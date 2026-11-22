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
 * - **It reads markup as the browser will.** Tokenizing follows the WHATWG tokenizer
 *   (`tokenizer.ts`), and the parts of tree construction that decide how the rest is tokenized —
 *   whether an element is HTML or SVG/MathML, whether a start tag opens raw text, which templates
 *   are open — are tracked (`open-elements.ts`). A transform that sees every tag the browser will
 *   see is the only kind that can be a security boundary.
 * - **Fragment markup is written so it can be read only one way** (`contain`): what browsers would
 *   recover from differently is closed explicitly or dropped, and a fragment cannot close the
 *   elements it is placed in or leave one of its own open to swallow what follows. See
 *   `open-elements.ts`.
 * - **Streaming**: output is produced as input arrives. A tag, comment or doctype is held until it is
 *   complete; text, raw text included, is passed on as it arrives.
 * - **Chunk-boundary safe**: the output is the same however the input is split.
 * - **Fidelity by default**: a tag no handler modifies is emitted byte-for-byte as it arrived.
 *   Only mutated tags are re-serialized, and their untouched attributes keep their authored value.
 * - **Stream injection**: injected content may itself be a `ReadableStream`, which is what makes
 *   piercing a true interleave (shell up to the slot, then the fragment's stream, then the rest
 *   of the shell) rather than a buffer-everything-then-concatenate.
 *
 * The conformance vectors in `html-rewrite-stream.spec.ts` and the differential tests against
 * parse5 and Chromium (`differential.spec.ts`, `e2e/rewriter-differential.e2e.ts`) are its oracle.
 */

import { decodeAttributeValue } from './character-references.js';
import { OpenElements, VOID } from './open-elements.js';
import { type RawAttribute, type Token, Tokenizer } from './tokenizer.js';

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
  /**
   * The input is a fragment, to be placed inside an element of another document (a pierced
   * fragment's `<braid-document>`): write it so every browser reads it the same way, keep it inside
   * that element, and remove — rather than guess at — any attribute a handler reads whose value the
   * rewriter cannot decode for certain. See `open-elements.ts`. Off for a shell, which is the
   * document itself and is trusted.
   */
  contain?: boolean;
}

const encoder = new TextEncoder();

export function rewriteHtmlStream(
  input: ReadableStream<Uint8Array>,
  options: RewriteOptions,
): ReadableStream<Uint8Array> {
  return toReadableStream(rewrite(input, options));
}

interface Attribute {
  /** Lowercased name, for lookups. */
  name: string;
  /** The name exactly as authored, so untouched attributes re-serialize unchanged. */
  rawName: string;
  /** The authored value, character references undecoded; null for a valueless attribute. */
  raw: string | null;
  /** The decoded (or assigned) value; undefined until read. */
  value?: string | null;
  /** Assigned by a handler, so serialized from `value` rather than `raw`. */
  modified: boolean;
  /** Removed by a handler: left in place and skipped, so a removal costs nothing per attribute. */
  removed?: boolean;
}

/** One part of the output: markup, or a stream to splice in. */
type Part = string | ReadableStream<Uint8Array>;

