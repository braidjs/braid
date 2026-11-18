# @braidlabs/sdui

Server-driven UI that survives app version skew. Every component, action and analytics event is a [`@braidlabs/contract`](./contract.md) document, so a screen is authored once and **projected** to exactly what each binary in the field was built to render.

This package is the core: the document model and its parsers, the projection engine and its fallback ladder, handshake resolution, flag and rollout evaluation, the state specification, and a contract-aware screen diff. It holds no state and does no I/O, and runs unchanged on Node, Workers, Deno, browsers and Hermes. The delivery API, the client and the CMS described in the [plan](../sdui-cms-plan.md) are built on it.

---

## Installation

```bash
npm install @braidlabs/sdui @braidlabs/contract @braidlabs/skew
```

---

## Why projection?

A native binary cannot be redeployed. The usual server-driven UI answers are `if (appVersion >= 5.8)` in the backend, a "minimum app version" field authors must remember, or clients that silently drop what they do not recognise.

Here, each device declares the version of every component it was built with, and the server migrates each node to that version through the component's contract — down for an older binary, up for a newer one:

- **What a downgrade loses is measured**, so the result is labelled, not passed off as exact.
- **Where a step cannot be inverted, nothing is guessed.** The node goes down a fallback ladder.
- **The cost is known before publishing**, because projection is a function an editor can run against every app version in the field.

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

- `criticalPaths` are fields a render must not lose, written as paths in the component's **newest** shape. A downgrade that would discard one is not a degraded render, it is an unsupported one.
- `fallback` is what a device gets when it cannot render the component and the node authored nothing: `omit` (default), `placeholder`, `fail-screen`, or `{ "type": "text", "props": { "content": { "$from": "title" } } }` to build another component from this node's props.
- `slots.<name>.since` says which version introduced a slot; older clients do not get its children.

**A client manifest** is what one binary can render, generated when the app is built. A device sends only its fingerprint (`cm_…`, from `manifestFingerprint`) at handshake.

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

---

## Parsing untrusted input

Every document that crosses a trust boundary has a parser that throws a `TypeError` naming the first problem and where it is. Everything downstream assumes its input was parsed.

