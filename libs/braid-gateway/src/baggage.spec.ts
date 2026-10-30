import { describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.js';
import { fragmentBaggage, type BaggageOptions } from './baggage.js';
import type { FragmentManifest } from './registry.js';
import type { FragmentFetchEvent } from './telemetry.js';

const request = (baggage?: string) =>
  new Request('https://shell.example/__braid/frag/orders/api', { headers: baggage ? { baggage } : {} });
const baggageOf = (req: Request, options: BaggageOptions | undefined) => fragmentBaggage(req, options, 'orders');

describe('fragmentBaggage()', () => {
  it('drops every inbound member unless allowlisted', () => {
    expect(baggageOf(request('tenant=acme,userId=42'), undefined)).toBeNull();
    expect(baggageOf(request('tenant=acme,userId=42'), { forward: ['tenant'] })).toBe('tenant=acme');
  });

  it('checks allowlisted values against their pattern, in full, decoded', () => {
    const forward = { tenant: /[a-z]+/, region: /eu|us/ };
    expect(baggageOf(request('tenant=acme,region=eu'), { forward })).toBe('tenant=acme,region=eu');
    expect(baggageOf(request('tenant=acme1,region=euw'), { forward })).toBeNull();
    expect(baggageOf(request('tenant=%E0%A4%A'), { forward: { tenant: /.*/ } })).toBeNull();
  });

  it('drops member properties and malformed members', () => {
    expect(baggageOf(request('tenant=acme;sampled=1, =x, bad key=1'), { forward: ['tenant', 'bad key'] })).toBe('tenant=acme');
  });

  it("lets the gateway's own members override a client's", () => {
    const options = { forward: ['tenant'], set: () => ({ tenant: 'from server', 'braid.fragment.id': 'orders' }) };
    expect(baggageOf(request('tenant=forged'), options)).toBe('tenant=from%20server,braid.fragment.id=orders');
  });

  it('drops an oversize header whole', () => {
    expect(baggageOf(request(`tenant=${'a'.repeat(9000)}`), { forward: ['tenant'] })).toBeNull();
  });

  it('matches a pattern the same way every time, whatever its flags', () => {
    const forward = { tenant: /[a-z]+/g, region: /a|ab/, line: /^x$/m };
    const results = [1, 2, 3, 4].map(() => baggageOf(request('tenant=acme,region=ab'), { forward }));
    expect(results).toEqual(Array(4).fill('tenant=acme,region=ab'));
    // `m` must not let `^`/`$` match at a newline inside the value
    expect(baggageOf(request('line=a%0Ax'), { forward })).toBeNull();
  });

  it('forwards only well-formed values, by key alone too', () => {
    // a space, a quote and a backslash are not baggage octets; a bad escape does not decode
    expect(baggageOf(request('tenant=a b"c\\d'), { forward: ['tenant'] })).toBeNull();
    expect(baggageOf(request('tenant=%zz'), { forward: ['tenant'] })).toBeNull();
    expect(baggageOf(request('tenant=caf%C3%A9'), { forward: ['tenant'] })).toBe('tenant=caf%C3%A9');
  });

  it("hands `set` the fragment, and drops a member it can't encode instead of failing", () => {
    const set = vi.fn(() => ({ 'braid.fragment.id': 'orders', broken: '\ud800' }));
    expect(baggageOf(request(), { set })).toBe('braid.fragment.id=orders');
    expect(set).toHaveBeenCalledWith(expect.any(Request), 'orders');
  });
});

describe('baggage on fragment requests', () => {
  function capture(manifests: Partial<FragmentManifest>[] = [{}]) {
    const seen: (string | null)[] = [];
    const registry = manifests.map((manifest, i) => ({
      id: `f${i}`,
      endpoint: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Request(input, init).headers.get('baggage'));
        return new Response('ok');
      }) as typeof fetch,
      ...manifest,
    }));
    return { seen, registry };
  }

  it('no longer copies the browser’s baggage to a fragment by default', async () => {
    const { seen, registry } = capture();
    await createGateway({ registry, forwardCredentials: true }).handle(
      new Request('https://shell.example/__braid/frag/f0/api', { headers: { baggage: 'userId=42' } }),
    );
    expect(seen).toEqual([null]);
  });

  it('forwards allowlisted baggage only inside the trust boundary', async () => {
    const { seen, registry } = capture([{}, {}]);
    const gateway = createGateway({
      registry,
      baggage: { forward: ['tenant'] },
      forwardCredentials: (fragment) => fragment.id === 'f0',
    });
    for (const id of ['f0', 'f1']) {
      await gateway.handle(new Request(`https://shell.example/__braid/frag/${id}/api`, { headers: { baggage: 'tenant=acme' } }));
    }
    expect(seen).toEqual(['tenant=acme', null]);
  });

  it('never coalesces two fetches whose baggage differs', async () => {
    let calls = 0;
    const gate = Promise.withResolvers<void>();
    const gateway = createGateway({
      registry: [
        {
          id: 'orders',
          endpoint: (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls++;
            const baggage = new Request(input, init).headers.get('baggage');
            await gate.promise;
            return new Response(baggage);
          }) as typeof fetch,
        },
      ],
      forwardCredentials: true,
      baggage: { forward: ['tenant'] },
    });
    const fetchAs = (tenant: string) =>
      gateway.handle(new Request('https://shell.example/__braid/frag/orders/api', { headers: { baggage: `tenant=${tenant}` } }));
    const pending = [fetchAs('acme'), fetchAs('globex'), fetchAs('acme')];
    await new Promise((r) => setTimeout(r, 10));
    gate.resolve();
    const bodies = await Promise.all(pending.map(async (p) => (await p)!.text()));
    expect(bodies).toEqual(['tenant=acme', 'tenant=globex', 'tenant=acme']);
    // the two acme fetches still shared one
    expect(calls).toBe(2);
  });
});

