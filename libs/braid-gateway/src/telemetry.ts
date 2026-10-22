/**
 * Optional telemetry: what the gateway did on the server, and what the user experienced in the
 * browser — both attributed to the fragment responsible.
 *
 * **The attribution is the point.** Server-side timings per fragment are ordinary; a reverse proxy
 * gives you those. Web vitals per *fragment* are not, because in a composed page the page-level
 * number is an average over apps owned by different teams. "The page has a CLS of 0.31" starts an
 * argument. "Ninety percent of the layout shift happened inside `reviews`" ends it.
 *
 * Off unless configured, and configured as one hook rather than a sink: what to do with an event —
 * OpenTelemetry, a log line, a counter, nothing — is the deployment's decision, and a gateway that
 * picked for you would be a dependency you did not ask for.
 */

/** Fires when the gateway fetches a fragment's endpoint. Server-side, always available. */
export interface FragmentFetchEvent {
  kind: 'fragment-fetch';
  fragmentId: string;
  /**
   * Why the fetch happened: composing a document, or serving a request addressed to the
   * fragment's namespace. Worth distinguishing — a slow pierce delays the page, while a slow
   * namespace asset delays only that fragment.
   */
  phase: 'pierce' | 'namespace';
  /**
   * `'shed'` means the breaker refused the request without making it — no endpoint was contacted,
   * so there is no status and the duration is ~0. Distinct from `error` on purpose: an operator
   * counting failures must not count our own load-shedding as the endpoint failing again.
   */
  outcome: 'ok' | 'error' | 'timeout' | 'shed';
  /** Absent when the fetch threw before a response existed. */
  status?: number;
  durationMs: number;
  at: number;
}

export type WebVitalName = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB';

/** Fires when a browser reports a web vital, attributed to a fragment where one can be blamed. */
export interface WebVitalEvent {
  kind: 'web-vital';
  name: WebVitalName;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  /**
   * The fragment whose subtree the metric was attributed to.
   *
   * `null` is a real answer, not a gap: TTFB belongs to the document, and an LCP element in the
   * shell's own markup is genuinely the shell's. Blaming a fragment for those would be worse than
   * saying nothing.
   */
  fragmentId: string | null;
  pathname: string;
  at: number;
}

/** Fires when a fragment's circuit breaker changes state. Never per request — only on the edges. */
export interface BreakerEvent {
  kind: 'breaker';
  fragmentId: string;
  from: 'closed' | 'open' | 'half-open';
  to: 'closed' | 'open' | 'half-open';
  /** Consecutive failures at the moment of the transition. */
  failures: number;
  at: number;
}

export type TelemetryEvent = FragmentFetchEvent | WebVitalEvent | BreakerEvent | RegistryEvent;

/**
 * Fires when a `registryRefreshMs` reload swaps in a changed registry, or fails. An unchanged
 * reload is silent: on a short interval it would be a heartbeat, not an event.
 */
export type RegistryEvent =
  | { kind: 'registry'; outcome: 'refreshed'; fragmentCount: number; at: number }
  | { kind: 'registry'; outcome: 'failed'; error: string; at: number };

export interface TelemetryOptions {
  /**
   * Called for every event.
   *
   * **On the request path for server events, so it must be cheap.** Called synchronously and never
   * awaited; a sink that does real work should buffer and flush elsewhere. Unlike `observe`, this
   * one *is* wrapped — a broken telemetry sink must not fail the request it is describing, because
   * the whole point is to be safe to leave on in production.
   */
  on: (event: TelemetryEvent) => void;
  /**
   * Collect web vitals in the browser and report them here. Off by default.
   *
   * Turning this on serves a small collector from the gateway and injects it into composed
   * documents. It is off by default because it adds a script to every pierced page, and that is
   * not a decision a library should make for a deployment.
   */
  webVitals?: boolean;
  /**
   * Fraction of *browser sessions* that report, 0–1. Defaults to 1.
   *
   * Sampled per session rather than per metric on purpose: a session that reports its LCP but not
   * its CLS produces a dataset where the two cannot be correlated, which quietly ruins the
   * analysis they were collected for.
   */
  sampleRate?: number;
}

/** Thresholds from web.dev. Kept here so the gateway and the collector cannot disagree. */
const THRESHOLDS: Record<WebVitalName, [good: number, poor: number]> = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

export function rateVital(name: WebVitalName, value: number): WebVitalEvent['rating'] {
  const [good, poor] = THRESHOLDS[name];
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}

/**
 * Parses a beacon body into events.
 *
 * **Everything here arrives from a browser, so none of it is trusted.** A metric name that is not
 * one of the five, a value that is not finite, or a fragment id that is not registered is dropped
 * rather than forwarded — a telemetry endpoint that relays whatever it is posted is an open
 * ingestion API for anyone who can reach it, and the sink downstream would be the thing paying for
 * that. `known` is the registry's fragment ids; pass an empty set to accept none.
 */
