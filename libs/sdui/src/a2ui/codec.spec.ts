import { describe, expect, it } from 'vitest';
import { a2uiBasicCatalog, A2UI_BASIC_CATALOG_ID } from './basic.js';
import { surfaceMessages, surfaceToScreen } from './codec.js';
import { parseA2uiMessage, type A2uiMessage } from './messages.js';
import { A2uiSurfaces } from './surfaces.js';
import { upstreamExamples, upstreamValidators } from './upstream.spec-util.js';

const examples = upstreamExamples();

/** Components an example sends that end up unreferenced by its last message. */
const ORPHANS: Readonly<Record<string, readonly string[]>> = {
  'incremental-dashboard.json': ['panel_a_loading', 'panel_b_loading'],
};
const validators = upstreamValidators();

function fold(messages: readonly unknown[]): A2uiSurfaces {
  const surfaces = new A2uiSurfaces();
  for (const raw of messages) surfaces.apply(parseA2uiMessage(raw));
  return surfaces;
}

describe('the upstream basic-catalog examples', () => {
  it('are all here', () => {
    expect(examples.length).toBeGreaterThanOrEqual(40);
  });

  it.each(examples.map((example) => [example.file, example] as const))(
    '%s round-trips through the SDUI model',
    (_file, example) => {
      // the examples are valid by the spec's own schemas, which is what makes them a fair test
      for (const message of example.messages)
        expect(
          validators.agentToRenderer(message),
          validators.explain(validators.agentToRenderer),
        ).toBe(true);

      const original = fold(example.messages);
      for (const surfaceId of original.ids()) {
        const state = original.get(surfaceId)!;
        const { screen, dangling, orphans } = surfaceToScreen(state, {
          catalog: a2uiBasicCatalog,
        });
        expect(screen).not.toBeNull();
        expect(dangling).toEqual([]);

        const messages: A2uiMessage[] = surfaceMessages({
          surfaceId,
          catalogId: state.catalogId ?? A2UI_BASIC_CATALOG_ID,
          root: screen!.root,
          dataModel: screen!.data,
          sendDataModel: state.sendDataModel,
          catalog: a2uiBasicCatalog,
        });
        for (const message of messages)
          expect(
            validators.agentToRenderer(message),
            validators.explain(validators.agentToRenderer),
          ).toBe(true);

        // What reaches the root comes back exactly. What does not is reported, not sent: a tree
        // has no place for a component nothing references. Upstream has exactly one such case —
        // the loading panels incremental-dashboard replaces — and that is asserted, not filtered.
        expect(orphans).toEqual(ORPHANS[example.file] ?? []);
        const reachable = [...state.components].filter(
          ([id]) => !orphans.includes(id),
        );
        const again = fold(messages).get(surfaceId)!;
        expect(Object.fromEntries(again.components)).toEqual(
          Object.fromEntries(reachable),
        );
        expect(again.dataModel).toEqual(state.dataModel);
        expect(again.catalogId).toBe(state.catalogId);
        expect(again.sendDataModel).toBe(state.sendDataModel);
      }
    },
  );
});
