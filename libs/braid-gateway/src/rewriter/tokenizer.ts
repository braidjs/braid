/**
 * The HTML tokenizer, as the WHATWG spec defines it, for a rewriter.
 *
 * What a tag is, what is text and what is a comment has to be decided exactly as the browser will
 * decide it for the rewriter's output — a `<` the rewriter took for text and the browser takes for
 * a tag is markup that no transform ever saw. So this follows the spec's states rather than
 * approximating them: every way a comment ends (`-->`, `--!>`, `<!-->`, `<!--->`), bogus comments
 * (`<?…>`, `</1…>`, `<!x…>`), which end at the first `>` whatever the quotes, doctypes, which do
 * too, CDATA (only in foreign content, which the caller says), tag and attribute names that run to
 * whitespace, `/` or `>` whatever they contain, and the content states: RCDATA, RAWTEXT, PLAINTEXT
 * and script data with its escape states, where `<!--` and `<script>` change where `</script>`
 * ends the element.
 *
 * It does not decode or normalize: each token carries the source text it came from, so a token
 * nothing changes is written back byte for byte. Input arrives in pieces; a token split across them
 * is held until it is complete, and text — including raw text, which can be most of a document — is
 * handed on as it arrives, held back only by as much as could be the start of what ends it.
 *
 * Which content state follows a start tag is the tree's decision, not the tokenizer's (`<style>` is
 * raw text in HTML and markup in SVG), so the caller sets {@link Tokenizer.switchTo} and
 * {@link Tokenizer.cdataAllowed} as it goes.
 */

export interface RawAttribute {
  /** Lowercased, as the DOM sees it. */
  name: string;
  /** As authored. */
  rawName: string;
  /** The value as authored, quotes excluded and character references undecoded; null for none. */
  raw: string | null;
}

export type Token =
  /** Text, and the content state it was read in: data, RCDATA, RAWTEXT, script data or PLAINTEXT. */
  | { type: 'text'; raw: string; state: ContentState }
  | { type: 'start'; raw: string; name: string; attributes: RawAttribute[]; selfClosing: boolean }
  | { type: 'end'; raw: string; name: string }
  /** A comment; `complete` is false only for one the input ended inside. */
  | { type: 'comment'; raw: string; complete: boolean }
  /** A bogus comment: `<?…>`, `</` and a non-letter, or `<!` and anything not a comment or doctype. */
  | { type: 'bogus'; raw: string; data: string }
  | { type: 'doctype'; raw: string }
  /** A piece of a CDATA section: `text` is its content, `raw` the same with any delimiters it includes. */
  | { type: 'cdata'; raw: string; text: string }
  /** `</>`, which the browser drops. */
  | { type: 'nothing'; raw: string }
  /** A tag the input ended inside, which the browser drops. */
  | { type: 'unterminated'; raw: string };

export type ContentState = 'data' | 'rcdata' | 'rawtext' | 'script' | 'plaintext';

/** How far reading an incomplete tag got (see {@link Tokenizer.tag}). */
interface PendingTag {
  /** The tag's `<`. */
  at: number;
  /** Null while the name itself is incomplete. */
  name: string | null;
  attributes: RawAttribute[];
  seen: Set<string>;
  /** Where the attribute being read when the input ran out starts. */
  resumeAt: number;
  /** Where to go on looking for the closing quote of that attribute's value, or -1. */
  quoteFrom: number;
}

/** Where script data is: plain, after `<!--`, or after `<!--` and then `<script>`. */
type ScriptState = 'data' | 'escaped' | 'double';

export class Tokenizer {
  /** Whether `<![CDATA[` opens a CDATA section: true when the adjusted current node is not HTML. */
  cdataAllowed = false;

  private buffer = '';
  private index = 0;
  private ended = false;

  private state: ContentState = 'data';
  /** The element whose end tag ends the current RCDATA, RAWTEXT or script data. */
  private endTagName = '';
  private scriptState: ScriptState = 'data';
  /** Consecutive `-` just read in escaped script data: two and a `>` return to plain script data. */
  private dashes = 0;
  private inCdata = false;

  /** For a comment, bogus comment or doctype still incomplete: where to resume looking for its end. */
  private resumeAt = -1;
  private resumeFrom = 0;
  /** A tag still incomplete at the end of the input so far, and how far reading it got. */
  private pendingTag: PendingTag | null = null;
  /**
   * A tag, comment, bogus comment or doctype is incomplete, and what could end it has not arrived
   * since: a `>`, the closing quote of a value being read, or a comment's `-->`/`--!>` (the last few
   * characters kept, as it may straddle pieces). Checked against each new piece of input alone, so a
   * long token arriving in many pieces is not read again (nor its buffer flattened) for every piece.
   */
  private wake: { char: string } | { commentTail: string } | null = null;

