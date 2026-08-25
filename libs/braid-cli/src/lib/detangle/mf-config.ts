/**
 * Reading a Module Federation config **without executing it**.
 *
 * The obvious implementation imports the file and reads the object. It is also the wrong one for a
 * command whose entire promise is that it writes nothing until you say so: an MF config is ordinary
 * TypeScript that can read env vars, hit the filesystem, or call into a build plugin, and a dry run
 * that executes arbitrary workspace code is not a dry run.
 *
 * So this extracts statically, and — the part that makes it honest — **says when it could not**.
 * A config whose `remotes` come from a variable, a spread, or a function call yields
 * `confidence: 'partial'` with the reason, and `braid detangle` prints that as a finding rather
 * than silently converting a topology it guessed at.
 */

export type Confidence = 'exact' | 'partial' | 'none';

export interface RemoteRef {
  /** The remote's MF name, as the shell refers to it. */
  name: string;
  /** Where the shell was told to find it, when the config states one. */
  entry?: string;
}

export interface ModuleFederationConfig {
  /** The project's own MF name. */
  name?: string;
  remotes: RemoteRef[];
  exposes: Record<string, string>;
  /** `shared` singleton keys — reported, never converted. See the plan's scope section. */
  shared: string[];
  confidence: Confidence;
  /** Why the read is partial, in terms a developer can act on. */
  notes: string[];
  /** Which file this came from, relative to the workspace root. */
  file: string;
}

const EMPTY: Omit<ModuleFederationConfig, 'file'> = {
  remotes: [],
  exposes: {},
  shared: [],
  confidence: 'none',
  notes: [],
};

/** Filenames that carry an MF config, in the order Nx and webpack look for them. */
export const MF_CONFIG_FILES = [
  'module-federation.config.ts',
  'module-federation.config.js',
  'webpack.config.ts',
  'webpack.config.js',
  'rspack.config.ts',
  'rspack.config.js',
] as const;

export function parseModuleFederationConfig(source: string, file: string): ModuleFederationConfig {
  const result: ModuleFederationConfig = { ...EMPTY, remotes: [], exposes: {}, shared: [], notes: [], file };

  const name = matchStringProperty(source, 'name');
  if (name) result.name = name;

  const remotes = extractBlock(source, 'remotes');
  const exposes = extractBlock(source, 'exposes');
  const shared = extractBlock(source, 'shared');

  if (!remotes && !exposes) {
    result.confidence = 'none';
    result.notes.push('no `remotes` or `exposes` found');
    return result;
  }

  if (remotes) {
    const parsed = parseRemotes(remotes.body, remotes.kind);
    result.remotes = parsed.remotes;
    result.notes.push(...parsed.notes);
    if (parsed.notes.length > 0) result.confidence = 'partial';
  }

  if (exposes) {
    const parsed = parseRecord(exposes.body);
    result.exposes = parsed.entries;
    if (parsed.skipped > 0) {
      result.confidence = 'partial';
      result.notes.push(`${parsed.skipped} \`exposes\` entr${parsed.skipped === 1 ? 'y is' : 'ies are'} not a string literal`);
    }
  }

  if (shared) {
    result.shared = parseSharedKeys(shared.body);
  }

  if (result.confidence !== 'partial') result.confidence = 'exact';
  return result;
}

/**
 * Finds `<key>: [ … ]` or `<key>: { … }` and returns its body, balanced.
 *
 * A regex cannot balance brackets, so this scans. Nested objects inside `remotes` are common
 * (`{ billing: { type: 'module', remoteEntry: '…' } }`) and a non-scanning match would stop at the
 * first `}` and silently drop every remote after it.
 */
function extractBlock(source: string, key: string): { body: string; kind: '[' | '{' } | undefined {
  const start = new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*([[{])`, 'm').exec(source);
  if (!start) return undefined;

  const open = start[1] as '[' | '{';
  const close = open === '[' ? ']' : '}';
  const from = start.index + start[0].length;

  let depth = 1;
  let inString: string | undefined;
  for (let i = from; i < source.length; i++) {
    const char = source[i]!;
    if (inString) {
      if (char === '\\') i++;
      else if (char === inString) inString = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') inString = char;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return { body: source.slice(from, i), kind: open };
  }
  return undefined;
}

function parseRemotes(body: string, kind: '[' | '{'): { remotes: RemoteRef[]; notes: string[] } {
  const remotes: RemoteRef[] = [];
  const notes: string[] = [];

  if (kind === '[') {
    // `remotes: ['billing', 'reviews']`, or `[['billing', 'http://…/remoteEntry.js']]`
    for (const entry of splitTopLevel(body)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      const tuple = /^\[\s*(['"`])(.+?)\1\s*,\s*(['"`])(.+?)\3/.exec(trimmed);
      if (tuple) {
        remotes.push({ name: tuple[2]!, entry: tuple[4]! });
        continue;
      }

      const bare = /^(['"`])(.+?)\1$/.exec(trimmed);
      if (bare) {
        remotes.push({ name: bare[2]! });
        continue;
      }

      notes.push(`a \`remotes\` entry is not a literal (${preview(trimmed)}) — its remote was not detected`);
    }
    return { remotes, notes };
  }

  // `remotes: { billing: 'http://…/remoteEntry.js' }`
  for (const entry of splitTopLevel(body)) {
    const pair = /^\s*(['"`]?)([\w$-]+)\1\s*:\s*(.*)$/s.exec(entry);
    if (!pair) {
      if (entry.trim()) notes.push(`a \`remotes\` entry could not be read (${preview(entry)})`);
      continue;
    }
    const value = /^(['"`])(.+?)\1/.exec(pair[3]!.trim());
    remotes.push({ name: pair[2]!, ...(value ? { entry: value[2]! } : {}) });
  }
  return { remotes, notes };
}

function parseRecord(body: string): { entries: Record<string, string>; skipped: number } {
  const entries: Record<string, string> = {};
  let skipped = 0;

  for (const entry of splitTopLevel(body)) {
    const pair = /^\s*(['"`])(.+?)\1\s*:\s*(['"`])(.+?)\3/.exec(entry);
    if (pair) entries[pair[2]!] = pair[4]!;
    else if (entry.trim()) skipped++;
  }
  return { entries, skipped };
}

function parseSharedKeys(body: string): string[] {
  const keys: string[] = [];
  for (const entry of splitTopLevel(body)) {
    const pair = /^\s*(['"`]?)([@\w$/.-]+)\1\s*:/.exec(entry);
    if (pair) keys.push(pair[2]!);
  }
  return keys;
}

/** Splits on commas that are not inside brackets or strings. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | undefined;
  let start = 0;

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (inString) {
      if (char === '\\') i++;
      else if (char === inString) inString = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') inString = char;
    else if (char === '[' || char === '{' || char === '(') depth++;
    else if (char === ']' || char === '}' || char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function matchStringProperty(source: string, key: string): string | undefined {
  return new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*(['"\`])(.+?)\\1`, 'm').exec(source)?.[2];
}

function preview(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}
