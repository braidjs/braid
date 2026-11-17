import type { SkewContractDocument } from '@braidlabs/contract';
import {
  type ClientManifest,
  type Screen,
  type SduiCatalog,
  SCREEN_LIMITS,
  applyVisibility,
  assignRollout,
  checkCatalog,
  diffScreens,
  evaluateFlags,
  migrate,
  parseCatalog,
  parseClientManifest,
  parseCondition,
  parseFlagDefinitions,
  parseReleasePointer,
  parseRolloutPlan,
  parseScreen,
  projectScreen,
  screenId,
  validateScreen,
} from '../index.js';
import { runSdui } from './cli.js';
import { catalog, manifest, readVector, screen } from './fixtures.spec-util.js';

/**
 * One test (or more) per finding of the code review and the security audit of this package. Each
 * fails without its fix.
 */

const doc = (
  type: string,
  current: number,
  steps: SkewContractDocument['steps'],
): SkewContractDocument => ({
  skewContract: '1',
  name: `sdui.component.${type}`,
  current,
  steps,
});
const device = (components: Record<string, number>): ClientManifest => ({
  sduiManifest: '1',
  protocol: [1, 1],
  app: 'a',
  platform: 'ios',
  version: '1.0',
  components,
});
const reportOf = (result: ReturnType<typeof projectScreen>, id: string) =>
  result.report.filter((entry) => entry.nodeId === id);

describe('a required node blocks the screen wherever it sits', () => {
  const legal = {
    id: 'legal',
    type: 'text',
    v: 2,
    required: true,
    props: { content: '18+ only' },
  };
  const base = catalog();
  const withPanel = parseCatalog({
    ...base,
    components: {
      ...base.components,
      panel: {
        contract: doc('panel', 2, [
          { from: 1, to: 2, description: 'a footer slot', ops: [] },
        ]),
        slots: { body: {}, footer: { since: 2 } },
      },
    },
  });
  const under = (panel: object): Screen => ({
    id: 's',
    slug: 's',
    root: {
      id: 'root',
      type: 'stack',
      v: 1,
      slots: { children: [panel as never] },
    },
  });
  const has = (version?: number): ClientManifest => ({
    ...manifest('current'),
    components: {
      ...manifest('current').components,
      ...(version ? { panel: version } : {}),
    },
  });

  it('under a slot the app version does not have', () => {
    const result = projectScreen(
      under({ id: 'panel', type: 'panel', v: 2, slots: { footer: [legal] } }),
      withPanel,
      has(1),
    );
    expect(result).toMatchObject({
      outcome: 'blocked',
      root: null,
      blockedBy: ['legal'],
    });
    expect(reportOf(result, 'legal')).toMatchObject([
      { outcome: 'omitted', blocking: true },
    ]);
    expect(reportOf(result, 'legal')[0]?.reason).toContain('"footer" slot');
  });

  it('under a parent that is omitted', () => {
    const result = projectScreen(
      under({
        id: 'panel',
        type: 'panel',
        v: 2,
        slots: {
          body: [
            { id: 'deep', type: 'stack', v: 1, slots: { children: [legal] } },
          ],
        },
      }),
      withPanel,
      has(),
    );
    expect(result).toMatchObject({ outcome: 'blocked', blockedBy: ['legal'] });
  });

  it('under a parent that is replaced by its authored fallback', () => {
    const replaced = {
      id: 'panel',
      type: 'panel',
      v: 2,
      slots: { body: [legal] },
      fallback: { id: 'fb', type: 'text', v: 2, props: { content: 'A panel' } },
    };
    const result = projectScreen(under(replaced), withPanel, has());
    expect(result).toMatchObject({ outcome: 'blocked', blockedBy: ['legal'] });
    expect(reportOf(result, 'panel')).toMatchObject([
      { outcome: 'fallback-authored' },
    ]);
  });

  it('under a parent that is replaced by its catalog fallback, and for a fail-screen component', () => {
    const failing = parseCatalog({
      ...withPanel,
      components: {
        ...withPanel.components,
        panel: { ...withPanel.components['panel'], fallback: 'placeholder' },
        'video-tile': {
          ...withPanel.components['video-tile'],
          fallback: 'fail-screen',
        },
      },
    });
    const video = {
      id: 'video',
      type: 'video-tile',
      v: 1,
      props: { title: 't', src: 's' },
    };
    const result = projectScreen(
      under({ id: 'panel', type: 'panel', v: 2, slots: { body: [video] } }),
      failing,
      has(),
    );
    expect(result).toMatchObject({ outcome: 'blocked', blockedBy: ['video'] });
  });

  it('but not when the required node is where it can be rendered', () => {
    const result = projectScreen(
      under({ id: 'panel', type: 'panel', v: 2, slots: { body: [legal] } }),
      withPanel,
      has(2),
    );
    expect(result.outcome).toBe('exact');
  });

  it('never marks a node inside an authored state as blocking, and drops a state that lost something required', () => {
    const authored: Screen = {
      ...screen('home'),
      states: {
        empty: { id: 'e', type: 'panel', v: 2, slots: { body: [legal] } },
      },
    };
    const result = projectScreen(authored, withPanel, has());
    expect(result.outcome).not.toBe('blocked');
    expect(result.states).toBeUndefined();
    expect(result.report.some((entry) => entry.blocking)).toBe(false);
  });
});

