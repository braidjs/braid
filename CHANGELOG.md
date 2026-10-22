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