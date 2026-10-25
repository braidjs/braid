// Builds the public site into a folder of static files: no server, no gateway.
//
//   node apps/site/build.mjs --out dist/apps/site
//
// 1. bundles the host runtime (`core.js`) and each contract fragment (`f/<name>/main.js`)
// 2. bundles the page templates for Node, runs them, and writes each page's HTML
//    (every homepage section is prerendered, so the page reads fine before any JavaScript)
// 3. copies the static files (stylesheet, favicon)
import { build } from 'esbuild';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '../..');

/** True when `path` is strictly inside `parent`. */
const within = (parent, path) => {
  const rel = relative(parent, path);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** True for a path inside the system temp directory (where the spec builds), symlinks resolved. */
const inTempDir = (path) => {
  try {
    return within(realpathSync(tmpdir()), join(realpathSync(dirname(path)), basename(path)));
  } catch {
    return false;
  }
};

export async function buildSite(outDir) {
  const out = resolve(workspace, outDir);
  // The output is cleared first, so a mistyped or empty --out must never point at the repo itself.
  const holdsWorkspace = out === workspace || within(out, workspace);
  if (holdsWorkspace || (!within(join(workspace, 'dist'), out) && !inTempDir(out))) {
    throw new Error(`refusing to clear ${out}: --out must be inside ${join(workspace, 'dist')} or the system temp directory`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const shared = {
    bundle: true,
    format: 'esm',
    target: 'es2022',
    tsconfig: join(workspace, 'tsconfig.base.json'),
    loader: { '.html': 'text', '.css': 'text' },
    logLevel: 'warning',
  };

  // 1. the browser bundles
  const fragments = readdirSync(join(here, 'src/fragments'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  await build({
    ...shared,
    platform: 'browser',
    minify: true,
    sourcemap: true,
    entryPoints: {
      core: join(here, 'src/host/main.ts'),
      contact: join(here, 'src/host/contact.ts'),
      ...Object.fromEntries(fragments.map((name) => [`f/${name}/main`, join(here, `src/fragments/${name}/main.ts`)])),
    },
    outdir: out,
  });

  // 2. the pages, prerendered in Node
  const scratch = mkdtempSync(join(tmpdir(), 'braid-site-'));
  try {
    const pagesModule = join(scratch, 'pages.mjs');
    await build({ ...shared, platform: 'node', entryPoints: [join(here, 'src/pages/index.ts')], outfile: pagesModule });
    const { pages } = await import(pathToFileURL(pagesModule).href);
    for (const page of pages) {
      const file = join(out, page.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, page.html);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // 3. static files
  cpSync(join(here, 'src/static'), out, { recursive: true });

  return { out, fragments };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--out');
  const outDir = flag > 0 ? process.argv[flag + 1] : 'dist/apps/site';
  const { out, fragments } = await buildSite(outDir);
  console.log(`site → ${out} (${fragments.length} fragments: ${fragments.join(', ')})`);
}
