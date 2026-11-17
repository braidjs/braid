import type { SkewContractDocument } from '@braidlabs/contract';
import {
  type ClientManifest,
  type Screen,
  type SduiCatalog,
  CATALOG_LIMITS,
  MIGRATED_DEPTH_LIMIT,
  MIGRATED_CHARACTER_LIMIT,
  MIGRATED_VALUE_LIMIT,
  MIGRATION_ALLOWANCE,
  SCREEN_LIMITS,
  TRACE_BUDGET,
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
  parseHandshakeRequest,
  parseReleasePointer,
  parseRolloutPlan,
  parseScreen,
  projectScreen,
  resolveHandshake,
  screenId,
  validateScreen,
} from '../index.js';
import { runSdui } from './cli.js';
import { measure, outgrows } from './internal.js';
import { withValuesFrom, withinAny } from './paths.js';
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
    ).toThrow('a number that is not finite');
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

/**
 * Second verification pass: behaviour it found wrong, and fixes whose tests did not pin them.
 */
describe('loss is what was there and did not come back', () => {
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
  const authored = (v: number, props: object, extra: object = {}): Screen => ({
    id: 's',
    slug: 's',
    root: { id: 'n', type: 'note', v, props, ...extra },
  });

  it('does not count a field the author left out, which a default fills in on the way back', () => {
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
    // Both of these send the byte-identical payload to a v1 device; neither loses anything.
    expect(migrate(mapped, { items: [{}] }, 2, 1)).toMatchObject({
      ok: true,
      value: { items: [{}] },
      lossyPaths: [],
    });
    expect(migrate(mapped, { items: [{ badge: 'new' }] }, 2, 1)).toMatchObject({
      ok: true,
      value: { items: [{}] },
      lossyPaths: [],
    });
    expect(
      projectScreen(
        authored(2, { items: [{}] }),
        only(mapped, { criticalPaths: ['items'] }),
        device({ note: 1 }),
      ).root,
    ).not.toBeNull();

    const toned = doc('note', 2, [
      {
        from: 1,
        to: 2,
        description: 'tone',
        ops: [{ default: { path: 'tone', value: 'plain' } }],
      },
    ]);
    const result = projectScreen(
      authored(2, { text: 'x' }, { required: true }),
      only(toned, { criticalPaths: ['tone'] }),
      device({ note: 1 }),
    );
    expect(result).toMatchObject({ outcome: 'exact', blockedBy: [] });
    expect(result.report[0]).toMatchObject({
      outcome: 'downgraded',
      lossyPaths: [],
    });
  });

  it('does not degrade a screen for a style the author never set', () => {
    const plain: Screen = {
      id: 's',
      slug: 's',
      root: { id: 'n', type: 'text', v: 2, props: { content: 'Hi' } },
    };
    expect(projectScreen(plain, catalog(), manifest('legacy'))).toMatchObject({
      outcome: 'exact',
      root: { props: { text: 'Hi' } },
    });
  });

  it('treats null and absent as the same nothing', () => {
    const badged = doc('note', 2, [
      {
        from: 1,
        to: 2,
        description: 'badge',
        ops: [{ default: { path: 'badge', value: 'new' } }],
      },
    ]);
    expect(migrate(badged, { text: 'x', badge: null }, 2, 1)).toMatchObject({
      ok: true,
      lossyPaths: [],
    });
    expect(migrate(badged, { text: 'x', badge: 'SALE' }, 2, 1)).toMatchObject({
      ok: true,
      lossyPaths: ['badge'],
    });
  });

  const legalSteps: SkewContractDocument['steps'] = [
    {
      from: 1,
      to: 2,
      description: 'legal text',
      ops: [{ default: { path: 'legal', value: null } }],
    },
    {
      from: 2,
      to: 3,
      description: 'renamed',
      ops: [{ rename: { from: 'legal', to: 'legalNote' } }],
    },
    {
      from: 3,
      to: 4,
      description: 'an unused field is dropped for good',
      ops: [{ drop: { path: 'unused' } }],
    },
  ];

  it('finds a critical field in the newest shape even when a step above the node cannot be inverted', () => {
    const strict = only(doc('note', 4, legalSteps), {
      criticalPaths: ['legalNote'],
    });
    // Authored at v2, before the rename, and v3 → v4 cannot be taken back down.
    const result = projectScreen(
      authored(2, { title: 'x', legal: 'Terms apply' }, { required: true }),
      strict,
      device({ note: 1 }),
    );
    expect(result).toMatchObject({
      outcome: 'blocked',
      root: null,
      blockedBy: ['n'],
    });
    expect(result.report[0]?.reason).toContain('cannot carry "legalNote"');
    // The same node with nothing in the critical field renders.
    expect(
      projectScreen(
        authored(2, { title: 'x' }, { required: true }),
        strict,
        device({ note: 1 }),
      ).outcome,
    ).toBe('exact');
  });

  it('treats any loss as critical when the loss cannot be put in the newest shape at all', () => {
    const steps: SkewContractDocument['steps'] = [
      ...legalSteps.slice(0, 2),
      { from: 3, to: 4, description: 'summarise', code: 'summarise' },
    ];
    const strict = only(doc('note', 4, steps), {
      criticalPaths: ['legalNote'],
    });
    const lenient = only(doc('note', 4, steps));
    const node = authored(2, { title: 'x', legal: 'Terms apply' });
    // No implementation of the code step here, so v2 cannot be lifted to v4 to learn the new name.
    expect(projectScreen(node, strict, device({ note: 1 })).root).toBeNull();
    expect(
      projectScreen(node, strict, device({ note: 1 })).report[0]?.reason,
    ).toContain('cannot carry "legal"');
    // Without critical paths there is nothing to protect: it renders, and says what it lost.
    expect(
      projectScreen(node, lenient, device({ note: 1 })).report[0],
    ).toMatchObject({ outcome: 'downgraded', lossyPaths: ['legal'] });
    // And with nothing lost, a component with critical paths still renders.
    expect(
      projectScreen(authored(2, { title: 'x' }), strict, device({ note: 1 }))
        .root,
    ).not.toBeNull();
  });
});

describe('required, precisely', () => {
  const required = {
    id: 'r',
    type: 'video-tile',
    v: 1,
    required: true,
    props: { title: 't', src: 's' },
  };

  it('drops an authored state that renders but lost something required inside it', () => {
    const authored: Screen = {
      ...screen('home'),
      states: {
        empty: {
          id: 'e',
          type: 'stack',
          v: 1,
          slots: {
            children: [
              {
                id: 'kept',
                type: 'text',
                v: 2,
                props: { content: 'Nothing yet' },
              },
              required,
            ],
          },
        },
      },
    };
    const result = projectScreen(authored, catalog(), manifest('one-behind'));
    // The stack itself renders on this device; the state is still not worth showing.
    expect(result.states).toBeUndefined();
    expect(result.outcome).not.toBe('blocked');
    expect(result.report.find((entry) => entry.nodeId === 'e')).toMatchObject({
      outcome: 'exact',
    });
    expect(result.report.find((entry) => entry.nodeId === 'r')).toMatchObject({
      outcome: 'omitted',
    });
    expect(
      projectScreen(authored, catalog(), manifest('current')).states?.empty,
    ).toMatchObject({ id: 'e' });
  });

  it('is conditional inside a fallback: it counts when that fallback is what is rendered, and not otherwise', () => {
    const inFallback = (fallback: object): Screen => ({
      id: 's',
      slug: 's',
      root: {
        id: 'n',
        type: 'video-tile',
        v: 1,
        props: { title: 't', src: 's' },
        fallback: fallback as never,
      },
    });
    const lacksStack = { ...manifest('one-behind'), components: { text: 2 } };
    const group = {
      id: 'f',
      type: 'stack',
      v: 1,
      slots: { children: [{ ...required, type: 'legal-note', v: 9 }] },
      fallback: { id: 'f2', type: 'text', v: 2, props: { content: 'x' } },
    };
    // The fallback `f` is not rendered (the device has no stack); its own fallback is. `r` was
    // required of `f`, not of the screen.
    expect(
      projectScreen(inFallback(group), catalog(), lacksStack),
    ).toMatchObject({ outcome: 'fallback', blockedBy: [], root: { id: 'f2' } });
    // Here `f` is rendered, and so what it requires is required.
    expect(
      projectScreen(inFallback(group), catalog(), manifest('one-behind')),
    ).toMatchObject({ outcome: 'blocked', blockedBy: ['r'] });
  });
});

