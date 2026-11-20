# @braidlabs/sdui

Server-driven UI that survives app version skew. Every component, action and analytics event is a [`@braidlabs/contract`](./contract.md) document, so a screen is authored once and **projected** to exactly what each binary in the field was built to render.

This package is the core: the document model and its parsers, the projection engine and its fallback ladder, handshake resolution, flag and rollout evaluation, the state specification, and a contract-aware screen diff. It holds no state and does no I/O, and runs unchanged on Node, Workers, Deno, browsers and Hermes. The delivery API, the client and the CMS described in the [plan](../sdui-cms-plan.md) are built on it. Two subpaths add [A2UI](#a2ui): `@braidlabs/sdui/a2ui`, the same model on A2UI's wire format, and `@braidlabs/sdui/web`, a renderer that draws it into the host's own page.

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

| Parser                                                       | Input                                          | Notable checks                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| :----------------------------------------------------------- | :--------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseScreen`                                                | A screen from an editor                        | Unknown keys; unique node ids; slot and action names; condition bodies; the reserved keys `__proto__`, `constructor`, `prototype` anywhere; prop keys containing `.`, `[` or `]`; values in props and flag values that are not JSON (a bigint, a function, `undefined`, a class instance, an array carrying anything besides its elements, a hole in a list); the size limits in `SCREEN_LIMITS` (5,000 nodes, 64 levels of nodes, 32 levels inside props) |
| `parseCatalog`                                               | A catalog                                      | Contract names; **every step's ops are compiled**, so a catalog that parses can be migrated; fallbacks name real components; the reserved keys and values that are not JSON, anywhere in the document; the limits in `CATALOG_LIMITS` (64 levels and a million values of document, 32 segments in a path an op names or reads with `$from`)                                                                                                                |
| `parseClientManifest`                                        | A manifest, possibly from a device             | Unknown keys (so one binary cannot be given unlimited fingerprints); entry counts; versions                                                                                                                                                                                                                                                                                                                                                                |
| `parseHandshakeRequest`                                      | The first body an unauthenticated device sends | Shape, lengths and unknown keys; `device` is a flat record of short scalars; a manifest sent in full is parsed and must describe the app the request claims to be                                                                                                                                                                                                                                                                                          |
| `parseReleasePointer`                                        | A pointer a device received                    | `seq` is a non-negative integer                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `parseCondition`, `parseRolloutPlan`, `parseFlagDefinitions` | Operator configuration                         | Closed condition kinds; ascending stages; a flag rule cannot read another flag                                                                                                                                                                                                                                                                                                                                                                             |

The parsers vouch for data: what `JSON.parse` returns. They check a value as it is when they read it, and return the object they were given, so an object that answers differently the next time it is read — a proxy, a getter — is outside what they can vouch for. Parse the text that crossed the boundary, not an object built elsewhere.

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
- Tracing each loss on its own is one lift per loss, so it is rationed. A projection has a budget, `TRACE_BUDGET` (2,000,000), spent in document order; tracing a node's losses one by one costs _losses × (values in its props + 32) × versions lifted_. A node whose losses would cost more than is left is not traced loss by loss: every one of its losses is reported under its authored name (as well as wherever the comparison of all of them together placed it), and if its component has critical paths the node is refused. Authored states are projected after the tree and draw on what is left. A hundred nodes each losing five of twenty fields spend under 30,000 of it. A list of several thousand elements, each losing a field, costs more than all of it — which is what keeps a screen at the size limits to seconds rather than minutes.

Migrating _up_ never reports a loss: what a newer version of a component no longer has is the catalog's decision. If the way back up cannot be run, the loss cannot be measured, and the node is treated as unsupported. So is a node whose steps give a payload nested more than 64 levels deep (`MIGRATED_DEPTH_LIMIT`) or holding more than 400,000 values once written out (`MIGRATED_VALUE_LIMIT`, twice what a whole screen may hold): whatever a catalog's steps do with props, a result like that is not a payload. A value that steps copy into itself counts once for every place it appears, which is how it would be sent.

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

`projectScreen` is deterministic for a given clock. The clock is read once per call, and what it returns reaches a result only through an op that uses `$now` or a `code` step that reads its context — so for a catalog with neither, a projection can be computed once per release and manifest and cached by their ids, together with the `unsupported` list if one is used.

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

`tools/sdui/check-state-matrix.mjs` fails when a state is listed without a conformance vector, when one of the four state types is declared as anything but exactly its list, when a list is followed by anything but `as const;`, when `states.ts` holds a cast (any `as` other than `as const`, or an angle-bracket assertion to a state type, `unknown`, `any` or `never`), and when a resolver is not declared as returning exactly its state type. With those in place, pushing or returning a string that is in no list is a compile error. The check reads `states.ts` alone, with comments and the text of strings set aside, and refuses a template literal that holds an expression, since it cannot read inside one. It is a guard against mistakes, not a proof. A state invented in another file is outside its view, and so is anything that gets a value past the compiler without a cast: `any`, `@ts-ignore`, `JSON.parse`, a type predicate, an assertion function. The vectors set several facts at once where order matters, so the precedence between states is part of the specification.

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

`checkCatalog`, `createClientManifest`, `catalogId` and `runSdui` are the same things as functions. `migrate(contract, value, from, to)` is the single-payload migration projection is built on.

---

## A2UI

[A2UI](https://a2ui.org/specification/v1.0-a2ui/) is how agents describe UI to renderers: surfaces of components from a catalog, a data model they bind to, and actions back. `@braidlabs/sdui/a2ui` speaks v1.0 and joins it to everything above — an A2UI surface is a screen, and a renderer's catalog is a client manifest — so the projection that keeps native binaries safe from version skew keeps A2UI renderers safe too. `@braidlabs/sdui/web` is a renderer that draws A2UI into the host's own page.

A2UI on its own identifies a catalog by an id and nothing else. A renderer built last spring and one built today look the same if they name the same catalog, and an agent writing for one breaks the other. Here:

- **The agent authors against the catalog's own id** (`catalog.a2ui.catalogId`): the newest version of every component.
- **Each renderer names a catalog id derived from what it can draw** — `…/catalog.json?caps=cv_9f2c…`, from `a2uiCatalogId(catalog, manifest)`. Builds that draw alike share an id.
- **Between them, `createA2uiProjector`** projects each surface to that renderer: downgraded where the steps allow, down the fallback ladder where they do not, never with a guessed value. An update reaches the renderer as just the components whose projection changed. A surface a renderer cannot show honestly is not sent; the agent receives an `INCOMPATIBLE` error and can choose something else.

```ts
import { createA2uiProjector, resolveRendererCapabilities } from '@braidlabs/sdui/a2ui';

// `a2uiRendererCapabilities` from the transport: which renderer is this?
const renderer = resolveRendererCapabilities(capabilities, { catalogs: [catalog], manifests });
if (renderer.status !== 'ok') return refuse(renderer.status); // manifest-unknown, protocol-unsupported

const projector = createA2uiProjector({ catalog, manifest: renderer.manifest, catalogId: renderer.catalogId });
for await (const message of agent) {
  const { toRenderer, toAgent } = projector.push(message);
  toRenderer.forEach(sendToRenderer);
  toAgent.forEach(sendToAgent); // INCOMPATIBLE, or a function the renderer lacks
}
```

### The model, in A2UI terms

| A2UI                                      | SDUI model                                                                                                                                                   |
| :---------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a surface's components, a flat list by id | a screen's tree; `surfaceToScreen` and `treeToComponents` convert; every upstream example round-trips, its unreferenced components reported rather than kept |
| `children: ["a", "b"]`, `child: "a"`      | slots; `max: 1` is a single child. `Tabs.tabs[].child` is a slot with `a2ui: { list, key }`                                                                  |
| `children: { path, componentId }`         | a slot whose one node has `repeat: "<path>"`                                                                                                                 |
| a referenced id not yet sent              | an `sdui.placeholder` node, written back as the same dangling reference                                                                                      |
| one component under two parents           | a copy with `copyOf`, written back as a reference                                                                                                            |
| `@accessibility`, `@checks`, `@metadata`  | `annotations`, carried through projection untouched                                                                                                          |
| `action: { event }` / `{ functionCall }`  | the `a2ui.event` / `a2ui.call` actions; an SDUI catalog's own actions are written as events of their name                                                    |
| `{ "@path" }`, `{ "@call" }` in props     | bound values. A step may move, wrap or drop one; a step that converts, maps or reaches into one is a `gap`                                                   |
| catalog functions                         | `catalog.functions`; `manifest.functions` lists what a renderer implements, and a node calling one it lacks goes down the ladder                             |
| the data model                            | `screen.data`                                                                                                                                                |

`parseA2uiMessage` and `parseA2uiStream` refuse what the v1.0 schemas refuse — and reserved keys, unknown `@` directives, `theme` (removed in v1.0), values past the size limits — with the spec's error codes and a JSON Pointer. `A2uiSurfaces` applies messages by the spec's state rules. `a2uiBasicCatalog` and `a2uiBasicManifest` are the basic catalog as a catalog and as a renderer.

### Prerendering

Projection is a pure function of immutable inputs, and a release serves a finite set of manifests, so every variant can be computed when a screen is published:

```bash
sdui a2ui prerender --catalog catalog.json --screen screens/trip.json \
  --manifest manifests/web-3.0.json --manifest manifests/web-1.9.json \
  --context summer-sale=contexts/summer-sale.json --out prerendered/
```

Each variant is written as the A2UI stream that renderer receives (`.jsonl`) and as the HTML a browser shows before any script runs (`.html`), content-addressed, with `index.json` mapping each catalog id to its variant. `selectPrerendered(index, slug, supportedCatalogIds)` picks one per request. `prerenderA2ui` is the same as a function, and takes a renderer's registry so host components prerender too.

### The renderer: `@braidlabs/sdui/web`

```ts
import { defineA2uiSurface, h } from '@braidlabs/sdui/web';

defineA2uiSurface({
  registry: {
    Card: { element: 'acme-panel' }, // the host's own custom element
    FlightCard: { fragment: { name: 'flight-card', entry: 'https://flights.example/card.js' }, events: { select: 'select' } }, // another team's Braid fragment
    Fare: (c) => h('div', { class: 'fare' }, c.text('label')), // a view, drawn the same on a server
  },
});
```

```html
<a2ui-surface src="/agent/stream" action-url="/agent/actions" catalog-ids="https://acme.example/a2ui/catalog.json?caps=cv_9f2c…"></a2ui-surface>
```

- **Light DOM.** Components are semantic HTML with classes (`a2ui-Button`) and data attributes (`data-variant="primary"`) and no styles of their own: the host's stylesheet is what they look like. `A2UI_DEFAULT_CSS` is a starting point at zero specificity.
- **Braided components.** A component type can be the host's own custom element (props as its `a2ui` property and scalar attributes; children slotted by prop name) or a Braid fragment in contract mode (props as its `props`; a `braid:event` becomes the A2UI action named in `events`, with its detail in the context).
- **Patching, not replacing.** An agent's update never replaces an input under the cursor: focus, caret and selection survive. Prerendered HTML (from `renderA2uiHtml`, or the prerender command) carries `data-a2ui-key`s and the messages that built it, and is adopted in place.
- **Closed and checked.** Bindings, `@checks` and the basic catalog's functions are evaluated by a closed interpreter; a `formatString` template is interpolated only where it was written as one, never from data. Regular expressions are parsed in the A2UI dialect, refused when the spec's rules say they could backtrack or when they would compile to more than 20,000 instructions (nested lookaheads and counted repeats included), and matched by a linear-time NFA. Markdown is the spec's subset — no HTML, images or links; a link is its words.
- **URLs pass a policy** (`urlPolicy`). `javascript:` and `data:text` URLs are never written, and a URL padded with whitespace the URL parser keeps is refused. Links (which need a click) may go to any http(s) host unless `hosts` narrows them. **Media load by themselves**, so a URL built from bound data would send what someone types to whoever it names: absolute media URLs are refused unless their host is in `mediaHosts`.
- **A draw has a budget.** `DRAW_LIMITS` charges each draw for function calls, text (labels, titles, values, check messages, paragraphs — priced by what laying it out costs a browser, `layoutCost`: 1 a character of Latin, Greek or Cyrillic; 8 for the scripts measured to cost a few times that (Hebrew, Arabic, Devanagari, Chinese, Japanese, Korean, emoji, combining marks) and for symbols, each block of which counts as a script of its own, since a browser draws them from fonts of their own; 50 for a script broken into lines by dictionary, and for every script not measured; and 1,000 for each change of script or direction, and for each control character, emoji presentation selector and invisible break (a soft hyphen, a zero-width space, a line separator), since a browser shapes each run, and may pick a font for it, on its own — so 20,000 characters alternating Latin and Hebrew cost what 20 million plain ones do. A draw's text is at most 500,000 of these: layout depends on where text is as well as what, and a flex row measuring every line break of 2,000,000 plain characters of short words took over half a second. An element that sees a draw's layout run long anyway draws less text next time, and lets the limit back slowly), Braid fragments (32 a draw; each is a realm of its own), components and repeated parts drawn (template items, tabs, options), regex steps, and work: every value read — bound or literal, a scalar too — costs what it holds, one unit per value and one per 16 characters of its strings and keys, every time it is read. So whatever a draw does with a value afterwards (walk it, stringify it, hand it to a host element) is paid for before it is done, and a function over a large binding costs as much as the binding is large. Each check, each prop handed to a host element, each date-format letter and each pattern compiled is charged too. The budget is shared by every surface on an element and every renderer function call between draws; in a browser a draw also ends after `DRAW_LIMITS.ms` (100 ms), whatever its units say. Past a limit the rest of the draw is a placeholder and the agent is told. A host element is never handed a prop larger than 16,000 characters; a surface that fails to draw is reported (`RENDER_ERROR`) without taking its neighbours with it. Components an agent draws carry opaque ids and names, sit outside any host form (`form="a2ui-detached"`), and a host element is given attributes only for the scalar props its catalog schema declares.
- **What is measured not to freeze or fill the page.** One message carries at most 50,000 values (`A2UI_LIMITS`), which bounds the longest a page spends applying one, and a draw puts at most 5,000 components, repeated parts and markup elements in the page. Messages — from a stream, an action's answer or `push()` — are applied a few milliseconds at a time (a `push()` of one JSON array as text is parsed in one go first; no line may be longer than one message) with the page let run in between, and drawn in a task of their own, at most once per batch, with as long between draws as the last one took — so `push()` returns before the page shows what it pushed: wait for the element's `a2ui:render` event, not a microtask. (Prerendered markup is still adopted synchronously, when the element connects.) An update costs what it changes: the data model is written in place, not copied. What a renderer holds is counted in characters as well as values — `DATA_MODEL_LIMITS` (200,000 values and 2,000,000 characters a surface), `SURFACES_LIMITS` (64 surfaces, 2,000,000 characters of components each, 8,000,000 characters in all) — and an update past them is refused. Renderer functions an agent calls are limited too, `CALL_LIMITS` (20 at once, then five a second), since each answer is a request to the agent and its reply may ask for more. The agent hears a bounded amount, `ERROR_LIMITS`: a burst of 20 errors then two a second, each cut to 1,000 characters, and a stream that has had 100 messages refused is hung up on. `e2e/a2ui-exhaustion.e2e.ts` runs, in Chromium, every stream six rounds of review used to freeze or crash the renderer, and text of each kind the budget prices at the most the budget allows, and holds each to under 300 ms of main-thread time at once. That is evidence, not proof: the renderer runs on the page's thread, layout is the browser's, and pricing it is measurement, so a kind of content nobody has measured may still cost more than it is charged. For agents you do not trust at all, put `<a2ui-surface>` in a frame of its own origin, where a browser that isolates sites gives it a thread of its own.
- **Not a confidentiality boundary.** `sendDataModel` says whether the data model rides along with messages to the agent; an agent can read any value anyway, by binding it into an action's context. Keep secrets out of a surface's data model.
- **Messages out** are dispatched as a cancelable `a2ui:message` event and POSTed to `action-url` as `{ message, metadata }`, with `a2uiRendererCapabilities` and, for an action on a surface created with `sendDataModel`, `a2uiRendererDataModel`. Errors and renderer functions' answers carry no data model: they happen when the agent says, and writing a large model out for each would be work the agent could ask for without end. A response of more messages is applied.

`examples/concierge` puts it together: a CMS-authored screen prerendered per renderer, an agent's surface through the projector, `Card` drawn by the host's element and `FlightCard` by a Braid fragment.

---

## Also exported

|                                                                                                                                                                                                                                                                      |                                                                                                       |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| `contentAddress`, `sha256Hex`, `hash32`                                                                                                                                                                                                                              | The content addressing behind `scr_`, `cat_` and `cm_` ids: a synchronous SHA-256 over canonical JSON |
| `changedPaths`                                                                                                                                                                                                                                                       | Dot-paths at which two values differ                                                                  |
| `compareVersions`, `parseVersion`                                                                                                                                                                                                                                    | Dotted-number versions; `null` for anything that is not one                                           |
| `evaluateCondition`, `hiddenByFlagsAlone`, `flagsIn`                                                                                                                                                                                                                 | The condition language, outside `applyVisibility`                                                     |
| `bucketOf`, `inPercent`, `rolloutPercent`                                                                                                                                                                                                                            | The pieces of `assignRollout`                                                                         |
| `contractName`                                                                                                                                                                                                                                                       | `sdui.component.<type>`, the name a catalog entry's contract must carry                               |
| `SCREEN_LIMITS`, `CATALOG_LIMITS`, `MANIFEST_LIMITS`, `MIGRATED_DEPTH_LIMIT`, `MIGRATED_VALUE_LIMIT`, `TRACE_BUDGET`, `BUCKETS`, `PLACEHOLDER_TYPE`, `SDUI_PROTOCOL_VERSION`, `HANDSHAKE_STATUSES`, `CLOCK_SKEW_LIMIT_MS`, the `*_ID_PREFIX` constants, `SDUI_USAGE` | Constants                                                                                             |

---

## Conformance vectors

The package ships its specification as data in `conformance/`: projection results, state resolutions, handshake outcomes, the sequence rule, buckets, flags, conditions and diffs. A client in another language is correct when it gives the same answers. A device needs only the four state resolvers and `decidePointer`.
