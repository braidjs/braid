import { describe, expect, it, vi } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createGateway } from '@braidlabs/gateway';
import { renderShellDocument, shellDocuments } from './shell-render.js';
import type { ShellManifest } from './shell.js';
import { createSnapshot } from './snapshot.js';
import { memorySnapshotStore } from './store.js';
import { snapshotRegistry } from './source.js';

const manifests: FragmentManifest[] = [
  { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] },
  { id: 'rating', endpoint: 'https://rating.internal', bound: false, src: '/widget' },
];

const storefront: ShellManifest = {
  id: 'storefront',
  framework: 'vanilla',
  routes: [
    {
      path: '/billing/*',
      layout: { areas: 'header header\naside main', columns: '280px 1fr', rows: 'auto 1fr', gap: '12px' },
      slots: { header: 'rating', main: 'billing' },
    },
  ],
  head: {
    title: 'Billing · <Example> & Co',
    meta: [{ name: 'description', content: 'Invoices "and" payments' }],
    stylesheets: [{ href: '/assets/site.css' }],
    scripts: [{ src: 'https://cdn.example/analytics.js', async: true }],
  },
};

const RUNTIME = '/assets/braid-runtime.js';

describe('renderShellDocument()', () => {
  const html = () =>
    renderShellDocument(storefront, storefront.routes[0], manifests, { runtimeSrc: RUNTIME, assetOrigins: ['https://cdn.example'] });

  it('renders the head, escaped', () => {
    const page = html();
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<title>Billing · &lt;Example&gt; &amp; Co</title>');
    expect(page).toContain('<meta name="description" content="Invoices &quot;and&quot; payments">');
    expect(page).toContain('<link rel="stylesheet" href="/assets/site.css">');
    expect(page).toContain('<script src="https://cdn.example/analytics.js" async></script>');
    expect(page).toContain(`<script type="module" src="${RUNTIME}"></script>`);
  });

  it('lays the route out as the CSS grid its areas describe', () => {
    const page = html();
    expect(page).toContain(`grid-template-areas:"header header" "aside main"`);
    expect(page).toContain('grid-template-columns:280px 1fr');
    expect(page).toContain('gap:12px');
    expect(page).toContain(`[data-braid-area="main"]{grid-area:main}`);
  });

  it('puts one named slot in each slotted area, with an unbound fragment at its src', () => {
    const page = html();
    expect(page).toContain('<fragment-slot name="billing" data-braid-area="main"></fragment-slot>');
    expect(page).toContain('<fragment-slot name="rating" data-braid-area="header" src="/widget"></fragment-slot>');
    // an area with no fragment is simply empty
    expect(page).not.toMatch(/<fragment-slot[^>]*data-braid-area="aside"/);
  });

  it('re-checks URLs at render time, so a hostile one stored before validation existed never loads', () => {
    const hostile: ShellManifest = {
      ...storefront,
      head: {
        scripts: [{ src: 'javascript:alert(1)' }, { src: '//evil.example/x.js' }, { src: '/ok.js' }],
        stylesheets: [{ href: 'http://insecure.example/a.css' }],
        title: '</title><script>alert(1)</script>',
      },
    };

    const page = renderShellDocument(hostile, hostile.routes[0], manifests, { runtimeSrc: RUNTIME });

    expect(page).not.toMatch(/javascript:|evil\.example|insecure\.example|<script>alert/);
    expect(page).toContain('<script src="/ok.js"></script>');
  });

  it('loads cross-origin assets only from origins the operator allowed', () => {
    const page = renderShellDocument(storefront, storefront.routes[0], manifests, { runtimeSrc: RUNTIME });

    expect(page).not.toContain('cdn.example');
    expect(page).toContain('<link rel="stylesheet" href="/assets/site.css">');
  });

  it("drops an unbound fragment's src unless it is a path on its own endpoint", () => {
    const hostile = [manifests[0]!, { ...manifests[1]!, src: '//evil.example/x' }];

    expect(renderShellDocument(storefront, storefront.routes[0], hostile, { runtimeSrc: RUNTIME })).not.toContain('evil.example');
  });

  it('drops a layout value that is not a track list rather than writing it into a style rule', () => {
    const route = { ...storefront.routes[0], layout: { ...storefront.routes[0].layout, columns: '1fr; } body { display:none' } };

    const page = renderShellDocument(storefront, route, manifests, { runtimeSrc: RUNTIME });

    expect(page).not.toContain('display:none');
    expect(page).not.toContain('grid-template-columns');
  });

  it('refuses a runtime URL that could load from anywhere', () => {
    expect(() => renderShellDocument(storefront, storefront.routes[0], manifests, { runtimeSrc: 'http://cdn.example/core.js' })).toThrow(
      /runtimeSrc/,
    );
  });
});

