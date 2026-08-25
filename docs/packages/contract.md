# @braidlabs/contract

Data-driven declarative schema migrations. The API that owns a contract publishes its version history as a JSON document (`/.well-known/skew/contracts/:name`), allowing older client builds to dynamically fetch, interpret, and bidirectionally migrate data without shipping new client code.

---

## Installation

```bash
npm install @braidlabs/contract @braidlabs/skew
```

---

## Why Declarative Contracts?

Standard code-shipped migration chains cannot migrate **backward** from a future version (`ahead` failure) because the older client was compiled before the new version was authored.

`@braidlabs/contract` solves this:
- **Reversible Declarative Operations:** Operations (`rename`, `move`, `wrap`, `hoist`, `map`, `default`, `drop`, `convert`, `const`) automatically imply their inverse migrations.
- **Dynamic Downgrades:** When an older client receives data authored by a newer build, it fetches the contract document from the origin, learns the new migration steps, and downgrades the payload safely.

---

## Contract Document Structure

```json
{
  "skewContract": "1",
  "name": "user-account",
  "current": 2,
  "steps": [
    {
      "from": 1,
      "to": 2,
      "description": "split fullName into firstName and lastName; nest settings",
      "ops": [
        { "rename": { "from": "name", "to": "fullName" } },
        { "move": { "from": "theme", "to": "preferences.theme" } },
        { "default": { "path": "preferences.notifications", "value": true } }
      ]
    }
  ],
  "schemas": {
    "1": { "type": "object", "properties": { "name": { "type": "string" } } },
    "2": { "type": "object", "properties": { "fullName": { "type": "string" } } }
  }
}
```

---

## Usage

### Reading with Dynamic Contract Resolution

```ts
import { createContractResolver, wellKnownContractUrl } from '@braidlabs/contract';
import { UserSchemaV1 } from './user.schema';

const resolver = createContractResolver();
const contractUrl = wellKnownContractUrl('https://api.example.com', 'user-account');

// Reads data, resolving contract document from API if payload is from a future version
const result = await resolver.readResolving(UserSchemaV1, payload, contractUrl);

if (result.ok) {
  console.log('Projected user:', result.value);
  if (result.downgradedFrom) {
    console.warn(`Downgraded from future version ${result.downgradedFrom}`);
    console.log('Discarded lossy paths:', result.lossyPaths);
  }
}
```
