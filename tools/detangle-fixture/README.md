# `detangle` fixture — a Module Federation workspace, committed

A minimal but *real* MF workspace that `braid detangle` converts in CI, and that the composed
result then boots and serves.

It exists because every other test in `libs/braid-cli` asserts what detangle *says*. This one
asserts that what it produces **runs**: the config it writes is loaded, a gateway is stood up from
it, and a request for `/billing` comes back with the remote's markup already inside the shell's
HTML. That is the only check on the end of the pipeline, and it is the one a converted workspace
actually depends on.

## Why the apps are static HTML

They are not federated at runtime, and they do not need to be. Detangle reads MF *config* — which is
here, and real — and what it emits is a Braid topology. Building three webpack bundles to prove that
would test webpack. The apps are documents served on their own ports, which is exactly what a
fragment endpoint is.

## Why it is in `.nxignore`

The `project.json` files are the input detangle reads. Without the ignore, this workspace's own Nx
graph would adopt three fake applications and `nx run-many` would try to build them.

## Layout

```
apps/shell           MF host: remotes billing + reviews, routed. No server target.
apps/billing         MF remote, exposes ./Routes, serve port 4201
apps/reviews         MF remote, exposes ./Routes, serve port 4202
project.json         a workspace-root project — the case that once ended the scan at 1 project
```
