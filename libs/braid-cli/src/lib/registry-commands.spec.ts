import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FragmentManifest } from '@braidlabs/gateway';
import { parseSnapshot } from '@braidlabs/registry';
import { registry } from './registry-commands.js';

/** Strips ANSI so assertions read as plain text. */
// eslint-disable-next-line no-control-regex -- matching escape sequences is the point
const plain = (text: string) => text.replace(/?\[[0-9;]*m/g, '');

describe('braid registry', () => {
  let directory: string;
  let stdout: string;
  let stderr: string;
  let restore: () => void;

  const healthy: FragmentManifest[] = [
    { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'], title: 'Billing' },
    { id: 'reviews', endpoint: 'https://reviews.internal' },
  ];

  async function writeConfig(fragments: unknown[]): Promise<string> {
    const path = join(directory, 'braid.config.json');
    await writeFile(path, JSON.stringify({ port: 4000, shell: { port: 4200 }, fragments }));
    return path;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'braid-registry-'));
    stdout = '';
    stderr = '';

    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => ((stdout += chunk), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => ((stderr += chunk), true)) as typeof process.stderr.write;
    restore = () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    };
  });

  afterEach(async () => {
    restore();
    await rm(directory, { recursive: true, force: true });
  });

  describe('validate', () => {
    it('exits 0 on a healthy registry', async () => {
      const config = await writeConfig(healthy);

      expect(await registry(['validate', '--config', config])).toBe(0);
      expect(plain(stdout)).toContain('2 fragments, no conflicts');
    });

    it('exits 1 and names the problem on an error', async () => {
      const config = await writeConfig([{ id: 'billing', endpoint: '/relative' }]);

      expect(await registry(['validate', '--config', config])).toBe(1);
      expect(plain(stdout)).toContain('not an absolute URL');
    });

    it('reports a pierce conflict without failing the run', async () => {
      const config = await writeConfig([
        { id: 'shell', endpoint: 'https://s.internal', pierce: ['/*'] },
        { id: 'billing', endpoint: 'https://b.internal', pierce: ['/billing/*'] },
      ]);

      expect(await registry(['validate', '--config', config])).toBe(0);
      expect(plain(stdout)).toContain('both pierce the same page URLs');
    });
  });

  describe('publish', () => {
    it('writes a snapshot and points HEAD at it', async () => {
      const config = await writeConfig(healthy);
      const out = join(directory, 'snapshots');

      expect(await registry(['publish', '--config', config, '--to', out])).toBe(0);

      const id = plain(stdout).match(/reg_[0-9a-f]{32}/)?.[0];
      expect(id).toBeDefined();
      expect((await readFile(join(out, 'HEAD'), 'utf8')).trim()).toBe(id);

      const snapshot = parseSnapshot(await readFile(join(out, `${id}.json`), 'utf8'));
      expect(snapshot.manifests.map((m) => m.id)).toEqual(['billing', 'reviews']);
    });

    it('excludes dev scaffolding, so two developers publish the same id', async () => {
      const withDev = await writeConfig([{ ...healthy[0]!, dev: { port: 4301 } }]);
      const withoutDev = await writeConfig([healthy[0]!]);

      await registry(['publish', '--config', withDev, '--dry-run']);
      const first = plain(stdout).match(/reg_[0-9a-f]{32}/)?.[0];
      stdout = '';
      await registry(['publish', '--config', withoutDev, '--dry-run']);
      const second = plain(stdout).match(/reg_[0-9a-f]{32}/)?.[0];

      expect(first).toBe(second);
    });

    it('refuses to publish a registry with errors', async () => {
      const config = await writeConfig([{ id: 'billing', endpoint: '/relative' }]);

      expect(await registry(['publish', '--config', config, '--to', join(directory, 'out')])).toBe(1);
      expect(plain(stderr)).toContain('refusing to publish');
    });

    it('writes nothing on --dry-run', async () => {
      const config = await writeConfig(healthy);
      const out = join(directory, 'snapshots');

      expect(await registry(['publish', '--config', config, '--to', out, '--dry-run'])).toBe(0);
      expect(plain(stdout)).toContain('dry run');
      await expect(readFile(join(out, 'HEAD'), 'utf8')).rejects.toThrow();
    });

    it('keeps labels out of the content address', async () => {
      const config = await writeConfig(healthy);

      await registry(['publish', '--config', config, '--dry-run', '--label', 'by=ada']);
      const first = plain(stdout).match(/reg_[0-9a-f]{32}/)?.[0];
      stdout = '';
      await registry(['publish', '--config', config, '--dry-run', '--label', 'by=grace']);

      expect(plain(stdout).match(/reg_[0-9a-f]{32}/)?.[0]).toBe(first);
    });
  });

  /**
   * `--source` reads the registry from a module instead of braid.config, which is how a composed
   * registry — a `supergraph([...])` — gets validated and published in CI without restating it as
   * config.
   */
  describe('--source', () => {
    async function writeSource(name: string, body: string): Promise<string> {
      const path = join(directory, name);
      await writeFile(path, body);
      return path;
    }

    it('validates a module whose default export is an array of manifests', async () => {
      const source = await writeSource('registry.mjs', `export default ${JSON.stringify(healthy)};`);

      expect(await registry(['validate', '--source', source])).toBe(0);
      expect(plain(stdout)).toContain('2 fragments, no conflicts');
    });

    it('publishes from a module whose default export is a registry function', async () => {
      const source = await writeSource('registry.mjs', `export default async () => (${JSON.stringify(healthy)});`);
      const fromConfig = await writeConfig(healthy);

      expect(await registry(['publish', '--source', source, '--dry-run'])).toBe(0);
      const fromSourceOutput = plain(stdout);
      stdout = '';
      expect(await registry(['publish', '--config', fromConfig, '--dry-run'])).toBe(0);

      // the same manifests make the same content address, wherever they were read from
      const id = /reg_[0-9a-f]+/;
      expect(fromSourceOutput.match(id)?.[0]).toBeDefined();
      expect(fromSourceOutput.match(id)?.[0]).toBe(plain(stdout).match(id)?.[0]);
    });

    it('fails a composed registry that two subgraphs both claim a fragment of', async () => {
      const source = await writeSource(
        'supergraph.mjs',
        `import { subgraph, supergraph } from '@braidlabs/registry';
         export default supergraph([
           subgraph({ name: 'orders', url: 'https://orders.internal', registry: [{ id: 'cart', endpoint: 'x:' }] }),
           subgraph({ name: 'checkout', url: 'https://checkout.internal', registry: [{ id: 'cart', endpoint: 'x:' }] }),
         ]);`,
      );

      expect(await registry(['publish', '--source', source, '--dry-run'])).toBe(1);
      expect(stderr).toMatch(/"cart" is claimed by both subgraph "orders" and subgraph "checkout"/);
    });

    it('fails a source whose registry has validation errors', async () => {
      const source = await writeSource('registry.mjs', `export default [{ id: 'billing', endpoint: '/relative' }];`);

      expect(await registry(['validate', '--source', source])).toBe(1);
      expect(plain(stdout)).toContain('not an absolute URL');
    });

    it('names the module when its default export is not a registry', async () => {
      const source = await writeSource('registry.mjs', `export default { manifests: [] };`);

      expect(await registry(['validate', '--source', source])).toBe(1);
      expect(stderr).toContain('registry.mjs');
      expect(stderr).toContain('default export');
    });

    it('refuses a --source with no module, rather than falling back to braid.config', async () => {
      await writeConfig(healthy);

      expect(await registry(['validate', '--source'])).toBe(1);
      expect(await registry(['validate', '--source', '--dry-run'])).toBe(1);
      expect(stderr).toContain('--source needs a module path');
    });

    it('takes principals for access from --as only, never from a braid.config up the tree', async () => {
      const previous = process.cwd();
      await writeFile(
        join(directory, 'braid.config.json'),
        JSON.stringify({ port: 4000, shell: { port: 4200 }, fragments: [], principals: { trader: { roles: ['trader'] } } }),
      );
      const source = await writeSource('registry.mjs', `export default ${JSON.stringify(healthy)};`);
      process.chdir(directory);
      try {
        expect(await registry(['access', '--source', source])).toBe(0);
      } finally {
        process.chdir(previous);
      }

      expect(plain(stdout)).toContain('anonymous');
      expect(plain(stdout)).not.toContain('trader');
    });

    it('refuses --source together with --config, rather than picking one', async () => {
      const source = await writeSource('registry.mjs', `export default [];`);
      const config = await writeConfig(healthy);

      expect(await registry(['validate', '--source', source, '--config', config])).toBe(1);
      expect(stderr).toContain('either --source or --config');
    });
  });

  describe('diff', () => {
    it('reports an unchanged registry as identical', async () => {
      const config = await writeConfig(healthy);
      const out = join(directory, 'snapshots');
      await registry(['publish', '--config', config, '--to', out]);
      stdout = '';

      expect(await registry(['diff', '--config', config, '--against', out])).toBe(0);
      expect(plain(stdout)).toContain('identical');
    });

    it('labels a routing change as gateway-owned', async () => {
      const published = await writeConfig(healthy);
      const out = join(directory, 'snapshots');
      await registry(['publish', '--config', published, '--to', out]);

      const changed = await writeConfig([{ ...healthy[0]!, pierce: ['/billing/*', '/invoices/*'] }, healthy[1]!]);
      stdout = '';

      expect(await registry(['diff', '--config', changed, '--against', out])).toBe(0);
      const output = plain(stdout);
      expect(output).toContain('pierce');
      expect(output).toContain('gateway');
      expect(output).toContain('1 gateway-owned field');
    });

    it('reports additions and removals', async () => {
      const published = await writeConfig(healthy);
      const out = join(directory, 'snapshots');
      await registry(['publish', '--config', published, '--to', out]);

      const changed = await writeConfig([healthy[0]!, { id: 'rating', endpoint: 'https://r.internal' }]);
      stdout = '';
      await registry(['diff', '--config', changed, '--against', out]);

      const output = plain(stdout);
      expect(output).toContain('+ rating');
      expect(output).toContain('- reviews');
    });

    it('requires --against', async () => {
      const config = await writeConfig(healthy);

      expect(await registry(['diff', '--config', config])).toBe(1);
      expect(plain(stderr)).toContain('--against');
    });
  });

  describe('access', () => {
    const gated = [
      { id: 'billing', endpoint: 'https://b.internal' },
      { id: 'payroll', endpoint: 'https://p.internal', access: { fetch: { roles: ['payroll'] } } },
    ];

    it('shows who can list and load each fragment', async () => {
      const config = await writeConfig(gated);

      expect(await registry(['access', '--config', config, '--as', 'clerk'])).toBe(0);
      const output = plain(stdout);
      expect(output).toContain('anonymous');
      expect(output).toContain('clerk');
      expect(output).toContain('billing');
      expect(output).toContain('payroll');
    });

    it('always includes anonymous, even when principals are named', async () => {
      const config = await writeConfig(gated);
      await registry(['access', '--config', config, '--as', 'ops:roles=ops']);

      expect(plain(stdout)).toContain('anonymous');
    });

    it('reads principals from the config when no --as is given', async () => {
      const path = join(directory, 'braid.config.json');
      await writeFile(
        path,
        JSON.stringify({ port: 4000, shell: { port: 4200 }, fragments: gated, principals: { auditor: { roles: ['audit'] } } }),
      );

      await registry(['access', '--config', path]);

      expect(plain(stdout)).toContain('auditor');
    });

    it('reports what a tightened rule takes away', async () => {
      const published = await writeConfig(gated);
      const out = join(directory, 'snapshots');
      await registry(['publish', '--config', published, '--to', out]);

      const tightened = await writeConfig([
        { ...gated[0], access: { list: { roles: ['finance'] } } },
        gated[1],
      ]);
      stdout = '';
      await registry(['access', '--config', tightened, '--against', out, '--as', 'clerk']);

      const output = plain(stdout);
      expect(output).toContain('Access removed');
      expect(output).toContain('anonymous can no longer list billing');
    });

    it('names a removed fragment as the reason access went away', async () => {
      const published = await writeConfig(gated);
      const out = join(directory, 'snapshots');
      await registry(['publish', '--config', published, '--to', out]);

      const removed = await writeConfig([gated[0]]);
      stdout = '';
      await registry(['access', '--config', removed, '--against', out]);

      expect(plain(stdout)).toContain('(fragment removed)');
    });

    it('says so when a change touches no access at all', async () => {
      const published = await writeConfig(gated);
      const out = join(directory, 'snapshots');
      await registry(['publish', '--config', published, '--to', out]);

      const renamed = await writeConfig([{ ...gated[0], title: 'Renamed' }, gated[1]]);
      stdout = '';
      await registry(['access', '--config', renamed, '--against', out]);

      expect(plain(stdout)).toContain('no access changes');
    });
  });

  describe('impact', () => {
    const routed = [
      { id: 'billing', endpoint: 'https://b.internal', pierce: ['/billing/*'] },
      { id: 'reviews', endpoint: 'https://r.internal', pierce: ['/reviews/*'] },
    ];

    async function writeObservations(paths: [string, number][]): Promise<string> {
      const file = join(directory, 'observations.json');
      await writeFile(
        file,
        JSON.stringify({
          paths: paths.map(([pathname, count]) => ({
            pathname,
            count,
            fragmentIds: [],
            firstSeen: '2026-08-01T00:00:00.000Z',
            lastSeen: '2026-08-14T00:00:00.000Z',
          })),
          totalRequests: paths.reduce((sum, [, count]) => sum + count, 0),
          evicted: 0,
          since: '2026-08-01T00:00:00.000Z',
        }),
      );
      return file;
    }

    it('counts the traffic a narrowed pattern stops composing on', async () => {
      const published = await writeConfig(routed);
      const out = join(directory, 'snapshots');
      await registry(['publish', '--config', published, '--to', out]);

      const observations = await writeObservations([
        ['/billing/invoices', 40],
        ['/billing/settings', 3],
      ]);
      const narrowed = await writeConfig([{ ...routed[0], pierce: ['/billing/invoices'] }, routed[1]]);
      stdout = '';

      expect(
        await registry(['impact', '--config', narrowed, '--observations', observations, '--against', out]),
      ).toBe(0);

      const output = plain(stdout);
      expect(output).toContain('billing');
      expect(output).toContain('/billing/settings');
      expect(output).toContain('3 of 43 observed requests affected');
    });

    it('says so when observed traffic is unaffected', async () => {
      const published = await writeConfig(routed);
      const out = join(directory, 'snapshots');
      await registry(['publish', '--config', published, '--to', out]);

      const observations = await writeObservations([['/billing/x', 5]]);
      const renamed = await writeConfig([{ ...routed[0], title: 'Renamed' }, routed[1]]);
      stdout = '';
      await registry(['impact', '--config', renamed, '--observations', observations, '--against', out]);

      expect(plain(stdout)).toContain('no observed traffic changes what it composes');
    });

    it('requires both inputs, and says where observations come from', async () => {
      const config = await writeConfig(routed);

      expect(await registry(['impact', '--config', config])).toBe(1);
      expect(plain(stderr)).toContain('--observations');
      expect(plain(stderr)).toContain('observe');
    });

    it('reports a missing observations file rather than crashing', async () => {
      const published = await writeConfig(routed);
      const out = join(directory, 'snapshots');
      await registry(['publish', '--config', published, '--to', out]);
      stderr = '';

      expect(
        await registry(['impact', '--config', published, '--observations', join(directory, 'nope.json'), '--against', out]),
      ).toBe(1);
      expect(plain(stderr)).toContain('braid registry impact:');
    });
  });

  it('prints usage for an unknown subcommand', async () => {
    expect(await registry(['wat'])).toBe(1);
    expect(plain(stdout)).toContain('braid registry');
  });
});
