# Federating gateways

Short version: a team that already runs its own Braid gateway can join an org-wide gateway with **one
config entry on the org side and no change on theirs**. The org gateway composes the team's fragments
into its own registry, then pierces each one straight into the org shell. There is one shell, one
piercing pass, and one realm per fragment. No shell runs inside another shell.

```ts
import { createGateway } from '@braidlabs/gateway';
import { subgraph, supergraph } from '@braidlabs/registry';

createGateway({
  registry: supergraph([
    orgManifests, // the org's own fragments, unchanged
    subgraph({
      name: 'orders',
      url: 'https://orders.internal.example.com', // the team gateway, basePath included
      registry: 'https://orders.internal.example.com/braid-registry.json', // any registry source
    }),
  ]),
  forwardCredentials: true, // only if team fragments need the user's identity, see "Credentials"
});
```

## The problem this solves

Suppose the orders team runs an ECS service that hosts Braid. Its gateway pierces `/orders/*` into
the team's own shell. Then the org wants those routes inside its own site. Without federation, the
only way is to treat the team's **shell** as a fragment:

```
org gateway ──pierces──▶ orders shell (a fragment) ──its slots──▶ orders fragments
```

That falls apart in a predictable order:

1. The org gateway fetches the team shell with `sec-fetch-dest: empty`, so the team gateway, correctly, does not pierce it.
2. The inner `<fragment-slot name="orders">` boots client-side and asks the **org** origin for
   `/__braid/doc/orders/`.
3. The org registry has never heard of `orders`, so it returns 404. The fix is to copy the team's
   manifests into the org registry by hand, re-pierce, and run two realms for one screen.

## The model, borrowed from Apollo Federation

| Apollo | Braid |
| --- | --- |
| **Subgraph:** a service that owns part of the schema | a team gateway that owns a set of fragment manifests |
| **Supergraph:** the composed schema | `supergraph([...])`: one registry made of every source |
| **Router:** plans each query across subgraphs | the org gateway, which pierces any composed fragment directly |
| **Composition errors** | a fragment id claimed twice, plus any `validateRegistry` error |
| **Static supergraph** in CI | compose once, publish a snapshot, serve it with `snapshotRegistry` |

The idea is Apollo's: **flatten at composition time, not at request time.** The org gateway knows
every fragment in the graph before a request arrives, so there is nothing left to discover at
runtime.

## How a request flows

`subgraph()` changes one field on each team manifest. It points `endpoint` at the team gateway's
raw fragment namespace:

```
team manifest    { id: 'orders', endpoint: 'http://10.0.3.17:4200', pierce: ['/orders/*'] }
in the supergraph { id: 'orders', endpoint: 'https://orders.internal/__braid/frag/orders/', pierce: ['/orders/*'] }
```

For `GET /orders/42`:

1. The org gateway matches `/orders/*`. It fetches
   `https://orders.internal/__braid/frag/orders/orders/42` alongside the org shell.
2. The team gateway's `/__braid/frag/` route is a **raw proxy**. It strips its prefix and forwards
   `/orders/42` to the team's private origin. It does not prepare or pierce anything.
3. The org gateway prepares the HTML **once**: scripts made inert, singletons renamed, and
   subresources re-rooted to the org's own `/__braid/frag/orders/…`. It then pierces that HTML
   into `<fragment-slot name="orders">` in the org shell.
4. Asset requests take the same path. A request for `/__braid/frag/orders/assets/app.js` on the org
   goes to the team gateway, which sends `/assets/app.js` to the origin.

Everything else on the manifest is the team's to declare, and arrives as written: `pierce`, `bound`,
`src`, `documentPath`, `access`, `capabilities`, `entry`. Paths on the endpoint still resolve,
because the team gateway strips its namespace first. Function endpoints and private-network
endpoints in the team's registry are fine, since the org never sees them.

## What each side does

**The team** changes nothing about its gateway. It keeps serving its own app standalone. To join, it
makes its manifests readable by the org, using any source the gateway already accepts:

