# @braidlabs/cli

The developer experience command-line interface for Braid. Run composed applications locally with live-reload, proxy multi-origin dev servers through a single unified gateway, scaffold configs, and register fragments.

---

## Installation

```bash
npm install -D @braidlabs/cli
```

---

## Commands

### `braid dev`
Starts the dev servers declared in `braid.config.json`, waits for all services to answer health checks, and starts the gateway on a single unified origin.

```bash
npx braid dev
```

### `braid init`
Scaffolds a clean `braid.config.json` in the current project root.

```bash
npx braid init
```

### `braid add <fragment-id>`
Adds a new fragment entry to `braid.config.json` with port and piercing route options:

```bash
npx braid add billing --port 4201 --pierce "/billing/*"
```

---

## Configuration (`braid.config.json`)

```jsonc
{
  "port": 3000,
  "shell": {
    "port": 4200,
    "command": "npm run start:shell"
  },
  "fragments": [
    {
      "id": "billing",
      "endpoint": "http://localhost:4201/__braid/frag/billing",
      "dev": {
        "port": 4201,
        "command": "npm run start:billing"
      },
      "pierce": ["/billing", "/billing/*"],
      "timeoutMs": 2000,
      "fallback": "placeholder"
    }
  ]
}
```

---

## Nx Plugin Integration

Add the Braid plugin to `nx.json` for automatic target inference:

```json
{
  "plugins": ["@braidlabs/cli/nx"]
}
```

Any project with a `braid.config.{json,mjs,js}` automatically gains a `braid-dev` target runnable via:

```bash
nx run shell:braid-dev
```

---

## Dev Server Settings & Vite/Angular HMR

Vite and Angular dev servers emit absolute module URLs (`/@fs/…`, `/@vite/client`) during local development. Configure each fragment's dev server to serve under its own namespace:

```json
{
  "servePath": "/__braid/frag/billing/"
}
```

This ensures that all asset, chunk, and API calls route cleanly through the composed gateway origin.
