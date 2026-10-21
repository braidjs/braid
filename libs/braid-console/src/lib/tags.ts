/**
 * Tag colors: the same tag is the same color everywhere — table, graph, designer, search.
 *
 * Derived from the tag text rather than assigned, so there is nothing to store or keep in sync and
 * two consoles pointed at one registry agree. The cost is that two tags can share a color; every
 * chip carries its text, so color is a grouping cue and never the only way to tell tags apart.
 *
 * Each pair clears 4.5:1 text contrast in both themes (lowest: teal on light, 5.97:1).
 */
const PALETTE: readonly { name: string; light: [string, string]; dark: [string, string] }[] = [
  { name: 'blue', light: ['#0f548c', '#e8f1fb'], dark: ['#8bc1f7', '#102b46'] },
  { name: 'teal', light: ['#00666d', '#e3f5f5'], dark: ['#6fd1d6', '#0b3134'] },
  { name: 'orange', light: ['#8a3707', '#fdefe6'], dark: ['#f7a76b', '#3d2210'] },
  { name: 'purple', light: ['#5c2e91', '#f2ecf9'], dark: ['#c5a6ef', '#2c1f40'] },
  { name: 'pink', light: ['#9b1d5f', '#fbedf4'], dark: ['#f08fc3', '#3d1a2c'] },
  { name: 'green', light: ['#0e5c0e', '#e7f5e7'], dark: ['#8fd58f', '#15301a'] },
  { name: 'olive', light: ['#5c5300', '#f6f3d8'], dark: ['#d8cc6a', '#2f2b0a'] },
  { name: 'slate', light: ['#3b4a5c', '#eaeef3'], dark: ['#b5c3d4', '#232b35'] },
];

export const TAG_COLOR_COUNT = PALETTE.length;

/** The palette slot for a tag: FNV-1a over its lowercased text, so `Finance` and `finance` agree. */
export function tagColor(tag: string): number {
  let hash = 0x811c9dc5;
  for (const char of tag.toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % PALETTE.length;
}

/** The class that colors a tag chip. */
export function tagClass(tag: string): string {
  return `braid-console__tag braid-console__tag--c${tagColor(tag)}`;
}

/**
 * Per-slot custom properties, in the three places the console decides its theme: the light
 * default, the OS dark preference, and an explicit `data-theme` that wins in both directions.
 */
export const TAG_STYLES = (() => {
  const rules = (scheme: 'light' | 'dark', scope: string) =>
    PALETTE.map(
      ({ [scheme]: [fg, bg] }, index) => `${scope} .braid-console__tag--c${index} { --bc-tag-fg: ${fg}; --bc-tag-bg: ${bg}; }`,
    ).join('\n');

  return `
/* --- tags --------------------------------------------------------------- */
.braid-console__tag[class*='braid-console__tag--c'] { color: var(--bc-tag-fg); background: var(--bc-tag-bg); border-color: transparent; }
.braid-console__tagbutton { font: inherit; cursor: pointer; }
.braid-console__tagbutton:focus-visible { outline: 2px solid var(--bc-accent); outline-offset: 1px; }
${rules('light', '.braid-console')}
@media (prefers-color-scheme: dark) {
${rules('dark', '.braid-console')}
}
${rules('light', ".braid-console[data-theme='light']")}
${rules('dark', ".braid-console[data-theme='dark']")}
`;
})();
