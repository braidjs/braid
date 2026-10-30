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
 * - `'sanitize'` applies the gateway's rules to those writes: no `<script>`, no `on*` attribute, no
 *   `javascript:` URL, no inline or `data:`/`blob:` frame document, no meta refresh. The markup is
 *   parsed in an inert `<template>` and its cleaned nodes are inserted, never serialized and parsed
 *   again — a second parse in a different context is how sanitizers get bypassed.
 * - `'report'` writes the markup unchanged, and warns once per distinct finding with what
 *   `'sanitize'` would have removed. It parses every write a second time to know, so it is for
 *   development and staging.
 *
 * Covered: `innerHTML` on the fragment's elements and shadow root, and `insertAdjacentHTML` — the
 * sinks the fragment boundary already stamps. Not covered: `outerHTML`, `setHTMLUnsafe`,
 * `Range.createContextualFragment`, and DOM a fragment builds attribute by attribute.
 */
export type HtmlPolicyMode = 'report' | 'sanitize';

/** Attributes whose value is a URL that runs on navigation or load. */
const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'xlink:href'];

/** Elements whose source is a document of its own. */
const FRAME_ELEMENTS: Record<string, string> = { iframe: 'src', frame: 'src', embed: 'src', object: 'data' };

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
   * Parses `html` for a write through `sink`. Returns the cleaned nodes to insert in its place under
   * `'sanitize'`, or null to write the original markup (`'report'`, after warning).
   */
  filter(html: string, sink: string): DocumentFragment | null;
}

export function createHtmlPolicy(mode: HtmlPolicyMode, fragmentId: string, mainDocument: Document): HtmlPolicy {
  const warned = new Set<string>();

  return {
    filter(html, sink) {
      const template = mainDocument.createElement('template');
      template.innerHTML = html;
      const findings = clean(template.content);

      if (mode === 'sanitize') return template.content;

      for (const finding of findings) {
        const key = `${sink} ${finding}`;
        if (warned.has(key) || warned.size >= MAX_WARNINGS) continue;
        warned.add(key);
        console.warn(`[braid:${fragmentId}] ${sink} wrote markup with ${finding}; capabilities.html "sanitize" would remove it`);
      }
      return null;
    },
  };
}

/** Removes what may not run, and names what it removed. Mutates `root`. */
function clean(root: DocumentFragment): string[] {
  const findings: string[] = [];
  // templates nest: their contents are separate fragments the tree walk does not enter
  const roots: ParentNode[] = [root];
  while (roots.length) {
    const current = roots.pop()!;
    for (const element of [...current.querySelectorAll('*')]) {
      const name = element.localName;
      if (name === 'script') {
        findings.push('a <script>');
        element.remove();
        continue;
      }
      if (name === 'meta' && element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') {
        findings.push('a meta refresh');
        element.remove();
        continue;
      }
      if (name === 'template') roots.push((element as HTMLTemplateElement).content);

      for (const attribute of [...element.attributes]) {
        const attributeName = attribute.name.toLowerCase();
        if (/^on[a-z]+$/.test(attributeName)) {
          findings.push(`an ${attributeName} handler on <${name}>`);
          element.removeAttribute(attribute.name);
        } else if (attributeName === 'srcdoc') {
          findings.push(`srcdoc on <${name}>`);
          element.removeAttribute(attribute.name);
        } else if (URL_ATTRIBUTES.includes(attributeName) && scheme(attribute.value) === 'javascript') {
          findings.push(`a javascript: ${attributeName} on <${name}>`);
          element.removeAttribute(attribute.name);
        } else if (FRAME_ELEMENTS[name] === attributeName && ['data', 'blob'].includes(scheme(attribute.value) ?? '')) {
          findings.push(`a ${scheme(attribute.value)}: document in <${name}>`);
          element.removeAttribute(attribute.name);
        }
      }
    }
  }
  return findings;
}

/** A URL's scheme as the URL parser reads it: tabs, newlines and surrounding controls ignored. */
function scheme(value: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const url = value.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '').toLowerCase();
  return /^([a-z][a-z0-9+.-]*):/.exec(url)?.[1];
}
