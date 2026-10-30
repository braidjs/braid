import type { FragmentCapabilities } from '../weave/capabilities.js';

/**
 * What a compat fragment's own HTML writes may put in the page: `capabilities.html`, opt-in.
 *
 * The gateway already neutralizes the markup a fragment *sends*: no handler, script, `javascript:`
 * frame or meta refresh in server-rendered HTML runs in the host realm. Markup a fragment's code
 * *writes* at runtime has had no such treatment. `el.innerHTML = userInput` with a stray
 * `<img onerror>` compiles that handler in the host page's realm, because the element is the host
 * document's — an XSS in one fragment becomes script in the shell.
 *
 * - `'sanitize'` removes what could run, or make Braid run something: every `<script>`, `on*`
 *   attributes, `javascript:` URLs, frame documents from anything but http(s) (the gateway's
 *   allowlist), SVG animation (which can set a link's `href`), meta refresh, `<base>`, Braid's own
 *   elements (a written `<fragment-slot entry>` would boot a realm), and the `inert-*` links and
 *   `data-script-type` markers only the gateway may write.
 * - `'report'` writes the markup unchanged, and warns once per distinct finding with what
 *   `'sanitize'` would have removed. It parses every write a second time to know, so it is for
 *   development and staging.
 *
 * **Parsing is the native parse, somewhere harmless.** The markup is parsed by the browser's own
 * fragment parser, with an element of the same name and namespace as the write's target for
 * context, in a document with no browsing context — where nothing loads, runs or dispatches. So a
 * write into an `<svg>` yields SVG, a `<tr>` into a `<table>` gets its `<tbody>`, exactly as the
 * native setter would; only then are the cleaned nodes moved into the page. They are never
 * serialized and parsed again: a second parse is how sanitizers get bypassed. Writes whose result
 * is only ever text — into a `<textarea>`, `<style>`, `<script>`, `<title>` — and `TrustedHTML`
 * values, which the host's own policy already vetted, are passed straight to the native setter.
 * Any other value is converted to a string, as the native setter would, and cleaned.
 *
 * Not in scope: CSS. A written `<style>`, stylesheet link or `style` attribute can still restyle or
 * overlay the host page.
 *
 * Covered: `innerHTML` on the fragment's elements and shadow root, and `insertAdjacentHTML` — the
 * sinks the fragment boundary already stamps. Not covered: `outerHTML`, `setHTMLUnsafe`,
 * `Range.createContextualFragment`, markup parsed elsewhere and then inserted (`DOMParser`,
 * `document.implementation`, `jQuery.parseHTML`), `document.write`, captured native setters, and DOM
 * a fragment builds attribute by attribute. A custom element the host defines upgrades wherever it
 * is inserted, so its tag in written markup is as capable as the element is.
 */
export type HtmlPolicyMode = 'report' | 'sanitize';

const XHTML = 'http://www.w3.org/1999/xhtml';

