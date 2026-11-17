# A CMS for server-driven native UI, on Braid contracts — plan

Status: approved — P1 built, P2–P7 to do · Packages: `@braidlabs/sdui` (new), `@braidlabs/cms` (new) · Builds on: `@braidlabs/skew`,
`@braidlabs/contract`, `@braidlabs/build`, `@braidlabs/studio` · Borrows patterns from: `@braidlabs/registry`,
`@braidlabs/console`, `@braidlabs/data`

Design boards for the editor (private until its owner shares it): <https://claude.ai/artifact/VMfSjLxUXzb42svH5EDubW>

## Problem

Server-driven UI lets a team change a native app's screens without shipping a binary. Its
fundamental problem is the one this repository exists to solve: **two independently versioned
parties meet at a boundary with no way to discover they disagree.**

- The server has one idea of what a `hero-banner` is. The field has every idea the app has ever
  shipped: this week's build, the one from March that 12% of people never updated, a TestFlight
  build from tomorrow.
- A binary cannot be redeployed. A web client that is too old reloads; a phone that is too old stays
  too old until its owner decides otherwise.
- Every SDUI system therefore grows the same scar tissue: `if (appVersion >= 5.8)` branches in the
  backend, "minimum app version" fields authors must remember to set, clients that silently drop
  nodes they do not recognise, and a compatibility matrix that lives in someone's head.

The usual remedies treat compatibility as something authors and backend engineers manage by hand.
Braid already has a mechanism that makes it mechanical.

## The idea

**Every component, action and event in the UI vocabulary is a `@braidlabs/contract` document.** Its
props have numbered versions; the steps between versions are data from the closed op whitelist
(`rename`, `move`, `wrap`, `hoist`, `map`, `default`, `drop`, `convert`, `const`); each op knows its
inverse, and the fields a downgrade guesses (`derivedPaths`) or discards (`lossyPaths`) are computed
rather than annotated (`libs/skew/src/lib/lens.ts`, `libs/contract/src/lib/schema-from-contract.ts`).

That gives four things no hand-rolled SDUI stack has:

1. **Authors write once, at the newest version.** There is no per-app-version content.
2. **Each device says what it was built with**, and the server _projects_ every node down (or up) to
   exactly that, through the same steps `versionedFromContract(doc, { at })` already runs. The
   server is always at least as new as the content it serves, which is the property that makes
   `ahead` curable (`libs/contract/src/lib/resolver.ts`).
3. **The cost of a downgrade is known before publishing.** `lossyPaths` tells the editor "the badge
   on this card is dropped for the 12% of devices on 5.8" while the author is still looking at the
   card. Compatibility stops being a production surprise and becomes a number in the toolbar.
4. **Where a step cannot be inverted, the answer is `gap`, never a guess** — and `gap` has a designed
   response: the fallback ladder below.

## Principles

1. **Content is data, never code.** No scripts, no expression language, no HTML, no freeform CSS.
   Conditions, validators and formatters are closed whitelists, as contract ops are. This is the
   trust model of `@braidlabs/contract` extended to UI, and it is also what keeps a server-driven
   app inside both app stores' rules on downloaded code.
2. **Immutable, content-addressed artifacts; pointers move.** A release is `rel_<hash>`, a catalog is
   `cat_<hash>`, a client manifest is `cm_<hash>`. Promotion, rollout and rollback are pointer moves
   over byte-identical artifacts — the registry's design (`libs/braid-registry/src/lib/snapshot.ts`),
   reused, not reinvented.
3. **Projection on the server.** A native client needs a JSON decoder and a renderer — no lens
   interpreter in Swift or Kotlin. One implementation of the migration semantics, in TypeScript.
4. **Every state has a designed answer and a name.** The state lists in this document are `as const`
   unions in code; the reference client, the editor's state switcher and the conformance vectors are
   all exhaustiveness-checked against them. "Leave no state unturned" is a compile error, not a
   review comment.
5. **Honest degradation, labelled.** A degraded render is reported as degraded — in the response, in
   telemetry, in the editor — never passed off as exact. Same stance as `downgradedFrom`.
6. **Never go backwards by accident.** A stale replica and a deliberate rollback both hand a device
   an older release. They must be distinguishable; see "Sequence numbers".
7. **Braid does not own your identity provider or your analytics warehouse.** OIDC in, pluggable
   sinks out, as `createOidcAuthorizer` and the OTel plan already do.
8. **The server is the enforcement point.** The CMS hides what a role cannot do as a courtesy; every
   request is verified.

## Architecture

```
  engineering (CI)                editors (CMS)                         devices
  ────────────────                ─────────────                         ───────
  component contracts             drafts ── publish ──► release         app binary embeds
  action contracts                (server state)        rel_…           client manifest cm_…
        │                                                 │                   │
        ▼                                                 ▼                   │ handshake
  catalog cat_… ──► environments: dev ─► test ─► prod (refs + rollout plans)  │
        │                                   │                                 ▼
        │                                   └────► delivery API ── project(release, catalog, manifest)
        │                                              │   ▲                  │
        └──► /.well-known/skew/contracts/:name         │   └─ flags, audience, kill switches
                                                       ▼
                                   events ◄── census, projection outcomes, product analytics
```

| Package                          | What it is                                                                                                                                                                                                                                                                                                            | Depends on                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `@braidlabs/sdui`                | Platform-neutral core: document model, catalog, client manifest, projection engine, fallback ladder, flag and rollout evaluation, handshake resolution, state unions, conformance vectors. Pure functions. Runs on Node, Workers, Deno, Hermes, browsers.                                                             | `skew`, `contract`                                    |
| `@braidlabs/sdui/server`         | Fetch-native delivery API and admin API (`createSduiApi`), stores, environments, audit, authorizers. Same shape as `createRegistryApi`.                                                                                                                                                                               | core; optional peer `jose`                            |
| `@braidlabs/sdui/client`         | Headless reference client: handshake, release pin, fetch, cache, fallback, event outbox. No UI. Usable from React Native as-is.                                                                                                                                                                                       | core                                                  |
| `@braidlabs/cms`                 | The CMS: WYSIWYG editor, web and emulator preview, history and compare, releases board, flags, clients, catalog browser, insights, audit. Mountable React components or a standalone app with OIDC sign-in — the console's structure (`libs/braid-console`). Includes a web preview renderer for the starter catalog. | `sdui`, `studio`, `react`; app only: `oidc-client-ts` |
| `sdui` bin, in `@braidlabs/sdui` | `sdui catalog check\|id`, `sdui manifest gen\|fingerprint` (P1); `catalog publish`, `manifest register` and `bundle` arrive with the server in P2. Lives here, not in `@braidlabs/build`, which stays dependency-free.                                                                                                | —                                                     |

Subpath exports with optional peers are this repo's existing convention (`@braidlabs/registry/oidc`),
and keep the count at two new packages.

## The model

### Catalog — the UI vocabulary, owned by engineering

```jsonc
{
  "sduiCatalog": "1",
  "components": {
    "product-card": {
      "contract": {
        "skewContract": "1",
        "name": "sdui.component.product-card",
        "current": 3,
        "steps": [
          /* … */
        ],
        "schemas": {
          /* … */
        },
      },
      "slots": { "footer": { "accepts": ["button", "badge"], "max": 2 } },
      "fallback": "omit", // omit | placeholder | { "type": "text", "from": "title" } | "fail-screen"
      "criticalPaths": ["price", "legalNote"], // losing one of these is not a degraded render, it is an unsupported one
      "localizable": ["title", "badge.text"],
      "skeleton": { "shape": "card", "lines": 2 },
      "editor": { "label": "Product card", "group": "Commerce", "icon": "card" },
    },
  },
  "actions": {
    "navigate": {
      "contract": {
        /* … */
      },
    },
    "open-url": {
      /* … */
    },
    "submit": {
      /* … */
    },
  },
  "events": {
    "impression": {
      "contract": {
        /* … */
      },
    },
    "action": {
      /* … */
    },
  },
  "tokens": {
    "contract": {
      /* design tokens: color, spacing, type roles */
    },
  },
}
```

