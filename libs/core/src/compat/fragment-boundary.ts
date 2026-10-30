/* eslint-disable @typescript-eslint/no-unsafe-function-type, prefer-rest-params --
 * ported from the matrix-tested web-fragments fork: the wrappers must forward the exact
 * original `arguments` object to native DOM methods, and accept any native function shape. */
import {
  compatDomInsertion,
  compatMultiNodeDomInsertion,
  executeInertScript,
  executeInertPreloadLink,
  INERT_SELECTOR,
  isBraidInertLink,
  isRunnable,
  markBraidInertLink,
  markGatewayContent,
  markRunnable,
  markStartedInPlace,
  restoreScriptType,
  alreadyExecutedScriptsAndLinks,
} from './script-execution.js';
import { removeBornInertShadowing, unwrapBornInertScriptToLive } from './born-inert-scripts.js';
import { isDevMode } from '../config.js';
import { fragmentRootOf, subresourceUrlOverrides, type FragmentUrlBase } from './subresource-urls.js';
import type { HtmlPolicy } from './html-policy.js';

/**
 * The fragment boundary: all main-realm interception is confined here — the
 * host page's `Node`/`Element` prototypes are never touched.
 *
 * Every node inside a fragment's DOM is "stamped" with a per-fragment prototype spliced above
 * its native prototype (`Object.create(nativeProto, overrides)` + `Object.setPrototypeOf(node, …)`).
 * The overrides provide script/preload activation on insertion and virtualized
 * `ownerDocument`/`getRootNode` — but only for nodes that belong to the fragment. The host page
 * runs on pristine prototypes.
 *
 * Stamping is applied synchronously at every point where nodes enter the fragment world, and
 * stamped entry points propagate the stamp to whatever they create or admit (insertion methods,
 * `cloneNode`, `innerHTML`, `insertAdjacentHTML`), so the stamped set is closed under the
 * operations fragment code can perform on it.
 *
 * A `MutationObserver` scoped to the fragment's shadow root acts as the safety net for
 * insertions that bypass stamped methods (e.g. code calling captured native functions): scripts
 * reaching the DOM through such paths are inert by construction (see `born-inert-scripts.ts`
 * and the gateway's SSR neutralization), and the observer activates them — one microtask later —
 * in the fragment's realm, stamps the stray subtree, and reports the bypass in dev mode.
 */

// Native main-realm references, captured at module load.
const native = {
  appendChild: Node.prototype.appendChild,
  insertBefore: Node.prototype.insertBefore,
  replaceChild: Node.prototype.replaceChild,
  getRootNode: Node.prototype.getRootNode,
  cloneNode: Node.prototype.cloneNode,
  ownerDocument: Object.getOwnPropertyDescriptor(Node.prototype, 'ownerDocument')!.get!,
  elementAppend: Element.prototype.append,
  elementPrepend: Element.prototype.prepend,
  elementReplaceChildren: Element.prototype.replaceChildren,
  elementReplaceWith: Element.prototype.replaceWith,
  insertAdjacentElement: Element.prototype.insertAdjacentElement,
  insertAdjacentHTML: Element.prototype.insertAdjacentHTML,
  elementInnerHTML: Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!,
  fragmentAppend: DocumentFragment.prototype.append,
  fragmentPrepend: DocumentFragment.prototype.prepend,
  fragmentReplaceChildren: DocumentFragment.prototype.replaceChildren,
  elementBefore: Element.prototype.before,
  elementAfter: Element.prototype.after,
  shadowRootInnerHTML: Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'innerHTML')!,
};

export interface FragmentBoundary {
  /** Stamps a single element with the fragment's boundary prototype. */
  stampNode(node: Node): void;
  /** Stamps an element (or DocumentFragment contents) and all its element descendants. */
  stampTree(root: Node): void;
  /** Gives a copy of fragment DOM the provenance of what it copies (see `inheritProvenance`). */
  inheritProvenance(source: Node, copy: Node, deep: boolean): void;
  /** Disconnects the boundary observer. Called when the fragment is destroyed. */
  disconnect(): void;
}

