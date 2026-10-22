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

Every value is escaped for where it lands. Today the framework decides which code you get. The
gateway still serves the HTML your shell app returns, and serving shells straight from the
definition is planned.

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
  Teams that prefer GitOps keep snapshots in git and publish from CI.
- **Auditable.** Every snapshot records who published it, taken from the verified token. History
  is append-only, and rollback is a re-pin. Every write attempt (publish, pin, and refusals) is
  also an audit event for your SIEM, as JSON lines or batched to a webhook (see
  [audit export](./registry.md#audit-export)).
- **Air-gapped.** Any OIDC issuer works in place of Okta, verification keys can be supplied
  locally, and the console calls nothing but your gateway and your issuer.

Planned: the gateway serving shells from their definition with no rebuild, and a GitOps mode that
opens a pull request instead of publishing.

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
