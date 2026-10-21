import type { FragmentManifest } from '@braidlabs/gateway';
import type { RegistryFinding } from './analysis.js';

/**
 * A shell: the page a set of fragments composes into, as data.
 *
 * Until now a shell was whatever HTML the gateway's downstream app returned, and where each
 * fragment sat was decided in that app's source. Describing it here puts the layout in the same
 * immutable, content-addressed snapshot as the fragments it places, so a layout change is
 * reviewed, diffed, published and rolled back exactly like a routing change.
 *
 * **A shell is data, not an app.** `framework` says which kind of host renders it — React,
 * Angular, Angular with SSR, or a plain HTML page — and the layout means the same thing in all
 * four. Nothing in this package renders a shell; the console generates host code from one.
 */
export interface ShellManifest {
  /** Unique among shells. Same rules as a fragment id: non-empty, no `/`. */
  id: string;
  title?: string;
  description?: string;
  tags?: string[];
  framework: ShellFramework;
  routes: ShellRoute[];
  head?: ShellHead;
}

export type ShellFramework = 'react' | 'angular' | 'angular-ssr' | 'vanilla';

export const SHELL_FRAMEWORKS: readonly ShellFramework[] = ['react', 'angular', 'angular-ssr', 'vanilla'];

export interface ShellRoute {
  /** URLPattern pathname syntax — the same matcher the gateway uses for `pierce`. */
  path: string;
  layout: ShellLayout;
  /** Area name → fragment id. One fragment per area; an area with no entry renders empty. */
  slots?: Record<string, string>;
}

/**
 * A CSS grid, written the way CSS already lets you draw one.
 *
 * `areas` is `grid-template-areas` as ASCII art, one grid row per line:
 *
 * ```
 * header header
 * nav    main
 * ```
 *
 * There is deliberately no other model of the layout. What you type is the CSS, so the editor
 * cannot drift from the output and the rules are the browser's own: every area must be a single
 * rectangle, and every row must have the same number of cells.
 */
export interface ShellLayout {
  areas: string;
  /** `grid-template-columns`, e.g. `220px 1fr`. */
  columns?: string;
  /** `grid-template-rows`. */
  rows?: string;
  gap?: string;
}

export interface ShellHead {
  title?: string;
  meta?: ShellMeta[];
  /** By URL only. Inline script is not representable, on purpose. */
  scripts?: ShellScript[];
  stylesheets?: ShellStylesheet[];
}

export interface ShellMeta {
  /** `name` or `property` (Open Graph uses `property`); one of the two is required. */
  name?: string;
  property?: string;
  content: string;
}

export interface ShellScript {
  src: string;
  type?: 'module' | 'classic';
  async?: boolean;
  defer?: boolean;
  integrity?: string;
}

export interface ShellStylesheet {
  href: string;
  integrity?: string;
}

// ---------------------------------------------------------------------------
// Layout parsing
// ---------------------------------------------------------------------------

export interface GridArea {
  name: string;
  /** 1-based, as CSS grid lines are. */
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
}

export interface ParsedAreas {
  /** The cells, row by row; `.` marks an empty cell. */
  cells: string[][];
  rowCount: number;
  columnCount: number;
  /** In order of first appearance, reading left to right, top to bottom. */
  areas: GridArea[];
  /** Empty when the layout is valid. Each message names the row or area at fault. */
  errors: string[];
}

const AREA_NAME = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;
const EMPTY_CELL = /^\.+$/;

/**
 * Parses ASCII-art `grid-template-areas`.
 *
 * Blank lines are ignored, and a row may be wrapped in quotes so a template pasted from CSS works
 * unchanged. A run of dots is an empty cell, as in CSS.
 */
