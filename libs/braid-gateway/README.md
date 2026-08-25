# @braidlabs/gateway

> Every `/__braid/…` URL this package serves — what asks for it, when, and what comes back — is
> walked through in [Braid, explained](../../docs/braid-explained.md#4-the-__braid-urls).

The Braid gateway: fetch-native, platform-neutral origin-front middleware. Routes fragment
traffic by **exact id** under the reserved `/__braid/frag/:fragmentId/*` namespace — no route
pattern sniffing, no header-trust fallback — and passes everything else through to your existing
app.

Braid's founding architecture lives in [`docs/braid-architecture.md`](../../docs/braid-architecture.md).

Also see: [failure modes](../../docs/braid-failure-modes.md) ·
[CDN configuration](../../docs/braid-cdn.md) ·
[using Braid without the gateway](../../docs/braid-without-gateway.md)

## Usage

```ts
import { createGateway } from '@braidlabs/gateway';

const gateway = createGateway({
  registry: [
    // adapter defaults to "compat" — zero fragment code required
    { id: 'legacy-billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] },
  ],
});
```

The registry is data, not code: pass inline manifests, a URL to a JSON array of manifests,
or an async loader (file/KV/database). Deploying a fragment never redeploys the gateway.

A fragment that ships a **web component** rather than a whole app declares the adapter, the module
to load, and the element to mount:

```ts
{ id: 'rating', endpoint: 'https://widgets.example.com',
  adapter: 'custom-element', entry: '/star-rating.js', element: 'star-rating',
  events: ['rating:change'] }
```

### The registry as an FDC3 App Directory

```ts
createGateway({ registry, discovery: { appd: true } });
```

Serves the same registry in FDC3 App Directory shape at `/__braid/registry/appd/v2/apps` (and
`/appd/v2/apps/{appId}`). It is a **projection, not a second directory** — same manifests, same
`access.list` rules — so a caller can never see through AppD a resolver that discovery would have
hidden. `findIntent` becomes a registry query, and a user only sees resolvers they may use.

Manifests contribute intents through an `fdc3` block and listing metadata through `appd`:

```ts
{ id: 'billing', endpoint: '…', pierce: ['/billing/*'],
  fdc3: { listensFor: { ViewInvoice: { contexts: ['fdc3.instrument'] } },
          raises: { ViewChart: ['fdc3.instrument'] } },
  appd: { publisher: 'Payments', contactEmail: 'payments@example.com' } }
```

Two mapping decisions worth knowing:

- **`details.url` is a page, when there is one.** AppD asks where a web app lives; a fragment lives
  inside a host page. If the fragment declares `pierce`, the first concrete pattern names a page it
  actually appears on and that is the URL — follow it and you see the app. Otherwise the mount is
  used, and `hostManifests.braid.standalonePage` says which you got.
- **Braid launch detail rides in `hostManifests`**, which is what AppD reserves for exactly this.
  A fragment is *mounted into a page*, not opened as a window, so a Braid-aware agent reads
  `hostManifests.braid` and mounts a `<fragment-slot>`; one that does not falls back to the URL.

An app the caller may not list 404s exactly as an unregistered one does — distinguishing them would
let an unauthorized caller enumerate the registry one id at a time.

Verify the record shape against the FDC3 AppD v2 spec before depending on it; the schema carries
more optional members than this projects.

A relative `entry` is re-rooted into the fragment's namespace, so the module and its imports are
fetched through the gateway rather than from the host's root. Such a fragment serves no document,
and the gateway answers its document request with `204` rather than forwarding it.

## Bindings

The core is `handle(request, next)` — fetch-native and platform-neutral. Piercing needs to
*read* the shell's response, so each binding differs in how it obtains it. All three below are
covered by integration tests against the real frameworks (`bindings.spec.ts`).

**Express / Connect / Vite / plain `http`** — mount it first; `next()` runs the rest of the app,
and the gateway reads what it writes:

```ts
import { toNodeMiddleware } from '@braidlabs/gateway/node';

app.use(toNodeMiddleware(gateway));
```

**Angular SSR (`@angular/ssr/node`)** — mount `toNodeMiddleware` on Express before the Angular handler, and enable `trustProxyHeaders` on `AngularNodeAppEngine` so forwarded gateway headers are accepted:

```ts
const angularApp = new AngularNodeAppEngine({
  allowedHosts: ['localhost', '127.0.0.1'],
  trustProxyHeaders: true,
});
app.use(toNodeMiddleware(gateway));
```

**NestJS** — the Express adapter is a Connect stack, so the same binding applies:

```ts
const app = await NestFactory.create(AppModule);
app.use(toNodeMiddleware(gateway));
```

**Nitro / h3 / Workers / Deno / Bun** — wrap the app's fetch handler:

```ts
import { toFetchHandler } from '@braidlabs/gateway';
import { toWebHandler } from 'h3';

export default toFetchHandler(gateway, toWebHandler(app));
```

For a built Nitro app, the gateway also composes in front of the generated Node listener, which
needs no Nitro internals and matches the "origin-front middleware" model:

```ts
import { listener } from './.output/server/index.mjs';

const braid = toNodeMiddleware(gateway);
createServer((req, res) => braid(req, res, () => listener(req, res)));
```

A fetch-style middleware form is available too:
`toWebMiddleware(gateway)(request, () => shellResponse)`. In every binding the shell application
runs at most once per request.

## What it serves

- **Realm stubs** (`/__braid/realm/:id/*`): a minimal document carrying the composition protocol
  version, the manifest-declared adapter, and a `<base>` that keeps every relative subresource
  request inside the fragment's namespace. Version mismatches fail in the client as named errors
  — no title-check heuristics.
- **Fragment documents** (`/__braid/doc/:id/*`): the fragment's HTML prepared for the host page's
  DOM — exactly what piercing injects, for the client-boot path.
- **Fragment assets/data** (`/__braid/frag/:id/*`): forwarded to the endpoint with the prefix
  stripped, so endpoints see the same paths they serve standalone. Redirects pass through
  unfollowed; each fragment gets a manifest-declared timeout budget.
- **Pierced documents**: see below.
- **Unknown ids**: 404, never the app shell.

## Piercing

Add `pierce` patterns to a manifest and the gateway server-renders that fragment into the page:

```ts
{ id: 'legacy-billing', endpoint: 'https://billing.internal', pierce: ['/billing', '/billing/*'] }
```

On a matching document request the gateway fetches the shell and every matching fragment
concurrently, then **interleaves** the fragments into the shell's response stream — a fragment
never serializes behind the shell. Each fragment lands in the `<fragment-slot>` that names it,
as a declarative shadow root, so the browser parses it into exactly the shape the client runtime
would have built; the slot then adopts it instead of fetching. Shells with no matching slot get
one created before `</body>`.

Fragment HTML is transformed on the way through: the doctype is stripped, `<html>/<head>/<body>`
become `braid-html/braid-head/braid-body` (start *and* end tags), scripts are neutralized to
`type="inert"`, and script preload links become `rel="inert-*"`. Fragment scripts are therefore
never live in the host realm, not even between parsing and activation.

If a fragment can't be server-rendered, the page still renders and the slot is left for the
client runtime to fill — a transient SSR failure self-heals rather than becoming a visible
error. Set `fallback: 'error-html'` on the manifest when a missing section is worse than a
visible failure.

## The three namespaces

Each kind of thing the gateway serves has its own path. That is a caching decision: a URL whose
response depends on a request header needs that header in every cache key between here and the
browser, and most CDNs ignore `Vary` on anything but `Accept-Encoding`.

| Path | Serves | Cacheable |
| --- | --- | --- |
| `/__braid/frag/:id/*` | the fragment's own endpoint — assets, data, anything it serves | **yes, on URL alone** — this is nearly all the traffic |
| `/__braid/realm/:id/*` | the realm stub the fragment's hidden iframe boots from | yes, on URL alone (1h + `stale-while-revalidate`) |
| `/__braid/doc/:id/*` | the fragment's document, prepared for the host page's DOM | per the fragment's own cache headers |

**No braid URL varies on a request header.** Point a CDN at them and they cache correctly with
no configuration at all.

### The one thing that does vary

| Header | URL | Response changes to | Why |
| --- | --- | --- | --- |
| `sec-fetch-dest: document` | a page URL some fragment `pierce`s | the shell with fragments composed into it | A page navigation gets a complete document with fragments already inside. The same URL fetched by a client-side router wants the SPA's own payload, and injecting a declarative shadow root into that would corrupt it. The browser sets this header; it must reach the origin. |

Both representations carry `Vary: sec-fetch-dest` — and, because most CDNs honor `Vary` only for
`Accept-Encoding`, the gateway also rewrites `Cache-Control` on these URLs to keep them out of
shared caches: `public` and `s-maxage` are dropped, `private` is added, and your own `max-age` /
`no-store` / `stale-while-revalidate` are untouched. Browser caching still works.

Set `pierceCacheControl: 'preserve'` to opt out — only if the pages are anonymous *and* you have
put `sec-fetch-dest` into the edge's cache key. See [CDN configuration](../../docs/braid-cdn.md).

The gateway sends `Vary: sec-fetch-dest` on those page responses.

**Why `Vary` at all.** HTTP caches key on the URL. When one URL can return different bodies
depending on a request header, the cache must include that header in its key or it hands the
wrong body to the next caller. `Vary` is how the origin says which headers matter — but it is
advisory, and many CDNs honor it only for `Accept-Encoding`. Since only *page* URLs vary now,
and page URLs are usually personalized and uncacheable anyway, the practical advice is simply:
don't edge-cache pierced pages. See [CDN setup](../../docs/braid-cdn.md).

## Discovery endpoint (optional)

For shells that build their UI from the registry rather than hard-coding slot names — a launcher,
an admin console, a directory of available apps — the gateway can publish a paginated listing.
It is **off by default**, because a registry describes internal topology.

```ts
const gateway = createGateway({
  registry,
  discovery: {
    path: '/__braid/registry', // default
    pageSize: 100, // default; also the ceiling unless maxPageSize says otherwise
    principal: (request) => sessionFrom(request), // → { roles, permissions }
  },
});
```

```
GET /__braid/registry?page=2&pageSize=50
```
```json
{
  "items": [{ "id": "billing", "title": "Billing", "adapter": "compat", "mount": "/__braid/frag/billing/" }],
  "page": 2, "pageSize": 50, "total": 137, "totalPages": 3, "hasMore": true,
  "protocolVersion": "1"
}
```

**Defaults that protect you.** Internal `endpoint` values are withheld unless you set
`includeEndpoints`. Listings are `no-store` and vary on `cookie`/`authorization`, so a shared
cache can never serve one caller's listing to another. Page size is capped however large a number
the caller asks for.

**Development mode lists everything** — every fragment, with endpoints, ignoring `access` rules —
and logs a warning at startup saying so. That is deliberate for local debugging and must not ship;
the response carries `"unfiltered": true` so a client can tell.

## Access: who may list, who may load

**Everything is public by default.** A manifest with no `access` is listed for everyone and
loadable by everyone. Restrict only what needs restricting, and declare it at registration so a
fragment's own team owns its exposure rather than every host re-deciding it.

```jsonc
{
  "id": "payroll",
  "endpoint": "https://payroll.internal",
  "access": {
    "list": { "roles": ["finance", "admin"] },   // who sees it in the registry
    "fetch": { "roles": ["finance"] }            // who may actually load it
  }
}
```

The two rules are independent, which is the point:

| `list` | `fetch` | Behavior |
| --- | --- | --- |
| open | open | the default — a public fragment |
| open | restricted | shown in a launcher, refused on load; listings mark it `"loadable": false` so the UI can render that state |
| restricted | open | kept out of listings, still loadable by anyone with a deep link |
| restricted | restricted | invisible and unreachable — to that caller it does not exist |

Within a rule, **roles are any-of** (holding one of them is enough) and **scopes are all-of** (an
operation requiring two scopes needs both). Declare either or both.

Wire up who is asking once, at the gateway:

```ts
createGateway({
  registry,
  principal: (request) => sessionFrom(request), // → { roles, scopes }
  discovery: {},
});
```

`principal` is only consulted for fragments that actually declare `access`, so a public registry
never pays for a session lookup on asset requests.

**Enforcement.** `access.fetch` applies to every namespace request — the realm stub, the
document, and every asset — and to piercing, where an unauthorized fragment is simply not
composed into the page (the slot is left empty rather than the page failing). A caller who may
list but not load gets `403`; a caller who may not even list it gets `404`, because confirming
existence would turn the namespace into an inventory of what they cannot reach.

**Development mode bypasses access rules entirely**, so local work needs no session wiring.

This is authorization for *composition*, not a substitute for the fragment's own. The fragment's
endpoint should still authorize the requests it receives.

## Telemetry (optional)

Off unless configured. One hook, two kinds of event — what the gateway did, and what the browser
experienced — both attributed to the fragment responsible.

```ts
createGateway({
  registry,
  telemetry: {
    on: (event) => otel.emit(event),
    webVitals: true,   // also collect LCP/CLS/INP/FCP/TTFB in the browser
    sampleRate: 0.1,   // of browser sessions, not of metrics
  },
});
```

| Event | When | Carries |
| --- | --- | --- |
| `fragment-fetch` | the gateway fetched a fragment endpoint | `fragmentId`, `phase`, `outcome`, `status`, `durationMs` |
| `web-vital` | a browser reported a vital | `name`, `value`, `rating`, `fragmentId`, `pathname` |

`phase` separates a **pierce** fetch, which delays the page, from a **namespace** fetch, which
delays only that fragment. `outcome` reports a 5xx as `ok` with its status: the distinction an
operator needs is *did we reach it*, and folding a reachable-but-broken endpoint in with an
unreachable one loses it.

### Why per-fragment vitals are the point

Server-side timings per fragment are ordinary — a reverse proxy gives you those. Web vitals per
*fragment* are not, because in a composed page the page-level number is an average over apps owned
by different teams. "The page has a CLS of 0.31" starts an argument; "ninety percent of the layout
shift happened inside `reviews`" ends it.

Attribution works by climbing from the reported element to its enclosing `<fragment-slot>` —
**through shadow roots**, since a pierced fragment's DOM lives in a declarative shadow root where
`closest()` stops at the boundary. `fragmentId: null` is a real answer, not a gap: TTFB belongs to
the document, and an LCP element in the shell's own markup is genuinely the shell's.

`webVitals` is off by default because it serves a collector from `/__braid/vitals.js` and injects
it into every composed page, which is a deployment's decision rather than a library's. The
collector is ~2 kB, hand-written rather than pulling in `web-vitals`, and beacons to
`/__braid/vitals` on `visibilitychange`/`pagehide`.

**That endpoint is reachable by anyone who can load the page**, so nothing it receives is trusted:
metric names are checked against the five, values must be finite and positive, the pathname is
stripped of its query and length-capped, the batch is capped, and a `fragmentId` the registry does
not know is nulled rather than relayed. It always answers `204` — the browser is unloading and
nothing is listening, so a status code would only tell a prober what the endpoint accepts.

The hook is wrapped: a throwing sink is logged once and then muted, because a feature meant to be
left on in production must not be able to take the site down. (`observe` deliberately does *not*
do this — a broken analysis hook should fail loudly, since silently recording nothing corrupts the
decisions its data feeds.)

### What the listing publishes

Each entry carries what a consumer needs to *embed* the fragment, not just name it: `id`, `title`,
`adapter`, `mount`, `pierce`, `loadable`, and — because they change the required markup — `bound`
and `src`. A widget embedded without its `src` renders an empty shell on every page, so a listing
that omitted it would force every consumer to guess. `endpoint` appears only when
`includeEndpoints` is on, or in development.

The registry console uses exactly this to generate copy-pasteable integration code per fragment.

## Circuit breaker (optional)

```ts
createGateway({ registry, breaker: true });            // 3 failures, 10s cooldown
createGateway({ registry, breaker: { failureThreshold: 5, resetTimeoutMs: 30_000 } });
```

**The problem is compounding, not failure.** A fragment endpoint that is down already costs its
full `timeoutMs` — but it costs that on *every* request, because nothing remembers the last one.
Four fragments at a 3s budget is a page held hostage to the worst of them, repeatedly, with the
shell's response waiting behind it. The fallback machinery already handles a fragment that fails;
what it cannot do is stop paying to rediscover that it fails.

So this is a **latency control first, an availability control second**. When the circuit is open
the manifest's declared fallback is served immediately instead of after the budget expires — the
rendered result is identical, it just arrives in ~0ms.

Per fragment id, never global: fragments are independently deployed, and one team's bad release
must not shed another team's traffic. A 5xx counts as a failure (reachable is not the same as
working). A shed request reports `outcome: 'shed'` rather than `'error'`, so an operator counting
failures does not count our own load-shedding as the endpoint failing again. Transitions arrive on
the telemetry hook as `kind: 'breaker'` — on the four state edges only, never per request.

