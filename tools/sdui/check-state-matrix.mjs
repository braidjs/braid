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

const source = readFileSync(statesPath, 'utf8');
const declared = new Map();
for (const match of source.matchAll(
  /export const (\w+_STATES) = \[([\s\S]*?)\] as const;/g,
)) {
  const level = LEVELS[match[1]];
  if (!level) {
    failures.push(
      `${match[1]} is a state list this check does not know — add its level to LEVELS in tools/sdui/check-state-matrix.mjs`,
    );
    continue;
  }
  const names = [...match[2].matchAll(/'([^']+)'/g)].map((name) => name[1]);
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name))
      failures.push(`${level}: "${name}" is listed twice in ${match[1]}`);
    seen.add(name);
  }
  declared.set(level, seen);
}
for (const [constant, level] of Object.entries(LEVELS)) {
  if (!declared.has(level))
    failures.push(`${constant} was not found in ${statesPath}`);
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
