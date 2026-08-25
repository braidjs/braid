# Adopting Braid from Module Federation

You do not have to choose. A page can host federated remotes and Braid fragments at the same
time, so migration is per-remote and reversible — which matters, because for some remotes
federation is the better answer and should stay.

## What actually changes

Module Federation composes at **build/module** level: the host imports a remote's module and runs
it in the host's JavaScript context, sharing a dependency graph.

Braid composes at **runtime/DOM** level: the remote runs in its own realm with its own
dependency graph, and only its DOM enters the host page.

| | Module Federation | Braid |
| --- | --- | --- |
| Remote's dependencies | shared with the host, negotiated at runtime | isolated; two React majors cannot collide |
| Version skew | singletons must agree, or you get subtle breakage | structurally impossible for dependencies |
| Remote must be built for it | yes — `exposes`, shared config, matching bundler | no — compat takes an unmodified app |
| Server-side rendering | hard; needs coordinated SSR | the gateway composes SSR output |
| Cost | one JS context, smallest payload | one iframe realm per fragment |
| Failure mode | a shared-dep mismatch breaks the host | a broken fragment leaves the page standing |

**Keep federation** where remotes are small, share the host's framework version, and you want the
smallest possible payload. **Move to Braid** where a remote has its own release train, its own
framework version, needs SSR, or is a legacy app you cannot rebuild.

## Migrating one remote

The remote needs **no code changes** — that is the point of the compat adapter. The work is on
the host, and it is small.

**1. Serve the remote as an ordinary app.** A federated remote is already deployed somewhere; you
need it to serve a normal document at a route. Usually its existing dev/prod build already does.

**2. Register it with the gateway.**

```jsonc
{ "id": "billing", "endpoint": "https://billing.internal", "pierce": ["/billing/*"] }
```

**3. Replace the federated mount point with a slot.**

```diff
- const Billing = React.lazy(() => import('billing/Module'));
- <Suspense fallback={<Spinner/>}><Billing /></Suspense>
+ <braid-fragment name="billing" />
```

```diff
- loadRemoteModule({ remoteName: 'billing', exposedModule: './Module' })
+ <braid-fragment name="billing" />
```

**4. Drop the remote from the federation config** — its `remotes` entry, and any `shared`
singletons that existed only for it. That step is what pays: shared-dependency negotiation is
where federation's version-skew failures come from.

**5. Delete the remote's `exposes`** once no host references it, along with the federation plugin
if it was the last remote.

Do these one remote at a time. Between steps 3 and 5 the app is in a perfectly good state with
both mechanisms live.

## Things that need a decision, not a rewrite

**Shared state.** Federation lets remotes import a shared store directly. Braid fragments cannot —
different realms. Use the context bus (`braidContext.set` / `env.context`), which structured-clones
across the boundary. If a remote genuinely needs live shared object identity with the host, it is
a federation case, not a Braid case.

**Shared component libraries.** Under federation these are shared singletons; under Braid each
fragment bundles its own copy. That costs bytes and buys independent upgrades. Measure before
assuming it is a problem — a design system is usually small next to a framework.

**Routing.** A federated remote often uses the host's router instance. A Braid fragment uses its
own, bound to the host URL: its `routerLink`s drive the host, and host navigation drives it. No
shared router instance, and no `provideRouter` coordination.

**Cross-remote imports.** If remotes import each other, untangle that first; it is a coupling
federation permits and Braid does not.

## Running both at once

Nothing special is required. The gateway only claims `/__braid/*` and the page URLs a fragment
declares in `pierce`; federated chunk requests pass through untouched. Both can appear on one
page, and `braid dev` fronts the same dev servers you already run.

The only real conflict is **`publicPath` collisions**: a federated remote serving assets from a
path that a fragment's `pierce` pattern also matches. Fragment traffic is exact and
id-addressed, so it will not misroute — but a broad pattern like `pierce: ["/*"]` will try to
compose pages you did not mean. Keep pierce patterns narrow.

## Proposed tooling

None of this exists yet; it is the shape worth building if a migration is real.

**`braid migrate mf --remote <name>`** — read the federation config, emit the manifest entry for
that remote, and print the exact host-side diff (the `loadRemoteModule`/`React.lazy` call sites
to replace). Report what it could not determine rather than guessing.

