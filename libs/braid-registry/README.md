# @braidlabs/registry

Immutable, content-addressed snapshots of a [Braid](../braid-gateway) fragment registry — plus the
analysis that tells you what a change would do.

```ts
import { createSnapshot, snapshotRegistry } from '@braidlabs/registry';
import { fileSnapshotStore } from '@braidlabs/registry/node';

const store = fileSnapshotStore({ directory: '/var/lib/braid' });
await store.put(await createSnapshot({ manifests }));

createGateway({
  registry: snapshotRegistry({ store, pinned: process.env.BRAID_REGISTRY_SNAPSHOT }),
});
```

## Why snapshots

The registry sits on the request path — piercing resolves manifests while composing a document
response — so a registry backed by a live database makes gateway availability depend on that
database. Immutability fixes that, and pays for several other things on the way:

| Property | Because |
| --- | --- |
| Cacheable forever | a snapshot id names one byte-identical document; it can never mean something else later |
| Rollback is a pointer move | re-pin the previous id — no undo log, no inverse migration, nothing was mutated |
| Promotion is a pointer move | production pins the **byte-identical** artifact staging tested, not a re-render of the same intent |
| Survives a store outage | the pinned snapshot is already resolved; the store is needed to *change* config, not to serve it |
| Diffable | two ids and a diff — the reviewable artifact a config PR used to provide |

Ids are content addresses, so **publishing an unchanged registry is a no-op** rather than a new
artifact to reason about. `createdAt` and `labels` are excluded from the hash deliberately: they
describe the act of publishing, not the configuration being published.

## Resolution, and when it happens

`snapshotRegistry()` runs **once**. The gateway's `Registry` memoizes its source, so the store is
contacted during the first request that needs a manifest and never again.

Two consequences worth stating plainly:

1. The request path does not depend on the store past boot. That is the point.
2. **Re-pinning takes effect on restart, unless you ask for hot re-pin.** By default a config
   change is a deploy, visible wherever deploys are visible. Give the gateway `registryRefreshMs`
   and a source that follows HEAD (no `pinned`), and a re-pin goes live within that interval
   instead. A reload that finds HEAD unmoved costs one `head()` call. One that fails keeps the
   current snapshot serving, and a `pinned` source never moves.

   ```ts
   createGateway({ registry: snapshotRegistry({ store }), registryRefreshMs: 15_000 });
   ```

## Falling back

```ts
snapshotRegistry({
  store,                                              // primary — S3, KV, Postgres
  pinned: process.env.BRAID_REGISTRY_SNAPSHOT,
  cache: fileSnapshotStore({ directory: '/var/cache/braid' }),
  fallback: 'last-known-good',                        // default
});
```

The cache must be **durable** to be useful. The failure it exists to cover is a cold boot against
an unreachable store, and an in-memory cache has nothing in it at that moment. Choose
`fallback: 'fail'` when serving stale routing is worse than serving nothing.

Snapshots are verified on read: content that does not hash to its id is refused, because that is
not staleness but alteration, and serving it would silently change which fragments compose which
pages.

## Analysis

Framework-free and dependency-free, so the same functions back `braid registry validate` in a
terminal and a console in a browser.

```ts
import { validateRegistry, diffRegistries } from '@braidlabs/registry';

validateRegistry(manifests);          // conflicts decidable from the manifests alone
diffRegistries(published, proposed);  // what this config would change
```

`validateRegistry` catches duplicate and unaddressable ids, relative endpoints, invalid pierce
patterns, incomplete `custom-element` manifests, empty access rules, and — the one that is
invisible in a line-oriented diff — **two fragments whose pierce patterns claim the same page
URLs**. Overlap is a *warning*: a page composing several fragments is the feature, a stray `/*`
swallowing a sibling route is the bug, and only you can tell them apart.

Overlap detection is a documented heuristic. `URLPattern` exposes no intersection operation, so
each pattern is reduced to a sample path and cross-tested. That catches what happens in practice
and will miss patterns that intersect only on inputs the sample does not generate.

`diffRegistries` labels every change with the field's **owner**:

```
~ billing
    pierce (gateway)   ["/billing/*"] → ["/billing/*","/invoices/*"]
    title  (app)       "Billing" → "Billing & Invoices"
```

That split comes from one question — *can a lie here hurt anyone but the liar?* A changed `pierce`
is a routing change with page-wide blast radius; a changed `title` is a label. A flat list of
altered keys makes them look alike.

