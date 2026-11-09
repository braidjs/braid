import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PreferenceBackend } from './preferences.js';

export interface FilePreferenceBackendOptions {
  /** Directory to hold one JSON file per user. Created on first write. */
  directory: string;
}

/**
 * Preferences on disk: one JSON file per subject, named by a hash of it, so no subject — whatever
 * it contains — can name a path outside `directory` or collide with another.
 *
 * For a single-instance gateway or a mounted volume. Writes are atomic by rename, and writes for
 * one subject run one at a time, so concurrent saves never lose each other's keys. Behind several
 * gateway instances, implement {@link PreferenceBackend} over your database instead.
 */
export function filePreferenceBackend(options: FilePreferenceBackendOptions): PreferenceBackend {
  const { directory } = options;
  /** The tail of each subject's queue of writes. */
  const queues = new Map<string, Promise<unknown>>();

  const fileFor = (subject: string) => join(directory, `${createHash('sha256').update(subject).digest('hex')}.json`);

  async function read(subject: string): Promise<Record<string, string>> {
    try {
      const file = JSON.parse(await readFile(fileFor(subject), 'utf8')) as { entries?: Record<string, string> };
      return Object.assign(Object.create(null) as Record<string, string>, file.entries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as Record<string, string>;
      throw error;
    }
  }

  function update(subject: string, change: (entries: Record<string, string>) => void): Promise<void> {
    const run = (queues.get(subject) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const entries = await read(subject);
      change(entries);
      await mkdir(directory, { recursive: true });
      const file = fileFor(subject);
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify({ entries }), 'utf8');
      await rename(temporary, file);
    });
    queues.set(subject, run);
    void run.finally(() => {
      if (queues.get(subject) === run) queues.delete(subject);
    }).catch(() => undefined);
    return run;
  }

  return {
    async get(subject, key) {
      await queues.get(subject)?.catch(() => undefined);
      return (await read(subject))[key];
    },
    set(subject, key, json) {
      return update(subject, (entries) => {
        entries[key] = json;
      });
    },
    delete(subject, key) {
      return update(subject, (entries) => {
        delete entries[key];
      });
    },
    async list(subject, prefix) {
      await queues.get(subject)?.catch(() => undefined);
      return Object.keys(await read(subject)).filter((key) => key.startsWith(prefix));
    },
  };
}
