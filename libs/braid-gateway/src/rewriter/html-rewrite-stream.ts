/**
 * The owned streaming HTML rewriter (zero forked dependencies).
 *
 * Braid's streaming needs are narrow and known: rename three elements, neutralize scripts and
 * script-preload links, inject content at slot elements, and interleave two HTML streams. That
 * is a small enough surface to own outright rather than inherit a forked HTMLRewriter wasm
 * build — and owning it is what makes the composition protocol testable as a spec.
 *
 * Properties this implementation guarantees:
 *
 * - **Streaming**: output is produced as input arrives. Only the current (partial) tag is
 *   buffered, so memory stays bounded regardless of document size.
 * - **Chunk-boundary safe**: a tag, comment, doctype, or raw-text end sequence split across
 *   network chunks is reassembled before it is interpreted.
 * - **Fidelity by default**: a tag no handler modifies is emitted byte-for-byte as it arrived.
 *   Only mutated tags are re-serialized.
 * - **Stream injection**: injected content may itself be a `ReadableStream`, which is what makes
 *   piercing a true interleave (shell up to the slot, then the fragment's stream, then the rest
 *   of the shell) rather than a buffer-everything-then-concatenate.
 *
 * Scope note: this is a rewriter, not a parser. It does not build a tree, resolve implied tags,
 * or handle malformed-markup recovery — it observes a linear token stream. That is sufficient
 * for every transform in the composition protocol, and the conformance vectors in
 * `html-rewrite-stream.spec.ts` are the oracle for it.
 */

/** Content that can be injected: literal HTML, or a stream of it (interleaved as it arrives). */
export type Injection = string | ReadableStream<Uint8Array>;

export interface StartTag {
  /** The tag name, lowercased. Assigning renames the element. */
  tagName: string;
  readonly selfClosing: boolean;
  /** Lowercased names of the element's attributes, in source order. */
  readonly attributeNames: string[];
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  /** Emits content immediately before this start tag. */
  before(content: Injection): void;
  /** Emits content immediately after this start tag (i.e. as the element's first content). */
  prepend(content: Injection): void;
}

export interface EndTag {
  readonly tagName: string;
  /** Emits content immediately before this end tag. */
  before(content: Injection): void;
}

/**
 * A handler may return a promise, and the stream waits on it at that tag — everything before the
 * tag has already been emitted. That is how a pierced slot waits for its fragment without holding
 * back the shell ahead of it. Handlers that return nothing cost nothing extra.
 */
export interface ElementHandler {
  element?(tag: StartTag): void | Promise<void>;
  endTag?(tag: EndTag): void | Promise<void>;
}

export interface RewriteOptions {
  /**
   * Handlers keyed by lowercased tag name. The key `*` matches every element and runs before
   * the tag-specific handler — used for transforms that apply regardless of element, such as
   * stripping inline event handlers.
   */
  handlers: Record<string, ElementHandler>;
  /** Drops `<!doctype …>` tokens (nested doctypes make some parsers choke). */
  stripDoctype?: boolean;
  /**
   * Emitted once the input ends. Used as the safety net for injections anchored to an end tag
   * that never arrives — `</body>` is optional in HTML and frequently omitted.
   */
  onEnd?(): Injection | undefined | Promise<Injection | undefined>;
}

/**
 * Elements whose content is not parsed as markup. Inside them, `<` starts a tag only in the
 * element's own end-tag sequence.
 */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'title', 'textarea']);

/** Elements that never have an end tag, so renaming one must not open a rename scope. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

const encoder = new TextEncoder();

interface ParsedAttribute {
  /** Lowercased name, for lookups. */
  name: string;
  /** The name exactly as authored, so untouched attributes re-serialize unchanged. */
  rawName: string;
  /** Decoded value, or null for a valueless attribute. */
  value: string | null;
}

type TokenKind = 'start' | 'end' | 'comment' | 'doctype' | 'bogus';

interface Token {
  kind: TokenKind;
  /** Index just past the token in the buffer. */
  end: number;
  /** Lowercased tag name; empty for non-element tokens. */
  name: string;
  selfClosing: boolean;
  attributes: ParsedAttribute[];
}

