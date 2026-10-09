import { describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.js';
import { singleFlightKey } from './single-flight.js';

/**
 * Conditional requests for a fragment's own assets reach its endpoint, so a revalidation of an
 * unchanged file costs a 304 rather than the whole body again.
 *
 * Only where the gateway passes the endpoint's response through untouched. A prepared document or
 * pierced page is a transformation of the endpoint's body, and the endpoint's validator does not
 * describe what the browser holds.
 */

const ETAG = '"v1"';

function endpoint() {
  const seen: Array<{ path: string; ifNoneMatch: string | null; ifModifiedSince: string | null }> = [];
  const fetcher = vi.fn(async (request: Request) => {
    const ifNoneMatch = request.headers.get('if-none-match');
    seen.push({
      path: new URL(request.url).pathname,
      ifNoneMatch,
      ifModifiedSince: request.headers.get('if-modified-since'),
    });
    if (ifNoneMatch === ETAG) return new Response(null, { status: 304, headers: { etag: ETAG } });
    const html = new URL(request.url).pathname.endsWith('.js') ? 'export {}' : '<h1>Billing</h1>';
    return new Response(html, {
      headers: { etag: ETAG, 'content-type': html.startsWith('<') ? 'text/html' : 'text/javascript' },
    });
  });
  return { fetcher: fetcher as unknown as typeof fetch, seen };
}

const conditional = { 'if-none-match': ETAG, 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' };

describe('asset revalidation', () => {
  it('forwards validators for fragment assets and passes the 304 through', async () => {
    const { fetcher, seen } = endpoint();
    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: fetcher }] });

    const response = await gateway.handle(
      new Request('https://x.example/__braid/frag/billing/main.js', { headers: conditional }),
    );

    expect(response!.status).toBe(304);
    expect(await response!.text()).toBe('');
    expect(seen[0]).toMatchObject({ ifNoneMatch: ETAG, ifModifiedSince: conditional['if-modified-since'] });
  });

  it('still strips them for a prepared fragment document', async () => {
    const { fetcher, seen } = endpoint();
    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: fetcher }] });

    const response = await gateway.handle(
      new Request('https://x.example/__braid/doc/billing/invoices', { headers: conditional }),
    );

    expect(response!.status).toBe(200);
    expect(seen[0]).toMatchObject({ ifNoneMatch: null, ifModifiedSince: null });
  });

  it('still strips them when piercing, where they are the shell’s validators', async () => {
    const { fetcher, seen } = endpoint();
    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: fetcher, pierce: ['/billing/*'] }] });

    await gateway.handle(
      new Request('https://x.example/billing/invoices', {
        headers: { ...conditional, 'sec-fetch-dest': 'document' },
      }),
      async () =>
        new Response('<html><body><fragment-slot name="billing"></fragment-slot></body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    );

    expect(seen[0]).toMatchObject({ ifNoneMatch: null, ifModifiedSince: null });
  });

  it('never shares one caller’s 304 with a caller who asked for the body', () => {
    const plain = new Request('https://e.example/main.js');
    const revalidating = new Request('https://e.example/main.js', { headers: conditional });

    expect(singleFlightKey(plain, plain.url)).not.toBe(singleFlightKey(revalidating, revalidating.url));
  });
});
