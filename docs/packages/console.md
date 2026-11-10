# @braidlabs/console

A console for a Braid gateway's registry: browse and search fragments, see what composes where,
design **shells** as data, publish immutable snapshots, and roll back. One package, two forms: React
components to mount inside a portal you already run, and a standalone app you deploy behind SSO.

---

## Installation

```bash
npm install @braidlabs/console
```

Styles are injected by the components themselves, scoped under `.braid-console`. There is no CSS
file to import.

---

## What it does

| View | Needs | What it is for |
| :--- | :--- | :--- |
| **Fragments** | the gateway's `/__braid/registry` | every registered fragment, filterable with the query syntax below |
| **Topology** | the same | shells → routes → fragments → origins: the only real couplings between fragments |
| **Shells** | the registry write API | list, design, generate code for, publish and delete shells |
| **History** | the write API | who published what, rollback by re-pinning, and promotion through environments with approvals |
| **Edit fragments** | the write API | add, change and remove fragment manifests, with a diff and an access preview |

Viewing fragments needs nothing deployed. Everything else needs `createRegistryApi` from
[`@braidlabs/registry`](./registry.md) mounted beside the gateway. Without it those views explain
what to mount instead of failing.

The package has a second entry, `@braidlabs/console/workspace`: the runtime for a
[workspace](#the-workspace) area designed into a shell. It has no React in it.

---

## Shells and the layout designer

A shell is a page as data: routes, and per route a grid layout typed as ASCII art, with one
fragment per area.

```
header header
aside  main
footer footer
```

What you type **is** CSS `grid-template-areas`, so the preview is the browser's own grid and the
validation is the browser's own rules: every area a single rectangle, every row the same width. Pick
an area in the preview, then the fragment that fills it.

Each shell also carries its document head: title, meta tags, and scripts and stylesheets **by URL**
(`https:` or root-relative; inline script is not representable). The console edits the head as data
and never loads it into its own page. Running a shell's scripts in the admin origin would put
third-party code next to an operator's token.

The **Code** tab generates the host for each framework a shell can be:

| Framework | You get |
| :--- | :--- |
| React | route components with `<BraidFragment>` in a grid, the layout CSS, and `index.html` with the head |
| Angular | standalone components and `app.routes.ts` with `<braid-fragment>` |
| Angular SSR | the Angular files plus `server.ts` with the gateway mounted in front of the SSR handler |
| Plain JS | one HTML page per route with `<fragment-slot>`s |

A route may also have one **workspace** area: see [The workspace](#the-workspace) below.

Every value is escaped for where it lands. A **Plain JS** shell needs no code at all: the gateway
can serve it straight from its definition, so publishing it puts the page live with no rebuild (see
[serving shells from their definition](./registry.md#serving-shells-from-their-definition)). For
the other frameworks, the code is yours to build and serve, and the gateway pierces fragments into
what your app returns.

---

## The workspace

Most areas of a shell hold one fixed fragment. A **workspace** area holds whatever apps the user
has open: they launch apps into it, and save and restore named layouts of it. The fixed areas
around it — navigation, a header — stay exactly as designed.

**Designing it.** In the layout preview, pick an area and tick **Workspace**. Add the **starting
apps** that are open when the page first loads. A route has at most one workspace; ticking another
area moves it there. The area shows hatched in the preview with its starting apps, and the shell
validates like any other: the area must exist, hold no fixed fragment, and name registered
fragments.

```json
{
  "path": "/desk",
  "layout": { "areas": "nav desk", "columns": "220px 1fr" },
  "slots": { "nav": "navigation" },
  "workspace": { "area": "desk", "apps": ["blotter", "chart"] }
}
```

**What it renders.** In every target the area becomes an element marked `data-braid-workspace`,
holding a `<fragment-slot>` for each starting app (at most 32). The **Code** tab adds the wiring:
the same few lines inline for Plain JS, and a `workspace.ts` module for React and Angular. There
the framework renders the area empty and the workspace opens the starting apps after render,
because the workspace adds and removes the area's children itself when a layout is restored, and
a framework must not own them. A Plain JS
shell [served from its definition](./registry.md#serving-shells-from-their-definition) renders the
area too; its runtime module creates the workspace.

**Running it.** `createWorkspace()` finds the page's `[data-braid-workspace]` element:

```ts
import { initBraid } from '@braidlabs/core';
import { createWorkspace } from '@braidlabs/console/workspace';

const workspace = createWorkspace();
initBraid({ realmGlobals: workspace.realmGlobals() });

workspace.open('chart', { props: { symbol: 'AAPL' } }); // launch an app into the area
await workspace.layouts.save('morning');                // the area's apps, in order, with their state
await workspace.layouts.restore('morning');             // replaces the area's apps; nothing outside it
await workspace.layouts.list();                         // ['morning']
await workspace.layouts.delete('morning');
```

A layout is the area's `<fragment-slot>`s in order: each one's app, `src` and `props`, and whatever
state the app gives. A reload shows the shell as designed, with its starting apps; restoring a
layout is the page's call, so a "restore my last layout on load" is one line in the host.

**Inside an app.** Every fragment gets `window.braidDesktop`:

```ts
await braidDesktop.settings.set('columns', ['due', 'amount']); // this app's, for this user
await braidDesktop.settings.get('columns');                    // after a reload too

braidDesktop.onSaveLayout(() => ({ tab: currentTab }));        // JSON, within 2 seconds
if (braidDesktop.restoredState) showTab(braidDesktop.restoredState.tab);
```

Settings belong to the app and the user, and every instance of the app shares them. One app cannot
name another's keys through `braidDesktop`. That keeps settings apart; it is not a security
boundary, because trusted fragments share the page's origin and its storage.

**Preferences.**

```ts
await workspace.preferences.setHost({ defaultUserChannel: 'fdc3.channel.1', hiddenApps: ['legacy-chart'] }); // replaces
await workspace.preferences.getHost();
await workspace.preferences.intentChoice('ViewChart', 'fdc3.instrument'); // 'chart', or undefined
await workspace.preferences.forgetIntentChoice('ViewChart', 'fdc3.instrument');
```

They are read once, when the first fragment boots, and kept. A store that takes longer than a
second to answer is skipped: fragments boot without preferences rather than waiting.

`hiddenApps` are never offered as a choice. When hiding leaves one candidate the raise goes to it
without asking, and when it leaves none the raise is cancelled. Hiding governs the choice, not
delivery: an app that is the only one able to take an intent still gets it.

**Where it is kept.** Under keys such as `host`, `intents/{intent}/{contextType}`,
`apps/{appId}/{key}` and `layouts/{name}`, in the `store`:

| Store | Kept | Per |
| :--- | :--- | :--- |
| `localStorageStore()` (default) | in `localStorage`, under `braid.workspace/` | origin and browser profile |
| `serverStore({ url })` | on the gateway, `createGateway({ preferences })` | signed-in user, in any browser |
| `memoryStore()` | in memory, until reload | page |

Any object with `get`, `set`, `delete` and `list` is a `PreferenceStore`. The gateway side is
described under [Per-user preferences](./gateway.md#per-user-preferences-opt-in).

**With FDC3.** The workspace needs no FDC3 agent, and works with one. Spread `workspace.fdc3(resolver)`
into the agent's options and wrap its `realmGlobals`, and it also restores each app's user channel,
joins a default channel, hides apps from the intent resolver and remembers the user's choice. An
app joins its channel before its own code runs, but just after `fdc3.open` has resolved for the
opener, so an opener should pass context to `open` rather than broadcast straight after it. See
[`@braidlabs/fdc3`](./fdc3.md#preferences-app-settings-and-layouts-the-workspace).

**A worked example.** [Starport](https://github.com/braidjs/braid/tree/main/examples/starport) is a
workspace of five static apps: a ship picked in one is followed by the others, an intent two of
them can take is asked about and remembered, and a saved layout brings each app's state back.

Not supported: sizes and positions within the area (a layout is an order, laid out by your CSS),
and layouts shared between users.

---

## Behind the service-worker gateway

The console is a static bundle, so it can be served from a bucket or a CDN. Its backend can be
the gateway in a service worker ([`@braidlabs/sw/gateway`](./sw.md#the-gateway-in-the-worker-static-hosting))
on the same origin:

| View | With the in-worker gateway |
| :--- | :--- |
| Fragments, Topology | Work as they are, with `discovery` on: the worker answers `/__braid/registry` |
| Shells, History, Edit fragments | Work once the registry write API is composed into the worker, over a store in the browser |

```js
// sw.js
import { braidGatewayHandler } from '@braidlabs/sw/gateway';
import { cacheSnapshotStore, createRegistryApi, shellDocuments, snapshotRegistry } from '@braidlabs/registry';

const store = cacheSnapshotStore();              // snapshots in Cache Storage: they outlive the worker
const registry = snapshotRegistry({ store });
// fragments may only be served from this origin, so a publish cannot point the page at another
const api = createRegistryApi({ store, authorize: () => true, endpointOrigins: [self.location.origin] });
const braid = braidGatewayHandler({
  mode: 'production',
  registry,
  discovery: {},
  documents: shellDocuments({ registry, runtimeSrc: '/runtime.js' }),
});

async function registryApi(request) {
  // the only request another site can aim at the worker is a navigation (a link, a posted form);
  // the console calls the API with fetch, so navigations are refused, and a write must be JSON
  if (request.mode === 'navigate') return new Response(null, { status: 403 });
  const json = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json';
  if (request.method !== 'GET' && request.method !== 'HEAD' && !json) return new Response(null, { status: 415 });

  const response = (await api.handle(request)) ?? new Response(null, { status: 404 });
  // a publish or a pin moved HEAD: serve it on the next navigation
  if (request.method !== 'GET' && response.ok) await braid.gateway.refreshRegistry().catch(() => undefined);
  return response;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/__braid/registry-api/')) {
    event.respondWith(registryApi(event.request));
    return;
  }
  const handled = braid(event.request, event.preloadResponse);
  if (handled) event.respondWith(handled);
});
```

Seed the store with a first snapshot when the worker installs (`createSnapshot`, `store.put`,
`store.setHead`), and start the console after the worker controls the page, as any page behind
the in-worker gateway does. A shell published from the console is then served by the worker on
the next navigation.

Know what this is before relying on it:

- **It is one browser's registry.** Snapshots live in that browser's Cache Storage, per origin and
  profile, and go when the user clears site data. Nobody else sees what is published. Use it to
  design and preview; ship a design with the **Code** tab, or by publishing to a registry on a
  server.
- **The origin is the only boundary.** There is no session to authorize against, so
  `authorize: () => true` — honest here, wrong on a server. Any script on the origin can publish,
  as it could write the cache directly. Other sites are kept out by the worker itself: a worker
  answers its own pages' requests and navigations into its scope, so it must refuse navigations to
  the API (a form posted from anywhere is one) and take writes only as JSON, as above. Keep
  `endpointOrigins` to the origin, so that even a publish cannot make the page load a fragment
  from somewhere else.
- **No environments or promotion.** `cacheSnapshotStore` tracks HEAD only, so History lists and
  re-pins but has no environments.

---

## Query syntax

The filter boxes take free text, or terms:

| Term | Matches |
| :--- | :--- |
| `tag:finance` | has the tag |
| `type:shell`, `type:fragment` | kind |
| `framework:angular-ssr` | a shell's framework |
| `adapter:custom-element` | a fragment's adapter |
| `route:/billing/*` or `route:/billing/42` | a pattern as written, or a concrete path it serves |
| `is:gated` | listed, but you may not load it |
| `is:unrouted` | pierces no route (a widget) |

Terms are ANDed. `-` negates (`-is:gated`, `-legacy`), quotes keep spaces (`"customer reviews"`), and
unknown keys are searched as text. Clicking a tag chip filters by it. A tag has the same color
everywhere: the color is derived from its text.

---

## Publishing, deleting, rolling back

Edits are a draft in the browser until you publish. Publishing mints a **new** snapshot and moves
HEAD; the previous snapshot is untouched. Deleting a shell or fragment is publishing without it, and
undoing anything is pinning an earlier snapshot in **History**.

- If someone published since your draft began, the publish is refused and you are offered a reload
  rather than overwriting their change.
- Removing a fragment that a shell still slots is refused, naming the shell.
- Roles that may publish but not pin publish **candidates**, which someone with pin rights promotes
  from History.
- A gateway with `registryRefreshMs` and a source that follows HEAD serves a new pin within that
  interval, with no restart (hot re-pin). Without it, a gateway loads its snapshot when it starts,
  so a new pin goes live on its next restart or deploy. Instances poll independently, so a fleet
  converges within one interval rather than at one instant.

---

## In your own portal

```tsx
import { RegistryConsole, ShellsPanel, HistoryPanel } from '@braidlabs/console';

const api = { baseUrl: 'https://gateway.example.com', headers: async () => ({ authorization: `Bearer ${await getToken()}` }) };

<RegistryConsole api={api} />
<ShellsPanel api={api} selected={shellId} onSelect={setShellId} />
<HistoryPanel api={api} />
```

The library **never performs a login**. It takes your session through `headers()`, owns no route,
and styles nothing outside `.braid-console`. It reads `GET /permissions` only to hide what the server
would refuse; the server decides every request.

---

## Standalone, behind Okta

```bash
nx build-app braid-console   # → dist/apps/braid-console, one bundle for every environment
```

Configure it in the page it is served from:

```html
<script type="application/json" id="braid-console-config">
  {
    "baseUrl": "https://gateway.example.com",
    "edit": true,
    "auth": { "issuer": "https://example.okta.com/oauth2/default", "clientId": "0oa…" }
  }
</script>
```

With `auth`, the app signs in with Authorization Code + PKCE (the OIDC client loads only then),
returns you to the view you were on, renews silently, and shows who you are and what your role
allows. In Okta:

1. Create a **single-page app** integration with Authorization Code and PKCE. Its sign-in and
   sign-out redirect URIs are the console's URL.
2. Use a **custom authorization server** and add a **`groups` claim to the access token**.
3. Assign groups and map them on the server with `createOidcAuthorizer`'s `roleMap`
   (see [the registry](./registry.md#okta)).

Tokens live in `sessionStorage`. Serve the console with a strict Content-Security-Policy.

---

## How an enterprise runs it

- **Inside the developer portal.** Mount the components in Backstage or an in-house admin app. They
  inherit its SSO session through `headers()`.
- **Standalone behind SSO.** Deploy the static bundle to a CDN, or serve it beside the gateway at
  `/__braid/console` as `apps/braid-poc-host` does, configured per environment from the page. Staging and production run the same
  artifact.
- **API and CI first.** Everything the console does is an HTTP call. A pipeline validates with
  `validateRegistry`, publishes with a client-credentials token, and sends `baseId` to avoid races.
  Teams that prefer GitOps give the API a `githubPublisher`, so every publish from the console opens a pull request (see [GitOps](./registry.md#gitops-publish-by-pull-request)), or keep snapshots in git and publish from CI.
- **Auditable.** Every snapshot records who published it, taken from the verified token. History
  is append-only, and rollback is a re-pin. Every write attempt (publish, pin, and refusals) is
  also an audit event for your SIEM, as JSON lines or batched to a webhook (see
  [audit export](./registry.md#audit-export)).
- **Air-gapped.** Any OIDC issuer works in place of Okta, verification keys can be supplied
  locally, and the console calls nothing but your gateway and your issuer.
- **On its own origin.** Serve the standalone console and the registry API from a dedicated origin
  (`registry.example.com`), not the origin your composed pages are on. Sign-in tokens are kept in
  `sessionStorage`, and any script on the same origin (a pierced fragment, a served shell) can open
  the console in a window and read them. The built `index.html` carries a Content-Security-Policy
  that only lets its own bundle run; add `frame-ancestors 'none'` as a response header (a meta tag
  can't carry it), and narrow `connect-src` to your API and issuer there if you can.
- **Hardened API.** Set `endpointOrigins` on the registry API so fragment endpoints can only point
  where you allow, and `paths` on `shellDocuments` so served shells can only answer the parts of the
  site you allow (see [the write API](./registry.md#the-write-api)).

---

## Try it

```bash
nx build-app braid-console
BRAID_DEMO_AUTH=mock TSX_TSCONFIG_PATH=tsconfig.base.json npx tsx tools/braid-console/demo-server.mjs
# → http://localhost:9100 — a mock Okta asks which demo role to sign in as
```

The mock issues real RS256 tokens, and the registry API verifies them with the same
`createOidcAuthorizer` a production deployment uses. `curl localhost:9100/mock-oidc/dev-token?role=editor`
mints a token for scripts. Omit `BRAID_DEMO_AUTH` for the unauthenticated demo.
