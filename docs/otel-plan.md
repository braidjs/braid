# OpenTelemetry for Braid, and Console Insights — plan

Status: approved · Package: `@braidlabs/otel` (new) · Touches: gateway, core,
sw, data, skew, fdc3, angular, registry, console

## Problem

A composed page is several teams' apps on one screen, served through one gateway. When it is slow
or broken, the question is always *whose part*. Braid already answers a slice of that:

- `libs/braid-gateway/src/telemetry.ts` emits `fragment-fetch`, `breaker` and `registry` events
  and, with `webVitals: true`, collects LCP/CLS/INP/FCP/TTFB in the browser attributed to the
  fragment whose shadow root they happened in.
- `libs/braid-sw/src/lib/reports.ts` queues SW asset and skew reports durably, with Background
  Sync, so they survive the tab closing.

None of it is OpenTelemetry. Each event is a plain callback the deployment must translate, there
is no trace that runs from the browser through the gateway to a fragment's endpoint and back, and
nothing covers what happens inside a fragment after it boots — its API calls, its cache, its
navigation. Enterprises already run Honeycomb, Datadog, Grafana/Tempo, New Relic or a collector;
they want Braid's data **in that system**, attributed per fragment, not in a new silo.

The reference point is Interop.io's io.Insights: platform-level telemetry about many apps on one
desktop, published over OTel to the customer's own collector and dashboards. Braid's equivalent is
the page: many fragments, one gateway, one trace.

## Principles

1. **OTel-native.** Real spans and metrics through `@opentelemetry/api`, with OTel semantic
   conventions, exported over OTLP. Braid never owns the backend.
2. **Bring your own SDK.** Tracers come from the global API (`trace.getTracer`), so whatever the
   server or host page registered — NodeSDK, a Honeycomb distro, `dd-trace`'s `TracerProvider` —
   receives Braid's spans. Braid never registers a second provider.
3. **Zero cost when off.** Only the new `@braidlabs/otel` package imports `@opentelemetry/api`
   (as a required peer, so it resolves to the host's own copy). Core, gateway, sw, data and skew
   gain small dependency-free hooks and **no** OTel dependency. `tools/release/check-publishable.mjs`
   check 3 already fails a release if one of them imports an undeclared package.
4. **Attribution everywhere.** Every span Braid creates carries `braid.fragment.id`. That is the
   part no generic RUM product can do on a composed page.
5. **Three tiers, each enabled separately:** server tracing, browser RUM/performance, and
   interaction analytics (clicks). Analytics needs its own consent and is off until granted.
6. **Untrusted input stays untrusted.** Browser telemetry reaches the backend through a gateway
   relay that validates it, as `parseVitalsBeacon` already does for vitals. No vendor key ships to
   the browser.
7. **Backward compatible.** `telemetry.on`, `webVitals` and `sampleRate` keep working unchanged;
   `telemetry.spec.ts` passes unmodified throughout.

## Developer API (target shape)

```ts
// server: the deployment's own SDK is registered first, as it is today
import { otelGatewayTelemetry } from '@braidlabs/otel';
createGateway({ registry, telemetry: otelGatewayTelemetry({ webVitals: true, sampleRate: 0.2 }) });

// browser: RUM, and separately consented analytics
import { braidRum, braidAnalytics } from '@braidlabs/otel/browser';
braidRum({ relay: '/__braid/otlp/v1/traces', consent: () => cmp.allows('performance') });
braidAnalytics({ consent: () => cmp.allows('analytics') }); // clicks on [data-braid-track]
```

## Phases

Each phase is one PR-sized card. Phase 1 is detailed; the rest get tasks and acceptance criteria
and are re-planned when they start.

### Phase 1 — Gateway traces (Standard; smallest valuable PR)

Puts every fragment fetch into the customer's existing server traces, with attribution, and fixes
the package layout everything else builds on.

Tasks:

1. **Gateway hook** (`libs/braid-gateway/src/telemetry.ts`, `gateway.ts`):
   - `TelemetryOptions.on` becomes optional.
   - New optional `onFragmentFetch({ fragmentId, phase })` hook in `fetchFragment`, called after
     the credential strip and `additionalHeaders`. It returns `{ headers?, end?(event) }`: headers
     to set on the fragment request, and a callback the three existing `emit` sites (ok, shed,
     error/timeout) call with the same `FragmentFetchEvent`.
   - Muted by the existing `telemetryBroken` rule when it throws.
2. **`libs/otel` scaffold**: `@braidlabs/otel`, root export only, peer `@opentelemetry/api ^1`,
   `sideEffects: false`, Nx release config as for the gateway. Dev deps: `sdk-trace-base`,
   `context-async-hooks`.
3. **`otelGatewayTelemetry()`** returns `TelemetryOptions`:
   - a CLIENT span `GET {fragmentId}` per fragment fetch, parented on the active context, with
     `braid.fragment.id`, `braid.fetch.phase` (pierce | namespace), `braid.fetch.outcome`
     (ok | error | timeout | shed), `http.response.status_code`, and `error.type`
     (`timeout`, `braid.circuit_open`, or the error class); status ERROR on error, timeout, shed
     and 5xx;
   - W3C `traceparent`/`tracestate` injected into the fragment request, **overwriting** what the
     browser sent;
   - **Baggage, safely** (W3C `baggage`). Supported, never passed through blind:
     - inbound `baggage` from the browser is dropped unless the deployment allowlists keys
       (`baggage: { forward: ['tenant', 'experiment'] }`); allowlisted members are kept only if
       their values match a per-key pattern and the header stays within W3C limits (8192 bytes,
       180 members); member properties are dropped;
     - server-set baggage (`baggage: { set: (request) => ({ 'braid.fragment.id': … }) }`) is
       added by the gateway and always wins over a client value with the same key;
     - forwarded only to fragments inside the deployment's trust boundary (the same rule as
       `forwardCredentials`), never to third-party endpoints;
     - baggage is never copied onto span attributes automatically (it is not a PII-safe channel);
   - breaker transitions as a span event on the active span; `web-vital` events as span events;
   - still forwards every event to a user `on`, if given.