async function* rewrite(input: ReadableStream<Uint8Array>, options: RewriteOptions): AsyncGenerator<Uint8Array> {
  const contain = options.contain === true;
  const decoder = new TextDecoder();
  const reader = input.getReader();
  const tokenizer = new Tokenizer();
  const tree = new OpenElements(contain);

  /** Output not yet yielded: written as one chunk per chunk of input, not one per token. */
  let out = '';
  /** Dropping a `<noscript>` with its content, which is read as raw text. */
  let droppingRawText = false;
  /** After a fragment's `<plaintext>`: everything is text, written as text. */
  let escapingRest = false;
  /**
   * Whether the fragment's text written so far ends in what could be the start of a character
   * reference (`&am`). A token dropped there would join it to the text after the drop —
   * `&am</body>p;` read as `&amp;` — so a dropped token is written as an empty comment instead,
   * which ends the reference and is inserted in every mode.
   */
  let inReference = false;
  /**
   * Open elements whose start tag a handler renamed. Renaming an element must rename its end
   * tag too — otherwise the renamed element is never closed, and everything that follows nests
   * inside it (a `<braid-head>` left open swallows the whole `<braid-body>`). Indexed by original
   * name, so finding one costs the same however many are open.
   */
  const openRenames: { original: string; renamed: string }[] = [];
  const renamesByName = new Map<string, number[]>();
  const pushRename = (original: string, renamed: string) => {
    const indices = renamesByName.get(original);
    if (indices) indices.push(openRenames.length);
    else renamesByName.set(original, [openRenames.length]);
    openRenames.push({ original, renamed });
  };
  const truncateRenames = (length: number) => {
    while (openRenames.length > length) {
      const { original } = openRenames.pop()!;
      const indices = renamesByName.get(original)!;
      indices.pop();
      if (!indices.length) renamesByName.delete(original);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      tokenizer.feed(done ? decoder.decode() : decoder.decode(value, { stream: true }));
      if (done) tokenizer.end();

      for (;;) {
        tokenizer.cdataAllowed = tree.cdataAllowed();
        const token = tokenizer.next();
        if (!token) break;

        if (token.type === 'start' || token.type === 'end') {
          const parts = token.type === 'start' ? startTag(token) : endTag(token);
          if (parts instanceof Promise) {
            // everything before the tag goes out before the stream waits on it
            yield* flush();
            yield* emitParts(await parts);
          } else {
            yield* emitParts(parts);
          }
        } else if (token.type === 'text' && contain && !escapingRest && !droppingRawText && (token.state === 'data' || token.state === 'rcdata')) {
          // A literal `<` in text is next to whatever is written after it — and what is written after it
          // is not always what followed it, once something between was dropped: `<` and a dropped
          // `</body>` and `x` would be `<x`, a tag. As `&lt;` it is the same text, and next to nothing.
          writeText(token.raw.replaceAll('<', '&lt;'));
        } else {
          write(other(token));
        }
      }

      yield* flush();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (contain) out += closeWhatIsOpen();
  yield* flush();

  const trailing = await options.onEnd?.();
  if (trailing !== undefined) {
    yield* emit(trailing);
  }

  function* flush(): Generator<Uint8Array> {
    if (out) {
      yield encoder.encode(out);
      out = '';
    }
  }

  async function* emitParts(parts: Part[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) {
      if (typeof part === 'string') {
        write(part);
      } else {
        inReference = false;
        yield* flush();
        yield* emit(part);
      }
    }
    if (!parts.length) write('');
  }

  /** Writes markup (or nothing, for a dropped token). */
  function write(markup: string): void {
    if (!markup) {
      if (inReference) out += '<!---->';
    } else {
      out += markup;
    }
    inReference = false;
  }

  /** Writes a fragment's text, noting whether it ends inside what could be a reference. */
  function writeText(text: string): void {
    if (!text) return;
    const ampersand = text.lastIndexOf('&');
    inReference = ampersand === -1 ? inReference && REFERENCE_TAIL.test(text) : REFERENCE_TAIL.test(text.slice(ampersand + 1));
    out += text;
  }

  function other(token: Exclude<Token, { type: 'start' | 'end' }>): string {
    switch (token.type) {
      case 'text':
        if (droppingRawText) return '';
        if (escapingRest) return escapeText(token.raw);
        // `</` the input ended on would open a bogus comment with whatever is appended after it
        if (token.state === 'data' && token.raw === '</' && tokenizer.isEnded) return '&lt;/';
        return token.raw;
      case 'cdata':
        // as text, which reads the same whether or not the browser takes it for a CDATA section
        return contain ? escapeText(token.text) : token.raw;
      // What the input ended inside of is closed, so whatever is appended after it — the end of a
      // fragment's document, or a shell's late content — is not read as part of it.
      case 'comment':
        // `-->` closes a comment from any state the input can end it in
        return token.complete ? token.raw : `${token.raw}-->`;
      case 'bogus':
        if (contain) return canonicalComment(token.data);
        return token.raw.endsWith('>') ? token.raw : `${token.raw}>`;
      case 'doctype':
        if (options.stripDoctype) return '';
        return token.raw.endsWith('>') ? token.raw : `${token.raw}>`;
      case 'nothing':
        return contain ? '' : token.raw;
      case 'unterminated':
        // the browser drops a tag the input ended inside; written out, it would swallow
        // whatever is appended after it
        return '';
    }
  }

  function startTag(token: Extract<Token, { type: 'start' }>): Part[] | Promise<Part[]> {
    const plan = tree.planStart(
      token.name,
      token.name === 'font' && token.attributes.some(({ name }) => name === 'color' || name === 'face' || name === 'size'),
    );
    const parts: Part[] = [];
    if (contain && plan.closers.length) parts.push(plan.closers.join(''));

    if (contain && plan.drop) {
      parts.push(plan.replacement ?? blockedMarker(plan.name));
      return parts;
    }

    const html = plan.foreign === null;
    if (contain && html && plan.name === 'noscript') {
      // Raw text with scripting on (a pierced fragment) and markup with it off (a fetched one,
      // parsed in a template's content): the two would read it differently. Dropped whole.
      parts.push(blockedMarker('noscript'));
      tokenizer.switchTo('rawtext', 'noscript');
      droppingRawText = true;
      return parts;
    }

    // A fragment's `<image>` is written as the `<img>` the browser makes of it, so the transforms see
    // an img; a shell's is left as written.
    const tag = new Tag(contain ? plan.name : token.name, token, contain);
    const elementHandlers = [handlerFor('*')?.element, handlerFor(tag.tagName)?.element];

    let pending: Promise<void> | undefined;
    for (const element of elementHandlers) {
      if (!element) continue;
      if (pending) {
        pending = pending.then(() => element(tag));
        continue;
      }
      // awaited only when it is a promise: this runs for every element of every document, and an
      // unconditional await would be a microtask per tag
      const result = element(tag);
      if (result) pending = result;
    }

    const finish = (): Part[] => {
      if (contain && html && plan.name === 'plaintext') {
        // Everything after it is text: written as escaped text in a `<pre>`, which reads the same
        // everywhere and leaves the document after the fragment as markup.
        tag.tagName = 'pre';
        tag.block('plaintext');
      }

      const name = tag.tagName === token.name ? plan.name : tag.tagName;
      // a self-closing HTML element is opened all the same; only a void one, or a foreign one, is not
      const opens = !VOID.has(plan.name) && !(plan.foreign && token.selfClosing);
      if (name !== plan.name && opens) {
        pushRename(plan.name, name);
      }

      const content = tree.pushStart(plan, name, token.selfClosing, (attribute) => tag.getAttribute(attribute));
      if (contain && html && plan.name === 'plaintext') {
        tokenizer.switchTo('plaintext', 'plaintext');
        escapingRest = true;
      } else if (content) {
        tokenizer.switchTo(content, name);
      }

      parts.push(...tag.beforeContent, tag.serialize(token.raw), ...tag.prependContent);
      return parts;
    };

    return pending ? pending.then(finish) : finish();
  }

  function endTag(token: Extract<Token, { type: 'end' }>): Part[] | Promise<Part[]> {
    if (droppingRawText) {
      // the `</noscript>` that ended the dropped content
      droppingRawText = false;
      return [];
    }

    // An end tag for an element that was renamed is written under the new name. The rename is
    // forgotten — with any nested inside it, whose end tags were implied or never arrived — once the
    // element is actually closed: an end tag dropped, or one that closes nothing, leaves it open.
    const renameIndex = renamesByName.get(token.name)?.at(-1) ?? -1;
    const renamedTo = renameIndex === -1 ? null : openRenames[renameIndex].renamed;
    const name = renamedTo ?? token.name;

    const openBefore = renamedTo ? tree.openCount(renamedTo) : 0;
    const plan = tree.planEnd(name);
    if (renamedTo && tree.openCount(renamedTo) < openBefore) truncateRenames(renameIndex);
    const parts: Part[] = [];
    if (contain && plan.closers.length) parts.push(plan.closers.join(''));
    if (contain && plan.drop) return parts;

    const text = renamedTo ? `</${renamedTo}>` : token.raw;
    const handler = handlerFor(token.name);
    if (!handler?.endTag) {
      parts.push(text);
      return parts;
    }

    const before: Injection[] = [];
    const pending = handler.endTag({
      tagName: token.name,
      before(content: Injection) {
        before.push(content);
      },
    });
    const finish = (): Part[] => {
      parts.push(...before, text);
      return parts;
    };
    return pending ? pending.then(finish) : finish();
  }

  /** A handler by tag name: own keys only, so a tag named `constructor` has none. */
  function handlerFor(name: string): ElementHandler | undefined {
    return Object.hasOwn(options.handlers, name) ? options.handlers[name] : undefined;
  }

  /** What a fragment the input ended inside of needs, so nothing after it is read as part of it. */
  function closeWhatIsOpen(): string {
    let closing = '';
    const { state, tagName, scriptState } = tokenizer.contentState;
    if (!droppingRawText && !escapingRest && (state === 'rcdata' || state === 'rawtext' || state === 'script')) {
      // inside `<!--` in a script, `</script>` ends the element only once `-->` has ended the escape
      if (state === 'script' && scriptState !== 'data') closing += '-->';
      closing += `</${tagName}>`;
      tree.popRawText();
    }
    return closing + tree.closeAll().join('');
  }
}

class Tag implements StartTag {
  readonly beforeContent: Injection[] = [];
  readonly prependContent: Injection[] = [];
  readonly selfClosing: boolean;
  private name: string;
  private dirty: boolean;
  private readonly attributes: Attribute[];
  /** The attributes not removed, by name: lookups cost the same however many a tag has. */
  private readonly byName = new Map<string, Attribute>();
  /** Attributes removed because their value could not be read for certain. */
  private readonly blocked: string[] = [];

  constructor(
    name: string,
    token: { name: string; selfClosing: boolean; attributes: RawAttribute[] },
    private readonly contain: boolean,
  ) {
    this.name = name;
    // `<image>` is written as the `<img>` the browser makes of it, so the transforms see an img
    this.dirty = name !== token.name;
    this.selfClosing = token.selfClosing;
    this.attributes = token.attributes.map((attribute) => ({ ...attribute, modified: false }));
    for (const attribute of this.attributes) this.byName.set(attribute.name, attribute);
  }

  get tagName(): string {
    return this.name;
  }

  set tagName(value: string) {
    this.name = value.toLowerCase();
    this.dirty = true;
  }

  get attributeNames(): string[] {
    return [...this.byName.keys()];
  }

  getAttribute(attributeName: string): string | null {
    const lowercased = attributeName.toLowerCase();
    const attribute = this.byName.get(lowercased);
    if (!attribute) return null;
    if (attribute.modified || attribute.value !== undefined) return attribute.value ?? null;
    if (attribute.raw === null) return null;

    const decoded = decodeAttributeValue(attribute.raw);
    if (decoded.uncertain && this.contain) {
      // a reference the rewriter cannot decode, in a value it is about to judge: the browser
      // might read it otherwise, so it is removed rather than guessed at
      this.removeAttribute(lowercased);
      this.block(lowercased);
      return null;
    }
    attribute.value = decoded.value;
    return decoded.value;
  }

  setAttribute(attributeName: string, value: string): void {
    const lowercased = attributeName.toLowerCase();
    const existing = this.byName.get(lowercased);
    if (existing) {
      existing.value = value;
      existing.modified = true;
    } else {
      const added: Attribute = { name: lowercased, rawName: attributeName, raw: null, value, modified: true };
      this.attributes.push(added);
      this.byName.set(lowercased, added);
    }
    this.dirty = true;
  }

  removeAttribute(attributeName: string): void {
    const lowercased = attributeName.toLowerCase();
    const attribute = this.byName.get(lowercased);
    if (attribute) {
      attribute.removed = true;
      this.byName.delete(lowercased);
      this.dirty = true;
    }
  }

  before(content: Injection): void {
    this.beforeContent.push(content);
  }

  prepend(content: Injection): void {
    this.prependContent.push(content);
  }

  /** Names a removed attribute in `data-braid-blocked`, alongside whatever a handler puts there. */
  block(reason: string): void {
    this.blocked.push(reason);
    this.dirty = true;
  }

  serialize(raw: string): string {
    if (!this.dirty) return raw;
    let blocked = this.blocked.join(' ');
    let markup = `<${this.name}`;
    for (const attribute of this.attributes) {
      if (attribute.removed) continue;
      if (blocked && attribute.name === 'data-braid-blocked') {
        // the authored value as authored, references and all; an assigned one escaped
        const value = attribute.modified
          ? escapeAttributeValue(attribute.value ?? '')
          : (attribute.raw ?? '').replaceAll('"', '&quot;');
        markup += ` ${attribute.rawName}="${value ? `${value} ` : ''}${escapeAttributeValue(blocked)}"`;
        blocked = '';
        continue;
      }
      if (attribute.modified) {
        markup += ` ${attribute.rawName}="${escapeAttributeValue(attribute.value ?? '')}"`;
      } else if (attribute.raw === null) {
        markup += ` ${attribute.rawName}`;
      } else {
        // as authored, references and all: quoted, which reads the same as however it was quoted
        markup += ` ${attribute.rawName}="${attribute.raw.replaceAll('"', '&quot;')}"`;
      }
    }
    if (blocked) markup += ` data-braid-blocked="${escapeAttributeValue(blocked)}"`;
    return `${markup}${this.selfClosing ? '/>' : '>'}`;
  }
}

/** Marks where a fragment's element was dropped, in a comment: the one node every parser mode inserts. */
function blockedMarker(name: string): string {
  return `<!--braid-blocked ${name.replaceAll('-', '')}-->`;
}

/** A bogus comment, written as a real one with the same data. */
function canonicalComment(data: string): string {
  // `<!-->` and `<!--->` would end it at once
  return `<!--${data.startsWith('>') || data.startsWith('-') ? ' ' : ''}${data}-->`;
}

/** What may follow an `&` and still be part of a character reference. */
const REFERENCE_TAIL = /^[A-Za-z0-9#]*$/;

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}

async function* emit(content: Injection): AsyncGenerator<Uint8Array> {
  if (typeof content === 'string') {
    if (content) yield encoder.encode(content);
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

function escapeAttributeValue(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
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

