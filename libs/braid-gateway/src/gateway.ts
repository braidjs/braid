import {
  BRAID_ADAPTER_META,
  BRAID_ADAPTER_OPTIONS_META,
  BRAID_FRAGMENT_ID_HEADER,
  BRAID_PROTOCOL_META,
  BRAID_PROTOCOL_VERSION,
  braidFragmentUrl,
  parseBraidPathname,
  BRAID_SERVICE_WORKER_PATH,
  BRAID_VITALS_BEACON_PATH,
  BRAID_VITALS_SCRIPT_PATH,
} from './protocol.js';
import {
  canFetch,
  canList,
  hasAccessRules,
  Principal,
  Registry,
  RegistrySource,
  ResolvedFragmentManifest,
} from './registry.js';
import { createDiscoveryHandler, DiscoveryOptions } from './discovery.js';
import { createBreaker, type BreakerOptions } from './breaker.js';
import { createSingleFlight, singleFlightKey } from './single-flight.js';
import {
  parseVitalsBeacon,
  vitalsCollectorScript,
  type TelemetryEvent,
  type TelemetryOptions,
} from './telemetry.js';
import { cspNonceOf, pierceShellHtml, PierceTarget, prepareFragmentHtml } from './rewriter/transforms.js';

/**
 * Gateway core: fetch-native, platform-neutral origin-front middleware.
 *
 * Two responsibilities:
 *
 * 1. **Namespace routing**: requests under `/__braid/frag/:id/*` address a fragment by id,
 *    exactly — realm stubs, assets, and data. No pattern matching, no request sniffing.
 * 2. **Piercing**: for document requests whose page URL a fragment declares in its
 *    `pierce` patterns, the fragment's server-rendered HTML is interleaved into the shell's
 *    response stream, so fragments paint with the shell's first response.
 *
 * Everything else passes through to the shell untouched.
 */

export interface GatewayOptions {
  /** The fragment registry: inline manifests, a JSON URL, or an async loader. */
  registry: RegistrySource;
  /** 'development' enables verbose error bodies; defaults to 'development'. */
  mode?: 'production' | 'development';
  /**
   * Additional headers set on every request forwarded to a fragment endpoint.
   *
   * A function is called once per fragment request with the *incoming* request, for headers that
   * describe the current caller — a signed identity assertion, a trace id, a tenant id. A plain
   * object is read once at construction, so anything per-request has to be the function form.
   */
  additionalHeaders?: Record<string, string> | ((request: Request) => Record<string, string>);
  /**
   * Forward the caller's `Cookie` and `Authorization` headers to fragment endpoints.
   *
   * **Off by default, deliberately.** A fragment endpoint is a URL from the registry — frequently
   * a different team, often a different company, sometimes a different network. `Cookie` and
   * `Authorization` authenticate the caller to *the shell's* origin, so forwarding them hands
   * every fragment backend the ability to act as that user against it. That is the whole trust
   * boundary between a host and the fragments it composes.
   *
   * A fragment that needs to identify the caller should be given something scoped to it: an
   * assertion minted per request via {@link GatewayOptions.additionalHeaders}, or a token
   * exchanged for the fragment's own audience. Turn this on only when every endpoint in the
   * registry is inside the same trust boundary as the shell.
   */
  forwardCredentials?: boolean;
  /**
   * Publishes a paginated listing of the fragments this gateway serves, for shells that build
   * their UI from the registry instead of hard-coding slot names.
   *
   * Off unless configured: a registry describes internal topology, so exposing it is a choice.
   * See {@link DiscoveryOptions}.
   */
  discovery?: DiscoveryOptions;
  /**
   * Resolves who is asking, for manifests that declare `access` rules.
   *
   * Wire it to whatever your app already uses for sessions. It is only called for fragments that
   * actually restrict something, so fully public registries never pay for it — and a fragment
   * with `access` rules but no resolver treats every caller as anonymous.
   */
  principal?: (request: Request) => Principal | undefined | Promise<Principal | undefined>;
  /**
   * Whether to pass an incoming `x-forwarded-proto` / `x-forwarded-host` through to fragment
   * endpoints instead of overwriting them from the request's own URL. Defaults to false.
   *
   * Leave it off unless a proxy you control is the only way requests reach this gateway.
   * Otherwise a client can name any host it likes, and a fragment that builds absolute URLs
   * from those headers (reset links, cache keys, redirects) will build them for the attacker's
   * host.
   */
  trustForwardedHeaders?: boolean;
  /**
   * What to do with `Cache-Control` on a page URL some fragment declares in `pierce`.
   *
   * - `'private'` (default) — keep it out of shared caches: `public` and `s-maxage` are dropped
   *   and `private` is added. The browser may still cache it.
   * - `'preserve'` — leave the shell's own headers untouched.
   *
   * The default exists because such a URL has two representations (composed for a navigation,
   * plain for a soft-navigation fetch) and `Vary: sec-fetch-dest` is not enough to protect them:
   * most CDNs, Cloudflare among them, honor `Vary` only for `Accept-Encoding`. A shared cache
   * that ignores it will store one representation and serve it as the other — the fragment
   * silently vanishes from the page, or appears in a payload a router is trying to parse as JSON.
   * Composed pages are also usually personalized, and caching one freezes the fragment's HTML at
   * the shell's TTL, so a fragment deploy stays invisible until the page expires.
   *
   * Choose `'preserve'` only when the pages are genuinely anonymous **and** you have put
   * `sec-fetch-dest` into the edge's cache key. See `docs/braid-cdn.md`.
   */
  pierceCacheControl?: 'private' | 'preserve';
  /**
   * Called for every document request that reaches the shell, with which fragments composed into
   * it. This is what makes traffic-informed impact analysis possible: "after this change, 43 of
   * the 412 page URLs we actually serve stop composing billing".
   *
   * **On the request path, so it must be cheap.** It is called synchronously and never awaited;
   * a sink that does real work should buffer and flush elsewhere. It is also called *outside* any
   * try/catch — a throwing observer will fail the request, which is the honest behavior for a
   * broken observer rather than one that silently records nothing.
   *
   * Off unless configured. Recording the paths a site serves is a data-retention decision, not a
   * default: paths carry identifiers, and sometimes personal ones.
   */
  observe?: (event: RoutingEvent) => void;
  /**
   * Report what the gateway did, and optionally what the browser experienced — per fragment.
   *
   * Distinct from {@link GatewayOptions.observe}, which records *which* fragments composed where
   * so a registry change can be analysed offline. This one records how they *behaved*: fetch
   * outcomes and durations on the server, and web vitals in the browser attributed to the fragment
   * whose subtree they happened in.
   *
   * Off unless configured. Unlike `observe`, the hook is wrapped — a throwing telemetry sink is
   * reported once and then ignored, because a feature meant to be left on in production must not
   * be able to take the site down with it.
   */
  telemetry?: TelemetryOptions;
  /**
   * Stop paying a broken fragment's timeout on every request.
   *
   * A fragment endpoint that is down already costs its full `timeoutMs`; without a breaker it
   * costs that *again* on the next request, and the one after. This converts a slow repeated
   * failure into a fast one — the fallback the manifest already declares is served immediately
   * instead of after the budget expires.
   *
   * `true` takes the defaults (3 consecutive failures, 10s cooldown). Off unless configured,
   * because shedding load is a behaviour change and a deployment should opt into it knowingly.
   */
  breaker?: boolean | Partial<BreakerOptions>;
  /**
   * Collapse concurrent identical fragment fetches into one.
   *
   * A CDN in front of this gateway caches the composed document and does nothing for the origin
   * fetches a cache *miss* still costs. An unbound widget pierced into every page is fetched once
   * per render; fifty concurrent renders are fifty identical fetches. This makes them one.
   *
   * Not a cache: nothing outlives the request that started it, so there is no TTL, no
   * invalidation, and no dependence on which instance a request lands on — which is what makes it
   * safe on ECS or any horizontally scaled deployment.
   *
   * Requests only share a fetch when their `cookie`, `authorization`, `user-agent`, and
   * negotiation headers match exactly, so personalized fragments are never shared between users,
   * and a fragment declaring `access` rules is never shared at all.
   *
   * **On by default**, because it changes how many times an identical fetch is made and nothing
   * else: no response is stored, reused later, or shared across identities. A fragment whose
   * endpoint varies on something the gateway cannot see sets `coalesce: false` on its manifest;
   * set this to `false` to turn the whole mechanism off.
   */
  coalesceFragmentFetches?: boolean;
  /**
   * Serve Braid's service worker from `/__braid/sw.js`. Off by default.
   *
   * Worth doing here for a reason that is not convenience. **A worker's scope is capped by the path
   * it is served from**, so a script at `/__braid/sw.js` defaults to controlling `/__braid/` — which
   * would intercept fragment assets but not the shell's own, making it useless for the chunk-failure
   * case that matters most. Widening it needs a `Service-Worker-Allowed` header on the script
   * response, and the gateway is the one component already sitting in front of the origin that can
   * send it without additional infrastructure configuration.
   *
   * The default scope is `/`. That sounds broad and costs nothing: scope precedence is
   * longest-match, so a worker registered at `/legacy/` still controls clients under `/legacy/`
   * whatever Braid claims — the root is a fallback, not an exclusion, and the handler ignores
   * everything outside the namespace anyway. The override exists for a gateway mounted under a path
   * on an origin it does not own.
   */
  serviceWorker?: boolean | ServiceWorkerOptions;
}

