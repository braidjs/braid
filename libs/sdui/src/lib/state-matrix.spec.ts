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

  it('catches a state type widened through an alias', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdui-states-'));
    const modified = join(dir, 'states.ts');
    const source = readFileSync(statesSource, 'utf8');
    const exact = 'export type NodeState = (typeof NODE_STATES)[number];';
    expect(source).toContain(exact);
    writeFileSync(
      modified,
      source.replace(
        exact,
        "export type ListedNodeState = (typeof NODE_STATES)[number];\nexport type NodeState = ListedNodeState | 'pulsing';",
      ),
    );
    const result = check('--states', modified);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'type NodeState is not exactly (typeof NODE_STATES)[number]',
    );
  });

  it('catches a state type that has gone missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdui-states-'));
    const modified = join(dir, 'states.ts');
    writeFileSync(
      modified,
      readFileSync(statesSource, 'utf8').replace(
        'export type ScreenState =',
        'export type PageState =',
      ),
    );
    const result = check('--states', modified);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('type ScreenState is not declared');
  });

  const withStates = (edit: (source: string) => string) => {
    const dir = mkdtempSync(join(tmpdir(), 'sdui-states-'));
    const modified = join(dir, 'states.ts');
    const source = readFileSync(statesSource, 'utf8');
    const edited = edit(source);
    expect(edited).not.toBe(source);
    writeFileSync(modified, edited);
    return check('--states', modified);
  };

  it('refuses a list followed by a cast that widens it', () => {
    const result = withStates((source) =>
      source.replace(
        /(export const ACTION_STATES = \[[\s\S]*?\]) as const;/,
        "$1 as const as readonly (string | 'pulsing')[];",
      ),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'ACTION_STATES must end with "] as const;" and nothing else',
    );
  });

  it('is not satisfied by a declaration that only exists in a comment', () => {
    const exact = 'export type NodeState = (typeof NODE_STATES)[number];';
    const widened = withStates((source) =>
      source.replace(
        exact,
        `export type NodeState = (typeof NODE_STATES)[number] | 'pulsing';\n/*\n${exact}\n*/`,
      ),
    );
    expect(widened.status).toBe(1);
    expect(widened.stderr).toContain('type NodeState is not exactly');

    // A new state in the real list, with the old list kept in a comment after it.
    const old = /export const ACTION_STATES = \[[\s\S]*?\] as const;/.exec(
      readFileSync(statesSource, 'utf8'),
    )?.[0] as string;
    const shadowed = withStates((source) =>
      source.replace(
        old,
        `${old.replace("'idle',", "'idle', 'pulsing',")}\n/*\n${old}\n*/`,
      ),
    );
    expect(shadowed.status).toBe(1);
    expect(shadowed.stderr).toContain(
      'action: "pulsing" has no conformance vector',
    );
  });

  it('refuses a cast, which could make a state of something that is in no list', () => {
    const result = withStates((source) =>
      source.replace(
        /SEMANTIC_FAILURES\.find\(\(known\) => known === failure\) \?\?\s+'error-server'/,
        '(failure as unknown as ScreenState)',
      ),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a cast ("as ScreenState")');
    expect(result.stderr).toContain('a cast ("as unknown")');
  });

  it('refuses a resolver declared as returning more than its state type', () => {
    const inline = withStates((source) =>
      source.replace(
        /(export function resolveScreenState\(facts: ScreenFacts\): \{\s+state: ScreenState)/,
        "$1 | 'withdrawn'",
      ),
    );
    expect(inline.status).toBe(1);
    expect(inline.stderr).toContain(
      'resolveScreenState must be declared as returning exactly {state:ScreenState;source:UiSource;}',
    );
    for (const [name, facts, returns] of [
      ['resolveActionState', 'ActionFacts', 'ActionState'],
      ['resolveNodeStates', 'NodeFacts', 'NodeState[]'],
    ] as const) {
      const widened = withStates((source) =>
        source.replace(
          `export function ${name}(facts: ${facts}): ${returns} {`,
          `export function ${name}(facts: ${facts}): ${returns} | 'pulsing' {`,
        ),
      );
      expect(widened.status).toBe(1);
      expect(widened.stderr).toContain(
        `${name} must be declared as returning exactly ${returns}`,
      );
    }
  });

  it('is not misled by a comment opener inside a string', () => {
    const exact = 'export type ScreenState = (typeof SCREEN_STATES)[number];';
    const result = withStates((source) =>
      source.replace(
        exact,
        `const open = '/*';\n${exact.replace(';', " | 'withdrawn';")}\nconst close = '*/';`,
      ),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('type ScreenState is not exactly');
  });

  it('refuses a list declared twice', () => {
    const old = /export const ACTION_STATES = \[[\s\S]*?\] as const;/.exec(
      readFileSync(statesSource, 'utf8'),
    )?.[0] as string;
    const result = withStates((source) =>
      source.replace(old, `${old}\n${old}`),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ACTION_STATES is declared more than once');
  });
});
