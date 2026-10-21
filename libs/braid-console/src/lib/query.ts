import type { DiscoveryEntry } from '@braidlabs/gateway';
import type { ShellManifest } from '@braidlabs/registry';

/**
 * A small query language over shells and fragments.
 *
 * ```
 * tag:finance -is:gated route:/billing/123 "customer reviews"
 * ```
 *
 * Terms are ANDed; `-` negates one; quotes keep spaces in a value. Anything that is not a known
 * `key:value` is free text, matched as one phrase across everything a row shows — which is exactly
 * what the old filter box did, so a query with no keys behaves as it always has.
 */
export const QUERY_KEYS = ['tag', 'type', 'framework', 'route', 'adapter', 'is'] as const;

export type QueryKey = (typeof QUERY_KEYS)[number];

export interface QueryTerm {
  key: QueryKey;
  value: string;
  negate: boolean;
}

export interface ParsedQuery {
  terms: QueryTerm[];
  /** Free text, lowercased and matched as one phrase; empty when there is none. */
  text: string;
  /** Words prefixed with `-` and no key, lowercased: a row containing any of them is excluded. */
  exclude: string[];
}

/** What a row shows, normalized so shells and fragments can be matched by one function. */
export interface SearchItem {
  type: 'shell' | 'fragment';
  id: string;
  tags: readonly string[];
  /** Fragments: pierce patterns. Shells: route paths. */
  routes: readonly string[];
  adapter?: string;
  framework?: string;
  /** Listed but not loadable by this caller. Fragments only. */
  gated?: boolean;
  /** Everything free text searches. */
  fields: readonly string[];
}

const TOKEN = /(-?)(?:([a-zA-Z]+):)?(?:"([^"]*)"|(\S+))/g;

export function parseQuery(input: string): ParsedQuery {
  const terms: QueryTerm[] = [];
  const text: string[] = [];
  const exclude: string[] = [];
  let structured = false;

  for (const match of input.matchAll(TOKEN)) {
    const [raw, minus, key, quoted, bare] = match;
    const value = quoted ?? bare ?? '';
    const known = key && (QUERY_KEYS as readonly string[]).includes(key.toLowerCase());

    if (known) {
      structured = true;
      terms.push({ key: key.toLowerCase() as QueryKey, value, negate: minus === '-' });
    } else if (minus === '-' && !key && value) {
      structured = true;
      exclude.push(value.toLowerCase());
    } else {
      if (quoted !== undefined) structured = true;
      text.push(key ? raw.replace(/^-/, '') : value);
    }
  }

  // With no structure at all, keep the query's own spacing: the old filter matched the trimmed
  // query as typed, and "unchanged" should mean unchanged.
  const phrase = structured ? text.join(' ') : input.trim();
  return { terms, text: phrase.toLowerCase(), exclude };
}

export function matchQuery(item: SearchItem, query: ParsedQuery): boolean {
  const fields = item.fields.map((field) => field.toLowerCase());
  if (query.text && !fields.some((field) => field.includes(query.text))) return false;
  if (query.exclude.some((word) => fields.some((field) => field.includes(word)))) return false;
  return query.terms.every((term) => matchTerm(item, term) !== term.negate);
}

function matchTerm(item: SearchItem, { key, value }: QueryTerm): boolean {
  const needle = value.toLowerCase();
  switch (key) {
    case 'tag':
      return item.tags.some((tag) => tag.toLowerCase() === needle);
    case 'type':
      return item.type === needle;
    case 'framework':
      return item.framework?.toLowerCase() === needle;
    case 'adapter':
      return item.adapter?.toLowerCase() === needle;
    case 'route':
      return item.routes.some((pattern) => routeMatches(pattern, value));
    case 'is':
      if (needle === 'gated') return item.gated === true;
      if (needle === 'unrouted') return item.routes.length === 0;
      return false;
  }
}

/**
 * `route:` matches a pattern written the same way, or a concrete path the pattern would serve —
 * `route:/billing/123` finds what pierces `/billing/*`, which is the question an operator with a
 * URL in hand is asking.
 */
function routeMatches(pattern: string, value: string): boolean {
  if (pattern.toLowerCase() === value.toLowerCase()) return true;
  if (typeof URLPattern === 'undefined' || !value.startsWith('/')) return false;
  try {
    return new URLPattern({ pathname: pattern }).test({ pathname: value });
  } catch {
    return false;
  }
}

export function fragmentItem(entry: DiscoveryEntry): SearchItem {
  return {
    type: 'fragment',
    id: entry.id,
    tags: entry.tags ?? [],
    routes: entry.pierce ?? [],
    adapter: entry.adapter,
    gated: !entry.loadable,
    fields: [entry.id, entry.title, entry.description, entry.adapter, ...(entry.tags ?? []), ...(entry.pierce ?? [])].filter(
      (field): field is string => Boolean(field),
    ),
  };
}

export function shellItem(shell: ShellManifest): SearchItem {
  const routes = shell.routes.map((route) => route.path);
  const slotted = shell.routes.flatMap((route) => Object.values(route.slots ?? {}));
  return {
    type: 'shell',
    id: shell.id,
    tags: shell.tags ?? [],
    routes,
    framework: shell.framework,
    fields: [shell.id, shell.title, shell.description, shell.framework, ...(shell.tags ?? []), ...routes, ...slotted].filter(
      (field): field is string => Boolean(field),
    ),
  };
}

/** Filters anything with a {@link SearchItem} view by a query string. */
export function filterBy<T>(items: readonly T[], query: string, view: (item: T) => SearchItem): T[] {
  const parsed = parseQuery(query);
  if (!parsed.text && parsed.terms.length === 0 && parsed.exclude.length === 0) return [...items];
  return items.filter((item) => matchQuery(view(item), parsed));
}