describe('what a downgrade loses is measured, in the newest shape', () => {
  const only = (
    contract: SkewContractDocument,
    extra: object = {},
  ): SduiCatalog =>
    parseCatalog({
      sduiCatalog: '1',
      components: {
        note: {
          contract: { ...contract, name: 'sdui.component.note' },
          ...extra,
        },
      },
    });
  const authored = (v: number, props: object): Screen => ({
    id: 's',
    slug: 's',
    root: { id: 'n', type: 'note', v, props },
  });

  it('catches a critical field renamed later in the same step', () => {
    const renamed = doc('note', 2, [
      {
        from: 1,
        to: 2,
        description: 'badge, then label',
        ops: [
          { default: { path: 'badge', value: null } },
          { rename: { from: 'badge', to: 'label' } },
        ],
      },
    ]);
    const props = { title: 'x', label: 'SALE' };
    expect(migrate(renamed, props, 2, 1)).toMatchObject({
      ok: true,
      lossyPaths: ['label'],
    });
    const result = projectScreen(
      authored(2, props),
      only(renamed, { criticalPaths: ['label'] }),
      device({ note: 1 }),
    );
    expect(result.root).toBeNull();
    expect(result.report[0]?.reason).toContain('cannot carry "label"');
  });

  it('catches a critical field renamed by a later step, under the name it has now', () => {
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'legal note',
        ops: [{ default: { path: 'legalNote', value: null } }],
      },
      {
        from: 2,
        to: 3,
        description: 'rename',
        ops: [{ rename: { from: 'legalNote', to: 'disclaimer' } }],
      },
    ];
    const props = { title: 'x', disclaimer: 'Terms apply' };
    const result = projectScreen(
      authored(3, props),
      only(doc('note', 3, steps), { criticalPaths: ['disclaimer'] }),
      device({ note: 1 }),
    );
    expect(result.root).toBeNull();
    // Without a critical path it renders, and the loss is named as the author knows it.
    expect(
      projectScreen(
        authored(3, props),
        only(doc('note', 3, steps)),
        device({ note: 1 }),
      ).report[0],
    ).toMatchObject({ outcome: 'downgraded', lossyPaths: ['disclaimer'] });
  });

  it('names the loss in the newest shape even for a node authored before the rename', () => {
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'legal note',
        ops: [{ default: { path: 'legalNote', value: null } }],
      },
      {
        from: 2,
        to: 3,
        description: 'rename',
        ops: [{ rename: { from: 'legalNote', to: 'disclaimer' } }],
      },
    ];
    const result = projectScreen(
      authored(2, { title: 'x', legalNote: 'Terms apply' }),
      only(doc('note', 3, steps), { criticalPaths: ['disclaimer'] }),
      device({ note: 1 }),
    );
    expect(result.root).toBeNull();
    expect(result.report[0]?.reason).toContain('"disclaimer"');
  });

  it('catches a wrapped field moved by a later step', () => {
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'wrap',
        ops: [{ wrap: { path: 'price', key: 'amount', also: { sale: null } } }],
      },
      {
        from: 2,
        to: 3,
        description: 'move',
        ops: [{ move: { from: 'price', to: 'pricing.list' } }],
      },
    ];
    const result = projectScreen(
      authored(3, { pricing: { list: { amount: 10, sale: 8 } } }),
      only(doc('note', 3, steps), { criticalPaths: ['pricing'] }),
      device({ note: 1 }),
    );
    expect(result.root).toBeNull();
  });

  it('does not report a default-valued element of a list as lost, and does report an authored one', () => {
    const mapped = doc('note', 2, [
      {
        from: 1,
        to: 2,
        description: 'badges',
        ops: [
          {
            map: {
              path: 'items',
              ops: [{ default: { path: 'badge', value: 'new' } }],
            },
          },
        ],
      },
    ]);
    expect(
      migrate(mapped, { items: [{ badge: 'new' }, { badge: 'new' }] }, 2, 1),
    ).toMatchObject({ ok: true, lossyPaths: [] });
    expect(
      migrate(mapped, { items: [{ badge: 'new' }, { badge: 'SALE' }] }, 2, 1),
    ).toMatchObject({ ok: true, lossyPaths: ['items[1].badge'] });
    const critical = only(mapped, { criticalPaths: ['items'] });
    expect(
      projectScreen(
        authored(2, { items: [{ badge: 'new' }] }),
        critical,
        device({ note: 1 }),
      ).root,
    ).not.toBeNull();
    expect(
      projectScreen(
        authored(2, { items: [{ badge: 'SALE' }] }),
        critical,
        device({ note: 1 }),
      ).root,
    ).toBeNull();
  });

  it.each([
    [
      'hoist',
      [{ hoist: { path: 'image', key: 'url' } }],
      { image: 'a.png' },
      [],
    ],
    [
      'convert',
      [{ convert: { path: 'count', to: 'string' } }],
      { count: '3' },
      [],
    ],
    [
      'const',
      [{ const: { path: 'kind', value: 'note' } }],
      { kind: 'note' },
      [],
    ],
    [
      'const, overwritten by the author',
      [{ const: { path: 'kind', value: 'note' } }],
      { kind: 'memo' },
      ['kind'],
    ],
    [
      'drop with restore',
      [{ drop: { path: 'legacy', restore: false } }],
      { text: 'x' },
      [],
    ],
  ] as const)('round-trips %s', (_name, ops, props, lossy) => {
    const contract = doc('note', 2, [
      { from: 1, to: 2, description: 'step', ops: ops as never },
    ]);
    expect(migrate(contract, props, 2, 1)).toMatchObject({
      ok: true,
      lossyPaths: lossy,
    });
  });

  it('reads the clock once, so a $now field cannot make a migration or a projection disagree with itself', () => {
    const stamped = doc('note', 2, [
      {
        from: 1,
        to: 2,
        description: 'stamp',
        ops: [
          {
            wrap: {
              path: 'nav',
              key: 'amount',
              also: { asOf: { $now: true } },
            },
          },
        ],
      },
    ]);
    let tick = 0;
    const context = { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) };
    const authoredAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
    // The authored timestamp equals the one instant taken from the clock: nothing is lost.
    expect(
      migrate(stamped, { nav: { amount: 5, asOf: authoredAt } }, 2, 1, {
        context: { now: () => new Date(authoredAt) },
      }),
    ).toMatchObject({ ok: true, lossyPaths: [] });
    // A different authored timestamp is lost on the way down, and is reported.
    expect(
      migrate(
        stamped,
        { nav: { amount: 5, asOf: '2020-01-01T00:00:00.000Z' } },
        2,
        1,
        { context },
      ),
    ).toMatchObject({ ok: true, lossyPaths: ['nav.asOf'] });
    const twice: Screen = {
      id: 's',
      slug: 's',
      root: { id: 'r', type: 'note', v: 1, props: { nav: 1 } },
    };
    const result = projectScreen(twice, only(stamped), device({ note: 2 }), {
      context,
    });
    expect(result.root?.props).toEqual({
      nav: { amount: 1, asOf: expect.any(String) },
    });
    expect(
      projectScreen(twice, only(stamped), device({ note: 2 }), {
        context: { now: () => new Date(authoredAt) },
      }),
    ).toEqual(
      projectScreen(twice, only(stamped), device({ note: 2 }), {
        context: { now: () => new Date(authoredAt) },
      }),
    );
  });

  it('costs one node, not the screen, when a catalog that skipped the parser has an op that will not compile', () => {
    const bad = {
      sduiCatalog: '1',
      components: {
        note: {
          contract: doc('note', 2, [
            {
              from: 1,
              to: 2,
              description: 'nope',
              ops: [{ nope: { path: 'x' } } as never],
            },
          ]),
        },
      },
    } as SduiCatalog;
    const result = projectScreen(
      authored(1, { x: 1 }),
      bad,
      device({ note: 2 }),
    );
    expect(result.root).toBeNull();
    expect(result.report[0]?.reason).toContain('unknown op "nope"');
    expect(() =>
      diffScreens(authored(1, { x: 1 }), authored(1, { x: 2 }), bad),
    ).not.toThrow();
  });
});

