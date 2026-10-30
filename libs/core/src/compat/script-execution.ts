/* eslint-disable @typescript-eslint/no-unsafe-function-type --
 * ported from the matrix-tested web-fragments fork: the deferred-insertion callbacks are
 * arbitrary pre-bound native method wrappers. */
import { assert } from '../utils/assert.js';
import { getInternalReference } from './metadata.js';
import { isRunnable, markRunnable } from './born-inert-scripts.js';

/**
 * Script execution machinery for compat fragments: any script that enters a fragment's DOM is
 * neutralized in the main document (an inert placeholder keeps the DOM shape the app expects)
 * and executed in the fragment's realm instead.
 */

export function compatDomInsertion<T extends Node>(
  nodeToInsert: T,
  doInsertTheNode: Function,
  realmDocument?: Document,
): T {
  // if we are operating outside of a fragment DOM or the appended child is neither an element nor
  // a document fragment (which can carry scripts, e.g. cloned template contents), then just append
  if (!realmDocument || !(nodeToInsert instanceof HTMLElement || nodeToInsert instanceof DocumentFragment)) {
    return doInsertTheNode();
  }

  // if the child's prototype is directly HTMLElement, then check if this is a HTML/BODY/HEAD element and rewrite it
  if (nodeToInsert instanceof HTMLElement && Object.getPrototypeOf(nodeToInsert) === HTMLElement.prototype) {
    patchSpecialHtmlElement(nodeToInsert, realmDocument);
  }

  // if the child is a script, then append and execute it in the fragment's realm
  if (nodeToInsert instanceof HTMLScriptElement) {
    // if the child is an unattached inline script that doesn't yet have any text content, then we need to treat it in a special way
    if (!nodeToInsert.src && !nodeToInsert.firstChild && !nodeToInsert.parentNode && isRunnable(nodeToInsert)) {
      prepareUnattachedInlineScript(nodeToInsert, realmDocument);
      return doInsertTheNode();
    }

    // a script nothing of Braid's or the fragment's own document made: it never runs anywhere
    if (!isRunnable(nodeToInsert)) {
      setInertScriptType(nodeToInsert);
      const returnVal = doInsertTheNode();
      restoreIfDataBlock(nodeToInsert);
      return returnVal;
    }

    setInertScriptType(nodeToInsert);
    const returnVal = doInsertTheNode();
    restoreScriptType(nodeToInsert);
    executeInertScript(nodeToInsert, realmDocument);
    return returnVal;
  }

  // if it's a preload or prefetch link for a script then append it to the realm and leave an inert node in the fragment DOM
  if (
    nodeToInsert instanceof HTMLLinkElement &&
    (nodeToInsert.rel === 'preload' || nodeToInsert.rel === 'prefetch' || nodeToInsert.rel === 'modulepreload')
  ) {
    setInertLinkRel(nodeToInsert);
    const returnVal = doInsertTheNode();
    executeInertPreloadLink(nodeToInsert, realmDocument);
    return returnVal;
  }

  const nestedScriptsAndLinks: NodeListOf<HTMLScriptElement | HTMLLinkElement> = nodeToInsert.querySelectorAll?.(
    'script,link[rel=preload],link[rel=prefetch],link[rel=modulepreload]',
  );

  // if the child doesn't contain nested scripts or links, then just append it
  if (nestedScriptsAndLinks.length === 0) {
    return doInsertTheNode();
  }

  // otherwise, append the child and execute all nested scripts in the fragment's realm
  nestedScriptsAndLinks.forEach((element) => makeElementInert(element));
  const returnVal = doInsertTheNode();
  nestedScriptsAndLinks.forEach((element) => restoreElement(element));
  nestedScriptsAndLinks.forEach((element) => executeElement(element, realmDocument));
  return returnVal;
}

/**
 * Handles a multi-node insertion (append, prepend, replaceChildren, replaceWith) into a fragment
 * DOM.
 *
 * All scripts and preload links across all node arguments are neutralized first, then the actual
 * insertion runs exactly once, and only then are the scripts restored and executed in the
 * fragment's realm, in argument order. (Neutralizing/restoring per-node around a shared deferred
 * insertion would restore earlier scripts to their live form before the insertion actually
 * happens, causing them to execute in the main JS context.)
 */
