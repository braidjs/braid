import { getBraidConfig } from '../config.js';
import { braidFragmentUrl } from '../protocol.js';

/**
 * How long a prefetched document waits for its slot. Long enough to cover hover-to-click and a
 * router's own work; short enough that a document rendered for one moment is never shown in a much
 * later one. Personalised markup is held in memory for at most this long, used once, and dropped.
 */
export const PREFETCH_TTL_MS = 10_000;

type DocumentResult = Promise<{ html: string; isHtml: boolean }>;

interface Prefetched {
  document: DocumentResult;
  controller: AbortController;
  expiry: ReturnType<typeof setTimeout>;
}

const prefetched = new Map<string, Prefetched>();

const keyOf = (fragmentId: string, routeSrcUrl: URL) => `${fragmentId} ${routeSrcUrl.pathname}${routeSrcUrl.search}`;

/**
 * Starts a prefetch: the document now, held for {@link takePrefetchedDocument}; the document's
 * scripts as HTTP-cache hints. `fetchDocument` is the slot's own document fetch,
 * passed in so this module does not import the slot. See `prefetchFragment`.
 */
export function startPrefetch(fragmentId: string, route: string, fetchDocument: (url: URL, signal: AbortSignal) => DocumentResult): void {
  const routeSrcUrl = new URL(route, document.baseURI);
  const key = keyOf(fragmentId, routeSrcUrl);
  if (prefetched.has(key)) return;

  const controller = new AbortController();
  const result = fetchDocument(routeSrcUrl, controller.signal);
  // held, not awaited: a failure surfaces when (if) a slot takes it, exactly as its own fetch would
  result.catch(() => undefined);
  const expiry = setTimeout(() => {
    prefetched.delete(key);
    controller.abort();
  }, PREFETCH_TTL_MS);
  prefetched.set(key, { document: result, controller, expiry });

  // The realm stub is not hinted: a host-document prefetch does not satisfy the realm iframe's
  // navigation in Chrome's cache, so it would only be fetched twice.
  void result.then(({ html, isHtml }) => {
    if (!isHtml) return;
    // only the fragment's own namespace, as the gateway's own hints are: a document does not get to
    // make the host fetch whatever URL it names
    const namespace = new URL(`${braidFragmentUrl(fragmentId, '/', '', getBraidConfig().basePath)}`, location.origin).href;
    for (const script of scriptsIn(html)) {
      const url = new URL(script.href, document.baseURI).href;
      if (url.startsWith(namespace)) hint(url, script.crossorigin);
    }
  }, () => undefined);
}

/**
 * The prefetched document for a slot about to fetch its own, if one is held. Single use: taking it
 * removes it, and the slot's abort signal now governs the request.
 */
export function takePrefetchedDocument(fragmentId: string, routeSrcUrl: URL, signal: AbortSignal): DocumentResult | undefined {
  const key = keyOf(fragmentId, routeSrcUrl);
  const entry = prefetched.get(key);
  if (!entry) return undefined;
  prefetched.delete(key);
  clearTimeout(entry.expiry);
  if (signal.aborted) entry.controller.abort();
  else signal.addEventListener('abort', () => entry.controller.abort(), { once: true });
  return entry.document;
}

/**
 * Drops every held prefetch. Call it when the user signs out or switches account: a held document
 * was rendered for whoever was signed in when it was fetched.
 */
export function clearPrefetchedFragments(): void {
  for (const entry of prefetched.values()) {
    clearTimeout(entry.expiry);
    entry.controller.abort();
  }
  prefetched.clear();
  hinted.clear();
}

/**
 * The scripts a prepared document will have the realm load, in the CORS mode it will use — the
 * gateway has made them inert and kept the original type as `data-script-type`.
 */
function scriptsIn(html: string): { href: string; crossorigin: string | null }[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  return [...template.content.querySelectorAll<HTMLScriptElement>('script[src]:not([nomodule])')].map((script) => {
    const crossorigin = script.getAttribute('crossorigin');
    const isModule = script.getAttribute('data-script-type') === 'module';
    return { href: script.getAttribute('src')!, crossorigin: isModule ? (crossorigin ?? '') : crossorigin };
  });
}

/** Hrefs already hinted on this page, so hovering the same link again adds nothing to `<head>`. */
const hinted = new Set<string>();

function hint(href: string, crossorigin: string | null): void {
  if (hinted.has(href)) return;
  hinted.add(href);
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.href = href;
  if (crossorigin !== null) link.crossOrigin = crossorigin;
  document.head.append(link);
}
