# @braidlabs/skew

Framework-agnostic core primitives for surviving version skew across independently deployed frontend applications, APIs, and client-side storage boundaries.

Zero dependencies. Works in browsers, Node.js, Cloudflare Workers, and Deno.

---

## Installation

```bash
npm install @braidlabs/skew
```

---

## The Core Concept: Surviving Version Skew

In composed and distributed frontend systems, version skew occurs across four critical boundaries:

| Boundary | What crosses it | Typical failure | How `@braidlabs/skew` solves it |
| :--- | :--- | :--- | :--- |
| **Past ↔ Present** | Persisted draft or local cache | `undefined` read errors / crashes | Versioned schema automatically migrates past state |
| **Client ↔ API** | Queued mutation outbox | Silent corruption or 400 Bad Request | Envelopes with explicit schema version headers |
| **Host ↔ Fragment** | Props and Context Bus events | Mismatched object shapes | Bidirectional migration bridges |
| **Client ↔ Origin** | Stale lazy chunks | `ChunkLoadError` white screen | Stamped build manifests and negotiation |

---

## Versioned Schemas & Migration Chains

Declare an entity's schema version history and progressive forward migrations in one place:

```ts
import { versioned } from '@braidlabs/skew';

// Frozen snapshot types representing each historical schema version
interface UserV1 {
  id: string;
  fullName: string;
}

interface UserV2 {
  id: string;
  firstName: string;
  lastName: string;
}

interface UserV3 extends UserV2 {
  email: string;
  verified: boolean;
}

// Migration chain definition
export const UserSchema = versioned<UserV1>('user-profile')
  .next<UserV2>('split fullName into firstName and lastName', (v1) => {
    const [firstName = '', ...rest] = (v1.fullName || '').split(' ');
    return {
      id: v1.id,
      firstName,
      lastName: rest.join(' '),
    };
  })
  .next<UserV3>('add verified email fields', (v2) => ({
    ...v2,
    email: '',
    verified: false,
  }));
```

### Reading & Auto-Migrating Data

When reading payloads from IndexedDB, localStorage, or API responses, `UserSchema.read()` automatically applies needed migration steps:

```ts
const result = UserSchema.read(rawDataFromStorage);

if (result.ok) {
  // result.value is guaranteed to match UserV3
  console.log('User profile:', result.value.firstName);

  if (result.migratedFrom !== null) {
    console.log(`Auto-migrated from schema V${result.migratedFrom} to V3`);
  }
} else {
  console.error('Failed to read payload:', result.error);
}
```

### Writing Envelopes

```ts
const envelope = UserSchema.write({
  id: 'usr_102',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  verified: true,
});

// Stored with version metadata:
// { __schema: 'user-profile', __version: 3, payload: { ... } }
```

---

## The Rules of Version Skew

1. **Snapshots are Immutable:** Migration interfaces (`V1`, `V2`) are frozen copies, never mutable live application models.
2. **Rejection of Future Versions:** If a client receives a payload authored by a build from the future (e.g. V4 when running V3 code), it fails safely and predictably (`future-version` error) rather than silently corrupting data.
3. **Pure Migration Functions:** Migration functions must be pure, deterministic functions without side effects.
