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

## The gateway in the worker, for static hosting (requirements, not built)

Offline composition already runs the gateway's piercing in the worker. The open question is whether
the worker can be the gateway **while online**, for a shell on purely static hosting (a bucket, a
CDN, GitHub Pages) with no server in front of it. Nothing below is built. It records what an
implementation must satisfy, so the design starts from the constraints rather than discovering them.

**What it would do.** It would serve `/__braid/realm/:id/*` stubs, proxy `/__braid/frag/:id/*` and
`/__braid/doc/:id/*` to each fragment's origin, and pierce document navigations, all with the
gateway's own code. That is exactly what offline composition does now, but against the network.

### Requirements

1. **The first visit must work without a reload.** No worker is installed on a first visit, so the
   design is:
   - The static host serves the shell and realm stubs generated at build time. Stubs are
     byte-stable per registry snapshot, so they can be plain files.
   - The page registers the worker, and the worker calls `clients.claim()` for this mode. This is
     a deliberate exception to the `claimClients: false` default above: there is no earlier worker
     to swap out from under the page.
   - Slots wait for `navigator.serviceWorker.ready`, with a timeout, before booting. From then on
     the realm iframes' navigations and the namespace fetches are the worker's to answer.
   - The first visit's first paint is not composed. Fragments boot client-side, which already works
     without piercing. Every later navigation is composed by the worker.
2. **Fragment origins must send CORS headers.** The worker fetches them cross-origin. Documents and
   assets need `Access-Control-Allow-Origin` naming the shell's origin, and module scripts need it
   regardless.
3. **Authenticated fragments must be same-site with the shell** (subdomains of one registrable
   domain). With credentials, the worker's cross-origin requests also need
   `Access-Control-Allow-Credentials`. Across sites, third-party cookie blocking (Safari, Firefox,
   and Chrome where enabled) drops the session. A fragment that needs login cookies from another
   site cannot be composed this way, and the build should refuse its manifest rather than let it
   fail at runtime.
4. **There must be a fallback where no worker can run.** Some private-browsing modes and enterprise
   policies disable service workers. Without a worker, compat fragments have no namespace, so the
   page must boot those slots as contract or untrusted fragments, or show their fallback content.
   It must never leave them half-booted.
5. **What the server gateway enforces must stay enforced.** Today's server gateway strips
   credentials (`forwardCredentials`), checks `access`, and decides redirects (`redirectOrigins`).
   In the worker, all of that runs on the user's device, which makes it advisory: a user can
   change it. Anything that must hold against the user stays on the fragment's own origin. The
   docs must say so plainly, as the boundary docs do for trusted fragments.
6. **The registry must be pinned.** The worker loads one snapshot (`snapshotUrl`), verifies it as
   the registry does, and composes only from it. Updating the snapshot follows the worker's
   version discipline (see below), so configuration churn never becomes an unannounced change of
   composition mid-session.
7. **The gateway core stays runtime-neutral.** No `node:` imports in the gateway, registry or
   rewriter, which offline composition already depends on. A new dependency of the core that
   breaks this breaks both.

### Open questions

- **Worker startup on every navigation.** A cold start can add tens of milliseconds on mobile.
  Navigation preload can fetch the shell while the worker boots, but there is no server to ask for
  the fragments early.
- **Which `x-braid-composed` value** a worker-composed online page should carry, so it can be told
  apart from a server-composed one in telemetry.

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
