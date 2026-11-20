import { isRecord, outgrows } from '../lib/internal.js';
import { readPointer } from '../a2ui/surfaces.js';
import {
  type A2uiRegex,
  MatchBudget,
  RegexDialectError,
  a2uiRegexMatches,
  compileA2uiRegex,
} from './regex.js';

/**
 * Evaluating A2UI dynamic values — bindings, function calls, `formatString` templates — over a
 * surface's data model.
 *
 * Everything here runs on what an agent sent, so it is a closed interpreter with a budget: the
 * functions are the basic catalog's (and any a host registers), a template is parsed by a small
 * grammar that has no operators, every evaluation has a ceiling on calls and depth, and a URL is
 * checked against a policy before anything can open it. A failure is never an exception thrown
 * into the page: it is reported (`EXPRESSION_ERROR`) and the value is `null`, which is what the
 * spec says a failed binding resolves to.
 */

export interface EvaluationScope {
  /** Where relative paths start: the template item's location, `[]` at the root. */
  readonly base: readonly string[];
  /** The innermost template iteration's index, for `@index`. */
  readonly index?: number;
}

export const ROOT_SCOPE: EvaluationScope = Object.freeze({ base: [] });

export interface ValidationResult {
  readonly valid: boolean;
  readonly message?: string;
  readonly severity?: 'error' | 'warning' | 'info';
}

export type ReportedError = { readonly code: string; readonly message: string };

/**
 * Which URLs may be used, and for what.
 *
 * - Links and `openUrl` — which need a person's click — default to `https:`, `http:`, `mailto:`
 *   and `tel:` on any host; `hosts` limits absolute http(s) links (`*.example.com` matches
 *   subdomains).
 * - Media load by themselves, the moment they are drawn, so they are a channel out: an image URL
 *   built from bound data would send what someone types to whoever the URL names. So absolute
 *   media URLs are refused unless their host is in `mediaHosts`; relative URLs (the page's own
 *   origin) and `data:` raster images are allowed.
 */
export interface UrlPolicy {
  readonly linkSchemes?: readonly string[];
  readonly mediaSchemes?: readonly string[];
  readonly hosts?: readonly string[];
  /** Hosts images, video and audio may load from. None by default. */
  readonly mediaHosts?: readonly string[];
}

const hostMatches = (host: string, patterns: readonly string[]): boolean =>
  patterns.some(
    (pattern) =>
      pattern === '*' ||
      (pattern.startsWith('*.')
        ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
        : host === pattern),
  );

export type UrlUse = 'link' | 'image' | 'media';

export type UrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

const DATA_IMAGE =
  /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;

/** Whether a URL from content may be used: the renderer's `blocked-url` state when not. */
export function checkUrl(
  raw: unknown,
  use: UrlUse,
  policy: UrlPolicy = {},
): UrlCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'not a URL' };
  // What the URL parser strips: C0 controls and spaces at the ends — and nothing else.
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  if (stripped === '') return { ok: false, reason: 'not a URL' };
  // Whitespace the URL parser keeps but a person or a careless consumer would not — U+00A0,
  // U+FEFF, U+3000 around "javascript:" — is a disguise, not a URL.
  if (stripped.trim() !== stripped)
    return {
      ok: false,
      reason: 'a URL that begins or ends with invisible characters',
    };
  if (raw.length > 8_192)
    return { ok: false, reason: 'a URL longer than 8192 characters' };
  if (use === 'image' && stripped.toLowerCase().startsWith('data:'))
    return DATA_IMAGE.test(stripped)
      ? { ok: true, url: stripped }
      : { ok: false, reason: 'a data URL that is not an image' };
  let parsed: URL;
  const PROBE = 'https://relative.a2ui.invalid';
  // A URL that names a scheme is absolute, whatever the page's base: against an https: base,
  // "https:attacker.example" would parse as a path, and on an http: page it is a host. The parser
  // drops tabs and newlines anywhere, so they are dropped before looking.
  const named = /^[a-z][a-z0-9+.-]*:/i.test(stripped.replace(/[\t\n\r]/g, ''));
  try {
    // The WHATWG parser is what a browser will use, so it decides: "java\tscript:" is javascript:.
    parsed = named ? new URL(stripped) : new URL(stripped, `${PROBE}/`);
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  // Relative: the page's own origin. Returned stripped exactly as the URL parser strips it —
  // C0 controls and spaces at the ends — and no more: String#trim also strips U+00A0 and U+FEFF,
  // which the parser keeps, so a trimmed " javascript:…" would be a different URL from the one
  // just checked.
  if (parsed.origin === PROBE) return { ok: true, url: stripped };
  const schemes =
    use === 'link'
      ? (policy.linkSchemes ?? ['https:', 'http:', 'mailto:', 'tel:'])
      : (policy.mediaSchemes ?? ['https:', 'http:']);
  if (!schemes.includes(parsed.protocol))
    return {
      ok: false,
      reason: `the "${parsed.protocol}" scheme is not allowed`,
    };
  const web = parsed.protocol === 'https:' || parsed.protocol === 'http:';
  if (
    use !== 'link' &&
    web &&
    !hostMatches(parsed.hostname, policy.mediaHosts ?? [])
  )
    return {
      ok: false,
      reason: `"${parsed.hostname}" is not a host this page loads media from`,
    };
  if (
    use === 'link' &&
    policy.hosts &&
    web &&
    !hostMatches(parsed.hostname, policy.hosts)
  )
    return {
      ok: false,
      reason: `"${parsed.hostname}" is not a host this page allows`,
    };
  return { ok: true, url: parsed.href };
}

