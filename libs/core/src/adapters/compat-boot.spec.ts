import { describe, expect, it } from 'vitest';
import { imagesSettled } from './compat-adapter.js';

/**
 * What a compat fragment's window `load` waits for. Boot itself does not wait on it: the slot is
 * ready once the fragment's code has run.
 */
describe('imagesSettled()', () => {
  const settledWithin = (promise: Promise<void>, ms = 20) =>
    Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

  function contentRootWith(html: string): HTMLElement {
    const root = document.createElement('braid-document');
    root.innerHTML = html;
    return root;
  }

  it('waits for an image that is still loading, until it loads or fails', async () => {
    const root = contentRootWith('<img src="/a.png"><img src="/b.png">');
    const settled = imagesSettled(root);

    expect(await settledWithin(settled)).toBe(false);
    root.querySelectorAll('img')[0].dispatchEvent(new Event('load'));
    root.querySelectorAll('img')[1].dispatchEvent(new Event('error'));
    expect(await settledWithin(settled)).toBe(true);
  });

  it('does not wait for a lazy image, which the browser would not load until scrolled to', async () => {
    const root = contentRootWith('<img loading="lazy" src="/below-the-fold.png"><img loading="LAZY" src="/b.png">');

    expect(await settledWithin(imagesSettled(root))).toBe(true);
  });
});
