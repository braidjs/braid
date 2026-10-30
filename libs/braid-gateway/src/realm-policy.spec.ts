import { describe, expect, it } from 'vitest';
import { createGateway } from './gateway.js';
import type { FragmentManifest } from './registry.js';

const stubRequest = new Request('https://portal.example/__braid/realm/billing/');
const notFound = async () => new Response('shell', { status: 404 });

function stub(manifest: Partial<FragmentManifest>, realmPolicy?: 'report' | 'enforce') {
  const gateway = createGateway({
    registry: [{ id: 'billing', endpoint: 'https://billing.internal', ...manifest }],
    ...(realmPolicy ? { realmPolicy } : {}),
  });
  return gateway.handle(stubRequest, notFound);
}

describe('realm network policy', () => {
  const network = { capabilities: { network: ['https://api.billing.example', 'wss://*.push.example:443'] } };

  it('enforces the declared origins on the realm with realmPolicy: enforce', async () => {
    const response = (await stub(network, 'enforce'))!;
    expect(response.headers.get('content-security-policy')).toBe(
      "connect-src 'self' https://api.billing.example wss://*.push.example:443",
    );
    expect(response.headers.get('content-security-policy-report-only')).toBeNull();
  });

  it('only reports with realmPolicy: report', async () => {
    const response = (await stub(network, 'report'))!;
    expect(response.headers.get('content-security-policy-report-only')).toBe(
      "connect-src 'self' https://api.billing.example wss://*.push.example:443",
    );
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('sends no policy without the option, or for a fragment that declares no network', async () => {
    const withoutOption = (await stub(network))!;
    const withoutNetwork = (await stub({}, 'enforce'))!;
    for (const response of [withoutOption, withoutNetwork]) {
      expect(response.headers.get('content-security-policy')).toBeNull();
      expect(response.headers.get('content-security-policy-report-only')).toBeNull();
    }
    // and the stub itself is unchanged by the option
    expect(await withoutOption.text()).toBe(await (await stub(network, 'enforce'))!.text());
  });

  it('gives a stub with a policy its own ETag, so turning the policy on or off is never answered 304', async () => {
    const plain = (await stub(network))!.headers.get('etag');
    const enforced = (await stub(network, 'enforce'))!.headers.get('etag');
    const reported = (await stub(network, 'report'))!.headers.get('etag');
    expect(new Set([plain, enforced, reported]).size).toBe(3);

    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: 'https://billing.internal', ...network }] });
    const revalidated = await gateway.handle(
      new Request(stubRequest.url, { headers: { 'if-none-match': enforced! } }),
      notFound,
    );
    expect(revalidated!.status).toBe(200);
  });

  it.each([
    'https://api.example/v1',
    "https://api.example 'unsafe-inline'",
    'https://a.example; script-src *',
    'https://a.example,https://b.example',
    "'self'",
    'api.example',
    'javascript:alert(1)',
  ])('refuses the network entry %j when the registry loads', (entry) => {
    expect(() =>
      createGateway({
        registry: [{ id: 'billing', endpoint: 'https://billing.internal', capabilities: { network: [entry] } }],
        realmPolicy: 'enforce',
      }),
    ).toThrow(/manifest "billing" has capabilities.network entries/);
  });

  it('refuses an unknown realmPolicy', () => {
    expect(() => createGateway({ registry: [], realmPolicy: 'block' as never })).toThrow(/realmPolicy/);
  });
});