describe('the fallback ladder, pinned', () => {
  it("prefers a node's authored fallback to its catalog fallback when a step cannot be inverted", () => {
    const result = projectScreen(screen('home'), catalog(), manifest('legacy'));
    // legal-note has a catalog fallback; n_returns also has its own, and its own wins.
    expect(reportOf(result, 'n_returns')).toMatchObject([
      {
        outcome: 'fallback-authored',
        rung: 3,
        replacedBy: { id: 'n_returns_fallback' },
      },
    ]);
    expect(reportOf(result, 'n_returns')[0]?.reason).toContain(
      'cannot be inverted',
    );
    // n_legal has only the catalog's, and reports the stand-in's own losses too.
    expect(reportOf(result, 'n_legal')).toMatchObject([
      { outcome: 'fallback-catalog', rung: 4 },
      {
        type: 'text',
        outcome: 'downgraded',
        lossyPaths: ['style'],
        fallbackFor: 'n_legal',
      },
    ]);
  });

  const share = (extra: object): Screen => ({
    id: 's',
    slug: 's',
    root: {
      id: 'n',
      type: 'legal-note',
      v: 2,
      props: { text: 'Share' },
      actions: {
        press: {
          type: 'share',
          v: 1,
          props: { text: 'hi' },
          unsupported: 'hide',
        },
      },
      ...extra,
    },
  });

  it('hide removes the node instead of swapping in the catalog fallback', () => {
    // legal-note's catalog fallback is a text; `hide` must not produce it.
    const result = projectScreen(share({}), catalog(), manifest('one-behind'));
    expect(result.root).toBeNull();
    expect(result.report).toMatchObject([
      { nodeId: 'n', outcome: 'omitted', rung: 5 },
    ]);
  });

  it('hide still uses a fallback the author wrote for the node', () => {
    const result = projectScreen(
      share({
        fallback: {
          id: 'fb',
          type: 'text',
          v: 2,
          props: { content: 'Share on the web' },
        },
      }),
      catalog(),
      manifest('one-behind'),
    );
    expect(result.root).toMatchObject({ id: 'fb', type: 'text' });
  });

  it('sends a placeholder that says nothing about the component it replaces', () => {
    const base = readVector('catalog.json');
    base.components['video-tile'].fallback = 'placeholder';
    const secret: Screen = {
      id: 's',
      slug: 's',
      root: {
        id: 'n',
        type: 'video-tile',
        v: 1,
        props: { title: 't', src: 's' },
      },
    };
    expect(
      JSON.stringify(
        projectScreen(secret, parseCatalog(base), manifest('one-behind')).root,
      ),
    ).not.toContain('video-tile');
  });
});

describe('applyVisibility covers authored states', () => {
  const gated: Screen = {
    ...screen('home'),
    states: {
      empty: {
        id: 'e',
        type: 'stack',
        v: 1,
        slots: {
          children: [
            {
              id: 'e1',
              type: 'text',
              v: 2,
              props: { content: 'staff-only copy' },
              visibility: {
                all: [{ audience: 'internal-beta' }, { flag: 'secret-launch' }],
              },
            },
          ],
        },
      },
      error: 'system',
    },
  };

  it('prunes and strips inside states, so no rule, flag or audience name reaches a device', () => {
    const visible = applyVisibility(
      projectScreen(gated, catalog(), manifest('current')),
      { audiences: [], flags: {} },
    );
    const wire = JSON.stringify({ root: visible.root, states: visible.states });
    for (const leak of [
      'visibility',
      'internal-beta',
      'secret-launch',
      'staff-only copy',
      'member-promo',
    ])
      expect(wire).not.toContain(leak);
    expect(visible.states).toEqual({
      empty: { id: 'e', type: 'stack', v: 1, slots: { children: [] } },
      error: 'system',
    });
    expect(visible.hidden.map((entry) => entry.nodeId).sort()).toEqual([
      'e1',
      'n_promo',
    ]);
  });

  it('keeps a gated state node for someone it is for', () => {
    const visible = applyVisibility(
      projectScreen(gated, catalog(), manifest('current')),
      { audiences: ['internal-beta'], flags: { 'secret-launch': true } },
    );
    expect(JSON.stringify(visible.states)).toContain('staff-only copy');
    expect(JSON.stringify(visible.states)).not.toContain('visibility');
  });
});

