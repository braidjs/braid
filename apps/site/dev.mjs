// Local development with a working contact form, and no AWS:
//
//   node apps/site/dev.mjs [--port 8787]        (or: npx nx run site:dev)
//
// Bundles aws/local.ts (the real contact handler with local stand-ins) and starts serve.mjs with it,
// so the built site and POST /api/contact are served together.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '../..');
const flag = process.argv.indexOf('--port');
const port = flag > 0 ? process.argv[flag + 1] : '8787';

const scratch = mkdtempSync(join(tmpdir(), 'braid-site-dev-'));
const api = join(scratch, 'api.mjs');
await build({
  entryPoints: [join(here, 'aws/local.ts')],
  outfile: api,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  tsconfig: join(workspace, 'tsconfig.base.json'),
  logLevel: 'warning',
});

const server = spawn(
  process.execPath,
  [join(here, 'serve.mjs'), '--dir', join(workspace, 'dist/apps/site'), '--port', port, '--api', api],
  { stdio: 'inherit' },
);
server.on('exit', (code) => {
  rmSync(scratch, { recursive: true, force: true });
  process.exit(code ?? 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
