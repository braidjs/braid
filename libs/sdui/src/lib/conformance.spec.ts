import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACTION_STATES,
  HANDSHAKE_STATUSES,
  NODE_STATES,
  SCREEN_STATES,
  SESSION_STATES,
  assignRollout,
  bucketOf,
  decidePointer,
  diffScreens,
  evaluateCondition,
  evaluateFlags,
  parseCatalog,
  parseClientManifest,
  parseScreen,
  projectScreen,
  resolveActionState,
  resolveHandshake,
  resolveNodeStates,
  resolveScreenState,
  resolveSessionState,
} from '../index.js';

/**
 * Runs every vector in `conformance/`. The vectors are the specification a client in any language
 * is written against; this is the reference implementation being held to them.
 */
const dir = resolve(import.meta.dirname, '../../conformance');
const read = (path: string): any =>
  JSON.parse(readFileSync(resolve(dir, path), 'utf8'));
const files = (folder: string): string[] =>
  readdirSync(resolve(dir, folder))
    .filter((name) => name.endsWith('.json'))
    .sort();

describe('conformance: projection', () => {
  for (const file of files('projection')) {
    const vector = read(`projection/${file}`);
    it(`${vector.name} — ${vector.description}`, () => {
      const result = projectScreen(
        parseScreen(read(vector.screen)),
        parseCatalog(read(vector.catalog)),
        parseClientManifest(read(vector.manifest)),
        vector.options,
      );
      expect(JSON.parse(JSON.stringify(result))).toEqual(vector.expect);
    });
  }
});

describe('conformance: states', () => {
  const levels = [
    ['session', SESSION_STATES, (given: any) => resolveSessionState(given)],
    ['screen', SCREEN_STATES, (given: any) => resolveScreenState(given)],
    ['node', NODE_STATES, (given: any) => resolveNodeStates(given)],
    ['action', ACTION_STATES, (given: any) => resolveActionState(given)],
  ] as const;

  for (const [level, states, resolver] of levels) {
    const { vectors } = read(`states/${level}.json`);

    it(`${level}: every state has a vector, and every vector names a state`, () => {
      const covered = new Set(vectors.map((vector: any) => vector.state));
      expect(states.filter((state) => !covered.has(state))).toEqual([]);
      expect(
        [...covered].filter(
          (state) => !(states as readonly string[]).includes(state as string),
        ),
      ).toEqual([]);
    });

    for (const vector of vectors) {
      it(`${level}: ${vector.state}${vector.description ? ` — ${vector.description}` : ''} ${JSON.stringify(vector.given)}`, () => {
        const resolved = resolver(vector.given);
        if (level === 'node') {
          expect(resolved).toEqual([vector.state, ...vector.also]);
        } else if (level === 'action') {
          expect(resolved).toBe(vector.state);
        } else {
          expect(resolved).toEqual({
            state: vector.state,
            source: vector.source,
          });
        }
      });
    }
  }
});

describe('conformance: handshake', () => {
  const { vectors } = read('handshake.json');

  it('has a vector for every status', () => {
    const covered = new Set(vectors.map((vector: any) => vector.expect.status));
    expect(HANDSHAKE_STATUSES.filter((status) => !covered.has(status))).toEqual(
      [],
    );
  });

  for (const vector of vectors) {
    it(vector.name, () => {
      const { knownManifests, ...policy } = vector.policy;
      expect(
        resolveHandshake(vector.request, {
          ...policy,
          knowsManifest: (fingerprint) => knownManifests.includes(fingerprint),
        }),
      ).toEqual(vector.expect);
    });
  }
});

describe('conformance: the sequence rule', () => {
  for (const vector of read('pointer.json').vectors) {
    it(vector.name, () => {
      expect(decidePointer(vector.known, vector.offered)).toEqual(
        vector.expect,
      );
    });
  }
});

describe('conformance: rollout and flags', () => {
  const rollout = read('rollout.json');

  it('buckets installs exactly as the definition says', () => {
    for (const vector of rollout.vectors)
      expect(bucketOf(vector.salt, vector.install)).toBe(vector.bucket);
  });

  it('assigns installs to a rollout arm', () => {
    for (const vector of rollout.assignments.vectors) {
      expect(assignRollout(rollout.assignments.plan, vector.install)).toEqual(
        vector.expect,
      );
      expect(
        assignRollout(
          { ...rollout.assignments.plan, halted: true },
          vector.install,
        ).release,
      ).toBe(rollout.assignments.halted.release);
    }
  });

  const flags = read('flags.json');
  for (const vector of flags.vectors) {
    it(`flags for ${vector.install} ${JSON.stringify(vector.context)}`, () => {
      expect(
        evaluateFlags(flags.definitions, vector.install, vector.context),
      ).toEqual(vector.expect);
    });
  }
});

describe('conformance: conditions', () => {
  for (const vector of read('conditions.json').vectors) {
    it(`${JSON.stringify(vector.condition)} with ${JSON.stringify(vector.context)} is ${vector.expect}`, () => {
      expect(evaluateCondition(vector.condition, vector.context)).toBe(
        vector.expect,
      );
    });
  }
});

describe('conformance: diff', () => {
  for (const file of files('diff')) {
    const vector = read(`diff/${file}`);
    it(`${vector.name} — ${vector.description}`, () => {
      const { beforeId, afterId, ...result } = diffScreens(
        parseScreen(vector.before),
        parseScreen(vector.after),
        parseCatalog(read(vector.catalog)),
      );
      expect(result).toEqual(vector.expect);
      expect(beforeId === afterId).toBe(vector.expect.unchanged);
    });
  }
});
