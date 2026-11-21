import { canonicalJson } from '@braidlabs/skew';
import { isRecord } from './internal.js';

/**
 * Values bound to data.
 *
 * A prop may hold, instead of a literal, a value that is only known where the screen is rendered:
 * `{ "@path": "/user/name" }` reads the surface's data model, and `{ "@call": "formatCurrency",
 * "args": { … } }` calls one of the catalog's closed list of functions. They are A2UI's dynamic
 * values, and they are data — a path and a name from a list — not code.
 *
 * What they mean for projection is that a migration cannot see through them. A step may move a
 * bound value, wrap it or drop it, because none of that needs to know what it is. A step that
 * converts it, maps over it, or takes a field out of it would need its value, which the server does
 * not have: that is a `gap`, the same answer as a step that cannot be inverted, and the node goes
 * down the ladder instead of reaching a device with a binding a step has mangled.
 */

const BINDING_KEYS = ['@path', '@call'] as const;

/** `{ "@path": … }` or `{ "@call": … }`. */
export function isDynamicValue(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    BINDING_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/**
 * Where a payload holds bound values, as dotted paths with list indices in brackets
 * (`tabs[1].title`). A bound value is a leaf: the arguments of a call are not walked.
 */
export function dynamicPaths(value: unknown, prefix = ''): string[] {
  const found: string[] = [];
  const visit = (inner: unknown, at: string, depth: number): void => {
    if (depth > 64 || typeof inner !== 'object' || inner === null) return;
    if (isDynamicValue(inner)) {
      found.push(at);
      return;
    }
    if (Array.isArray(inner)) {
      for (let index = 0; index < inner.length; index++)
        visit(inner[index], `${at}[${index}]`, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(inner))
      visit(child, at === '' ? key : `${at}.${key}`, depth + 1);
  };
  visit(value, prefix, 0);
  return found;
}

/** True when a payload holds any bound value. Cheap enough to ask before anything else. */
export function hasDynamicValues(value: unknown): boolean {
  return dynamicPaths(value).length > 0;
}

type Op = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

function own(target: unknown, key: string): unknown {
  return isRecord(target) && Object.prototype.hasOwnProperty.call(target, key)
    ? target[key]
    : undefined;
}

/**
 * The first point along `path` (dotted) at which the payload holds a bound value, and whether the
 * path ends there or goes on inside it.
 */
function boundOn(
  value: unknown,
  path: string,
): { readonly at: string; readonly inside: boolean } | null {
  const segments = path.split('.');
  let current = value;
  for (let index = 0; index < segments.length; index++) {
    if (isDynamicValue(current) && index > 0)
      return { at: segments.slice(0, index).join('.'), inside: true };
    current = own(current, segments[index] as string);
  }
  return isDynamicValue(current) ? { at: path, inside: false } : null;
}

const describe = (value: unknown): string => {
  const text = JSON.stringify(value) ?? '';
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
};

/**
 * Why a step's ops cannot run over this payload because of what is bound in it, or `null`.
 * `up` says which way the step runs: unwrapping and hoisting read a field out of a value, and
 * which of them does so depends on the direction.
 *
 * Checked against the payload as it stands before the step. A step of several ops sees the
 * intermediate values only approximately; {@link changedBinding} is the backstop that compares
 * what comes out.
 */
export function boundConflict(
  ops: readonly unknown[],
  value: unknown,
  up: boolean,
  prefix = '',
): string | null {
  const name = (path: string): string =>
    prefix === '' ? path : `${prefix}.${path}`;
  for (const raw of up ? ops : [...ops].reverse()) {
    if (!isRecord(raw)) continue;
    const [kind] = Object.keys(raw);
    const body = (raw as Op)[kind as string];
    if (!isRecord(body)) continue;
    const paths = [
      ...(['path', 'from', 'to'] as const).map((key) => body[key]),
      // values an op reads from elsewhere in the payload: `{ "$from": "a.b" }` in `wrap.also`,
      // `default`, `const`
      ...sources(body),
    ].filter((path): path is string => typeof path === 'string');
    for (const path of paths) {
      const bound = boundOn(value, path);
      if (bound?.inside)
        return `reaches into "${name(bound.at)}", which is bound to data (${describe(getAt(value, bound.at))}) and only known when it is rendered`;
    }
    const path = typeof body['path'] === 'string' ? body['path'] : null;
    if (path === null) continue;
    const target = getAt(value, path);
    const bound = boundOn(value, path);
    if (kind === 'convert' && (bound !== null || hasDynamicValues(target)))
      return `converts "${name(path)}", which is bound to data (${describe(target)}) and only known when it is rendered`;
    if (kind === 'map') {
      if (bound !== null)
        return `maps over "${name(path)}", which is bound to data (${describe(target)}) and only known when it is rendered`;
      if (Array.isArray(target) && Array.isArray(body['ops'])) {
        for (let index = 0; index < target.length; index++) {
          const inner = boundConflict(
            body['ops'] as unknown[],
            target[index],
            up,
            `${name(path)}[${index}]`,
          );
          if (inner !== null) return inner;
        }
      }
    }
    const takesOut = (kind === 'wrap' && !up) || (kind === 'hoist' && up);
    if (takesOut && bound !== null && !bound.inside)
      return `takes a field out of "${name(path)}", which is bound to data (${describe(target)}) and only known when it is rendered`;
  }
  return null;
}

/** Every `$from` an op's body reads, outside a nested `map`'s own ops. */
function sources(body: Readonly<Record<string, unknown>>, depth = 0): string[] {
  const found: string[] = [];
  if (depth > 16) return found;
  for (const [key, inner] of Object.entries(body)) {
    if (key === 'ops') continue;
    if (key === '$from' && typeof inner === 'string') found.push(inner);
    else if (isRecord(inner)) found.push(...sources(inner, depth + 1));
  }
  return found;
}

function getAt(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) current = own(current, segment);
  return current;
}

/**
 * The first bound value in `output` that is not, unchanged, one of the bound values in `input` —
 * a binding some step altered — as its path, or `null`. A bound value that is gone is not
 * reported here: that is a loss, and losses are measured by the round trip like any other.
 */
export function changedBinding(input: unknown, output: unknown): string | null {
  const before = new Set<string>();
  for (const path of dynamicPaths(input))
    before.add(canonicalJson(atPath(input, path)));
  for (const path of dynamicPaths(output)) {
    if (!before.has(canonicalJson(atPath(output, path))))
      return path === '' ? '(the props)' : path;
  }
  return null;
}

/** Reads a path as {@link dynamicPaths} writes it. */
function atPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  let current = value;
  for (const part of path.match(/[^.[\]]+|\[\d+\]/g) ?? []) {
    if (part.startsWith('[')) {
      const index = Number(part.slice(1, -1));
      current = Array.isArray(current) ? current[index] : undefined;
    } else current = own(current, part);
  }
  return current;
}