## Access preview

`satisfies()` is a pure function of a rule and a principal, so the effect of an access change is
*exactly* computable — no sampling, no observation. What is not available is a list of real users:
the gateway holds no principal directory. So the operator names who to test as, which is honest
about its inputs and still catches the change that matters.

```ts
const matrix = accessMatrix(proposed, [ANONYMOUS, { name: 'trader', roles: ['trader'] }], published);
matrix.losses; // ← the output that matters
```

**Losses are the finding; the grid is context for it.** A gain is usually deliberate and already
visible in the diff. A loss is how a fragment quietly stops being listed for the people who use it,
and nothing else in the toolchain would tell you.

Three details that are easy to get wrong:

- A removed fragment produces losses, not silence. Losing access by deletion is still losing
  access, and an operator should not have to cross-reference the diff to notice.
- `denied → absent` is **neither** a gain nor a loss. Classifying by "was not previously allowed"
  would announce that deleting a fragment granted people access to it.
- Manifests are not normalized first, because this runs while someone is still typing one. An
  incomplete manifest is `validateRegistry`'s finding to report, not this one's to throw on.

```bash
braid registry access --against ./snapshots --as 'trader:roles=trader'
```

Principals can also live in `braid.config.json` under `principals`, which makes them reviewable and
shared — the roles a deployment cares about are a property of the deployment, not of one command.
`anonymous` is always checked and never needs declaring.

## Traffic-informed impact

The static checks answer *"do these patterns overlap?"*. This answers *"and does anyone go there?"* —
which turns a warning an operator has to judge into a number they can act on. It is the only
analysis here that is **not** decidable from the manifests alone, which is why it needs a gateway to
have been recording and is opt-in at both ends.

```ts
const observations = createRoutingObservations({
  maxPaths: 5000,
  redact: (pathname) => pathname.replace(/\/invoices\/[^/]+/, '/invoices/:id'),
});

createGateway({ registry, observe: (event) => observations.record(event) });
```

```bash
braid registry impact --observations ./observations.json --against ./snapshots
```

```
  billing  −5 requests on 2 paths
  reviews  +3 requests on 1 path

requests  path
       4  /billing/settings  −billing
       3  /reports/q3        +reviews
       1  /billing           −billing

  8 of 20 observed requests affected
```

**An aggregate, not a log.** A log of every document request is unbounded, is a retention
liability, and answers no question this needs. What the analysis needs is the distinct paths, how
often each is served, and what composes there.

Three disciplines, all of which any request-path event sink needs:

| Concern | Approach |
| --- | --- |
| **Bounded memory** | `maxPaths` caps distinct paths; least-recently-seen is evicted first, keeping the sample weighted toward live traffic |
| **Redaction** | paths carry identifiers and sometimes personal ones — `redact` collapses them, which flattens cardinality at the same time |
| **Never blocking** | `observe` is synchronous, unawaited, and updates one map entry; a sink doing real work must buffer and flush elsewhere |

A capped set reports `sampled: true`, and every summary built from it says so. Truncated data that
reads as complete is worse than none.

Only **document** requests are observed — a soft navigation fetching the same URL is not a second
page view — and *every* document request is, not just pierce-matched ones. A path that composes
nothing today is exactly the path a widened pattern would start composing tomorrow, and reporting a
gain needs both sides.

## Stores

| Store | Where | Use |
| --- | --- | --- |
| `memorySnapshotStore()` | `@braidlabs/registry` | tests, development |
| `fileSnapshotStore({ directory })` | `@braidlabs/registry/node` | single-instance primary, config volume, or the durable local cache |

`SnapshotStore` is four methods and no update path, because a snapshot cannot be edited. Implement
it against whatever you already run.

The filesystem store writes atomically by rename, so a process dying mid-write leaves the previous
bytes intact rather than a truncated file that fails verification on the next boot. It refuses ids
that are not content addresses, so a crafted id cannot read outside its directory.

## The write API

Editing needs a server. `createRegistryApi` is fetch-native, like the gateway, and mounts wherever
you already handle requests:

```ts
const api = createRegistryApi({
  store,
  authorize: (request, action) => session(request).can(action), // 'read' | 'publish' | 'pin'
  fetchDescriptors: true,
});

const response = await api.handle(request); // null when the path is not ours
```

