import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DetanglePlan } from './plan.js';

/**
 * Turning the shell into a host.
 *
 * This is the phase the plan's one design rule was written for — *detangle proposes; the developer
 * disposes* — because it is the only phase that edits code somebody wrote. Everything here therefore
 * produces an **edit description** rather than performing an edit: a file, a line, the text to
 * remove, the text to put there, and why. `--write` applies them; `--diff` prints them; a test
 * asserts them without a filesystem.
 *
 * The rule that shaped the rest: **an edit whose "before" cannot be located exactly is not made.**
 * A route array is easy to find and hard to rewrite correctly — guards, factories, nested children,
 * `providers` on the route object — and a codemod that half-rewrites one leaves a shell that neither
 * federates nor composes. Where the pattern is not exact, this reports the site and the intended
 * change and leaves the typing to a human who can see the surrounding code.
 */

export interface ShellEdit {
  /** Workspace-relative file. */
  file: string;
  /** 1-indexed line, when the site is known. */
  line?: number;
  /**
   * `insert` and `remove` are applied by `--write`; `manual` never is.
   *
   * The distinction is not about difficulty, it is about whether the exact "before" is known. An
   * `insert` adds a line at a place that cannot be wrong twice; a `remove` deletes a range this
   * module located precisely and re-verified. Everything else is `manual`, because a codemod that
   * half-rewrites a route array leaves a shell that neither federates nor composes — and that fails
   * at runtime rather than in a diff.
   */
  kind: 'insert' | 'remove' | 'replace' | 'manual';
  /** For `remove`: the 1-indexed inclusive line range to delete. */
  range?: { from: number; to: number };
  /**
   * For `insert`: a character offset, when the text must land *inside* a line.
   *
   * A provider belongs between the brackets of `providers: [ … ]`, and that array is written on one
   * line as often as not. Inserting a whole line there produces syntactically broken TypeScript —
   * which is how the first version of this put `provideClientHydration(…)` above the imports.
   */
  offset?: number;
  /** What the edit achieves, in one line. */
  summary: string;
  /** The text to insert or the replacement, when this is automatable. */
  text?: string;
  /** Why, for the diff output and for the developer reading it later. */
  why: string;
}

export interface ShellTransform {
  edits: ShellEdit[];
  /** Things the shell needs that could not be located at all. */
  followUps: string[];
}

/**
 * Files a shell keeps its bootstrap in. `main.ts` is where `initBraid` belongs — before any slot
 * connects — and `main.server.ts` is where Angular's server bootstrap lives.
 */
const BOOTSTRAP_FILES = ['src/main.ts', 'src/main.tsx', 'src/index.tsx', 'src/bootstrap.ts'];