export function parseVitalsBeacon(body: unknown, known: ReadonlySet<string>, now = Date.now()): WebVitalEvent[] {
  if (!body || typeof body !== 'object') return [];
  const { pathname, metrics } = body as { pathname?: unknown; metrics?: unknown };
  if (typeof pathname !== 'string' || !Array.isArray(metrics)) return [];

  // A pathname is echoed back into whatever the sink writes to, so it is length-capped and
  // stripped of its query here rather than trusted to be a URL this gateway ever served.
  const safePath = pathname.split('?')[0].slice(0, 512);
  const events: WebVitalEvent[] = [];

  for (const metric of metrics.slice(0, 32)) {
    if (!metric || typeof metric !== 'object') continue;
    const { name, value, fragmentId } = metric as { name?: unknown; value?: unknown; fragmentId?: unknown };

    if (typeof name !== 'string' || !(name in THRESHOLDS)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;

    const vital = name as WebVitalName;
    events.push({
      kind: 'web-vital',
      name: vital,
      value,
      rating: rateVital(vital, value),
      // An unregistered id means the page was tampered with or the registry changed under it.
      // Either way the honest attribution is "not a fragment we know", which is null.
      fragmentId: typeof fragmentId === 'string' && known.has(fragmentId) ? fragmentId : null,
      pathname: safePath,
      at: now,
    });
  }

  return events;
}

/**
 * The browser-side collector, as a source string.
 *
 * Hand-written rather than pulling in `web-vitals`: the library is excellent and mostly solves a
 * problem this does not have — cross-browser normalization for metrics whose polyfills matter on
 * browsers that cannot run Braid's realms anyway. What is left is four `PerformanceObserver`
 * registrations, and shipping them inline keeps this dependency-free and keeps the injected script
 * small enough that measuring a page does not measurably change it.
 *
 * The part that is not boilerplate is {@link ownerOf}: attributing an element to the fragment that
 * rendered it means climbing *out of shadow roots*, since a pierced fragment's DOM lives inside a
 * declarative shadow root and `closest()` stops at that boundary.
 */
export function vitalsCollectorScript(endpoint: string, sampleRate: number): string {
  return `// Generated by @braidlabs/gateway. Reports web vitals, attributed per fragment.
(function () {
  if (Math.random() >= ${JSON.stringify(sampleRate)}) return;
  if (typeof PerformanceObserver !== 'function') return;

  var metrics = new Map();
  var sent = false;

  // Climbs out of shadow roots, which closest() will not do: a pierced fragment's content lives
  // in a declarative shadow root, so every node inside one is invisible to an ordinary ancestor
  // walk from the document.
  function ownerOf(node) {
    var current = node;
    while (current) {
      if (current.nodeType === 1 && current.tagName === 'FRAGMENT-SLOT') {
        return current.getAttribute('name');
      }
      var next = current.parentNode;
      if (!next) {
        var root = current.getRootNode && current.getRootNode();
        next = root && root.host ? root.host : null;
      }
      current = next;
    }
    return null;
  }

  // Last value wins for the cumulative and "largest" metrics; that is what the final report means.
  function record(name, value, node) {
    metrics.set(name, { name: name, value: value, fragmentId: node ? ownerOf(node) : null });
  }

  function observe(type, handler, options) {
    try {
      var observer = new PerformanceObserver(function (list) { list.getEntries().forEach(handler); });
      observer.observe(Object.assign({ type: type, buffered: true }, options || {}));
    } catch (error) {
      // An unsupported entry type is not an error worth surfacing to the page; it just means this
      // browser does not report that metric.
    }
  }

  observe('largest-contentful-paint', function (entry) {
    record('LCP', entry.startTime, entry.element);
  });

  observe('paint', function (entry) {
    if (entry.name === 'first-contentful-paint') record('FCP', entry.startTime, null);
  });

  observe('navigation', function (entry) {
    record('TTFB', entry.responseStart, null);
  });

  // CLS is cumulative, and the interesting question is which fragment moved the most — so the
  // score is accumulated per owner and the worst offender is what gets reported.
  var shiftByOwner = new Map();
  observe('layout-shift', function (entry) {
    if (entry.hadRecentInput) return;
    var sources = entry.sources || [];
    var owner = null;
    for (var i = 0; i < sources.length && owner === null; i++) {
      if (sources[i].node) owner = ownerOf(sources[i].node);
    }
    var key = owner === null ? '' : owner;
    shiftByOwner.set(key, (shiftByOwner.get(key) || 0) + entry.value);

    var worstKey = '';
    var total = 0;
    shiftByOwner.forEach(function (score, candidate) {
      total += score;
      if (score > (shiftByOwner.get(worstKey) || 0)) worstKey = candidate;
    });
    metrics.set('CLS', { name: 'CLS', value: total, fragmentId: worstKey || null });
  });

  observe('event', function (entry) {
    var current = metrics.get('INP');
    if (!current || entry.duration > current.value) record('INP', entry.duration, entry.target);
  }, { durationThreshold: 40 });

  // Reported when the page goes away, which is the only moment the numbers are final. pagehide
  // covers the bfcache path that visibilitychange alone misses on iOS.
  function flush() {
    if (sent || metrics.size === 0) return;
    sent = true;
    var body = JSON.stringify({ pathname: location.pathname, metrics: Array.from(metrics.values()) });
    if (navigator.sendBeacon) navigator.sendBeacon(${JSON.stringify(endpoint)}, new Blob([body], { type: 'application/json' }));
  }

  addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
  addEventListener('pagehide', flush);
})();
`;
}