Off unless configured, because shedding load is a behaviour change a deployment should opt into.

## Concurrent-fetch coalescing (on by default)

Composing a page costs one origin fetch per fragment. A widget pierced into `/` and `/*` is fetched
once per render, so fifty concurrent renders are fifty identical fetches of the same header panel.
The gateway collapses those into one.

```ts
createGateway({ registry });                                  // on
createGateway({ registry, coalesceFragmentFetches: false });  // off
```

**Not a cache.** It only notices that a fetch it is already making is the one another request
wants; nothing outlives the request that started it. No TTL, no invalidation, no shared state, and
no dependence on which instance a request lands on — which is what makes it safe by default on ECS
or any horizontally scaled deployment.

The key is computed from the request that is actually **sent**, so it contains exactly what the
endpoint can see: `user-agent`, the negotiation headers, any header the gateway itself added via
`additionalHeaders`, and — when `forwardCredentials` is on — `cookie` and `authorization`. A
fragment declaring `access` rules is never shared at all.

Because credentials are not forwarded by default, two signed-in users produce a byte-identical
fragment request and *do* share a flight, which is correct: the endpoint cannot tell them apart.
Turn on `forwardCredentials`, or add a per-caller header, and they stop sharing again. Sharing a
render across identities the endpoint *can* distinguish is a data leak wearing a performance
feature's clothes, so anything that varies by caller has to be in the key.

