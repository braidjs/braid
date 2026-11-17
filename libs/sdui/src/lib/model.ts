import { contentAddress } from './hash.js';

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
   * (the default) keeps it visible and inert; `hide` removes the node. Never a dead button that
   * looks live.
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
  /** A required node that cannot be rendered makes the whole screen unrenderable for that device. */
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

const MAX_DEPTH = 64;

/**
 * Validates an untrusted value as a screen document. Throws `TypeError` naming the first problem
 * and where it is — a malformed screen must fail where it arrived, not inside a projection.
 *
 * Structural only: whether props match their component's schema is a question for the catalog.
 */
export function parseScreen(raw: unknown): Screen {
  const fail = (message: string): never => {
    throw new TypeError(`sdui screen: ${message}`);
  };
  if (!isRecord(raw)) return fail('document must be an object');
  if (!isNonEmptyString(raw['id'])) fail('id must be a non-empty string');
  if (!isNonEmptyString(raw['slug'])) fail('slug must be a non-empty string');
  if (raw['title'] !== undefined && typeof raw['title'] !== 'string')
    fail('title must be a string');

  const seen = new Set<string>();

  const checkAction = (value: unknown, where: string, depth: number): void => {
    if (!isRecord(value)) return fail(`${where} must be an object`);
    if (depth > 8) fail(`${where} has more than 8 nested fallbacks`);
    if (!isNonEmptyString(value['type']))
      fail(`${where}.type must be a non-empty string`);
    if (!isVersion(value['v'])) fail(`${where}.v must be a positive integer`);
    if (value['props'] !== undefined && !isRecord(value['props']))
      fail(`${where}.props must be an object`);
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

  const checkNode = (value: unknown, where: string, depth: number): void => {
    if (!isRecord(value)) return fail(`${where} must be an object`);
    if (depth > MAX_DEPTH)
      fail(`${where} is nested more than ${MAX_DEPTH} levels deep`);
    const id = value['id'];
    if (!isNonEmptyString(id))
      return fail(`${where}.id must be a non-empty string`);
    if (seen.has(id))
      fail(`node id "${id}" is used more than once (at ${where})`);
    seen.add(id);
    if (!isNonEmptyString(value['type']))
      fail(`${where}.type must be a non-empty string`);
    if (!isVersion(value['v'])) fail(`${where}.v must be a positive integer`);
    if (value['props'] !== undefined && !isRecord(value['props']))
      fail(`${where}.props must be an object`);
    if (
      value['required'] !== undefined &&
      typeof value['required'] !== 'boolean'
    )
      fail(`${where}.required must be a boolean`);

    if (value['slots'] !== undefined) {
      const slots = value['slots'];
      if (!isRecord(slots)) return fail(`${where}.slots must be an object`);
      for (const [slot, children] of Object.entries(slots)) {
        if (!Array.isArray(children))
          return fail(`${where}.slots.${slot} must be an array`);
        children.forEach((child, index) =>
          checkNode(child, `${where}.slots.${slot}[${index}]`, depth + 1),
        );
      }
    }
    if (value['actions'] !== undefined) {
      const actions = value['actions'];
      if (!isRecord(actions)) return fail(`${where}.actions must be an object`);
      for (const [name, action] of Object.entries(actions))
        checkAction(action, `${where}.actions.${name}`, 0);
    }
    if (value['visibility'] !== undefined)
      checkCondition(value['visibility'], `${where}.visibility`, 0, fail);
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
  fail: (message: string) => never,
): void {
  if (!isRecord(value)) return fail(`${where} must be an object`);
  if (depth > 16) fail(`${where} is nested more than 16 levels deep`);
  const kinds = CONDITION_KEYS.filter((key) => key in value);
  if (kinds.length !== 1) {
    return fail(
      `${where} must be exactly one of ${CONDITION_KEYS.join(', ')} — conditions are a closed set, not expressions`,
    );
  }
  const kind = kinds[0] as (typeof CONDITION_KEYS)[number];
  const body = value[kind];
  switch (kind) {
    case 'flag':
    case 'audience':
      if (!isNonEmptyString(body))
        fail(`${where}.${kind} must be a non-empty string`);
      return;
    case 'platform':
    case 'locale':
      if (!Array.isArray(body) || !body.every(isNonEmptyString))
        fail(`${where}.${kind} must be an array of strings`);
      return;
    case 'appVersion':
    case 'schedule':
      if (!isRecord(body)) fail(`${where}.${kind} must be an object`);
      return;
    case 'all':
    case 'any':
      if (!Array.isArray(body))
        return fail(`${where}.${kind} must be an array`);
      body.forEach((inner, index) =>
        checkCondition(inner, `${where}.${kind}[${index}]`, depth + 1, fail),
      );
      return;
    case 'not':
      checkCondition(body, `${where}.not`, depth + 1, fail);
      return;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isVersion(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}
