import { afterEach, describe, expect, it } from 'vitest';
import { createFragmentBoundary } from './fragment-boundary.js';
import { alreadyExecutedScriptsAndLinks, isBraidInert, setInertScriptType } from './script-execution.js';
import { insideAnotherFragment } from '../elements/fragment-slot.js';

/**
 * Markup a fragment writes is not markup Braid prepared. A `<script type="inert">` in it is a
 * forgery of Braid's own marker, and a parsed `<script>` is one the browser will never run; neither
 * may be run in the realm because the fragment happened to move it.
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
  const fragment = createFragmentBoundary({
    realmDocument: document.implementation.createHTMLDocument(),
    shadowRoot,
    braidDocumentElement: braidDocument,
    abortSignal: new AbortController().signal,
  });
  fragment.stampTree(braidDocument);
  return { container, braidDocument, fragment };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('inert markers the fragment wrote', () => {
  afterEach(() => document.body.replaceChildren());

  it('treats the gateway’s inert scripts, present when the boundary was made, as Braid’s', () => {
    const { braidDocument } = boundary('<script type="inert" data-script-type="module" src="/__braid/frag/x/a.js"></script>');
    expect(isBraidInert(braidDocument.querySelector('script')!)).toBe(true);
  });

  it('leaves a written <script type="inert"> exactly as inert as it is natively', async () => {
    const { container } = boundary();
    container.innerHTML = '<script type="inert">top.ran = true</script><link rel="inert-modulepreload" href="/evil.js">';
    await tick();
    const script = container.querySelector('script')!;
    expect(isBraidInert(script)).toBe(false);
    // activation would have restored its type; it is untouched
    expect(script.getAttribute('type')).toBe('inert');
    expect(container.querySelector('link')!.getAttribute('rel')).toBe('inert-modulepreload');
  });

  it('marks scripts parsed by innerHTML and insertAdjacentHTML as started, so moving them runs nothing', () => {
    const { container } = boundary();
    container.innerHTML = '<div><script>top.ran = true</script></div>';
    container.insertAdjacentHTML('beforeend', '<script>top.ran = true</script>');
    const scripts = [...container.querySelectorAll('script')];
    expect(scripts.every((script) => alreadyExecutedScriptsAndLinks.has(script))).toBe(true);
  });

  it('marks a clone of a started script as started, and a clone of a Braid inert script as Braid’s', () => {
    const { container } = boundary();
    container.innerHTML = '<div><script>top.ran = true</script></div>';
    const copy = (container.firstElementChild as Element).cloneNode(true) as Element;
    expect(alreadyExecutedScriptsAndLinks.has(copy.querySelector('script')!)).toBe(true);

    // a detached holder with the fragment's stamp, so cloning it goes through the boundary without
    // inserting (and so running) the script
    const { fragment } = boundary();
    const neutralized = document.createElement('script');
    neutralized.textContent = 'ok()';
    setInertScriptType(neutralized);
    const holder = document.createElement('span');
    Node.prototype.appendChild.call(holder, neutralized);
    fragment.stampNode(holder);
    const cloned = holder.cloneNode(true) as Element;
    expect(isBraidInert(cloned.querySelector('script')!)).toBe(true);
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
    // deeper still, inside a component the fragment rendered
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
    // stamped: its own getRootNode() answers with the fragment's virtual document
    expect(nested.getRootNode()).not.toBeInstanceOf(ShadowRoot);
    expect(insideAnotherFragment(nested)).toBe(true);
  });
});
