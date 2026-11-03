# @braidlabs/sw

Skew-aware asset serving for composed pages.

The classic micro-frontend white screen: a user has the page open, a deploy lands, they click
something that lazy-loads `main.abc123.js` — and it is gone, because the new build wrote
`main.def456.js`. Nothing on the page can recover. The request comes from the module loader, the
response is a 404, and the route dies.

A service worker is the **only** layer that can answer that request from a copy it kept.

Braid makes this materially cleaner than it is for a monolith. Every fragment's assets live under
`/__braid/frag/:id/*`, so each fragment gets **its own cache partition keyed by its own build**.
Fragment A at build 5 and fragment B at build 12 coexist, with no shared cache generation for one
deploy to invalidate on the other's behalf. A monolith's worker has one bucket and one answer.

---

## Two shapes

Both ship, because "the app already has a service worker" is not a safe assumption — least of all
for internal enterprise apps.

**A handler, for a worker you already own.** Braid never takes your `fetch` event:

```js
// your sw.js
import { braidFetchHandler } from '@braidlabs/sw';
const braid = braidFetchHandler({ buildId: BUILD_ID });

self.addEventListener('fetch', (event) => {
  const handled = braid(event.request); // null for anything not ours
  if (handled) event.respondWith(handled);
});
```

**A complete worker, for shells with none.** Same handler, already wired:

```js
// sw.js
import { setupBraidWorker } from '@braidlabs/sw';
setupBraidWorker({ buildId: BUILD_ID, precache: ['billing', 'notifications'] });
```

## Let the gateway serve it

```ts
createGateway({ registry, serviceWorker: true });                  // scope '/'
createGateway({ registry, serviceWorker: { scope: '/apps/' } });   // path-mounted deployments
```

```ts
import { registerBraidServiceWorker } from '@braidlabs/core';
await registerBraidServiceWorker({ buildId: BUILD_ID });
```

**A worker's scope is capped by the path it is served from.** A script at `/__braid/sw.js` defaults
to controlling `/__braid/` — enough for fragment assets, useless for the shell's own, which is the
chunk-failure case that matters most. Widening it needs `Service-Worker-Allowed` on the script
response, and the gateway is the one component already in front of the origin that can send it
without touching infrastructure config.

Claiming `/` sounds broad and costs nothing: scope precedence is longest-match, so a worker
registered at `/legacy/` still controls `/legacy/` whatever Braid claims. The root is a fallback,
not an exclusion — and the handler returns `null` outside the namespace anyway.

The generated script is **byte-stable across registry publishes**. Baking the snapshot id into it
would make every publish a worker update with its own waiting and activation lifecycle;
configuration churn must not become worker churn.

## What it will and will not do

| | |
| --- | --- |
| Serves a cached chunk when the origin 404s it | ✅ the deploy case |
| Serves from cache when the network is gone | ✅ offline |
| Answers a 500 from cache | ❌ that is an outage, and hiding it makes it someone else's mystery |
| Answers a POST | ❌ a cache cannot, and pretending turns a failed write into a stale success |
| Touches anything outside `/__braid/` | ❌ never |
| Caches fragment **documents** | ❌ composed markup's freshness is the gateway's business |

## Offline composition

Opt-in, and the piece with the most leverage: the worker runs **the gateway's own piercing**.

```js
setupBraidWorker({
  buildId: BUILD_ID,
  offline: { snapshotUrl: '/__braid/registry/pinned.json' },
});
```

The gateway core is runtime-neutral — no `node:` imports in the gateway, the registry, or the
rewriter — and a service worker is a web-standard runtime. So the worker holds the shell and the
fragment documents and interleaves them with the same `pierceShellHtml` the server runs. A second
implementation of piercing would be a second set of piercing bugs, found offline.

**It holds the parts, not the finished page.** Caching composed HTML would be simpler and much less
useful: the composed page is the cross-product of shell, fragments, and route. Holding the parts
means a route visited once composes offline afterwards, a fragment updates its own part, and a
fragment with nothing cached degrades to a placeholder instead of failing the page.

The shell is re-fetched with `sec-fetch-dest: empty`, which is how the gateway already distinguishes
a soft-navigation fetch from a document request — the same distinction every pierced response
declares in its `Vary` header, used from the other side.

Two things it will not do: compose while the network is reachable (the gateway is authoritative),
and cache a composed response (a page pierced against a registry that has since changed is exactly
the stale artifact this package exists to avoid). Composed pages carry
`x-braid-composed: offline` so a shell can say so rather than look merely slow.

**What it keeps is one person's.** The parts are fetched with the user's cookies, and the cache
outlives the session. It keeps nothing the origin marked `Cache-Control: no-store` (and drops a copy
it kept before the origin said so), and nothing for a route no fragment pierces. `private` pages are
kept: that directive is about shared caches, this one is the browser's own, and the gateway marks
every pierced page `private` by default. So clear it at sign-out, or the next person on the device
is served the last one's pages whenever the network drops. A refresh still running when the clear
lands does not write afterwards:

