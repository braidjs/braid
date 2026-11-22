/**
 * The part of HTML tree construction a rewriter has to follow, and the canonical output that keeps
 * it followable.
 *
 * The tokenizer's state after a start tag is the tree's decision: `<style>` opens raw text as an
 * HTML element and nothing as an SVG one, `<![CDATA[` is a section in foreign content and a bogus
 * comment outside it, and whether an element is HTML or foreign depends on everything open around
 * it. A rewriter that gets any of that wrong reads markup the browser reads as text, or text the
 * browser reads as markup — a tag no transform saw.
 *
 * This tracks the stack of open elements with each one's namespace, and for a fragment
 * (`contain`) it does more than follow: it writes what it decided into the output, so the browser
 * has nothing left to recover from and so reaches the same decision whatever its error recovery is.
 *
 * - **Foreign content is closed explicitly.** A tag that breaks out of SVG or MathML (`<div>`,
 *   `<img>`, `<font>`…), an end tag for an element below foreign ones, the end of the fragment: each
 *   first gets an end tag for every foreign element it would have popped, innermost first. Inside an
 *   HTML island in foreign content (`<foreignObject>` and the like), the same goes for every
 *   element an implied end tag or misnesting would close: closed by its own end tag, so the
 *   adoption agency and formatting-element reconstruction — which could put an HTML element on top
 *   of an integration point the rewriter thinks is current — never run there. Table structure there
 *   is dropped, since a table mode can clear the stack through foreign content.
 * - **Where browsers disagree, the construct is dropped.** Customizable `<select>` parses its content
 *   as in body; older parsers ignore most of it, raw-text elements included. Inside one, raw-text
 *   elements other than `<script>` and `<textarea>`, and SVG and MathML, are dropped, and what would
 *   close it is written as `</select>`. A `<template>` whose first child is `<col>` ignores all but
 *   `<col>` and `<template>`: everything else is dropped. `<noscript>` (raw text with scripting on,
 *   markup without), `<frameset>` and `<frame>` are dropped; `<plaintext>` becomes a `<pre>`.
 * - **A fragment cannot close what it did not open.** `</template>` and `</braid-document>`, and the
 *   other elements the gateway wraps a fragment in, are dropped unless they match an element the
 *   fragment opened; at its end, every template, select and foreign element it left open is closed.
 *
 * What this does not model — implied end tags outside foreign content, the adoption agency, foster
 * parenting — can change which HTML element is current, but never whether it is HTML, whether a tag
 * opens raw text, or which templates are open, which is all that decides how the rest is read. Two
 * rules that could are kept from running instead: an `<a>` while an out-of-scope `<a>` is open, which
 * removes that one from the stack wherever it is, is dropped; and end tags (and closers) for the
 * elements a fragment is placed in are written only inside a template it opened, so a wrong guess
 * about them cannot reach the host. Both parse contexts have a template on the stack, which is also
 * what keeps a nested `<form>` from being ignored there.
 */

export type Namespace = 'html' | 'svg' | 'math';

/** Whether an element is an integration point, where HTML rules apply again inside foreign content. */
const enum Integration {
  None = 0,
  /** SVG `foreignObject`, `desc`, `title`; MathML `annotation-xml` with an HTML encoding. */
  Html = 1,
  /** MathML `mi`, `mo`, `mn`, `ms`, `mtext`: start tags but `mglyph`/`malignmark` are HTML. */
  MathText = 2,
}

/** How a `<template>`'s content is parsed: decided by its first start tag. */
type TemplateMode = 'undecided' | 'body' | 'table' | 'colgroup' | 'tablebody' | 'row';

/** An element as created, before the stack fills in what it knows from below. */
interface NewEntry {
  name: string;
  namespace: Namespace;
  integration: Integration;
  templateMode?: TemplateMode;
}

/**
 * An open element, with what the rules ask of the stack precomputed from the entry below when it is
 * pushed — so no question costs more the deeper the document is. Each `…At` is the index of the
 * nearest entry at or below this one that is such an element, 0 (the root) when there is none.
 */
