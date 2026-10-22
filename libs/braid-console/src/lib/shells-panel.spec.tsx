import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FragmentManifest } from '@braidlabs/gateway';
import type { RegistryPermissions, ShellManifest } from '@braidlabs/registry';
import { newShell, ShellsPanel } from './shells-panel.js';
import { HistoryPanel } from './history-panel.js';
import { tagClass } from './tags.js';

const manifests: FragmentManifest[] = [
  { id: 'billing', endpoint: 'https://b.internal', pierce: ['/billing/*'], tags: ['finance'] },
  { id: 'reviews', endpoint: 'https://r.internal', pierce: ['/billing/*'] },
];

const storefront: ShellManifest = {
  id: 'storefront',
  framework: 'react',
  tags: ['core'],
  routes: [{ path: '/billing/*', layout: { areas: 'header header\nnav main' }, slots: { main: 'billing' } }],
};

const EDITOR: RegistryPermissions = { read: true, publish: true, pin: true, actor: 'dana@example.com' };
const VIEWER: RegistryPermissions = { read: true, publish: false, pin: false, actor: 'viewer@example.com' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Server {
  head?: { id: string | null; snapshot: unknown } | Response;
  permissions?: RegistryPermissions | Response;
  publish?: (body: Record<string, unknown>) => Response;
}

function server({ head, permissions = EDITOR, publish }: Server) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'https://x.example').pathname.replace('/__braid/registry-api', '');
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });

    if (path === '/head') return head instanceof Response ? head : json(head ?? { id: 'reg_a', snapshot: { id: 'reg_a', createdAt: '', manifests, shells: [storefront] } });
    if (path === '/permissions') return permissions instanceof Response ? permissions : json(permissions);
    if (path === '/snapshots' && method === 'POST') {
      return publish ? publish(body ?? {}) : json({ snapshot: { id: 'reg_b', createdAt: '', fragmentCount: 2 }, findings: [], descriptorNotes: [], pinned: body?.['pin'] !== false }, 201);
    }
    if (path === '/snapshots') return json({ items: [], head: null });
    return json({ error: 'no route' }, 404);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