describe('limits and names, each pinned', () => {
  const home = (mutate: (draft: any) => void) => () => {
    const draft = structuredClone(screen('home')) as any;
    mutate(draft);
    return parseScreen(draft);
  };
  const first = (draft: any) => draft.root.slots.children[0];

  it.each(['constructor', 'prototype', '__proto__', '0abc', 'has space', ''])(
    'refuses %j as a slot name and as an action name',
    (name) => {
      const keyed = (value: unknown) =>
        JSON.parse(`{${JSON.stringify(name)}:${JSON.stringify(value)}}`);
      expect(home((d) => (first(d).slots = keyed([])))).toThrow('slot named');
      expect(
        home((d) => (first(d).actions = keyed({ type: 'navigate', v: 1 }))),
      ).toThrow('action named');
    },
  );

  it.each(['constructor', 'prototype', '__proto__'])(
    'refuses %j as a flag key and in a condition',
    (name) => {
      expect(() =>
        parseFlagDefinitions(
          JSON.parse(`[{"key":${JSON.stringify(name)},"default":1}]`),
        ),
      ).toThrow('short plain word');
      expect(() => parseCondition({ flag: name })).toThrow(
        'must be a flag name',
      );
    },
  );

  it('refuses a document with more values than the cap, however it is spread', () => {
    const many = Array.from(
      { length: SCREEN_LIMITS.values },
      (_, index) => index,
    );
    expect(home((d) => (first(d).props = { many }))).toThrow(
      `more than ${SCREEN_LIMITS.values} values`,
    );
    expect(
      home((d) => (first(d).props = { few: many.slice(0, 1000) })),
    ).not.toThrow();
  });

  it('refuses a condition nested past the limit, and counts conditions against the value cap', () => {
    let nested: unknown = { platform: ['ios'] };
    for (let depth = 0; depth < 17; depth++) nested = { not: nested };
    expect(() => parseCondition(nested)).toThrow(
      'nested more than 16 levels deep',
    );
    let wide: unknown = { platform: ['ios'] };
    for (let level = 0; level < 3; level++)
      wide = { all: Array.from({ length: 64 }, () => wide) };
    expect(() => parseCondition(wide)).toThrow(
      `more than ${SCREEN_LIMITS.values} values`,
    );
  });

  it('answers unknown, not a stack overflow, for a condition that skipped the parser', () => {
    let nested: any = { platform: ['ios'] };
    for (let depth = 0; depth < 20_000; depth++) nested = { not: nested };
    const gated = { id: 'n', type: 'text', v: 2, visibility: nested } as never;
    expect(applyVisibility({ root: gated }, { platform: 'ios' })).toMatchObject(
      { root: null },
    );
  });
});

describe('fixes whose tests did not hold them', () => {
  it('tells two steps apart even when a 32-bit hash of them collides', () => {
    // Found by search: these pairs collide under FNV-1a of "description:ops" and of the canonical
    // step text respectively. A comparison by either hash calls the edit an unchanged step.
    for (const [a, b] of [
      [940068, 1784900],
      [512789, 749192],
    ] as const) {
      const at = (value: number): SduiCatalog =>
        ({
          sduiCatalog: '1',
          components: {
            note: {
              contract: doc('note', 2, [
                {
                  from: 1,
                  to: 2,
                  description: 'a badge',
                  ops: [{ default: { path: 'badge', value: `v${value}` } }],
                },
              ]),
            },
          },
        }) as SduiCatalog;
      expect(checkCatalog(at(a), at(b))).toMatchObject([
        { kind: 'step-edited', contract: 'sdui.component.note' },
      ]);
    }
  });

  it('diffs a list far too long for any table of pairs', () => {
    // 60,000 siblings: a table of every pair would be 3.6 billion cells.
    const children = Array.from({ length: 60_000 }, (_, index) => ({
      id: `n${index}`,
      type: 'text',
      v: 2,
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
    const { changes } = diffScreens(
      make(children),
      make([children[children.length - 1], ...children.slice(0, -1)]),
      catalog(),
    );
    expect(changes).toEqual([
      {
        kind: 'moved',
        nodeId: 'n59999',
        type: 'text',
        from: { parentId: 'r', slot: 'children', index: 59_999 },
        to: { parentId: 'r', slot: 'children', index: 0 },
      },
    ]);
  });

  it('agrees with brute force on which siblings moved, for every ordering of six', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const make = (order: string[]): Screen => ({
      id: 's',
      slug: 's',
      root: {
        id: 'r',
        type: 'stack',
        v: 1,
        slots: { children: order.map((id) => ({ id, type: 'text', v: 2 })) },
      },
    });
    const longestRun = (order: string[]): number => {
      const best = order.map(() => 1);
      for (let i = 0; i < order.length; i++)
        for (let j = 0; j < i; j++)
          if ((order[j] as string) < (order[i] as string))
            best[i] = Math.max(best[i] as number, (best[j] as number) + 1);
      return Math.max(...best);
    };
    const permute = (rest: string[], done: string[] = []): string[][] =>
      rest.length === 0
        ? [done]
        : rest.flatMap((id, index) =>
            permute(
              [...rest.slice(0, index), ...rest.slice(index + 1)],
              [...done, id],
            ),
          );
    for (const order of permute(ids)) {
      const moved = diffScreens(
        make(ids),
        make(order),
        catalog(),
      ).changes.filter((change) => change.kind === 'moved');
      expect(moved.length).toBe(ids.length - longestRun(order));
    }
  });

  it('resolveHandshake refuses a malformed manifest itself, without the parser having run', () => {
    const request = {
      protocol: [1, 1],
      manifest: { junk: 1, components: 'not-a-map' },
      app: { id: 'a', platform: 'ios', version: '6.2.0' },
    } as never;
    expect(
      resolveHandshake(request, {
        authorized: true,
        knowsManifest: () => false,
      }),
    ).toEqual({ status: 'manifest-unknown', httpStatus: 400, protocol: 1 });
  });

  it('parseHandshakeRequest bounds device facts and refuses stray keys on app', () => {
    const valid = {
      protocol: [1, 1],
      manifest: 'cm_x',
      app: { id: 'a', platform: 'ios', version: '6.2.0' },
    };
    expect(
      parseHandshakeRequest({
        ...valid,
        device: { os: '17.4', fontScale: 1.3, reduceMotion: true },
      }),
    ).toBeTruthy();
    let deep: unknown = 1;
    for (let depth = 0; depth < 20_000; depth++) deep = [deep];
    expect(() =>
      parseHandshakeRequest({ ...valid, device: { os: deep } }),
    ).toThrow('device.os must be');
    expect(() =>
      parseHandshakeRequest({
        ...valid,
        device: { os: 'x'.repeat(5_000_000) },
      }),
    ).toThrow('device.os must be');
    expect(() =>
      parseHandshakeRequest({
        ...valid,
        device: JSON.parse('{"__proto__":{"a":1}}'),
      }),
    ).toThrow('not a short plain word');
    expect(() =>
      parseHandshakeRequest({
        ...valid,
        app: JSON.parse(
          '{"id":"a","platform":"ios","version":"6.2.0","__proto__":{"a":1}}',
        ),
      }),
    ).toThrow('app has an unknown key');
  });
});

/**
 * Third verification pass.
 */
describe('loss, for a node authored below the newest version', () => {
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
  const authored = (v: number, props: object, extra: object = {}): Screen => ({
    id: 's',
    slug: 's',
    root: { id: 'n', type: 'note', v, props, ...extra },
  });
  const project = (node: Screen, strict: SduiCatalog) =>
    projectScreen(node, strict, device({ note: 1 }));

  it('reports nothing for a field its author left out — the lift runs here', () => {
    // v3 exists only so that these nodes, authored at v2, are below the newest version.
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'badges and style',
        ops: [
          {
            map: {
              path: 'items',
              ops: [{ default: { path: 'badge', value: 'new' } }],
            },
          },
          { default: { path: 'style', value: 'body' } },
        ],
      },
      {
        from: 2,
        to: 3,
        description: 'tone',
        ops: [{ default: { path: 'tone', value: 'plain' } }],
      },
    ];
    const strict = only(doc('note', 3, steps), {
      criticalPaths: ['items', 'style'],
    });
    const result = project(
      authored(2, { items: [{}] }, { required: true }),
      strict,
    );
    expect(result).toMatchObject({
      outcome: 'exact',
      blockedBy: [],
      root: { props: { items: [{}] } },
    });
    expect(result.report[0]).toMatchObject({
      outcome: 'downgraded',
      lossyPaths: [],
    });
    // And an authored value in the same place is a loss, named in the newest shape.
    expect(
      project(
        authored(2, { items: [{ badge: 'SALE' }] }),
        only(doc('note', 3, steps)),
      ).report[0],
    ).toMatchObject({ lossyPaths: ['items[0].badge'] });
    expect(
      project(authored(2, { items: [{ badge: 'SALE' }] }), strict).root,
    ).toBeNull();
  });

  it('is not fooled by a later default that fills an absent field but not a null one', () => {
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'legal',
        ops: [{ default: { path: 'legal', value: null } }],
      },
      {
        from: 2,
        to: 3,
        description: 'rename',
        ops: [{ rename: { from: 'legal', to: 'legalNote' } }],
      },
      {
        from: 3,
        to: 4,
        description: 'standard terms',
        ops: [{ default: { path: 'legalNote', value: 'Standard terms' } }],
      },
    ];
    const strict = only(doc('note', 4, steps), {
      criticalPaths: ['legalNote'],
    });
    // The author wrote no legal text at all. Nothing is lost on a v1 device.
    for (const props of [{ title: 'x' }, { title: 'x', legal: null }]) {
      expect(
        project(authored(2, props, { required: true }), strict),
      ).toMatchObject({ outcome: 'exact', blockedBy: [] });
    }
    // The author did write some: that is lost, under the name it has now.
    const lost = project(
      authored(2, { title: 'x', legal: 'Terms apply' }, { required: true }),
      strict,
    );
    expect(lost).toMatchObject({ outcome: 'blocked', blockedBy: ['n'] });
    expect(lost.report[0]?.reason).toContain('cannot carry "legalNote"');
  });

  const dropped: SkewContractDocument['steps'] = [
    {
      from: 1,
      to: 2,
      description: 'subtitle',
      ops: [{ default: { path: 'subtitle', value: null } }],
    },
    {
      from: 2,
      to: 3,
      description: 'subtitle is retired',
      ops: [{ drop: { path: 'subtitle' } }],
    },
  ];

  it('still reports a loss the newest shape has no place for, under its authored name', () => {
    const result = project(
      authored(2, { title: 'x', subtitle: 'Hello' }),
      only(doc('note', 3, dropped)),
    );
    expect(result.outcome).toBe('degraded');
    expect(result.report[0]).toMatchObject({
      outcome: 'downgraded',
      lossyPaths: ['subtitle'],
    });
  });

  it('refuses a loss it cannot trace when the component has critical paths', () => {
    const strict = only(doc('note', 3, dropped), { criticalPaths: ['price'] });
    const result = project(
      authored(2, { title: 'x', subtitle: 'Hello' }),
      strict,
    );
    expect(result.root).toBeNull();
    expect(result.report[0]?.reason).toContain('cannot carry "subtitle"');
    expect(project(authored(2, { title: 'x' }), strict).root).not.toBeNull();
  });

  it('refuses when a later one-way step folds the lost value and its replacement into one', () => {
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'legal',
        ops: [{ default: { path: 'legal', value: null } }],
      },
      {
        from: 2,
        to: 3,
        description: 'rename',
        ops: [{ rename: { from: 'legal', to: 'legalNote' } }],
      },
      {
        from: 3,
        to: 4,
        description: 'kinds of terms',
        ops: [
          {
            convert: {
              path: 'legalNote',
              to: 'string',
              via: { 'Terms apply': 'standard', null: 'standard' },
            },
          },
        ],
      },
    ];
    const strict = only(doc('note', 4, steps), {
      criticalPaths: ['legalNote'],
    });
    expect(
      project(authored(2, { title: 'x', legal: 'Terms apply' }), strict).root,
    ).toBeNull();
  });

  it('judges each loss on its own: one that traces to something harmless does not cover for one that does not trace', () => {
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'badge and subtitle',
        ops: [
          { default: { path: 'badge', value: null } },
          { default: { path: 'subtitle', value: null } },
        ],
      },
      {
        from: 2,
        to: 3,
        description: 'subtitle is retired',
        ops: [{ drop: { path: 'subtitle' } }],
      },
    ];
    const strict = only(doc('note', 3, steps), { criticalPaths: ['price'] });
    const lenient = only(doc('note', 3, steps));
    const node = authored(2, { title: 'x', badge: 'New', subtitle: 'Hello' });
    expect(project(node, lenient).report[0]).toMatchObject({
      lossyPaths: ['badge', 'subtitle'],
    });
    expect(project(node, strict).root).toBeNull();
    // With only the traceable, non-critical loss it renders.
    expect(
      project(authored(2, { title: 'x', badge: 'New' }), strict).report[0],
    ).toMatchObject({ outcome: 'downgraded', lossyPaths: ['badge'] });
  });
});

