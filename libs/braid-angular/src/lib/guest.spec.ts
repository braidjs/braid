import { Component, inject, OnInit, PendingTasks, provideZonelessChangeDetection } from '@angular/core';
import type { FragmentEnv } from '@braidlabs/core';
import { defineAngularFragment } from './guest';

/**
 * `defineAngularFragment` registers its mount on the realm's global, where the contract adapter
 * reads it; reading it back here lets the test drive the mount with a minimal env, without a realm.
 */
const registeredMount = () =>
  (globalThis as unknown as { __braidFragment: { mount(env: FragmentEnv): Promise<void> } }).__braidFragment.mount;

let finishLoading: () => void;

@Component({ selector: 'braid-test-fragment', standalone: true, template: '<p>fragment</p>' })
class FragmentComponent implements OnInit {
  readonly #tasks = inject(PendingTasks);
  ngOnInit(): void {
    finishLoading = this.#tasks.add();
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('defineAngularFragment()', () => {
  it('reports settled on its own once the first screen has loaded', async () => {
    defineAngularFragment({ component: FragmentComponent, providers: () => [provideZonelessChangeDetection()] });
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const controller = new AbortController();
    const settled = vi.fn();

    await registeredMount()({ root, signal: controller.signal, settled } as unknown as FragmentEnv);
    await settle();
    expect(root.textContent).toBe('fragment');
    expect(settled).not.toHaveBeenCalled();

    finishLoading();
    await settle();
    expect(settled).toHaveBeenCalledTimes(1);
    controller.abort();
  });
});