/**
 * Every function a value calls: the `@call` of each call in it, the functions named inside a
 * `formatString` template (`${formatDate(value:${/d}, format:'yyyy')}`), and an `a2ui.call`
 * action's `call`. System functions (`@index`) are left out: every renderer has them.
 */
export function callsIn(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (inner: unknown, depth: number): void => {
    if (depth > 64 || typeof inner !== 'object' || inner === null) return;
    if (Array.isArray(inner)) {
      for (const item of inner) visit(item, depth + 1);
      return;
    }
    const record = inner as Record<string, unknown>;
    const call = Object.prototype.hasOwnProperty.call(record, '@call')
      ? record['@call']
      : undefined;
    if (typeof call === 'string') {
      if (!call.startsWith('@')) found.add(call);
      const args = record['args'];
      if (
        call === 'formatString' &&
        isRecord(args) &&
        typeof args['value'] === 'string'
      )
        for (const name of templateCalls(args['value'])) found.add(name);
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(value, 0);
  return [...found];
}

/** Function names called inside a `formatString` template: an identifier followed by `(`. */
function templateCalls(template: string): string[] {
  const names: string[] = [];
  let depth = 0;
  // Only inside `${…}`: a "(" in the text around the expressions is just text.
  for (let index = 0; index < template.length; index++) {
    const char = template[index];
    if (char === '\\' && template[index + 1] === '$') {
      index++;
      continue;
    }
    if (char === '$' && template[index + 1] === '{') {
      depth++;
      index++;
      continue;
    }
    if (char === '}' && depth > 0) {
      depth--;
      continue;
    }
    if (depth > 0) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
        template.slice(index, index + 80),
      );
      if (
        match &&
        (index === 0 || !/[A-Za-z0-9_@]/.test(template[index - 1] as string))
      ) {
        names.push(match[1] as string);
        index += (match[1] as string).length - 1;
      }
    }
  }
  return names;
}
