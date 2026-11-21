# `@braidlabs/sdui`

Server-driven UI that survives app version skew.

Every component, action and analytics event is a `@braidlabs/contract` document. A screen is
authored once, at the newest version of each component, and **projected** to exactly what each
binary in the field was built to render:

```ts
import { projectScreen } from '@braidlabs/sdui';

const { outcome, root, report } = projectScreen(screen, catalog, manifest);
// outcome: 'exact' | 'degraded' | 'fallback' | 'blocked'
// report:  per node — downgraded with lossyPaths: ['badge'], or which fallback it took and why
```

- What a downgrade loses is **measured** — taken down and straight back up — so a degraded render
  is labelled as one.
- Where a step cannot be inverted, or a critical field would be lost, **nothing is guessed**: the
  node takes its authored fallback, then the catalog's, then is omitted — and a required node that
  does not reach the screen, for any reason, blocks it for that device.
- Projection is a pure function, so the cost of a change is known **before** it is published, for
  every app version in the field.

Also here, all pure and dependency-free beyond `@braidlabs/skew` and `@braidlabs/contract`:

|                                                                                        |                                                                                     |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `resolveHandshake`, `decidePointer`                                                    | Can this binary be served, and is that older release a rollback or a stale replica? |
| `assignRollout`, `evaluateFlags`                                                       | Sticky percentage rollouts and flags that only ever widen                           |
| `resolveSessionState`, `resolveScreenState`, `resolveNodeStates`, `resolveActionState` | Every state an app can be in, named, with where its pixels come from                |
| `diffScreens`                                                                          | A contract-aware diff: a move is a move, a catalog upgrade is not an edit           |
| `checkCatalog`, `createClientManifest`                                                 | The append-only rule, and what one binary can render                                |
| `sdui` (bin)                                                                           | `catalog check`, `catalog id`, `manifest gen`, `manifest fingerprint`               |

## A2UI

Two subpaths make [A2UI v1.0](https://a2ui.org/specification/v1.0-a2ui/) first-class:

- **`@braidlabs/sdui/a2ui`** — A2UI as a wire format of the same model. Agents author against a
  catalog's own id; each renderer names an id derived from what it can draw; `createA2uiProjector`
  sends each one the agent's surface at its own versions, and `sdui a2ui prerender` writes every
  variant ahead of time, as A2UI and as HTML.
- **`@braidlabs/sdui/web`** — `<a2ui-surface>`, a renderer that draws into the host's own page in
  light DOM, where any component type can be the host's own custom element or a Braid fragment
  from another team.

`examples/concierge` shows both.

`conformance/` holds the specification as data — the vectors a client in any language is checked
against.

Full documentation: <https://github.com/braidjs/braid/blob/main/docs/packages/sdui.md>. Design and
roadmap: <https://github.com/braidjs/braid/blob/main/docs/sdui-cms-plan.md>.
