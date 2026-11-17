import {
  createClientManifest,
  manifestFingerprint,
  parseClientManifest,
} from '../index.js';
import { catalog, manifest } from './fixtures.spec-util.js';

describe('client manifest', () => {
  const options = {
    app: 'acme-shop',
    platform: 'ios',
    version: '6.2.0',
    build: 6200118,
    assets: ['jpeg', 'png', 'webp'],
    limits: { depth: 12, bytes: 262144 },
  };

  it("is built at the catalog's newest versions, and matches the conformance manifest for that app", () => {
    const built = createClientManifest(catalog(), options);
    expect(built).toEqual(manifest('current'));
    expect(manifestFingerprint(built)).toBe(
      manifestFingerprint(manifest('current')),
    );
  });

  it('has a fingerprint that ignores key order', () => {
    const original = manifest('current');
    const reversed = Object.fromEntries(
      Object.entries(original).reverse(),
    ) as typeof original;
    const shuffled = {
      ...reversed,
      components: Object.fromEntries(
        Object.entries(original.components).reverse(),
      ),
    };
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(original));
    expect(manifestFingerprint(shuffled)).toBe(manifestFingerprint(original));
    expect(manifestFingerprint(original)).toMatch(/^cm_[0-9a-f]{32}$/);
  });

  it('has a fingerprint that changes when a component version changes', () => {
    const pinned = createClientManifest(catalog(), {
      ...options,
      pin: { 'hero-banner': 2 },
    });
    expect(pinned.components['hero-banner']).toBe(2);
    expect(manifestFingerprint(pinned)).not.toBe(
      manifestFingerprint(manifest('current')),
    );
  });

  it('leaves out a component pinned to 0, and refuses pins the catalog cannot back', () => {
    expect(
      createClientManifest(catalog(), {
        ...options,
        pin: { 'video-tile': 0, share: 0 },
      }),
    ).toMatchObject({ actions: { navigate: 2, 'open-url': 1 } });
    expect(
      createClientManifest(catalog(), { ...options, pin: { 'video-tile': 0 } })
        .components,
    ).not.toHaveProperty('video-tile');
    expect(() =>
      createClientManifest(catalog(), {
        ...options,
        pin: { 'hero-banner': 4 },
      }),
    ).toThrow('covers v1 through v3');
    expect(() =>
      createClientManifest(catalog(), { ...options, pin: { carousel: 1 } }),
    ).toThrow('no component or action by that name');
  });

  it('refuses malformed manifests at the boundary', () => {
    const base = manifest('current');
    expect(() => parseClientManifest({ ...base, protocol: [2, 1] })).toThrow(
      'protocol must be [min, max]',
    );
    expect(() => parseClientManifest({ ...base, version: 'six' })).toThrow(
      'dotted numbers',
    );
    expect(() =>
      parseClientManifest({ ...base, components: { text: 0 } }),
    ).toThrow('components.text must be a positive integer');
    expect(() => parseClientManifest({ ...base, sduiManifest: '9' })).toThrow(
      'unsupported manifest format',
    );
  });
});