export function createFragmentBoundary(options: {
  realmDocument: Document;
  shadowRoot: ShadowRoot;
  braidDocumentElement: HTMLElement;
  abortSignal: AbortSignal;
  /** Applied to the fragment's `innerHTML` and `insertAdjacentHTML` writes; see `html-policy.ts`. */
  htmlPolicy?: HtmlPolicy;
}): FragmentBoundary {
  const { realmDocument, shadowRoot, braidDocumentElement, abortSignal, htmlPolicy } = options;

  const stampedNodes = new WeakSet<Node>();
  const stampedProtos = new Map<object, object>();
  const stampedProtoSet = new WeakSet<object>();
  let warnedAboutUnstampedEntry = false;

  /** A node is inside this fragment's DOM iff its plain root is the fragment's shadow root. */
  function isInFragmentDom(node: Node): boolean {
    return native.getRootNode.call(node) === shadowRoot;
  }

  /**
   * Reverts any born-inert scripts in the given node (or its subtree) to their live form, so
   * the standard insertion handling below can process them like any other insertion.
   *
   * This also covers *clones* of born-inert scripts: clones carry the `type="inert"` +
   * `data-script-type` attributes (attributes copy with cloneNode) but not the WeakSet
   * membership. Reviving them here restores standalone-behavior parity.
   */
  function reviveInertScript(script: HTMLScriptElement): void {
    unwrapBornInertScriptToLive(script);
    // only a script that may run at all: one markup wrote as `type="inert"` stays exactly that
    if (script.getAttribute('type') === 'inert' && !alreadyExecutedScriptsAndLinks.has(script) && isRunnable(script)) {
      restoreScriptType(script);
    }
  }

  /**
   * A clone carries its source's provenance, as the browser carries a script's started flag: a clone
   * of a script that may run and has not yet may run, a clone of one that has run has run, and a
   * clone of an inert link Braid made is Braid's. Matched by position: a deep clone has its source's
   * shape. Only clones made through the boundary carry it — any other clone path (a `Range`, a
   * fragment's own `DocumentFragment`) yields scripts that never run, which is the safe side.
   */
  function inheritProvenance(source: Node, clone: Node, deep: boolean): void {
    if (!(source instanceof Element) && !(source instanceof DocumentFragment)) return;
    const select = 'script,link[rel^="inert-"]';
    const sources = [...(source instanceof Element && source.matches(select) ? [source] : [])];
    const clones = [...(clone instanceof Element && clone.matches(select) ? [clone] : [])];
    if (deep) {
      sources.push(...source.querySelectorAll(select));
      clones.push(...(clone as Element | DocumentFragment).querySelectorAll(select));
    }
    sources.forEach((element, index) => {
      const copy = clones[index];
      if (!copy || copy.localName !== element.localName) return;
      if (element.localName === 'script') {
        if (alreadyExecutedScriptsAndLinks.has(element as HTMLScriptElement)) alreadyExecutedScriptsAndLinks.add(copy as HTMLScriptElement);
        else if (isRunnable(element as HTMLScriptElement)) markRunnable(copy as HTMLScriptElement);
      } else if (isBraidInertLink(element as HTMLLinkElement)) {
        markBraidInertLink(copy as HTMLLinkElement);
      }
    });
    if (deep) inheritThroughTemplates(source, clone);
  }

  /**
   * A template's content is copied with it, but no selector enters it: pair the templates up and
   * carry provenance into each copied content, which can itself be instantiated later.
   */
  function inheritThroughTemplates(source: Element | DocumentFragment, clone: Node): void {
    const sources = [...(source instanceof Element && source.localName === 'template' ? [source] : []), ...source.querySelectorAll('template')];
    const clones = [
      ...(clone instanceof Element && clone.localName === 'template' ? [clone] : []),
      ...((clone as Element | DocumentFragment).querySelectorAll?.('template') ?? []),
    ];
    sources.forEach((template, index) => {
      const copy = clones[index] as HTMLTemplateElement | undefined;
      if (!copy) return;
      inheritProvenance((template as HTMLTemplateElement).content, copy.content, true);
      carryProvenanceOnClone(copy.content);
    });
  }

  /**
   * The gateway's templates hold scripts a fragment instantiates later, with
   * `template.content.cloneNode(true)`. A template's content is a DocumentFragment, which the
   * boundary does not stamp, so each one gets its own `cloneNode` that carries provenance — an own
   * property of the fragment's DOM object, not a host prototype.
   */
  function carryProvenanceThroughTemplates(root: ParentNode): void {
    for (const template of root.querySelectorAll('template')) {
      const content = (template as HTMLTemplateElement).content;
      carryProvenanceOnClone(content);
      carryProvenanceThroughTemplates(content);
    }
  }

  function carryProvenanceOnClone(content: DocumentFragment): void {
    Object.defineProperty(content, 'cloneNode', {
      configurable: true,
      writable: true,
      value: function templateContentCloneNode(this: DocumentFragment, deep?: boolean) {
        const clone = native.cloneNode.call(this, deep);
        inheritProvenance(this, clone, Boolean(deep));
        return clone;
      },
    });
  }

  function prepareForInsertion<T extends Node>(node: T): T {
    if (node instanceof HTMLScriptElement) {
      reviveInertScript(node);
    } else if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      (node as unknown as Element).querySelectorAll?.('script').forEach((script) => {
        reviveInertScript(script as HTMLScriptElement);
      });
    }
    return node;
  }

  /**
   * Nodes to stamp after an insertion: the node itself, or — for a DocumentFragment, whose
   * children move into the target during insertion — its current children.
   */
  function nodesToStampAfterInsertion(node: Node): Node[] {
    return node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? [...node.childNodes] : [node];
  }

  /**
   * Creates a wrapper for a single-child insertion method (appendChild, insertBefore).
   *
   * When the target is inside the fragment's DOM, the insertion gets script handling (via
   * `compatDomInsertion`). In all cases the inserted subtree is stamped so the stamped set
   * stays closed.
   */
  function makeSingleNodeInsertion(nativeFn: Function) {
    return function boundaryInsertion<T extends Node>(this: Node, childNode: T): T {
      const args = arguments;
      const futureStamps = nodesToStampAfterInsertion(childNode);
      const doInsertTheNode = () => {
        const result = nativeFn.apply(this, args);
        futureStamps.forEach(stampTree);
        return result as T;
      };

      if (!isInFragmentDom(this)) {
        // insertions into unattached trees are not script-processed; scripts are handled when
        // the tree itself is inserted into the fragment's DOM
        return doInsertTheNode();
      }

      return compatDomInsertion(prepareForInsertion(childNode), doInsertTheNode, realmDocument);
    };
  }

  function boundaryReplaceChild<T extends Node>(this: Node, newChild: Node, oldChild: T): T {
    const args = arguments;
    const futureStamps = nodesToStampAfterInsertion(newChild);
    const doInsertTheNode = () => {
      const result = native.replaceChild.apply(this, args as any);
      futureStamps.forEach(stampTree);
      return result;
    };

    if (!isInFragmentDom(this)) {
      doInsertTheNode();
    } else {
      compatDomInsertion(prepareForInsertion(newChild), doInsertTheNode, realmDocument);
    }
    return oldChild;
  }

  function boundaryInsertAdjacentElement(this: Element, where: InsertPosition, element: Element): Element | null {
    const args = arguments;
    const doInsertTheNode = () => {
      const result = native.insertAdjacentElement.apply(this, args as any);
      stampTree(element);
      return result;
    };

    if (!isInFragmentDom(this)) {
      return doInsertTheNode();
    }
    return compatDomInsertion(prepareForInsertion(element), doInsertTheNode, realmDocument) as Element | null;
  }

  /**
   * Creates a wrapper for the multi-node insertion methods (append, prepend, replaceChildren,
   * replaceWith): the native insertion runs once, after every node argument has been
   * preprocessed.
   */
  function makeMultiNodeInsertion(nativeFn: Function) {
    return function boundaryMultiInsertion(this: Node, ...nodes: (Node | string)[]) {
      const args = arguments;
      const nodeArgs = nodes.filter((node): node is Node => typeof node !== 'string');
      const futureStamps = nodeArgs.flatMap(nodesToStampAfterInsertion);

      const doInsertTheNodes = () => {
        nativeFn.apply(this, args);
        futureStamps.forEach(stampTree);
      };

      if (!isInFragmentDom(this)) {
        return doInsertTheNodes();
      }

      nodeArgs.forEach(prepareForInsertion);
      compatMultiNodeDomInsertion(nodes, doInsertTheNodes, realmDocument);
    };
  }

  function makeHtmlParsingOverrides(innerHTMLDescriptor: PropertyDescriptor): PropertyDescriptorMap {
    return {
      // Scripts parsed from html never execute (per spec), so parsing only needs stamp propagation.
      // A fragment with an HTML policy has the markup parsed and cleaned first (`html-policy.ts`),
      // and the result inserted natively, so the write means what the native setter would have.
      innerHTML: {
        configurable: true,
        enumerable: true,
        get(this: Element) {
          return innerHTMLDescriptor.get!.call(this);
        },
        set(this: Element | ShadowRoot, value: string) {
          // a shadow root's markup is parsed with its host for context, as the native setter does
          const context = this instanceof ShadowRoot ? this.host : this;
          const cleaned = htmlPolicy?.filter(value === null ? '' : value, context, 'innerHTML');
          if (cleaned) {
            // a template's markup is its content, not its children
            const target = this instanceof HTMLTemplateElement ? this.content : this;
            if (target instanceof Element) native.elementReplaceChildren.call(target, cleaned);
            else native.fragmentReplaceChildren.call(target, cleaned);
          } else {
            innerHTMLDescriptor.set!.call(this, value);
          }
          stampTree(this);
        },
      },
    };
  }

  const elementOverrides: PropertyDescriptorMap = {
    appendChild: { configurable: true, writable: true, value: makeSingleNodeInsertion(native.appendChild) },
    insertBefore: { configurable: true, writable: true, value: makeSingleNodeInsertion(native.insertBefore) },
    replaceChild: { configurable: true, writable: true, value: boundaryReplaceChild },
    insertAdjacentElement: { configurable: true, writable: true, value: boundaryInsertAdjacentElement },
    append: { configurable: true, writable: true, value: makeMultiNodeInsertion(native.elementAppend) },
    prepend: { configurable: true, writable: true, value: makeMultiNodeInsertion(native.elementPrepend) },
    replaceChildren: {
      configurable: true,
      writable: true,
      value: makeMultiNodeInsertion(native.elementReplaceChildren),
    },
    replaceWith: { configurable: true, writable: true, value: makeMultiNodeInsertion(native.elementReplaceWith) },
    insertAdjacentHTML: {
      configurable: true,
      writable: true,
      value: function boundaryInsertAdjacentHTML(this: Element, position: InsertPosition, text: string) {
        const lowercasePosition = String(position).toLowerCase();
        const outside = lowercasePosition === 'beforebegin' || lowercasePosition === 'afterend';
        const inside = lowercasePosition === 'afterbegin' || lowercasePosition === 'beforeend';
        const parent = this.parentNode;
        // the native method's context and errors, so a policy changes nothing but what is removed:
        // outside the element, its parent is the context, or a <body> when the parent is no element
        const context = inside
          ? this
          : parent instanceof Element
            ? parent
            : this.ownerDocument.createElement('body');
        const cleaned =
          htmlPolicy && (inside || (outside && parent && parent.nodeType !== Node.DOCUMENT_NODE))
            ? htmlPolicy.filter(text, context, 'insertAdjacentHTML')
            : null;
        if (cleaned) {
          if (lowercasePosition === 'beforebegin') native.elementBefore.call(this, cleaned);
          else if (lowercasePosition === 'afterbegin') native.elementPrepend.call(this, cleaned);
          else if (lowercasePosition === 'beforeend') native.elementAppend.call(this, cleaned);
          else native.elementAfter.call(this, cleaned);
        } else {
          // also what throws for an unknown position, or outside an element with no parent
          native.insertAdjacentHTML.call(this, position, text);
        }
        stampTree(inside ? this : this.parentNode ?? this);
      },
    },
    cloneNode: {
      configurable: true,
      writable: true,
      value: function boundaryCloneNode(this: Node, deep?: boolean) {
        const clone = native.cloneNode.call(this, deep);
        inheritProvenance(this, clone, Boolean(deep));
        stampTree(clone);
        return clone;
      },
    },
    ownerDocument: {
      configurable: true,
      enumerable: true,
      get(this: Node) {
        return isInFragmentDom(this) ? realmDocument : native.ownerDocument.call(this);
      },
    },
    getRootNode: {
      configurable: true,
      writable: true,
      value: function boundaryGetRootNode(this: Node, getRootNodeOptions?: GetRootNodeOptions) {
        const plainRoot = native.getRootNode.call(this);
        if (plainRoot === shadowRoot) {
          // nodes in a fragment report the fragment's document as their root
          return realmDocument;
        }
        return getRootNodeOptions ? native.getRootNode.call(this, getRootNodeOptions) : plainRoot;
      },
    },
    ...makeHtmlParsingOverrides(native.elementInnerHTML),
  };

  /**
   * What a URL set from fragment script resolves against, read when it is set: the namespace from
   * the realm's base, and the fragment's own `<base href>` from its markup — the two the gateway
   * uses for the same URL in markup, so markup and script agree on every route.
   */
  const urlBase = (): FragmentUrlBase => ({
    root: fragmentRootOf(realmDocument.baseURI),
    baseHref: braidDocumentElement.querySelector('base[href]')?.getAttribute('href') ?? '/',
  });

  function stampNode(node: Node): void {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (stampedNodes.has(node)) return;

    const proto = Object.getPrototypeOf(node);
    if (proto === null || stampedProtoSet.has(proto)) {
      stampedNodes.add(node);
      return;
    }

    let stampedProto = stampedProtos.get(proto);
    if (!stampedProto) {
      // a subresource URL the fragment's code sets resolves into its namespace, as one in its
      // markup does (see subresource-urls.ts); keyed by prototype, which fixes the element type
      stampedProto = Object.create(proto, {
        ...elementOverrides,
        ...subresourceUrlOverrides(proto, (node as Element).localName, urlBase),
      });
      stampedProtos.set(proto, stampedProto!);
      stampedProtoSet.add(stampedProto!);
    }
    Object.setPrototypeOf(node, stampedProto!);
    stampedNodes.add(node);
  }

  function stampTree(root: Node): void {
    if (root.nodeType === Node.ELEMENT_NODE) {
      stampNode(root);
    } else if (root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }
    (root as Element | DocumentFragment).querySelectorAll('*').forEach(stampNode);
  }

  /**
   * Stamp the shadow root itself with own-property overrides (a shadow root is a per-fragment
   * singleton, so instance properties are simpler than a spliced prototype and just as
   * effective). The shadow root keeps its native `ownerDocument`/`getRootNode` behavior
   * (reporting the main document) — only insertions are intercepted.
   */
  Object.defineProperties(shadowRoot, {
    appendChild: { configurable: true, writable: true, value: makeSingleNodeInsertion(native.appendChild) },
    insertBefore: { configurable: true, writable: true, value: makeSingleNodeInsertion(native.insertBefore) },
    replaceChild: { configurable: true, writable: true, value: boundaryReplaceChild },
    append: { configurable: true, writable: true, value: makeMultiNodeInsertion(native.fragmentAppend) },
    prepend: { configurable: true, writable: true, value: makeMultiNodeInsertion(native.fragmentPrepend) },
    replaceChildren: {
      configurable: true,
      writable: true,
      value: makeMultiNodeInsertion(native.fragmentReplaceChildren),
    },
    ...makeHtmlParsingOverrides(native.shadowRootInnerHTML),
  });

  // stamp the initial fragment DOM (for pierced fragments this includes the SSR'ed content;
  // for slot-fetched fragments this is the already-inserted, neutralized content)
  stampTree(braidDocumentElement);
  // that content is the gateway's: its scripts may run and its inert links are the ones it
  // neutralized, and nothing of the fragment's has run yet to have written any of its own
  markGatewayContent(braidDocumentElement);
  carryProvenanceThroughTemplates(braidDocumentElement);
  // before the observer starts, so moving them out and back is not mistaken for an insertion
  markStartedInPlace(braidDocumentElement);

  /**
   * The boundary observer: activates inert scripts/preload-links that entered the fragment's
   * DOM through unstamped paths, stamps stray subtrees, and reports bypasses in dev mode.
   * Everything it does is idempotent with the synchronous stamped-insertion handling.
   */
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const addedNode of record.addedNodes) {
        if (addedNode.nodeType !== Node.ELEMENT_NODE) continue;
        const addedElement = addedNode as Element;

        if (!stampedNodes.has(addedElement)) {
          if (isDevMode() && !warnedAboutUnstampedEntry) {
            warnedAboutUnstampedEntry = true;
            console.warn(
              `Braid compat: a node entered a fragment's DOM through a code path the fragment boundary doesn't intercept synchronously (e.g. a captured native DOM function).\n` +
                `Scripts inserted this way still execute in the fragment's realm, but one microtask later than usual. Node:`,
              addedElement,
            );
          }
          stampTree(addedElement);
        }

        // scripts that arrived by a path the boundary did not intercept were not marked started
        markStartedInPlace(addedElement);
        activateInertScriptsAndLinks(addedElement);
      }
    }
  });

  function activateInertScriptsAndLinks(root: Element): void {
    const candidates: (HTMLScriptElement | HTMLLinkElement)[] = [];
    if (root.matches(INERT_SELECTOR)) {
      candidates.push(root as HTMLScriptElement | HTMLLinkElement);
    }
    candidates.push(...(root.querySelectorAll(INERT_SELECTOR) as NodeListOf<HTMLScriptElement | HTMLLinkElement>));

    for (const candidate of candidates) {
      // a script that may not run, or a marker Braid did not set, is markup the fragment wrote, and
      // it stays as inert as it would be natively — see `isRunnable`
      if (candidate instanceof HTMLLinkElement ? !isBraidInertLink(candidate) : !isRunnable(candidate)) continue;
      if (candidate instanceof HTMLLinkElement) {
        executeInertPreloadLink(candidate, realmDocument);
      } else {
        if (!candidate.src && !candidate.textContent) {
          // an empty inert script can't execute; leave it be
          continue;
        }
        removeBornInertShadowing(candidate);
        restoreScriptType(candidate);
        executeInertScript(candidate, realmDocument);
      }
    }
  }

  observer.observe(shadowRoot, { childList: true, subtree: true });
  abortSignal.addEventListener('abort', () => observer.disconnect());

  return {
    stampNode,
    stampTree,
    inheritProvenance,
    disconnect: () => observer.disconnect(),
  };
}
