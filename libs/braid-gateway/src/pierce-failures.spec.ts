import { describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.js';

/**
 * Pierce fetches start before the shell is awaited, so their failures surface later — or never,
 * when the shell fails first. Neither may become an unhandled rejection or a leaked body.
 */

const SHELL = `<html><head></head><body><fragment-slot name="billing"></fragment-slot><footer>end</footer></body></html>`;
const navigation = new Request('https://x.example/billing/invoices', { headers: { 'sec-fetch-dest': 'document' } });
const shell = async () => new Response(SHELL, { headers: { 'content-type': 'text/html' } });

function pierceGateway(fragment: Promise<Response>) {
  return createGateway({
    registry: [{ id: 'billing', pierce: ['/billing/*'], endpoint: (async () => fragment) as unknown as typeof fetch }],
  });
}

describe('pierce failures before a fragment request is sent', () => {
  it('degrade to the slot fallback rather than an unhandled rejection', async () => {
    const gateway = createGateway({
      registry: [{ id: 'billing', pierce: ['/billing/*'], endpoint: 'https://billing.internal/' }],
      additionalHeaders: () => {
        throw new Error('identity service down');
      },
    });

    const html = await (await gateway.handle(navigation, shell))!.text();

    expect(html).toContain('<fragment-slot name="billing" data-braid-fallback="placeholder">');
    expect(html).toContain('<footer>end</footer>');
  });

  it('cancel the fragment fetches when the shell itself fails', async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    const gateway = pierceGateway(Promise.resolve(new Response(body, { headers: { 'content-type': 'text/html' } })));

    await expect(gateway.handle(navigation, () => Promise.reject(new Error('shell down')))).rejects.toThrow('shell down');
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});