4. **Docs**: `docs/packages/otel.md` with registration snippets for NodeSDK + OTLP, Honeycomb and
   `dd-trace`; gateway docs link to it.

Acceptance criteria:

- [x] With a registered provider and an in-memory exporter, a request to a page piercing two
      fragments, made inside an active parent span, exports two CLIENT spans sharing the parent's
      trace id, each with its `braid.fragment.id`, phase, outcome and status. (`npx nx test otel`)
- [x] Each fragment endpoint (a function endpoint in the spec) receives a `traceparent` whose span
      id is its own CLIENT span's, even when the inbound request carried a different one.
- [x] A browser `baggage` header reaches no fragment by default; with `forward: ['tenant']`, only a
      valid `tenant` member arrives; an oversize or malformed header is dropped whole; a server-set
      key overrides the client's; a fragment outside the trust boundary receives no baggage.
- [x] A timeout, an open breaker (endpoint never called) and a 503 each show the right outcome,
      `error.type` and ERROR status on the span.
- [x] With no `onFragmentFetch` configured, fragment request headers are exactly today's; with the
      API installed but no SDK registered, responses are byte-identical to a gateway without the
      plugin. (`npx nx test braid-gateway otel`)
- [x] `libs/braid-gateway/src/telemetry.spec.ts` passes unmodified, and a user `on` passed through
      `otelGatewayTelemetry` receives identical events.
- [x] A throwing hook is logged once and muted; the request still succeeds.
- [x] `CI=1 npx nx run-many -t lint test build` passes, and `check-publishable` passes with the new
      package and fails if the gateway is made to import `@opentelemetry/api`.