| Parser                                                       | Input                                          | Notable checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| :----------------------------------------------------------- | :--------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parseScreen`                                                | A screen from an editor                        | Unknown keys; unique node ids; slot and action names; condition bodies; the reserved keys `__proto__`, `constructor`, `prototype` anywhere; prop keys containing `.`, `[` or `]`; values in props and flag values that are not JSON (a bigint, a function, `undefined`, a class instance, an array carrying anything besides its elements, a hole in a list); the size limits in `SCREEN_LIMITS` (5,000 nodes, 64 levels of nodes, 32 levels inside props, 128 characters in a prop key; and across all props and flag values together, 200,000 values (each condition counts as one more), 4 million characters of strings and keys, and 16 million characters of paths) |
| `parseCatalog`                                               | A catalog                                      | Contract names; **every step's ops are compiled**, so a catalog that parses can be migrated; fallbacks name real components; the reserved keys and values that are not JSON, anywhere in the document; the limits in `CATALOG_LIMITS` (64 levels, a million values and 8 million characters of document; 32 segments and 200 characters in any path it names — an op's path, a key an op adds, a `$from`, a critical path — counting every separator; 200 characters in any key anywhere in the document)                                                                                                                                                                 |
| `parseClientManifest`                                        | A manifest, possibly from a device             | Unknown keys (so one binary cannot be given unlimited fingerprints); entry counts; versions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `parseHandshakeRequest`                                      | The first body an unauthenticated device sends | Shape, lengths and unknown keys; `device` is a flat record of short scalars; a manifest sent in full is parsed and must describe the app the request claims to be                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `parseReleasePointer`                                        | A pointer a device received                    | `seq` is a non-negative integer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `parseCondition`, `parseRolloutPlan`, `parseFlagDefinitions` | Operator configuration                         | Closed condition kinds; ascending stages; a flag rule cannot read another flag                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

The parsers vouch for data: what `JSON.parse` returns. They check a value as it is when they read it, and return the object they were given, so an object that answers differently the next time it is read — a proxy, a getter — is outside what they can vouch for. Parse the text that crossed the boundary, not an object built elsewhere.

"Characters of paths" is the text of the path to every value, each written out as a report would name it: `items[2].badge` is 14. A key counts once in a document's size however many values sit under it, and once per value here — which is what bounds how large a report of what was lost or changed can be.

`validateScreen(screen, catalog)` answers a different question — does this screen fit this catalog? — and returns problems instead of throwing: an unknown component or action, a version newer than the catalog, an unknown slot, a slot's `accepts` or `max`. Projection is forgiving about these, which is right for a device and wrong for an author. Whether props match a version's JSON Schema is checked where screens are published.

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

On an app whose `product-card` is v1 (and which has the `text` component the fallback uses) the sale price cannot be carried, `price` is critical, and so the node is never rendered as a card with the wrong price. It takes its authored fallback:

```json
{
  "nodeId": "n_card",
  "outcome": "fallback-authored",
  "rung": 3,
  "reason": "\"product-card\" v1 cannot carry \"price.sale\", which must not be lost",
  "replacedBy": { "id": "n_card_fallback", "type": "text" }
}
```

### How loss is measured

`lossyPaths` is not read off the ops. The node is taken down to the device's version and straight back up, and what it held that does not come back is what was lost.

- A field the author left out is not a loss, and neither is a value the trip back up restores; a value that was there and did not come back is.
- Paths are in the component's **newest** shape, the one an author edits and `criticalPaths` are written in. For a node authored below the newest version, the node as authored and the node with what it lost put back as the round trip left it are both lifted to the newest version and compared. A field a later step renamed is found under its current name, and a later step that cannot be inverted is no obstacle, because lifting only goes up.
- That comparison is made once for all the losses together — which is what the device actually gets, and catches losses that only matter in combination — and then once for each loss on its own, to find a loss that leaves no trace in the newest shape: the newest version no longer has the field, a later step folds the lost value and its replacement into one, or the copy cannot be lifted.
- A loss that leaves no trace is still reported, under the name it had where the node was authored. On a component that has critical paths it is treated as critical, because it cannot be compared with them by name: the node is not rendered as itself. It goes down the ladder like any node that cannot be: to its authored fallback, then the catalog's, then omission — which, for a required node, blocks the screen for that device. The reason given says that the loss could not be traced, rather than naming a critical field.
- Tracing each loss on its own is one lift per loss, so it is rationed. A projection has a budget, `TRACE_BUDGET` (2,000,000), spent in document order; tracing a node's losses one by one costs _losses × (size + 32) × versions lifted_, where _size_ is what the node comes to at its newest version: its values, plus one for every 256 characters in its strings and keys. A node with a single loss needs no extra lift and costs nothing. A node with more, whose losses would cost more than is left, is not traced loss by loss: every one of its losses is reported under its authored name (as well as wherever the comparison of all of them together placed it), and if its component has critical paths the node is refused. Authored states are projected after the tree and draw on what is left. A hundred nodes each losing five of twenty fields spend under 30,000 of it. A list of several thousand elements, each losing a field, costs more than all of it — which is what keeps a screen at the size limits to seconds rather than minutes.

Migrating _up_ never reports a loss: what a newer version of a component no longer has is the catalog's decision. If the way back up cannot be run, the loss cannot be measured, and the node is treated as unsupported. So is a node whose steps give a payload past any of four limits: nested more than 64 levels deep (`MIGRATED_DEPTH_LIMIT`), more than 400,000 values (`MIGRATED_VALUE_LIMIT`), more than 8 million characters in its strings and keys (`MIGRATED_CHARACTER_LIMIT`), or more than 32 million characters of paths (`MIGRATED_PATH_LIMIT`) — each twice what a whole screen may hold. Size is measured as the payload would be written out: a value or a string that steps copy into several places counts once for each.

Those limits are per payload, and a screen has thousands of them. So the migrations of one `projectScreen` call, or one `diffScreens` call, also share an allowance (`MIGRATION_ALLOWANCE`: 8 million values, 64 million characters and 256 million characters of paths between them, drawn down in document order). A migration that finds it spent is not run and fails like a step that failed: in a projection its node goes down the ladder, and in a diff its props are compared as authored. It is there for a catalog whose steps multiply every payload. A projection migrates each node about four times, so a screen at its limits, under a catalog that does not grow its payloads, draws about a tenth of the values and a quarter of the characters and of the paths. The lifts that trace losses one at a time are not drawn from it; the tracing budget rations those. `migrate` on its own has no allowance unless it is passed one as `allowance`.

If the props as a whole do not come back — a `code` step gave back something that is not props — the loss is reported as `""` and is never traced: on a component with critical paths the node is refused.

### The fallback ladder

| Rung | What the device gets                                    | Node outcome               |
| :--- | :------------------------------------------------------ | :------------------------- |
| 1    | The node, exactly as authored                           | `exact`                    |
| 2    | The node, migrated to the device's version              | `downgraded` or `upgraded` |
| 3    | The node's authored `fallback` (which may have its own) | `fallback-authored`        |
| 4    | The component's catalog `fallback`                      | `fallback-catalog`         |
| 5    | Nothing                                                 | `omitted`                  |

Rungs beyond this — an earlier release, the device's cache, the baseline bundled in the binary — belong to the delivery API and the client. A `blocked` result is how projection hands over to them.

**`required` is a property of the node, not of the route to it.** A required node (or a `fail-screen` component) in the screen's tree must reach the screen as itself or as its own fallback. If it does not — because it could not be rendered, because it sat in a slot the device's version lacks, or because an ancestor was omitted or replaced by a fallback — the screen is `blocked` for that device and `blockedBy` names the node.

Inside a fallback, `required` is conditional on that fallback being the thing rendered. A fallback that is itself passed over asks nothing of the screen; one that is rendered must show what it requires. An authored state that loses something required is dropped, and the device uses the default for that state.

The catalog's `placeholder` is the protocol type `sdui.placeholder`, which every client renders. It carries nothing about the component it replaces.

**Actions** go through their own contracts. An action the device cannot run uses the action's `fallback`. Failing that the control is disabled (`"disabled": true`), or, with `"unsupported": "hide"`, the node is taken off the screen: its authored fallback is shown if it has one, and otherwise nothing is. A control is never left looking live with nothing behind it.

### Options

| Option        | Purpose                                                                                                                                                                                                                |
| :------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported` | Component types to treat as absent on this device whatever its manifest says. An operator's kill switch for a native component that misbehaves in one build: it takes its fallbacks with no release and no app update. |
| `codeSteps`   | Implementations for a contract's named `code` steps. Without one, that step is a gap.                                                                                                                                  |
| `context`     | The clock `$now` reads. One instant is taken from it for the whole projection.                                                                                                                                         |

