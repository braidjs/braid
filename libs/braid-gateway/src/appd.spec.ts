import { describe, expect, it } from 'vitest';
import { createGateway } from './gateway.js';
import { normalizeManifest, type FragmentManifest } from './registry.js';
import { toAppdApplication } from './appd.js';
import { appdErrors } from '../../../tools/fdc3/validate-appd.js';

const ORIGIN = 'https://shell.example';

const project = (manifest: FragmentManifest) => toAppdApplication(normalizeManifest(manifest), ORIGIN);

const billing: FragmentManifest = {
  id: 'billing',
  endpoint: 'https://billing.internal',
  pierce: ['/billing', '/billing/*'],
  title: 'Billing',
  description: 'Invoices and payment methods.',
  tags: ['finance', 'core'],
};

describe('toAppdApplication', () => {
  it('projects the fields AppD needs from the registry it already has', () => {
    const application = project(billing);

    expect(application).toMatchObject({
      appId: 'billing',
      type: 'web',
      title: 'Billing',
      description: 'Invoices and payment methods.',
      categories: ['finance', 'core'],
    });
  });

  it('points details.url at a page the fragment actually appears on', () => {
    // an operator following the link should see the app, not a namespace path
    expect(project(billing).details.url).toBe('https://shell.example/billing');
  });

  it('strips a trailing wildcard rather than linking to a literal /*', () => {
    expect(project({ ...billing, pierce: ['/billing/*'] }).details.url).toBe('https://shell.example/billing');
  });

  it('skips a parameterized pattern, which names no particular page', () => {
    const application = project({ ...billing, pierce: ['/orders/:id'] });

    expect(application.details.url).toBe('https://shell.example/__braid/frag/billing/');
    expect(application.hostManifests.braid.standalonePage).toBe(false);
  });

  it('falls back to the mount when the fragment pierces nothing', () => {
    const application = project({ id: 'rating', endpoint: 'https://w.internal' });

    expect(application.details.url).toBe('https://shell.example/__braid/frag/rating/');
    expect(application.hostManifests.braid.standalonePage).toBe(false);
  });

  it('carries Braid launch detail in hostManifests, because a fragment is mounted not opened', () => {
    const application = project({ ...billing, adapter: 'custom-element', entry: '/w.js', element: 'star-rating' });

    expect(application.hostManifests.braid).toEqual({
      fragmentId: 'billing',
      mount: '/__braid/frag/billing/',
      adapter: 'custom-element',
      standalonePage: true,
    });
  });

  describe('interop', () => {
    it('projects intents keyed by name, with no name member of their own', () => {
      const application = project({
        ...billing,
        fdc3: {
          listensFor: { ViewOrderTicket: { contexts: ['fdc3.instrument'], displayName: 'View order ticket' } },
          raises: { ViewChart: ['fdc3.instrument'] },
        },
      });

      expect(application.interop?.intents?.listensFor?.['ViewOrderTicket']).toEqual({
        displayName: 'View order ticket',
        contexts: ['fdc3.instrument'],
      });
      expect(application.interop?.intents?.raises).toEqual({ ViewChart: ['fdc3.instrument'] });
    });

    it('defaults an intent with no declared contexts to an empty list, which the shape requires', () => {
      const application = project({ ...billing, fdc3: { listensFor: { StartCall: {} } } });

      expect(application.interop?.intents?.listensFor?.['StartCall']?.contexts).toEqual([]);
    });

    it('omits interop entirely when a fragment declares no FDC3 metadata', () => {
      expect(project(billing).interop).toBeUndefined();
    });

    it('omits interop when the fdc3 block carries only runtime members', () => {
      // apiVersion and contexts are for the runtime, not the directory
      expect(project({ ...billing, fdc3: { apiVersion: '2.2', contexts: { 'fdc3.instrument': 3 } } }).interop)
        .toBeUndefined();
    });

    it('projects user channel usage', () => {
      const application = project({
        ...billing,
        fdc3: { userChannels: { broadcasts: ['fdc3.instrument'], listensFor: ['fdc3.order'] } },
      });

      expect(application.interop?.userChannels).toEqual({
        broadcasts: ['fdc3.instrument'],
        listensFor: ['fdc3.order'],
      });
    });
  });

  it('carries descriptive appd metadata when a manifest supplies it', () => {
    const application = project({
      ...billing,
      appd: { publisher: 'Payments', contactEmail: 'pay@example.com', version: '3.1.0', icons: [{ src: '/i.png' }] },
    });

    expect(application).toMatchObject({
      publisher: 'Payments',
      contactEmail: 'pay@example.com',
      version: '3.1.0',
      // AppD requires an absolute url
      icons: [{ src: 'https://shell.example/i.png' }],
    });
  });

  describe('against the FDC3 2.2 App Directory schema', () => {
    const full: FragmentManifest = {
      ...billing,
      adapter: 'custom-element',
      entry: '/w.js',
      element: 'billing-app',
      fdc3: {
        apiVersion: '2.2',
        contexts: { 'fdc3.instrument': 2 },
        listensFor: {
          ViewInvoice: { contexts: ['fdc3.instrument'], displayName: 'View invoice', resultType: 'fdc3.invoice' },
          StartCall: {},
        },
        raises: { ViewChart: ['fdc3.instrument'] },
        defaultChannel: 'fdc3.channel.1',
        userChannels: { broadcasts: ['fdc3.instrument'], listensFor: ['fdc3.order'] },
      },
      appd: {
        publisher: 'Payments',
        contactEmail: 'pay@example.com',
        supportEmail: 'help@example.com',
        moreInfo: 'https://docs.example/billing',
        version: '3.1.0',
        tooltip: 'Invoices',
        icons: [{ src: '/i.png', size: '64x64', type: 'image/png' }, { src: 'https://cdn.example/i.svg' }],
      },
    };

    it.each([
      ['a bare manifest', { id: 'rating', endpoint: 'https://w.internal' }],
      ['a described manifest', billing],
      ['a manifest with full fdc3 and appd blocks', full],
    ] as const)('produces a valid Application from %s', (_, manifest) => {
      expect(appdErrors('Application', project(manifest))).toEqual([]);
    });

    it('is a real check: the schema refuses a record without a title or with a relative icon', () => {
      const { title: _title, ...untitled } = project(billing);

      expect(appdErrors('Application', untitled)).not.toEqual([]);
      expect(appdErrors('Application', { ...project(billing), icons: [{ src: '/i.png' }] })).not.toEqual([]);
    });

    it('sets neither the deprecated application name nor a name on any intent', () => {
      const application = project(full);

      expect(application).not.toHaveProperty('name');
      for (const intent of Object.values(application.interop?.intents?.listensFor ?? {})) {
        expect(intent).not.toHaveProperty('name');
      }
    });
  });
});

