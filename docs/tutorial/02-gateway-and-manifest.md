# Step 2: The Gateway & Fragment Manifest

In this step, you will install the Braid Gateway middleware and declare a fragment manifest for the React billing app so the gateway can route traffic and compose pages on the server.

---

## 1. Install Braid Dependencies

In the monorepo root, install `@braidlabs/gateway` and `@braidlabs/core`:

```bash
npm install @braidlabs/gateway @braidlabs/core
```

---

## 2. Define the Fragment Manifest

Create `apps/billing/braid.manifest.json`:

```json
{
  "id": "billing",
  "endpoint": "http://localhost:4201/__braid/frag/billing",
  "pierce": ["/billing", "/billing/*"],
  "timeoutMs": 1500,
  "fallback": "placeholder"
}
```

### Explanation of Manifest Fields
- **`id`**: Unique name for the fragment.
- **`endpoint`**: The upstream URL where the billing application is served.
- **`pierce`**: Route patterns that trigger server-side HTML composition. When a user requests `/billing` or `/billing/*`, the gateway fetches both the shell and billing fragment concurrently and stitches them together.
- **`timeoutMs`**: Maximum time to wait for the upstream before degrading to fallback.
- **`fallback`**: Strategy to use if the billing service is down (`placeholder`, `omit`, or `error-html`).

---

## 3. Create the Gateway Server

Create a lightweight gateway server in `apps/gateway/server.mjs`:

```js
import express from 'express';
import { createGateway } from '@braidlabs/gateway';
import { toNodeMiddleware } from '@braidlabs/gateway/node';
import manifest from '../billing/braid.manifest.json' with { type: 'json' };

const app = express();
const port = 3000;

// Initialize Braid Gateway with the manifest
const gateway = createGateway({
  registry: [manifest],
});

// Mount Gateway middleware first
app.use(toNodeMiddleware(gateway));

// Forward all non-Braid traffic to the Angular host shell
app.use(async (req, res) => {
  const targetUrl = new URL(req.url, 'http://localhost:4200');
  const response = await fetch(targetUrl, {
    method: req.method,
    headers: req.headers,
  });

  res.status(response.status);
  response.headers.forEach((val, key) => res.setHeader(key, val));
  const body = await response.text();
  res.send(body);
});

app.listen(port, () => {
  console.log(`Braid Gateway running at http://localhost:${port}`);
});
```

---

## 4. Test Server-Side Piercing

Start all three servers:
1. `npx nx serve shell --port=4200` (Angular Shell)
2. `npx nx serve billing --port=4201` (React Billing)
3. `node apps/gateway/server.mjs` (Gateway on Port 3000)

Now open terminal and run:

```bash
curl -i http://localhost:3000/billing
```

Notice what happens:
1. The gateway makes parallel fetches to `http://localhost:4200/billing` and `http://localhost:4201/billing`.
2. The gateway automatically rewrites the fragment's `<script>` tags to `<script type="inert">` so they do not execute globally on the host window.
3. The gateway streams a single, unified response containing the shell and the Declarative Shadow Root (`<template shadowrootmode="open">`).

---

## Next Step

In **[Step 3: Mounting with Shadow DOM & Realms](./03-mounting-and-isolation.md)**, we will update the Angular host app using `@braidlabs/angular` to mount the fragment in the browser with full CSS encapsulation and JavaScript realm isolation.
