# @braidlabs/gateway

Fetch-native origin-front middleware. A library, not a service.

## Mounting

```ts
import { createGateway } from '@braidlabs/gateway';
import { toNodeMiddleware, toNodeUpgradeHandler } from '@braidlabs/gateway/node';

const gateway = createGateway({ registry, mode: 'production' });

app.use(toNodeMiddleware(gateway));                    // Express, NestJS, Connect, Vite
server.on('upgrade', toNodeUpgradeHandler(gateway));   // fragment websockets (dev HMR, live apps)
```

```ts
// Workers, Deno, Bun, h3/Nitro
export default toFetchHandler(gateway, toWebHandler(app));
```

Mount it **first**, so it sees requests before the app does. For a legacy app you cannot modify,
run the same library as an edge worker or reverse proxy in front of it.

A host that shares its domain and only owns a path (`/manage/` behind a load balancer) sets the
same `basePath` on both sides — `createGateway({ registry, basePath: '/manage' })` and
`initBraid({ basePath: '/manage' })` — and the namespaces move to `/manage/__braid/…`. `pierce`
patterns still match full page paths. `serviceWorker`, `discovery` and `telemetry.webVitals` don't
support a `basePath` yet; combining them throws.

## Manifests

```jsonc
{
  "id": "billing",                       // addresses the fragment; no "/" allowed
  "endpoint": "https://billing.internal", // a URL or a fetch-compatible function
  "pierce": ["/billing", "/billing/*"],   // page URLs to server-render it into
  "timeoutMs": 1500,
  "fallback": "placeholder",              // placeholder | omit | error-html
  "title": "Billing",                     // discovery metadata
  "access": { "list": {...}, "fetch": {...} }
}
```

`adapter` defaults to `compat`. An endpoint **path** is a boundary: `https://internal/apps/billing/`
cannot be used to reach the rest of that origin.

An SPA on a static origin (a bucket behind a CDN) has one document and 404s every route. Declare
`"documentPath": "/index.html"` and the gateway fetches that document for every page route, deep
links included; assets are still fetched at their own paths.

A fragment that is a **web component** declares the adapter and what to load, and serves no
document at all (the gateway answers its document request with `204`):

```jsonc
{ "id": "rating", "endpoint": "https://widgets.example.com",
  "adapter": "custom-element", "entry": "/star-rating.js", "element": "star-rating",
  "events": ["rating:change"] }
```

A relative `entry` is re-rooted into the fragment's namespace, so the module and everything it
imports are fetched through the gateway rather than from the host's own root.

The registry is data: inline manifests, a URL to JSON, or an async loader. Deploying a fragment
never redeploys the gateway.

## App Directory

`discovery: { appd: true }` also serves the registry in FDC3 App Directory shape at
`/__braid/registry/appd/v2/apps`. A projection over the same manifests and the same `access.list`
rules — never a second directory. Intents come from the manifest's `fdc3.listensFor`/`fdc3.raises`;
Braid launch detail rides in `hostManifests.braid`, because a fragment is mounted into a page
rather than opened as a window.

## The three namespaces

| Path | Serves | Notes |
| --- | --- | --- |
| `/__braid/frag/:id/*` | the fragment's endpoint (assets, data) | prefix stripped before forwarding |
| `/__braid/realm/:id/*` | the realm stub the iframe boots from | carries protocol version + adapter |
| `/__braid/doc/:id/*` | the fragment's document, prepared for the host DOM | what piercing injects |

**None of them vary on a request header** — they cache on URL alone; cache them aggressively at
the edge. Only a *page* URL that a fragment pierces varies, on `sec-fetch-dest`, and the gateway
keeps those out of shared caches for you: `public`/`s-maxage` dropped, `private` added, the app's
own `max-age`/`no-store` left alone. `Vary` is not sufficient on its own — most CDNs honor it only
for `Accept-Encoding`, and a cache that ignores it will serve a composed page to a router's fetch
or an unpierced shell to a navigation.

`pierceCacheControl: 'preserve'` opts out; only correct if the pages are anonymous *and*
`sec-fetch-dest` is in the edge's cache key.

## Piercing

A document request to a `pierce`-matched URL is composed: shell and fragments fetched
concurrently, fragment HTML **stream-interleaved** into the matching `<fragment-slot>` as a
declarative shadow root. The client adopts it instead of fetching.

Fragment HTML is transformed on the way through: doctype stripped, `<html>/<head>/<body>` renamed
to `braid-*`, scripts neutralized to `type="inert"`, inline `on*` handlers stripped, meta refresh
defanged, subresource URLs re-rooted into `/__braid/frag/:id/`. `<base href>` is deliberately
left alone.

A fragment that fails to render degrades to the client-boot path rather than breaking the page.

## Access

```jsonc
"access": {
  "list":  { "roles": ["finance"] },   // who sees it in the discovery registry
  "fetch": { "scopes": ["billing:read"] } // who may load it
}
```

Both public when omitted, and independent. **Roles are any-of; scopes are all-of.** Enforced on
every namespace request, on websocket upgrades, and on piercing. Unauthorized → `403`, or `404`
when the caller may not even list it. Development mode bypasses it.

```ts
createGateway({ registry, principal: (request) => sessionFrom(request) });
```

`principal` is only called for fragments that declare `access`.

## Discovery (opt-in)

```ts
createGateway({ registry, discovery: { pageSize: 100 } });
```

`GET /__braid/registry` returns a paginated listing filtered by `access.list`, with `loadable`
per entry, endpoints withheld unless `includeEndpoints`, and `no-store`. Development mode lists
everything and says so.

## Other options

- `observe` — records which page paths compose which fragments, for `braid registry impact`. Off by
  default; recording paths is a retention decision. Synchronous and on the request path, so it must
  be cheap.
- `trustForwardedHeaders` — off by default; `x-forwarded-*` are overwritten from the real request
  unless a proxy you control is the only path in.
- `mode: 'development'` — verbose errors, bypassed access rules, and the `Origin` header rewritten
  to the endpoint's own origin so dev servers don't reject fragment module requests.
