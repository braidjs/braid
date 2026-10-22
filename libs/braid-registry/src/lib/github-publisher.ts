import { serializeSnapshot, type RegistrySnapshot } from './snapshot.js';
import type { RegistryDiff, RegistryFinding } from './analysis.js';

/**
 * Where a validated publish goes instead of the store — the GitOps seam.
 *
 * With a publisher, `POST /snapshots` still validates, checks ownership and mints the snapshot,
 * but hands it to the publisher rather than storing it and moving HEAD. The publisher proposes
 * the change somewhere it gets reviewed (a pull request), and whatever deploys the registry from
 * there — CI syncing a store, a gateway reading a file store from a checkout — is what makes it
 * live. The response is 202: accepted, not yet done.
 */
export interface SnapshotPublisher {
  propose(proposal: SnapshotProposal): Promise<{ pullRequest: { url: string; number: number } }>;
}

export interface SnapshotProposal {
  snapshot: RegistrySnapshot;
  /** Whether merging should also move HEAD. False for a candidate. */
  pin: boolean;
  actor: string | null;
  /** What it changes about the snapshot HEAD pointed at, when there was one. */
  diff?: RegistryDiff;
  findings: readonly RegistryFinding[];
}

export interface GitHubPublisherOptions {
  owner: string;
  repo: string;
  /** A token that may create branches, write contents and open pull requests on the repository. */
  token: string;
  /** The branch pull requests target. Defaults to `main`. */
  base?: string;
  /**
   * The directory snapshots live in, in the same layout as `fileSnapshotStore`: `<id>.json` and a
   * `HEAD` file. Point a file store at a checkout of it and merging a pull request is publishing.
   * Defaults to `registry`.
   */
  directory?: string;
  /** For GitHub Enterprise Server: `https://github.example.com/api/v3`. */
  apiUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Proposes each publish as a GitHub pull request: a branch with the snapshot file (and, for a pin,
 * the new `HEAD`), and a pull request describing the change and who asked for it. Review and merge
 * are the approval; the registry API changes nothing until then.
 *
 * Uses the REST API directly — no client library, no git binary — so it runs wherever the registry
 * API does.
 */
export function githubPublisher(options: GitHubPublisherOptions): SnapshotPublisher {
  const { owner, repo, token, base = 'main', directory = 'registry', apiUrl = 'https://api.github.com' } = options;
  if (!/^https:\/\//i.test(apiUrl)) {
    throw new Error(`braid-registry: githubPublisher apiUrl "${apiUrl}" must be https — the token would otherwise travel in cleartext`);
  }
  const send = options.fetch ?? globalThis.fetch;
  const root = `${apiUrl.replace(/\/$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const dir = directory.replace(/^\/+|\/+$/g, '');

  async function github<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    const response = await send(`${root}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { message?: string };
      // The message is GitHub's; the token never appears in it or in the request URL.
      throw new GitHubPublishError(`GitHub ${method} ${path} failed with HTTP ${response.status}${detail.message ? `: ${detail.message}` : ''}`);
    }
    return (await response.json().catch(() => ({}))) as T;
  }

  const contentPath = (name: string) => `/contents/${[...dir.split('/').filter(Boolean), name].map(encodeURIComponent).join('/')}`;
  /** A branch name in a URL path: its slashes stay slashes (`release/1.x`), everything else is encoded. */
  const refPath = (name: string) => name.split('/').map(encodeURIComponent).join('/');

  return {
    async propose({ snapshot, pin, actor, diff, findings }) {
      const branch = `braid/publish-${snapshot.id.replace(/^reg_/, '').slice(0, 12)}-${Date.now().toString(36)}`;
      const who = actor ?? 'an unidentified caller';

      const ref = await github<{ object: { sha: string } }>('GET', `/git/ref/heads/${refPath(base)}`);
      await github('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: ref!.object.sha });

      try {
        return await proposeOnBranch(branch);
      } catch (error) {
        // Leave nothing behind for a proposal that did not happen. Best effort: the original error
        // is the one worth reporting.
        await github('DELETE', `/git/refs/heads/${refPath(branch)}`).catch(() => undefined);
        throw error;
      }

      async function proposeOnBranch(branch: string) {
      // A snapshot's id is its content, so a file already there is this file: republishing it (a
      // re-pin of an old candidate, a rollback by content) only needs HEAD to move.
      const existingSnapshot = await github<{ sha: string }>('GET', `${contentPath(`${snapshot.id}.json`)}?ref=${encodeURIComponent(branch)}`, undefined, true);
      if (!existingSnapshot) {
        await github('PUT', contentPath(`${snapshot.id}.json`), {
          message: `registry: add snapshot ${snapshot.id}`,
          content: base64(serializeSnapshot(snapshot)),
          branch,
        });
      }

      if (pin) {
        const existing = await github<{ sha: string }>('GET', `${contentPath('HEAD')}?ref=${encodeURIComponent(branch)}`, undefined, true);
        await github('PUT', contentPath('HEAD'), {
          message: `registry: pin ${snapshot.id}`,
          content: base64(`${snapshot.id}\n`),
          branch,
          ...(existing?.sha ? { sha: existing.sha } : {}),
        });
      }

      const changes = diff
        ? [`${diff.added.length} added`, `${diff.removed.length} removed`, `${diff.changed.length} changed`].join(', ')
        : 'the first snapshot';
      const warnings = findings.filter((finding) => finding.severity !== 'error');
      const pull = await github<{ html_url: string; number: number }>('POST', '/pulls', {
        title: `Registry: ${pin ? 'publish and pin' : 'publish candidate'} ${snapshot.id}`,
        head: branch,
        base,
        body: [
          `Requested by ${code(who)} through the Braid registry API.`,
          '',
          `- Snapshot: \`${snapshot.id}\` (${snapshot.manifests.length} fragments, ${(snapshot.shells ?? []).length} shells)`,
          `- Changes: ${changes}`,
          `- ${pin ? 'Merging moves HEAD to this snapshot.' : 'A candidate: merging stores it without moving HEAD.'}`,
          // Warnings quote fragment ids and patterns, which are publisher text: kept inside code
          // spans on one line, so they cannot add lines, mention people or link anywhere.
          ...(warnings.length > 0 ? ['', '**Warnings**', ...warnings.map((finding) => `- ${code(finding.message)}`)] : []),
        ].join('\n'),
      });

      return { pullRequest: { url: pull!.html_url, number: pull!.number } };
      }
    },
  };
}

/** A publisher failure: reported to the caller as a 502, since the registry API itself is fine. */
export class GitHubPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubPublishError';
  }
}

/** Base64 of a string's UTF-8 bytes, in chunks: spreading a large snapshot into one call overflows the stack. */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** Text as an inline Markdown code span: one line, fenced by more backticks than it contains. */
function code(text: string): string {
  const line = text.replace(/[\r\n]+/g, ' ');
  const longestRun = Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence} ${line} ${fence}`;
}