For an endpoint that varies on something the gateway cannot see — a tenant or feature-flag header —
opt out on the manifest with `coalesce: false`.

How much it saves scales with endpoint latency × concurrency. Against a 120ms endpoint, ten
parallel renders collapse to one fetch; against a fragment on localhost answering in 10ms the
requests barely overlap and it saves nothing. Measure somewhere that resembles production.

## Content Security Policy

The gateway injects inline markup into someone else's document: the `<style>` that makes slots lay
out as blocks, and — when `webVitals` is on — the collector `<script>`. Under a strict policy
(`script-src 'nonce-…'`) the browser drops anything unstamped **silently**, which is the worst
failure shape available: the page renders, the slot layout rule is gone, and no server log mentions
it.

So the gateway reads the nonce from the shell's *own* `Content-Security-Policy` response header and
stamps what it injects. Nothing to configure — it works if your shell already sends a nonce.

It never mints one. A nonce the shell's policy does not list is not trusted, and a nonce reused
across responses is not a nonce. A shell with no policy, or one using hashes or `'unsafe-inline'`,
gets unstamped markup, which is correct for all three.

## Security posture

The trusted tier is **namespace isolation, not a security boundary**: fragments are same-origin
with the host and share its cookies, storage, and DOM reachability. What the gateway does
guarantee is that nothing a fragment sends can execute JavaScript in the *host realm* or
navigate the host page — scripts are neutralized, inline `on*` handlers are stripped, and
`<meta http-equiv="refresh">` is defanged. Fragment code runs in the fragment's realm or not at
all.

