import { describe, expect, it } from 'vitest';
import { fragmentSrcset, fragmentSubresourceUrl, subresourceUrlOverrides } from './subresource-urls.js';

const base = 'https://shell.example/__braid/frag/billing/billing/invoices/';

describe('fragmentSubresourceUrl()', () => {
  it('re-roots relative and root-relative URLs into the namespace, as the gateway does for markup', () => {
    expect(fragmentSubresourceUrl('logo.png', base)).toBe('/__braid/frag/billing/billing/invoices/logo.png');
    expect(fragmentSubresourceUrl('../renew.html?x=1#h', base)).toBe('/__braid/frag/billing/billing/renew.html?x=1#h');
    expect(fragmentSubresourceUrl('/assets/app.js', base)).toBe('/__braid/frag/billing/assets/app.js');
  });

  it('keeps a gateway basePath in front of the namespace', () => {
    expect(fragmentSubresourceUrl('a.png', 'https://shell.example/portal/__braid/frag/billing/')).toBe('/portal/__braid/frag/billing/a.png');
  });

  it('leaves absolute, protocol-relative, data, fragment-only and empty URLs alone', () => {
    for (const url of ['https://cdn.example/x.js', '//cdn.example/x.js', 'data:image/png;base64,AA', 'blob:abc', '#top', '']) {
      expect(fragmentSubresourceUrl(url, base)).toBe(url);
    }
  });

  it('leaves URLs alone when the realm base is not a fragment namespace', () => {
    expect(fragmentSubresourceUrl('logo.png', 'https://shell.example/some/page')).toBe('logo.png');
  });

  it('maps every srcset candidate and keeps descriptors', () => {
    expect(fragmentSrcset('a.png 1x, https://cdn.example/b.png 2x', base)).toBe(
      '/__braid/frag/billing/billing/invoices/a.png 1x, https://cdn.example/b.png 2x',
    );
  });
});

describe('subresourceUrlOverrides()', () => {
  function stamped<T extends Element>(element: T): T {
    const proto = Object.getPrototypeOf(element);
    Object.setPrototypeOf(element, Object.create(proto, subresourceUrlOverrides(proto, element.localName, () => base)));
    return element;
  }

  it('maps the property and setAttribute for subresource attributes', () => {
    const frame = stamped(document.createElement('iframe'));
    frame.src = 'silent-renew.html';
    expect(frame.getAttribute('src')).toBe('/__braid/frag/billing/billing/invoices/silent-renew.html');

    const img = stamped(document.createElement('img'));
    img.setAttribute('src', 'logo.png');
    img.srcset = 'a.png 2x';
    expect(img.getAttribute('src')).toBe('/__braid/frag/billing/billing/invoices/logo.png');
    expect(img.getAttribute('srcset')).toBe('/__braid/frag/billing/billing/invoices/a.png 2x');
  });

  it('leaves navigation targets and other attributes alone', () => {
    const anchor = stamped(document.createElement('a'));
    anchor.setAttribute('href', 'next-page');
    expect(anchor.getAttribute('href')).toBe('next-page');

    const img = stamped(document.createElement('img'));
    img.setAttribute('alt', 'logo.png');
    expect(img.getAttribute('alt')).toBe('logo.png');
  });
});