export async function planShellTransform(
  workspaceRoot: string,
  plan: DetanglePlan,
  framework: 'angular' | 'react' | 'unknown',
): Promise<ShellTransform> {
  const edits: ShellEdit[] = [];
  const followUps: string[] = [];
  const shellRoot = plan.shell?.root;
  if (!shellRoot) return { edits, followUps };

  const bootstrap = await firstExisting(workspaceRoot, shellRoot, BOOTSTRAP_FILES);

  if (bootstrap) {
    const alreadyWired = /@braidlabs\/(core|angular|react)/.test(bootstrap.source);

    /**
     * For Angular, both the runtime and hydration are **providers**, so both need the same thing: a
     * located `providers: [ … ]` to insert between. Where it cannot be found, both become manual —
     * an import added without its call is an unused import and a runtime that never initializes,
     * which is worse than no edit because it looks done.
     */
    const config =
      framework === 'angular'
        ? await firstExisting(workspaceRoot, shellRoot, ['src/app/app.config.ts', 'src/app/app.config.server.ts'])
        : undefined;
    const providers = config ? findProvidersArray(config.source) : undefined;

    if (!alreadyWired) {
      if (framework === 'angular' && config && providers !== undefined) {
        edits.push(
          {
            file: config.file,
            line: 1,
            kind: 'insert',
            summary: 'import the Braid runtime',
            text: `import { provideBraid } from '@braidlabs/angular';`,
            why: 'the <fragment-slot> element is registered by the runtime; a slot that connects before it does nothing',
          },
          {
            file: config.file,
            offset: providers,
            line: lineAt(config.source, providers),
            kind: 'insert',
            summary: 'add provideBraid() to the application providers',
            text: 'provideBraid(), ',
            why: 'the import alone does nothing — provideBraid() is what registers the element and wires host navigation',
          },
        );
      } else {
        edits.push({
          file: config?.file ?? bootstrap.file,
          kind: 'manual',
          summary:
            framework === 'react'
              ? 'call initBraidReact() before rendering'
              : 'call initBraid() before any <fragment-slot> connects',
          why:
            'the runtime must be initialized before a slot connects, and this file has no ' +
            '`providers: [ … ]` to insert into — where it goes depends on how this app bootstraps',
        });
      }
    }

    /**
     * Hydration, for Angular, is non-negotiable and is the first entry in the failure-modes doc.
     *
     * Without it Angular discards the server-rendered DOM and re-creates it — which destroys the
     * `<fragment-slot>` the gateway already filled and boots a second realm to fetch it again. The
     * symptom is a fragment that flashes and reloads, and it is the single most likely way a freshly
     * converted workspace looks broken.
     */
    if (framework === 'angular' && config && !/provideClientHydration/.test(config.source)) {
      const why =
        'without hydration Angular discards the server-rendered DOM, destroying the fragment-slot the ' +
        'gateway filled and booting a second realm to re-fetch it — the first entry in braid-failure-modes.md';

      if (providers !== undefined) {
        edits.push(
          {
            file: config.file,
            line: 1,
            kind: 'insert',
            summary: 'import provideClientHydration',
            text: `import { provideClientHydration, withIncrementalHydration } from '@angular/platform-browser';`,
            why,
          },
          {
            file: config.file,
            offset: providers,
            line: lineAt(config.source, providers),
            kind: 'insert',
            summary: 'add provideClientHydration() to the application providers',
            text: 'provideClientHydration(withIncrementalHydration()), ',
            why,
          },
        );
      } else {
        edits.push({ file: config.file, kind: 'manual', summary: 'add provideClientHydration() to both bootstraps', why });
      }
    }
  } else {
    followUps.push(`no bootstrap file found under ${shellRoot}/src — add the Braid runtime import by hand`);
  }

  for (const fragment of plan.fragments) {
    if (!fragment.from) {
      followUps.push(`${fragment.id}: no call site found — add its <fragment-slot> by hand`);
      continue;
    }

    const source = await read(workspaceRoot, fragment.from);
    if (!source) continue;

    /**
     * A character offset, not a line: the enclosing route object is frequently written on one line,
     * and locating its braces from a line number cannot distinguish "the object opens above" from
     * "the object opens later on this same line". That distinction is the difference between finding
     * the element and refusing every single-line route in the file.
     */
    const anchor = new RegExp(`remoteName\\s*:\\s*['"\`]${fragment.remote}['"\`]|['"\`]${fragment.remote}/`).exec(source)?.index;
    const line = anchor === undefined ? undefined : lineOfOffset(source, anchor);

    /**
     * A routed remote's route is *removed*, not rewritten: once the fragment is pierced at that
     * path, the gateway serves it and a client route pointing at the old federated module would
     * shadow the composed page with a second, unfederated one.
     */
    const removable = fragment.bound && anchor !== undefined ? findRemovableRoute(source, anchor) : undefined;

    edits.push({
      file: fragment.from,
      ...(line === undefined ? {} : { line }),
      kind: removable ? 'remove' : 'manual',
      ...(removable ? { range: removable.range } : {}),
      summary: fragment.bound
        ? `remove the "${fragment.remote}" route — the gateway serves ${fragment.pierce[0] ?? 'it'} now`
        : `replace the "${fragment.remote}" mount with <fragment-slot name="${fragment.id}" src="${fragment.src ?? '/'}">`,
      why: fragment.bound
        ? removable
          ? 'a client route still pointing at the federated module would shadow the composed page'
          : `a client route pointing at the federated module would shadow the composed page — ` +
            `left manual because ${refusalReason(source, anchor)}`
        : 'an inline component mount becomes an unbound fragment, asked for one fixed path on every page',
    });
  }

  return { edits, followUps };
}

/** Guesses the shell's framework from its dependencies. Reported, never assumed silently. */
export async function detectFramework(
  workspaceRoot: string,
  shellRoot: string,
): Promise<'angular' | 'react' | 'unknown'> {
  for (const candidate of [`${shellRoot}/package.json`, 'package.json']) {
    const source = await read(workspaceRoot, candidate);
    if (!source) continue;
    if (/"@angular\/core"/.test(source)) return 'angular';
    if (/"react-dom"/.test(source)) return 'react';
  }

  const bootstrap = await firstExisting(workspaceRoot, shellRoot, BOOTSTRAP_FILES);
  if (bootstrap?.source.includes('@angular/')) return 'angular';
  if (bootstrap?.source.includes('react-dom')) return 'react';
  return 'unknown';
}

async function read(workspaceRoot: string, relative: string): Promise<string | undefined> {
  try {
    return await readFile(join(workspaceRoot, relative), 'utf-8');
  } catch {
    return undefined;
  }
}