export interface ServiceWorkerOptions {
  /** The scope to claim, sent as `Service-Worker-Allowed`. Defaults to `/`. */
  scope?: string;
  /**
   * The module the generated worker imports `setupBraidWorker` from.
   *
   * A URL your origin serves — the worker runs in its own realm and cannot resolve a bare specifier.
   * Defaults to `/braid-sw.js`, which is where a build that copies `@braidlabs/sw` normally
   * lands it.
   */
  module?: string;
  /** Fragment ids whose realm stubs the worker precaches at install. */
  precache?: readonly string[];
  /** Stamped into the worker so it can report disagreement with the page it is serving. */
  buildId?: string;
}

/**
 * One document request, and what composed into it.
 *
 * Emitted for *every* document request the shell handles, not only pierce-matched ones. A path
 * that composes nothing today is exactly the path that a widened pattern would start composing
 * tomorrow, and analysis needs both sides to report a gain.
 */
export interface RoutingEvent {
  /** Page pathname. Search is excluded — it never affects pierce matching. */
  pathname: string;
  /** Fragment ids that composed into this response, in registration order. */
  fragmentIds: string[];
  at: number;
}

export interface BraidGateway {
  /**
   * Handles a request if it belongs to Braid: a fragment-namespace request, or a document
   * request that pierces one or more fragments. Returns null for everything else — the caller
   * passes those through to the shell.
   *
   * @param next fetches the shell application's response. Required for piercing; without it,
   *             document requests are passed through and fragments boot client-side instead.
   */
  handle(request: Request, next?: () => Promise<Response>): Promise<Response | null>;

  /**
   * Resolves a websocket upgrade addressed to a fragment.
   *
   * Dev servers push reloads over websockets, and live apps use them for real work. Both are
   * addressed through the fragment namespace, so the gateway has to say where they go — the
   * socket plumbing itself belongs to the platform binding.
   *
   * @returns the endpoint URL to dial, or null when the request is not a fragment upgrade, the
   *          fragment is unknown, or the caller may not load it.
   */
  resolveUpgrade(request: Request): Promise<{ fragmentId: string; target: URL } | null>;
}

