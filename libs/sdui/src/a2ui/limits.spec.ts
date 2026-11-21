import { describe, expect, it } from 'vitest';
import { A2UI_BASIC_CATALOG_ID } from './basic.js';
import { parseA2uiMessage } from './messages.js';
import {
  A2uiSurfaces,
  DATA_MODEL_LIMITS,
  SURFACES_LIMITS,
  weigh,
} from './surfaces.js';

/** What a renderer may be made to hold, in characters as well as values, and what that costs. */

const create = (surfaceId: string, dataModel?: object) =>
  parseA2uiMessage({
    version: '1.0',
    createSurface: {
      surfaceId,
      catalogId: A2UI_BASIC_CATALOG_ID,
      ...(dataModel ? { dataModel } : {}),
    },
  });
const write = (surfaceId: string, path: string, value: unknown) =>
  parseA2uiMessage({
    version: '1.0',
    updateDataModel: { surfaceId, path, value },
  });
/** 19 strings of 100,000 characters: 1.9 M characters in 20 values. */
const strings = (seed: number) =>
  Object.fromEntries(
    Array.from({ length: 19 }, (_, i) => [
      `s${i}`,
      String.fromCharCode(97 + ((seed + i) % 26)).repeat(100_000),
    ]),
  );

/** What the store's running totals should be, counted from scratch. */
function recount(surfaces: A2uiSurfaces): number {
  let chars = 0;
  for (const id of surfaces.ids()) {
    const surface = surfaces.get(id)!;
    chars += weigh(surface.dataModel).chars;
    for (const component of surface.components.values()) {
      const weight = weigh(component);
      chars += weight.values + weight.chars;
    }
  }
  return chars;
}

describe('a data model is limited in characters, not only values', () => {
  it('refuses the update that would take it past its characters, and keeps the model', () => {
    const surfaces = new A2uiSurfaces();
    surfaces.apply(create('s'));
    surfaces.apply(write('s', '/a', strings(0)));
    expect(() => surfaces.apply(write('s', '/b', strings(1)))).toThrow(
      new RegExp(`more than ${DATA_MODEL_LIMITS.chars} characters`),
    );
    expect(Object.keys(surfaces.get('s')!.dataModel)).toEqual(['a']);
    expect(surfaces.chars).toBe(recount(surfaces));
    // replacing it is not adding to it
    surfaces.apply(write('s', '/a', strings(2)));
    expect(surfaces.chars).toBe(recount(surfaces));
  });

  it('refuses, across surfaces, what the renderer cannot hold in all', () => {
    const surfaces = new A2uiSurfaces();
    let refused = 0;
    for (let i = 0; i < 10; i++) {
      surfaces.apply(create(`s${i}`));
      try {
        surfaces.apply(write(`s${i}`, '/a', strings(i)));
      } catch {
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
    expect(surfaces.chars).toBeLessThanOrEqual(SURFACES_LIMITS.chars);
    expect(surfaces.chars).toBe(recount(surfaces));
    // deleting a surface makes room again
    surfaces.apply(
      parseA2uiMessage({ version: '1.0', deleteSurface: { surfaceId: 's0' } }),
    );
    surfaces.apply(write('s9', '/a', strings(9)));
    expect(surfaces.chars).toBe(recount(surfaces));
  });

  it('counts components too', () => {
    const surfaces = new A2uiSurfaces();
    surfaces.apply(create('s'));
    const text = (id: string, seed: number) => ({
      id,
      component: 'Text',
      text: String.fromCharCode(97 + seed).repeat(100_000),
    });
    const update = (components: unknown[]) =>
      surfaces.apply(
        parseA2uiMessage({
          version: '1.0',
          updateComponents: { surfaceId: 's', components },
        }),
      );
    for (let i = 0; i < 19; i++) update([text(`t${i}`, i)]);
    expect(() => update([text('t19', 1), text('t20', 2)])).toThrow(
      /components would hold more than/,
    );
    expect(surfaces.get('s')!.components.has('t19')).toBe(false);
    // replacing a component costs only the difference
    update([text('t0', 5)]);
    expect(surfaces.chars).toBe(recount(surfaces));
  });
});

describe('an update costs what it changes', () => {
  it('writing one number beside 45,000 keys does not copy them', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 45_000 }, (_, i) => [`k${i.toString(36)}`, 0]),
    );
    const surfaces = new A2uiSurfaces();
    surfaces.apply(create('s', wide));
    const model = surfaces.get('s')!.dataModel;
    const started = performance.now();
    for (let i = 0; i < 2_000; i++) surfaces.apply(write('s', '/x', i));
    const elapsed = performance.now() - started;
    expect(surfaces.get('s')!.dataModel).toBe(model); // in place
    expect(surfaces.get('s')!.dataModel['x']).toBe(1_999);
    // a copy per update is ~2,000 x 45,000 keys: seconds, not this
    expect(elapsed).toBeLessThan(250);
  });

  it('keeps its totals exact through any sequence of writes, refused ones included', () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const paths = [
      '/a',
      '/a/b',
      '/a/b/c',
      '/l',
      '/l/0',
      '/l/-',
      '/l/3',
      '/l/0/x',
      '/s',
      '/a/0',
    ];
    const values = [
      () => null,
      () => random(100),
      () => 'x'.repeat(random(50)),
      () => ({ k: 'v'.repeat(random(10)), n: [1, 2, { q: 'r' }] }),
      () => [random(5), 'y', { z: [] }],
      () => ({}),
    ];
    for (let run = 0; run < 20; run++) {
      const surfaces = new A2uiSurfaces();
      surfaces.apply(create('s', { a: { b: 1 }, l: [] }));
      for (let step = 0; step < 300; step++) {
        const before = JSON.stringify(surfaces.get('s')!.dataModel);
        const path = paths[random(paths.length)]!;
        try {
          if (random(20) === 0) surfaces.apply(write('s', '/', values[3]!()));
          else
            surfaces.apply(write('s', path, values[random(values.length)]!()));
        } catch {
          // a refused write leaves the model as it was
          expect(JSON.stringify(surfaces.get('s')!.dataModel)).toBe(before);
        }
        expect(surfaces.chars).toBe(recount(surfaces));
      }
    }
  });
});
