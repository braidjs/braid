import { braidFragmentUrl } from '../protocol.js';
import { concatStreams, Injection, rewriteHtmlStream, StartTag } from './html-rewrite-stream.js';

/**
 * The composition protocol's HTML transforms, expressed against the owned rewriter.
 *
 * These are the normative behaviors a Braid gateway must implement; the conformance vectors in
 * `transforms.spec.ts` are their oracle, and any second implementation (a native `HTMLRewriter`
 * path on workerd, say) must pass the same vectors before it is allowed to serve traffic.
 */

/** The `<style>` the shell needs for slots and fragment stand-ins to lay out as blocks. */
export const BRAID_SHELL_STYLES =
  '<style>fragment-slot { display: block; }</style>';

/**
 * The shell's CSP nonce, read from its own response headers.
 *
 * **The gateway injects inline markup into someone else's document**, and under a strict policy —
 * `script-src 'nonce-…'`, `style-src 'nonce-…'` — anything without the right nonce is dropped
 * silently by the browser. That is the worst possible failure shape: the page renders, the slot
 * layout rule is gone, and nothing in the server logs mentions it.
 *
 * Reading the nonce off the shell's *own* CSP is the only correct source. Minting one here would
 * be worse than useless: a nonce the shell's policy does not list is not trusted, and a nonce
 * reused across responses is not a nonce. If the shell does not send a policy, or sends one
 * without a nonce, this returns null and nothing is stamped — an unrestricted page needs no
 * attribute, and a policy using hashes or `'unsafe-inline'` is not ours to second-guess.
 */
export function cspNonceOf(headers: Headers): string | null {
  const policy = headers.get('content-security-policy');
  if (!policy) return null;

  // Only script-src and style-src matter here; those are the two directives governing what this
  // layer injects. `default-src` counts when the specific directive is absent, per CSP fallback.
  const match = /(?:^|;)\s*(?:script-src|style-src|default-src)[^;]*'nonce-([A-Za-z0-9+/_-]+=*)'/.exec(policy);
  return match?.[1] ?? null;
}

/** Stamps a nonce onto generated inline markup. A no-op when the shell has no policy. */
export function withNonce(markup: string, nonce: string | null): string {
  if (!nonce) return markup;
  return markup.replace(/<(script|style)(?=[\s>])/g, `<$1 nonce="${escapeAttribute(nonce)}"`);
}

/** The `<style>` that goes inside every fragment's shadow root. */
export const BRAID_FRAGMENT_STYLES =
  '<style>:host, braid-document, braid-html, braid-body { display: block; } braid-head { display: none; }</style>';

/**
 * Inline event handler content attributes (`onclick`, `onerror`, …).
 *
 * Deliberately `on` + letters only: the browser compiles these into functions **in the document
 * that owns the node**, which for fragment content is the host page — so they are a wrong-realm
 * execution path. Framework binding syntaxes that merely look similar (`on-click`, `x-on:click`,
 * `@click`, `(click)`) contain a non-letter and are left alone; they are interpreted by the
 * fragment's own framework inside the fragment's realm, so removing them would break the app
 * without buying any isolation.
 */
const INLINE_EVENT_HANDLER = /^on[a-z]+$/;

/**
 * Attributes that point at a **subresource** the fragment owns, per element.
 *
 * A fragment's markup ends up in the host page's DOM, so these URLs resolve against the *host*
 * page rather than the fragment — `styles.css` on a host page at `/billing/invoices` would be
 * fetched from `/billing/styles.css`, which belongs to the host. Rewriting them into the
 * fragment's namespace is what makes "the fragment is served through the gateway" true for
 * everything its markup references, not just the code the realm executes.
 *
 * Navigation targets (`a[href]`, `form[action]`, `area[href]`) are deliberately absent: those
 * are page navigations, and in bound mode they belong to the host's URL space. `base[href]` is
 * absent too — it is what the fragment's own router reads to know its base path, and rewriting
 * it into the namespace would break routing.
 */
