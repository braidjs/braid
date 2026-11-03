import { describe, expect, it, vi } from 'vitest';
import { braidNavigationHandler, clearBraidCaches } from './compose.js';

/**
 * Offline composition, which is the claim worth being careful about: a page that composed on the
 * server composes again from cache, with no network, using the same piercing code the gateway runs.
 */

interface Entry {
  response: Response;
}

function memoryCaches(): CacheStorage & { partitions: Map<string, Map<string, Entry>> } {
  const partitions = new Map<string, Map<string, Entry>>();

  const open = async (name: string) => {
    let entries = partitions.get(name);
    if (!entries) {
      entries = new Map();
      partitions.set(name, entries);
    }
    const store = entries;
    return {
      async match(request: RequestInfo) {
        const key = typeof request === 'string' ? request : (request as Request).url;
        return store.get(key)?.response.clone();
      },
      async put(request: RequestInfo, response: Response) {
        const key = typeof request === 'string' ? request : (request as Request).url;
        store.set(key, { response });
      },
      async delete(request: RequestInfo) {
        const key = typeof request === 'string' ? request : (request as Request).url;
        return store.delete(key);
      },
    } as unknown as Cache;
  };

  return {
    open,
    keys: async () => [...partitions.keys()],
    delete: async (name: string) => partitions.delete(name),
    partitions,
  } as unknown as CacheStorage & { partitions: Map<string, Map<string, Entry>> };
}

const SNAPSHOT = {
  id: 'reg_abc',
  createdAt: '2026-01-01T00:00:00.000Z',
  manifests: [
    { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] },
    { id: 'notifications', endpoint: 'https://n.internal', pierce: ['/', '/*'], bound: false, src: '/panel' },
  ],
};

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });

/** The origin, as seen by the worker: online until `offline()` is called. */
function origin() {
  let down = false;
  const asked: string[] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    asked.push(`${url.pathname}${request.headers.get('sec-fetch-dest') === 'empty' ? ' (shell)' : ''}`);

    if (down) throw new TypeError('Failed to fetch');

    if (url.pathname === '/registry.json') return new Response(JSON.stringify(SNAPSHOT));
    if (url.pathname.startsWith('/__braid/doc/billing')) return html('<braid-html><braid-body><h1>Invoices</h1></braid-body></braid-html>');
    if (url.pathname.startsWith('/__braid/doc/notifications')) return html('<braid-html><braid-body><p>3 unread</p></braid-body></braid-html>');
    if (request.headers.get('sec-fetch-dest') === 'empty') {
      return html('<html><body><fragment-slot name="billing"></fragment-slot><fragment-slot name="notifications"></fragment-slot></body></html>');
    }
    return html('<html><body>the composed page from the server</body></html>');
  }) as unknown as typeof fetch;

  return { fetchImpl, asked, offline: () => void (down = true) };
}

const navigation = (path: string) =>
  new Request(`https://shop.example${path}`, { headers: { accept: 'text/html' } });

describe('scope', () => {
  it('only answers navigations', () => {
    const handler = braidNavigationHandler({ snapshotUrl: '/registry.json', caches: memoryCaches(), fetch: vi.fn() });

    expect(handler(new Request('https://shop.example/app.js'))).toBeNull();
    expect(handler(new Request('https://shop.example/', { method: 'POST', headers: { accept: 'text/html' } }))).toBeNull();
    expect(handler(navigation('/billing/invoices'))).not.toBeNull();
  });

  it('prefers the network whenever there is one', async () => {
    const server = origin();
    const handler = braidNavigationHandler({
      snapshotUrl: '/registry.json',
      caches: memoryCaches(),
      fetch: server.fetchImpl,
    });

    const response = await handler(navigation('/billing/invoices'))!;

    // The gateway is authoritative. Composing locally while it is reachable would be answering with
    // a copy of an answer we could have simply asked for.
    expect(await response.text()).toContain('the composed page from the server');
  });
});

