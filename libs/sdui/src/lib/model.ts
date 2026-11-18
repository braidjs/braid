import { parseVersion } from './conditions.js';
import { contentAddress } from './hash.js';
import { RESERVED_KEYS, isRecord, isSafeName, notJson } from './internal.js';

/**
 * The screen document — what an editor authors and a release carries.
 *
 * Every node is a versioned envelope in disguise: `{ type, v, props }` is skew's
 * `{ name, v, payload }`, with the component type naming the contract. That is the whole trick of
 * this package. Because each node says which version of its component it was written for, a
 * server can migrate it to whatever version a particular binary was built against.
 *
 * Nothing here is executable. Conditions are a closed set, styling is by token, rich text is a
 * tree — the same stance as contract ops, and what keeps a server-driven app inside both app
 * stores' rules on downloaded code.
 */

/** A closed condition language. There are no expressions; a new need is a new member. */
export type Condition =
  | { readonly flag: string; readonly is?: unknown }
  | { readonly platform: readonly string[] }
  | { readonly appVersion: { readonly min?: string; readonly max?: string } }
  | { readonly audience: string }
  | { readonly locale: readonly string[] }
  | { readonly schedule: { readonly from?: string; readonly until?: string } }
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition };

export interface SduiAction {
  readonly type: string;
  /** The action contract version these props were authored at. */
  readonly v: number;
  readonly props?: Readonly<Record<string, unknown>>;
  /** Tried, in turn, when a device cannot perform this action. */
  readonly fallback?: SduiAction;
  /**
   * What happens to the control when neither this action nor a fallback is supported. `disable`
   * (the default) keeps it visible and inert. `hide` takes the node off the screen: its authored
   * fallback is shown if it has one, and otherwise nothing is. Never a dead button that looks
   * live.
   */
  readonly unsupported?: 'disable' | 'hide';
}

export interface SduiNode {
  /** Stable across edits. Keys analytics, diffs and the editor's selection. */
  readonly id: string;
  readonly type: string;
  /** The component contract version these props were authored at. */
  readonly v: number;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly slots?: Readonly<Record<string, readonly SduiNode[]>>;
  readonly actions?: Readonly<Record<string, SduiAction>>;
  readonly visibility?: Condition;
  /** What a device that cannot render this node gets instead, before the catalog's own fallback. */
  readonly fallback?: SduiNode;
  /**
   * A required node in the screen's tree must reach the screen — as itself or as its own
   * fallback. If it does not, for any reason, including an ancestor that was omitted or replaced
   * by a fallback, the screen is blocked for that device.
   *
   * Inside a fallback it is conditional: it counts when that fallback is the thing rendered, and
   * a fallback that is passed over asks nothing of the screen. On a fallback node itself it has
   * no effect — the node it stands in for is the one that is or is not required.
   */
  readonly required?: boolean;
  readonly analytics?: { readonly name?: string };
}

export interface ScreenStates {
  /** `auto` derives a skeleton from each component's declared shape. */
  readonly loading?: 'auto' | SduiNode;
  readonly empty?: SduiNode;
  /** `system` uses the app's system state, which is also bundled in the binary. */
  readonly error?: 'system' | SduiNode;
  readonly offline?: 'system' | SduiNode;
}

export interface Screen {
  readonly id: string;
  readonly slug: string;
  readonly title?: string;
  readonly root: SduiNode;
  readonly states?: ScreenStates;
}

export const SCREEN_ID_PREFIX = 'scr_';

/**
 * A screen's content address. Two screens with the same id are the same screen, so "did Home
 * change in this release?" never needs a walk.
 */
export function screenId(screen: Screen): string {
  return contentAddress(SCREEN_ID_PREFIX, screen);
}

/**
 * How big a screen may be. Generous for anything a person authors and small enough that every
 * function downstream — projection, diffing, hashing, serialising — stays cheap and cannot be
 * driven into the ground by one document.
 */
export const SCREEN_LIMITS = Object.freeze({
  /** Nodes, counting fallbacks and authored states. */
  nodes: 5_000,
  /** How deep nodes nest through slots and fallbacks. */
  depth: 64,
  /** How deep a value nests inside `props` or a flag's `is`. */
  valueDepth: 32,
  /** Scalars, arrays and objects across all props. */
  values: 200_000,
  /** Characters in any one string. */
  string: 100_000,
  /** Characters in any one key inside props. A path in a report repeats every key above it. */
  key: 128,
  /** Characters in all the strings and keys of all props together. */
  characters: 4_000_000,
});