- Each component's JSON Schemas (already a field of `SkewContractDocument`) drive the editor's
  property inspector. The contract is the single source for the form, the migration and the
  generated native types.
- **Append-only, enforced.** `sdui catalog check` compares against the published catalog and fails
  if an existing step's fingerprint changed or steps were reordered (rule 2 of `using-skew`). A
  wrong step gets a correcting step.
- `code` steps are allowed but flagged: a `code` step is not invertible on the server unless the
  server ships the implementation, so it shows in the catalog browser as "breaks older clients".

### Client manifest — what one binary can render

Generated at app build time by `sdui manifest gen` from the component versions the app actually
implements, alongside frozen types from `skew-contract gen`:

```jsonc
{ "sduiManifest": "1", "protocol": [1, 1], "app": "acme-shop", "platform": "ios", "version": "5.8.0", "build": 5800412, "components": { "product-card": 2, "hero-banner": 1, "stack": 1, "text": 2 }, "actions": { "navigate": 1, "open-url": 1 }, "assets": ["jpeg", "png", "webp"], "limits": { "depth": 12, "bytes": 262144 } }
```

Its fingerprint (`cm_<fnv/sha of canonicalJson>`, the same canonicalisation as `contractFingerprint`)
is what the device sends. The app's release job registers the full manifest with
`sdui manifest register`, so a production handshake carries one short string and the server already
knows the population it has to serve.

### Screen document — what editors author

```jsonc
{
  "id": "scr_home",
  "slug": "home",
  "title": "Home",
  "root": {
    "id": "n_01",
    "type": "stack",
    "v": 1,
    "props": { "gap": "md" },
    "slots": {
      "children": [
        {
          "id": "n_02",
          "type": "hero-banner",
          "v": 2,
          "props": {
            /* … */
          },
          "actions": { "press": { "type": "navigate", "v": 1, "props": { "to": "sale" } } },
          "visibility": { "all": [{ "flag": "summer-sale" }, { "platform": ["ios", "android"] }] },
          "fallback": { "id": "n_02f", "type": "text", "v": 1, "props": { "text": "Summer sale — up to 40% off" } },
          "required": false,
          "analytics": { "name": "home_hero" },
        },
      ],
    },
  },
  "states": {
    "loading": "auto",
    "empty": {
      /* node */
    },
    "error": "system",
    "offline": "system",
  },
}
```

- Every node is a skew envelope in disguise: `{ type, v, props }` is `{ name, v, payload }`. Node
  ids are stable across edits — they key analytics, diffs and the editor's selection.
- `visibility` is a closed condition set: `flag`, `platform`, `appVersion` range, `audience`
  segment, `locale`, `schedule` window, combined with `all` / `any` / `not`. No expressions.
- Rich text is a restricted tree (paragraph, strong, emphasis, link, list), itself a contract. Not
  HTML: native cannot render it, and the CMS never has to sanitise it.
- Styling is by design token only (`"gap": "md"`, `"tone": "accent"`), so iOS and Android resolve
  the same intent natively and a theme change is one token-set edit.
- Data binding v1 is deliberately narrow: a node may bind a prop to `source.path` from a named data
  source declared by the app, whose response is itself a versioned contract. Path lookup plus a
  closed formatter list (`currency`, `date`, `number`, `plural`).

### Release — what gets promoted

`rel_<sha256 of canonical content>`: screens, navigation and route table, strings per locale, token
sets, system-state screens, the catalog id it was authored against, and the _names_ of the flags it
references. Reusable blocks are resolved into the release at publish, so a release is
self-contained. Assets are referenced by content address. `createdAt` and labels sit outside the
hash, exactly as in `RegistrySnapshot`.

Drafts are **server state** (unlike the console's browser-only registry drafts,
`libs/braid-console/src/lib/draft.ts`): several editors work on the same content, and previewing on
a real phone needs the server to serve the draft. Drafts are stored through
`createVersionedStore`, so the CMS's own persisted documents survive the CMS's own deploys.

## Projection and the fallback ladder

`project(release, catalog, manifest, context) → { tree, report }`, per node, depth first:

| Case                                                             | Outcome                                            | What happens                                           |
| ---------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| client version = authored version                                | `exact`                                            | pass through                                           |
| client older, steps invertible, no critical path lost            | `downgraded`                                       | run down-steps; record `lossyPaths` and `derivedPaths` |
| client newer than authored                                       | `upgraded`                                         | run up-steps; record `derivedPaths`                    |
| client older, a critical path would be lost                      | `unsupported`                                      | go down the ladder                                     |
| step not invertible / `code` step missing (`gap`)                | `unsupported`                                      | go down the ladder                                     |
| client lacks the component, or an operator kill switch covers it | `unsupported`                                      | go down the ladder                                     |
| action not supported                                             | per action: `hide` \| `disable` \| fallback action | control stays honest: never a dead button              |
| projected props fail the client version's JSON Schema (P2)       | `unsupported`                                      | defence in depth; reported as a server bug             |

**The ladder** — each rung is tried only when the one above cannot be honest. Each rung emits
telemetry naming itself, so "how far down are people falling" is a chart.

1. Exact render.
2. Projected render (down or up), labelled.
3. The node's authored fallback (projected in turn).
4. The component's catalog fallback (`placeholder`, a derived `text`, …).
5. Omit the node — unless it is `required`.
6. Screen level: the newest earlier release in this environment that this manifest renders without
   an unsupported required node (the server keeps this pointer per manifest).
7. The device's last-known-good cached screen.
8. The **bundled baseline**: `sdui bundle` projects production to the app's own manifest at build
   time and ships it in the binary. First launch offline has something real to show.
9. Native, hard-coded: system error, "update the app", or the pre-SDUI screen if one exists.

The projection report (`{ nodeId, outcome, rung, lossyPaths, derivedPaths }[]`) is used four times:
by the editor's compatibility view, by the publish gate, by delivery telemetry, and — in dev builds —
as a debug overlay on the device.

Projection is a pure function of immutable inputs, and the set of registered manifests is finite, so
the projected template is computed once per `(release, manifest)` and cached. Per-request work is
pruning by visibility and resolving strings.

## Handshake

`POST /sdui/v1/handshake`, at cold start, on foreground after the TTL, after sign-in or sign-out, and
after an app update.

```jsonc
// request
{ "protocol": [1, 1], "manifest": "cm_9f2c…",
  "app": { "id": "acme-shop", "platform": "ios", "version": "5.8.0", "build": 5800412 },
  "device": { "os": "17.4", "locale": "fr-CA", "tz": "America/Toronto", "class": "phone",
              "fontScale": 1.3, "reduceMotion": true, "dataSaver": false },
  "install": "ins_…",                    // pseudonymous, resettable
  "known": { "release": "rel_ab12…", "seq": 418 } }

// response
{ "protocol": 1, "status": "ok",        // see outcomes
  "environment": "prod", "release": "rel_cd34…", "seq": 421, "apply": "next-navigation",
  "flags": { "summer-sale": true, "checkout-layout": "b" }, "assignments": ["exp_41:b"],
  "routes": { "home": { "etag": "…", "skeleton": {/* tiny tree */} }, "sale": {/* … */} },
  "update": { "recommended": "6.1.0", "required": "5.2.0", "url": "…" },
  "contracts": "/.well-known/skew/contracts/", "token": "<delivery token, 30 min>",
  "revalidateAfter": 300, "serverTime": "2026-11-17T10:04:11Z" }
```

