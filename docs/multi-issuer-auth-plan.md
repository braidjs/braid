# Multi-issuer auth isolation for trusted fragments — plan

Status: approved · Packages: `@braidlabs/core`, `@braidlabs/gateway`

## Problem

Trusted (compat) fragments share the host origin. When fragments use different OIDC authorization
servers, or need different groups, their auth state collides in three places:

1. **Web Storage.**
   - Every realm's `localStorage`/`sessionStorage` *is* the host's, so clients with fixed default
     keys (okta-auth-js `okta-token-storage`, transaction and PKCE keys) overwrite each other.
   - Their sync listeners react to `storage` events, which reach other realms on the page.
2. **Session cookies.**
   - Authorization-code flows that finish server-side (a BFF, or an OIDC proxy plugin) set a
     session cookie on the origin. Two backends both setting `session; Path=/` overwrite each
     other, and concurrent logins race on state cookie names.
   - The gateway passes fragment `Set-Cookie` through unchanged (`gateway.ts:935`, `:854`).
   - With `forwardCredentials`, every fragment backend receives every other fragment's session
     (`gateway.ts:400-410`).
3. **Messages.** Measured in P1 (results below): each listener style misses half the replies,
   and a relative iframe `src` set by fragment code loads from the host page.

`FragmentCapabilities.storage: 'partitioned' | 'shared'` already exists, and is reserved for this
(`weave/capabilities.ts:46`, registry manifest, passed through to the realm stub). This plan
implements it. **One flag drives both halves**, client storage and gateway cookies. Default stays
`'shared'`; nothing changes for fragments that don't opt in.

## Phases

### P1 — Probe

A Playwright suite against real Chromium and a real gateway (`e2e/auth-probe.e2e.ts`, run by
`npm run e2e` and its own CI job; the setup is shared with the loading-state and OTel browser
checks, by decision). Each test pins today's behaviour, so the fix that changes one flips it.

#### Results (Chromium 141, Playwright 1.56.1)

| Question | Result |
| --- | --- |
| Realm `localStorage` is an own, configurable accessor on the realm window | **yes** — a per-realm override is possible |
| Two fragments with default keys: last writer wins for both | **yes** — confirmed collision |
| A realm's `addEventListener('storage')` hears another fragment's writes | **yes** — via the host-window relay |
| A realm's `window.onstorage` hears another fragment's writes | **yes** — natively: browsers fire `storage` at every same-origin window, realms included |
| Hidden iframe in the fragment DOM → `parent.postMessage` → `addEventListener` | **delivered** |
| …the same reply → `window.onmessage =` | **lost** (it lands on the host window) |
| Popup → `opener.postMessage`, and a self-post → `addEventListener` | **lost** (they land on the realm window) |
| …the same → `window.onmessage =` | **delivered** |
| Relative `src` on an iframe created by fragment code | **resolves against the host page**, so the reply never comes |

#### Decisions from the results

- **P2 filters `storage` events in both places:** the host-window relay *and* native events on
  the realm window (`onstorage` and any native listener).
- **P4 is needed,** with three parts:
  - deliver realm-window messages (popup replies, self-posts) to compat listeners;
  - deliver host-window messages to `window.onmessage`;
  - resolve relative URLs on elements fragment code creates against the fragment's base.

Not covered here, and proven in P3's gateway specs instead: cookie collisions, which are
deterministic HTTP semantics.

- [ ] Overriding a realm window's `localStorage`/`sessionStorage` with `defineProperty` before
      its first script works. A realm script sees the override, and the host is untouched.
- [ ] Storage events, each answered yes or no: a realm write reaches the host window, reaches the
      writer's own compat listener (echo), and reaches a second realm's listener.
- [ ] Four message styles, each recorded as delivered or lost:
      - a hidden iframe in the fragment DOM posting to `parent`, caught by `addEventListener`;
      - the same reply caught by `window.onmessage =`;
      - a popup posting to `opener`;
      - a realm posting to itself.
- [ ] The table ends with two decisions: whether P4 is needed, and whether `onstorage` needs
      handling.

Cookie collisions are deterministic HTTP semantics, so they are proven by gateway specs in P3,
not by the browser.

### P2 — Storage partitioning (core)

`capabilities.storage` takes `'shared'` (default), `'partitioned'` (keyed by fragment id), or
`{ partition: name }`. Fragments naming the same partition share it, which is how two fragments
using one issuer keep a single login.

- `libs/core/src/compat/storage-partition.ts` builds a Proxy view over the native store with the
  prefix `braid:storage:<encodeURIComponent(id)>:`.
  - Methods, `length`, `key(i)` and `clear()` see only own keys.
  - Named-property access works (`ls.foo`, `Object.keys`).
  - `instanceof Storage` holds.
- Installed with `defineProperty` on the realm window next to the `navigator` patch
  (`realm-patches.ts:123`), before any fragment script runs, only when
  `capabilities.storage === 'partitioned'` on the compat tier.