describe('reserved keys, where the plan says they are refused', () => {
  const clone = (): any => structuredClone(readVector('catalog.json'));
  const broken = (mutate: (draft: any) => void) => () => {
    const draft = clone();
    mutate(draft);
    return parseCatalog(draft);
  };

  it('in a catalog: critical and localizable paths, slot accepts', () => {
    expect(
      broken(
        (d) => (d.components['product-card'].criticalPaths = ['__proto__']),
      ),
    ).toThrow('criticalPaths must be an array of paths');
    expect(
      broken(
        (d) =>
          (d.components['product-card'].criticalPaths = [
            'constructor.prototype',
          ]),
      ),
    ).toThrow('criticalPaths');
    expect(
      broken(
        (d) =>
          (d.components['product-card'].localizable = ['items[0].constructor']),
      ),
    ).toThrow('localizable');
    expect(
      broken(
        (d) => (d.components['stack'].slots.children.accepts = ['__proto__']),
      ),
    ).toThrow('accepts must be an array of component types');
    expect(
      broken(
        (d) =>
          (d.components['stack'].slots.children.accepts = [
            'text',
            'product-card',
          ]),
      ),
    ).not.toThrow();
  });

  it('in flag definitions and rollout plans', () => {
    expect(() =>
      parseFlagDefinitions([
        { key: 'a', default: JSON.parse('{"__proto__":{"admin":true}}') },
      ]),
    ).toThrow('its default uses the reserved key "__proto__"');
    expect(() =>
      parseFlagDefinitions([
        {
          key: 'a',
          default: 1,
          rules: [{ value: { deep: [{ constructor: 1 }] } }],
        },
      ]),
    ).toThrow('its value uses the reserved key "constructor"');
    expect(() =>
      parseFlagDefinitions([
        JSON.parse('{"key":"a","default":1,"__proto__":{"x":1}}'),
      ]),
    ).toThrow('unknown key "__proto__"');
    expect(() =>
      parseFlagDefinitions([
        { key: 'a', default: 1, rules: [{ value: 2, extra: 1 }] },
      ]),
    ).toThrow('rule 0 has an unknown key "extra"');
    expect(() =>
      parseRolloutPlan(
        JSON.parse(
          '{"stable":"a","candidate":"b","stages":[100],"stage":0,"salt":"s","__proto__":{"x":1}}',
        ),
      ),
    ).toThrow('unknown key "__proto__"');
  });

  it('in what a device says it knows', () => {
    const valid = {
      protocol: [1, 1],
      manifest: 'cm_x',
      app: { id: 'a', platform: 'ios', version: '6.2.0' },
    };
    expect(() =>
      parseHandshakeRequest({
        ...valid,
        known: { release: 'rel_a', seq: 1, extra: 1 },
      }),
    ).toThrow('known takes release and seq');
    expect(() =>
      parseHandshakeRequest({
        ...valid,
        known: JSON.parse('{"release":"rel_a","seq":1,"__proto__":{"x":1}}'),
      }),
    ).toThrow('known takes release and seq');
  });
});

describe('the rest of the third pass', () => {
  it('validateScreen says that required on a fallback has no effect', () => {
    const odd: Screen = {
      id: 's',
      slug: 's',
      root: {
        id: 'n',
        type: 'video-tile',
        v: 1,
        props: { title: 't', src: 's' },
        fallback: {
          id: 'fb',
          type: 'text',
          v: 2,
          required: true,
          props: { content: 'x' },
        },
      },
    };
    expect(validateScreen(odd, catalog())).toEqual([
      {
        nodeId: 'fb',
        message:
          '"required" on a fallback has no effect — mark "n", the node it stands in for',
      },
    ]);
  });

  it('resolveHandshake tells a retired binary to update even when what it sent is not a manifest', () => {
    const request = {
      protocol: [1, 1],
      manifest: { junk: 1 },
      app: { id: 'a', platform: 'ios', version: '4.0' },
    } as never;
    expect(
      resolveHandshake(request, {
        authorized: true,
        knowsManifest: () => false,
        requiredVersion: '5.2.0',
      }).status,
    ).toBe('update-required');
    expect(
      resolveHandshake(request, {
        authorized: true,
        knowsManifest: () => false,
      }),
    ).toMatchObject({ status: 'manifest-unknown', httpStatus: 400 });
  });
});

/**
 * Fourth verification pass.
 */