`projectScreen` is deterministic for a given clock. The clock is read once per call, and what it returns reaches a result only through an op that uses `$now` or a `code` step that reads its context — so for a catalog with neither, a projection can be computed once per release and manifest and cached by their ids, together with the `unsupported` list and the `codeSteps` in use.

### Visibility

Conditions are left on the projected nodes and applied per request:

```ts
const visible = applyVisibility(result, { flags, platform: 'ios', audiences: ['members'], now: new Date() });

visible.root; // pruned, with every condition stripped
visible.states; // authored states, pruned and stripped the same way
visible.hidden; // [{ nodeId, by: 'flag' | 'visibility' }]
```

`applyVisibility` takes the whole projection, because authored states carry conditions too. **What it returns is the only form of a projection that is safe to send to a device**: rules, flag names and audience names never leave the server.

Conditions are three-valued and fail closed. A term about something the context does not say — no platform, a flag that does not exist, a version that is not a version — is _unknown_, unknown survives `not`, and only a condition known to hold shows a node. So `{ "not": { "platform": ["ios"] } }` is not true for a request that never said what it is on. `evaluateCondition` exposes the same evaluation.

---

## Handshake

```ts
import { parseHandshakeRequest, resolveHandshake, decidePointer } from '@braidlabs/sdui';

const answer = resolveHandshake(parseHandshakeRequest(body), {
  authorized: true,
  requiredVersion: '5.2.0',
  recommendedVersion: '6.1.0',
  knowsManifest: (fingerprint) => registered.has(fingerprint),
  registeredVersion: registered.get(fingerprint)?.version,
});
```

| Status                 | HTTP | When                                                                                                                                                                                  |
| :--------------------- | :--- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol-unsupported` | 426  | No wire-protocol version in common. Checked first: nothing else could be read.                                                                                                        |
| `maintenance`          | 503  | The global kill switch.                                                                                                                                                               |
| `unauthorized`         | 401  | `authorized` is anything but `true`.                                                                                                                                                  |
| `update-required`      | 200  | Below `requiredVersion`. A retired binary is told to update and served nothing.                                                                                                       |
| `manifest-unknown`     | 409  | The fingerprint is not registered; the device resends its manifest in full. A manifest sent in full that is not a manifest gets the same status with 400: there is nothing to resend. |
| `update-recommended`   | 200  | Below `recommendedVersion`, or too much of the release renders degraded.                                                                                                              |
| `ok`                   | 200  |                                                                                                                                                                                       |

Three things are deliberate:

- `authorized` is required and only `true` passes. A delivery API with no tokens says so by passing `true`.
- A device reports its own version. Pass `registeredVersion` — the version in the manifest your release job registered — and it is used instead. A version that cannot be read is below any floor.
- A manifest sent in full is validated by `resolveHandshake` itself, and served with `registered: false` in the answer when nobody registered it: its capabilities are the device's own word.

A policy whose own versions are malformed throws, rather than answering every device `ok`.

### Rollback or stale replica?

Both hand a device an older release. `decidePointer` tells them apart with a sequence number that goes up every time an environment's pointer moves:

```ts
decidePointer({ release: 'rel_c', seq: 8 }, { release: 'rel_b', seq: 9, kind: 'rollback' });
// { action: 'adopt', changed: true, rolledBack: true }

