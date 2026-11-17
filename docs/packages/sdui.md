# @braidlabs/sdui

Server-driven UI that survives app version skew. Every component, action and analytics event is a [`@braidlabs/contract`](./contract.md) document, so a screen is authored once and **projected** to exactly what each binary in the field was built to render.

This package is the pure core: the document model, the projection engine and its fallback ladder, handshake resolution, flag and rollout evaluation, the state specification, and a contract-aware screen diff. It holds no state and does no I/O, and runs unchanged on Node, Workers, Deno, browsers and Hermes. The delivery API, the client and the CMS described in the [plan](../sdui-cms-plan.md) are built on it.

---

## Installation

```bash
npm install @braidlabs/sdui @braidlabs/contract @braidlabs/skew
```

---

## Why projection?

A native binary cannot be redeployed. The usual server-driven UI answers are `if (appVersion >= 5.8)` in the backend, a "minimum app version" field authors must remember, or clients that silently drop what they do not recognise.

Here, each device declares the version of every component it was built with, and the server migrates each node to that version through the component's contract — down for an older binary, up for a newer one:

- **What a downgrade loses is computed**, so the result is labelled, not passed off as exact.
- **Where a step cannot be inverted, nothing is guessed.** The node goes down a fallback ladder.
- **The cost is known before publishing**, because projection is a pure function an editor can run against every app version in the field.

---

## The three documents

**A catalog** is the app's UI vocabulary, owned by engineering: one contract per component, action and event.

```json
{
  "sduiCatalog": "1",
  "components": {
    "product-card": {
      "contract": {
        "skewContract": "1",
        "name": "sdui.component.product-card",
        "current": 3,
        "steps": [
          {
            "from": 1,
            "to": 2,
            "description": "price becomes an object that can carry a sale price",
            "ops": [{ "wrap": { "path": "price", "key": "amount", "also": { "sale": null } } }]
          },
          {
            "from": 2,
            "to": 3,
            "description": "an optional badge",
            "ops": [{ "default": { "path": "badge", "value": null } }]
          }
        ]
      },
      "criticalPaths": ["price"],
      "fallback": "omit"
    }
  }
}
```

- `criticalPaths` are fields a render must not lose. A downgrade that would discard one is not a degraded render, it is an unsupported one.
- `fallback` is what a device gets when it cannot render the component and the node authored nothing: `omit` (default), `placeholder`, `fail-screen`, or `{ "type": "text", "props": { "content": { "$from": "title" } } }` to build another component from this node's props.
- `slots.<name>.since` says which version introduced a slot; older clients do not get its children.

**A client manifest** is what one binary can render, generated when the app is built. A device sends only its fingerprint (`cm_…`) at handshake.

```json
{
  "sduiManifest": "1",
  "protocol": [1, 1],
  "app": "acme-shop",
  "platform": "ios",
  "version": "5.8.0",
  "components": { "product-card": 2, "text": 2, "stack": 1 },
  "actions": { "navigate": 1 }
}
```

**A screen** is what an editor authors. Every node says which version of its component it was written for.

```json
{
  "id": "screen-home",
  "slug": "home",
  "root": {
    "id": "n_card",
    "type": "product-card",
    "v": 3,
    "props": { "title": "Trail Runner 2", "price": { "amount": 129, "sale": 99 }, "badge": "New" },
    "actions": { "press": { "type": "navigate", "v": 2, "props": { "to": "product/trail-runner-2" } } },
    "visibility": { "all": [{ "flag": "summer-sale" }, { "platform": ["ios", "android"] }] },
    "fallback": { "id": "n_card_fallback", "type": "text", "v": 2, "props": { "content": "Trail Runner 2, now $99" } }
  }
}
```

Nothing in a screen is executable. Conditions are a closed set (`flag`, `platform`, `appVersion`, `audience`, `locale`, `schedule`, combined with `all` / `any` / `not`), not expressions.

`parseCatalog`, `parseClientManifest` and `parseScreen` validate untrusted input and throw a `TypeError` naming the first problem and where it is.

---

## Projecting a screen