describe('loss tracing is bounded, and sees losses together', () => {
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
  const authored = (v: number, props: object, extra: object = {}): Screen => ({
    id: 's',
    slug: 's',
    root: { id: 'n', type: 'note', v, props, ...extra },
  });
  const project = (node: Screen, strict: SduiCatalog) =>
    projectScreen(node, strict, device({ note: 1 }));

  it('catches two losses that only reach a critical field together', () => {
    // Either of `p.a.v` and `p.b.v` alone leaves `c` standing, filled from the other.
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'wrap',
        ops: [{ wrap: { path: 'p', key: 'k' } }],
      },
      {
        from: 2,
        to: 3,
        description: 'c from b, then from a',
        ops: [
          { rename: { from: 'p.b.v', to: 'c' } },
          { rename: { from: 'p.a.v', to: 'c' } },
        ],
      },
    ];
    const strict = only(doc('note', 3, steps), { criticalPaths: ['c'] });
    const both = project(
      authored(
        2,
        { p: { k: 'K', a: { v: 'X', note: 'n1' }, b: { v: 'X', note: 'n2' } } },
        { required: true },
      ),
      strict,
    );
    expect(both).toMatchObject({ outcome: 'blocked', blockedBy: ['n'] });
    expect(both.report[0]?.reason).toContain('cannot carry "c"');
  });

  it('refuses when the lost value itself lifts to nothing, so the loss leaves no trace', () => {
    // 'Terms' becomes null in the newest shape. Comparing the two lifted copies in both
    // directions would see the replacement appear and call the loss traced and harmless.
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'legal',
        ops: [{ default: { path: 'legal', value: null } }],
      },
      {
        from: 2,
        to: 3,
        description: 'kinds',
        ops: [
          {
            convert: {
              path: 'legal',
              to: 'string',
              via: { Terms: null, null: 'none' },
            },
          },
        ],
      },
    ];
    const result = project(
      authored(2, { title: 'x', legal: 'Terms' }),
      only(doc('note', 3, steps), { criticalPaths: ['price'] }),
    );
    expect(result.root).toBeNull();
    expect(result.report[0]?.reason).toContain('cannot carry "legal"');
  });

  it('refuses when what was lost is where a later step takes a critical field from', () => {
    // `cost` is hoisted out of `p.price` by the step above; without `p.price` it has no value.
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'price',
        ops: [{ default: { path: 'p.price', value: { amount: 0 } } }],
      },
      {
        from: 2,
        to: 3,
        description: 'cost',
        ops: [
          { hoist: { path: 'p.price', key: 'amount' } },
          { rename: { from: 'p.price', to: 'cost' } },
        ],
      },
    ];
    const strict = only(doc('note', 3, steps), { criticalPaths: ['cost'] });
    const node = authored(
      2,
      { p: { k: 'K', price: { amount: 5 } } },
      { required: true },
    );
    // On a v1 device `p.price` is gone; it must not render without the cost.
    const result = project(node, strict);
    expect(result).toMatchObject({ outcome: 'blocked', blockedBy: ['n'] });
  });

  it('traces each loss on its own while the budget lasts, and assumes the worst past it', () => {
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'badges',
        ops: [
          {
            map: {
              path: 'items',
              ops: [{ default: { path: 'badge', value: null } }],
            },
          },
        ],
      },
      {
        from: 2,
        to: 3,
        description: 'tone',
        ops: [{ default: { path: 'tone', value: 'plain' } }],
      },
    ];
    const strict = only(doc('note', 3, steps), { criticalPaths: ['tone'] });
    const lenient = only(doc('note', 3, steps));
    const list = (length: number) =>
      authored(2, {
        items: Array.from({ length }, (_, index) => ({
          id: index,
          badge: `b${index}`,
        })),
      });
    // A hundred losses are each traced: none is near `tone`, so the node renders.
    const small = project(list(100), strict);
    expect(small.outcome).toBe('degraded');
    expect(small.report[0]?.lossyPaths).toHaveLength(100);

    // 8,000 would be 8,000 lifts of 24,000 values — a minute and a half. Past the budget they
    // are not traced one by one: all are reported, and a component with critical paths refuses.
    const started = Date.now();
    const refused = project(list(8000), strict);
    const reported = project(list(8000), lenient);
    const elapsed = Date.now() - started;
    expect(refused.root).toBeNull();
    expect(refused.report[0]?.reason).toContain(
      'cannot carry "items[0].badge"',
    );
    expect(reported.outcome).toBe('degraded');
    expect(reported.report[0]?.lossyPaths).toHaveLength(8000);
    expect(elapsed).toBeLessThan(4000);
  });

  it('is not stalled, or misled, by a prop key spelled like an array index', () => {
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'extras',
        ops: [{ default: { path: 'note', value: null } }],
      },
      {
        from: 2,
        to: 3,
        description: 'each x',
        ops: [
          {
            map: {
              path: 'x',
              ops: [{ default: { path: 'seen', value: false } }],
            },
          },
        ],
      },
    ];
    const odd = {
      id: 's',
      slug: 's',
      root: {
        id: 'n',
        type: 'note',
        v: 2,
        props: { x: [{ a: 1 }], 'x[4294967294]': 'k', note: 'lost' },
      },
    } as Screen;
    const started = Date.now();
    const result = project(odd, only(doc('note', 3, steps)));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.report[0]).toMatchObject({ lossyPaths: ['note'] });
    // And a parsed screen cannot carry such a key in the first place.
    expect(() => parseScreen(structuredClone(odd))).toThrow(
      'containing ".", "[" or "]"',
    );
    expect(() =>
      parseScreen({
        id: 's',
        slug: 's',
        root: { id: 'n', type: 'note', v: 1, props: { 'a.b': 1 } },
      }),
    ).toThrow('containing ".", "[" or "]"');
  });
});

describe('the fourth pass, the rest', () => {
  it('holds the value cap on props alone, with no condition in the screen to trip it', () => {
    const plain = (count: number) => ({
      id: 's',
      slug: 's',
      root: {
        id: 'n',
        type: 'text',
        v: 2,
        props: { many: Array.from({ length: count }, (_, index) => index) },
      },
    });
    expect(() => parseScreen(plain(SCREEN_LIMITS.values + 10))).toThrow(
      `more than ${SCREEN_LIMITS.values} values`,
    );
    expect(() => parseScreen(plain(1000))).not.toThrow();
  });

  it('refuses reserved keys inside a catalog fallback, and a $from that carries anything else', () => {
    const broken = (fallback: unknown) => () => {
      const draft = structuredClone(readVector('catalog.json'));
      draft.components['video-tile'].fallback = fallback;
      return parseCatalog(draft);
    };
    expect(
      broken({
        type: 'text',
        props: { content: { nested: JSON.parse('{"__proto__":{"x":1}}') } },
      }),
    ).toThrow('fallback prop "content" uses the reserved key "__proto__"');
    expect(
      broken({ type: 'text', props: { content: [{ constructor: 1 }] } }),
    ).toThrow('uses the reserved key "constructor"');
    expect(
      broken({
        type: 'text',
        props: { content: JSON.parse('{"$from":"title","__proto__":{"x":1}}') },
      }),
    ).toThrow('must be { "$from": "<path>" } and nothing else');
    expect(broken({ type: 'text', props: { content: { $from: 7 } } })).toThrow(
      'must be { "$from": "<path>" }',
    );
    expect(
      broken({
        type: 'text',
        props: { content: { $from: 'title' }, style: 'link' },
      }),
    ).not.toThrow();
  });

  it('refuses a flag owner or expiry that is not a short string', () => {
    expect(() =>
      parseFlagDefinitions([
        { key: 'a', default: 1, owner: JSON.parse('{"__proto__":{"x":1}}') },
      ]),
    ).toThrow('owner must be a string');
    expect(() =>
      parseFlagDefinitions([
        { key: 'a', default: 1, expires: { constructor: 1 } },
      ]),
    ).toThrow('expires must be a string');
    expect(() =>
      parseFlagDefinitions([
        { key: 'a', default: 1, owner: 'growth', expires: '2027-01-01' },
      ]),
    ).not.toThrow();
  });
});

describe('many losses on one node', () => {
  it('are each traced, however many kinds of field they are', () => {
    const fields = Array.from({ length: 40 }, (_, index) => `f${index}`);
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'forty fields',
        ops: fields.map((field) => ({ default: { path: field, value: null } })),
      },
      {
        from: 2,
        to: 3,
        description: 'tone',
        ops: [{ default: { path: 'tone', value: 'plain' } }],
      },
    ];
    const only = (extra: object = {}): SduiCatalog =>
      parseCatalog({
        sduiCatalog: '1',
        components: { note: { contract: doc('note', 3, steps), ...extra } },
      });
    const node: Screen = {
      id: 's',
      slug: 's',
      root: {
        id: 'n',
        type: 'note',
        v: 2,
        props: Object.fromEntries(fields.map((field) => [field, 'set'])),
      },
    };
    for (const strict of [only(), only({ criticalPaths: ['tone'] })]) {
      const result = projectScreen(node, strict, device({ note: 1 }));
      expect(result.outcome).toBe('degraded');
      expect(result.report[0]?.lossyPaths).toHaveLength(40);
    }
    expect(
      projectScreen(node, only({ criticalPaths: ['f7'] }), device({ note: 1 }))
        .report[0]?.reason,
    ).toContain('cannot carry "f7"');
  });
});