| Outcome                    | When                                                                                     | Device does                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                       | manifest known, above the floor                                                          | pin `release`; render                                                                                                           |
| `update-recommended`       | renders, but degraded past a configured share of nodes, or below the recommended version | render; show the authored soft prompt at most once per version                                                                  |
| `update-required`          | below the floor — skew's `retired`: steps below `base` were deliberately dropped         | show the native force-update screen. Never server-driven: the server cannot be trusted to render for a client it has retired    |
| `protocol-unsupported`     | protocol ranges do not intersect (HTTP 426)                                              | bundled baseline; report                                                                                                        |
| `manifest-unknown`         | fingerprint not registered (HTTP 409)                                                    | resend with the full manifest. Accepted in dev and test; in prod accepted but marked unverified, rate-limited and not persisted |
| `maintenance` / `disabled` | global kill switch                                                                       | bundled baseline or native screens; retry on `revalidateAfter`                                                                  |
| `unauthorized`             | delivery or user token rejected                                                          | refresh once; then continue as anonymous, or native sign-in if the app requires it                                              |
| unreachable / timed out    | no answer inside the splash budget (default 1500 ms)                                     | proceed on the cached pin; handshake continues in the background                                                                |

**Session consistency.** A session renders one release. A new release applies at the `apply`
boundary the rollout names: `next-launch`, `next-navigation` (default), or `immediate` (reserved for
rollbacks an operator marks urgent). A form in progress keeps the release it started on; its draft
is envelope-stamped, and submissions carry the action contract version so the server migrates them
up — the device's own past deployment, handled the way `@braidlabs/angular-workflow` handles a
wizard draft.