export function createGateway(options: GatewayOptions): BraidGateway {
  const registry = new Registry(options.registry);
  const mode = options.mode ?? 'development';
  const pierceCacheControl = options.pierceCacheControl ?? 'private';
  const additionalHeaders = options.additionalHeaders ?? {};
  const resolveAdditionalHeaders = typeof additionalHeaders === 'function'
    ? additionalHeaders
    : () => additionalHeaders;
  const forwardCredentials = options.forwardCredentials ?? false;
  const trustForwardedHeaders = options.trustForwardedHeaders ?? false;
  const serviceWorker = options.serviceWorker
    ? (options.serviceWorker === true ? {} : options.serviceWorker)
    : null;
  const isDevelopment = mode === 'development';
  const telemetry = options.telemetry ?? null;
  const singleFlight = options.coalesceFragmentFetches === false ? null : createSingleFlight();
  const breaker = options.breaker
    ? createBreaker(options.breaker === true ? {} : options.breaker, (transition) =>
        // Routed through the same hook as everything else: a circuit opening is the single most
        // useful thing this gateway can tell an operator, and it should not need its own sink.
        emit({
          kind: 'breaker',
          fragmentId: transition.fragmentId,
          from: transition.from,
          to: transition.to,
          failures: transition.failures,
          at: Date.now(),
        }),
      )
    : null;
  const vitalsEnabled = telemetry?.webVitals === true;
  let telemetryBroken = false;

  /**
   * Emits a telemetry event, and survives a sink that throws.
   *
   * `observe` deliberately does not do this — a broken analysis hook should fail loudly, because
   * its data is used to make decisions and silently recording nothing is worse than an error. This
   * hook has the opposite risk profile: it is meant to be left on in production, in front of every
   * request, so a bad sink taking the site down would make the safe choice "leave telemetry off".
   * Reported once, then muted, so a sink failing per-request cannot flood the log either.
   */
  function emit(event: TelemetryEvent): void {
    if (!telemetry || telemetryBroken) return;
    try {
      telemetry.on(event);
    } catch (error) {
      telemetryBroken = true;
      console.error('[braid-gateway] telemetry hook threw; telemetry disabled for this process', error);
    }
  }

  /**
   * Resolves the caller, but only when some manifest actually restricts something — a fully
   * public registry never pays for session lookup on every asset request.
   */
  const resolvePrincipal = async (request: Request): Promise<Principal | undefined> =>
    options.principal ? ((await options.principal(request)) ?? undefined) : undefined;

  const discovery = createDiscoveryHandler(registry, options.discovery, mode, resolvePrincipal);

  return {
    async handle(request: Request, next?: () => Promise<Response>): Promise<Response | null> {
      const requestUrl = new URL(request.url);

      if (discovery?.owns(requestUrl.pathname)) {
        return discovery.handle(request, requestUrl);
      }

      if (serviceWorker && requestUrl.pathname === BRAID_SERVICE_WORKER_PATH) {
        return serviceWorkerResponse(serviceWorker);
      }

      if (vitalsEnabled && requestUrl.pathname === BRAID_VITALS_SCRIPT_PATH) {
        return new Response(vitalsCollectorScript(BRAID_VITALS_BEACON_PATH, telemetry?.sampleRate ?? 1), {
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            // Immutable: the script is generated from this gateway's config and changes only when
            // that does, at which point the deployment restarts anyway.
            'cache-control': 'public, max-age=3600',
          },
        });
      }

      if (vitalsEnabled && requestUrl.pathname === BRAID_VITALS_BEACON_PATH) {
        return handleVitalsBeacon(request);
      }

      const route = parseBraidPathname(requestUrl.pathname);

      if (!route) {
        return next ? handleShellRequest(request, requestUrl, next) : null;
      }

      /**
       * Braid requests are routed to the addressed fragment exactly: an unknown fragment id is a
       * 404 (never the app shell, and never a header-based fallback — removed by design).
       */
      const fragment = await registry.getFragment(route.fragmentId);

      if (!fragment) {
        // no protocol meta on purpose: the client's stub verification fails loudly with a named
        // error instead of silently reframing this error document
        return htmlResponse(
          `<!doctype html><title>Braid: unknown fragment</title>` +
            (mode === 'development'
              ? `<p>braid-gateway: no fragment with id "${escapeHtml(route.fragmentId)}" is registered.<br>` +
                `Register a manifest for it in the gateway registry, and ensure @braidlabs/core and @braidlabs/gateway versions match.</p>`
              : '<p>Unknown fragment</p>'),
          404,
        );
      }

      // a fragment may declare who is allowed to load it at all (public unless it says otherwise)
      const denied = await authorizeFetch(request, fragment);
      if (denied) return denied;

      switch (route.kind) {
        /**
         * The realm stub: the document the fragment's hidden iframe boots from. It exists so the
         * realm has a real same-origin URL, which is what lets the client `replaceState` it to
         * the fragment's route and make `location`/`history` truthful.
         *
         * Its `<base>` points into the *fragment* namespace, so relative subresource requests
         * made from the fragment's JS context resolve to the fragment's own assets even after
         * the route-url illusion is restored.
         */
        case 'realm':
          return htmlResponse(
            `<!doctype html><title>Braid realm</title>` +
              `<meta name="${BRAID_PROTOCOL_META}" content="${BRAID_PROTOCOL_VERSION}">` +
              `<meta name="${BRAID_ADAPTER_META}" content="${escapeHtml(fragment.adapter)}">` +
              adapterOptionsMeta(fragment) +
              `<base href="${escapeHtml(braidFragmentUrl(fragment.id, route.pathname))}">`,
            200,
            {
              [BRAID_FRAGMENT_ID_HEADER]: fragment.id,
              // identical for a given url, and now varies on nothing: safe to cache anywhere
              'Cache-Control': 'max-age=3600, public, stale-while-revalidate=31536000',
            },
          );

        /**
         * The fragment's document, prepared for the host page's DOM: singletons renamed, scripts
         * neutralized, subresource URLs re-rooted into the fragment namespace. Exactly what
         * piercing injects, for the client-boot path.
         */
        case 'document':
          /**
           * A fragment built from an entry module has no document to give: its adapter creates
           * the UI itself. Answering "nothing here" is the truthful response, and keeps a widget
           * that ships only a script from logging a 404 on every boot.
           */
          if (fragment.entry) {
            return new Response(null, {
              status: 204,
              headers: { [BRAID_FRAGMENT_ID_HEADER]: fragment.id },
            });
          }

          return forwardToFragment(request, requestUrl, route.pathname, fragment, { prepare: true });

        /**
         * The fragment's own endpoint — assets, data, anything it serves — forwarded with the
         * prefix stripped so the endpoint sees the paths it would serve standalone.
         */
        case 'fragment':
          return forwardToFragment(request, requestUrl, route.pathname, fragment);
      }
    },

    async resolveUpgrade(request: Request): Promise<{ fragmentId: string; target: URL } | null> {
      const requestUrl = new URL(request.url);
      const route = parseBraidPathname(requestUrl.pathname);

      // only the fragment namespace carries live sockets; stubs and documents are plain GETs
      if (!route || route.kind !== 'fragment') return null;

      const fragment = await registry.getFragment(route.fragmentId);
      if (!fragment) return null;

      // a socket is a load like any other, so the same access rule applies
      if (await authorizeFetch(request, fragment)) return null;

      // a fetcher-function endpoint has no origin to dial
      if (typeof fragment.endpoint !== 'string') return null;

      const strippedUrl = new URL(requestUrl);
      strippedUrl.pathname = route.pathname;

      try {
        return { fragmentId: fragment.id, target: resolveEndpointUrl(fragment.endpoint, strippedUrl, fragment.id) };
      } catch {
        return null;
      }
    },
  };

  /**
   * Applies a fragment's `access.fetch` rule, if it declares one.
   *
   * A caller who may not even *list* the fragment gets a 404: to them it does not exist, and
   * saying otherwise would turn the namespace into an inventory of what they cannot reach. A
   * caller who may list it but not load it gets an honest 403.
   *
   * Both rules are public by default, so a registry that declares no `access` never lands here.
   */
  async function authorizeFetch(
    request: Request,
    fragment: ResolvedFragmentManifest,
  ): Promise<Response | null> {
    if (isDevelopment || !hasAccessRules(fragment)) return null;

    const principal = await resolvePrincipal(request);
    if (canFetch(fragment, principal)) return null;

    if (!canList(fragment, principal)) {
      return htmlResponse(
        `<!doctype html><title>Braid: unknown fragment</title><p>Unknown fragment</p>`,
        404,
      );
    }

    return htmlResponse(
      `<!doctype html><title>Braid: forbidden</title><p>You do not have access to this fragment.</p>`,
      403,
      { [BRAID_FRAGMENT_ID_HEADER]: fragment.id },
    );
  }

  async function forwardToFragment(
    request: Request,
    requestUrl: URL,
    strippedPathname: string,
    fragment: ResolvedFragmentManifest,
    options: { prepare?: boolean } = {},
  ): Promise<Response> {
    const result = await fetchFragment(request, requestUrl, `${strippedPathname}${requestUrl.search}`, fragment);

    if (!result.ok && result.outOfScope) {
      console.warn(String(result.error));
      return htmlResponse(
        mode === 'development'
          ? `<p>braid-gateway: that path is outside the endpoint declared by fragment "${escapeHtml(fragment.id)}".</p>`
          : '<p>Not found</p>',
        404,
        { [BRAID_FRAGMENT_ID_HEADER]: fragment.id },
      );
    }

    if (!result.ok) {
      return htmlResponse(
        mode === 'development'
          ? `<p>braid-gateway: ${describeFragmentFailure(fragment, result)}.<br>` +
              `Endpoint: ${escapeHtml(describeEndpoint(fragment))}<br>` +
              `Error: ${escapeHtml(String(result.error))}</p>`
          : '<p>There was a problem fulfilling your request.</p>',
        result.timedOut ? 504 : 502,
        { [BRAID_FRAGMENT_ID_HEADER]: fragment.id },
      );
    }

    /**
     * A fragment *document* gets exactly the preparation pierced content gets. Without it the
     * same fragment would behave differently depending on whether it was server-rendered into
     * the page or fetched by the slot — its relative asset URLs would resolve against the host
     * page, and its scripts would arrive live in the host realm.
     */
    const prepare =
      options.prepare && result.response.headers.get('content-type')?.toLowerCase().includes('text/html');

    const body =
      prepare && result.response.body
        ? prepareFragmentHtml(result.response.body, { fragmentId: fragment.id })
        : result.response.body;

    const isNullBody =
      result.response.status === 204 ||
      result.response.status === 205 ||
      result.response.status === 304 ||
      (result.response.status >= 100 && result.response.status < 200);

    const forwarded = new Response(isNullBody ? null : body, result.response);
    forwarded.headers.append(BRAID_FRAGMENT_ID_HEADER, fragment.id);
    if (prepare) {
      // the body was transformed, so any length the endpoint declared no longer describes it
      forwarded.headers.delete('content-length');
    }
    return forwarded;
  }

  type FragmentFetchResult =
    | { ok: true; response: Response }
    | { ok: false; error: unknown; timedOut: boolean; outOfScope?: boolean };

  /**
   * Fetches from a fragment's endpoint. The namespace prefix is already stripped, so the
   * endpoint sees the same path it would serve standalone.
   */
  async function fetchFragment(
    request: Request,
    requestUrl: URL,
    /** The path on the fragment's own endpoint, query included. */
    path: string,
    fragment: ResolvedFragmentManifest,
    /** What this fetch is for. Only used to label telemetry. */
    phase: 'pierce' | 'namespace' = 'namespace',
  ): Promise<FragmentFetchResult> {
    const { endpoint } = fragment;

    // The caller composes the whole path, query included. Whether the page's query belongs on this
    // request is a question only the caller can answer — a namespace request forwards it, a bound
    // fragment renders it, and to a widget the host's `?tab=` means nothing at all.
    const strippedUrl = new URL(path, requestUrl);

    let fragmentRequestUrl: URL;
    let fragmentFetch: typeof fetch;

    if (typeof endpoint === 'function') {
      fragmentRequestUrl = strippedUrl;
      fragmentFetch = endpoint;
    } else {
      try {
        fragmentRequestUrl = resolveEndpointUrl(endpoint, strippedUrl, fragment.id);
      } catch (error) {
        return { ok: false, error, timedOut: false, outOfScope: error instanceof EndpointScopeError };
      }
      fragmentFetch = globalThis.fetch;
    }

    const fragmentRequest = new Request(fragmentRequestUrl, request);

    // `new Request(url, request)` copies every header, including the caller's credentials.
    // Those authenticate the caller to the *shell's* origin, and a fragment endpoint is a
    // different origin by construction — so they are removed unless the host has said its whole
    // registry is inside one trust boundary. See `forwardCredentials`.
    if (!forwardCredentials) {
      fragmentRequest.headers.delete('cookie');
      fragmentRequest.headers.delete('authorization');
    }

    // Tell the fragment endpoint the protocol and host the *user* reached us on.
    //
    // These are overwritten, not forwarded: an incoming x-forwarded-host is client-controlled,
    // and fragments routinely build absolute URLs from it. Set `trustForwardedHeaders` only
    // when a proxy you control is the sole path to this gateway.
    fragmentRequest.headers.set(
      'x-forwarded-proto',
      (trustForwardedHeaders && request.headers.get('x-forwarded-proto')) || requestUrl.protocol.slice(0, -1),
    );
    fragmentRequest.headers.set(
      'x-forwarded-host',
      (trustForwardedHeaders && request.headers.get('x-forwarded-host')) || requestUrl.host,
    );

    // After the credential strip, so a host can deliberately supply its own `authorization` for
    // a fragment; before the protocol headers below, which are the gateway's to state.
    // Captured, because these names go into the coalescing key below: a function-form
    // `additionalHeaders` varies per caller, and a key blind to it would share one caller's
    // fragment render with another.
    const extraHeaderNames: string[] = [];
    for (const [name, value] of Object.entries(resolveAdditionalHeaders(request))) {
      fragmentRequest.headers.set(name, value);
      extraHeaderNames.push(name);
    }

    // the endpoint serves an embedded fragment, not a full document
    fragmentRequest.headers.set('sec-fetch-dest', 'empty');
    fragmentRequest.headers.set('x-braid-fragment-mode', 'embedded');

    /**
     * In development, present the request as coming from the endpoint's own origin.
     *
     * Module scripts are fetched in CORS mode, so the browser attaches the *host page's* origin
     * to every one of a fragment's script requests. Dev servers (Vite, and anything else with
     * cross-origin request protection) reject those with a 403, which shows up as a fragment
     * that boots but renders nothing. The gateway is the origin-front here, so rewriting the
     * header is truthful: from the endpoint's perspective the request did come from its origin.
     *
     * Not done in production, where an endpoint may legitimately want the real origin.
     */
    if (isDevelopment && typeof endpoint === 'string') {
      fragmentRequest.headers.set('origin', new URL(endpoint).origin);
      fragmentRequest.headers.delete('referer');
    }

    // a document request carries validators for the *shell*; they mean nothing to the fragment
    fragmentRequest.headers.delete('if-none-match');
    fragmentRequest.headers.delete('if-modified-since');

    // per-fragment timeout budget from the manifest
    const timeoutSignal = AbortSignal.timeout(fragment.timeoutMs);

    // Refuse before spending the budget. The caller's fallback handling is identical either way —
    // this only changes how long it waits to get there.
    if (breaker && !breaker.allows(fragment.id)) {
      emit({
        kind: 'fragment-fetch',
        fragmentId: fragment.id,
        phase,
        outcome: 'shed',
        durationMs: 0,
        at: Date.now(),
      });
      return { ok: false, error: new BreakerOpenError(fragment.id), timedOut: false };
    }

    // Measured around the fetch only. The header work above is this process's own time, and
    // attributing it to the fragment's endpoint would make every fragment look slower than it is.
    const startedAt = performance.now();

    try {
      // don't follow redirects: they are sent all the way to the client, which can then decide
      // to follow them or not (this keeps window.location correct in the fragment's realm)
      // Coalesced only when the manifest declares no access rules. A gated fragment's response
      // depends on an authorization decision this layer has already made per-request, and sharing
      // one across two callers would share that decision with it.
      const key =
        singleFlight && fragment.coalesce !== false && !hasAccessRules(fragment)
          ? singleFlightKey(fragmentRequest, fragmentRequestUrl.href, extraHeaderNames)
          : null;

      const response = key
        ? await singleFlight!.run(key, () => fragmentFetch(fragmentRequest, { redirect: 'manual', signal: timeoutSignal }))
        : await fragmentFetch(fragmentRequest, { redirect: 'manual', signal: timeoutSignal });

      // A 5xx is a reachable endpoint, but it is not a working one — a fragment returning 500 on
      // every request would otherwise hold the circuit closed forever and keep paying for it.
      if (response.status >= 500) breaker?.failed(fragment.id);
      else breaker?.succeeded(fragment.id);

      emit({
        kind: 'fragment-fetch',
        fragmentId: fragment.id,
        phase,
        // A 5xx is a response, not a failed fetch. Reported as `ok` with its status rather than as
        // an error, because the distinction the operator needs is "did we reach it" — and folding
        // a reachable-but-broken endpoint into the same bucket as an unreachable one loses it.
        outcome: 'ok',
        status: response.status,
        durationMs: performance.now() - startedAt,
        at: Date.now(),
      });
      return { ok: true, response };
    } catch (error) {
      breaker?.failed(fragment.id);
      emit({
        kind: 'fragment-fetch',
        fragmentId: fragment.id,
        phase,
        outcome: timeoutSignal.aborted ? 'timeout' : 'error',
        durationMs: performance.now() - startedAt,
        at: Date.now(),
      });
      return { ok: false, error, timedOut: timeoutSignal.aborted };
    }
  }

  /**
   * Handles a request bound for the shell application.
   *
   * A document navigation to a URL some fragment declares in `pierce` is composed. Any *other*
   * request to such a URL is passed through — but still gets `vary: sec-fetch-dest`, because
   * the same URL now has two representations. Without it a shared cache can store the
   * unpierced shell from a soft-navigation fetch and later serve it to a real navigation,
   * silently dropping the fragment from the page.
   *
   * The unpierced representation is marked shared-cache-unsafe for the same reason the composed
   * one is: it is the *other* half of the pair a cache could confuse. See
   * {@link GatewayOptions.pierceCacheControl}.
   */
  async function handleShellRequest(
    request: Request,
    requestUrl: URL,
    next: () => Promise<Response>,
  ): Promise<Response | null> {
    if (request.method !== 'GET') return null;

    const matches = await registry.matchPierceRoutes(requestUrl.pathname);
    const isDocument = isDocumentRequest(request);

    // Observed before the early return below, so paths that compose *nothing* are recorded too.
    // Only document requests: they are the population that could ever compose, and a soft
    // navigation fetching the same URL is not a second page view.
    if (options.observe && isDocument) {
      options.observe({
        pathname: requestUrl.pathname,
        fragmentIds: matches.map((manifest) => manifest.id),
        at: Date.now(),
      });
    }

    if (matches.length === 0) return null;

    if (isDocument) {
      // a fragment the caller may not load is simply not composed into their page; the slot is
      // left for the client, which will get the same 403/404 and can render it as it sees fit
      const permitted: ResolvedFragmentManifest[] = [];
      for (const fragment of matches) {
        if (!(await authorizeFetch(request, fragment))) permitted.push(fragment);
      }

      if (permitted.length > 0) {
        return pierceDocument(request, requestUrl, next, permitted);
      }
    }

    const shell = await next();
    const isNullBody =
      shell.status === 204 ||
      shell.status === 205 ||
      shell.status === 304 ||
      (shell.status >= 100 && shell.status < 200);
    const passthrough = new Response(isNullBody ? null : shell.body, shell);
    passthrough.headers.append('vary', 'sec-fetch-dest');
    applyPierceCacheControl(passthrough.headers);
    return passthrough;
  }

  /**
   * Composes a document response: the shell, with every fragment that declares this page URL
   * pierced into the slot that names it.
   *
   * The shell and all matching fragments are fetched concurrently, and the fragments' HTML is
   * interleaved into the shell's stream as it arrives — so a fragment never serializes behind
   * the shell, and the page paints with fragments already present.
   */
  async function pierceDocument(
    request: Request,
    requestUrl: URL,
    next: () => Promise<Response>,
    matches: ResolvedFragmentManifest[],
  ): Promise<Response | null> {
    const pagePath = `${requestUrl.pathname}${requestUrl.search}`;
    const [shellResponse, ...fragmentResults] = await Promise.all([
      next(),
      // A bound fragment renders the page's own route, so the endpoint gets the page path. An
      // unbound one is chrome: its content lives at one fixed path, and asking a notifications
      // endpoint for `/billing/invoices` is a question it has no answer to.
      ...matches.map((fragment) => fetchFragment(request, requestUrl, fragmentPath(fragment, requestUrl), fragment, 'pierce')),
    ]);

    const isShellNullBody =
      shellResponse.status === 204 ||
      shellResponse.status === 205 ||
      shellResponse.status === 304 ||
      (shellResponse.status >= 100 && shellResponse.status < 200);
    const shell = new Response(isShellNullBody ? null : shellResponse.body, shellResponse);
    shell.headers.append('vary', 'sec-fetch-dest');
    applyPierceCacheControl(shell.headers);

    const isHtml = shell.headers.get('content-type')?.toLowerCase().includes('text/html');

    if (!shell.ok || !isHtml || !shell.body) {
      // nothing to pierce into: hand the shell back untouched and cancel the fragment bodies
      await Promise.all(
        fragmentResults.map((result) => (result.ok ? result.response.body?.cancel() : undefined)),
      );
      return shell;
    }

    const targets: PierceTarget[] = matches.map((fragment, index) => {
      const result = fragmentResults[index];
      const failed = !result.ok || !result.response.ok || !result.response.body;

      if (!failed) {
        return {
          fragmentId: fragment.id,
          content: prepareFragmentHtml(result.response.body!, { fragmentId: fragment.id }),
          ...(fragment.src === undefined ? {} : { src: fragment.src }),
        };
      }

      const detail = !result.ok
        ? describeFragmentFailure(fragment, result)
        : `fragment "${fragment.id}" responded with HTTP ${result.response.status}`;
      console.warn(`braid-gateway: not piercing ${pagePath} — ${detail}`);

      if (result.ok) void result.response.body?.cancel();

      // `error-html` is the only fallback that renders something; `omit` and `placeholder`
      // leave the slot empty, and the client runtime fetches the fragment itself — a failed
      // pierce degrades to the client-side boot path rather than to a broken page
      if (fragment.fallback === 'error-html') {
        return {
          fragmentId: fragment.id,
          content: stringStream(
            mode === 'development'
              ? `<braid-html><braid-body><p>braid-gateway: ${escapeHtml(detail)}</p></braid-body></braid-html>`
              : '<braid-html><braid-body><p>This section is temporarily unavailable.</p></braid-body></braid-html>',
          ),
        };
      }

      return {
        fragmentId: fragment.id,
        content: null,
        ...(fragment.fallback === 'placeholder' ? { fallbackReason: 'placeholder' } : {}),
      };
    });

    const pierced = new Response(
      pierceShellHtml({
        shell: shell.body,
        fragments: targets,
        // From the shell's own policy — see `cspNonceOf`. Without this, a strict CSP drops the
        // slot layout rule and the collector silently, leaving a page that renders wrong with
        // nothing in any server log to explain it.
        nonce: cspNonceOf(shell.headers),
        // `defer` rather than `async`: the collector registers buffered observers, so it does not
        // race the paint it measures, and deferring keeps it off the parser's critical path.
        ...(vitalsEnabled ? { headScript: `<script src="${BRAID_VITALS_SCRIPT_PATH}" defer></script>` } : {}),
      }),
      shell,
    );
    // the body is transformed, so any length/encoding the shell declared no longer describes it
    pierced.headers.delete('content-length');
    pierced.headers.delete('content-encoding');
    for (const target of targets) {
      pierced.headers.append(BRAID_FRAGMENT_ID_HEADER, target.fragmentId);
    }
    return pierced;
  }

  /**
   * The path this fragment's content is fetched from for a given page.
   *
   * The whole difference between a screen and a widget, in one expression.
   */
  function fragmentPath(fragment: ResolvedFragmentManifest, requestUrl: URL): string {
    // `src` verbatim, query and all: an unbound fragment's content lives at one address, and
    // appending the page's query would give the widget a different cache key on every page it
    // appears on while changing nothing about what it renders.
    if (fragment.bound === false && fragment.src) return fragment.src;
    return `${requestUrl.pathname}${requestUrl.search}`;
  }

  /**
   * The generated worker script.
   *
   * **Kept byte-stable across registry publishes**, deliberately. The tempting move is to bake the
   * pinned snapshot id and the fragment ids into it, since this gateway knows them — but then the
   * script changes on every publish, and every change is a worker update with its own waiting and
   * activation lifecycle. Configuration churn must not become worker churn, so anything that varies
   * with the registry is fetched by the worker at runtime instead.
   */
  function serviceWorkerResponse(config: ServiceWorkerOptions): Response {
    const module = config.module ?? '/braid-sw.js';
    const setup = {
      ...(config.buildId === undefined ? {} : { buildId: config.buildId }),
      ...(config.precache === undefined ? {} : { precache: [...config.precache] }),
    };

    const script =
      `// Generated by @braidlabs/gateway. Serves the Braid namespace only.\n` +
      `import { setupBraidWorker } from ${JSON.stringify(module)};\n` +
      `setupBraidWorker(${JSON.stringify(setup)});\n`;

    return new Response(script, {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        // The whole reason this lives on the gateway: without it the worker's scope is capped at
        // /__braid/, where it could serve fragment assets but not the shell's own.
        'service-worker-allowed': config.scope ?? '/',
        // A worker script must not be served stale — the browser's update check is the only thing
        // that ever replaces it.
        'cache-control': 'no-cache',
      },
    });
  }

  /**
   * Receives a vitals beacon.
   *
   * Always answers 204, including for a body it rejected. The browser cannot act on an error here
   * — `sendBeacon` fires as the page unloads and nothing is listening for the response — so a
   * status code would only be a signal to whoever is probing the endpoint about what it accepts.
   */
  async function handleVitalsBeacon(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });

    try {
      const body: unknown = await request.json();
      const known = new Set((await registry.listFragments()).map((fragment) => fragment.id));
      for (const event of parseVitalsBeacon(body, known)) emit(event);
    } catch {
      // A malformed beacon is not worth a log line: it is either a truncated unload or someone
      // poking the endpoint, and neither is actionable.
    }

    return new Response(null, { status: 204 });
  }

  function describeFragmentFailure(
    fragment: ResolvedFragmentManifest,
    result: { timedOut: boolean },
  ): string {
    if (result.timedOut) return `fragment "${fragment.id}" exceeded its ${fragment.timeoutMs}ms timeout budget`;
    if (breaker?.stateOf(fragment.id) === 'open') {
      return `fragment "${fragment.id}" has an open circuit after repeated failures; serving its fallback without attempting a fetch`;
    }
    return `fetching fragment "${fragment.id}" failed`;
  }

  function describeEndpoint(fragment: ResolvedFragmentManifest): string {
    return typeof fragment.endpoint === 'function' ? '[fetcher function]' : String(fragment.endpoint);
  }

  /**
   * Keeps a pierce-matched page URL out of shared caches, unless the app opted out.
   *
   * Rewrites rather than replaces: an app's own `max-age`, `no-store`, or
   * `stale-while-revalidate` is its business — only the *shared*-cacheability directives are
   * touched, because those are the ones that can hand one representation of this URL to a
   * request that asked for the other.
   */
  function applyPierceCacheControl(headers: Headers): void {
    if (pierceCacheControl === 'preserve') return;

    const directives = (headers.get('cache-control') ?? '')
      .split(',')
      .map((directive) => directive.trim())
      .filter((directive) => directive && !/^(public|s-maxage=.*|proxy-revalidate)$/i.test(directive));

    if (!directives.some((directive) => /^(private|no-store)$/i.test(directive))) {
      directives.unshift('private');
    }

    headers.set('cache-control', directives.join(', '));
  }

  /**
   * A gateway-authored response inside a braid namespace.
   *
   * No `Vary` here: since realm stubs and prepared documents have their own paths, every braid
   * URL has exactly one representation and caches on URL alone.
   */
  function htmlResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
    return new Response(body, {
      status,
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        ...headers,
      },
    });
  }
}

