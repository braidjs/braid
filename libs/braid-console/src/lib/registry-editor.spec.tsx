import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FragmentManifest } from '@braidlabs/gateway';
import { RegistryEditor } from './registry-editor.js';

const manifests: FragmentManifest[] = [
  { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'], title: 'Billing' },
];

const owned: FragmentManifest[] = [
  { id: 'billing', endpoint: 'https://billing.internal', tags: ['finance'] },
  { id: 'reviews', endpoint: 'https://reviews.internal', tags: ['react'] },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake API: GET /head serves a pinned snapshot, POST /snapshots publishes. */
function fakeApi(over: { publish?: () => Response; permissions?: unknown } = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];

  const doFetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (url.endsWith('/permissions') && method === 'GET') {
      return json(over.permissions ?? { read: true, publish: true, pin: true, actor: null, tags: null });
    }
    if (url.endsWith('/head') && method === 'GET') {
      return json({ id: 'reg_base', snapshot: { id: 'reg_base', createdAt: '2026-01-01', manifests } });
    }
    if (url.endsWith('/snapshots') && method === 'POST') {
      return (
        over.publish?.() ??
        json(
          {
            snapshot: { id: 'reg_new', createdAt: '2026-08-14', fragmentCount: 1 },
            findings: [],
            descriptorNotes: [],
            pinned: true,
          },
          201,
        )
      );
    }
    return json({ error: 'unexpected' }, 404);
  });

  return { fetch: doFetch as unknown as typeof fetch, calls };
}

