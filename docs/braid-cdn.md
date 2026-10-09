# Putting a CDN in front of the Braid gateway

Short version: **cache `/__braid/frag/*` and `/__braid/realm/*` aggressively, and don't edge-cache
pierced pages.** No custom cache keys, no `Vary` configuration, nothing your CDN has to support
beyond ordinary URL-keyed caching.

This is the gateway's default, and it enforces its own half: pages that some fragment pierces are
marked `private`, so a correct shared cache will not store them even if your shell says `public`.
You configure the aggressive half — the `/__braid/*` namespaces — at the edge.

That default is only *simple* because the protocol was designed for it. If you are curious why,
or you want to cache pages too, read on.

Two other questions come up straight after this one, and both have their own section below: what
the gateway caches itself (nothing, on purpose) and which clouds it can actually run on (most of
them, with two specific exceptions worth knowing before you plan around them).

---

## Why it's this simple

Each kind of thing the gateway serves has its own path, rather than one path that returns
different content depending on request headers:

| Path | Serves | How to cache it |
| --- | --- | --- |
| `/__braid/frag/:id/*` | the fragment's own endpoint: JS, CSS, images, data | **Aggressively.** This is the bulk of your traffic. If the fragment's build hashes filenames, cache immutably; the fragment id is in the path, so two fragments' assets can never collide. |
| `/__braid/realm/:id/*` | the realm stub each fragment's hidden iframe boots from | **Aggressively.** Tiny, identical for a given URL, already marked `max-age=3600, stale-while-revalidate`. Caching it removes a round trip from every fragment boot. |
| `/__braid/doc/:id/*` | the fragment's document, prepared for the host page's DOM | **Follow the fragment's own headers.** It is the fragment team's call, and it often reflects a signed-in user. |
| `/__braid/registry` | the discovery listing, if enabled | **Never.** Already `no-store`; it depends on who asked. |

None of these vary on a request header. A CDN that does nothing but key on the URL is correct.

**Note if you are upgrading from protocol v1:** realm stubs used to live at `/__braid/frag/*`
behind `sec-fetch-dest: iframe`, and prepared documents behind an `x-braid-dest` header. Both now
have their own paths, and the header is gone. Any cache-key rules you wrote for those can go.

---

## The one URL that does vary

A page URL that some fragment declares in its `pierce` list returns:

- the shell **with fragments composed into it**, for a document navigation
  (`sec-fetch-dest: document`);
- the plain shell, for anything else — a client-side router prefetching the same URL, say.

That variance is inherent: those are genuinely different things to ask for, and we don't control
what a host's router fetches. The gateway sends `Vary: sec-fetch-dest` on both representations.

**`Vary` is not enough on its own, so the gateway also keeps them out of shared caches.** Most
CDNs — Cloudflare among them — honor `Vary` only for `Accept-Encoding`, so a shared cache that
ignores it stores one representation and serves it as the other: the fragment silently vanishes
from a navigated page, or a declarative shadow root turns up inside a payload a router is trying
to parse. On top of that, composed pages are usually personalized (the gateway forwards cookies to
fragment endpoints), and composition couples lifetimes — a cached composed page freezes the
fragment's HTML at the shell's TTL, so a fragment deploy stays invisible until the page expires.

So on any page URL a fragment pierces, the gateway rewrites `Cache-Control`: `public` and
`s-maxage` are dropped and `private` added. Your own `max-age`, `no-store`, and
`stale-while-revalidate` are left alone — only shared cacheability is overridden, and only on
these URLs. Browser caching still works.

**To cache them anyway**, opt out and take on the cache key yourself:

```ts
createGateway({ registry, pierceCacheControl: 'preserve' });
```

Only do this if the pages are genuinely anonymous. You then must put `sec-fetch-dest` into the
edge's cache key for those routes, use a short TTL with `stale-while-revalidate`, and confirm the
edge does not strip `Sec-*` request headers before they reach the origin.

---

## Behaviors to preserve at the edge

**Streaming.** Piercing interleaves the shell and the fragment as they arrive, so the shell's
first bytes reach the browser before the fragment finishes rendering. A CDN that buffers whole
responses erases that. Enable streaming/chunked pass-through for composed documents.

**Compression.** The gateway rewrites bodies and drops `content-length`/`content-encoding` on
transformed responses. Compress at the edge rather than expecting the origin to.

**Frame headers.** The realm is a same-origin iframe. If your CDN or WAF injects
`X-Frame-Options: DENY` or a restrictive `frame-ancestors` on `/__braid/realm/*`, every fragment
fails to boot with a `realm-boot` error. Exempt the braid namespaces, or scope those headers to
`SAMEORIGIN`.

---

## Content Security Policy

- `frame-src 'self'` is required — the compat realm is a same-origin iframe.
- Add `blob:` only if you use contract-blob realms.
- Fragment scripts load from your own origin under `/__braid/frag/…`, so `script-src 'self'`
  covers them with no per-fragment entries.

