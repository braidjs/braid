import { afterEach, describe, expect, it } from 'vitest';
import { createFragmentBoundary } from './fragment-boundary.js';
import { executeScriptsInFragmentContent } from './script-execution.js';
import { makeScriptBornInert } from './born-inert-scripts.js';
import { setInternalReference } from './metadata.js';
import { insideAnotherFragment } from '../elements/fragment-slot.js';

/**
 * A script runs in a fragment's realm only if the fragment's own document made it, or the gateway
 * did — never because markup that a parser produced reached the DOM, whatever its markers say.
 * "Ran" here means the boundary put an executable copy into the realm's document.
 */
function boundary(initial = '', hostTag = 'div') {
  const host = document.createElement(hostTag);
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const braidDocument = document.createElement('braid-document');
  braidDocument.innerHTML = initial;
  shadowRoot.append(braidDocument);
  const container = document.createElement('div');
  braidDocument.append(container);
  const realmDocument = document.implementation.createHTMLDocument();
  setInternalReference(realmDocument, 'body');
  const fragment = createFragmentBoundary({
    realmDocument,
    shadowRoot,
    braidDocumentElement: braidDocument,
    abortSignal: new AbortController().signal,
  });
  fragment.stampTree(braidDocument);
  const ran = () => [...realmDocument.body.querySelectorAll('script')].map((script) => script.textContent);
  return { container, braidDocument, fragment, realmDocument, ran };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('what may run in the realm', () => {
  afterEach(() => document.body.replaceChildren());

  it('runs a script the fragment’s own document created', () => {
    const { container, ran } = boundary();
    const script = document.createElement('script');
    makeScriptBornInert(script);
    script.textContent = 'own()';
    container.append(script);
    expect(ran()).toEqual(['own()']);
  });

  it('runs the gateway’s scripts, including ones in a template the fragment instantiates later', async () => {
    const { braidDocument, container, realmDocument, ran } = boundary(
      '<script type="inert">boot()</script>' +
        '<template id="t"><script type="inert" data-script-type="module">later()</script></template>',
    );
    executeScriptsInFragmentContent(braidDocument, realmDocument);
    expect(ran()).toEqual(['boot()']);

    const template = braidDocument.querySelector('template')!;
    container.append(template.content.cloneNode(true));
    await tick();
    expect(ran()).toEqual(['boot()', 'later()']);
    // with its real type, not as a classic script
    expect(realmDocument.body.lastElementChild!.getAttribute('type')).toBe('module');
  });

  describe('never runs markup a parser produced', () => {
    it('a written <script type="inert">, through the observer or when moved', async () => {
      const { container, ran } = boundary();
      container.innerHTML = '<i><script type="inert">forged()</script></i>';
      await tick();
      const other = document.createElement('div');
      container.append(other);
      other.append(container.querySelector('i')!);
      await tick();
      expect(ran()).toEqual([]);
    });

    it('a parsed <script>, moved, cloned, or copied through a Range', async () => {
      const { container, ran } = boundary();
      container.innerHTML = '<p><script>parsed()</script></p>';
      container.append(container.querySelector('p')!.cloneNode(true));
      const range = document.createRange();
      range.selectNodeContents(container);
      container.append(range.cloneContents());
      container.append(document.createRange().createContextualFragment('<script type="inert">forged()</script>'));
      await tick();
      expect(ran()).toEqual([]);
    });

    it('a script in a template’s content the fragment wrote, instantiated', async () => {
      const { container, ran } = boundary();
      const template = document.createElement('template');
      template.innerHTML = '<script>templated()</script>';
      container.append(template.content.cloneNode(true));
      container.append(template.content);
      await tick();
      expect(ran()).toEqual([]);
    });

    it('a script written by outerHTML, then moved', async () => {
      const { container, ran } = boundary();
      container.innerHTML = '<span></span>';
      container.querySelector('span')!.outerHTML = '<p><script>outer()</script></p>';
      const other = document.createElement('div');
      container.append(other);
      other.append(container.querySelector('p')!);
      await tick();
      expect(ran()).toEqual([]);
    });
  });

  it('gives the host copy of a script that ran its real type back, and runs nothing more when it moves', () => {
    const { container, ran } = boundary();
    const script = document.createElement('script');
    makeScriptBornInert(script);
    script.type = 'module';
    script.textContent = 'once()';
    container.append(script);
    expect(ran()).toEqual(['once()']);
    // marked started the browser's way before insertion (verified in Chromium: jsdom has no such
    // flag to observe), so its real type is safe to give back, and selectors by type still match
    expect(Element.prototype.getAttribute.call(script, 'type')).toBe('module');
    expect(container.querySelector('script[type="module"]')).toBe(script);
    const other = document.createElement('div');
    container.append(other);
    other.append(script);
    expect(ran()).toEqual(['once()']);
  });

  it('runs every JavaScript type the browser runs, not only the common spellings', () => {
    const { container, ran } = boundary();
    for (const type of ['application/javascript', ' TEXT/ECMASCRIPT ']) {
      const script = document.createElement('script');
      makeScriptBornInert(script);
      script.type = type;
      script.textContent = `typed('${type.trim()}')`;
      container.append(script);
    }
    expect(ran()).toEqual(["typed('application/javascript')", "typed('TEXT/ECMASCRIPT')"]);
  });

  it('never runs a created script whose own code set its type to inert', () => {
    const { container, ran } = boundary();
    const script = document.createElement('script');
    makeScriptBornInert(script);
    script.type = 'inert';
    script.textContent = 'copied()';
    container.append(script);
    expect(ran()).toEqual([]);
  });

  it('never runs a contextual-fragment script, whatever JavaScript type it has', async () => {
    const { container, ran } = boundary();
    container.append(document.createRange().createContextualFragment('<script type="text/ecmascript">exotic()</script>'));
    await tick();
    expect(ran()).toEqual([]);
  });

  it('carries provenance into nested gateway templates, and through importNode', async () => {
    const { braidDocument, container, fragment, ran } = boundary(
      '<template id="outer"><template id="inner"><script type="inert">nested()</script></template></template>' +
        '<template id="imported"><script type="inert">imported()</script></template>',
    );
    const outer = (braidDocument.querySelector('#outer') as HTMLTemplateElement).content.cloneNode(true) as DocumentFragment;
    const inner = outer.querySelector('template') as HTMLTemplateElement;
    container.append(inner.content.cloneNode(true));

    const source = (braidDocument.querySelector('#imported') as HTMLTemplateElement).content;
    const copy = document.importNode(source, true);
    // what the realm document's importNode does after its native copy
    fragment.inheritProvenance(source, copy, true);
    container.append(copy);
    await tick();
    expect(ran()).toEqual(['nested()', 'imported()']);
  });

  it('keeps a data block’s type when it is moved, so code that finds it by type still does', () => {
    const { container, ran } = boundary();
    container.innerHTML = '<p><script type="application/json" id="state">{"a":1}</script></p>';
    const other = document.createElement('div');
    container.append(other);
    other.append(container.querySelector('p')!);
    expect(container.querySelector('script[type="application/json"]')!.id).toBe('state');
    expect(ran()).toEqual([]);
  });

  it('revives only the inert links Braid made, never one the fragment wrote', async () => {
    const { container, realmDocument } = boundary('<link rel="inert-modulepreload" href="/gateway.js">');
    container.innerHTML = '<link rel="inert-modulepreload" href="/forged.js">';
    await tick();
    const revived = [...realmDocument.body.querySelectorAll('link')].map((link) => link.getAttribute('href'));
    expect(revived).not.toContain('/forged.js');
  });
});

describe('insideAnotherFragment()', () => {
  afterEach(() => document.body.replaceChildren());

  it('is true only for a slot in some fragment’s shadow root, not a host component’s', () => {
    const outer = document.createElement('fragment-slot');
    document.body.append(outer);
    const nested = document.createElement('fragment-slot');
    const wrapper = document.createElement('div');
    outer.attachShadow({ mode: 'open' }).append(wrapper);
    const component = document.createElement('x-card');
    wrapper.append(component);
    component.attachShadow({ mode: 'open' }).append(nested);
    expect(insideAnotherFragment(nested)).toBe(true);

    const hostComponent = document.createElement('x-shell');
    document.body.append(hostComponent);
    const hostSlot = document.createElement('fragment-slot');
    hostComponent.attachShadow({ mode: 'open' }).append(hostSlot);
    expect(insideAnotherFragment(hostSlot)).toBe(false);
    expect(insideAnotherFragment(outer)).toBe(false);
  });

  it('sees through the virtual getRootNode of a slot a compat fragment wrote', () => {
    const { container } = boundary('', 'fragment-slot');
    const nested = document.createElement('fragment-slot');
    container.append(nested);
    expect(nested.getRootNode()).not.toBeInstanceOf(ShadowRoot);
    expect(insideAnotherFragment(nested)).toBe(true);
  });
});
