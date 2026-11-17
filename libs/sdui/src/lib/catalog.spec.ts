import {
  type SduiCatalog,
  catalogId,
  checkCatalog,
  contractName,
  parseCatalog,
} from '../index.js';
import { catalog } from './fixtures.spec-util.js';

const clone = (value: SduiCatalog): any => structuredClone(value);

describe('checkCatalog: published history is append-only', () => {
  it('accepts a catalog that only appends a step and a version', () => {
    const next = clone(catalog());
    const card = next.components['product-card'].contract;
    card.current = 4;
    card.steps.push({
      from: 3,
      to: 4,
      description: 'a rating',
      ops: [{ default: { path: 'rating', value: null } }],
    });
    card.schemas['4'] = { type: 'object' };
    next.components['banner'] = {
      contract: {
        skewContract: '1',
        name: contractName('component', 'banner'),
        current: 1,
        steps: [],
      },
    };
    expect(checkCatalog(catalog(), next)).toEqual([]);
  });

  it('accepts the identical catalog', () => {
    expect(checkCatalog(catalog(), catalog())).toEqual([]);
  });

  it('names the step when a published step is edited', () => {
    const next = clone(catalog());
    next.components['product-card'].contract.steps[0].ops[0].wrap.also.sale = 0;
    const violations = checkCatalog(catalog(), next);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: 'step-edited',
      contract: 'sdui.component.product-card',
      step: { from: 1, to: 2 },
    });
    expect(violations[0]?.message).toContain('v1 → v2');
    expect(violations[0]?.message).toContain('price becomes an object');
  });

  it("counts a changed description as an edit — the description is a code step's identity", () => {
    const next = clone(catalog());
    next.components['hero-banner'].contract.steps[1].description =
      'countdown, reworded';
    expect(checkCatalog(catalog(), next)).toMatchObject([
      { kind: 'step-edited', step: { from: 2, to: 3 } },
    ]);
  });

  it('names both steps when published steps are reordered', () => {
    const next = clone(catalog());
    const steps = next.components['hero-banner'].contract.steps;
    [steps[0], steps[1]] = [
      { ...steps[1], from: 1, to: 2 },
      { ...steps[0], from: 2, to: 3 },
    ];
    const violations = checkCatalog(catalog(), next);
    expect(
      violations.map((violation) => [violation.kind, violation.step]),
    ).toEqual([
      ['steps-reordered', { from: 1, to: 2 }],
      ['steps-reordered', { from: 2, to: 3 }],
    ]);
    expect(violations[0]?.message).toContain('moved to v2 → v3');
  });

  it('reports a removed contract, a lowered version and an edited schema', () => {
    const next = clone(catalog());
    delete next.components['video-tile'];
    delete next.actions['share'];
    next.components['text'].contract.current = 1;
    next.components['text'].contract.steps = [];
    next.components['stack'].contract.schemas['1'] = {
      type: 'object',
      properties: { gap: { type: 'number' } },
    };
    const kinds = checkCatalog(catalog(), next).map(
      (violation) => `${violation.kind}:${violation.contract}`,
    );
    expect(kinds).toEqual([
      'schema-edited:sdui.component.stack',
      'version-lowered:sdui.component.text',
      'removed:sdui.component.video-tile',
      'removed:sdui.action.share',
    ]);
  });
});

describe('parseCatalog', () => {
  const broken = (mutate: (draft: any) => void): (() => unknown) => {
    const draft = clone(catalog());
    mutate(draft);
    return () => parseCatalog(draft);
  };

  it('accepts the conformance catalog and addresses it by content', () => {
    expect(catalogId(catalog())).toMatch(/^cat_[0-9a-f]{32}$/);
    const reordered = {
      events: catalog().events,
      actions: catalog().actions,
      components: catalog().components,
      sduiCatalog: '1' as const,
    };
    expect(catalogId(reordered)).toBe(catalogId(catalog()));
  });

  it('refuses a contract under the wrong name', () => {
    expect(
      broken((d) => (d.components['text'].contract.name = 'text')),
    ).toThrow('must be named "sdui.component.text"');
  });

  it('refuses a malformed contract, saying which component', () => {
    expect(
      broken((d) => d.components['hero-banner'].contract.steps.pop()),
    ).toThrow(/component "hero-banner": skew contract: steps must cover/);
  });

  it('refuses a fallback that names nothing, itself, or a slot from the future', () => {
    expect(
      broken((d) => (d.components['legal-note'].fallback = { type: 'nope' })),
    ).toThrow('which is not in this catalog');
    expect(
      broken((d) => (d.components['text'].fallback = { type: 'text' })),
    ).toThrow('cannot be its own fallback');
    expect(
      broken((d) => (d.components['stack'].slots.children.since = 2)),
    ).toThrow('since must be a version between 1 and 1');
  });

  it('refuses the reserved placeholder type and a format it does not know', () => {
    expect(
      broken((d) => (d.components['sdui.placeholder'] = d.components['text'])),
    ).toThrow('reserved');
    expect(broken((d) => (d.sduiCatalog = '2'))).toThrow(
      'unsupported catalog format "2"',
    );
  });
});
