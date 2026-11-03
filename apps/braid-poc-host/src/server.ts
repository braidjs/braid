import { AngularNodeAppEngine, createNodeRequestHandler, isMainModule, writeResponseToNodeResponse } from '@angular/ssr/node';
import { createGateway, type TelemetryEvent } from '@braidlabs/gateway';
import type { FragmentManifest } from '@braidlabs/gateway';
import { toNodeMiddleware } from '@braidlabs/gateway/node';
import { createRegistryApi, createRoutingObservations, createSnapshot, serializeObservations } from '@braidlabs/registry';
import { fileSnapshotStore } from '@braidlabs/registry/node';
import { mountDemoApi } from './demo-api.js';
import express from 'express';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');

const app = express();

// Angular 22 validates the Host header against an allow-list (SSRF hardening). This POC is
// served from localhost, so it has to be named explicitly. Proxy headers are trusted since the gateway fronts it.
const angularApp = new AngularNodeAppEngine({
  allowedHosts: ['localhost', '127.0.0.1'],
  trustProxyHeaders: true,
});

/**
 * The Braid gateway, in front of the host's own SSR.
 *
 * Two jobs, both invisible to the Angular app behind it:
 *
 * 1. `/__braid/frag/billing/*` is routed to the remote app by id — its realm stub, its
 *    JavaScript, its stylesheet, its data. The remote never learns it is embedded.
 * 2. A document request for a `pierce` route is composed: the gateway fetches the host's SSR
 *    output and the remote's HTML concurrently and interleaves them, so the remote's markup is
 *    inside `<fragment-slot>` in the very first response — no client round trip to fill it.
 */
const REGISTRY: FragmentManifest[] = [
    {
      id: 'billing',
      // no `adapter` — compat is the default, which is what lets a stock Angular app be a
      // fragment with zero code changes
      endpoint: process.env['BRAID_REMOTE_ORIGIN'] ?? 'http://localhost:4501',
      pierce: ['/billing', '/billing/*'],
      title: 'Billing',
      description: 'Invoices and billing settings, deployed independently of the shell.',
      tags: ['finance'],
      // Projected into the App Directory listing. `findIntent` becomes a registry query, and
      // because the listing is access-filtered, a user only sees resolvers they may use.
      fdc3: {
        listensFor: { ViewInvoice: { contexts: ['fdc3.instrument'], displayName: 'View invoice' } },
        raises: { ViewChart: ['fdc3.instrument'] },
      },
      appd: { publisher: 'Payments', contactEmail: 'payments@example.com', version: '1.4.0' },
    },

    /**
     * A React app, composed into an Angular page. No adapter declared, so it gets compat — the
     * same default that made the Angular remote work, and the reason a fragment's framework is
     * the gateway's business only insofar as it names an endpoint.
     */
    {
      id: 'reviews',
      endpoint: process.env['BRAID_REACT_ORIGIN'] ?? 'http://localhost:4502',
      pierce: ['/billing', '/billing/*'],
      title: 'Customer reviews',
      description: 'A React 19 application running in its own realm.',
      tags: ['feedback'],
    },

    /**
     * A plain custom element. `custom-element` is a *contract* adapter: no document facade, no
     * window patches — the fragment gets a mount point, its props, and a teardown signal.
     * `events` is what the adapter republishes to the host as `braid:event`.
     */
    {
      // The demo's live-typing panel. A second custom element from the same widget deployment.
      id: 'live-text',
      endpoint: process.env['BRAID_WIDGET_ORIGIN'] ?? 'http://localhost:4503',
      adapter: 'custom-element',
      entry: '/live-text.js',
      element: 'live-text',
      title: 'Live text',
      description: 'Renders text the host is typing, in its own realm.',
      tags: ['widget', 'demo'],
    },
    {
      id: 'rating',
      endpoint: process.env['BRAID_WIDGET_ORIGIN'] ?? 'http://localhost:4503',
      adapter: 'custom-element',
      entry: '/star-rating.js',
      element: 'star-rating',
      events: { 'rating:change': { detail: 'object' } },
      title: 'Star rating',
      description: 'A framework-free web component, mounted through the contract adapter.',
      tags: ['widget'],
    },

    /**
     * The unbound fragment: shell chrome rather than a screen.
     *
     * `bound: false` with `src` is the whole difference. A bound fragment is asked for the page the
     * user is on; this one is asked for `/panel` on every page, because that is where its content
     * lives and `/billing/invoices` is a question its endpoint has no answer to.
     *
     * The tight `timeoutMs` is not caution, it is the price of `pierce: ['/*']`: this fetch is now
     * on the critical path of every document request, so a slow widget would slow the whole site.
     * Past the budget the slot degrades to `placeholder` and the client boots the fragment itself.
     */
    {
      id: 'notifications',
      endpoint: process.env['BRAID_NOTIFICATIONS_ORIGIN'] ?? 'http://localhost:4505',
      bound: false,
      src: '/panel',
      pierce: ['/', '/*'],
      timeoutMs: 400,
      fallback: 'placeholder',
      title: 'Notifications',
      description: 'Server-rendered header chrome, deployed on its own schedule.',
      tags: ['chrome'],
    },

    /**
     * Registered but restricted, so the console's access preview has something to say. Listing
     * and loading are independent: this is visible to everyone and loadable only by `finance`.
     */
    {
      id: 'payroll',
      endpoint: process.env['BRAID_PAYROLL_ORIGIN'] ?? 'http://localhost:4504',
      title: 'Payroll',
      description: 'Listed for everyone, loadable only with the finance role.',
      tags: ['finance'],
      access: { fetch: { roles: ['finance'] } },
    },
];

