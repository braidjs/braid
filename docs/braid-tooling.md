# Braid tooling — what exists, what's missing

An honest status of the developer-facing surface, and the shape of what should come next.

## What exists today

| Command             | Status    | What it does                                                                                                                                     |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `braid dev`         | **works** | starts the shell and fragment dev servers, waits for them, serves the gateway in front on one origin, proxies HTTP and websockets, prefixes logs |
| `braid init`        | **works** | writes a starter `braid.config.json`                                                                                                             |
| `braid add <id>`    | **works** | registers a fragment in the config (`--endpoint`, `--port`, `--pierce`)                                                                          |
| `@braidlabs/cli/nx` | **works** | Nx plugin inferring a `braid-dev` target from any `braid.config.*`                                                                               |

See [the dev workflow](https://github.com/braidjs/braid/blob/main/skills/using-braid/references/dev-workflow.md) for how to use them, and
what dev servers still need configured by hand.

## What does not exist

**Nothing scaffolds a gateway into an existing app.** Mounting it is three lines, but you have to
know which three, and where — and the right answer differs per framework (Express middleware,
Nest `app.use`, a wrapped fetch handler for Nitro/Workers) and per rendering mode. Today that
knowledge lives only in the README.

**Nothing wires a host app's provider.** For Angular that means `provideBraid()` in the right
bootstrap, `provideClientHydration()` in a config _shared with the server bootstrap_, and — for
SSR — per-request render mode on pierced routes. Getting hydration on only one side is the single
most common failure, and it is exactly what a generator should make impossible.

**Nothing prepares a fragment for dev.** Serving a fragment's dev server under its own namespace
(`servePath`/`base`) plus the matching endpoint path is a two-file change that is easy to get
subtly wrong and produces a fragment that renders nothing.

**No doctor.** Most of what goes wrong is detectable from config alone.

## Proposed commands

### `braid add-gateway` — mount the gateway in the app you already have

Detects the server framework and rendering mode, then makes the smallest correct edit.

```
$ braid add-gateway
  detected: Angular 22, SSR (outputMode: server, ssr.entry present)
  → apps/shell/src/server.ts   mount toNodeMiddleware(gateway) before the Angular handler
  → braid.config.json          created
  → package.json               added @braidlabs/gateway
```

The detection matrix is the valuable part, because the right answer really does differ:

| Detected                  | Where the gateway goes                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Angular SSR (`ssr.entry`) | the app's `server.ts`, before the Angular handler                                                |
| Angular SPA (no `ssr`)    | no server exists — scaffold a minimal one, or configure `braid dev` only and print how to deploy |
| NestJS                    | `app.use(...)` in `main.ts`, before `app.listen`                                                 |
| Express / Connect         | first `app.use` in the entry file                                                                |
| Nitro / h3                | wrap the exported handler with `toFetchHandler`                                                  |
| Unknown                   | print the snippet and where it belongs; change nothing                                           |

**SPA hosts deserve a real answer, not a shrug.** A pure SPA has no server to mount middleware
in, so the honest options are: run `braid dev` locally and put the gateway at the edge in
production, or adopt a thin server. The command should say which it did and why.

### `braid add-fragment <id>` — prepare an app to _be_ a fragment

Zero application code, by design. It configures the dev server's serve path, adds the manifest
entry with the matching endpoint, and — where it can detect one — sets `outputHashing` so stale
bundles stop biting.

### `braid ng-add` (or `nx g @braidlabs/angular:setup`)

Host-side wiring for Angular, as a generator so it is idempotent and reviewable in a diff:
`provideBraid()`, hydration in a _shared_ config, per-request render mode for pierced routes, and
a `<braid-fragment>` placed where you point it.

### `braid doctor`

Static checks for the failure modes we have actually hit:

- hydration configured on one bootstrap but not the other
- host navigation wired to all router events instead of after-navigation
- a pierced route that is prerendered
- unhashed output served with a long `max-age`
- a fragment dev server whose serve path and endpoint path disagree
- client and gateway package versions that disagree on the protocol

### `braid certify` (future)

The conformance kit: run a fragment standalone and slotted, diff the behavior, and report
wrong-realm executions, host-purity violations, and unaudited API usage.

## Suggested order

1. `braid doctor` — cheapest, and turns invisible failures into messages
2. `braid add-fragment` — the smaller of the two setup paths, and the one teams repeat most
3. `braid add-gateway` / `ng-add` — highest value, most detection risk
4. `braid certify`

Everything above is a proposal. Nothing in this section is implemented.
