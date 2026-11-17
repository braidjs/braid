import {
  type Screen,
  compareVersions,
  evaluateCondition,
  flagsIn,
  hasPath,
  migrate,
  parseScreen,
  pathWithin,
  screenId,
} from '../index.js';
import { catalog, screen } from './fixtures.spec-util.js';

describe('parseScreen', () => {
  const broken = (mutate: (draft: any) => void): (() => unknown) => {
    const draft = structuredClone(screen('home')) as any;
    mutate(draft);
    return () => parseScreen(draft);
  };

  it('accepts the conformance screens', () => {
    expect(screen('home').slug).toBe('home');
    expect(screenId(screen('home'))).toMatch(/^scr_[0-9a-f]{32}$/);
  });

  it('says where the problem is', () => {
    expect(broken((d) => delete d.root.slots.children[2].v)).toThrow(
      'root.slots.children[2].v must be a positive integer',
    );
    expect(
      broken((d) => (d.root.slots.children[0].actions.press.type = '')),
    ).toThrow('root.slots.children[0].actions.press.type');
    expect(broken((d) => (d.states.loading = 'system'))).toThrow(
      'states.loading must be an object',
    );
    expect(broken((d) => (d.states.refreshing = 'auto'))).toThrow(
      'not a screen state that can be authored',
    );
  });

  it('refuses a node id used twice, including inside a fallback', () => {
    expect(
      broken((d) => (d.root.slots.children[1].fallback.id = 'n_hero')),
    ).toThrow('node id "n_hero" is used more than once');
  });

  it('refuses anything that is not one of the closed conditions', () => {
    expect(
      broken(
        (d) =>
          (d.root.slots.children[5].visibility = { expr: 'user.age > 18' }),
      ),
    ).toThrow('conditions are a closed set');
    expect(
      broken(
        (d) =>
          (d.root.slots.children[5].visibility = {
            flag: 'a',
            platform: ['ios'],
          }),
      ),
    ).toThrow('exactly one of');
  });

  it('refuses a tree deep enough to be an attack rather than a screen', () => {
    let node: any = { id: 'leaf', type: 'stack', v: 1 };
    for (let depth = 0; depth < 70; depth++)
      node = {
        id: `n${depth}`,
        type: 'stack',
        v: 1,
        slots: { children: [node] },
      };
    expect(() =>
      parseScreen({ id: 's', slug: 's', root: node } satisfies Screen),
    ).toThrow('nested more than 64 levels deep');
  });
});

describe('migrate', () => {
  const card = catalog().components['product-card']!.contract;

  it('reports a range error instead of running off the end of the steps', () => {
    expect(migrate(card, {}, 1, 4)).toMatchObject({
      ok: false,
      reason: 'range',
    });
    expect(migrate(card, {}, 0, 2)).toMatchObject({
      ok: false,
      reason: 'range',
    });
  });

  it('round-trips losslessly when nothing the older shape lacks was set', () => {
    const v3 = {
      title: 'Ridge Shell',
      price: { amount: 168, sale: null },
      badge: null,
    };
    const down = migrate(card, v3, 3, 1);
    expect(down).toMatchObject({
      ok: true,
      value: { title: 'Ridge Shell', price: 168 },
      lossyPaths: [],
    });
    expect(migrate(card, down.ok ? down.value : null, 1, 3)).toMatchObject({
      ok: true,
      value: v3,
    });
  });

  it('never mutates what it was given', () => {
    const v3 = Object.freeze({
      title: 'x',
      price: Object.freeze({ amount: 1, sale: 2 }),
      badge: 'New',
    });
    expect(migrate(card, v3, 3, 1)).toMatchObject({
      ok: true,
      lossyPaths: ['badge', 'price.sale'],
    });
  });
});

describe('paths, versions and flag names', () => {
  it('finds values under list segments', () => {
    expect(hasPath({ items: [{ a: 1 }, {}] }, 'items[].a')).toBe(true);
    expect(hasPath({ items: [{}] }, 'items[].a')).toBe(false);
    expect(hasPath({ a: null }, 'a')).toBe(true);
  });

  it('matches a path against a critical prefix in both directions', () => {
    expect(pathWithin('price.sale', 'price')).toBe(true);
    expect(pathWithin('price', 'price.sale')).toBe(true);
    expect(pathWithin('pricing', 'price')).toBe(false);
  });

  it('orders versions numerically and survives junk', () => {
    expect(compareVersions('5.10', '5.8')).toBe(1);
    expect(compareVersions('5.8', '5.8.0')).toBe(0);
    expect(compareVersions('six', '0')).toBe(0);
  });

  it('lists the flags a condition reads and answers "is it only a flag?"', () => {
    const condition = {
      all: [
        { flag: 'a' },
        { any: [{ not: { flag: 'b' } }, { platform: ['ios'] }] },
      ],
    };
    expect(flagsIn(condition)).toEqual(['a', 'b']);
    expect(
      evaluateCondition({ not: { flag: 'a' } }, { flags: { a: true } }),
    ).toBe(false);
    expect(
      evaluateCondition(
        { not: { flag: 'a' } },
        { flags: { a: true } },
        { assumeFlags: true },
      ),
    ).toBe(true);
  });
});
