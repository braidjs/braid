/**
 * Serves the built console from a real gateway, same origin.
 *
 * That is both the simplest way to see it working and a realistic deployment: the console is a
 * static bundle, and the gateway is already an HTTP server in front of the origin.
 *
 * `tsx` is not a workspace dependency, and Node's own type stripping cannot resolve the workspace's
 * `.js`-suffixed source imports or its `@braidlabs/*` path aliases — so both are handed to `tsx` via
 * npx, pointed at the tsconfig that defines them:
 *
 *   TSX_TSCONFIG_PATH=tsconfig.base.json npx tsx tools/braid-console/demo-server.mjs
 *   GATEWAY_MODE=production TSX_TSCONFIG_PATH=tsconfig.base.json npx tsx tools/braid-console/demo-server.mjs
 *
 * With `BRAID_DEMO_AUTH=mock` the registry API requires a bearer token, verified by the real
 * `createOidcAuthorizer`, and a mock Okta at /mock-oidc signs them — pick a role instead of typing
 * a password. `curl localhost:9100/mock-oidc/dev-token?role=editor` mints one for scripts.
 *
 * Build the console first: `nx build-app braid-console`.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../../libs/braid-gateway/src/index.ts';
import { toNodeMiddleware } from '../../libs/braid-gateway/src/node.ts';
import { build } from 'esbuild';
import { createRegistryApi, createSnapshot, jsonLinesAuditSink, memorySnapshotStore, shellDocuments, snapshotRegistry } from '../../libs/braid-registry/src/index.ts';
import { createOidcAuthorizer } from '../../libs/braid-registry/src/oidc.ts';
import { createMockOidc, MOCK_AUDIENCE, MOCK_CLIENT_ID, MOCK_ROLE_MAP } from './mock-oidc.mjs';

const PORT = 9100;
const ORIGIN = `http://localhost:${PORT}`;
const MOCK_AUTH = process.env.BRAID_DEMO_AUTH === 'mock';

// Resolved from this file, not the cwd, so the server runs correctly from any directory.
const DIST = fileURLToPath(new URL('../../dist/apps/braid-console', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// The client runtime a served shell loads: @braidlabs/core bundled into one module that starts it.
// A real deployment builds and serves this itself (or from its CDN); bundling it here keeps the
// demo to one process.
const RUNTIME_PATH = '/__demo/braid-runtime.js';
const RUNTIME = (
  await build({
    stdin: { contents: "import { initBraid } from '@braidlabs/core';\ninitBraid();\n", resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    tsconfig: `${ROOT}/tsconfig.base.json`,
    logLevel: 'silent',
  })
).outputFiles[0].contents;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const REGISTRY = [
  {
    id: 'billing',
    endpoint: 'http://localhost:9101',
    pierce: ['/billing/*'],
    title: 'Billing',
    description: 'Invoices and payment methods.',
    tags: ['finance', 'core'],
  },
  {
    id: 'reviews',
    endpoint: 'http://localhost:9102',
    pierce: ['/billing/*'],
    title: 'Customer reviews',
    description: 'A React 19 app composed into the billing page.',
    tags: ['react'],
  },
  {
    id: 'rating',
    endpoint: 'http://localhost:9103',
    adapter: 'custom-element',
    entry: '/star-rating.js',
    element: 'star-rating',
    title: 'Star rating',
    description: 'A framework-free web component.',
    tags: ['widget'],
  },
  {
    id: 'payroll',
    endpoint: 'http://localhost:9104',
    pierce: ['/payroll/*'],
    title: 'Payroll',
    description: 'Restricted — listed, but not loadable without the payroll role.',
    tags: ['finance'],
    access: { fetch: { roles: ['payroll'] } },
  },
];

// One shell, so the designer and the map have something to show: the billing page as a grid. It is
// plain JS, so the gateway serves it from its definition: open /billing/1 — no shell app runs here.
const SHELLS = [
  {
    id: 'storefront',
    title: 'Customer storefront',
    framework: 'vanilla',
    tags: ['core'],
    routes: [
      {
        path: '/billing/*',
        layout: { areas: 'header header\naside main', columns: '280px 1fr', rows: 'auto 1fr', gap: '12px' },
        slots: { header: 'rating', aside: 'reviews', main: 'billing' },
      },
    ],
    head: { title: 'Billing · Example Co', meta: [{ name: 'description', content: 'Invoices and payment methods.' }] },
  },
];

// Seeded with the same manifests, so the editor has a pinned snapshot to branch from.
const store = memorySnapshotStore();
const seeded = await createSnapshot({ manifests: REGISTRY, shells: SHELLS, labels: { publishedBy: 'demo-seed' } });
await store.put(seeded);
await store.setHead(seeded.id);

// The gateway serves the store the console publishes to, and follows its HEAD: publish or pin in
// the console and the next page load shows it, with no restart (hot re-pin). Plain-JS shells are
// served from their definition, so a shell published in the console is a live page.
const registry = snapshotRegistry({ store });
const gateway = createGateway({
  mode: process.env.GATEWAY_MODE === 'production' ? 'production' : 'development',
  discovery: { includeEndpoints: false },
  registry,
  registryRefreshMs: 1000,
  documents: shellDocuments({ registry, runtimeSrc: RUNTIME_PATH }),
  principal: () => ({ roles: ['finance'], scopes: [] }),
});

const oidc = MOCK_AUTH ? await createMockOidc({ origin: ORIGIN }) : null;

const registryApi = createRegistryApi({
  store,
  // staging → production. With sign-in, production needs a second person to approve a promotion;
  // without it there is no way to tell people apart, so the demo promotes directly.
  environments: [{ name: 'staging' }, { name: 'production', from: 'staging', approvals: oidc ? 1 : 0 }],
  // every publish, pin and refused write, one JSON line each — what a log shipper would forward
  audit: jsonLinesAuditSink((line) => process.stdout.write(`audit ${line}`)),
  ...(oidc
    ? // The production verifier, against the mock's keys. `jwks` skips discovery only because the
      // mock lives in this process; a real deployment omits it and the keys come from Okta.
      createOidcAuthorizer({ issuer: oidc.issuer, audience: MOCK_AUDIENCE, roleMap: MOCK_ROLE_MAP, jwks: oidc.jwks })
    : {
        // A real deployment wires this to its own session. Allowing everything is fine for a demo,
        // and would be remote control of the registry in production — which is why there is no
        // permissive default and an unconfigured API refuses writes.
        authorize: () => true,
      }),
});

// What the console reads from the page. The built index.html carries `{ "edit": true }`; in mock
// mode the issuer is added, which is all a real deployment changes too.
const CONSOLE_CONFIG = JSON.stringify({ edit: true, ...(oidc ? { auth: { issuer: oidc.issuer, clientId: MOCK_CLIENT_ID } } : {}) });

const middleware = toNodeMiddleware(gateway);

createServer(async (request, response) => {
  if (oidc && (await oidc.handle(request, response))) return;

  if (request.url === RUNTIME_PATH) {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(RUNTIME);
    return;
  }

  middleware(request, response, async () => {
    const apiResponse = await registryApi.handle(await toWebRequest(request));
    if (apiResponse) {
      response.writeHead(apiResponse.status, Object.fromEntries(apiResponse.headers));
      response.end(Buffer.from(await apiResponse.arrayBuffer()));
      return;
    }

    // Strip the query *before* testing for the root, so `/?x=1` still serves the app rather than
    // falling through to a read of the dist directory itself.
    const pathname = (request.url ?? '/').split('?')[0];
    const path = !pathname || pathname === '/' ? '/index.html' : pathname;
    // Resolved and then checked: a raw `/../../package.json` must not read outside the bundle.
    let file;
    try {
      file = resolve(DIST, `.${decodeURIComponent(path)}`);
    } catch {
      file = null;
    }
    if (!file || !file.startsWith(DIST + sep)) {
      response.writeHead(404).end('not found');
      return;
    }
    try {
      let body = await readFile(file);
      if (path === '/index.html') {
        body = Buffer.from(
          body.toString('utf8').replace(
            /(<script type="application\/json" id="braid-console-config">)[\s\S]*?(<\/script>)/,
            // A function, so a `$` in the config is text rather than a replacement pattern.
            (_match, open, close) => `${open}${CONSOLE_CONFIG.replace(/</g, '\\u003c')}${close}`,
          ),
        );
      }
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  // Loopback only: the demo authorizes everyone (or hands out tokens), which is fine on this
  // machine and not on the network it is attached to.
}).listen(PORT, '127.0.0.1', () => console.log(`console demo → ${ORIGIN}${oidc ? '  (mock Okta sign-in; curl tokens at /mock-oidc/dev-token?role=viewer|candidate|editor)' : ''}`));

async function toWebRequest(request) {
  const url = new URL(request.url, `http://${request.headers.host ?? `localhost:${PORT}`}`);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  const chunks = [];
  if (hasBody) for await (const chunk of request) chunks.push(chunk);

  return new Request(url, {
    method: request.method,
    headers: Object.entries(request.headers).filter(([, value]) => typeof value === 'string'),
    ...(hasBody && chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
  });
}
