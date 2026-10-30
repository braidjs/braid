import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createGateway, type FragmentManifest, type TelemetryEvent } from '@braidlabs/gateway';
import { otelGatewayTelemetry } from './gateway.js';

/**
 * Against a real SDK tracer provider and an in-memory exporter, so these are the spans a deployment
 * would export. The provider is registered globally, as NodeSDK or a vendor distribution would.
 */

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

type Seen = Record<string, { traceparent: string | null; tracestate: string | null; baggage?: string | null; activeSpanId?: string }[]>;

function endpoints(
  seen: Seen,
  respond: (id: string, signal?: AbortSignal | null) => Promise<Response> | Response = () => new Response('<p>ok</p>'),
) {
  return (id: string): FragmentManifest => ({
    id,
    pierce: ['/page'],
    endpoint: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      (seen[id] ??= []).push({
        traceparent: request.headers.get('traceparent'),
        tracestate: request.headers.get('tracestate'),
        ...(request.headers.has('baggage') ? { baggage: request.headers.get('baggage') } : {}),
        activeSpanId: trace.getActiveSpan()?.spanContext().spanId,
      });
      return respond(id, init?.signal);
    }) as typeof fetch,
  });
}

const shell = async () =>
  new Response('<html><body><fragment-slot name="orders"></fragment-slot><fragment-slot name="billing"></fragment-slot></body></html>', {
    headers: { 'content-type': 'text/html' },
  });

const navigation = () =>
  new Request('https://shell.example/page', {
    headers: { 'sec-fetch-dest': 'document', traceparent: '00-ffffffffffffffffffffffffffffffff-ffffffffffffffff-01', tracestate: 'browser=1' },
  });