const SUBRESOURCE_ATTRIBUTES: Record<string, readonly string[]> = {
  audio: ['src'],
  embed: ['src'],
  iframe: ['src'],
  img: ['src', 'srcset'],
  input: ['src'],
  link: ['href'],
  object: ['data'],
  script: ['src'],
  source: ['src', 'srcset'],
  track: ['src'],
  use: ['href'],
  video: ['src', 'poster'],
};

const SRCSET_ATTRIBUTES = new Set(['srcset']);

/**
 * The attribute each frame-like element loads a document from.
 *
 * A frame's document is a realm of its own, but a `javascript:` URL — or an `iframe[srcdoc]` —
 * gives it the *host's* origin, with markup the fragment wrote: it runs on parse, before any
 * client code, and `parent` is the host page. Verified executing for `iframe` on both the pierced
 * and the client-boot paths; Chromium does not run `javascript:` in `embed`/`object`, which are
 * covered anyway rather than trusting that to hold in every engine. `data:` and `blob:` are refused
 * alongside it: no served markup has a use for a `blob:` URL, and a document inlined in a `data:`
 * URL is the same markup-as-code shape.
 */
const FRAME_SOURCE_ATTRIBUTES: Record<string, string> = {
  embed: 'src',
  iframe: 'src',
  object: 'data',
};

/**
 * Prepares a fragment's HTML for life inside the host page:
 *
 * - the doctype is stripped (a nested doctype makes some parsers choke, and it materializes
 *   nothing in the DOM anyway);
 * - `<html>`/`<head>`/`<body>` become `braid-html`/`braid-head`/`braid-body`, because the DOM
 *   forbids duplicates of those singletons and would silently drop them;
 * - every `<script>` is neutralized (`type="inert"`, real type parked in `data-script-type`) so
 *   it cannot execute in the host's JS context — the client activates it in the fragment's realm;
 * - script preload/prefetch/modulepreload links become `rel="inert-*"` so they don't trigger a
 *   duplicate load in the host context;
 * - inline event handler attributes are removed, and `<meta http-equiv="refresh">` is defanged;
 * - frames whose document the markup supplies inline — `iframe[srcdoc]`, or a `javascript:`,
 *   `data:` or `blob:` URL on `iframe`/`embed`/`object` — lose that attribute.
 *
 * This is the server half of the born-inert invariant, and the handler, meta-refresh and frame
 * rules are what make the invariant true rather than merely true-of-`<script>`: **no code a
 * fragment's markup carries inline can execute outside the fragment's realm or navigate the host
 * page.** Handlers, meta refresh, `srcdoc` and `javascript:` frames were each verified taking
 * effect in the host page before this transform handled them; `data:` and `blob:` frames are
 * refused alongside them (see {@link FRAME_SOURCE_ATTRIBUTES}). Whatever is removed is named in a
 * `data-braid-blocked` attribute on the tag, so a fragment that loses something can see why.
 *
 * A frame that *loads* a document from the fragment's namespace is not inline code and is left
 * alone: it runs the fragment's own code with the host's origin, as its realm already does. That
 * is the trusted tier's model, not a gap in this transform — see docs/braid-fragment-markup.md.
 *
 * Still not neutralized, because they require a user to click rather than executing on parse:
 * `javascript:` URLs on links (`a[href]`, `area[href]`) and form `action`s. Those remain within the
 * trusted tier's stated model — a trusted fragment can navigate the page a user clicks through —
 * and are called out in the security section of the README.
 */