/** Context elements whose fragment parse yields text only: no tag or attribute can result. */
const TEXT_ONLY_CONTEXTS = new Set(['textarea', 'title', 'style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

/** Attributes whose value is a URL that runs on navigation or load. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'data']);

/**
 * Elements removed outright, with what they would do:
 * - SVG animation, which can set an `href` to `javascript:` (DOMPurify forbids these for the same
 *   reason);
 * - `<base>`, which re-roots how Braid resolves the fragment's own URLs;
 * - Braid's own elements, which boot realms and deliver content when they connect.
 */
const REMOVED_ELEMENTS = new Map([
  ['animate', 'SVG animation'],
  ['set', 'SVG animation'],
  ['animatemotion', 'SVG animation'],
  ['animatetransform', 'SVG animation'],
  ['discard', 'SVG animation'],
  ['base', 'a <base>'],
  ['fragment-slot', 'a <fragment-slot>'],
  ['braid-late', 'a <braid-late>'],
  ['braid-late-end', 'a <braid-late-end>'],
]);

/** Elements whose source is a document of its own, and the attribute that names it. */
const FRAME_SOURCES = new Map([
  ['iframe', 'src'],
  ['frame', 'src'],
  ['embed', 'src'],
  ['object', 'data'],
]);

const MAX_WARNINGS = 50;

export function resolveHtmlPolicy(capabilities: FragmentCapabilities | undefined, fragmentId: string): HtmlPolicyMode | null {
  const grant: unknown = capabilities?.html;
  if (grant === undefined) return null;
  if (grant === 'report' || grant === 'sanitize') return grant;
  console.warn(`[braid:${fragmentId}] ignoring capabilities.html ${JSON.stringify(grant)}; expected "report" or "sanitize"`);
  return null;
}

export interface HtmlPolicy {
  /**
   * Parses `markup` as a write into `context` through `sink`. Returns the cleaned nodes to insert
   * in its place under `'sanitize'`, or null to let the native setter write `markup` as it is:
   * always under `'report'` (after warning), and for writes that cannot produce markup.
   */
  filter(markup: unknown, context: Element, sink: string): DocumentFragment | null;
}

export function createHtmlPolicy(mode: HtmlPolicyMode, fragmentId: string, mainDocument: Document): HtmlPolicy {
  const warned = new Set<string>();
  // no browsing context: nothing parsed here fetches, runs, or fires an event
  const inert = mainDocument.implementation.createHTMLDocument('');

  return {
    filter(markup, context, sink) {
      // a TrustedHTML was vetted by the host's own policy, and re-parsing it as a string here would
      // be refused by that policy anyway; anything else is a string to the native setter, and here
      const trustedTypes = (globalThis as { trustedTypes?: { isHTML(value: unknown): boolean } }).trustedTypes;
      if (trustedTypes?.isHTML(markup)) return null;
      markup = String(markup);
      if (context.namespaceURI === XHTML && TEXT_ONLY_CONTEXTS.has(context.localName)) return null;

      const parsingContext = inert.createElementNS(context.namespaceURI, context.localName);
      parsingContext.innerHTML = markup as string;
      const parsed = parsingContext instanceof HTMLTemplateElement ? parsingContext.content : parsingContext;
      const findings = clean(parsed);

      if (mode === 'report') {
        for (const finding of findings) {
          // keyed by what was found, not where: tag names are the writer's to choose, and a key per
          // tag would let a flood of harmless ones use up the warnings before the one that matters
          const key = `${sink} ${finding.kind}`;
          if (warned.has(key)) continue;
          if (warned.size === MAX_WARNINGS) {
            warned.add(key);
            console.warn(`[braid:${fragmentId}] further capabilities.html findings are not reported`);
            continue;
          }
          if (warned.size > MAX_WARNINGS) continue;
          warned.add(key);
          console.warn(
            `[braid:${fragmentId}] ${sink} wrote markup with ${finding.kind} on <${JSON.stringify(finding.element.slice(0, 32)).slice(1, -1)}>; ` +
              `capabilities.html "sanitize" would remove it`,
          );
        }
        return null;
      }

      const fragment = inert.createDocumentFragment();
      fragment.append(...parsed.childNodes);
      return fragment;
    },
  };
}

interface Finding {
  /** What was found: `an onerror handler`, `a <script>`. */
  kind: string;
  /** The element it was found on or as. */
  element: string;
}

/** Removes what may run, and names what it removed. Mutates `root`. */
function clean(root: ParentNode): Finding[] {
  const findings: Finding[] = [];
  const found = (kind: string, element: string) => findings.push({ kind, element });
  // templates nest: their contents are separate fragments the selector does not enter
  const roots: ParentNode[] = [root];
  while (roots.length) {
    const current = roots.pop()!;
    for (const element of [...current.querySelectorAll('*')]) {
      const name = element.localName;
      const lowerName = name.toLowerCase();
      // Every script, data blocks included: the compat boundary runs a `type="inert"` one in the
      // realm, and a fragment's runtime markup has no need of either.
      if (lowerName === 'script') {
        found('a <script>', name);
        element.remove();
        continue;
      }
      const removed = REMOVED_ELEMENTS.get(lowerName);
      if (removed) {
        found(removed, name);
        element.remove();
        continue;
      }
      if (lowerName === 'meta' && element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') {
        found('a meta refresh', name);
        element.remove();
        continue;
      }
      // only the gateway writes these: the boundary turns them back into live preloads in the realm
      if (lowerName === 'link' && /^inert-/i.test(element.getAttribute('rel')?.trim() ?? '')) {
        found('an inert-* link', name);
        element.remove();
        continue;
      }
      if (lowerName === 'template') roots.push((element as HTMLTemplateElement).content);

      for (const attribute of [...element.attributes]) {
        const attributeName = attribute.name.toLowerCase();
        const attributeScheme = scheme(attribute.value);
        if (/^on/.test(attributeName)) {
          found(`an ${attributeName} handler`, name);
          element.removeAttribute(attribute.name);
        } else if (attributeName === 'srcdoc' || attributeName === 'data-script-type') {
          found(attributeName, name);
          element.removeAttribute(attribute.name);
        } else if (FRAME_SOURCES.get(lowerName) === attributeName) {
          // an allowlist, as the gateway's: a frame loads a document by URL, or none
          if (attributeScheme !== undefined && attributeScheme !== 'http' && attributeScheme !== 'https' && attribute.value.trim().toLowerCase() !== 'about:blank') {
            found(`a ${attributeScheme}: document`, name);
            element.removeAttribute(attribute.name);
          }
        } else if (URL_ATTRIBUTES.has(attributeName) && attributeScheme === 'javascript') {
          found(`a javascript: ${attributeName}`, name);
          element.removeAttribute(attribute.name);
        }
      }
    }
  }
  return findings;
}

/** A URL's scheme as the URL parser reads it: tabs, newlines and leading controls ignored. */
function scheme(value: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const url = value.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '').toLowerCase();
  return /^([a-z][a-z0-9+.-]*):/.exec(url)?.[1];
}
