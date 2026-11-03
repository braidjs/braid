import {
  createGateway,
  toFetchHandler,
  toWebMiddleware,
  type BraidGateway,
  type GatewayOptions,
} from '@braidlabs/gateway';
import {
  braidFetchHandler,
  type BraidFetchHandlerOptions,
} from './asset-handler.js';

/**
 * The gateway itself, run inside the worker: composition for an origin that has no server to put
 * a gateway on — static hosting, a CDN bucket, a shell someone else deploys.
 *
 * Not a second gateway. The gateway core is runtime-neutral, so this is the same `createGateway`
 * the server runs, given the network as its shell. What this module adds is what a worker needs
 * and a server does not: a decision, made synchronously, about which requests to answer — a
 * `fetch` listener must call `respondWith` before it returns, long before the gateway knows
 * whether a page will pierce.
 *
 * Two things carry over differently from a server, and both are the browser's rules rather than
 * this module's. The worker's `fetch` cannot set forbidden headers, so `Cookie` is not forwarded
 * by name — a same-origin endpoint gets the browser's own cookies, a cross-origin one none, as
 * for the page's own requests. And a cross-origin endpoint must answer CORS at all, because the
 * worker reads the response it pierces.
 */

/** The gateway's options, less the one that would have the worker serve a worker. */
export type BraidGatewayHandlerOptions = Omit<GatewayOptions, 'serviceWorker'>;

export interface BraidGatewayHandler {
  /**
   * Answers a request the gateway owns, or returns `null` — synchronously — for one it leaves to
   * the browser. Pass the event's `preloadResponse` and a navigation's shell is the preloaded one;
   * a worker that turns preload on should know the browser preloads realm frames too, which this
   * answers itself, so each also reaches the server.
   */
  (
    request: Request,
    preloadResponse?: Promise<Response | undefined>,
  ): Promise<Response> | null;
  /**
   * Any request through the gateway, the network behind it. Hand this to {@link braidFetchHandler}
   * as its `fetch` and the skew cache sits in front of the in-worker gateway, as it would sit in
   * front of a server one. Unlike the handler it claims nothing: whatever it is given, it routes.
   */
  readonly fetch: typeof fetch;
  readonly gateway: BraidGateway;
  /** Whether the handler would claim this request, decided as the handler decides it. */
  claims(request: Request): boolean;
}

/**
 * Builds the in-worker gateway, to compose into a worker you already own.
 *
 * ```js
 * import { braidGatewayHandler } from '@braidlabs/sw/gateway';
 *
 * const braid = braidGatewayHandler({ registry: [{ id: 'billing', endpoint: '/billing-app/', pierce: ['/billing/*'] }] });
 * self.addEventListener('fetch', (event) => {
 *   const handled = braid(event.request, event.preloadResponse);
 *   if (handled) event.respondWith(handled);
 * });
 * ```
 *
 * Claims a same-origin request in the Braid namespace (under `basePath`, when set), and every GET
 * navigation — whether a page pierces is the registry's answer, and it arrives too late to decide
 * on. A navigation no fragment claims goes to the network unchanged, and so does a shell that
 * answers with a redirect.
 */
export function braidGatewayHandler(
  options: BraidGatewayHandlerOptions,
): BraidGatewayHandler {
  const gateway = createGateway(options);
  // as the gateway trims it, which has already refused a malformed one
  const namespace = `${(options.basePath ?? '').replace(/\/+$/, '')}/__braid/`;
  const network = (request: Request) => globalThis.fetch(request);
  const viaGateway = toFetchHandler(gateway, network);
  const compose = toWebMiddleware(gateway);

  const claims = (request: Request): boolean => {
    const url = new URL(request.url);
    // `location` is the worker's own; without one (a test, a non-worker runtime) there is no
    // origin to compare against, and nothing to leave to a browser either
    const origin = (globalThis as { location?: { origin: string } }).location
      ?.origin;
    if (origin !== undefined && url.origin !== origin) return false;
    return (
      url.pathname.startsWith(namespace) ||
      (request.method === 'GET' && isNavigation(request))
    );
  };

  const handler = (
    request: Request,
    preloadResponse?: Promise<Response | undefined>,
  ): Promise<Response> | null => {
    if (!claims(request)) return null;
    if (new URL(request.url).pathname.startsWith(namespace))
      return asGatewayRequest(request).then(viaGateway);

    // The shell is the browser's own navigation — preloaded while the worker booted, when it was,
    // and asked for again if the preload failed — and the gateway gets a copy it can derive
    // fragment requests from.
    const shell = () =>
      Promise.resolve(preloadResponse).then(
        (preloaded) => preloaded ?? network(request),
        () => network(request),
      );
    return asGatewayRequest(request).then((copy) => compose(copy, shell));
  };

  const fetchViaGateway = (input: RequestInfo | URL, init?: RequestInit) =>
    asGatewayRequest(
      input instanceof Request && init === undefined
        ? input
        : new Request(input, init),
    ).then(viaGateway);

  return Object.assign(handler, {
    fetch: fetchViaGateway as typeof fetch,
    gateway,
    claims,
  });
}