/**
 * Records which page paths this gateway actually serves, so `braid registry impact` can say what a
 * change would do to real traffic rather than to hypothetical URLs.
 *
 * Off by default in the library: recording paths is a data-retention decision, not a default. Here
 * it is on, bounded, and redacted — the redactor collapses invoice ids, which both protects the
 * identifiers and keeps cardinality flat.
 */
const observations = createRoutingObservations({
  maxPaths: 2000,
  redact: (pathname) => pathname.replace(/\/invoices\/[^/]+/, '/invoices/:id'),
});

/**
 * The last few hundred telemetry events, in memory.
 *
 * A real deployment sends these to OpenTelemetry or a metrics pipeline; a ring buffer behind an
 * endpoint is the demo equivalent, and it keeps the hook's contract visible — the gateway hands
 * over events and has no opinion about where they go.
 */
const telemetryLog: TelemetryEvent[] = [];

const gateway = createGateway({
  registry: REGISTRY,
  // synchronous and cheap: it updates one Map entry and returns
  observe: (event) => observations.record(event),
  /**
   * Server-side fetch outcomes, plus web vitals from the browser attributed per fragment.
   *
   * `webVitals` serves a collector from `/__braid/vitals.js` and injects it into composed pages.
   * It is on here because the whole point of this POC is to make the machinery visible; it is off
   * by default in the library, since adding a script to every pierced page is a deployment's call.
   */
  telemetry: {
    on: (event) => {
      telemetryLog.push(event);
      if (telemetryLog.length > 300) telemetryLog.shift();
    },
    webVitals: true,
  },
  mode: 'development',
  // `GET /__braid/registry` — in development this lists everything, endpoints included.
  // `appd: true` additionally serves it in FDC3 App Directory shape at
  // `/__braid/registry/appd/v2/apps` — a projection over the same manifests and the same access
  // rules, never a second directory.
  discovery: { appd: true },
});

