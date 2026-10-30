import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFragmentBoundary } from './fragment-boundary.js';
import { createHtmlPolicy, HtmlPolicyMode, resolveHtmlPolicy } from './html-policy.js';

const DANGEROUS =
  '<p>hello</p>' +
  '<img src="x" onerror="window.ran = true">' +
  '<script>window.ran = true</script>' +
  '<a href=" java\tscript:alert(1)">link</a>' +
  '<form action="javascript:alert(1)"><button formaction="JAVASCRIPT:alert(1)">go</button></form>' +
  '<iframe srcdoc="<script>parent.ran = true</script>"></iframe>' +
  '<iframe src="data:text/html,hi"></iframe>' +
  '<meta http-equiv="Refresh" content="0;url=https://evil.example">' +
  '<a href="/safe">safe</a>';

/** A fragment boundary over a slot-shaped shadow root, as the compat realm patches build one. */
function boundary(mode?: HtmlPolicyMode) {
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const braidDocument = document.createElement('braid-document');
  shadowRoot.append(braidDocument);
  const container = document.createElement('div');
  braidDocument.append(container);
  const controller = new AbortController();
  const fragment = createFragmentBoundary({
    realmDocument: document.implementation.createHTMLDocument(),
    shadowRoot,
    braidDocumentElement: braidDocument,
    abortSignal: controller.signal,
    ...(mode ? { htmlPolicy: createHtmlPolicy(mode, 'billing', document) } : {}),
  });
  fragment.stampTree(braidDocument);
  return { container, shadowRoot, dispose: () => controller.abort() };
}

describe('HTML sink policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  describe("'sanitize'", () => {
    it('removes what could run from innerHTML, and keeps the rest', () => {
      const { container } = boundary('sanitize');
      container.innerHTML = DANGEROUS;

      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('meta')).toBeNull();
      expect(container.querySelector('img')!.hasAttribute('onerror')).toBe(false);
      expect(container.querySelector('a')!.hasAttribute('href')).toBe(false);
      expect(container.querySelector('form')!.hasAttribute('action')).toBe(false);
      expect(container.querySelector('button')!.hasAttribute('formaction')).toBe(false);
      const [srcdocFrame, dataFrame] = container.querySelectorAll('iframe');
      expect(srcdocFrame.hasAttribute('srcdoc')).toBe(false);
      expect(dataFrame.hasAttribute('src')).toBe(false);
      // what is harmless survives
      expect(container.querySelector('p')!.textContent).toBe('hello');
      expect(container.querySelector('a[href="/safe"]')).not.toBeNull();
    });

    it('cleans insertAdjacentHTML at every position', () => {
      const { container } = boundary('sanitize');
      const parent = container;
      const child = document.createElement('span');
      parent.append(child);
      for (const position of ['beforebegin', 'afterbegin', 'beforeend', 'afterend'] as const) {
        child.insertAdjacentHTML(position, `<b data-at="${position}" onclick="x()">${position}</b>`);
      }
      expect([...parent.querySelectorAll('b')].map((b) => [b.dataset.at, b.hasAttribute('onclick')])).toEqual([
        ['beforebegin', false],
        ['afterbegin', false],
        ['beforeend', false],
        ['afterend', false],
      ]);
      expect(() => child.insertAdjacentHTML('sideways' as InsertPosition, '<b></b>')).toThrow(/position/);
    });

    it('cleans markup written into a template, and inside nested templates', () => {
      const { container } = boundary('sanitize');
      container.innerHTML = '<template><template><img onerror="x()"></template></template>';
      const outer = container.querySelector('template')!;
      const inner = outer.content.querySelector('template')!;
      expect(inner.content.querySelector('img')!.hasAttribute('onerror')).toBe(false);
    });
  });

  describe("'report'", () => {
    it('writes the markup unchanged, and warns once per distinct finding', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { container } = boundary('report');
      container.innerHTML = DANGEROUS;
      container.innerHTML = DANGEROUS;

      expect(container.querySelector('img')!.getAttribute('onerror')).toBe('window.ran = true');
      expect(container.querySelector('script')).not.toBeNull();
      const messages = warn.mock.calls.map(([message]) => String(message));
      expect(messages.some((message) => message.includes('[braid:billing] innerHTML wrote markup with an onerror handler on <img>'))).toBe(true);
      // the same write twice warns no more than once
      expect(new Set(messages).size).toBe(messages.length);
    });
  });

  it('leaves innerHTML exactly as it was without a policy', () => {
    const { container } = boundary();
    container.innerHTML = DANGEROUS;
    expect(container.querySelector('img')!.getAttribute('onerror')).toBe('window.ran = true');
    expect(container.querySelector('script')).not.toBeNull();
  });
});

describe('resolveHtmlPolicy()', () => {
  it('accepts report and sanitize, and ignores anything else with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveHtmlPolicy(undefined, 'billing')).toBeNull();
    expect(resolveHtmlPolicy({ html: 'sanitize' }, 'billing')).toBe('sanitize');
    expect(resolveHtmlPolicy({ html: 'report' }, 'billing')).toBe('report');
    expect(resolveHtmlPolicy({ html: 'strict' as never }, 'billing')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[braid:billing] ignoring capabilities.html "strict"'));
    warn.mockRestore();
  });
});
