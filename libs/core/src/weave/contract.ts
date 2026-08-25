import type { VersionedSchema } from '@braidlabs/skew';

/**
 * Contract negotiation at connect time.
 *
 * Skew is the strongest thing Braid has, and it answers the *second* question about version
 * disagreement: given a mismatch, what can be salvaged? This module asks the first one — should
 * these two have been connected at all — and it exists because Braid could previously answer only
 * by failing later, inside whichever interaction happened to touch the missing term.
 *
 * Three outcomes, and the third is the one only Braid can offer:
 *
 * 1. **compatible** — terms agree; open.
 * 2. **incompatible** — refuse at mount, naming both versions and the failing term. Failing here is
 *    strictly better than failing at first interaction: an empty slot with a fallback beats a
 *    rendered UI that throws when someone clicks it.
 * 3. **bridged** — the terms disagree but a registered Skew migration spans the gap. Open, and
 *    report what will be derived or discarded. Detecting skew and reconciling it are not the same
 *    capability, and this is where the difference shows up.
 */

export interface ContractProvisions {
  events?: string[];
  actions?: string[];
}

export interface ContractRequirements {
  /** Range the fragment requires of the host's contract version. See `satisfiesRange`. */
  host?: string;
  /**
   * Skew chain version per context key, not a semver range.
   *
   * Deliberately the same integers `contextVersions` already uses rather than a parallel
   * string-range vocabulary: a second way to say "which shape of `cart` do you speak" would need
   * its own mapping onto the migration chain, and the two would disagree the first time anyone
   * edited one of them.
   */
  context?: Record<string, number>;
}

export interface FragmentContract {
  version: string;
  requires?: ContractRequirements;
  provides?: ContractProvisions;
}

export interface HostContract {
  version: string;
  provides?: ContractProvisions;
}

/** One context key the fragment will receive at a version other than the published one. */
export interface ContextBridge {
  key: string;
  /** The version the host publishes. */
  from: number;
  /** The version the fragment declared it speaks. */
  to: number;
  /** Fields the projection discards on the way down. Empty when the bridge is lossless. */
  discards: string[];
}

export type NegotiationOutcome = 'compatible' | 'bridged' | 'incompatible';

export interface Negotiation {
  outcome: NegotiationOutcome;
  bridges: ContextBridge[];
  /** Set when incompatible: what disagreed, in terms a developer can act on. */
  reason?: string;
  fixHint?: string;
}

export interface NegotiateOptions {
  host: HostContract | undefined;
  fragment: FragmentContract | undefined;
  /** Resolves a context key's registered schema. Injected — see `ContextBusLike`. */
  schemaFor(key: string): VersionedSchema<unknown> | undefined;
}

/**
 * Compares what a fragment requires against what the host offers.
 *
 * A fragment that declares no contract is compatible with everything, and must stay that way:
 * compat mode's whole promise is that being composed requires no change to the app, and a
 * negotiation that refused undeclared fragments would revoke it.
 */
