import type { SkewContractDocument } from '@braidlabs/contract';
import {
  type ClientManifest,
  type Screen,
  type SduiCatalog,
  PLACEHOLDER_TYPE,
  applyVisibility,
  parseCatalog,
  projectScreen,
} from '../index.js';
import { catalog, manifest, screen } from './fixtures.spec-util.js';

const reportOf = (result: ReturnType<typeof projectScreen>, id: string) =>
  result.report.find((entry) => entry.nodeId === id);
const childOf = (result: ReturnType<typeof projectScreen>, id: string) =>
  result.root?.slots?.['children']?.find((child) => child.id === id);

describe('projectScreen: one authored screen, three app versions', () => {
  it('renders every node exactly on the app the screen was authored for', () => {
    const result = projectScreen(
      screen('home'),
      catalog(),
      manifest('current'),
    );
    expect(result.outcome).toBe('exact');
    expect(
      result.report.every(
        (entry) => entry.outcome === 'exact' && entry.lossyPaths.length === 0,
      ),
    ).toBe(true);
    expect(childOf(result, 'n_card_runner')?.props).toEqual(
      screen('home').root.slots?.['children']?.[1]?.props,
    );
  });

  it('downgrades for an older app and names exactly what was lost', () => {
    const result = projectScreen(
      screen('home'),
      catalog(),
      manifest('one-behind'),
    );
    expect(reportOf(result, 'n_hero')).toMatchObject({
      outcome: 'downgraded',
      rendered: 2,
      lossyPaths: ['countdown'],
    });
    expect(reportOf(result, 'n_card_runner')).toMatchObject({
      outcome: 'downgraded',
      rendered: 2,
      lossyPaths: ['badge'],
    });
    // The projected node has the older shape and nothing the older app does not know.
    expect(childOf(result, 'n_card_runner')).toMatchObject({
      v: 2,
      props: { title: 'Trail Runner 2', price: { amount: 129, sale: 99 } },
    });
    expect(childOf(result, 'n_card_runner')?.props).not.toHaveProperty('badge');
  });

  it('does not call a field lost when it was still at its default', () => {
    const result = projectScreen(
      screen('home'),
      catalog(),
      manifest('one-behind'),
    );
    // Ridge Shell has no badge and no sale price: v2 carries everything it says.
    expect(reportOf(result, 'n_card_shell')).toMatchObject({
      outcome: 'downgraded',
      lossyPaths: [],
    });
  });

  it('takes the authored fallback when a critical field would be lost — never a card with the wrong price', () => {
    const result = projectScreen(screen('home'), catalog(), manifest('legacy'));
    expect(reportOf(result, 'n_card_runner')).toMatchObject({
      outcome: 'fallback-authored',
      rung: 3,
      replacedBy: { id: 'n_card_runner_fallback', type: 'text' },
    });
    expect(reportOf(result, 'n_card_runner')?.reason).toContain('price.sale');
    expect(childOf(result, 'n_card_runner')).toBeUndefined();
    expect(childOf(result, 'n_card_runner_fallback')).toEqual({
      id: 'n_card_runner_fallback',
      type: 'text',
      v: 1,
      props: { text: 'Trail Runner 2, now $99' },
    });
    // The other card loses nothing critical, so it renders as itself at v1.
    expect(childOf(result, 'n_card_shell')).toEqual({
      id: 'n_card_shell',
      type: 'product-card',
      v: 1,
      props: { title: 'Ridge Shell', price: 168 },
    });
  });

  it('takes a fallback when a step cannot be inverted — the gap is not guessed across', () => {
    const result = projectScreen(screen('home'), catalog(), manifest('legacy'));
    const entry = reportOf(result, 'n_legal');
    expect(entry).toMatchObject({
      outcome: 'fallback-catalog',
      rung: 4,
      replacedBy: { type: 'text' },
    });
    expect(entry?.reason).toContain('cannot be inverted');
    expect(childOf(result, 'n_legal')).toEqual({
      id: 'n_legal',
      type: 'text',
      v: 1,
      props: { text: 'Prices include tax.' },
    });
    expect(JSON.stringify(result.root)).not.toContain('legacyFlag');
  });

  it('never emits a component or version the manifest did not declare', () => {
    for (const name of ['current', 'one-behind', 'legacy'] as const) {
      const device = manifest(name);
      const result = projectScreen(screen('home'), catalog(), device);
      const visit = (node: NonNullable<typeof result.root>): void => {
        expect(device.components[node.type]).toBe(node.v);
        for (const action of Object.values(node.actions ?? {}))
          expect(device.actions?.[action.type]).toBe(action.v);
        for (const children of Object.values(node.slots ?? {}))
          children.forEach(visit);
      };
      visit(result.root as NonNullable<typeof result.root>);
    }
  });

  it('is deterministic and leaves its inputs untouched', () => {
    const authored = screen('home');
    const before = JSON.stringify(authored);
    const first = projectScreen(authored, catalog(), manifest('legacy'));
    const second = projectScreen(authored, catalog(), manifest('legacy'));
    expect(second).toEqual(first);
    expect(JSON.stringify(authored)).toBe(before);
  });
});

