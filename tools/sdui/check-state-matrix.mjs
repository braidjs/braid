#!/usr/bin/env node
/**
 * Fails when a server-driven UI state has a name and no specification.
 *
 * `libs/sdui/src/lib/states.ts` lists every state a session, a screen, a node and an action can be
 * in. A name there is a promise that the state has been thought through: when it happens and what
 * the user sees. The vectors in `libs/sdui/conformance/states/` are where that promise is kept —
 * facts in, state out — and they are what a client in another language is tested against.
 *
 * So the two must agree in both directions:
 *
 *   - every state has at least one vector (a state nobody specified), and
 *   - every vector names a state that exists (a specification for a state that was renamed away).
 *
 * It also insists that each state type is exactly its list, that the file has no cast, and that each
 * resolver is declared as returning exactly its state type — so that the compiler, not this script,
 * is what stops a resolver returning a state that is not in a list. It reads that one file: it
 * cannot see a state invented in another, and it is a guard against mistakes, not against someone
 * set on getting round it.
 *
 * This reads the source file rather than importing the built package, so it runs before a build
 * and cannot be satisfied by a stale `dist/`.
 *
 *   node tools/sdui/check-state-matrix.mjs [--states <states.ts>] [--vectors <dir>]
 *
 * Exits 1 listing every gap, not just the first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('../../', import.meta.url).pathname);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? resolve(args[index + 1]) : fallback;
};
const statesPath = flag('states', join(root, 'libs/sdui/src/lib/states.ts'));
const vectorsDir = flag('vectors', join(root, 'libs/sdui/conformance/states'));

const LEVELS = {
  SESSION_STATES: 'session',
  SCREEN_STATES: 'screen',
  NODE_STATES: 'node',
  ACTION_STATES: 'action',
};
const failures = [];

// Comments are removed first, so nothing in one can stand in for a declaration: a list or a type
// left behind in a comment is not the list or the type. Strings are stepped over while doing it,
// so a comment opener inside one hides nothing.
function withoutComments(text, { blankStrings = false } = {}) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote !== null) {
      if (char === '\\') {
        if (!blankStrings) out += char + (text[i + 1] ?? '');
        i++;
      } else if (char === quote) {
        quote = null;
        out += char;
      } else if (quote === '`' && char === '$' && text[i + 1] === '{') {
        // What is inside `${…}` is code again, and this scanner does not follow it there.
        templateExpressions++;
        if (!blankStrings) out += char;
      } else if (!blankStrings) {
        out += char;
      }
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else {
      out += char;
    }
  }
  return out;
}
let templateExpressions = 0;
const raw = readFileSync(statesPath, 'utf8');
const source = withoutComments(raw);
// The same, with what is inside every string removed: for looking at the code, where the text of
// a string must not be taken for a declaration or hide one.
const code = withoutComments(raw, { blankStrings: true });
if (templateExpressions > 0)
  failures.push(
    `a template literal with an expression ("\${…}") in ${statesPath} — this check cannot read inside one; build the string another way`,
  );
const declared = new Map();
// Found by position, not by one regex across the file: each list is located at its `export const`
// and read up to the first `] as const`, which is linear however large the file is.
const seenConstants = new Set();
const OPENING = /^export const (\w+_STATES) = \[/gm;
for (let match = OPENING.exec(source); match; match = OPENING.exec(source)) {
  const constant = match[1];
  const start = match.index + match[0].length;
  const end = source.indexOf('] as const', start);
  if (end < 0) {
    failures.push(`${constant} has no closing "] as const" in ${statesPath}`);
    break; // nothing after this point closes either, so there is no reason to look again
  }
  // Exactly `] as const;` and nothing more: a cast after it could widen the list's type to
  // admit a state that is not in it.
  if (!source.startsWith('] as const;', end)) {
    failures.push(
      `${constant} must end with "] as const;" and nothing else — a cast there can add states this check cannot see`,
    );
  }
  if (seenConstants.has(constant))
    failures.push(`${constant} is declared more than once`);
  seenConstants.add(constant);
  const level = LEVELS[constant];
  if (!level) {
    failures.push(
      `${constant} is a state list this check does not know — add its level to LEVELS in tools/sdui/check-state-matrix.mjs`,
    );
    continue;
  }
  const body = source.slice(start, end).replace(/\/\/[^\n]*/g, '');
  // Any quote style: a state added as "x" or `x` is still a state.
  const names = [...body.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)].map(
    (name) => name[1] ?? name[2] ?? name[3],
  );
  // Whatever is left once the names and commas are gone is something this check cannot read —
  // a spread, a variable — and a list it cannot read is a list it cannot vouch for.
  const rest = body
    .replace(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g, '')
    .replace(/[\s,]/g, '');
  if (rest.length > 0)
    failures.push(
      `${constant} holds something other than string literals ("${rest.slice(0, 30)}") — list every state by name`,
    );
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name))
      failures.push(`${level}: "${name}" is listed twice in ${constant}`);
    seen.add(name);
  }
  declared.set(level, seen);
}
for (const [constant, level] of Object.entries(LEVELS)) {
  if (!declared.has(level))
    failures.push(`${constant} was not found in ${statesPath}`);
}

