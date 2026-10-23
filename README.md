<p align="center">
  <img src="assets/fin.png" width="200" alt="Braid logo" />
</p>

<h1 align="center">Braid</h1>

<p align="center">
  <strong>Tangle-free microfrontends.</strong><br />
  Independently deployed apps composed into one page, one layout and one accessibility tree,
  with each app's JavaScript isolated in its own realm.
</p>

<p align="center">
  <a href="https://braidjs.github.io/braid/"><strong>Documentation</strong></a> ·
  <a href="https://braidjs.github.io/braid/getting-started">Getting started</a> ·
  <a href="https://braidjs.github.io/braid/tutorial/">Tutorial</a> ·
  <a href="https://braidjs.github.io/braid/packages/">Packages</a> ·
  <a href="https://stackblitz.com/github/braidjs/braid/tree/main/examples/acme-portal">Try it in StackBlitz</a>
</p>

---

## What Braid does

- **Splits where code runs from where the DOM lives.** Each fragment's JavaScript runs in its own
  hidden same-origin realm, with its own globals and import map. Its HTML renders into the host
  page inside a shadow root, in normal layout flow. React 18 and React 19, or zoned and zoneless
  Angular, can share a page without colliding.
- **Composes on the server.** The gateway sits in front of your host app and streams each
  fragment's HTML into the page as it is served ("piercing"), so content is there before any
  JavaScript runs.
- **Routes fragment traffic deterministically.** Every fragment lives at its own path,
  `/__braid/frag/:id/`, so caching and nested fragments behave predictably.
- **Keeps the host page untouched.** No globals or prototypes are patched on the host. Modern apps
  get an explicit `FragmentEnv` through small framework adapters. Legacy apps can run unmodified
  through a compat adapter, contained inside their own realm.
- **Handles version skew.** Data crossing a fragment boundary is versioned and migrated in both
  directions, so independently deployed apps can disagree about a schema without breaking.
- **Treats configuration as governed data.** The registry stores immutable, content-addressed
  snapshots with rollback, environments and approvals, per-team ownership, an audit trail and
  publishing by pull request. The console edits all of it, including shells laid out as data.

Braid is a successor to [web-fragments](https://github.com/web-fragments/web-fragments), and builds
on its core idea.

## A quick look

```ts
// server.ts: put the gateway in front of your host app
import { createGateway } from '@braidlabs/gateway';
import { toNodeMiddleware } from '@braidlabs/gateway/node';

const gateway = createGateway({
  mode: 'production',
  registry: [{ id: 'billing', endpoint: 'http://localhost:4201', pierce: ['/billing', '/billing/*'] }],
});
app.use(toNodeMiddleware(gateway));
```

```ts
// main.ts: in the host app's startup, load the runtime
import '@braidlabs/core';
```

```html
<!-- the host's template: name the slot -->
<fragment-slot name="billing"></fragment-slot>
```

The billing app changes nothing; it keeps building and serving itself as before. The
[getting-started guide](https://braidjs.github.io/braid/getting-started) walks through it.

## Packages

All packages are published under [`@braidlabs`](https://www.npmjs.com/org/braidlabs) on npm.

| Area                   | Package                                                | What it is                                                                      |
| :--------------------- | :----------------------------------------------------- | :------------------------------------------------------------------------------ |
| **Composition**        | [`@braidlabs/core`](libs/core)                         | Client runtime: `<fragment-slot>`, realms, the compat adapter                   |
|                        | [`@braidlabs/gateway`](libs/braid-gateway)             | Fetch-native middleware: routing under `/__braid/`, server-side piercing        |
|                        | [`@braidlabs/sw`](libs/braid-sw)                       | Service worker that keeps each fragment's assets cached per build               |
| **Framework bindings** | [`@braidlabs/angular`](libs/braid-angular)             | `<braid-fragment>`, `provideBraid()`, `defineAngularFragment()`                 |
|                        | [`@braidlabs/react`](libs/braid-react)                 | `<BraidFragment>` and host-navigation wiring for any router                     |
| **Operations**         | [`@braidlabs/registry`](libs/braid-registry)           | Snapshots, validation, the write API, environments, ownership, audit, GitOps    |
|                        | [`@braidlabs/console`](libs/braid-console)             | Registry console: fragments, shell designer, history and rollback               |
|                        | [`@braidlabs/cli`](libs/braid-cli)                     | `braid dev` for local composition, scaffolding and registry commands            |
| **Version skew**       | [`@braidlabs/skew`](libs/skew)                         | Versioned envelopes, migration chains, build identity. No dependencies          |
|                        | [`@braidlabs/contract`](libs/contract)                 | Migrations published as a document an API serves and clients resolve            |
|                        | [`@braidlabs/build`](libs/build)                       | `skew-stamp` and `skew-contract`: build identity and contract types             |
|                        | [`@braidlabs/data`](libs/data)                         | Local-first data layer, tolerant of skew between independently deployed readers |
|                        | [`@braidlabs/studio`](libs/studio)                     | Payload diffs for inspecting migrations                                         |
| **Angular toolkit**    | [`@braidlabs/angular-core`](libs/angular/core)         | DI and signal wrappers for versioned stores                                     |
|                        | [`@braidlabs/angular-router`](libs/angular/router)     | Recovery from stale lazy chunks after a deploy, without reload loops            |
|                        | [`@braidlabs/angular-data`](libs/angular/data)         | Entity store, tag invalidation and a durable mutation outbox                    |
|                        | [`@braidlabs/angular-workflow`](libs/angular/workflow) | Multi-step flows whose drafts survive refreshes and deploys                     |

The version-skew and Angular packages stand alone: use them with or without the composition layer.

## Learn more

- [**Braid, explained**](https://braidjs.github.io/braid/braid-explained): the vocabulary and one
  page load, in about fifteen minutes
- [**Tutorial**](https://braidjs.github.io/braid/tutorial/): seven steps from two apps to production
- [**Package reference**](https://braidjs.github.io/braid/packages/): one page per package
- [**Failure modes**](https://braidjs.github.io/braid/braid-failure-modes): what goes wrong in
  practice, by symptom
- [Architecture](docs/braid-architecture.md) and the [technical appendix](technical-appendix.md):
  design decisions and trade-offs

## Demos

```sh
npm run braid:demo   # Braid: a host and three remotes composed on one page
npm run demo:prod    # two production builds, real deploys, real version-skew failures
npm run demo         # the simulated single-build demo
```

See [apps/README.md](apps/README.md) and [docs/braid-poc.md](docs/braid-poc.md).

## Development

Requires Node 24 (see `.nvmrc`).

```sh
npm install
npm run verify       # lint, test and build every library
npm test             # all projects
npm run audit:cve    # fails on new high or critical CVEs; also runs in CI
```

Releases run from the **Release** workflow. While the major version is 0, pass an exact version
(for example `0.5.0`); a `minor` bump would publish a patch.

## License

MIT