  /** Appends input. */
  feed(text: string): void {
    const wake = this.wake;
    if (wake) {
      if ('char' in wake) {
        if (text.includes(wake.char)) this.wake = null;
      } else if (/--!?>/.test(wake.commentTail + text)) {
        this.wake = null;
      } else {
        wake.commentTail = (wake.commentTail + text).slice(-3);
      }
    }
    if (this.index > 0) {
      this.buffer = this.buffer.slice(this.index);
      if (this.resumeAt !== -1) {
        this.resumeAt -= this.index;
        this.resumeFrom -= this.index;
      }
      const tag = this.pendingTag;
      if (tag) {
        tag.at -= this.index;
        tag.resumeAt -= this.index;
        if (tag.quoteFrom !== -1) tag.quoteFrom -= this.index;
      }
      this.index = 0;
    }
    this.buffer += text;
  }

  /** Marks the end of input: what is still incomplete is emitted as the browser would read it at EOF. */
  end(): void {
    this.ended = true;
  }

  /** Whether the input has ended. */
  get isEnded(): boolean {
    return this.ended;
  }

  /** Switches the content state, for the element whose start tag was just read. */
  switchTo(state: Exclude<ContentState, 'data'>, tagName: string): void {
    this.state = state;
    this.endTagName = tagName;
    this.scriptState = 'data';
    this.dashes = 0;
  }

  /** The state the input is in, for closing what it left open. */
  get contentState(): { state: ContentState; tagName: string; scriptState: ScriptState } {
    return { state: this.state, tagName: this.endTagName, scriptState: this.scriptState };
  }

  /** The next token, or null when more input is needed (or, once ended, when there is none). */
  next(): Token | null {
    if (this.wake && !this.ended) return null;
    if (this.index >= this.buffer.length) return null;
    switch (this.state) {
      case 'plaintext':
        return this.take(this.buffer.length, 'text');
      case 'rcdata':
      case 'rawtext':
        return this.rawText();
      case 'script':
        return this.scriptData();
      case 'data':
        return this.inCdata ? this.cdata() : this.data();
    }
  }

  // --- content states ---

  private data(): Token | null {
    const lessThan = this.buffer.indexOf('<', this.index);
    if (lessThan === -1) return this.take(this.buffer.length, 'text');
    if (lessThan > this.index) return this.take(lessThan, 'text');
    return this.markup();
  }

  private rawText(): Token | null {
    const { buffer } = this;
    const nameLength = this.endTagName.length;
    let at = buffer.indexOf('</', this.index);
    while (at !== -1) {
      const delimiterAt = at + 2 + nameLength;
      if (delimiterAt >= buffer.length) {
        if (!this.ended) break;
      } else if (isDelimiter(buffer[delimiterAt]) && this.isEndTagName(at + 2)) {
        return this.endContent(at);
      }
      at = buffer.indexOf('</', at + 1);
    }
    if (this.ended) return this.take(buffer.length, 'text');
    // hold back what could still become `</name` and its delimiter
    const safe = Math.max(this.index, buffer.length - (nameLength + 2));
    return safe > this.index ? this.take(safe, 'text') : null;
  }

  private scriptData(): Token | null {
    const { buffer } = this;
    let at = this.index;
    while (at < buffer.length) {
      const char = buffer[at];
      if (char === '<') {
        // `</script` and a delimiter ends the element outside a double escape, and moves from a
        // double escape back to a single one inside one
        const endTag = this.match(at, '</script', true);
        if (endTag === undefined) return this.holdBack(at);
        if (endTag) {
          if (this.scriptState !== 'double') return this.endContent(at);
          this.scriptState = 'escaped';
          this.dashes = 0;
          at += 9;
          continue;
        }
        if (this.scriptState === 'data') {
          const escape = this.match(at, '<!--', false);
          if (escape === undefined) return this.holdBack(at);
          if (escape) {
            this.scriptState = 'escaped';
            this.dashes = 2; // `<!-->` is an escape opened and closed
            at += 4;
            continue;
          }
        } else if (this.scriptState === 'escaped') {
          const doubleEscape = this.match(at, '<script', true);
          if (doubleEscape === undefined) return this.holdBack(at);
          if (doubleEscape) {
            this.scriptState = 'double';
            this.dashes = 0;
            at += 8;
            continue;
          }
        }
        this.dashes = 0;
        at++;
        continue;
      }
      if (this.scriptState !== 'data') {
        if (char === '-') this.dashes++;
        else if (char === '>' && this.dashes >= 2) {
          this.scriptState = 'data';
          this.dashes = 0;
        } else this.dashes = 0;
      }
      at++;
    }
    return this.take(buffer.length, 'text');
  }

