import { canonicalJson, fnv1a } from '@braidlabs/skew';
import {
  type SkewContractDocument,
  type SkewContractStep,
  parseContractDocument,
} from '@braidlabs/contract';
import { contentAddress } from './hash.js';
import { isRecord } from './model.js';

/**
 * The catalog — an app's UI vocabulary, owned by engineering.
 *
 * Each component, action and analytics event is a `@braidlabs/contract` document: numbered
 * versions of its props, and the steps between them as data. Editors never touch this. They author
 * against whatever the catalog's newest versions are, and the catalog is what lets a server turn
 * that into what an older binary understands.
 */

/**
 * What a device gets when it cannot render a component and the node authored no fallback of its
 * own.
 *
 * - `omit` — leave it out (the default).
 * - `placeholder` — the protocol's built-in placeholder, which every client renders.
 * - `fail-screen` — this component is never optional: treat the node as required.
 * - `{ type, props }` — another component, its props built from this node's. A prop value of
 *   `{ "$from": "title" }` copies this node's `title`; anything else is a literal.
 */
export type CatalogFallback =
  | 'omit'
  | 'placeholder'
  | 'fail-screen'
  | {
      readonly type: string;
      readonly props?: Readonly<Record<string, unknown>>;
    };

export interface SlotDefinition {
  /** Component types this slot accepts. Absent means any. */
  readonly accepts?: readonly string[];
  readonly max?: number;
  /** The component version that introduced this slot. Older clients do not have it. */
  readonly since?: number;
}

export interface ComponentDefinition {
  readonly contract: SkewContractDocument;
  readonly slots?: Readonly<Record<string, SlotDefinition>>;
  readonly fallback?: CatalogFallback;
  /**
   * Prop paths (or `slots.<name>`) a render must not lose. A downgrade that would discard one is
   * not a degraded render, it is an unsupported one — a price, a legal note.
   */
  readonly criticalPaths?: readonly string[];
  readonly localizable?: readonly string[];
  /** The shape a derived loading skeleton draws for this component. Opaque to this package. */
  readonly skeleton?: unknown;
  /** Presentation in the CMS. Opaque to this package. */
  readonly editor?: Readonly<Record<string, unknown>>;
}

export interface ContractEntry {
  readonly contract: SkewContractDocument;
}

export interface SduiCatalog {
  readonly sduiCatalog: '1';
  readonly components: Readonly<Record<string, ComponentDefinition>>;
  readonly actions?: Readonly<Record<string, ContractEntry>>;
  readonly events?: Readonly<Record<string, ContractEntry>>;
}

export const CATALOG_ID_PREFIX = 'cat_';

/** The type every client renders without declaring it, for `fallback: "placeholder"`. */
export const PLACEHOLDER_TYPE = 'sdui.placeholder';

export type ContractKind = 'component' | 'action' | 'event';

/** The contract name a catalog entry must carry: `sdui.component.product-card`. */
export function contractName(kind: ContractKind, type: string): string {
  return `sdui.${kind}.${type}`;
}

export function catalogId(catalog: SduiCatalog): string {
  return contentAddress(CATALOG_ID_PREFIX, catalog);
}

const TYPE_NAME = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

/**
 * Validates an untrusted value as a catalog. Throws `TypeError` naming the first problem.
 */
