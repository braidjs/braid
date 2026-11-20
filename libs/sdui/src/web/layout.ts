/**
 * What a browser pays to lay a text out, in characters of plain Latin.
 *
 * Length is a fair price for Latin text, but not for all text: a browser shapes each run of one
 * script and direction on its own, and finds a font for it — a change of script can be a change
 * of font, and a run costs it as much as hundreds of plain characters. Some scripts are broken
 * into lines by dictionary. An agent choosing its text can choose the expensive kind. Measured in
 * Chromium, 20,000 characters alternating Latin and Hebrew took ~450 ms to lay out, and 20,000
 * rotating through seventeen scripts ~300 ms, where 380,000 of plain Latin took ~25 ms.
 *
 * So a text costs:
 * - 1 for each character of Latin, Greek or Cyrillic, punctuation and symbols;
 * - {@link COMPLEX_COST} for each character of the scripts measured to cost more but not much
 *   more — Hebrew, Arabic, Devanagari, Chinese, Japanese, Korean, emoji, combining marks;
 * - {@link UNMEASURED_COST} for each character of a script broken into lines by dictionary (Thai,
 *   Lao, Khmer, Myanmar), and of every script not listed here, which is priced as if it were;
 * - {@link RUN_COST} for each change from one script (or one Unicode block, for the unlisted ones)
 *   to another, and for each bidi control character.
 *
 * Ordinary text in one language costs its length, or a few times it.
 */

/** Cost of one change of script or block, or one bidi control. */
export const RUN_COST = 1_000;
/** Cost of a character of the scripts measured to cost a few times Latin. */
export const COMPLEX_COST = 8;
/** Cost of a character of a script broken into lines by dictionary, or not measured. */
export const UNMEASURED_COST = 50;

/** A character's group — a change of group is a run — and what it costs. */
interface Kind {
  readonly group: number;
  readonly cost: number;
}

const NEUTRAL = 0; // goes with the run it is in
const CONTROL = -1; // a run of its own
const LATIN = 1;
const GREEK = 2;
const CYRILLIC = 3;
const HEBREW = 4;
const ARABIC = 5;
const DEVANAGARI = 6;
const HAN = 7; // with kana and bopomofo: one font covers them
const HANGUL = 8;
const EMOJI = 9;

const kind = (group: number, cost: number): Kind => ({ group, cost });
const PLAIN = kind(NEUTRAL, 1);
const MARK = kind(NEUTRAL, COMPLEX_COST);
const RUN = kind(CONTROL, 1);

const within = (code: number, from: number, to: number): boolean =>
  code >= from && code <= to;

function kindOf(code: number): Kind {
  // C0 controls but tab and line ends: nothing a text means, and a font change each
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
    return RUN;
  if (code < 0x80)
    return within(code, 0x30, 0x39) ||
      within(code, 0x41, 0x5a) ||
      within(code, 0x61, 0x7a)
      ? kind(LATIN, 1)
      : PLAIN;
  // C1 controls: line breaks and font changes nobody types
  if (code < 0xa0 || code === 0x00ad) return RUN; // and the soft hyphen, an invisible break
  if (code < 0xc0) return PLAIN;
  if (code <= 0x02ff || within(code, 0x1e00, 0x1eff)) return kind(LATIN, 1);
  if (code <= 0x036f) return MARK; // combining marks go with their base
  if (code <= 0x03ff || within(code, 0x1f00, 0x1fff)) return kind(GREEK, 1);
  if (code <= 0x052f) return kind(CYRILLIC, 1);
  if (within(code, 0x0590, 0x05ff) || within(code, 0xfb1d, 0xfb4f))
    return kind(HEBREW, COMPLEX_COST);
  if (code === 0x061c) return RUN;
  if (
    within(code, 0x0600, 0x06ff) ||
    within(code, 0x0750, 0x077f) ||
    within(code, 0x08a0, 0x08ff) ||
    within(code, 0xfb50, 0xfdff) ||
    within(code, 0xfe70, 0xfefe)
  )
    return kind(ARABIC, COMPLEX_COST);
  if (within(code, 0x0900, 0x097f)) return kind(DEVANAGARI, COMPLEX_COST);
  if (
    code === 0x200e ||
    code === 0x200f ||
    within(code, 0x202a, 0x202e) ||
    within(code, 0x2066, 0x2069)
  )
    return RUN;
  // An emoji presentation selector turns the character before it into an emoji: a run.
  if (code === 0xfe0f) return RUN;
  if (code === 0x200d || within(code, 0xfe00, 0xfe0e)) return MARK; // joiners, text selectors
  if (within(code, 0x20d0, 0x20ff)) return MARK;
  if (
    within(code, 0x2600, 0x27bf) ||
    within(code, 0x1f000, 0x1faff) ||
    within(code, 0xe0020, 0xe007f)
  )
    return kind(EMOJI, COMPLEX_COST);
  // Invisible breaks and formatting characters: a soft hyphen, zero-width spaces and joiners
  // other than ZWJ, line and paragraph separators — each one ends a run.
  if (
    within(code, 0x200b, 0x200c) ||
    within(code, 0x2028, 0x2029) ||
    within(code, 0x2060, 0x206f)
  )
    return RUN;
  // General punctuation, super- and subscripts and currency are in every text font.
  if (within(code, 0x2000, 0x20cf)) return PLAIN;
  // Symbols — letterlike, arrows, maths, technical, box drawing, shapes, Braille, and the emoji
  // among them — often come from fonts of their own: each block is a group, and a change a run.
  if (within(code, 0x2100, 0x2bff))
    return kind(2_000 + (code >> 7), COMPLEX_COST);
  if (
    within(code, 0x2e80, 0x2fff) ||
    within(code, 0x3000, 0x31ff) || // CJK punctuation with the scripts it is set in
    within(code, 0x3400, 0x4dbf) ||
    within(code, 0x4e00, 0x9fff) ||
    within(code, 0xf900, 0xfaff) ||
    within(code, 0xff00, 0xffef) ||
    within(code, 0x20000, 0x3ffff)
  )
    return kind(HAN, COMPLEX_COST);
  if (
    within(code, 0xac00, 0xd7af) ||
    within(code, 0x1100, 0x11ff) ||
    within(code, 0x3130, 0x318f)
  )
    return kind(HANGUL, COMPLEX_COST);
  // Everything else — the dictionary scripts, and every script not measured — by its block.
  return kind(1_000 + (code >> 7), UNMEASURED_COST);
}

/** Characters a browser pairs and mirrors in right-to-left text: brackets. */
const MIRRORED = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0xab, 0xbb,
]);

export function layoutCost(text: string): number {
  let ascii = true;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (
      code > 0x7f ||
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
    ) {
      ascii = false;
      break;
    }
  }
  if (ascii) return text.length;
  let cost = 0;
  let last = NEUTRAL;
  let rtl = false;
  let brackets = 0;
  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index);
    // a pair is one character
    if (within(code, 0xd800, 0xdbff) && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (within(low, 0xdc00, 0xdfff)) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        index++;
      }
    }
    if (MIRRORED.has(code)) brackets++;
    const { group, cost: each } = kindOf(code);
    if (group === HEBREW || group === ARABIC) rtl = true;
    cost += each;
    if (group === NEUTRAL) continue;
    if (group === CONTROL) {
      cost += RUN_COST;
      continue;
    }
    if (last !== NEUTRAL && group !== last) cost += RUN_COST;
    last = group;
  }
  // In right-to-left text, brackets are paired and mirrored: that costs per bracket.
  return rtl ? cost + brackets * UNMEASURED_COST : cost;
}