describe('projectScreen: actions', () => {
  it('disables a control whose action the app lacks, and says why', () => {
    const result = projectScreen(
      screen('home'),
      catalog(),
      manifest('one-behind'),
    );
    expect(childOf(result, 'n_share')).toMatchObject({ disabled: true });
    expect(childOf(result, 'n_share')).not.toHaveProperty('actions');
    expect(reportOf(result, 'n_share')?.actions?.[0]).toMatchObject({
      outcome: 'disabled',
      reason: 'this app version has no "share" action',
    });
    expect(result.outcome).not.toBe('exact');
  });

  it('downgrades an action through its own contract', () => {
    const result = projectScreen(
      screen('home'),
      catalog(),
      manifest('one-behind'),
    );
    expect(childOf(result, 'n_hero')?.actions?.['press']).toEqual({
      type: 'navigate',
      v: 1,
      props: { to: 'sale' },
    });
    expect(reportOf(result, 'n_hero')?.actions?.[0]).toMatchObject({
      outcome: 'downgraded',
      lossyPaths: ['transition'],
    });
  });

  const withShare = (action: object): Screen => ({
    id: 's',
    slug: 's',
    root: {
      id: 'n',
      type: 'text',
      v: 2,
      props: { content: 'Share' },
      actions: {
        press: { type: 'share', v: 1, props: { text: 'hi' }, ...action },
      },
    },
  });

  it('uses an action fallback before giving up on the control', () => {
    const result = projectScreen(
      withShare({
        fallback: {
          type: 'open-url',
          v: 1,
          props: { url: 'https://acme.example/share' },
        },
      }),
      catalog(),
      manifest('legacy'),
    );
    expect(result.root?.actions?.['press']).toEqual({
      type: 'open-url',
      v: 1,
      props: { url: 'https://acme.example/share' },
    });
    expect(result.root).not.toHaveProperty('disabled');
    expect(result.report[0]?.actions?.[0]).toMatchObject({
      outcome: 'fallback',
      type: 'open-url',
    });
  });

  it('removes the node when the action is set to hide', () => {
    const result = projectScreen(
      withShare({ unsupported: 'hide' }),
      catalog(),
      manifest('legacy'),
    );
    expect(result.root).toBeNull();
    expect(result.report[0]).toMatchObject({ outcome: 'omitted', rung: 5 });
    expect(result.outcome).toBe('fallback');
  });
});

