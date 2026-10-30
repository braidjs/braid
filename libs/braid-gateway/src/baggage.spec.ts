import { describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.js';
import { fragmentBaggage } from './baggage.js';
import type { FragmentManifest } from './registry.js';
import type { FragmentFetchEvent } from './telemetry.js';

const request = (baggage?: string) =>
  new Request('https://shell.example/__braid/frag/orders/api', { headers: baggage ? { baggage } : {} });

describe('fragmentBaggage()', () => {
  it('drops every inbound member unless allowlisted', () => {
    expect(fragmentBaggage(request('tenant=acme,userId=42'), undefined)).toBeNull();
    expect(fragmentBaggage(request('tenant=acme,userId=42'), { forward: ['tenant'] })).toBe('tenant=acme');
  });

  it('checks allowlisted values against their pattern, in full, decoded', () => {
    const forward = { tenant: /[a-z]+/, region: /eu|us/ };
    expect(fragmentBaggage(request('tenant=acme,region=eu'), { forward })).toBe('tenant=acme,region=eu');
    expect(fragmentBaggage(request('tenant=acme1,region=euw'), { forward })).toBeNull();
    expect(fragmentBaggage(request('tenant=%E0%A4%A'), { forward: { tenant: /.*/ } })).toBeNull();
  });

  it('drops member properties and malformed members', () => {
    expect(fragmentBaggage(request('tenant=acme;sampled=1, =x, bad key=1'), { forward: ['tenant', 'bad key'] })).toBe('tenant=acme');
  });

  it("lets the gateway's own members override a client's", () => {
    const options = { forward: ['tenant'], set: () => ({ tenant: 'from server', 'braid.fragment.id': 'orders' }) };
    expect(fragmentBaggage(request('tenant=forged'), options)).toBe('tenant=from%20server,braid.fragment.id=orders');
  });

  it('drops an oversize header whole', () => {
    expect(fragmentBaggage(request(`tenant=${'a'.repeat(9000)}`), { forward: ['tenant'] })).toBeNull();
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
});
