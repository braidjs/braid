// The whole gateway, in the worker. The server behind it only serves files.
import { setupBraidGateway } from '@braidlabs/sw/gateway';
import { APPS, baseOf, basePathOf } from './registry.js';

// this file sits at the desk's root, wherever that is mounted
const base = baseOf(self.location.href);

setupBraidGateway({
  mode: 'production',
  // The desk may share its origin (it is hosted at /starport/), so Braid's namespace lives under
  // its folder — /starport/__braid/… — and the worker's scope covers it.
  basePath: basePathOf(base),
  registry: APPS.map(({ id, title, fdc3 }) => ({
    id,
    title,
    fdc3,
    // same origin: each app is a folder of static files next to the desk
    endpoint: new URL(`${base}apps/${id}/`, self.location.origin).href,
    // Each app is one document on a static host, which has no page at the desk's own path:
    // without this the gateway would ask the app for /starport/.
    documentPath: '/index.html',
  })),
  // the page that installs the worker composes without a reload
  claimClients: true,
});