describe('parseScreen refuses what would hurt later', () => {
  const broken = (mutate: (draft: any) => void): (() => unknown) => {
    const draft = structuredClone(screen('home')) as any;
    mutate(draft);
    return () => parseScreen(draft);
  };
  const child = (index: number) => ['root', 'slots', 'children', index];
  const at = (draft: any, path: (string | number)[]): any =>
    path.reduce((scope, key) => scope[key], draft);

  it('malformed condition bodies, which used to throw on every request', () => {
    expect(
      broken((d) => (at(d, child(5)).visibility = { appVersion: { min: 6 } })),
    ).toThrow('appVersion.min must be a version');
    expect(
      broken(
        (d) => (at(d, child(5)).visibility = { appVersion: { min: 'v6.0.0' } }),
      ),
    ).toThrow('appVersion.min must be a version');
    expect(
      broken(
        (d) =>
          (at(d, child(5)).visibility = { appVersion: { minimum: '6.0' } }),
      ),
    ).toThrow('unknown key "minimum"');
    expect(
      broken((d) => (at(d, child(5)).visibility = { appVersion: {} })),
    ).toThrow('needs min or max');
    expect(
      broken(
        (d) =>
          (at(d, child(5)).visibility = { schedule: { start: '2099-01-01' } }),
      ),
    ).toThrow('unknown key "start"');
    expect(
      broken(
        (d) => (at(d, child(5)).visibility = { schedule: { from: 'soon' } }),
      ),
    ).toThrow('must be a date and time');
    expect(
      broken(
        (d) => (at(d, child(5)).visibility = { schedule: { from: null } }),
      ),
    ).toThrow('must be a date and time');
    expect(
      broken(
        (d) => (at(d, child(5)).visibility = { flag: 'a', platform: ['ios'] }),
      ),
    ).toThrow('exactly one of');
    expect(
      broken((d) => (at(d, child(5)).visibility = { flag: 'a', when: 1 })),
    ).toThrow('unknown key "when"');
    expect(
      broken((d) => (at(d, child(5)).visibility = { flag: '__proto__' })),
    ).toThrow('must be a flag name');
  });

  it('reserved keys anywhere, so two different screens cannot share an id or lose a slot', () => {
    expect(
      broken(
        (d) =>
          (at(d, child(0)).props = JSON.parse(
            '{"title":"x","__proto__":{"evil":1}}',
          )),
      ),
    ).toThrow('reserved key "__proto__"');
    expect(
      broken((d) => (at(d, child(0)).props = { a: { constructor: 1 } })),
    ).toThrow('reserved key "constructor"');
    expect(
      broken((d) => (at(d, child(0)).slots = JSON.parse('{"__proto__":[]}'))),
    ).toThrow('slot named "__proto__"');
    expect(
      broken(
        (d) =>
          (at(d, child(0)).actions = JSON.parse(
            '{"__proto__":{"type":"navigate","v":1}}',
          )),
      ),
    ).toThrow('action named "__proto__"');
    expect(
      broken(
        (d) =>
          (at(d, child(5)).visibility = {
            flag: 'f',
            is: JSON.parse('{"__proto__":1}'),
          }),
      ),
    ).toThrow('reserved key');
  });

  it('gives screens that differ only under a hostile key different ids when they skip the parser', () => {
    const make = (extra: string): Screen =>
      JSON.parse(
        `{"id":"s","slug":"s","root":{"id":"n","type":"text","v":2,"props":{"content":"hi"${extra}}}}`,
      );
    const ids = [
      make(''),
      make(',"__proto__":{"evil":1}'),
      make(',"__proto__":{"other":[1,2,3]}'),
    ].map(screenId);
    expect(new Set(ids).size).toBe(3);
    expect(
      diffScreens(make(''), make(',"__proto__":{"evil":1}'), catalog())
        .unchanged,
    ).toBe(false);
  });

  it('documents past the size limits, before anything recursive sees them', () => {
    const wide = {
      id: 's',
      slug: 's',
      root: {
        id: 'r',
        type: 'stack',
        v: 1,
        slots: {
          children: Array.from(
            { length: SCREEN_LIMITS.nodes + 1 },
            (_, index) => ({ id: `n${index}`, type: 'text', v: 2 }),
          ),
        },
      },
    };
    expect(() => parseScreen(wide)).toThrow(
      `more than ${SCREEN_LIMITS.nodes} nodes`,
    );

    let deep: unknown = 'x';
    for (let depth = 0; depth < 5000; depth++) deep = { a: deep };
    expect(broken((d) => (at(d, child(0)).props = { deep }))).toThrow(
      `nested more than ${SCREEN_LIMITS.valueDepth} levels deep`,
    );
    let is: unknown = 1;
    for (let depth = 0; depth < 20_000; depth++) is = [is];
    expect(
      broken((d) => (at(d, child(5)).visibility = { flag: 'f', is })),
    ).toThrow('levels deep');
    expect(
      broken(
        (d) =>
          (at(d, child(0)).props = {
            text: 'x'.repeat(SCREEN_LIMITS.string + 1),
          }),
      ),
    ).toThrow('string of more than');
    expect(
      broken((d) => (at(d, child(0)).props = { n: Number.POSITIVE_INFINITY })),
    ).toThrow('not a finite number');
  });

  it('unknown keys and unvalidated analytics, which would otherwise be forwarded to devices', () => {
    expect(
      broken(
        (d) =>
          (at(d, child(0)).analytics = {
            name: 'hero',
            email: 'someone@example.com',
          }),
      ),
    ).toThrow('analytics has an unknown key "email"');
    expect(broken((d) => (at(d, child(0)).onPress = 'alert(1)'))).toThrow(
      'unknown key "onPress"',
    );
    expect(broken((d) => (d.script = 'x'))).toThrow('unknown key "script"');
  });

  it('accepts a screen at exactly the limits and projects it without overflowing', () => {
    const children = Array.from(
      { length: SCREEN_LIMITS.nodes - 1 },
      (_, index) => ({
        id: `n${index}`,
        type: 'text',
        v: 2,
        props: { content: String(index) },
      }),
    );
    const big = parseScreen({
      id: 's',
      slug: 's',
      root: { id: 'r', type: 'stack', v: 1, slots: { children } },
    });
    const result = projectScreen(big, catalog(), manifest('legacy'));
    expect(result.report).toHaveLength(SCREEN_LIMITS.nodes);
    expect(result.root?.slots?.['children']).toHaveLength(
      SCREEN_LIMITS.nodes - 1,
    );
  });
});

