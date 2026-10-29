/**
 * Per-fragment Web Storage for trusted fragments.
 *
 * A compat realm is a same-origin iframe, so its `localStorage` and `sessionStorage` *are* the
 * host's. Two fragments whose libraries keep state under the same fixed key — an OIDC client's
 * `okta-token-storage`, a PKCE transaction — overwrite each other, and the `storage` events those
 * writes raise reach every other realm on the page, where a sync listener dutifully copies the
 * wrong value back. A partition gives the fragment a view over the native store in which every key
 * it sees is its own, and events for anyone else's keys never arrive.
 *
 * It is an accident barrier, not a security boundary: same-origin code can still reach
 * `top.localStorage`. See docs/braid-boundary.md.
 *
 * Storage keys are prefixed `braid:storage:<partition>:`. A partition is the fragment's id by
 * default (`storage: 'partitioned'`), or a name several fragments share
 * (`storage: { partition: 'kcd' }`), which is how two fragments using one issuer keep one login.
 */

const PREFIX = 'braid:storage:';

/** The native-store key prefix for a partition. Encoded so a name can never reach into another's. */
export function storagePartitionPrefix(partition: string): string {
  return `${PREFIX}${encodeURIComponent(partition)}:`;
}

type StorageName = 'localStorage' | 'sessionStorage';

/**
 * A `Storage` that reads and writes only the keys under `prefix`, with the prefix out of sight.
 *
 * A Proxy rather than a subclass, because `Storage` exposes its entries as named properties —
 * `localStorage.token = 'x'`, `Object.keys(localStorage)` — and only a Proxy can answer those.
 */
export function createStorageView(
  native: Storage,
  prefix: string,
  storagePrototype: object,
  /** Told of every write that changes the store, which is every write that raises a `storage` event. */
  onChange: (nativeKey: string, newValue: string | null) => void = () => undefined,
): Storage {
  const ownKeys = (): string[] => {
    const keys: string[] = [];
    for (let i = 0; i < native.length; i++) {
      const key = native.key(i);
      if (key !== null && key.startsWith(prefix)) keys.push(key.slice(prefix.length));
    }
    return keys;
  };

  const set = (nativeKey: string, value: string): void => {
    const changed = native.getItem(nativeKey) !== value;
    native.setItem(nativeKey, value);
    if (changed) onChange(nativeKey, value);
  };
  const remove = (nativeKey: string): void => {
    const existed = native.getItem(nativeKey) !== null;
    native.removeItem(nativeKey);
    if (existed) onChange(nativeKey, null);
  };

  const methods = {
    getItem: (key: string): string | null => native.getItem(prefix + String(key)),
    setItem: (key: string, value: string): void => set(prefix + String(key), String(value)),
    removeItem: (key: string): void => remove(prefix + String(key)),
    // removes this partition's entries one by one, so other partitions and the host keep theirs
    clear: (): void => ownKeys().forEach((key) => remove(prefix + key)),
    key: (index: number): string | null => ownKeys()[Math.trunc(Number(index))] ?? null,
  };

  const isMember = (property: PropertyKey): boolean =>
    typeof property === 'symbol' || property in methods || property === 'length' || property in storagePrototype;

  return new Proxy(Object.create(storagePrototype) as Storage, {
    get(_target, property) {
      if (property === 'length') return ownKeys().length;
      if (typeof property === 'string' && property in methods) return methods[property as keyof typeof methods];
      if (isMember(property)) return Reflect.get(storagePrototype, property);
      // a named property: the entry, or undefined (not null) like a native Storage
      return native.getItem(prefix + String(property)) ?? undefined;
    },
    // as natively: assigning any string property stores an entry (WebIDL's named setter wins on
    // [[Set]]), while reading a member name still finds the member
    set(_target, property, value) {
      if (typeof property === 'symbol') return false;
      methods.setItem(property, value);
      return true;
    },
    has(_target, property) {
      if (isMember(property)) return true;
      return native.getItem(prefix + String(property)) !== null;
    },
    deleteProperty(_target, property) {
      if (typeof property === 'string') methods.removeItem(property);
      return true;
    },
    ownKeys() {
      return ownKeys();
    },
    getOwnPropertyDescriptor(_target, property) {
      if (isMember(property)) return undefined;
      const value = native.getItem(prefix + String(property));
      return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
    },
    defineProperty() {
      return false;
    },
  });
}