export function rewriteHtmlStream(
  input: ReadableStream<Uint8Array>,
  options: RewriteOptions,
): ReadableStream<Uint8Array> {
  return toReadableStream(rewrite(input, options));
}

async function* rewrite(
  input: ReadableStream<Uint8Array>,
  options: RewriteOptions,
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  const reader = input.getReader();

  let buffer = '';
  /** Non-null while inside a raw-text element, holding its lowercased tag name. */
  let rawTextElement: string | null = null;
  /**
   * Open elements whose start tag a handler renamed. Renaming an element must rename its end
   * tag too — otherwise the renamed element is never closed, and everything that follows nests
   * inside it (a `<braid-head>` left open swallows the whole `<braid-body>`).
   */
  const openRenames: { original: string; renamed: string }[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      const result = yield* consume(buffer, done);
      buffer = result.remainder;
      rawTextElement = result.rawTextElement;

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  const trailing = await options.onEnd?.();
  if (trailing !== undefined) {
    yield* emit(trailing);
  }

  /**
   * Consumes as much of the buffer as can be interpreted unambiguously, yielding output.
   * Returns whatever tail must wait for more input (a partial tag, or the start of what might
   * be a raw-text end sequence).
   */
  async function* consume(
    text: string,
    isFinal: boolean,
  ): AsyncGenerator<Uint8Array, { remainder: string; rawTextElement: string | null }> {
    let index = 0;

    for (;;) {
      if (rawTextElement) {
        const closeIndex = findRawTextEnd(text, index, rawTextElement);

        if (closeIndex === -1) {
          if (isFinal) {
            yield* emitText(text.slice(index));
            return { remainder: '', rawTextElement };
          }
          // hold back enough characters that a split end-tag sequence stays reassemblable
          const safeEnd = text.length - (rawTextElement.length + 3);
          if (safeEnd > index) {
            yield* emitText(text.slice(index, safeEnd));
            index = safeEnd;
          }
          return { remainder: text.slice(index), rawTextElement };
        }

        if (closeIndex > index) {
          yield* emitText(text.slice(index, closeIndex));
        }
        index = closeIndex;
        rawTextElement = null;
      }

      const tagStart = text.indexOf('<', index);

      if (tagStart === -1) {
        yield* emitText(text.slice(index));
        return { remainder: '', rawTextElement };
      }

      if (tagStart > index) {
        yield* emitText(text.slice(index, tagStart));
        index = tagStart;
      }

      const token = scanToken(text, tagStart);

      if (!token) {
        if (isFinal) {
          // an unterminated tag at end of input is emitted verbatim rather than swallowed
          yield* emitText(text.slice(index));
          return { remainder: '', rawTextElement };
        }
        return { remainder: text.slice(index), rawTextElement };
      }

      const raw = text.slice(tagStart, token.end);
      index = token.end;

      switch (token.kind) {
        case 'doctype':
          if (!options.stripDoctype) yield* emitText(raw);
          break;

        case 'comment':
        case 'bogus':
          yield* emitText(raw);
          break;

        case 'start': {
          yield* emitStartTag(token, raw);
          if (!token.selfClosing && RAW_TEXT_ELEMENTS.has(token.name)) {
            rawTextElement = token.name;
          }
          break;
        }

        case 'end': {
          yield* emitEndTag(token, raw);
          break;
        }
      }
    }
  }

  async function* emitStartTag(token: Token, raw: string): AsyncGenerator<Uint8Array> {
    // the wildcard handler runs first, so element-specific handlers see (and can override) its
    // work rather than racing it
    const elementHandlers = [options.handlers['*']?.element, options.handlers[token.name]?.element].filter(
      (element) => element !== undefined,
    );

    if (elementHandlers.length === 0) {
      yield* emitText(raw);
      return;
    }

    const originalName = token.name;
    const before: Injection[] = [];
    const prepend: Injection[] = [];
    let dirty = false;
    let name = token.name;
    const attributes = token.attributes;

    const tag: StartTag = {
      get tagName() {
        return name;
      },
      set tagName(value: string) {
        name = value.toLowerCase();
        dirty = true;
      },
      selfClosing: token.selfClosing,
      get attributeNames() {
        return attributes.map((attribute) => attribute.name);
      },
      getAttribute(attributeName: string) {
        return attributes.find((attribute) => attribute.name === attributeName.toLowerCase())?.value ?? null;
      },
      setAttribute(attributeName: string, value: string) {
        const lowercased = attributeName.toLowerCase();
        const existing = attributes.find((attribute) => attribute.name === lowercased);
        if (existing) {
          existing.value = value;
        } else {
          attributes.push({ name: lowercased, rawName: attributeName, value });
        }
        dirty = true;
      },
      removeAttribute(attributeName: string) {
        const lowercased = attributeName.toLowerCase();
        const at = attributes.findIndex((attribute) => attribute.name === lowercased);
        if (at !== -1) {
          attributes.splice(at, 1);
          dirty = true;
        }
      },
      before(content: Injection) {
        before.push(content);
      },
      prepend(content: Injection) {
        prepend.push(content);
      },
    };

    for (const element of elementHandlers) {
      // awaited only when it is a promise: this runs for every element of every document, and an
      // unconditional await would be a microtask per tag
      const pending = element(tag);
      if (pending) await pending;
    }

    if (name !== originalName && !token.selfClosing && !VOID_ELEMENTS.has(originalName)) {
      openRenames.push({ original: originalName, renamed: name });
    }

    for (const content of before) {
      yield* emit(content);
    }

    yield* emitText(dirty ? serializeStartTag(name, attributes, token.selfClosing) : raw);

    for (const content of prepend) {
      yield* emit(content);
    }
  }

  async function* emitEndTag(token: Token, raw: string): AsyncGenerator<Uint8Array> {
    const handler = options.handlers[token.name];

    // close the innermost open element that was renamed under this name, discarding any renames
    // nested inside it (their end tags were implied, or never arrived)
    const renameIndex = openRenames.findLastIndex((entry) => entry.original === token.name);
    const renamedTo = renameIndex === -1 ? null : openRenames[renameIndex].renamed;
    if (renameIndex !== -1) {
      openRenames.length = renameIndex;
    }

    const text = renamedTo ? `</${renamedTo}>` : raw;

    if (!handler?.endTag) {
      yield* emitText(text);
      return;
    }

    const before: Injection[] = [];
    const pending = handler.endTag({
      tagName: token.name,
      before(content: Injection) {
        before.push(content);
      },
    });
    if (pending) await pending;

    for (const content of before) {
      yield* emit(content);
    }
    yield* emitText(text);
  }
}

async function* emit(content: Injection): AsyncGenerator<Uint8Array> {
  if (typeof content === 'string') {
    yield* emitText(content);
    return;
  }

  const reader = content.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function* emitText(text: string): Generator<Uint8Array> {
  if (text) yield encoder.encode(text);
}

/**
 * Scans one token starting at `start` (which must point at `<`).
 *
 * @returns the token, or null when the buffer ends mid-token and more input is needed.
 */
function scanToken(text: string, start: number): Token | null {
  const length = text.length;
  let index = start + 1;

  if (index >= length) return null;

  // markup declarations: comments, doctypes, CDATA
  if (text[index] === '!') {
    if (text.startsWith('<!--', start)) {
      const close = text.indexOf('-->', start + 4);
      return close === -1 ? null : { kind: 'comment', end: close + 3, name: '', selfClosing: false, attributes: [] };
    }

    const close = findDeclarationEnd(text, start + 2);
    if (close === -1) return null;
    const isDoctype = /^<!doctype/i.test(text.slice(start, start + 9));
    return { kind: isDoctype ? 'doctype' : 'bogus', end: close, name: '', selfClosing: false, attributes: [] };
  }

  if (text[index] === '?') {
    const close = text.indexOf('>', index);
    return close === -1 ? null : { kind: 'bogus', end: close + 1, name: '', selfClosing: false, attributes: [] };
  }

  const isEndTag = text[index] === '/';
  if (isEndTag) index++;

  const nameStart = index;
  while (index < length && isTagNameChar(text[index])) index++;

  // Running out of buffer is "incomplete", never "not a tag" — the name may continue in the
  // next chunk, and `</` at a chunk boundary must not be mistaken for literal text.
  if (index >= length) return null;

  // `<` not followed by a tag name is literal text (`a < b`), not a tag
  if (index === nameStart) {
    return { kind: 'bogus', end: start + 1, name: '', selfClosing: false, attributes: [] };
  }

  const name = text.slice(nameStart, index).toLowerCase();
  const attributes: ParsedAttribute[] = [];
  let selfClosing = false;

  for (;;) {
    while (index < length && isWhitespace(text[index])) index++;
    if (index >= length) return null;

    if (text[index] === '>') {
      return { kind: isEndTag ? 'end' : 'start', end: index + 1, name, selfClosing, attributes };
    }

    if (text[index] === '/') {
      if (index + 1 >= length) return null;
      if (text[index + 1] === '>') {
        selfClosing = true;
        return { kind: isEndTag ? 'end' : 'start', end: index + 2, name, selfClosing, attributes };
      }
      index++;
      continue;
    }

    const attributeNameStart = index;
    while (index < length && !isWhitespace(text[index]) && text[index] !== '=' && text[index] !== '>') {
      if (text[index] === '/' && text[index + 1] === '>') break;
      index++;
    }
    if (index >= length) return null;

    const rawName = text.slice(attributeNameStart, index);
    if (!rawName) {
      // defensive: no progress would loop forever
      index++;
      continue;
    }

    let cursor = index;
    while (cursor < length && isWhitespace(text[cursor])) cursor++;
    if (cursor >= length) return null;

    let value: string | null = null;

    if (text[cursor] === '=') {
      cursor++;
      while (cursor < length && isWhitespace(text[cursor])) cursor++;
      if (cursor >= length) return null;

      const quote = text[cursor];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, cursor + 1);
        if (close === -1) return null;
        value = decodeAttributeValue(text.slice(cursor + 1, close));
        cursor = close + 1;
      } else {
        const valueStart = cursor;
        while (cursor < length && !isWhitespace(text[cursor]) && text[cursor] !== '>') cursor++;
        if (cursor >= length) return null;
        value = decodeAttributeValue(text.slice(valueStart, cursor));
      }
      index = cursor;
    }

    attributes.push({ name: rawName.toLowerCase(), rawName, value });
  }
}