**Nonces are handled for you.** The gateway injects inline markup into your document — the `<style>`
that makes slots lay out as blocks, and the web-vitals collector if you turned it on. Under a strict
policy the browser drops unstamped inline content *silently*, which is the worst failure shape
there is: the page renders, the slot layout rule is missing, and nothing anywhere logs it.

So the gateway reads the nonce off your shell's own `Content-Security-Policy` response header and
stamps what it injects. Nothing to configure. It never mints a nonce of its own — one your policy
does not list would not be trusted, and one reused across responses is not a nonce. A shell with no
policy, or one built on hashes or `'unsafe-inline'`, gets unstamped markup, which is right in all
three cases.

If your CSP is applied at the edge rather than at the origin, the gateway never sees it. Set the
header at the origin, or the nonce cannot be propagated.

---

## What the gateway caches (nothing) and what it collapses

The gateway holds no response cache, and that is deliberate rather than unfinished. Caching wants a
place where entries are shared, invalidation is expressible, and staleness is somebody's job — a
CDN is that place, and a fleet of interchangeable compute instances is not. If you run this on ECS,
Cloud Run, or anything else behind a load balancer, an in-process cache would be N caches with N
independent hit rates and no way to purge them together. Leave caching at the edge.

There is one thing the edge structurally cannot do for you. A CDN caches the *composed document*;
on a cache **miss** the gateway still makes one origin fetch per fragment on that page. A widget
pierced into `/` and `/*` is fetched once per render, so fifty concurrent renders are fifty
identical fetches of the same header panel.

The gateway collapses those, and does it **by default** — there is nothing to turn on:

```ts
createGateway({ registry });                                  // coalescing on
createGateway({ registry, coalesceFragmentFetches: false });  // off, everywhere
```

Default-on is defensible because of what it changes: how many times an identical fetch is made, and
nothing else. No response is stored, reused later, or shared across identities.

It is not a cache and does not become one. It only notices that a fetch it is *already making* is
the one another request wants, and lets both use the result; nothing outlives the request that
started it. No TTL, no invalidation, no shared state, and no dependence on which instance a request
lands on.

Two requests share a fetch only when their `cookie`, `authorization`, `user-agent`, and negotiation
headers match exactly, and fragments declaring `access` rules are never shared at all. The honest
consequence is that this helps anonymous and shared-identity traffic a lot and personalized
fragments not at all — two signed-in users have different cookies and never share a flight. That is
the correct behaviour, not a limitation to tune away: sharing a render across identities is a data
leak wearing a performance feature's clothes.

`user-agent` is in that list specifically because this is on by default. Server-side device
detection is common and completely invisible from the manifest, so without it an endpoint's mobile
render could be served to a desktop request that happened to arrive alongside it. It costs collapse
rate, since user-agent strings are diverse, and that is the right trade to make for a default.

**If your endpoint varies on something the gateway cannot see** — a tenant header, a feature-flag
header, anything bespoke — say so on the manifest:

```ts
{ id: 'reports', endpoint: '…', coalesce: false }
```

That is the one case default-on gets wrong, and it is one line to correct.

**How much it buys you scales with endpoint latency × concurrency**, so measure before believing.
Against a 120ms endpoint, ten parallel renders collapse to a single fetch. Against a fragment on
localhost answering in 10ms the requests barely overlap and it saves nothing — which is why a
local benchmark will tell you this feature does nothing, and a cross-AZ production path will not.

---

## Where the gateway can actually run

The gateway is a `fetch` handler. It takes a `Request`, may call `fetch` a few times, and returns a
streaming `Response`. There is nothing Node-specific in it — `node:` imports appear only in the
optional Express/Node adapter — so it runs anywhere that gives you four things:

| Needs | Used for |
| --- | --- |
| `Request` / `Response` / `fetch` | everything |
| **Streaming response bodies** (`ReadableStream`) | piercing, and this is the one that eliminates platforms |
| `URLPattern` | compiling `pierce` patterns |
| `AbortSignal.timeout` | per-fragment timeout budgets |

`URLPattern` is the portable one to watch: it is global from Node 23.8, and on a runtime without it
the registry reports a single `urlpattern-unavailable` error rather than claiming every one of your
patterns is malformed.

**Streaming is the requirement that decides most of this.** Piercing is a streaming transform: the
shell streams out, and each fragment's HTML is spliced in as it arrives. On a platform that buffers
the response before sending it, everything still *works* — you simply give up the reason to compose
on the server at all, because time-to-first-byte goes back to waiting for the slowest fragment.

### The short version by platform