interface Entry extends NewEntry {
  /** The element "reset the insertion mode" stops at. */
  modeAt: number;
  /** Whether a foreign element is open at or below this, above the nearest template. */
  foreign: boolean;
  htmlAt: number;
  templateAt: number;
  /** Boundaries of the default, button and list item scopes, and of {@link OpenElements.findOpen}. */
  scopeAt: number;
  buttonScopeAt: number;
  listScopeAt: number;
  openAt: number;
  /** Special elements, and the ones the `<li>` and `<dd>` loops stop at (all but address, div, p). */
  specialAt: number;
  listLoopAt: number;
  /** The nearest table element or template, and the lowest marker element above it (-1 for none). */
  tableAt: number;
  markerAt: number;
  /** Whether the nearest table or template below is a table: a select here is in a table. */
  inTable: boolean;
}

export type ContentState = 'rcdata' | 'rawtext' | 'script' | 'plaintext';

export interface StartPlan {
  /** End tags to write before this tag. */
  closers: string[];
  /** Drop the tag: the browser would not see it the same way everywhere. */
  drop: boolean;
  /** Written in place of the tag (`</select>` for a `<select>` inside one). */
  replacement?: string;
  /** Whether HTML rules or foreign-content rules process the tag. */
  foreign: Namespace | null;
  /** The name the browser gives the element (`image` becomes `img`). */
  name: string;
}

export interface EndPlan {
  closers: string[];
  drop: boolean;
}

/** Elements the gateway wraps a fragment in: a fragment's end tag for one must match its own. */
const HOST_ELEMENTS = new Set([
  'template',
  'braid-document',
  'fragment-slot',
  'braid-late',
  'braid-late-end',
  'slot',
  'body',
  'html',
  'head',
]);

export const VOID = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'keygen', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT = new Map<string, ContentState>([
  ['script', 'script'],
  ['style', 'rawtext'],
  ['xmp', 'rawtext'],
  ['iframe', 'rawtext'],
  ['noembed', 'rawtext'],
  ['noframes', 'rawtext'],
  ['noscript', 'rawtext'], // with scripting on, as a pierced fragment is parsed (a fragment's is dropped)
  ['textarea', 'rcdata'],
  ['title', 'rcdata'],
  ['plaintext', 'plaintext'],
]);

/** Start tags that leave foreign content; `font` only with a color, face or size attribute. */
const BREAKOUT = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's',
  'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
]);

const SPECIAL = new Set([
  'address', 'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote', 'body', 'br', 'button',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dir', 'div', 'dl', 'dt', 'embed', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
  'html', 'iframe', 'img', 'input', 'keygen', 'li', 'link', 'listing', 'main', 'marquee', 'menu', 'meta', 'nav',
  'noembed', 'noframes', 'noscript', 'object', 'ol', 'p', 'param', 'plaintext', 'pre', 'script', 'search', 'section',
  'select', 'source', 'style', 'summary', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'title',
  'tr', 'track', 'ul', 'wbr', 'xmp',
]);

const SCOPE_BOUNDARIES = new Set(['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template']);

const TABLE_STRUCTURE = new Set(['caption', 'col', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'table']);

const FORMATTING = new Set(['a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u']);

/** Start tags that close an open `<p>` first. */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'header', 'hgroup', 'main', 'menu', 'nav', 'ol', 'p', 'search', 'section', 'summary',
  'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'listing', 'form', 'hr', 'xmp', 'table', 'plaintext',
]);

const HEADING_LIST = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const HEADINGS = new Set(HEADING_LIST);

/** End tags closed when in scope, as the in-body rules list them. */
const SCOPED_END = new Set([
  'address', 'article', 'aside', 'blockquote', 'button', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'header', 'hgroup', 'listing', 'main', 'menu', 'nav', 'ol', 'pre', 'search',
  'section', 'summary', 'ul', 'dd', 'dt', 'applet', 'marquee', 'object', 'form',
]);

/** Elements that put a marker in the list of active formatting elements, besides cells, captions and templates. */
const MARKERS = new Set(['applet', 'object', 'marquee']);

/** Elements table structure clears the stack back to, or closes. */
const TABLE_ELEMENTS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption']);

/** Elements that put a marker in the list of active formatting elements, templates aside. */
const MARKER_ELEMENTS = new Set(['applet', 'object', 'marquee', 'td', 'th', 'caption']);

/** Elements a fragment's end closes, with everything above them (see {@link OpenElements.closeAll}). */
const CLOSED_AT_END = new Set(['template', 'select', 'applet', 'object', 'marquee', 'td', 'th', 'caption']);

const IMPLIED_END = new Set(['dd', 'dt', 'li', 'optgroup', 'option', 'p', 'rb', 'rp', 'rt', 'rtc']);

