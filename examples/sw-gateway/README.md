# Braid with no server gateway — proof of concept

The Braid gateway, running in a service worker (`@braidlabs/sw/gateway`), in front of a plain static
server that has never heard of Braid. Composition, realm boot, and piercing all come from the worker.

## What it shows

- `/` — the shell, a static file. Once the worker controls the page, the `billing` slot composes
  client-side and its script boots in a realm: the fragment reads **booted in its realm**.
- `/billing` — the same shell from the server, **pierced in the worker**. The fragment's markup is in
  the document the browser parsed (view source shows `<template shadowrootmode>` inside the slot).
- The server's log. Any `/__braid/` URL that reaches it is logged as a sign the worker wasn't in
  control. With the worker running, none does.

## Files

- `src/sw.js` — the whole worker: `setupBraidGateway` with a one-fragment registry.
- `src/main.js` — the page's runtime. It registers the worker and calls `initBraid()` once it controls the page.
- `server.mjs` — the static server, which bundles both with esbuild on start.
- `public/shell` and `public/billing-app` — two independently "deployed" static apps.

## Running it

```bash
npm install
npm start
```

Open `http://127.0.0.1:3000/`, then follow the Billing link.

From a Braid checkout, before `@braidlabs/sw/gateway` is published, bundle against the sources
instead:

```bash
BRAID_TSCONFIG=../../tsconfig.base.json node server.mjs
```

The repository's e2e (`e2e/service-worker-gateway.e2e.ts`) runs this example in Chromium.

## Limits

See "The gateway in the worker" in the [`@braidlabs/sw` README](../../libs/braid-sw/README.md). In
short:

- the first visit's first paint isn't composed;
- cross-origin endpoints need CORS;
- the gateway's policies are advisory on the user's device;
- there's no fallback yet where service workers are disabled.
