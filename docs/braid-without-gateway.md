# Can Braid be used without the gateway?

Short answer: **you never need to deploy a separate gateway service, but compat-mode fragments do
need the gateway's code running somewhere on the host origin.** Which of those you were asking
usually decides the answer, so this document separates them.

---

## "Do I have to run a gateway as its own service?"

No. `@braidlabs/gateway` is a library, not a server. It is middleware inside the server you
already run:

```ts
app.use(toNodeMiddleware(gateway)); // Express, NestJS, Connect, Vite
export default toFetchHandler(gateway, appHandler); // Workers, Deno, Bun, h3/Nitro
```

There is no extra process, port, container, or deployment. The [gateway
README](https://github.com/braidjs/braid/blob/main/libs/braid-gateway/README.md) has the binding for each framework.

If you *cannot* modify the origin server — the classic legacy-monolith case — run the gateway as
an edge worker or reverse proxy in front of it instead. The monolith stays untouched; the gateway
just needs to see requests before it does. That is the arrangement the architecture calls
"origin-front middleware", and it is the same library either way.

---

## "Can I use the client with no gateway code at all?"

For **compat mode — the default adapter — no.** This is structural, not an omission.

A compat fragment's whole value is that unmodified code believes it owns the browser, which means
its `location` and `history` must be truthful. That forces the realm to boot from a real `http:`
URL: `history.replaceState` may only rewrite a document's URL within its own origin and scheme, so
a `blob:` or `srcdoc:` realm can never present itself as `https://yourapp/billing/invoices`. A real
URL means something must serve it.

What the gateway serves that the client cannot manufacture:

| Need | Why the client can't do it |
| ---- | -------------------------- |
| The realm stub at `/__braid/frag/:id/…` | must be a real same-origin URL (above), carrying the protocol version and the fragment's `<base>` |
| The fragment's document, prepared | singleton renaming, script neutralization, and subresource re-rooting must happen before the markup reaches the host's DOM |
| Namespace routing | strips `/__braid/frag/:id` and forwards to the fragment's endpoint, so the endpoint sees the paths it serves standalone |

Without them the client fails loudly rather than half-working: the realm stub check produces a
named `BraidError { stage: 'realm-boot' }` telling you the gateway is not mounted.

### What a hand-rolled replacement would have to provide

If you genuinely cannot use the library, this is the contract — but you are reimplementing the
gateway, and the protocol version is checked, so you inherit the maintenance:

1. `GET /__braid/realm/:id/` → an HTML stub containing
   `<meta name="braid-protocol" content="2">`, `<meta name="braid-adapter" content="compat">`,
   and a `<base>` (the client points it at `/__braid/frag/:id/<route>` once the stub loads). Older
   clients request `/__braid/realm/:id/<route>` and expect that `<base>` from the server.
2. `GET /__braid/doc/:id/<route>` → the fragment's HTML, with `<html>`/`<head>`/`<body>` renamed
   to `braid-*`, every `<script>` neutralized to `type="inert"` with the real type in
   `data-script-type`, inline `on*` handlers stripped, and subresource URLs re-rooted into
   `/__braid/frag/:id/`.
3. `GET /__braid/frag/:id/*` → forwarded to the fragment's origin with the prefix removed.

None of the three may depend on a request header — that property is what makes them cacheable
without CDN configuration, and clients rely on it.

Use the library.

---

## The one mode that needs no server: contract-blob realms

Contract-mode fragments do not maintain any illusion — they receive `env.location` and
`env.document` instead of reading globals — so their realm has nothing to be truthful about. Those
realms boot from a `blob:` URL the runtime authors itself: no network round trip, no stub, no
server involvement, and zero interaction with the joint session history.

This works today and is verified (same-origin, DOM-capable, per-realm import maps, no history
entries). What does **not** exist yet is a contract adapter for any framework, so nothing routes
to it in normal use — you can create such a realm directly, but you cannot yet mount a React or
Angular app into one.

When contract adapters land, a genuinely gateway-free deployment becomes possible for fragments
whose entry module and assets are absolute URLs to their own origin (with CORS). You would give
up namespace routing, server-side piercing, and the manifest registry — the fragment would be a
module you load, not a URL you compose. That is a real trade, and for a legacy app it is not
available at all, because legacy apps are exactly the ones that cannot be handed an `env`.

---

## Choosing

| You want to… | Gateway needed? | How |
| ------------ | --------------- | --- |
| Compose an unmodified legacy app | Yes, as middleware or an edge proxy | compat adapter, the default |
| Avoid a separate deployment | Not a separate one | mount the library in your existing server |
| Compose an app whose server you can't touch | Yes, in front of it | edge worker / reverse proxy |
| Skip server-side rendering of fragments | No — piercing is optional | omit `pierce` from the manifest; the slot fetches instead |
| Load a modern app with no server component | Not yet | contract-blob realms exist; contract adapters do not |

Piercing being optional is worth restating: dropping `pierce` from a manifest costs you the
server-rendered first paint and nothing else. The fragment boots client-side and everything in
this document still applies.