export function prepareFragmentHtml(
  body: ReadableStream<Uint8Array>,
  options: {
    fragmentId: string;
    basePath?: string;
    /** Called with each script the fragment will load from its own namespace, for prefetch hints. */
    onScript?: (script: ScriptHint) => void;
  },
): ReadableStream<Uint8Array> {
  // every subresource is re-rooted under this: the fragment's namespace, at the gateway's mount
  const fragmentRoot = braidFragmentUrl(options.fragmentId, '', '', options.basePath);

  // Only the fragment's own scripts: a hint for any other url would have the host page fetch
  // whatever a fragment names, and it would warm nothing the realm is going to ask for.
  const hint = (href: string | null, crossorigin: string | null) => {
    if (href?.startsWith(`${fragmentRoot}/`)) options.onScript?.({ href, crossorigin });
  };

  // The fragment's own <base href>, which its subresource URLs resolve against. It appears in
  // <head> before anything that references it, so tracking it as the stream passes is enough.
  let fragmentBaseHref = '/';

  return rewriteHtmlStream(body, {
    stripDoctype: true,
    handlers: {
      '*': {
        element(tag) {
          for (const attributeName of tag.attributeNames) {
            if (INLINE_EVENT_HANDLER.test(attributeName)) {
              tag.removeAttribute(attributeName);
            }
          }
          blockInlineFrameDocuments(tag);
          rewriteSubresourceUrls(tag, fragmentRoot, fragmentBaseHref);
        },
      },
      base: {
        element(tag) {
          // read, never rewrite: this is what the fragment's router reads as its base path
          const href = tag.getAttribute('href');
          if (href) fragmentBaseHref = href;
        },
      },
      html: { element: (tag) => void (tag.tagName = 'braid-html') },
      head: { element: (tag) => void (tag.tagName = 'braid-head') },
      body: { element: (tag) => void (tag.tagName = 'braid-body') },
      script: {
        element(tag) {
          const type = tag.getAttribute('type');
          // after the wildcard handler, so this is the namespaced url the realm will request
          // module scripts are fetched in CORS mode whether or not they say so; `nomodule` ones never
          // are, by any browser that runs modules
          const crossorigin = tag.getAttribute('crossorigin');
          if (!tag.attributeNames.includes('nomodule')) {
            hint(tag.getAttribute('src'), type === 'module' ? (crossorigin ?? '') : crossorigin);
          }
          if (type) tag.setAttribute('data-script-type', type);
          tag.setAttribute('type', 'inert');
        },
      },
      link: {
        element(tag) {
          const rel = tag.getAttribute('rel');
          const href = tag.getAttribute('href');
          const crossorigin = tag.getAttribute('crossorigin');
          if (rel === 'modulepreload') hint(href, crossorigin ?? '');
          if (rel === 'preload' && tag.getAttribute('as') === 'script') hint(href, crossorigin);
          if (rel === 'preload' || rel === 'prefetch' || rel === 'modulepreload') {
            tag.setAttribute('rel', `inert-${rel}`);
          }
        },
      },
      meta: {
        element(tag) {
          // a meta refresh anywhere in the page navigates the whole host document, throwing away
          // the shell and every other fragment on it
          if (tag.getAttribute('http-equiv')?.trim().toLowerCase() !== 'refresh') return;
          tag.removeAttribute('http-equiv');
          tag.setAttribute('data-braid-blocked', 'meta-refresh');
        },
      },
    },
  });
}

/**
 * Removes a frame's document when the markup supplies it inline instead of naming one to load,
 * marking the tag with what was removed.
 *
 * An allowlist, not a `javascript:` check: the rewriter decodes only a handful of entities, and
 * a tag nothing rewrites passes through byte for byte for the browser to decode in full. A value
 * with no scheme is left to {@link namespaceUrl}, which re-roots it as a path — and re-escapes
 * it, so an entity-spelled scheme (`&#106;avascript:`) comes out as a harmless same-origin path.
 */
function blockInlineFrameDocuments(tag: StartTag): void {
  const sourceAttribute = FRAME_SOURCE_ATTRIBUTES[tag.tagName];
  if (!sourceAttribute) return;

  const blocked: string[] = [];

  const source = tag.getAttribute(sourceAttribute);
  if (source !== null && !loadsDocumentByUrl(source)) {
    tag.removeAttribute(sourceAttribute);
    blocked.push(sourceAttribute);
  }

  // by name, not value: a valueless `srcdoc` reads as null, and still overrides `src`
  if (tag.tagName === 'iframe' && tag.attributeNames.includes('srcdoc')) {
    tag.removeAttribute('srcdoc');
    blocked.push('srcdoc');
  }

  if (blocked.length) tag.setAttribute('data-braid-blocked', blocked.join(' '));
}

