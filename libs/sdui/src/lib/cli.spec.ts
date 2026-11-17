import { type CliIo, runSdui } from './cli.js';
import { catalog, manifest, readVector } from './fixtures.spec-util.js';

function run(argv: string[], files: Record<string, unknown> = {}) {
  const disk = new Map(
    Object.entries(files).map(([path, value]) => [
      path,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  );
  let out = '';
  let err = '';
  const io: CliIo = {
    readFile: (path) => {
      const content = disk.get(path);
      if (content === undefined) throw new Error('no such file');
      return content;
    },
    writeFile: (path, content) => void disk.set(path, content),
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
  };
  const code = runSdui(argv, io);
  return { code, out, err, disk };
}

const published = () => readVector('catalog.json');

describe('sdui catalog check', () => {
  const check = (next: unknown) =>
    run(
      [
        'catalog',
        'check',
        '--published',
        'published.json',
        '--next',
        'next.json',
      ],
      { 'published.json': published(), 'next.json': next },
    );

  it('exits 0 when a step is appended', () => {
    const next = published();
    const card = next.components['product-card'].contract;
    card.current = 4;
    card.steps.push({
      from: 3,
      to: 4,
      description: 'a rating',
      ops: [{ default: { path: 'rating', value: null } }],
    });
    const result = check(next);
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain('only adds');
  });

  it('exits 1 and names the step when a published step is edited', () => {
    const next = published();
    next.components['product-card'].contract.steps[1].ops[0].default.value =
      'Sale';
    const result = check(next);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'sdui.component.product-card step v2 → v3 ("an optional badge") was edited',
    );
  });

  it('exits 1 and names the steps when published steps are reordered', () => {
    const next = published();
    const steps = next.components['hero-banner'].contract.steps;
    next.components['hero-banner'].contract.steps = [
      { ...steps[1], from: 1, to: 2 },
      { ...steps[0], from: 2, to: 3 },
    ];
    const result = check(next);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'sdui.component.hero-banner step v1 → v2 ("the call to action becomes an object") was moved to v2 → v3',
    );
    expect(result.err).toContain(
      'sdui.component.hero-banner step v2 → v3 ("an optional countdown") was moved to v1 → v2',
    );
  });

  it('exits 2 for input it cannot read, without calling it a violation', () => {
    expect(
      run(
        [
          'catalog',
          'check',
          '--published',
          'missing.json',
          '--next',
          'next.json',
        ],
        { 'next.json': published() },
      ),
    ).toMatchObject({ code: 2 });
    expect(check('{ not json').code).toBe(2);
    expect(run(['catalog', 'check', '--next', 'next.json']).code).toBe(2);
  });
});

describe('sdui manifest', () => {
  const gen = (...extra: string[]) =>
    run(
      [
        'manifest',
        'gen',
        '--catalog',
        'catalog.json',
        '--app',
        'acme-shop',
        '--platform',
        'ios',
        '--app-version',
        '6.2.0',
        '--build',
        '6200118',
        '--assets',
        'jpeg,png,webp',
        '--out',
        'out/manifest.json',
        ...extra,
      ],
      {
        'catalog.json': published(),
      },
    );
  const fingerprintOf = (text: string): string =>
    /cm_[0-9a-f]{32}/.exec(text)?.[0] as string;

  it('writes the manifest and prints its fingerprint', () => {
    const result = gen();
    expect(result.code).toBe(0);
    const written = JSON.parse(result.disk.get('out/manifest.json') as string);
    expect(written.components).toEqual(manifest('current').components);
    expect(fingerprintOf(result.out)).toMatch(/^cm_/);
  });

  it("gives the same fingerprint whatever order the file's keys are in", () => {
    const result = gen();
    const written = JSON.parse(result.disk.get('out/manifest.json') as string);
    const reversed = Object.fromEntries(Object.entries(written).reverse());
    reversed['components'] = Object.fromEntries(
      Object.entries(written.components).reverse(),
    );
    const again = run(['manifest', 'fingerprint', '--in', 'm.json'], {
      'm.json': reversed,
    });
    expect(again.out.trim()).toBe(fingerprintOf(result.out));
  });

  it('gives a different fingerprint when a component version changes', () => {
    const pinned = gen('--pin', 'hero-banner=2', '--pin', 'video-tile=0');
    const written = JSON.parse(pinned.disk.get('out/manifest.json') as string);
    expect(written.components['hero-banner']).toBe(2);
    expect(written.components).not.toHaveProperty('video-tile');
    expect(fingerprintOf(pinned.out)).not.toBe(fingerprintOf(gen().out));
  });

  it('refuses a pin the catalog cannot back, and a malformed one', () => {
    expect(gen('--pin', 'hero-banner=9')).toMatchObject({ code: 2 });
    expect(gen('--pin', 'hero-banner')).toMatchObject({ code: 2 });
    expect(run(['manifest', 'gen', '--catalog', 'catalog.json']).err).toContain(
      'missing --app, --platform, --app-version, --out',
    );
  });
});

describe('sdui', () => {
  it('prints usage for --help and for nothing, and fails on an unknown command', () => {
    expect(run(['--help'])).toMatchObject({ code: 0 });
    expect(run([]).out).toContain('sdui catalog check');
    expect(run(['catalog', 'publish'])).toMatchObject({ code: 2 });
    expect(
      run(['catalog', 'id', '--in', 'c.json'], { 'c.json': catalog() }).out,
    ).toMatch(/^cat_[0-9a-f]{32}\n$/);
  });
});
