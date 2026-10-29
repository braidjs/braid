import { afterEach, describe, expect, it } from 'vitest';
import { installStoragePartition, storagePartitionPrefix } from './storage-partition.js';
import { resolveStoragePartition } from '../weave/capabilities.js';

/**
 * The partition view against a real realm: a same-origin iframe running real classic scripts, so
 * bare `localStorage` resolves through the engine's global bindings exactly as fragment code does.
 * Cross-window `storage` events are a browser behaviour jsdom does not model faithfully; those are
 * covered in e2e/storage-partition.e2e.ts.
 */
describe('installStoragePartition()', () => {
  const frames: HTMLIFrameElement[] = [];

  afterEach(() => {
    frames.splice(0).forEach((frame) => frame.remove());
    localStorage.clear();
    sessionStorage.clear();
  });

  function realm(): Window & { result?: unknown } {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    frames.push(frame);
    return frame.contentWindow as Window & { result?: unknown };
  }

  function run(target: Window, source: string): void {
    const script = target.document.createElement('script');
    script.textContent = source;
    target.document.body.append(script);
  }

  it("keeps a fragment's entries under its prefix, out of the host's and other partitions' sight", () => {
    const a = realm();
    const b = realm();
    installStoragePartition(a, window, 'a');
    installStoragePartition(b, window, 'b');
    localStorage.setItem('token', 'host');

    run(a, `localStorage.setItem('token', 'from-a'); sessionStorage.setItem('tx', 'a-tx');`);
    run(b, `localStorage.setItem('token', 'from-b');`);
    run(a, `window.result = [localStorage.getItem('token'), sessionStorage.getItem('tx')];`);

    expect(a.result).toEqual(['from-a', 'a-tx']);
    expect(b.localStorage.getItem('token')).toBe('from-b');
    expect(b.sessionStorage.getItem('tx')).toBeNull();
    expect(localStorage.getItem('token')).toBe('host');
    expect(localStorage.getItem(`${storagePartitionPrefix('a')}token`)).toBe('from-a');
  });

  it('enumerates, counts and clears only its own entries', () => {
    const a = realm();
    const b = realm();
    installStoragePartition(a, window, 'a');
    installStoragePartition(b, window, 'b');
    localStorage.setItem('host-key', '1');
    b.localStorage.setItem('b-key', '1');

    run(
      a,
      `localStorage.setItem('one', '1'); localStorage.setItem('two', '2');
       window.result = { length: localStorage.length, keys: [localStorage.key(0), localStorage.key(1), localStorage.key(2)],
         own: Object.keys(localStorage).sort() };
       localStorage.clear();`,
    );

    expect(a.result).toEqual({ length: 2, keys: expect.arrayContaining(['one', 'two', null]), own: ['one', 'two'] });
    expect(a.localStorage.length).toBe(0);
    expect(localStorage.getItem('host-key')).toBe('1');
    expect(b.localStorage.getItem('b-key')).toBe('1');
  });

  it('behaves like a Storage: named properties, `in`, delete, string coercion, instanceof', () => {
    const a = realm();
    installStoragePartition(a, window, 'a');

    run(
      a,
      `localStorage.theme = 'dark';
       localStorage.setItem('count', 3);
       var before = 'theme' in localStorage;
       delete localStorage.theme;
       window.result = { before: before, after: 'theme' in localStorage, missing: localStorage.nope,
         missingItem: localStorage.getItem('nope'), count: localStorage.count, isStorage: localStorage instanceof Storage,
         method: typeof localStorage.getItem, tag: Object.prototype.toString.call(localStorage) };`,
    );

    expect(a.result).toEqual({
      before: true,
      after: false,
      missing: undefined,
      missingItem: null,
      count: '3',
      isStorage: true,
      method: 'function',
      tag: '[object Storage]',
    });
  });

  it('shares a named partition between fragments, and only between them', () => {
    const one = realm();
    const two = realm();
    const other = realm();
    installStoragePartition(one, window, 'kcd');
    installStoragePartition(two, window, 'kcd');
    installStoragePartition(other, window, 'other');

    one.localStorage.setItem('session', 'shared-login');

    expect(two.localStorage.getItem('session')).toBe('shared-login');
    expect(other.localStorage.getItem('session')).toBeNull();
  });

  it('cannot reach into another partition by naming it in a key', () => {
    const a = realm();
    installStoragePartition(a, window, 'a');
    // the prefix is encoded, so ":" in a partition name cannot forge another's boundary
    installStoragePartition(realm(), window, 'a:b');

    a.localStorage.setItem('b:key', 'x');
    expect(localStorage.getItem(`${storagePartitionPrefix('a:b')}key`)).toBeNull();
  });

  it('translates storage events: own keys unprefixed, others dropped, a foreign clear() passed on', () => {
    const a = realm();
    const partition = installStoragePartition(a, window, 'a');
    const event = (key: string | null) => new StorageEvent('storage', { key, storageArea: localStorage });

    const own = partition.adaptEvent(event(`${storagePartitionPrefix('a')}token`));
    expect(own?.key).toBe('token');
    expect(own?.storageArea).toBe(a.localStorage);
    expect(partition.adaptEvent(event(`${storagePartitionPrefix('b')}token`))).toBeNull();
    expect(partition.adaptEvent(event('token'))).toBeNull();
    expect(partition.adaptEvent(event(null))).toEqual({ key: null, storageArea: a.localStorage });
    expect(partition.adaptEvent(new StorageEvent('storage', { key: 'x', storageArea: null }))).toBeNull();
  });
});

describe('resolveStoragePartition()', () => {
  it('names the partition, or null for the shared store, and treats anything malformed as shared', () => {
    expect(resolveStoragePartition({ storage: 'partitioned' }, 'orders')).toBe('orders');
    expect(resolveStoragePartition({ storage: { partition: 'kcd' } }, 'orders')).toBe('kcd');
    expect(resolveStoragePartition({ storage: 'shared' }, 'orders')).toBeNull();
    expect(resolveStoragePartition(undefined, 'orders')).toBeNull();
    for (const typo of ['partition', { partition: '' }, { name: 'kcd' }, 1, null]) {
      expect(resolveStoragePartition({ storage: typo } as never, 'orders')).toBeNull();
    }
  });
});
