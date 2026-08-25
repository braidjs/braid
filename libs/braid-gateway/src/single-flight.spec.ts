import { describe, expect, it, vi } from 'vitest';
import { createSingleFlight, singleFlightKey } from './single-flight.js';
import { createGateway } from './gateway.js';

const deferred = () => {
  let resolve!: (value: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('createSingleFlight', () => {
  it('makes one call for concurrent identical keys', async () => {
    const flight = createSingleFlight();
    const gate = deferred();
    const fetcher = vi.fn(() => gate.promise);

    const all = Promise.all([flight.run('k', fetcher), flight.run('k', fetcher), flight.run('k', fetcher)]);
    gate.resolve(new Response('body'));
    await all;

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // Bodies are single-use, so a joiner handed the same object would find it already consumed.
  it('gives every participant an independently readable body', async () => {
    const flight = createSingleFlight();
    const gate = deferred();
    const fetcher = () => gate.promise;

    const pending = Promise.all([flight.run('k', fetcher), flight.run('k', fetcher)]);
    gate.resolve(new Response('shared payload'));
    const [first, second] = await pending;

    expect(await first.text()).toBe('shared payload');
    expect(await second.text()).toBe('shared payload');
  });

  it('does not share different keys', async () => {
    const flight = createSingleFlight();
    const fetcher = vi.fn(async () => new Response('x'));

    await Promise.all([flight.run('a', fetcher), flight.run('b', fetcher)]);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // A coalescer, not a cache: once a flight settles the next caller must go and fetch.
  it('starts a new call once the previous one has settled', async () => {
    const flight = createSingleFlight();
    const fetcher = vi.fn(async () => new Response('x'));

    await flight.run('k', fetcher);
    await flight.run('k', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(flight.size()).toBe(0);
  });

  it('rejects every participant when the shared call fails, and clears the entry', async () => {
    const flight = createSingleFlight();
    const gate = deferred();
    const fetcher = vi.fn(() => gate.promise);

    const joined = Promise.allSettled([flight.run('k', fetcher), flight.run('k', fetcher)]);
    gate.reject(new Error('endpoint down'));
    const results = await joined;

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(flight.size()).toBe(0);
  });
});

describe('singleFlightKey', () => {
  const get = (init?: RequestInit) => new Request('https://f.test/panel', init);

  it('matches identical anonymous requests', () => {
    expect(singleFlightKey(get(), 'https://f.test/panel')).toBe(singleFlightKey(get(), 'https://f.test/panel'));
  });

  // The correctness boundary: sharing across identities is a data leak wearing a performance
  // feature's clothes.
  it('separates requests carrying different credentials', () => {
    const a = singleFlightKey(get({ headers: { cookie: 'sid=alice' } }), 'https://f.test/panel');
    const b = singleFlightKey(get({ headers: { cookie: 'sid=bob' } }), 'https://f.test/panel');
    const anon = singleFlightKey(get(), 'https://f.test/panel');

    expect(a).not.toBe(b);
    expect(a).not.toBe(anon);
  });

  it('separates requests differing only by authorization', () => {
    const a = singleFlightKey(get({ headers: { authorization: 'Bearer a' } }), 'https://f.test/panel');
    const b = singleFlightKey(get({ headers: { authorization: 'Bearer b' } }), 'https://f.test/panel');

    expect(a).not.toBe(b);
  });

  it('separates requests differing by content negotiation', () => {
    const a = singleFlightKey(get({ headers: { 'accept-language': 'en' } }), 'https://f.test/panel');
    const b = singleFlightKey(get({ headers: { 'accept-language': 'fr' } }), 'https://f.test/panel');

    expect(a).not.toBe(b);
  });

  // Server-side device detection is invisible from the manifest, so it has to be in the key.
  it('separates requests differing by user-agent', () => {
    const a = singleFlightKey(get({ headers: { 'user-agent': 'Mobile Safari' } }), 'https://f.test/panel');
    const b = singleFlightKey(get({ headers: { 'user-agent': 'Desktop Chrome' } }), 'https://f.test/panel');

    expect(a).not.toBe(b);
  });

  it('refuses unsafe methods and range requests', () => {
    expect(singleFlightKey(new Request('https://f.test/panel', { method: 'POST' }), 'https://f.test/panel')).toBeNull();
    expect(singleFlightKey(get({ headers: { range: 'bytes=0-99' } }), 'https://f.test/panel')).toBeNull();
  });
});

describe('gateway fragment coalescing', () => {
  const shell = (slots: string) =>
    new Response(`<!doctype html><html><head></head><body>${slots}</body></html>`, {
      headers: { 'content-type': 'text/html' },
    });

  it('fetches an unbound widget once for concurrent identical renders', async () => {
    const gate = deferred();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => gate.promise);

    const gateway = createGateway({
      registry: [{ id: 'notifications', endpoint: 'https://notify.test', bound: false, src: '/panel', pierce: ['/*'] }],
      coalesceFragmentFetches: true,
    });

    const render = () =>
      gateway.handle(new Request('https://shell.test/page', { headers: { 'sec-fetch-dest': 'document' } }), async () =>
        shell('<fragment-slot name="notifications"></fragment-slot>'),
      );

    const all = Promise.all([render(), render(), render()]);
    gate.resolve(new Response('<p>3 unread</p>', { headers: { 'content-type': 'text/html' } }));
    const pages = await all;
    const bodies = await Promise.all(pages.map((page) => page!.text()));

    // Counted before restoring: mockRestore() clears the call history along with the stub.
    const calls = fetchMock.mock.calls.length;
    fetchMock.mockRestore();

    expect(calls).toBe(1);
    // Every page must still contain the content — a collapsed fetch that loses a render is worse
    // than the duplicate fetches it saved.
    expect(bodies.every((body) => body.includes('3 unread'))).toBe(true);
  });

  /**
   * The key is computed from the request that is actually **sent**, not the one received — so
   * what it must contain follows from what the endpoint can actually see.
   *
   * Since credentials are no longer forwarded by default, two signed-in callers produce a
   * byte-identical fragment request, and sharing one response is correct rather than a leak. The
   * moment a host forwards credentials, or adds a per-caller header of its own, the requests
   * differ again and so must the key.
   */
  it('coalesces across sessions when the endpoint cannot see the session', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<p>panel</p>', { headers: { 'content-type': 'text/html' } }));

    const gateway = createGateway({
      registry: [{ id: 'notifications', endpoint: 'https://notify.test', bound: false, src: '/panel', pierce: ['/*'] }],
      coalesceFragmentFetches: true,
    });

    const render = (sid: string) =>
      gateway.handle(
        new Request('https://shell.test/page', { headers: { 'sec-fetch-dest': 'document', cookie: `sid=${sid}` } }),
        async () => shell('<fragment-slot name="notifications"></fragment-slot>'),
      );

    await Promise.all([render('alice'), render('bob')]);

    const calls = fetchMock.mock.calls.length;
    fetchMock.mockRestore();
    expect(calls).toBe(1);
  });

  it('does not coalesce across sessions once credentials are forwarded', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<p>panel</p>', { headers: { 'content-type': 'text/html' } }));

    const gateway = createGateway({
      registry: [{ id: 'notifications', endpoint: 'https://notify.test', bound: false, src: '/panel', pierce: ['/*'] }],
      coalesceFragmentFetches: true,
      forwardCredentials: true,
    });

    const render = (sid: string) =>
      gateway.handle(
        new Request('https://shell.test/page', { headers: { 'sec-fetch-dest': 'document', cookie: `sid=${sid}` } }),
        async () => shell('<fragment-slot name="notifications"></fragment-slot>'),
      );

    await Promise.all([render('alice'), render('bob')]);

    const calls = fetchMock.mock.calls.length;
    fetchMock.mockRestore();
    expect(calls).toBe(2);
  });

  it('does not coalesce across callers given different gateway-added headers', async () => {
    // The leak this closes: a function-form `additionalHeaders` varies per caller, so a key that
    // ignored it would serve one caller a fragment rendered against another's identity.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<p>panel</p>', { headers: { 'content-type': 'text/html' } }));

    const gateway = createGateway({
      registry: [{ id: 'notifications', endpoint: 'https://notify.test', bound: false, src: '/panel', pierce: ['/*'] }],
      coalesceFragmentFetches: true,
      additionalHeaders: (request) => ({
        'x-braid-identity': `assertion-for-${request.headers.get('x-user') ?? 'anon'}`,
      }),
    });

    const render = (user: string) =>
      gateway.handle(
        new Request('https://shell.test/page', { headers: { 'sec-fetch-dest': 'document', 'x-user': user } }),
        async () => shell('<fragment-slot name="notifications"></fragment-slot>'),
      );

    await Promise.all([render('alice'), render('bob')]);

    const calls = fetchMock.mock.calls.length;
    fetchMock.mockRestore();
    expect(calls).toBe(2);
  });

  it('still coalesces when a gateway-added header is the same for everyone', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<p>panel</p>', { headers: { 'content-type': 'text/html' } }));

    const gateway = createGateway({
      registry: [{ id: 'notifications', endpoint: 'https://notify.test', bound: false, src: '/panel', pierce: ['/*'] }],
      coalesceFragmentFetches: true,
      additionalHeaders: { 'x-tenant': 'acme' },
    });

    const render = () =>
      gateway.handle(
        new Request('https://shell.test/page', { headers: { 'sec-fetch-dest': 'document' } }),
        async () => shell('<fragment-slot name="notifications"></fragment-slot>'),
      );

    await Promise.all([render(), render()]);

    const calls = fetchMock.mock.calls.length;
    fetchMock.mockRestore();
    expect(calls).toBe(1);
  });

  // A gated fragment's response follows an authorization decision made per request; sharing the
  // response would share the decision.
  it('never coalesces a fragment that declares access rules', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<p>payroll</p>', { headers: { 'content-type': 'text/html' } }));

    const gateway = createGateway({
      registry: [
        {
          id: 'payroll',
          endpoint: 'https://payroll.test',
          bound: false,
          src: '/panel',
          pierce: ['/*'],
          access: { fetch: { roles: ['payroll'] } },
        },
      ],
      principal: () => ({ roles: ['payroll'], scopes: [] }),
      coalesceFragmentFetches: true,
    });

    const render = () =>
      gateway.handle(new Request('https://shell.test/page', { headers: { 'sec-fetch-dest': 'document' } }), async () =>
        shell('<fragment-slot name="payroll"></fragment-slot>'),
      );

    await Promise.all([render(), render()]);

    const calls = fetchMock.mock.calls.length;
    fetchMock.mockRestore();
    expect(calls).toBe(2);
  });

  it('leaves fetches alone when coalescing is explicitly disabled', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<p>panel</p>', { headers: { 'content-type': 'text/html' } }));

    const gateway = createGateway({
      registry: [{ id: 'notifications', endpoint: 'https://notify.test', bound: false, src: '/panel', pierce: ['/*'] }],
      coalesceFragmentFetches: false,
    });

    const render = () =>
      gateway.handle(new Request('https://shell.test/page', { headers: { 'sec-fetch-dest': 'document' } }), async () =>
        shell('<fragment-slot name="notifications"></fragment-slot>'),
      );

    await Promise.all([render(), render()]);

    const calls = fetchMock.mock.calls.length;
    fetchMock.mockRestore();
    expect(calls).toBe(2);
  });

  // The default: an unconfigured gateway coalesces.
  it('coalesces without being asked to', async () => {
    const gate = deferred();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => gate.promise);

    const gateway = createGateway({
      registry: [{ id: 'notifications', endpoint: 'https://notify.test', bound: false, src: '/panel', pierce: ['/*'] }],
    });

    const render = () =>
      gateway.handle(new Request('https://shell.test/page', { headers: { 'sec-fetch-dest': 'document' } }), async () =>
        shell('<fragment-slot name="notifications"></fragment-slot>'),
      );

    const all = Promise.all([render(), render(), render()]);
    gate.resolve(new Response('<p>panel</p>', { headers: { 'content-type': 'text/html' } }));
    await all;

    const calls = fetchMock.mock.calls.length;
    fetchMock.mockRestore();
    expect(calls).toBe(1);
  });

  // The escape hatch for an endpoint varying on something the gateway cannot see.
  it('honors a manifest opting out', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<p>panel</p>', { headers: { 'content-type': 'text/html' } }));

    const gateway = createGateway({
      registry: [
        { id: 'notifications', endpoint: 'https://notify.test', bound: false, src: '/panel', pierce: ['/*'], coalesce: false },
      ],
    });

    const render = () =>
      gateway.handle(new Request('https://shell.test/page', { headers: { 'sec-fetch-dest': 'document' } }), async () =>
        shell('<fragment-slot name="notifications"></fragment-slot>'),
      );

    await Promise.all([render(), render()]);

    const calls = fetchMock.mock.calls.length;
    fetchMock.mockRestore();
    expect(calls).toBe(2);
  });
});