type Fail = (message: string) => never;
interface Budget {
  values: number;
  characters: number;
}
const spend = (budget: Budget, characters: number, fail: Fail): void => {
  budget.characters -= characters;
  if (budget.characters < 0)
    fail(
      `the document's strings and keys come to more than ${SCREEN_LIMITS.characters} characters`,
    );
};

/**
 * Walks an arbitrary JSON value an editor supplied — props, a flag's `is` — and refuses what
 * should never be in one: nesting past the limit, a reserved key, a string long enough to be a
 * payload rather than content.
 */
function checkValue(
  value: unknown,
  where: string,
  depth: number,
  budget: Budget,
  fail: Fail,
): void {
  if (--budget.values < 0)
    fail(`the document holds more than ${SCREEN_LIMITS.values} values`);
  if (typeof value === 'string') {
    if (value.length > SCREEN_LIMITS.string)
      fail(
        `${where} is a string of more than ${SCREEN_LIMITS.string} characters`,
      );
    spend(budget, value.length, fail);
    return;
  }
  const problem = notJson(value);
  if (problem !== null) fail(`${where} is ${problem}, which is not JSON`);
  if (typeof value !== 'object' || value === null) return;
  if (depth >= SCREEN_LIMITS.valueDepth)
    fail(
      `${where} is nested more than ${SCREEN_LIMITS.valueDepth} levels deep`,
    );
  if (Array.isArray(value)) {
    // By index, not `forEach`: that would step over a hole, and a hole is an `undefined`.
    for (let index = 0; index < value.length; index++)
      checkValue(value[index], `${where}[${index}]`, depth + 1, budget, fail);
    return;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (RESERVED_KEYS.has(key)) fail(`${where} uses the reserved key "${key}"`);
    if (key.length > SCREEN_LIMITS.key)
      fail(
        `${where} has a key of more than ${SCREEN_LIMITS.key} characters ("${key.slice(0, 20)}…")`,
      );
    spend(budget, key.length, fail);
    // A key with path punctuation in it could not be told, in a report or a critical path, from
    // a nesting or a list index.
    if (/[.[\]]/.test(key))
      fail(
        `${where} has a key ${JSON.stringify(key.slice(0, 40))} containing ".", "[" or "]"`,
      );
    checkValue(inner, `${where}.${key}`, depth + 1, budget, fail);
  }
}

const CONDITION_KEYS = [
  'flag',
  'platform',
  'appVersion',
  'audience',
  'locale',
  'schedule',
  'all',
  'any',
  'not',
] as const;

function checkCondition(
  value: unknown,
  where: string,
  depth: number,
  budget: Budget,
  fail: Fail,
): void {
  if (--budget.values < 0)
    fail(`the document holds more than ${SCREEN_LIMITS.values} values`);
  if (!isRecord(value)) return fail(`${where} must be an object`);
  if (depth > 16) fail(`${where} is nested more than 16 levels deep`);
  const kinds = CONDITION_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  if (kinds.length !== 1) {
    return fail(
      `${where} must be exactly one of ${CONDITION_KEYS.join(', ')} — conditions are a closed set, not expressions`,
    );
  }
  const kind = kinds[0] as (typeof CONDITION_KEYS)[number];
  const allowed = kind === 'flag' ? ['flag', 'is'] : [kind];
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) fail(`${where} has an unknown key "${extra}"`);
  const body = value[kind];

  const onlyKeys = (
    object: Record<string, unknown>,
    keys: readonly string[],
  ): void => {
    const present = Object.keys(object);
    const unknown = present.find((key) => !keys.includes(key));
    if (unknown !== undefined)
      fail(
        `${where}.${kind} has an unknown key "${unknown}" — it takes ${keys.join(' and ')}`,
      );
    if (present.length === 0)
      fail(`${where}.${kind} needs ${keys.join(' or ')}`);
  };

  switch (kind) {
    case 'flag':
      if (!isSafeName(body)) fail(`${where}.flag must be a flag name`);
      if ('is' in value)
        checkValue(value['is'], `${where}.is`, 0, budget, fail);
      return;
    case 'audience':
      if (!isShortString(body))
        fail(`${where}.audience must be a non-empty string`);
      return;
    case 'platform':
    case 'locale':
      if (
        !Array.isArray(body) ||
        body.length === 0 ||
        body.length > 64 ||
        !body.every(isShortString)
      ) {
        fail(`${where}.${kind} must be an array of 1 to 64 strings`);
      }
      return;
    case 'appVersion':
      if (!isRecord(body)) return fail(`${where}.appVersion must be an object`);
      onlyKeys(body, ['min', 'max']);
      for (const [key, bound] of Object.entries(body)) {
        if (!parseVersion(bound))
          fail(
            `${where}.appVersion.${key} must be a version of dotted numbers, like "5.8.0"`,
          );
      }
      return;
    case 'schedule':
      if (!isRecord(body)) return fail(`${where}.schedule must be an object`);
      onlyKeys(body, ['from', 'until']);
      for (const [key, at] of Object.entries(body)) {
        if (
          typeof at !== 'string' ||
          at.length > 40 ||
          Number.isNaN(new Date(at).getTime())
        )
          fail(
            `${where}.schedule.${key} must be a date and time, like "2026-11-20T00:00:00Z"`,
          );
      }
      return;
    case 'all':
    case 'any':
      if (!Array.isArray(body) || body.length > 64)
        return fail(
          `${where}.${kind} must be an array of at most 64 conditions`,
        );
      // By index: `forEach` steps over a hole, and a hole is not a condition.
      for (let index = 0; index < body.length; index++)
        checkCondition(
          body[index],
          `${where}.${kind}[${index}]`,
          depth + 1,
          budget,
          fail,
        );
      return;
    case 'not':
      checkCondition(body, `${where}.not`, depth + 1, budget, fail);
      return;
  }
}

