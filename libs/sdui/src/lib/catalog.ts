import { canonicalJson, compileLens } from '@braidlabs/skew';
import {
  type SkewContractDocument,
  type SkewContractStep,
  parseContractDocument,
} from '@braidlabs/contract';
import { contentAddress } from './hash.js';
import { type Screen, type SduiAction, type SduiNode } from './model.js';
import {
  RESERVED_KEYS,
  hasReservedSegment,
  isRecord,
  isSafeName,
  notJson,
  outgrows,
  own,
  reservedKeyIn,
} from './internal.js';

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
   * Prop paths in the component's **newest** shape (or `slots.<name>`) that a render must not
   * lose. A downgrade that would discard one is not a degraded render, it is an unsupported one —
   * a price, a legal note.
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
const RESERVED = RESERVED_KEYS;

/**
 * How big a catalog may be. A catalog is written by engineers, so these are not there to ration
 * it. They are there so that a mistake is a message at the door: a document this deep or this
 * large is not a catalog, and a path this long names nothing in a payload.
 *
 * They do not bound what a catalog's steps go on to build — a thousand short steps can nest a
 * payload a thousand deep. `migrate` checks what comes out, for that.
 */
export const CATALOG_LIMITS = Object.freeze({
  /** How deep the document itself nests, schemas and default values included. */
  depth: 64,
  /** Scalars, arrays and objects in the whole document. */
  values: 1_000_000,
  /** Segments in any one path an op names: `a.b.c` is three. */
  pathSegments: 32,
});

/** The first path in a list of ops that is longer than the limit, looking inside `map`. */
function overlongPath(ops: unknown): string | null {
  if (!Array.isArray(ops)) return null;
  for (const op of ops) {
    if (!isRecord(op)) continue;
    for (const body of Object.values(op)) {
      if (!isRecord(body)) continue;
      for (const key of ['path', 'from', 'to']) {
        const path = own(body, key);
        if (
          typeof path === 'string' &&
          path.split('.').length > CATALOG_LIMITS.pathSegments
        )
          return path;
      }
      const inner = overlongPath(own(body, 'ops'));
      if (inner !== null) return inner;
    }
  }
  return null;
}

/**
 * The first thing in a document that is not JSON — or, when `reserved` is set, that is a reserved
 * key — with where it is.
 */
function documentProblem(
  value: unknown,
  where: string,
  reserved: boolean,
): string | null {
  const problem = reserved ? null : notJson(value);
  if (problem !== null) return `${where} is ${problem}, which is not JSON`;
  if (typeof value !== 'object' || value === null) return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = documentProblem(
        value[index],
        `${where}[${index}]`,
        reserved,
      );
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (reserved && RESERVED_KEYS.has(key))
      return `${where} uses the reserved key "${key}"`;
    const found = documentProblem(
      inner,
      `${where}.${key.slice(0, 64)}`,
      reserved,
    );
    if (found !== null) return found;
  }
  return null;
}

/**
 * Validates an untrusted value as a catalog. Throws `TypeError` naming the first problem.
 *
 * Every step's ops are compiled here, so a catalog that parses is one whose migrations can run:
 * a malformed op fails at the door, in `sdui catalog check`, not inside a projection.
 */