**Sequence numbers.** Every move of an environment ref gets a monotonically increasing `seq` (it is
the ref log's length). A device never accepts a lower `seq` than it has seen: that is a lagging
replica — skew's `staleOrigin`, where obeying would flap or loop. A rollback is a _new_ move with a
_higher_ `seq` pointing at an _older_ release, so the device follows it. Same rule for flags.

**Compatibility beyond components.** The manifest also negotiates actions, asset formats, layout
limits (depth, payload bytes) and protocol. Locale, text direction, font scale, reduced motion and
data saver travel in `device` and are honoured by projection (string resolution, asset variant
choice, skeleton animation) or passed to the renderer.

**Retiring versions.** The census (below) shows when a component version has had no devices for N
days. The catalog browser then offers to raise that contract's `base`; devices below it get
`update-required` rather than a render nobody tested. Trim-only at the bottom, append-only at the
top — `VersionedOptions.base` as designed.

## Every state

These tables are the specification. Each `id` is a member of a const union in
`libs/sdui/src/lib/states.ts`; `tools/sdui/check-state-matrix.mjs` fails the build if an id lacks a
conformance vector. The same check gains the reference client's tests in P3 and the editor's state
switcher in P4, as each comes to exist.

### Session

| id                     | Trigger                            | User sees                                                                                                      | UI comes from            |
| ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `first-launch-online`  | no cache, handshake succeeds       | skeleton from bundled routes → content                                                                         | bundled → server         |
| `first-launch-offline` | no cache, no network               | bundled baseline, quiet offline notice                                                                         | bundled                  |
| `handshake-pending`    | within splash budget               | native splash                                                                                                  | native                   |
| `handshake-timeout`    | budget exceeded                    | cached pin, revalidating                                                                                       | cache                    |
| `ok`                   | —                                  | content                                                                                                        | server                   |
| `update-recommended`   | see handshake                      | content + dismissible prompt                                                                                   | server + authored prompt |
| `update-required`      | below floor                        | force-update screen                                                                                            | native                   |
| `protocol-unsupported` | 426                                | baseline                                                                                                       | bundled                  |
| `maintenance`          | kill switch                        | baseline or maintenance screen                                                                                 | bundled                  |
| `principal-changed`    | someone signed in or out           | re-handshake; personalised cache partition switches                                                            | server                   |
| `token-expired`        | 401 mid-session                    | nothing, if refresh succeeds; else anonymous content                                                           | server                   |
| `release-superseded`   | new `seq` mid-session              | nothing until the `apply` boundary                                                                             | pinned release           |
| `rolled-back`          | higher `seq`, older release        | per `apply`; urgent replaces the screen in place                                                               | server                   |
| `stale-origin`         | lower `seq` offered                | nothing; keep pin; report                                                                                      | pinned release           |
| `clock-skewed`         | device clock far from `serverTime` | nothing; schedules evaluated on server time                                                                    | server                   |
| `app-updated`          | manifest fingerprint changed       | cache partition for the old fingerprint is unreadable by design → baseline of the new binary until first fetch | bundled → server         |
| `consent-changed`      | analytics consent revoked          | nothing; event queue purged                                                                                    | —                        |

### Screen

| id                                                | Trigger                              | User sees                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loading-initial`                                 | no cached copy                       | skeleton — authored, or derived from each component's `skeleton`; delivered in the route table so it is available before, and without, the fetch. Shown after 100 ms, held at least 400 ms, static under reduced motion |
| `loaded`                                          | 200                                  | content                                                                                                                                                                                                                 |
| `loaded-revalidating`                             | cached copy shown, fetch in flight   | content; swap only at a safe point (not under the user's finger)                                                                                                                                                        |
| `loaded-stale`                                    | cache shown, fetch failed            | content + quiet "showing saved content" notice                                                                                                                                                                          |
| `refreshing`                                      | pull to refresh                      | content + native refresh control                                                                                                                                                                                        |
| `paginating` / `pagination-error` / `end-of-list` | list continuation                    | footer spinner / inline retry row / authored end marker                                                                                                                                                                 |
| `partial`                                         | some nodes fell down the ladder      | content with fallbacks; invisible to the user, visible in telemetry                                                                                                                                                     |
| `empty`                                           | data source returned nothing         | the screen's authored empty state                                                                                                                                                                                       |
| `error-network`                                   | fetch failed, no cache               | system offline screen with retry (backoff with jitter, capped)                                                                                                                                                          |
| `error-server`                                    | 5xx, no cache                        | system error screen with retry                                                                                                                                                                                          |
| `error-timeout`                                   | exceeded screen budget (default 8 s) | as `error-network`                                                                                                                                                                                                      |
| `error-rate-limited`                              | 429                                  | cache if any; else system error honouring `Retry-After`                                                                                                                                                                 |
| `not-found`                                       | 404: slug unknown in pinned release  | authored not-found screen; deep links fall back to the home route                                                                                                                                                       |
| `gone` / `moved`                                  | 410 / redirect entry in route table  | authored "no longer available" / follow the redirect once                                                                                                                                                               |
| `forbidden`                                       | 403: audience or entitlement         | authored upsell or sign-in, as the screen declares                                                                                                                                                                      |
| `not-yet-live` / `expired`                        | schedule window                      | treated as `not-found`; editors see why in preview                                                                                                                                                                      |
| `incompatible`                                    | a required node is unsupported       | rungs 6–9 of the ladder                                                                                                                                                                                                 |
| `decode-error`                                    | payload fails the device's decoder   | discard, report with release and node id, rungs 7–9. Never a crash                                                                                                                                                      |
| `render-error`                                    | a native component throws            | that node's error boundary: its fallback, else omitted; reported                                                                                                                                                        |

### Node

`exact` · `upgraded` · `downgraded` · `fallback-authored` · `fallback-catalog` · `omitted` ·
`hidden-by-visibility` · `hidden-by-flag` · `variant` (experiment arm) · `deferred-loading` ·
`deferred-error` (inline retry) · `deferred-empty` · `data-loading` · `data-error` · `data-stale` ·
`disabled` · `asset-loading` (dominant colour or blurhash from asset metadata; declared aspect ratio,
so no layout shift) · `asset-error` (authored alt treatment) · `asset-format-unsupported` (resolved
on the server from `manifest.assets`; never reaches the device) · `string-missing` (locale fallback
chain `fr-CA → fr → default`; reported; blocked at publish for required locales) · `truncated` (text
overflow rule declared per prop).

### Action and form

`idle` · `unsupported` (hidden, disabled, or replaced, per the node) · `confirming` · `pending`
(control disabled, double-tap guarded, idempotency key attached) · `succeeded` · `failed-retryable` ·
`failed-terminal` (authored message) · `queued-offline` (durable outbox, the `@braidlabs/data`
pattern; replayed in order) · `requires-auth` · `target-missing` (navigate to a slug the pinned
release lacks → home route, reported) · `blocked-url` (not on the manifest's scheme and host
allowlist) · field `invalid` (closed validator list) · `server-rejected` (errors mapped to fields) ·
`draft-restored` (after app kill or a release change, with any `derivedPaths` surfaced).

### Defaults

Every level has one, so "nothing was authored" is never undefined behaviour: contract `default` ops
and schema defaults for props; catalog `fallback` for components; a per-app **System states** set
(offline, error, not found, forbidden, update, maintenance) authored in the CMS and also bundled in
the binary; a declared default for every flag; a default locale for every string; the bundled
baseline for every route.

## Flags, rollouts, rollbacks

Three levers, kept separate because they change at different speeds and are owned by different
people.

| Lever       | Changes                                                | Speed               | Who                                |
| ----------- | ------------------------------------------------------ | ------------------- | ---------------------------------- |
| **Release** | which content an environment serves                    | pointer move        | editors publish, approvers promote |
| **Rollout** | which share of an environment gets a candidate release | stage by stage      | approvers                          |
| **Flag**    | behaviour inside a release                             | instant, no publish | per-environment grant              |

**Rollouts.** An environment ref is a plan: `{ stable, candidate, stages: [1, 5, 25, 50, 100],
stage, salt, audience, bake, guardrails, apply }`. Bucketing is `hash(salt + install) mod 10000`,
deterministic and sticky; widening a stage never moves a device back to stable. `audience` narrows
who is eligible (platform, app-version range, locale, an internal-testers list). Guardrails compare
candidate against stable on decode errors, render errors, ladder depth, action failures and any
metric the events sink reports back; crossing a threshold **pauses** the rollout automatically and
pages; auto-rollback is opt-in per environment. Completing the last stage makes the candidate the
stable release.

**Rollback.** One action: move the ref to a previous entry in its log. No inverse migration exists
because nothing was mutated. It gets a new `seq`, an `apply` (default `next-navigation`, `immediate`
when marked urgent), an audit event, and needs no second approver — the target was already approved
once.

**Flags.** Boolean, variant, or contract-typed JSON. Rules are `audience → value` with a percentage;
evaluated **on the server** at handshake, so unreleased rules and audiences never ship to a device
— it receives values and assignment ids only. Sticky per session; default-if-unreachable is the
flag's declared default, cached from the last handshake. A release lists the flag names it
references and publishing is blocked if one is undefined or lacks an off-branch that validates.
Flags carry an owner and an expiry; expired flags are a lint. Experiments are variant flags with
exposure events and a goal metric.

**Kill switches** — all pointer or table edits, none needs a release or an app update:

- global: SDUI off for an app and environment → baseline;
- per screen: serve the last compatible earlier release for that slug;
- **per component, per manifest range**: "treat `video-carousel` as unsupported on Android builds
  512–530". A crashing native component in one binary is routed to its fallback through ordinary
  projection. This is the capability the model gives for free and the one on-call will thank it for.

## Environments and deployment

**Content: draft → dev → test → prod.** Publishing mints a release and points `dev` at it. Promotion
moves the _same_ release id forward. Gates run at each step and are stricter toward prod:

- schema validation of every node against its contract version;
- **compatibility gate** against the census _of the target environment_: share of devices exact,
  degraded, on a fallback, and blocked; a configurable budget (default: 0% blocked, ≤ 2% on a
  screen-level fallback) refuses the promotion with the offending nodes named;
- flags defined, with off-branches; routes and navigation targets resolve; action URLs allowlisted;
- required locales complete; accessibility lint (labels, heading order, contrast of token pairs,
  touch-target tokens); assets present and within size budget; payload bytes per screen within the
  smallest registered manifest's limit;
- four-eyes on prod: the approver's `iss|sub` must differ from the requester's, and approval is
  refused if the environment moved since the request (`PendingPromotion.base`, as the registry does).

Scheduled promotions and content windows are executed by a `POST /admin/tick` an operator wires to
any cron; the scheduler holds no timers of its own, so it runs on Workers as well as Node.

**Catalog: engineering's pipeline.** `sdui catalog check` in pull requests; `sdui catalog publish
--env dev` on merge; catalogs promote through the same environments. A release cannot be promoted
into an environment whose catalog lacks a contract version the release uses.

**App builds.** `sdui manifest gen` → frozen types and `client-manifest.json`; `sdui bundle --env
prod` → baseline in the binary; `sdui manifest register` in the store-submission job. Debug builds
talk to `dev`, internal tracks to `test`, store builds to `prod`; a signed preview link can point a
debug or internal build at one draft.

**The CMS itself.** Stateless fetch-native handlers; stores behind an interface with memory and
file implementations (the registry's `SnapshotStore` shape: `get`/`put`/`list`/`ref`/`setRef`/
`refLog`/`pending`). Release-addressed responses are `immutable` and CDN-cacheable keyed by release,
manifest and variant; pointer endpoints are `no-cache` with ETags. Export and import between
instances is copying content-addressed files.

## Analytics and telemetry

Three streams, one envelope, one endpoint (`POST /sdui/v1/events`, batched, authenticated by the
delivery token):

1. **Census and health** (always on, no personal data): handshake outcomes; active installs by app
   version × manifest × platform over 1/7/30 days; projection outcomes per component per client
   version; ladder rung reached; decode, render, asset and action failures; latency and cache hits.
   This is operational data the system needs in order to be safe — it feeds the compatibility gate,
   the retirement advisor and rollout guardrails. Kept in a small built-in rollup store.
2. **Product analytics** (consent-gated): screen view, impression (≥ 50% visible for ≥ 1 s), action,
   scroll depth, form start/submit/abandon, experiment exposure. Every event is stamped
   automatically with release, screen, node id, component and version, variant, projection outcome,
   app version and locale — attribution no generic SDK can provide, because only the renderer knows
   which node of which release was on screen. Forwarded to a pluggable `EventSink` (Segment,
   Amplitude, BigQuery, OTel); a per-node rollup stays for the editor's insights overlay.
3. **Audit** (every admin mutation): the registry's `AuditEvent` shape and sinks
   (`jsonLinesAuditSink`, `webhookAuditSink`), extended with the SDUI actions.

Event payloads are contracts too: an old app sends an old event shape and ingestion migrates it up.
On the device, events queue durably, batch, back off, drop oldest past a cap, respect consent
(revoking purges the queue), sample by configuration and never carry free text from props — an
allowlist of event properties is part of the catalog. Install ids are pseudonymous and resettable;
deletion by install or user id is an admin API; raw IPs are not stored.

## Auth

### Devices

| Concern            | Design                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App identity       | A public app key per environment. Not a secret — nothing in a binary is. It selects the app and its rate limits.                                                                                                                                                                                                                                                    |
| Device integrity   | Optional `attest` hook (App Attest, Play Integrity) exchanged at handshake for the short-lived **delivery token** (signed, 30 min, audience `sdui-delivery`, claims: app, environment, manifest, install, `attested`). Policy per environment: require, prefer, or ignore.                                                                                          |
| End-user identity  | The app's own access token from the customer's issuer, verified with JWKS (the `createOidcAuthorizer` verifier, asymmetric algorithms only, `exp` required). Yields the principal used for audiences, entitlements and gated screens. Anonymous is a first-class principal.                                                                                         |
| Expiry mid-session | 401 → refresh once → retry once → continue anonymous or native sign-in. No retry loops.                                                                                                                                                                                                                                                                             |
| Sign-out           | Re-handshake; personalised cache partition purged. Caches are partitioned by environment, manifest and principal (`@braidlabs/data` partitions).                                                                                                                                                                                                                    |
| On-device storage  | Tokens in Keychain / Keystore; gated-content cache encrypted at rest.                                                                                                                                                                                                                                                                                               |
| Tampering          | Optional detached signature (Ed25519, keys at a JWKS URL, pinned key ids in the binary) on screen responses, so a compromised CDN or proxy cannot inject UI. Navigation and URL actions are restricted to the manifest's allowlist, so even a compromised CMS cannot send users to an arbitrary host.                                                               |
| Preview            | A draft on a web link, an emulator or a real phone (QR code): a preview token bound to draft, editor subject, environment and scope; 10 minutes, renewable, revocable. Remote control and node-rectangle reporting are honoured only in preview mode; store builds ignore preview links unless the app opts in; a persistent preview mark; no production analytics. |
| Abuse              | Rate limits per install and per address; manifest-registration limits; unverified manifests never persisted in prod.                                                                                                                                                                                                                                                |

### CMS users

OIDC Authorization Code with PKCE in the standalone app, as `libs/braid-console/src/app/auth.ts`;
mounted inside a portal it inherits that portal's session. Roles come from the issuer's groups claim
through a role map, and CI from scopes through a scope map — no local user table, so deprovisioning
in the IdP is deprovisioning here.

| Grant                                                       | Viewer |  Editor   | Admin | CI  |
| ----------------------------------------------------------- | :----: | :-------: | :---: | :-: |
| `read` — content, releases, history, insights, audit        |   ✓    |     ✓     |   ✓   |     |
| `preview` — web preview and compare, of anything readable   |   ✓    |     ✓     |   ✓   |     |
| `preview:draft` — device and emulator tokens for drafts     |        |     ✓     |   ✓   |     |
| `emulator:<env>` — start emulator sessions and capture jobs |        | dev, test |  all  |  ✓  |
| `restore` — restore a revision, screen or field             |        |     ✓     |   ✓   |     |
| `edit` — drafts, assets, strings                            |        |     ✓     |   ✓   |     |
| `publish` — mint a release into `dev`                       |        |     ✓     |   ✓   |     |
| `promote:test`                                              |        |     ✓     |   ✓   |     |
| `promote:prod` — _request_; lands as pending                |        |     ✓     |   ✓   |     |
| `approve:prod` — never one's own request                    |        |           |   ✓   |     |
| `rollout:<env>` · `rollback:<env>`                          |        | dev, test |  all  |     |
| `flags:<env>`                                               |        | dev, test |  all  |     |
| `kill` — kill switches and component overrides              |        |           |   ✓   |     |
| `admin` — apps, keys, environments, retention, deletion     |        |           |   ✓   |     |
| `catalog:publish` · `clients:register`                      |        |           |   ✓   |  ✓  |

Default group names `sdui-viewers`, `sdui-editors`, `sdui-admins`; all remappable, and grants are
environment-scoped the way `RegistryGrant` already is (`promote:${env}`), so "approver for prod but
not an admin" is a role-map entry, not a code change. Optional ownership by tag (the registry's
`tagMap`) limits an editor group to its own screens.

Hardening carried over from the registry API: bearer tokens only (no ambient cookies, so no CSRF
surface), cross-site POSTs refused on `sec-fetch-site`, verification failures answered without the
reason, writes refused outright when no `authorize` hook is configured. Added for a CMS: uploads are
type-sniffed, size-capped and re-encoded, SVG is refused; the preview canvas never injects authored
strings as HTML; a strict CSP on the standalone app; an auth-matrix test that enumerates the router
table and fails on any route without an expected status per role.

## The CMS and its editor

Design boards: <https://claude.ai/artifact/VMfSjLxUXzb42svH5EDubW> — the editor, the state board, the
releases board, and compare with emulator preview. Braid's own palette and faces (the site's ink ground, thread teal, amber, clay;
Instrument Serif, IBM Plex Sans and Mono), themable through scoped custom properties like the console.

**Editor layout.**

- _Top bar_: screen and space, where this screen stands in each environment, undo/redo, the
  **compatibility meter** (exact · degraded · fallback · blocked, as shares of the target
  environment's real devices), Preview on device, Publish.
- _Left_: Layers (the node tree; drag to reorder, keyboard-movable) and Components (the catalog, each
  with the share of devices that render its current version).
- _Canvas_: the screen in a device frame, rendered by the web preview renderer. Direct manipulation
  — select, type into text in place, drag between insertion points, drop into slots. **Compare
  mode** puts "Latest" next to "As seen by 5.8 (12%)", with degraded nodes marked amber and
  fallbacks hatched, straight from the projection report.
- _Canvas toolbar_: device and platform skin, light/dark, locale, text size, right-to-left, **state**
  (every screen state from the tables above — an unauthored state shows its default and a prompt to
  design it), flags and variants, audience, and date (to see scheduled content).
- _Inspector_: Content (a form generated from the contract's JSON Schema; fields a downgrade drops
  are annotated with how many devices lose them), Style (tokens), Actions, Visibility, Fallback
  (what older apps get — live), States, Analytics, Accessibility, Localisation.
- _Issues_: errors block publish, warnings do not; each selects its node.

**Other views.** Releases (dev, test, prod as lanes; promote, approve, rollout stages with
guardrail traces, rollback), Flags, Clients (census, per-manifest capabilities, retirement advisor,
component overrides), Catalog (components, versions, steps, which steps are lossy), Insights, Audit,
Settings. Preview, History and Compare have their own sections below.

**Editing model.** Edits are operations (`insert`, `move`, `remove`, `setProp`, `setAction`, …) over
the document, which gives undo/redo and a readable history. Autosave carries the draft's base
revision; a conflicting save is refused and the editor offers a three-way view — the registry's
optimistic-concurrency stance. A soft lock with presence covers the common case of two people in
one screen. Opening a draft authored against an older catalog up-migrates its nodes and lists the
`derivedPaths` as "filled with defaults — review".

**The canvas is honest about what it is.** It is a web rendering of native components: exact about
structure, content, tokens, states and compatibility, and approximate about pixels. The emulator
and device previews below are the pixel truth. Custom catalog components without a registered web
preview render as a labelled box with their props — never as nothing.

## Previews

Three tiers, cheapest first. All three run the **same preview protocol**, so a draft, a control and a
forced state behave identically whether the renderer is a browser tab or a real binary.

| Tier         | What renders                                                                                                             | Fidelity                                                              | Cost                        | Who uses it                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------- | ---------------------------------------- |
| **Web**      | The web preview renderer driving the real `@braidlabs/sdui/client` against the delivery API                              | Structure, content, states, compatibility: exact. Pixels: approximate | Free, instant               | Everyone; the editor canvas is this tier |
| **Emulator** | The app's **real binary** in an iOS Simulator or Android Emulator, streamed into the CMS or run on a developer's machine | Native truth for that OS and app version                              | A session, seconds to start | Editors before publishing, approvers, QA |
| **Device**   | The real app on a real phone, by QR code                                                                                 | Native truth, plus the hardware                                       | A phone                     | Anyone holding one                       |

### The preview protocol

- A **preview token** binds a draft (or a release), an environment, the issuing editor's subject and
  a scope. `POST /sdui/v1/preview/redeem` exchanges it for a delivery token; from there the client
  performs an ordinary handshake and ordinary fetches, so preview exercises the real projection,
  flags, fallbacks and auth — not a parallel code path that could drift.
- **Live reload.** The client holds `GET /sdui/v1/preview/stream` (server-sent events). A new draft
  revision arrives as an event and the client refetches the affected screen; the editor's keystroke
  shows on the simulator in well under a second.
- **Remote control**, over the same stream, only honoured in preview mode: go to a screen; force any
  state from the state tables (`loading-initial`, `error-network`, `empty`, …) without having to
  break the network; set locale, theme, text size, direction; override flags and audience; freeze
  the clock.
- **Inspect, both ways.** In preview mode the client reports each node's on-screen rectangle. Tap a
  component in the emulator and the editor selects that node; select a node in the editor and the
  emulator outlines it.
- **Settled signal.** The client reports when a screen has finished loading data, assets and
  animations (and holds animations and the clock still when asked). Captures wait for it, which is
  what makes native screenshots repeatable enough to diff.
- A persistent **PREVIEW** mark on every previewed surface; preview sessions send no production
  analytics; store builds ignore preview links unless the app opts in.

### Web preview

- **In the editor**: the canvas, with compare mode and every toolbar control.
- **As a link**: `/preview/<token>` opens the screen full-window with a slim control bar — device,
  app version ("as seen by 5.8"), locale, theme, text size, state, flags. This is what a product
  owner or a legal reviewer is sent; it needs only the `preview` grant, or a time-limited link with
  no account when an editor chooses to make one.
- **The matrix**: one screen rendered as a grid — app versions across, and down the side any of
  locales, themes, text sizes or states. Web-rendered, so it is instant, and it is the fastest way
  to see what a change does to the long tail.

### Emulator preview

The point of this tier is that it runs **old binaries too**. Projection _predicts_ what 5.8 shows;
an emulator running the real 5.8 build _shows_ it. When the two disagree the catalog or a native
component is wrong, and that is found in the CMS rather than in production.

- **Preview builds.** The app's release job uploads a simulator build (`.app`) and an emulator build
  (`.apk`) alongside `sdui manifest register`, so every registered app version has a runnable
  artifact with the preview SDK enabled.
- **Providers, behind one interface.** Braid does not run a device farm.

  ```ts
  interface EmulatorProvider {
    devices(): Promise<EmulatorDevice[]>; // platform, OS versions, models
    start(options: { build: string; device: string; os: string; launchUrl: string; locale?: string }): Promise<EmulatorSession>;
    screenshot(session: string): Promise<Blob>;
    end(session: string): Promise<void>;
  }
  interface EmulatorSession {
    id: string;
    embedUrl?: string;
    expiresAt: string;
  }
  ```

  Three implementations are planned: a **hosted** adapter for a streamed-emulator service (the
  session's `embedUrl` is framed inside the CMS, so an editor with nothing installed sees the real
  app in the browser); a **self-hosted** adapter for an Android emulator container with a WebRTC
  bridge; and **local**.

- **Local.** `sdui preview --ios | --android [--app-version 5.8] --draft <id>` boots the simulator
  or emulator on the developer's machine, installs the matching preview build, opens the preview
  link (`xcrun simctl openurl`, `adb shell am start`), and stays attached for live reload. The CMS
  shows the session as connected and the inspect bridge works the same way.
- **In the CMS**: an Emulator tab beside the canvas — pick platform, model, OS and app version; the
  stream sits where the web frame was, with the same state, locale and flag controls driving it
  through remote control. Sessions idle out, are capped per person and per day, and are an
  environment-scoped grant because they cost money.
- **Captures.** A capture job walks screens × states × locales × themes for a chosen set of app
  versions, waits for the settled signal, and stores each screenshot content-addressed against
  `(release, screen, manifest, state, locale, theme)`. Captures run on publish for the configured
  set and on demand; they feed history thumbnails and the visual diff below. With no provider
  configured, the same job runs the web renderer headlessly, so visual history and diffing always
  exist — at web fidelity.

## History, comparison and diffing

### What has a history

| Thing                             | History is                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A draft                           | Its operation log: every autosave is a revision. Runs of edits by one person are grouped into sessions; an editor can name a checkpoint.           |
| A screen                          | The releases that changed it. Each screen subtree has its own content address (`scr_<hash>`), so "did Home change in r40?" is a comparison of ids. |
| A node or a field                 | Who last changed it, in which revision and release — shown in the inspector on demand.                                                             |
| An environment                    | Its ref log: every promotion, rollout stage, pause and rollback, with actor and `seq`.                                                             |
| Flags, overrides, strings, tokens | Their own revision lists, with the same compare view.                                                                                              |

History is append-only everywhere. **Restore** never rewrites it: restoring a revision, a screen
from an old release, or a single field from a diff creates a new revision whose content matches the
old one, attributed to whoever restored it. Draft operation logs are compacted to checkpoints after
a retention window; releases are kept forever, since everything else points at them.

The **History view** is a timeline per screen and per app: revisions and releases on one axis,
environment moves marked on it, each entry with its author, a capture thumbnail and a one-line
summary generated from the diff. Filter by screen, person, environment or date; any two entries
can be selected and compared.

### What can be compared

Any two of: draft revision, release, environment ("what is on test that is not on prod"). And, for
one version, any two **viewpoints**: app versions (the editor's compare mode, generalised), locales,
themes, audiences, flag settings. The compare view always states both sides in full, e.g. _prod r37
as 6.2, en-CA_ against _draft r42 as 6.2, en-CA_.

### Three synchronised views of one comparison

Selecting a change in any view selects it in the others.

1. **Changes** — a semantic diff, in sentences. Nodes are matched by stable id, so a move is a move
   and not a delete plus an add. Each change is one of: added, removed, moved, content changed,
   action changed, visibility changed, fallback changed, state changed, string changed, token
   changed, asset replaced. Field-level differences come from `diffPayloads` in `@braidlabs/studio`;
   text is diffed by word, tokens show before and after swatches, assets sit side by side.
2. **Visual** — the two renders, as side by side, a swipe divider, onion skin, or changes
   highlighted. In the web tier changed regions are drawn from the changed nodes' own rectangles,
   so there is no pixel noise. On captures, a per-pixel comparison with a tolerance finds the
   regions and the reported node rectangles name them. Web renders are instant; native captures
   are shown when they exist and can be requested when they do not.
3. **Data** — the raw documents, as authored and **as delivered**: what bytes a given app version
   received before and after. This is the view for engineers and for incident review.

**The diff is contract-aware**, which is what makes it trustworthy here. Two sides authored against
different catalog versions are first migrated to a common version, so a component upgrade does not
masquerade as an edit. What the catalog changed is listed separately — "upgraded by the catalog, no
content change", with the `derivedPaths` it filled in. The reverse case is called out too: a screen
whose content is identical but whose render differs (a token or a native component changed) is
flagged as **changed without an edit**, which is the change nobody reviewed.

### Where the diff is used

- **Before publishing**: draft against the environment's current release.
- **Approving a promotion**: the approver sees changes and visuals for the promotion, per affected
  app version, before the Approve button is enabled. Four-eyes means the second pair looked at
  something.
- **Visual gate** (optional, per environment): captures of the candidate against the current
  release; any visual change not explained by a content change needs an explicit acknowledgement.
- **Rollback**: the diff of what a rollback will undo, shown before confirming.
- **Release notes**: the change list, as text, attached to the release and to its audit event.
- **Conflicting saves**: the three-way view (base, theirs, yours) is this compare view with a third
  column.
- **Selective restore**: "restore this" on a single change in the Changes view.

## API surface

Delivery (`/sdui/v1`): `POST /handshake` · `GET /screens/:slug` (sends `Skew-Contract`, `ETag`,
`Sdui-Release`, `Sdui-Projection`) · `GET /assets/:id` · `POST /events` · `POST /preview/redeem` ·
`GET /.well-known/skew/contracts/:name`.

Admin (`/sdui/admin`): drafts (`GET/PUT/DELETE`, `POST …/ops`), `POST /releases`, `GET /releases`,
`GET /environments`, `POST /environments/:env/promote|approve|reject|rollback`, rollouts
(`start|advance|pause|halt`), flags, `GET/POST /clients`, `GET /census`, `POST /overrides`,
catalogs, assets, `POST /compat` (projection report for a draft against an environment's census),
`GET /insights`, `GET /audit`, `GET /permissions`, `POST /tick`.

Preview: `POST /admin/preview-tokens`, `GET /v1/preview/stream`, `POST /admin/preview/:session/control`,
`GET /admin/emulators/devices`, `POST /admin/emulators/sessions`, `DELETE /admin/emulators/sessions/:id`,
`POST /admin/captures`, `GET /admin/captures`.

History: `GET /admin/drafts/:id/revisions`, `GET /admin/screens/:slug/history`,
`POST /admin/compare` (two versions, optional viewpoints → change list, both projected documents,
capture ids), `POST /admin/restore`.

## Phases

Each phase is shippable and is locked with `/goal-set` on its own. Criteria are things to run.

### P1 — Core and protocol (`@braidlabs/sdui`)

- [x] `nx test sdui` passes a conformance suite driven by JSON vectors in `libs/sdui/conformance/`:
      one authored screen projected to three manifests yields `exact`; `downgraded` with the expected
      `lossyPaths`; and the authored fallback where a step is not invertible or a critical path would
      be lost — never a guessed value.
- [x] `sdui catalog check` exits non-zero, naming the step, when a published step is edited or
      reordered, and zero when a step is appended.
- [x] Over 100,000 synthetic installs a 5% stage assigns 5% ± 0.3%, assignment is identical across
      calls, and widening 5% → 25% moves no install from candidate to stable.
- [x] Handshake resolution returns each outcome in the handshake table for a fixture row, and the
      sequence rule holds: lower `seq` is ignored, higher `seq` with an older release is followed.
- [x] `tools/sdui/check-state-matrix.mjs` passes, and fails when a state id is added without a
      vector.
- [x] `diffScreens` vectors pass: a moved node reports one move (not a delete and an add); two
      sides authored at different contract versions with the same content report no content change
      and one "upgraded by the catalog" entry; an unchanged screen is detected by equal `scr_` ids
      without walking it.

Tasks: model and validators · catalog and manifest fingerprints · projection and report · ladder ·
flag and rollout evaluation · handshake resolution · state unions · screen content addresses and
the contract-aware semantic diff · the `sdui` bin · nx project, tsconfig path, publishable check ·
`docs/packages/sdui.md`.

Built, then reviewed three ways (goal verification, code review, security audit) and corrected.
Decisions the review forced, which the sections above should be read with:

- **`required` is strict.** A required node in the screen's tree that does not reach the screen
  blocks it, wherever the node sits — including under an ancestor that was replaced by its own
  fallback. Inside a fallback it is conditional: it counts when that fallback is what is rendered.
- **Loss is measured, not declared.** A downgrade's lost paths are what the node held that does not
  come back from a trip down and up, placed in the component's newest shape, which is the shape
  `criticalPaths` are written in. A field the author left out was never lost. Each loss is also
  traced on its own; one that leaves no trace in the newest shape is still reported, and on a
  component with critical paths it is refused. That tracing is rationed per projection: a node
  whose losses would cost more than the budget has left has all of them treated as untraced.
- **Conditions are three-valued.** Unknown is not true, and stays unknown through `not`.
- **Every trust boundary has a parser** with size limits. The reserved keys `__proto__`,
  `constructor` and `prototype` are refused in screens, manifests and handshake bodies, anywhere
  in a catalog, and in flag and rollout definitions; values that are not JSON are refused in
  screens and catalogs. A catalog's depth and size are limited, and a migration whose result is
  too deep or too large to write out fails like any other step that fails. The parsers vouch for
  data as `JSON.parse` gives it, not for a live object that changes after it is read. Two root
  causes were fixed in `@braidlabs/skew` rather than worked around.
- **`hide` removes the node**; it does not swap in the catalog's fallback.

Two things the tables above describe are left for P2, where their acceptance criteria are:
validating projected props against the client version's JSON Schema, and enforcing a manifest's
`limits`. Projection reports four screen outcomes — `exact`, `degraded`, `fallback`, `blocked` —
and `blocked` is what the `incompatible` screen state is resolved from.

### P2 — Delivery and control plane (`@braidlabs/sdui/server`)

- [ ] Over HTTP against an in-memory server: publish lands in `dev`; promote to `test` succeeds;
      promote to `prod` is pending; the requester approving gets 403; a second subject approving
      moves the ref; rollback moves it back with a higher `seq`; each step emits exactly one audit
      event.
- [ ] `GET /screens/home` for three registered manifests returns three different bodies from one
      release, each valid against that manifest's schemas, with a stable `ETag` and a 304 on
      revalidation.
- [ ] The auth-matrix test covers every route in the router table for viewer, editor, admin, CI,
      device and anonymous, and fails if a route has no row.
- [ ] Posting events with a candidate decode-error rate over the guardrail pauses the rollout and
      records why.
- [ ] A component override for one manifest changes that device's next response to the fallback,
      with no new release.
- [ ] A release whose compatibility report exceeds the environment's budget is refused promotion,
      and the response names the nodes.
- [ ] A preview token redeemed by a client yields the draft's content through the ordinary
      handshake; a new draft revision reaches an open preview stream; an expired or revoked token,
      or one presented for another draft, is refused; preview traffic produces no product events.
- [ ] `POST /admin/compare` between two releases returns the change list and both documents as
      delivered to a named manifest; `POST /admin/restore` of a revision creates a new revision
      with identical content and leaves the log intact.

### P3 — Reference client (`@braidlabs/sdui/client`)

- [ ] Every session, screen, node and action state id has a named test in the headless client, and
      the matrix check enforces it.
- [ ] With no network and no cache the client yields the bundled baseline; with a cache and a
      failing server it yields `loaded-stale`; it never throws on a malformed payload.
- [ ] Events queued offline survive a restart of the client on the same storage driver, flush in
      order, and are purged when consent is revoked.
- [ ] Changing the principal switches cache partition; the previous principal's gated content is
      unreadable afterwards.
- [ ] In preview mode the client obeys every remote-control command (navigate, force each state
      id, locale, theme, flags, frozen clock), reports node rectangles, and emits a settled signal
      exactly once per screen load; outside preview mode it ignores all of them.

### P4 — The CMS: editor and web preview (`@braidlabs/cms`)

- [ ] Playwright, against the demo server and the mock issuer (`tools/braid-console/mock-oidc.mjs`):
      an editor signs in, drags a component onto the canvas, types into it in place, sees the
      compatibility meter move after adding a component an older manifest lacks, authors a fallback,
      sees the meter recover, and publishes to `dev`.
- [ ] A viewer sees the same screen with no editing controls, and a forged write with the viewer's
      token is refused by the API.
- [ ] The state switcher renders every screen state for the demo screen; a screenshot per state is
      written and none is blank.
- [ ] Promote, approve, advance, halt and roll back from the releases board, each reflected by the
      API.
- [ ] No serious or critical axe violations in the editor and releases views; insert, reorder and
      delete are completable by keyboard alone.
- [ ] A web preview link opens the draft full-window with no editing surface; typing in the editor
      updates it without a reload; the matrix view renders the demo screen for every registered
      app version and none is blank.
- [ ] The library entry stays under a size budget checked like `tools/braid-console/check-size.mjs`.

### P5 — History, compare and visual diff

- [ ] Playwright: the history timeline lists the demo screen's revisions and releases with authors
      and environment moves; selecting two opens Compare.
- [ ] In Compare, a known edit (one title changed, one card moved, one card added) appears as
      exactly three entries in Changes; selecting each outlines the matching region in Visual and
      the matching lines in Data.
- [ ] The visual view's four modes (side by side, swipe, onion skin, highlight) each render both
      sides; on two stored captures that differ in one known region, the pixel comparison reports
      that region and no other, and reports none for identical captures.
- [ ] A screen whose content is identical across two releases but whose token set changed is
      flagged "changed without an edit".
- [ ] Restoring one field from the Changes view changes only that field and adds one revision.
- [ ] The approval dialog for a pending promotion shows the comparison and enables Approve only
      after it has been opened.

### P6 — Emulator and device preview

- [ ] Against a fake `EmulatorProvider` in tests: starting a session frames its embed in the
      Emulator tab; state, locale and flag controls reach the session as remote-control commands;
      tapping a reported node rectangle selects that node in the editor; idle sessions end and the
      per-person cap is enforced.
- [ ] A capture job over the demo release stores one screenshot per screen × state × app version
      in the configured set, each taken after the settled signal, and re-running it stores nothing
      new.
- [ ] With no provider configured, the same job produces web-rendered captures and Compare works
      from them.
- [ ] `sdui preview --android --draft <id>` and `--ios`, run on a machine with the emulators
      installed, boot the device, open the draft and live-reload an edit. **Verified by hand on a
      developer machine, not in CI**; the command's argument handling and the commands it would
      run are unit-tested here.

### P7 — Example, end to end, docs

- [ ] `npm run sdui:demo` starts the server, the CMS and three simulated devices pinned at three
      manifests; an e2e asserts they render the same release three ways and that a rollback reaches
      all three under the sequence rule.
- [ ] Docs pages for both packages and a tutorial build; `npm run verify`-equivalent and
      `tools/release/check-publishable.mjs` pass with the new packages included.

### Later (not in this plan's build)

Swift and Kotlin SDKs written against the conformance vectors and the state unions; React Native
bindings over `@braidlabs/sdui/client`; an OTel bridge in `@braidlabs/otel`; a GitOps publisher for
releases like `githubPublisher`.

## Cut

Folded in above; listed so the removals are visible.

- **Lens interpreters on the device** → projection is server-side only. The cost: cached content does
  not survive an app update that changes the manifest; the bundled baseline covers the gap.
- **Real-time co-editing** → revision-checked autosave, soft lock, presence.
- **An analytics product** → census and per-node rollups built in; everything else through a sink.
- **Expression language, HTML, freeform CSS** → closed conditions, restricted rich text, tokens.
- **An action proxy** — the CMS is not the app's backend; `submit` names an endpoint the app
  declares.
- **Database adapters** → memory and file stores behind the interface.
- **A drag-and-drop or rich-text dependency** → pointer events as `@braidlabs/console/tiles` does;
  rich text limited to marks over plain text.
- **Running a device farm** → an `EmulatorProvider` interface with hosted, self-hosted and local
  adapters; the hosted adapter targets one service first.
- **A pixel-diff or image dependency** → a small per-pixel comparison in the browser over canvas
  data; region naming comes from node rectangles, not from image analysis.
- **Branching and merging of drafts** → linear history with restore, including single-field
  restore; the three-way view exists only to resolve a conflicting save.
- **Comments, AI authoring, a marketplace of templates.**
- **Seven packages** → two, with subpaths.

## Risks and open questions

- **Which native stacks, and in what order?** Assumed: protocol first, with a TypeScript reference
  client that React Native can use directly, and Swift/Kotlin SDKs as a later phase built against
  the conformance vectors. Nothing in this repository can build or run an iOS or Android app, so
  native SDKs need a machine with Xcode and the Android SDK. If Swift and Kotlin must come first,
  P3 changes shape and the order of P3/P4 swaps.
- **Web preview fidelity.** The canvas approximates native rendering. Mitigated by tokens, platform
  skins and device preview; a customer with a large custom catalog must supply web previews to get
  true WYSIWYG for those components.
- **Inline rich-text editing without a dependency** is the least certain piece of the editor. If it
  proves fragile, canvas editing stays plain text and marks move to the inspector.
- **Reusing registry code vs. copying its shape.** `SnapshotStore` and `createOidcAuthorizer` are
  typed to fragment manifests and `RegistryAction`. The plan generalises them where the change is
  type-only and backward compatible, and otherwise mirrors them; which applies is decided in P2
  with the code open, and any change to `@braidlabs/registry` ships as its own commit.
- **Variant explosion in caches.** Flags, audience and locale multiply response variants. The
  projected template is cached per `(release, manifest)` and the rest is applied per request;
  whether that is fast enough at the edge is measured in P2, not assumed.
- **Guardrail quality depends on event volume.** Small audiences give noisy rates; guardrails need
  minimum-sample thresholds, and auto-rollback stays opt-in.
- **Attestation and payload signing** are designed as hooks; the provider integrations are the
  adopter's, and are untested here.
- **Emulator preview cannot be proven in this repository.** iOS simulators need macOS hosts; a
  streamed emulator needs a provider account; none of that exists in CI here. P6 is tested against
  a fake provider and the local command is verified by hand. The hosted adapter's first target
  service is an open choice. Emulator preview also depends on a native SDK with preview mode, so it
  is only real once the Swift and Kotlin SDKs exist — until then it runs a React Native build or
  the web client inside the frame.
- **Native captures are only as repeatable as the app.** Frozen clock, held animations and the
  settled signal remove most noise; remote images, system fonts and OS updates remove the rest of
  the guarantee. The visual gate therefore asks for acknowledgement instead of failing a
  promotion, and compares with a tolerance.
- **Capture volume.** Screens × states × locales × themes × app versions grows quickly. Captures
  run for a configured set, content-addressed so unchanged screens cost nothing, and on demand
  otherwise.
- **Scope.** This is seven phases. P1–P2 prove the idea and are useful alone (a headless SDUI
  backend with a compatibility gate). The editor is the largest single piece of work; history and
  compare (P5) depend only on P1–P4, and emulator preview (P6) can ship after everything else.
