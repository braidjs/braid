/**
 * Born-inert scripts.
 *
 * Every script element created by fragment code (via the document facade's
 * `createElement`/`createElementNS`) is neutralized at creation: its `type` attribute is set to
 * `inert` before fragment code can attach content or insert it. This guarantees that no script
 * reachable by fragment code can ever execute in the main JS context, no matter how it is
 * inserted — even through code paths the boundary does not intercept synchronously.
 *
 * So that fragment code doesn't observe the neutralization, the script's `type` property and its
 * `getAttribute`/`setAttribute` methods are shadowed to read and write the real type from/to the
 * `data-script-type` attribute (the same attribute the gateway uses when neutralizing SSR
 * content). The shadowing own-properties are removed before the script is activated.
 */

const nativeSetAttribute = Element.prototype.setAttribute;
const nativeGetAttribute = Element.prototype.getAttribute;
const nativeRemoveAttribute = Element.prototype.removeAttribute;

const bornInertScripts = new WeakSet<HTMLScriptElement>();

/**
 * The scripts that may run in a fragment's realm at all: provenance, not markers.
 *
 * A marker — `type="inert"`, `data-script-type` — is an attribute, and markup can forge attributes.
 * And a `<script>` that markup produced through any parser sink (`innerHTML`, `outerHTML`,
 * `setHTMLUnsafe`, a template's content, `DOMParser`) is one the browser never runs. So a script
 * runs only if one of these made it:
 *
 * - the fragment's own `document.createElement('script')`, which makes it born inert;
 * - the gateway, whose prepared content is in the fragment's DOM when its boundary is created;
 * - a clone, through the boundary, of one of these that has not run yet.
 *
 * Everything else stays neutralized, however it reaches the DOM. Membership outlives the born-inert
 * shadowing, which is removed when the script is activated.
 */
const runnableScripts = new WeakSet<HTMLScriptElement>();

export function markRunnable(script: HTMLScriptElement): void {
  runnableScripts.add(script);
}

export function isRunnable(script: HTMLScriptElement): boolean {
  return runnableScripts.has(script);
}

export function makeScriptBornInert(script: HTMLScriptElement): void {
  nativeSetAttribute.call(script, 'type', 'inert');
  bornInertScripts.add(script);
  runnableScripts.add(script);
  shadowType(script);
}

/**
 * Keeps a script in the host document inert for good: after its copy has run in the realm, or when
 * it may never run at all. Its `type` attribute stays `inert`, and its real type is what `type`,
 * `getAttribute('type')` and friends report and change, as for a born-inert script.
 *
 * Why not restore the real type: the host element was inserted while inert, so the browser never
 * marked it started. With a live type, the next time it became connected — the host moving the
 * slot, a keyed list reordering, a portal — the browser would prepare and run it, natively, in the
 * host window. Kept inert, there is nothing for the browser to run, however it is moved or changed.
 */
export function keepInert(script: HTMLScriptElement): void {
  const current = nativeGetAttribute.call(script, 'type');
  if (current !== 'inert') {
    if (current === null) nativeRemoveAttribute.call(script, 'data-script-type');
    else nativeSetAttribute.call(script, 'data-script-type', current);
    nativeSetAttribute.call(script, 'type', 'inert');
  }
  shadowType(script);
}

/** Reads and writes of `type` go to `data-script-type`, so the element itself stays inert. */
function shadowType(script: HTMLScriptElement): void {
  Object.defineProperties(script, {
    type: {
      configurable: true,
      enumerable: true,
      get() {
        return nativeGetAttribute.call(this, 'data-script-type') ?? '';
      },
      set(value: string) {
        nativeSetAttribute.call(this, 'data-script-type', String(value));
      },
    },
    setAttribute: {
      configurable: true,
      writable: true,
      value: function setAttribute(name: string, value: string) {
        return nativeSetAttribute.call(this, String(name).toLowerCase() === 'type' ? 'data-script-type' : name, value);
      },
    },
    getAttribute: {
      configurable: true,
      writable: true,
      value: function getAttribute(name: string) {
        return nativeGetAttribute.call(this, String(name).toLowerCase() === 'type' ? 'data-script-type' : name);
      },
    },
    removeAttribute: {
      configurable: true,
      writable: true,
      value: function removeAttribute(name: string) {
        return nativeRemoveAttribute.call(this, String(name).toLowerCase() === 'type' ? 'data-script-type' : name);
      },
    },
  });
}

export function isBornInertScript(script: HTMLScriptElement): boolean {
  return bornInertScripts.has(script);
}

/**
 * Removes the type-shadowing own-properties, leaving the script in the standard inert form
 * (`type="inert"` plus the real type in `data-script-type`) that the script execution machinery
 * understands. Used on the asynchronous (boundary observer) activation path, where the script is
 * already attached to the fragment's DOM in inert form.
 */
export function removeBornInertShadowing(script: HTMLScriptElement): void {
  if (!bornInertScripts.has(script)) return;
  delete (script as any).type;
  delete (script as any).setAttribute;
  delete (script as any).getAttribute;
  delete (script as any).removeAttribute;
  bornInertScripts.delete(script);
  // A script whose own code set its type to `inert` (a library copying attributes from a script it
  // found) is a data block that only looks like Braid's marker: it never runs, as natively.
  if (nativeGetAttribute.call(script, 'data-script-type')?.trim().toLowerCase() === 'inert') runnableScripts.delete(script);
}

/**
 * Fully reverts a born-inert script to the live form the application intended (real `type`
 * attribute, no `data-script-type`). Used on the synchronous (stamped insertion) activation
 * path, which re-neutralizes the script itself before performing the actual DOM insertion — the
 * script is never attached to the DOM in live form.
 */
export function unwrapBornInertScriptToLive(script: HTMLScriptElement): void {
  if (!bornInertScripts.has(script)) return;
  removeBornInertShadowing(script);
  const realType = nativeGetAttribute.call(script, 'data-script-type');
  nativeRemoveAttribute.call(script, 'data-script-type');
  if (realType) {
    nativeSetAttribute.call(script, 'type', realType);
  } else {
    nativeRemoveAttribute.call(script, 'type');
  }
}