- the array it passes to `createGateway`, shared as a package or a file;
- a URL that serves that array as JSON;
- a `snapshotRegistry()` loader over snapshots it already publishes with `braid registry publish`.

**The org** adds one `subgraph()` entry per team and declares slots for the team's fragment ids in
its shell (see Layout).

## Composition rules

`supergraph()` fails closed:

- **Duplicate ids.** If two sources claim the same fragment id, composition throws and names both
  owners: `fragment id "cart" is claimed by both subgraph "orders" and subgraph "checkout"`. A
  gateway that silently kept one would serve one team's fragment where another team expected its
  own.
- **Validation errors.** Any other `validateRegistry` error also fails composition, for example an
  invalid id or an invalid pierce pattern.
- **Warnings.** Warnings are logged and composition proceeds. The common one is `pierce-overlap`,
  two teams piercing the same route, which is treated exactly as it would be inside one registry.

## Credentials

The gateway strips `cookie` and `authorization` from every fragment fetch unless
`forwardCredentials` is set. In a federated graph that has two consequences:

- **Gated fragments need `forwardCredentials`.** A team fragment with `access` rules needs it on the
  org gateway. Without it, the team gateway sees every user as anonymous and refuses. That is
  fail-closed, but it is probably not what you want.
- **It applies to every endpoint.** `forwardCredentials` covers the whole registry. Turn it on only
  when every endpoint in the graph should receive the user's cookies.

`access` rules are copied as data, so the org gateway also enforces them at its edge (it needs a
`principal` resolver that understands the same identity). The team gateway stays authoritative:
even a caller the org lets through is checked again by the team.

## Availability: compose ahead of time in production

`supergraph()` loads every source when the gateway first needs its registry. If one team's registry
is unreachable at that moment, the org registry fails, and it keeps failing until that team
recovers, because the gateway does not cache a failed load.

So in production, compose at build or deploy time and serve a snapshot:

```ts
// in CI or a deploy step
const snapshot = await createSnapshot({ manifests: await supergraph([...])() });
await store.put(snapshot);

// in the org gateway
createGateway({
  registry: snapshotRegistry({ store, pinned: process.env.BRAID_SUPERGRAPH, cache: fileSnapshotStore({ directory: '/var/cache/braid' }) }),
});
```

A composition error then fails CI instead of a deploy, the running gateway serves exactly the graph
that was reviewed, and `snapshotRegistry`'s last-known-good cache covers a store outage. This is the
same reason Apollo recommends a static supergraph over composing at runtime.

## Layout

Pierced content goes into the `<fragment-slot>` whose `name` is the fragment id. If the org shell
has no such slot, the content lands just before `</body>`. So the org shell declares a slot for each
team fragment id it routes to.

Team chrome that used to live in the team shell, such as a sub-navigation, becomes a fragment of its
own. Register it as `bound: false` with a `src`, and give it a slot.

## Caveats

- **Two proxy hops per asset.** Requests go org gateway → team gateway → origin. Put a CDN in front
  of the org gateway and cache `/__braid/frag/*` there (see [CDN and deployment](/braid-cdn)).
- **`x-forwarded-host` is the org's on the first hop only.** The team gateway overwrites it unless it
  sets `trustForwardedHeaders`. Team fragments that build absolute URLs from it see the team's host.
- **Relative redirects.** A fragment using `redirect: 'navigate'` that answers with a relative
  `Location` resolves against the team gateway's origin. Allow that origin in the org's
  `redirectOrigins`, or redirect with absolute URLs.
- **No loop guard.** A team manifest whose endpoint points back at the org gateway's
  `/__braid/frag/` recurses until the fragment timeout. Composition never produces this; only hand
  configuration can.

## Not in this version

- Runtime polling or managed federation. Restarting to re-pin is the model, as it is for any
  registry.
- A subgraph export endpoint on the team gateway, such as `/__braid/graph`.
- Renaming or prefixing fragment ids, and rewriting route paths.
- Nested piercing, or composing a team's shell as a fragment.
- A direct-to-origin mode that skips the team gateway.
