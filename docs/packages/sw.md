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
});
```

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