describe('<ShellsPanel>', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.getElementById('braid-console-styles')?.remove();
  });

  async function render(api: { fetch: typeof fetch }, props: Partial<Parameters<typeof ShellsPanel>[0]> = {}) {
    await act(async () => root.render(<ShellsPanel api={api} {...props} />));
  }

  const button = (name: string | RegExp) =>
    [...container.querySelectorAll('button')].find((el) => (typeof name === 'string' ? el.textContent?.trim() === name : name.test(el.textContent ?? '')));

  async function click(el: Element | undefined | null) {
    expect(el).toBeTruthy();
    await act(async () => (el as HTMLElement).click());
  }

  async function type(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
    expect(el).toBeTruthy();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el!.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function choose(select: HTMLSelectElement | null, value: string) {
    expect(select).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  const areaNames = () => [...container.querySelectorAll('.braid-console__area .braid-console__areaname')].map((el) => el.textContent);
  const textarea = () => container.querySelector<HTMLTextAreaElement>('.braid-console__ascii');
  const fieldInput = (label: string, nth = 0) =>
    [...container.querySelectorAll<HTMLLabelElement>('label.braid-console__field')]
      .filter((el) => el.querySelector('.braid-console__fieldlabel')?.textContent === label)
      [nth]?.querySelector<HTMLInputElement>('input') ?? null;

  it('lists the pinned shells with their tags and routes', async () => {
    await render(server({}));

    expect(container.textContent).toContain('storefront');
    expect(container.textContent).toContain('/billing/*');
    expect(container.querySelector('button[aria-label="Filter by tag core"]')).toBeTruthy();
  });

  it('redraws the grid preview as the ASCII layout is typed', async () => {
    await render(server({}));
    await click(button('Edit'));

    expect(areaNames()).toEqual(['header', 'nav', 'main']);

    await type(textarea(), 'header header\nnav main\nfooter footer');
    expect(areaNames()).toEqual(['header', 'nav', 'main', 'footer']);
    expect(container.querySelector<HTMLElement>('.braid-console__gridpreview')?.style.gridTemplateAreas).toContain('"footer footer"');
  });

  it('shows an error for an L-shaped area and refuses to publish', async () => {
    await render(server({}));
    await click(button('Edit'));
    await type(textarea(), 'nav main\nnav nav');

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('"nav" is not a rectangle');
    expect(container.querySelector('.braid-console__gridpreview')).toBeNull();
    expect(button('Publish & pin')?.disabled).toBe(true);
  });

  it('slots a fragment into the area chosen in the preview', async () => {
    await render(server({}));
    await click(button('Edit'));
    await click(container.querySelector('button[aria-label^="Area nav"]'));

    const select = [...container.querySelectorAll<HTMLSelectElement>('select')].find((el) => el.closest('label')?.textContent?.includes('Fragment in'));
    await choose(select ?? null, 'reviews');

    expect(container.querySelector('button[aria-label="Area nav, holds reviews"]')).toBeTruthy();
  });

  it('refuses a javascript: script URL and never puts the shell head into the page', async () => {
    const before = document.querySelectorAll('script, link').length;
    await render(server({}));
    await click(button('Edit'));
    await click(button('Head & assets'));
    await click(button('+ Script'));
    await type(fieldInput('Script URL'), 'javascript:alert(1)');
    await click(button('+ Stylesheet'));
    await type(fieldInput('Stylesheet URL'), 'https://cdn.example.com/theme.css');

    expect(container.textContent).toContain('unsafe-shell-url');
    expect(button('Publish & pin')?.disabled).toBe(true);
    expect(document.querySelectorAll('script, link').length).toBe(before);
  });

  it('switches the generated code with the framework tab', async () => {
    await render(server({}));
    await click(button('Edit'));
    await click(button('Code'));

    expect(container.querySelector('pre')?.textContent).toContain("from '@braidlabs/react'");
    await click(button('Angular SSR'));
    expect(container.textContent).toContain('server.ts');
    expect(container.textContent).toContain('toNodeMiddleware(gateway)');
  });

  it('publishes the pinned fragments unchanged with the edited shells and the base id', async () => {
    const api = server({});
    await render(api);
    await click(button('New shell'));
    await click(button('Publish & pin'));

    const post = api.calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ manifests, baseId: 'reg_a', pin: true });
    expect((post?.body?.['shells'] as ShellManifest[]).map((shell) => shell.id)).toEqual(['storefront', 'new-shell']);
    expect(container.textContent).toContain('Published reg_b and pinned');
  });

  it('deletes a shell by publishing without it', async () => {
    const api = server({});
    await render(api);
    await click(container.querySelector('button[aria-label="Delete storefront"]'));
    await click(button('Publish & pin'));

    expect(api.calls.find((call) => call.method === 'POST')?.body?.['shells']).toEqual([]);
  });

  it('offers a reload instead of overwriting when someone published first', async () => {
    await render(server({ publish: () => json({ error: 'HEAD moved', head: 'reg_z' }, 409) }));
    await click(button('New shell'));
    await click(button('Publish & pin'));

    expect(container.textContent).toContain('Someone published since you started');
    expect(button(/Reload pinned/)).toBeTruthy();
  });

  it('publishes a candidate when the role may publish but not pin', async () => {
    const api = server({ permissions: { ...EDITOR, pin: false } });
    await render(api);
    await click(button('New shell'));
    await click(button('Publish as candidate'));

    expect(api.calls.find((call) => call.method === 'POST')?.body?.['pin']).toBe(false);
  });

  it('shows a viewer the shells but no way to change them', async () => {
    await render(server({ permissions: VIEWER }));

    expect(button('New shell')).toBeUndefined();
    expect(container.querySelector('button[aria-label="Delete storefront"]')).toBeNull();
    await click(button('View'));
    expect(container.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true);
  });

  it('explains a missing registry API instead of failing', async () => {
    await render(server({ head: json({ error: 'no route' }, 404) }));

    expect(container.textContent).toContain('The registry API is not mounted');
    expect(container.querySelector('.braid-console__error')).toBeNull();
  });

  it('asks a signed-out caller to sign in', async () => {
    await render(server({ head: json({ error: 'token' }, 401) }));

    expect(container.textContent).toContain('Sign in to see shells');
  });

  it('tells a caller whose role cannot read why', async () => {
    await render(server({ head: json({ error: 'no' }, 403) }));

    expect(container.textContent).toContain('Your role cannot read shells');
  });

  it('invites the first shell into an empty store', async () => {
    await render(server({ head: { id: null, snapshot: null } }));

    expect(container.textContent).toContain('No shells yet');
    await click(button('Create your first shell'));
    expect(textarea()).toBeTruthy();
  });

  const twoShells = {
    id: 'reg_a',
    snapshot: { id: 'reg_a', createdAt: '', manifests, shells: [{ ...storefront, id: 'admin', routes: [{ path: '/admin', layout: { areas: 'only' } }] }, storefront] },
  };

  it('stays on the shell being renamed, even onto another shell\u2019s id', async () => {
    const onSelect = vi.fn();
    await render(server({ head: twoShells }), { selected: 'storefront', onSelect });

    await type(fieldInput('Id'), 'store');
    expect(onSelect).toHaveBeenLastCalledWith('store');
    await act(async () => root.render(<ShellsPanel api={server({ head: twoShells })} selected="store" onSelect={onSelect} />));
    expect(textarea()?.value).toBe('header header\nnav main');

    await type(fieldInput('Id'), 'admin');
    await act(async () => root.render(<ShellsPanel api={server({ head: twoShells })} selected="admin" onSelect={onSelect} />));
    expect(textarea()?.value).toBe('header header\nnav main');
    expect(container.textContent).toContain('duplicate-shell-id');
    expect(button('Publish & pin')?.disabled).toBe(true);
  });

  it('keeps the designer open while the id is cleared to retype it', async () => {
    const onSelect = vi.fn();
    await render(server({}), { selected: 'storefront', onSelect });

    await type(fieldInput('Id'), '');

    expect(onSelect).not.toHaveBeenCalledWith('');
    expect(textarea()).toBeTruthy();
  });

  it('keeps the base after a candidate publish, so the next one is still checked against HEAD', async () => {
    const api = server({ permissions: { ...EDITOR, pin: false } });
    await render(api);
    await click(button('New shell'));
    await click(button('Publish as candidate'));
    expect(container.textContent).toContain('as a candidate, not pinned');
    await click(button('← Shells'));
    await click(button('New shell'));
    await click(button('Publish as candidate'));

    expect(api.calls.filter((call) => call.method === 'POST').map((call) => call.body?.['baseId'])).toEqual(['reg_a', 'reg_a']);
  });

  it('moves the base to the new snapshot after a pinned publish', async () => {
    const api = server({});
    await render(api);
    await click(button('New shell'));
    await click(button('Publish & pin'));
    await click(button('← Shells'));
    await click(button('New shell'));
    await click(button('Publish & pin'));

    expect(api.calls.filter((call) => call.method === 'POST').map((call) => call.body?.['baseId'])).toEqual(['reg_a', 'reg_b']);
  });

  it('keeps edits typed while a publish is in flight', async () => {
    let answer: (response: Response) => void = () => undefined;
    const api = server({ publish: () => json({}, 500) });
    const fetchMock = api.fetch as unknown as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) =>
      init.method === 'POST' ? new Promise<Response>((resolve) => (answer = resolve)) : original(url, init),
    );
    await render(api);
    await click(button('Edit'));
    await type(fieldInput('Title'), 'Before');
    await act(async () => button('Publish & pin')!.click());
    await type(fieldInput('Title'), 'Typed during publish');
    await act(async () => answer(json({ snapshot: { id: 'reg_b', createdAt: '', fragmentCount: 2 }, findings: [], descriptorNotes: [], pinned: true }, 201)));

    expect(fieldInput('Title')?.value).toBe('Typed during publish');
    expect(button('Discard')?.disabled).toBe(false);
  });

  it('edits the route shown after Discard removes the one that was selected', async () => {
    await render(server({}));
    await click(button('Edit'));
    await click(button('+ Route'));
    await click(button('Discard'));
    await type(fieldInput('Path'), '/checkout/*');

    expect(container.querySelector('.braid-console__routebutton')?.textContent).toBe('/checkout/*');
  });

  it('reloads HEAD when refreshKey changes, unless there is a draft', async () => {
    const api = server({});
    const heads = () => api.calls.filter((call) => call.path === '/head').length;
    await act(async () => root.render(<ShellsPanel api={api} refreshKey={0} />));
    expect(heads()).toBe(1);

    await act(async () => root.render(<ShellsPanel api={api} refreshKey={1} />));
    expect(heads()).toBe(2);

    await click(button('New shell'));
    await act(async () => root.render(<ShellsPanel api={api} refreshKey={2} />));
    expect(heads()).toBe(2);
    expect(textarea()).toBeTruthy();
  });

  it('reports unpublished changes to the host', async () => {
    const onDirtyChange = vi.fn();
    await render(server({}), { onDirtyChange });
    await click(button('New shell'));

    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await click(button('Discard'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('shows tag chips in the list and the designer with the same colors as everywhere else', async () => {
    await render(server({}));
    expect(container.querySelector('button[aria-label="Filter by tag core"]')?.className).toBe(`${tagClass('core')} braid-console__tagbutton`);

    await click(button('Edit'));
    expect(container.querySelector('.braid-console__tagrow .braid-console__tag')?.className).toBe(tagClass('core'));
  });

  it('follows a host-controlled selection by id', async () => {
    const onSelect = vi.fn();
    await render(server({}), { selected: 'storefront', onSelect });

    expect(textarea()?.value).toBe('header header\nnav main');
    await click(button('← Shells'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});

describe('<HistoryPanel>', () => {
  it('lists snapshots with who published them, and pins an older one', async () => {
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url, 'https://x.example').pathname.replace('/__braid/registry-api', '');
      calls.push(`${init.method ?? 'GET'} ${path}`);
      if (path === '/permissions') return json(EDITOR);
      if (path === '/head') return json({ id: 'reg_old', pinned: true });
      return json({
        head: 'reg_new',
        items: [
          { id: 'reg_new', createdAt: '2026-10-21T10:00:00Z', fragmentCount: 2, labels: { publishedBy: 'dana@example.com' } },
          { id: 'reg_old', createdAt: '2026-10-20T10:00:00Z', fragmentCount: 2 },
        ],
      });
    });

    await act(async () => root.render(<HistoryPanel api={{ fetch: fetchMock as unknown as typeof fetch }} />));

    expect(container.textContent).toContain('dana@example.com');
    expect(container.textContent).toContain('not recorded');
    expect(container.querySelector('button[aria-label="Pin reg_new (roll back to it)"]')).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Pin reg_old (roll back to it)"]')?.click());
    expect(calls).toContain('POST /head');

    act(() => root.unmount());
    container.remove();
  });
});

describe('newShell()', () => {
  it('gives each new shell a route of its own, so two never claim one page', () => {
    const first = newShell([]);
    const second = newShell([first]);
    const clashing = newShell([{ ...first, id: 'other', routes: [{ path: '/new-shell-2', layout: { areas: 'main' } }] }, first]);

    expect(first.routes[0]!.path).toBe('/new-shell');
    expect(second.routes[0]!.path).toBe('/new-shell-2');
    expect(clashing.routes[0]!.path).toBe('/new-shell-3');
  });
});
