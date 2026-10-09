# Braid — failure modes and how to avoid them

> Symptom-first, and it assumes you know what a realm, a slot, and the `/__braid/` namespace are.
> If a term here is unfamiliar, [**Braid, explained**](braid-explained.md) defines it in one page.

Composition failures are rarely loud. A fragment that quietly re-fetches content it already had,
or lags one navigation behind, looks like it works. This is the catalogue of the ones we have
actually hit, each with the symptom you would see first and the thing that prevents it.

Every entry here was observed in a real browser during development, not imagined.

---

## A routed fragment mounted by client-side navigation hijacks the host URL

**Fixed.** Kept here because the trace is the clearest illustration of how realm navigation reaches
the top document, and because the first fix for it was wrong in an instructive way. See *The fix*
below for what actually holds.

**Symptom.** The host router navigates to a route — say `/reports` — and the URL immediately becomes
one of the *fragment's* routes instead. The page renders the wrong component. A direct load or a
full reload of the same URL works perfectly.

**Trace.** Instrumenting `history` on the host shows the host's own navigation succeeding and then
being undone by a traversal nobody in the host called:

```
pushState /reports   → /reports
POPSTATE             → /billing/invoices
replaceState /billing/invoices
```

No `history.back()`, `forward()`, or `go()` runs in the top document. The traversal comes from
**inside a realm**: a compat realm is a real same-origin iframe on a real URL, so its navigations
join the top document's session history, and a traversal there moves the top document with it.

**Cause.** A compat fragment whose own application has a router, mounted onto a route reached by
*client-side* navigation. When the realm boots, the fragment's router performs its initial
navigation; that navigation lands in the joint session history alongside the host's just-pushed
entry, and the resulting traversal replaces it.

Setting `src` does **not** avoid it. An unbound fragment does not *drive* host navigation through
Braid, but its realm is still an iframe in the same session history, which is a lower level than
`bound` operates at.

**What it does not affect.** A fragment with no router of its own — a React app without one, a
custom element — is fine, because nothing inside it navigates on boot. Pages reached by a full
document load are fine, because the host is not mid-`pushState` when the realms boot. That is why
the composed billing page works and a client-side hop to another page mounting the same fragment
does not.

**The fix, and the wrong version of it.**

The first attempt gated the privilege on *boot*: a bound fragment's history calls were confined to
its own realm until its scripts had finished running. That is the right shape and the wrong clock.
**Scripts having run is not the same as the router having settled** — Angular resolves its initial
route asynchronously, measured at ~170ms after mount, long after the last `<script>` returned. The
window had already reopened by the time the redirect landed, so the bug survived its own fix and
reproduced exactly as before.

No timing constant fixes that honestly; the next router is slower than whatever delay is chosen.
The gate is therefore **causal, not temporal**:

> A bound fragment may drive the host URL only once the user has acted inside it. Until then, every
> mutating history call is applied to the fragment's own realm.

A navigation the user did not ask for stays inside the realm, whenever it happens. The fragment
still settles into its route — it simply does so in its own `location` instead of the address bar.

**Verified both directions.** Mounting the routed `billing` fragment on `/demo` — the case that used
to bounce the host — now leaves the host at `/demo` while the fragment's own realm resolves to
`/billing/invoices`. Clicking a link inside that fragment on its own page still moves the host to
`/billing/settings`, so real navigation is untouched.

**The cost, stated plainly.** A bound fragment that redirects with no user input — an async auth
check, say — now changes only its own location. That is the safer of the two defaults: the host URL
staying where the host put it is the property worth keeping, and a fragment that genuinely needs to
move the host can do it from a user gesture.

`contract-blob` realms remain the structurally cleaner answer for contract-mode fragments, since
they never touch the joint session history at all. Compat still needs a real `http:` URL to keep
`location` truthful, which is why it needs this gate instead.

## Host integration

### The fragment renders, then flickers and re-renders — and there are two realms

