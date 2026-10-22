# @braidlabs/registry

Immutable, content-addressed snapshots of a Braid fragment registry, with schema validation, fallback caches, and change-diff analysis.

---

## Installation

```bash
npm install @braidlabs/registry
```

---

## Why Content-Addressed Snapshots?

Because the registry is on the critical request path during server-side piercing, querying a live relational database on every document load can introduce latency and single-point-of-failure risks.

| Feature | Benefit |
| :--- | :--- |
| **Cacheable Forever** | A snapshot hash identifies a byte-identical manifest document that never mutates. |
| **Instant Rollback** | Rollback is an atomic pointer move to a previous snapshot ID with zero database migrations. |
| **Survives Store Outages** | The gateway memoizes the pinned snapshot on boot; store outages never disrupt live traffic. |
| **Deterministic Diffs** | Reviewable diff analysis between two snapshot hashes before promoting changes to production. |

---

## Usage

### Creating & Storing Snapshots

```ts
import { createSnapshot } from '@braidlabs/registry';
import { fileSnapshotStore } from '@braidlabs/registry/node';

const store = fileSnapshotStore({ directory: '/var/lib/braid' });

// Create an immutable snapshot from manifests
const snapshot = await createSnapshot({
  manifests: [
    { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] },
    { id: 'catalog', endpoint: 'https://catalog.internal', pierce: ['/products/*'] },
  ],
});

// Content-addressed: the id is 'reg_' plus 32 hex chars of a SHA-256 of the content
await store.put(snapshot);
console.log(`Published snapshot: ${snapshot.id}`);
```

### Loading in Braid Gateway

```ts
import { createGateway } from '@braidlabs/gateway';
import { snapshotRegistry } from '@braidlabs/registry';
import { fileSnapshotStore } from '@braidlabs/registry/node';

const store = fileSnapshotStore({ directory: '/var/lib/braid' });

const gateway = createGateway({
  registry: snapshotRegistry({
    store,
    pinned: process.env.BRAID_REGISTRY_SNAPSHOT, // e.g. 'reg_bc25abc511812088f248a24bb2b8d78b'
    fallback: 'last-known-good',
  }),
});
```

### Federating team gateways

`subgraph()` and `supergraph()` compose another team's gateway into this one's registry, so its
fragments pierce straight into your shell instead of arriving as a shell within a shell:

```ts
import { subgraph, supergraph } from '@braidlabs/registry';

createGateway({
  registry: supergraph([
    orgManifests,
    subgraph({ name: 'orders', url: 'https://orders.internal', registry: 'https://orders.internal/braid-registry.json' }),
  ]),
});
```

Composition fails closed on a fragment id claimed twice. See [Federating gateways](/braid-federation)
for the request flow, credentials, and composing ahead of time into a snapshot.

---

## Snapshot Diffing

Inspect changes between two snapshot versions before deployment:

```ts
import { diffRegistries } from '@braidlabs/registry';

const diff = diffRegistries(previousSnapshot.manifests, newSnapshot.manifests);

console.log('Added fragments:', diff.added);
console.log('Removed fragments:', diff.removed);
// Each change is labelled by owner: 'gateway' (routing, exposure) or 'app' (labels).
console.log('Changed:', diff.changed);
```

---

## Shells

A shell is the page fragments compose into, kept in the same snapshot: a framework, routes, and per
route a CSS grid written as ASCII art (`grid-template-areas`), the fragment in each area, and the
document head.

```ts
await createSnapshot({
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
      head: { title: 'Billing', stylesheets: [{ href: '/assets/theme.css' }] },
    },
  ],
});
```

`validateRegistry(manifests, { shells })` checks:

- layouts by the browser's rules (rectangular areas, equal-width rows);
- that every slotted fragment is registered;
- route syntax, and that no two shells claim the same route;
- that scripts and stylesheets load over `https:` or a root-relative path.

A snapshot without shells keeps the id it always had.

### Serving shells from their definition

