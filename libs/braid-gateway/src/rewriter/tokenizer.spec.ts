import { type Token as Parse5Token, Tokenizer as Parse5Tokenizer, TokenizerMode } from 'parse5';
import { describe, expect, it } from 'vitest';
import { hostileCases, random } from '../../testing/hostile-markup.js';
import { decodeAttributeValue, KNOWN_REFERENCE_NAMES, LEGACY_REFERENCE_NAMES } from './character-references.js';
import { type ContentState, type Token, Tokenizer } from './tokenizer.js';

/**
 * The tokenizer against the spec's: targeted vectors for each way markup ends that the old scanner
 * got wrong, and a differential against parse5's tokenizer — which implements the spec's state
 * machine directly — on generated hostile markup, fed in random pieces.
 */

/** The content state each raw-text element opens when it is an HTML element. */
const RAW_TEXT: Record<string, Exclude<ContentState, 'data'>> = {
  script: 'script',
  style: 'rawtext',
  xmp: 'rawtext',
  iframe: 'rawtext',
  noembed: 'rawtext',
  noframes: 'rawtext',
  noscript: 'rawtext',
  textarea: 'rcdata',
  title: 'rcdata',
  plaintext: 'plaintext',
};

const PARSE5_STATE = {
  script: TokenizerMode.SCRIPT_DATA,
  rawtext: TokenizerMode.RAWTEXT,
  rcdata: TokenizerMode.RCDATA,
  plaintext: TokenizerMode.PLAINTEXT,
};

/** A token as both tokenizers can describe it: text is left out, since this one does not decode it. */
type Summary = string;

/** Tokenizes in pieces, switching content state after raw-text start tags unless `foreign`. */
function tokenize(html: string, options: { splits?: number[]; foreign?: boolean } = {}): Token[] {
  const tokenizer = new Tokenizer();
  tokenizer.cdataAllowed = options.foreign ?? false;
  const cuts = [...new Set(options.splits ?? [])].filter((cut) => cut > 0 && cut < html.length).sort((a, b) => a - b);
  const pieces = [0, ...cuts, html.length].slice(1).map((end, index, ends) => html.slice(index ? ends[index - 1] : 0, end));
  const tokens: Token[] = [];
  for (const [index, piece] of pieces.entries()) {
    tokenizer.feed(piece);
    if (index === pieces.length - 1) tokenizer.end();
    for (let token = tokenizer.next(); token; token = tokenizer.next()) {
      tokens.push(token);
      if (token.type === 'start' && !options.foreign && token.name in RAW_TEXT) tokenizer.switchTo(RAW_TEXT[token.name], token.name);
    }
  }
  return tokens;
}

const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replaceAll('\0', '�');

function summarize(tokens: Token[]): Summary[] {
  const summary: Summary[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'start': {
        const attributes = token.attributes.map(({ name, raw }) => {
          if (raw === null) return name;
          const { value, uncertain } = decodeAttributeValue(raw);
          return uncertain ? `${name}=?` : `${name}=${JSON.stringify(value)}`;
        });
        summary.push(`<${token.name}${attributes.map((a) => ` ${a}`).join('')}${token.selfClosing ? '/' : ''}>`);
        break;
      }
      case 'end':
        summary.push(`</${token.name}>`);
        break;
      case 'comment':
        summary.push(token.complete ? `comment ${JSON.stringify(normalize(commentData(token.raw)))}` : 'comment at eof');
        break;
      case 'bogus':
        summary.push(`comment ${JSON.stringify(normalize(token.data))}`);
        break;
      case 'doctype':
        summary.push('doctype');
        break;
    }
  }
  return summary;
}

function commentData(raw: string): string {
  if (raw === '<!-->' || raw === '<!--->') return '';
  return raw.slice(4).replace(/--!?>$/, '');
}

function parse5Summary(html: string, options: { foreign?: boolean } = {}): Summary[] {
  const summary: Summary[] = [];
  let lastIsEofComment = false;
  const tokenizer: Parse5Tokenizer = new Parse5Tokenizer(
    {},
    {
      onStartTag(token: Parse5Token.TagToken) {
        // parse5 keeps a repeated attribute's first value too
        const attributes = token.attrs.map(({ name, value }) => (value === '' && !/=/.test(name) ? name : `${name}=${JSON.stringify(value)}`));
        summary.push(`<${token.tagName}${attributes.map((a) => ` ${a}`).join('')}${token.selfClosing ? '/' : ''}>`);
        if (!options.foreign && token.tagName in RAW_TEXT) {
          tokenizer.state = PARSE5_STATE[RAW_TEXT[token.tagName]];
          tokenizer.lastStartTagName = token.tagName;
        }
      },
      onEndTag(token: Parse5Token.TagToken) {
        summary.push(`</${token.tagName}>`);
      },
      onComment(token: Parse5Token.CommentToken) {
        summary.push(`comment ${JSON.stringify(token.data)}`);
        lastIsEofComment = true;
      },
      onDoctype() {
        summary.push('doctype');
      },
      onEof() {},
      onCharacter() {},
      onNullCharacter() {},
      onWhitespaceCharacter() {},
    },
  );
  tokenizer.inForeignNode = options.foreign ?? false;
  tokenizer.write(html, true);
  void lastIsEofComment;
  return summary;
}