/** Whether a frame URL names a document to fetch (or none), rather than carrying one inline. */
function loadsDocumentByUrl(rawUrl: string): boolean {
  const url = asUrlParserReadsIt(rawUrl).toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(url)?.[1];
  return scheme === undefined || scheme === 'http' || scheme === 'https' || url === 'about:blank';
}

/**
 * A URL as the WHATWG URL parser sees it before reading a scheme: tabs and newlines removed
 * anywhere, C0 controls and spaces trimmed from both ends. `String#trim` models neither.
 */
function asUrlParserReadsIt(rawUrl: string): string {
  const url = rawUrl.replace(/[\t\n\r]/g, '');
  let start = 0;
  let end = url.length;
  while (start < end && url.charCodeAt(start) <= 0x20) start++;
  while (end > start && url.charCodeAt(end - 1) <= 0x20) end--;
  return url.slice(start, end);
}

/** Rewrites a tag's subresource URLs into the fragment's namespace. */
function rewriteSubresourceUrls(tag: StartTag, fragmentRoot: string, baseHref: string): void {
  const attributes = SUBRESOURCE_ATTRIBUTES[tag.tagName];
  if (!attributes) return;

  for (const attributeName of attributes) {
    const value = tag.getAttribute(attributeName);
    if (!value) continue;

    const rewritten = SRCSET_ATTRIBUTES.has(attributeName)
      ? rewriteSrcset(value, fragmentRoot, baseHref)
      : namespaceUrl(value, fragmentRoot, baseHref);

    if (rewritten !== null) {
      tag.setAttribute(attributeName, rewritten);
    }
  }
}

/**
 * Maps one URL into the fragment's namespace, or returns null to leave it untouched.
 *
 * Left alone: anything with a scheme (`https:`, `data:`, `blob:`), protocol-relative URLs, and
 * pure fragment identifiers — none of those are the fragment's own subresources.
 */