describe('shellDocuments()', () => {
  const documentRequest = (path: string) =>
    new Request(`https://www.example${path}`, { headers: { 'sec-fetch-dest': 'document' } });

  async function setup(shells: ShellManifest[]) {
    const snapshot = await createSnapshot({ manifests, shells });
    const store = memorySnapshotStore([snapshot]);
    const registry = snapshotRegistry({ store });
    return { store, registry, documents: shellDocuments({ registry, runtimeSrc: RUNTIME }) };
  }

  it('answers a page a vanilla shell route matches, and nothing else', async () => {
    const { documents } = await setup([storefront]);

    const page = await documents(documentRequest('/billing/42'));
    expect(page!.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page!.text()).toContain('<fragment-slot name="billing"');

    expect(await documents(documentRequest('/about'))).toBeNull();
  });

  it('does not serve a route that claims the whole site unless the operator allows it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const everything = { ...storefront, id: 'everything', routes: [{ ...storefront.routes[0]!, path: '/*' }] };
    const snapshot = await createSnapshot({ manifests, shells: [everything] });
    const registry = snapshotRegistry({ store: memorySnapshotStore([snapshot]) });

    expect(await shellDocuments({ registry, runtimeSrc: RUNTIME })(documentRequest('/anything'))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('claims the whole site'));
    expect(await shellDocuments({ registry, runtimeSrc: RUNTIME, paths: ['/'] })(documentRequest('/anything'))).not.toBeNull();
    expect(await shellDocuments({ registry, runtimeSrc: RUNTIME, paths: ['/promo'] })(documentRequest('/anything'))).toBeNull();
    warn.mockRestore();
  });

  it('renders from the snapshot the gateway is serving, not one it refused to load', async () => {
    const good = await createSnapshot({ manifests, shells: [storefront] });
    // a snapshot written straight to the store, past validation: its fragment id cannot compile
    const broken = await createSnapshot({ manifests: [...manifests, { id: 'bad/id', endpoint: 'https://x.internal' }], shells: [] });
    const store = memorySnapshotStore([good, broken]);
    await store.setHead?.(good.id);
    const registry = snapshotRegistry({ store, verify: false });
    const gateway = createGateway({ mode: 'production', registry, documents: shellDocuments({ registry, runtimeSrc: RUNTIME }) });
    await gateway.refreshRegistry();

    await store.setHead?.(broken.id);
    await expect(gateway.refreshRegistry()).rejects.toThrow();

    // the gateway kept the good snapshot's fragments, so the page keeps the good snapshot's shell
    const response = await gateway.handle(documentRequest('/billing/1'));
    expect(await response!.text()).toContain('<fragment-slot name="billing"');
  });

  it('answers HEAD for a page it serves, without the body', async () => {
    const { documents } = await setup([storefront]);
    const gateway = createGateway({ mode: 'production', registry: [...manifests], documents });

    const response = await gateway.handle(new Request('https://www.example/billing/1', { method: 'HEAD' }));

    expect(response!.status).toBe(200);
    expect(response!.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response!.body).toBeNull();
  });

  it('leaves app-rendered shells to their apps', async () => {
    const { documents } = await setup([{ ...storefront, framework: 'react' }]);

    expect(await documents(documentRequest('/billing/42'))).toBeNull();
  });

  it('serves a shell published after the gateway started, on its next registry reload', async () => {
    const { store, registry, documents } = await setup([]);
    const gateway = createGateway({ mode: 'production', registry, documents });
    expect(await gateway.handle(documentRequest('/billing/1'))).toBeNull();

    const next = await createSnapshot({ manifests, shells: [storefront] });
    await store.put(next);
    await store.setHead?.(next.id);
    await gateway.refreshRegistry();

    // the gateway now answers the page itself; billing's fetch fails offline, so its slot is left
    // for the client, but the shell — title, grid, slots — is served with no app and no rebuild
    const response = await gateway.handle(documentRequest('/billing/1'));
    const body = await response!.text();
    expect(response!.status).toBe(200);
    expect(body).toContain('<title>Billing');
    expect(body).toContain('grid-template-areas');
    expect(body).toContain('<fragment-slot name="billing"');
  });
});