/** Finds the end of a markup declaration, honoring quoted strings (doctypes may contain `>`). */
function findDeclarationEnd(text: string, from: number): number {
  let index = from;
  let quote: string | null = null;

  while (index < text.length) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index + 1;
    }
    index++;
  }
  return -1;
}

/**
 * Finds the start of a raw-text element's end tag (`</script`, `</style`, …), which is the only
 * markup recognized inside such an element.
 */
function findRawTextEnd(text: string, from: number, tagName: string): number {
  const needle = `</${tagName}`;
  const haystack = text.toLowerCase();
  let index = from;

  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return -1;

    const after = text[found + needle.length];
    // the end tag is only terminated by whitespace, `/`, `>` — `</scriptfoo` is raw text
    if (after === undefined) return -1;
    if (isWhitespace(after) || after === '/' || after === '>') return found;

    index = found + needle.length;
  }
}

function serializeStartTag(name: string, attributes: ParsedAttribute[], selfClosing: boolean): string {
  const serializedAttributes = attributes
    .map((attribute) =>
      attribute.value === null ? ` ${attribute.rawName}` : ` ${attribute.rawName}="${escapeAttributeValue(attribute.value)}"`,
    )
    .join('');

  return `<${name}${serializedAttributes}${selfClosing ? '/>' : '>'}`;
}

/**
 * Decodes the handful of entities that realistically appear in the attributes Braid reads
 * (`name`, `type`, `rel`). Full entity decoding is deliberately out of scope: this is a
 * rewriter, and every value it round-trips it also re-encodes.
 */
function decodeAttributeValue(value: string): string {
  if (!value.includes('&')) return value;
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function escapeAttributeValue(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function isTagNameChar(char: string): boolean {
  return /[a-zA-Z0-9:_.-]/.test(char);
}

/** Adapts an async generator of chunks into a ReadableStream. */
export function toReadableStream(generator: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await generator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await generator.return(undefined as never).catch(() => undefined);
      void reason;
    },
  });
}

/** Builds a stream from literal strings and other streams, concatenated in order. */
export function concatStreams(parts: Injection[]): ReadableStream<Uint8Array> {
  return toReadableStream(
    (async function* () {
      for (const part of parts) {
        yield* emit(part);
      }
    })(),
  );
}
