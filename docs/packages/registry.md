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

// Store content-addressed artifact (e.g. hash 'sha256:abc123...')
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
    pinned: process.env.BRAID_REGISTRY_SNAPSHOT, // e.g. 'sha256:abc123...'
    fallback: 'last-known-good',
  }),
});
```

---

## Snapshot Diffing

Inspect changes between two snapshot versions before deployment:

```ts
import { diffSnapshots } from '@braidlabs/registry';

const diff = diffSnapshots(previousSnapshot, newSnapshot);

console.log('Added fragments:', diff.added);
console.log('Removed fragments:', diff.removed);
console.log('Changed routing/piercing:', diff.modified);
```
