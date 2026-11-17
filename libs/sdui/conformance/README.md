# Conformance vectors

These files are the specification of `@braidlabs/sdui`, as data. The TypeScript in `src/` is one
implementation of it; a Swift, Kotlin or any other client is another, and is correct when it gives
the same answers.

Every vector is facts in, answer out. None needs a network, a clock or a renderer.

| File                  | Function                                                  | A vector is                                                |
| --------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `projection/*.json`   | `projectScreen(screen, catalog, manifest, options)`       | the whole result: outcome, projected tree, per-node report |
| `states/session.json` | `resolveSessionState(given)`                              | `{ state, source }`                                        |
| `states/screen.json`  | `resolveScreenState(given)`                               | `{ state, source }`                                        |
| `states/node.json`    | `resolveNodeStates(given)`                                | `[state, ...also]`, most significant first                 |
| `states/action.json`  | `resolveActionState(given)`                               | `state`                                                    |
| `handshake.json`      | `resolveHandshake(request, policy)`                       | status, HTTP status, agreed protocol                       |
| `pointer.json`        | `decidePointer(known, offered)`                           | adopt, keep, ignore-stale or conflict                      |
| `rollout.json`        | `bucketOf(salt, install)`, `assignRollout(plan, install)` | the bucket, and the release an install gets                |
| `flags.json`          | `evaluateFlags(definitions, install, context)`            | values and assignment ids                                  |
| `conditions.json`     | `evaluateCondition(condition, context)`                   | true or false                                              |
| `diff/*.json`         | `diffScreens(before, after, catalog)`                     | changes and catalog upgrades                               |

`catalog.json`, `manifests/` and `screens/` are the shared inputs the projection vectors name by
path: one catalog, the same app at three versions, and two screens.

## What a server-side-only port can skip

Projection, handshake resolution, flags, rollouts and diffing run on the server. A device needs the
four state resolvers and `decidePointer`, and nothing else from this directory.

## Changing a vector

A vector that changes is a behaviour change for every client in the field, so treat one like a
published contract step: add vectors freely, and change an existing one only when the behaviour it
pins was wrong. `tools/sdui/check-state-matrix.mjs` fails when a state in `src/lib/states.ts` has no
vector here.
