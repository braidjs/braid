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