decidePointer({ release: 'rel_c', seq: 8 }, { release: 'rel_b', seq: 7 });
// { action: 'ignore-stale', changed: false, rolledBack: false }
```

A device never accepts a lower `seq` than it has seen, and always accepts a higher one, whatever it points at. An offer whose `seq` is missing, fractional or a string is never adopted.

---

## Flags and rollouts

```ts
import { assignRollout, evaluateFlags } from '@braidlabs/sdui';

assignRollout({ stable: 'rel_a', candidate: 'rel_b', stages: [1, 5, 25, 50, 100], stage: 2, salt: 'rollout-r40' }, install);
// { release: 'rel_b', arm: 'candidate', bucket: 1834 }

evaluateFlags([{ key: 'new-search', default: false, rules: [{ when: { appVersion: { min: '6.1' } }, percent: 5, value: true }] }], install, context);
// { values: { 'new-search': true }, assignments: ['new-search:0'] }
```

Each install hashes, with a salt, to a fixed bucket in 0–9999 (`bucketOf`), and a percentage is the set of buckets below a line. Raising the percentage moves the line and never moves a device back across it. Flags are evaluated where this runs — on the server — so a device is sent values and assignment ids, never rules.

- A request with no install id is inside a percentage only when that percentage is 100.
- A `stage` that is not one of the plan's stages is nobody, not everybody.
- **A percentage is not access control.** A device chooses its own install id and the hash is public. Gate what must be gated with an `audience` the server derives from a verified identity.

---

## States

`SESSION_STATES`, `SCREEN_STATES`, `NODE_STATES` and `ACTION_STATES` name every state a server-driven app can be in. Four resolvers turn facts into a state:

| Resolver                     | Returns                                          |
| :--------------------------- | :----------------------------------------------- |
| `resolveSessionState(facts)` | `{ state, source }`                              |
| `resolveScreenState(facts)`  | `{ state, source }`                              |
| `resolveNodeStates(facts)`   | every state that applies, most significant first |
| `resolveActionState(facts)`  | the state                                        |

```ts
resolveScreenState({ fetch: 'failed', failure: 'network', cached: true });
// { state: 'loaded-stale', source: 'cache' }

resolveScreenState({ fetch: 'failed', failure: 'forbidden', cached: true });
// { state: 'forbidden', source: 'system-state' }
```

A transport failure shows the cached copy when there is one. A semantic failure never does: the server has said this content is not for this person now. A failure the client does not recognise is treated as the server's error and never as a reason to show the cache.

`source` says where the pixels come from (`server`, `cache`, `skeleton`, `authored-state`, `system-state`, `earlier-release`, `bundled`, `native`), so a state whose interface the server cannot supply is one the server is not needed for.

`tools/sdui/check-state-matrix.mjs` fails when a state is listed without a conformance vector, or a vector names a state that is in no list. So that a state is not added somewhere the lists do not show, it also holds `states.ts` to a shape the compiler can check. Each list is an `export const` that is exactly `[…] as const` of string literals. Each of the four state types is declared once, as exactly its list. Each resolver is declared once, as returning exactly its state type. And the file holds none of the things that make the compiler take a type on trust: a cast in either spelling other than `as const`, the type `any`, a type predicate or assertion signature, a function signature with no body (an overload), a class, a `declare`, or a `@ts-` directive, read as the compiler reads it — lowercased first. With those in place the direct ways of adding one do not compile: `states.push('pulsing')` and `return 'pulsing'` are errors unless the string is in the list.

The check reads `states.ts` with the TypeScript parser, so a declaration in a comment or a string is not taken for one. It is a guard against mistakes, not a proof, and three things are outside it. It reads that one file, so a state invented in another is not seen. A value a library types as `any`, as `JSON.parse` does, passes for anything. And TypeScript itself is not sound: a list of states can be handed to code that takes a list of strings, and written to through that. The vectors set several facts at once where order matters, so the precedence between states is part of the specification.

---

## Diffing two versions of a screen

```ts
import { diffScreens } from '@braidlabs/sdui';