/** What a `storage` event looks like from inside the partition, or `null` if it is not its event. */
export interface PartitionedStorageEvent {
  key: string | null;
  storageArea: Storage;
}

export interface StoragePartition {
  /** Translates a `storage` event raised on the host window into the partition's terms. */
  adaptEvent(event: StorageEvent): PartitionedStorageEvent | null;
}

/** Finds the getter for a storage attribute wherever the engine defines it (instance or prototype). */
function nativeStorageGetter(target: Window, name: StorageName): () => Storage {
  for (let object: object | null = target; object; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor?.get) return descriptor.get.bind(target) as () => Storage;
    if (descriptor) return () => descriptor.value as Storage;
  }
  throw new Error(`braid: this browser has no ${name}`);
}

/**
 * Replaces the realm window's `localStorage` and `sessionStorage` with views on `partition`.
 *
 * Must run before any fragment script, which the compat boot guarantees: the realm stub has no
 * scripts of its own, and the fragment's are activated only after the patches are in place.
 * Reaching for a store that the browser refuses (some privacy modes throw) throws, as natively.
 */
export function installStoragePartition(
  realmWindow: Window,
  mainWindow: Window,
  partition: string,
  signal?: AbortSignal,
): StoragePartition {
  const prefix = storagePartitionPrefix(partition);
  const storagePrototype = (realmWindow as unknown as { Storage: { prototype: object } }).Storage.prototype;
  const views = new Map<StorageName, Storage>();
  // captured before the accessors below replace them, or the view would find itself
  const native = {
    localStorage: nativeStorageGetter(realmWindow, 'localStorage'),
    sessionStorage: nativeStorageGetter(realmWindow, 'sessionStorage'),
  };

  /**
   * A window never hears its own writes, but a realm listens on the host window, where its writes
   * do raise events. Each write this realm makes is recorded, and the host event it raises is
   * marked an echo — by a listener registered here, before any fragment code can add its own, so
   * it always sees the event first.
   */
  const pending = new Map<string, number>();
  const echoes = new WeakSet<Event>();
  const writeId = (area: StorageName, nativeKey: string, newValue: string | null) =>
    `${area}\u0000${nativeKey}\u0000${newValue === null ? '\u0001' : newValue}`;

  const view = (name: StorageName): Storage => {
    let existing = views.get(name);
    if (!existing) {
      existing = createStorageView(native[name](), prefix, storagePrototype, (nativeKey, newValue) => {
        const id = writeId(name, nativeKey, newValue);
        pending.set(id, (pending.get(id) ?? 0) + 1);
      });
      views.set(name, existing);
    }
    return existing;
  };

  for (const name of ['localStorage', 'sessionStorage'] as const) {
    // the native attributes are enumerable, configurable getters with no setter; so are these
    Object.defineProperty(realmWindow, name, { get: () => view(name), set: undefined, configurable: true, enumerable: true });
  }

  const hostArea = (name: StorageName): Storage | null => {
    try {
      return nativeStorageGetter(mainWindow, name)();
    } catch {
      return null;
    }
  };

  const areaOf = (event: StorageEvent): StorageName | null => {
    const area = event.storageArea;
    if (!area) return null;
    return area === hostArea('sessionStorage') ? 'sessionStorage' : area === hostArea('localStorage') ? 'localStorage' : null;
  };

  mainWindow.addEventListener(
    'storage',
    (event) => {
      const name = areaOf(event);
      if (!name || event.key === null) return;
      const id = writeId(name, event.key, event.newValue);
      const count = pending.get(id);
      if (!count) return;
      if (count === 1) pending.delete(id);
      else pending.set(id, count - 1);
      echoes.add(event);
    },
    signal ? { signal } : {},
  );

  return {
    adaptEvent(event) {
      const name = areaOf(event);
      if (!name || echoes.has(event)) return null;
      // a `clear()` outside the partition wiped this partition's entries too, so it is news here
      if (event.key === null) return { key: null, storageArea: view(name) };
      if (!event.key.startsWith(prefix)) return null;
      return { key: event.key.slice(prefix.length), storageArea: view(name) };
    },
  };
}
