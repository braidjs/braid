/**
 * Install-time routes: the Service Worker Static Routing API (`InstallEvent.addRoutes`, Chromium).
 *
 * A worker with a `fetch` listener is started for every request in its scope, including the ones
 * its listener then lets pass: the shell's own scripts, images and API calls each wait on a worker
 * that has nothing to say about them. Routes declared at install let the browser decide without
 * the worker, so only what the worker actually answers starts it.
 *
 * The routes have to say exactly what the worker's listener claims, no more and no less. A route
 * that sends a claimed request to the network bypasses the worker; one that sends an unclaimed
 * request to the listener only costs what it costs today. So everything a worker claims is listed
 * as `fetch-event`, and the network takes the rest.
 *
 * Every other `fetch` listener in the same worker is bypassed too, which is why a worker that may
 * share its file with an application's own listener only does this when asked.
 */

/** What a worker answers, as its `fetch` listener decides it. */
export interface ClaimedRequests {
  /** Pathname patterns (URLPattern syntax) the worker answers, e.g. `/__braid/*`. */
  pathnames: readonly string[];
  /** The origin those pathnames are answered on; any origin when absent. */
  origin?: string;
  /** Answer only GET requests under those pathnames. */
  getOnly?: boolean;
  /** Whether the worker answers GET navigations, wherever they go. */
  navigations: boolean;
}

/** A condition and source as `addRoutes` takes them. */
export interface StaticRoute {
  condition: { urlPattern?: unknown; requestMethod?: string; requestMode?: string };
  source: 'network' | 'fetch-event';
}

/** The slice of `InstallEvent` used here. */
export interface RoutableInstallEvent {
  addRoutes?(rules: StaticRoute | readonly StaticRoute[]): Promise<void>;
}

type URLPatternConstructor = new (init?: Record<string, string>) => unknown;

/**
 * The rules for a worker that answers `claimed`, in the order the browser evaluates them: the
 * first match wins, so the worker's own requests come first and the catch-all last. Null where
 * `URLPattern` is missing, since every rule needs one.
 */
export function staticRoutesFor(claimed: ClaimedRequests): StaticRoute[] | null {
  const Pattern = (globalThis as { URLPattern?: URLPatternConstructor }).URLPattern;
  if (!Pattern) return null;

  const rules: StaticRoute[] = claimed.pathnames.map((pathname) => ({
    condition: {
      urlPattern: new Pattern({ pathname, ...(claimed.origin === undefined ? {} : { baseURL: claimed.origin }) }),
      ...(claimed.getOnly ? { requestMethod: 'GET' } : {}),
    },
    source: 'fetch-event',
  }));
  if (claimed.navigations) {
    // A worker only ever sees navigations into its own scope, so the origin is belt and braces:
    // it keeps the rule saying exactly what the listener does.
    const origin = claimed.origin === undefined ? undefined : new URL(claimed.origin);
    rules.push({
      condition: {
        ...(origin
          ? { urlPattern: new Pattern({ protocol: origin.protocol.slice(0, -1), hostname: origin.hostname, port: origin.port }) }
          : {}),
        requestMode: 'navigate',
        requestMethod: 'GET',
      },
      source: 'fetch-event',
    });
  }
  rules.push({ condition: { urlPattern: new Pattern({}) }, source: 'network' });
  return rules;
}

/**
 * Registers the routes for `claimed` on an install event, where the browser supports them.
 *
 * Returns the registration to wait on, or undefined where there is nothing to do. A browser that
 * refuses the rules leaves the worker exactly as it was without them — started for everything,
 * deciding in its listener — so a refusal is a warning, never a failed install.
 */
export function addStaticRoutes(event: RoutableInstallEvent, claimed: ClaimedRequests): Promise<void> | undefined {
  if (typeof event.addRoutes !== 'function') return undefined;
  const rules = staticRoutesFor(claimed);
  if (!rules) return undefined;
  return event.addRoutes(rules).catch((error: unknown) => {
    console.warn('braid-sw: static routes were not registered; every request will start the worker', error);
  });
}

/** A path prefix as a literal in URLPattern syntax, so a base path is matched as written. */
export function patternLiteral(path: string): string {
  return path.replace(/[\\:*?+(){}]/g, '\\$&');
}
