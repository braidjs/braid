# @braidlabs/console

A console for a [Braid](../braid-gateway) gateway's registry: fragments, the composition map,
**shells** designed as data, and snapshot history with rollback. One package, two shapes: mountable
React components, and a standalone deployable app with optional OIDC (Okta) sign-in.

**Viewing needs nothing deployed.** The fragment list and map read the `/__braid/registry`
discovery endpoint the gateway already serves. Shells, history and editing need the registry write
API from [`@braidlabs/registry`](../braid-registry); without it those views say what to mount.

The full guide — the layout designer, query syntax, Okta setup, and how an enterprise runs it — is
[docs/packages/console.md](../../docs/packages/console.md).

## As a library

For teams who already run an internal admin app and want this inside it rather than beside it:

```tsx
import { RegistryConsole } from '@braidlabs/console';

<RegistryConsole api={{ baseUrl: '/api/gateway', headers: () => ({ Authorization: token }) }} />;
```

| Prop | Type | Notes |
| --- | --- | --- |
| `api` | `ConsoleApi` | base URL, discovery path, a `headers()` hook, or your own `fetch` |
| `theme` | `'light' \| 'dark'` | omit to follow the viewer's OS setting |
| `className` | `string` | for sizing and positioning |
| `onLoaded` | `(listing) => void` | for hosts that want their own chrome |

## As an app

```bash
nx build-app braid-console     # → dist/apps/braid-console
nx serve-app braid-console     # dev server
```

A static bundle for object storage, nginx, or the gateway itself. Configuration comes from the DOM,
not from a build-time constant, so **one artifact serves every environment**:

```html
<script type="application/json" id="braid-console-config">
  { "baseUrl": "https://shell.example" }
</script>
```

Omit it and the console reads the origin it was served from — which is what you want when the
gateway serves the bundle, and the simplest deployment there is.

## Being a library has consequences

Mounting inside someone else's page is a real constraint, and these are cheaper to honor from the
start than to retrofit:

**No global styles.** Every rule is scoped under `.braid-console`. No resets, no bare element
selectors, no `:root`. A library that styles `body` or `*` vandalizes its host, and the damage
surfaces in a part of the app nobody connects to this component. There is a test that walks the
parsed CSSOM and fails if any selector escapes the scope.

**No router ownership.** The console cannot own the URL bar in someone else's app, so it holds its
own state.

**No session.** It takes an API base and a `headers()` hook and never performs a login — identity
belongs to the host, exactly as it does for the gateway's own `principal` resolver.

**Theming by variable, not by specificity.** Everything themable is a CSS custom property on the
scope class. Dark mode follows `prefers-color-scheme`; `theme="dark"` forces it, and wins in both
directions, because an admin shell may be dark inside a light OS.

**Container queries, not media queries.** The console's width is its host's business, not the
viewport's. In a 420px sidebar it stacks — on a 1280px screen.

**Slim is a number.** 140 kB gzipped for the app bundle including React and the inlined
stylesheet, enforced by `nx size braid-console`. Currently 105 kB, with the OIDC client in a separate chunk loaded only when sign-in is configured. React is a peer dependency in
library form, so a host never ships two copies.

## Editing

```tsx
import { RegistryEditor } from '@braidlabs/console';

<RegistryEditor api={{ apiPath: '/__braid/registry-api' }} onPublished={(o) => toast(o.snapshot.id)} />;
```

Needs [`@braidlabs/registry`](../braid-registry)'s write API mounted. The flow is **branch from
what is pinned → edit → see what it changes → publish**, and publishing never mutates the snapshot
being edited: it mints a new one and moves a pointer, so the previous configuration survives
untouched and rollback is re-pinning it.

Three things the editor does on purpose:

**Validates as you type, and does not trust itself.** The same `validateRegistry` the server runs,
run locally for the person typing. The server validates again, because a client check is advice and
the server's is the decision — a 422 shows the server's findings, not the client's.

**Marks gateway-owned fields.** `endpoint`, `pierce`, `access`, `fallback` carry a badge, and the
pre-publish diff labels every change by owner. A changed `pierce` is a routing change with
page-wide blast radius; a changed `title` is a label. An unlabelled list makes them look alike.

**Clearing a field removes it.** An empty input means *unset*, not `""` — because an omitted field
is what lets a fragment descriptor supply it later, and `title: ""` is not the same as no title.

**Previews who loses access.** *Show access* renders a list/fetch matrix per named principal, with
`✓ → ✗` transitions against what is pinned. Losses lead; the grid is context. The count surfaces in
the publish bar whether or not the panel is open, because a finding hidden behind a toggle nobody
pressed is not a finding. Every outcome carries a text label as well as a symbol, so the meaning
does not depend on colour.

Principals are what-ifs, not a directory — the gateway has none. Pass `principals` and
`onPrincipalsChange` to hold them in the host; omit both and the editor keeps them for the session.

Drafts live in the browser. Nothing is written until you publish, so closing the tab discards, and
there is no draft state to reconcile between editors.

## What it shows

| Column | |
| --- | --- |
| Fragment | id, title, description, tags |
| Adapter | `compat`, `custom-element`, … |
| Pierces | the page URL patterns it is server-rendered into |
| Mount | what `<fragment-slot name>` resolves to |
| Access | `loadable` or `gated` |

`gated` is not a broken row. Listing and loading are **separate rules**, so a fragment you may see
but not load is a legitimate state — a launcher should render it, not hide it. And when a gateway
is in development mode the listing skips access filtering entirely, which the console says out
loud rather than letting you mistake a dev listing for a production one.

## Shells, search, and sign-in

```tsx
import { ShellsPanel, HistoryPanel } from '@braidlabs/console';

<ShellsPanel api={api} selected={shellId} onSelect={setShellId} />
<HistoryPanel api={api} />
```

- **`ShellsPanel`** lists shells and opens a designer: routes, a layout typed as ASCII art that *is*
  CSS `grid-template-areas` with a live grid preview, a fragment per area, the document head as
  data (never loaded into this page), and generated host code for React, Angular, Angular SSR and
  plain HTML. Publishing sends `baseId`, so a stale draft is refused rather than overwriting.
- **`HistoryPanel`** lists snapshots with their server-recorded publisher. Rollback is pinning one.
- **Query syntax** in every filter: `tag:` `type:` `framework:` `route:` `adapter:` `is:gated`
  `is:unrouted`, `-` to negate, quotes for spaces. Tags are colored from their text, the same
  everywhere.
- **Sign-in** is the standalone app's alone: add `"auth": { "issuer", "clientId" }` to the page
  config and it signs in with Authorization Code + PKCE, loading the OIDC client only then. The
  library still never logs in; `GET /permissions` only decides which buttons to draw.

## Related

- [`@braidlabs/registry`](../braid-registry) — snapshots, shells, analysis, the write API, and
  `@braidlabs/registry/oidc`
- [the guide](../../docs/packages/console.md) — including how an enterprise deploys and governs it
