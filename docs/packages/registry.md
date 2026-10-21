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

### Okta

`createOidcAuthorizer` verifies bearer tokens against the issuer's JWKS and maps groups and scopes
to actions through `roleMap` (default: `braid-viewers` → read, `braid-editors` → read, publish,
pin). It needs the optional peer dependency `jose`.

1. Use a **custom authorization server** (`https://<org>.okta.com/oauth2/default` or your own); the
   org server's access tokens cannot be verified by third parties.
2. Add a **`groups` claim to the access token**, filtered to your `braid-*` groups.
3. For CI, create a service app (client credentials) and a custom scope such as `braid:publish`, and
   put that scope in `roleMap`. Service tokens have no groups.
4. Set `audience` to the authorization server's audience (`api://default` unless you changed it).