- `storage` events in the existing `mainProxyListener` are handled through the existing
  `eventPatch` (which already overrides `target` and `currentTarget`):
  - events from other partitions, and unprefixed events, are dropped;
  - `key` is stripped of the prefix;
  - `storageArea` becomes the view.

Acceptance criteria (each spec written first and seen failing):

- [ ] A and B are both partitioned, and A runs `setItem('k','a')`. B's `getItem('k')` and the
      host's are `null`, and the real store holds exactly `braid:storage:A:k`.
- [ ] In A, `length`, `key(i)`, `Object.keys` and `localStorage.k` see only A's keys. `clear()`
      leaves B's keys and the host's keys alone. The same holds for `sessionStorage`.
- [ ] A fragment's first inline script already writes into its partition.
- [ ] Shared, unconfigured, untrusted and contract fragments behave byte-for-byte as before.
- [ ] A's storage listener fires for writes to A's partition with the key unprefixed and
      `storageArea` set to A's view. It does not fire for B's writes or for unprefixed host
      writes.
- [ ] The same holds for `window.onstorage`. A listener attached by calling the original
      `EventTarget.prototype.addEventListener` deliberately bypasses the filter, which is acceptable
      for an accident barrier and documented.
- [ ] Two fragments with `storage: { partition: 'kcd' }` see each other's keys, and a third
      fragment does not.
- [ ] `CI=1 npx nx run-many -t lint test build` passes, with no new dependency.

### P3 — Cookie scoping (gateway, plus the realm's `document.cookie`), one PR in two commits

The two halves ship together. Gateway renaming alone would hide script-readable cookies (CSRF
tokens) from the fragment's own JS.

- **Outbound.** Applies on namespace responses, `/__braid/doc/` and the 409 redirect. A
  partitioned fragment's `Set-Cookie` name becomes `braid$<encodeURIComponent(id)>$<name>`:
  - a leading `__Host-` or `__Secure-` prefix is kept;
  - `Domain` is dropped and `Path=/` is forced;
  - deletions are renamed the same way;
  - a fragment can never set another fragment's cookie.
- **Inbound.** Applies to namespace, pierce and websocket upgrade requests, and runs before the
  single-flight key is computed. A partitioned fragment receives its own cookies with the prefix
  removed. With `forwardCredentials`, it also gets unscoped host cookies. It never gets another
  fragment's cookies. Its own cookies are forwarded even without `forwardCredentials`, because its
  own backend set them.
- **Realm `document.cookie`** for partitioned fragments: writes are scoped. Reads return the
  fragment's own cookies, unprefixed, plus unscoped host cookies.

Acceptance criteria: gateway specs for each rename rule, including the prefix and injective
encoding; an inbound table test; two concurrent requests with different scoped sessions never
coalesce; the existing 374 gateway specs pass unchanged; and core specs for the cookie view.

### P4 — Message delivery and relative URLs (confirmed by P1)

- Messages dispatched at the realm window (popup `opener` replies, self-posts) reach compat
  `addEventListener('message')` listeners.
- Host-window messages reach `window.onmessage`.
- Each arrives exactly once. `event.source` and `event.origin` stay unchanged, so the library's
  own origin checks still apply.
- A relative `src` on an iframe created by fragment code resolves against the fragment's base.
- The P1 tests for these flip.

### P5 — Mount prerequisites

- `initBraid({ prerequisites: { [key]: (key, { signal }) => 'ready' | 'not-entitled' } })` plus a
  manifest `requires: string[]`.
- Resolution runs concurrently with realm creation and the document fetch, and is gated before
  `adapter.boot`. There is one in-flight call per key.
- `not-entitled` renders through the existing fallback path. A throw goes through the existing
  error path.
- A docs recipe covers mapping groups to `Principal.roles` and `access.fetch.roles`, and the
  per-route session cookie names an edge proxy needs.

### Later — gateway-held cookie jar

The browser holds one gateway cookie. Upstream fragment cookies are stored server-side, keyed by
(session, fragment). This is the fix for cookie header growth and for "no session cookies in the
browser" policies.

## Known limits (documented)

- **Not a security boundary.** Same-origin code can still reach `top.localStorage` and the raw
  cookie jar. This stops accidents, not attackers.
- **SSO between fragments.** Two fragments that share an issuer no longer share tokens; each logs
  in once — unless they share a named partition (`storage: { partition: 'kcd' }`), which P2
  adds for exactly this.
- **Requests must go through the gateway.** Cookie scoping works only for requests that traverse
  the gateway namespace. A fragment calling the host origin directly gets renamed cookies its
  backend won't recognise. P3 adds a check that fragment requests, including the OIDC callback,
  land in the namespace.
- **Edge proxies.** Cookies set by a proxy *in front of* the gateway are never renamed. The fix
  there is per-route cookie names (docs recipe).
- **Header size.** Every scoped cookie rides every request; the later cookie jar is the fix.
- **Uncovered storage.** IndexedDB, Cache Storage, BroadcastChannel and Web Locks are not
  partitioned.
