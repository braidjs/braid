import { describe, expect, it } from 'vitest';
import { parseModuleFederationConfig } from './mf-config.js';

/**
 * The parser reads without executing, so every test here is about what it does when the config is
 * *not* a plain literal — which is the case that decides whether this command can be trusted.
 */

describe('parseModuleFederationConfig()', () => {
  it('reads the @nx/module-federation host shape', () => {
    const config = parseModuleFederationConfig(
      `
      import { ModuleFederationConfig } from '@nx/module-federation';
      const config: ModuleFederationConfig = {
        name: 'shell',
        remotes: ['billing', 'reviews'],
      };
      export default config;
      `,
      'apps/shell/module-federation.config.ts',
    );

    expect(config.name).toBe('shell');
    expect(config.remotes.map((remote) => remote.name)).toEqual(['billing', 'reviews']);
    expect(config.confidence).toBe('exact');
  });

  it('reads the tuple form, keeping each remote entry', () => {
    const config = parseModuleFederationConfig(
      `export default { name: 'shell', remotes: [['billing', 'http://localhost:4201/remoteEntry.js']] };`,
      'webpack.config.js',
    );

    expect(config.remotes).toEqual([{ name: 'billing', entry: 'http://localhost:4201/remoteEntry.js' }]);
  });

  it('reads the object form used by hand-rolled webpack configs', () => {
    const config = parseModuleFederationConfig(
      `
      new ModuleFederationPlugin({
        name: 'shell',
        remotes: {
          billing: 'billing@http://localhost:4201/remoteEntry.js',
          reviews: 'reviews@http://localhost:4202/remoteEntry.js',
        },
      })
      `,
      'webpack.config.js',
    );

    expect(config.remotes.map((remote) => remote.name)).toEqual(['billing', 'reviews']);
    expect(config.remotes[0]!.entry).toContain('4201');
  });

  it('does not stop at the first nested object', () => {
    // A non-scanning match ends at the first `}` and silently drops every remote after it — which
    // looks exactly like a workspace with one remote.
    const config = parseModuleFederationConfig(
      `export default {
        remotes: {
          billing: { type: 'module', remoteEntry: 'http://localhost:4201/remoteEntry.js' },
          reviews: { type: 'module', remoteEntry: 'http://localhost:4202/remoteEntry.js' },
          payroll: { type: 'module', remoteEntry: 'http://localhost:4203/remoteEntry.js' },
        },
      };`,
      'module-federation.config.ts',
    );

    expect(config.remotes.map((remote) => remote.name)).toEqual(['billing', 'reviews', 'payroll']);
  });

  it('reads exposes and shared', () => {
    const config = parseModuleFederationConfig(
      `export default {
        name: 'billing',
        exposes: { './Routes': 'apps/billing/src/app/remote-entry/entry.routes.ts' },
        shared: { '@angular/core': { singleton: true }, '@ngrx/store': { singleton: true } },
      };`,
      'module-federation.config.ts',
    );

    expect(config.exposes).toEqual({ './Routes': 'apps/billing/src/app/remote-entry/entry.routes.ts' });
    expect(config.shared).toEqual(['@angular/core', '@ngrx/store']);
  });

  it('reports partial confidence for a remote it could not read, rather than dropping it silently', () => {
    const config = parseModuleFederationConfig(
      `const extra = loadRemotes();
       export default { name: 'shell', remotes: ['billing', ...extra] };`,
      'module-federation.config.ts',
    );

    // The whole promise of a dry run is that it does not guess. A spread that this cannot resolve
    // has to surface as a finding, not as a topology that happens to be missing a remote.
    expect(config.remotes.map((remote) => remote.name)).toEqual(['billing']);
    expect(config.confidence).toBe('partial');
    expect(config.notes.join(' ')).toContain('not a literal');
  });

  it('reports none when there is no federation block at all', () => {
    const config = parseModuleFederationConfig(`export default { mode: 'production' };`, 'webpack.config.js');

    expect(config.confidence).toBe('none');
    expect(config.remotes).toEqual([]);
  });

  it('is not fooled by a comma inside a string', () => {
    const config = parseModuleFederationConfig(
      `export default { remotes: { billing: 'billing@http://h/a,b/remoteEntry.js' } };`,
      'webpack.config.js',
    );

    expect(config.remotes).toHaveLength(1);
    expect(config.remotes[0]!.entry).toBe('billing@http://h/a,b/remoteEntry.js');
  });
});