As built (PR #62), after review and a probe against `@opentelemetry/instrumentation-undici`:

- The fetch runs with Braid's CLIENT span active (a `run` hook), so an HTTP-client span nests
  under it. When something hooks undici's request creation, that instrumentation writes the
  fragment request's trace context and Braid writes none: it appends rather than replaces, and two
  `traceparent` headers would leave the backend with neither. Otherwise Braid writes it with the
  registered propagator, or a W3C `traceparent` when none is registered.
- The fetch runs without the OpenTelemetry context's baggage, which NodeSDK's default propagators
  would otherwise re-inject from the browser's header past the gateway's filter.
- Baggage values must be W3C baggage octets; patterns match the whole decoded value statelessly;
  `set(request, fragmentId)`; baggage is part of the single-flight key; coalesced fetches carry
  `braid.fetch.coalesced`.
- Not yet: a span for websocket upgrades, and web vitals as their own span or metric rather than
  events on the beacon request's span.

### Phase 2 — Console Insights v1: permission and deep links

Needs only Phase 1's attributes; independent of browser RUM.

- `read:insights` grant (`RegistryGrant`, `oidc.ts`), `AuthorizeContext.resource: 'insights'`,
  and `insights` in `GET /permissions`. **Not** implied by plain `read`.
- Configurable link templates with `{fragmentId}`, `{environment}`, `{snapshotId}`, `{from}`,
  `{to}` (and later `{traceId}`, `{sessionId}`), rendered on the console's fragment, history and
  environment views: "Open in Honeycomb/Datadog/Grafana".
- AC: `/permissions` reports `insights: true` only with `read:insights`; the console shows the
  links only then, with hrefs matching the templates; console bundle stays within its size budget.

### Phase 3 — Server span, metrics, and handing the trace to the browser

- `withOtelServerSpan(handler)` for hosts without HTTP auto-instrumentation (hosts with it already
  have a SERVER span; Braid adds `http.route` and `braid.request.kind` to it). Inbound
  `traceparent` from browsers is **not** trusted as a parent by default (a client could force
  sampling); it is linked instead. Opt-in to trust it.
- Metrics: `braid.fragment.fetch.duration` (histogram), breaker transitions (counter).
- Document handback: one carrier, `<meta name="traceparent">` in pierced documents (what OTel's
  document-load instrumentation reads), only on responses that are not shared-cacheable — a
  CDN-cached document would hand every visitor the same trace id.
- AC: one trace from the gateway's SERVER span through every fragment fetch; meta present on a
  `private`/`no-store` pierced document and absent on a cacheable one and under
  `pierceCacheControl: 'preserve'`.

### Phase 4 — Browser RUM (`@braidlabs/otel/browser`) and the OTLP relay

Client spans and the relay ship together; spans with no export path are useless.

- **Relay** `POST /__braid/otlp/v1/traces` on the gateway (respects `basePath`): OTLP/JSON only,
  body and span-count caps, attribute allowlist, query strings stripped, `service.name` forced to
  the configured browser service, unregistered `braid.fragment.id` dropped, always 204, forwarded
  off the request path to the deployment's collector with server-held headers. A direct-to-collector
  mode stays available for teams with ingest-only keys, documented with its trade-offs.
- **Spans**: one `braid.slot` span per fragment lifecycle (boot → ready/error, and close) and
  `braid.navigation` per route change, parented on the document's trace. v1 observes
  `fragment-slot[state]` with a `MutationObserver` — the `braid:state`/`braid:error` events do not
  bubble, and this needs no core change. Existing per-fragment web vitals become
  `browser.web_vital` spans.
- **Export**: the stock OTLP HTTP exporter and batch processor pointed at the relay (a docs snippet
  for teams without a web SDK, not a Braid-owned SDK); flush on `pagehide`.
- **Sessions**: a session id in `sessionStorage` (per tab, survives reloads, no cookie), and one
  sampling decision per session shared by every fragment.
- **Privacy**: `consent` hook (RUM default decided below), query/hash stripping, no input values
  or text content ever.
- AC (jsdom + real gateway): booting a pierced fragment exports `braid.slot` with its id in the
  document's trace; an LCP element in a fragment's shadow root yields `browser.web_vital` for that
  fragment; the relay forwards valid OTLP with server-held headers and drops spoofed
  `service.name`, unknown fragment ids and oversize bodies; consent denied exports nothing; a
  sampled-out session exports nothing from any fragment.

### Phase 5 — Fragment API calls and fragment-owned instrumentation

- **API calls**: CLIENT spans for a compat fragment's `fetch`/XHR, patched in the **realm only**
  (Braid never patches the host window), with `braid.fragment.id`; `traceparent` injected for
  same-origin and an explicit `propagateTo` list only (blind cross-origin injection triggers CORS
  preflights).
- **Fragment-owned OTel**: a fragment that already uses `@opentelemetry/api` lands in the host's
  provider, attributed. Mechanism: a per-fragment facade at the OTel API's global symbol in the
  realm, delegating to the host and stamping `braid.fragment.id` (needs `installRealmGlobals` to
  accept symbol keys). A fragment that bundles its own SDK has its registration refused by OTel's
  own already-registered check.
- Optional core `onPhase(fragmentId, phase, ms)` seam if per-phase boot timing (realm create,
  handshake, mount) is wanted inside `braid.slot`.
- AC: a realm `fetch` to the gateway namespace carries `traceparent` and joins the trace; a
  cross-origin one outside `propagateTo` does not; a span started by fragment code through
  `@opentelemetry/api` reaches the host exporter with the fragment's id.

### Phase 6 — Interaction analytics (separately consented)

- `braidAnalytics({ consent })`: `consent` required, default denied. One `document` click
  listener using `event.composedPath()` (fragment content is inside shadow roots, so `target` is
  retargeted), recording `app.widget.click` with `app.widget.id` from `data-braid-track` (or an
  allowlist) and `braid.fragment.id`. No text, values or coordinates.
- Exported through the same relay; a separate allowlist entry.
- AC: with RUM on but analytics consent absent, zero click records; granted, a click on
  `[data-braid-track=checkout]` inside a fragment yields `app.widget.id=checkout` with its fragment
  id and nothing else identifying.

### Phase 7 — Service worker, cache and data integrations

One card per integration, each a thin adapter over hooks that exist today, adding a hook only
where one is missing:

- **SW**: `braid.sw.fetch` per intercepted request with the existing `AssetOutcome` (network,
  cache, cache-after-404, …), cache hit/miss counters; spans queued on the existing
  `createReportQueue` outbox so they survive tab close.
- **Data**: cache reads and writes (`braid.data.query` with source store | network and staleness;
  `braid.data.mutate` confirmed | queued), outbox flush; partition values never recorded.
- **Skew**: events for failed, migrated, downgraded and lossy reads; never payloads.
- **FDC3**: `fdc3.broadcast` and `fdc3.raiseIntent` with source and target fragments, no context
  bodies.
- **Angular**: router navigation by route template, stale-chunk recovery, workflow steps.

### Phase 8 — Insights views in the console

- A server-side query adapter (vendor secrets never reach the browser), behind `read:insights`.
  The first adapter is a concrete function for one vendor; the interface is extracted when the
  second arrives.
- Views: per-fragment health (error rate, fetch latency, vitals over time), a page-load trace
  waterfall (gateway fetches through client boot), a sessions list with per-session timeline, and
  deploy correlation using the registry's snapshots, environments and promotions (deploy markers
  emitted from the registry's audit sink).
- AC: endpoints 403 without `read:insights`; with a fixture adapter, each view renders from
  adapter data; no vendor credential appears in any response.

## Decisions (recommendations taken unless noted)

1. **Package name** — `@braidlabs/otel`. (`telemetry` already names the gateway's plain hook.)
2. **First vendor for the Phase 8 adapter** — your pilot customer's. With none, Honeycomb or
   Grafana Tempo (open query API, easy to fixture). Datadog's spans API is the most restrictive.
3. **RUM consent default** — on unless the `consent` hook says otherwise (performance data, no
   identifiers); analytics always off until consented. This is ultimately your customers' legal
   call; the hook makes either default one line.
4. **Session scope** — per tab via `sessionStorage`, no cookie. A cross-tab, cross-day session
   needs a cookie and a consent story; defer until someone needs it.
5. **No built-in trace store.** Visualization reads from the customer's backend; Braid stores
   nothing. (A store would make Braid a custodian of behavioural data and duplicate the vendor.)

## Where the planner and simplifier disagreed

- **Trace views in the console.** The simplifier would stop at deep links. Kept as Phase 8, because
  you asked for the console to visualize traces and sessions — but deep links ship first.
- **Fragment API calls, cache reads/writes, SW interceptor spans.** The simplifier cut these as
  risky or noisy. Kept (Phases 5 and 7) because you named them; reduced to thin adapters with
  sampling.
- **Realm OTel facade.** The simplifier would defer it in favour of handing fragments a wrapper via
  the existing `realmGlobals` hook. Kept in Phase 5: compat promises fragments work unchanged, and
  fragments that already use `@opentelemetry/api` would not see a string-keyed wrapper.
- **Cut, agreed by both**: a built-in store; a `braid.pierce` stream span; coalesced-fetch links;
  a plugin-array framework; a Braid-owned web SDK and custom exporter; a second SW queue; page-view
  tracking (document-load covers it); persisting `traceparent` on outbox entries.

## Discovered (separate tickets, not this plan)

- **Browser trace headers leak to fragment endpoints today.** `fetchFragment` does
  `new Request(url, request)` (`gateway.ts:992`), which copies the browser's `traceparent`,
  `tracestate` and `baggage` to every fragment endpoint; only credential headers are stripped.
  `baggage` can carry arbitrary client-set key/values into internal services. Phase 1 fixes this
  with the safe-baggage rules above, and the "drop inbound `baggage` unless allowlisted" default
  applies even when OTel is not configured — so it can ship ahead of Phase 1 as a small hardening
  PR if wanted.
- `/__braid/vitals.js` does not respect `basePath`; the Phase 4 relay must.

## Out of scope

- Session replay (DOM recording).
- Patching the host page's `fetch`, XHR or history from Braid. Host-side HTTP tracing comes from
  the host's own SDK.
- Tracing for untrusted (cross-origin) fragments beyond passing trace context in the handshake.
- WebSocket upgrade tracing.
