import { describe, expect, it } from 'vitest';
import { createGateway } from './gateway.js';

/**
 * A pierced page starts streaming when the *shell* responds, not when the slowest fragment does.
 *
 * Everything before the first slot — the shell's `<head>`, its stylesheets and scripts — reaches
 * the browser at the shell's own pace. Only the bytes after a slot wait on that slot's fragment.
 */

const SHELL = `<html><head><link rel="stylesheet" href="/shell.css"></head><body><h1>Shell</h1><fragment-slot name="billing"></fragment-slot><footer>end</footer></body></html>`;

function gated<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

const settles = <T>(promise: Promise<T>, ms = 50) =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

function pierceGateway(fragment: Promise<Response>, fallback: 'placeholder' | 'error-html' = 'placeholder') {
  return createGateway({
    registry: [
      {
        id: 'billing',
        pierce: ['/billing/*'],
        fallback,
        endpoint: (async () => fragment) as unknown as typeof fetch,
      },
    ],
  });
}

const navigation = new Request('https://x.example/billing/invoices', { headers: { 'sec-fetch-dest': 'document' } });
const shell = async () => new Response(SHELL, { headers: { 'content-type': 'text/html' } });

describe('pierce streaming', () => {
  it('responds, and streams the shell up to the slot, before a slow fragment answers', async () => {
    const fragment = gated<Response>();
    const gateway = pierceGateway(fragment.promise);

    const handled = gateway.handle(navigation, shell);
    expect(await settles(handled)).toBe(true);

    const reader = (await handled)!.body!.getReader();
    const decoder = new TextDecoder();
    let early = '';
    // up to the slot: its own start tag waits, since its attributes depend on how the fetch went
    while (!early.includes('<h1>Shell</h1>')) {
      const next = reader.read();
      expect(await settles(next)).toBe(true);
      early += decoder.decode((await next).value);
    }
    expect(early).toContain('/shell.css');
    expect(early).not.toContain('<h2>Invoices</h2>');

    fragment.open(new Response('<h2>Invoices</h2>', { headers: { 'content-type': 'text/html' } }));
    let rest = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += decoder.decode(chunk.value);

    const html = early + rest;
    expect(html).toContain('<fragment-slot name="billing" data-braid-pierced="">');
    expect(html).toContain('<h2>Invoices</h2>');
    expect(html.indexOf('<h2>Invoices</h2>')).toBeLessThan(html.indexOf('<footer>'));
  });

  it('still falls back at the slot when the fragment fails after the shell has started streaming', async () => {
    const fragment = gated<Response>();
    const gateway = pierceGateway(fragment.promise);

    const response = (await gateway.handle(navigation, shell))!;
    fragment.open(new Response('nope', { status: 503 }));
    const html = await response.text();

    expect(html).toContain('<fragment-slot name="billing" data-braid-fallback="placeholder">');
    expect(html).toContain('<footer>end</footer>');
  });

  it('renders error html at the slot for a late failure when the manifest asks for it', async () => {
    const fragment = gated<Response>();
    const gateway = pierceGateway(fragment.promise, 'error-html');

    const response = (await gateway.handle(navigation, shell))!;
    fragment.open(new Response('nope', { status: 503 }));

    expect(await response.text()).toContain('responded with HTTP 503');
  });
});