/**
 * Whether a URL's scheme is one a view may ever write, whatever a page's policy: the backstop the
 * view applies to every URL attribute. Hosts are the page policy's business, checked before.
 */
export function urlSchemeAllowed(raw: string, use: UrlUse): boolean {
  return checkUrl(raw, use, { mediaHosts: ['*'] }).ok;
}

/** A function a host adds to the evaluator, for a catalog of its own. */
export type HostFunction = (
  args: Readonly<Record<string, unknown>>,
  context: { readonly activated: boolean },
) => unknown;

export interface EvaluatorOptions {
  /** The surface's data model, read afresh on each evaluation. */
  readonly model: () => unknown;
  readonly locale?: string;
  /** IANA time zone for `formatDate`. A prerendered page and its renderer must agree on it. */
  readonly timeZone?: string;
  readonly urlPolicy?: UrlPolicy;
  /** Opens a URL `openUrl` was given, after the policy allowed it. Absent: `openUrl` does nothing. */
  readonly openUrl?: (url: string) => void;
  readonly functions?: Readonly<Record<string, HostFunction>>;
  readonly report: (error: ReportedError) => void;
}

/** Regex steps one draw of a surface may take across all its matches: well under a frame's worth of work per check. */
export const DRAW_MATCH_STEPS = 2_000_000;

export const EVALUATION_LIMITS = Object.freeze({
  /** Function calls in one evaluation, templates included. */
  calls: 256,
  /** Nesting of calls and templates. */
  depth: 16,
  /** Characters a template may have, and a string an evaluation may build. */
  template: 8_192,
  output: 100_000,
});

class Budget {
  calls = 0;
}

class ExpressionError extends Error {}

export interface Evaluator {
  /** A dynamic value: a literal, `{ "@path" }`, or `{ "@call" }`. `null` when it fails. */
  value(raw: unknown, scope?: EvaluationScope): unknown;
  /** As a `DynamicBoolean`, with the spec's coercions. */
  boolean(raw: unknown, scope?: EvaluationScope): boolean;
  /** As a `DynamicString`: what is shown. */
  text(raw: unknown, scope?: EvaluationScope): string;
  /** A component's `@checks`. */
  checks(
    rules: unknown,
    scope?: EvaluationScope,
  ): { readonly valid: boolean; readonly messages: readonly string[] };
  /** Starts a draw: regex matching shares one step budget until the next. */
  beginDraw(): void;
  /** A function call made by a user gesture: `openUrl` runs only here. */
  activate(call: unknown, scope?: EvaluationScope): unknown;
}

/** The spec's `DynamicBoolean` coercion table. */
export function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (isRecord(value) && typeof value['valid'] === 'boolean')
    return value['valid'];
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  return false;
}