function namespaceUrl(rawUrl: string, fragmentRoot: string, baseHref: string): string | null {
  const url = rawUrl.trim();
  if (!url || url.startsWith('#') || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return null;
  }

  // resolve exactly as the browser would have in the fragment's own document, then re-root it
  const resolved = new URL(url, `http://braid.invalid${baseHref.startsWith('/') ? baseHref : `/${baseHref}`}`);
  return `${fragmentRoot}${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/** Rewrites each candidate in a `srcset`, preserving its density/width descriptors. */
function rewriteSrcset(value: string, fragmentRoot: string, baseHref: string): string | null {
  const candidates = value.split(',');
  let changed = false;

  const rewritten = candidates.map((candidate) => {
    const match = /^(\s*)(\S+)(\s*.*)$/.exec(candidate);
    if (!match) return candidate;

    const [, leading, url, descriptor] = match;
    const namespaced = namespaceUrl(url, fragmentRoot, baseHref);
    if (namespaced === null) return candidate;

    changed = true;
    return `${leading}${namespaced}${descriptor}`;
  });

  return changed ? rewritten.join(',') : null;
}

/** A script a fragment will load, for a preload hint in the host document. */
export interface ScriptHint {
  href: string;
  /**
   * The CORS mode the realm will fetch it in: null for none, `''` for anonymous, or the explicit
   * value. The hint has to match or the HTTP cache will not answer the realm's request with it.
   */
  crossorigin: string | null;
}

/**
 * Prefetch hints for a pierced fragment's scripts, emitted in its shadow root after its content —
 * where the list is complete, and outside the `<braid-document>` the fragment sees as its own.
 *
 * A pierced fragment's scripts are inert until the client boots it, which means after the host's
 * own JavaScript has loaded, the realm has booted, and the handshake has run. These start the
 * downloads while the rest of the page is still parsing. The realm is a separate document, so it
 * benefits through the HTTP cache: cacheable assets (content-hashed bundles, normally) gain a round
 * trip or more.
 *
 * `prefetch`, not `preload`: the host document never uses these itself, so a preload is reported
 * as unused on every page, and it is fetched at high priority mid-body, ahead of the shell's own
 * images. A prefetch is idle-priority and silent, and measured the same gain.
 */
export function scriptPrefetchHints(scripts: readonly ScriptHint[]): string {
  return [...new Map(scripts.map((script) => [script.href, script])).values()]
    .map(({ href, crossorigin }) => {
      const cors = crossorigin === null ? '' : crossorigin ? ` crossorigin="${escapeAttribute(crossorigin)}"` : ' crossorigin';
      return `<link rel="prefetch" href="${escapeAttribute(href)}"${cors}>`;
    })
    .join('');
}

export interface PierceTarget {
  fragmentId: string;
  /**
   * The fragment's prepared content (see {@link prepareFragmentHtml}), or null to pierce
   * nothing — the slot is left for the client to fill by fetching (the `omit`/`placeholder`
   * failure fallbacks).
   */
  content: ReadableStream<Uint8Array> | null;
  /** Set as `data-braid-fallback` on the slot when content is omitted, for skeleton styling. */
  fallbackReason?: string;
  /**
   * Markup emitted in the shadow root after `<braid-document>`, once `content` has been fully streamed (and so after
   * anything collected while streaming it is known). Used for {@link scriptPrefetchHints}.
   */
  after?: () => string;
  /**
   * The path the manifest says this fragment's content lives at, for unbound fragments.
   *
   * The host's own template is what tells the client where to mount an unbound fragment, so this is
   * carried only to check the two against each other. Declaring it in both places is the accepted
   * cost of the slot working identically whether or not the page was pierced; warning on
   * disagreement is what stops that duplication from drifting in silence.
   */
  src?: string;
}

/**
 * A fragment whose response has not arrived yet.
 *
 * The shell streams on without it; the stream waits for `settled` only when it reaches this
 * fragment's slot (or, for a shell with no slot, the end of `<body>`).
 */
export interface PendingPierceTarget extends Pick<PierceTarget, 'fragmentId' | 'src'> {
  settled: Promise<Pick<PierceTarget, 'content' | 'fallbackReason' | 'after'>>;
}

export interface PierceOptions {
  /** The shell application's HTML. */
  shell: ReadableStream<Uint8Array>;
  /** The fragments to pierce into this document, in registration order. */
  fragments: (PierceTarget | PendingPierceTarget)[];
  /**
   * Markup appended inside `<head>`, after the shell styles. Used for the optional web-vitals
   * collector; empty for every other deployment, which is why it is a string the caller composes
   * rather than a telemetry-shaped option this layer would have to know about.
   */
  headScript?: string;
  /**
   * The shell's CSP nonce, so injected inline markup survives a strict policy. See
   * {@link cspNonceOf} for why this must come from the shell rather than be minted here.
   */
  nonce?: string | null;
}

/**
 * Pierces a fragment into the shell's HTML stream.
 *
 * The fragment's server-rendered content is injected into the matching `<fragment-slot>` as a
 * declarative shadow root, so the browser parses it into exactly the shape the client runtime
 * would have built — the slot then adopts it instead of fetching, and the fragment paints as
 * part of the shell's first response rather than a round trip later.
 *
 * Injection is stream-interleaved: the shell streams out until the slot is reached, the
 * fragment's stream is spliced in as it arrives, then the rest of the shell follows.
 *
 * If the shell contains no matching slot, the fragment is appended before `</body>` (or at the
 * end of the document — `</body>` is optional in HTML and often omitted) inside a slot element
 * the gateway creates. This keeps piercing working for shells that haven't been marked up yet.
 */
export function pierceShellHtml(options: PierceOptions): ReadableStream<Uint8Array> {
  const { shell, headScript, nonce } = options;

  const pending = new Map(options.fragments.map((fragment) => [fragment.fragmentId, fragment]));
  let stylesInjected = false;

  const settle = async (target: PierceTarget | PendingPierceTarget): Promise<PierceTarget> =>
    'settled' in target
      ? { fragmentId: target.fragmentId, ...(target.src === undefined ? {} : { src: target.src }), ...(await target.settled) }
      : target;

  const shadowRoot = (target: PierceTarget): Injection[] => [
    '<template shadowrootmode="open">',
    BRAID_FRAGMENT_STYLES,
    '<braid-document>',
    target.content ?? '',
    '</braid-document>',
    ...(target.after ? [lazyText(target.after)] : []),
    '</template>',
  ];

  /** A slot element the gateway creates because the shell didn't mark one up. */
  const orphanSlot = (target: PierceTarget): Injection =>
    concatStreams([
      `<fragment-slot name="${escapeAttribute(target.fragmentId)}"` +
        // A slot the gateway invents has no template to have declared `src`, so the manifest's is
        // the only source there is.
        `${target.src ? ` src="${escapeAttribute(target.src)}"` : ''} data-braid-pierced="">`,
      ...shadowRoot(target),
      '</fragment-slot>',
    ]);

  /** Every fragment that never found a slot, appended in registration order. */
  const remainingOrphans = async (): Promise<Injection | undefined> => {
    const remaining = [...pending.values()];
    pending.clear();
    const orphans = (await Promise.all(remaining.map(settle))).filter((target) => target.content);
    return orphans.length ? concatStreams(orphans.map(orphanSlot)) : undefined;
  };

  return rewriteHtmlStream(shell, {
    handlers: {
      head: {
        element(tag) {
          if (stylesInjected) return;
          stylesInjected = true;
          // Styles first: the slot layout rules must land before any fragment content is parsed,
          // and an async measurement script must never be what delays them.
          tag.prepend(withNonce(BRAID_SHELL_STYLES + (headScript ?? ''), nonce ?? null));
        },
      },

      'fragment-slot': {
        element(tag) {
          const name = tag.getAttribute('name');
          const unsettled = name ? pending.get(name) : undefined;
          // synchronous unless this slot is one being pierced: only those wait
          if (!unsettled) return;
          pending.delete(unsettled.fragmentId);
          return pierceSlot(tag, unsettled);
        },
      },

      body: {
        async endTag(tag) {
          const orphans = await remainingOrphans();
          if (orphans) tag.before(orphans);
        },
      },
    },

    // `</body>` is optional in HTML and frequently omitted — this is the safety net
    onEnd: remainingOrphans,
  });

  /** Fills a pierced slot once its fragment has settled. The one place the stream waits for it. */
  async function pierceSlot(tag: StartTag, unsettled: PierceTarget | PendingPierceTarget): Promise<void> {
    // everything before the slot is already out
    const target = await settle(unsettled);

    const declared = tag.getAttribute('src');
    if (target.src && declared && declared !== target.src) {
      // Two sources of truth that disagree: the gateway pierced content from one path while
      // the client will boot the fragment at another, so the widget changes under the user
      // the moment it hydrates. Cheap to say, and invisible otherwise.
      console.warn(
        `braid-gateway: slot for fragment "${target.fragmentId}" declares src="${declared}" ` +
          `but its manifest declares src="${target.src}" — the pierced content and the client ` +
          `boot would come from different paths`,
      );
    }
    if (target.src && !declared) tag.setAttribute('src', target.src);

    if (!target.content) {
      // nothing to pierce: mark the slot so the page can style a skeleton, and let the
      // client runtime fetch the fragment itself
      if (target.fallbackReason) tag.setAttribute('data-braid-fallback', target.fallbackReason);
      return;
    }

    tag.setAttribute('data-braid-pierced', '');
    for (const part of shadowRoot(target)) {
      tag.prepend(part);
    }
  }
}

/**
 * A stream whose text is computed when it is first read, not when it is built — so it can describe
 * what the injections before it streamed. A zero high-water mark is what keeps `pull` from running
 * eagerly at construction.
 */
function lazyText(text: () => string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const value = text();
        if (value) controller.enqueue(new TextEncoder().encode(value));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