```ts
import { parseCatalog, parseClientManifest, parseScreen, projectScreen, applyVisibility } from '@braidlabs/sdui';

const result = projectScreen(parseScreen(screen), parseCatalog(catalog), parseClientManifest(manifest));

result.outcome; // 'exact' | 'degraded' | 'fallback' | 'blocked'
result.root; // the tree at the device's versions, or null when blocked
result.report; // one entry per authored node: what happened to it, and why
```

For the card above on an app whose `product-card` is v2, the node is downgraded and the report says what was lost:

```json
{ "nodeId": "n_card", "outcome": "downgraded", "rung": 2, "authored": 3, "rendered": 2, "lossyPaths": ["badge"] }
```

On an app whose `product-card` is v1 the sale price cannot be carried, `price` is critical, and so the node is never rendered as a card with the wrong price. It takes its authored fallback:

```json
{
  "nodeId": "n_card",
  "outcome": "fallback-authored",
  "rung": 3,
  "reason": "\"product-card\" v1 cannot carry \"price.sale\", which must not be lost",
  "replacedBy": { "id": "n_card_fallback", "type": "text" }
}
```

A field is only reported lost when it held something: a badge still at its default is not a loss.

### The fallback ladder

| Rung | What the device gets                                                        | Node outcome               |
| :--- | :-------------------------------------------------------------------------- | :------------------------- |
| 1    | The node, exactly as authored                                               | `exact`                    |
| 2    | The node, migrated to the device's version                                  | `downgraded` or `upgraded` |
| 3    | The node's authored `fallback` (which may have its own)                     | `fallback-authored`        |
| 4    | The component's catalog `fallback`                                          | `fallback-catalog`         |
| 5    | Nothing. If the node is `required`, the screen is `blocked` for this device | `omitted`                  |

Rungs beyond this — an earlier release, the device's cache, the baseline bundled in the binary — belong to the delivery API and the client. A `blocked` result is how projection hands over to them.

Actions go through their own contracts. An action the device cannot run uses the action's `fallback`, and otherwise the control is disabled (`"disabled": true`) or, with `"unsupported": "hide"`, the node is removed. A control is never left looking live with nothing behind it.

### Options

| Option        | Purpose                                                                                                                                                                                                                |
| :------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported` | Component types to treat as absent on this device whatever its manifest says. An operator's kill switch for a native component that misbehaves in one build: it takes its fallbacks with no release and no app update. |
| `codeSteps`   | Implementations for a contract's named `code` steps. Without one, that step is a gap.                                                                                                                                  |
| `context`     | The migration clock, for `$now` values. Pin it to make a projection reproducible.                                                                                                                                      |

### Visibility

`projectScreen` is a pure function of immutable inputs, so its result can be cached per release and manifest. Conditions are left on the projected nodes and applied per request:

```ts
const { root, hidden } = applyVisibility(result.root, { flags, platform: 'ios', audiences: ['members'], now: new Date() });
```

This prunes nodes whose condition is false and strips every condition from what is sent, so rules and audiences never reach a device. A condition about something the context does not say is false.

---

## Handshake

```ts
import { resolveHandshake, decidePointer } from '@braidlabs/sdui';

const answer = resolveHandshake(request, {
  requiredVersion: '5.2.0',
  recommendedVersion: '6.1.0',
  knowsManifest: (fingerprint) => registered.has(fingerprint),
});
```

| Status                 | HTTP | When                                                                            |
| :--------------------- | :--- | :------------------------------------------------------------------------------ |
| `protocol-unsupported` | 426  | No wire-protocol version in common. Checked first: nothing else could be read.  |
| `maintenance`          | 503  | The global kill switch.                                                         |
| `unauthorized`         | 401  | The token was rejected.                                                         |
| `update-required`      | 200  | Below `requiredVersion`. A retired binary is told to update and served nothing. |
| `manifest-unknown`     | 409  | The fingerprint is not registered; the device resends its manifest in full.     |
| `update-recommended`   | 200  | Below `recommendedVersion`, or too much of the release renders degraded.        |
| `ok`                   | 200  |                                                                                 |

A handshake is the first thing an unauthenticated device sends. `parseHandshakeRequest` validates the body before it reaches `resolveHandshake`, and `parseClientManifest` validates a manifest sent in full.

### Rollback or stale replica?

Both hand a device an older release. `decidePointer` tells them apart with a sequence number that goes up every time an environment's pointer moves:

```ts
decidePointer({ release: 'rel_c', seq: 8 }, { release: 'rel_b', seq: 9, kind: 'rollback' });
// { action: 'adopt', changed: true, rolledBack: true }

