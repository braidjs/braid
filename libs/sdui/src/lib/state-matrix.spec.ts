import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `tools/sdui/check-state-matrix.mjs` is the gate that keeps a state from being named without
 * being specified. Run here so the gate is part of `nx test sdui`, and so the gate itself is known
 * to fail when it should.
 */
const script = resolve(
  import.meta.dirname,
  '../../../../tools/sdui/check-state-matrix.mjs',
);
const statesSource = resolve(import.meta.dirname, 'states.ts');
const vectorsDir = resolve(import.meta.dirname, '../../conformance/states');
const check = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

describe('check-state-matrix', () => {
  it('passes for the states and vectors in this repository', () => {
    const result = check();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /state matrix: 75 states, \d+ vectors, every state specified/,
    );
  });

  it('fails, naming the state, when a state is added without a vector', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdui-states-'));
    const modified = join(dir, 'states.ts');
    writeFileSync(
      modified,
      readFileSync(statesSource, 'utf8').replace(
        "'loading-initial',",
        "'loading-initial', 'loading-forever',",
      ),
    );
    const result = check('--states', modified);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'screen: "loading-forever" has no conformance vector',
    );
    expect(result.stderr).toContain('1 problem\n');
  });

  it('fails when a vector names a state that does not exist, or a vector file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdui-vectors-'));
    for (const level of ['session', 'screen', 'node']) {
      writeFileSync(
        join(dir, `${level}.json`),
        readFileSync(join(vectorsDir, `${level}.json`), 'utf8').replaceAll(
          '"state": "ok"',
          '"state": "fine"',
        ),
      );
    }
    const result = check('--vectors', dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'is for "fine", which is not a session state',
    );
    expect(result.stderr).toContain('session: "ok" has no conformance vector');
    expect(result.stderr).toContain('action: no vector file');
  });

  it.each([
    ['double quotes', '"loading-forever"'],
    ['backticks', '`loading-forever`'],
  ])('catches a state added in %s', (_style, literal) => {
    const dir = mkdtempSync(join(tmpdir(), 'sdui-states-'));
    const modified = join(dir, 'states.ts');
    writeFileSync(
      modified,
      readFileSync(statesSource, 'utf8').replace(
        "'loading-initial',",
        `'loading-initial', ${literal},`,
      ),
    );
    const result = check('--states', modified);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'screen: "loading-forever" has no conformance vector',
    );
  });

  it('refuses a list it cannot read in full, such as one built with a spread', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdui-states-'));
    const modified = join(dir, 'states.ts');
    writeFileSync(
      modified,
      readFileSync(statesSource, 'utf8').replace(
        "'loading-initial',",
        "'loading-initial', ...MORE,",
      ),
    );
    const result = check('--states', modified);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'holds something other than string literals',
    );
  });

  it('stays linear on a file built to make a backtracking pattern crawl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdui-states-'));
    const hostile = join(dir, 'states.ts');
    writeFileSync(hostile, 'export const A_STATES = [\n'.repeat(40_000));
    const started = Date.now();
    const result = check('--states', hostile);
    expect(result.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('catches a state added to the type and left out of the list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdui-states-'));
    const modified = join(dir, 'states.ts');
    const source = readFileSync(statesSource, 'utf8');
    expect(source).toContain(
      'export type ActionState = (typeof ACTION_STATES)[number];',
    );
    writeFileSync(
      modified,
      source.replace(
        'export type ActionState = (typeof ACTION_STATES)[number];',
        "export type ActionState = (typeof ACTION_STATES)[number] | 'cancelled';",
      ),
    );
    const result = check('--states', modified);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'type ActionState is not exactly (typeof ACTION_STATES)[number]',
    );
  });
});