| Route | Does |
| --- | --- |
| `GET /head` | the pinned snapshot |
| `GET /snapshots` | recent snapshots, newest first |
| `GET /snapshots/:id` | one snapshot |
| `GET /permissions` | the caller's own `{ read, publish, pin, actor }`, so a UI offers only what will work |
| `POST /snapshots` | validate → merge descriptors → mint → store → pin |
| `POST /head` | re-pin. **This is rollback**, and it is the whole of it |

The publish body is `{ manifests, shells?, labels?, pin?, baseId? }`:

- **`pin`** defaults to true, and a publish that pins is checked for **both** `publish` and `pin`. A
  role that may only publish sends `pin: false` and leaves a candidate for someone who may pin.
  **Upgrading:** before this, a default publish asked `authorize` only for `publish` and pinned
  regardless. A hook that grants a pipeline `publish` but not `pin` now gets 403 for a pinning
  publish; grant `pin` too, or publish with `pin: false`.
- **`baseId`** is the snapshot id a draft started from (`null` if nothing was pinned). When sent, a
  publish is refused with **409** and `{ head }` if HEAD has moved since, so two editors cannot
  silently overwrite each other. Omit it for last-write-wins, as a pipeline might.
- **`shells`**: omit to keep HEAD's shells, `[]` to remove them. Carried shells are validated, so
  deleting a fragment a shell still slots is refused by name rather than publishing a hole.

Malformed JSON is a **400**, and a shell of the wrong shape a **422** naming the field. A write that
a browser marks `Sec-Fetch-Site: cross-site` is refused, which closes CSRF for an `authorize` hook
that reads a cookie. `baseId` is checked on arrival and again just before HEAD moves, without a
lock: two publishes in the same instant can both pass, which only a compare-and-set store closes. `authorize` may return a `Response` — a 401 with `WWW-Authenticate`,
say — which is sent as-is; `false` is a 403.

**`identify(request)`** names the caller as the server knows them. When present, every publish
records it as `labels.publishedBy` and discards any client-sent value; without it, labels are
whatever the client claimed.

**Writes are refused without an `authorize` hook.** There is no permissive default: an
unauthenticated publish endpoint is remote control of which fragments compose which pages. Reads
are allowed by default, matching the registry's own public-by-default posture.

Publishing **re-validates server-side** whatever arrives. A client may validate too — the console
does, as you type — but that is a convenience for whoever is typing, not the decision.

Drafts are deliberately not server state. Only published snapshots are, which keeps this to six
routes and sidesteps multi-editor reconciliation; the cost is that drafts do not follow you between
devices.

## The registry as an FDC3 App Directory

`appd` serves the registry as an FDC3 2.2 App Directory, from the same API, under the same `read`
right — one URL to configure in any FDC3 desktop agent:

```ts
createRegistryApi({
  store,
  ...authorizer,
  environments: [{ name: 'staging' }, { name: 'production', from: 'staging', approvals: 1 }],
  appd: { origin: 'https://portal.example', environment: 'production' },
});
// GET /__braid/registry-api/appd/v2/apps          → { applications, message }
// GET /__braid/registry-api/appd/v2/apps/billing  → the bare Application record
```

- **Governed.** With `environment`, the directory is that environment's pin, so an agent resolves
  intents only to apps that were promoted — and approved, where production requires it. Without
  it, HEAD is served.
- **The same records as the gateway.** Manifests' `fdc3` and `appd` blocks are projected by the
  gateway's `toAppdApplication`, validated in tests against FDC3's own schema. `origin` is the shell
  the apps appear on; `details.url` and icons are absolute on it.
- **Not per-user.** This is the governance view: it is not filtered by `access.list`. For a page's
  own agent, where each user should see only what they may list, serve
  `discovery: { appd: true }` from the gateway instead.
- **Its own right.** The directory asks `authorize` for `read` with `{ resource: 'directory' }`, so
  it can be opened to desktop agents without opening `/head` and `/snapshots`, which return whole
  manifests. `createOidcAuthorizer` grants it to `'read:directory'` as well as `'read'`.
- Errors are AppD's `{ code, message }`: 404 for an unknown app, 403 when `authorize` refuses `read`.
  A `Response` from `authorize` (a 401 bearer challenge) is passed through.

## Shells

A shell is the page fragments compose into, as data: a framework, routes, and per route a layout
written as CSS `grid-template-areas` — the ASCII art *is* the CSS — with the fragment that fills each
area, plus the document head (meta, and scripts and stylesheets by URL).

