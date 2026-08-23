#!/usr/bin/env node
/**
 * Refuses to let an unpublishable Angular library reach `nx release publish`.
 *
 * Why this exists: `ngc` in *full* compilation mode injects a `prepublishOnly` script into the
 * emitted package.json that fails `npm publish` on purpose — full-mode output is locked to one
 * exact Angular version and must never ship. CI's `npm pack --dry-run` does not run
 * `prepublishOnly` (only `publish` does), so a library built in full mode passes every CI check
 * and then fails the release. Two of seventeen packages did exactly that on the first dry run.
 *
 * Two checks, because they catch different things:
 *
 *   1. Source — every project built with `@nx/angular:package` must set
 *      `angularCompilerOptions.compilationMode: "partial"` in its production tsconfig. This names
 *      the cause, so the failure message says which file to fix.
 *   2. Output — no `@braidlabs/*` package.json under `dist/` may carry a `prepublishOnly` script.
 *      This names the symptom, so any *future* mechanism that produces unpublishable output is
 *      caught even if it is not the one above.
 *
 * Run after `build`, before `publish`. Exits 1 with every violation listed, not just the first.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const root = resolve(new URL('../../', import.meta.url).pathname);
const failures = [];

// --- 1. source: partial compilation on every Angular package project -------------------------

function* projectFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* projectFiles(path);
    else if (entry === 'project.json') yield path;
  }
}

function readJson(path) {
  // tsconfig files may carry comments; strip line comments only — block comments are rare here.
  const text = readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(text);
}

for (const projectPath of projectFiles(join(root, 'libs'))) {
  const project = readJson(projectPath);
  const build = project.targets?.build;
  if (build?.executor !== '@nx/angular:package') continue;

  const configName = build.defaultConfiguration ?? 'production';
  const tsConfigRel = build.configurations?.[configName]?.tsConfig ?? build.options?.tsConfig;
  if (!tsConfigRel) {
    failures.push(`${project.name}: no tsConfig on the "${configName}" build configuration`);
    continue;
  }

  const tsConfigPath = join(root, tsConfigRel);
  if (!existsSync(tsConfigPath)) {
    failures.push(`${project.name}: ${tsConfigRel} does not exist`);
    continue;
  }

  const mode = readJson(tsConfigPath).angularCompilerOptions?.compilationMode;
  if (mode !== 'partial') {
    failures.push(
      `${project.name}: ${tsConfigRel} has compilationMode ${JSON.stringify(mode ?? 'unset')} — ` +
        `set angularCompilerOptions.compilationMode to "partial" or npm publish will refuse it`,
    );
  }
}

// --- 2. output: no publish-blocking script in anything we ship ------------------------------

function* distPackages(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!statSync(path).isDirectory()) continue;
    const pkg = join(path, 'package.json');
    if (existsSync(pkg)) yield pkg;
    else yield* distPackages(path); // libs/angular/* nests one level deeper
  }
}

let shipped = 0;
for (const pkgPath of distPackages(join(root, 'dist', 'libs'))) {
  const pkg = readJson(pkgPath);
  if (!pkg.name?.startsWith('@braidlabs/')) continue;
  shipped += 1;
  if (pkg.scripts?.prepublishOnly) {
    failures.push(
      `${pkg.name}: ${dirname(pkgPath).replace(root + '/', '')}/package.json carries a prepublishOnly ` +
        `script — this output was compiled in full mode and cannot be published`,
    );
  }
}

if (shipped === 0) {
  failures.push('no @braidlabs/* packages found under dist/libs — run the build before this check');
}

// --- report -------------------------------------------------------------------------------

if (failures.length > 0) {
  console.error('\nrelease check: unpublishable output\n');
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error('');
  process.exit(1);
}

console.log(`release check: ${shipped} @braidlabs packages publishable, every Angular library in partial mode`);
