/**
 * Braid's own writes into the sinks Trusted Types guards, for a host page that enforces them
 * (`require-trusted-types-for 'script'`).
 *
 * The runtime writes to a handful of sinks itself: it parses the markup the gateway prepared, it
 * marks a script as already started by giving it a line of text, and the opt-in HTML policy
 * parses a fragment's write into an inert document before cleaning it. Under enforcement each of
 * those needs a trusted value, so they go through one policy, named `braid`, which a host lists in
 * its `trusted-types` directive.
 *
 * The policy passes values through unchanged, which is why it is never exported: only these call
 * sites can reach it, and each one either writes something Braid authored or parses into a
 * document where nothing runs. Everything a fragment writes itself still meets the host's own
 * enforcement — which is the point of turning it on.
 *
 * Created on first use, in whichever realm the write happens: a realm document inherits the host's
 * policy, and a trusted value is checked against the realm that writes it.
 */

interface PassThroughPolicy {
  createHTML(input: string): unknown;
  createScript(input: string): unknown;
}

interface TrustedTypesGlobal {
  trustedTypes?: { createPolicy(name: string, rules: Record<string, (input: string) => string>): PassThroughPolicy };
}

const POLICY_NAME = 'braid';
const policies = new WeakMap<object, PassThroughPolicy | null>();

function policyFor(realm: object): PassThroughPolicy | null {
  if (policies.has(realm)) return policies.get(realm) ?? null;
  const factory = (realm as TrustedTypesGlobal).trustedTypes;
  let policy: PassThroughPolicy | null = null;
  if (factory) {
    try {
      const same = (input: string) => input;
      policy = factory.createPolicy(POLICY_NAME, { createHTML: same, createScript: same });
    } catch (error) {
      // Not listed in the host's `trusted-types` directive, or the name already taken — by a second
      // copy of the runtime, or by script that ran first. Writes go as plain strings and enforcement
      // reports them; the warning says which.
      console.warn(`[braid] could not create the "${POLICY_NAME}" Trusted Types policy: ${(error as Error)?.message ?? error}`);
      policy = null;
    }
  }
  policies.set(realm, policy);
  return policy;
}

/** Markup Braid parses: the gateway's prepared document, or a write it is about to clean. */
export function trustedHTML(markup: string, realm: object = globalThis): string {
  return (policyFor(realm)?.createHTML(markup) as string | undefined) ?? markup;
}

/** Script text Braid writes itself. */
export function trustedScript(source: string, realm: object = globalThis): string {
  return (policyFor(realm)?.createScript(source) as string | undefined) ?? source;
}

/**
 * Creates the host's policy now, if the page has Trusted Types. Called by `initBraid`, before any
 * fragment code runs: what the host's directive grants is the name `braid`, so it must be Braid's
 * before anything else on the page can create it.
 */
export function claimBraidPolicy(): void {
  policyFor(globalThis);
}
