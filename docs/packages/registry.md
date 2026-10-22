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

`validateRegistry(manifests, { shells })` checks layouts by the browser's rules (rectangular areas,
equal-width rows), that every slotted fragment is registered, route syntax, and that scripts and
stylesheets load over `https:` or a root-relative path. A snapshot without shells keeps the id it
always had.

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
| `GET /snapshots`, `GET /snapshots/:id` | history and one snapshot |
| `GET /permissions` | the caller's `{ read, publish, pin, actor }` |
| `POST /snapshots` | `{ manifests, shells?, labels?, pin?, baseId? }` → validate, mint, store, pin |
| `POST /head` | `{ id }` — re-pin. Rollback is this. |

- **Writes need `authorize`.** Without it they are refused. A publish that pins needs both `publish`
  and `pin`, so a contributor role publishes candidates with `pin: false`.
- **`identify`** records the verified caller as `labels.publishedBy`, replacing any client value.
- **`baseId`** makes a stale publish fail with 409 instead of overwriting someone else's.
- **Omitted `shells` carry HEAD's forward**, so a client that only edits fragments cannot delete
  every shell by accident; `[]` removes them.

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
  people apart isn't one. If the environment moved after the request, the approval is refused:
  the approver would be approving a change they never saw.
- **Rights per environment.** `promote` and `approve` are actions, and `authorize` receives the
  environment. With `createOidcAuthorizer`, `roleMap` can grant `'promote:staging'` or
  `'approve:production'`, and the bare action grants it everywhere. `/permissions` reports both
  rights for each environment.
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
  fragment pierce pages already pierced by a fragment the caller doesn't own is refused. Overlaps
  that already existed in HEAD are not the caller's doing and don't block their edits.
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