/**
 * Wraps a gateway as web middleware: braid requests are handled — including document requests
 * that pierce fragments into the shell — and everything else goes to the shell via `next()`.
 *
 * `next` is memoized, so the shell application runs at most once per request no matter how the
 * gateway and the caller interleave.
 */
export function toWebMiddleware(
  gateway: BraidGateway,
): (request: Request, next: () => Promise<Response>) => Promise<Response> {
  return async (request, next) => {
    const shellOnce = once(next);
    return (await gateway.handle(request, shellOnce)) ?? shellOnce();
  };
}

/**
 * Wraps a fetch handler — the shell application as `(Request) => Response` — with the gateway.
 *
 * This is the binding for every web-standard runtime: Cloudflare Workers, Deno, Bun, and
 * h3/Nitro (via `toWebHandler(app)`). It is also the only in-process way to pierce on those
 * runtimes, because piercing needs to *read* the shell's response, which a middleware chain
 * with no return value cannot give it.
 *
 * ```ts
 * // h3 / Nitro
 * import { toWebHandler } from 'h3';
 * export default toFetchHandler(gateway, toWebHandler(app));
 * ```
 */
export function toFetchHandler(
  gateway: BraidGateway,
  appHandler: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const shellOnce = once(() => Promise.resolve(appHandler(request)));
    return (await gateway.handle(request, shellOnce)) ?? shellOnce();
  };
}