describe('the fifth pass: a loss with no trace, wherever it hides', () => {
  const only = (
    steps: SkewContractDocument['steps'],
    extra: object = {},
  ): SduiCatalog =>
    parseCatalog({
      sduiCatalog: '1',
      components: {
        note: { contract: doc('note', steps.length + 1, steps), ...extra },
      },
    });
  const authored = (props: object, extra: object = {}): Screen =>
    parseScreen({
      id: 's',
      slug: 's',
      root: { id: 'n', type: 'note', v: 2, props, ...extra },
    });
  const onV1 = (
    node: Screen,
    strict: SduiCatalog,
    options: Parameters<typeof projectScreen>[3] = {},
  ) => projectScreen(node, strict, device({ note: 1 }), options);

  it('is not hidden by another loss of the same kind that does leave one', () => {
    // v3 folds badge "A" and no badge into the same "x"; "B" becomes "y". So losing "A" leaves no
    // trace in the newest shape, and losing "B" does.
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'badges',
        ops: [
          {
            map: {
              path: 'items',
              ops: [{ default: { path: 'badge', value: null } }],
            },
          },
        ],
      },
      {
        from: 2,
        to: 3,
        description: 'badge kinds, one way',
        ops: [
          {
            map: {
              path: 'items',
              ops: [
                {
                  convert: {
                    path: 'badge',
                    to: 'string',
                    via: { A: 'x', null: 'x', B: 'y' },
                  },
                },
              ],
            },
          },
        ],
      },
    ];
    const strict = only(steps, { criticalPaths: ['price'] });
    const alone = onV1(authored({ items: [{ badge: 'A' }] }), strict);
    expect(alone.report[0]?.reason).toContain('cannot carry "items[0].badge"');
    // The same loss, next to one that can be traced: still refused.
    const beside = onV1(
      authored({ items: [{ badge: 'A' }, { badge: 'B' }] }),
      strict,
    );
    expect(beside.root).toBeNull();
    expect(beside.report[0]?.reason).toContain('cannot carry "items[0].badge"');
    // And with nothing critical to protect, both are reported.
    expect(
      onV1(authored({ items: [{ badge: 'A' }, { badge: 'B' }] }), only(steps))
        .report[0]?.lossyPaths,
    ).toEqual(['items[1].badge', 'items[0].badge']);
  });

  it('counts a loss whose copy cannot be lifted, though the losses together can', () => {
    // With both losses put back the lift works. With `q` alone put back as the device has it,
    // `b` keeps its authored "P", the rename brings `q`'s number over it, and the hoist fails.
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'b is fixed, q is new',
        ops: [
          { const: { path: 'b', value: { k: 'Z' } } },
          { drop: { path: 'q', restore: 0 } },
        ],
      },
      {
        from: 2,
        to: 3,
        description: 'snapshot b, then b from q, then unwrap',
        ops: [
          { wrap: { path: 'w', key: 'k', also: { snap: { $from: '/b' } } } },
          { rename: { from: 'q', to: 'b' } },
          { hoist: { path: 'b', key: 'k' } },
        ],
      },
    ];
    const node = { w: 'W', b: 'P', q: { k: 1 } };
    const refused = onV1(
      authored(node),
      only(steps, { criticalPaths: ['price'] }),
    );
    expect(refused.root).toBeNull();
    expect(refused.report[0]?.reason).toContain('cannot carry "q"');
    // Nothing critical: it renders, and `q` is among what it reports, under its authored name.
    const lenient = onV1(authored(node), only(steps));
    expect(lenient.outcome).toBe('degraded');
    expect(lenient.report[0]?.lossyPaths).toContain('q');
  });

  it('never reads an unliftable copy as "nothing lost"', () => {
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'a is fixed, b is new',
        ops: [
          { const: { path: 'a', value: 'S' } },
          { drop: { path: 'b', restore: 0 } },
        ],
      },
      {
        from: 2,
        to: 3,
        description: 'snapshot a, a from b, unwrap a',
        ops: [
          { wrap: { path: 'w', key: 'k', also: { snap: { $from: '/a' } } } },
          { rename: { from: 'b', to: 'a' } },
          { hoist: { path: 'a', key: 'k' } },
        ],
      },
    ];
    const strict = only(steps, { criticalPaths: ['price'] });
    const props = { w: 'W', a: { k: 1 }, b: { k: 2 } };
    const optional = onV1(authored(props), strict);
    expect(optional.root).toBeNull();
    expect(optional.report[0]).toMatchObject({ outcome: 'omitted' });
    expect(optional.report[0]?.reason).toContain('cannot carry');
    expect(onV1(authored(props, { required: true }), strict)).toMatchObject({
      outcome: 'blocked',
      blockedBy: ['n'],
    });
    // Without critical paths it renders — and is not called exact.
    const lenient = onV1(authored(props), only(steps));
    expect(lenient.outcome).toBe('degraded');
    expect(lenient.report[0]?.lossyPaths.length).toBeGreaterThan(0);
  });

  it('puts a lost value back as absent, not as null, so a later default can hide it', () => {
    // `p.x` is dropped by the unwrap; lifted again, the v3 default fills in the very value the
    // author wrote. Nothing shows in the newest shape, so the loss is untraced — and refused.
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'wrap p',
        ops: [{ wrap: { path: 'p', key: 'k' } }],
      },
      {
        from: 2,
        to: 3,
        description: 'p.x defaults to D',
        ops: [{ default: { path: 'p.x', value: 'D' } }],
      },
    ];
    const node = authored({ p: { k: 'K', x: 'D' } });
    expect(
      onV1(node, only(steps, { criticalPaths: ['price'] })).report[0]?.reason,
    ).toContain('cannot carry "p.x"');
    expect(onV1(node, only(steps)).report[0]?.lossyPaths).toEqual(['p.x']);
  });

  it('does not report a loss at "" when a step turns the copy into something else', () => {
    // Without its `kind` the code step gives back a string, not props: the whole of the lifted
    // copy differs. That says nothing about which field it was, so the loss keeps its name.
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'kind',
        ops: [{ default: { path: 'kind', value: null } }],
      },
      { from: 2, to: 3, description: 'by kind', code: 'by-kind' },
    ];
    const codeSteps = {
      'by-kind': {
        up: (props: { kind: string | null }) =>
          props.kind === null ? 'nothing' : { ...props, known: true },
      },
    };
    const node = authored({ kind: 'sale', title: 'x' });
    const lenient = onV1(node, only(steps), { codeSteps });
    expect(lenient.report[0]?.lossyPaths).toEqual(['kind']);
    expect(
      onV1(node, only(steps, { criticalPaths: ['price'] }), { codeSteps })
        .report[0]?.reason,
    ).toContain('cannot carry "kind"');
  });

  it('reports the props as a whole when a step gives back something that is not props', () => {
    const steps: SkewContractDocument['steps'] = [
      { from: 1, to: 2, description: 'opaque', code: 'opaque' },
      {
        from: 2,
        to: 3,
        description: 'tone',
        ops: [{ default: { path: 'tone', value: 'plain' } }],
      },
    ];
    const codeSteps = { opaque: { up: () => 'gone', down: () => ({}) } };
    // A key that happens to be spelled "undefined" is content like any other, and stays put.
    const node = authored({ undefined: 'kept', a: 1 });
    expect(
      onV1(node, only(steps), { codeSteps }).report[0]?.lossyPaths,
    ).toEqual(['']);
    expect(
      onV1(node, only(steps, { criticalPaths: ['price'] }), { codeSteps })
        .report[0]?.reason,
    ).toContain('cannot carry its props as a whole');
    expect(withValuesFrom({ undefined: 'kept', a: 1 }, 'gone', [[]])).toEqual({
      undefined: 'kept',
      a: 1,
    });
  });

  it.each([1, 2])(
    'shares one tracing budget across the nodes of a projection (%i versions lifted)',
    (above) => {
      const fields = Array.from({ length: 32 }, (_, index) => `f${index}`);
      const strict = parseCatalog({
        sduiCatalog: '1',
        components: {
          note: {
            contract: doc('note', 2 + above, [
              {
                from: 1,
                to: 2,
                description: 'fields',
                ops: fields.map((field) => ({
                  default: { path: field, value: null },
                })),
              },
              ...Array.from({ length: above }, (_, index) => ({
                from: 2 + index,
                to: 3 + index,
                description: `tone ${index}`,
                ops: [{ default: { path: `tone${index}`, value: 'plain' } }],
              })),
            ]),
            criticalPaths: ['tone0'],
          },
          stack: { contract: doc('stack', 1, []), slots: { children: {} } },
        },
      });
      const notes = (count: number): Screen =>
        parseScreen({
          id: 's',
          slug: 's',
          root: {
            id: 'root',
            type: 'stack',
            v: 1,
            slots: {
              children: Array.from({ length: count }, (_, index) => ({
                id: `n${index}`,
                type: 'note',
                v: 2,
                props: Object.fromEntries(fields.map((field) => [field, 'x'])),
              })),
            },
          },
        });
      const on = device({ note: 1, stack: 1 });
      // Each node costs 32 losses × (33 values + 32) = 2,080 of the budget per version lifted.
      const within = Math.floor(TRACE_BUDGET / (2080 * above));
      const result = projectScreen(notes(within + 5), strict, on);
      const outcomes = result.report
        .filter((entry) => entry.type === 'note')
        .map((entry) => entry.outcome);
      expect(outcomes.slice(0, within)).toEqual(
        Array.from({ length: within }, () => 'downgraded'),
      );
      // Past the budget the losses are not traced, so a component with critical paths refuses.
      expect(outcomes.slice(within)).toEqual(
        Array.from({ length: 5 }, () => 'omitted'),
      );
      expect(reportOf(result, `n${within}`)[0]?.reason).toContain(
        'cannot carry',
      );
      // The budget is the projection's, not the process's: the next one starts afresh.
      expect(projectScreen(notes(3), strict, on).outcome).toBe('degraded');
    },
  );

  it('refuses the loss of the props as a whole at the newest version too', () => {
    const steps: SkewContractDocument['steps'] = [
      { from: 1, to: 2, description: 'opaque', code: 'opaque' },
    ];
    const codeSteps = { opaque: { up: () => 'gone', down: () => ({}) } };
    const node = authored({ price: 5, a: 1 });
    const strict = onV1(node, only(steps, { criticalPaths: ['price'] }), {
      codeSteps,
    });
    expect(strict.root).toBeNull();
    expect(strict.report[0]?.reason).toContain(
      'cannot carry its props as a whole',
    );
    expect(
      onV1(node, only(steps), { codeSteps }).report[0]?.lossyPaths,
    ).toEqual(['']);
  });

  it(
    'projects a screen at the size limits in seconds, whatever it loses',
    { timeout: 60_000 },
    () => {
      const steps: SkewContractDocument['steps'] = [
        {
          from: 1,
          to: 2,
          description: 'badges',
          ops: [
            {
              map: {
                path: 'items',
                ops: [{ default: { path: 'badge', value: null } }],
              },
            },
          ],
        },
        {
          from: 2,
          to: 3,
          description: 'tone',
          ops: [{ default: { path: 'tone', value: 'plain' } }],
        },
      ];
      // 99,990 elements of one field each: just inside `SCREEN_LIMITS.values`, as `parseScreen`
      // confirms, and every one of them loses its badge.
      const node = authored({
        items: Array.from(
          { length: SCREEN_LIMITS.values / 2 - 10 },
          (_, index) => ({ badge: `b${index}` }),
        ),
      });
      const started = Date.now();
      // A thousand critical paths as well: each lost path is checked against all of them.
      const critical = [
        'tone',
        ...Array.from({ length: 1000 }, (_, index) => `c${index}.x`),
      ];
      const refused = onV1(node, only(steps, { criticalPaths: critical }));
      const reported = onV1(node, only(steps));
      const elapsed = Date.now() - started;
      expect(refused.root).toBeNull();
      expect(reported.report[0]?.lossyPaths).toHaveLength(
        SCREEN_LIMITS.values / 2 - 10,
      );
      // About two seconds here. It was a minute when the losses were grouped by copying, and a
      // quarter of one when each lost path was compared with each critical path in turn.
      expect(elapsed).toBeLessThan(8000);
    },
  );
});