describe('composing with no network', () => {
  it('pierces cached fragment documents into the cached shell', async () => {
    const server = origin();
    const caches = memoryCaches();
    const composed: unknown[] = [];
    const handler = braidNavigationHandler({
      snapshotUrl: '/registry.json',
      caches,
      fetch: server.fetchImpl,
      onCompose: (event) => composed.push(event),
    });

    // One online visit is what stocks the cache.
    await handler(navigation('/billing/invoices'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));

    server.offline();
    const offline = await handler(navigation('/billing/invoices'))!;
    const body = await offline.text();

    expect(offline.headers.get('x-braid-composed')).toBe('offline');
    expect(body).toContain('<h1>Invoices</h1>');
    expect(body).toContain('<p>3 unread</p>');
    expect(body).toContain('<template shadowrootmode="open">');
    expect(composed).toEqual([{ pathname: '/billing/invoices', fragmentIds: ['billing', 'notifications'] }]);
  });

  it('asks the unbound fragment for its own path, as the server does', async () => {
    const server = origin();
    const handler = braidNavigationHandler({
      snapshotUrl: '/registry.json',
      caches: memoryCaches(),
      fetch: server.fetchImpl,
    });

    await handler(navigation('/billing/invoices'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A widget's document lives at /panel whatever page it appears on — the same rule the gateway
    // applies, because a second implementation of it is a second set of bugs.
    expect(server.asked).toContain('/__braid/doc/notifications/panel');
    expect(server.asked).toContain('/__braid/doc/billing/billing/invoices');
  });

  it('degrades a fragment it never cached to a placeholder rather than failing the page', async () => {
    const server = origin();
    const caches = memoryCaches();
    const handler = braidNavigationHandler({ snapshotUrl: '/registry.json', caches, fetch: server.fetchImpl });

    await handler(navigation('/billing/invoices'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The billing fragment's cache is dropped, as an eviction would drop it.
    caches.partitions.delete('braid-frag:billing');

    server.offline();
    const body = await (await handler(navigation('/billing/invoices'))!).text();

    expect(body).toContain('data-braid-fallback="placeholder"');
    expect(body).toContain('<p>3 unread</p>');
  });

  it('gives up honestly when it has no shell for this route', async () => {
    const server = origin();
    const handler = braidNavigationHandler({
      snapshotUrl: '/registry.json',
      caches: memoryCaches(),
      fetch: server.fetchImpl,
    });

    server.offline();

    // Never visited, nothing cached: the offline error is the truth, and inventing a page would be
    // worse than reporting it.
    await expect(handler(navigation('/billing/invoices'))!).rejects.toThrow('Failed to fetch');
  });

  it('caches the shell unpierced, so composition has parts rather than a finished page', async () => {
    const server = origin();
    const caches = memoryCaches();
    const handler = braidNavigationHandler({ snapshotUrl: '/registry.json', caches, fetch: server.fetchImpl });

    await handler(navigation('/billing/invoices'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const shell = await (await caches.open('braid-shell')).match('https://shop.example/billing/invoices');
    const body = await shell!.text();
    expect(body).toContain('<fragment-slot name="billing">');
    expect(body).not.toContain('shadowrootmode');
  });
});

describe('streaming', () => {
  it('interleaves the shell around a fragment that is still arriving', async () => {
    // The plan flags "does streaming composition behave under respondWith" as a thing to verify.
    // The half this package owns is that the composed body is a *stream* — that the shell's opening
    // markup is readable before the fragment's body has finished arriving. Whether a browser then
    // streams that Response through respondWith is the platform's guarantee, not this code's.
    const caches = memoryCaches();
    const shellCache = await caches.open('braid-shell');
    await shellCache.put(
      'https://shop.example/billing/invoices',
      html('<html><body><header>shell</header><fragment-slot name="billing"></fragment-slot><footer>end</footer></body></html>'),
    );
    const snapshotCache = await caches.open('braid-snapshot');
    await snapshotCache.put('https://shop.example/registry.json', new Response(JSON.stringify(SNAPSHOT)));

    // A fragment document that arrives in pieces, slowly.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowFragment = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encode = (text: string) => new TextEncoder().encode(text);
        controller.enqueue(encode('<braid-html><braid-body><h1>Invoices</h1>'));
        await gate;
        controller.enqueue(encode('<p>tail</p></braid-body></braid-html>'));
        controller.close();
      },
    });
    const fragmentCache = await caches.open('braid-frag:billing');
    await fragmentCache.put(
      'https://shop.example/__braid/doc/billing/billing/invoices',
      new Response(slowFragment, { headers: { 'content-type': 'text/html' } }),
    );

    const handler = braidNavigationHandler({
      snapshotUrl: '/registry.json',
      caches,
      fetch: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    });

    const response = await handler(navigation('/billing/invoices'))!;
    const reader = response.body!.getReader();

    let seen = '';
    while (!seen.includes('<h1>Invoices</h1>')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }

    // The shell's opening markup and the fragment's first chunk are readable while the fragment's
    // body is still open — the page paints with the fragment present rather than after it.
    expect(seen).toContain('<header>shell</header>');
    expect(seen).not.toContain('<footer>end</footer>');

    release();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('<footer>end</footer>');
  });
});

/**
 * What offline composition may keep. A cache that outlives a session is a cache the next person on
 * the device reads, so the origin's own word that a response is private wins.
 */
describe('what is kept for offline composition', () => {
  function serving(headers: { shell?: string; billing?: string }, manifests = SNAPSHOT.manifests) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const cc = (value?: string) => (value ? { 'cache-control': value } : {});
      if (url.pathname === '/registry.json') return new Response(JSON.stringify({ ...SNAPSHOT, manifests }));
      if (url.pathname.startsWith('/__braid/doc/')) {
        return new Response('<braid-html><braid-body>doc</braid-body></braid-html>', {
          headers: { 'content-type': 'text/html', ...cc(headers.billing) },
        });
      }
      return new Response('<html><body><fragment-slot name="billing"></fragment-slot></body></html>', {
        headers: { 'content-type': 'text/html', ...cc(headers.shell) },
      });
    }) as unknown as typeof fetch;
  }

  async function visit(fetchImpl: typeof fetch, path = '/billing/invoices') {
    const caches = memoryCaches();
    await braidNavigationHandler({ snapshotUrl: '/registry.json', caches, fetch: fetchImpl })(navigation(path))!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return caches.partitions;
  }

  it('keeps neither a shell nor a document the origin marked no-store, in any case', async () => {
    const kept = await visit(serving({ shell: 'max-age=0, No-Store', billing: 'NO-STORE' }));
    expect(kept.get('braid-shell')?.size ?? 0).toBe(0);
    expect(kept.get('braid-frag:billing')?.size ?? 0).toBe(0);
  });

  it('keeps a private page, which is what the gateway marks every pierced page by default', async () => {
    // `private` keeps a page out of shared caches; this one is the browser's own. Sign-out clears it.
    const kept = await visit(serving({ shell: 'private', billing: 'private, max-age=60' }));
    expect(kept.get('braid-shell')?.size).toBe(1);
    expect(kept.get('braid-frag:billing')?.size).toBe(1);
  });

  it('drops a kept copy once the origin marks the page no-store', async () => {
    const caches = memoryCaches();
    let header = 'private';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await serving({ shell: header, billing: header })(input, init);
      return response;
    }) as unknown as typeof fetch;
    const handler = braidNavigationHandler({ snapshotUrl: '/registry.json', caches, fetch: fetchImpl });

    await handler(navigation('/billing/invoices'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(caches.partitions.get('braid-shell')?.size).toBe(1);

    header = 'no-store';
    await handler(navigation('/billing/invoices'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(caches.partitions.get('braid-shell')?.size).toBe(0);
    expect(caches.partitions.get('braid-frag:billing')?.size).toBe(0);
  });

  it('does not let a refresh that was already running write after a clear', async () => {
    const caches = memoryCaches();
    let releaseDocument!: () => void;
    const documentHeld = new Promise<void>((resolve) => (releaseDocument = resolve));
    const base = serving({});
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/__braid/doc/')) await documentHeld; // a slow fragment
      return base(input, init);
    }) as unknown as typeof fetch;

    await braidNavigationHandler({ snapshotUrl: '/registry.json', caches, fetch: fetchImpl })(navigation('/billing/invoices'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Sign-out lands while that fragment is still on its way, fetched with the old cookies.
    await clearBraidCaches({ caches });
    releaseDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(caches.partitions.get('braid-frag:billing')?.size ?? 0).toBe(0);
  });

  it('does not compose a route no fragment pierces, even from a shell an older build kept', async () => {
    const billingOnly = [{ id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] }];
    const caches = memoryCaches();
    const shells = await caches.open('braid-shell');
    await shells.put('https://shop.example/account/statements', html('<html><body>last person</body></html>'));
    let down = false;
    const live = serving({}, billingOnly);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (down && !url.endsWith('/registry.json')) throw new TypeError('Failed to fetch');
      return live(input, init);
    }) as unknown as typeof fetch;
    const handler = braidNavigationHandler({ snapshotUrl: '/registry.json', caches, fetch: fetchImpl });
    await handler(navigation('/billing/x'))!; // stocks the snapshot
    down = true;

    await expect(handler(navigation('/account/statements'))!).rejects.toThrow();
  });

  it('keeps nothing for a route no fragment pierces', async () => {
    const billingOnly = [{ id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] }];
    const kept = await visit(serving({}, billingOnly), '/account/statements');
    expect(kept.get('braid-shell')?.size ?? 0).toBe(0);
  });
});

describe('clearBraidCaches', () => {
  it("deletes the shell and every fragment's cache, and nothing else", async () => {
    const caches = memoryCaches();
    for (const name of ['braid-shell', 'braid-frag:billing', 'braid-frag:notifications', 'app-assets']) await caches.open(name);

    await clearBraidCaches({ caches });

    expect([...caches.partitions.keys()]).toEqual(['app-assets']);
  });
});
