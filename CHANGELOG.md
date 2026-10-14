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