describe('projectScreen: the rest of the ladder', () => {
  const one = (node: object): Screen => ({
    id: 's',
    slug: 's',
    root: {
      id: 'n_root',
      type: 'stack',
      v: 1,
      slots: { children: [node as never] },
    },
  });
  const without = (device: ClientManifest, type: string): ClientManifest => {
    const components = { ...device.components };
    delete components[type];
    return { ...device, components };
  };
  const video = {
    id: 'n_video',
    type: 'video-tile',
    v: 1,
    props: { title: 'Boots', src: 'a' },
  };

  it('omits an optional node with no fallback', () => {
    const result = projectScreen(one(video), catalog(), manifest('one-behind'));
    expect(result.outcome).toBe('fallback');
    expect(result.root?.slots?.['children']).toEqual([]);
    expect(reportOf(result, 'n_video')).toMatchObject({
      outcome: 'omitted',
      rung: 5,
    });
    expect(reportOf(result, 'n_video')).not.toHaveProperty('blocking');
  });

  it('blocks the screen when a required node has nowhere to fall', () => {
    const result = projectScreen(
      screen('watch'),
      catalog(),
      manifest('one-behind'),
    );
    expect(result).toMatchObject({
      outcome: 'blocked',
      root: null,
      blockedBy: ['n_player'],
    });
    expect(reportOf(result, 'n_player')).toMatchObject({
      outcome: 'omitted',
      blocking: true,
    });
  });

  it('does not block when a required node has a fallback that renders', () => {
    const result = projectScreen(
      one({
        ...video,
        required: true,
        fallback: {
          id: 'n_fb',
          type: 'text',
          v: 2,
          props: { content: 'Watch on the web' },
        },
      }),
      catalog(),
      manifest('one-behind'),
    );
    expect(result.outcome).toBe('fallback');
    expect(result.blockedBy).toEqual([]);
    expect(childOf(result, 'n_fb')).toBeDefined();
  });

  it('follows a chain of authored fallbacks to the first one that renders', () => {
    const chained = {
      ...video,
      fallback: {
        id: 'n_fb1',
        type: 'video-tile',
        v: 1,
        props: { title: 'Also video', src: 'b' },
        fallback: {
          id: 'n_fb2',
          type: 'text',
          v: 2,
          props: { content: 'Text at last' },
        },
      },
    };
    const result = projectScreen(
      one(chained),
      catalog(),
      manifest('one-behind'),
    );
    expect(result.root?.slots?.['children']?.map((child) => child.id)).toEqual([
      'n_fb2',
    ]);
    expect(result.report.map((entry) => [entry.nodeId, entry.outcome])).toEqual(
      [
        ['n_root', 'exact'],
        ['n_video', 'fallback-authored'],
        ['n_fb1', 'fallback-authored'],
        ['n_fb2', 'exact'],
      ],
    );
  });

  const withFallback = (fallback: unknown): SduiCatalog => {
    const base = catalog();
    return parseCatalog({
      ...base,
      components: {
        ...base.components,
        'video-tile': { ...base.components['video-tile'], fallback },
      },
    });
  };

  it('draws the protocol placeholder when the catalog asks for one', () => {
    const result = projectScreen(
      one(video),
      withFallback('placeholder'),
      manifest('one-behind'),
    );
    expect(childOf(result, 'n_video')).toEqual({
      id: 'n_video',
      type: PLACEHOLDER_TYPE,
      v: 1,
    });
    expect(reportOf(result, 'n_video')).toMatchObject({
      outcome: 'fallback-catalog',
      rung: 4,
    });
  });

  it('treats a fail-screen component as required', () => {
    const result = projectScreen(
      one(video),
      withFallback('fail-screen'),
      manifest('one-behind'),
    );
    expect(result).toMatchObject({
      outcome: 'blocked',
      blockedBy: ['n_video'],
    });
  });

  it('builds a catalog stand-in from the node, and gives up cleanly when the app lacks that too', () => {
    const standIn = withFallback({
      type: 'text',
      props: { content: { $from: 'title' }, style: 'link' },
    });
    expect(
      childOf(
        projectScreen(one(video), standIn, manifest('legacy')),
        'n_video',
      ),
    ).toEqual({ id: 'n_video', type: 'text', v: 1, props: { text: 'Boots' } });
    const result = projectScreen(
      one(video),
      standIn,
      without(manifest('one-behind'), 'text'),
    );
    expect(reportOf(result, 'n_video')).toMatchObject({
      outcome: 'omitted',
      rung: 5,
    });
  });

  it('applies the kill switch with no change to the manifest or the screen', () => {
    const live = projectScreen(screen('home'), catalog(), manifest('current'));
    const killed = projectScreen(
      screen('home'),
      catalog(),
      manifest('current'),
      { unsupported: ['video-tile'] },
    );
    expect(childOf(live, 'n_video')?.type).toBe('video-tile');
    expect(childOf(killed, 'n_video')).toBeUndefined();
    expect(childOf(killed, 'n_video_fallback')?.type).toBe('text');
    expect(reportOf(killed, 'n_video')?.reason).toContain('switched off');
  });

  it('never lets an unrenderable authored state block the screen', () => {
    const authored: Screen = {
      ...screen('home'),
      states: {
        empty: {
          id: 'n_empty',
          type: 'video-tile',
          v: 1,
          required: true,
          props: { title: 'x', src: 'y' },
        },
      },
    };
    const result = projectScreen(authored, catalog(), manifest('one-behind'));
    expect(result.outcome).not.toBe('blocked');
    expect(result.states).toBeUndefined();
  });
});