export function parseCatalog(raw: unknown): SduiCatalog {
  const fail = (message: string): never => {
    throw new TypeError(`sdui catalog: ${message}`);
  };
  if (!isRecord(raw)) return fail('document must be an object');
  if (raw['sduiCatalog'] !== '1')
    fail(
      `unsupported catalog format "${String(raw['sduiCatalog'])}" — this reader understands "1"`,
    );
  if (!isRecord(raw['components']))
    return fail('components must be an object keyed by component type');

  const section = (kind: ContractKind, entries: unknown): void => {
    if (entries === undefined) return;
    if (!isRecord(entries))
      return fail(`${kind}s must be an object keyed by type`);
    for (const [type, entry] of Object.entries(entries)) {
      const where = `${kind} "${type}"`;
      if (!TYPE_NAME.test(type))
        fail(`${where}: type names are lowercase words joined by "-" or "."`);
      if (kind === 'component' && type === PLACEHOLDER_TYPE)
        fail(`"${PLACEHOLDER_TYPE}" is reserved by the protocol`);
      if (!isRecord(entry)) return fail(`${where} must be an object`);
      let contract: SkewContractDocument;
      try {
        contract = parseContractDocument(entry['contract']);
      } catch (cause) {
        return fail(
          `${where}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      const expected = contractName(kind, type);
      if (contract.name !== expected)
        fail(
          `${where}: its contract must be named "${expected}", got "${contract.name}"`,
        );
      if (kind !== 'component') continue;

      const slots = entry['slots'];
      if (slots !== undefined) {
        if (!isRecord(slots)) return fail(`${where}: slots must be an object`);
        for (const [slot, definition] of Object.entries(slots)) {
          if (!isRecord(definition))
            return fail(`${where}: slot "${slot}" must be an object`);
          const since = definition['since'];
          if (
            since !== undefined &&
            (!Number.isInteger(since) ||
              (since as number) < 1 ||
              (since as number) > contract.current)
          ) {
            fail(
              `${where}: slot "${slot}" since must be a version between 1 and ${contract.current}`,
            );
          }
        }
      }
      const fallback = entry['fallback'];
      if (
        fallback !== undefined &&
        fallback !== 'omit' &&
        fallback !== 'placeholder' &&
        fallback !== 'fail-screen'
      ) {
        if (!isRecord(fallback) || typeof fallback['type'] !== 'string') {
          return fail(
            `${where}: fallback must be "omit", "placeholder", "fail-screen" or { type, props }`,
          );
        }
        if (fallback['type'] === type)
          fail(`${where}: a component cannot be its own fallback`);
      }
      for (const key of ['criticalPaths', 'localizable'] as const) {
        const list = entry[key];
        if (
          list !== undefined &&
          (!Array.isArray(list) ||
            !list.every((p) => typeof p === 'string' && p.length > 0))
        ) {
          fail(`${where}: ${key} must be an array of paths`);
        }
      }
    }
  };

  section('component', raw['components']);
  section('action', raw['actions']);
  section('event', raw['events']);

  // A fallback names another component; one that names nothing fails here, not on a device.
  for (const [type, entry] of Object.entries(raw['components'])) {
    const fallback = (entry as ComponentDefinition).fallback;
    if (isRecord(fallback) && !(fallback['type'] in raw['components'])) {
      fail(
        `component "${type}": its fallback names "${String(fallback['type'])}", which is not in this catalog`,
      );
    }
  }

  return raw as unknown as SduiCatalog;
}

// --- append-only check ------------------------------------------------------

export interface CatalogViolation {
  readonly kind:
    | 'removed'
    | 'step-edited'
    | 'steps-reordered'
    | 'version-lowered'
    | 'schema-edited';
  readonly contract: string;
  /** The step concerned, as the published catalog numbered it. */
  readonly step?: { readonly from: number; readonly to: number };
  readonly message: string;
}

/** What a step *is*, apart from where it sits — so a reorder can be told from an edit. */
function stepIdentity(step: SkewContractStep): string {
  return fnv1a(
    `${step.description}:${step.ops ? canonicalJson(step.ops) : `code:${step.code}`}`,
  );
}

/**
 * Compares a proposed catalog against the published one and reports every way it breaks the
 * append-only rule.
 *
 * Content already in the field was authored under the published steps, and is decoded by exactly
 * those steps for as long as a binary that old is running. So a published step may never change
 * or move, a published version's schema may never change, and nothing may disappear. New shape
 * means a new step appended; a wrong old step means a *correcting* step appended.
 *
 * An empty result means the proposal only adds.
 */
export function checkCatalog(
  published: SduiCatalog,
  next: SduiCatalog,
): CatalogViolation[] {
  const violations: CatalogViolation[] = [];

  const compare = (
    kind: ContractKind,
    before: Readonly<Record<string, ContractEntry>> = {},
    after: Readonly<Record<string, ContractEntry>> = {},
  ): void => {
    for (const [type, entry] of Object.entries(before)) {
      const name = contractName(kind, type);
      const proposed = after[type];
      if (!proposed) {
        violations.push({
          kind: 'removed',
          contract: name,
          message: `${name} was removed — content already published still names it`,
        });
        continue;
      }
      const was = entry.contract;
      const now = proposed.contract;
      if (now.current < was.current) {
        violations.push({
          kind: 'version-lowered',
          contract: name,
          message: `${name} went from v${was.current} to v${now.current} — versions only go up`,
        });
      }

      const identities = now.steps.map(stepIdentity);
      was.steps.forEach((step, index) => {
        const span = { from: step.from, to: step.to };
        const label = `${name} step v${step.from} → v${step.to} ("${step.description}")`;
        const identity = stepIdentity(step);
        if (identities[index] === identity) return;
        const movedTo = identities.indexOf(identity);
        if (movedTo >= 0) {
          violations.push({
            kind: 'steps-reordered',
            contract: name,
            step: span,
            message: `${label} was moved to v${movedTo + 1} → v${movedTo + 2} — published steps keep their place; append a new step instead`,
          });
        } else if (index < now.steps.length) {
          violations.push({
            kind: 'step-edited',
            contract: name,
            step: span,
            message: `${label} was edited — published steps are frozen; append a correcting step instead`,
          });
        }
        // A step missing because `current` went down is already reported as version-lowered.
      });

      for (const [version, schema] of Object.entries(was.schemas ?? {})) {
        const proposedSchema = now.schemas?.[version];
        if (
          proposedSchema === undefined ||
          canonicalJson(proposedSchema) !== canonicalJson(schema)
        ) {
          violations.push({
            kind: 'schema-edited',
            contract: name,
            message: `${name} schema for v${version} was ${proposedSchema === undefined ? 'removed' : 'edited'} — a published version's shape is frozen`,
          });
        }
      }
    }
  };

  compare('component', published.components, next.components);
  compare('action', published.actions, next.actions);
  compare('event', published.events, next.events);
  return violations;
}
