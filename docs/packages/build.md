# @braidlabs/build

Build-time tools for stamping identity, emitting skew manifests (`skew-manifest.json`), and generating frozen schema snapshot types.

---

## Installation

```bash
npm install -D @braidlabs/build
```

---

## The `skew-stamp` CLI

Stamps the current build with git commit hash, timestamp, and metadata, writing a TypeScript module and a public manifest:

```bash
npx skew-stamp --out-ts src/build-id.ts --out-manifest public/skew-manifest.json
```

### Generated `build-id.ts`
```ts
export const BUILD_ID = '20260825.142033.a8f1e2c';
export const BUILT_AT = 1787670033000;
```

### Emitted `skew-manifest.json`
```json
{
  "buildId": "20260825.142033.a8f1e2c",
  "builtAt": 1787670033000,
  "commit": "a8f1e2c4d9",
  "branch": "main"
}
```

---

## Why Stamped Builds Matter

When an active user triggers a lazy route after a deployment lands, client routers can detect whether the current build is stale by comparing their in-memory `BUILT_AT` against the origin's `skew-manifest.json`.

If a newer build is detected, Braid's recovery interceptors perform a safe target reload without infinite reload loops.