describe('conditions outside screens are parsed too', () => {
  it('parseCondition refuses an unknown kind, which under not used to be true', () => {
    expect(() => parseCondition({ not: { region: ['eu'] } })).toThrow(
      'exactly one of',
    );
    expect(parseCondition({ not: { platform: ['ios'] } })).toEqual({
      not: { platform: ['ios'] },
    });
  });

  it('an unparsed audience with an unknown kind keeps everyone on stable', () => {
    const plan = {
      stable: 'a',
      candidate: 'b',
      stages: [100],
      stage: 0,
      salt: 's',
      audience: { not: { region: ['eu'] } } as never,
    };
    expect(assignRollout(plan, 'ins_1').arm).toBe('stable');
  });

  it('parseRolloutPlan and parseFlagDefinitions refuse what would fail open', () => {
    const plan = {
      stable: 'a',
      candidate: 'b',
      stages: [1, 100],
      stage: 0,
      salt: 's',
    };
    expect(parseRolloutPlan(structuredClone(plan))).toEqual(plan);
    expect(() => parseRolloutPlan({ ...plan, stage: 7 })).toThrow(
      'stage must be an index',
    );
    expect(() => parseRolloutPlan({ ...plan, stages: [5, 1] })).toThrow(
      'must ascend',
    );
    expect(() =>
      parseRolloutPlan({ ...plan, audience: { not: { region: ['eu'] } } }),
    ).toThrow('exactly one of');
    expect(() =>
      parseFlagDefinitions([{ key: '__proto__', default: { admin: true } }]),
    ).toThrow('short plain word');
    expect(() => parseFlagDefinitions([{ key: 'a' }])).toThrow(
      'needs a default',
    );
    expect(() =>
      parseFlagDefinitions([
        { key: 'a', default: 1, rules: [{ value: 2, percent: 150 }] },
      ]),
    ).toThrow('percent must be between 0 and 100');
    expect(() =>
      parseFlagDefinitions([
        { key: 'a', default: 1, rules: [{ value: 2, when: { flag: 'b' } }] },
      ]),
    ).toThrow('cannot read another flag');
    expect(() =>
      parseFlagDefinitions([
        {
          key: 'a',
          default: 1,
          rules: [{ value: 2, when: { audience: 'flag' } }],
        },
      ]),
    ).not.toThrow();
  });
});

describe('rollouts and flags fail closed', () => {
  it('keeps a flag keyed __proto__ as an own key instead of making it the prototype', () => {
    const proto = JSON.parse('[{"key":"__proto__","default":{"admin":true}}]');
    const { values } = evaluateFlags(proto, 'ins_1');
    expect((values as Record<string, unknown>)['admin']).toBeUndefined();
    expect(Object.keys(values)).toEqual(['__proto__']);
  });

  it('puts an install with no id inside nothing short of 100%', () => {
    const plan = (percent: number) => ({
      stable: 'a',
      candidate: 'b',
      stages: [percent],
      stage: 0,
      salt: 's',
    });
    expect(assignRollout(plan(99.99), undefined)).toEqual({
      release: 'a',
      arm: 'stable',
      bucket: null,
    });
    expect(assignRollout(plan(100), undefined).arm).toBe('candidate');
    expect(assignRollout(plan(99.99), '').arm).toBe('stable');
    const flags = [
      { key: 'f', default: false, rules: [{ percent: 99, value: true }] },
    ];
    expect(evaluateFlags(flags, null).values).toEqual({ f: false });
  });

  it('keeps an install inside a flag percentage as it widens', () => {
    const at = (percent: number) => [
      { key: 'new-search', default: false, rules: [{ percent, value: true }] },
    ];
    const installs = Array.from(
      { length: 20_000 },
      (_, index) => `ins_${index}`,
    );
    const on5 = installs.filter(
      (install) => evaluateFlags(at(5), install).values['new-search'],
    );
    expect(on5.length).toBeGreaterThan(800);
    expect(
      on5.every(
        (install) => evaluateFlags(at(25), install).values['new-search'],
      ),
    ).toBe(true);
  });
});

