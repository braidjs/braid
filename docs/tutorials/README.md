# Braid tutorials

Hands-on, step-by-step introductions to each package. Every tutorial builds
something small and real, uses only public API, and ends with the failure it
protects you from — reproduced, not described.

They run in three movements. **Composition** first, because that is what Braid
is; then **data versioning**, because independently deployed apps disagree about
shapes; then **state management**, because what they disagree about has to live
somewhere.

New here? Read [Getting started](../getting-started.md) first — it puts a
fragment on a page in about ten minutes. Then take Tutorial 1.

## Composition

| #   | Tutorial                                 | Package                                  | You will build                                                                                                         |
| --- | ---------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | [Compose without colliding](01-braid.md) | `@braidlabs/core` · `@braidlabs/gateway` | An enterprise microfrontend shell with server-side piercing, isolated iframe realms, and zero-blast-radius degradation |

## Data versioning

| #   | Tutorial                                       | Package            | You will build                                                                                                     |
| --- | ---------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 2   | [Version the data, not the deploy](02-skew.md) | `@braidlabs/skew`  | A draft schema that survives three shape changes, migrates in both directions, and refuses dishonestly-shaped data |
| 3   | [Give your build a name](03-build.md)          | `@braidlabs/build` | A stamped build identity, a served manifest, a stale-origin detector, and generated frozen types                   |

## State management

| #   | Tutorial                                                    | Package                   | You will build                                                                                                                                                                                             |
| --- | ----------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | [Client storage that survives a reload](04-data-storage.md) | `@braidlabs/data`         | A framework-free cache on IndexedDB — shared across apps, invalidated by tag, with a durable queue for writes the network never took                                                                       |
| 5   | [Versioned stores, the Angular way](05-angular-core.md)     | `@braidlabs/angular-core` | A draft editor on DI + Signals with zero flicker and typed failure states                                                                                                                                  |
| 6   | [One graph, durable writes](06-angular-data.md)             | `@braidlabs/angular-data` | A normalized fund list with optimistic, outbox-durable order submission                                                                                                                                    |
| 7   | [Build a storefront, end to end](07-storefront.md)          | `@braidlabs/data`         | The whole layer in build order — guest and customer partitions, a shared catalogue, orders that survive the network dropping, a shipping event pushed from the server, and a sign-out that destroys it all |

Tutorials 1–6 take one package at a time. **Tutorial 7 is the one to read if you
want to build something end to end**: it uses the whole data layer in the order
you would actually build it, rather than feature by feature.

**Read them in the demo.** These pages are also served inside the federated
demo apps — the remote exposes a `./Tutorials` module and the host routes to
it at `/tutorials`, so the tutorials themselves cross the same deployment
boundary they teach about:

```sh
npm run demo:prod        # host → http://localhost:4410/tutorials
```

Screenshots are captured from that demo. When a step says "watch the
inspector", the Basics tab of the running host is the best companion — every
claim here can be reproduced there with a click.