const { unchanged, changes, catalogUpgrades } = diffScreens(before, after, catalog);
```

- Nodes are matched by id, so a move is one `moved` change and not a removal and an addition. Among siblings, the fewest nodes that explain the new order are the ones reported, in `n log n` — a list of thousands costs no more per node than a list of ten.
- Both sides are migrated to the catalog's newest versions first, at one instant, so a component that was only upgraded is listed under `catalogUpgrades` (with the fields it filled by default) and not as an edit. That includes an upgrade inside an action, a fallback or an authored state.
- Equal content addresses (`screenId`) mean `unchanged` without walking either tree. Two documents that differ as bytes and not as screens — `props: {}` against no props — are also `unchanged`.

Change kinds: `added`, `removed`, `moved`, `content` (with the changed paths), `type`, `actions`, `visibility`, `fallback`, `required`, `analytics`, and `screen` for the id, title, slug or an authored state. A `type` change is reported together with whatever else changed on the node.

---

## The `sdui` command

```bash
# In a pull request: fail if the catalog rewrites anything already shipped.
sdui catalog check --published catalog.published.json --next catalog.json

# In the app's build: write the manifest for this binary.
sdui manifest gen --catalog catalog.json --app acme-shop --platform ios \
                  --app-version 5.8.0 --pin hero-banner=2 --out client-manifest.json

sdui manifest fingerprint --in client-manifest.json
sdui catalog id --in catalog.json
```

`catalog check` exits 1 and names each problem:

```
sdui.component.product-card step v1 → v2 ("price becomes an object that can carry a sale price") was edited — published steps are frozen; append a correcting step instead
```

Content already in the field was authored under the published steps and is decoded by exactly those steps for as long as a binary that old is running. So `checkCatalog` reports:

- a published step that was edited or moved, compared exactly rather than by a hash;
- a published version's schema that changed;
- a contract that disappeared, or a version number that went down;
- a slot that was removed or whose `since` changed;
- a critical path that was removed.

A component's `fallback`, `accepts`, `max` and editor metadata are policy and may change. A catalog whose ops cannot be compiled is a usage error (exit 2), not an addition.

`checkCatalog`, `createClientManifest`, `catalogId` and `runSdui` are the same things as functions. `migrate(contract, value, from, to, options)` is the single-payload migration projection is built on; its options are `codeSteps`, `context` and `allowance`.

---

## Also exported

|                                                                                                                                                                                                                                                                                                                                                |                                                                                                       |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| `contentAddress`, `sha256Hex`, `hash32`                                                                                                                                                                                                                                                                                                        | The content addressing behind `scr_`, `cat_` and `cm_` ids: a synchronous SHA-256 over canonical JSON |
| `changedPaths`                                                                                                                                                                                                                                                                                                                                 | Dot-paths at which two values differ                                                                  |
| `compareVersions`, `parseVersion`                                                                                                                                                                                                                                                                                                              | Dotted-number versions; `null` for anything that is not one                                           |
| `evaluateCondition`, `hiddenByFlagsAlone`, `flagsIn`                                                                                                                                                                                                                                                                                           | The condition language, outside `applyVisibility`                                                     |
| `bucketOf`, `inPercent`, `rolloutPercent`                                                                                                                                                                                                                                                                                                      | The pieces of `assignRollout`                                                                         |
| `contractName`                                                                                                                                                                                                                                                                                                                                 | `sdui.component.<type>`, the name a catalog entry's contract must carry                               |
| `SCREEN_LIMITS`, `CATALOG_LIMITS`, `MANIFEST_LIMITS`, `MIGRATED_DEPTH_LIMIT`, `MIGRATED_VALUE_LIMIT`, `MIGRATED_CHARACTER_LIMIT`, `MIGRATED_PATH_LIMIT`, `MIGRATION_ALLOWANCE`, `TRACE_BUDGET`, `BUCKETS`, `PLACEHOLDER_TYPE`, `SDUI_PROTOCOL_VERSION`, `HANDSHAKE_STATUSES`, `CLOCK_SKEW_LIMIT_MS`, the `*_ID_PREFIX` constants, `SDUI_USAGE` | Constants                                                                                             |

---

## Conformance vectors

The package ships its specification as data in `conformance/`: projection results, state resolutions, handshake outcomes, the sequence rule, buckets, flags, conditions and diffs. A client in another language is correct when it gives the same answers. A device needs only the four state resolvers and `decidePointer`.