describe('the App Directory endpoint', () => {
  const registry: FragmentManifest[] = [
    billing,
    { id: 'payroll', endpoint: 'https://p.internal', title: 'Payroll', access: { list: { roles: ['hr'] } } },
  ];

  const gateway = (principalRoles?: string[]) =>
    createGateway({
      mode: 'production',
      registry,
      discovery: { appd: true },
      ...(principalRoles ? { principal: () => ({ roles: principalRoles }) } : {}),
    });

  const get = (path: string, roles?: string[]) =>
    gateway(roles).handle(new Request(`${ORIGIN}${path}`));

  it('serves the listing in AppD shape', async () => {
    const response = await get('/__braid/registry/appd/v2/apps');
    const body = await response!.json();

    expect(response!.status).toBe(200);
    expect(appdErrors('AllApplicationsResponse', body)).toEqual([]);
    expect(body.message).toBe('OK');
    expect(body.applications.map((a: { appId: string }) => a.appId)).toEqual(['billing']);
  });

  it('serves a single application by appId as the bare record, as the spec has it', async () => {
    const response = await get('/__braid/registry/appd/v2/apps/billing');
    const body = await response!.json();

    expect(response!.status).toBe(200);
    expect(body.appId).toBe('billing');
    expect(body).not.toHaveProperty('application');
    expect(appdErrors('Application', body)).toEqual([]);
  });

  it('applies the same access.list rules as discovery', async () => {
    const anonymous = await (await get('/__braid/registry/appd/v2/apps'))!.json();
    const hr = await (await get('/__braid/registry/appd/v2/apps', ['hr']))!.json();

    expect(anonymous.applications.map((a: { appId: string }) => a.appId)).toEqual(['billing']);
    expect(hr.applications.map((a: { appId: string }) => a.appId)).toEqual(['billing', 'payroll']);
  });

  it('404s an app the caller may not list, exactly as it 404s an unknown one', async () => {
    // distinguishing them would let an unauthorized caller enumerate the registry one id at a time
    const hidden = await get('/__braid/registry/appd/v2/apps/payroll');
    const missing = await get('/__braid/registry/appd/v2/apps/nope');

    expect(hidden!.status).toBe(404);
    expect(missing!.status).toBe(404);
    // AppD's ErrorDTO, and the same body either way
    expect(await hidden!.json()).toEqual({ code: 404, message: 'No application with appId "payroll"' });
    expect(await missing!.json()).toEqual({ code: 404, message: 'No application with appId "nope"' });
    expect(appdErrors('ErrorDTO', { code: 404, message: 'x' })).toEqual([]);
  });

  it('404s a malformed escape rather than throwing', async () => {
    expect((await get('/__braid/registry/appd/v2/apps/%E0%A4%A'))!.status).toBe(404);
  });

  it('is off unless asked for', async () => {
    const withoutAppd = createGateway({ mode: 'production', registry, discovery: {} });

    expect(await withoutAppd.handle(new Request(`${ORIGIN}/__braid/registry/appd/v2/apps`))).toBeNull();
  });

  it('is off when discovery itself is off', async () => {
    const noDiscovery = createGateway({ mode: 'production', registry });

    expect(await noDiscovery.handle(new Request(`${ORIGIN}/__braid/registry/appd/v2/apps`))).toBeNull();
  });

  it('never lands in a shared cache — the listing depends on who asked', async () => {
    const response = await get('/__braid/registry/appd/v2/apps');

    expect(response!.headers.get('cache-control')).toBe('no-store');
    expect(response!.headers.get('vary')).toContain('cookie');
  });

  it('builds absolute urls from the request origin', async () => {
    const body = await (await get('/__braid/registry/appd/v2/apps'))!.json();

    expect(body.applications[0].details.url.startsWith(ORIGIN)).toBe(true);
  });

  it('rejects a write', async () => {
    const response = await gateway().handle(
      new Request(`${ORIGIN}/__braid/registry/appd/v2/apps`, { method: 'POST' }),
    );

    expect(response!.status).toBe(405);
  });
});