export function parseAreas(text: string): ParsedAreas {
  // CSS also writes the whole template on one line — "a b" "c d" — so quoted groups are rows too.
  const lines = /^\s*(["'])/.test(text) ? [...text.matchAll(/(["'])([^"']*)\1/g)].map((match) => match[2] ?? '') : text.split('\n');
  const cells = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/).map((cell) => (EMPTY_CELL.test(cell) ? '.' : cell)));

  const errors: string[] = [];
  const columnCount = cells[0]?.length ?? 0;

  if (cells.length === 0) errors.push('the layout is empty — type at least one row of area names');

  cells.forEach((row, index) => {
    if (row.length !== columnCount) {
      errors.push(`row ${index + 1} has ${row.length} cells but row 1 has ${columnCount} — every row needs the same number`);
    }
  });

  const positions = new Map<string, [number, number][]>();
  cells.forEach((row, r) =>
    row.forEach((name, c) => {
      if (name === '.') return;
      if (!AREA_NAME.test(name) || name === '__proto__') {
        if (!positions.has(name)) errors.push(`"${name}" is not a valid area name — use letters, digits, "-" and "_", starting with a letter`);
        positions.set(name, []);
        return;
      }
      const list = positions.get(name) ?? [];
      list.push([r, c]);
      positions.set(name, list);
    }),
  );

  const areas: GridArea[] = [];
  for (const [name, points] of positions) {
    if (points.length === 0) continue;
    const rows = points.map(([r]) => r);
    const columns = points.map(([, c]) => c);
    const top = Math.min(...rows);
    const left = Math.min(...columns);
    const rowSpan = Math.max(...rows) - top + 1;
    const columnSpan = Math.max(...columns) - left + 1;

    if (points.length !== rowSpan * columnSpan) {
      errors.push(`"${name}" is not a rectangle — CSS discards a template whose areas are not single rectangles`);
      continue;
    }
    areas.push({ name, row: top + 1, column: left + 1, rowSpan, columnSpan });
  }

  return { cells, rowCount: cells.length, columnCount, areas, errors };
}