A `vanilla` shell needs no application. The gateway renders it from the registry and pierces
fragments into it in the same pass, so publishing the shell puts the page live with no rebuild:

```ts
import { shellDocuments, snapshotRegistry } from '@braidlabs/registry';

const registry = snapshotRegistry({ store });
createGateway({
  registry,
  registryRefreshMs: 5_000, // with hot re-pin, a published shell is live within seconds
  documents: shellDocuments({
    registry,
    runtimeSrc: '/assets/braid-runtime.js',
    assetOrigins: ['https://cdn.example.com'], // third parties a shell may load from; default none
    paths: ['/billing', '/promo'], // where shells may answer; default: anywhere but the whole site
  }),
});
```

- **Matching.** A document request that a vanilla shell's route matches is answered with that route
  rendered. Shells are tried in id order and routes in the order declared, with the same
  trailing-slash tolerance as `pierce`. Anything else falls through to the app behind the gateway.
- **What it renders.** The head, the route's grid as an inline `<style>` rule, a named
  `<fragment-slot>` per slotted area, and the runtime module. Unbound fragments get their `src`.
- **Untrusted input.** The snapshot is treated as untrusted at render time, not only at publish
  time. Text is escaped, a script or stylesheet URL that is not `https:` or root-relative is left
  out, a layout value that is not a CSS track list is dropped, and an unbound fragment's `src` must
  be a root-relative path.
- **Operator limits.** Publishers decide what a shell contains, and the operator decides what a
  served shell may do:
  - `assetOrigins` lists the origins whose scripts and stylesheets a served shell may load. By
    default only root-relative assets load, because a script a shell names runs on this origin,
    beside every pierced fragment, every cookie and the registry API.
  - `paths` lists the path prefixes shells may be served at. Without it, a route that claims the
    whole site (`/`, `/*`, `/{*}`, a leading parameter or group) is not served and is logged. List
    `'/'` to allow those. A route is judged as URLPattern compiles it, so `/billing/../login` is
    `/login`, not a path under `/billing`. Set `paths` whenever publishers are not all trusted
    operators: a served shell answers ahead of the app, so an unlisted route is a claim on any page
    the app serves, `/login` included.
- **HEAD.** A HEAD request gets the same status and headers without the body, so monitors and link
  checkers see what a browser does.
- **No CSP header.** Served pages carry no Content-Security-Policy. A strict `style-src` would block
  the inline styles inside pierced fragments, so the right policy depends on your fragments; set
  one at your edge.
- **`runtimeSrc`.** A module you build and serve that runs `initBraid()` from `@braidlabs/core`. A
  served page has no bundler to resolve a bare import, so the runtime has to arrive as one file.
- **Same snapshot.** Shells come from the snapshot whose fragments the gateway is serving, so a
  re-pin moves both together. A snapshot the gateway refused to load, for example one with a
  pattern that doesn't compile, can't put its shell ahead of the fragments still being served.
- **Overlaps.** Two shells declaring the same route is a validation error. Routes in different
  shells that can answer the same page, such as `/billing/*` and `/billing/:id`, get a
  `shell-route-overlap` warning, and the shell with the earlier id wins.

React, Angular and Angular SSR shells are applications. The console generates their code, and they
are served by your app as before.

Today the framework selects the host code the console generates. The gateway still serves the HTML
your shell app returns; serving shells from the definition is planned.

---

## The write API

```ts
import { createRegistryApi } from '@braidlabs/registry';
import { createOidcAuthorizer } from '@braidlabs/registry/oidc';

const api = createRegistryApi({
  store,
  ...createOidcAuthorizer({ issuer: 'https://example.okta.com/oauth2/default', audience: 'api://braid-console' }),
});
const response = await api.handle(request); // null when the path is not the API's
```

