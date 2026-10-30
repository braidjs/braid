import { rewriteQuerySelector } from '../utils/selector-helpers.js';
import { FacadeOverrides } from './document-facade.js';
import { nativeCookieAccessor, type CookieAccessor } from './cookie-partition.js';

/**
 * Hooks provided by the fragment boundary. Nodes created via the facade are stamped with the
 * fragment's boundary prototype, and scripts are neutralized at creation ("born inert").
 */
export interface DocumentBoundaryHooks {
  stampNode(node: Node): void;
  makeScriptBornInert(script: HTMLScriptElement): void;
}

/**
 * Everything the document overrides need from the surrounding compat context.
 *
 * All dependencies are injected so that this module stays free of imports with side effects and
 * can be exercised by unit tests outside of a browser.
 */
/** The realm document's native `cookie` accessor, if the engine has one where we can find it. */
function findNativeCookie(realmDocument: Document): CookieAccessor | null {
  try {
    return nativeCookieAccessor(realmDocument);
  } catch {
    return null;
  }
}

export interface DocumentOverridesContext {
  /** The document of the fragment's hidden realm iframe. */
  realmDocument: Document;
  /** The main frame's document which owns the fragment's DOM. */
  mainDocument: Document;
  /** The `<braid-document>` element that acts as the fragment's virtual document element in the main DOM. */
  braidDocumentElement: HTMLElement;
  /** The shadow root of the `<fragment-slot>` element that contains the fragment's DOM. */
  fragmentShadowRoot: ShadowRoot;
  /** Whether the fragment's navigation is bound to the main window's navigation. */
  boundNavigation: boolean;
  /** Returns the virtualized readyState of the fragment's document. */
  getRealmDocumentReadyState: () => DocumentReadyState;
  /** Returns the inert clone (in the main DOM) of the script currently executing in the fragment's realm. */
  getCurrentScript: () => HTMLScriptElement | undefined;
  /** Boundary hooks; absent only in unit tests that exercise the overrides in isolation. */
  boundary?: DocumentBoundaryHooks;
  /**
   * `document.cookie` for a partitioned fragment (cookie-partition.ts). Absent for a shared one,
   * which reads and writes the origin's jar natively.
   */
  cookie?: CookieAccessor;
}

/**
 * Creates the facade overrides that virtualize the Document API surface for a compat fragment.
 *
 * Each override redirects a Document member to operate on the fragment's DOM in the main
 * document (the shadow root of `<fragment-slot>` and its `<braid-document>` element) instead of
 * the hidden realm's document.
 *
 * Every member overridden here must be classified as `'virtualized'` in
 * `document-member-classification.ts`.
 */