export function compatMultiNodeDomInsertion(
  nodes: (Node | string)[],
  doInsertTheNodes: () => void,
  realmDocument?: Document,
) {
  if (!realmDocument) {
    return doInsertTheNodes();
  }

  const scriptsAndLinks: (HTMLScriptElement | HTMLLinkElement)[] = [];

  for (const node of nodes) {
    if (typeof node === 'string') {
      console.warn(
        'Braid compat: string arguments to append/prepend/replaceChildren/replaceWith are not supported and could result in incorrect script execution. Inserted string: ',
        node,
      );
      continue;
    }

    if (node instanceof HTMLElement && Object.getPrototypeOf(node) === HTMLElement.prototype) {
      patchSpecialHtmlElement(node, realmDocument);
    }

    if (node instanceof HTMLScriptElement) {
      if (!node.src && !node.firstChild && !node.parentNode && isRunnable(node)) {
        prepareUnattachedInlineScript(node, realmDocument);
      } else {
        scriptsAndLinks.push(node);
      }
    } else if (
      node instanceof HTMLLinkElement &&
      (node.rel === 'preload' || node.rel === 'prefetch' || node.rel === 'modulepreload')
    ) {
      scriptsAndLinks.push(node);
    } else if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      const nested: NodeListOf<HTMLScriptElement | HTMLLinkElement> | undefined = (
        node as Element | DocumentFragment
      ).querySelectorAll?.('script,link[rel=preload],link[rel=prefetch],link[rel=modulepreload]');
      nested?.forEach((element) => scriptsAndLinks.push(element));
    }
  }

  scriptsAndLinks.forEach((element) => makeElementInert(element));
  doInsertTheNodes();
  scriptsAndLinks.forEach((element) => restoreElement(element));
  scriptsAndLinks.forEach((element) => executeElement(element, realmDocument));
}

function makeElementInert(element: HTMLScriptElement | HTMLLinkElement) {
  if (element instanceof HTMLScriptElement) {
    setInertScriptType(element);
  } else {
    setInertLinkRel(element);
  }
}

function restoreElement(element: HTMLScriptElement | HTMLLinkElement) {
  if (element instanceof HTMLScriptElement) {
    if (isRunnable(element)) restoreScriptType(element);
    else restoreIfDataBlock(element);
  } else {
    // don't restore links as we currently don't have another way of keeping them inert
  }
}

function executeElement(element: HTMLScriptElement | HTMLLinkElement, realmDocument: Document) {
  if (element instanceof HTMLScriptElement) {
    executeInertScript(element, realmDocument);
  } else {
    executeInertPreloadLink(element, realmDocument);
  }
}

/**
 * Activates the initial content of a fragment: patches braid-html/head/body stand-ins and
 * executes every neutralized script/preload-link in document order in the fragment's realm.
 *
 * Used for both server-pierced content and content fetched client-side by the slot (which the
 * compat adapter neutralizes before insertion).
 */
export function executeScriptsInFragmentContent(contentRoot: ParentNode, realmDocument: Document) {
  // In addition to executing scripts, we also need to patch braid- tags if they are present so
  // that the scripts see them without the prefix.
  [...contentRoot.querySelectorAll('braid-html, braid-body, braid-head')].forEach((element) =>
    patchSpecialHtmlElement(element, realmDocument),
  );

  const scriptsAndLinks = [
    ...contentRoot.querySelectorAll(
      'link[rel=inert-preload],link[rel=inert-prefetch],link[rel=inert-modulepreload],script',
    ),
  ] as (HTMLLinkElement | HTMLScriptElement)[];

  scriptsAndLinks.forEach((inertElement) => {
    if (inertElement instanceof HTMLLinkElement) {
      executeInertPreloadLink(inertElement, realmDocument);
    } else {
      restoreScriptType(inertElement);
      executeInertScript(inertElement, realmDocument);
    }
  });
}

/**
 * Weak map of scripts running in the realm to their inert clones in the fragment DOM.
 */
export const execToInertScriptMap = new WeakMap<HTMLScriptElement, HTMLScriptElement>();
export const alreadyExecutedScriptsAndLinks = new WeakSet<HTMLScriptElement | HTMLLinkElement>();

/**
 * Executes a script in the fragment's realm.
 * @param inertScript inert script already appended to a document within the fragment DOM
 * @param realmDocument realm document in which the script should execute
 * @returns true if the script executed, false if it was ignored
 */
export function executeInertScript(inertScript: HTMLScriptElement, realmDocument: Document): boolean {
  // If the inert script has already been evaluated but later re-added to the DOM via any DOM
  // insertion method (i.e. insertBefore() and appendChild()), do not evaluate the script again
  if (alreadyExecutedScriptsAndLinks.has(inertScript)) {
    return false;
  }

  // nor one that was never Braid's or the fragment's own to run (see `isRunnable`)
  if (!isRunnable(inertScript)) {
    return false;
  }

  // If the script does not have a valid type attribute, treat the script node as a data block.
  // Data blocks live in the main document as-is.
  if (!EXECUTABLE_TYPES.includes(inertScript.getAttribute('type'))) {
    return false;
  }

  assert(!!(inertScript.src || inertScript.textContent), `Can't execute script without src or textContent!`);

  attachScriptToRealm({ inertScript, realmDocument });

  return true;
}

