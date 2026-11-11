import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

/**
 * Builds Starport into a folder of static files. That folder is the whole deployment: put it on
 * any static host, at the root or under a path.
 *
 *   node build.mjs [--out dist]
 *
 *   index.html, shell.css   the desk
 *   main.js                 the desk's runtime
 *   sw.js                   the Braid gateway, as a service worker
 *   apps/{id}/              each app: its page and its script
 */

const here = fileURLToPath(new URL('.', import.meta.url));
/** Says a folder is this build's output, and so safe for the next build to clear. */
const MARKER = '.starport-build';

/** `tsconfig` lets a Braid checkout resolve the packages from source. */
export async function build({ out = join(here, 'dist'), tsconfig } = {}) {
  const target = resolve(out);
  // The folder is cleared first. So it is only ever one this build made (it leaves a marker), or
  // one that is empty or not there yet: a mistyped --out cannot take anything else with it.
  const existing = await readdir(target).catch(() => []);
  if (existing.length > 0 && !existing.includes(MARKER)) {
    throw new Error(`refusing to clear ${target}: it is not empty and was not written by this build`);
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(join(here, 'public', 'shell'), target, { recursive: true });
  await cp(join(here, 'public', 'apps'), join(target, 'apps'), { recursive: true });

  const apps = await readdir(join(here, 'public', 'apps'));
  const bundle = (entry, outfile, format) =>
    esbuild({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format,
      platform: 'browser',
      target: 'es2022',
      logLevel: 'silent',
      // relative to where the build was started, as the path was given
      ...(tsconfig ? { tsconfig: resolve(tsconfig) } : {}),
    });
  await Promise.all([
    bundle(join(here, 'src', 'main.js'), join(target, 'main.js'), 'esm'),
    bundle(join(here, 'src', 'sw.js'), join(target, 'sw.js'), 'esm'),
    // An app's script is a classic script, as an app that has never heard of Braid would ship.
    // Bundling it is this example's stand-in for that app's own build.
    ...apps.map((id) => bundle(join(here, 'public', 'apps', id, 'app.js'), join(target, 'apps', id, 'app.js'), 'iife')),
  ]);
  await writeFile(join(target, MARKER), '');
  return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--out');
  const out = await build({
    ...(flag > 0 ? { out: process.argv[flag + 1] } : {}),
    ...(process.env.BRAID_TSCONFIG ? { tsconfig: process.env.BRAID_TSCONFIG } : {}),
  });
  console.log(`Starport built into ${out}`);
}
