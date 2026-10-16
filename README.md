<p align="center">
  <img src="assets/fin.png" width="280" alt="Skew logo" />
</p>

<h1 align="center">Skew</h1>

<p align="center">
  Version-skew tolerance for web applications: versioned data, detected disagreement,
  and recovery at every boundary where two builds meet.
</p>

<p align="center">
  <img alt="Angular 22" src="https://img.shields.io/badge/Angular-22-DD0031?style=flat-square" />
  <img alt="TypeScript 6.0" src="https://img.shields.io/badge/TypeScript-6.0-3178C6?style=flat-square" />
  <img alt="312 tests passing" src="https://img.shields.io/badge/tests-312%20passing-2EA043?style=flat-square" />
  <img alt="zero core dependencies" src="https://img.shields.io/badge/core%20deps-0-8FBFE0?style=flat-square" />
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-1E3A5F?style=flat-square" />
</p>

---

## The problem

Web applications are deployed continuously, but nothing forces the rest of the
world to move at the same time. At any given moment, some part of your system
is running an older build than another part — and data or code is crossing
between them. Concretely:

- **A tab stays open across a deploy.** A user opens your app Monday morning
  and leaves the tab open. You deploy at noon; the deploy replaces the
  content-hashed chunk files. When the user clicks a lazy-loaded route at
  2pm, the browser requests a file that no longer exists and the navigation
  dies with `ChunkLoadError`.
- **Cached or persisted data outlives the code that wrote it.** Your app
  autosaves drafts to `localStorage`. A release renames `themeQuote` to
  `scriptureOfWeek`. Every draft saved before the release still has the old
  field name, but the new code reads it as the new type — so the user gets
  `undefined` deep inside a renderer, far from the cause.
- **A queued write is sent by a build that no longer matches the server.**
  An offline-capable app queues a mutation, the user closes the laptop, and
  by the time the queue flushes the API has moved to a new contract. The
  request either 400s or — worse — is accepted and silently misinterpreted.
- **Two independently deployed frontends share one page.** A micro-frontend
  host built against v1 of a record hands it to a remote built against v2.
  Both compile fine on their own; the disagreement only exists at runtime.
- **A client can't be updated on your schedule.** A mobile app on a release
  train, or a partner integration, keeps calling your API with last month's
  understanding of the data while the API has moved on.

These look like five unrelated bugs. They are one bug: **two
independently-versioned parties met at a boundary with no way to discover
that they disagreed.** The counterparty is sometimes another team's
deployment, sometimes another device — and sometimes your own past
deployment, which is the case teams miss most often. A draft written by
build 41 and resumed under build 57 is the same failure as a client on 41
calling a server on 57.

## What Skew does

Skew supplies the missing primitive, applied uniformly at every one of those
boundaries:

