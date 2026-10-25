// The CDK CLI's --app command: bundles infra/app.ts with esbuild, then runs it.
//
// The bundle is written inside cdk.out (gitignored) rather than a temp folder, so its imports of
// aws-cdk-lib resolve against the workspace's node_modules.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '../../..');
const outDir = join(here, 'cdk.out');
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, '.app.mjs');

await build({
  entryPoints: [join(here, 'app.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  tsconfig: join(workspace, 'tsconfig.base.json'),
  logLevel: 'warning',
});

process.env.BRAID_WORKSPACE = workspace;
await import(pathToFileURL(bundle).href);
