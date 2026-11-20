import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { a2uiBasicCatalog } from './basic.js';
import { surfaceToScreen } from './codec.js';
import {
  A2UI_LIMITS,
  A2uiError,
  parseA2uiMessage,
  parseA2uiStream,
  toJsonLines,
} from './messages.js';
import { A2uiSurfaces } from './surfaces.js';

interface Vector {
  name: string;
  messages: unknown[];
  error?: { code: string; path?: string };
  dangling?: string[];
  orphans?: string[];
  screen?: null;
}
const vectors: { refused: Vector[]; accepted: Vector[] } = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../conformance/a2ui/streams.json'),
    'utf8',
  ),
);

/** Parse, apply, convert — what a renderer or the projector does with each message. */
function run(messages: readonly unknown[]) {
  const surfaces = new A2uiSurfaces();
  let last: ReturnType<typeof surfaceToScreen> | null = null;
  for (const raw of messages) {
    const applied = surfaces.apply(parseA2uiMessage(raw));
    const state = applied.surfaceId
      ? surfaces.get(applied.surfaceId)
      : undefined;
    if (state) last = surfaceToScreen(state, { catalog: a2uiBasicCatalog });
  }
  return last;
}

describe('A2UI streams that are refused', () => {
  it.each(vectors.refused.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      let caught: unknown;
      try {
        run(vector.messages.slice(0, -1));
      } catch (error) {
        throw new Error(
          `a message before the last one was refused: ${(error as Error).message}`,
        );
      }
      try {
        run(vector.messages);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(A2uiError);
      expect((caught as A2uiError).code).toBe(vector.error!.code);
      if (vector.error!.path !== undefined)
        expect((caught as A2uiError).path).toBe(vector.error!.path);
      expect((caught as A2uiError).message.length).toBeGreaterThan(10);
    },
  );

  it('refuses a message with more components than the limit', () => {
    const components = Array.from(
      { length: A2UI_LIMITS.components + 1 },
      (_, i) => ({
        id: `c${i}`,
        component: 'Text',
        text: 'x',
      }),
    );
    expect(() =>
      parseA2uiMessage({
        version: '1.0',
        updateComponents: { surfaceId: 's', components },
      }),
    ).toThrow(/at most 5000 components/);
  });

  it('refuses a surface that grows past the limit over several messages', () => {
    const surfaces = new A2uiSurfaces();
    surfaces.apply(
      parseA2uiMessage({ version: '1.0', createSurface: { surfaceId: 's' } }),
    );
    const batch = (from: number) =>
      parseA2uiMessage({
        version: '1.0',
        updateComponents: {
          surfaceId: 's',
          components: Array.from({ length: 2_500 }, (_, i) => ({
            id: `c${from + i}`,
            component: 'Text',
            text: 'x',
          })),
        },
      });
    surfaces.apply(batch(0));
    surfaces.apply(batch(2_500));
    expect(() => surfaces.apply(batch(5_000))).toThrow(
      /more than 5000 components/,
    );
    expect(surfaces.get('s')!.components.size).toBe(5_000);
  });

  it('refuses a data model update that would grow it past the limit, and keeps the old one', () => {
    const surfaces = new A2uiSurfaces();
    surfaces.apply(
      parseA2uiMessage({
        version: '1.0',
        createSurface: { surfaceId: 's', dataModel: { a: 1 } },
      }),
    );
    // each message is under the per-message limit; together they are past the data model's
    const big = Array.from({ length: 190_000 }, (_, i) => i);
    const update = (path: string) =>
      surfaces.apply(
        parseA2uiMessage({
          version: '1.0',
          updateDataModel: { surfaceId: 's', path, value: big },
        }),
      );
    update('/x');
    update('/y');
    expect(() => update('/z')).toThrow(/more than 400000 values/);
    expect(surfaces.get('s')!.dataModel['z']).toBeUndefined();
    expect(surfaces.get('s')!.dataModel['y']).toHaveLength(190_000);
  });

  it('refuses a string longer than the limit', () => {
    expect(() =>
      parseA2uiMessage({
        version: '1.0',
        createSurface: {
          surfaceId: 's',
          dataModel: { a: 'x'.repeat(A2UI_LIMITS.string + 1) },
        },
      }),
    ).toThrow(/more than 100000 characters/);
  });

  it('names the line of a stream that failed', () => {
    const text =
      toJsonLines([{ version: '1.0', createSurface: { surfaceId: 's' } }]) +
      '{"version":"1.0","nope":{}}\n';
    expect(() => parseA2uiStream(text)).toThrow(/line 2/);
    expect(() => parseA2uiStream('{"version":')).toThrow(/not JSON/);
  });
});

describe('A2UI streams that are accepted', () => {
  it.each(vectors.accepted.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      const result = run(vector.messages)!;
      if (vector.screen === null) expect(result.screen).toBeNull();
      else expect(result.screen).not.toBeNull();
      expect(result.dangling).toEqual(vector.dangling);
      expect(result.orphans).toEqual(vector.orphans);
    },
  );

  it('reads a stream as JSON Lines or as one array, the same either way', () => {
    const messages = [
      { version: '1.0', createSurface: { surfaceId: 's' } },
      {
        version: '1.0',
        updateComponents: {
          surfaceId: 's',
          components: [{ id: 'root', component: 'Text', text: 'x' }],
        },
      },
    ];
    expect(parseA2uiStream(toJsonLines(messages))).toEqual(messages);
    expect(parseA2uiStream(JSON.stringify(messages))).toEqual(messages);
  });

  it('writes data model values by pointer: nested, into lists, and deleting with null', () => {
    const surfaces = new A2uiSurfaces();
    const apply = (raw: unknown) => surfaces.apply(parseA2uiMessage(raw));
    apply({
      version: '1.0',
      createSurface: { surfaceId: 's', dataModel: { list: ['a', 'b'] } },
    });
    apply({
      version: '1.0',
      updateDataModel: { surfaceId: 's', path: '/user/name', value: 'Ada' },
    });
    apply({
      version: '1.0',
      updateDataModel: { surfaceId: 's', path: '/list/-', value: 'c' },
    });
    apply({
      version: '1.0',
      updateDataModel: { surfaceId: 's', path: '/list/0', value: null },
    });
    apply({
      version: '1.0',
      updateDataModel: { surfaceId: 's', path: '/a~1b', value: 1 },
    });
    expect(surfaces.get('s')!.dataModel).toEqual({
      list: ['b', 'c'],
      user: { name: 'Ada' },
      'a/b': 1,
    });
    apply({
      version: '1.0',
      updateDataModel: { surfaceId: 's', value: { fresh: true } },
    });
    expect(surfaces.get('s')!.dataModel).toEqual({ fresh: true });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});
