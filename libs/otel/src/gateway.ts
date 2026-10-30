import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanContext,
  type TracerProvider,
} from '@opentelemetry/api';
import type { FragmentFetchEvent, TelemetryEvent, TelemetryOptions } from '@braidlabs/gateway';

/**
 * OpenTelemetry for the gateway: each fragment fetch becomes a CLIENT span in the current trace,
 * named for its fragment, and the fragment's endpoint is handed that span as its parent.
 *
 * It brings no SDK. Spans go to whatever tracer provider the process registered — NodeSDK with an
 * OTLP exporter, a Honeycomb distribution, `dd-trace`'s provider — so they land in the traces the
 * deployment already has, under the request span its HTTP instrumentation already opened. With
 * nothing registered, the API hands out no-op tracers and this costs next to nothing.
 */

export interface OtelGatewayTelemetryOptions extends Omit<TelemetryOptions, 'onFragmentFetch'> {
  /** A tracer provider to use instead of the globally registered one. */
  tracerProvider?: TracerProvider;
}

const TRACER_NAME = '@braidlabs/otel';

/** Methods HTTP semantic conventions name; any other is `_OTHER`, so span names stay bounded. */
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);

/** W3C `traceparent` for a span context. */
function traceparent(spanContext: SpanContext): string {
  return `00-${spanContext.traceId}-${spanContext.spanId}-${(spanContext.traceFlags & 0xff).toString(16).padStart(2, '0')}`;
}

/**
 * Whether an HTTP-client instrumentation hooks the gateway's `fetch` — OpenTelemetry's undici
 * instrumentation, which NodeSDK's auto-instrumentations install, or a vendor's — and so adds the
 * fragment request's trace context itself, under the span active as it runs. It appends rather than
 * replaces, and a request carrying two `traceparent`s carries none a receiver may use.
 */
function httpClientPropagates(): boolean {
  const host = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const channels = host?.getBuiltinModule?.('node:diagnostics_channel') as { hasSubscribers(name: string): boolean } | undefined;
  return channels?.hasSubscribers('undici:request:create') ?? false;
}

/**
 * The fragment request's trace context: the fetch span's, never the caller's. Written with the
 * registered propagator (W3C, B3, …), or as a W3C `traceparent` when there is none — unless an
 * HTTP-client instrumentation will write it.
 */
function traceHeaders(fetchContext: Context, spanContext: SpanContext): Record<string, string | null> {
  // no span to hand on: the request is left as it is
  if (!trace.isSpanContextValid(spanContext)) return {};

  // baggage is the gateway's `baggage` option's to decide, and is left alone
  const fields = propagation.fields().filter((field) => field !== 'baggage');
  const headers: Record<string, string | null> = {};
  for (const field of ['traceparent', 'tracestate', ...fields]) headers[field] = null;
  if (httpClientPropagates()) return headers;

  if (fields.length) {
    propagation.inject(fetchContext, headers);
  } else {
    headers['traceparent'] = traceparent(spanContext);
    const traceState = spanContext.traceState?.serialize();
    if (traceState) headers['tracestate'] = traceState;
  }
  return headers;
}

function endFetchSpan(span: Span, event: FragmentFetchEvent, error: unknown): void {
  span.setAttribute('braid.fetch.outcome', event.outcome);
  if (event.status !== undefined) span.setAttribute('http.response.status_code', event.status);
  // joined a fetch already in flight: the endpoint saw another span's trace context, not this one's
  if (event.coalesced) span.setAttribute('braid.fetch.coalesced', true);

  const errorType =
    event.outcome === 'timeout'
      ? 'timeout'
      : event.outcome === 'shed'
        ? 'braid.circuit_open'
        : event.outcome === 'error'
          ? error instanceof Error
            ? error.name
            : '_OTHER'
          : event.status !== undefined && event.status >= 500
            ? String(event.status)
            : undefined;

  if (errorType) {
    span.setAttribute('error.type', errorType);
    span.setStatus({ code: SpanStatusCode.ERROR });
    if (error instanceof Error) span.recordException(error);
  }
  span.end();
}

/**
 * Breaker transitions and web vitals, as events on the active span: the request span the
 * deployment's HTTP instrumentation opened — for a web vital, the beacon request that carried it.
 */
function recordEvent(event: TelemetryEvent): void {
  const active = trace.getActiveSpan();
  if (!active?.isRecording()) return;
  if (event.kind === 'breaker') {
    active.addEvent('braid.breaker.transition', {
      'braid.fragment.id': event.fragmentId,
      'braid.breaker.from': event.from,
      'braid.breaker.to': event.to,
      'braid.breaker.failures': event.failures,
    });
  } else if (event.kind === 'web-vital') {
    active.addEvent('browser.web_vital', {
      'browser.web_vital.name': event.name,
      'browser.web_vital.value': event.value,
      'browser.web_vital.rating': event.rating,
      ...(event.fragmentId === null ? {} : { 'braid.fragment.id': event.fragmentId }),
      'url.path': event.pathname,
    });
  }
}

/**
 * Gateway telemetry that records fragment fetches as OpenTelemetry spans.
 *
 * ```ts
 * createGateway({ registry, telemetry: otelGatewayTelemetry({ webVitals: true }) });
 * ```
 *
 * Accepts every other `telemetry` option, and passes events to an `on` given here too.
 */
export function otelGatewayTelemetry(options: OtelGatewayTelemetryOptions = {}): TelemetryOptions {
  if ('onFragmentFetch' in options) {
    throw new TypeError('otelGatewayTelemetry() opens the fragment fetch spans itself; it takes no onFragmentFetch');
  }
  const { tracerProvider, on, ...rest } = options;
  const tracer = () => (tracerProvider ?? trace.getTracerProvider()).getTracer(TRACER_NAME);

  return {
    ...rest,

    on(event: TelemetryEvent) {
      try {
        recordEvent(event);
      } finally {
        on?.(event);
      }
    },

    onFragmentFetch({ fragmentId, phase, method }) {
      const known = HTTP_METHODS.has(method);
      const parent = context.active();
      const span = tracer().startSpan(
        `${known ? method : 'HTTP'} ${fragmentId}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'braid.fragment.id': fragmentId,
            'braid.fetch.phase': phase,
            'http.request.method': known ? method : '_OTHER',
            ...(known ? {} : { 'http.request.method_original': method }),
          },
        },
        parent,
      );
      // The fetch runs with this span active, so an HTTP client's own span nests under it — and with
      // no baggage, because a propagator injecting the request's would hand the fragment the
      // browser's, which the gateway's `baggage` option exists to filter.
      const fetchContext = propagation.deleteBaggage(trace.setSpan(parent, span));
      return {
        headers: traceHeaders(fetchContext, span.spanContext()),
        run: (fetch) => context.with(fetchContext, fetch),
        end: (event, error) => endFetchSpan(span, event, error),
      };
    },
  };
}
