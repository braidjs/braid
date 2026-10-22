import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RegistryPermissions } from '@braidlabs/registry';
import { HistoryPanel } from './history-panel.js';
import type { EnvironmentState } from './client.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const items = [
  { id: 'reg_b', createdAt: '2026-10-22T10:00:00Z', fragmentCount: 2 },
  { id: 'reg_a', createdAt: '2026-10-21T10:00:00Z', fragmentCount: 2 },
];

function server(environments: EnvironmentState[], permissions: RegistryPermissions) {
  const calls: { method: string; path: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'https://x.example').pathname.replace('/__braid/registry-api', '');
    const method = init.method ?? 'GET';
    calls.push({ method, path });
    if (path === '/snapshots') return json({ items, head: 'reg_b' });
    if (path === '/permissions') return json(permissions);
    if (path === '/environments') return json({ items: environments });
    if (method === 'POST') return json({}, 200);
    return json({ error: 'no route' }, 404);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

const staging: EnvironmentState = { name: 'staging', from: null, approvals: 0, id: 'reg_b', pending: null };
const production: EnvironmentState = { name: 'production', from: 'staging', approvals: 1, id: 'reg_a', pending: null };
const rights = (promote: boolean, approve: boolean) => ({ promote, approve });

describe('<HistoryPanel> environments', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(api: { fetch: typeof fetch }) {
    await act(async () => root.render(<HistoryPanel api={api} />));
    await act(async () => undefined);
  }

  const byLabel = (label: string) => container.querySelector(`button[aria-label="${label}"]`);
  const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

  it('badges each snapshot with the environments it is in, and offers to promote along the pipeline', async () => {
    await render(
      server([staging, production], {
        read: true,
        publish: true,
        pin: true,
        actor: 'ada',
        tags: null,
        environments: { staging: rights(true, false), production: rights(true, false) },
      }),
    );

    expect(container.textContent).toContain('staging');
    expect(container.textContent).toContain('production');
    // reg_b is what staging holds, so it — and only it — can go to production
    expect(byLabel('Promote reg_b to production')).not.toBeNull();
    expect(byLabel('Promote reg_a to production')).toBeNull();
    // reg_a can go to staging, which has no source
    expect(byLabel('Promote reg_a to staging')).not.toBeNull();
  });

  it('shows a pending promotion, with Approve for someone else and Withdraw for the requester', async () => {
    const pending = { id: 'reg_b', base: 'reg_a', requestedBy: 'ada', requestedAt: '2026-10-22T11:00:00Z' };
    const approverApi = server([staging, { ...production, pending }], {
      read: true,
      publish: false,
      pin: false,
      actor: 'grace',
      tags: null,
      environments: { staging: rights(false, false), production: rights(false, true) },
    });
    await render(approverApi);

    expect(container.textContent).toContain('ada asked to promote');
    expect(byLabel('Promote reg_b to production')).toBeNull();
    await act(async () => button('Approve')!.click());
    expect(approverApi.calls).toContainEqual({ method: 'POST', path: '/environments/production/approve' });

    act(() => root.unmount());
    root = createRoot(container);
    await render(
      server([staging, { ...production, pending }], {
        read: true,
        publish: true,
        pin: true,
        actor: 'ada',
        tags: null,
        environments: { staging: rights(true, false), production: rights(true, true) },
      }),
    );
    expect(button('Approve')).toBeUndefined();
    expect(button('Withdraw')).toBeDefined();
  });

  it('shows nothing about environments when the registry has none', async () => {
    const api = server([], { read: true, publish: true, pin: true, actor: null, tags: null });
    await render(api);

    expect(container.textContent).not.toContain('Promote');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  });
});
