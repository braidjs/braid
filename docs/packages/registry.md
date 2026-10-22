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
    whole site (`/`, `/*`, a leading parameter) is not served and is logged. List `'/'` to allow
    those.
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