**Symptom.** `document.querySelectorAll('iframe[name^="braid:"]')` returns more than one frame
per slot. The network shows the fragment's HTML being fetched even though the gateway pierced it
into the page.

**Cause.** The host framework discarded the server-rendered DOM and re-created it. Angular does
this when hydration is not enabled: `<fragment-slot>` is destroyed along with the shadow root the
gateway filled, and the new element boots a second realm to fetch the fragment itself.

**Prevention.** Enable hydration on **both** bootstraps — the server has to emit the annotations
for the client to reuse them. Configuring it on only one side silently does nothing:

```ts
// shared app config, used by main.ts and main.server.ts
providers: [provideClientHydration()];
```

**Check it.** One realm per slot, and `slot.hasAttribute('data-braid-pierced')` is true.

### The fragment lags one navigation behind the host

**Symptom.** Clicking a host link changes the URL and the host's own UI, but the fragment still
shows the previous screen. Back/forward works correctly, which makes it look intermittent.

**Cause.** `onHostNavigation` was wired to *every* router event. Routers report navigation in
phases, and the early ones fire before the URL changes — Angular's `NavigationStart` is the
common case — so the fragment is told about a location the page has not reached yet.

**Prevention.** Wire an *after*-navigation hook only:

```ts
router.events
  .pipe(filter((e) => e instanceof NavigationEnd || e instanceof NavigationSkipped))
  .subscribe(() => notify());
```

The navigation bus also defends against this (it keys duplicate-suppression on the URL rather
than on time alone), but the filtered wiring is what you should write.

### `<fragment-slot>` renders nothing and the console has no Braid errors

**Cause.** `initBraid()` was never called, so the custom element was never defined and the
element is an inert unknown tag.

**Prevention.** Call `initBraid()` once during bootstrap, before any slot connects. If it runs
but an adapter is missing you get a named `adapter-resolution` error instead of silence.

### The framework complains about an unknown element

**Prevention.** Angular needs `CUSTOM_ELEMENTS_SCHEMA` on the component that renders the slot.
Vue needs `compilerOptions.isCustomElement`. React needs nothing.

### Angular SSR warns: `Received "x-forwarded-proto" header but "trustProxyHeaders" was not set up to allow it`

**Symptom.** Angular SSR logs a console warning on incoming requests when running behind the Braid gateway.

**Cause.** The gateway sets standard `x-forwarded-proto` and `x-forwarded-host` headers when fronting the host app. Angular's `@angular/ssr/node` (`AngularNodeAppEngine`) validates proxy headers for SSR security and warns if `trustProxyHeaders` is omitted.

**Prevention.** Pass `trustProxyHeaders: true` in your server's `AngularNodeAppEngine` configuration:

```ts
const angularApp = new AngularNodeAppEngine({
  allowedHosts: ['localhost', '127.0.0.1'],
  trustProxyHeaders: true,
});
```

---

## Fragment (remote app) integration

### The fragment's stylesheet 404s, or the wrong CSS loads

**Symptom.** Unstyled fragment content; a request for `/some/host/path/styles.css`.

**Cause.** A fragment's markup lives in the *host* page's DOM, so its relative URLs resolve
against the host page. The gateway re-roots subresource URLs into `/__braid/frag/:id/…` to
prevent exactly this — if you are seeing it, the response did not go through that transform.

**Prevention.** Fetch fragment documents through `/__braid/doc/:id/…`, which is the namespace
that returns markup already prepared for the host's DOM. The client does this automatically;
fetching `/__braid/frag/:id/…` instead gives you the fragment's raw HTML, which is not safe to
insert.

### A fragment fails to load with a CORS error, or a "redirected" `fragment-fetch` error

**Symptom.** The slot shows `fragment-fetch: the fragment redirected "/__braid/doc/…"`. On older
versions it was worse: a CORS error on a `/__braid/doc/…` request, or a login page's markup rendered
inside the slot, and nothing in the error mentioned a redirect.