async function firstExisting(
  workspaceRoot: string,
  shellRoot: string,
  candidates: string[],
): Promise<{ file: string; source: string } | undefined> {
  for (const candidate of candidates) {
    const file = `${shellRoot}/${candidate}`;
    const source = await read(workspaceRoot, file);
    if (source !== undefined) return { file, source };
  }
  return undefined;
}

function lineOf(source: string, pattern: RegExp): number | undefined {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => pattern.test(line));
  return index >= 0 ? index + 1 : undefined;
}

/** 1-indexed line containing a character offset, for reporting a located call site. */
function lineOfOffset(source: string, offset: number): number {
  return lineAt(source, offset);
}

/**
 * The one route shape this will delete: `{ path: '…', loadChildren: () => loadRemoteModule(…) }`,
 * as a single element of an array literal — on one line or many.
 *
 * Everything about this function is a refusal. It exists because route removal is the only shell
 * edit worth automating (forgetting it leaves a client route shadowing the composed page) and
 * because it is also the edit most able to destroy a file. So it deletes only what it can prove:
 *
 * - the enclosing `{ … }` can be located from the call site **and re-verified** to contain it;
 * - it declares no `canActivate`, `canMatch`, `canLoad`, `resolve`, `providers`, `children`, `data`;
 * - it contains exactly one `path` and exactly one `loadChildren`/`loadComponent`/`component`;
 * - that `path` is a string literal.
 *
 * A guard or a resolver means the route carries behaviour the fragment does not inherit; `children`
 * means deleting the element removes routes that have nothing to do with this remote. Both are
 * correctness bugs that surface in production, so both are refusals here.
 *
 * **The scan is approximate and then verified**, which is what makes it safe. Finding the opening
 * brace by scanning backwards cannot account for a `{` inside a string; so the forward scan from
 * that brace is string-aware, and if the range it produces does not enclose the anchor, the whole
 * thing is refused rather than trusted.
 */