export interface BraidGatewayWorkerOptions extends BraidGatewayHandlerOptions {
  /**
   * Keep fragment assets in build-keyed partitions, as {@link braidFetchHandler} does, in front of
   * the in-worker gateway. Off by default. Not yet supported together with `basePath`, where the
   * asset handler would not recognise the namespace and cache nothing; combining them throws.
   */
  assets?: Omit<BraidFetchHandlerOptions, 'fetch'>;
  /**
   * Take over open pages as soon as this worker activates, so the page that installed it composes
   * without a reload — and answer a page that asks to be claimed, which is how a page loaded with
   * the worker bypassed (a hard reload) gets it back. Off by default, for the reason it is off in
   * `setupBraidWorker`: a page mid-session starts being served by a worker it did not load against.
   */
  claimClients?: boolean;
}

/** The message a page posts to an active worker that is not controlling it. */
export const BRAID_CLAIM_MESSAGE = 'braid-sw:claim';

/**
 * Installs the in-worker gateway as the whole worker, and returns the gateway it runs — the one
 * thing a worker built this way might still want to reach, for `refreshRegistry()` say.
 *
 * ```js
 * // sw.js
 * import { setupBraidGateway } from '@braidlabs/sw/gateway';
 * setupBraidGateway({ registry: [{ id: 'billing', endpoint: '/billing-app/', pierce: ['/billing/*'] }] });
 * ```
 */
export function setupBraidGateway(
  options: BraidGatewayWorkerOptions,
): BraidGateway {
  const scope = globalThis as unknown as {
    addEventListener(
      type: string,
      listener: (event: GatewayFetchEvent) => void,
    ): void;
    clients?: { claim(): Promise<void> };
    registration?: {
      navigationPreload?: { enable(): Promise<void>; disable(): Promise<void> };
    };
  };
  const { assets, claimClients, ...gatewayOptions } = options;
  if (assets && gatewayOptions.basePath) {
    throw new Error(
      'braid-sw: `assets` is not yet supported together with `basePath`',
    );
  }
  const braid = braidGatewayHandler(gatewayOptions);
  const cached = assets
    ? braidFetchHandler({ ...assets, fetch: braid.fetch })
    : null;

  scope.addEventListener('activate', (event) => {
    // Off, though every navigation passes through: the browser preloads *every* navigation in
    // scope, the realm frames this worker answers itself among them, so each would also reach a
    // server that has no answer for it. And the setting outlives the worker that set it.
    const work: Promise<unknown>[] = [
      scope.registration?.navigationPreload?.disable().catch(() => undefined) ??
        Promise.resolve(),
    ];
    if (claimClients && scope.clients) work.push(scope.clients.claim());
    event.waitUntil?.(Promise.all(work));
  });

  scope.addEventListener('message', (event) => {
    if (
      !claimClients ||
      (event.data as { type?: string } | undefined)?.type !==
        BRAID_CLAIM_MESSAGE
    )
      return;
    if (scope.clients) event.waitUntil?.(scope.clients.claim());
  });

  scope.addEventListener('fetch', (event) => {
    // the claim decision first: the asset cache matches by path alone, on any origin
    if (!braid.claims(event.request)) return;
    const handled =
      cached?.(event.request) ?? braid(event.request, event.preloadResponse);
    if (handled) event.respondWith?.(handled);
  });

  return braid.gateway;
}

/**
 * A navigation, as a request the gateway can build its own from.
 *
 * The gateway derives each fragment request with `new Request(url, request)`, which a browser
 * refuses for a `navigate`-mode request — and the gateway, catching that, would serve every
 * pierced slot as a placeholder. A server never sees that mode, so only a worker has to do this.
 *
 * Credentials go as a page's own `fetch` sends them, same-origin only, rather than as the
 * navigation's `include`: a pierce must not be a credentialed CORS request where the page's own
 * requests for the same fragment are not. A body is read up front, since a browser streams a
 * request body only over HTTP/2.
 */
async function asGatewayRequest(request: Request): Promise<Request> {
  if (request.mode !== 'navigate') return request;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    credentials: 'same-origin',
    // `only-if-cached` is refused outside same-origin mode, which a copy cannot have
    cache: request.cache === 'only-if-cached' ? 'default' : request.cache,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
  });
}

/**
 * Only the browser's own navigations. A page's `fetch` with an HTML `Accept` (htmx, Turbo, a
 * prefetch) is a fetch, and the gateway — which in a worker cannot see `Sec-Fetch-Dest` — would
 * otherwise pierce it as a document.
 */
function isNavigation(request: Request): boolean {
  return request.mode === 'navigate';
}

/** The slice of the worker events used here. */
interface GatewayFetchEvent {
  request: Request;
  data?: unknown;
  respondWith?(response: Promise<Response> | Response): void;
  waitUntil?(promise: Promise<unknown>): void;
  preloadResponse?: Promise<Response | undefined>;
}