  private cdata(): Token | null {
    const close = this.buffer.indexOf(']]>', this.index);
    if (close !== -1) {
      const text = this.buffer.slice(this.index, close);
      const raw = this.buffer.slice(this.index, close + 3);
      this.index = close + 3;
      this.inCdata = false;
      return { type: 'cdata', raw, text };
    }
    // hold back a `]` or `]]` that may be the start of `]]>`
    const safe = this.ended ? this.buffer.length : Math.max(this.index, this.buffer.length - 2);
    if (safe === this.index) return null;
    const text = this.buffer.slice(this.index, safe);
    this.index = safe;
    return { type: 'cdata', raw: text, text };
  }

  // --- markup ---

  /** At a `<` in the data state. */
  private markup(): Token | null {
    const { buffer } = this;
    const at = this.index;
    if (at + 1 >= buffer.length) return this.ended ? this.take(at + 1, 'text') : null;
    const next = buffer[at + 1];

    if (isAsciiAlpha(next)) return this.tag(at, false);

    if (next === '/') {
      if (at + 2 >= buffer.length) return this.ended ? this.take(at + 2, 'text') : null;
      const after = buffer[at + 2];
      if (isAsciiAlpha(after)) return this.tag(at, true);
      if (after === '>') return this.take(at + 3, 'nothing');
      return this.bogus(at, at + 2);
    }

    if (next === '?') return this.bogus(at, at + 1);

    if (next === '!') {
      const rest = buffer.slice(at + 2, at + 9);
      if (rest.startsWith('--')) return this.comment(at);
      if (!this.ended && rest.length < 2 && '--'.startsWith(rest)) return null;
      if (rest.length === 7 ? rest.toLowerCase() === 'doctype' : !this.ended && 'doctype'.startsWith(rest.toLowerCase())) {
        return rest.length === 7 ? this.doctype(at) : null;
      }
      if (this.cdataAllowed) {
        if (rest === '[CDATA[') {
          this.index = at + 9;
          this.inCdata = true;
          return { type: 'cdata', raw: '<![CDATA[', text: '' };
        }
        if (!this.ended && rest.length < 7 && '[CDATA['.startsWith(rest)) return null;
      }
      return this.bogus(at, at + 2);
    }

    // `<` not opening anything is text
    return this.take(at + 1, 'text');
  }

  private comment(at: number): Token | null {
    const { buffer } = this;
    const start = at + 4;
    // `<!-->` and `<!--->` are empty comments, ended by their own dashes
    if (start >= buffer.length) return this.incompleteComment(at, at + 4, false);
    if (buffer[start] === '>') return this.take(start + 1, 'comment');
    if (buffer[start] === '-') {
      if (start + 1 >= buffer.length) return this.incompleteComment(at, at + 4, false);
      if (buffer[start + 1] === '>') return this.take(start + 2, 'comment');
    }

    let from = this.resumeAt === at ? this.resumeFrom : start;
    for (;;) {
      const dashes = buffer.indexOf('--', from);
      if (dashes === -1) {
        // a single `-` at the very end could be the first of the two
        return this.incompleteComment(at, Math.max(start, buffer.length - 1));
      }
      let after = dashes + 2;
      while (after < buffer.length && buffer[after] === '-') after++;
      if (after >= buffer.length) return this.incompleteComment(at, dashes);
      if (buffer[after] === '>') return this.take(after + 1, 'comment');
      if (buffer[after] === '!') {
        if (after + 1 >= buffer.length) return this.incompleteComment(at, dashes);
        if (buffer[after + 1] === '>') return this.take(after + 2, 'comment');
        from = after + 1;
        continue;
      }
      from = after;
    }
  }

  /** @param waitForEnd whether only a `-->`/`--!>` could complete it, rather than any next character */
  private incompleteComment(at: number, resumeFrom: number, waitForEnd = true): Token | null {
    if (this.ended) {
      const raw = this.buffer.slice(at);
      this.index = this.buffer.length;
      this.resumeAt = -1;
      return { type: 'comment', raw, complete: false };
    }
    this.resumeAt = at;
    this.resumeFrom = resumeFrom;
    if (waitForEnd) this.wake = { commentTail: this.buffer.slice(-3) };
    return null;
  }

