# @braidlabs/sw

Skew-aware asset serving and cache partitioning for composed microfrontends. Prevents stale lazy-chunk 404 errors during rolling deployments by isolating cache partitions by fragment build ID.

---

## Installation

```bash
npm install @braidlabs/sw
```

---

## The Problem: Stale Lazy Chunks During Rolling Deploys

In microfrontend architectures, a user may keep a tab open during a deployment rollout. When they navigate to a lazy-loaded route, the browser requests the older chunk hash (`feature.abc123.js`). If the origin or CDN has purged older chunks for the new deployment, the request fails with a 404, crashing the client router.

A Service Worker is the only browser primitive capable of intercepting that dynamic module fetch and serving the preserved chunk from an isolated cache partition.

---

## Key Features

1. **Per-Fragment Cache Partitions:** Because fragment traffic routes under `/__braid/frag/:id/*`, each microfrontend gets an isolated cache partition keyed by its own build timestamp/ID. Fragment A at build 5 and Fragment B at build 12 never clobber each other's assets.
2. **Two Integration Shapes:**
   - **Composable Fetch Handler:** Easily embedded into an existing enterprise Service Worker without taking over global fetch handlers.
   - **Standalone Worker:** Turnkey Service Worker for applications without existing workers.
3. **Gateway Scope Header Injection:** Gateway automatically sends `Service-Worker-Allowed: /` to ensure root page scope coverage.

---

## Usage

### Option 1: Composing into an Existing Service Worker

```js
// sw.js
import { braidFetchHandler } from '@braidlabs/sw';

const braid = braidFetchHandler({ buildId: self.__BUILD_ID });

self.addEventListener('fetch', (event) => {
  // Returns a Promise<Response> for Braid namespace requests; returns null for all other traffic
  const handled = braid(event.request);
  if (handled) {
    event.respondWith(handled);
  }
});
```

### Option 2: Standalone Worker Setup

```js
// sw.js
import { setupBraidWorker } from '@braidlabs/sw';

setupBraidWorker({
  buildId: self.__BUILD_ID,
  precache: ['billing', 'catalog'],
  staticRoutes: true, // only if nothing else in this file listens for `fetch`
});
```

### Per-fragment Storage Buckets (opt-in)

```js
setupBraidWorker({ buildId: self.__BUILD_ID, precache: ['billing'], buckets: true });
```

With `buckets: true`, where the browser has Storage Buckets (Chromium), each fragment's cache (its chunks, its realm stub, its offline documents) lives in a bucket of its own. A bucket is the browser's unit of eviction, so a device short on space evicts one fragment's files rather than every fragment's at once, deploy-skew safety net included. Pruning a fragment that left the registry deletes its bucket, and signing out (`braid-sw:clear`) deletes them all. Buckets are named `braid-sw_<prefix>_<fragment>_<hash>`, and the worker only ever deletes names in exactly that format, never the realm's database buckets or the app's own. If a bucket is refused, or the browser has no buckets, the shared Cache Storage is used as before. Switching it on starts with empty fragment caches once, and pruning removes the shared ones it supersedes. Sign-out clears the worker's buckets even after it stops using them.

### Static routes: start the worker only for what it answers

A worker with a `fetch` listener normally starts for *every* request in its scope. That includes requests its listener ignores, such as the shell's own scripts, images and API calls, and each of those waits for the worker to start. Where the browser supports the Service Worker Static Routing API (`InstallEvent.addRoutes`, Chromium today), both workers can instead declare at install time exactly which requests they answer. Everything else goes straight to the network, and the worker doesn't start for it.

- **`setupBraidGateway` does this by default.** It answers its namespace and same-origin GET navigations. Pass `staticRoutes: false` if the same worker file adds its own `fetch` listener.
- **`setupBraidWorker` does it only with `staticRoutes: true`.** It answers fragment assets and realm stubs. It's off by default because the routes bypass every `fetch` listener in the worker, including any you added yourself. It has no effect with `offline`: offline composition also answers a page's own `fetch` for HTML (htmx, Turbo), and a route can match a request's mode but not its `Accept` header.
- **Browsers without the API, or that refuse the rules, behave as before**, and you get a console warning. Installation never fails because of it.
- **Resource timing shows it**, where the browser reports `workerMatchedSourceType` (recent Chromium): `network` for a routed request, `fetch-event` for one the worker answered.

