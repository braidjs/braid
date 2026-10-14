#!/usr/bin/env node
/**
 * Refuses to release a version npm already has.
 *
 * Why this exists: release run #11 was dispatched with the exact specifier "0.1.1", a version
 * published months earlier. `nx release publish` skips a version the registry already holds,
 * logs "Skipped package …", and still reports success — so the run went green, published
 * nothing, and pushed nothing. A version number is spent the moment npm takes it; asking for it
 * again is always a mistake, and it should fail loudly.
 *
 *   node tools/release/check-version-unspent.mjs <specifier>
 *     Before versioning. If the specifier is an exact version, every @braidlabs package in the
 *     workspace must not have it on npm yet. A bump keyword (patch, minor, …) passes here; the
 *     second form checks what it resolved to.
 *
 *   node tools/release/check-version-unspent.mjs
 *     After versioning. Every @braidlabs package under dist/ must carry a version npm does not
 *     have yet. (A dry run writes no manifests, so this form has nothing new to check there.)
 *
 * Exits 1 with every collision listed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('../../', import.meta.url).pathname);
const specifier = process.argv[2];
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function* manifests(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (!statSync(path).isDirectory()) continue;
    const pkg = join(path, 'package.json');
    if (existsSync(pkg)) yield pkg;
    else yield* manifests(path); // libs/angular/* nests one level deeper
  }
}

function braidPackages(dir) {
  const found = [];
  for (const path of manifests(dir)) {
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    if (pkg.name?.startsWith('@braidlabs/') && !pkg.private) found.push(pkg);
  }
  return found;
}

function publishedVersions(name) {
  try {
    const out = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const versions = JSON.parse(out || '[]');
    return new Set(Array.isArray(versions) ? versions : [versions]);
  } catch (error) {
    // A package that has never been published is the one case a lookup may fail.
    if (/E404|404 Not Found/.test(String(error.stderr ?? error.message)))
      return new Set();
    throw error;
  }
}

let targets;
if (specifier !== undefined) {
  if (!EXACT.test(specifier)) {
    console.log(
      `release check: "${specifier}" is a bump, not a version; checked after versioning`,
    );
    process.exit(0);
  }
  targets = braidPackages(join(root, 'libs')).map((pkg) => ({
    name: pkg.name,
    version: specifier,
  }));
} else {
  targets = braidPackages(join(root, 'dist', 'libs')).map(
    ({ name, version }) => ({ name, version }),
  );
}

if (targets.length === 0) {
  console.error('release check: no @braidlabs packages found to check');
  process.exit(1);
}

const spent = targets.filter(({ name, version }) =>
  publishedVersions(name).has(version),
);

if (spent.length > 0) {
  console.error('\nrelease check: version already on npm\n');
  for (const { name, version } of spent)
    console.error(`  ✗ ${name}@${version} is already published`);
  console.error(
    '\nA published version can never be published again. Re-run the release with a bump ' +
      '(patch | minor | major) or an exact version npm does not have yet.\n',
  );
  process.exit(1);
}

console.log(
  `release check: ${targets.length} @braidlabs packages, none of their versions on npm yet`,
);
