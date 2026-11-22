import { describe, expect, it } from 'vitest';
import { parseFragmentContent } from './compat-adapter.js';

/**
 * The client parses markup the gateway already prepared. These assert it adopts that markup
 * faithfully — in particular that it does *not* re-run the server-side transforms, which would
 * record `inert` as a script's real type and stop it ever executing.
 */
describe('parseFragmentContent()', () => {
  it('adopts gateway-prepared document markup as-is', () => {
    const content = parseFragmentContent(
      `<braid-html lang="en"><braid-head><title>Billing</title></braid-head>` +
        `<braid-body class="legacy"><h1>Invoices</h1></braid-body></braid-html>`,
      document,
    );

    expect(content.tagName).toBe('BRAID-HTML');
    expect(content.getAttribute('lang')).toBe('en');
    expect(content.querySelector('braid-head title')!.textContent).toBe('Billing');
    expect(content.querySelector('braid-body')!.getAttribute('class')).toBe('legacy');
    expect(content.ownerDocument).toBe(document);
  });

  it('leaves already-neutralized scripts exactly as the gateway left them', () => {
    const content = parseFragmentContent(
      `<braid-html><braid-body>` +
        `<script type="inert" data-script-type="module" src="/__braid/frag/billing/main.js"></script>` +
        `</braid-body></braid-html>`,
      document,
    );

    const script = content.querySelector('script')!;
    expect(script.getAttribute('type')).toBe('inert');
    // the real type must survive — the activation path restores it to run the script
    expect(script.getAttribute('data-script-type')).toBe('module');
    expect(script.getAttribute('src')).toBe('/__braid/frag/billing/main.js');
  });

  it('wraps bare markup that has no braid-html root', () => {
    const content = parseFragmentContent(`<p>fragment</p>`, document);

    expect(content.tagName).toBe('BRAID-HTML');
    expect(content.querySelector('braid-body p')!.textContent).toBe('fragment');
  });

  // The gateway writes fragment markup to be read one way where a pierced fragment is parsed:
  // inside a <braid-document> in a template, with scripting on. The fetched path parses it there too.
  it('keeps a bare snippet’s leading <style>, which a document parse moves to a <head> and loses', () => {
    const content = parseFragmentContent(`<style>p { color: red }</style><p>fragment</p>`, document);

    expect(content.querySelector('braid-body > style')!.textContent).toBe('p { color: red }');
    expect(content.querySelector('braid-body > p')!.textContent).toBe('fragment');
  });

  it('parses in the same context as a pierced fragment: table and form rules of a template', () => {
    // in a template, a <form> inside a <form> is a second form, and table text stays in place
    const content = parseFragmentContent(`<form id="a"><form id="b"></form></form><table>x</table>`, document);

    expect([...content.querySelectorAll('form')].map((form) => form.id)).toEqual(['a', 'b']);
    expect(content.querySelector('braid-body')!.firstChild).toBe(content.querySelector('form'));
  });

  it('does not execute scripts while parsing', () => {
    (window as unknown as { __parsedScriptRan?: boolean }).__parsedScriptRan = false;
    const closingScriptTag = '</' + 'script>';
    parseFragmentContent(
      `<braid-body><script>window.__parsedScriptRan = true;${closingScriptTag}</braid-body>`,
      document,
    );

    expect((window as unknown as { __parsedScriptRan?: boolean }).__parsedScriptRan).toBe(false);
  });
});
