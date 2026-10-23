# @braidlabs/core

The Braid client runtime — compose independently deployed frontend apps into one cohesive page:
one origin, one DOM, one accessibility tree, while each app keeps its own JavaScript world, its
own dependencies, and its own release train.

Skew handling — versioned envelopes, migration chains, and negotiation — lives alongside this
runtime in [`@braidlabs/skew`](../skew).

**Start with [Braid, explained](../../docs/braid-explained.md)** if you are new to this: it defines
every term this README uses and walks one page load end to end. The founding architecture and its
rationale live in [`docs/braid-architecture.md`](../../docs/braid-architecture.md).

Also see: [failure modes](../../docs/braid-failure-modes.md) ·
[working POC](../../docs/braid-poc.md) ·
[using Braid without the gateway](../../docs/braid-without-gateway.md)

## Adapters in this build

| Adapter | Manifest | For | Needs a document? |
| --- | --- | --- | --- |
| `compat` | omit `adapter` — this is the default | whole apps that cannot be modified | yes |
| `custom-element` | `"adapter": "custom-element"` | a fragment that *is* a web component | no |

The **compat adapter** is the contained emulation layer for apps that cannot be told anything
(a legacy monolith mid-migration), and it is the default: a manifest that doesn't declare an
adapter gets it. Being a fragment requires zero app-code changes; config only.

The **custom-element adapter** is the other end of the spectrum, and the first adapter to use the
contract surface. Registering a fragment that already ships a custom element takes three manifest
fields and no emulation at all:

```ts
{ id: 'rating', endpoint: 'http://localhost:4503',
  adapter: 'custom-element', entry: '/star-rating.js', element: 'star-rating',
  events: ['rating:change'] }
```

The element is created **inside the realm**, where it upgrades against the fragment's own
definition, then moved into the host's DOM — adoption across documents preserves the element's
class, so the fragment's implementation keeps running while its custom element registry stays out
of the host's. `env.props` are applied as DOM properties; the listed `events` are republished as
`braid:event` on the slot. Such a fragment serves no document at all, which is what
`needsDocument: false` on the adapter declares.

The rest of the contract surface (`FragmentEnv`, `BraidAdapter`) is defined and exported, and
**contract-blob realms work** (see below), but no framework contract adapters (react/angular/vue)
ship yet, so nothing routes to them automatically.

## Realms

| Kind            | URL              | History involvement                        | Used by         |
| --------------- | ---------------- | ------------------------------------------ | --------------- |
| `compat-http`   | `/__braid/frag/…`| initial load only (`replaceState` after)   | compat adapter  |
| `contract-blob` | `blob:`          | none, ever                                 | contract adapter (`adapter="contract"`) |
| `sandbox`       | third-party      | —                                          | untrusted tier, via `createSandboxRealm()` |

Contract-blob realms boot from a `blob:` URL the runtime authors: no network round trip, no
gateway stub, and zero interaction with the joint session history. Each carries a `<base>`: the
fragment's namespace by default, or the entry module's directory for a fragment loaded with no
gateway. Two fragments can ship different majors of the same dependency because each realm
evaluates its own copy. `createRealm()` also accepts a per-realm import map, but nothing exposes
it to fragment authors yet.

Verified empirically in Chromium: same-origin and DOM-capable, five realms add
**zero** history entries, per-realm import maps resolve, module evaluation works, and globals do
not leak between realms. Firefox and WebKit remain unverified here.

**Known platform limitation.** `window.location` and `document.location` are
`[LegacyUnforgeable]` — own, non-configurable properties that cannot be intercepted in any
realm, including one we authored. So the dev-mode guidance toward `env.*`
covers `document` members but *cannot* cover `location`: a contract fragment reading `location`
silently gets the blob URL. This is the same platform rule that stops a blob document from
faking an http URL, and it is why compat mode keeps http realms.

## Piercing

When the gateway server-renders a fragment into the page, `<fragment-slot>` **adopts** that
content instead of fetching: the slot detects the declarative shadow root the gateway wrote,
and the compat adapter activates the already-neutralized content in place. `reload()` always
goes back to the network.

## Usage

Host page:

```ts
import { initBraid } from '@braidlabs/core';

initBraid({
  // wire your router so bound fragments observe host navigations (Braid never patches
  // the host History API — host purity is an invariant, not a mode):
  onHostNavigation: (notify) => router.afterEach(() => notify()),
});
```

```html
<fragment-slot name="legacy-billing"></fragment-slot>
```

Server: mount [`@braidlabs/gateway`](../braid-gateway) in front of your app and register a
manifest for `legacy-billing`. No fragment code is required.

## What the compat adapter does

- Boots each fragment's JS in a hidden same-origin iframe realm loaded from the gateway
  namespace (`/__braid/frag/:id/…`), restoring the fragment's route-url illusion via
  `history.replaceState`.
- Installs the document facade: a Proxy spliced into the realm document's prototype chain,
  driven by a generated WebIDL audit manifest — unaudited API use surfaces as loud diagnostics
  in dev mode.
- Confines all main-realm interception to the fragment boundary: per-node prototype stamping,
  born-inert scripts, and a shadow-root-scoped observer safety net.
- **Never patches a host-page global or prototype. In any mode. Ever.**

## Isolation boundaries

| Scope                   | Isolation mechanism                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| compat realm (window)   | constructor `hasInstance`, observer/CSSOM constructor swaps, size getters, history proxy |
| compat realm (document) | proxy facade over the document prototype chain (WebIDL-audited)                          |
| fragment DOM nodes      | per-node prototype stamping (insertion/clone/ownerDocument/getRootNode)                  |
| fragment scripts        | born-inert `type` shadowing traps until activation                                       |

All interception is strictly confined to the fragment's own realm and shadow DOM boundary.