describe('projectScreen: versions in every direction', () => {
  const doc = (
    current: number,
    steps: SkewContractDocument['steps'],
  ): SkewContractDocument => ({
    skewContract: '1',
    name: 'sdui.component.note',
    current,
    steps,
  });
  const only = (
    contract: SkewContractDocument,
    extra: object = {},
  ): SduiCatalog =>
    parseCatalog({
      sduiCatalog: '1',
      components: { note: { contract, ...extra } },
    });
  const device = (version: number): ClientManifest => ({
    sduiManifest: '1',
    protocol: [1, 1],
    app: 'a',
    platform: 'ios',
    version: '1.0',
    components: { note: version },
  });
  const authored = (v: number, props: object, slots?: object): Screen => ({
    id: 's',
    slug: 's',
    root: {
      id: 'n',
      type: 'note',
      v,
      props,
      ...(slots ? { slots } : {}),
    } as never,
  });

  const twoSteps = doc(3, [
    {
      from: 1,
      to: 2,
      description: 'rename',
      ops: [{ rename: { from: 'body', to: 'text' } }],
    },
    {
      from: 2,
      to: 3,
      description: 'tone',
      ops: [{ default: { path: 'tone', value: 'plain' } }],
    },
  ]);

  it('upgrades content authored before the app was built, and marks what it filled in', () => {
    const result = projectScreen(
      authored(1, { body: 'hello' }),
      only(twoSteps),
      device(3),
    );
    expect(result.root).toEqual({
      id: 'n',
      type: 'note',
      v: 3,
      props: { text: 'hello', tone: 'plain' },
    });
    expect(result.report[0]).toMatchObject({
      outcome: 'upgraded',
      rung: 2,
      derivedPaths: ['tone'],
      lossyPaths: [],
    });
    expect(result.outcome).toBe('exact');
  });

  it('cannot render for an app that is ahead of the catalog', () => {
    const result = projectScreen(
      authored(3, { text: 'hello', tone: 'plain' }),
      only(twoSteps),
      device(4),
    );
    expect(result.report[0]).toMatchObject({ outcome: 'omitted' });
    expect(result.report[0]?.reason).toContain('newer than the catalog');
  });

  it('treats a code step with no implementation as a gap, and runs one that is supplied', () => {
    const coded = only(
      doc(2, [
        { from: 1, to: 2, description: 'split the name', code: 'split-name' },
      ]),
    );
    const screenAt2 = authored(2, { first: 'Ada', last: 'Lovelace' });
    expect(
      projectScreen(screenAt2, coded, device(1)).report[0]?.reason,
    ).toContain('split-name');

    const codeSteps = {
      'split-name': {
        up: (p: { name: string }) => ({
          first: p.name.split(' ')[0],
          last: p.name.split(' ')[1],
        }),
        down: (p: { first: string; last: string }) => ({
          name: `${p.first} ${p.last}`,
        }),
      },
    };
    expect(
      projectScreen(screenAt2, coded, device(1), { codeSteps }).root,
    ).toEqual({ id: 'n', type: 'note', v: 1, props: { name: 'Ada Lovelace' } });
  });

  it('falls back when a migration throws on this data instead of emitting half a migration', () => {
    const wrapped = only(
      doc(2, [
        {
          from: 1,
          to: 2,
          description: 'wrap',
          ops: [{ wrap: { path: 'price', key: 'amount' } }],
        },
      ]),
    );
    // Authored as v2 but with a scalar where the v2 shape has an object: the down step cannot unwrap it.
    const result = projectScreen(
      authored(2, { price: 12 }),
      wrapped,
      device(1),
    );
    expect(result.root).toBeNull();
    expect(result.report[0]?.reason).toContain('failed');
  });

  it('drops a slot the app version predates, and treats it as critical when the catalog says so', () => {
    const child = { id: 'c', type: 'note', v: 2, props: {} };
    const slotted = (critical: boolean): SduiCatalog =>
      only(doc(2, [{ from: 1, to: 2, description: 'footer slot', ops: [] }]), {
        slots: { footer: { since: 2 } },
        ...(critical ? { criticalPaths: ['slots.footer'] } : {}),
      });
    const result = projectScreen(
      authored(2, { text: 'x' }, { footer: [child] }),
      slotted(false),
      device(1),
    );
    expect(result.root).toEqual({
      id: 'n',
      type: 'note',
      v: 1,
      props: { text: 'x' },
    });
    expect(result.report[0]).toMatchObject({
      outcome: 'downgraded',
      lossyPaths: ['slots.footer'],
    });
    expect(result.outcome).toBe('degraded');
    expect(
      projectScreen(
        authored(2, { text: 'x' }, { footer: [child] }),
        slotted(true),
        device(1),
      ).root,
    ).toBeNull();
  });
});

