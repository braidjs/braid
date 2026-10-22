import { describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.js';

/**
 * `documents` lets the gateway answer a page from something other than a shell app — a shell
 * defined as data, rendered on request — and pierce fragments into it exactly as it would into an
 * app's HTML.
 */
describe('gateway documents hook', () => {
  const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const page = `<!doctype html><html><head><title>Billing</title></head><body><fragment-slot name="billing"></fragment-slot></body></html>`;
  const billing = (async () => html('<h1>Invoices</h1>')) as unknown as typeof fetch;
  const documentRequest = (path: string) =>
    new Request(`https://example.com${path}`, { headers: { 'sec-fetch-dest': 'document' } });

  it('pierces fragments into the document it supplies, with no shell app behind the gateway', async () => {
    const gateway = createGateway({
      registry: [{ id: 'billing', endpoint: billing, pierce: ['/billing/*'] }],
      documents: async () => html(page),
    });

    const response = await gateway.handle(documentRequest('/billing/1'));
    const body = await response!.text();

    expect(response!.status).toBe(200);
    expect(body).toContain('<title>Billing</title>');
    expect(body).toContain('<h1>Invoices</h1>');
    expect(response!.headers.get('x-braid-fragment-id')).toBe('billing');
  });

  it('serves its document when no fragment pierces the page', async () => {
    const gateway = createGateway({
      registry: [{ id: 'billing', endpoint: billing, pierce: ['/billing/*'] }],
      documents: async (request) => (new URL(request.url).pathname === '/about' ? html('<h1>About</h1>') : null),
    });

    const response = await gateway.handle(documentRequest('/about'));

    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe('<h1>About</h1>');
    expect(response!.headers.get('cache-control')).toContain('private');
  });

  it('falls through to the shell app when it has no document for the page', async () => {
    const shell = vi.fn(async () => html('<p>app</p>'));
    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: billing }], documents: async () => null });

    const response = await gateway.handle(documentRequest('/elsewhere'), shell);

    // nothing pierces /elsewhere either, so the gateway steps aside and the caller serves its app
    expect(response).toBeNull();
    expect(shell).not.toHaveBeenCalled();
  });

  it('is consulted only for document requests, never for assets or data', async () => {
    const documents = vi.fn(async () => html(page));
    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: billing, pierce: ['/billing/*'] }], documents });

    await gateway.handle(new Request('https://example.com/billing/1', { headers: { 'sec-fetch-dest': 'empty' } }));
    await gateway.handle(new Request('https://example.com/billing/1', { method: 'POST', body: '{}' }));

    expect(documents).not.toHaveBeenCalled();
  });
});