/** The `grid-template-areas` value for parsed cells: one quoted string per row. */
export function formatAreas(cells: readonly (readonly string[])[]): string[] {
  const widths = cells[0]?.map((_, c) => Math.max(...cells.map((row) => row[c]?.length ?? 0))) ?? [];
  return cells.map((row) => `"${row.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join(' ').trimEnd()}"`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Track sizes and gaps end up inside generated CSS, so they are held to the characters a track
 * list can contain. `;`, braces and angle brackets are what would let a value escape its
 * declaration.
 */
const CSS_TRACKS = /^[a-zA-Z0-9 ().,%+*/-]+$/;

/**
 * A grid track list or gap that can be written into generated CSS as-is. `/` and `*` are allowed
 * for `calc()`, but never together: `/*` would open a comment that swallows the rest of the file.
 */
export function isSafeTrackList(value: string): boolean {
  return typeof value === 'string' && CSS_TRACKS.test(value) && !/\/\*|\*\//.test(value);
}

/**
 * Validates shells against each other and against the fragments they place.
 *
 * Called by `validateRegistry` when it is given shells; exported for surfaces that only edit
 * shells.
 */
export function validateShells(shells: readonly ShellManifest[], manifests: readonly FragmentManifest[]): RegistryFinding[] {
  const findings: RegistryFinding[] = [];
  const fragmentIds = new Set(manifests.map((manifest) => manifest.id));
  const seen = new Set<string>();

  const error = (code: RegistryFinding['code'], shellId: string, message: string, hint?: string, fragments: string[] = []) =>
    findings.push({ severity: 'error', code, shellIds: [shellId], fragmentIds: fragments, message, ...(hint ? { hint } : {}) });

  for (const shell of shells) {
    // Shape first. A shell arrives as JSON from whoever may publish, and everything downstream —
    // this function, the console, generated code — assumes the declared types. A malformed one is
    // reported and not looked at further, rather than crashing whoever reads it next.
    const problems = shapeProblems(shell);
    const id = typeof shell?.id === 'string' ? shell.id : String(shell?.id);
    if (problems.length > 0) {
      for (const problem of problems) error('invalid-shell-field', id, `shell "${id}": ${problem}`);
      continue;
    }

    if (!SHELL_ID.test(id)) {
      error('invalid-shell-id', id, `shell id "${id}" is invalid`, 'use letters, digits, ".", "_" and "-", starting with a letter or digit');
    } else if (seen.has(id)) {
      error('duplicate-shell-id', id, `shell id "${id}" is defined more than once`, 'give one of them a different id');
    }
    seen.add(id);

    if (!SHELL_FRAMEWORKS.includes(shell.framework)) {
      error('invalid-shell-framework', id, `shell "${id}" has an unknown framework "${shell.framework}"`, `use one of ${SHELL_FRAMEWORKS.join(', ')}`);
    }

    const paths = new Set<string>();
    for (const route of shell.routes) {
      validateRoutePath(route.path, id, paths, error);
      paths.add(route.path);

      const parsed = parseAreas(route.layout.areas);
      for (const message of parsed.errors) {
        error('invalid-shell-layout', id, `shell "${id}" route ${route.path}: ${message}`);
      }
      for (const [property, value] of [
        ['columns', route.layout.columns],
        ['rows', route.layout.rows],
        ['gap', route.layout.gap],
      ] as const) {
        if (value !== undefined && !isSafeTrackList(value)) {
          error('invalid-shell-layout', id, `shell "${id}" route ${route.path}: ${property} "${value}" is not a CSS track list`, 'use sizes such as 220px 1fr or minmax(0, 1fr)');
        }
      }

      if (parsed.errors.length > 0) continue;
      const areaNames = new Set(parsed.areas.map((area) => area.name));
      for (const [area, fragmentId] of Object.entries(route.slots ?? {})) {
        if (!areaNames.has(area)) {
          error('slot-unknown-area', id, `shell "${id}" route ${route.path} slots "${fragmentId}" into area "${area}", which the layout does not have`, 'add the area to the layout or remove the slot', [fragmentId]);
        }
        if (!fragmentIds.has(fragmentId)) {
          error('slot-unknown-fragment', id, `fragment "${fragmentId}" is slotted by shell "${id}" (route ${route.path}, area "${area}") but is not registered`, 'register the fragment, or remove it from the shell before deleting it', [fragmentId]);
        }
      }
    }

    for (const script of shell.head?.scripts ?? []) {
      if (!isSafeAssetUrl(script.src)) {
        error('unsafe-shell-url', id, `shell "${id}" loads a script from "${script.src}"`, 'scripts and stylesheets must load over https: or from a root-relative path such as /assets/app.js');
      }
    }
    for (const sheet of shell.head?.stylesheets ?? []) {
      if (!isSafeAssetUrl(sheet.href)) {
        error('unsafe-shell-url', id, `shell "${id}" loads a stylesheet from "${sheet.href}"`, 'scripts and stylesheets must load over https: or from a root-relative path such as /assets/app.css');
      }
    }
  }

  return findings;
}

/** Shell ids end up in file names, CSS classes, comments and URLs: kept to a charset safe in all. */
const SHELL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What is wrong with a shell's types, as messages; empty when it has the declared shape. */
function shapeProblems(shell: ShellManifest): string[] {
  const problems: string[] = [];
  const isString = (value: unknown) => typeof value === 'string';
  const optionalString = (value: unknown, name: string) => {
    if (value !== undefined && !isString(value)) problems.push(`${name} must be a string`);
  };
  const isStringList = (value: unknown) => Array.isArray(value) && value.every(isString);

  if (typeof shell !== 'object' || shell === null) return ['is not an object'];
  if (!isString(shell.id)) problems.push('id must be a string');
  optionalString(shell.title, 'title');
  optionalString(shell.description, 'description');
  if (shell.tags !== undefined && !isStringList(shell.tags)) problems.push('tags must be a list of strings');
  if (!isString(shell.framework)) problems.push('framework must be a string');

  if (!Array.isArray(shell.routes)) {
    problems.push('routes must be a list');
  } else {
    shell.routes.forEach((route, index) => {
      const at = `routes[${index}]`;
      if (typeof route !== 'object' || route === null) return problems.push(`${at} is not an object`);
      if (!isString(route.path)) problems.push(`${at}.path must be a string`);
      if (typeof route.layout !== 'object' || route.layout === null || !isString(route.layout.areas)) {
        problems.push(`${at}.layout.areas must be a string`);
      } else {
        optionalString(route.layout.columns, `${at}.layout.columns`);
        optionalString(route.layout.rows, `${at}.layout.rows`);
        optionalString(route.layout.gap, `${at}.layout.gap`);
      }
      if (route.slots !== undefined && (typeof route.slots !== 'object' || route.slots === null || Array.isArray(route.slots) || !Object.values(route.slots).every(isString))) {
        problems.push(`${at}.slots must map area names to fragment ids`);
      }
      return undefined;
    });
  }

  const head = shell.head;
  if (head !== undefined) {
    if (typeof head !== 'object' || head === null) return [...problems, 'head must be an object'];
    optionalString(head.title, 'head.title');
    for (const [index, meta] of (Array.isArray(head.meta) ? head.meta : head.meta === undefined ? [] : [null]).entries()) {
      if (typeof meta !== 'object' || meta === null || !isString(meta.content) || !(isString(meta.name) || isString(meta.property))) {
        problems.push(`head.meta[${index}] needs a string content and a string name or property`);
      }
    }
    for (const [index, script] of (Array.isArray(head.scripts) ? head.scripts : head.scripts === undefined ? [] : [null]).entries()) {
      if (typeof script !== 'object' || script === null || !isString(script.src)) problems.push(`head.scripts[${index}].src must be a string`);
      else {
        optionalString(script.integrity, `head.scripts[${index}].integrity`);
        if (script.type !== undefined && script.type !== 'module' && script.type !== 'classic') problems.push(`head.scripts[${index}].type must be module or classic`);
        for (const flag of ['async', 'defer'] as const) {
          if (script[flag] !== undefined && typeof script[flag] !== 'boolean') problems.push(`head.scripts[${index}].${flag} must be true or false`);
        }
      }
    }
    for (const [index, sheet] of (Array.isArray(head.stylesheets) ? head.stylesheets : head.stylesheets === undefined ? [] : [null]).entries()) {
      if (typeof sheet !== 'object' || sheet === null || !isString(sheet.href)) problems.push(`head.stylesheets[${index}].href must be a string`);
      else optionalString(sheet.integrity, `head.stylesheets[${index}].integrity`);
    }
  }

  return problems;
}

function validateRoutePath(
  path: string,
  shellId: string,
  seen: Set<string>,
  error: (code: RegistryFinding['code'], shellId: string, message: string, hint?: string) => void,
): void {
  if (seen.has(path)) {
    error('invalid-route-path', shellId, `shell "${shellId}" declares route ${path} more than once`);
    return;
  }
  if (UNSAFE_CHARACTERS.test(path)) {
    error('invalid-route-path', shellId, `shell "${shellId}" has a route path containing whitespace or control characters`, 'paths use URLPattern pathname syntax, e.g. /orders/*');
    return;
  }
  if (!path.startsWith('/')) {
    error('invalid-route-path', shellId, `shell "${shellId}" has a route path "${path}" that does not start with "/"`, 'paths use URLPattern pathname syntax, e.g. /orders/* or /orders/:id');
    return;
  }
  // Without URLPattern only the leading-slash check above can run. analysis.ts reports the
  // missing runtime once for pierce patterns; repeating it per route would only add noise.
  if (typeof URLPattern === 'undefined') return;
  try {
    new URLPattern({ pathname: path });
  } catch {
    error('invalid-route-path', shellId, `shell "${shellId}" has an invalid route path "${path}"`, 'paths use URLPattern pathname syntax, e.g. /orders/* or /orders/:id');
  }
}

/** Whitespace, C0/C1 controls, and the Unicode line and paragraph separators. */
// Matching control characters is the point of this pattern.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/;

/** `https:` URLs and root-relative paths. Protocol-relative `//host` is refused: it inherits `http:`. */
export function isSafeAssetUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  // Browsers drop tabs and newlines inside URLs, so "/\t/evil.com" would load //evil.com.
  if (UNSAFE_CHARACTERS.test(url)) return false;
  if (url.startsWith('/')) return !url.startsWith('//') && !url.startsWith('/\\');
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
