# Shared host globals for trusted fragments — plan

Status: approved for build · Branch: `feat/shared-globals` · Package: `@braidlabs/core`

## Problem

A compat fragment runs its JavaScript in a hidden same-origin realm iframe. That realm has its own
`window`, so every global an MFE touches is the realm's copy, not the host's:

```js
// inside a fragment, today
window.adobeDataLayer = window.adobeDataLayer || []; // a fresh, realm-local array
adobeDataLayer.push({ event: 'cart:add' }); // nobody is listening to it
```

The host already loaded Adobe Launch, GTM, Medallia, an OTel web SDK. The fragment can't see any
of them, so the team either loses its analytics without noticing or loads a second copy of the
vendor script. "Zero app-code changes" is the promise of `compat`, and this is where it breaks.

## Developer API

```ts
initBraid({
  sharedGlobals: ['dataLayer', 'adobeDataLayer', 'adobeLaunch', '_satellite', 'KAMPYLE'],
});
```

Per fragment, from the registry manifest or `initBraid({ capabilities })`:

```jsonc
"capabilities": { "sharedGlobals": ["dataLayer"] }   // replaces the host default
"capabilities": { "sharedGlobals": [] }              // opts this fragment out
```

## Design

- In `initializeRealmContext` (`libs/core/src/compat/realm-patches.ts`), under the window patches and
  so before any fragment script runs, define an accessor on the **realm** window for each name:
  - `get` reads `mainWindow[name]` on every access, so a global the host sets up later is still seen.
  - `set` writes `mainWindow[name]`.
  - `configurable: true, enumerable: true`.
- Bare identifiers work. `var dataLayer = dataLayer || []` in a classic script reaches the accessor,
  because `CreateGlobalVarBinding` leaves an existing own property alone. A jsdom iframe probe
  confirmed this.
- **Skip rule:** any name already `in` the realm window is skipped, with one dev-mode warning. That
  covers `location`, `document`, `top`, `eval`, every constructor, every `on*` handler, and every
  name compat already patches, without maintaining a denylist.
- **Tier scope:** trusted (same-origin compat realm) only. Only the compat boot path receives
  `sharedGlobals`. The untrusted cross-origin tier never reads the field, the same way it ignores
  `network`.
- **Precedence:** the per-fragment `capabilities.sharedGlobals` value is resolved by the existing
  `resolveCapabilities`. When it is present it replaces `initBraid({ sharedGlobals })`.

### The host-purity invariant, stated honestly

Braid still installs nothing on the host window or its prototypes. The accessors live on the
fragment's realm. What changes is that a trusted fragment can now write to host globals the host
**named itself**. That is a trust decision the host makes, and `docs/braid-boundary.md` says so.

## Known limits (documented, not fixed)

- **Script dedupe.** A fragment's own `<script src=".../launch.js">` still runs. The fragment
  should guard it with `if (!window._satellite)`, which now sees the host's copy.
- **Host should own initialization.** If a fragment assigns a global first (`dataLayer = []`), the
  host holds a realm-created object that outlives the fragment. It also replaces any array the
  host already hooked, which breaks GTM's patched `push`.
- **Cross-realm identity.** Objects pushed from a realm fail `instanceof Object` checks in host
  code. `Array.isArray` and the usual plain-object checks still pass.
- **Shadowing.** `function dataLayer(){}` in a fragment redefines the accessor as a realm-local
  data property. It doesn't throw and it leaves the host alone.
- **Presence checks.** `'dataLayer' in window` is true inside the fragment even before the host
  defines it. Truthiness guards still behave.

## Tasks

1. `compat/shared-globals.ts` helper `installSharedGlobals(realmWindow, mainWindow, names, fragmentId)`,
   wired into `initializeRealmContext`. Specs run real classic scripts in a jsdom iframe.
2. Add `sharedGlobals` to `BraidOptions` and the resolved config, to `FragmentCapabilities`, to the
   gateway manifest `capabilities` type (one line, to avoid excess-property errors for registry
   authors), and to `AdapterBootContext` as an optional field. It is resolved in `fragment-slot.ts`
   on the trusted compat path only.
3. Docs: JSDoc on the new fields, a new row in the capabilities grant table, `docs/packages/core.md`,
   a trust-model paragraph in `docs/braid-boundary.md`, and one line in
   `skills/using-braid/references/client.md`.

## Acceptance criteria

- [ ] A fragment's `var dataLayer = dataLayer || []; dataLayer.push(x)` lands in the host's
      original array. Bare `dataLayer` and `window.dataLayer` reach the same array.
- [ ] The getter is live: a value the host assigns after boot is visible in the fragment. A
      fragment assignment is visible on the host.
- [ ] A name already `in` the realm window (for example `location`, `MutationObserver`) is skipped,
      with one dev warning and no warning in production. `KAMPYLE` is accepted.
- [ ] A per-fragment `capabilities.sharedGlobals` replaces the host default, and `[]` opts out.
- [ ] Untrusted and contract fragments get no accessors and no error.
- [ ] A fragment declaring `function dataLayer(){}` doesn't throw and leaves the host's
      `dataLayer` untouched.
- [ ] The core suite stays green (269 at baseline) with the new specs added.

## Out of scope

- Deduplicating vendor `<script>` tags.
- The custom-element and contract adapters.
- A dev warning for `sharedGlobals` on the untrusted tier, and a post-boot shadowing check. Both
  were cut by the simplifier, and the docs cover them instead.

## Discovered

- `docs/packages/core.md`'s `InitBraidOptions` block lists `gatewayBaseUrl` and
  `defaultTimeoutMs`, which don't exist, and omits `capabilities`, `contract` and `dev`.
- `docs/braid-architecture.md:144` says host purity is "enforced in CI via automated host-purity
  test suites". No such suite was found.

## Changed in review

Built in PR #25. Review and the security audit added:

- `resolveSharedGlobals` ignores a grant that is not an array of strings.
- A spec pins the boot order at the adapter seam.
- The docs say plainly that a per-fragment grant **replaces** the host list, so it can widen it,
  and that whoever controls the registry controls it.

## Follow-up (2026-10-21)

- **Built (#30):** `sharedGlobals` now reach custom-element fragments, with a real-realm host-purity
  spec. `InitBraidOptions` in the core docs is corrected, and the architecture doc no longer claims a
  CI host-purity suite.
- **Declined:**
  - **Vendor script dedupe:** skipping a fragment's `<script src>` would also skip libraries each
    realm needs its own copy of. The documented `if (!window._satellite)` guard is enough.
  - **`sharedGlobals` for contract fragments:** their host API is the contract.
  - **Dev warnings (untrusted-tier grant, post-boot shadowing check):** cut again in simplification.
    The shadowing check could see only boot-time shadowing.
