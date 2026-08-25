import { AdapterBootContext, InstalledAdapter } from './adapter.js';
import { BraidError } from '../errors.js';
import { readFragmentDefinition } from '../env/define-fragment.js';

/**
 * The contract adapter: a fragment that asks for a `FragmentEnv` instead of pretending to own a
 * browser.
 *
 * This is the mode `braid-architecture.md` has described as the end state since before there was
 * anything to run it — `FragmentEnv` was defined, documented as "the heart of the project", and
 * consumed by nothing a framework application would reach for. Every normal path ran through compat
 * mode, which meant Braid's production surface was its most expensive and most browser-quirk-
 * dependent one: the mode whose failure modes fill `braid-failure-modes.md`.
 *
 * What a contract fragment gives up: the illusion. No `document` facade, no `window` patches, no
 * history virtualisation, no script neutralisation, no singleton renaming. What it gets back is the
 * whole of that list as *not-your-problem*, plus one structural bonus that is easy to undersell:
 *
 * **A contract fragment needs no gateway.** Its realm boots from a `blob:` URL the runtime writes
 * itself, so there is no realm stub to serve, no namespace to route, and no host-origin middleware
 * to install. A statically hosted SPA can be a Braid host for contract fragments. That was the
 * sharpest structural criticism of the architecture, and this is the answer to it.
 */
export const contractAdapter: InstalledAdapter = {
  name: 'contract',

  /**
   * A blob realm: no network round trip, no realm stub, and — because the realm never navigates —
   * zero interaction with the joint session history, which is the entire class of back/forward
   * corruption that compat mode has to work around.
   */
  realmKind: 'contract-blob',

  /** A contract fragment builds its own UI from its entry module; it serves no document. */
  needsDocument: false,

  async boot(ctx: AdapterBootContext): Promise<void> {
    const { fragmentId, realm, env } = ctx;
    // Markup first, stub second: the gateway-free path has no stub to read, and a host that named
    // an entry explicitly means it.
    const entry = ctx.entry ?? readEntry(realm.adapterOptions, fragmentId);

    await realm.evaluate(entry);

    /**
     * The entry module registers itself on the realm's global during evaluation, rather than
     * exporting something the host reads back.
     *
     * `realm.evaluate()` is a dynamic import in another realm, and its module namespace object is
     * not reachable from here in a way that survives every bundler's output shape. A registration
     * call is boring, explicit, and works the same whether the fragment ships an ES module, a
     * bundled IIFE, or something a build tool invented last week.
     */
    const definition = readFragmentDefinition(realm.window);

    if (!definition || typeof definition.mount !== 'function') {
      throw new BraidError(`the entry module "${entry}" did not define a fragment`, {
        fragmentId,
        stage: 'adapter-mount',
        fixHint:
          'the entry module must call defineFragment({ mount }) from @braidlabs/core at import time — ' +
          'a default export is not enough, because the host reads the registration, not the module',
      });
    }

    await definition.mount(env);
  },
};

function readEntry(options: Readonly<Record<string, unknown>>, fragmentId: string): string {
  const entry = options['entry'];
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new BraidError('the contract adapter needs an entry module', {
      fragmentId,
      stage: 'adapter-resolution',
      fixHint:
        `set "entry" on the fragment's manifest ("entry": "/main.js"), or declare it on the slot ` +
        `for a gateway-free fragment: <fragment-slot adapter="contract" entry="https://…/main.js">`,
    });
  }
  return entry;
}
