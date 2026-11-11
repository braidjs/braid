# @braidlabs/gateway

The Braid Gateway is a fetch-native, platform-neutral origin-front middleware. It routes fragment traffic by **exact ID** under the reserved `/__braid/frag/:fragmentId/*` namespace, pierces server-rendered HTML into declarative shadow roots, manages manifests, and transparently proxies all other traffic to your existing application.

---

## Installation

```bash
npm install @braidlabs/gateway
```

---

## Key Features

1. **Exact Namespace Routing:** Routes subresource and API requests to upstream fragment endpoints under `/__braid/frag/:id/*` with prefixes stripped cleanly.
2. **Server-Side Piercing:** Fetches the host shell and matching fragments concurrently on initial document requests, splicing fragment SSR HTML directly into the host's Declarative Shadow DOM (`<template shadowrootmode="open">`).
3. **Script Neutralization:** Automatically rewrites fragment `<script>` tags to `<script type="inert">` during piercing so they do not execute in the host window.
4. **Data-Driven Manifest Registry:** Configured via JSON manifests, local files, URLs, or dynamic KV/database loaders. Deploying a new fragment requires zero gateway redeployments.
5. **FDC3 App Directory Projection:** Can serve the manifest registry in standard FDC3 App Directory (AppD v2) format at `/__braid/registry/appd/v2/apps`.
6. **Federation:** A team's gateway can join this one as a subgraph. Its fragments are composed into this registry and pierced directly, with no shell within a shell. See [Federating gateways](/braid-federation).
7. **Per-user preferences (opt-in):** Stores each signed-in user's JSON entries at `/__braid/preferences/*`, same-origin only and within quotas, for the [console workspace](./console.md#the-workspace)'s `serverStore()`. See [Per-user preferences](#per-user-preferences-opt-in).

---

## Reserved URL Namespaces

| Namespace | What it serves | Purpose |
| :--- | :--- | :--- |
| `/__braid/frag/:id/*` | Assets & API traffic | Forwards directly to fragment endpoint with prefix stripped. |
| `/__braid/realm/:id/*` | Realm boot stubs | Serves minimal HTML stub to initialize hidden iframe runtimes. |
| `/__braid/doc/:id/*` | Prepared DOM payload | Serves rewritten, script-inert HTML for dynamic injection. |
| `/__braid/preferences/*` | The signed-in user's JSON entries (opt-in) | Reads and writes per-user preferences; see [below](#per-user-preferences-opt-in). |

A host mounted under a path it shares a domain with sets `createGateway({ basePath: '/manage' })`
and `initBraid({ basePath: '/manage' })`; the namespaces then live at `/manage/__braid/…` and the
root is left alone. Not yet combinable with `serviceWorker`, `discovery`, `preferences`, or `telemetry.webVitals`.

**Paths that are refused.** A fragment request is forwarded only if every segment of its path means
the same thing decoded as it does as written. A segment that decodes to `.` or `..`, that holds an
encoded slash, backslash or NUL (`a%2Fb`), that is a dot segment with path parameters (`..;x`), or
that is not valid percent-encoding (a bare `%`) gets a 404 and nothing is fetched. An upstream that
decodes before it resolves would otherwise be walked out of the fragment's endpoint path. This
applies to a bound fragment's page route too: a route parameter that may contain a slash belongs in
the query string, or give the fragment a `documentPath`.

---

## Usage

### Basic Setup

```ts
import { createGateway } from '@braidlabs/gateway';

const gateway = createGateway({
  registry: [
    {
      id: 'billing',
      endpoint: 'https://billing.internal',
      pierce: ['/billing', '/billing/*'],
      timeoutMs: 1500,
      fallback: 'placeholder',
    },
    {
      id: 'rating-widget',
      endpoint: 'https://widgets.internal',
      adapter: 'custom-element',
      entry: '/star-rating.js',
      element: 'star-rating',
      events: ['rating:change'],
    },
  ],
});
```

---

## Platform Bindings

### Express / Connect / Vite

```ts
import express from 'express';
import { createGateway } from '@braidlabs/gateway';
import { toNodeMiddleware } from '@braidlabs/gateway/node';

const app = express();
const gateway = createGateway({ registry: 'https://config.internal/manifests.json' });

// Mount gateway as the first middleware
app.use(toNodeMiddleware(gateway));

// Host app routes follow
app.use(express.static('public'));
app.listen(3000);
```

### Fastify

```ts
import Fastify from 'fastify';
import { toFastifyPlugin } from '@braidlabs/gateway/fastify';

const fastify = Fastify();
fastify.register(toFastifyPlugin(gateway));
```

### Cloudflare Workers / Fetch Standard

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return gateway.handle(request, async (req) => {
      // Forward non-Braid traffic to host origin
      return fetch(req);
    });
  },
};
```

---

## Manifest Configuration Reference

```ts
interface FragmentManifest {
  /** Unique fragment identifier. */
  id: string;
  /** Upstream endpoint base URL. */
  endpoint: string;
  /** Adapter kind: 'compat' (default) or 'custom-element'. */
  adapter?: 'compat' | 'custom-element';
  /** URL patterns on the host that should server-pierce this fragment. */
  pierce?: string[];
  /** Fixed path of the fragment's document on its endpoint, for SPAs on static origins (e.g. '/index.html'). */
  documentPath?: string;
  /** Upstream timeout in milliseconds before triggering fallback (default: 1500). */
  timeoutMs?: number;
  /** Fallback strategy when upstream fails: 'placeholder' | 'omit' | 'error-html'. */
  fallback?: 'placeholder' | 'omit' | 'error-html';
  /** Whether the page stream waits at this fragment's slot ('in-order', default) or streams past it. */
  stream?: 'in-order' | 'out-of-order';
  /** Let the browser fetch or render this fragment's pierced pages ahead of a click (with the gateway's `speculationRules`). */
  speculate?: 'prefetch' | 'prerender';
  /** Custom Element module entry (for custom-element adapter). */
  entry?: string;
  /** Custom Element tag name (for custom-element adapter). */
  element?: string;
  /** Custom events emitted by the fragment. */
  events?: string[];
}
```

## Streaming past a slow fragment

The gateway fetches the shell and every pierced fragment at once. It splices each fragment in when
the stream reaches its slot, and waits there if that fragment has not answered yet. Everything after
the slot waits with it, for up to the fragment's `timeoutMs`.

`stream: "out-of-order"` removes that wait for one fragment:

```ts
{ id: 'recommendations', endpoint: 'https://recs.internal', pierce: ['/product/*'], stream: 'out-of-order', timeoutMs: 4000 }
```

- **Only a fragment that would hold the stream is moved.** If it has answered by the time its
  slot streams, or within one more turn of the event loop, it is inlined exactly as `in-order`
  would inline it, byte for byte.
- **Otherwise the slot is marked and the stream moves on.** The slot gets `data-braid-deferred`
  and the markup after it streams immediately. Before `</body>`, each late fragment follows as
  soon as it settles, in a hidden `<braid-late>` carrying the same declarative shadow root a pierce
  would. The client moves it into the slot. A token minted per response pairs the two, so no other
  markup can fill the slot.
- **Failures fall back the same way.** A late fragment that fails or times out sends an empty
  `<braid-late>`, marked with its fallback, and the slot boots client-side. `error-html` content
  is delivered like any other content.
- **"Answered" means its response headers arrived.** A fragment that sends headers quickly and then
  streams a slow body is inlined, and its body still holds the stream. Late fragments are sent one
  at a time in the order their headers arrive, so a slow body also delays the late fragments after
  it.

Use it for fragments below the fold or off the critical path. Keep in-order:

- **The fragment that holds the page's largest content (the LCP element).** Moving it to the end
  of the document delays that paint.
- **Any fragment whose space you cannot reserve.** Without the space, its content landing late
  shifts the page.

What it does not change, and what to plan for:

- **The rest of the page still waits for late fragments.** The response stays open until they
  settle, so `DOMContentLoaded`, the `load` event, the host's `defer` and module scripts (its
  hydration), eager fragment boots, and anything started on `load` all wait up to that fragment's
  `timeoutMs`. What gets earlier is the markup after the slot, which parses and paints at once.
  Keep `timeoutMs` modest, and load host scripts with `async` where they can run early.
- **Late content paints when the client runtime runs.** Load it as a classic script in `<head>`,
  or as `type="module" async`, so each late fragment moves in as it arrives. Loaded with `defer`, or
  as a plain module script, it waits for the whole document, and so for the slowest late fragment.
- **Reserve the slot's space.** Use `min-height` or `aspect-ratio` on the slot, or a skeleton on
  `fragment-slot[data-braid-deferred]`, sized to the fragment's usual height. Content taller than
  the reservation still shifts the page. A fragment that times out is fetched again client-side,
  so its content lands later still.
- **No inline script is added.** The move is done by the `<braid-late>` element the client runtime
  defines, so a strict CSP needs nothing new. Without JavaScript the late content stays hidden, and
  the slot shows whatever the host put in it.
- **Hosts that hydrate the whole document** will find `<braid-late>` nodes before `</body>`, and
  may see them as a mismatch. Hydrate an app root instead of `document`.

## Instant navigations with Speculation Rules (opt-in)

The gateway already knows which URLs compose which fragment. With `speculationRules: true` it tells the browser too, so following a link to a fragment's route can show a page the browser has already fetched or rendered:

```ts
createGateway({
  speculationRules: true,
  registry: [
    { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing', '/billing/*'], speculate: 'prerender' },
    { id: 'orders', endpoint: 'https://orders.internal', pierce: ['/orders/:id'], speculate: 'prefetch' },
  ],
});
```

- **Every page carries a pointer to the rules.** Pages the gateway composes, and the navigations it passes to your app, get `Speculation-Rules: "/__braid/speculation-rules.json"`. The page that *links* to a route is the one the browser speculates from. For a passed-through page, the binding sets the header on the way out (`gateway.pageHeaders(request)`, applied by `toNodeMiddleware`, `toWebMiddleware` and `toFetchHandler`). The gateway never reads your app's response to add it, so the page streams exactly as it would without the gateway. The value is the same for every visitor, so cached pages stay shareable, and browsers ignore it on anything but HTML.
- **The rules list each opted-in fragment's `pierce` patterns.** `prefetch` fetches the composed document, so the click skips the round trip. `prerender` also renders it: the realm boots and the fragment's code runs, so the page appears at once and the fragment doesn't fetch its document again. Both trigger with `moderate` eagerness, on hover or pointerdown. Trailing-slash variants are included, matching how pierce routes match.
- **Some links and patterns are never speculated:**
  - links marked `rel="nofollow"`, as user-generated content usually is, or `data-braid-no-speculate`;
  - unbound fragments, which are chrome pierced into pages they don't own;
  - patterns that match any path (`/*`, `/:page`), which would make every same-origin link speculative, `/logout` included.

  Registry analysis warns about the last two.
- **Access rules are respected.** A fragment the visitor may not list or load is left out, as discovery and the namespace keep it out of sight. When the gateway can tell visitors apart (a `principal` resolver) or any fragment has access rules, the response is `private, no-store` and varies on `cookie` and `authorization`. Otherwise it's shared for 60 seconds. In development, nothing is filtered and nothing is stored.
- **Prerendering runs a fragment's code before anyone sees the page.** Analytics, view counts and other side effects fire for pages the visitor may never open, and the request carries the visitor's cookies. That's why it's opt-in per fragment. A fragment that sets `speculate` should treat a request with `Sec-Purpose: prefetch` (`prefetch;prerender` when prerendering) as not yet a visit, and defer side effects in the page until `document.prerendering` is false (the `prerenderingchange` event).
- **Only Chromium implements it.** Other browsers ignore the header. The endpoint isn't available under a `basePath` yet.
- **Testing it under automation takes care.** Chromium won't prerender while a DevTools client is attached straight to the page target, which is how Playwright attaches, and reports `PrerenderingDisabledByDevTools`. Braid's own e2e test drives Chromium over CDP through the tab target instead (`e2e/speculation-rules.e2e.ts`).

## Realm network policy (opt-in)

A manifest's `capabilities.network` lists the origins a fragment is expected to talk to. On the
trusted tier it is advisory by default. Set `realmPolicy` and the gateway turns it into a policy on
the fragment's realm:

```ts
createGateway({
  registry: [{ id: 'billing', endpoint: 'https://billing.internal', capabilities: { network: ['https://api.stripe.com'] } }],
  realmPolicy: 'report', // then 'enforce'
});
```

- **What gets sent.** The realm stub of every compat or custom-element fragment that declares
  `network` carries `connect-src 'self' <its origins>`. With `'report'` it goes as
  `Content-Security-Policy-Report-Only`, with `'enforce'` as `Content-Security-Policy`.
- **What it covers.** The realm's own `fetch`, XHR, WebSocket and EventSource requests, and JSON
  module imports (CSP counts those as connections, so a fragment importing JSON from a CDN needs
  that origin listed). `'self'` is the host origin, so the fragment's own namespace and the host's
  APIs stay reachable.
- **What it does not cover.** Several things stay under the host's policy:
  - markup the fragment puts in the page (images, form actions);
  - `navigator.sendBeacon`, because a compat realm's `navigator` is the host's;
  - any client the host shares through `sharedGlobals`;
  - code that deliberately reaches into the host realm.

  It catches accidents and naive supply-chain exfiltration. It is not a boundary, because the
  trusted tier has none.
- **What you see.** The client logs every request the policy blocks, or would have blocked, with
  the fragment's name and the URL. Start with `'report'`, read the console, add what is missing,
  then switch to `'enforce'`.
- **Entries must be plain origins.** A scheme, a host (optionally `*.`-prefixed) and an optional
  port: `https://api.example.com`, `wss://*.push.example.com:443`. Write internationalised hosts in
  punycode (`xn--…`). IPv6 literals cannot be expressed in a CSP source.
- **Anything else is left out, with a warning.** A path, a quote, `;` or `,` is warned about when
  the registry loads and kept out of the policy, so a manifest cannot add a directive. Leaving an
  entry out makes the policy stricter, never looser. A gateway without `realmPolicy` still starts.
- **An empty list is the strictest declaration:** `connect-src 'self'`, the host origin only.
- **It is the registry's grant only.** A grant passed to `initBraid({ capabilities })` never
  reaches the realm's headers.
- **Unchanged without it.** With no `realmPolicy`, or for a fragment with no `network` at all,
  stubs are unchanged. A stub that carries a policy has its own `ETag`, so turning the policy on,
  off or between modes reaches browsers that cached the old stub.

## Per-fragment cookies

Trusted fragments share the host origin's cookie jar. When fragments' backends finish an
authorization-code login by setting a session cookie, two of them setting `session` with `Path=/`
overwrite each other. With `forwardCredentials`, every fragment's backend also receives every other
fragment's session. A fragment whose manifest sets `capabilities.storage` gets cookies of its own:

```jsonc
{ "id": "orders", "endpoint": "https://orders.internal", "capabilities": { "storage": "partitioned" } }
```

- **On the way out**, the gateway renames each `Set-Cookie` from the fragment's endpoint into the
  fragment's scope: `session=…` becomes `braid$orders$session=…`. A `__Host-` or `__Secure-` prefix
  stays at the front. `Domain` is dropped and `Path` becomes `/`, so the cookie still arrives on
  page requests and a pierced fragment renders signed in. This applies to namespace responses,
  fragment documents and `redirect: 'navigate'` logins.
- **On the way in**, the fragment's endpoint receives its own cookies under the names it set, on
  namespace, document, pierce and websocket requests alike. It gets them even when
  `forwardCredentials` is off, because its own login set them. The host's unscoped cookies are
  added only when `forwardCredentials` allows. If one has the same name as the fragment's own, the
  fragment's own wins. Another fragment's cookies are never sent, to partitioned and shared
  fragments alike.
- **`Clear-Site-Data` is dropped** from a partitioned fragment's responses. Otherwise one
  fragment's logout would wipe every other fragment's cookies and storage along with its own.
- **In the browser**, the fragment's `document.cookie` is the same scoped view (see
  `@braidlabs/core`, "Per-fragment storage").
- **Named partitions share cookies.** Fragments with `{ "partition": "kcd" }` share one scope, so
  fragments on one issuer keep one login. Each of their endpoints then receives the shared session
  whatever `forwardCredentials` says, so name a partition across endpoints only when one team or
  trust boundary owns them all.
- **Compat fragments only.** Custom-element and contract fragments run in the host window, where
  nothing would show them their cookies under their own names, so the grant is ignored for them.

Limits:

- **Every scoped cookie travels on every request** to the origin. Large upstream sessions across
  many fragments can exceed proxy header limits, which are commonly 8–16 KB.
- **Only cookies that pass through the gateway are renamed.** A proxy *in front of* the gateway on
  the same origin, such as an OIDC plugin at the edge, needs its own per-route session cookie
  names.
- **A fragment's requests must go through its namespace** (`/__braid/frag/<id>/…`) for its cookies
  to reach its backend. A call to the host origin directly carries the scoped names, which the
  backend won't recognise.
- **Every scoped cookie has `Path=/`.** A backend that sets one name on two paths keeps only one,
  and a cookie the fragment writes from script with no `Path` lands on `/`.
- **Pierced documents don't forward the fragment's `Set-Cookie`.** That was already true before
  this change. A sliding session is refreshed by the fragment's next namespace request.
- **`cookieStore` is not available in a partitioned realm.** It reads and writes the raw jar.
  Libraries fall back to `document.cookie`, which is scoped.

## Baggage

The gateway doesn't copy the browser's W3C `baggage` header to fragment endpoints. Baggage is
arbitrary key/value context that any page script or extension can set, and it would otherwise flow
into every backend behind every fragment. Say what may pass:

```ts
createGateway({
  registry,
  baggage: {
    // inbound keys to keep, optionally with a pattern their value must match in full
    forward: { tenant: /[a-z0-9-]+/, experiment: /[a-z]+/ },
    // members of the gateway's own, per fragment; they win over a client's with the same key
    set: (request, fragmentId) => ({ 'deployment.environment': 'production', 'braid.fragment.id': fragmentId }),
  },
});
```

- **Values are checked.** An inbound value must be well formed: W3C baggage octets, with valid
  percent-encoding. A pattern must match the decoded value in full, whatever its flags. Keys alone
  (`forward: ['tenant']`) check nothing more, so give a pattern for any value a backend acts on.
- **Properties are dropped.** Member properties (`;…`) are removed, and members that don't parse
  are skipped.
- **Size limits.** A header over the W3C limits (8192 bytes, 180 members) is dropped whole.
- **Trust boundary.** Only fragments that `forwardCredentials` allows receive any baggage. The
  same holds for websocket upgrades: a binding other than the Node one must apply
  `UpgradeTarget.baggage`.
- **Coalescing.** Two fetches with different baggage are never coalesced, so an endpoint that
  routes on a member answers each caller for its own.
- **Tracing.** For OpenTelemetry tracing of fragment fetches, see [@braidlabs/otel](./otel.md).

---

## Per-user preferences (opt-in)

`preferences` serves each signed-in user's own JSON entries at `/__braid/preferences/*`. It is what
`serverStore()` from the [console workspace](./console.md#the-workspace) talks to, so preferences, app
settings and saved layouts follow the user to any browser.

```ts
import { createGateway } from '@braidlabs/gateway';
import { filePreferenceBackend } from '@braidlabs/gateway/node';

createGateway({
  registry,
  principal: async (request) => {
    const session = await sessions.read(request);
    return session && { subject: session.userId, roles: session.roles };
  },
  preferences: { backend: filePreferenceBackend({ directory: '/var/lib/braid/preferences' }) },
});
```

| Request | Answer |
| :--- | :--- |
| `GET /__braid/preferences/{key}` | 200 with the value, or 404 |
| `PUT /__braid/preferences/{key}` with an `application/json` body | 204 |
| `DELETE /__braid/preferences/{key}` | 204 |
| `GET /__braid/preferences?prefix={prefix}` | 200 `{ "keys": [...] }` |

- **Keyed by `subject`.** Entries belong to the `subject` your `principal` resolver returns. It
  must be globally unique and come from your session, never from anything the client sends. An
  OIDC `sub` is unique only per issuer, so with several identity providers use `${iss}|${sub}`.
  A request without a subject is refused with 401. Nothing in a request can name another subject,
  so one user can't read or write another's entries.
- **Same-origin only.** Any request that `Sec-Fetch-Site` marks as cross-site or same-site, or
  that has an `Origin` from another origin when that header is absent, gets 403. That covers reads
  too. PUT and DELETE also need a CORS preflight, which this endpoint never grants, and a PUT must
  be `application/json` (415 otherwise), which an HTML form can't send.
- **Bounded.** A value is limited to 64 KiB (`maxValueBytes`), and a user to 1000 entries
  (`maxEntries`) and 1 MiB in all (`maxTotalBytes`); past any of these, 413. The backend enforces
  the quotas together with the write, so concurrent requests can't exceed them. A key is up to
  eight `/`-separated segments of `A-Z a-z 0-9 . _ ~ % -`, each percent-encoded in the URL;
  anything else gets 400. A slow body is bounded only by your server's own timeouts
  (`server.requestTimeout` in Node).
- **Never cached.** Every answer is `private, no-store`.
- **Backends.** `memoryPreferenceBackend()` for tests. `filePreferenceBackend({ directory })`, from
  `@braidlabs/gateway/node`, keeps one file per user (mode 0600, named by a hash of the subject),
  written atomically. Behind several gateway instances, implement `PreferenceBackend` (`get`,
  `set`, `delete`, `list`) over your database. Its `set(subject, key, json, limits)` must check
  `limits` in the same transaction as the write. `withinLimits()` does the arithmetic. Reject with
  `PreferenceQuotaError` to have the gateway answer 413.