export function findRemovableRoute(
  source: string,
  /** Character offset of something inside the route — the `remoteName` match, in practice. */
  anchor: number,
): { range: { from: number; to: number } } | undefined {
  if (anchor < 0 || anchor >= source.length) return undefined;

  /**
   * Walks **outward** through enclosing braces, not just to the nearest one.
   *
   * The anchor is the `remoteName` key, which sits inside `loadRemoteModule({ … })` — so the nearest
   * enclosing object is the call's argument, not the route. The first implementation stopped there,
   * found no `path:`, and refused every route in the file. Each level out is tested against the same
   * criteria; the first that looks like a route object is the answer, and a level carrying more than
   * one `path:` means we have left the element and gone into the array, so it stops.
   */
  let from = anchor;
  for (let level = 0; level < 6; level++) {
    const bounds = enclosingBraces(source, from);
    if (!bounds) return undefined;

    const element = source.slice(bounds.open, bounds.close + 1);
    const paths = element.match(/\bpath\s*:/g)?.length ?? 0;

    if (paths === 1) {
      if (/\b(canActivate|canMatch|canLoad|resolve|providers|children|data)\s*:/.test(element)) return undefined;
      if ((element.match(/\b(loadChildren|loadComponent|component)\s*:/g)?.length ?? 0) !== 1) return undefined;
      if (!/path\s*:\s*['"`]/.test(element)) return undefined;

      /**
       * Whole lines, extended over a trailing comma so the array keeps no dangling one. Lines rather
       * than a character range because the element occupies its own line(s) in every routes file
       * anyone actually has, and deleting lines is what keeps the result readable as a diff.
       */
      return {
        range: { from: lineAt(source, bounds.open), to: lineAt(source, trailingComma(source, bounds.close)) },
      };
    }

    // More than one `path:` means this level is the array or an ancestor — we have gone too far.
    if (paths > 1) return undefined;

    from = bounds.open - 1;
    if (from < 0) return undefined;
  }

  return undefined;
}

/**
 * The braces enclosing an offset: found by scanning backwards, then **verified** by a string-aware
 * scan forwards.
 *
 * The backward scan cannot account for a `{` inside a string literal, so it is treated as a guess.
 * The forward scan from that brace is string-aware, and if the range it produces does not enclose
 * the original offset, the guess was wrong and the whole thing is refused rather than trusted.
 */
function enclosingBraces(source: string, from: number): { open: number; close: number } | undefined {
  let depth = 0;
  let open = -1;
  for (let i = from; i >= 0; i--) {
    const char = source[i]!;
    if (char === '}') depth++;
    else if (char === '{') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open < 0) return undefined;

  let balance = 0;
  let quote: string | undefined;
  for (let i = open; i < source.length; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') balance++;
    else if (char === '}' && --balance === 0) {
      return i >= from ? { open, close: i } : undefined;
    }
  }
  return undefined;
}

/** The offset of a `,` immediately following `close`, or `close` itself. */
function trailingComma(source: string, close: number): number {
  for (let i = close + 1; i < source.length; i++) {
    const char = source[i]!;
    if (char === ',') return i;
    if (char !== ' ' && char !== '\t') return close;
  }
  return close;
}

/**
 * The offset just inside `providers: [`, or undefined.
 *
 * Takes the first match, so a `providers:` inside a comment or a string would fool it — and the
 * consequence would be a provider inserted somewhere harmless-looking and wrong. That is why the
 * caller treats found/not-found as the only two outcomes and never falls back to a line guess: the
 * failure mode of guessing here is syntactically broken TypeScript.
 */
export function findProvidersArray(source: string): number | undefined {
  const match = /providers\s*:\s*\[/.exec(source);
  return match ? match.index + match[0].length : undefined;
}

/** 1-indexed line containing a character offset. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/** Why a route was left manual, in the words a developer can act on. */
function refusalReason(source: string, anchor: number | undefined): string {
  if (anchor === undefined) return 'its call site could not be located';

  const window = source.slice(Math.max(0, anchor - 400), anchor + 400);

  const guard = /\b(canActivate|canMatch|canLoad|resolve|providers|children|data)\s*:/.exec(window)?.[1];
  if (guard) return `the route carries \`${guard}\`, which the fragment does not inherit`;
  return 'the route object could not be bracket-matched with confidence';
}

/**
 * Applies the edits `--write` is allowed to make, and skips the rest.
 *
 * Line-based rather than AST-based, deliberately: an AST rewrite reprints the file, and a codemod
 * that reformats three hundred lines to change two produces a diff nobody reviews. Editing lines
 * leaves everything else byte-identical, which is what makes the result readable as a diff — and
 * being readable as a diff is the whole safety argument for this phase.
 */
export async function applyShellEdits(
  workspaceRoot: string,
  edits: ShellEdit[],
): Promise<{ written: string[]; skipped: Array<{ path: string; reason: string }> }> {
  const written: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const byFile = new Map<string, ShellEdit[]>();
  for (const edit of edits) {
    if (edit.kind === 'manual' || edit.kind === 'replace') {
      skipped.push({ path: edit.file, reason: edit.summary });
      continue;
    }
    const group = byFile.get(edit.file);
    if (group) group.push(edit);
    else byFile.set(edit.file, [edit]);
  }

  for (const [file, fileEdits] of byFile) {
    const source = await read(workspaceRoot, file);
    if (source === undefined) {
      skipped.push({ path: file, reason: 'could not be read' });
      continue;
    }

    /**
     * Every edit is resolved to a character span first, then applied **back to front**.
     *
     * Line edits and offset edits have to be applied in one ordering or they shift each other, and
     * "insert a line at line 1" and "insert text at offset 214" cannot be compared as they stand.
     * Converting both to spans makes the ordering total and the splicing trivial — and going
     * backwards means no earlier edit can move a later one's target.
     */
    const spans = fileEdits
      .map((edit) => resolveSpan(source, edit))
      .filter((span): span is { at: number; remove: number; text: string } => span !== undefined)
      .sort((a, b) => b.at - a.at);

    let next = source;
    for (const span of spans) {
      next = next.slice(0, span.at) + span.text + next.slice(span.at + span.remove);
    }

    await writeFile(join(workspaceRoot, file), next);
    written.push(file);
  }

  return { written, skipped };
}

/** One edit as a character span: where, how much to drop, what to put there. */
function resolveSpan(source: string, edit: ShellEdit): { at: number; remove: number; text: string } | undefined {
  if (edit.kind === 'remove' && edit.range) {
    const at = offsetOfLine(source, edit.range.from);
    const end = offsetOfLine(source, edit.range.to + 1);
    return { at, remove: end - at, text: '' };
  }

  if (edit.kind === 'insert' && edit.text !== undefined) {
    // An offset lands inside a line — a provider between brackets. A line inserts a whole line.
    if (edit.offset !== undefined) return { at: edit.offset, remove: 0, text: edit.text };
    const at = offsetOfLine(source, edit.line ?? 1);
    return { at, remove: 0, text: `${edit.text}\n` };
  }

  return undefined;
}

/** Character offset of the start of a 1-indexed line; the end of the source if it runs past. */
function offsetOfLine(source: string, line: number): number {
  if (line <= 1) return 0;
  let seen = 1;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n' && ++seen === line) return i + 1;
  }
  return source.length;
}