| Platform | Verdict | Why |
| --- | --- | --- |
| **Cloudflare Workers** | Best fit | Full Web-standard runtime, streaming, `URLPattern`, and a native `HTMLRewriter` the transform layer is already written to accommodate |
| Vercel Edge / Netlify Edge / Deno Deploy | Works well | V8 isolates or Deno; streaming and the whole API surface |
| **AWS ECS / Fargate / App Runner** | Works well | Ordinary Node; the boring, predictable option |
| Google Cloud Run | Works well | Ordinary Node, streaming supported, scales to zero |
| Azure Container Apps / App Service | Works well | Ordinary Node |
| AWS Lambda **Function URL** with response streaming | Works | Needs `awslambda.streamifyResponse`; regional rather than edge |
| Fastly Compute | Probably works | Verify `URLPattern` in the JS runtime before committing |
| **AWS Lambda@Edge** | Avoid | No response streaming, plus body-size caps — you keep composition and lose the reason for it |
| **CloudFront Functions** | Cannot | No network access at all, ~1ms CPU budget. The gateway's job is fetching fragment endpoints |
| Azure Front Door rules / Akamai ESI | Cannot | Rules engines, not runtimes — no place for your code to run |

The two "cannot" rows are worth stating plainly because they are the ones people ask about first.
CloudFront Functions and CDN rules engines are for rewriting headers and URLs. The gateway makes
outbound HTTP calls and streams a transformed body; that is a different category of thing.

### Recommended setups

**On AWS.** CloudFront → ALB → ECS/Fargate is the setup to reach for. CloudFront caches
`/__braid/frag/*` and `/__braid/realm/*` aggressively and passes pierced pages through; the gateway
runs as an ordinary long-lived Node process, which also means the circuit breaker and fetch
coalescing have somewhere to keep their state between requests. If you would rather not run
containers, a Lambda Function URL with response streaming behind CloudFront is the version that
keeps piercing streaming — but note that per-instance state resets with every cold start, so the
breaker protects less than it does on ECS. Do not reach for Lambda@Edge here; the latency you save
on the network you give back on the first byte.

**On Cloudflare.** Workers, and put the gateway at the edge properly. This is the deployment the
protocol was designed against: streaming is native, `HTMLRewriter` exists in the runtime, and the
CDN and the compute are the same layer, so there is no origin hop between the two halves of the
work. Cache rules cover the `/__braid/*` namespaces.

**On Azure.** Container Apps behind Front Door, with Front Door doing the `/__braid/*` caching.
Azure Functions on a Premium plan works too; the Consumption plan's cold starts are the thing to
watch, since every one of them empties the breaker and the coalescer.

**On Google Cloud.** Cloud Run behind Cloud CDN. Cloud Run scales to zero and streams properly,
which makes it the closest thing GCP has to the ECS setup above.

**Mixed, and perfectly reasonable.** Nothing says the fragments live where the gateway lives. A
common shape is the gateway on Workers or Cloud Run near the user, with fragment endpoints on
whatever each team already deploys to. The gateway's own latency budget is the fragment fetch, so
what matters is the hop from gateway to fragment — put those close together, and put the gateway
close to the user only after that hop is short.

### Two things to get right wherever you deploy

**Keep the fragment hop short.** Every pierced page costs one fetch per fragment, in parallel. The
shell starts streaming as soon as it responds, but the bytes after each slot wait for that slot's
fragment, so a slow fragment still holds back everything below it. A gateway at the edge with fragments in one distant region is
slower than a gateway sitting next to its fragments. Optimise the inner hop first.

**Give per-instance state somewhere to live.** The circuit breaker and the fetch coalescer are both
in-process and per-instance by design. That is a feature on long-lived compute and close to
meaningless on a platform that gives you a fresh isolate per request — nothing is wrong, you just
get less from them than the configuration implies.

---

## Verifying your configuration

Run these against the edge, not the origin.

```bash
# 1. braid URLs must not vary on anything (expect no Vary header)
curl -sI https://edge/__braid/realm/billing/ | grep -i vary
curl -sI https://edge/__braid/frag/billing/main.js | grep -i vary
```

```bash
# 2. the same braid URL returns the same body however it is asked for
curl -s                            https://edge/__braid/realm/billing/ | shasum
curl -s -H 'sec-fetch-dest: iframe' https://edge/__braid/realm/billing/ | shasum
```

```bash
# 3. a document navigation is composed; a soft-navigation fetch of the same page is not
curl -s -H 'sec-fetch-dest: document' https://edge/billing/invoices | grep -c shadowrootmode  # 1
curl -s -H 'sec-fetch-dest: empty'    https://edge/billing/invoices | grep -c shadowrootmode  # 0
```

```bash
# 4. pierced pages are not shared-cacheable (expect "private", and no "public"/"s-maxage")
#    note: a GET, not `curl -I` — the gateway only composes GET, so HEAD passes straight through
curl -s -D - -o /dev/null -H 'sec-fetch-dest: document' https://edge/billing/invoices \
  | grep -iE '^cache-control|^vary'
```

(1) and (2) failing means something at the edge is adding variance Braid did not ask for. (3)
returning the same count twice means pierced pages are being cached without `sec-fetch-dest` in
the key — stop caching them, or add it. (4) showing `public` means either the edge is rewriting
the origin's `Cache-Control`, or you set `pierceCacheControl: 'preserve'` — in which case (3) is
the test that matters.
