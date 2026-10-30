import { describe, expect, it } from 'vitest';
import { partitionCookie, type CookieAccessor } from './cookie-partition.js';

/** A stand-in for `document.cookie`: records writes, serves a fixed jar. */
function jar(contents: string): CookieAccessor & { writes: string[] } {
  const writes: string[] = [];
  return { writes, get: () => contents, set: (value) => void writes.push(value) };
}

describe('partitionCookie()', () => {
  it("reads its own cookies under their own names, plus the host's, never another partition's", () => {
    const native = jar('braid$orders$csrf=o; braid$billing$csrf=b; theme=dark; __Host-braid$orders$sid=s');
    expect(partitionCookie(native, 'orders').get()).toBe('csrf=o; theme=dark; __Host-sid=s');
    expect(partitionCookie(native, 'billing').get()).toBe('csrf=b; theme=dark');
  });

  it('writes into the partition, host-only on Path=/, keeping the other attributes', () => {
    const native = jar('');
    const cookie = partitionCookie(native, 'orders');
    cookie.set('pref=1; Path=/somewhere; Domain=example.com; Max-Age=60; SameSite=Lax');
    cookie.set('__Secure-flag=on; Secure');
    expect(native.writes).toEqual([
      'braid$orders$pref=1; Path=/; Max-Age=60; SameSite=Lax',
      '__Secure-braid$orders$flag=on; Path=/; Secure',
    ]);
  });

  it('ignores a write with no cookie name, as the browser does', () => {
    const native = jar('');
    partitionCookie(native, 'orders').set('=nameless');
    expect(native.writes).toEqual([]);
  });
});
