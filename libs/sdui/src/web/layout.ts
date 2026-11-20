/**
 * What a browser pays to lay a text out, in characters of plain Latin.
 *
 * Length is a fair price for most text, but not all: each change of direction (Latin to Hebrew
 * and back) or of script starts a run the browser shapes on its own, and a run costs it as much
 * as hundreds of plain characters. Thai, Lao, Khmer and Myanmar are broken into lines by
 * dictionary, character by character. Measured in Chromium, 20,000 characters alternating Latin
 * and Hebrew take ~450 ms to lay out, where 380,000 of plain Latin take ~25 ms. An agent choosing
 * its text can choose the expensive kind, so a draw's text budget is charged this, not the length.
 *
 * Ordinary text in any one script — a Hebrew paragraph, Thai a line long, English with an emoji —
 * costs about its length.
 */

/** Cost of one change of direction or script, or one bidi control character. */
export const RUN_COST = 1_000;
/** Cost of one character of a script broken into lines by dictionary. */
export const DICTIONARY_COST = 50;

const NEUTRAL = 0;
const LATIN = 1;
const RTL = 2;
const DICTIONARY = 3;
const OTHER = 4;
const CONTROL = 5;

function classOf(code: number): number {
  if (code < 0x80)
    return (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
      ? LATIN
      : NEUTRAL;
  if (code < 0xc0) return NEUTRAL; // Latin-1 punctuation and symbols
  if (code <= 0x02ff) return LATIN;
  if (code <= 0x036f) return NEUTRAL; // combining marks go with their base
  if (code === 0x061c) return CONTROL;
  if (code >= 0x0590 && code <= 0x08ff) return RTL;
  if (
    (code >= 0x0e00 && code <= 0x0eff) || // Thai, Lao
    (code >= 0x1000 && code <= 0x109f) || // Myanmar
    (code >= 0x1780 && code <= 0x17ff) || // Khmer
    (code >= 0x1a20 && code <= 0x1aaf) || // Tai Tham
    (code >= 0xa9e0 && code <= 0xa9ff) ||
    (code >= 0xaa60 && code <= 0xaa7f)
  )
    return DICTIONARY;
  if (code >= 0x1e00 && code <= 0x1eff) return LATIN;
  if (
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
    return CONTROL;
  if (code >= 0x2000 && code <= 0x2bff) return NEUTRAL; // punctuation, symbols, arrows
  if (code >= 0x3000 && code <= 0x303f) return NEUTRAL; // CJK punctuation
  if (code >= 0xdc00 && code <= 0xdfff) return NEUTRAL; // second half of a pair
  if (code >= 0xfb1d && code <= 0xfdff) return RTL;
  if (code >= 0xfe00 && code <= 0xfe0f) return NEUTRAL; // variation selectors
  if (code >= 0xfe70 && code <= 0xfeff) return code === 0xfeff ? NEUTRAL : RTL;
  // first halves of pairs for the supplementary right-to-left blocks
  if (code === 0xd802 || code === 0xd803 || code === 0xd83a || code === 0xd83b)
    return RTL;
  return OTHER;
}

/** Characters outside plain ASCII: the only text whose cost is not its length. */
const BEYOND_ASCII = /[^\u0000-\u007f]/;

export function layoutCost(text: string): number {
  if (!BEYOND_ASCII.test(text)) return text.length;
  let cost = text.length;
  let last = NEUTRAL;
  for (let index = 0; index < text.length; index++) {
    const kind = classOf(text.charCodeAt(index));
    if (kind === NEUTRAL) continue;
    if (kind === CONTROL) {
      cost += RUN_COST;
      continue;
    }
    if (kind === DICTIONARY) cost += DICTIONARY_COST;
    if (last !== NEUTRAL && kind !== last) cost += RUN_COST;
    last = kind;
  }
  return cost;
}
