import { context, SpanKind, SpanStatusCode, trace, type Span, type SpanContext, type TracerProvider } from '@opentelemetry/api';
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

/** W3C `traceparent` for a span context. */
function traceparent(spanContext: SpanContext): string {
  return `00-${spanContext.traceId}-${spanContext.spanId}-${(spanContext.traceFlags & 0xff).toString(16).padStart(2, '0')}`;
}

function endFetchSpan(span: Span, event: FragmentFetchEvent, error: unknown): void {
  span.setAttribute('braid.fetch.outcome', event.outcome);
  if (event.status !== undefined) span.setAttribute('http.response.status_code', event.status);

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
 * Gateway telemetry that records fragment fetches as OpenTelemetry spans.
 *
 * ```ts
 * createGateway({ registry, telemetry: otelGatewayTelemetry({ webVitals: true }) });
 * ```
 *
 * Accepts every other `telemetry` option, and passes events to an `on` given here too.
 */
export function otelGatewayTelemetry(options: OtelGatewayTelemetryOptions = {}): TelemetryOptions {
  const { tracerProvider, on, ...rest } = options;
  const tracer = () => (tracerProvider ?? trace.getTracerProvider()).getTracer(TRACER_NAME);

  return {
    ...rest,

    on(event: TelemetryEvent) {
      const active = trace.getActiveSpan();
      if (active?.isRecording()) {
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
      on?.(event);
    },

    onFragmentFetch({ fragmentId, phase, method }) {
      const span = tracer().startSpan(
        `${method} ${fragmentId}`,
        {
          kind: SpanKind.CLIENT,
          attributes: { 'braid.fragment.id': fragmentId, 'braid.fetch.phase': phase, 'http.request.method': method },
        },
        context.active(),
      );
      const spanContext = span.spanContext();
      // the endpoint's parent is this span, never what the browser sent
      const headers: Record<string, string> = trace.isSpanContextValid(spanContext)
        ? { traceparent: traceparent(spanContext), ...(spanContext.traceState ? { tracestate: spanContext.traceState.serialize() } : {}) }
        : {};
      return { headers, end: (event, error) => endFetchSpan(span, event, error) };
    },
  };
}