```ts
const snapshot = await createSnapshot({
  manifests,
  shells: [
    {
      id: 'storefront',
      framework: 'react', // 'react' | 'angular' | 'angular-ssr' | 'vanilla'
      routes: [
        {
          path: '/billing/*',
          layout: { areas: 'header header\naside main', columns: '280px 1fr' },
          slots: { header: 'rating', aside: 'reviews', main: 'billing' },
        },
      ],
      head: { title: 'Billing', scripts: [{ src: 'https://cdn.example.com/a.js', type: 'module' }] },
    },
  ],
});
```

`parseAreas(text)` applies the browser's own rules — every area a single rectangle, every row the
same width, valid identifiers — and `validateRegistry(manifests, { shells })` adds shell findings:
`duplicate-shell-id`, `invalid-shell-layout`, `invalid-route-path`, `slot-unknown-area`,
`slot-unknown-fragment` (naming the shell), and `unsafe-shell-url` for anything that is not
`https:` or root-relative. Inline script is not representable.

Shells are in the content address. A snapshot without them hashes exactly as before shells
existed, so no existing id changed.

**Today a shell's framework decides the host code the console generates, not what serves the page**:
the gateway still pierces fragments into whatever HTML its downstream app returns. Serving shells
from the definition is the next step.

## Signing in with Okta, or any OIDC issuer

`@braidlabs/registry/oidc` turns verified access tokens into `authorize` and `identify`:

```ts
import { createOidcAuthorizer } from '@braidlabs/registry/oidc'; // needs the optional peer `jose`

const api = createRegistryApi({
  store,
  ...createOidcAuthorizer({
    issuer: 'https://example.okta.com/oauth2/default',
    audience: 'api://braid-console',
    roleMap: {
      'braid-viewers': ['read'],
      'braid-contributors': ['read', 'publish'], // candidates only
      'braid-editors': ['read', 'publish', 'pin'],
    },
    // For a CI service app's client-credentials token, which has no groups.
    scopeMap: { 'braid:publish': ['read', 'publish', 'pin'] },
  }),
});
```

Tokens are verified against the issuer's JWKS, found by OIDC discovery (or given as `jwks` for tests
and air-gapped networks), with asymmetric algorithms only. A missing or invalid token is a 401, a
role that does not grant the action a 403, an unreachable issuer a 503. `roleMap` matches the
`groups` claim (or `rolesClaim`); `scopeMap` matches the token's scopes. They are separate because
a scope is whatever a permitted client asked for: map one only when the issuer's access policy lets
just the CI client request it, or any signed-in user could ask for it through the console.

For Okta: use a **custom authorization server** (`/oauth2/default` or your own) — the org server's
access tokens are not verifiable by third parties — and add a **`groups` claim to the access token**,
not only the ID token. A client-credentials token has no user and therefore no groups; grant it a
custom scope and map the scope.

## Fragment descriptors

A fragment may publish facts about itself at `/.well-known/braid/fragment.json`, which the gateway
merges at publish time:

```jsonc
{ "braid": "1", "title": "Billing", "description": "Invoices and payment methods.",
  "tags": ["finance"] }
```

This exists because a manifest mixes fields owned by different teams, and a fact recorded by
someone other than the person who knows it drifts silently. The fix is not a permission matrix over
a shared document — it is letting the app publish its own facts next to the code that makes them
true.

**Always optional.** A fragment that publishes nothing keeps working exactly as it does today. That
floor must stay, because compat's whole promise is that being composed requires no change to the
app. Best generated as a build artifact, so nobody maintains it by hand.

Precedence, and why:

| Rule | Reason |
| --- | --- |
| Gateway-owned fields are **never** merged | a descriptor carrying `pierce`/`access`/`endpoint` is confused or hostile; the value is dropped **and reported** |
| An explicit manifest entry wins | a deliberate human override, and the escape hatch when a self-report is wrong |
| Otherwise the descriptor supplies it | the app knows its own title better than the platform team does |

Disagreements are surfaced, never resolved quietly — a disagreement usually means the app moved and
the manifest did not, which is the drift this exists to catch.

Fetching happens **at publish time, never on the request path**, so a gateway serving a snapshot
never reaches out to a fragment to learn what it is. A fragment that is unreachable does not fail
the publish; the previous values stand and the failure is reported.

## From the CLI

```bash
braid registry validate
braid registry publish --to ./snapshots --label by=ada --descriptors
braid registry diff --against ./snapshots
```

See [`@braidlabs/cli`](../braid-cli), and
[the console](../braid-console) for a UI over all of it.