describe('out-of-order pierce streaming', () => {
  function outOfOrderGateway(fragment: Promise<Response>, extra: Record<string, unknown> = {}) {
    return createGateway({
      registry: [
        {
          id: 'billing',
          pierce: ['/billing/*'],
          stream: 'out-of-order',
          endpoint: (async () => fragment) as unknown as typeof fetch,
          ...extra,
        },
      ],
    });
  }

  /** Reads until the accumulated text contains `marker`, failing if the stream stalls first. */
  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string, seen = '') {
    const decoder = new TextDecoder();
    while (!seen.includes(marker)) {
      const next = reader.read();
      expect(await settles(next)).toBe(true);
      const chunk = await next;
      if (chunk.done) break;
      seen += decoder.decode(chunk.value);
    }
    return seen;
  }

  it('streams the shell past a slow fragment’s slot, then sends its markup at the end', async () => {
    const fragment = gated<Response>();
    const gateway = outOfOrderGateway(fragment.promise);

    const reader = (await gateway.handle(navigation, shell))!.body!.getReader();
    // the footer is after the slot, and arrives while the fragment is still out
    const early = await readUntil(reader, '<footer>end</footer>');
    const token = /data-braid-deferred="([0-9a-f-]{36})"/.exec(early)?.[1];
    expect(token).toBeDefined();
    expect(early).not.toContain('<h2>Invoices</h2>');

    fragment.open(new Response('<h2>Invoices</h2>', { headers: { 'content-type': 'text/html' } }));
    let rest = '';
    const decoder = new TextDecoder();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += decoder.decode(chunk.value);

    expect(rest).toContain(`<braid-late for="billing" token="${token}" hidden><template shadowrootmode="open">`);
    expect(rest).toContain('<h2>Invoices</h2>');
    // closed by a sentinel after the shadow root, so an early-loaded client delivers once it exists
    expect(rest).toContain('</template><braid-late-end></braid-late-end></braid-late>');
    // still inside the body, so the parser builds it into the same document
    expect(rest.indexOf('</braid-late>')).toBeLessThan(rest.indexOf('</body>'));
  });

  it('inlines a fragment that answered before its slot streamed, exactly as in-order does', async () => {
    const answered = () => Promise.resolve(new Response('<h2>Invoices</h2>', { headers: { 'content-type': 'text/html' } }));
    const outOfOrder = await (await outOfOrderGateway(answered()).handle(navigation, shell))!.text();
    const inOrder = await (await pierceGateway(answered()).handle(navigation, shell))!.text();

    expect(outOfOrder).toBe(inOrder);
    expect(outOfOrder).not.toContain('braid-late');
  });

  it('sends an empty late element for a fragment that fails, so the client boots the slot itself', async () => {
    const fragment = gated<Response>();
    const gateway = outOfOrderGateway(fragment.promise);

    const reader = (await gateway.handle(navigation, shell))!.body!.getReader();
    const early = await readUntil(reader, '<footer>end</footer>');
    fragment.open(new Response('nope', { status: 503 }));
    let rest = '';
    const decoder = new TextDecoder();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += decoder.decode(chunk.value);

    const token = /data-braid-deferred="([0-9a-f-]{36})"/.exec(early)?.[1];
    expect(rest).toContain(
      `<braid-late for="billing" token="${token}" data-braid-empty="" data-braid-fallback="placeholder" hidden></braid-late>`,
    );
  });

  it('times out at the end of the document rather than at the slot', async () => {
    // an endpoint that answers only by being aborted, as a hung origin does
    const hung = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    const gateway = outOfOrderGateway(Promise.resolve(new Response('')), { timeoutMs: 30, endpoint: hung });

    const html = await (await gateway.handle(navigation, shell))!.text();
    expect(html.indexOf('<footer>end</footer>')).toBeLessThan(html.indexOf('<braid-late for="billing"'));
    expect(html).toContain('data-braid-fallback="placeholder"');
  });

  it('mints a fresh token for every response', async () => {
    const tokenOf = async () => {
      const fragment = gated<Response>();
      const reader = (await outOfOrderGateway(fragment.promise).handle(navigation, shell))!.body!.getReader();
      const early = await readUntil(reader, '<footer>end</footer>');
      fragment.open(new Response('<h2>Invoices</h2>', { headers: { 'content-type': 'text/html' } }));
      await reader.cancel();
      return /data-braid-deferred="([^"]+)"/.exec(early)?.[1];
    };
    const [first, second] = [await tokenOf(), await tokenOf()];
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it('inlines a fragment that answers within a turn of the slot streaming, rather than deferring it', async () => {
    const soon = new Promise<Response>((resolve) =>
      queueMicrotask(() => resolve(new Response('<h2>Invoices</h2>', { headers: { 'content-type': 'text/html' } }))),
    );
    const html = await (await outOfOrderGateway(soon).handle(navigation, shell))!.text();
    expect(html).not.toContain('braid-late');
    expect(html.indexOf('<h2>Invoices</h2>')).toBeLessThan(html.indexOf('<footer>'));
  });

  it('rejects an unknown stream value', () => {
    expect(() => outOfOrderGateway(Promise.resolve(new Response('')), { stream: 'sideways' })).toThrow(/stream: "sideways"/);
  });
});

describe('pierced script prefetch hints', () => {
  it('prefetches the fragment’s own scripts, in the CORS mode the realm will use', async () => {
    const gateway = pierceGateway(
      Promise.resolve(
        new Response(
          `<html><head><link rel="modulepreload" href="/chunk.js"><script type="module" src="/main.js"></script>` +
            `<script src="/legacy.js"></script><script type="module" src="/main.js"></script>` +
            `<script src="/creds.js" crossorigin="use-credentials"></script>` +
            `<script nomodule src="/polyfills.js"></script>` +
            `<script src="https://cdn.elsewhere.example/lib.js"></script></head>` +
            `<body><h2>Invoices</h2><script>inline()</script></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        ),
      ),
    );

    const html = await (await gateway.handle(navigation, shell))!.text();

    // inside the shadow root, after the fragment's document: the slot's light DOM stays the host's
    expect(html.slice(html.indexOf('</braid-document>'), html.indexOf('</fragment-slot>'))).toBe(
      '</braid-document>' +
        '<link rel="prefetch" href="/__braid/frag/billing/chunk.js" crossorigin>' +
        '<link rel="prefetch" href="/__braid/frag/billing/main.js" crossorigin>' +
        '<link rel="prefetch" href="/__braid/frag/billing/legacy.js">' +
        '<link rel="prefetch" href="/__braid/frag/billing/creds.js" crossorigin="use-credentials">' +
        '</template>',
    );
    // and nothing live inside the shadow root: the fragment's own copies stay inert
    expect(html).toContain('<link rel="inert-modulepreload" href="/__braid/frag/billing/chunk.js">');
  });

  it('adds none for a fragment that fell back', async () => {
    const gateway = pierceGateway(Promise.resolve(new Response('nope', { status: 503 })));

    const html = await (await gateway.handle(navigation, shell))!.text();

    expect(html).not.toContain('rel="prefetch"');
  });
});