**`braid doctor --mf`** — flag the specific hazards: a `shared` singleton that exists only for an
already-migrated remote, a `pierce` pattern overlapping a federated `publicPath`, remotes that
import each other.

**A codemod for mount points.** The call-site shapes are few and regular
(`React.lazy(() => import('remote/X'))`, Angular's `loadRemoteModule`, `loadRemoteEntry`), so
rewriting them to a slot is mechanical. Worth doing only after a couple of real migrations tell
us which shapes actually occur.

Start manually with one remote. A migration you have done once by hand is the only reliable
specification for the tool that does the rest.

---

## `braid detangle`: read your workspace first

Before converting anything by hand, point the CLI at the workspace and let it tell you what it
finds:

```sh
npx braid detangle
```

It reads the project graph and every Module Federation config, infers which project is the shell,
maps each remote to a fragment, and prints the topology with its findings. **It writes nothing** —
the default is a report.

```
braid detangle — apps/shell
  Shell     shell            -> host, 3 slots
  Gateway                    -> NEW app (shell has no server target)

  Fragments
    billing        :4201    bound    /billing /billing/*   from apps/shell/src/app/app.routes.ts
    reviews        :4202    bound    /reviews /reviews/*   from apps/shell/src/app/app.routes.ts
    notifications  no port  unbound  pierce unknown        from apps/shell/src/app/header.ts

  Findings
    ⚠  "notifications" has no serve port — its endpoint cannot be inferred
    ⚠  header.ts: mounts "notifications" but its route path is not a string literal nearby
    ·  2 shared singletons: @ngrx/store, @angular/core
       shared instances do not survive realm isolation — move cross-app state onto the context bus
```

### The flags

| Flag | What it does |
| --- | --- |
| *(none)* | report only |
| `--shell <project>` | name the host, when the workspace has more than one |
| `--diff` | also print the `braid.config.json` it would write |
| `--write` | write `braid.config.json`. Refuses on a dirty git tree or a blocking finding |
| `--gateway` | with `--write`, also scaffold the gateway app (new files only) |
| `--shell-edits` | with `--write`, also apply the shell edits that can be applied safely |
| `--force` | override those refusals, and replace an existing config |
| `--remove-mf` | check whether the federation config can safely be stripped |
| `--port <n>` | port for the composed app (default 4000) |

### What it will and will not do for you

**It writes `braid.config.json`**, which `braid dev` runs immediately.

**With `--gateway` it scaffolds the gateway app** — new files only, and it refuses an existing
directory rather than merging into it.

**With `--shell-edits` it applies the edits it can prove**: the Braid runtime import *and* its
`provideBraid()` call, `provideClientHydration()`, and the removal of routes that mount a remote.
Providers are inserted inside `providers: [ … ]` at a character offset, so a one-line array stays
valid; where no providers array can be found, the import and its call are refused **together**,
because an import without its call is an unused import and a runtime that never initializes.

**A route is only removed when its shape can be proved:** exactly one string-literal `path`, exactly
one `loadChildren`/`loadComponent`/`component`, and no `canActivate`, `canMatch`, `canLoad`,
`resolve`, `providers`, `children`, or `data`. Anything else stays a finding with the reason named —
a guard carries behaviour the fragment does not inherit, and `children` means deleting the element
would remove routes unrelated to the remote.

**It never reprints a file.** Edits are line- and offset-based, so everything else stays
byte-identical and the result reads as a diff. Converting the test fixture is a two-line deletion and
three insertions.

**It converts no shared state, ever.** MF `shared` singletons — an NgRx store, an auth service
imported across the boundary — do not survive realm isolation, and no codemod can decide what should
replace them. Detangle lists every one it finds and points at the context bus. This is the honest
hard part of any real migration, and a tool that pretended otherwise would be lying to you.

**Cross-remote deep imports are listed, never rewritten.** `import { Thing } from 'billing/Thing'`
has no Braid equivalent — a realm boundary means the shell cannot hold a reference into a fragment's
module graph. Move the type to a library, or pass the value as a prop or context.

### Two refusals worth knowing about

**A dirty git tree stops `--write`.** The entire safety story for a command that edits a workspace is
that `git checkout` undoes it, and that is only true when there was nothing else to lose.

**`--remove-mf` refuses when another host still consumes the same remotes**, naming every one. That
failure is not recoverable by re-running anything — the other host simply stops building.

