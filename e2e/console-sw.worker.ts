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
// There is no server to hold a session, so there is no one to authorize: the boundary is the
// origin, and `registryApi` below is what keeps other sites on the far side of it. Published
// fragments may only be served from this origin, so a publish cannot point the page at another.
const api = createRegistryApi({ store, authorize: () => true, endpointOrigins: [worker.location.origin] });
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
  // Pages this worker controls are same-origin, and call the API with fetch. The one request any
  // other site can aim here is a navigation — a link, or a form it posts — and the console never
  // navigates to the API, so those are refused outright rather than left to the API's own
  // cross-site check, which reads headers a worker is not promised on a navigation.
  if (request.mode === 'navigate') return new Response('the registry API does not take navigations', { status: 403 });
  // and a write is JSON, which no form can send
  const json = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json';
  if (request.method !== 'GET' && request.method !== 'HEAD' && !json) return new Response('writes are application/json', { status: 415 });

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