/** Ours, with a comment the input ended inside written as parse5 would have, when it can be. */
function comparable(ours: Summary[], theirs: Summary[]): [Summary[], Summary[]] {
  if (ours.at(-1) === 'comment at eof' && theirs.at(-1)?.startsWith('comment ')) {
    return [ours.slice(0, -1), theirs.slice(0, -1)];
  }
  return [ours, theirs];
}

/**
 * Attribute values without a value-less attribute's ambiguity: a name parse5 reports with the empty
 * value is written bare by both, except when ours had `=""`.
 */
function sameAttributes(ours: Summary[]): Summary[] {
  return ours.map((entry) => entry.replace(/ ([^\s=]+)=""/g, ' $1'));
}

describe('the tokenizer reads each construct as the spec does', () => {
  const vectors: [string, string, Summary[]][] = [
    ['a comment ends at --!>', '<!-- a --!><b>', ['comment " a "', '<b>']],
    ['<!--> is an empty comment', '<!--><b>-->', ['comment ""', '<b>']],
    ['<!---> is an empty comment', '<!---><b>-->', ['comment ""', '<b>']],
    ['dashes before > still end it', '<!-- a ----><b>', ['comment " a --"', '<b>']],
    ['--!- does not end it', '<!-- a --!-><b>-->', ['comment " a --!-><b>"']],
    ['<? is a bogus comment to the first >', '<?a"><b>"?>', ['comment "?a\\""', '<b>']],
    ['</ and a digit is a bogus comment', '</1 a="><b>">', ['comment "1 a=\\""', '<b>']],
    ['<! and a letter is a bogus comment, quotes or not', '<!a b="><b>">', ['comment "a b=\\""', '<b>']],
    ['</> is nothing', '</><b>', ['<b>']],
    ['a doctype ends at the first >, inside quotes too', '<!DOCTYPE x "a>b"><b>', ['doctype', '<b>']],
    ['<![CDATA[ outside foreign content is a bogus comment', '<![CDATA[<b>]]>', ['comment "[CDATA[<b"']],
    ['a tag name runs to whitespace, / or >', '<a$b\u000bc d=1>', ['<a$b\u000bc d="1">']],
    ['an attribute name keeps quotes and <', '<a "onclick=x <y=1>', ['<a "onclick="x" <y="1">']],
    ['a leading = is part of the name', '<a =b=1>', ['<a =b="1">']],
    ['/ separates attributes', '<img/src=x/onerror=y>', ['<img src="x/onerror=y">']],
    ['an empty unquoted value ends the tag', '<a b=>c', ['<a b="">']],
    ['a self-closing HTML style is still raw text', '<style/><b></style><i>', ['<style/>', '</style>', '<i>']],
    ['xmp is raw text', '<xmp><b></xmp>', ['<xmp>', '</xmp>']],
    ['iframe is raw text', '<iframe><b></iframe>', ['<iframe>', '</iframe>']],
    ['noembed is raw text', '<noembed><b></noembed>', ['<noembed>', '</noembed>']],
    ['noframes is raw text', '<noframes><b></noframes>', ['<noframes>', '</noframes>']],
    ['noscript is raw text, with scripting on', '<noscript><b></noscript>', ['<noscript>', '</noscript>']],
    ['plaintext never ends', '<plaintext></plaintext><b>', ['<plaintext>']],
    ['a raw-text end tag needs a delimiter', '<style></stylex></style\u000b></style\f><b>', ['<style>', '</style>', '<b>']],
    ['a raw-text end tag may carry attributes with >', '<style></style a=">"><b>', ['<style>', '</style>', '<b>']],
    ['an escaped script still ends at </script>', '<script><!--</script><b>', ['<script>', '</script>', '<b>']],
    ['a double-escaped script does not', '<script><!--<script></script><b></script>--><i>', ['<script>', '</script>', '<i>']],
    ['--> leaves the escape', '<script><!--<script>--></script><b>', ['<script>', '</script>', '<b>']],
    ['<!--> escapes and unescapes at once', '<script><!--><script></script><b>', ['<script>', '</script>', '<b>']],
    ['an unterminated tag is dropped at the end', '<b><a title="x', ['<b>']],
  ];

  for (const [name, html, expected] of vectors) {
    it(name, () => {
      expect(summarize(tokenize(html))).toEqual(expected);
      expect(sameAttributes(parse5Summary(html)), 'and parse5 agrees').toEqual(sameAttributes(expected));
      // the same at every split into two pieces, and in pieces of one character
      for (let cut = 1; cut < html.length; cut++) expect(summarize(tokenize(html, { splits: [cut] }))).toEqual(expected);
      const everyOffset = Array.from({ length: html.length }, (_, index) => index);
      expect(summarize(tokenize(html, { splits: everyOffset }))).toEqual(expected);
    });
  }

  it('<![CDATA[ in foreign content is a section, to the first ]]>', () => {
    const html = '<![CDATA[ > <!-- ]]><b>';
    const tokens = tokenize(html, { foreign: true });
    expect(tokens.filter((token) => token.type === 'cdata').map((token) => (token as { text: string }).text).join('')).toBe(
      ' > <!-- ',
    );
    expect(summarize(tokens)).toEqual(['<b>']);
    expect(parse5Summary(html, { foreign: true })).toEqual(['<b>']);
  });

  it('writes every token back as it arrived', () => {
    for (const html of hostileCases(500, 3)) {
      const raw = tokenize(html)
        .map((token) => token.raw)
        .join('');
      expect(raw).toBe(html);
    }
  });
});