/** `formatString`'s conversion: `null` is empty, objects are JSON. */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  // A binding to the whole data model is drawn on every redraw; past this, it is not drawn.
  if (outgrows(value, { depth: 32, values: 10_000 }) !== null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export function createEvaluator(options: EvaluatorOptions): Evaluator {
  const locale = options.locale ?? 'en-US';
  const regexes = new Map<string, A2uiRegex | RegexDialectError>();
  /** Shared by every match until the next `beginDraw`: see {@link MatchBudget}. */
  let drawBudget = new MatchBudget(DRAW_MATCH_STEPS);

  const fail = (message: string): never => {
    throw new ExpressionError(message);
  };

  function evaluate(
    raw: unknown,
    scope: EvaluationScope,
    budget: Budget,
    depth: number,
    activated: boolean,
  ): unknown {
    if (depth > EVALUATION_LIMITS.depth)
      fail(`expressions nest more than ${EVALUATION_LIMITS.depth} levels deep`);
    if (raw === null || typeof raw !== 'object') return raw;
    if (Array.isArray(raw))
      return raw.map((item) =>
        evaluate(item, scope, budget, depth + 1, activated),
      );
    if (Object.prototype.hasOwnProperty.call(raw, '@path')) {
      const path = (raw as Record<string, unknown>)['@path'];
      if (typeof path !== 'string')
        fail('a binding names its path as a string');
      return readPointer(options.model(), path as string, scope) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(raw, '@call'))
      return call(
        raw as Record<string, unknown>,
        scope,
        budget,
        depth,
        activated,
      );
    // A literal object: its values may be bound, and "@@key" is the literal key "@key".
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      const literal = key.startsWith('@@') ? key.slice(1) : key;
      Object.defineProperty(out, literal, {
        value: evaluate(value, scope, budget, depth + 1, activated),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }

  function call(
    raw: Record<string, unknown>,
    scope: EvaluationScope,
    budget: Budget,
    depth: number,
    activated: boolean,
  ): unknown {
    if (++budget.calls > EVALUATION_LIMITS.calls)
      fail(`more than ${EVALUATION_LIMITS.calls} function calls in one value`);
    const name = raw['@call'];
    if (typeof name !== 'string')
      return fail('a call names its function as a string');
    const rawArgs = isRecord(raw['args']) ? raw['args'] : {};
    // No prototype: an argument named "__proto__" is an argument, not a way to the object's.
    const args: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(rawArgs))
      args[key] =
        name === 'formatString' && key === 'value'
          ? value
          : evaluate(value, scope, budget, depth + 1, activated);
    // A template is interpolated only when it was written as one: a bound value is data, and
    // text someone typed must not become an expression.
    return run(
      name,
      args,
      scope,
      budget,
      depth,
      activated,
      typeof rawArgs['value'] === 'string',
    );
  }

  function run(
    name: string,
    args: Record<string, unknown>,
    scope: EvaluationScope,
    budget: Budget,
    depth: number,
    activated: boolean,
    literalTemplate = false,
  ): unknown {
    const num = (value: unknown, what: string): number => {
      const n =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : NaN;
      if (!Number.isFinite(n)) fail(`${name}: ${what} is not a number`);
      return n;
    };
    const decimals = (value: unknown): number | undefined => {
      if (value === undefined || value === null) return undefined;
      const n = num(value, 'decimals');
      if (!Number.isInteger(n) || n < 0 || n > 20)
        fail(`${name}: decimals must be a whole number from 0 to 20`);
      return n;
    };
    const valid = (ok: boolean): ValidationResult => ({ valid: ok });
    switch (name) {
      case '@index':
        if (scope.index === undefined)
          return fail('@index is only available inside a template');
        return (
          scope.index +
          (args['offset'] === undefined ? 0 : num(args['offset'], 'offset'))
        );
      case 'required': {
        const v = args['value'];
        return valid(
          !(
            v === null ||
            v === undefined ||
            v === '' ||
            (Array.isArray(v) && v.length === 0)
          ),
        );
      }
      case 'regex': {
        const pattern = args['pattern'];
        if (typeof pattern !== 'string')
          return fail('regex: pattern must be a string');
        let compiled = regexes.get(pattern);
        if (compiled === undefined) {
          try {
            compiled = compileA2uiRegex(pattern);
          } catch (error) {
            compiled =
              error instanceof RegexDialectError
                ? error
                : new RegexDialectError(String(error));
          }
          if (regexes.size > 64) regexes.clear();
          regexes.set(pattern, compiled);
        }
        if (compiled instanceof RegexDialectError)
          return fail(`regex: ${compiled.message}`);
        return valid(
          a2uiRegexMatches(compiled, toText(args['value']), drawBudget),
        );
      }
      case 'length': {
        const length = [...toText(args['value'])].length;
        const min = args['min'] === undefined ? 0 : num(args['min'], 'min');
        const max =
          args['max'] === undefined ? Infinity : num(args['max'], 'max');
        return valid(length >= min && length <= max);
      }
      case 'numeric': {
        const raw = args['value'];
        const n =
          typeof raw === 'number'
            ? raw
            : typeof raw === 'string' && raw.trim() !== ''
              ? Number(raw)
              : NaN;
        if (!Number.isFinite(n)) return valid(false);
        const min =
          args['min'] === undefined ? -Infinity : num(args['min'], 'min');
        const max =
          args['max'] === undefined ? Infinity : num(args['max'], 'max');
        return valid(n >= min && n <= max);
      }
      case 'email':
        return valid(
          /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(toText(args['value'])),
        );
      case 'formatString': {
        const template = args['value'];
        if (typeof template !== 'string' || !literalTemplate)
          return toText(
            evaluate(template, scope, budget, depth + 1, activated),
          );
        return interpolate(template, scope, budget, depth + 1, activated);
      }
      case 'formatNumber': {
        const d = decimals(args['decimals']);
        return new Intl.NumberFormat(locale, {
          ...(d !== undefined
            ? { minimumFractionDigits: d, maximumFractionDigits: d }
            : {}),
          useGrouping:
            args['grouping'] === undefined ? true : toBoolean(args['grouping']),
        }).format(num(args['value'], 'value'));
      }
      case 'formatCurrency': {
        const currency = toText(args['currency']).toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency))
          fail('formatCurrency: currency must be an ISO 4217 code');
        const d = decimals(args['decimals']);
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          ...(d !== undefined
            ? { minimumFractionDigits: d, maximumFractionDigits: d }
            : {}),
          useGrouping:
            args['grouping'] === undefined ? true : toBoolean(args['grouping']),
        }).format(num(args['value'], 'value'));
      }
      case 'formatDate':
        return formatDate(
          args['value'],
          toText(args['format']),
          locale,
          options.timeZone,
        );
      case 'pluralize': {
        const category = new Intl.PluralRules(locale).select(
          num(args['value'], 'value'),
        );
        const chosen =
          args[category] ??
          (category !== 'other' && num(args['value'], 'value') === 0
            ? args['zero']
            : undefined) ??
          args['other'];
        return toText(chosen);
      }
      case 'and':
      case 'or': {
        const values = args['values'];
        if (!Array.isArray(values))
          return fail(`${name}: values must be a list`);
        const booleans = values.map(toBoolean);
        return name === 'and'
          ? booleans.every(Boolean)
          : booleans.some(Boolean);
      }
      case 'not':
        return !toBoolean(args['value']);
      case 'openUrl': {
        if (!activated) return fail('openUrl can only run from a user gesture');
        const checked = checkUrl(args['url'], 'link', options.urlPolicy);
        if (!checked.ok)
          return fail(`openUrl: blocked-url — ${checked.reason}`);
        options.openUrl?.(checked.url);
        return null;
      }
      default: {
        const host =
          options.functions &&
          Object.prototype.hasOwnProperty.call(options.functions, name)
            ? options.functions[name]
            : undefined;
        if (!host) return fail(`"${name}" is not a function this renderer has`);
        return host(args, { activated });
      }
    }
  }

  // --- formatString -----------------------------------------------------------------------------

  type Expr =
    | { readonly kind: 'path'; readonly path: string }
    | { readonly kind: 'literal'; readonly value: unknown }
    | {
        readonly kind: 'call';
        readonly name: string;
        readonly args: readonly (readonly [string, Expr])[];
      };

  /** Parses the inside of one `${…}`, from `from`; returns the expression and where it ended. */
  function parseExpr(
    source: string,
    from: number,
    depth: number,
  ): { expr: Expr; end: number } {
    if (depth > EVALUATION_LIMITS.depth) fail('a template nests too deeply');
    let at = from;
    const ws = () => {
      while (/\s/.test(source[at] ?? '')) at++;
    };
    ws();
    const c = source[at];
    if (c === '$' && source[at + 1] === '{') {
      const inner = parseExpr(source, at + 2, depth + 1);
      at = inner.end;
      ws();
      if (source[at] !== '}') fail('a "${" is not closed');
      return { expr: inner.expr, end: at + 1 };
    }
    if (c === "'" || c === '"') {
      let value = '';
      at++;
      while (at < source.length && source[at] !== c) {
        if (source[at] === '\\' && at + 1 < source.length) at++;
        value += source[at++];
      }
      if (source[at] !== c) fail('a string in a template is not closed');
      return { expr: { kind: 'literal', value }, end: at + 1 };
    }
    const number = /^-?\d+(\.\d+)?/.exec(source.slice(at, at + 40));
    if (number && !/[A-Za-z_/]/.test(source[at + number[0].length] ?? ''))
      return {
        expr: { kind: 'literal', value: Number(number[0]) },
        end: at + number[0].length,
      };
    const word = /^@?[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at, at + 128));
    if (word) {
      let after = at + word[0].length;
      while (/\s/.test(source[after] ?? '')) after++;
      if (source[after] === '(') {
        at = after + 1;
        const args: [string, Expr][] = [];
        ws();
        while (source[at] !== ')') {
          if (at >= source.length) fail('a call in a template is not closed');
          const named = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(
            source.slice(at, at + 128),
          );
          let key = args.length === 0 ? 'value' : `arg${args.length}`;
          if (named) {
            key = named[1] as string;
            at += named[0].length;
          }
          const arg = parseArg(source, at, depth + 1);
          args.push([key, arg.expr]);
          at = arg.end;
          ws();
          if (source[at] === ',') {
            at++;
            ws();
          } else if (source[at] !== ')') fail('expected "," or ")" in a call');
        }
        return { expr: { kind: 'call', name: word[0], args }, end: at + 1 };
      }
      if (
        ['true', 'false', 'null'].includes(word[0]) &&
        !/[/]/.test(source[at + word[0].length] ?? '')
      )
        return {
          expr: { kind: 'literal', value: JSON.parse(word[0]) },
          end: at + word[0].length,
        };
    }
    // Anything else is a path, up to the end of the expression.
    let end = at;
    while (end < source.length && !'},)'.includes(source[end] as string)) end++;
    const path = source.slice(at, end).trim();
    if (path === '') fail('an empty expression in a template');
    return { expr: { kind: 'path', path }, end };
  }

  function parseArg(
    source: string,
    at: number,
    depth: number,
  ): { expr: Expr; end: number } {
    return parseExpr(source, at, depth);
  }

  function evalExpr(
    expr: Expr,
    scope: EvaluationScope,
    budget: Budget,
    depth: number,
    activated: boolean,
  ): unknown {
    switch (expr.kind) {
      case 'literal':
        return expr.value;
      case 'path':
        return readPointer(options.model(), expr.path, scope) ?? null;
      case 'call': {
        if (++budget.calls > EVALUATION_LIMITS.calls)
          fail(
            `more than ${EVALUATION_LIMITS.calls} function calls in one value`,
          );
        const args: Record<string, unknown> = Object.create(null);
        for (const [key, value] of expr.args)
          args[key] = evalExpr(value, scope, budget, depth + 1, activated);
        const literal =
          expr.args.find(([key]) => key === 'value')?.[1].kind === 'literal';
        return run(
          expr.name,
          args,
          scope,
          budget,
          depth + 1,
          activated,
          literal,
        );
      }
    }
  }

  function interpolate(
    template: string,
    scope: EvaluationScope,
    budget: Budget,
    depth: number,
    activated: boolean,
  ): string {
    if (template.length > EVALUATION_LIMITS.template)
      fail(
        `a template is longer than ${EVALUATION_LIMITS.template} characters`,
      );
    let out = '';
    let at = 0;
    while (at < template.length) {
      const c = template[at] as string;
      if (c === '\\' && template[at + 1] === '$' && template[at + 2] === '{') {
        out += '${';
        at += 3;
        continue;
      }
      if (c === '$' && template[at + 1] === '{') {
        const { expr, end } = parseExpr(template, at + 2, depth);
        if (template[end] !== '}') fail('a "${" is not closed');
        out += toText(evalExpr(expr, scope, budget, depth, activated));
        at = end + 1;
      } else {
        out += c;
        at++;
      }
      if (out.length > EVALUATION_LIMITS.output)
        fail('a template builds a string that is too long');
    }
    return out;
  }

  // --- the evaluator ----------------------------------------------------------------------------

  const guarded = <T>(fallback: T, work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (
        !(
          error instanceof ExpressionError ||
          error instanceof RegexDialectError ||
          error instanceof RangeError ||
          error instanceof TypeError
        )
      )
        throw error;
      options.report({ code: 'EXPRESSION_ERROR', message: error.message });
      return fallback;
    }
  };

  return {
    value: (raw, scope = ROOT_SCOPE) =>
      guarded(null as unknown, () =>
        evaluate(raw, scope, new Budget(), 0, false),
      ),
    boolean: (raw, scope = ROOT_SCOPE) =>
      guarded(false, () =>
        toBoolean(evaluate(raw, scope, new Budget(), 0, false)),
      ),
    text: (raw, scope = ROOT_SCOPE) =>
      guarded('', () => toText(evaluate(raw, scope, new Budget(), 0, false))),
    activate: (raw, scope = ROOT_SCOPE) =>
      guarded(null as unknown, () =>
        evaluate(raw, scope, new Budget(), 0, true),
      ),
    beginDraw() {
      drawBudget = new MatchBudget(DRAW_MATCH_STEPS);
    },
    checks(rules, scope = ROOT_SCOPE) {
      if (!Array.isArray(rules)) return { valid: true, messages: [] };
      const messages: string[] = [];
      let valid = true;
      for (const rule of rules) {
        if (!isRecord(rule)) continue;
        const fallback =
          typeof rule['message'] === 'string' ? rule['message'] : undefined;
        const result = guarded<unknown>(false, () =>
          evaluate(rule['condition'], scope, new Budget(), 0, false),
        );
        const ok =
          isRecord(result) && typeof result['valid'] === 'boolean'
            ? result['valid']
            : toBoolean(result);
        if (ok) continue;
        valid = false;
        const message =
          isRecord(result) && typeof result['message'] === 'string'
            ? result['message']
            : fallback;
        if (message) messages.push(message);
      }
      return { valid, messages };
    },
  };
}

