# Federated gateways (a Braid supergraph) — plan

Status: approved for build · Branch: `feat/gateway-federation` · Package: `@braidlabs/registry`

## Problem

A product team runs Braid in its own ECS webapp. Their gateway serves a set of routes, each one a
fragment. Later the team wants those routes to appear inside a larger, org-wide Braid gateway.
Today the only way is **shell-within-a-shell**:

```
org gateway ──pierces──▶ team shell (as a fragment) ──its own slots──▶ team fragments
```

The org gateway fetches the team shell with `sec-fetch-dest: empty`, so the team gateway does not
pierce. The inner `<fragment-slot name="orders">` then boots client-side and asks the **org**
origin for `/__braid/doc/orders/`. The org registry has never heard of `orders`, so the request
404s. Fixing that means re-piercing, hand-copying manifests, and running two realms per screen.

## Inspiration: Apollo Federation

| Apollo                                           | Braid                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| subgraph: a service that owns part of the schema | a team gateway that owns a set of fragment manifests                     |
| supergraph: the composed schema                  | the composed manifest array, which is a plain `RegistrySource`           |
| router: plans queries across subgraphs           | the org gateway, which pierces any composed fragment directly            |
| composition errors (type conflicts)              | duplicate fragment ids, failing closed, plus `validateRegistry` findings |
| static supergraph in CI, managed federation      | compose, then `createSnapshot` + `snapshotRegistry` with last-known-good |

The key move is the same as Apollo's: **flatten at composition time, not at request time.** The
router knows every fragment in the graph, so a page has one shell, one piercing pass, and one realm
per fragment.

## Design

```ts
// org gateway
import { subgraph, supergraph } from '@braidlabs/registry';

createGateway({
  registry: supergraph([
    orgManifests, // the org's own fragments, unchanged
    subgraph({
      name: 'orders',
      url: 'https://orders.internal.example.com', // the team gateway, basePath included
      registry: 'https://orders.internal.example.com/braid-registry.json', // any RegistrySource
    }),
  ]),
  forwardCredentials: true, // team access rules need the user's identity — see Credentials
});
```

- **`subgraph({ name, url, registry })`** loads the team's manifests from any existing
  `RegistrySource` (an array, a JSON URL, a snapshot loader or a function). It rewrites every
  endpoint to `<url>/__braid/frag/<id>/`. The org gateway then proxies **through** the team gateway:
  - The team's fragment origins stay private inside their VPC.
  - Function and localhost endpoints in the team's registry never have to be published.
  - The team gateway's `/__braid/frag/` route is a raw proxy, so the HTML is prepared and pierced
    exactly once, by the org gateway.
  - Relative `entry` URLs re-root through the same namespace.
- **`supergraph(sources)`** concatenates the sources and returns a `RegistrySource`:
  - A fragment id found in two sources throws, naming both subgraphs.
  - The merged list then goes through `validateRegistry`. Error findings throw and warnings
    (such as pierce overlaps) are logged.
  - Every error fails closed, so a broken composition never silently serves one team's fragment
    in place of another's.
- **The team side needs no gateway change.** The team gateway keeps serving its own app
  standalone. To join the graph it publishes its manifests somewhere the org can read them,
  through any existing registry source.
- **`createGateway` is untouched.** The supergraph is just a registry.

### Credentials

The gateway strips `cookie` and `authorization` before every fragment fetch unless
`forwardCredentials` is set (`gateway.ts:787`). Without it, the team gateway sees every user as
anonymous, so the team's `access.fetch` rules deny gated fragments. That is fail-closed, but it is
probably not what you want.

The `access` rules are copied as data, so the org gateway also enforces them at the edge. The team
gateway stays authoritative.

`forwardCredentials` applies to the whole registry, so turn it on only when every endpoint in the
graph is trusted with the user's cookies.

### Availability

`Registry` doesn't cache a failed load. With runtime composition, one unreachable team keeps the
org registry failing until that team recovers. For production, compose in CI or at deploy time
with `createSnapshot(await supergraph([...])())` and serve that snapshot with `snapshotRegistry`,
which keeps a last-known-good copy. This is the same reason Apollo recommends a static supergraph.

### Layout

Pierced content goes into the `<fragment-slot>` whose `name` matches the fragment id. The org shell
therefore declares slots for team fragment ids, or the content lands just before `</body>`. Team
chrome, such as a sub-nav, can be registered as a `bound: false` fragment of its own.

## Tasks

1. `libs/braid-registry/src/lib/supergraph.ts`: `subgraph()` and `supergraph()`, exported from
   `index.ts`. Unit specs cover the endpoint rewrite, a duplicate id across subgraphs throwing with
   both names, an overlap surfacing as a warning, and team function/localhost endpoints being
   tolerated.
2. A two-gateway integration spec: the org gateway sits in front of a real `createGateway` team
   gateway, and the team's fragment origin is a fetch function.
3. `docs/braid-federation.md`, plus a sidebar entry and links from the gateway and registry
   package docs.

## Acceptance criteria

- [ ] Org config is one `subgraph({ name, url, registry })` entry inside `supergraph([...])`. Team
      config is unchanged.
- [ ] A document request to the org gateway for a team route pierces the team fragment once: the
      team shell's `next` is called 0 times, and there is exactly one `shadowrootmode` template for
      it.
- [ ] Fragment assets load through the org path `/__braid/frag/<id>/…`. The team fragment origin
      receives the unprefixed path.
- [ ] A fragment id duplicated across subgraphs makes the registry load reject with an error naming
      both subgraphs.
- [ ] The team's `access` rules hold through the org gateway: an anonymous user is denied, and a
      user forwarded with credentials and the required role is allowed.
- [ ] The registry and gateway suites pass, and `gateway.ts` is unchanged.

## Out of scope

- Runtime polling or managed federation. Restarting to re-pin is the existing model.
- A `/__braid/graph` subgraph-export endpoint (see Disagreements).
- A `braid graph compose` CLI. Composition is a function call, and `braid registry publish` already
  ships snapshots.
- Nested piercing, id prefixing or renaming, and route rewriting.
- A direct-to-origin mode that skips the team gateway hop.
- Per-fragment credential forwarding.

## Disagreements recorded

- **Planner vs simplifier on `/__braid/graph`.** The planner wanted an opt-in endpoint on the team
  gateway that exports full manifests, so that function endpoints and drift are handled live. The
  simplifier cut it: `subgraph()` overwrites endpoints anyway, and any registry source works.
  **Built: the simplifier's version.** Revisit if teams report drift between what their gateway
  serves and what they publish.

## Discovered

- **No hop or loop guard.** A team endpoint pointing back at the org gateway's `/__braid/frag/`
  would recurse until the per-fragment timeout. Composition can't create this, only hand
  configuration can. A candidate fix is an `x-braid-via` header with a 508 response.
- **A generic route-outlet slot** would remove the need to name a slot per fragment id. This is
  the obvious follow-up.
- **`x-forwarded-host`** is overwritten by the team gateway unless it sets
  `trustForwardedHeaders`. Team fragments that build absolute URLs will therefore see the team
  host.
- **Two proxy hops per asset** (org gateway, then team gateway, then origin). A CDN in front of
  the org gateway matters more in this topology.