export function createDocumentOverrides(ctx: DocumentOverridesContext): FacadeOverrides {
  const { realmDocument, mainDocument, braidDocumentElement, fragmentShadowRoot, boundNavigation } = ctx;

  /**
   * Elements created via the facade enter the fragment boundary at birth: scripts are
   * neutralized before fragment code can arm them, and every created element is stamped so that
   * operations on it are intercepted at the boundary rather than via global patches.
   */
  function admitCreatedElement<T extends Element>(element: T): T {
    if (ctx.boundary) {
      if (element instanceof HTMLScriptElement) {
        ctx.boundary.makeScriptBornInert(element);
      }
      ctx.boundary.stampNode(element);
    }
    return element;
  }

  // the realm is same-origin, so the native accessor is the host origin's jar; captured before the
  // facade swaps the document's prototype, which is the only reason it is an override at all
  const nativeCookie = ctx.cookie ? null : findNativeCookie(realmDocument);

  return {
    cookie: {
      get: () => (ctx.cookie ? ctx.cookie.get() : (nativeCookie?.get() ?? '')),
      set: (value: string) => (ctx.cookie ? ctx.cookie.set(value) : nativeCookie?.set(value)),
    },

    title: {
      get: function () {
        return (
          // https://html.spec.whatwg.org/multipage/dom.html#document.title
          braidDocumentElement.querySelector('title')?.textContent?.trim() ?? '[braid fragment document]'
        );
      },
      set: function (newTitle: string) {
        const titleElement = braidDocumentElement.querySelector('title');
        if (titleElement) {
          titleElement.textContent = newTitle;
        }
        if (boundNavigation) {
          mainDocument.title = newTitle;
        }
      },
    },

    readyState: {
      get() {
        return ctx.getRealmDocumentReadyState();
      },
    },

    currentScript: {
      get() {
        return ctx.getCurrentScript();
      },
    },

    // redirect getElementById to be a scoped braidDocumentElement.querySelector query
    getElementById: {
      value(id: string) {
        return braidDocumentElement.querySelector(`[id="${id}"]`);
      },
    },

    getElementsByClassName: {
      value(names: string) {
        return braidDocumentElement.getElementsByClassName(names);
      },
    },

    getElementsByName: {
      value(name: string) {
        return braidDocumentElement.querySelector(`[name="${name}"]`);
      },
    },

    getElementsByTagNameNS: {
      value(namespaceURI: string | null, name: string) {
        return braidDocumentElement.getElementsByTagNameNS(namespaceURI, name);
      },
    },

    // redirect to mainDocument
    activeElement: {
      get: () => {
        return (
          fragmentShadowRoot.activeElement ??
          (mainDocument.activeElement === mainDocument.body ? realmDocument.body : null)
        );
      },
    },

    styleSheets: {
      get: () => {
        return fragmentShadowRoot.styleSheets;
      },
    },

    adoptedStyleSheets: {
      get() {
        return fragmentShadowRoot.adoptedStyleSheets;
      },
      set(value: CSSStyleSheet[]) {
        fragmentShadowRoot.adoptedStyleSheets = value;
      },
    },

    dispatchEvent: {
      value(event: Event) {
        return braidDocumentElement.dispatchEvent(event);
      },
    },

    childElementCount: {
      get() {
        return braidDocumentElement.childElementCount;
      },
    },

    hasChildNodes: {
      value() {
        return braidDocumentElement.hasChildNodes();
      },
    },

    children: {
      get() {
        return braidDocumentElement.children;
      },
    },

    firstElementChild: {
      get() {
        return braidDocumentElement.firstElementChild;
      },
    },

    firstChild: {
      get() {
        return braidDocumentElement.firstChild;
      },
    },

    lastElementChild: {
      get() {
        return braidDocumentElement.lastElementChild;
      },
    },

    lastChild: {
      get() {
        return braidDocumentElement.lastChild;
      },
    },

    /**
     * The following properties are references to special elements in a Document (html, head,
     * body). The browser does not allow multiple instances of these elements within a Document,
     * so we cannot render true <html>, <head>, <body> elements within the shadow root of a
     * fragment.
     *
     * Instead, render custom elements (braid-html, braid-head, braid-body) that act like the
     * html, head, and body. The tagName and nodeName properties of these custom elements are
     * then patched to return "HTML", "HEAD", and "BODY", respectively.
     *
     * CSS selector queries that contain html/head/body tag selectors are rewritten to the
     * custom elements.
     */
    querySelector: {
      value(selector: string) {
        return braidDocumentElement.querySelector(rewriteQuerySelector(selector));
      },
    },
    querySelectorAll: {
      value(selector: string) {
        return braidDocumentElement.querySelectorAll(rewriteQuerySelector(selector));
      },
    },
    getElementsByTagName: {
      value(tagName: string) {
        // The shadowRoot node itself does not have a getElementsByTagName method.
        // For html, head, and body, rely on the rewritten querySelectorAll query.
        // This will return a NodeList instead of an HTMLCollection, which will suffice for most use cases.
        return braidDocumentElement.querySelectorAll(rewriteQuerySelector(tagName));
      },
    },
    documentElement: {
      get() {
        return braidDocumentElement.querySelector('braid-html') ?? braidDocumentElement.firstElementChild;
      },
    },
    head: {
      get() {
        return braidDocumentElement.querySelector('braid-head') ?? braidDocumentElement.firstElementChild;
      },
    },
    body: {
      get() {
        return braidDocumentElement.querySelector('braid-body') ?? braidDocumentElement.firstElementChild;
      },
    },

    // document.createElement & friends overrides: nodes must be created in the main document
    // so that they can be attached to the fragment's DOM without adoption
    ...Object.fromEntries(
      (
        [
          'createAttributeNS',
          'createCDATASection',
          'createComment',
          'createDocumentFragment',
          'createEvent',
          'createExpression',
          'createNSResolver',
          'createNodeIterator',
          'createProcessingInstruction',
          'createRange',
          'createTextNode',
          'createTreeWalker',
        ] as const
      ).map((createProperty) => [
        createProperty,
        {
          value: function compatCreateFn(...args: unknown[]) {
            return (mainDocument[createProperty] as (...args: unknown[]) => unknown).apply(mainDocument, args);
          },
        },
      ]),
    ),

    createElement: {
      value: function createElement(...[tagName, ...rest]: Parameters<Document['createElement']>) {
        const element = Document.prototype.createElement.apply(
          // create the element within the realm document if it contains a dash as it could be a
          // custom element defined only in the fragment's realm
          tagName.includes('-') ? realmDocument : mainDocument,
          [tagName, ...rest],
        );
        return admitCreatedElement(element);
      },
    },
    createElementNS: {
      value: function createElementNS(...[namespaceURI, tagName, ...rest]: Parameters<Document['createElementNS']>) {
        const element = Document.prototype.createElementNS.apply(
          // create the element within the realm document if it contains a dash as it could be a
          // custom element defined only in the fragment's realm
          namespaceURI === 'http://www.w3.org/1999/xhtml' && tagName.includes('-') ? realmDocument : mainDocument,
          [namespaceURI, tagName, ...rest] as Parameters<Document['createElementNS']>,
        );
        return admitCreatedElement(element as Element);
      },
    },
  } satisfies Partial<Record<keyof Document, unknown>> as FacadeOverrides;
}