// --- dates --------------------------------------------------------------------------------------

function formatDate(
  value: unknown,
  pattern: string,
  locale: string,
  timeZone?: string,
): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value)
        : typeof value === 'string'
          ? new Date(value)
          : new Date(NaN);
  if (Number.isNaN(date.getTime()))
    throw new ExpressionError('formatDate: value is not a date');
  if (pattern.length > 256)
    throw new ExpressionError('formatDate: the format is too long');
  const zone = timeZone ? { timeZone } : {};
  const part = (
    opts: Intl.DateTimeFormatOptions,
    type: Intl.DateTimeFormatPartTypes,
  ): string =>
    new Intl.DateTimeFormat(locale, { ...zone, ...opts })
      .formatToParts(date)
      .find((p) => p.type === type)?.value ?? '';
  const pad = (n: string, width: number) => n.padStart(width, '0');
  const numeric = (
    opts: Intl.DateTimeFormatOptions,
    type: Intl.DateTimeFormatPartTypes,
  ) =>
    String(
      Number(
        new Intl.DateTimeFormat('en-US', { ...zone, ...opts })
          .formatToParts(date)
          .find((p) => p.type === type)?.value ?? '0',
      ),
    );
  let out = '';
  let at = 0;
  while (at < pattern.length) {
    const c = pattern[at] as string;
    if (c === "'") {
      const close = pattern.indexOf("'", at + 1);
      if (close === at + 1) out += "'";
      else out += pattern.slice(at + 1, close === -1 ? undefined : close);
      at = close === -1 ? pattern.length : close + 1;
      continue;
    }
    let run = 1;
    while (pattern[at + run] === c) run++;
    at += run;
    switch (c) {
      case 'y':
      case 'Y': {
        const year = numeric({ year: 'numeric' }, 'year');
        out += run === 2 ? pad(year, 4).slice(-2) : year;
        break;
      }
      case 'M':
        out +=
          run >= 4
            ? part({ month: 'long' }, 'month')
            : run === 3
              ? part({ month: 'short' }, 'month')
              : run === 2
                ? pad(numeric({ month: 'numeric' }, 'month'), 2)
                : numeric({ month: 'numeric' }, 'month');
        break;
      case 'd': {
        const day = numeric({ day: 'numeric' }, 'day');
        out += run >= 2 ? pad(day, 2) : day;
        break;
      }
      case 'E':
        out += part({ weekday: run >= 4 ? 'long' : 'short' }, 'weekday');
        break;
      case 'H': {
        const hour = String(
          Number(numeric({ hour: 'numeric', hourCycle: 'h23' }, 'hour')) % 24,
        );
        out += run >= 2 ? pad(hour, 2) : hour;
        break;
      }
      case 'h': {
        const hour = numeric({ hour: 'numeric', hour12: true }, 'hour');
        out += run >= 2 ? pad(hour, 2) : hour;
        break;
      }
      case 'm':
        out += pad(numeric({ minute: 'numeric' }, 'minute'), 2);
        break;
      case 's':
        out += pad(numeric({ second: 'numeric' }, 'second'), 2);
        break;
      case 'a':
        out += part({ hour: 'numeric', hour12: true }, 'dayPeriod');
        break;
      default:
        out += c.repeat(run);
    }
  }
  return out;
}