export function executeInertPreloadLink(inertLink: HTMLLinkElement, realmDocument: Document): boolean {
  // If the inert link has already been evaluated but later re-added to the DOM via any DOM
  // insertion method, do not evaluate the link again
  if (alreadyExecutedScriptsAndLinks.has(inertLink)) {
    return false;
  }

  // If the link does not have a valid href attribute then skip
  if (!inertLink.href) return false;

  const execLink = realmDocument.importNode(inertLink, true);
  restoreLinkRel(execLink);

  // Grab the Event constructor from the realm
  const Event = realmDocument.defaultView!.Event;

  // Redispatch the load event onto the inert link in the fragment DOM
  execLink.addEventListener('load', () => {
    inertLink.dispatchEvent(new Event('load', { cancelable: false }));
  });

  // Redispatch the error event onto the inert link in the fragment DOM
  execLink.addEventListener('error', () => {
    inertLink.dispatchEvent(new Event('error', { cancelable: false }));
  });

  getInternalReference(realmDocument, 'body').appendChild(execLink);
  alreadyExecutedScriptsAndLinks.add(inertLink);

  return true;
}

/**
 * Attaches exec scripts to the realm and keeps a record of already evaluated scripts.
 * @param inertScript inert script already appended to a document within the fragment DOM
 * @param execScript exec script to be attached to the realm document
 * @param realmDocument realm document in which the script should execute
 */
export function attachScriptToRealm({
  inertScript,
  execScript,
  realmDocument,
}: {
  inertScript: HTMLScriptElement;
  execScript?: HTMLScriptElement;
  realmDocument: Document;
}) {
  if (!execScript) {
    // Build a FRESH script element rather than cloning: a script that descends from a parser
    // document (DOMParser, fragment parsing) carries the spec's "already started" flag, and
    // cloning preserves the flag — a clone would silently never execute.
    //
    // The fresh element must be created realm-side with the realm document's NATIVE
    // createElement: the facade virtualizes `realmDocument.createElement` into the main
    // document, and a script adopted across documents does not execute.
    execScript = Document.prototype.createElement.call(realmDocument, 'script') as HTMLScriptElement;
    for (const attribute of inertScript.attributes) {
      execScript.setAttribute(attribute.name, attribute.value);
    }
    execScript.textContent = inertScript.textContent;
  }

  // the following line will append the executable script to the realm
  // - inline scripts (script with textContent) will be executed synchronously when attached
  // - external scripts (with src attribute) will execute once the current turn of the event loop unwinds
  execToInertScriptMap.set(execScript, inertScript);

  // redispatch the load event onto the inert script in the fragment DOM
  execScript.addEventListener('load', () => {
    inertScript.dispatchEvent(new Event('load', { cancelable: false }));
  });

  // redispatch the error event onto the inert script in the fragment DOM
  execScript.addEventListener('error', () => {
    inertScript.dispatchEvent(new Event('error', { cancelable: false }));
  });

  getInternalReference(realmDocument, 'body').appendChild(execScript);
  alreadyExecutedScriptsAndLinks.add(inertScript);
}

/**
 * The preload links Braid itself made inert (`rel="inert-*"`), and so may bring back to life. A link
 * the fragment's markup wrote with that rel is a forgery of the marker: natively it does nothing,
 * and here it stays that way. Scripts are decided by provenance instead — see `isRunnable`.
 */
const braidInertLinks = new WeakSet<HTMLLinkElement>();

export function isBraidInertLink(link: HTMLLinkElement): boolean {
  return braidInertLinks.has(link);
}

export function markBraidInertLink(link: HTMLLinkElement): void {
  braidInertLinks.add(link);
}

export { isRunnable, markRunnable };

/** The marker selector: what Braid neutralizes, and the gateway too. */
export const INERT_SELECTOR =
  'script[type="inert"],link[rel="inert-preload"],link[rel="inert-prefetch"],link[rel="inert-modulepreload"]';

/**
 * Marks the gateway's prepared content under `root` as Braid's: its scripts may run, its inert links
 * may be revived. Template contents included, which a selector does not enter.
 */
export function markGatewayContent(root: ParentNode): void {
  const roots: ParentNode[] = [root];
  while (roots.length) {
    const current = roots.pop()!;
    current.querySelectorAll('script').forEach((script) => markRunnable(script as HTMLScriptElement));
    current.querySelectorAll('link[rel^="inert-"]').forEach((link) => markBraidInertLink(link as HTMLLinkElement));
    current.querySelectorAll('template').forEach((template) => roots.push((template as HTMLTemplateElement).content));
  }
}

/**
 * Set the type attribute of a script element to "inert".
 *
 * This prevents the script from executing in the main JS context when the script is attached to
 * the main document.
 */