**Cause.** The fragment's endpoint answered its document request with a 3xx — almost always because
the request was unauthenticated and it redirected to a login page. The gateway passes redirects
through untouched, and the client fetches the document rather than navigating to it. Following the
redirect leaves the fragment's namespace: cross-origin it fails as an opaque CORS error that hides
the real status, and a relative `Location` resolves against the host's origin and returns the wrong
page with a 200.

**Fix.** Either make the fragment render an unauthenticated state (or answer 401/403) instead of
redirecting its document, or opt in to following the redirect with `redirect: 'navigate'` on its
manifest — then the gateway hands the target to the client, which navigates the page there. The
target must be on the host's origin, inside the fragment's endpoint path, or in the gateway's
`redirectOrigins` (exact origins, or `https://*.example.com`); anything else is refused with a 502 and
a log line naming the origin and path. Without `redirect: 'navigate'` the redirect's target is not
readable from the browser; the request's response in DevTools → Network shows it.

### A fragment's login redirects over and over, or stops with "redirected again"

**Symptom.** With `redirect: 'navigate'`, the user logs in, comes back, and is sent to the login
again; or the slot shows `fragment "…" redirected again straight after the last redirect, so it was
not followed`.

**Cause.** The fragment redirects because it cannot tell who the user is — and the gateway does not
forward the caller's `Cookie` or `Authorization` to fragment endpoints unless told to. After login the
fragment still sees an anonymous request. The client stops the loop after one round trip (30 seconds,
per fragment, remembered in `sessionStorage`) rather than reloading forever.

**Fix.** Give the fragment the user's identity: `forwardCredentials: true` when every endpoint is inside
the shell's trust boundary, otherwise a signed per-request assertion via `additionalHeaders`. The gateway
warns when a fragment opts in with neither (at startup for an inline registry, on the first redirect
otherwise). A return URL that lands on the wrong page is a
`?next=` the gateway could not recognise: only a parameter whose whole value is the fragment's own URL is
rewritten to the page the user was on.

### One fragment's storage stops opening after another deploys

**Symptom.** A fragment that worked yesterday can no longer read or write anything. Its errors name
IndexedDB — `VersionError`, or an open request that never settles — and nothing about that fragment
changed. Another fragment on the same origin deployed recently.

**Cause (fixed, but worth recognising).** `indexedDbRecordDriver` used to derive the database version
from the number of collections it declared. Two applications sharing an origin rarely declare the
same number, so each demanded its own version — and the one with the *shorter* list ended up
requesting a version lower than the database already had. IndexedDB refuses that permanently. The
sibling that "broke" it had done nothing wrong.

**Fix.** Upgrade `@braidlabs/data`. The version is now discovered rather than derived, connections
close themselves on `versionchange` so a sibling's upgrade is not blocked, and a genuinely blocked
upgrade reports which database and collections are involved instead of hanging. If you are pinned to
an older version, the workaround is to have every application on the origin declare an identical
collection list.

### One client's unsent edit appears on another client's screen

**Symptom.** An advisor (or any user who works on behalf of others) has two tabs open on different
clients. An edit queued offline for the first client shows up as pending on the second — same record
id, wrong tenant. It corrects itself on reload, which makes it look like a rendering glitch.

**Cause (fixed).** The optimistic overlay was keyed by record id alone. The outbox is deliberately
*session*-scoped — a queued write belongs to the session that made it, not to whichever client was on
screen — so both tabs read one queue, and `holding:h1` means something different in each.

**Fix.** Upgrade `@braidlabs/data`. Overlays now carry the partition they were made for, and a reader
only applies the ones belonging to the partition it is reading. The queue stays session-scoped, so
the edit still flushes from whichever tab is open — scoping the queue too would strand a trade behind
a client the advisor had closed.

**Worth checking in your own code:** anything else keyed by record id across a tenant switch. Records,
invalidation, and fetch de-duplication were already partition-scoped; the overlay was the one that was
not.