decidePointer({ release: 'rel_c', seq: 8 }, { release: 'rel_b', seq: 7 });
// { action: 'ignore-stale', changed: false, rolledBack: false }
```

A device never accepts a lower `seq` than it has seen, and always accepts a higher one, whatever it points at.

---

## Flags and rollouts

```ts
import { assignRollout, evaluateFlags } from '@braidlabs/sdui';

assignRollout({ stable: 'rel_a', candidate: 'rel_b', stages: [1, 5, 25, 50, 100], stage: 2, salt: 'rollout-r40' }, install);
// { release: 'rel_b', arm: 'candidate', bucket: 1834 }

evaluateFlags([{ key: 'new-search', default: false, rules: [{ when: { appVersion: { min: '6.1' } }, percent: 5, value: true }] }], install, context);
// { values: { 'new-search': true }, assignments: ['new-search:0'] }
```

Each install hashes, with a salt, to a fixed bucket in 0–9999, and a percentage is the set of buckets below a line. Raising the percentage moves the line and never moves a device back across it. Flags are evaluated where this runs — on the server — so a device is sent values and assignment ids, never rules.

---

## States

`SESSION_STATES`, `SCREEN_STATES`, `NODE_STATES` and `ACTION_STATES` name every state a server-driven app can be in. Four pure resolvers turn facts into a state:

```ts
import { resolveScreenState } from '@braidlabs/sdui';

resolveScreenState({ fetch: 'failed', failure: 'network', cached: true });
// { state: 'loaded-stale', source: 'cache' }

resolveScreenState({ fetch: 'failed', failure: 'forbidden', cached: true });
// { state: 'forbidden', source: 'system-state' }
```

A transport failure shows the cached copy when there is one. A semantic failure never does: the server has said this content is not for this person now.

`source` says where the pixels come from (`server`, `cache`, `skeleton`, `authored-state`, `system-state`, `earlier-release`, `bundled`, `native`), so a state whose interface the server cannot supply is one the server is not needed for.

`tools/sdui/check-state-matrix.mjs` fails when a state is listed without a conformance vector.

---

## Diffing two versions of a screen

```ts
import { diffScreens } from '@braidlabs/sdui';

const { unchanged, changes, catalogUpgrades } = diffScreens(before, after, catalog);
```

- Nodes are matched by id, so a move is one `moved` change and not a removal and an addition.
- Both sides are migrated to the catalog's newest versions first, so a component that was only upgraded is listed under `catalogUpgrades` (with the fields it filled by default) and not as an edit.
- Equal content addresses (`screenId`) mean `unchanged`, without walking either tree.

Change kinds: `added`, `removed`, `moved`, `content` (with the changed paths), `type`, `actions`, `visibility`, `fallback`, `required`, `analytics`, and `screen` for the title, slug or an authored state.

---

## The `sdui` command

```bash
# In a pull request: fail if the catalog edits, reorders or removes anything already shipped.
sdui catalog check --published catalog.published.json --next catalog.json

# In the app's build: write the manifest for this binary.
sdui manifest gen --catalog catalog.json --app acme-shop --platform ios \
                  --app-version 5.8.0 --pin hero-banner=2 --out client-manifest.json

sdui manifest fingerprint --in client-manifest.json
sdui catalog id --in catalog.json
```

`catalog check` exits 1 and names each step:

```
sdui.component.product-card step v1 → v2 ("price becomes an object that can carry a sale price") was edited — published steps are frozen; append a correcting step instead
```

Content already in the field was authored under the published steps and is decoded by exactly those steps for as long as a binary that old is running. New shape is a new step, appended.

`checkCatalog`, `createClientManifest` and `runSdui` are the same things as functions.

---

## Conformance vectors

The package ships its specification as data in `conformance/`: projection results, state resolutions, handshake outcomes, the sequence rule, buckets, flags, conditions and diffs. A client in another language is correct when it gives the same answers. A device needs only the four state resolvers and `decidePointer`.
