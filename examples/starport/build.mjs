import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
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

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));

/** `tsconfig` lets a Braid checkout resolve the packages from source. */
export async function build({ out = join(here, 'dist'), tsconfig } = {}) {
  const target = resolve(out);
  // the folder is cleared first, so it must never be one that holds this example
  if (`${here}${sep}`.startsWith(`${target}${sep}`) || here.startsWith(`${target}${sep}`)) {
    throw new Error(`refusing to clear ${target}: --out must not contain the example itself`);
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
  await writeFile(join(target, '.nojekyll'), '');
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