/** Start tags processed as in head inside a template, which leave its mode undecided. */
const TEMPLATE_HEAD_TAGS = new Set([
  'base', 'basefont', 'bgsound', 'link', 'meta', 'noframes', 'script', 'style', 'template', 'title',
]);

/** Names "reset the insertion mode appropriately" acts on, foreign elements of which a fragment may not write. */
const MODE_NAMES = new Set(['select', 'td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'caption', 'colgroup', 'table', 'template', 'head', 'body', 'html', 'frameset']);

/** HTML elements "reset the insertion mode appropriately" stops at. */
const MODE_SETTING = new Set(['select', 'td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'caption', 'colgroup', 'table', 'template']);

/** Foreign elements that bound every scope, and are special: the integration points, and annotation-xml. */
function isForeignBoundary(namespace: Namespace, name: string): boolean {
  if (namespace === 'svg') return name === 'foreignobject' || name === 'desc' || name === 'title';
  if (namespace === 'math') return name === 'mi' || name === 'mo' || name === 'mn' || name === 'ms' || name === 'mtext' || name === 'annotation-xml';
  return false;
}

type Mode = 'body' | 'select' | 'select-in-table' | 'colgroup' | 'colgroup-template' | 'table' | 'tablebody' | 'row' | 'cell' | 'caption' | 'template';

const ROOT: Entry = Object.freeze({
  name: '#root',
  namespace: 'html',
  integration: Integration.None,
  modeAt: 0,
  foreign: false,
  htmlAt: 0,
  templateAt: 0,
  scopeAt: 0,
  buttonScopeAt: 0,
  listScopeAt: 0,
  openAt: 0,
  specialAt: 0,
  listLoopAt: 0,
  tableAt: 0,
  markerAt: -1,
  inTable: false,
});

export class OpenElements {
  private readonly stack: Entry[] = [ROOT];
  /** The indices of the open elements of each name, innermost last: HTML ones and foreign ones. */
  private readonly html = new Map<string, number[]>();
  private readonly foreignByName = new Map<string, number[]>();

  /**
   * @param contain Fragment markup: write the canonical output described above, and keep it inside
   *   the element it is placed in. Off for a shell, which is trusted and whose markup is left as is.
   */
  constructor(private readonly contain: boolean) {}

  private get current(): Entry {
    return this.stack[this.stack.length - 1];
  }

  /** Whether `<![CDATA[` opens a CDATA section: the current node is not HTML. */
  cdataAllowed(): boolean {
    return this.current.namespace !== 'html';
  }

  /**
   * Decides how a start tag is processed, popping what it implicitly closes.
   *
   * @param fontBreaksOut for a `font`, whether it has a `color`, `face` or `size` attribute, which
   *   makes it leave foreign content
   */
  planStart(name: string, fontBreaksOut = false): StartPlan {
    const closers: string[] = [];
    let tagName = name;

    // foreign content: a breakout tag pops back to HTML (or an integration point) first
    for (;;) {
      const current = this.current;
      if (this.htmlRulesFor(current, tagName)) break;
      if (!BREAKOUT.has(tagName) && !(tagName === 'font' && fontBreaksOut)) {
        // No SVG or MathML element has the name of one that resets the insertion mode; a parser that
        // checked names without namespaces (parse5 does, for frameset) would change mode at one.
        const drop = this.contain && MODE_NAMES.has(tagName);
        return { closers, drop, foreign: current.namespace, name: tagName };
      }
      while (this.isPlainForeign(this.current)) {
        closers.push(this.popWithCloser());
      }
    }

    if (tagName === 'image') tagName = 'img';
    const plan = (drop: boolean, replacement?: string): StartPlan => ({
      closers,
      drop,
      ...(replacement === undefined ? {} : { replacement }),
      foreign: null,
      name: tagName,
    });

    let mode = this.mode();
    if (mode === 'colgroup' && tagName !== 'col' && tagName !== 'template') {
      // a colgroup ends at anything but a col; the tag is reprocessed in table mode
      this.pop();
      mode = this.mode();
    }

    if (!this.contain) return plan(false);

    if (tagName === 'frameset' || tagName === 'frame') return plan(true);

    if (mode === 'colgroup-template') {
      return plan(tagName !== 'col' && tagName !== 'template');
    }

    if (mode === 'select' || mode === 'select-in-table') {
      if (tagName === 'select') {
        this.popUntil('select');
        return plan(true, '</select>');
      }
      const closesSelect =
        tagName === 'input' ||
        tagName === 'keygen' ||
        tagName === 'textarea' ||
        (mode === 'select-in-table' && TABLE_STRUCTURE.has(tagName) && tagName !== 'col' && tagName !== 'colgroup');
      if (closesSelect) {
        closers.push('</select>');
        this.popUntil('select');
        return this.continueHtmlStart(tagName, closers);
      }
      if (tagName === 'svg' || tagName === 'math') return plan(true);
      if (RAW_TEXT.has(tagName) && tagName !== 'script') return plan(true);
      if (TABLE_STRUCTURE.has(tagName) || MARKERS.has(tagName)) return plan(true);
      return plan(false);
    }

    return this.continueHtmlStart(tagName, closers);
  }

  /** An HTML start tag outside select and column-group templates, in a fragment. */
  private continueHtmlStart(tagName: string, closers: string[]): StartPlan {
    const plan = (drop: boolean): StartPlan => ({ closers, drop, foreign: null, name: tagName });

    // An `<a>` while another is open makes the browser remove the open one from the stack even when
    // it is out of scope — below an integration point, say — which nothing here could follow. An
    // `<a>` in scope is closed explicitly (below, or by the adoption agency outside foreign content);
    // one out of scope is not written.
    if (tagName === 'a' && this.last('a') > 0 && this.inScope('a') === -1) return plan(true);
    if (!this.inForeignContent()) {
      if (tagName === 'table' && this.tableBelowTemplate('table')) return plan(true);
      if (TABLE_STRUCTURE.has(tagName)) closers.push(...this.closeMarkersAboveTable());
      return plan(false);
    }

    // An HTML island inside foreign content: close explicitly what the in-body rules would close
    // implicitly, and drop what a table mode would clear the stack through.
    // and html/head/body, which in-body rules ignore while the tracker would record them
    if (TABLE_STRUCTURE.has(tagName) || tagName === 'select' || tagName === 'html' || tagName === 'head' || tagName === 'body') {
      return plan(true);
    }
    // In a table mode — foreign content foster-parented into a table, or in a cell the table rules
    // have closed — a start tag at an integration point is processed by the table rules, which treat
    // it as in body except for `<form>`: with a template open, ignored. The tracker follows the table
    // modes only approximately, so a `<form>` in an island is never written: with it gone, nothing an
    // island lets through is read differently in any mode.
    if (tagName === 'form') return plan(true);

    if (CLOSES_P.has(tagName) || tagName === 'li' || tagName === 'dd' || tagName === 'dt') {
      if (tagName === 'li' || tagName === 'dd' || tagName === 'dt') {
        // the nearest li (or dd/dt) not below a special element other than address, div and p
        const open = tagName === 'li' ? this.last('li') : Math.max(this.last('dd'), this.last('dt'));
        if (open > 0 && open >= this.current.listLoopAt) closers.push(...this.closeThrough(open));
      }
      const p = this.inScope('p', 'buttonScopeAt');
      if (p !== -1) closers.push(...this.closeThrough(p));
      if (HEADINGS.has(tagName) && this.current.namespace === 'html' && HEADINGS.has(this.current.name)) {
        closers.push(this.popWithCloser());
      }
      return plan(false);
    }

    if (tagName === 'button' || tagName === 'a' || tagName === 'nobr') {
      const open = this.inScope(tagName);
      if (open !== -1) closers.push(...this.closeThrough(open));
      return plan(false);
    }

    if (tagName === 'option' || tagName === 'optgroup') {
      if (this.current.namespace === 'html' && this.current.name === 'option') closers.push(this.popWithCloser());
      return plan(false);
    }

    if (tagName === 'rb' || tagName === 'rtc' || tagName === 'rp' || tagName === 'rt') {
      if (this.inScope('ruby') !== -1) {
        const except = tagName === 'rp' || tagName === 'rt' ? 'rtc' : '';
        while (
          this.current.namespace === 'html' &&
          IMPLIED_END.has(this.current.name) &&
          this.current.name !== except
        ) {
          closers.push(this.popWithCloser());
        }
      }
      return plan(false);
    }

    return plan(false);
  }

  /**
   * Records a start tag the plan let through, under the name it was finally written with (a
   * handler may have renamed it), and says which content state follows it.
   */
  pushStart(plan: StartPlan, name: string, selfClosing: boolean, attribute: (name: string) => string | null): ContentState | null {
    if (plan.foreign) {
      if (!selfClosing) this.push(foreignEntry(plan.foreign, name, attribute));
      return null;
    }

    if (name === 'svg' || name === 'math') {
      if (!selfClosing) this.push(foreignEntry(name, name, attribute));
      this.decideTemplateMode(name);
      return null;
    }

    this.decideTemplateMode(name);
    if (VOID.has(name)) return null;

    // (never inside a select: older parsers ignore most of what is in one, so nothing there closes it)
    const mode = this.mode();
    if (!this.inForeignContent() && mode !== 'select' && mode !== 'select-in-table') {
      this.closeImpliedOutsideForeignContent(name);
    }

    const entry: NewEntry = { name, namespace: 'html', integration: Integration.None };
    if (name === 'template') entry.templateMode = 'undecided';
    this.push(entry);
    return RAW_TEXT.get(name) ?? null;
  }

  /** How many HTML elements of this name are open. */
  openCount(name: string): number {
    return this.html.get(name)?.length ?? 0;
  }

  /** A raw-text element's end tag arrived, ending its content. */
  isRawTextCurrent(name: string): boolean {
    return this.current.namespace === 'html' && this.current.name === name && RAW_TEXT.has(name);
  }

  /** Decides how an end tag is processed, popping what it closes. */
  planEnd(name: string): EndPlan {
    const closers: string[] = [];
    const plan = (drop: boolean): EndPlan => ({ closers, drop });

    if (this.isRawTextCurrent(name)) {
      this.pop();
      return plan(false);
    }

    if (this.current.namespace !== 'html') {
      if (name === 'br' || name === 'p') {
        // like a breakout start tag
        while (this.isPlainForeign(this.current)) {
          closers.push(this.popWithCloser());
        }
      } else {
        // end tags in foreign content — at an integration point too — close the nearest foreign
        // element of the name, or are handed to HTML rules at the first HTML element below
        const html = this.current.htmlAt;
        const match = this.foreignByName.get(name)?.at(-1) ?? -1;
        if (match > html) {
          closers.push(...this.closeThrough(match, true));
          return plan(false);
        }
        // One a fragment cannot have: of table structure dropped in foreign content, or of an element
        // it was placed in. Dropped as it is, rather than after closing the foreign content to reach
        // HTML rules that would drop it anyway.
        if (this.contain && this.droppedInForeignContent(name)) return plan(true);
        closers.push(...this.closeThrough(html + 1));
      }
    }

    return this.planHtmlEnd(name, closers);
  }

  private planHtmlEnd(name: string, closers: string[]): EndPlan {
    const plan = (drop: boolean): EndPlan => ({ closers, drop });

    // An end tag for one of the elements the fragment is placed in passes only inside a template the
    // fragment opened, and for an element it opened there: even if the tracker is wrong about that
    // element still being open, the end tag cannot reach past the fragment's own template.
    if (this.contain && this.reachesHost(name)) return plan(true);

    if (name === 'template') {
      const template = this.current.templateAt;
      if (template === 0) return plan(this.contain);
      // Foreign content in it, and each element that put a marker in the list of active formatting
      // elements, is closed by its own end tag (so each clears its own marker), with what is open
      // above them; `</template>` pops the rest, as it would.
      if (this.contain) {
        let lowest = -1;
        for (let index = template + 1; index < this.stack.length; index++) {
          const entry = this.stack[index];
          if (entry.namespace !== 'html' || MARKER_ELEMENTS.has(entry.name)) {
            lowest = index;
            break;
          }
        }
        if (lowest !== -1) closers.push(...this.closeThrough(lowest));
      }
      this.truncate(template);
      return plan(false);
    }

    const mode = this.mode();

    if (mode === 'colgroup-template' && this.contain) return plan(true);

    if (mode === 'select' || mode === 'select-in-table') {
      if (name === 'select') {
        const select = this.findOpen('select');
        if (select === -1) return plan(this.contain);
        this.truncate(select);
        return plan(false);
      }
      if (name === 'option' || name === 'optgroup') {
        if (this.current.namespace === 'html' && this.current.name === name) this.pop();
        return plan(false);
      }
      if (mode === 'select-in-table' && TABLE_STRUCTURE.has(name) && name !== 'col' && name !== 'colgroup') {
        if (this.contain) closers.push('</select>');
        this.popUntil('select');
        return this.planHtmlEnd(name, closers);
      }
      // ignored by older parsers, and able to close the select in newer ones
      if (this.contain) return plan(true);
    }

    if (this.contain && this.inForeignContent()) {
      if (TABLE_STRUCTURE.has(name) || name === 'select' || name === 'body' || name === 'html') return plan(true);
      if (name === 'br') return plan(false);

      let target = -1;
      if (name === 'p') {
        target = this.inScope('p', 'buttonScopeAt');
        if (target === -1) return plan(false); // an empty <p>, created and closed
      } else if (name === 'li') {
        target = this.inScope('li', 'listScopeAt');
      } else if (HEADINGS.has(name)) {
        const heading = Math.max(...HEADING_LIST.map((level) => this.last(level)));
        target = heading > 0 && heading >= this.current.scopeAt ? heading : -1;
      } else if (SCOPED_END.has(name) || FORMATTING.has(name)) {
        target = this.inScope(name);
      } else {
        // any other end tag: the nearest element of the name, not below a special element
        const open = this.last(name);
        target = open > 0 && open >= this.current.specialAt ? open : -1;
      }
      if (target === -1) return plan(true);
      closers.push(...this.closeThrough(target, true));
      return plan(false);
    }

    // outside foreign content: follow approximately, never past a template, table cell or select
    if (this.contain && TABLE_STRUCTURE.has(name) && this.tableBelowTemplate(name)) return plan(true);
    if (this.contain && TABLE_STRUCTURE.has(name)) closers.push(...this.closeMarkersAboveTable());
    const open = this.findOpen(name);
    if (open === -1) return plan(this.contain && HOST_ELEMENTS.has(name));
    this.truncate(open);
    return plan(false);
  }

  /**
   * End tags that close what a fragment left open, at its end: every template, select and foreign
   * element, every element that puts a marker in the list of active formatting elements, and
   * whatever is open above the lowest of them.
   *
   * The markers matter because the template the fragment is placed in clears that list only back to
   * the last marker when it closes: a formatting element opened before an `<object>`, `<td>` or
   * `<caption>` left open would survive it, and be reconstructed around the host's markup after
   * the fragment — an `<a href>` of the fragment's wrapped around the host's text.
   */
  closeAll(): string[] {
    let lowest = -1;
    for (let index = 1; index < this.stack.length; index++) {
      const entry = this.stack[index];
      if (entry.namespace !== 'html' || CLOSED_AT_END.has(entry.name)) {
        lowest = index;
        break;
      }
    }
    if (lowest === -1) return [];
    return this.closeThrough(lowest);
  }

  /** The raw-text element open at the current node, if any (`<plaintext>` excepted: it never ends). */
  openRawText(): string | null {
    const { name, namespace } = this.current;
    return namespace === 'html' && RAW_TEXT.has(name) && name !== 'plaintext' ? name : null;
  }

  /** Pops the current element after a raw-text element the input ended inside was closed. */
  popRawText(): void {
    if (this.current.namespace === 'html' && RAW_TEXT.has(this.current.name)) this.pop();
  }

  // --- the stack ---

  /** An end tag that, in foreign content, matches nothing a fragment could have opened. */
  private droppedInForeignContent(name: string): boolean {
    return TABLE_STRUCTURE.has(name) || name === 'select' || this.reachesHost(name);
  }

  /**
   * Whether, in a table mode, the nearest open element of this name is only below the nearest
   * template, or none is open. The spec ignores the token then — table scope stops at a template —
   * but parse5 (and with it jsdom) looks past the template and closes the fragment's outer table, and
   * its template with it. Not written, so no parser has the choice.
   */
  private tableBelowTemplate(name: string): boolean {
    const mode = this.mode();
    if (mode !== 'table' && mode !== 'tablebody' && mode !== 'row' && mode !== 'cell' && mode !== 'caption') return false;
    return this.last(name) <= this.current.templateAt;
  }

  /**
   * A `</braid-document>` not safely inside a template of the fragment's own. Of the elements a
   * fragment is placed in, only the `<braid-document>` is inside the template it is parsed in — the
   * slot, and a late-content wrapper, are outside it, where no end tag reaches past the template.
   */
  private reachesHost(name: string): boolean {
    if (name !== 'braid-document') return false;
    const template = this.current.templateAt;
    return template === 0 || this.last(name) <= template;
  }

  /** A foreign element that is not an integration point: what a breakout pops. */
  private isPlainForeign(entry: Entry): boolean {
    return entry.namespace !== 'html' && entry.integration === Integration.None;
  }

  /** Whether HTML rules process this start tag at this element. */
  private htmlRulesFor(entry: Entry, tagName: string): boolean {
    if (entry.namespace === 'html') return true;
    if (entry.integration === Integration.Html) return true;
    if (entry.integration === Integration.MathText) return tagName !== 'mglyph' && tagName !== 'malignmark';
    return entry.namespace === 'math' && entry.name === 'annotation-xml' && tagName === 'svg';
  }

  /** Whether a foreign element is open above the nearest template: HTML parsed here is an island. */
  private inForeignContent(): boolean {
    return this.current.foreign;
  }

  /** The insertion mode, as "reset the insertion mode appropriately" finds it. */
  private mode(): Mode {
    const entry = this.stack[this.current.modeAt];
    switch (entry.name) {
      case 'select':
        return entry.inTable ? 'select-in-table' : 'select';
      case 'td':
      case 'th':
        return 'cell';
      case 'tr':
        return 'row';
      case 'tbody':
      case 'thead':
      case 'tfoot':
        return 'tablebody';
      case 'caption':
        return 'caption';
      case 'colgroup':
        return 'colgroup';
      case 'table':
        return 'table';
      case 'template':
        switch (entry.templateMode) {
          case 'colgroup':
            return 'colgroup-template';
          case 'table':
          case 'tablebody':
          case 'row':
          case 'body':
            return entry.templateMode;
          default:
            return 'template';
        }
      default:
        return 'body';
    }
  }

  /** A template's first start tag decides how the rest of its content is parsed. */
  private decideTemplateMode(name: string): void {
    const current = this.current;
    if (current.namespace !== 'html' || current.name !== 'template' || current.templateMode !== 'undecided') return;
    if (TEMPLATE_HEAD_TAGS.has(name)) return;
    current.templateMode =
      name === 'caption' || name === 'colgroup' || name === 'tbody' || name === 'tfoot' || name === 'thead'
        ? 'table'
        : name === 'col'
          ? 'colgroup'
          : name === 'tr'
            ? 'tablebody'
            : name === 'td' || name === 'th'
              ? 'row'
              : 'body';
  }

  /** Implied end tags outside foreign content: followed, not written, to keep the stack close. */
  private closeImpliedOutsideForeignContent(name: string): void {
    if (CLOSES_P.has(name) || name === 'li' || name === 'dd' || name === 'dt') {
      const p = this.inScope('p', 'buttonScopeAt');
      if (p !== -1) this.truncate(p);
    }
    if (name === 'li' || name === 'dd' || name === 'dt' || name === 'option') {
      const names = name === 'li' ? ['li'] : name === 'option' ? ['option'] : ['dd', 'dt'];
      if (this.current.namespace === 'html' && names.includes(this.current.name)) this.pop();
    }
  }

  /** The index of the innermost open HTML element of this name, or 0 for none. */
  private last(name: string): number {
    return this.html.get(name)?.at(-1) ?? 0;
  }

  /** The index of the innermost open HTML element of this name, if it is in the given scope; or -1. */
  private inScope(name: string, scope: 'scopeAt' | 'buttonScopeAt' | 'listScopeAt' = 'scopeAt'): number {
    const open = this.last(name);
    return open > 0 && open >= this.current[scope] ? open : -1;
  }

  /** The nearest open HTML element of this name, not looking past a template, cell, table or select. */
  private findOpen(name: string): number {
    const open = this.last(name);
    return open > 0 && open >= this.current.openAt ? open : -1;
  }

  /**
   * End tags for an `<object>`, `<applet>` or `<marquee>` open above the nearest table element, and
   * for what is open above it. Table structure clears the stack back to the table, or closes the cell,
   * without the end tags — and an element popped that way leaves its marker in the list of active
   * formatting elements, which shields what was opened before it from ever being cleared: a fragment's
   * `<a href>` would be reconstructed around the host's markup after the fragment.
   */
  private closeMarkersAboveTable(): string[] {
    const { tableAt, markerAt } = this.current;
    if (tableAt === 0 || markerAt === -1) return [];
    // a template clears the stack back to itself only once its first child put it in a table mode
    const table = this.stack[tableAt];
    if (table.name === 'template' && !['table', 'tablebody', 'row'].includes(table.templateMode ?? '')) return [];
    return this.closeThrough(markerAt);
  }

  private popUntil(name: string): void {
    const index = this.findOpen(name);
    if (index !== -1) this.truncate(index);
  }

  private push(created: NewEntry): void {
    const below = this.current;
    const index = this.stack.length;
    const { name, namespace } = created;
    const html = namespace === 'html';
    const boundary = html ? SCOPE_BOUNDARIES.has(name) : isForeignBoundary(namespace, name);
    const special = html ? SPECIAL.has(name) : isForeignBoundary(namespace, name);
    const tableElement = html && (TABLE_ELEMENTS.has(name) || name === 'template');
    const entry: Entry = {
      ...created,
      modeAt: html && MODE_SETTING.has(name) ? index : below.modeAt,
      foreign: html ? name !== 'template' && below.foreign : true,
      htmlAt: html ? index : below.htmlAt,
      templateAt: html && name === 'template' ? index : below.templateAt,
      scopeAt: boundary ? index : below.scopeAt,
      buttonScopeAt: boundary || (html && name === 'button') ? index : below.buttonScopeAt,
      listScopeAt: boundary || (html && (name === 'ol' || name === 'ul')) ? index : below.listScopeAt,
      openAt: boundary || (html && name === 'select') ? index : below.openAt,
      specialAt: special ? index : below.specialAt,
      listLoopAt: special && !(html && (name === 'address' || name === 'div' || name === 'p')) ? index : below.listLoopAt,
      tableAt: tableElement ? index : below.tableAt,
      markerAt: tableElement ? -1 : html && MARKERS.has(name) && below.markerAt === -1 ? index : below.markerAt,
      inTable: html && name === 'table' ? true : html && name === 'template' ? false : below.inTable,
    };
    this.stack.push(entry);
    const byName = html ? this.html : this.foreignByName;
    const indices = byName.get(name);
    if (indices) indices.push(index);
    else byName.set(name, [index]);
  }

  private pop(): Entry {
    const entry = this.stack.pop()!;
    const byName = entry.namespace === 'html' ? this.html : this.foreignByName;
    const indices = byName.get(entry.name)!;
    indices.pop();
    // a name no longer open is forgotten, so many distinct names cost nothing once closed
    if (!indices.length) byName.delete(entry.name);
    return entry;
  }

  private truncate(length: number): void {
    while (this.stack.length > length) this.pop();
  }

  private popWithCloser(): string {
    return this.closerFor(this.pop());
  }

  /**
   * The end tag that closes an entry — none for one named like an element the fragment is placed in
   * and not inside a template of its own: the browser may have closed it already, and the end tag
   * would close the host's instead.
   */
  private closerFor(entry: Entry): string {
    // (Inside an HTML island in foreign content the stack is exact, and the end tag is written: the
    // closers after it depend on it.)
    if (entry.name === 'braid-document' && entry.namespace === 'html' && entry.templateAt === 0 && !entry.foreign) {
      return '';
    }
    return `</${entry.name}>`;
  }

  /**
   * End tags for every element from the current one down to `index`, popping them. With
   * `excludeLast`, the element at `index` is popped but its end tag left to the caller, who is
   * writing it already.
   */
  private closeThrough(index: number, excludeLast = false): string[] {
    const closers: string[] = [];
    while (this.stack.length > index + 1) closers.push(this.popWithCloser());
    const last = this.pop();
    if (!excludeLast) closers.push(this.closerFor(last));
    return closers;
  }
}

function foreignEntry(namespace: Namespace, name: string, attribute: (name: string) => string | null): NewEntry {
  let integration = Integration.None;
  if (namespace === 'svg') {
    if (name === 'foreignobject' || name === 'desc' || name === 'title') integration = Integration.Html;
  } else if (namespace === 'math') {
    if (name === 'mi' || name === 'mo' || name === 'mn' || name === 'ms' || name === 'mtext') {
      integration = Integration.MathText;
    } else if (name === 'annotation-xml') {
      const encoding = attribute('encoding')?.toLowerCase();
      if (encoding === 'text/html' || encoding === 'application/xhtml+xml') integration = Integration.Html;
    }
  }
  return { name, namespace, integration };
}