```ts
// in the page, at sign-out
navigator.serviceWorker.controller?.postMessage({ type: 'braid-sw:clear' }); // replies { type: 'braid-sw:cleared', ok }

// or in your own worker
import { clearBraidCaches } from '@braidlabs/sw';
await clearBraidCaches();
```

## The gateway in the worker, for static hosting (`@braidlabs/sw/gateway`, proof of concept)

Offline composition runs the gateway's piercing in the worker against the cache. The
`@braidlabs/sw/gateway` entry runs the **whole gateway** in the worker against the network. That's
for a shell on purely static hosting (a bucket, a CDN, GitHub Pages) with no server to put a gateway
on. It's the same `createGateway` the server runs, with the network as its shell.

```js
// sw.js — bundled, and served from the root so its scope covers the shell
import { setupBraidGateway } from '@braidlabs/sw/gateway';

setupBraidGateway({
  registry: [{ id: 'billing', endpoint: new URL('/billing-app/', self.location.origin).href, pierce: ['/billing/*'] }],
  claimClients: true, // the installing page composes without a reload
  assets: {}, // optional: the skew cache, in front of the in-worker gateway
});
```

Its own entry, rather than part of `@braidlabs/sw`, because it is a different decision. The main
entry keeps a *server* gateway's assets alive and stays small enough to compose into any worker. It
bundles none of the gateway's router. This entry *is* the router, rewriter and piercing.

To compose it into a worker you already own, use `braidGatewayHandler(options)`. It returns a handler
that decides synchronously, as `respondWith` requires:
- It claims same-origin requests under `/__braid/` (or under `basePath`) and the browser's own GET
  navigations.
- Everything else, including a page's own `fetch` for HTML, returns `null`.

Its `.fetch` routes any request through the gateway. Hand it to the asset handler, and the skew
cache sits in front of the in-worker gateway as it would in front of a server one. Without it, the
asset handler's misses go to the network, and on a static host that's a 404:

```js
const braid = braidGatewayHandler({ registry });
const assets = braidFetchHandler({ fetch: braid.fetch });
self.addEventListener('fetch', (event) => {
  if (!braid.claims(event.request)) return; // the asset handler matches by path alone, on any origin
  const handled = assets(event.request) ?? braid(event.request);
  if (handled) event.respondWith(handled);
});
```

The page starts Braid once the worker controls it. Until then `/__braid/` is a 404 on a static host.
A hard reload loads the page past a worker that is already active, and an active worker doesn't
claim a page unasked, so the page asks:

```js
if (!navigator.serviceWorker.controller) {
  const changed = new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  const registration = await navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/' });
  registration.active?.postMessage({ type: 'braid-sw:claim' }); // BRAID_CLAIM_MESSAGE, honoured with claimClients
  await changed;
}
initBraid();
```

[`examples/sw-gateway`](../../examples/sw-gateway) is the proof of concept. It's a static server with
no gateway, serving the fragment zstd-compressed as a CDN would. The fragment composes, boots in its
realm, pierces, and comes back after a hard reload. The repository's e2e runs that example in
Chromium and asserts no `/__braid/` request ever reaches the server.

### What running in a browser changed

The server never meets any of these. The e2e found each one, and fails without its fix:

- **Navigation requests can't be copied.** The gateway derives fragment requests with
  `new Request(url, request)`, which a browser refuses for a `navigate`-mode request. The gateway
  caught the error and pierced a placeholder.
  - The handler now hands the gateway a non-navigation copy, and the shell still loads through the
    browser's own navigation.
  - The copy sends credentials as a page's own `fetch` would (same-origin), not as the navigation's
    `include`.
  - It keeps a POST's body.
- **`accept-encoding` is a forbidden header.** The gateway pins it on a server so it knows which
  codings `fetch` decoded, and a browser silently drops the pin. The gateway now notices the header
  didn't take and trusts the browser to have decoded whatever it asked for, instead of refusing
  `zstd` with a 502.
- **Navigation preload is off.** The browser preloads *every* navigation in scope, including the
  realm frames' navigations, which the worker answers itself. Each would also go to a server with no
  answer for it. `setupBraidGateway` turns preload off. A worker of your own that enables it should
  expect those requests.

Two came from review rather than the e2e, and have specs:
- **A redirecting shell is handed back to the browser.** A navigation's own `fetch` returns an
  opaque redirect, for example when the host answers `/billing` with `/billing/`. It can't be copied
  into a new response, so the gateway passes any status-0 shell through untouched.
- **A page's `fetch` for HTML isn't a navigation.** The gateway can't see `Sec-Fetch-Dest` from a
  worker. Claiming an htmx or Turbo request by its `Accept` header would pierce it as a document.

### Requirements, and where each stands