/**
 * The registry console, served from the gateway's own origin at `/__braid/console`.
 *
 * Same origin is the point: the console reads `/__braid/registry` and writes to
 * `/__braid/registry-api`, so there is no CORS, no second deployment, and no cross-origin session
 * to arrange. It is also a realistic shape — the console is a static bundle, and the gateway is
 * already an HTTP server.
 *
 * Snapshots land in `.braid/registry` so publishing survives a restart and the artifacts are
 * inspectable. Note the deliberate gap the POC leaves visible: this gateway serves the *inline*
 * manifests above, so publishing a snapshot here does not change what it composes until a deploy
 * pins the new id. That is the model, not a limitation of the demo — configuration changes are
 * deploys.
 */
const snapshots = fileSnapshotStore({ directory: resolve(process.cwd(), '.braid/registry') });

// Seed once, so the editor has a pinned snapshot to branch from on a fresh checkout. Content
// addressing makes this idempotent: re-seeding identical manifests yields the same id.
if (!(await snapshots.head?.())) {
  const seed = await createSnapshot({ manifests: REGISTRY, labels: { by: 'braid-poc' } });
  await snapshots.put(seed);
  await snapshots.setHead?.(seed.id);
}

const registryApi = createRegistryApi({
  store: snapshots,
  // A demo, so everything is permitted. A real deployment wires this to its own session — without
  // it the API refuses writes, because an unauthenticated publish endpoint is remote control of
  // which fragments compose which pages.
  authorize: () => true,
});

/**
 * In production the gateway is middleware inside this server. Under `braid dev` it runs *in
 * front* of this server instead, so the app must not mount a second one — a doubly-pierced page
 * would carry two copies of every fragment.
 */
if (!process.env['BRAID_DEV']) {
  app.use(toNodeMiddleware(gateway));
}

// The console's write API. `/__braid/registry-api/*` is not one of the gateway's three namespaces,
// so the middleware above passes it through to here.
app.use(async (req, res, next) => {
  const url = new URL(req.originalUrl, `http://${req.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/__braid/registry-api')) return next();

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  const response = await registryApi.handle(
    new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).filter(([, value]) => typeof value === 'string') as [string, string][],
      ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
    }),
  );

  if (!response) return next();
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(Buffer.from(await response.arrayBuffer()));
});

// The console itself. Its bundle uses relative asset URLs, so it works under this prefix without
// being rebuilt for it — hence the redirect: without the trailing slash the browser would resolve
// `./assets/…` against `/__braid/` and miss.
// The demo's data sources: SWAPI for reads, a controllable mock for writes. Mounted before the
// Angular handler so it is not swallowed by the SSR catch-all.
app.use(express.json());
mountDemoApi(app);

app.use('/__braid/console', (req, res, next) => {
  // Exact-match on originalUrl, not a route: Express treats `/x` and `/x/` as the same path, so
  // `app.get('/__braid/console')` would also catch the slashed form and redirect it to itself.
  if (req.originalUrl === '/__braid/console') return res.redirect(301, '/__braid/console/');
  next();
});
app.use('/__braid/console', express.static(resolve(serverDistFolder, '../../braid-console'), { index: 'index.html' }));

// Dumps what has been observed, so the CLI can analyze it. A real deployment would flush this on
// an interval to durable storage rather than exposing it — this is a demo affordance.
app.get('/__braid/observations', async (_req, res) => {
  const path = resolve(process.cwd(), '.braid/observations.json');
  await writeFile(path, serializeObservations(observations.snapshot()));
  res.type('application/json').send(serializeObservations(observations.snapshot()));
});

// What the gateway measured. Same demo affordance as the observations dump above.
app.get('/__braid/telemetry', (_req, res) => {
  res.type('application/json').send(JSON.stringify({ events: telemetryLog }));
});

// The host's own static assets. No max-age: this POC builds without filename hashing, so a
// long-lived cache would serve a stale bundle after every rebuild.
app.use(
  express.static(browserDistFolder, {
    etag: true,
    maxAge: 0,
    index: false,
    redirect: false,
  }),
);

// everything else is rendered by Angular — the gateway pierces this response when the route
// matches a fragment's `pierce` patterns
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  const port = Number(process.env['PORT'] ?? 4500);
  app.listen(port, () => {
    console.log(`braid poc host (SSR + gateway) listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
