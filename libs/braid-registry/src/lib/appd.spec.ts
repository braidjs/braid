import { describe, expect, it } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createRegistryApi, type RegistryApiOptions } from './api.js';
import { memorySnapshotStore } from './store.js';
import { createSnapshot } from './snapshot.js';
import { appdErrors } from '../../../../tools/fdc3/validate-appd.js';

const BASE = 'https://ops.example/__braid/registry-api';
const SHELL = 'https://portal.example';

const billing: FragmentManifest = {
  id: 'billing',
  endpoint: 'https://billing.internal',
  pierce: ['/billing/*'],
  title: 'Billing',
  tags: ['finance'],
  fdc3: { listensFor: { ViewInvoice: { contexts: ['fdc3.instrument'] } } },
  appd: { publisher: 'Payments', icons: [{ src: '/billing.png' }] },
};
const payroll: FragmentManifest = {
  id: 'payroll',
  endpoint: 'https://payroll.internal',
  title: 'Payroll',
  access: { list: { roles: ['hr'] } },
};

async function setup(options: Partial<RegistryApiOptions> = {}) {
  const released = await createSnapshot({ manifests: [billing] });
  const draft = await createSnapshot({ manifests: [billing, payroll] });
  const store = memorySnapshotStore([released, draft]);
  await store.setHead?.(draft.id);
  await store.setRef?.('production', released.id);
  const api = createRegistryApi({ store, appd: { origin: SHELL }, ...options });
  const get = (path: string, headers?: HeadersInit) => api.handle(new Request(`${BASE}${path}`, { headers }));
  return { api, store, get };
}

const ids = (body: { applications: { appId: string }[] }) => body.applications.map((app) => app.appId);

describe('the registry as an FDC3 App Directory', () => {
  it('lists HEAD as a schema-valid AllApplicationsResponse, with urls on the shell origin', async () => {
    const { get } = await setup();
    const response = (await get('/appd/v2/apps'))!;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(appdErrors('AllApplicationsResponse', body)).toEqual([]);
    // the registry is a governance view, not a per-user one: `read` already returns every manifest
    expect(ids(body)).toEqual(['billing', 'payroll']);
    expect(body.applications[0].details.url).toBe(`${SHELL}/billing`);
    expect(body.applications[0].icons[0].src).toBe(`${SHELL}/billing.png`);
    expect(body.applications[0].interop.intents.listensFor.ViewInvoice.contexts).toEqual(['fdc3.instrument']);
  });

  it('serves one application as the bare record', async () => {
    const { get } = await setup();
    const response = (await get('/appd/v2/apps/billing'))!;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.appId).toBe('billing');
    expect(appdErrors('Application', body)).toEqual([]);
  });

  it('404s an unknown app with an ErrorDTO', async () => {
    const { get } = await setup();
    const response = (await get('/appd/v2/apps/nope'))!;

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 404, message: 'No application with appId "nope"' });
  });

  it('serves an environment’s pin rather than HEAD when told to', async () => {
    const { get } = await setup({
      environments: [{ name: 'production' }],
      appd: { origin: SHELL, environment: 'production' },
    });

    // HEAD has payroll; production was never promoted past billing
    expect(ids(await (await get('/appd/v2/apps'))!.json())).toEqual(['billing']);
    expect((await get('/appd/v2/apps/payroll'))!.status).toBe(404);
  });

  it('serves an empty directory when nothing is published', async () => {
    const api = createRegistryApi({ store: memorySnapshotStore(), appd: { origin: SHELL } });
    const response = (await api.handle(new Request(`${BASE}/appd/v2/apps`)))!;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applications: [], message: 'OK' });
  });

  it('is the read right: refused reads get a 403 ErrorDTO', async () => {
    const { get } = await setup({ authorize: (request) => request.headers.get('x-read') === 'yes' });

    const refused = (await get('/appd/v2/apps'))!;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: 403, message: 'not authorized to read' });
    expect((await get('/appd/v2/apps', { 'x-read': 'yes' }))!.status).toBe(200);
  });

  it('passes an authorize hook’s own response through, e.g. a bearer challenge', async () => {
    const challenge = new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
    const { get } = await setup({ authorize: () => challenge });

    expect(await get('/appd/v2/apps')).toBe(challenge);
  });

  it('is off unless configured', async () => {
    const api = createRegistryApi({ store: memorySnapshotStore() });

    expect((await api.handle(new Request(`${BASE}/appd/v2/apps`)))!.status).toBe(404);
  });

  it('refuses at startup an origin that is not one, or an environment that is not configured', () => {
    expect(() => createRegistryApi({ store: memorySnapshotStore(), appd: { origin: 'portal.example' } })).toThrow(/appd.origin/);
    expect(() => createRegistryApi({ store: memorySnapshotStore(), appd: { origin: `${SHELL}/apps` } })).toThrow(/appd.origin/);
    expect(() => createRegistryApi({ store: memorySnapshotStore(), appd: { origin: SHELL, environment: 'production' } })).toThrow(
      /appd.environment/,
    );
  });

  it('asks for the directory alone, so it can be opened without opening /head', async () => {
    const { get } = await setup({
      authorize: (request, action, context) => action === 'read' && context?.resource === 'directory',
    });

    expect((await get('/appd/v2/apps'))!.status).toBe(200);
    expect((await get('/head'))!.status).toBe(403);
  });
});