describe('the fifth pass: nothing parsed can make a projection throw', () => {
  const steps = (
    ops: NonNullable<SkewContractDocument['steps'][number]['ops']>,
  ): SkewContractDocument['steps'] => [
    {
      from: 1,
      to: 2,
      description: 'extras',
      ops: [{ default: { path: 'note', value: null } }],
    },
    { from: 2, to: 3, description: 'deep', ops },
  ];
  const withSteps = (ops: Parameters<typeof steps>[0]): unknown => ({
    sduiCatalog: '1',
    components: { note: { contract: doc('note', 3, steps(ops)) } },
  });
  const authored = (props: unknown, id = 's'): Screen =>
    parseScreen({
      id,
      slug: 's',
      root: { id: 'n', type: 'note', v: 2, props },
    });

  it('refuses a catalog whose op names a path too long to be one', () => {
    const path = (segments: number) =>
      Array.from({ length: segments }, (_, index) => `a${index}`).join('.');
    const at = (segments: number) =>
      withSteps([{ default: { path: path(segments), value: 1 } }]);
    expect(() => parseCatalog(at(3000))).toThrow(
      `a path of more than ${CATALOG_LIMITS.pathSegments} segments`,
    );
    expect(() => parseCatalog(at(CATALOG_LIMITS.pathSegments + 1))).toThrow(
      'segments',
    );
    expect(() => parseCatalog(at(CATALOG_LIMITS.pathSegments))).not.toThrow();
    // Inside a `map`, and as the `to` of a rename.
    expect(() =>
      parseCatalog(
        withSteps([
          {
            map: {
              path: 'items',
              ops: [{ rename: { from: 'a', to: path(40) } }],
            },
          },
        ]),
      ),
    ).toThrow('segments');
  });

  it('refuses a catalog nested past its limit, without walking it', () => {
    let value: unknown = 1;
    for (let depth = 0; depth < 20_000; depth++) value = { k: value };
    expect(() =>
      parseCatalog(withSteps([{ default: { path: 'deep', value } }])),
    ).toThrow(`more than ${CATALOG_LIMITS.depth} levels deep`);
  });

  it('gives a fallback, not a stack overflow, when steps nest a payload past walking', () => {
    // No path is long and the document is shallow; the depth comes from running 20,000 ops.
    const deep = parseCatalog(
      withSteps(
        Array.from({ length: 20_000 }, () => ({
          wrap: { path: 'p', key: 'k' },
        })),
      ),
    );
    const down = projectScreen(
      authored({ p: 'x', note: 'lost' }),
      deep,
      device({ note: 1 }),
    );
    // The loss could not be traced through the lift, so it is reported under its own name.
    expect(down.report[0]?.lossyPaths).toEqual(['note']);
    const up = projectScreen(authored({ p: 'x' }), deep, device({ note: 3 }));
    expect(up.outcome).toBe('fallback');
    expect(up.report[0]?.reason).toContain(
      `nested more than ${MIGRATED_DEPTH_LIMIT} levels deep`,
    );
    expect(() =>
      diffScreens(authored({ p: 'x' }), authored({ p: 'y' }, 's2'), deep),
    ).not.toThrow();
    expect(() => validateScreen(authored({ p: 'x' }), deep)).not.toThrow();
  });

  it('refuses values that are not JSON, in a screen and in a catalog', () => {
    const screenWith = (value: unknown) => () => authored({ a: value });
    expect(screenWith(BigInt(10))).toThrow(
      'root.props.a is a bigint, which is not JSON',
    );
    expect(screenWith(Symbol('x'))).toThrow('a symbol');
    expect(screenWith(() => 1)).toThrow('a function');
    expect(screenWith(undefined)).toThrow('undefined');
    expect(screenWith(new Date(0))).toThrow('not plain data');
    expect(screenWith(new Map())).toThrow('not plain data');
    // A hole in a list is an `undefined` too.
    expect(screenWith(new Array(3))).toThrow('root.props.a[0] is undefined');
    expect(screenWith(Number.NaN)).toThrow('a number that is not finite');
    expect(() =>
      parseScreen({
        id: 's',
        slug: 's',
        root: {
          id: 'n',
          type: 'note',
          v: 2,
          visibility: { flag: 'f', is: BigInt(10) },
        },
      }),
    ).toThrow('a bigint');
    expect(screenWith(Object.create(null))).not.toThrow();
    expect(screenWith([1, 'two', null, true, { three: 3 }])).not.toThrow();

    expect(() =>
      parseCatalog(withSteps([{ default: { path: 'n', value: BigInt(10) } }])),
    ).toThrow('is a bigint, which is not JSON');
  });

  it('refuses a reserved key anywhere in a catalog, not only where a name is', () => {
    const reserved = JSON.parse('{"__proto__": 1}') as unknown;
    expect(() =>
      parseCatalog(withSteps([{ default: { path: 'n', value: reserved } }])),
    ).toThrow('uses the reserved key "__proto__"');
    const editor = withSteps([]) as {
      components: { note: Record<string, unknown> };
    };
    editor.components.note['editor'] = { label: 'Note', constructor: 'x' };
    expect(() => parseCatalog(editor)).toThrow(
      'catalog.components.note.editor uses the reserved key "constructor"',
    );
  });
});