describe('telemetry.onFragmentFetch', () => {
  it('sets its headers on the fragment request and ends with the same event `on` receives', async () => {
    const seen: (string | null)[] = [];
    const on = vi.fn();
    const end = vi.fn();
    const gateway = createGateway({
      registry: [
        {
          id: 'orders',
          endpoint: (async (input: RequestInfo | URL, init?: RequestInit) => {
            seen.push(new Request(input, init).headers.get('traceparent'));
            return new Response('ok', { status: 503 });
          }) as typeof fetch,
        },
      ],
      telemetry: {
        on,
        onFragmentFetch: ({ fragmentId, phase, method }) => {
          expect({ fragmentId, phase, method }).toEqual({ fragmentId: 'orders', phase: 'namespace', method: 'GET' });
          return { headers: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' }, end };
        },
      },
    });
    await gateway.handle(
      new Request('https://shell.example/__braid/frag/orders/api', {
        headers: { traceparent: '00-ffffffffffffffffffffffffffffffff-ffffffffffffffff-01' },
      }),
    );

    // the hook's trace context, not the browser's
    expect(seen).toEqual(['00-0123456789abcdef0123456789abcdef-0123456789abcdef-01']);
    const event = on.mock.calls.find(([e]) => e.kind === 'fragment-fetch')![0] as FragmentFetchEvent;
    expect(end).toHaveBeenCalledWith(event, undefined);
    expect(event).toMatchObject({ outcome: 'ok', status: 503 });
  });

  it('is muted, with the request still served, when it throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gateway = createGateway({
      registry: [{ id: 'orders', endpoint: (async () => new Response('ok')) as typeof fetch }],
      telemetry: {
        onFragmentFetch: () => {
          throw new Error('broken tracer');
        },
      },
    });
    const response = await gateway.handle(new Request('https://shell.example/__braid/frag/orders/api'));
    expect(response?.status).toBe(200);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('leaves the request headers exactly as before when not configured', async () => {
    const headers: Headers[] = [];
    const gateway = createGateway({
      registry: [
        {
          id: 'orders',
          endpoint: (async (input: RequestInfo | URL, init?: RequestInit) => (headers.push(new Request(input, init).headers), new Response('ok'))) as typeof fetch,
        },
      ],
    });
    await gateway.handle(
      new Request('https://shell.example/__braid/frag/orders/api', {
        headers: { traceparent: '00-ffffffffffffffffffffffffffffffff-ffffffffffffffff-01' },
      }),
    );
    // unchanged from before: the caller's trace context still passes through without a tracer
    expect(headers[0].get('traceparent')).toBe('00-ffffffffffffffffffffffffffffffff-ffffffffffffffff-01');
  });

  it('still ends what it opened after a throwing `on` mutes telemetry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const end = vi.fn();
    const gateway = createGateway({
      registry: [{ id: 'orders', endpoint: (async () => new Response('ok')) as typeof fetch }],
      telemetry: {
        on: () => {
          throw new Error('broken sink');
        },
        onFragmentFetch: () => ({ end }),
      },
    });
    expect((await gateway.handle(new Request('https://shell.example/__braid/frag/orders/api')))?.status).toBe(200);
    expect(end).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('is muted, and still ended, when it hands back headers that cannot be set', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const end = vi.fn();
    const seen: Headers[] = [];
    const gateway = createGateway({
      registry: [
        {
          id: 'orders',
          endpoint: (async (input: RequestInfo | URL, init?: RequestInit) => (seen.push(new Request(input, init).headers), new Response('ok'))) as typeof fetch,
        },
      ],
      telemetry: { onFragmentFetch: () => ({ headers: { traceparent: '00-ok', 'bad name': 'x' }, end }) },
    });
    const response = await gateway.handle(
      new Request('https://shell.example/__braid/frag/orders/api', { headers: { tracestate: 'browser=1' } }),
    );
    expect(response?.status).toBe(200);
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok' }), undefined);
    // none of them set, so the request is as it would be without the hook
    expect(seen[0].get('traceparent')).toBeNull();
    expect(seen[0].get('tracestate')).toBe('browser=1');
    error.mockRestore();
  });

  it("drops the caller's tracestate for a traceparent of any case", async () => {
    const seen: Headers[] = [];
    const gateway = createGateway({
      registry: [
        {
          id: 'orders',
          endpoint: (async (input: RequestInfo | URL, init?: RequestInit) => (seen.push(new Request(input, init).headers), new Response('ok'))) as typeof fetch,
        },
      ],
      telemetry: { onFragmentFetch: () => ({ headers: { Traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' } }) },
    });
    await gateway.handle(new Request('https://shell.example/__braid/frag/orders/api', { headers: { tracestate: 'browser=1' } }));
    expect(seen[0].get('tracestate')).toBeNull();
  });

  it('runs the endpoint fetch inside `run`, and marks a fetch that joined another as coalesced', async () => {
    const gate = Promise.withResolvers<void>();
    const running: string[] = [];
    let current: string | undefined;
    const events: FragmentFetchEvent[] = [];
    let next = 0;
    const gateway = createGateway({
      registry: [
        {
          id: 'orders',
          endpoint: (async () => {
            running.push(current!);
            await gate.promise;
            return new Response('ok');
          }) as typeof fetch,
        },
      ],
      telemetry: {
        onFragmentFetch: () => {
          const id = `fetch-${next++}`;
          return {
            run: (fetch) => {
              current = id;
              try {
                return fetch();
              } finally {
                current = undefined;
              }
            },
            end: (event) => events.push(event),
          };
        },
      },
    });
    const pending = [1, 2].map(() => gateway.handle(new Request('https://shell.example/__braid/frag/orders/api')));
    await new Promise((r) => setTimeout(r, 10));
    gate.resolve();
    await Promise.all(pending);

    // one endpoint call, made inside the first fetch's run
    expect(running).toEqual(['fetch-0']);
    expect(events.map((event) => event.coalesced ?? false).sort()).toEqual([false, true]);
  });
});