// The lists are only the whole truth if the state types are exactly the lists. A type widened on
// the side — directly, or through an alias — adds a state this check never sees. So each of the
// four state types must be declared as exactly its list, and nothing else.
const TYPES = {
  SESSION_STATES: 'SessionState',
  SCREEN_STATES: 'ScreenState',
  NODE_STATES: 'NodeState',
  ACTION_STATES: 'ActionState',
};
const typeAliases = new Map();
for (const alias of code.matchAll(
  /^export type (\w+)(?:<[^>]*>)? =([^;]*);/gm,
)) {
  if (typeAliases.has(alias[1]))
    failures.push(`type ${alias[1]} is declared more than once`);
  typeAliases.set(alias[1], alias[2].replace(/\s+/g, ''));
}
for (const [constant, type] of Object.entries(TYPES)) {
  const exact = `(typeof${constant})[number]`;
  const declared = typeAliases.get(type);
  if (declared === undefined)
    failures.push(
      `type ${type} is not declared in ${statesPath} — it must be exactly (typeof ${constant})[number]`,
    );
  else if (declared !== exact)
    failures.push(
      `type ${type} is not exactly (typeof ${constant})[number] — every state must be in the ${constant} list, where this check can see it`,
    );
}

// A cast can make a value a state without it being in a list, and a resolver whose return type
// names more than the state type can return one. Neither is needed in this file, so neither is
// allowed: the only `as` is `as const`, and each resolver returns exactly its state type.
// `as` in any spelling — `as X`, `as (X)`, `as (typeof LIST)[number]` — and the older `<X>value`.
const STATE_TYPES =
  'SessionState|ScreenState|NodeState|ActionState|unknown|any|never';
for (const cast of [
  ...code.matchAll(/\bas\b(?!\s+const\b)\s*[^\s;,)]*/g),
  ...code.matchAll(
    new RegExp(
      `(?<![\\w$])<\\s*(?:${STATE_TYPES})(?:\\[\\])?\\s*>\\s*[\\w(<]`,
      'g',
    ),
  ),
])
  failures.push(
    `a cast ("${cast[0].replace(/\s+/g, ' ').trim()}") in ${statesPath} — a value cast to a state need not be in a list; find it in the list instead`,
  );
const RESOLVERS = {
  resolveSessionState: '{state:SessionState;source:UiSource;}',
  resolveScreenState: '{state:ScreenState;source:UiSource;}',
  resolveNodeStates: 'NodeState[]',
  resolveActionState: 'ActionState',
};
for (const [name, returns] of Object.entries(RESOLVERS)) {
  const signature = new RegExp(
    `^export function ${name}\\(facts: \\w+\\):\\s*(\\{[^{}]*\\}|[^{}]*?)\\s*\\{\\n`,
    'm',
  ).exec(code);
  const found = signature?.[1].replace(/\s+/g, '');
  if (found !== returns)
    failures.push(
      `${name} must be declared as returning exactly ${returns} — ${found === undefined ? 'it was not found' : `it returns ${found}`}`,
    );
}

let stateCount = 0;
let vectorCount = 0;
for (const [level, states] of declared) {
  const file = join(vectorsDir, `${level}.json`);
  if (!existsSync(file)) {
    failures.push(`${level}: no vector file at ${file}`);
    continue;
  }
  let vectors;
  try {
    vectors = JSON.parse(readFileSync(file, 'utf8')).vectors;
  } catch (error) {
    failures.push(`${level}: ${file} is not valid JSON (${error.message})`);
    continue;
  }
  if (!Array.isArray(vectors)) {
    failures.push(`${level}: ${file} has no "vectors" array`);
    continue;
  }
  stateCount += states.size;
  vectorCount += vectors.length;

  const specified = new Set();
  vectors.forEach((vector, index) => {
    if (
      typeof vector?.state !== 'string' ||
      typeof vector.given !== 'object' ||
      vector.given === null
    ) {
      failures.push(`${level}: vector ${index} needs a "state" and a "given"`);
      return;
    }
    specified.add(vector.state);
    if (!states.has(vector.state))
      failures.push(
        `${level}: vector ${index} is for "${vector.state}", which is not a ${level} state`,
      );
  });
  for (const state of states) {
    if (!specified.has(state))
      failures.push(
        `${level}: "${state}" has no conformance vector — say when it happens and what the user sees, in ${file}`,
      );
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `state matrix: ${failures.length} problem${failures.length === 1 ? '' : 's'}\n${failures.map((failure) => `  - ${failure}\n`).join('')}`,
  );
  process.exit(1);
}
process.stdout.write(
  `state matrix: ${stateCount} states, ${vectorCount} vectors, every state specified\n`,
);