describe('checkCatalog compares exactly, and beyond the contract', () => {
  const clone = (): any => structuredClone(readVector('catalog.json'));
  const check = (mutate: (draft: any) => void) => {
    const next = clone();
    mutate(next);
    return checkCatalog(catalog(), next);
  };

  it('catches any difference in a published step, including a key the lens ignores', () => {
    const violations = check(
      (d) =>
        (d.components['product-card'].contract.steps[1].ops[0].default.zz =
          'nonce'),
    );
    expect(violations).toMatchObject([
      { kind: 'step-edited', step: { from: 2, to: 3 } },
    ]);
  });

  it('does not call an edit a move when another step looks like the published one', () => {
    const repeated = (last: string): SduiCatalog =>
      ({
        sduiCatalog: '1',
        components: {
          note: {
            contract: doc('note', 4, [
              {
                from: 1,
                to: 2,
                description: 'A',
                ops: [{ default: { path: 'a', value: 1 } }],
              },
              {
                from: 2,
                to: 3,
                description: 'B',
                ops: [{ default: { path: 'b', value: 1 } }],
              },
              {
                from: 3,
                to: 4,
                description: last,
                ops: [
                  { default: { path: last === 'A' ? 'a' : 'x', value: 1 } },
                ],
              },
            ]),
          },
        },
      }) as SduiCatalog;
    expect(checkCatalog(repeated('A'), repeated('X'))).toMatchObject([
      { kind: 'step-edited', step: { from: 3, to: 4 } },
    ]);
  });

  it('reports a removed slot, a changed since, and a removed critical path; allows policy to change', () => {
    expect(
      check((d) => delete d.components['stack'].slots.children),
    ).toMatchObject([{ kind: 'slot-changed' }]);
    const sinceBase = clone();
    sinceBase.components['hero-banner'].slots = { extras: { since: 1 } };
    const sinceNext = structuredClone(sinceBase);
    sinceNext.components['hero-banner'].slots.extras.since = 2;
    expect(checkCatalog(sinceBase, sinceNext)).toMatchObject([
      { kind: 'slot-changed', contract: 'sdui.component.hero-banner' },
    ]);
    expect(
      check((d) => delete d.components['product-card'].criticalPaths),
    ).toMatchObject([
      {
        kind: 'critical-path-removed',
        contract: 'sdui.component.product-card',
      },
    ]);
    expect(
      check((d) => (d.components['legal-note'].fallback = 'omit')),
    ).toEqual([]);
    expect(
      check(
        (d) =>
          (d.components['product-card'].criticalPaths = ['price', 'title']),
      ),
    ).toEqual([]);
  });

  it('parseCatalog refuses ops the lens compiler refuses, naming the step', () => {
    for (const ops of [
      [{ nope: {} }],
      [{ rename: { from: 1, to: 'x' } }],
      [null],
      [{ convert: { path: 'p', to: 'date' } }],
      [{ rename: { from: 'title', to: '__proto__.polluted' } }],
    ]) {
      const draft = clone();
      draft.components['text'].contract.steps[0].ops = ops;
      expect(() => parseCatalog(draft)).toThrow(
        /component "text": step v1 → v2 cannot be compiled/,
      );
    }
  });

  it('sdui catalog check exits 2 for such a catalog instead of calling it an addition', () => {
    const draft = clone();
    draft.components['text'].contract.current = 3;
    draft.components['text'].contract.steps.push({
      from: 2,
      to: 3,
      description: 'bogus',
      ops: [{ bogus: { path: 'x' } }],
    });
    let err = '';
    const code = runSdui(
      ['catalog', 'check', '--published', 'a', '--next', 'b'],
      {
        readFile: (path) => JSON.stringify(path === 'a' ? clone() : draft),
        writeFile: () => undefined,
        stdout: () => undefined,
        stderr: (text) => void (err += text),
      },
    );
    expect(code).toBe(2);
    expect(err).toContain('cannot be compiled');
  });
});

describe('validateScreen', () => {
  it('finds nothing wrong with the conformance screens', () => {
    expect(validateScreen(screen('home'), catalog())).toEqual([]);
    expect(validateScreen(screen('watch'), catalog())).toEqual([]);
  });

  it('names an unknown component, a version from the future, an unknown slot and action, and slot rules', () => {
    const base = readVector('catalog.json');
    base.components['stack'].slots.children = { accepts: ['text'], max: 1 };
    const odd: Screen = {
      id: 's',
      slug: 's',
      root: {
        id: 'r',
        type: 'stack',
        v: 1,
        slots: {
          children: [
            {
              id: 'a',
              type: 'video-tile',
              v: 1,
              props: {},
              actions: { press: { type: 'teleport', v: 1 } },
            },
            { id: 'b', type: 'text', v: 9, props: {} },
            { id: 'c', type: 'carousel', v: 1 },
          ],
          sidebar: [],
        },
      },
    };
    expect(
      validateScreen(odd, parseCatalog(base)).map(
        (problem) => `${problem.nodeId}: ${problem.message}`,
      ),
    ).toEqual([
      'r: slot "children" takes at most 1, and has 3',
      'a: a "video-tile" cannot go in the "children" slot of "stack", which takes text',
      'c: a "carousel" cannot go in the "children" slot of "stack", which takes text',
      'r: "stack" has no slot named "sidebar"',
      'a: action "press" is a "teleport", which is not an action in the catalog',
      'b: authored at "text" v9, but the catalog only goes to v2',
      'c: "carousel" is not a component in the catalog',
    ]);
  });
});