export function parseCatalog(raw: unknown): SduiCatalog {
  const fail = (message: string): never => {
    throw new TypeError(`sdui catalog: ${message}`);
  };
  if (!isRecord(raw)) return fail('document must be an object');
  // Before anything walks it: everything below, and everything that reads a catalog later, may
  // then assume a document of ordinary depth and size.
  const outgrown = outgrows(raw, CATALOG_LIMITS);
  if (outgrown !== null)
    fail(
      outgrown === 'depth'
        ? `the document nests more than ${CATALOG_LIMITS.depth} levels deep`
        : `the document holds more than ${CATALOG_LIMITS.values} values`,
    );
  // Then that it is data, so that nothing below meets a hole where a step should be, or a value
  // it cannot print.
  const notData = documentProblem(raw, 'catalog', false);
  if (notData !== null) fail(notData);
  if (raw['sduiCatalog'] !== '1')
    fail(
      `unsupported catalog format ${typeof raw['sduiCatalog'] === 'string' ? `"${raw['sduiCatalog'].slice(0, 40)}"` : '(not a string)'} — this reader understands "1"`,
    );
  if (!isRecord(raw['components']))
    return fail('components must be an object keyed by component type');

  const section = (kind: ContractKind, entries: unknown): void => {
    if (entries === undefined) return;
    if (!isRecord(entries))
      return fail(`${kind}s must be an object keyed by type`);
    for (const [type, entry] of Object.entries(entries)) {
      const where = `${kind} "${type}"`;
      if (type.length > 128 || !TYPE_NAME.test(type) || RESERVED.has(type))
        fail(
          `${where}: type names are lowercase words joined by "-" or ".", and not a reserved word`,
        );
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
      for (const step of contract.steps) {
        if (!step.ops) continue;
        const overlong = overlongPath(step.ops);
        if (overlong !== null)
          fail(
            `${where}: step v${step.from} → v${step.to} names a path of more than ${CATALOG_LIMITS.pathSegments} segments ("${overlong.slice(0, 40)}…")`,
          );
        try {
          compileLens(step.ops);
        } catch (cause) {
          fail(
            `${where}: step v${step.from} → v${step.to} cannot be compiled — ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
      if (kind !== 'component') continue;

      const slots = entry['slots'];
      if (slots !== undefined) {
        if (!isRecord(slots)) return fail(`${where}: slots must be an object`);
        for (const [slot, definition] of Object.entries(slots)) {
          if (!isSafeName(slot))
            fail(
              `${where}: ${JSON.stringify(slot)} is not a slot name — a slot name is a short plain word`,
            );
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
          const accepts = definition['accepts'];
          if (
            accepts !== undefined &&
            (!Array.isArray(accepts) ||
              !accepts.every(
                (t) =>
                  typeof t === 'string' &&
                  TYPE_NAME.test(t) &&
                  !RESERVED.has(t),
              ))
          )
            fail(
              `${where}: slot "${slot}" accepts must be an array of component types`,
            );
          const max = definition['max'];
          if (
            max !== undefined &&
            (!Number.isInteger(max) || (max as number) < 0)
          )
            fail(`${where}: slot "${slot}" max must be a whole number`);
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
        const props = fallback['props'];
        if (props !== undefined) {
          if (!isRecord(props))
            return fail(`${where}: fallback props must be an object`);
          const reserved = Object.keys(props).find((key) => RESERVED.has(key));
          if (reserved !== undefined)
            fail(`${where}: fallback props use the reserved key "${reserved}"`);
          for (const [prop, spec] of Object.entries(props)) {
            if (isRecord(spec) && '$from' in spec) {
              if (
                typeof spec['$from'] !== 'string' ||
                Object.keys(spec).length !== 1
              )
                fail(
                  `${where}: fallback prop "${prop}" must be { "$from": "<path>" } and nothing else`,
                );
              if (hasReservedSegment(spec['$from'] as string))
                fail(
                  `${where}: fallback props read from a reserved path "${String(spec['$from'])}"`,
                );
              continue;
            }
            const reservedInside = reservedKeyIn(spec);
            if (reservedInside !== null)
              fail(
                `${where}: fallback prop "${prop}" uses the reserved key "${reservedInside}"`,
              );
          }
        }
      }
      for (const key of ['criticalPaths', 'localizable'] as const) {
        const list = entry[key];
        if (
          list !== undefined &&
          (!Array.isArray(list) ||
            !list.every(
              (p) =>
                typeof p === 'string' && p.length > 0 && !hasReservedSegment(p),
            ))
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
    if (
      isRecord(fallback) &&
      own(raw['components'], fallback['type'] as string) === undefined
    ) {
      fail(
        `component "${type}": its fallback names "${String(fallback['type'])}", which is not in this catalog`,
      );
    }
  }

  // Last, so that a problem with a name is reported in the terms above: no key anywhere in the
  // document — in a default value, a schema, editor metadata — is a reserved one.
  const problem = documentProblem(raw, 'catalog', true);
  if (problem !== null) fail(problem);

  return raw as unknown as SduiCatalog;
}

// --- append-only check ------------------------------------------------------

export interface CatalogViolation {
  readonly kind:
    | 'removed'
    | 'step-edited'
    | 'steps-reordered'
    | 'version-lowered'
    | 'schema-edited'
    | 'slot-changed'
    | 'critical-path-removed';
  readonly contract: string;
  /** The step concerned, as the published catalog numbered it. */
  readonly step?: { readonly from: number; readonly to: number };
  readonly message: string;
}

/**
 * What a step *is*, apart from where it sits — so a reorder can be told from an edit. The whole
 * canonical text, not a hash of it: this is compared to decide whether published history was
 * rewritten, and a short hash is something a determined edit can be made to collide with.
 */
function stepIdentity(step: SkewContractStep): string {
  return canonicalJson([step.description, step.ops ?? null, step.code ?? null]);
}

/**
 * Compares a proposed catalog against the published one and reports every way it rewrites what
 * was shipped.
 *
 * Content already in the field was authored under the published steps, and is decoded by exactly
 * those steps for as long as a binary that old is running. So:
 *
 * - a published **step** may never change or move, and a published version's **schema** may never
 *   change — new shape means a new step appended, a wrong old step means a correcting one;
 * - no contract may **disappear**, and no version number may go down;
 * - a **slot** may not be removed or have its `since` changed, which would send an old binary
 *   children it has nowhere to put;
 * - a **critical path** may not be removed, which would turn a refusal into a silent loss.
 *
 * A component's `fallback`, `accepts`, `max` and editor metadata are policy, not history, and may
 * change. An empty result means the proposal only adds.
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
      const proposed = own(after, type);
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
      const publishedIdentities = was.steps.map(stepIdentity);
      // A proposed step that is still where its published twin was is spoken for: it cannot also
      // be the place some other identical-looking step "moved to".
      const inPlace = new Set(
        publishedIdentities.map((identity, index) =>
          identities[index] === identity ? index : -1,
        ),
      );
      was.steps.forEach((step, index) => {
        if (inPlace.has(index)) return;
        const span = { from: step.from, to: step.to };
        const label = `${name} step v${step.from} → v${step.to} ("${step.description}")`;
        const movedTo = identities.findIndex(
          (identity, at) =>
            identity === publishedIdentities[index] && !inPlace.has(at),
        );
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
        const proposedSchema = own(
          now.schemas as Record<string, unknown> | undefined,
          version,
        );
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

      if (kind !== 'component') continue;
      const wasComponent = entry as ComponentDefinition;
      const nowComponent = proposed as ComponentDefinition;
      for (const [slot, definition] of Object.entries(
        wasComponent.slots ?? {},
      )) {
        const proposedSlot = own(nowComponent.slots, slot);
        if (!proposedSlot) {
          violations.push({
            kind: 'slot-changed',
            contract: name,
            message: `${name} slot "${slot}" was removed — published content still fills it`,
          });
        } else if ((proposedSlot.since ?? 1) !== (definition.since ?? 1)) {
          violations.push({
            kind: 'slot-changed',
            contract: name,
            message: `${name} slot "${slot}" went from since v${definition.since ?? 1} to since v${proposedSlot.since ?? 1} — which versions have a slot is frozen`,
          });
        }
      }
      for (const path of wasComponent.criticalPaths ?? []) {
        if (!(nowComponent.criticalPaths ?? []).includes(path)) {
          violations.push({
            kind: 'critical-path-removed',
            contract: name,
            message: `${name} no longer treats "${path}" as critical — older apps would lose it silently instead of taking a fallback`,
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

// --- does a screen fit a catalog? -------------------------------------------

export interface ScreenProblem {
  readonly nodeId: string;
  readonly message: string;
}

/**
 * Checks an authored screen against a catalog: every way it names something the catalog does not
 * have, or uses a slot the catalog does not allow.
 *
 * Projection is forgiving about these — an unknown component is simply unsupported and takes its
 * fallback — which is right for a device and wrong for an author, who should hear about a typo
 * before publishing rather than see a node quietly missing.
 *
 * Structural only. Whether props match a version's JSON Schema is checked where screens are
 * published.
 */
export function validateScreen(
  screen: Screen,
  catalog: SduiCatalog,
): ScreenProblem[] {
  const problems: ScreenProblem[] = [];

  const checkAction = (
    nodeId: string,
    name: string,
    action: SduiAction,
  ): void => {
    const definition = own(catalog.actions, action.type);
    if (!definition)
      problems.push({
        nodeId,
        message: `action "${name}" is a "${action.type}", which is not an action in the catalog`,
      });
    else if (action.v > definition.contract.current)
      problems.push({
        nodeId,
        message: `action "${name}" is authored at "${action.type}" v${action.v}, but the catalog only goes to v${definition.contract.current}`,
      });
    if (action.fallback) checkAction(nodeId, name, action.fallback);
  };

  const checkNode = (node: SduiNode): void => {
    const definition = own(catalog.components, node.type);
    if (!definition) {
      problems.push({
        nodeId: node.id,
        message: `"${node.type}" is not a component in the catalog`,
      });
    } else {
      if (node.v > definition.contract.current)
        problems.push({
          nodeId: node.id,
          message: `authored at "${node.type}" v${node.v}, but the catalog only goes to v${definition.contract.current}`,
        });
      for (const [slot, children] of Object.entries(node.slots ?? {})) {
        const slotDefinition = own(definition.slots, slot);
        if (!slotDefinition) {
          problems.push({
            nodeId: node.id,
            message: `"${node.type}" has no slot named "${slot}"`,
          });
          continue;
        }
        if ((slotDefinition.since ?? 1) > node.v)
          problems.push({
            nodeId: node.id,
            message: `slot "${slot}" needs "${node.type}" v${slotDefinition.since}, and this node is authored at v${node.v}`,
          });
        if (
          slotDefinition.max !== undefined &&
          children.length > slotDefinition.max
        )
          problems.push({
            nodeId: node.id,
            message: `slot "${slot}" takes at most ${slotDefinition.max}, and has ${children.length}`,
          });
        for (const child of children) {
          if (
            slotDefinition.accepts &&
            !slotDefinition.accepts.includes(child.type)
          )
            problems.push({
              nodeId: child.id,
              message: `a "${child.type}" cannot go in the "${slot}" slot of "${node.type}", which takes ${slotDefinition.accepts.join(', ')}`,
            });
        }
      }
    }
    for (const [name, action] of Object.entries(node.actions ?? {}))
      checkAction(node.id, name, action);
    for (const children of Object.values(node.slots ?? {}))
      children.forEach(checkNode);
    if (node.fallback) {
      if (node.fallback.required)
        problems.push({
          nodeId: node.fallback.id,
          message: `"required" on a fallback has no effect — mark "${node.id}", the node it stands in for`,
        });
      checkNode(node.fallback);
    }
  };

  checkNode(screen.root);
  for (const state of Object.values(screen.states ?? {})) {
    if (typeof state !== 'string') checkNode(state);
  }
  return problems;
}
