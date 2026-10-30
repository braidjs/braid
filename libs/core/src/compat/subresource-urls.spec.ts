import { describe, expect, it } from 'vitest';
import { fragmentRootOf, fragmentSrcset, fragmentSubresourceUrl, subresourceUrlOverrides } from './subresource-urls.js';

const root = '/__braid/frag/billing';

describe('fragmentSubresourceUrl()', () => {
  it("resolves against the fragment's own base href, default `/`, then re-roots — the gateway's rule", () => {
    expect(fragmentSubresourceUrl('logo.png', root)).toBe('/__braid/frag/billing/logo.png');
    expect(fragmentSubresourceUrl('/assets/app.js', root)).toBe('/__braid/frag/billing/assets/app.js');
    expect(fragmentSubresourceUrl('renew.html?x=1#h', root, '/app/')).toBe('/__braid/frag/billing/app/renew.html?x=1#h');
    expect(fragmentSubresourceUrl('../up.png', root, '/app/deep/')).toBe('/__braid/frag/billing/app/up.png');
  });

  it('leaves URLs already inside the namespace alone, so reading one back and setting it again is safe', () => {
    expect(fragmentSubresourceUrl('/__braid/frag/billing/x.png', root)).toBe('/__braid/frag/billing/x.png');
    expect(fragmentSubresourceUrl('/__braid/frag/billing', root)).toBe('/__braid/frag/billing');
    // another fragment's namespace is not this one's, so it is re-rooted like any root path
    expect(fragmentSubresourceUrl('/__braid/frag/billingx/x.png', root)).toBe('/__braid/frag/billing/__braid/frag/billingx/x.png');
  });

  it('leaves absolute, protocol-relative, data, fragment-only and empty URLs alone', () => {
    for (const url of ['https://cdn.example/x.js', '//cdn.example/x.js', 'data:image/png;base64,AA', 'blob:abc', '#top', '']) {
      expect(fragmentSubresourceUrl(url, root)).toBe(url);
    }
  });

  it('maps every srcset candidate and keeps descriptors', () => {
    expect(fragmentSrcset('a.png 1x, https://cdn.example/b.png 2x', root)).toBe('/__braid/frag/billing/a.png 1x, https://cdn.example/b.png 2x');
  });
});

describe('fragmentRootOf()', () => {
  it('reads the namespace root, gateway basePath included, off the realm base', () => {
    expect(fragmentRootOf('https://shell.example/__braid/frag/billing/billing/invoices/')).toBe('/__braid/frag/billing');
    expect(fragmentRootOf('https://shell.example/portal/__braid/frag/billing/')).toBe('/portal/__braid/frag/billing');
    expect(fragmentRootOf('https://shell.example/some/page')).toBeNull();
  });
});

describe('subresourceUrlOverrides()', () => {
  const base = () => ({ root, baseHref: '/' });

  function stamped<T extends Element>(element: T): T {
    const proto = Object.getPrototypeOf(element);
    Object.setPrototypeOf(element, Object.create(proto, subresourceUrlOverrides(proto, element.localName, base)));
    return element;
  }

  it('maps the property and setAttribute for subresource attributes', () => {
    const frame = stamped(document.createElement('iframe'));
    frame.src = 'silent-renew.html';
    expect(frame.getAttribute('src')).toBe('/__braid/frag/billing/silent-renew.html');

    const img = stamped(document.createElement('img'));
    img.setAttribute('src', 'logo.png');
    img.srcset = 'a.png 2x';
    expect(img.getAttribute('src')).toBe('/__braid/frag/billing/logo.png');
    expect(img.getAttribute('srcset')).toBe('/__braid/frag/billing/a.png 2x');

    // copying an attribute it read back does not prefix it twice
    const copy = stamped(document.createElement('img'));
    copy.setAttribute('src', img.getAttribute('src')!);
    expect(copy.getAttribute('src')).toBe('/__braid/frag/billing/logo.png');
  });

  it('leaves navigation targets and other attributes alone', () => {
    const anchor = stamped(document.createElement('a'));
    anchor.setAttribute('href', 'next-page');
    expect(anchor.getAttribute('href')).toBe('next-page');

    const img = stamped(document.createElement('img'));
    img.setAttribute('alt', 'logo.png');
    expect(img.getAttribute('alt')).toBe('logo.png');
  });

  it('has no overrides for element names that collide with Object.prototype', () => {
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect(subresourceUrlOverrides(HTMLElement.prototype, name, base)).toEqual({});
    }
  });
});
