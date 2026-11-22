import { type DefaultTreeAdapterTypes, parse, parseFragment } from 'parse5';

/**
 * What must be true of a prepared fragment once a browser has parsed it — here, parse5, which
 * implements the spec as it stood before customizable `<select>` (the e2e test asks Chromium,
 * which implements it after).
 *
 * Parsed in both contexts fragment markup reaches: pierced, inside `<template shadowrootmode>`'s
 * `<braid-document>` in the host page with host markup after it; and fetched, inside a
 * `<braid-document>` in a template (`compat-adapter.ts`).
 */

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

const HTML = 'http://www.w3.org/1999/xhtml';
const SENTINEL = '<p id="braid-sentinel">after</p>';

export function violations(output: string): string[] {
  return [...piercedViolations(output), ...fetchedViolations(output)];
}

export function piercedViolations(output: string): string[] {
  const document = parse(
    `<!DOCTYPE html><html><head></head><body><fragment-slot name="f"><template shadowrootmode="open">` +
      `<braid-document>${output}</braid-document></template></fragment-slot>${SENTINEL}</body></html>`,
  );
  const found: string[] = [];
  const html = elements(document.childNodes).find((node) => node.tagName === 'html')!;
  const body = elements(html.childNodes).find((node) => node.tagName === 'body')!;
  const [slot, sentinel, ...rest] = elements(body.childNodes);
  if (slot?.tagName !== 'fragment-slot' || sentinel?.tagName !== 'p' || attribute(sentinel, 'id') !== 'braid-sentinel' || rest.length) {
    found.push(`pierced: the host markup after the fragment changed (${describe(body)})`);
  }
  if (sentinel && text(sentinel) !== 'after') found.push('pierced: the sentinel lost its text');
  const template = slot && elements(slot.childNodes);
  if (!template || template.length !== 1 || template[0].tagName !== 'template') {
    found.push(`pierced: something escaped the shadow root (${slot ? describe(slot) : 'no slot'})`);
    return [...found, ...walk(body, 'pierced')];
  }
  found.push(...contained((template[0] as DefaultTreeAdapterTypes.Template).content, 'pierced'));
  return found;
}

export function fetchedViolations(output: string): string[] {
  const fragment = parseFragment(`<template><braid-document>${output}</braid-document></template>`);
  const [template, ...rest] = elements(fragment.childNodes);
  if (template?.tagName !== 'template' || rest.length) {
    return ['fetched: something escaped the template', ...walk(fragment, 'fetched')];
  }
  return contained((template as DefaultTreeAdapterTypes.Template).content, 'fetched');
}

function contained(content: DefaultTreeAdapterTypes.DocumentFragment, context: string): string[] {
  const found: string[] = [];
  const children = elements(content.childNodes);
  if (children.length !== 1 || children[0].tagName !== 'braid-document') {
    found.push(`${context}: markup outside braid-document (${children.map((child) => child.tagName).join(', ')})`);
  }
  return [...found, ...walk(content, context)];
}

/** Every element below `root`, template content included, checked for what must not be live. */
function walk(root: Node, context: string): string[] {
  const found: string[] = [];
  const visit = (node: Node) => {
    if ('tagName' in node) check(node, (problem) => found.push(`${context}: <${node.tagName}> ${problem}`));
    if ('content' in node && node.content) visit(node.content);
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}

function check(element: Element, report: (problem: string) => void): void {
  for (const { name } of element.attrs) {
    if (/^on[a-z]+$/.test(name)) report(`has an inline handler, ${name}`);
  }
  if (element.tagName === 'script' && attribute(element, 'type') !== 'inert') report('is a live script');
  if (element.namespaceURI !== HTML) return;
  switch (element.tagName) {
    case 'iframe':
      if (element.attrs.some((a) => a.name === 'srcdoc')) report('has srcdoc');
      if (!loadsByUrl(attribute(element, 'src'))) report('loads an inline document');
      break;
    case 'embed':
      if (!loadsByUrl(attribute(element, 'src'))) report('loads an inline document');
      break;
    case 'object':
      if (!loadsByUrl(attribute(element, 'data'))) report('loads an inline document');
      break;
    case 'meta':
      if (attribute(element, 'http-equiv')?.trim().toLowerCase() === 'refresh') report('refreshes the page');
      break;
    case 'link': {
      const rel = (attribute(element, 'rel') ?? '').toLowerCase().split(/[\t\n\f\r ]+/);
      if (rel.some((token) => token === 'preload' || token === 'prefetch' || token === 'modulepreload')) {
        report('preloads in the host');
      }
      break;
    }
  }
}

function loadsByUrl(raw: string | null): boolean {
  if (raw === null) return true;
  // as the URL parser reads it: tabs and newlines removed, C0 controls and spaces trimmed
  let url = raw.replace(/[\t\n\r]/g, '');
  let start = 0;
  let end = url.length;
  while (start < end && url.charCodeAt(start) <= 0x20) start++;
  while (end > start && url.charCodeAt(end - 1) <= 0x20) end--;
  url = url.slice(start, end).toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(url)?.[1];
  return scheme === undefined || scheme === 'http' || scheme === 'https' || url === 'about:blank';
}

function elements(nodes: Node[]): Element[] {
  return nodes.filter((node): node is Element => 'tagName' in node);
}

function attribute(element: Element, name: string): string | null {
  return element.attrs.find((a) => a.name === name)?.value ?? null;
}

function text(element: Element): string {
  return element.childNodes.map((node) => ('value' in node && node.nodeName === '#text' ? node.value : '')).join('');
}

function describe(element: Element): string {
  return elements(element.childNodes)
    .map((child) => child.tagName)
    .join(', ');
}
