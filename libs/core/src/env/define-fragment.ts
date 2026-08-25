import type { FragmentEnv } from './fragment-env.js';
import type { FragmentContract } from '../weave/contract.js';

/**
 * The guest entry point for a contract-mode fragment.
 *
 * ```ts
 * import { defineFragment } from '@braidlabs/core';
 *
 * defineFragment({
 *   contract: { version: '2.1.0', requires: { host: '>=1.4.0' } },
 *   mount(env) {
 *     const app = createApp(env.root, { basePath: env.location.basePath });
 *     env.signal.addEventListener('abort', () => app.destroy());
 *   },
 * });
 * ```
 *
 * Called at import time, not exported. The host reads the *registration*, not the module namespace:
 * `realm.evaluate()` is a dynamic import in another realm, and reaching its exports back across that
 * boundary works differently depending on whether the fragment shipped an ES module, a bundled IIFE,
 * or whatever a build tool invented last week. A registration call is boring and shape-independent.
 *
 * **Packaging note.** This lives in `@braidlabs/core` alongside `connectToBraidHost` because both
 * are guest APIs and one import path is easier to teach than two. It is a fair criticism that a
 * fragment should not have to pull the host runtime — `<fragment-slot>`, the gateway protocol, the
 * whole compat layer — into its bundle to get this function. Splitting a guest-only entry point out
 * is a packaging change with no design content, and it is worth doing before anyone ships a
 * bundle-size-sensitive fragment.
 */

export interface FragmentDefinition {
  /** What this fragment requires of a host and provides back. Compared at the handshake. */
  contract?: FragmentContract;
  /**
   * Builds the fragment's UI into `env.root` and wires teardown to `env.signal`.
   *
   * Anything returned is ignored: a fragment's lifecycle is `env.signal` and `env.onClosing`, and a
   * second teardown channel via a return value would be a second thing to get wrong.
   */
  mount(env: FragmentEnv): void | Promise<void>;
}

/** Where the host looks for the registration. Realm-global, so one realm holds one fragment. */
const REGISTRATION_KEY = '__braidFragment';

export function defineFragment(definition: FragmentDefinition): void {
  if (typeof definition?.mount !== 'function') {
    throw new TypeError('defineFragment() needs a mount function');
  }

  const realm = globalThis as unknown as Record<string, unknown>;

  if (realm[REGISTRATION_KEY]) {
    // One realm, one fragment. A second registration means two entry modules were evaluated into
    // the same realm, which is a build mistake with a confusing symptom — the first fragment simply
    // never mounts — so it is worth naming rather than silently overwriting.
    console.warn(
      'braid: defineFragment() was called more than once in this realm; the last call wins. ' +
        'Each fragment gets its own realm, so two registrations means two entry modules were bundled together.',
    );
  }

  realm[REGISTRATION_KEY] = definition;
}

/** Reads a realm's registration. Exported for the adapter and for tests. */
export function readFragmentDefinition(realmGlobal: unknown): FragmentDefinition | undefined {
  if (!realmGlobal || typeof realmGlobal !== 'object') return undefined;
  return (realmGlobal as Record<string, unknown>)[REGISTRATION_KEY] as FragmentDefinition | undefined;
}
