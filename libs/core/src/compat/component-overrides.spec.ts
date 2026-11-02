import { afterEach, describe, expect, it } from 'vitest';
import { createFragmentBoundary } from './fragment-boundary.js';
import { setInternalReference } from './metadata.js';

/**
 * A custom element that overrides insertion on its own class, as Stencil's scoped components do
 * to move light-DOM children into an inner slot. The boundary stamps a prototype above the class;
 * these check the class's overrides still run underneath it.
 */
class SlotRelocating extends HTMLElement {
  get slotElement(): Element {
    // by children, not `:scope >`: jsdom answers that query with null inside a shadow tree
    let slot = [...this.children].find((child) => child.className === 'slot') ?? null;
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'slot';
      Node.prototype.appendChild.call(this, slot);
    }
    return slot;
  }
  override appendChild<T extends Node>(node: T): T {
    return this.slotElement.appendChild(node);
  }
  override insertBefore<T extends Node>(node: T, ref: Node | null): T {
    return this.slotElement.insertBefore(node, ref);
  }
  override append(...nodes: (Node | string)[]): void {
    this.slotElement.append(...nodes);
  }
}
customElements.define('test-relocating', SlotRelocating);

function fragmentContainer(): { container: HTMLElement; realmDocument: Document } {
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const braidDocument = document.createElement('braid-document');
  const container = document.createElement('div');
  braidDocument.append(container);
  shadowRoot.append(braidDocument);
  const realmDocument = document.implementation.createHTMLDocument();
  setInternalReference(realmDocument, 'body');
  createFragmentBoundary({ realmDocument, shadowRoot, braidDocumentElement: braidDocument, abortSignal: new AbortController().signal });
  return { container, realmDocument };
}

/** Where each child ends up, as a string, so the two runs compare as one value. */
function exercise(parent: HTMLElement): string {
  const element = document.createElement('test-relocating');
  parent.appendChild(element);
  const first = document.createElement('i');
  element.appendChild(first);
  // the reference is where the component put it: inside its slot, not a child of the element
  element.insertBefore(document.createElement('b'), first);
  element.append(document.createElement('u'));
  return element.outerHTML;
}

describe('a custom element’s own insertion overrides, inside a compat fragment', () => {
  afterEach(() => document.body.replaceChildren());

  it('place children where they would go outside a fragment, and insertBefore a relocated reference', () => {
    const outside = exercise(document.body);
    expect(outside).toBe('<test-relocating><div class="slot"><b></b><i></i><u></u></div></test-relocating>');
    expect(exercise(fragmentContainer().container)).toBe(outside);
  });

  it('keeps the boundary on an element the component inserts into', () => {
    const { container, realmDocument } = fragmentContainer();
    const element = document.createElement('test-relocating');
    container.appendChild(element);
    // the virtualized ownerDocument is the boundary's; it is still in place above the class
    expect(element.ownerDocument).toBe(realmDocument);
  });

  it('restamps an element whose definition arrives after it was stamped', async () => {
    const { container, realmDocument } = fragmentContainer();
    const element = document.createElement('test-late-relocating');
    container.appendChild(element);
    expect(element.ownerDocument).toBe(realmDocument);

    customElements.define('test-late-relocating', class extends SlotRelocating {});
    await customElements.whenDefined('test-late-relocating');
    await Promise.resolve();

    expect(element).toBeInstanceOf(SlotRelocating);
    expect(element.ownerDocument).toBe(realmDocument);
    element.appendChild(document.createElement('i'));
    expect(element.outerHTML).toBe('<test-late-relocating><div class="slot"><i></i></div></test-late-relocating>');
  });
});