/** Memoizes an async thunk so the wrapped work happens at most once. */
function once(fn: () => Promise<Response>): () => Promise<Response> {
  let pending: Promise<Response> | undefined;
  return () => (pending ??= fn());
}

/**
 * Whether a request is a top-level document navigation, which is what piercing composes.
 *
 * `sec-fetch-dest` is the reliable signal in browsers; the `accept` heuristic covers clients
 * that don't send fetch metadata (curl, some proxies, tests).
 */
function isDocumentRequest(request: Request): boolean {
  if (request.method !== 'GET') return false;

  const destination = request.headers.get('sec-fetch-dest');
  if (destination) return destination === 'document';

  return request.headers.get('accept')?.includes('text/html') ?? false;
}

/**
 * Resolves a namespace-stripped request against a fragment's endpoint, **within the endpoint's
 * own path**.
 *
 * `new URL('/admin', 'https://internal/apps/billing/')` yields `https://internal/admin`: an
 * absolute path replaces the endpoint's path entirely. Left alone, that turns the gateway into
 * a proxy for the endpoint host's whole origin rather than the subtree the manifest declared.
 * So the endpoint's path is treated as a prefix.
 *
 * The containment check afterwards is belt-and-braces: dot segments, including percent-encoded
 * ones (`%2e%2e`), are already normalized when the incoming request URL is parsed, which takes
 * such a request out of the fragment namespace entirely before it ever reaches here. The check
 * costs nothing and does not assume every runtime normalizes identically.
 */