---

## Gateway Enablement

Enable service worker serving directly in Braid Gateway:

```ts
import { createGateway } from '@braidlabs/gateway';

const gateway = createGateway({
  registry,
  serviceWorker: true, // Serves sw with Service-Worker-Allowed: /
});
```

Registering in the host page:

```ts
import { registerBraidServiceWorker } from '@braidlabs/core';

await registerBraidServiceWorker({ buildId: window.__BUILD_ID });
```

---

## The Gateway in the Worker (Static Hosting)

For a shell on purely static hosting (a bucket, a CDN, GitHub Pages) there is no server to put a gateway on. `@braidlabs/sw/gateway` runs the whole gateway in the service worker instead: the same `createGateway` the server runs, with the network as its shell. It serves realm stubs, proxies fragment documents and assets, and pierces navigations.

```js
// sw.js — bundled, and served from the root so its scope covers the shell
import { setupBraidGateway } from '@braidlabs/sw/gateway';

setupBraidGateway({
  registry: [{ id: 'billing', endpoint: new URL('/billing-app/', self.location.origin).href, pierce: ['/billing/*'] }],
  claimClients: true, // the installing page composes without a reload
  assets: {}, // optional: the skew cache, in front of the in-worker gateway
});
```

To compose it into a worker you already own, use `braidGatewayHandler(options)`. It returns `null` synchronously for any request it leaves to the browser. Its `.fetch` routes any request through the gateway. Pass it as `braidFetchHandler({ fetch: braid.fetch })` so the skew cache sits in front of the in-worker gateway; without it, the asset handler's misses go to the network, which is a 404 on a static host. The main `@braidlabs/sw` entry doesn't bundle any of this.

The host page starts Braid once the worker controls it, because until then `/__braid/` is a 404 on a static host. A hard reload loads the page past an already-active worker, so the page asks to be claimed:

```js
if (!navigator.serviceWorker.controller) {
  const changed = new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  const registration = await navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/' });
  registration.active?.postMessage({ type: 'braid-sw:claim' }); // honoured with claimClients
  await changed;
}
initBraid();
```

The registry console can run against this too, including its editing views, with the registry
API composed into the worker: see
[the console behind the service-worker gateway](./console.md#behind-the-service-worker-gateway).

This is a proof of concept ([`examples/sw-gateway`](https://github.com/braidjs/braid/tree/main/examples/sw-gateway)). Before relying on it:

- **The first visit's first paint isn't composed.** Fragments boot client-side, and every later navigation is pierced by the worker.
- **Cross-origin fragment endpoints must be public and send CORS headers**, because the browser fetches and reads them.
- **Login cookies reach same-origin endpoints only.** The worker can't set forbidden headers such as `Cookie`, and it fetches fragments with same-origin credentials, as the page's own requests do. `forwardCredentials` and cookie scoping have no effect.
- **The gateway's other policies are advisory.** `access` and `redirectOrigins` run on the user's device. Anything that must hold against the user belongs on the fragment's own origin.
- **Everything in the options is public.** The registry and `additionalHeaders` ship in `sw.js`, so they must hold no secrets.
- **Fragment redirects can't be followed.** A browser's `fetch` returns a manual redirect as an opaque response, so `redirect: 'navigate'` fails closed: a pierced slot falls back to its placeholder. A shell that redirects is handed back to the browser untouched.
- **The shell should refuse cross-site framing** (`X-Frame-Options` or `frame-ancestors`).
- **There's no fallback yet for browsers with service workers disabled.** The registry is baked into the worker unless you give it a `snapshotRegistry` over `cacheSnapshotStore()`, which is per browser.
