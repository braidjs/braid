## 0.6.0 (2026-10-27)

### 🚀 Features

- ⚠️  **fdc3:** report FDC3 3.0, refuse close() and newInstance:true at once ([2cf7d68](https://github.com/braidjs/braid/commit/2cf7d68))
- **site:** the public site, as static files with no gateway ([e34c799](https://github.com/braidjs/braid/commit/e34c799))
- **site:** "Interested in hosted Braid? Get in touch." on every page ([f444259](https://github.com/braidjs/braid/commit/f444259))
- **site:** a working contact form on a Cloudflare Worker ([089ae5c](https://github.com/braidjs/braid/commit/089ae5c))
- **site:** run the contact form as an AWS Lambda ([f3a4ce2](https://github.com/braidjs/braid/commit/f3a4ce2))
- **site:** a local dev server with a working contact form ([af8d410](https://github.com/braidjs/braid/commit/af8d410))
- **site:** the AWS stack for hosting and the contact form, in CDK ([e765d45](https://github.com/braidjs/braid/commit/e765d45))
- **site:** canonical URLs, share cards and JSON-LD ([1731aad](https://github.com/braidjs/braid/commit/1731aad))
- **site:** robots.txt, sitemap and llms.txt for crawlers ([64f6f5b](https://github.com/braidjs/braid/commit/64f6f5b))

### 🩹 Fixes

- **deps:** clear four high advisories published since the last audit ([4de9c1a](https://github.com/braidjs/braid/commit/4de9c1a))
- **fdc3:** match intent listeners by context type, as FDC3 3.0 does ([997a3dc](https://github.com/braidjs/braid/commit/997a3dc))
- **site:** keep live sections on screen, hide seams, fit phones ([3048006](https://github.com/braidjs/braid/commit/3048006))
- **site:** harden the preview server and the build's output guard ([90f2266](https://github.com/braidjs/braid/commit/90f2266))
- **site:** act on code review — dead CTA, anchor checks, contract, a11y ([d330850](https://github.com/braidjs/braid/commit/d330850))
- **site:** quieter nav — four links, two buttons, hosted line in the dateline ([5878124](https://github.com/braidjs/braid/commit/5878124))
- **site:** drop the date from the masthead dateline ([0b49751](https://github.com/braidjs/braid/commit/0b49751))
- **site:** give nav links a full-size click target ([c746cc2](https://github.com/braidjs/braid/commit/c746cc2))
- **site:** act on the security and code reviews of the contact form ([aa8fff5](https://github.com/braidjs/braid/commit/aa8fff5))
- **site:** CI can only publish content; close the Function URL bypass ([4328f8e](https://github.com/braidjs/braid/commit/4328f8e))
- **site:** trust GitHub's immutable OIDC subject for the publish role ([384558f](https://github.com/braidjs/braid/commit/384558f))
- **site:** let the publish role create Amplify deployments ([e654795](https://github.com/braidjs/braid/commit/e654795))
- **site:** make the llms-full converter strict, and its checks honest ([119d3a0](https://github.com/braidjs/braid/commit/119d3a0))

### ⚠️  Breaking Changes

- **fdc3:** report FDC3 3.0, refuse close() and newInstance:true at once  ([2cf7d68](https://github.com/braidjs/braid/commit/2cf7d68))
  the agent reports FDC3 3.0, and the FINOS 3.0 directory drops
  records whose optional fdc3Version range excludes 3.0.

### ❤️ Thank You

- Jeff Smith @Jefftopia

## 0.5.0 (2026-10-23)

### 🚀 Features

- **core:** realmGlobals — per-fragment values on a trusted fragment's realm ([e5ebf03](https://github.com/braidjs/braid/commit/e5ebf03))
- **core:** replay the current context value to a subscriber that asks ([ae2a7ac](https://github.com/braidjs/braid/commit/ae2a7ac))
- ⚠️  **core:** context subscribe replays the current value by default ([a251ab5](https://github.com/braidjs/braid/commit/a251ab5))
- **data:** channel state that persists across reloads ([42d6cbd](https://github.com/braidjs/braid/commit/42d6cbd))
- **data:** intents reach handlers in other realms on the page ([00659e2](https://github.com/braidjs/braid/commit/00659e2))
- **fdc3:** @braidlabs/fdc3, an FDC3 2.2 Desktop Agent for Braid pages ([7b2688a](https://github.com/braidjs/braid/commit/7b2688a))
- **registry:** endpointOrigins — an allowlist for where fragment endpoints may point ([fa39e58](https://github.com/braidjs/braid/commit/fa39e58))
- **registry:** serve the registry as an FDC3 App Directory ([7beef57](https://github.com/braidjs/braid/commit/7beef57))
- **registry,console:** page snapshot history, so rollback reaches past 25 ([7f7795d](https://github.com/braidjs/braid/commit/7f7795d))

### 🩹 Fixes

- **appd:** drop bad links instead of failing the listing; a directory-only read right ([144c648](https://github.com/braidjs/braid/commit/144c648))
- **console:** the fragment editor no longer overwrites newer publishes ([339ae03](https://github.com/braidjs/braid/commit/339ae03))
- **console:** keep fragment drafts across tabs, and ask before closing ([7a2a2a6](https://github.com/braidjs/braid/commit/7a2a2a6))
- **console:** ship the standalone app with a Content-Security-Policy ([08fa397](https://github.com/braidjs/braid/commit/08fa397))
- **console:** report editor dirtiness only when it changes ([3845303](https://github.com/braidjs/braid/commit/3845303))
- **console:** review fixes for CSP, permissions refetch and history paging ([eb32df6](https://github.com/braidjs/braid/commit/eb32df6))
- **core:** call the realmGlobals hook only for adapters that install it ([a1288ba](https://github.com/braidjs/braid/commit/a1288ba))
- **data:** page scope crosses a page's realms; late joiners get current state ([18023f2](https://github.com/braidjs/braid/commit/18023f2))
- **data:** set an intent call's error cause by hand for older TS libs ([25c7fb5](https://github.com/braidjs/braid/commit/25c7fb5))
- **data,core:** late join without a storm or false conflict; review fixes ([529792c](https://github.com/braidjs/braid/commit/529792c))
- **data,core:** harden cross-realm intents and persisted state from review ([203c566](https://github.com/braidjs/braid/commit/203c566))
- **fdc3:** harden the agent against review findings ([aabd608](https://github.com/braidjs/braid/commit/aabd608))
- **gateway:** make the App Directory projection conform to FDC3 2.2 AppD ([aeaa39a](https://github.com/braidjs/braid/commit/aeaa39a))
- **registry:** own shell routes, so a team cannot answer another team's pages ([8db6143](https://github.com/braidjs/braid/commit/8db6143))
- **registry:** judge route scope as URLPattern reads it, not as written ([23e5619](https://github.com/braidjs/braid/commit/23e5619))
- **registry:** descriptor probes no longer read the server's network out ([7621528](https://github.com/braidjs/braid/commit/7621528))
- **registry:** cap write bodies, and require JSON from browsers ([e837d20](https://github.com/braidjs/braid/commit/e837d20))
- **registry:** judge shell-route ownership conservatively, not by sampling ([bec45cc](https://github.com/braidjs/braid/commit/bec45cc))
- **registry:** probe only allowed endpoints, and keep refused snapshots unservable ([78a9943](https://github.com/braidjs/braid/commit/78a9943))

### ⚠️  Breaking Changes

- **core:** context subscribe replays the current value by default  ([a251ab5](https://github.com/braidjs/braid/commit/a251ab5))
  code that called get() and then subscribe() handles the
  first value twice. Drop the get(), or pass { replay: false }.
  Also fixes the replay path reading `options.as` when no options were passed,
  which threw inside the guarded call and was only logged.

## 0.4.0 (2026-10-22)

### 🚀 Features

- **cli:** read the registry from a module with --source ([6ff452c](https://github.com/braidjs/braid/commit/6ff452c))
- **console:** query language and stable tag colors ([fbb81c1](https://github.com/braidjs/braid/commit/fbb81c1))
- **console:** generate host code for a shell in four frameworks ([136abb7](https://github.com/braidjs/braid/commit/136abb7))
- **console:** shells on the composition map ([f92c238](https://github.com/braidjs/braid/commit/f92c238))
- **console:** shell designer, history and rollback, and setup states ([de117d9](https://github.com/braidjs/braid/commit/de117d9))
- **console:** Shells and History tabs, and OIDC sign-in for the standalone app ([b0e5239](https://github.com/braidjs/braid/commit/b0e5239))
- **console:** mock Okta demo mode, seeded shell, and topology fixes ([90cd2c0](https://github.com/braidjs/braid/commit/90cd2c0))
- **core:** share named host globals with trusted fragments ([db93c14](https://github.com/braidjs/braid/commit/db93c14))
- **core:** share host globals with custom-element fragments ([32d18aa](https://github.com/braidjs/braid/commit/32d18aa))
- **gateway:** decide credential forwarding per fragment ([d6c0195](https://github.com/braidjs/braid/commit/d6c0195))
- **gateway:** cut off fragment requests that loop through gateways ([b41bb9d](https://github.com/braidjs/braid/commit/b41bb9d))
- **gateway:** pierce a page's routed fragment into an outlet slot ([8cdd204](https://github.com/braidjs/braid/commit/8cdd204))
- **gateway,registry:** hot re-pin — serve a new pin without a restart ([d0b52ec](https://github.com/braidjs/braid/commit/d0b52ec))
- **gateway,registry:** serve shells straight from their definition ([fda09e4](https://github.com/braidjs/braid/commit/fda09e4))
- **registry:** shells as data in snapshots, with ASCII grid layouts ([c9ee9de](https://github.com/braidjs/braid/commit/c9ee9de))
- **registry:** verified publisher, conflict check, permissions, and pin enforcement ([c7ab920](https://github.com/braidjs/braid/commit/c7ab920))
- **registry:** OIDC authorizer for the registry API (Okta and any JWKS issuer) ([021bdca](https://github.com/braidjs/braid/commit/021bdca))
- **registry:** compose team gateways into an org supergraph ([51713d4](https://github.com/braidjs/braid/commit/51713d4))
- **registry:** audit export — one event per attempted write, for a SIEM ([a37a55d](https://github.com/braidjs/braid/commit/a37a55d))
- **registry,console:** per-tag ownership — teams change only what carries their tag ([5b8f2bc](https://github.com/braidjs/braid/commit/5b8f2bc))
- **registry,console:** environments with promotion and approvals ([719a999](https://github.com/braidjs/braid/commit/719a999))
- **registry,console:** GitOps — publish by pull request ([c58ce0b](https://github.com/braidjs/braid/commit/c58ce0b))

### 🩹 Fixes

- one-line grid templates pasted from CSS, and half-typed query keys ([38d1b8a](https://github.com/braidjs/braid/commit/38d1b8a))
- stale HEAD after rollback, 401-only re-sign-in, mixed-row grid parsing ([d537aa9](https://github.com/braidjs/braid/commit/d537aa9))
- **cli:** keep --source runs from borrowing braid.config ([3ec4b2f](https://github.com/braidjs/braid/commit/3ec4b2f))
- **console:** HEAD badge spacing and a note on the plain-JS bare import ([1027451](https://github.com/braidjs/braid/commit/1027451))
- **console:** close codegen escapes, keep drafts, renew sessions, lazy panels ([3282093](https://github.com/braidjs/braid/commit/3282093))
- **core:** validate shared-global grants and pin boot order ([afaa3a2](https://github.com/braidjs/braid/commit/afaa3a2))
- **deps:** refresh in-range transitive dependencies with known CVEs ([b0a28bd](https://github.com/braidjs/braid/commit/b0a28bd))
- **deps:** upgrade Angular 22.2, Nx 23.3 and Nest to clear critical/high CVEs ([5da8ead](https://github.com/braidjs/braid/commit/5da8ead))
- **deps:** clear three high advisories published since the last audit ([695cbf9](https://github.com/braidjs/braid/commit/695cbf9))
- **docs:** contain mermaid render failures inside the diagram's component ([f846669](https://github.com/braidjs/braid/commit/f846669))
- **gateway:** keep credentials off websocket upgrades unless forwarded ([c8385f7](https://github.com/braidjs/braid/commit/c8385f7))
- **gateway:** name a proxied fragment once, not once per gateway ([ad2a098](https://github.com/braidjs/braid/commit/ad2a098))
- **gateway:** close the remaining credential and loop gaps ([6150a10](https://github.com/braidjs/braid/commit/6150a10))
- **gateway:** keep a late named slot from booting a second copy of the outlet's fragment ([d1f4ec1](https://github.com/braidjs/braid/commit/d1f4ec1))
- ⚠️  **gateway:** quiet unchanged reloads, and keep realm stubs off the boot path ([715c773](https://github.com/braidjs/braid/commit/715c773))
- **gateway,registry:** bound what a served shell may claim and load ([51524b7](https://github.com/braidjs/braid/commit/51524b7))
- **registry:** harden shells, OIDC and the write API after review ([c46e4c2](https://github.com/braidjs/braid/commit/c46e4c2))
- **registry:** bound what a subgraph's registry can declare ([8fde69f](https://github.com/braidjs/braid/commit/8fde69f))
- **registry:** audit every write path, and keep the webhook sink calm in an outage ([1632622](https://github.com/braidjs/braid/commit/1632622))
- **registry,console:** close ownership's race, route and input gaps ([a73f42c](https://github.com/braidjs/braid/commit/a73f42c))
- **registry,console:** make four-eyes approval hold ([6660784](https://github.com/braidjs/braid/commit/6660784))
- **registry,console:** GitOps publishing survives republish, size and hostile text ([cd7c9fb](https://github.com/braidjs/braid/commit/cd7c9fb))
- **security:** address review — vue/Nest fixes, isolate and fail-closed scanner ([5f81329](https://github.com/braidjs/braid/commit/5f81329))

### ⚠️  Breaking Changes

- **gateway:** quiet unchanged reloads, and keep realm stubs off the boot path  ([715c773](https://github.com/braidjs/braid/commit/715c773))
  BraidGateway gains required refreshRegistry() and
  close(), Breaker gains required forget(), and TelemetryEvent gains the
  'registry' kind. Code that implements or mocks BraidGateway or Breaker,
  or switches exhaustively over TelemetryEvent kinds, must add them.

### ❤️ Thank You

- Jeff Smith @Jefftopia

## 0.3.0 (2026-10-14)

### 🩹 Fixes

- **packaging:** declare or stop emitting every import a published package makes ([4060e71](https://github.com/braidjs/braid/commit/4060e71))

### ❤️ Thank You

- Claude
- Claude Opus 5.5

## 0.2.0 (2026-10-14)

### 🚀 Features

- **clu:** wip detangle ([e170cf1](https://github.com/braidjs/braid/commit/e170cf1))
- **data:** list the partitions in a collection ([81eae48](https://github.com/braidjs/braid/commit/81eae48))
- **data:** collection change feed and collection queries ([b464791](https://github.com/braidjs/braid/commit/b464791))
- **data:** a sessionStorage record driver ([6e1fb62](https://github.com/braidjs/braid/commit/6e1fb62))
- **docs,bindings:** new bindings and new docs ([4322f97](https://github.com/braidjs/braid/commit/4322f97))
- **gateway:** add documentPath manifest field for SPAs on static origins ([18a4ab4](https://github.com/braidjs/braid/commit/18a4ab4))
- **gateway,core:** basePath for hosts mounted under a path ([b6c19b2](https://github.com/braidjs/braid/commit/b6c19b2))
- **gateway,core:** follow a fragment's login redirect as a page navigation (opt-in) ([b6809c8](https://github.com/braidjs/braid/commit/b6809c8))

### 🩹 Fixes

- **core:** refuse redirects on the fragment document fetch ([212f17b](https://github.com/braidjs/braid/commit/212f17b))
- **data:** review fixes for the collection feed and session driver ([3db9d9a](https://github.com/braidjs/braid/commit/3db9d9a))
- ⚠️  **gateway:** stop forwarding caller credentials to fragment endpoints ([2c4ebdc](https://github.com/braidjs/braid/commit/2c4ebdc))
- **gateway:** keep endpoint requests on the endpoint's origin ([17c7ef2](https://github.com/braidjs/braid/commit/17c7ef2))
- **gateway:** remove inline frame documents from fragment markup ([720f577](https://github.com/braidjs/braid/commit/720f577))
- **gateway:** prepare every /__braid/doc/ body, whatever its content-type ([18a6a86](https://github.com/braidjs/braid/commit/18a6a86))
- **gateway:** parse attributes as the browser does; review fixes ([7396d43](https://github.com/braidjs/braid/commit/7396d43))
- **gateway,core:** reject basePaths that can never match; document basePath ([45cddea](https://github.com/braidjs/braid/commit/45cddea))

### 🔥 Performance

- **core:** report a compat fragment ready without waiting on its images ([ddbb028](https://github.com/braidjs/braid/commit/ddbb028))
- **core:** load one realm stub per fragment, not one per route ([019ec0e](https://github.com/braidjs/braid/commit/019ec0e))
- **core:** paint a client-fetched fragment before its realm boots ([e21b54f](https://github.com/braidjs/braid/commit/e21b54f))
- **gateway:** let fragment assets revalidate with 304s ([dc01066](https://github.com/braidjs/braid/commit/dc01066))
- **gateway:** don't tee a coalesced fetch nobody joined ([bb14854](https://github.com/braidjs/braid/commit/bb14854))
- **gateway:** stream a pierced page as soon as the shell responds ([bdc5a73](https://github.com/braidjs/braid/commit/bdc5a73))
- **gateway:** prefetch a pierced fragment's scripts before it boots ([05d7de4](https://github.com/braidjs/braid/commit/05d7de4))
- **sw:** use navigation preload for navigations the worker handles ([c3dac47](https://github.com/braidjs/braid/commit/c3dac47))

### ⚠️  Breaking Changes

- **gateway:** stop forwarding caller credentials to fragment endpoints  ([2c4ebdc](https://github.com/braidjs/braid/commit/2c4ebdc))
  `Cookie` and `Authorization` are no longer sent to fragment
  endpoints. Set `forwardCredentials: true` to restore the old behaviour.
  `fetchFragment` builds `new Request(url, request)`, which copies every header.
  It removed the caching validators and set the x-forwarded pair, but nothing
  removed the caller's credentials — so every fragment endpoint in a registry
  received the session that authenticates the user to the shell's origin.
  A fragment endpoint is a URL from the registry: frequently a different team,
  often a different company. Forwarding those headers hands each of them the
  ability to act as that user against the shell. That is the trust boundary
  between a host and the fragments it composes, and it should not be crossed by
  default.
  A fragment that needs to know who is asking should get something scoped to it.
  So `additionalHeaders` now also accepts a function of the incoming request,
  for a per-caller identity assertion or trace id — a static Record is read once
  at construction and has nowhere to put one.
  That second change opened a leak, which is the reason the coalescing key moved
  too. `singleFlightKey` is computed from the *outbound* request and read only
  cookie/authorization/user-agent/negotiation; a per-caller header added by
  `additionalHeaders` varied while the key did not, so two callers would have
  shared one fragment render. The key now includes the names the gateway itself
  added. Mutation-checked: reverting that one argument fails the new test.
  The same reasoning changes an existing expectation in the other direction.
  With credentials stripped, two signed-in callers produce a byte-identical
  fragment request, so coalescing them is correct rather than a leak — the
  endpoint cannot tell them apart. `does not coalesce across different sessions`
  became a pair of tests covering both directions.
  219 gateway tests, 17 projects green.

### ❤️ Thank You

- Claude
- Claude Opus 5
- Claude Opus 5.5
- Claude Sonnet 5.5
- Jeff Smith @Jefftopia
- Jeffrey Smith @Jefftopia

## 0.1.1 (2026-08-23)

### 🚀 Features

- **braid:** add demo ([b2dcd2e](https://github.com/braidjs/braid/commit/b2dcd2e))
- **coalesce:** add coalescing to gateway ([9b40d73](https://github.com/braidjs/braid/commit/9b40d73))
- **data:** WIP event bus ([badef28](https://github.com/braidjs/braid/commit/badef28))
- **docs:** improve docs ([29999ac](https://github.com/braidjs/braid/commit/29999ac))
- **docs:** add image ([77d73af](https://github.com/braidjs/braid/commit/77d73af))
- **fdc3:** start adding fdc3 ([f2c6e78](https://github.com/braidjs/braid/commit/f2c6e78))
- **store:** add demo ([8f5b504](https://github.com/braidjs/braid/commit/8f5b504))
- **tutorials:** step-by-step tutorials for core, build, angular-core, and angular-data — served through federation ([885ddd4](https://github.com/braidjs/braid/commit/885ddd4))

### 🩹 Fixes

- **release:** push the changelog commit and version tag after publishing ([6c7c31a](https://github.com/braidjs/braid/commit/6c7c31a))
- **release:** build Angular libs in partial compilation mode ([414427c](https://github.com/braidjs/braid/commit/414427c))

### ❤️ Thank You

- Claude Fable 5
- Jeffrey Smith @Jefftopia