Deliberately not neutralized, because they require a user to act rather than executing on parse:
`javascript:` URLs and form `action`s. A trusted fragment can navigate a page the user clicks
through.

Defaults worth knowing: `x-forwarded-proto`/`x-forwarded-host` are **overwritten** from the real
request (opt into passthrough with `trustForwardedHeaders` only behind a proxy you control); an
endpoint's path is a boundary, so `endpoint: 'https://internal/apps/billing/'` cannot be used to
reach the rest of that origin; and the caller's `Cookie` and `Authorization` are **not** forwarded
to fragment endpoints.

That last one is the trust boundary between a shell and the fragments it composes. Those headers
authenticate the caller to *the shell's* origin, and a fragment endpoint is frequently a different
team and often a different company — forwarding them would let every fragment backend act as that
user against the shell. A fragment that needs to know who is asking should be given something
scoped to it: a per-request assertion via `additionalHeaders`, or a token exchanged for the
fragment's own audience. `forwardCredentials: true` restores the old behaviour, and is only
appropriate when every endpoint in the registry sits inside the same trust boundary as the shell.

Not yet implemented from the architecture's security section: allow-listed manifest origins and
signed manifests. Until those land, treat the registry as trusted configuration.

**The rewriter is owned, not forked.** `rewriteHtmlStream` is a small streaming HTML
rewriter with bounded memory and chunk-boundary safety; its conformance vectors
(`html-rewrite-stream.spec.ts`) are the oracle any second implementation — a native
`HTMLRewriter` path on workerd, say — must pass before it is allowed to serve traffic. Only the
owned path ships today, because `HTMLRewriter` does not exist in Node and an untested dual path
is how the upstream project got wasm/native drift.
