import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PendingPromotion, RefMove, SnapshotStore, SnapshotRef } from './store.js';
import { compareRefs, isAfterCursor, isEnvironmentName, toRef } from './store.js';
import { parseSnapshot, serializeSnapshot, SNAPSHOT_ID_PREFIX } from './snapshot.js';
import type { RegistrySnapshot } from './snapshot.js';

export interface FileSnapshotStoreOptions {
  /** Directory to hold `<id>.json` plus a `HEAD` file. Created on first write. */
  directory: string;
}

/**
 * A filesystem snapshot store: one JSON file per snapshot, plus a `HEAD` file naming the most
 * recent publish.
 *
 * Two roles, and it is genuinely good at both. As a **primary store** it suits a single-instance
 * deployment or a config volume baked into an image. As the **local cache** behind
 * `snapshotRegistry({ cache })` it is the right choice precisely because it is durable — the
 * failure that fallback exists to cover is a cold boot against an unreachable store, which an
 * in-memory cache cannot help with because nothing has been cached yet.
 *
 * Writes are atomic by rename, so a process dying mid-write leaves the previous bytes intact
 * rather than a truncated file that would fail content verification on the next boot.
 */
export function fileSnapshotStore(options: FileSnapshotStoreOptions): SnapshotStore {
  const { directory } = options;

  return {
    async get(id) {
      if (!isSafeId(id)) return null;
      try {
        return parseSnapshot(await readFile(pathFor(id), 'utf8'));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async put(snapshot) {
      await mkdir(directory, { recursive: true });
      await writeAtomic(pathFor(snapshot.id), serializeSnapshot(snapshot));
    },

    async list({ limit, before } = {}) {
      let entries: string[];
      try {
        entries = await readdir(directory);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }

      const refs: SnapshotRef[] = [];
      for (const entry of entries) {
        if (!entry.startsWith(SNAPSHOT_ID_PREFIX) || !entry.endsWith('.json')) continue;
        try {
          refs.push(toRef(parseSnapshot(await readFile(join(directory, entry), 'utf8'))));
        } catch {
          // A file that is not a readable snapshot is not a reason to fail the listing; it is
          // reported by verification when something tries to serve it.
        }
      }

      refs.sort(compareRefs);
      const page = before === undefined ? refs : refs.filter((ref) => isAfterCursor(ref, before));
      return limit === undefined ? page : page.slice(0, limit);
    },

    async head() {
      try {
        const id = (await readFile(join(directory, 'HEAD'), 'utf8')).trim();
        return id || null;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async setHead(id) {
      await mkdir(directory, { recursive: true });
      await writeAtomic(join(directory, 'HEAD'), `${id}\n`);
    },

    // Environments live beside HEAD: refs/<env> is the current id, refs/<env>.log one JSON move per
    // line (newest last on disk, newest first when read), pending/<env>.json an awaited approval.
    async ref(environment) {
      if (!isEnvironmentName(environment)) return null;
      return (await readOptional(join(directory, 'refs', environment)))?.trim() || null;
    },

    async setRef(environment, id, by = null) {
      if (!isEnvironmentName(environment)) throw new Error(`braid-registry: invalid environment name "${environment}"`);
      if (!isSafeId(id)) throw new Error(`braid-registry: invalid snapshot id "${id}"`);
      if (!(await readOptional(pathFor(id)))) throw new Error(`braid-registry: cannot point ${environment} at unknown snapshot "${id}"`);
      await mkdir(join(directory, 'refs'), { recursive: true });
      // The ref first: a crash between the two then loses a log line, rather than logging a move
      // that never happened — which a rollback would trust as "served before".
      await writeAtomic(join(directory, 'refs', environment), `${id}\n`);
      await appendFile(join(directory, 'refs', `${environment}.log`), `${JSON.stringify({ id, at: new Date().toISOString(), by })}\n`);
    },

    async refLog(environment, { limit } = {}) {
      if (!isEnvironmentName(environment)) return [];
      const text = await readOptional(join(directory, 'refs', `${environment}.log`));
      const moves = (text ?? '')
        .split('\n')
        .filter(Boolean)
        .flatMap((line): RefMove[] => {
          try {
            return [JSON.parse(line) as RefMove];
          } catch {
            return []; // a torn last line from a crash is not the whole log
          }
        })
        .reverse();
      return limit === undefined ? moves : moves.slice(0, limit);
    },

    async pending(environment) {
      if (!isEnvironmentName(environment)) return null;
      const text = await readOptional(join(directory, 'pending', `${environment}.json`));
      return text ? (JSON.parse(text) as PendingPromotion) : null;
    },

    async setPending(environment, value) {
      if (!isEnvironmentName(environment)) throw new Error(`braid-registry: invalid environment name "${environment}"`);
      const path = join(directory, 'pending', `${environment}.json`);
      if (!value) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(join(directory, 'pending'), { recursive: true });
      await writeAtomic(path, JSON.stringify(value));
    },
  };

  async function readOptional(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  function pathFor(id: string): string {
    return join(directory, `${id}.json`);
  }
}

/** Snapshot ids are content addresses, so anything else is a path traversal attempt. */
function isSafeId(id: string): boolean {
  return new RegExp(`^${SNAPSHOT_ID_PREFIX}[0-9a-f]{8,64}$`).test(id);
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(temporary, path);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export type { RegistrySnapshot };
