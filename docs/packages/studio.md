# @braidlabs/studio

Inspection and debugging tooling for version skew. Provides structural semantic diffing of versioned payloads in the vocabulary of schema migrations.

---

## Installation

```bash
npm install @braidlabs/studio
```

---

## `diffPayloads`

Performs a path-aware semantic diff of two payload shapes, specifically tracking which properties were guessed (`derivedPaths`) by forward migrations, and which properties were dropped (`lossyPaths`) during downgrades.

```ts
import { diffPayloads } from '@braidlabs/studio';
import { UserSchemaV1 } from './user.schema';

const readResult = UserSchemaV1.read(serverPayload);

if (readResult.ok) {
  const { lines, stats } = diffPayloads(serverPayload, readResult.value, {
    derivedPaths: readResult.derivedPaths, // Guessed values
    lossyPaths: readResult.lossyPaths,     // Discarded fields
  });

  console.log(`Diff Summary: +${stats.added} -${stats.removed} (~${stats.derived} derived, ~${stats.lost} lost)`);

  for (const line of lines) {
    console.log(`${line.kind.padEnd(8)} [${line.path}] ${line.text} ${line.tag ? `(${line.tag})` : ''}`);
  }
}
```

---

## Why Semantic Diffs Over Text Diffs

Standard text-based diff tools (like LCS) fail on structured JSON data when property structures evolve (e.g. promoting a scalar string `nav: 12000` to an object `nav: { amount: 12000, asOf: 1787670000 }`).

`diffPayloads` pairs lines by logical JSON path, rendering structural migrations and schema promotions cleanly and accurately.