1. **Stamp** whatever crosses a boundary with the version it was authored
   under (a small envelope: `{ v, n, payload }`, or a header for APIs that
   won't reshape bodies).
2. **Detect** disagreement when it's read back.
3. **Migrate** the data forward through a declared chain of steps — or, when
   migration is impossible, **fail loudly with a reason you can act on**
   instead of handing back a wrong-shaped object.

The core is a single dependency-free TypeScript package that runs in
browsers, Node, and workers. Everything else — Angular bindings, build
tooling, contract documents — is an application of the same idea to a
specific boundary, and every package is independently adoptable.

```sh
npm install @braidlabs/skew @braidlabs/build
```

```ts
import { versioned } from '@braidlabs/skew';

// Snapshot shapes: frozen copies of what each version looked like.
interface DraftV1 { id: string; body: string }
interface DraftV2 { id: string; title: string; body: string }

export const Draft = versioned<DraftV1>('draft')
  .next<DraftV2>('lift the first line into a title', (p) => ({
    id: p.id,
    title: p.body.split('\n')[0] ?? '',
    body: p.body,
  }));

const result = Draft.read(whateverWasInStorage);
if (result.ok) render(result.value);   // always the current shape
```

Each `next()` step is type-checked against the previous version, so a
migration that doesn't produce the declared next shape is a compile error.
Data with no envelope is treated as version 1, so you can adopt this on
existing stored data without a backfill: declare your current shape as the
base version and records upgrade as they are touched.

**The one rule that protects your data:** a migration must never reference
your live application types. Each step closes over its own frozen snapshot
(`DraftV1`, `DraftV2` above). If a migration imports the live interface,
then editing that interface later silently changes what the old migration
produces — and TypeScript cannot warn you, because the code still compiles.

## Tutorials

Step-by-step, screenshot-illustrated introductions to each package live in
[`docs/tutorials`](docs/tutorials/README.md) — core, build, angular-core, and
angular-data, each building something small and real.

They are also served *inside the production demo*: the remote exposes a
`./Tutorials` module and the host routes to it at
<http://localhost:4410/tutorials>, so the tutorials cross the same deployment
boundary they teach about. Redeploy the remote and the tutorial UI updates
under the running host.

---

## Packages

| Package                                               | What it does                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **[`@braidlabs/skew`](libs/skew)**                         | Envelopes, migration chains, versioned storage, build identity, the shared schema registry. No deps.    |
| **[`@braidlabs/contract`](libs/contract)**                 | Migration history published as a document the API serves; clients resolve it at runtime.                |
| **[`@braidlabs/build`](libs/build)**                       | `skew-stamp` (build identity + manifest) and `skew-contract gen` (frozen types from a contract).        |
| **[`@braidlabs/studio`](libs/studio)**                     | Inspection tooling: structural payload diffs that mark guessed and discarded values. Framework-free.    |
| **[`@braidlabs/angular-core`](libs/angular/core)**         | Angular DI and signal wrappers for versioned stores.                                                    |
| **[`@braidlabs/angular-router`](libs/angular/router)**     | Chunk-load recovery for lazy routes, without reload loops or lost work.                                 |
| **[`@braidlabs/angular-data`](libs/angular/data)**         | Normalized entity store, tag invalidation, and a durable mutation outbox.                               |
| **[`@braidlabs/angular-workflow`](libs/angular/workflow)** | Multi-step flows whose drafts survive refresh, deploys, and device changes.                             |
| **[`@braidlabs/core`](libs/core)**                       | Braid client runtime: isolated iframe realms, declarative shadow DOM, and compat adapter for microfrontends. |
| **[`@braidlabs/gateway`](libs/braid-gateway)**       | Fetch-native origin-front middleware with manifest routing, clean namespaces, and server-side piercing.      |
| **[`@braidlabs/angular`](libs/braid-angular)**       | Angular binding for Braid: typed `<braid-fragment>` component and router integration.                        |
| **[`@braidlabs/react`](libs/braid-react)**           | React binding for Braid: `<BraidFragment>` component and router integration.                                 |
| **[`@braidlabs/cli`](libs/braid-cli)**               | Braid CLI (`braid dev`): local dev server orchestration with live reload.                                   |

Every package depends on `@braidlabs/skew` and never on a sibling. You can adopt
one, several, or none of the Angular ones; nothing is load-bearing for
anything else.

## Which packages for which situation

Individual packages solve individual failures, but the situations that make
teams reach for this library usually involve a *combination* of boundaries.
These are the groupings that come up in practice.

### An app that autosaves drafts or caches API data locally

**`@braidlabs/skew`** (+ **`@braidlabs/angular-core`** in Angular).

The moment you write `JSON.parse(raw) as Draft`, you have an assertion where
you need a check, and the first release that changes the model breaks every
record already sitting in users' browsers. `versioned()` +
`createVersionedStore` replaces the cast with migration at the boundary.
`@braidlabs/angular-core` adds the DI token and signal wrappers
(`provideSkewStore`, `injectSkewSignal`) so components consume the store
without a flash of empty state. You do not need anything else for this —
no build stamping, no contracts.

### An app whose users keep tabs open across deploys

**`@braidlabs/build`** + **`@braidlabs/angular-router`** (+ `@braidlabs/skew`, which they build on).

Chunk recovery needs two things migrations don't: a *build identity* to
compare against (that's `skew-stamp`, which generates a build-id module and a
manifest at build time) and a router integration that classifies the failure
before acting (that's `lazy()` + `provideSkewRecovery`). The classification
matters because the same `ChunkLoadError` has opposite correct responses: a
new deploy means "reload at the target URL", a *stale origin* (a CDN region
still serving the old index.html) means "do not reload — it will loop
forever", offline means "don't reload — you'd land on an error page", and a
deleted route means "redirect, reloading will 404 forever".

### Offline-capable data entry

**`@braidlabs/skew`** + **`@braidlabs/build`** + **`@braidlabs/angular-data`**.

A mutation queued while offline must survive a page reload, which means it
must be persisted — and anything persisted can outlive the build that wrote
it. The outbox in `@braidlabs/angular-data` therefore needs `@braidlabs/skew`'s
versioning twice over: queued payloads carry the schema version they were
authored under (so a flush after a deploy can migrate them before sending),
and a queue written by a *newer* build is left untouched rather than
replayed with payloads this build doesn't understand. `skew-stamp` supplies
the build id that makes "newer" detectable. Using the outbox without
versioning would replay stale payloads into a moved API — the 400s would
just arrive later, with less context.

### A multi-step wizard users abandon and resume

**`@braidlabs/skew`** + **`@braidlabs/angular-workflow`** (+ **`@braidlabs/angular-router`**
if the steps are lazy-loaded routes).

A six-step application form is abandoned on Thursday and resumed on Monday;
in between, a release added a step and renamed two fields. The workflow
package owns step↔route mapping, guarded deep links, resumption, and
idempotent submit — and takes a `schema` from `@braidlabs/skew` so the parked
draft is migrated on resume instead of silently corrupted. If the steps are
lazily loaded, the deploy can also break the *code* loading mid-wizard,
which is the router package's job.

### An API whose clients you cannot force-update

**`@braidlabs/contract`** + **`@braidlabs/skew`** + **`@braidlabs/build`**, on both sides.

Mobile release trains, partner integrations, or simply many web clients on
different deploy cadences: the server moves to v2 while v1 clients keep
running for weeks. Code-shipped migration chains cannot fix the direction
that matters here — a v1 client reading v2 data (`ahead`) needs knowledge
that didn't exist when it was built. `@braidlabs/contract` closes the gap: the
server publishes its migration history as a data document at
`/.well-known/skew/contracts/:name`, and clients resolve it at runtime
(`readResolving`) to read newer data as an honest, labeled projection. On
the server, the same document generates the frozen types
(`skew-contract gen`) and can drive the down-conversion for versioned
endpoints, so the endpoint, the document, and every client migration share
one definition. See [Contracts as data](#contracts-as-data--migrations-without-a-deploy).

### Independently deployed micro-frontends on one page

**`@braidlabs/skew`** + **`@braidlabs/build`** + **`@braidlabs/angular-router`**
(+ **`@braidlabs/contract`** if the host and remotes also disagree with an API).

A host built against v1 and a remote built against v2 share one JavaScript
runtime. Three boundaries are live at once: the remote's chunk can vanish
under the host (router package), records handed across the boundary carry
different shapes (core envelopes), and — uniquely to this setup — the newer
bundle can *teach* the older one: `registerSchema()` publishes the remote's
migration steps into the page-wide registry, so the host's plain `read()`
can downgrade v2 records it could never have understood alone, with the
discarded fields named. The registry also detects two builds that disagree
about what a version *means*, via content fingerprints on every step.

## `@braidlabs/skew` in more depth

### Results, not exceptions

`read()` returns a discriminated result, because the failure modes need
different remedies:

```ts
if (!result.ok) {
  switch (result.reason) {
    case 'ahead':   return refetch();    // written by a NEWER build
    case 'gap':     return reportBug();  // a migration step is missing
    case 'invalid': return discard();    // not this schema's data at all
    case 'threw':   return reportBug();  // a migration failed partway
    case 'retired': return refetch();    // below the schema's cleanup floor — policy, not a bug
  }
}
```

`ahead` deserves its own explanation, because it is the case most codebases
get wrong. Data written by a newer build cannot be guessed downward — the
fields the newer build added were never sent to you. Collapsing `ahead` into
`null` means every caller invents its own response, and in practice the
response is "discard it", which destroys good data. This situation is not
rare: a colleague saves from the new deploy while your tab is stale; a phone
updates before the laptop does.

`ahead` is a diagnosis, not always a dead end. When a downward path is known
— a step's declared `down` function, a step contributed by a newer bundle
via the shared registry, or a step resolved from a published contract —
`read()` returns `ok` with `downgradedFrom` set and every discarded field
named in `lossyPaths`. Fields a migration had to invent (defaults,
placeholders, clock-derived values) are named in `derivedPaths`, so
downstream code can distinguish reported values from guesses.

### Versioned storage

```ts
const drafts = createVersionedStore(Draft, {
  driver: webStorageDriver('local'),
  buildId: BUILD_ID,
  onReadFailure: (key, failure) => telemetry.warn('stale draft', { key, ...failure }),
});

await drafts.set('2026-12-06', content);
const stored = await drafts.get('2026-12-06');  // migrated on the way out
const now = drafts.peek('2026-12-06');          // sync, for initializers
```

Drivers: `memoryDriver()`, `webStorageDriver('local' | 'session')`, or
implement `StorageDriver` for IndexedDB or native storage. The web-storage
driver degrades to memory under Safari private mode, disabled cookies, and
SSR, and swallows quota errors on write — a failing cache should never break
a save the user asked for.

### Retiring old versions

Chains do not grow forever: they are append-only at the top and **trim-only
at the bottom**. Once telemetry (`result.migratedFrom`) shows a version no
longer arrives — accelerated by `rewriteOnRead: true` on stores, which
re-persists migrated records at the current version so old ones drop out of
circulation — re-declare the schema with the oldest surviving shape as its
base and delete the retired steps:

```ts
// before: versioned<V1>('draft').next<V2>(…).next<V3>(…).next<V4>(…)
export const Draft = versioned<V3>('draft', { base: 3 }).next<V4>(…);
```

Reads below the floor fail with `reason: 'retired'` — a policy outcome
(discard/refetch/reset), deliberately distinct from `gap`, which still means
"a step is missing and that's a bug". Retire aggressively for refetchable
caches, conservatively for user work you can't refetch (drain outboxes
first). Details in the [core README](libs/skew/README.md).

### Runtime validation

Skew handles the envelope and the migration chain; it deliberately does not
ship a payload validator, to keep the core dependency-free. Bring your own
(Zod, Valibot) via the `validate` option; it runs after all migrations, and
a failure surfaces as `reason: 'invalid'` rather than an exception.

### Build identity

```ts
const probe = createVersionProbe({
  identity: { buildId: BUILD_ID, builtAt: BUILT_AT },  // from skew-stamp
  manifestUrl: '/skew-manifest.json',                  // serve with Cache-Control: no-store
});
```

`probe.check()` classifies the running client against the origin: `current`,
`staleClient` (offer a reload), `staleOrigin` (**do not reload — it will
loop**), `differs`, or `unreachable`. Detecting `staleOrigin` requires
comparing build timestamps, which is why `skew-stamp` records `builtAt` and
not just an id.

## Handling version skew in API responses

The same idea aimed at one specific boundary: a response body from an API
your build didn't ship. The short version — the full workflow with code from
the running demo is in the sections below it:

1. **Declare a versioned schema** for every payload, named by contract
   (`versioned<FundV1[]>('portfolio-funds')`). The name is how a reader on a
   different build recognizes the same envelope.
2. **Read every response through the schema** (`schema.read(body)`), never
   through a cast. The cast compiles either way; only the read tells you
   when it's wrong.
3. **Handle each failure reason** — `ahead` usually means "refetch or offer
   a reload", `gap`/`threw` mean "report a bug", `invalid` means "this isn't
   the data you thought it was".
4. **When the contract changes, append a step**; never edit the frozen base
   types. If a new field has no honest derivation from old data, give it an
   honest placeholder rather than a plausible invention.
5. **On the server, version the endpoint** (`/v1/funds` and `/v2/funds` live
   at once) rather than mutating it in place — that's what lets a client
   pinned to v1 keep working while v2 clients ship.
6. **On writes, refuse a stale contract with a named error** (`409` with
   `expected`/`received`) instead of coercing it server-side. Coercion turns
   a real disagreement into a false success the client never learns about.
7. **If writes can be queued** (offline, retries, redeploys), record the
   schema version on the queued entry so the flush can migrate before
   sending — and do the migrate-and-retry inside the runner, or the queue
   will resend the same stale envelope forever.

## The shared registry — when both builds share a page

In a federated page, the host built against v1 and the remote built against
v2 are loaded into the same JavaScript runtime and share one `@braidlabs/skew`
instance. The remote's bundle contains exactly the migration knowledge the
host lacks, and `registerSchema()` lets it say so:

```ts
// The NEWER bundle declares both directions and registers them.
export const FundSchemaV2 = versioned<FundV1>('portfolio-fund')
  .next<FundV2>('promote scalars to structure', { up, down, derives, lossy });
registerSchema(FundSchemaV2);
```

From that moment, the host's plain `read()` can migrate a v2 record down
through the registered step — `ahead` becomes `ok` with `downgradedFrom: 2`
and the discarded fields named — with no DI, no imports, and no knowledge
that the remote exists. Every step carries a content fingerprint, so two
builds that disagree about what a version means are detected and reported
(`setRegistryConflictHandler`) instead of silently corrupting each other.

## Contracts as data — migrations without a deploy

The registry needs the newer bundle to be present on the page. The contract
document removes even that requirement, based on one observation: **an
origin is always at least as new as the newest data it serves.** So the
origin that produced a too-new response can also publish the knowledge that
explains it:

```
GET /api/.well-known/skew/contracts/portfolio-fund
```

```jsonc
{
  "skewContract": "1",
  "name": "portfolio-fund",
  "current": 2,
  "steps": [{
    "from": 1, "to": 2,
    "description": "promote scalars to structure; add liquidity fields",
    "ops": [
      { "rename": { "from": "currency", "to": "baseCurrency" } },
      { "move": { "from": "cashPct", "to": "liquidity.cashPct" } },
      { "default": { "path": "liquidity.hqlaPct", "value": 0 } }
    ]
  }]
}
```

Nothing in the document is executable: ops come from a closed whitelist, and
each op knows its inverse, so declaring the up migration also provides the
down migration, with derived and lossy paths computed rather than
hand-annotated. Transforms the op set cannot express are named `"code"`
steps — consumers that ship the named implementation run it; consumers that
don't fail loudly with `gap` rather than guessing.

The client side is one call:

```ts
const result = await resolver.readResolving(FundSchemaV1, body, CONTRACT_URL);
```

It reads exactly as `read()` would; only on `ahead` does it fetch the
contract, learn the newer steps, and read again as a labeled projection. The
document is cached with ETag revalidation and can be pinned by content
fingerprint. Frozen per-version interfaces are generated from the document
(`skew-contract gen`) rather than maintained by hand.

## Angular integration

All Angular packages are standalone-only (configuration via `provideSkew*()`
functions), signal-based, zoneless-safe, and SSR-safe. See the
[Angular integration hub](libs/angular/README.md) and the per-package
READMEs linked in the table above.

## Alternatives, and when they're enough

- **`location.reload()` on `ChunkLoadError`** works until the origin is
  stale (infinite loop), the user is offline (error page), the route was
  deleted (404), or a half-written form was open (data loss).
- **Long CDN retention for old chunks** helps, but caching isn't retention:
  edges evict regardless of TTL, cold edges never had the object, and a
  pipeline that deletes old assets defeats it entirely. If you have real
  retention, you need less of this library's router half.
- **Vercel Skew Protection** solves the asset half well, at the platform
  layer — if you deploy on Vercel. It doesn't address API contract skew or
  locally persisted data.
- **State libraries** store drafts; they don't version them. The failure
  isn't losing a draft — it's resuming one whose shape has changed.

## Demos

Three demo setups (simulated, production federated, and Braid microfrontends)
plus a mock NestJS API exercise every scenario above. See
**[apps/README.md](apps/README.md)** and **[docs/braid-poc.md](docs/braid-poc.md)**
for how to run them.

```sh
npm run demo         # simulated, single build, fastest way to look around
npm run demo:prod    # two production builds, real deploys, real failures
npm run braid:demo   # Braid microfrontend POC (host + 3 remotes on one page)
```

## Development

```sh
npm install
npm run verify                   # lint + test + build, every library

npm test                         # all projects
npm run test:libs                # libraries only
npm run build:libs               # → dist/libs/*
npm run lint:libs
npm run format
npm run audit                    # cve-lite-cli: fails on high/critical CVEs
```

`npm run audit` also runs in CI on every PR and weekly. Accepted findings live
in `.cve-lite/baseline.json`, with the reason for each in
[`.cve-lite/README.md`](.cve-lite/README.md). Fix a finding rather than
baselining it; regenerate the baseline only to remove entries.

**Publishing**

```sh
npm run deploy:libs:dry-run
npm run deploy:libs              # nx release publish
npm run registry                 # local verdaccio on :4873
npm run deploy:libs:local
```

**Workspace conventions**

- Strict TypeScript with `noUncheckedIndexedAccess`
- ESM with explicit `.js` specifiers (`moduleResolution: nodenext`)
- Angular: signals, zoneless, standalone-only, `inject()`, no NgModules
- Results over exceptions at every boundary
- Zero runtime dependencies outside peer frameworks

Design rationale for every package — the constraints that forced each API
shape and the known gaps — is in the
**[Technical Appendix](technical-appendix.md)**.

## License

MIT
