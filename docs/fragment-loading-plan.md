# Fragment loading states — plan

Status: approved · Package: `@braidlabs/core` (+ thin wrapper changes)

## What exists

- `loading` is already a slot state, reflected as `state="loading"` (`fragment-slot.ts:180, :373`).
  `braid:state` fires for it.
- A `slot="fallback"` light-DOM child is already projected and shown on error
  (`SLOT_STYLES` / `ensureFallbackSlot`, `fragment-slot.ts:88-118`).
- A client-fetched document is painted before the realm finishes booting, so the right moment to
  hide a loading UI is **first paint**, not `ready`.
- Pierced (SSR'd) slots adopt a declarative shadow root with no `<slot>`, so they never show
  light-DOM children.

## Design: CSS on the existing state, no timers

The opt-in is the presence of a loading child. Nothing else is configured.

```html
<fragment-slot name="orders">
  <div slot="loading" aria-hidden="true" inert class="skeleton"></div>
  <p slot="fallback">Orders are unavailable right now.</p>
</fragment-slot>
```

- Projected through a `<slot name="loading">` added only to client-built shadow roots (the compat
  non-pierced and contract paths). It is never added to a pierced root, so SSR'd fragments never
  show a skeleton.
- Shown only while `state="loading"` **and** nothing has painted yet:
  `:host([state="loading"]) braid-document:empty ~ slot[name="loading"]`.
  It disappears the moment content paints, on error (the fallback takes over), and on teardown.
- **Delay against flashing.** A zero-length CSS animation with a start delay keeps the skeleton
  hidden for `--braid-loading-delay` (default `200ms`). Hosts can set the variable globally or
  per slot. A fast boot never shows it.
- **No minimum display time.** Holding content back to avoid a brief skeleton would delay real
  content, so it isn't done.
- Loading content lives in host light DOM. The fragment can't see or clobber it, and hydration
  never meets foreign DOM.

## Cards

### A — `slot="loading"` in core (PR 1)

Decided: the slot carries `aria-busy="true"` while its loading child is shown.

1. Add the loading rules and the delay keyframes to `SLOT_STYLES`.
2. Add `ensureLoadingSlot()`, called next to `ensureFallbackSlot` on the client-built paths only.
3. Docs in `docs/packages/core.md`: the pattern, `--braid-loading-delay`, `braid:state`, CLS
   guidance (size the slot with `min-height` or `aspect-ratio`), skeletons `aria-hidden` plus
   `inert`, shimmer only under `prefers-reduced-motion: no-preference`, and
   `fragment-slot:not(:defined) > [slot="loading"]` for the pre-upgrade moment.

Acceptance criteria:

- [ ] **Delay.** A client-built slot with a loading child shows it after the delay, while loading
      and before first paint. (Chromium)
- [ ] **Hand-off.** It disappears at first paint, before `ready`. (Chromium)
- [ ] **Error and teardown.** It disappears on `error` and `gone`; the fallback shows if present.
      (Chromium)
- [ ] **Pierced.** A pierced slot never shows it. (Chromium)
- [ ] **Delay variable.** `--braid-loading-delay: 0s` shows it immediately. (Chromium)
- [ ] **Opt-in only.** A slot with no loading child behaves exactly as before, and the existing
      core and gateway suites pass unchanged.
- [ ] **Structure.** A jsdom spec checks that client-built roots have `slot[name=loading]` after
      `braid-document`, that pierced roots don't, and that the rules are present.
- [ ] `CI=1 npx nx run-many -t lint test build` and `npm run docs:build` pass.

### B — wrappers pass children through

- React `<BraidFragment>` renders `children` inside `<fragment-slot>`.
- Angular `<braid-fragment>` adds `<ng-content/>`.
- Without this, wrapper users can't author `slot="loading"` or `slot="fallback"` at all.
- AC:
  - `render(<BraidFragment name="x"><div slot="loading"/></BraidFragment>)` yields
    `fragment-slot > [slot=loading]`;
  - the Angular spec shows the projected child;
  - with no children, nothing changes.

## Separate bug tickets (found while planning, not gating this)

- **Pierced slots never get the fallback CSS.** `ensureFallbackSlot` skips `SLOT_STYLES` whenever
  any `<style>` exists, and the gateway's declarative shadow root always has one. On pierced
  pages, fallback content shows while the fragment is healthy and isn't revealed on error. A spec
  masks this (`fragment-slot.spec.ts:95-106`).
- **React `onStateChange` ignores `braid:state`**, so it misses `loading` and the liveness
  states. The docs say otherwise. Angular's `state()` has the same gap.

## Out of scope

- A JS timing engine, `initBraid({ loading })`, and a new `data-braid-loading` attribute:
  `state="loading"` already is the signal.
- Telemetry fields for loading time; they belong to the OTel plan.
- Gateway-served skeletons. They would need out-of-order streaming.
- The untrusted tier, whose iframe needs its own handling. Deferred by decision.
