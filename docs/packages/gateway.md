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

---

## Reserved URL Namespaces

| Namespace | What it serves | Purpose |
| :--- | :--- | :--- |
| `/__braid/frag/:id/*` | Assets & API traffic | Forwards directly to fragment endpoint with prefix stripped. |
| `/__braid/realm/:id/*` | Realm boot stubs | Serves minimal HTML stub to initialize hidden iframe runtimes. |
| `/__braid/doc/:id/*` | Prepared DOM payload | Serves rewritten, script-inert HTML for dynamic injection. |

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
  /** Upstream timeout in milliseconds before triggering fallback (default: 1500). */
  timeoutMs?: number;
  /** Fallback strategy when upstream fails: 'placeholder' | 'omit' | 'error-html'. */
  fallback?: 'placeholder' | 'omit' | 'error-html';
  /** Custom Element module entry (for custom-element adapter). */
  entry?: string;
  /** Custom Element tag name (for custom-element adapter). */
  element?: string;
  /** Custom events emitted by the fragment. */
  events?: string[];
}
```