describe('manifests and pointers from devices', () => {
  it('refuses a manifest with unknown keys, so it cannot be given unlimited fingerprints', () => {
    expect(() =>
      parseClientManifest({ ...manifest('current'), junk: 1 }),
    ).toThrow('unknown key "junk"');
    expect(() => parseClientManifest({})).toThrow(
      'unsupported manifest format',
    );
    expect(() =>
      parseClientManifest({ ...manifest('current'), limits: { depth: -1 } }),
    ).toThrow('limits.depth must be a positive integer');
    expect(() =>
      parseClientManifest({ ...manifest('current'), limits: { width: 1 } }),
    ).toThrow('limits has an unknown key');
    expect(() =>
      parseClientManifest({
        ...manifest('current'),
        components: JSON.parse('{"__proto__":1}'),
      }),
    ).toThrow('not a type name');
    const many = Object.fromEntries(
      Array.from({ length: 2001 }, (_, index) => [`c${index}`, 1]),
    );
    expect(() =>
      parseClientManifest({ ...manifest('current'), components: many }),
    ).toThrow('more than 2000 entries');
  });

  it('parseReleasePointer refuses a seq that is not a whole number', () => {
    expect(
      parseReleasePointer({ release: 'rel_a', seq: 3, kind: 'rollback' }),
    ).toEqual({ release: 'rel_a', seq: 3, kind: 'rollback' });
    for (const seq of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '11',
      {},
      -1,
      1.5,
    ]) {
      expect(() => parseReleasePointer({ release: 'rel_a', seq })).toThrow(
        'seq must be a non-negative integer',
      );
    }
  });
});

describe('the sdui command, hardened', () => {
  const run = (argv: string[], files: Record<string, unknown> = {}) => {
    const disk = new Map(
      Object.entries(files).map(([path, value]) => [
        path,
        JSON.stringify(value),
      ]),
    );
    let out = '';
    let err = '';
    const code = runSdui(argv, {
      readFile: (path) => {
        const content = disk.get(path);
        if (content === undefined) throw new Error('no such file');
        return content;
      },
      writeFile: (path, content) => void disk.set(path, content),
      stdout: (text) => void (out += text),
      stderr: (text) => void (err += text),
    });
    return { code, out, err, disk };
  };
  const gen = (...extra: string[]) =>
    run(
      [
        'manifest',
        'gen',
        '--catalog',
        'c.json',
        '--app',
        'a',
        '--platform',
        'ios',
        '--app-version',
        '1.0',
        '--out',
        'm.json',
        ...extra,
      ],
      { 'c.json': readVector('catalog.json') },
    );

  it('does not crash on a flag named after an inherited member', () => {
    expect(
      run(
        [
          'catalog',
          'id',
          '--in',
          'c.json',
          '--constructor',
          'x',
          '--__proto__',
          'y',
        ],
        { 'c.json': readVector('catalog.json') },
      ),
    ).toMatchObject({ code: 0 });
  });

  it('errors on --pin __proto__=1 instead of silently ignoring it', () => {
    const result = gen('--pin', '__proto__=1');
    expect(result.code).toBe(2);
    expect(result.err).toContain('no component or action by that name');
  });

  it('changes the fingerprint when only a version is pinned', () => {
    const fingerprint = (text: string) => /cm_[0-9a-f]{32}/.exec(text)?.[0];
    const base = gen();
    const pinned = gen('--pin', 'hero-banner=2');
    expect(JSON.parse(pinned.disk.get('m.json') as string).components).toEqual({
      ...JSON.parse(base.disk.get('m.json') as string).components,
      'hero-banner': 2,
    });
    expect(fingerprint(pinned.out)).not.toBe(fingerprint(base.out));
  });

  it('refuses to write the manifest over the catalog', () => {
    const result = run(
      [
        'manifest',
        'gen',
        '--catalog',
        'c.json',
        '--app',
        'a',
        '--platform',
        'ios',
        '--app-version',
        '1.0',
        '--out',
        'c.json',
      ],
      { 'c.json': readVector('catalog.json') },
    );
    expect(result.code).toBe(2);
    expect(JSON.parse(result.disk.get('c.json') as string).sduiCatalog).toBe(
      '1',
    );
  });

  it('prints no line a document could use to forge CI output', () => {
    const next = structuredClone(readVector('catalog.json'));
    next.components['product-card'].contract.steps[1].description =
      'x\n::error file=app.ts,line=1::spoofed\n\u001b[2Kgone';
    const result = run(
      [
        'catalog',
        'check',
        '--published',
        'a.json',
        '--next',
        'b\n::add-mask::x.json',
      ],
      { 'a.json': readVector('catalog.json'), 'b\n::add-mask::x.json': next },
    );
    expect(result.code).toBe(1);
    expect(result.err.split('\n').some((line) => line.startsWith('::'))).toBe(
      false,
    );
    expect(result.err).not.toContain('\u001b');
  });
});

