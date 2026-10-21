import { describe, expect, it } from 'vitest';
import { readRoute, routeHash } from './routes.js';

describe('readRoute', () => {
  it.each([
    ['', { view: 'fragments' }],
    ['#', { view: 'fragments' }],
    ['#fragments', { view: 'fragments' }],
    ['#topology', { view: 'topology' }],
    ['#history', { view: 'history' }],
    ['#shells', { view: 'shells' }],
    ['#shells/partner-portal', { view: 'shells', shell: 'partner-portal' }],
    ['#shells/a%2Fb', { view: 'shells', shell: 'a/b' }],
    ['#shells/%E0%A4%A', { view: 'shells' }],
    ['#nonsense', { view: 'fragments' }],
  ])('%s → %j', (hash, route) => {
    expect(readRoute(hash, true)).toEqual(route);
  });

  it('opens the editor only when editing is enabled', () => {
    expect(readRoute('#edit', true)).toEqual({ view: 'edit' });
    expect(readRoute('#edit', false)).toEqual({ view: 'fragments' });
  });

  it('round-trips through routeHash', () => {
    for (const route of [{ view: 'shells' as const, shell: 'a b/c' }, { view: 'history' as const }]) {
      expect(readRoute(`#${routeHash(route)}`, true)).toEqual(route);
    }
  });
});
