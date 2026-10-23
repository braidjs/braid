import { AdapterBootContext, InstalledAdapter } from './adapter.js';
import { BraidError } from '../errors.js';
import { isDevMode } from '../config.js';
import { installRealmGlobals, installSharedGlobals } from '../compat/shared-globals.js';

/**
 * The custom-element adapter — a fragment that ships an ordinary custom element.
 *
 * This is contract-mode: no document facade, no window patches, no boundary stamping. A
 * well-behaved custom element does not need to believe it owns the browser; it needs a mount
 * point, its props, and a teardown signal — which is exactly what `FragmentEnv` provides. The
 * whole adapter is the code below.
 *
 * **How the element gets into the host page.** Custom element registries are per-window, so an
 * element defined in the fragment's realm only upgrades elements created by *that* realm's
 * document. So the element is created in the realm — where it upgrades against the fragment's
 * own definition — and then moved into the host's DOM. Adoption preserves the element's class
 * and behavior (the spec calls `adoptedCallback` and the instance keeps its definition), which
 * is what lets a fragment's element live in the host page while its code stays isolated.
 *
 * The isolation this buys is real: two fragments may define the same tag name differently, or
 * ship different majors of the same component library, and nothing collides — each definition
 * lives in its own registry.
 */
export const customElementAdapter: InstalledAdapter = {
  name: 'custom-element',

  /**
   * An http realm, not a blob realm, only because the client learns which adapter a fragment
   * uses by reading the realm stub — so the stub has to exist before the adapter is chosen.
   * Nothing else here needs it, and moving to `contract-blob` (no round trip, no history
   * interaction) is a change to the realm manager alone.
   */
  realmKind: 'compat-http',

  /**
   * The element is built from the entry module, so the fragment's HTML is never read. A widget
   * that ships only a script is a complete fragment.
   */
  needsDocument: false,

  async boot(ctx: AdapterBootContext): Promise<void> {
    const { fragmentId, realm, env, signal } = ctx;
    const options = readOptions(realm.adapterOptions, fragmentId);

    // The element's code runs in its own realm, so the host's analytics globals are not its globals
    // unless the host shared them — and they must be in place before the entry module runs.
    const mainWindow = env.root.ownerDocument.defaultView;
    if (mainWindow && ctx.sharedGlobals?.length) {
      installSharedGlobals(realm.window, mainWindow, ctx.sharedGlobals, fragmentId);
    }
    if (ctx.realmGlobals) installRealmGlobals(realm.window, ctx.realmGlobals, fragmentId);

    // define the element inside the fragment's own realm
    await realm.evaluate(options.entry);

    if (!realm.window.customElements.get(options.element)) {
      throw new BraidError(
        `the entry module did not define a custom element named "${options.element}"`,
        {
          fragmentId,
          stage: 'adapter-mount',
          fixHint:
            `check the "element" in this fragment's manifest against the tag name its entry module ` +
            `registers with customElements.define()`,
        },
      );
    }

    // created in the realm so it upgrades against the fragment's definition, then moved into
    // the host's DOM — adoption keeps the class, so it behaves the same in either document
    const element = realm.document.createElement(options.element);
    applyProps(element, env.props);
    env.root.append(element);

    env.onPropsChanged((props) => applyProps(element, props));

    // the fragment's own events, republished on the host boundary as braid:event
    for (const type of options.events) {
      element.addEventListener(type, (event) => env.emit(type, (event as CustomEvent).detail), { signal });
    }

    signal.addEventListener('abort', () => element.remove(), { once: true });

    if (isDevMode()) {
      console.debug(`[braid:${fragmentId}] mounted <${options.element}>`, {
        entry: options.entry,
        forwarding: options.events,
      });
    }
  },
};

interface CustomElementOptions {
  entry: string;
  element: string;
  events: string[];
}

function readOptions(raw: Readonly<Record<string, unknown>>, fragmentId: string): CustomElementOptions {
  const entry = typeof raw['entry'] === 'string' ? raw['entry'] : '';
  const element = typeof raw['element'] === 'string' ? raw['element'] : '';

  if (!entry || !element) {
    throw new BraidError(
      `the custom-element adapter needs "entry" and "element" in this fragment's manifest`,
      {
        fragmentId,
        stage: 'adapter-resolution',
        fixHint: `add them to the manifest, e.g. { "adapter": "custom-element", "entry": "/widget.js", "element": "star-rating" }`,
      },
    );
  }

  return {
    entry,
    element,
    events: Array.isArray(raw['events']) ? (raw['events'] as unknown[]).filter((e): e is string => typeof e === 'string') : [],
  };
}

/**
 * Props are assigned as element *properties*, which is the custom-element convention for
 * structured values — attributes would stringify them.
 */
function applyProps(element: Element, props: Readonly<Record<string, unknown>>): void {
  Object.assign(element, props);
}