describe('otelGatewayTelemetry()', () => {
  it('records each pierced fragment fetch as a CLIENT span in the active trace, and hands it to the endpoint as parent', async () => {
    const seen: Seen = {};
    const gateway = createGateway({ registry: ['orders', 'billing'].map(endpoints(seen)), telemetry: otelGatewayTelemetry() });

    const tracer = trace.getTracer('test');
    await tracer.startActiveSpan('GET /page', { kind: SpanKind.SERVER }, async (server) => {
      await (await gateway.handle(navigation(), shell))!.text();
      server.end();
    });

    const spans = exporter.getFinishedSpans();
    const server = spans.find((span) => span.name === 'GET /page')!;
    const fetches = spans.filter((span) => span.kind === SpanKind.CLIENT);
    expect(fetches.map((span) => span.name).sort()).toEqual(['GET billing', 'GET orders']);

    for (const span of fetches) {
      const id = span.attributes['braid.fragment.id'] as string;
      expect(span.spanContext().traceId).toBe(server.spanContext().traceId);
      expect(span.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
      expect(span.attributes).toMatchObject({ 'braid.fetch.phase': 'pierce', 'braid.fetch.outcome': 'ok', 'http.response.status_code': 200 });
      // the endpoint's parent is its own span — not the browser's trace, and without its tracestate —
      // and that span is the active one while the endpoint is fetched, so an HTTP client's nests under it
      expect(seen[id]![0]).toEqual({
        traceparent: `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
        tracestate: null,
        activeSpanId: span.spanContext().spanId,
      });
    }
  });

  it('still ends every span when an `on` it was given throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gateway = createGateway({
      registry: ['orders', 'billing'].map(endpoints({})),
      telemetry: otelGatewayTelemetry({
        on: () => {
          throw new Error('broken sink');
        },
      }),
    });
    await (await gateway.handle(navigation(), shell))!.text();
    expect(exporter.getFinishedSpans().map((span) => span.name).sort()).toEqual(['GET billing', 'GET orders']);
    error.mockRestore();
  });

  it('marks a fetch that joined one already in flight as coalesced', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gateway = createGateway({
      registry: [endpoints({}, async () => (await gate, new Response('ok')))('orders')],
      telemetry: otelGatewayTelemetry(),
    });
    const pending = [1, 2].map(() => gateway.handle(new Request('https://shell.example/__braid/frag/orders/x')));
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all(pending);
    expect(exporter.getFinishedSpans().map((span) => span.attributes['braid.fetch.coalesced'] ?? false).sort()).toEqual([false, true]);
  });

  it('names a span for a method HTTP does not define by `HTTP`, so names stay bounded', async () => {
    const gateway = createGateway({ registry: [endpoints({})('orders')], telemetry: otelGatewayTelemetry() });
    await gateway.handle(new Request('https://shell.example/__braid/frag/orders/x', { method: 'PROPFIND' }));
    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe('HTTP orders');
    expect(span!.attributes).toMatchObject({ 'http.request.method': '_OTHER', 'http.request.method_original': 'PROPFIND' });
  });

  describe('with the propagators NodeSDK registers by default', () => {
    beforeEach(() => {
      propagation.setGlobalPropagator(
        new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
      );
    });

    const browserRequest = () =>
      new Request('https://shell.example/__braid/frag/orders/x', {
        headers: { traceparent: '00-ffffffffffffffffffffffffffffffff-ffffffffffffffff-01', tracestate: 'browser=1', baggage: 'tenant=acme,userId=42' },
      });
    // as an HTTP server instrumentation leaves it: the browser's baggage, extracted into the context
    const asServer = (run: () => Promise<void>) =>
      context.with(
        propagation.setBaggage(context.active(), propagation.createBaggage({ tenant: { value: 'acme' }, userId: { value: '42' } })),
        () => trace.getTracer('test').startActiveSpan('GET /page', { kind: SpanKind.SERVER }, async (server) => (await run(), server.end())),
      );

    it("propagates the fetch span with them, and never the context's baggage", async () => {
      const seen: Seen = {};
      const gateway = createGateway({
        registry: [endpoints(seen)('orders')],
        forwardCredentials: true,
        baggage: { forward: ['tenant'] },
        telemetry: otelGatewayTelemetry(),
      });
      await asServer(async () => void (await gateway.handle(browserRequest())));

      const span = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.CLIENT)!;
      // only what the gateway's baggage option allows: the propagator adds nothing from the context
      expect(seen['orders']![0]).toMatchObject({
        traceparent: `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
        tracestate: null,
        baggage: 'tenant=acme',
      });
    });

    it('leaves trace context to an HTTP-client instrumentation, and clears the caller’s for it', async () => {
      // what OpenTelemetry's undici instrumentation does when it is enabled
      const listener = () => undefined;
      subscribe('undici:request:create', listener);
      try {
        const seen: Seen = {};
        const gateway = createGateway({ registry: [endpoints(seen)('orders')], telemetry: otelGatewayTelemetry() });
        await asServer(async () => void (await gateway.handle(browserRequest())));

        const span = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.CLIENT)!;
        // it appends its own, so this sets none — and the browser's is gone, not appended to
        expect(seen['orders']![0]).toMatchObject({ traceparent: null, tracestate: null, activeSpanId: span.spanContext().spanId });
      } finally {
        unsubscribe('undici:request:create', listener);
      }
    });
  });

  it('refuses an onFragmentFetch of its own, rather than silently replacing it', () => {
    expect(() => otelGatewayTelemetry({ onFragmentFetch: () => undefined } as never)).toThrow(TypeError);
  });

  it('marks a timeout, an open breaker and a 5xx as errors with the right error.type', async () => {
    const seen: Seen = {};
    const gateway = createGateway({
      registry: [
        // never answers; gives up when the gateway's timeout aborts it, as fetch does
        {
          ...endpoints(seen, (_id, signal) => new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))))('slow'),
          timeoutMs: 20,
        },
        endpoints(seen, () => new Response('down', { status: 503 }))('down'),
      ],
      breaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      telemetry: otelGatewayTelemetry(),
    });

    await gateway.handle(new Request('https://shell.example/__braid/frag/slow/x'));
    await gateway.handle(new Request('https://shell.example/__braid/frag/slow/x')); // breaker now open
    await gateway.handle(new Request('https://shell.example/__braid/frag/down/x'));

    const byOutcome = Object.fromEntries(
      exporter.getFinishedSpans().map((span) => [`${span.attributes['braid.fragment.id']}:${span.attributes['braid.fetch.outcome']}`, span]),
    );
    expect(byOutcome['slow:timeout']?.attributes['error.type']).toBe('timeout');
    expect(byOutcome['slow:shed']?.attributes['error.type']).toBe('braid.circuit_open');
    expect(byOutcome['down:ok']?.attributes['error.type']).toBe('503');
    for (const span of Object.values(byOutcome)) expect(span.status.code).toBe(SpanStatusCode.ERROR);
    // the shed fetch never reached the endpoint
    expect(seen['slow']).toHaveLength(1);
  });

  it('records breaker transitions on the active span, and still passes every event to `on`', async () => {
    const events: TelemetryEvent[] = [];
    const gateway = createGateway({
      registry: [endpoints({}, () => new Response('down', { status: 503 }))('down')],
      breaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      telemetry: otelGatewayTelemetry({ on: (event) => events.push(event) }),
    });

    await trace.getTracer('test').startActiveSpan('request', async (span) => {
      await gateway.handle(new Request('https://shell.example/__braid/frag/down/x'));
      span.end();
    });

    const request = exporter.getFinishedSpans().find((span) => span.name === 'request')!;
    expect(request.events.map((event) => event.name)).toContain('braid.breaker.transition');
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(['fragment-fetch', 'breaker']));
  });

  it('uses an injected tracer provider instead of the global one', async () => {
    const own = new InMemorySpanExporter();
    const ownProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(own)] });
    const gateway = createGateway({
      registry: [endpoints({})('orders')],
      telemetry: otelGatewayTelemetry({ tracerProvider: ownProvider }),
    });
    await gateway.handle(new Request('https://shell.example/__braid/frag/orders/x'));
    expect(own.getFinishedSpans().map((span) => span.name)).toEqual(['GET orders']);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});

describe('with no SDK registered', () => {
  it('leaves the fragment request and the response as they would be without it', async () => {
    trace.disable();
    const seen: Seen = {};
    const withOtel = createGateway({ registry: ['orders', 'billing'].map(endpoints(seen)), telemetry: otelGatewayTelemetry() });
    const plain = createGateway({ registry: ['orders', 'billing'].map(endpoints({})) });

    const a = await (await withOtel.handle(navigation(), shell))!.text();
    const b = await (await plain.handle(navigation(), shell))!.text();
    expect(a).toBe(b);
    // no span to propagate: the caller's trace context passes through, as it does with no telemetry
    expect(seen['orders']![0]!.traceparent).toBe('00-ffffffffffffffffffffffffffffffff-ffffffffffffffff-01');
  });
});