export function negotiateContract(options: NegotiateOptions): Negotiation {
  const { host, fragment, schemaFor } = options;

  if (!fragment) return { outcome: 'compatible', bridges: [] };

  const requiredHost = fragment.requires?.host;
  if (requiredHost !== undefined) {
    if (!host) {
      return {
        outcome: 'incompatible',
        bridges: [],
        reason: `the fragment requires a host contract matching "${requiredHost}", and this host declares none`,
        fixHint: 'declare the host contract: initBraid({ contract: { version: "1.0.0" } })',
      };
    }

    const satisfied = satisfiesRange(host.version, requiredHost);
    if (satisfied === 'unparseable') {
      // Refused rather than waved through. A range nobody can read is a requirement nobody is
      // checking, and the failure mode of silently passing it is a fragment that mounts against a
      // host it was never meant to run on.
      return {
        outcome: 'incompatible',
        bridges: [],
        reason: `the fragment requires host "${requiredHost}", which is not a range this build understands`,
        fixHint: `use one of: "1.2.3", ">=1.2.3", ">1.2.3", "<=1.2.3", "<1.2.3", "^1.2.3", "~1.2.3", "1.x", "*"`,
      };
    }

    if (!satisfied) {
      return {
        outcome: 'incompatible',
        bridges: [],
        reason: `the fragment requires host "${requiredHost}", and this host is "${host.version}"`,
        fixHint: 'deploy a host that satisfies the range, or relax the fragment’s requires.host',
      };
    }
  }

  const bridges: ContextBridge[] = [];
  for (const [key, declared] of Object.entries(fragment.requires?.context ?? {})) {
    const schema = schemaFor(key);
    // No schema registered means no projection happens and none is needed — the value crosses as
    // published, exactly as an untyped context always has.
    if (!schema || declared === schema.version) continue;

    if (declared > schema.version) {
      return {
        outcome: 'incompatible',
        bridges: [],
        reason: `the fragment reads context "${key}" at v${declared}, and this host publishes v${schema.version}`,
        fixHint: 'the fragment is newer than the host — deploy the host, or pin the fragment to a version it can produce',
      };
    }

    const spanned = schema.steps.filter((step) => step.to > declared && step.to <= schema.version);
    const missing = spanned.filter((step) => !step.down);
    if (missing.length > 0) {
      return {
        outcome: 'incompatible',
        bridges: [],
        reason:
          `context "${key}" cannot be bridged from v${schema.version} down to v${declared}: ` +
          `${missing.map((step) => `v${step.to} (${step.description})`).join(', ')} ` +
          `${missing.length === 1 ? 'declares' : 'declare'} no down migration`,
        fixHint: `add a down migration to the step that introduced v${missing[0]?.to}`,
      };
    }

    bridges.push({
      key,
      from: schema.version,
      to: declared,
      // What the fragment will not see. Reported rather than merely permitted: a bridge that
      // silently drops a field is how a fragment ends up rendering a confidently wrong screen.
      discards: [...new Set(spanned.flatMap((step) => step.lossy ?? []))],
    });
  }

  return { outcome: bridges.length > 0 ? 'bridged' : 'compatible', bridges };
}

/**
 * A deliberately narrow subset of semver range syntax.
 *
 * `semver` is not a dependency of `@braidlabs/core` and should not become one — it is a browser
 * runtime bundle, and the ranges that appear in a fragment manifest are the simple ones. The subset
 * is documented, and anything outside it returns `'unparseable'` rather than a guess, so a range
 * this build cannot read fails loudly at mount instead of quietly never being enforced.
 *
 * Supported: `*`, `1.x` / `1.*`, `1.2.3`, `>=`, `>`, `<=`, `<`, `^`, `~`.
 * Not supported: hyphen ranges, `||` unions, pre-release precedence.
 */
export function satisfiesRange(version: string, range: string): boolean | 'unparseable' {
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === '') return true;

  const target = parseVersion(version);
  if (!target) return 'unparseable';

  const wildcard = /^(\d+)\.(x|\*)$/.exec(trimmed);
  if (wildcard) return target[0] === Number(wildcard[1]);

  const operatorMatch = /^(>=|<=|>|<|\^|~)?\s*(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (!operatorMatch) return 'unparseable';

  const bound = parseVersion(operatorMatch[2]!);
  if (!bound) return 'unparseable';

  const order = compareVersions(target, bound);

  switch (operatorMatch[1]) {
    case undefined:
      return order === 0;
    case '>=':
      return order >= 0;
    case '>':
      return order > 0;
    case '<=':
      return order <= 0;
    case '<':
      return order < 0;
    case '^':
      // Caret: same major, and not older. Major 0 is treated as every minor being breaking, which
      // is the convention pre-1.0 packages actually rely on.
      return order >= 0 && target[0] === bound[0] && (bound[0] !== 0 || target[1] === bound[1]);
    case '~':
      return order >= 0 && target[0] === bound[0] && target[1] === bound[1];
    default:
      return 'unparseable';
  }
}

type Parsed = [number, number, number];

function parseVersion(value: string): Parsed | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}
