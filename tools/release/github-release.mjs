#!/usr/bin/env node
/**
 * Publishes a version's CHANGELOG.md section as a GitHub release.
 *
 * Why this exists: until 0.7.0 the changelog lived only in CHANGELOG.md, so nothing on GitHub said
 * what a tag contained. `nx release changelog` can create GitHub releases itself, but it does so
 * during the changelog step — before the release workflow publishes to npm and pushes the tag, on
 * purpose, so a failed publish leaves no tag behind. A release made then would point at a tag that
 * does not exist yet, or outlive a publish that failed. This runs last, against the pushed tag.
 *
 *   node tools/release/github-release.mjs [version]
 *     Publishes (or updates) the release for v<version>, with that version's section of
 *     CHANGELOG.md as its notes. Without a version, the newest section in CHANGELOG.md.
 *     The tag must already be on GitHub. Only the newest tag is marked "latest", so
 *     publishing an older version's notes does not displace it.
 *
 * Needs `gh` authenticated (GH_TOKEN in CI).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('../../', import.meta.url).pathname);
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');

/** Each `## <version> (<date>)` section, newest first, as CHANGELOG.md lists them. */
const sections = [...changelog.matchAll(/^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b.*$/gm)].map((match, index, all) => ({
  version: match[1],
  notes: changelog.slice(match.index + match[0].length, all[index + 1]?.index ?? changelog.length).trim(),
}));

const version = process.argv[2] ?? sections[0]?.version;
const section = sections.find((entry) => entry.version === version);
if (!section) {
  console.error(`github-release: CHANGELOG.md has no section for ${version ?? '(any version)'}`);
  process.exit(1);
}

const tag = `v${version}`;
const gh = (args, input) => execFileSync('gh', args, { cwd: root, input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'] });

const newestTag = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { cwd: root, encoding: 'utf8' }).split('\n')[0];
const latest = tag === newestTag ? 'true' : 'false';

let exists = true;
try {
  // quiet: "release not found" is the expected answer for a new version
  execFileSync('gh', ['release', 'view', tag, '--json', 'tagName'], { cwd: root, stdio: 'ignore' });
} catch {
  exists = false;
}

if (exists) {
  gh(['release', 'edit', tag, '--title', tag, '--notes-file', '-', `--latest=${latest}`], section.notes);
  console.log(`github-release: updated ${tag}`);
} else {
  gh(['release', 'create', tag, '--verify-tag', '--title', tag, '--notes-file', '-', `--latest=${latest}`], section.notes);
  console.log(`github-release: published ${tag}`);
}