describe('diffScreens, the rest', () => {
  const base = (): Screen => readVector('diff/moved.json').before;
  const edit = (mutate: (draft: any) => void): Screen => {
    const draft = structuredClone(base()) as any;
    mutate(draft);
    return draft;
  };

  it.each([
    ['first to last', (list: any[]) => [...list.slice(1), list[0]], 'n0'],
    [
      'last to first',
      (list: any[]) => [list[list.length - 1], ...list.slice(0, -1)],
      'n2999',
    ],
    [
      'from the middle',
      (list: any[]) => [
        ...list.slice(0, 1500),
        ...list.slice(1501),
        list[1500],
      ],
      'n1500',
    ],
  ])('finds the one move among 3,000 siblings, %s', (_name, reorder, moved) => {
    const children = Array.from({ length: 3000 }, (_, index) => ({
      id: `n${index}`,
      type: 'text',
      v: 2,
      props: { content: String(index) },
    }));
    const make = (list: unknown[]): Screen => ({
      id: 's',
      slug: 's',
      root: {
        id: 'r',
        type: 'stack',
        v: 1,
        slots: { children: list as never },
      },
    });
    const started = Date.now();
    const { changes } = diffScreens(
      make(children),
      make(reorder(children)),
      catalog(),
    );
    expect(
      changes.map((change) => [
        change.kind,
        'nodeId' in change ? change.nodeId : null,
      ]),
    ).toEqual([['moved', moved]]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stays fast with many large reversed containers', () => {
    const container = (c: number, reversed: boolean) => {
      const children = Array.from({ length: 1000 }, (_, index) => ({
        id: `c${c}n${index}`,
        type: 'text',
        v: 2,
      }));
      return {
        id: `c${c}`,
        type: 'stack',
        v: 1,
        slots: { children: reversed ? children.reverse() : children },
      };
    };
    const make = (reversed: boolean): Screen => ({
      id: 's',
      slug: 's',
      root: {
        id: 'r',
        type: 'stack',
        v: 1,
        slots: {
          children: Array.from({ length: 30 }, (_, c) =>
            container(c, reversed),
          ) as never,
        },
      },
    });
    const started = Date.now();
    expect(diffScreens(make(false), make(true), catalog()).changes.length).toBe(
      30 * 999,
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('is the same every time for a contract that stamps the time, and reads the clock once', () => {
    const stamped = parseCatalog({
      sduiCatalog: '1',
      components: {
        stack: catalog().components['stack'],
        quote: {
          contract: doc('quote', 2, [
            {
              from: 1,
              to: 2,
              description: 'stamp',
              ops: [
                {
                  wrap: {
                    path: 'nav',
                    key: 'amount',
                    also: { asOf: { $now: true } },
                  },
                },
              ],
            },
          ]),
        },
      },
    });
    const make = (title: string): Screen => ({
      id: 's',
      slug: 's',
      title,
      root: {
        id: 'r',
        type: 'stack',
        v: 1,
        slots: {
          children: [{ id: 'q', type: 'quote', v: 1, props: { nav: 5 } }],
        },
      },
    });
    let tick = 0;
    const context = {
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)),
    };
    for (let run = 0; run < 50; run++) {
      expect(
        diffScreens(make('A'), make('B'), stamped, { context }).changes,
      ).toEqual([{ kind: 'screen', paths: ['title'] }]);
    }
    expect(tick).toBe(50);
  });

  it('reports a type change together with everything else that changed on the node', () => {
    const before = edit((d) =>
      Object.assign(d.root.slots.children[1], {
        visibility: { audience: 'staff' },
        required: true,
      }),
    );
    const after = edit((d) =>
      Object.assign(d.root.slots.children[1], {
        type: 'legal-note',
        v: 2,
        props: { text: 'x' },
      }),
    );
    expect(diffScreens(before, after, catalog()).changes).toEqual([
      {
        kind: 'type',
        nodeId: 'n_shell',
        from: 'product-card',
        to: 'legal-note',
      },
      { kind: 'visibility', nodeId: 'n_shell', type: 'legal-note' },
      { kind: 'required', nodeId: 'n_shell', type: 'legal-note' },
    ]);
  });

  it('reports a changed screen id, and calls two spellings of the same screen unchanged', () => {
    expect(
      diffScreens(
        base(),
        edit((d) => (d.id = 'other')),
        catalog(),
      ),
    ).toMatchObject({
      unchanged: false,
      changes: [{ kind: 'screen', paths: ['id'] }],
    });
    const spelled = edit((d) => (d.root.props = {}));
    expect(screenId(spelled)).not.toBe(screenId(base()));
    expect(diffScreens(base(), spelled, catalog())).toMatchObject({
      unchanged: true,
      changes: [],
      catalogUpgrades: [],
    });
  });

  it('lists a catalog upgrade inside an action, a fallback and an authored state', () => {
    const before: Screen = {
      id: 's',
      slug: 's',
      root: {
        id: 'r',
        type: 'text',
        v: 2,
        props: { content: 'x' },
        actions: { press: { type: 'navigate', v: 1, props: { to: 'x' } } },
        fallback: { id: 'fb', type: 'text', v: 1, props: { text: 'y' } },
      },
      states: { empty: { id: 'e', type: 'text', v: 1, props: { text: 'z' } } },
    };
    const after: Screen = {
      id: 's',
      slug: 's',
      root: {
        id: 'r',
        type: 'text',
        v: 2,
        props: { content: 'x' },
        actions: {
          press: {
            type: 'navigate',
            v: 2,
            props: { to: 'x', transition: 'push' },
          },
        },
        fallback: {
          id: 'fb',
          type: 'text',
          v: 2,
          props: { content: 'y', style: 'body' },
        },
      },
      states: {
        empty: {
          id: 'e',
          type: 'text',
          v: 2,
          props: { content: 'z', style: 'body' },
        },
      },
    };
    const diff = diffScreens(before, after, catalog());
    expect(diff.changes).toEqual([]);
    expect(diff.unchanged).toBe(false);
    expect(diff.catalogUpgrades).toEqual([
      { nodeId: 'e', type: 'text', from: 1, to: 2, derivedPaths: ['style'] },
      {
        nodeId: 'r',
        type: 'navigate',
        from: 1,
        to: 2,
        derivedPaths: ['transition'],
        action: 'press',
      },
      { nodeId: 'fb', type: 'text', from: 1, to: 2, derivedPaths: ['style'] },
    ]);
  });

  it('is not fooled by an id that imitates how places are compared', () => {
    const before: Screen = {
      id: 's',
      slug: 's',
      root: { id: 'a', type: 'stack', v: 1 },
    };
    const after: Screen = {
      id: 's',
      slug: 's',
      root: {
        id: 'null',
        type: 'stack',
        v: 1,
        slots: { null: [{ id: 'a', type: 'stack', v: 1 }] },
      },
    };
    expect(diffScreens(before, after, catalog()).changes).toContainEqual({
      kind: 'moved',
      nodeId: 'a',
      type: 'stack',
      from: { parentId: null, slot: null, index: 0 },
      to: { parentId: 'null', slot: 'null', index: 0 },
    });
  });
});
