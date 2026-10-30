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

    it('removes javascript: from an <object> data URL, and every script, data blocks included', () => {
      const { container } = boundary('sanitize');
      container.innerHTML =
        '<object data="javascript:alert(1)"></object><script type="application/json">{"a":1}</script>' +
        '<script type="inert">top.ran = true</script><script type="inert" data-script-type="module">x()</script>';
      expect(container.querySelector('object')!.hasAttribute('data')).toBe(false);
      expect(container.querySelectorAll('script')).toHaveLength(0);
    });

    it('removes what would make Braid run something: its own elements and the gateway’s markers', () => {
      const { container } = boundary('sanitize');
      container.innerHTML =
        '<fragment-slot adapter="contract" name="p" entry="https://evil.example/e.js"></fragment-slot>' +
        '<braid-late for="x"></braid-late><braid-late-end></braid-late-end>' +
        '<link rel="inert-modulepreload" href="https://evil.example/m.js"><div data-script-type="module"></div>' +
        '<base href="/elsewhere/"><link rel="stylesheet" href="/kept.css">';
      expect(container.querySelector('fragment-slot, braid-late, braid-late-end, base, link[rel^="inert-"]')).toBeNull();
      expect(container.querySelector('div')!.hasAttribute('data-script-type')).toBe(false);
      // CSS is out of scope, and documented as such
      expect(container.querySelector('link[rel="stylesheet"]')).not.toBeNull();
    });

    it('removes SVG animation, which can set a link to javascript:', () => {
      const { container } = boundary('sanitize');
      container.innerHTML =
        '<svg><a><animate attributeName="href" values="javascript:alert(1)"></animate>' +
        '<set attributeName="xlink:href" to="javascript:alert(1)"></set><text>x</text></a></svg>';
      expect(container.querySelector('animate, set')).toBeNull();
      expect(container.querySelector('text')).not.toBeNull();
    });

    it('lets a frame load only a document by http(s) URL, or none', () => {
      const { container } = boundary('sanitize');
      container.innerHTML =
        '<iframe src="https://ok.example/"></iframe><iframe src="/relative"></iframe><iframe src="about:blank"></iframe>' +
        '<iframe src="filesystem:https://x/y"></iframe><embed src="javascript:x()"><object data="data:text/html,x"></object>';
      const sources = [...container.querySelectorAll('iframe, embed, object')].map(
        (element) => element.getAttribute('src') ?? element.getAttribute('data'),
      );
      expect(sources).toEqual(['https://ok.example/', '/relative', 'about:blank', null, null, null]);
    });

    it('cleans a value that is not a string, as the native setter would read it', () => {
      const { container } = boundary('sanitize');
      container.innerHTML = ['<img onerror="x()">'] as unknown as string;
      expect(container.querySelector('img')!.hasAttribute('onerror')).toBe(false);
      container.innerHTML = { toString: () => '<img onerror="x()">' } as unknown as string;
      expect(container.querySelector('img')!.hasAttribute('onerror')).toBe(false);
    });

    it('parses in the target’s own context, as the native setter does', () => {
      const { container } = boundary('sanitize');
      container.innerHTML = '<svg><g></g></svg><table></table><textarea></textarea><style></style>';
      const [svg, table, textarea, style] = [...container.children];

      svg.innerHTML = '<circle r="1" onclick="x()"></circle><linearGradient></linearGradient>';
      expect(svg.firstElementChild!.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(svg.firstElementChild!.hasAttribute('onclick')).toBe(false);
      expect(svg.lastElementChild!.localName).toBe('linearGradient');

      table.innerHTML = '<tr><td onclick="x()">1</td></tr>';
      expect((table as HTMLTableElement).tBodies).toHaveLength(1);
      expect(table.querySelector('td')!.hasAttribute('onclick')).toBe(false);

      // text-only targets get text, exactly as natively
      textarea.innerHTML = '<b>bold</b>';
      expect((textarea as HTMLTextAreaElement).value).toBe('<b>bold</b>');
      style.innerHTML = 'a::after { content: "&amp;<i>" }';
      expect(style.textContent).toBe('a::after { content: "&amp;<i>" }');
    });

    it('clears on null, as the native setter does', () => {
      const { container } = boundary('sanitize');
      container.innerHTML = '<p>x</p>';
      container.innerHTML = null as unknown as string;
      expect(container.childNodes).toHaveLength(0);
    });

    it('writes into a template element’s content, and into the shadow root', () => {
      const { container, shadowRoot } = boundary('sanitize');
      container.innerHTML = '<template></template>';
      const template = container.querySelector('template')!;
      template.innerHTML = '<img onerror="x()">';
      expect(template.content.querySelector('img')!.hasAttribute('onerror')).toBe(false);
      expect(template.childNodes).toHaveLength(0);

      shadowRoot.innerHTML = '<braid-document><img onerror="x()"></braid-document>';
      expect(shadowRoot.querySelector('img')!.hasAttribute('onerror')).toBe(false);
    });

    it('passes a TrustedHTML, which the host’s own policy vetted, to the native setter', () => {
      const trusted = { toString: () => '<img onerror="x()">' };
      vi.stubGlobal('trustedTypes', { isHTML: (value: unknown) => value === trusted });
      try {
        const { container } = boundary('sanitize');
        container.innerHTML = trusted as unknown as string;
        expect(container.querySelector('img')!.hasAttribute('onerror')).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
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
      expect(() => child.insertAdjacentHTML('sideways' as InsertPosition, '<b></b>')).toThrow();
    });

    it('throws for a position outside an element with no parent, as the native method does', () => {
      const { container } = boundary('sanitize');
      const orphan = document.createElement('span');
      container.append(orphan);
      orphan.remove();
      expect(() => orphan.insertAdjacentHTML('beforebegin', '<b></b>')).toThrow();
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
      expect(messages).toContain('[braid:billing] innerHTML wrote markup with an onerror handler on <img>; capabilities.html "sanitize" would remove it');
      // the same write twice warns no more than once
      expect(new Set(messages).size).toBe(messages.length);
    });
  });

  it("'report' cannot be flooded into silence by harmless variety, and says when it stops", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { container } = boundary('report');
    container.innerHTML = Array.from({ length: 60 }, (_, i) => `<x${i} onclick="1"></x${i}>`).join('');
    container.innerHTML = '<img src="x" onerror="1">';
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes('onerror handler'))).toBe(true);
    expect(messages.filter((message) => message.includes('onclick handler'))).toHaveLength(1);
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