describe('review of the fifth pass: size, not only depth', () => {
  const noteWith = (
    steps: SkewContractDocument['steps'],
    extra: object = {},
  ): SduiCatalog =>
    parseCatalog({
      sduiCatalog: '1',
      components: {
        note: { contract: doc('note', steps.length + 1, steps), ...extra },
      },
    });
  const note = (v: number, props: unknown, id = 's'): Screen =>
    parseScreen({ id, slug: 's', root: { id: 'n', type: 'note', v, props } });

  it('fails a node, quickly, when steps copy a value into itself until it cannot be written out', () => {
    // Each op puts what `a` holds under two keys of a new `a`. Sixty of them are a value with
    // 2^60 paths through it, in about a hundred objects.
    const doubling = noteWith([
      {
        from: 1,
        to: 2,
        description: 'double, sixty times',
        ops: Array.from({ length: 60 }, () => ({
          wrap: { path: 'a', key: 'l', also: { r: { $from: 'a' } } },
        })),
      },
    ]);
    const started = Date.now();
    const result = projectScreen(
      note(1, { a: 'x' }),
      doubling,
      device({ note: 2 }),
    );
    expect(result.outcome).toBe('fallback');
    expect(result.report[0]?.reason).toMatch(
      /nested more than 64 levels deep|of more than 400000 values/,
    );
    expect(() =>
      diffScreens(note(1, { a: 'x' }), note(1, { a: 'y' }, 's2'), doubling),
    ).not.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('holds the value limit exactly, counting a shared object once per place it appears', () => {
    const contract = doc('note', 2, [
      { from: 1, to: 2, description: 'rows', code: 'rows' },
    ]);
    // { rows: [ [0], [0], … ] } is 2 + 2 × count values written out; the row is one object.
    const rows = (count: number) => ({
      rows: {
        up: () => ({
          rows: Array.from({ length: count }, () => 0).map(() => ROW),
        }),
      },
    });
    const ROW = [0];
    expect(MIGRATED_VALUE_LIMIT).toBe(400_000);
    expect(migrate(contract, {}, 1, 2, { codeSteps: rows(199_999) }).ok).toBe(
      true,
    );
    const over = migrate(contract, {}, 1, 2, { codeSteps: rows(200_000) });
    expect(over).toMatchObject({ ok: false, reason: 'threw' });
    expect(over.ok ? '' : over.message).toContain('more than 400000 values');
    // And one value over, not two: the same 400,000 with one more scalar beside the rows.
    const oneOver = migrate(contract, {}, 1, 2, {
      codeSteps: {
        rows: {
          up: () => ({ ...rows(199_999).rows.up(), one: 0 }),
        },
      },
    });
    expect(oneOver.ok).toBe(false);
  });

  it('pins the limits themselves, which the docs quote', () => {
    expect(MIGRATED_DEPTH_LIMIT).toBe(64);
    expect(TRACE_BUDGET).toBe(2_000_000);
    expect(CATALOG_LIMITS).toEqual({
      depth: 64,
      values: 1_000_000,
      characters: 8_000_000,
      pathSegments: 32,
    });
    expect(MIGRATED_CHARACTER_LIMIT).toBe(8_000_000);
    expect(MIGRATION_ALLOWANCE).toEqual({
      values: 8_000_000,
      characters: 32_000_000,
    });
    expect(SCREEN_LIMITS.characters).toBe(4_000_000);
  });

  it('measures a shared object once, and still sees it where it sits too deep', () => {
    let looked = 0;
    const shared = {
      get counted() {
        looked++;
        return 1;
      },
    };
    const limits = { depth: 64, values: 1_000_000 };
    expect(
      outgrows(
        Array.from({ length: 1000 }, () => shared),
        limits,
      ),
    ).toBeNull();
    expect(looked).toBe(1);

    // Ten levels of its own, met first near the top and then again sixty levels down.
    const nest = (value: unknown, levels: number): unknown => {
      let nested = value;
      for (let level = 0; level < levels; level++) nested = [nested];
      return nested;
    };
    const ten = nest(0, 10);
    expect(outgrows({ a: ten, b: nest(ten, 50) }, limits)).toBeNull();
    expect(outgrows({ a: ten, b: nest(ten, 60) }, limits)).toBe('depth');
    // Exactly at the limit, and one past it: the root, 53 or 54 wrappers, and its own ten.
    expect(outgrows({ a: ten, b: nest(ten, 53) }, limits)).toBeNull();
    expect(outgrows({ a: ten, b: nest(ten, 54) }, limits)).toBe('depth');
    const loop: unknown[] = [];
    loop.push(loop);
    expect(outgrows(loop, limits)).toBe('depth');
  });

  it('holds the depth limit exactly', () => {
    const wraps = (count: number) =>
      doc('note', 2, [
        {
          from: 1,
          to: 2,
          description: 'wrap',
          ops: Array.from({ length: count }, () => ({
            wrap: { path: 'p', key: 'k' },
          })),
        },
      ]);
    // { p: 'x' } is one level; each wrap adds one.
    expect(migrate(wraps(MIGRATED_DEPTH_LIMIT - 1), { p: 'x' }, 1, 2).ok).toBe(
      true,
    );
    const over = migrate(wraps(MIGRATED_DEPTH_LIMIT), { p: 'x' }, 1, 2);
    expect(over.ok ? '' : over.message).toContain(
      `nested more than ${MIGRATED_DEPTH_LIMIT} levels deep`,
    );
  });

  it('holds the catalog limits exactly: depth, values, and `from` as well as `path` and `to`', () => {
    const depthOf = (value: unknown): number =>
      typeof value !== 'object' || value === null
        ? 0
        : 1 + Math.max(0, ...Object.values(value).map(depthOf));
    const withDefault = (value: unknown): unknown => ({
      sduiCatalog: '1',
      components: {
        note: {
          contract: doc('note', 2, [
            {
              from: 1,
              to: 2,
              description: 'd',
              ops: [{ default: { path: 'd', value } }],
            },
          ]),
        },
      },
    });
    const nested = (levels: number): unknown => {
      let value: unknown = 1;
      for (let level = 0; level < levels; level++) value = [value];
      return value;
    };
    const base = depthOf(withDefault(1));
    const atLimit = withDefault(nested(CATALOG_LIMITS.depth - base));
    expect(depthOf(atLimit)).toBe(CATALOG_LIMITS.depth);
    expect(() => parseCatalog(atLimit)).not.toThrow();
    expect(() =>
      parseCatalog(withDefault(nested(CATALOG_LIMITS.depth - base + 1))),
    ).toThrow(`more than ${CATALOG_LIMITS.depth} levels deep`);

    // A thousand references to one row of a thousand: small in memory, a million values written
    // out, and refused without being walked a million times.
    const row = Array.from({ length: 1000 }, () => 0);
    expect(() =>
      parseCatalog(withDefault(Array.from({ length: 1000 }, () => row))),
    ).toThrow(`more than ${CATALOG_LIMITS.values} values`);

    const long = Array.from({ length: 40 }, (_, index) => `a${index}`).join(
      '.',
    );
    expect(() =>
      parseCatalog({
        sduiCatalog: '1',
        components: {
          note: {
            contract: doc('note', 2, [
              {
                from: 1,
                to: 2,
                description: 'r',
                ops: [{ rename: { from: long, to: 'b' } }],
              },
            ]),
          },
        },
      }),
    ).toThrow('segments');
  });

  it('limits a path an op reads with `$from` like any other it names', () => {
    const long = `/${Array.from({ length: 40 }, (_, index) => `a${index}`).join('/')}`;
    const reading = (from: string) => () =>
      noteWith([
        {
          from: 1,
          to: 2,
          description: 'w',
          ops: [
            { wrap: { path: 'p', key: 'k', also: { copy: { $from: from } } } },
          ],
        },
      ]);
    expect(reading(long)).toThrow('segments');
    expect(reading('/a/b')).not.toThrow();
  });

  it('says which kind of refusal it is: a critical field lost, or a loss it could not place', () => {
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'price and note',
        ops: [
          { default: { path: 'price', value: null } },
          { default: { path: 'note', value: null } },
        ],
      },
      {
        from: 2,
        to: 3,
        description: 'no notes',
        ops: [{ drop: { path: 'note' } }],
      },
    ];
    const strict = noteWith(steps, { criticalPaths: ['price'] });
    const on = device({ note: 1 });
    expect(
      projectScreen(note(2, { price: 5 }), strict, on).report[0]?.reason,
    ).toContain('cannot carry "price", which must not be lost');
    // `note` is not critical, but v3 has no place for it, so nothing shows where it went.
    expect(
      projectScreen(note(2, { note: 'n' }), strict, on).report[0]?.reason,
    ).toContain(
      'cannot carry "note", and what was lost could not be traced to show that nothing critical went with it',
    );
  });

  it('answers "is this within a critical path" the same from a prepared list as one by one', () => {
    const paths = [
      'price',
      'price.sale',
      'items[].badge',
      'a.b.c',
      'slots.media',
      'x',
    ];
    const asked = [
      'price',
      'price.sale.amount',
      'pric',
      'prices',
      'items[3].badge',
      'items[3]',
      'items',
      'items[0].title',
      'a',
      'a.b',
      'a.b.c.d',
      'a.c',
      'slots.media',
      'slots',
      'x[2]',
      'y',
      '',
    ];
    for (const subset of [paths, paths.slice(1, 3), ['a.b.c'], []]) {
      const prepared = withinAny(subset);
      for (const path of asked)
        expect([path, prepared(path)]).toEqual([
          path,
          subset.some((prefix) => {
            const a = path.replace(/\[\d*\]/g, '');
            const b = prefix.replace(/\[\d*\]/g, '');
            return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
          }),
        ]);
    }
  });

  it('refuses a list with a hole where a node or a condition should be', () => {
    const stack = {
      id: 's',
      slug: 's',
      root: {
        id: 'r',
        type: 'stack',
        v: 1,
        slots: { children: new Array(1) as unknown[] },
      },
    };
    expect(() => parseScreen(stack)).toThrow(
      'root.slots.children[0] must be an object',
    );
    expect(() =>
      parseScreen({
        id: 's',
        slug: 's',
        root: {
          id: 'r',
          type: 'stack',
          v: 1,
          visibility: { all: new Array(2) as unknown[] },
        },
      }),
    ).toThrow('root.visibility.all[0] must be an object');
  });

  it('refuses a catalog that is not data in its own words, before reading any of it', () => {
    const holes = {
      sduiCatalog: '1',
      components: {
        note: {
          contract: {
            ...doc('note', 2, []),
            steps: new Array(1) as unknown[],
          },
        },
      },
    };
    expect(() => parseCatalog(holes)).toThrow(
      'sdui catalog: catalog.components.note.contract.steps[0] is undefined',
    );
    expect(() =>
      parseCatalog({ sduiCatalog: Object.create(null), components: {} }),
    ).toThrow('sdui catalog: unsupported catalog format (not a string)');
    expect(() => parseCatalog({ sduiCatalog: '2', components: {} })).toThrow(
      'sdui catalog: unsupported catalog format "2"',
    );
  });

  it('refuses an array that carries anything besides its elements', () => {
    // Defined, not assigned: assigning `__proto__` would set the prototype and leave no key.
    const smuggling = (extra: object): unknown[] =>
      Object.defineProperties(
        [1, 2] as unknown[],
        Object.getOwnPropertyDescriptors(extra),
      );
    expect(() => note(1, { list: smuggling({ f: () => 1 }) })).toThrow(
      'root.props.list is an array with properties besides its elements',
    );
    expect(() =>
      noteWith([
        {
          from: 1,
          to: 2,
          description: 'd',
          ops: [
            {
              default: {
                path: 'd',
                value: smuggling(JSON.parse('{"__proto__": 1}') as object),
              },
            },
          ],
        },
      ]),
    ).toThrow('an array with properties besides its elements');
    expect(() => note(1, { list: [1, 2] })).not.toThrow();
  });
});