  /** A bogus comment, whose data starts at `dataStart` and which ends at the first `>`. */
  private bogus(at: number, dataStart: number): Token | null {
    const close = this.buffer.indexOf('>', this.resumeAt === at ? this.resumeFrom : dataStart);
    if (close === -1) {
      if (!this.ended) return this.waitFrom(at, this.buffer.length);
      const raw = this.buffer.slice(at);
      this.index = this.buffer.length;
      this.resumeAt = -1;
      return { type: 'bogus', raw, data: raw.slice(dataStart - at) };
    }
    this.resumeAt = -1;
    const raw = this.buffer.slice(at, close + 1);
    this.index = close + 1;
    return { type: 'bogus', raw, data: raw.slice(dataStart - at, -1) };
  }

  /** A doctype ends at the first `>`: quotes around its identifiers do not protect one. */
  private doctype(at: number): Token | null {
    const close = this.buffer.indexOf('>', this.resumeAt === at ? this.resumeFrom : at + 9);
    if (close === -1) {
      if (!this.ended) return this.waitFrom(at, this.buffer.length);
      this.resumeAt = -1;
      return this.take(this.buffer.length, 'doctype');
    }
    this.resumeAt = -1;
    return this.take(close + 1, 'doctype');
  }

  private waitFrom(at: number, from: number): null {
    this.resumeAt = at;
    this.resumeFrom = from;
    this.wake = { char: '>' };
    return null;
  }

  /**
   * A start or end tag, starting at its `<`.
   *
   * A tag can end only at a `>`, so one still incomplete is not read again until a `>` arrives — or,
   * inside a quoted value, its closing quote (see {@link Tokenizer.wake}); and then reading resumes
   * after the last attribute it completed. A long tag arriving in many small chunks — one value of megabytes, or many thousands
   * of attributes — costs its length once, not once per chunk.
   */
  private tag(at: number, isEnd: boolean): Token | null {
    const { buffer } = this;
    const length = buffer.length;
    const pending = this.pendingTag?.at === at ? this.pendingTag : null;

    let index: number;
    let name: string;
    let attributes: RawAttribute[];
    /** The attribute names already read: the first of a repeated one is the one the browser keeps. */
    let seen: Set<string>;
    if (pending?.name != null) {
      ({ name, attributes, seen } = pending);
      index = pending.resumeAt;
    } else {
      index = at + (isEnd ? 2 : 1);
      const nameStart = index;
      while (index < length && !isWhitespace(buffer[index]) && buffer[index] !== '/' && buffer[index] !== '>') index++;
      if (index >= length) return this.incompleteTag(at, null, [], new Set(), index, -1);
      name = normalizeName(buffer.slice(nameStart, index));
      attributes = [];
      seen = new Set();
    }
    let selfClosing = false;

    for (;;) {
      // where reading resumes if the input ends before this attribute does
      const attributeAt = index;
      while (index < length && isWhitespace(buffer[index])) index++;
      if (index >= length) return this.incompleteTag(at, name, attributes, seen, attributeAt, -1);
      const char = buffer[index];

      if (char === '>') break;
      if (char === '/') {
        if (index + 1 >= length) return this.incompleteTag(at, name, attributes, seen, attributeAt, -1);
        if (buffer[index + 1] === '>') {
          selfClosing = true;
          index++;
          break;
        }
        index++;
        continue;
      }

      // An attribute name runs to whitespace, `/`, `>` or `=` — though a leading `=` is part of it.
      // Quotes and `<` are part of it too: the browser reads `<a "onclick=…>` as an attribute named
      // `"onclick`.
      const attributeStart = index;
      if (char === '=') index++;
      while (
        index < length &&
        !isWhitespace(buffer[index]) &&
        buffer[index] !== '/' &&
        buffer[index] !== '>' &&
        buffer[index] !== '='
      ) {
        index++;
      }
      if (index >= length) return this.incompleteTag(at, name, attributes, seen, attributeAt, -1);
      const rawName = buffer.slice(attributeStart, index);

      let cursor = index;
      while (cursor < length && isWhitespace(buffer[cursor])) cursor++;
      if (cursor >= length) return this.incompleteTag(at, name, attributes, seen, attributeAt, -1);

      let raw: string | null = null;
      if (buffer[cursor] === '=') {
        cursor++;
        while (cursor < length && isWhitespace(buffer[cursor])) cursor++;
        if (cursor >= length) return this.incompleteTag(at, name, attributes, seen, attributeAt, -1);
        const quote = buffer[cursor];
        if (quote === '"' || quote === "'") {
          const searchFrom = pending?.resumeAt === attributeAt && pending.quoteFrom > cursor ? pending.quoteFrom : cursor + 1;
          const close = buffer.indexOf(quote, searchFrom);
          if (close === -1) return this.incompleteTag(at, name, attributes, seen, attributeAt, length, quote);
          raw = buffer.slice(cursor + 1, close);
          cursor = close + 1;
        } else if (quote === '>') {
          raw = ''; // `a=>`: an empty value, and the tag ends
        } else {
          const valueStart = cursor;
          while (cursor < length && !isWhitespace(buffer[cursor]) && buffer[cursor] !== '>') cursor++;
          if (cursor >= length) return this.incompleteTag(at, name, attributes, seen, attributeAt, -1);
          raw = buffer.slice(valueStart, cursor);
        }
      }
      index = cursor;

      // the first of a repeated attribute is the one the browser keeps
      const lowered = normalizeName(rawName);
      if (!seen.has(lowered)) {
        seen.add(lowered);
        attributes.push({ name: lowered, rawName, raw });
      }
    }

    this.pendingTag = null;
    const raw = buffer.slice(at, index + 1);
    this.index = index + 1;
    return isEnd ? { type: 'end', raw, name } : { type: 'start', raw, name, attributes, selfClosing };
  }

