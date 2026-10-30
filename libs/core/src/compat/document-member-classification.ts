/**
 * Classification of the Document API surface for compat fragment contexts (the WebIDL audit
 * manifest for the document facade).
 *
 * Every entry records the result of auditing a Document member for use by application code
 * running inside a compat fragment:
 *
 * - `'virtualized'` — the member is reimplemented by the document facade (see
 *   `document-overrides.ts`) so that it operates on the fragment's DOM in the main document
 *   (shadow root / `<braid-document>`) instead of the fragment's hidden realm iframe document.
 *
 * - `'native'` — the member was audited and the realm document's native behavior is the desired
 *   behavior for fragments, so it intentionally passes through the facade untouched.
 *
 * Spec-defined Document members absent from this map have not been audited yet. They pass
 * through to the realm document's native behavior, and the facade logs a dev-mode diagnostic
 * when a fragment uses them, so unaudited API usage surfaces during development instead of
 * failing silently — and feeds the compat fidelity telemetry the architecture calls for.
 *
 * Members inherited from Node and EventTarget always pass through silently — DOM tree traversal
 * and event dispatch are virtualized at other layers (the fragment boundary and the event
 * system patches in `realm-patches.ts`).
 *
 * Note: `location` is a [LegacyUnforgeable] own property of the document instance and can never
 * be intercepted via the prototype chain, so it is intentionally not classified here. The compat
 * realm iframe's `src` is set to the fragment's url, which makes the realm's native
 * `document.location` correct for fragments.
 */
export type DocumentMemberClassification = 'virtualized' | 'native';

export const documentMemberClassification: Readonly<Record<string, DocumentMemberClassification>> = {
  // --- virtualized: reimplemented against the fragment's DOM in the main document ---

  // document metadata and state
  title: 'virtualized',
  readyState: 'virtualized',
  currentScript: 'virtualized',
  activeElement: 'virtualized',

  // styles
  styleSheets: 'virtualized',
  adoptedStyleSheets: 'virtualized',

  // document tree accessors (html/head/body are represented by braid-html/braid-head/braid-body custom elements)
  documentElement: 'virtualized',
  head: 'virtualized',
  body: 'virtualized',
  children: 'virtualized',
  childElementCount: 'virtualized',
  firstElementChild: 'virtualized',
  lastElementChild: 'virtualized',
  firstChild: 'virtualized',
  lastChild: 'virtualized',
  hasChildNodes: 'virtualized',

  // querying
  querySelector: 'virtualized',
  querySelectorAll: 'virtualized',
  getElementById: 'virtualized',
  getElementsByClassName: 'virtualized',
  getElementsByName: 'virtualized',
  getElementsByTagName: 'virtualized',
  getElementsByTagNameNS: 'virtualized',

  // event dispatch (listeners registered via addEventListener are retargeted by the event system patches)
  dispatchEvent: 'virtualized',

  // node creation (nodes must be created in the main document so they can be attached to the fragment's DOM)
  createElement: 'virtualized',
  createElementNS: 'virtualized',
  createAttributeNS: 'virtualized',
  createCDATASection: 'virtualized',
  createComment: 'virtualized',
  createDocumentFragment: 'virtualized',
  createEvent: 'virtualized',
  createExpression: 'virtualized',
  createNSResolver: 'virtualized',
  createNodeIterator: 'virtualized',
  createProcessingInstruction: 'virtualized',
  createRange: 'virtualized',
  createTextNode: 'virtualized',
  createTreeWalker: 'virtualized',
  // the realm is same-origin, so it shares the cookie jar; a partitioned fragment (capabilities.storage)
  // gets a scoped view of it instead (cookie-partition.ts), and a shared one the native jar
  cookie: 'virtualized',

  // --- native: audited, the realm document's native behavior is correct for fragments ---

  // fragments must see the fragment's window (the realm iframe's window), not the main window
  defaultView: 'native',

  // the realm iframe's src is set to the fragment's url, so url-related members are correct natively
  URL: 'native',
  documentURI: 'native',

  // document encoding/mode metadata of the realm document matches a standard html document
  compatMode: 'native',
  characterSet: 'native',
  charset: 'native',
  inputEncoding: 'native',
  contentType: 'native',

  // importNode deliberately creates nodes in the fragment's realm (used by the script execution machinery)
  importNode: 'native',
};
