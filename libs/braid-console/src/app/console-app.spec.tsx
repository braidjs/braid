import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConsoleApp } from './console-app.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const manifests = [{ id: 'billing', endpoint: 'https://billing.internal', title: 'Billing' }];

function fakeApi() {
  const doFetch = vi.fn(async (url: string) => {
    if (url.endsWith('/permissions')) return json({ read: true, publish: true, pin: true, actor: null, tags: null });
    if (url.endsWith('/head')) return json({ id: 'reg_base', snapshot: { id: 'reg_base', createdAt: '2026-01-01', manifests } });
    return json({ error: 'not here' }, 404);
  });
  return { fetch: doFetch as unknown as typeof fetch };
}

describe('<ConsoleApp> fragment drafts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.location.hash = '#edit';
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.location.hash = '';
  });

  const tab = (label: string) => [...container.querySelectorAll('[role="tab"]')].find((element) => element.textContent === label);
  const click = async (element: Element | undefined) => {
    await act(async () => element?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  };
  /** Whether the browser would ask before unloading the page. */
  const guarded = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('keeps an unpublished fragment draft across tabs, and asks before the page closes', async () => {
    await act(async () => root.render(<ConsoleApp api={fakeApi()} edit />));
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="Remove billing"]')).not.toBeNull());
    expect(guarded()).toBe(false);

    await click(container.querySelector('button[aria-label="Remove billing"]')!);
    expect(guarded()).toBe(true);

    await click(tab('Fragments'));
    await click(tab('Edit fragments'));

    // still the draft — billing removed — not a fresh copy of HEAD
    expect(container.querySelector('button[aria-label="Remove billing"]')).toBeNull();
    expect(container.textContent).toContain('No fragments');
    expect(guarded()).toBe(true);
  });
});
