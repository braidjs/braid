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
    expect(partitionCookie(native, 'orders').get()).toBe('csrf=o; __Host-sid=s; theme=dark');
    expect(partitionCookie(native, 'billing').get()).toBe('csrf=b; theme=dark');
  });

  it('lets its own cookie win over a host cookie of the same name', () => {
    const native = jar('session=host; theme=dark; braid$orders$session=own');
    expect(partitionCookie(native, 'orders').get()).toBe('session=own; theme=dark');
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

  it('drops a write with no cookie name rather than store it unscoped', () => {
    const native = jar('');
    partitionCookie(native, 'orders').set('=nameless');
    expect(native.writes).toEqual([]);
  });
});