describe('the seventh pass: what migrations may produce, in all', () => {
  const doubling = (wraps: number): SkewContractDocument['steps'] => [
    {
      from: 1,
      to: 2,
      description: 'copy p into itself',
      ops: Array.from({ length: wraps }, () => ({
        wrap: { path: 'p', key: 'k', also: { r: { $from: '/p' } } },
      })),
    },
  ];
  const cards = (wraps: number): SduiCatalog =>
    parseCatalog({
      sduiCatalog: '1',
      components: {
        card: { contract: doc('card', 2, doubling(wraps)) },
        stack: { contract: doc('stack', 1, []), slots: { children: {} } },
      },
    });
  const card = (id: string, p: string) => ({
    id,
    type: 'card',
    v: 1,
    props: { p },
  });

  it('counts characters: one long string copied thirteen times over is not a payload', () => {
    // 8,192 places for one 100,000-character string: sixteen thousand values, and 800 MB.
    const catalog = cards(13);
    const long = 'x'.repeat(100_000);
    const screen = (id: string, p: string): Screen =>
      parseScreen({
        id,
        slug: 's',
        root: { id: 'root', type: 'stack', v: 1 },
        states: { empty: card('e', p) },
      });
    const on = device({ card: 2, stack: 1 });
    const projected = projectScreen(screen('s', long), catalog, on);
    expect(reportOf(projected, 'e')[0]?.reason).toContain(
      `more than ${MIGRATED_CHARACTER_LIMIT} characters`,
    );
    expect(() => JSON.stringify(projected)).not.toThrow();
    expect(() =>
      diffScreens(
        screen('s', long),
        screen('s2', `${long.slice(1)}!`),
        catalog,
      ),
    ).not.toThrow();
    // Two keys of one character, and the string in three places.
    const thrice = { a: [long, long], b: long };
    expect(
      measure(thrice, { depth: 8, values: 100, characters: 300_002 }),
    ).toEqual({ values: 5, characters: 300_002 });
    expect(
      measure(thrice, { depth: 8, values: 100, characters: 300_001 }),
    ).toBe('characters');
  });

  it('shares one allowance across a projection, and across a diff', () => {
    // Each card comes to 2^17 values twice over — inside the limit for one payload. Sixty of them
    // are sixteen million values; the allowance is eight.
    const catalog = cards(17);
    const screen = (id: string, tag: string): Screen =>
      parseScreen({
        id,
        slug: 's',
        root: {
          id: 'root',
          type: 'stack',
          v: 1,
          slots: {
            children: Array.from({ length: 60 }, (_, index) =>
              card(`n${index}`, tag),
            ),
          },
        },
      });
    const result = projectScreen(
      screen('s', 'a'),
      catalog,
      device({ card: 2, stack: 1 }),
    );
    expect(reportOf(result, 'n0')[0]?.outcome).toBe('upgraded');
    expect(reportOf(result, 'n59')[0]).toMatchObject({ outcome: 'omitted' });
    expect(reportOf(result, 'n59')[0]?.reason).toContain(
      'the migrations of this call have produced all they may',
    );
    const rendered = result.report.filter(
      (entry) => entry.outcome === 'upgraded',
    ).length;
    // 262,143 values a card: thirty fit in eight million, and the thirty-first overdraws it.
    expect(rendered).toBe(31);
    expect(() =>
      diffScreens(screen('s', 'a'), screen('s2', 'b'), catalog),
    ).not.toThrow();

    // A migration on its own has no allowance unless it is given one; given one, it draws on it.
    const allowance = { values: 10, characters: 1000 };
    const small = doc('card', 2, doubling(1));
    expect(migrate(small, { p: 'x' }, 1, 2, { allowance }).ok).toBe(true);
    // { p: { k: 'x', r: 'x' } } is four values, and five characters of keys and strings.
    expect(allowance).toEqual({ values: 6, characters: 995 });
    expect(migrate(small, { p: 'x' }, 1, 2, { allowance }).ok).toBe(true);
    // Two left: the next one still runs, and overdraws; the one after finds nothing.
    expect(migrate(small, { p: 'x' }, 1, 2, { allowance }).ok).toBe(true);
    expect(allowance.values).toBe(-2);
    const spent = migrate(small, { p: 'x' }, 1, 2, { allowance });
    expect(spent.ok ? '' : spent.message).toContain(
      'have produced all they may',
    );
    expect(migrate(small, { p: 'x' }, 1, 2).ok).toBe(true);
  });

  it('holds the character limits exactly: screen, catalog and migrated payload', () => {
    const hundredK = 'x'.repeat(100_000);
    const screenOf = (last: string) => () =>
      parseScreen({
        id: 's',
        slug: 's',
        root: {
          id: 'n',
          type: 'card',
          v: 1,
          // One character of key, then forty strings.
          props: { a: [...Array.from({ length: 39 }, () => hundredK), last] },
        },
      });
    expect(screenOf(hundredK.slice(1))).not.toThrow();
    expect(screenOf(hundredK)).toThrow(
      `come to more than ${SCREEN_LIMITS.characters} characters`,
    );

    const charactersIn = (value: unknown): number =>
      typeof value === 'string'
        ? value.length
        : typeof value !== 'object' || value === null
          ? 0
          : Array.isArray(value)
            ? value.reduce<number>((sum, inner) => sum + charactersIn(inner), 0)
            : Object.entries(value).reduce(
                (sum, [key, inner]) => sum + key.length + charactersIn(inner),
                0,
              );
    const valuesIn = (value: unknown): number =>
      typeof value !== 'object' || value === null
        ? 1
        : 1 +
          Object.values(value).reduce<number>(
            (sum, inner) => sum + valuesIn(inner),
            0,
          );
    const catalogWith = (value: unknown): unknown => ({
      sduiCatalog: '1',
      components: {
        card: {
          contract: doc('card', 2, [
            {
              from: 1,
              to: 2,
              description: 'd',
              ops: [{ default: { path: 'd', value } }],
            },
          ]),
        },
      },
    });
    const baseCharacters = charactersIn(catalogWith(''));
    const text = (length: number): string[] => {
      const strings: string[] = [];
      for (let left = length; left > 0; left -= 100_000)
        strings.push('x'.repeat(Math.min(left, 100_000)));
      return strings;
    };
    const fullText = catalogWith(
      text(CATALOG_LIMITS.characters - baseCharacters),
    );
    expect(charactersIn(fullText)).toBe(CATALOG_LIMITS.characters);
    expect(() => parseCatalog(fullText)).not.toThrow();
    expect(() =>
      parseCatalog(
        catalogWith(text(CATALOG_LIMITS.characters - baseCharacters + 1)),
      ),
    ).toThrow(`more than ${CATALOG_LIMITS.characters} characters`);

    const baseValues = valuesIn(catalogWith([]));
    const numbers = (count: number) => Array.from({ length: count }, () => 0);
    const fullValues = catalogWith(numbers(CATALOG_LIMITS.values - baseValues));
    expect(valuesIn(fullValues)).toBe(CATALOG_LIMITS.values);
    expect(() => parseCatalog(fullValues)).not.toThrow();
    expect(() =>
      parseCatalog(
        catalogWith(numbers(CATALOG_LIMITS.values - baseValues + 1)),
      ),
    ).toThrow(`more than ${CATALOG_LIMITS.values} values`);

    const stretch = doc('card', 2, [
      { from: 1, to: 2, description: 's', code: 'stretch' },
    ]);
    const stretched = (length: number) =>
      migrate(stretch, {}, 1, 2, {
        codeSteps: { stretch: { up: () => ({ s: 'x'.repeat(length) }) } },
      });
    // One character of key.
    expect(stretched(MIGRATED_CHARACTER_LIMIT - 1).ok).toBe(true);
    expect(stretched(MIGRATED_CHARACTER_LIMIT).ok).toBe(false);
  });

  it('counts every separator in a path, and limits what a fallback reads', () => {
    const withPath = (path: string) => () =>
      parseCatalog({
        sduiCatalog: '1',
        components: {
          card: {
            contract: doc('card', 2, [
              {
                from: 1,
                to: 2,
                description: 'd',
                ops: [{ default: { path, value: 1 } }],
              },
            ]),
          },
        },
      });
    expect(withPath(`${'.'.repeat(1000)}x`)).toThrow('segments');
    const segments = (count: number) =>
      Array.from({ length: count }, (_, index) => `a${index}`);
    const reading = (from: string) => () =>
      parseCatalog({
        sduiCatalog: '1',
        components: {
          card: {
            contract: doc('card', 1, []),
            fallback: { type: 'text', props: { t: { $from: from } } },
          },
          text: { contract: doc('text', 1, []) },
        },
      });
    expect(
      reading(segments(CATALOG_LIMITS.pathSegments).join('.')),
    ).not.toThrow();
    expect(
      reading(segments(CATALOG_LIMITS.pathSegments + 1).join('.')),
    ).toThrow(
      `reads a path of more than ${CATALOG_LIMITS.pathSegments} segments`,
    );
    // A pointer's leading "/" is not a segment.
    const copying = (from: string) => () =>
      parseCatalog({
        sduiCatalog: '1',
        components: {
          card: {
            contract: doc('card', 2, [
              {
                from: 1,
                to: 2,
                description: 'w',
                ops: [
                  {
                    wrap: { path: 'p', key: 'k', also: { c: { $from: from } } },
                  },
                ],
              },
            ]),
          },
        },
      });
    expect(
      copying(`/${segments(CATALOG_LIMITS.pathSegments).join('/')}`),
    ).not.toThrow();
    expect(
      copying(`/${segments(CATALOG_LIMITS.pathSegments + 1).join('/')}`),
    ).toThrow('segments');
  });

  it('past the budget, reports a loss both where it landed and under the name it was authored with', () => {
    const steps: SkewContractDocument['steps'] = [
      {
        from: 1,
        to: 2,
        description: 'badges',
        ops: [
          {
            map: {
              path: 'items',
              ops: [{ default: { path: 'badge', value: null } }],
            },
          },
        ],
      },
      {
        from: 2,
        to: 3,
        description: 'badges are tags now',
        ops: [
          {
            map: {
              path: 'items',
              ops: [{ rename: { from: 'badge', to: 'tag' } }],
            },
          },
        ],
      },
    ];
    const catalog = parseCatalog({
      sduiCatalog: '1',
      components: { note: { contract: doc('note', 3, steps) } },
    });
    const list = (length: number): Screen =>
      parseScreen({
        id: 's',
        slug: 's',
        root: {
          id: 'n',
          type: 'note',
          v: 2,
          props: {
            items: Array.from({ length }, (_, index) => ({
              badge: `b${index}`,
            })),
          },
        },
      });
    const on = device({ note: 1 });
    // Within the budget each loss is traced, and reported where it landed.
    expect(projectScreen(list(3), catalog, on).report[0]?.lossyPaths).toEqual([
      'items[0].tag',
      'items[1].tag',
      'items[2].tag',
    ]);
    const past = projectScreen(list(2000), catalog, on).report[0]?.lossyPaths;
    expect(past).toHaveLength(4000);
    expect(past).toContain('items[0].tag');
    expect(past).toContain('items[0].badge');
  });
});
