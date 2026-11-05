# Formal verification for Braid — plan

Status: items 2 and 3 done (2026-11-04); items 1 and 4 not started · Touches: data, skew, registry, core, sw, CI

## Problem

On 2026-11-03 the security review found bugs that example-based tests could not have caught,
because each one lives in an ordering nobody thought to write down.

Four were in one place, the cross-tab session protocol:

- `signIn` raced another tab's sign-out purge (DS-6).
- `switchTenant` raced the same purge.
- An outbox drain kept sending after the signed-in person changed.
- A tenant switch mid-send left a sent entry queued, which caused a double send.

Two were decision procedures that answered wrongly for inputs nobody had tried:

- Route-overlap ownership missed `{/checkout}/pay` (RG-1).
- Route-overlap ownership grandfathered whole fragment pairs (NEW-1).

Every one was fixed with a test for that ordering or that input. None of those tests says the
problem class is gone. This plan targets the classes.

## What gets verified, and how

### 1. The cross-tab session protocol: a TLA+ model, checked with TLC

**Scope.**

- `libs/data/src/lib/tenancy.ts`: signIn, switchTenant, signOut, recover, purge markers,
  partition records.
- `libs/data/src/lib/locks.ts`: the per-user purge lock and the per-owner flush lock.
- `libs/data/src/lib/outbox.ts` and `flush.ts`: enqueue, drain snapshot, `stillQueued`, and
  entry partitions.
- `libs/braid-sw/src/lib/compose.ts`: refresh, clear, and the clear generation counter.

**Model.**

- N tabs (3 is enough), 2 users and 2 tenants, all sharing one store.
- Every `await` in the real code is a step where another tab may run.
- Any step can crash, which models the tab closing.
- Locks are exclusive and FIFO.

**Invariants (safety).**

- *No orphan:* no partition holds data for a user while no partition record names it, outside an
  in-progress purge that holds the lock.
- *No foreign replay:* every sent mutation is sent under the session of the principal that
  queued it.
- *At most once:* no queued entry is sent twice.
- *No resurrection:* after a clear completes, no cache entry written by a refresh that started
  before it exists.

**Liveness, under weak fairness.**

- Every interrupted purge is eventually completed by some tab's `recover()`.
- Every queued entry of a signed-in owner is eventually sent or abandoned.

**Acceptance.**

- `specs/tla/Tenancy.tla` with a `.cfg` checks clean under TLC at N = 3.
- Reverting each of the four fixes in the model produces a counterexample. This proves the model
  can see the bugs we already know about.
- The spec is linked from the code it models, with a comment at each modelled step, so a change
  to one flags the other.

### 2. Route overlap: soundness as a property, then exactly

**Scope.** `routesMayOverlap` and `canonicalRoute` in `libs/braid-registry/src/lib/route-scope.ts`,
and their callers in `ownership.ts`.

**Property.** If any path matches both patterns, `routesMayOverlap(a, b)` is `true`. A false
positive costs a refused publish. A false negative is a takeover.

**Steps.**

1. Property-based tests with fast-check. Generate patterns from the URLPattern pathname grammar
   (literals, `:name`, `*`, `{…}` groups, regex groups) and generate paths that match them, then
   assert soundness. These run in the existing vitest suite.
2. Optional, only if step 1 finds anything: decide overlap exactly. Compile both patterns to
   automata and test their intersection for emptiness, then cross-check `routesMayOverlap`
   against it.

**Acceptance.**

- The property passes 10,000 runs in CI.
- The property fails against the pre-fix fragment check (sample-path overlap). That proves it
  would have caught RG-1.

**Done (2026-11-04):** `libs/braid-registry/src/lib/route-scope.properties.spec.ts`. It passes
10,000 runs. Pointed once at the sampled-path overlap the fragment pierce check still uses, the
same generator found two counterexamples:

- `{/123}/pay/x-1` beside `/123/*` (the RG-1 shape);
- `/x-1/b/` beside `/x-1/b` (the sampler ignores trailing-slash tolerance).

Both stand until RG-1 is fixed. Step 2 (exact automata) is not needed for `routesMayOverlap`;
the property found nothing there.

### 3. Schema migrations and lenses: laws as properties

**Scope.** `libs/skew/src/lib/versioned.ts` and `lens.ts`, and the contract resolver.

**Properties.**

- Round trip: `up(down(x))` keeps every field the older version represents, for lossless steps.
  Steps declared `lossy` drop exactly the fields they name.
- Composition: migrating v1→v3 in one call equals v1→v2 then v2→v3.
- Prototype safety: no lens op, on any generated path, leaves `Object.prototype` changed (DS-3).

**Acceptance.**

- Each property runs under fast-check in vitest.
- The prototype-safety property fails against the unfixed `setAt`. DS-3 is not fixed yet; it is
  a P1 item, so this property lands together with that fix.

**Done (2026-11-04), except prototype safety:** `libs/skew/src/lib/lens.properties.spec.ts`.
It checks the round trip (`down(up(x))` equals `x`, nothing lossy), that no input is mutated, and
that ops steps compose on read and on `write({ as: 1 })`. Each law runs over generated lossless
op lists (rename, move, wrap, convert). Inverting `rename` the wrong way fails both round-trip
laws. The prototype-safety law waits for the DS-3 fix.

### 4. The untrusted handshake: a small model, as documentation

**Scope.** `libs/core/src/realm/sandbox-realm.ts` and `libs/core/src/weave/guest.ts`.

**Property.** The port reaches only the frame's own window, and the guest accepts a channel only
from `window.parent` on the pinned origin. The model covers ready, reply, load, frame navigation,
and a second window on the host origin.

**Why it ranks lowest.** The model is only as good as its model of the browser, and
`e2e/untrusted.e2e.ts` already exercises the real one. Do it only if item 1 has made TLA+ cheap
for us. Fold it into the same tooling.

## Tooling

- **TLA+:** `tla2tools.jar`, a pinned version with its checksum recorded, run with the Java
  already on this machine. Add `npm run verify:tla`.
- **CI:** a job that runs TLC on push and pull request when `specs/tla/**` or the modelled files
  change. It needs `actions/setup-java` pinned to a SHA, with `permissions: contents: read`.
- **fast-check:** one new devDependency, used only in spec files.

## Out of scope

- **HTML rewriter parser differentials (GW-4):** the right tool is differential fuzzing against
  parse5 or Chromium, not a proof. That gets a separate plan.
- **Codegen escaping (DS-5, RG-4):** fuzz it, and treat generated code that fails to parse as a
  bug.
- **Proving the TypeScript itself (refinement or mechanized proofs):** the model-to-code gap is
  covered by the linking comments and the counterexample-on-revert check, not by tooling.

## Risks

- **Model drift.** The model diverges from the code over time, and a green TLC run then means
  less. Mitigations: the linking comments, and the CI trigger on the modelled files.
- **State explosion.** At N = 3 with crashes, the state space may be too big for TLC.
  Mitigations: symmetry sets for tabs and users, and a bound on queue length. If that is still
  too slow, use Apalache.
- **No TLA+ experience on the team.** The first spec is the expensive one. Budget about three
  days for item 1, about one day each for items 2 and 3, and half a day for item 4.

## Order

Items 2 and 3 are done. Next is item 1,
the high-value one, in its own branch with its own CI job. Then item 4, only if item 1's
tooling earns it.
