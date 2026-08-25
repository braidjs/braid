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

### `braid detangle`
Analyzes an existing Module Federation Nx workspace, maps remotes to Braid fragments, detects shared singletons/guards, and automates migration to Braid:

```bash
# Report only (safe, writes nothing)
npx braid detangle

# Preview the generated braid.config.json
npx braid detangle --diff

# Generate braid.config.json, scaffold gateway app, and apply safe shell codemods
npx braid detangle --write --gateway --shell-edits
```

#### Flags for `braid detangle`

| Flag | Description |
| :--- | :--- |
| *(none)* | Dry-run report only (detects shell, remotes, routes, and shared state). |
| `--shell <project>` | Explicitly specify host shell project name if multiple exist. |
| `--diff` | Display the `braid.config.json` that would be generated. |
| `--write` | Write `braid.config.json` (refuses on dirty git tree or blocking findings). |
| `--gateway` | With `--write`, scaffold the gateway application (new files only). |
| `--shell-edits` | With `--write`, apply safe codemods to host shell (e.g. `provideBraid()`, client hydration). |
| `--force` | Override git safety refusals and replace existing configs. |
| `--remove-mf` | Check whether Module Federation config can be safely removed. |
| `--port <n>` | Port for the composed gateway application (default: `4000`). |

> For a full migration guide from Webpack/Rspack Module Federation, see **[From Module Federation](../braid-from-module-federation.md)**.

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