describe('applyVisibility', () => {
  const projected = () =>
    projectScreen(screen('home'), catalog(), manifest('current'));
  const ids = (root: ReturnType<typeof applyVisibility>['root']) =>
    root?.slots?.['children']?.map((child) => child.id) ?? [];

  it('prunes a node whose condition is false and strips every condition from what is sent', () => {
    const { root, hidden } = applyVisibility(projected(), {
      flags: { 'member-promo': true },
      audiences: [],
    });
    expect(ids(root)).not.toContain('n_promo');
    expect(hidden).toEqual([{ nodeId: 'n_promo', by: 'visibility' }]);
    expect(JSON.stringify(root)).not.toContain('visibility');
    expect(JSON.stringify(root)).not.toContain('member-promo');
  });

  it('says when a flag alone is what hides a node', () => {
    const { hidden } = applyVisibility(projected(), {
      flags: { 'member-promo': false },
      audiences: ['members'],
    });
    expect(hidden).toEqual([{ nodeId: 'n_promo', by: 'flag' }]);
  });

  it('keeps a node whose condition holds', () => {
    const { root, hidden } = applyVisibility(projected(), {
      flags: { 'member-promo': true },
      audiences: ['members'],
    });
    expect(ids(root)).toContain('n_promo');
    expect(hidden).toEqual([]);
  });

  it('shows a fallback under the same condition as the node it stands in for', () => {
    const gated: Screen = {
      id: 's',
      slug: 's',
      root: {
        id: 'n_video',
        type: 'video-tile',
        v: 1,
        props: { title: 't', src: 's' },
        visibility: { audience: 'members' },
        fallback: { id: 'n_fb', type: 'text', v: 2, props: { content: 'x' } },
      },
    };
    const result = projectScreen(gated, catalog(), manifest('one-behind'));
    expect(result.root).toMatchObject({
      id: 'n_fb',
      visibility: { audience: 'members' },
    });
    expect(applyVisibility(result, { audiences: [] }).root).toBeNull();
  });
});
