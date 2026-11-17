import {
  type Screen,
  type SduiCatalog,
  changedPaths,
  diffScreens,
  screenId,
} from '../index.js';
import { catalog, readVector, screen } from './fixtures.spec-util.js';

const base = (): Screen => readVector('diff/moved.json').before;
const edit = (mutate: (draft: any) => void): Screen => {
  const draft = structuredClone(base());
  mutate(draft);
  return draft;
};

describe('diffScreens', () => {
  it('reports one move when a node changes place — not a removal and an addition', () => {
    const { after } = readVector('diff/moved.json');
    const { changes } = diffScreens(base(), after, catalog());
    expect(changes.map((change) => change.kind)).toEqual(['moved']);
  });

  it('reports one move when a node goes to another parent, and nothing for the siblings that shifted', () => {
    const before = edit((d) =>
      d.root.slots.children.push({
        id: 'n_group',
        type: 'stack',
        v: 1,
        slots: { children: [] },
      }),
    );
    const after = edit((d) => {
      const [moved] = d.root.slots.children.splice(1, 1);
      d.root.slots.children.push({
        id: 'n_group',
        type: 'stack',
        v: 1,
        slots: { children: [moved] },
      });
    });
    expect(diffScreens(before, after, catalog()).changes).toEqual([
      {
        kind: 'moved',
        nodeId: 'n_shell',
        type: 'product-card',
        from: { parentId: 'n_root', slot: 'children', index: 1 },
        to: { parentId: 'n_group', slot: 'children', index: 0 },
      },
    ]);
  });

  it('reports no content change for the same content at two contract versions, and one catalog upgrade', () => {
    const { before, after } = readVector('diff/catalog-upgrade.json');
    const diff = diffScreens(before, after, catalog());
    expect(diff.unchanged).toBe(false);
    expect(diff.changes).toEqual([]);
    expect(diff.catalogUpgrades).toEqual([
      {
        nodeId: 'n_shell',
        type: 'product-card',
        from: 2,
        to: 3,
        derivedPaths: ['badge'],
      },
    ]);
  });

  it('reports the edit as well when an upgraded node was also edited', () => {
    const { before } = readVector('diff/catalog-upgrade.json');
    const after = edit((d) => (d.root.slots.children[1].props.badge = 'New'));
    const diff = diffScreens(before, after, catalog());
    expect(diff.changes).toEqual([
      {
        kind: 'content',
        nodeId: 'n_shell',
        type: 'product-card',
        paths: ['badge'],
      },
    ]);
    expect(diff.catalogUpgrades).toHaveLength(1);
  });

  it('detects an unchanged screen from its content address without walking it', () => {
    const { before, after } = readVector('diff/unchanged.json');
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
    expect(screenId(before)).toBe(screenId(after));
    // A catalog that throws on any read proves nothing was walked or migrated.
    const untouchable = new Proxy({} as SduiCatalog, {
      get: (_target, key) => {
        throw new Error(
          `the catalog was read (${String(key)}) for an unchanged screen`,
        );
      },
    });
    expect(diffScreens(before, after, untouchable)).toMatchObject({
      unchanged: true,
      changes: [],
      catalogUpgrades: [],
    });
    expect(() =>
      diffScreens(
        before,
        edit((d) => (d.title = 'Other')),
        untouchable,
      ),
    ).toThrow('the catalog was read');
  });

  it('reports actions, visibility, fallback, required and analytics as their own kinds', () => {
    const after = edit((d) => {
      const [, shell, runner] = d.root.slots.children;
      shell.actions = {
        press: {
          type: 'navigate',
          v: 2,
          props: { to: 'x', transition: 'push' },
        },
      };
      shell.visibility = { audience: 'members' };
      runner.fallback = {
        id: 'n_fb',
        type: 'text',
        v: 2,
        props: { content: 'x' },
      };
      runner.required = true;
      runner.analytics = { name: 'runner' };
    });
    expect(diffScreens(base(), after, catalog()).changes).toEqual([
      { kind: 'actions', nodeId: 'n_shell', type: 'product-card' },
      { kind: 'visibility', nodeId: 'n_shell', type: 'product-card' },
      { kind: 'fallback', nodeId: 'n_runner', type: 'product-card' },
      { kind: 'required', nodeId: 'n_runner', type: 'product-card' },
      { kind: 'analytics', nodeId: 'n_runner', type: 'product-card' },
    ]);
  });

  it('does not report an action that was only upgraded by the catalog', () => {
    const before = edit(
      (d) =>
        (d.root.slots.children[1].actions = {
          press: { type: 'navigate', v: 1, props: { to: 'x' } },
        }),
    );
    const after = edit(
      (d) =>
        (d.root.slots.children[1].actions = {
          press: {
            type: 'navigate',
            v: 2,
            props: { to: 'x', transition: 'push' },
          },
        }),
    );
    expect(diffScreens(before, after, catalog()).changes).toEqual([]);
  });

  it('reports a changed authored state and a changed type', () => {
    const before = screen('home');
    const after = structuredClone(before) as any;
    after.states.empty.props.content = 'Nothing here';
    after.root.slots.children[6] = {
      ...after.root.slots.children[6],
      type: 'text',
      props: { content: 'Prices include tax.' },
    };
    expect(diffScreens(before, after, catalog()).changes).toEqual([
      { kind: 'screen', paths: ['states.empty'] },
      { kind: 'type', nodeId: 'n_legal', from: 'legal-note', to: 'text' },
    ]);
  });
});

describe('changedPaths', () => {
  it('names leaf paths, and a whole array when its length changed', () => {
    expect(
      changedPaths(
        { a: 1, b: { c: [1, 2], d: 'x' } },
        { a: 1, b: { c: [1, 3], d: 'y' } },
      ),
    ).toEqual(['b.c[1]', 'b.d']);
    expect(changedPaths({ list: [1] }, { list: [1, 2] })).toEqual(['list']);
    expect(changedPaths({ a: undefined }, { a: null })).toEqual([]);
  });
});
