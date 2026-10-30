# @braidlabs/otel

OpenTelemetry for Braid. Every fragment fetch the gateway makes becomes a span in the traces you
already collect, named for its fragment, and the fragment's endpoint receives that span as its
parent. "The page is slow" becomes "`orders` took 900 ms to answer the pierce", in Honeycomb,
Datadog, Grafana Tempo or wherever your traces go.

This is Phase 1 of the [OpenTelemetry plan](../otel-plan.md): server tracing in the gateway.
Browser RUM, the console's Insights views and the other integrations follow.

```sh
npm install @braidlabs/otel @opentelemetry/api
```

## Usage

Register your tracing SDK first, as you would for any Node service. Then hand the gateway its
telemetry:

```ts
import { createGateway } from '@braidlabs/gateway';
import { otelGatewayTelemetry } from '@braidlabs/otel';

createGateway({
  registry,
  telemetry: otelGatewayTelemetry({ webVitals: true, sampleRate: 0.2 }),
});
```

`otelGatewayTelemetry` accepts every other `telemetry` option, and an `on` you pass still receives
every event.

## What you get

- **A CLIENT span per fragment fetch.** Fetches for pierced documents, the fragment namespace and
  fragment documents each get one, named `GET <fragment id>`. Attributes:
  - `braid.fragment.id`;
  - `braid.fetch.phase`, which is `pierce` or `namespace`;
  - `braid.fetch.outcome`, which is `ok`, `error`, `timeout` or `shed`;
  - `http.request.method` and `http.response.status_code`.

  A timeout, a fetch the circuit breaker refused, a 5xx and a thrown error mark the span as an
  error. Their `error.type` is `timeout`, `braid.circuit_open`, the status code, or the error's
  name. A 4xx is the fragment's answer, not a failed fetch, and is left unmarked. A method HTTP
  doesn't define is recorded as `_OTHER` and names the span `HTTP <fragment id>`.
- **One trace through the fragment.** The fragment request carries the trace context of its
  own span, written by your registered propagator (W3C `traceparent`, B3, …), and never what the
  browser sent. An instrumented fragment backend joins the same trace.
- **Coalesced fetches say so.** When identical fragment fetches are in flight at once, the gateway
  makes one and shares its response. Every caller still gets its span, but only the first one's
  trace context reaches the endpoint; the others carry `braid.fetch.coalesced: true`, and have no
  children from the fragment backend.
- **Breaker transitions and per-fragment web vitals** appear as span events
  (`braid.breaker.transition`, `browser.web_vital`) on the active span, which is the request span
  your HTTP instrumentation opened. Without that instrumentation there is no active span, and they
  go only to `on`. A web vital is on the span of the beacon request that carried it, not the page's
  trace. It is reported by the browser, unauthenticated, so treat its values, fragment id and path
  as user input.
- **Your SDK, not ours.** Spans go to the globally registered tracer provider, or to
  `tracerProvider` if you pass one. With nothing registered, the API hands out no-op tracers, and
  fragment requests are as they would be without this package. Neither `@braidlabs/core` nor
  `@braidlabs/gateway` depends on OpenTelemetry.

## Registering an SDK

**OpenTelemetry NodeSDK, exporting OTLP to a collector:**

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

new NodeSDK({
  serviceName: 'shell',
  traceExporter: new OTLPTraceExporter({ url: 'http://collector:4318/v1/traces' }),
  instrumentations: [getNodeAutoInstrumentations()],
}).start();
```

**Honeycomb:**

```ts
import { HoneycombSDK } from '@honeycombio/opentelemetry-node';

new HoneycombSDK({ serviceName: 'shell' }).start(); // HONEYCOMB_API_KEY from the environment
```

**Datadog, with `dd-trace`'s OpenTelemetry API support** (initialized before anything else, as
`dd-trace` must be; for ES modules, also start Node with `--import dd-trace/initialize.mjs`):

```ts
import tracer from 'dd-trace';

tracer.init();
const provider = new tracer.TracerProvider();
provider.register();
```

With HTTP auto-instrumentation on, the gateway's fragment spans sit under the request's SERVER
span. Each fragment fetch runs with Braid's span active. So when outgoing `fetch` (undici) is
instrumented too, as NodeSDK's auto-instrumentations do, the HTTP client's span nests inside
Braid's, the one named for the fragment. That instrumentation then writes the request's trace
context, and Braid writes none of its own, because it appends rather than replaces and two
`traceparent` headers would leave the backend with neither. With an SDK registered but no HTTP
instrumentation, there is no request span to join, so each fragment fetch starts a trace of its
own.

A propagator also carries the OpenTelemetry context's baggage, which your HTTP server
instrumentation fills from the browser's `baggage` header. Fragment fetches run without it, so the
gateway's `baggage` option stays the only thing deciding what a fragment receives.

Websocket upgrades to a fragment get no span yet, and the browser's trace context passes through
to the fragment's socket as it came.

## Baggage

Unrelated to whether this package is installed, the gateway no longer copies the browser's
`baggage` header to fragment endpoints. Allowlist what may pass, and add your own, with the
gateway's `baggage` option. See [@braidlabs/gateway](./gateway.md#baggage).
