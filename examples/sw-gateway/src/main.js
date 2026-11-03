import { initBraid } from '@braidlabs/core';

// Until the worker controls this page, /__braid/ is a 404 on a static server: nothing is there
// to answer it. So the runtime starts only once a controller exists.
async function controlled() {
  if (navigator.serviceWorker.controller) return;
  const changed = new Promise((resolve) =>
    navigator.serviceWorker.addEventListener('controllerchange', resolve, {
      once: true,
    }),
  );
  const registration = await navigator.serviceWorker.register('/sw.js', {
    type: 'module',
    scope: '/',
  });
  // A hard reload loads the page past a worker that is already active, and an active worker does
  // not claim a page unasked. (On a first visit there is none yet; the new one claims on activate.)
  registration.active?.postMessage({ type: 'braid-sw:claim' });
  await changed;
}

await controlled();
initBraid();
