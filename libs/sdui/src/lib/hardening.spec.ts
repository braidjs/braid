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

  it('refuses a catalog entry, a slot or a fallback prop with a reserved name', () => {
    const base = readVector('catalog.json');
    const odd = (mutate: (draft: any) => void) => () => {
      const draft = structuredClone(base);
      mutate(draft);
      parseCatalog(draft);
    };
    expect(
      odd(
        (d) =>
          (d.components['constructor'] = {
            contract: {
              skewContract: '1',
              name: 'sdui.component.constructor',
              current: 1,
              steps: [],
            },
          }),
      ),
    ).toThrow('not a reserved word');
    expect(
      odd((d) =>
        Object.defineProperty(d.components['stack'].slots, '__proto__', {
          value: {},
          enumerable: true,
        }),
      ),
    ).toThrow('is not a slot name');
    expect(
      odd(
        (d) =>
          (d.components['legal-note'].fallback.props = JSON.parse(
            '{"__proto__":{"x":1}}',
          )),
      ),
    ).toThrow('reserved key "__proto__"');
  });

  it('reports a removed contract by own name even when an inherited member has that name', () => {
    // Built by hand, as `checkCatalog` may be given catalogs that never went through the parser.
    const withOdd = structuredClone(readVector('catalog.json'));
    withOdd.components['constructor'] = {
      contract: {
        skewContract: '1',
        name: 'sdui.component.constructor',
        current: 1,
        steps: [],
      },
    };
    expect(checkCatalog(withOdd, catalog())).toMatchObject([
      { kind: 'removed', contract: 'sdui.component.constructor' },
    ]);
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
    const proto = JSON.parse('{"__proto__":1}');
    expect(() =>
      createClientManifest(catalog(), {
        app: 'a',
        platform: 'ios',
        version: '1.0',
        pin: proto,
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

  it('keeps a slot or an action keyed __proto__ in the output of a screen that skipped the parser', () => {
    const slots = JSON.parse(
      '{"__proto__":[{"id":"c","type":"text","v":2,"props":{"content":"kept"}}]}',
    );
    const actions = JSON.parse(
      '{"__proto__":{"type":"navigate","v":2,"props":{"to":"x","transition":"push"}}}',
    );
    const screen = {
      id: 's',
      slug: 's',
      root: { id: 'n', type: 'stack', v: 1, slots, actions },
    } as unknown as Screen;
    const base = readVector('catalog.json');
    Object.defineProperty(base.components['stack'].slots, '__proto__', {
      value: {},
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const result = projectScreen(screen, base, manifest('current'));
    expect(Object.keys(result.root?.slots ?? {})).toEqual(['__proto__']);
    expect(Object.keys(result.root?.actions ?? {})).toEqual(['__proto__']);
    expect(JSON.stringify(result.root)).toContain('"content":"kept"');
    expect(({} as Record<string, unknown>)['0']).toBeUndefined();
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
      resolveHandshake(request, { authorized: true, knowsManifest: () => true })
        .status,
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
      { ...valid, app: { ...valid.app, version: 'v6' } },
      'app.version must be dotted numbers',
    ],
    [{ ...valid, install: 'i'.repeat(500) }, 'install must be 1 to 128'],
    [{ ...valid, install: 'a\u0000b' }, 'install must be 1 to 128'],
    [
      { ...valid, known: { release: 'rel_a', seq: -1 } },
      'known must be { release, seq }',
    ],
    [
      { ...valid, known: { release: 'rel_a', seq: '3' } },
      'known must be { release, seq }',
    ],
    [{ ...valid, extra: 1 }, 'unknown key "extra"'],
  ])('refuses %j', (body, message) => {
    expect(() => parseHandshakeRequest(body)).toThrow(message);
  });

  it('validates a manifest sent in full, and refuses one that describes a different app', () => {
    const full = structuredClone(manifest('current'));
    const request = { ...valid, manifest: full };
    expect(parseHandshakeRequest(structuredClone(request)).manifest).toEqual(
      full,
    );
    expect(() =>
      parseHandshakeRequest({
        ...request,
        app: { ...valid.app, version: '99.0' },
      }),
    ).toThrow('describes a different app, platform or version');
    expect(() => parseHandshakeRequest({ ...request, manifest: {} })).toThrow(
      'unsupported manifest format',
    );
    expect(() =>
      parseHandshakeRequest({ ...request, manifest: { ...full, junk: 1 } }),
    ).toThrow('unknown key "junk"');

    let deep: unknown = 1;
    for (let depth = 0; depth < 20_000; depth++) deep = [deep];
    expect(() =>
      parseHandshakeRequest({
        ...request,
        manifest: { ...full, components: deep },
      }),
    ).toThrow(TypeError);
  });
});

describe('resolveHandshake', () => {
  const request = {
    protocol: [1, 1] as const,
    manifest: 'cm_known',
    app: { id: 'acme-shop', platform: 'ios', version: '6.2.0' },
  };

  it('passes only an explicit authorized: true', () => {
    for (const authorized of [undefined, null, 1, 'yes', false]) {
      expect(
        resolveHandshake(request, {
          authorized: authorized as never,
          knowsManifest: () => true,
        }).status,
      ).toBe('unauthorized');
    }
    expect(
      resolveHandshake(request, { authorized: true, knowsManifest: () => true })
        .status,
    ).toBe('ok');
  });

  it('throws on a policy whose versions are not versions, instead of waving everyone through', () => {
    expect(() =>
      resolveHandshake(request, {
        authorized: true,
        knowsManifest: () => true,
        requiredVersion: 'v6.0',
      }),
    ).toThrow('policy.requiredVersion must be a version');
  });

  it('serves a manifest sent in full and says it is unregistered; its own version is the one judged', () => {
    const full = manifest('legacy');
    const answer = resolveHandshake(
      { ...request, manifest: full, app: { ...request.app, version: '99.0' } },
      { authorized: true, knowsManifest: () => false, requiredVersion: '6.0' },
    );
    expect(answer.status).toBe('update-required');
    const served = resolveHandshake(
      { ...request, manifest: full },
      { authorized: true, knowsManifest: () => false },
    );
    expect(served).toMatchObject({ status: 'ok', registered: false });
  });
});
