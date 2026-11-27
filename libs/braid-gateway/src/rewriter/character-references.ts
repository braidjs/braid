/**
 * Character references in attribute values, decoded the way the HTML tokenizer decodes them.
 *
 * The rewriter reads a handful of attributes to decide what a tag does (`rel`, `type`,
 * `http-equiv`, a frame's `src`, MathML's `encoding`), and a value it reads differently from the
 * browser is a value it judged wrongly. Numeric references are decoded in full. Named ones are
 * decoded from a small table — every name the tokenizer accepts without a semicolon, which have to
 * be known to know where a reference ends, and the ASCII punctuation a URL scheme could be spelled
 * with — rather than all ~2,200, which would weigh on every gateway and service-worker bundle.
 *
 * A `&name;` the table does not have might be a reference the browser decodes or literal text, and
 * nothing here can tell which: the value is reported `uncertain`, and a fragment's attribute that
 * is read while uncertain is removed rather than guessed at (see `html-rewrite-stream.ts`).
 */

/** Names the tokenizer decodes without a trailing semicolon, with their code points. */
const LEGACY =
  'AElig:c6 AMP:26 Aacute:c1 Acirc:c2 Agrave:c0 Aring:c5 Atilde:c3 Auml:c4 COPY:a9 Ccedil:c7 ETH:d0 Eacute:c9 Ecirc:ca ' +
  'Egrave:c8 Euml:cb GT:3e Iacute:cd Icirc:ce Igrave:cc Iuml:cf LT:3c Ntilde:d1 Oacute:d3 Ocirc:d4 Ograve:d2 Oslash:d8 ' +
  'Otilde:d5 Ouml:d6 QUOT:22 REG:ae THORN:de Uacute:da Ucirc:db Ugrave:d9 Uuml:dc Yacute:dd aacute:e1 acirc:e2 acute:b4 ' +
  'aelig:e6 agrave:e0 amp:26 aring:e5 atilde:e3 auml:e4 brvbar:a6 ccedil:e7 cedil:b8 cent:a2 copy:a9 curren:a4 deg:b0 ' +
  'divide:f7 eacute:e9 ecirc:ea egrave:e8 eth:f0 euml:eb frac12:bd frac14:bc frac34:be gt:3e iacute:ed icirc:ee iexcl:a1 ' +
  'igrave:ec iquest:bf iuml:ef laquo:ab lt:3c macr:af micro:b5 middot:b7 nbsp:a0 not:ac ntilde:f1 oacute:f3 ocirc:f4 ' +
  'ograve:f2 ordf:aa ordm:ba oslash:f8 otilde:f5 ouml:f6 para:b6 plusmn:b1 pound:a3 quot:22 raquo:bb reg:ae sect:a7 shy:ad ' +
  'sup1:b9 sup2:b2 sup3:b3 szlig:df thorn:fe times:d7 uacute:fa ucirc:fb ugrave:f9 uml:a8 uuml:fc yacute:fd yen:a5 yuml:ff';

/** Further names decoded only with their semicolon: ASCII punctuation, and the commonest typography. */
const NAMED =
  'Tab:9 NewLine:a excl:21 num:23 dollar:24 percnt:25 apos:27 lpar:28 rpar:29 ast:2a midast:2a plus:2b comma:2c period:2e ' +
  'sol:2f colon:3a semi:3b equals:3d quest:3f commat:40 lsqb:5b lbrack:5b bsol:5c rsqb:5d rbrack:5d Hat:5e lowbar:5f ' +
  'UnderBar:5f grave:60 DiacriticalGrave:60 lcub:7b lbrace:7b verbar:7c vert:7c VerticalLine:7c rcub:7d rbrace:7d ' +
  'NonBreakingSpace:a0 hyphen:2010 dash:2010 ndash:2013 mdash:2014 lsquo:2018 rsquo:2019 ldquo:201c rdquo:201d ' +
  'hellip:2026 bull:2022 trade:2122 euro:20ac';