/**
 * Validates an untrusted value as a condition — for a rollout's audience or a flag rule, which
 * are not inside a screen. Throws `TypeError` naming the first problem.
 */
export function parseCondition(raw: unknown): Condition {
  checkCondition(
    raw,
    'condition',
    0,
    { values: SCREEN_LIMITS.values, characters: SCREEN_LIMITS.characters },
    (message) => {
      throw new TypeError(`sdui condition: ${message}`);
    },
  );
  return raw as Condition;
}

/**
 * Validates an untrusted value as a screen document. Throws `TypeError` naming the first problem
 * and where it is — a malformed screen must fail where it arrived, not inside a projection.
 *
 * Structural: it checks shape, names and size, so that everything downstream can assume them.
 * Whether a screen fits a particular catalog is `validateScreen`'s question.
 */
export function parseScreen(raw: unknown): Screen {
  const fail = (message: string): never => {
    throw new TypeError(`sdui screen: ${message}`);
  };
  if (!isRecord(raw)) return fail('document must be an object');
  const extra = Object.keys(raw).find(
    (key) => !['id', 'slug', 'title', 'root', 'states'].includes(key),
  );
  if (extra !== undefined) fail(`unknown key "${extra}"`);
  if (!isShortString(raw['id']))
    fail('id must be a non-empty string of at most 128 characters');
  if (!isShortString(raw['slug']))
    fail('slug must be a non-empty string of at most 128 characters');
  if (
    raw['title'] !== undefined &&
    (typeof raw['title'] !== 'string' || raw['title'].length > 512)
  )
    fail('title must be a string of at most 512 characters');

  const seen = new Set<string>();
  const budget = {
    values: SCREEN_LIMITS.values,
    characters: SCREEN_LIMITS.characters,
  };

  const checkProps = (props: unknown, where: string): void => {
    if (props === undefined) return;
    if (!isRecord(props)) return fail(`${where} must be an object`);
    checkValue(props, where, 0, budget, fail);
  };

  const checkAction = (value: unknown, where: string, depth: number): void => {
    if (!isRecord(value)) return fail(`${where} must be an object`);
    if (depth > 8) fail(`${where} has more than 8 nested fallbacks`);
    const unknown = Object.keys(value).find(
      (key) => !['type', 'v', 'props', 'fallback', 'unsupported'].includes(key),
    );
    if (unknown !== undefined) fail(`${where} has an unknown key "${unknown}"`);
    if (!isShortString(value['type']))
      fail(`${where}.type must be a non-empty string`);
    if (!isVersion(value['v'])) fail(`${where}.v must be a positive integer`);
    checkProps(value['props'], `${where}.props`);
    if (
      value['unsupported'] !== undefined &&
      value['unsupported'] !== 'disable' &&
      value['unsupported'] !== 'hide'
    ) {
      fail(`${where}.unsupported must be "disable" or "hide"`);
    }
    if (value['fallback'] !== undefined)
      checkAction(value['fallback'], `${where}.fallback`, depth + 1);
  };

  const NODE_KEYS = [
    'id',
    'type',
    'v',
    'props',
    'slots',
    'actions',
    'visibility',
    'fallback',
    'required',
    'analytics',
  ];

  const checkNode = (value: unknown, where: string, depth: number): void => {
    if (!isRecord(value)) return fail(`${where} must be an object`);
    if (depth > SCREEN_LIMITS.depth)
      fail(`${where} is nested more than ${SCREEN_LIMITS.depth} levels deep`);
    const unknown = Object.keys(value).find((key) => !NODE_KEYS.includes(key));
    if (unknown !== undefined) fail(`${where} has an unknown key "${unknown}"`);
    const id = value['id'];
    if (!isShortString(id))
      return fail(
        `${where}.id must be a non-empty string of at most 128 characters`,
      );
    if (seen.has(id))
      fail(`node id "${id}" is used more than once (at ${where})`);
    seen.add(id);
    if (seen.size > SCREEN_LIMITS.nodes)
      fail(`the screen has more than ${SCREEN_LIMITS.nodes} nodes`);
    if (!isShortString(value['type']))
      fail(`${where}.type must be a non-empty string`);
    if (!isVersion(value['v'])) fail(`${where}.v must be a positive integer`);
    checkProps(value['props'], `${where}.props`);
    if (
      value['required'] !== undefined &&
      typeof value['required'] !== 'boolean'
    )
      fail(`${where}.required must be a boolean`);

    if (value['analytics'] !== undefined) {
      const analytics = value['analytics'];
      if (!isRecord(analytics))
        return fail(`${where}.analytics must be an object`);
      const stray = Object.keys(analytics).find((key) => key !== 'name');
      if (stray !== undefined)
        fail(
          `${where}.analytics has an unknown key "${stray}" — it takes a name`,
        );
      if (analytics['name'] !== undefined && !isShortString(analytics['name']))
        fail(
          `${where}.analytics.name must be a non-empty string of at most 128 characters`,
        );
    }
    if (value['slots'] !== undefined) {
      const slots = value['slots'];
      if (!isRecord(slots)) return fail(`${where}.slots must be an object`);
      for (const [slot, children] of Object.entries(slots)) {
        if (!isSafeName(slot))
          fail(
            `${where}.slots has a slot named ${JSON.stringify(slot)} — a slot name is a short plain word`,
          );
        if (!Array.isArray(children))
          return fail(`${where}.slots.${slot} must be an array`);
        // By index: `forEach` steps over a hole, and a hole is not a node.
        for (let index = 0; index < children.length; index++)
          checkNode(
            children[index],
            `${where}.slots.${slot}[${index}]`,
            depth + 1,
          );
      }
    }
    if (value['actions'] !== undefined) {
      const actions = value['actions'];
      if (!isRecord(actions)) return fail(`${where}.actions must be an object`);
      for (const [name, action] of Object.entries(actions)) {
        if (!isSafeName(name))
          fail(
            `${where}.actions has an action named ${JSON.stringify(name)} — an action name is a short plain word`,
          );
        checkAction(action, `${where}.actions.${name}`, 0);
      }
    }
    if (value['visibility'] !== undefined)
      checkCondition(
        value['visibility'],
        `${where}.visibility`,
        0,
        budget,
        fail,
      );
    if (value['fallback'] !== undefined)
      checkNode(value['fallback'], `${where}.fallback`, depth + 1);
  };

  checkNode(raw['root'], 'root', 0);

  if (raw['states'] !== undefined) {
    const states = raw['states'];
    if (!isRecord(states)) return fail('states must be an object');
    for (const [name, value] of Object.entries(states)) {
      const keyword =
        name === 'loading'
          ? 'auto'
          : name === 'error' || name === 'offline'
            ? 'system'
            : null;
      if (!['loading', 'empty', 'error', 'offline'].includes(name))
        fail(`states.${name} is not a screen state that can be authored`);
      if (keyword !== null && value === keyword) continue;
      checkNode(value, `states.${name}`, 0);
    }
  }

  return raw as unknown as Screen;
}

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}
