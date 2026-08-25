# Trust tiers: what Braid's boundary actually enforces

Braid composes fragments at two different boundaries. They are not a fast path and a safe path, or
a default and an advanced option. They are **different bets**, and choosing between them is the most
consequential decision you will make about a fragment.

This document exists because Braid's other documentation has, in places, described the trusted tier
in language that implies more than it delivers. The correction, stated plainly:

> **The trusted tier is namespace isolation, not a security boundary.** It protects one application
> from another application's runtime *accidents*. It does not protect one application when another
> application's runtime has gone *bad*.

---

## The two tiers

| | **Trusted** (default) | **Untrusted** |
| --- | --- | --- |
| Mount | `<fragment-slot name="checkout">` | `<fragment-slot trust="untrusted" src="https://…">` |
| Realm | hidden same-origin iframe | visible cross-origin iframe |
| Where its DOM lives | **projected into the host document**, in a shadow root | its own document |
| Isolation | JS globals, module registry, framework identity | browser-enforced: Same-Origin Policy, sandbox, Permissions-Policy |
| Cookies & storage | **the host's** | its own, partitioned |
| Layout | participates in host layout | a rectangle the host sizes |
| Accessibility | one tree | nested documents |
| Overlays | can escape the fragment's box | clipped by the frame |
| Printing & selection | normal | frame-bound |
| SSR piercing | yes — fragment HTML in the host's first response | no |
| Gateway | required for compat mode | **not involved at all** |
| Zero app-code change | yes, via the compat adapter | no — the fragment calls `connectToBraidHost()` |

Everything in the trusted column below "where its DOM lives" is a *consequence* of sharing a
document. None of it survives a boundary the browser enforces. The untrusted tier gives up all of it.

## What the untrusted tier is

**An iframe with a good protocol on it.**

That is not a diminishment. The protocol is the part that makes an iframe usable as a composition
primitive rather than an escape hatch: a pinned handshake, contract negotiation before any state
crosses, liveness that can tell a hung fragment from a hidden tab, and a teardown that lets a
fragment flush unsaved work before it is disposed. All of that is shared with the trusted tier —
the same `weave` transport carries both.

What the untrusted tier adds is the only thing the trusted tier cannot: **separation that holds when
the code on the other side is hostile, compromised, or merely has a compromised dependency.**

## Choosing

Use the **trusted** tier when every fragment on the page belongs to the same security principal —
your own teams, your own code, deployed independently but trusted equally. This is the case Braid is
best at, and its advantages are real: seamless layout, one accessibility tree, server-composed first
paint, and zero-change adoption of applications you cannot modify.

Use the **untrusted** tier when that sentence stops being true:

- a third-party widget, analytics vendor, or embedded product;
- an acquired system whose code you have not audited;
- a plugin surface open to authors you do not employ;
- any fragment where a compromised dependency should not become a compromised session.

**Registering a trusted fragment grants it the user's session.** Its realm is same-origin, so it
shares the host's cookies and storage, and its DOM is in the host's document. If that sentence is
uncomfortable for a given fragment, that fragment belongs in the untrusted tier.

## Using the untrusted tier

Host:

```html
<fragment-slot
  name="vendor-analytics"
  trust="untrusted"
  src="https://vendor.example.com/widget"
  allow="clipboard-write"
  sandbox="allow-popups">
  <p slot="fallback">Analytics are unavailable.</p>
</fragment-slot>
```

```ts
initBraid({
  capabilities: {
    'vendor-analytics': {
      // Only these keys enter the fragment's mirror. Every other key is not merely withheld —
      // the fragment is never told it exists or when it changes.
      context: { read: ['locale'] },
      permissions: ['clipboard-write'],
    },
  },
});
```

Fragment, at its own origin:

```ts
import { connectToBraidHost } from '@braidlabs/core';

const session = await connectToBraidHost({
  hostOrigin: 'https://portal.example.com',
  contract: { version: '1.0.0', requires: { host: '>=1.4.0' } },
});

session.context.subscribe('user', renderUser);
session.onClosing(() => flushImpressions());
session.emit('impression', { slot: 'sidebar' });
```

### What is enforced, and by whom

| Control | Enforced by | Notes |
| --- | --- | --- |
| DOM, storage, cookie separation | **the browser** (Same-Origin Policy) | the reason this tier exists |
| `sandbox` tokens | **the browser** | `allow-scripts allow-forms` by default; additions are host-declared |
| `allow=` features | **the browser** (Permissions-Policy) | a deny list: unlisted features are unavailable in the frame |
| `credentialless` | **the browser**, where supported | ephemeral storage, so a fragment cannot correlate the user across sites |
| Origin pinning | **Braid**, both directions | the host posts to an exact origin; the guest accepts from one |
| Contract terms | **Braid** | negotiated before state crosses |
| Context grants | **Braid** | `capabilities.context.read`; an ungranted key is not mirrored and sends no change notification |

### Two refusals worth knowing about

**A same-origin `src` is refused.** `sandbox="allow-scripts allow-same-origin"` on a same-origin
frame is a sandbox that is not one: the framed document can reach into the host and remove its own
sandbox attribute. The markup looks locked down while it happens, so Braid refuses at the source
rather than trusting the token list.

**`allow-top-navigation` is never granted.** It is the standard route from "embedded widget" to
"phishing redirect". Use `allow-top-navigation-by-user-activation` if the fragment genuinely needs
to navigate the page.

## What is still missing

Named here rather than left to be discovered:

- **Context `write` grants.** No fragment can publish to the bus today, so `capabilities.context.write`
  is reserved and unenforced. `read` is enforced.
- **No DOM projection, by design.** If you need a fragment's content to participate in host layout,
  escape its box, or appear in the host's server-rendered HTML, it belongs in the trusted tier. This
  is not a gap to be closed later — it is the trade.
- **Cross-origin authentication is your problem.** The trusted tier's smooth session sharing comes
  from being same-origin. Here, third-party cookie restrictions and separate sessions are real
  architecture questions, and Braid does not answer them for you.
