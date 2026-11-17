import {
  type Screen,
  checkCatalog,
  createClientManifest,
  diffScreens,
  parseCatalog,
  parseHandshakeRequest,
  projectScreen,
  resolveHandshake,
} from '../index.js';
import { catalog, manifest, readVector } from './fixtures.spec-util.js';

/**
 * Names in a document are keys into maps here. These pin that a name which happens to be a
 * property of every object — `constructor`, `toString`, `__proto__` — is treated as the unknown
 * name it is, rather than found on the prototype.
 */
describe('names that collide with Object.prototype', () => {
  const named = (type: string, action = 'navigate'): Screen => ({
    id: 's',
    slug: 's',
    root: {
      id: 'n_root',
      type: 'stack',
      v: 1,
      slots: {
        children: [
          {
            id: 'n',
            type,
            v: 1,
            props: {},
            actions: { press: { type: action, v: 1, props: { to: 'x' } } },
          },
        ],
      },
    },
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'projects a node of type "%s" as an unknown component',
    (type) => {
      const result = projectScreen(named(type), catalog(), manifest('current'));
      expect(result.report[1]).toMatchObject({
        nodeId: 'n',
        outcome: 'omitted',
        reason: `"${type}" is not a component in the catalog`,
      });
      expect(result.root?.slots?.['children']).toEqual([]);
    },
  );

  it.each(['constructor', 'valueOf'])(
    'treats an action of type "%s" as unknown and disables the control',
    (action) => {
      const result = projectScreen(
        named('text', action),
        catalog(),
        manifest('current'),
      );
      expect(result.root?.slots?.['children']?.[0]).toMatchObject({
        disabled: true,
      });
    },
  );

  it('diffs screens that use such names without reading the prototype', () => {
    const before = named('constructor');
    const after = structuredClone(before) as any;
    after.root.slots.children[0].v = 2;
    expect(() => diffScreens(before, after, catalog())).not.toThrow();
  });

  it('handles a catalog entry named "constructor" as an ordinary entry', () => {
    const base = readVector('catalog.json');
    const withOdd = structuredClone(base);
    withOdd.components['constructor'] = {
      contract: {
        skewContract: '1',
        name: 'sdui.component.constructor',
        current: 1,
        steps: [],
      },
    };
    expect(
      checkCatalog(parseCatalog(withOdd), parseCatalog(base)),
    ).toMatchObject([
      { kind: 'removed', contract: 'sdui.component.constructor' },
    ]);
    expect(checkCatalog(parseCatalog(base), parseCatalog(withOdd))).toEqual([]);
  });

  it('refuses to pin a type the catalog does not have, even one every object has', () => {
    expect(() =>
      createClientManifest(catalog(), {
        app: 'a',
        platform: 'ios',
        version: '1.0',
        pin: { constructor: 1 },
      }),
    ).toThrow('no component or action by that name');
  });

  it("does not copy a prototype member through a catalog fallback's $from", () => {
    const base = readVector('catalog.json');
    base.components['video-tile'].fallback = {
      type: 'text',
      props: { content: { $from: 'constructor' }, style: 'body' },
    };
    const screen: Screen = {
      id: 's',
      slug: 's',
      root: {
        id: 'n',
        type: 'video-tile',
        v: 1,
        props: { title: 't', src: 's' },
      },
    };
    const result = projectScreen(
      screen,
      parseCatalog(base),
      manifest('one-behind'),
    );
    expect(result.root).toEqual({
      id: 'n',
      type: 'text',
      v: 2,
      props: { style: 'body' },
    });
  });
});

describe('parseHandshakeRequest', () => {
  const valid = {
    protocol: [1, 1],
    manifest: 'cm_known',
    app: { id: 'acme-shop', platform: 'ios', version: '6.2.0' },
    install: 'ins_1',
    known: { release: 'rel_a', seq: 3 },
  };

  it('accepts a well-formed request, which then resolves', () => {
    const request = parseHandshakeRequest(structuredClone(valid));
    expect(
      resolveHandshake(request, { knowsManifest: () => true }).status,
    ).toBe('ok');
  });

  it.each([
    [null, 'body must be an object'],
    [[], 'body must be an object'],
    [{ ...valid, protocol: '1' }, 'protocol must be [min, max]'],
    [{ ...valid, protocol: [2, 1] }, 'protocol must be [min, max]'],
    [{ ...valid, protocol: [1, 1.5] }, 'protocol must be [min, max]'],
    [
      { ...valid, manifest: 7 },
      'manifest must be a fingerprint or a manifest document',
    ],
    [{ ...valid, manifest: 'x'.repeat(129) }, 'manifest must be a fingerprint'],
    [{ ...valid, app: 'acme' }, 'app must be an object'],
    [
      { ...valid, app: { ...valid.app, version: '' } },
      'app.version must be a non-empty string',
    ],
    [
      { ...valid, install: 'i'.repeat(500) },
      'install must be a non-empty string of at most 128',
    ],
    [
      { ...valid, known: { release: 'rel_a', seq: -1 } },
      'known must be { release, seq }',
    ],
    [
      { ...valid, known: { release: 'rel_a', seq: '3' } },
      'known must be { release, seq }',
    ],
  ])('refuses %j', (body, message) => {
    expect(() => parseHandshakeRequest(body)).toThrow(message);
  });
});

describe('diffScreens on very long lists', () => {
  it('still finds a move among 3,000 siblings without building a 9-million-cell table', () => {
    const child = (index: number) => ({
      id: `n${index}`,
      type: 'text',
      v: 2,
      props: { content: String(index) },
    });
    const children = Array.from({ length: 3000 }, (_, index) => child(index));
    const before: Screen = {
      id: 's',
      slug: 's',
      root: { id: 'r', type: 'stack', v: 1, slots: { children } },
    };
    const moved = [
      ...children.slice(1),
      children[0] as (typeof children)[number],
    ];
    const after: Screen = {
      id: 's',
      slug: 's',
      root: { id: 'r', type: 'stack', v: 1, slots: { children: moved } },
    };
    const { changes } = diffScreens(before, after, catalog());
    expect(changes).toEqual([
      {
        kind: 'moved',
        nodeId: 'n0',
        type: 'text',
        from: { parentId: 'r', slot: 'children', index: 0 },
        to: { parentId: 'r', slot: 'children', index: 2999 },
      },
    ]);
  });
});