const parse = (table: string): Map<string, string> =>
  new Map(
    table.split(' ').map((entry) => {
      const [name, code] = entry.split(':');
      return [name, String.fromCodePoint(parseInt(code, 16))];
    }),
  );

const legacy = parse(LEGACY);
/** Every name this table decodes when it ends in a semicolon: the legacy ones have semicolon forms too. */
const named = new Map([...legacy, ...parse(NAMED)]);
const LONGEST_LEGACY = Math.max(...[...legacy.keys()].map((name) => name.length));

/** Numeric references to C1 controls are read as windows-1252, per the tokenizer. */
const C1_REPLACEMENTS: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const isAlphanumeric = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isHexDigit = (code: number): boolean =>
  isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);

export interface DecodedAttribute {
  value: string;
  /** A `&name;` this table does not know: the browser may read the value differently. */
  uncertain: boolean;
}

/**
 * Decodes an attribute value as the DOM will hold it: character references decoded as the
 * tokenizer decodes them, line breaks normalized and NUL replaced, as the input stream is.
 */
export function decodeAttributeValue(source: string): DecodedAttribute {
  const raw = /[\r\0]/.test(source) ? source.replace(/\r\n?/g, '\n').replaceAll('\0', '\ufffd') : source;
  if (!raw.includes('&')) return { value: raw, uncertain: false };

  let value = '';
  let uncertain = false;
  let index = 0;
  for (;;) {
    const ampersand = raw.indexOf('&', index);
    if (ampersand === -1) {
      value += raw.slice(index);
      return { value, uncertain };
    }
    value += raw.slice(index, ampersand);
    index = ampersand + 1;

    if (raw[index] === '#') {
      const numeric = decodeNumeric(raw, index + 1);
      if (numeric) {
        value += numeric.text;
        index = numeric.end;
      } else {
        value += '&';
      }
      continue;
    }

    let end = index;
    while (end < raw.length && isAlphanumeric(raw.charCodeAt(end))) end++;
    if (end === index) {
      value += '&';
      continue;
    }
    const name = raw.slice(index, end);

    if (raw[end] === ';') {
      const decoded = named.get(name);
      if (decoded !== undefined) {
        value += decoded;
        index = end + 1;
        continue;
      }
      // Not a name this table has. A legacy prefix of it would be followed by more letters, which
      // in an attribute the tokenizer does not decode — so it is either a reference this table
      // lacks, or literal text.
      uncertain = true;
      value += '&';
      continue;
    }

    // Without a semicolon only the legacy names decode, and in an attribute only when the name is
    // not followed by more of a name or by `=` (so `?a=1&copy=2` keeps its query).
    if (name.length <= LONGEST_LEGACY && legacy.has(name) && raw[end] !== '=') {
      value += legacy.get(name)!;
      index = end;
      continue;
    }
    value += '&';
  }
}

/** Decodes `&#…`, starting just past the `#`; null when no digits follow (the text stays literal). */
function decodeNumeric(raw: string, from: number): { text: string; end: number } | null {
  let index = from;
  const hex = raw[index] === 'x' || raw[index] === 'X';
  if (hex) index++;
  const digitsStart = index;
  let code = 0;
  while (index < raw.length && (hex ? isHexDigit(raw.charCodeAt(index)) : isDigit(raw.charCodeAt(index)))) {
    // capped, so a long run of digits cannot overflow past the out-of-range check
    code = Math.min(code * (hex ? 16 : 10) + parseInt(raw[index], 16), 0x110000);
    index++;
  }
  if (index === digitsStart) return null;
  if (raw[index] === ';') index++;

  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
  else code = C1_REPLACEMENTS[code] ?? code;
  return { text: String.fromCodePoint(code), end: index };
}

/** The names this table decodes, for its tests. */
export const KNOWN_REFERENCE_NAMES: ReadonlySet<string> = new Set(named.keys());
export const LEGACY_REFERENCE_NAMES: ReadonlySet<string> = new Set(legacy.keys());