export function resolveEndpointUrl(endpoint: string, strippedUrl: URL, fragmentId: string): URL {
  const endpointUrl = new URL(endpoint);
  const basePath = endpointUrl.pathname.endsWith('/') ? endpointUrl.pathname.slice(0, -1) : endpointUrl.pathname;

  const resolved = new URL(`${basePath}${strippedUrl.pathname}${strippedUrl.search}`, endpointUrl.origin);

  if (basePath && resolved.pathname !== basePath && !resolved.pathname.startsWith(`${basePath}/`)) {
    throw new EndpointScopeError(
      `braid-gateway: a request for fragment "${fragmentId}" resolved to "${resolved.pathname}", outside its ` +
        `endpoint path "${basePath}/" — refusing to forward it`,
    );
  }

  return resolved;
}

/** Thrown when a namespace request would reach outside its fragment endpoint's declared path. */
class EndpointScopeError extends Error {}

/**
 * The breaker refused a request without making it.
 *
 * A distinct type so the failure description can say the circuit is open rather than blame the
 * endpoint for a request it never received — an operator reading "fetching fragment X failed"
 * about a fetch that never happened would go and check the wrong system.
 */
class BreakerOpenError extends Error {
  constructor(fragmentId: string) {
    super(`fragment "${fragmentId}" has an open circuit; not attempting a fetch`);
    this.name = 'BreakerOpenError';
  }
}

