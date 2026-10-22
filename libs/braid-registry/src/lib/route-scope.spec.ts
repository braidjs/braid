import { describe, expect, it } from 'vitest';
import { claimsWholeSite, routesMayOverlap, withinPrefixes } from './route-scope.js';

describe('route scope', () => {
  it('counts any pattern over the first segment as a claim on the whole site', () => {
    for (const pattern of ['/', '/*', '/:page', '/(.*)', '/{*}', '/{:page}', '/:a?', '/*?', '(/[^_].*)', '{(/[^_].*)}', 'not a pattern (']) {
      expect(claimsWholeSite(pattern), pattern).toBe(true);
    }
    for (const pattern of ['/billing', '/billing/*', '/billing/:id(\\d+)', '/a(.*)']) {
      expect(claimsWholeSite(pattern), pattern).toBe(false);
    }
  });

  it('keeps a route inside its prefixes however the escape is spelled', () => {
    for (const pattern of ['/billing/../login', '/billing/%2e%2E/login', '/billing{/..}/login', '/billing(/.*)?', '/billing(.*)', '/billingx', '(/billing.*)']) {
      expect(withinPrefixes(pattern, ['/billing']), pattern).toBe(false);
    }
    expect(withinPrefixes('/billing/:id', ['/billing'])).toBe(true);
  });

  it('finds overlaps that sampling misses, including the trailing-slash tolerance', () => {
    const overlapping: [string, string][] = [
      ['/billing', '/billing/'],
      ['/billing/invoices', '/billing/invoices/'],
      ['/billing/*', '/bill{ing}/:x(\\d+)'],
      ['/billing/*', '/(billing)/:x(\\d+)'],
      ['/billing/:id', '/billing/:x(\\d+)/:y?'],
      ['/billing', '/billing/*?'],
      ['/billing/42', '/billing/:id'],
    ];
    for (const [a, b] of overlapping) {
      expect(routesMayOverlap(a, b), `${a} ~ ${b}`).toBe(true);
      expect(routesMayOverlap(b, a), `${b} ~ ${a}`).toBe(true);
    }
    for (const [a, b] of [['/billing/*', '/reviews/*'], ['/blog/*', '/blogging/*'], ['/billing', '/billing/invoices'], ['/a/:id', '/b']]) {
      expect(routesMayOverlap(a!, b!), `${a} ≁ ${b}`).toBe(false);
    }
  });
});