export function setInertScriptType(script: HTMLScriptElement) {
  const scriptType = script.type;
  if (scriptType) {
    script.setAttribute('data-script-type', scriptType);
  }
  script.setAttribute('type', 'inert');
}

/** Types the realm runs; anything else is a data block, which runs nowhere. */
const EXECUTABLE_TYPES = ['module', 'text/javascript', 'importmap', 'speculationrules', '', null];

/**
 * A script that will never run is left neutralized after insertion — unless it is a data block
 * (`application/json`, say), whose real type is restored: it runs nowhere either way, and code that
 * finds it by type must still find it.
 */
function restoreIfDataBlock(script: HTMLScriptElement): void {
  if (!EXECUTABLE_TYPES.includes(script.getAttribute('data-script-type'))) restoreScriptType(script);
}

/**
 * Restore the original script type and erase any signs of us making the script inert.
 */
export function restoreScriptType(script: HTMLScriptElement) {
  const scriptType = script.getAttribute('data-script-type');
  script.removeAttribute('data-script-type');
  script.removeAttribute('type');
  if (scriptType) {
    script.setAttribute('type', scriptType);
  }
}

/**
 * Neutralizes the original link, so that it doesn't result in a duplicate network call.
 */
export function setInertLinkRel(link: HTMLLinkElement) {
  const linkRel = link.rel;
  if (linkRel) {
    link.rel = 'inert-' + linkRel;
    markBraidInertLink(link);
  }
}

/**
 * Reverses the `setInertLinkRel` operation.
 */
function restoreLinkRel(link: HTMLLinkElement) {
  const linkRel = link.rel;
  if (linkRel && linkRel.startsWith('inert-')) {
    // strip the 'inert-' prefix
    link.rel = linkRel.slice(6);
  }
}

/**
 * Inline scripts that do not have textContent set are not evaluated until the first time
 * textContent is set.
 *
 * We prepare these scripts for future execution by:
 * - appending a non-neutralized clone of the script to the realm document
 * - neutralizing the original script so that it doesn't execute in the main JS context in the future
 * - patching the script's appendChild method to also append to the clone which will execute the
 *   script in the fragment's realm
 *
 * If text content is added later, the script then executes in the fragment's realm.
 */
function prepareUnattachedInlineScript(script: HTMLScriptElement, realmDocument: Document) {
  // We must clone the script before neutralizing it, otherwise the clone will also be neutralized
  const execScript = realmDocument.importNode(script, true);
  const inertScript = script;

  // neutralize the script so that it doesn't execute in the main JS context
  inertScript.textContent = '//inert';
  document.body.appendChild(inertScript);

  // now restore the inert script so the code using it doesn't see what we did
  inertScript.remove();
  inertScript.firstChild!.remove();

  // We have already cloned the inertScript so we don't need to clone it again.
  // Cloning again would cause the execScript to be neutralized.
  attachScriptToRealm({ inertScript, execScript, realmDocument });

  const origScriptAppendChild = inertScript.appendChild;
  inertScript.appendChild = function (node) {
    origScriptAppendChild.call(inertScript, node);
    execScript.appendChild.call(execScript, realmDocument.importNode(node, true));
    // restore appendChild since only the first invocation should execute a script
    inertScript.appendChild = origScriptAppendChild;
    return node;
  };
}

/**
 * Rewrite the tagName for the special braid-* stand-in elements so fragment code sees plain
 * HTML/HEAD/BODY, and map their sizing reads onto the host page's real elements.
 */
let lazyBraidCustomElements: Map<string, Element> | undefined;

function getBraidCustomElements(): Map<string, Element> {
  lazyBraidCustomElements ??= new Map([
    ['BRAID-HTML', document.documentElement],
    ['BRAID-HEAD', document.head],
    ['BRAID-BODY', document.body],
  ]);
  return lazyBraidCustomElements;
}

export function patchSpecialHtmlElement(node: Element, realmDocument: Document) {
  const originalTagName = node.tagName;
  const mappedElement = getBraidCustomElements().get(originalTagName);
  if (mappedElement) {
    Object.defineProperties(node, {
      clientWidth: {
        get() {
          return mappedElement.clientWidth;
        },
      },
      clientHeight: {
        get() {
          return mappedElement.clientHeight;
        },
      },
      nodeName: {
        get() {
          return originalTagName.replace(/^BRAID-/i, '');
        },
      },
      tagName: {
        get() {
          return originalTagName.replace(/^BRAID-/i, '');
        },
      },
    });

    // if the node is BRAID-HEAD, we are done
    if (node.tagName === 'HEAD') {
      return;
    }

    // otherwise we need to patch addEventListener and removeEventListener to support retargeting
    // to the main <html> and <body> elements
    node.addEventListener = realmDocument.addEventListener;
    node.removeEventListener = realmDocument.removeEventListener;
  }
}