function stringStream(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

/**
 * The manifest fields an adapter needs, serialized onto the realm stub.
 *
 * Only fields that mean something to *some* adapter travel here — the runtime itself never reads
 * them. Emitted only when there is something to say, so a compat fragment's stub is unchanged.
 */
function adapterOptionsMeta(fragment: ResolvedFragmentManifest): string {
  const options: Record<string, unknown> = {};

  // `entry` is a path on the fragment's *own* origin, so it is re-rooted into the fragment's
  // namespace exactly as the subresource URLs in its HTML are — a manifest never has to know
  // the gateway's URL layout. URLs with a scheme are somebody else's origin; left alone.
  if (fragment.entry) {
    options['entry'] = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(fragment.entry)
      ? fragment.entry
      : braidFragmentUrl(fragment.id, fragment.entry.startsWith('/') ? fragment.entry : `/${fragment.entry}`);
  }
  if (fragment.element) options['element'] = fragment.element;
  if (fragment.events) options['events'] = Object.keys(fragment.events);
  // Capabilities ride the same stub as the adapter options: the client needs them before it opens
  // the boundary, and the stub is the one thing it reads before anything else crosses.
  if (fragment.capabilities) options['capabilities'] = fragment.capabilities;

  if (Object.keys(options).length === 0) return '';

  return `<meta name="${BRAID_ADAPTER_OPTIONS_META}" content="${escapeHtml(JSON.stringify(options))}">`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
