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
 * It also insists that each state type is exactly its list, so a state cannot be added to the type
 * and left out of the list. It cannot see a state invented somewhere other than that file.
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
// left behind in a comment is not the list or the type.
const source = readFileSync(statesPath, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
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
const typeAliases = new Map(
  [...source.matchAll(/^export type (\w+)(?:<[^>]*>)? =([^;]*);/gm)].map(
    (alias) => [alias[1], alias[2].replace(/\s+/g, '')],
  ),
);
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