  private incompleteTag(
    at: number,
    name: string | null,
    attributes: RawAttribute[],
    seen: Set<string>,
    resumeAt: number,
    quoteFrom: number,
    quote = '>',
  ): Token | null {
    if (this.ended) {
      this.pendingTag = null;
      return this.unterminated(at);
    }
    this.pendingTag = { at, name, attributes, seen, resumeAt, quoteFrom };
    this.wake = { char: quote };
    return null;
  }

  private unterminated(at: number): Token {
    const raw = this.buffer.slice(at);
    this.index = this.buffer.length;
    return { type: 'unterminated', raw };
  }

  // --- helpers ---

  /** Ends RCDATA, RAWTEXT or script data at an end tag starting at `at`, which is read next as markup. */
  private endContent(at: number): Token | null {
    const text = at > this.index ? this.take(at, 'text') : null;
    this.state = 'data';
    this.scriptState = 'data';
    this.dashes = 0;
    return text ?? this.next();
  }

  /** In script data: emit what precedes `at` and wait there for the input that decides it. */
  private holdBack(at: number): Token | null {
    return at > this.index ? this.take(at, 'text') : null;
  }

  /**
   * Whether `sequence` (and, if `delimited`, a whitespace, `/` or `>` after it) starts at `at`,
   * ASCII case-insensitively: true, false, or undefined when the input so far cannot say.
   */
  private match(at: number, sequence: string, delimited: boolean): boolean | undefined {
    const { buffer } = this;
    const needed = sequence.length + (delimited ? 1 : 0);
    const available = buffer.length - at;
    const compared = Math.min(available, sequence.length);
    if (buffer.slice(at, at + compared).toLowerCase() !== sequence.slice(0, compared)) return false;
    if (available < needed) return this.ended ? false : undefined;
    return !delimited || isDelimiter(buffer[at + sequence.length]);
  }

  private isEndTagName(at: number): boolean {
    const name = this.endTagName;
    for (let offset = 0; offset < name.length; offset++) {
      const code = this.buffer.charCodeAt(at + offset);
      // ASCII lowercasing only, as the tokenizer does
      if ((code >= 0x41 && code <= 0x5a ? code + 0x20 : code) !== name.charCodeAt(offset)) return false;
    }
    return true;
  }

  private take(end: number, type: 'text' | 'comment' | 'doctype' | 'nothing'): Token {
    const raw = this.buffer.slice(this.index, end);
    this.index = end;
    this.resumeAt = -1;
    if (type === 'text') return { type, raw, state: this.inCdata ? 'data' : this.state };
    return type === 'comment' ? { type, raw, complete: true } : { type, raw };
  }
}

export function isWhitespace(char: string): boolean {
  // the browser normalizes CR to LF before tokenizing, so it separates like any other whitespace
  return char === ' ' || char === '\n' || char === '\t' || char === '\f' || char === '\r';
}

function isDelimiter(char: string): boolean {
  return isWhitespace(char) || char === '/' || char === '>';
}

function isAsciiAlpha(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** ASCII-lowercased, with NUL read as U+FFFD, as the tokenizer names tags and attributes. */
function normalizeName(name: string): string {
  let lowered = '';
  let changed = false;
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if ((code >= 0x41 && code <= 0x5a) || code === 0) {
      changed = true;
      break;
    }
  }
  if (!changed) return name;
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    lowered += code === 0 ? '�' : code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : name[index];
  }
  return lowered;
}