### Two fragments write the same record and one edit disappears

**Symptom.** Two composed apps write the same shared record. One of the edits is simply gone —
intermittently, and more often on a fast connection where both writes land close together.

**Cause.** Not a bug in either app. `@braidlabs/data` gives every write a single-record transaction, so
records are never torn and no update is lost to a read-modify-write — but there is **no compare-and-set**:
concurrent writes to one key end in last-write-wins. Both values were accepted by the server; the
store holds whichever arrived second.

**Fix.** The ordering has to be decided where the writes actually meet, which is the server. Add a
version or etag check and reject the stale write; the losing fragment's `mutate` then reports it as
`{ expected, actual, paths }` rather than losing silently. See
[the storefront tutorial's composition section](tutorials/07-storefront.md#7-what-happens-when-two-fragments-race).

Note the asymmetry while you are here: two fragments *reading* the same key are serialized by a
per-key Web Lock and produce one fetch. Reads are coordinated; writes are not.

### A widget renders an empty shell, or 404s, on every page

**Symptom.** A fragment meant to appear everywhere pierces nothing. The slot carries
`data-braid-fallback="placeholder"`, or the fragment's endpoint logs a stream of 404s for paths that
belong to the host — `/billing/invoices`, `/settings`, `/`.

**Cause.** The fragment is **bound** when it should not be. A bound fragment is a screen: the
gateway fetches it at the page's own path, because that is the route it is supposed to render.
Chrome — a header panel, a sidebar, a global search box — has content at one fixed address instead,
and asking its endpoint for the host's path is a question it has no answer to.

**Fix.** Declare it unbound, and say where its content lives:

```jsonc
{ "id": "notifications", "bound": false, "src": "/panel", "pierce": ["/", "/*"] }
```

The gateway warns at registration when `bound: false` arrives without a `src`, because the fallback
behaviour — fetching the page path — is wrong in a way that shows up as an empty widget rather than
as an error anyone can trace.

### The widget changes the moment it hydrates

**Symptom.** The server-rendered widget is right in the first paint, then flips to different content
(or to an empty state) as soon as the client boots.

**Cause.** The slot's `src` and the manifest's `src` disagree. The gateway pierced content from one
path; the client runtime then booted the fragment at the other. Both are working correctly — they
were told different things.

**Fix.** Make them agree. The gateway prints
`slot for fragment "…" declares src="…" but its manifest declares src="…"` at pierce time, which is
the only place this is visible before a user reports it. A slot that declares no `src` at all is
filled in from the manifest, so omitting it is safer than guessing at it.

### The fragment's own router computes the wrong routes

**Cause.** Something rewrote the fragment's `<base href>`. The fragment's router reads it to
learn its base path, and pointing it at the namespace makes every route resolve under
`/__braid/frag/…`, which the host URL never matches.

**Prevention.** Leave `<base>` alone — the gateway deliberately never rewrites it. Build the
remote with its normal base href (usually `/`), not with the namespace baked in.

### The fragment's JavaScript never runs

**Symptom.** Content appears (the SSR markup) but nothing is interactive; possibly
`Failed to load module script … MIME type "text/html"`.

**Causes, in order of likelihood.** The fragment endpoint has no SPA history fallback, so a
namespaced path returns HTML instead of the asset. Or the fragment's HTML was inserted without
being prepared, leaving relative script URLs to resolve against the realm's route directory.

**Prevention.** Serve the fragment endpoint with a history fallback, and let the gateway prepare
every fragment document. An endpoint that cannot have one — a static bucket behind a CDN — can
declare `documentPath: "/index.html"` in its manifest instead, and the gateway fetches that one
document for every route. A fragment's scripts always execute in its realm — never in the host —
so a script that "does nothing" is usually a URL problem, not an execution problem.

### The realm fails to boot with a named `realm-boot` error

**Causes.** The gateway is not mounted in front of the app (the stub request returned the host's
own HTML); the client and gateway package versions disagree on the protocol; or the fragment
endpoint sets `X-Frame-Options: DENY`, which stops the realm iframe loading.

**Prevention.** Mount the gateway first in the middleware chain, upgrade `@braidlabs/core` and
`@braidlabs/gateway` together, and do not let a CDN or WAF inject frame-blocking headers on
namespace responses. The error message names which of these it is.

---

## Deployment and build

### The browser runs an old client bundle after a rebuild

**Symptom.** Changes to the host or fragment have no effect; behavior matches a previous build.

**Cause.** Unhashed filenames served with a long `max-age`. Development builds often disable
filename hashing while the server still sends year-long cache headers.

**Prevention.** Use `outputHashing` in every configuration you actually serve, or send
`max-age=0` for unhashed assets. Do not rely on a manual hard-reload — your users cannot do one.

### Two dev servers answer on the same port

**Symptom.** One app's content served under the other's URL; a fragment that "is" the whole page.

**Cause.** Multiple child processes inheriting `PORT` from whatever launched them. The second one
fails to bind and the survivor answers for both.

**Prevention.** Pass each server its port explicitly rather than inheriting it, and fail loudly
when a child exits non-zero.

### A fragment disappears on some page loads

**Cause.** A shared cache served a composed page to a request that wanted the plain shell, or the
reverse. A page URL that a fragment pierces is the only Braid URL with more than one
representation — see [the three namespaces](https://github.com/braidjs/braid/blob/main/libs/braid-gateway/README.md#the-three-namespaces).

**Prevention.** Don't edge-cache pierced pages — the gateway defends this by default, marking
them `private` so a correct shared cache will not store them. Seeing this failure anyway means
either something at the edge is rewriting `Cache-Control`, or you set
`pierceCacheControl: 'preserve'`, in which case `sec-fetch-dest` must be in the cache key for
those routes and nothing at the edge may strip it. Braid URLs themselves
(`/__braid/frag|realm|doc/*`) vary on nothing and need no configuration.

---

## Security-shaped surprises

### Fragment code runs in the host's JavaScript context

This should not happen: the gateway strips inline `on*` handlers, neutralizes every `<script>`,
defangs `<meta http-equiv="refresh">`, and strips inline frame documents, so no markup a fragment
sends can execute in the host realm or navigate the host page.

**What is still yours to own.** `javascript:` URLs on links and form `action`s are not neutralized
because they require a user to click, and a trusted fragment is allowed to navigate a page the
user clicks through. (On frames they run on parse, so there the gateway removes them — along with
`iframe[srcdoc]` and `data:`/`blob:` frame URLs — and marks the tag `data-braid-blocked`.) And the
trusted tier is *namespace isolation, not a security boundary*: fragments are same-origin and
share the host's cookies and storage. Treat a manifest entry as granting that endpoint the user's
session.

### A fragment endpoint reaches further than its manifest says

**Prevention.** Give the endpoint a path (`https://internal/apps/billing/`) and the gateway
treats it as a boundary; requests that would resolve outside it are refused. Leave
`trustForwardedHeaders` off unless a proxy you control is the only route to the gateway.

---

## Quick diagnostic

Run this in the console on a page with a fragment. It answers most of the above at once:

```js
const slot = document.querySelector('fragment-slot');
({
  state: slot.state,
  pierced: slot.hasAttribute('data-braid-pierced'),
  realms: document.querySelectorAll('iframe[name^="braid:"]').length, // expect 1 per slot
  hostPrototypesPristine: Node.prototype.appendChild.toString().includes('[native code]'),
  hostHistoryPristine: !Object.getOwnPropertyDescriptor(window.history, 'pushState'),
});
```

`initBraid({ dev: true })` adds boot timings, unaudited-API warnings from the compat document
facade, and reports of nodes entering the fragment through paths the boundary cannot intercept
synchronously.
