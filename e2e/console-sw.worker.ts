/**
 * A whole Braid control plane in a service worker, for an origin with no server to run one on:
 * the gateway (`@braidlabs/sw/gateway`), the registry it serves from, and the registry's write API
 * for the console — all over a snapshot store in the browser's Cache Storage.
 *
 * What is published here lives in this browser only. It is for designing and previewing; the
 * console's generated code, or a snapshot published to a real registry, is how a design ships.
 */
import { braidGatewayHandler } from '@braidlabs/sw/gateway';
import { cacheSnapshotStore, createRegistryApi, createSnapshot, shellDocuments, snapshotRegistry } from '@braidlabs/registry';

interface WorkerScope {
  location: { origin: string };
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void): void;
  addEventListener(
    type: 'fetch',
    listener: (event: { request: Request; preloadResponse?: Promise<Response | undefined>; respondWith(response: Promise<Response>): void }) => void,
  ): void;
}
const worker = self as unknown as WorkerScope;

const store = cacheSnapshotStore();
const registry = snapshotRegistry({ store });
// Only this origin's pages reach the worker, and any of them could write the cache directly, so
// there is no one to authorize against: the origin is the boundary.
const api = createRegistryApi({ store, authorize: () => true });
const braid = braidGatewayHandler({
  mode: 'production',
  registry,
  discovery: { includeEndpoints: true },
  documents: shellDocuments({ registry, runtimeSrc: '/runtime.js' }),
});

/** A registry to start from, the first time this browser installs the worker. */
async function seed(): Promise<void> {
  if (await store.head?.()) return;
  const snapshot = await createSnapshot({
    manifests: [
      { id: 'notes', title: 'Notes', endpoint: `${worker.location.origin}/apps/notes/`, bound: false, src: '/', tags: ['demo'] },
      { id: 'chart', title: 'Chart', endpoint: `${worker.location.origin}/apps/chart/`, bound: false, src: '/' },
    ],
  });
  await store.put(snapshot);
  await store.setHead?.(snapshot.id);
}

worker.addEventListener('install', (event) => event.waitUntil(seed().then(() => worker.skipWaiting())));
worker.addEventListener('activate', (event) => event.waitUntil(worker.clients.claim()));

async function registryApi(request: Request): Promise<Response> {
  const response = (await api.handle(request)) ?? new Response(null, { status: 404 });
  // a publish or a pin moved HEAD: serve it now, rather than on the gateway's next reload
  if (request.method !== 'GET' && response.ok) await braid.gateway.refreshRegistry().catch(() => undefined);
  return response;
}

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === worker.location.origin && url.pathname.startsWith('/__braid/registry-api/')) {
    event.respondWith(registryApi(event.request));
    return;
  }
  const handled = braid(event.request, event.preloadResponse);
  if (handled) event.respondWith(handled);
});