describe('<RegistryEditor>', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.getElementById('braid-console-styles')?.remove();
  });

  async function render(api: { fetch: typeof fetch }) {
    await act(async () => {
      root.render(<RegistryEditor api={api} />);
    });
  }

  /** By visible text. */
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label);

  /** By accessible name, for icon-ish buttons whose text is not unique. */
  const byLabel = (label: string) =>
    [...container.querySelectorAll('button')].find((element) => element.getAttribute('aria-label') === label);

  const isDisabled = (label: string) => button(label)?.hasAttribute('disabled') ?? null;

  const click = async (element: Element | undefined) => {
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  it('branches from the pinned snapshot', async () => {
    const api = fakeApi();
    await render(api);

    expect(container.textContent).toContain('reg_base');
    expect(container.textContent).toContain('billing');
  });

  it('starts with publish disabled, because nothing has changed', async () => {
    await render(fakeApi());

    expect(isDisabled('Publish')).toBe(true);
    expect(container.textContent).toContain('No changes');
  });

  it('enables publish once something changes', async () => {
    await render(fakeApi());
    await click(button('Add fragment'));

    // the new fragment has a blank endpoint, so it is changed *and* invalid
    expect(container.textContent).toContain('cannot publish');
    expect(isDisabled('Publish')).toBe(true);
  });

  it('refuses to publish a draft with errors, without contacting the server', async () => {
    const api = fakeApi();
    await render(api);
    await click(button('Add fragment'));
    await click(button('Publish'));

    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('publishes a valid change and reports the new snapshot', async () => {
    const api = fakeApi();
    await render(api);

    await click(byLabel('Remove billing'));
    await click(button('Publish'));

    const published = api.calls.find((call) => call.method === 'POST');
    expect(published?.body).toMatchObject({ manifests: [] });
    expect(container.textContent).toContain('reg_new');
    expect(container.textContent).toContain('now pinned');
  });

  it('re-bases after publishing, so the same content is not offered again', async () => {
    const api = fakeApi();
    await render(api);
    await click(byLabel('Remove billing'));
    await click(button('Publish'));

    expect(container.textContent).toContain('No changes');
    expect(isDisabled('Publish')).toBe(true);
  });

  it('discards edits back to the pinned snapshot', async () => {
    await render(fakeApi());
    await click(byLabel('Remove billing'));
    expect(container.textContent).not.toContain('billing');

    await click(button('Discard'));

    expect(container.textContent).toContain('billing');
    expect(container.textContent).toContain('No changes');
  });

  it('shows what the draft changes, labelled by owner', async () => {
    await render(fakeApi());
    await click(byLabel('Remove billing'));
    await click(button('Show changes'));

    expect(container.querySelector('.braid-console__diff')?.textContent).toContain('billing');
  });

  it('surfaces server-side findings when the server refuses', async () => {
    const api = fakeApi({
      publish: () =>
        json(
          {
            error: 'the registry has errors and was not published',
            findings: [{ severity: 'error', code: 'duplicate-id', message: 'server says no', fragmentIds: ['billing'] }],
          },
          422,
        ),
    });
    await render(api);
    await click(byLabel('Remove billing'));
    await click(button('Publish'));

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('was not published');
    expect(alert?.textContent).toContain('server says no');
  });

  it('reports an authorization refusal in the server’s own words', async () => {
    const api = fakeApi({ publish: () => json({ error: 'not authorized to publish' }, 403) });
    await render(api);
    await click(byLabel('Remove billing'));
    await click(button('Publish'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('not authorized to publish');
  });

  it('marks gateway-owned fields in the editor', async () => {
    await render(fakeApi());
    await click(container.querySelector('.braid-console__disclose'));

    const owners = [...container.querySelectorAll('.braid-console__owner')].map((element) => element.textContent);
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.every((text) => text === 'gateway')).toBe(true);
  });

  describe('access preview', () => {
    /** A pinned snapshot where anonymous can list billing, so tightening it is a loss. */
    function apiWithAccess() {
      const doFetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/head')) {
          return json({ id: 'reg_base', snapshot: { id: 'reg_base', createdAt: '2026-01-01', manifests } });
        }
        return json({ snapshot: { id: 'reg_new', createdAt: 'x', fragmentCount: 1 }, findings: [], descriptorNotes: [], pinned: true }, 201);
      });
      return { fetch: doFetch as unknown as typeof fetch };
    }

    it('says nothing about access when a change does not touch it', async () => {
      await render(apiWithAccess());
      await click(button('Show access'));

      expect(container.querySelector('.braid-console__access')?.textContent).toContain('changes nobody');
    });

    it('warns in the publish bar when a change removes access, without opening the panel', async () => {
      await render(apiWithAccess());
      await click(byLabel('Remove billing'));

      // the finding is surfaced whether or not anyone pressed the toggle
      expect(container.querySelector('.braid-console__bar')?.textContent).toContain('access loss');
    });

    it('names who lost what', async () => {
      await render(apiWithAccess());
      await click(byLabel('Remove billing'));
      await click(button('Show access'));

      const alert = container.querySelector('.braid-console__access [role="alert"]');
      expect(alert?.textContent).toContain('anonymous');
      expect(alert?.textContent).toContain('billing');
      expect(alert?.textContent).toContain('fragment removed');
    });

    it('always shows anonymous as a column', async () => {
      await render(apiWithAccess());
      await click(button('Show access'));

      const headers = [...container.querySelectorAll('.braid-console__matrix th')].map((h) => h.textContent);
      expect(headers.some((text) => text?.includes('anonymous'))).toBe(true);
    });

    it('adds a principal to test as', async () => {
      await render(apiWithAccess());
      await click(button('Show access'));

      const input = container.querySelector('.braid-console__access input') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'trader:roles=trader');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await click(button('Test as'));

      const headers = [...container.querySelectorAll('.braid-console__matrix th')].map((h) => h.textContent);
      expect(headers.some((text) => text?.includes('trader'))).toBe(true);
    });

    it('labels every outcome for readers who cannot see colour', async () => {
      await render(apiWithAccess());
      await click(button('Show access'));

      const marks = [...container.querySelectorAll('.braid-console__mark')];
      expect(marks.length).toBeGreaterThan(0);
      expect(marks.every((mark) => /allowed|denied|not present/.test(mark.textContent ?? ''))).toBe(true);
    });

    it('does not crash on a half-written fragment', async () => {
      await render(apiWithAccess());
      await click(button('Add fragment'));
      await click(button('Show access'));

      expect(container.querySelector('.braid-console__matrix')).not.toBeNull();
    });
  });

  it('reports a failure to load rather than showing an empty editor', async () => {
    const doFetch = vi.fn(async () => json({ error: 'not authorized to read' }, 403));
    await render({ fetch: doFetch as unknown as typeof fetch });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('not authorized to read');
  });

  it('offers editing only on fragments carrying a tag the caller owns', async () => {
    const api = fakeApi({ permissions: { read: true, publish: true, pin: true, actor: null, tags: ['finance'] } });
    api.fetch = (async (url: string, init?: RequestInit) =>
      url.endsWith('/head')
        ? json({ id: 'reg_base', snapshot: { id: 'reg_base', createdAt: '', manifests: owned } })
        : (fakeApi({ permissions: { read: true, publish: true, pin: true, actor: null, tags: ['finance'] } }).fetch as typeof fetch)(url, init)) as typeof fetch;
    await render(api);

    expect(byLabel('Remove billing')).toBeDefined();
    expect(byLabel('Remove reviews')).toBeUndefined();
    expect(container.textContent).toContain('read-only');
  });
});
