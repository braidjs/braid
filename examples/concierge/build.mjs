import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';

/**
 * Builds Concierge into a folder: the static files a browser loads, the server's library, and the
 * prerendered trip screen — every variant, for every web renderer the app serves.
 *
 *   node build.mjs [--out dist]
 *
 *   public/            index.html (a template), host.css, gallery.html, main.js, fragments/
 *   server/lib.mjs     what server.mjs runs: prerendering, the agent's projector
 *   prerendered/       trip/<hash>.jsonl and .html, and index.json
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const MARKER = '.concierge-build';

/** `tsconfig` lets a Braid checkout resolve the packages from source. */
export async function build({ out = join(here, 'dist'), tsconfig } = {}) {
  const target = resolve(out);
  const existing = await readdir(target).catch(() => []);
  if (existing.length > 0 && !existing.includes(MARKER))
    throw new Error(
      `refusing to clear ${target}: it is not empty and was not written by this build`,
    );
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(target, MARKER), '');
  await cp(join(here, 'public'), join(target, 'public'), { recursive: true });

  const bundle = (entry, outfile, platform) =>
    esbuild({
      entryPoints: [join(here, entry)],
      outfile: join(target, outfile),
      bundle: true,
      format: 'esm',
      platform,
      target: platform === 'node' ? 'node20' : 'es2022',
      logLevel: 'silent',
      loader: { '.jsonl': 'text' },
      ...(tsconfig ? { tsconfig: resolve(tsconfig) } : {}),
    });
  await Promise.all([
    bundle('src/main.js', 'public/main.js', 'browser'),
    // the flights team's build, standing in for theirs: a separate bundle, a separate realm
    bundle(
      'src/fragments/flight-card.js',
      'public/fragments/flight-card.js',
      'browser',
    ),
    bundle('src/server-lib.js', 'server/lib.mjs', 'node'),
  ]);

  // Prerendering is part of publishing: every variant is written now, not computed per request.
  const lib = await import(
    `${pathToFileURL(join(target, 'server/lib.mjs')).href}?${Date.now()}`
  );
  for (const [path, content] of lib.prerender()) {
    const file = join(target, 'prerendered', path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--out');
  const out = await build({
    ...(flag > 0 ? { out: process.argv[flag + 1] } : {}),
    ...(process.env.BRAID_TSCONFIG
      ? { tsconfig: process.env.BRAID_TSCONFIG }
      : {}),
  });
  console.log(`Concierge built into ${out}`);
}