1. **The first visit must work without a reload.** *Met in the POC, partly.*
   - The page registers the worker and starts the runtime once a controller exists, and
     `claimClients` hands it the page. A hard reload asks the active worker to claim it.
   - The first paint isn't composed. Fragments boot client-side, and every later navigation is
     pierced by the worker.
   - Still open: build-time realm stubs, and a timeout on the wait.
2. **Fragment origins must send CORS headers.** *Documented, not exercised.* The worker reads what
   it pierces, so a cross-origin endpoint needs `Access-Control-Allow-Origin` naming the shell's
   origin. The POC's endpoint is same-origin. The endpoint also has to be public: on a server it can
   sit behind the gateway, but here the browser fetches it.
3. **Authenticated fragments must be same-origin with the shell.** *Documented.* The worker can't set
   `Cookie` by name, and its fragment requests send credentials same-origin only, as the page's own
   do. So a same-origin endpoint gets the browser's cookies and a cross-origin one gets none.
   `forwardCredentials` and per-fragment cookie scoping can't take effect: the browser's cookie rules
   replace them.
4. **There must be a fallback where no worker can run.** *Open.* Without a worker, the namespace is
   a 404 on a static host. The POC page waits for a controller indefinitely.
5. **What the server gateway enforces is advisory here.**
   - `access` and `redirectOrigins` run on the user's device, where the user can change them.
     Anything that must hold against the user stays on the fragment's own origin.
   - Everything in the options ships in the public `sw.js`, `additionalHeaders` included, so they
     must hold no secrets.
   - A fragment's redirect comes back to the worker opaque, so `redirect: 'navigate'` can't be
     honoured. It fails closed: a pierced slot falls back to its placeholder.
   - On `SameSite`, by reasoning rather than a browser test: a worker pierce sends a same-origin
     fragment the cookies the page's own client-side compose would send a moment later. That
     includes `Strict` ones after a cross-site link, which a server pierce wouldn't see. The shell
     should refuse cross-site framing, and the example sends `X-Frame-Options: SAMEORIGIN`.
6. **The registry must be pinned.** *Open.* The POC bakes its registry into the worker, so a
   registry change is a worker update. That's version discipline of a kind, but it isn't
   `snapshotUrl` loading and verification.
7. **The gateway core stays runtime-neutral.** *Holds.* The worker bundles the gateway apart from two
   fixes that apply on any runtime: the coding fix above, and passing an opaque shell through. A
   worker that imports only the main entry carries none of it.

### Open questions

- **Worker startup on every navigation.** With preload off, a navigation's shell request waits for
  the worker to boot, which can be tens of milliseconds on mobile. Requests it doesn't answer no
  longer pay that where the browser has static routing. `setupBraidGateway` declares its namespace
  and navigations at install (`staticRoutes`, on by default), and everything else goes straight to
  the network.
- **Which `x-braid-composed` value** a worker-composed online page should carry, so it can be told
  apart from a server-composed one in telemetry.
- **`assets` together with `basePath`.** The asset handler only recognises the namespace at the
  root, so `setupBraidGateway` refuses the combination for now.

## The worker is itself a skew vector

It is a long-lived deployment artifact that updates on its own schedule — a version boundary added
to a system whose purpose is managing version boundaries. So it gets the same discipline: it knows
its build and the snapshot it serves, and says so when they disagree with the page.

```ts
await registerBraidServiceWorker({
  buildId: BUILD_ID,
  onVersion: (report) => telemetry.record(report),
});
```

`claimClients` is off by default for the same reason. Claiming swaps the worker underneath a page
that is already running, so a page mid-session starts being served by a build it did not load
against. Waiting for the next navigation is the boring, correct behaviour.

## Reports that survive the tab closing

```js
setupBraidWorker({
  buildId: BUILD_ID,
  reports: { endpoint: '/__telemetry', driver: indexedDbRecordDriver({ database: 'braid-sw' }) },
});
```

The worker knows things nobody else can see — that a chunk was served from cache after the origin
404'd it, that its build disagrees with the page's. Handed to `onReport` those facts are
fire-and-forget, and the ones that go missing are disproportionately the interesting ones: a user who
hits a broken deploy is a user who closes the tab, and a `fetch` started during teardown loses that
race.

Queued reports are flushed on a Background Sync event — the browser wakes the worker when it judges
the network is back, with no page open and nothing racing teardown. Background Sync is Chromium-only,
so every activation also flushes opportunistically; a browser without it gets that path and nothing
else.

The queue is `@braidlabs/data`'s outbox rather than a second implementation: one record per entry, so
appending never reads the queue first and two contexts cannot lose each other's writes. A refused
batch stays queued in full — partial credit would need the endpoint to say which records it took,
and no telemetry endpoint does.

## Not a data cache

The Cache API stores `Request → Response`. The data layer needs per-entity keys, versioned
envelopes, and migrate-on-read; the Cache API offers none of the three, and storing enveloped
entities as opaque response bodies would defeat the projection the whole design rests on.

**Cache API for assets and stubs. IndexedDB (`@braidlabs/data`) for entities.**