| Route | Does |
| :--- | :--- |
| `GET /head` | the pinned snapshot, shells included |
| `GET /snapshots`, `GET /snapshots/:id` | a page of history (`?limit=`, up to 100, and `?before=` a previous page's `next`), and one snapshot |
| `GET /permissions` | the caller's `{ read, publish, pin, actor }` |
| `POST /snapshots` | `{ manifests, shells?, labels?, pin?, baseId? }` → validate, mint, store, pin |
| `POST /head` | `{ id }` — re-pin. Rollback is this. |

- **Writes need `authorize`.** Without it they are refused. A publish that pins needs both `publish`
  and `pin`, so a contributor role publishes candidates with `pin: false`.
- **`identify`** records the verified caller as `labels.publishedBy`, replacing any client value.
- **`baseId`** makes a stale publish fail with 409 instead of overwriting someone else's.
- **Omitted `shells` carry HEAD's forward**, so a client that only edits fragments cannot delete
  every shell by accident; `[]` removes them.
- **`endpointOrigins`** lists the origins a fragment endpoint may be on. The gateway proxies
  `/__braid/frag/:id/*` to a fragment's endpoint, so without it anyone who may publish decides what
  part of your network that path opens to the internet. A publish outside the list is refused with
  422 (`endpoint-not-allowed`); `validateRegistry` takes the same option for CI.
- **Bodies are capped** at `maxBodyBytes` (5 MB by default) and refused with 413 beyond it.
- **Browsers must send JSON.** A write carrying `Origin` or `Sec-Fetch-Site` must be
  `application/json` or is refused with 415, so a page cannot send a form or `text/plain` write
  without a CORS preflight. Cross-site browser writes are refused outright. Pipelines are unaffected.
- **Paging** is stable: newest first, by id within a millisecond. A custom store should honor
  `list({ before })` with `isAfterCursor`; one that ignores it ends the listing after one page.

### GitOps: publish by pull request

Give the API a `publisher`, and a publish becomes a proposal. It is validated, checked for
ownership and minted exactly as it would be stored, then handed to the publisher instead of the
store. The API answers `202` with the pull request, and HEAD stays where it is. Review and merge
are the approval, and whatever deploys the registry from the repository is what makes it live.

```ts
import { createRegistryApi, githubPublisher } from '@braidlabs/registry';

createRegistryApi({
  store, // synced from the repository's main branch, e.g. a file store over a checkout
  ...authorizer,
  publisher: githubPublisher({
    owner: 'acme',
    repo: 'registry',
    token: process.env.GITHUB_TOKEN, // contents: write, pull_requests: write
    directory: 'registry', // <id>.json and HEAD, in the file store's layout
  }),
});
```

For each publish, `githubPublisher`:

- creates a branch;
- writes `<directory>/<id>.json`, byte-for-byte what `fileSnapshotStore` holds;
- for a pin, also writes `<directory>/HEAD`;
- opens a pull request against `base`. The body says who asked, what changes, and any warnings.

Merging is therefore publishing for anything that reads the directory with `fileSnapshotStore`.

A few more details:

- **Errors.** An invalid registry is still a 422, and GitHub is never called. A GitHub failure is a
  502 that carries GitHub's message, never the token, and the branch it created is deleted.
- **Republishing** content already in the repository, such as a re-pin of a merged candidate,
  reuses the file, since a snapshot's id is its content. Only `HEAD` changes.
- **The pull request body** says who asked (the verified actor, and never a client-claimed
  `publishedBy`), what changes, and any warnings. Text that came from a publisher sits in code
  spans, so it can't add lines, mention people or link anywhere.
- **Audit** records the publish as outcome `proposed`, with the pull request URL. The console links
  the pull request.
- **Judged against the store.** `baseId`, ownership and diffs compare with the store, which lags
  the repository until it syncs. Two pull requests from the same base are each checked against
  the old HEAD. For a pin, the conflict on the `HEAD` file shows up in review, and resolving it is a
  review decision.
- **Pins** (`POST /head`) still act directly on the store, so under GitOps leave pinning to merges.
- **GitHub Enterprise Server:** set `apiUrl`, which must be https.

Without a publisher API, CI can still publish from git: `braid registry publish --source` in a
pipeline that runs on merge.

### Environments, promotion and approvals

HEAD is where publishing lands. Environments are named pointers beside it, and they move only by
promotion. A gateway can follow an environment instead of HEAD:

```ts
createRegistryApi({
  store,
  ...authorizer,
  environments: [
    { name: 'staging' }, // promoted from HEAD
    { name: 'production', from: 'staging', approvals: 1 },
  ],
});

// production's gateway serves what was promoted to production, live within the refresh interval
createGateway({ registry: snapshotRegistry({ store, environment: 'production' }), registryRefreshMs: 15_000 });
```

| Route | Does |
| :--- | :--- |
| `GET /environments` | each environment, where it points, and any promotion awaiting approval |
| `POST /environments/:env/promote` | `{ id? }`: move the environment, or with `approvals`, ask to (202) |
| `POST /environments/:env/approve` | approve the pending promotion |
| `POST /environments/:env/reject` | withdraw it (the requester) or decline it (an approver) |

- **What can be promoted.** An environment with a `from` source takes that source's current
  snapshot, so production gets exactly what staging was tested with. It can also be promoted back
  to a snapshot it served before, which is how it rolls back. One with no source takes HEAD, or any
  snapshot named.
- **Approvals.** With `approvals: 1`, a promotion waits until someone other than the requester
  approves it. The API refuses to start without `identify`, because an approval that can't tell
  people apart isn't one. Several rules keep the approval honest:
  - **People are compared by `subject`,** a stable identity. `createOidcAuthorizer` supplies
    issuer plus subject, so one person showing up under different display names on different
    clients is still one person.
  - **An approval names the request it approves** (`{ id, requestedAt }`, which the console
    sends). It is refused if that request was withdrawn and replaced after review, or if the
    environment moved since the request.
  - **Steps are serialized.** Promote, approve and reject run one at a time per environment within
    one API instance. Across instances, a store with compare-and-set would be needed.
  - **Withdrawing** is the requester's, while they still hold the right to promote there.
- **Rights per environment.** `promote` and `approve` are actions, and `authorize` receives the
  environment. With `createOidcAuthorizer`, `roleMap` can grant `'promote:staging'` or
  `'approve:production'`, and the bare action grants it everywhere. `DEFAULT_ROLE_MAP` grants
  neither. `/permissions` reports both rights for each environment. If your own `authorize` returns
  true for every action other than `read`, it now grants `promote` and `approve` too. Check it
  before turning environments on.
- **Ownership and audit.** Under per-tag ownership, a promotion is checked like a pin, by what it
  changes. Every promotion, approval and rejection is an audit event carrying its `environment`.
- **Storage.** Both bundled stores keep environments: memory, and the file store's `refs/` and
  `pending/` beside `HEAD`.

### Per-tag ownership

A registry is shared by many teams, and "may publish" is too coarse a right for it. With `owns`,
the API limits each caller to the fragments and shells carrying a tag they own:

```ts
createRegistryApi({
  store,
  ...createOidcAuthorizer({
    issuer,
    audience,
    roleMap: { 'braid-editors': ['read', 'publish', 'pin'] },
    // group → the tags its members own; '*' for everything
    tagMap: { payments: ['finance'], storefront: ['react', 'growth'], platform: '*' },
  }),
});
```

The rule applies to every fragment or shell a publish adds, changes or removes, compared with
HEAD. The caller must own **one of its old tags and one of its new ones**:

- Checking only the old tags would let a team retag its fragment into someone else's area.
- Checking only the new tags would let a team claim someone else's fragment by tagging it.
- An untagged item belongs to no team, so it needs `'*'`.

A pin is checked the same way, by what it changes about what is being served, so pinning someone
else's edit is not a way around it. Further rules:

- **Routes.** Owning a fragment doesn't mean owning every URL it can claim. A change that makes a
  fragment pierce pages already pierced by a fragment the caller doesn't own is refused. So is a
  change that makes a shell's routes answer pages a shell the caller doesn't own answers, which
  would otherwise win them outright by sorting first. Overlaps that already existed in HEAD are not
  the caller's doing and don't block their edits.
- **Races.** HEAD is re-checked just before it moves, with or without `baseId`. A publish or pin
  checked against one HEAD therefore can't replace a newer one and silently revert another team's
  change.
- **Co-owned items.** A fragment tagged `[finance, react]` can be changed by either team, and that
  includes removing the other team's tag.
- **Descriptors.** Ownership is judged on what the caller sent, before descriptors are merged.
- **Failures.** If `owns` throws, the write is refused with a generic 503.

A refusal is a 403 that names every item, and it is audited as `denied`. `GET /permissions` reports
the caller's `tags`, and the console hides Edit and Delete on items the caller doesn't own. Without
`owns` (or `tagMap`), nothing changes, and `publish` and `pin` rights are all there is.

### Audit export

Every attempted publish and pin produces one audit event, with one of four outcomes:

- `success`: the write went through.
- `denied`: the caller lacked the right, or the request was a cross-site browser write.
- `rejected`: the server refused it, such as a registry with errors or a HEAD that moved.
- `error`: the server failed partway. `snapshotId` and `pinned` say how far the write got.

Each event carries the verified actor (from `identify`, resolved once per request), the HTTP status,
the snapshot ids involved and, for anything but a success, the reason. Reads are not audited.

```ts
import { createRegistryApi, jsonLinesAuditSink, webhookAuditSink } from '@braidlabs/registry';

createRegistryApi({
  store,
  ...authorizer,
  audit: [
    // one JSON object per line, for Fluent Bit, Vector, or the Splunk or Datadog agent to ship
    jsonLinesAuditSink((line) => process.stdout.write(line)),
    // or straight to an HTTP collector, batched
    webhookAuditSink({ url: 'https://splunk.example/services/collector/raw', headers: { authorization: `Splunk ${token}` } }),
  ],
});
```

```json
{"version":1,"at":"2026-10-22T09:14:03.112Z","action":"pin","outcome":"success","actor":"ada@example.com","status":200,"previousId":"reg_9f…","snapshotId":"reg_41…"}
```

Sinks are best effort. They run after the response is decided, and a sink that throws or rejects
is logged once and never changes what the caller gets. That way an audit pipeline that is down
cannot stop someone rolling back a broken page. For fail-closed auditing, ship the JSON-lines
output with a durable log agent.

`webhookAuditSink` behaves as follows:

- **Batching:** at most 50 events per POST, sent when 50 are queued or after 5 seconds, with one
  request in flight at a time.
- **Failures:** a batch the endpoint refuses, or that gets no answer within 10 seconds, is kept,
  and the sink backs off, doubling up to a minute. An outage therefore costs one request per
  backoff period and one warning, however busy the API is.
- **Overflow:** when the queue reaches 10 000 events, the oldest are dropped and the count is
  logged.
- **Shutdown:** the timer does not keep the process alive, so call `sink.flush()` on shutdown or
  up to 5 seconds of events are lost. On Workers, pass `flush()` to `ctx.waitUntil`.

### Okta

`createOidcAuthorizer` verifies bearer tokens against the issuer's JWKS and maps groups and scopes
to actions through `roleMap` (default: `braid-viewers` → read, `braid-editors` → read, publish,
pin). It needs the optional peer dependency `jose`.

1. Use a **custom authorization server** (`https://<org>.okta.com/oauth2/default` or your own); the
   org server's access tokens cannot be verified by third parties.
2. Add a **`groups` claim to the access token**, filtered to your `braid-*` groups.
3. For CI, create a service app (client credentials) and a custom scope such as `braid:publish`, put
   that scope in `scopeMap` (not `roleMap`), and restrict the scope to the service app in the
   authorization server's access policy. Service tokens have no groups, and a scope any client may
   request is a scope any signed-in user may hold.
4. Set `audience` to the authorization server's audience (`api://default` unless you changed it).
5. For per-tag ownership, map groups to tags with `tagMap` (see [Per-tag ownership](#per-tag-ownership)).
   A caller in no mapped group owns nothing.