describe('the tokenizer against parse5', () => {
  for (const foreign of [false, true]) {
    it(`agrees on generated hostile markup, ${foreign ? 'in foreign content' : 'in HTML'}, split anywhere`, () => {
      const next = random(foreign ? 11 : 13);
      const failures: string[] = [];
      for (const html of hostileCases(4000, foreign ? 5 : 6)) {
        const theirs = parse5Summary(html, { foreign });
        const splits = Array.from({ length: 1 + Math.floor(next() * 6) }, () => Math.floor(next() * html.length));
        for (const ours of [summarize(tokenize(html, { foreign })), summarize(tokenize(html, { foreign, splits }))]) {
          const [a, b] = comparable(sameAttributes(ours), sameAttributes(theirs));
          // an uncertain value is one this side declines to decode: parse5's is not compared
          const b2 = b.map((entry, index) => (a[index]?.includes('=?') ? a[index] : entry));
          if (JSON.stringify(a) !== JSON.stringify(b2)) {
            failures.push(`${JSON.stringify(html)}\n  ours:   ${JSON.stringify(a)}\n  parse5: ${JSON.stringify(b2)}`);
          }
        }
        if (failures.length >= 5) break;
      }
      expect(failures.join('\n')).toBe('');
    });
  }
});

describe('character references in attribute values', () => {
  const parse5Value = (raw: string): string => {
    let value = '';
    const tokenizer = new Parse5Tokenizer(
      {},
      {
        onStartTag: (token: Parse5Token.TagToken) => void (value = token.attrs[0]?.value ?? ''),
        onEndTag() {},
        onComment() {},
        onDoctype() {},
        onEof() {},
        onCharacter() {},
        onNullCharacter() {},
        onWhitespaceCharacter() {},
      },
    );
    tokenizer.write(`<a x="${raw}">`, true);
    return value;
  };

  it('decodes as parse5 does wherever it is certain', () => {
    const next = random(17);
    const parts = [
      '&', '#', 'x', 'X', ';', '=', 'amp', 'lt', 'not', 'notin', 'copy', 'colon', 'Tab', 'NewLine', 'sol', 'ampx', 'frac12',
      '1', '9', 'f', '106', '0', '128', '65533', '1114112', 'a', 'b', ' ', 'z',
    ];
    for (let index = 0; index < 20000; index++) {
      let raw = '';
      const length = 1 + Math.floor(next() * 8);
      for (let part = 0; part < length; part++) raw += parts[Math.floor(next() * parts.length)];
      const ours = decodeAttributeValue(raw);
      if (!ours.uncertain) expect(ours.value, raw).toBe(parse5Value(raw));
    }
  });

  it('is uncertain only of a named reference it does not have', () => {
    expect(decodeAttributeValue('a&hellip;b')).toEqual({ value: 'a…b', uncertain: false });
    expect(decodeAttributeValue('a&NotAName;b').uncertain).toBe(true);
    expect(decodeAttributeValue('a&NotAName b').uncertain).toBe(false);
    expect(decodeAttributeValue('?a=1&copy=2')).toEqual({ value: '?a=1&copy=2', uncertain: false });
  });

  it('knows every name the tokenizer decodes without a semicolon', () => {
    // each legacy name decodes bare; the other known ones do not
    for (const name of LEGACY_REFERENCE_NAMES) expect(parse5Value(`&${name} `), name).not.toBe(`&${name} `);
    for (const name of KNOWN_REFERENCE_NAMES) {
      if (!LEGACY_REFERENCE_NAMES.has(name)) expect(parse5Value(`&${name} `), name).toBe(`&${name} `);
      expect(decodeAttributeValue(`&${name};`).value, name).toBe(parse5Value(`&${name};`));
    }
  });

  it('normalizes line breaks and NUL as the input stream does', () => {
    expect(decodeAttributeValue('a\r\nb\rc\0').value).toBe(parse5Value('a\r\nb\rc\0'));
  });
});
