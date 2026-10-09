import { AdapterBootContext, InstalledAdapter } from './adapter.js';
import { CompatShadowRoot, compatMetadataSymbol } from '../compat/metadata.js';
import { initializeRealmContext } from '../compat/realm-patches.js';
import { executeScriptsInFragmentContent } from '../compat/script-execution.js';
import { isDevMode } from '../config.js';

/**
 * The compat adapter — the emulation layer, contained.
 *
 * For apps that cannot be told anything (the legacy monolith mid-migration), this adapter
 * provides the full web-fragments-style illusion: the fragment's code believes it owns the whole
 * browser, while its DOM lives in the host page's shadow root and its JS runs in a hidden
 * same-origin realm iframe. All interception is confined to the fragment's own realm and
 * boundary; the host page is never patched.
 *
 * This is the only adapter shipped in this build, and the default (see `DEFAULT_ADAPTER`):
 * a manifest that doesn't declare an adapter gets this one, so being a fragment requires zero
 * app-code changes — config only.
 */
export const compatAdapter: InstalledAdapter = {
  name: 'compat',
  realmKind: 'compat-http',

  async boot(ctx: AdapterBootContext): Promise<void> {
    const { fragmentId, shadowRoot, contentRoot, realm, html, pierced, bound, signal } = ctx;

    const fragmentShadowRoot = Object.assign(shadowRoot, {
      [compatMetadataSymbol]: { documentReadyState: 'loading' as DocumentReadyState },
    }) as CompatShadowRoot;

    if (!pierced) {
      // The gateway prepared this markup exactly as it prepares pierced content — singletons
      // renamed, scripts neutralized, subresource URLs re-rooted — so the client only has to
      // parse it. Re-applying those transforms here would be actively harmful: neutralizing an
      // already-inert script would record `inert` as its "real" type and it would never run.
      const content = parseFragmentContent(html ?? '', contentRoot.ownerDocument);

      // Insert the (fully inert) content before the boundary exists; the boundary stamps the
      // whole tree when it is created below — same order as the pierced flow.
      contentRoot.appendChild(content);
    }

    // The abort controller tears down every listener/observer the compat machinery installs;
    // it aborts when the fragment unmounts (slot disconnect) or the realm unloads.
    const fragmentAbortController = new AbortController();
    signal.addEventListener('abort', () => fragmentAbortController.abort(), { once: true });

    // Install the full compat illusion onto the realm (window patches, document facade,
    // boundary stamping, born-inert scripts).
    const realmContext = initializeRealmContext(
      realm,
      fragmentShadowRoot,
      contentRoot,
      bound,
      fragmentAbortController,
    );

    // Now activate the fragment's scripts, in document order, in the realm's JS context.
    executeScriptsInFragmentContent(contentRoot, realm.document);

    // The fragment's own code has run, so its router has resolved whatever initial route it was
    // going to resolve. From here a navigation is the user's, and a bound fragment may drive the
    // host URL with it.
    realmContext.bootComplete();

    // Replicate the document lifecycle the fragment would observe standalone.
    fragmentShadowRoot[compatMetadataSymbol].documentReadyState = 'interactive';
    contentRoot.dispatchEvent(new Event('readystatechange', { bubbles: false, cancelable: false }));
    contentRoot.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: false }));

    // The window load event waits for the fragment's images, as a standalone document's would. By
    // now all styles and scripts have loaded, so images are the main kind of resource to wait for.
    //
    // Not awaited: boot is done once the fragment's code has run, and the slot reports ready on
    // boot. Holding that for every image — a hero banner, or a lazy one that may never load —
    // delays readiness for something the fragment observes on its own timeline anyway.
    void imagesSettled(contentRoot).then(() => {
      // Wrap the event into a task so we don't execute too early in case there are no images.
      setTimeout(() => {
        if (signal.aborted) return;
        fragmentShadowRoot[compatMetadataSymbol].documentReadyState = 'complete';
        contentRoot.dispatchEvent(new Event('readystatechange', { bubbles: false, cancelable: false }));
        realm.window.dispatchEvent(new Event('load', { bubbles: false, cancelable: false }));

        if (isDevMode()) {
          console.debug(`[braid:${fragmentId}] compat fragment loaded`, { shadowRoot: fragmentShadowRoot });
        }
      });
    });
  },
};

/**
 * Parses gateway-prepared fragment markup into nodes owned by the host document.
 *
 * The markup arrives already transformed (`braid-html`/`braid-head`/`braid-body` stand-ins,
 * inert scripts, namespaced subresource URLs), so this only parses and adopts it — parsing
 * happens in a detached `DOMParser` document, where nothing executes.
 *
 * The stand-ins are unknown elements, so the parser leaves them in `body`; the fragment's root
 * is `braid-html` when the gateway saw a full document, and a wrapper is synthesized when it
 * saw a bare markup snippet.
 */
export function parseFragmentContent(html: string, mainDocument: Document): HTMLElement {
  const parsed = new DOMParser().parseFromString(html, 'text/html');

  const braidHtml = parsed.body.querySelector('braid-html');
  if (braidHtml) {
    return mainDocument.importNode(braidHtml, true) as HTMLElement;
  }

  const wrapper = mainDocument.createElement('braid-html');
  const braidBody = mainDocument.createElement('braid-body');
  braidBody.append(...[...parsed.body.childNodes].map((node) => mainDocument.importNode(node, true)));
  wrapper.append(braidBody);
  return wrapper;
}

/**
 * Resolves once every image that holds a document's load event has loaded or failed.
 *
 * Lazy images are skipped, as browsers skip them: one below the fold does not load until it is
 * scrolled to, and waiting for it would mean the fragment's load event never fires.
 */
export function imagesSettled(contentRoot: HTMLElement): Promise<void> {
  const images = contentRoot.querySelectorAll<HTMLImageElement>('img:not([loading="lazy" i])');
  if (images.length === 0) {
    return Promise.resolve();
  }

  const imagePromises = [...images].map((image) => {
    return new Promise<void>((resolve) => {
      if (image.complete) {
        resolve();
      } else {
        image.addEventListener('load', () => resolve());
        image.addEventListener('error', () => resolve());
      }
    });
  });

  return Promise.all(imagePromises).then(() => undefined);
}
