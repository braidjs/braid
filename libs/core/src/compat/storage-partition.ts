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

/** The realm's own `Storage` operations, captured before {@link patchStoragePrototype} wraps them. */
interface StorageOps {
  getItem(store: Storage, key: string): string | null;
  setItem(store: Storage, key: string, value: string): void;
  removeItem(store: Storage, key: string): void;
  key(store: Storage, index: number): string | null;
  length(store: Storage): number;
}

/** What a view does for each `Storage` member, with `this` already resolved to the view. */
interface ViewMembers {
  getItem(...args: unknown[]): string | null;
  setItem(...args: unknown[]): void;
  removeItem(...args: unknown[]): void;
  clear(): void;
  key(...args: unknown[]): string | null;
  length(): number;
}

const METHODS = ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const;
/** The argument counts `Storage`'s methods require, for the TypeError a native call throws. */
const ARITY: Record<(typeof METHODS)[number], number> = { getItem: 1, setItem: 2, removeItem: 1, clear: 0, key: 1 };
const patched = new WeakMap<object, { ops: StorageOps; views: WeakMap<object, ViewMembers> }>();

function requireArguments(method: keyof typeof ARITY, args: unknown[]): void {
  if (args.length < ARITY[method]) {
    throw new TypeError(
      `Failed to execute '${method}' on 'Storage': ${ARITY[method]} argument${ARITY[method] > 1 ? 's' : ''} required, but only ${args.length} present.`,
    );
  }
}

/**
 * Makes the realm's own `Storage.prototype` answer for views, once per realm.
 *
 * A view is a Proxy, not a platform object, so the native methods would refuse it
 * (`Storage.prototype.getItem.call(localStorage, k)` is an "Illegal invocation"). Wrapping them —
 * the realm's copy only; the host's `Storage` is never touched — lets every route to a method work:
 * `localStorage.getItem(k)`, `.call(localStorage, …)`, and a library that monkey-patches
 * `Storage.prototype.setItem` sees the fragment's own key names. The views themselves call the
 * captured originals, so such a patch runs once per call, as it would natively.
 */
function patchStoragePrototype(storagePrototype: object): { ops: StorageOps; views: WeakMap<object, ViewMembers> } {
  const existing = patched.get(storagePrototype);
  if (existing) return existing;

  const descriptor = (name: string) => Object.getOwnPropertyDescriptor(storagePrototype, name);
  const original = Object.fromEntries(METHODS.map((name) => [name, descriptor(name)!.value])) as Record<
    (typeof METHODS)[number],
    (...args: unknown[]) => unknown
  >;
  const originalLength = descriptor('length')!.get!;
  const ops: StorageOps = {
    getItem: (store, key) => original.getItem.call(store, key) as string | null,
    setItem: (store, key, value) => void original.setItem.call(store, key, value),
    removeItem: (store, key) => void original.removeItem.call(store, key),
    key: (store, index) => original.key.call(store, index) as string | null,
    length: (store) => originalLength.call(store) as number,
  };
  const views = new WeakMap<object, ViewMembers>();

  for (const name of METHODS) {
    // a method definition, so the wrapper keeps the native's name and is not a constructor
    const wrapper = {
      [name](this: unknown, ...args: unknown[]) {
        const view = typeof this === 'object' && this !== null ? views.get(this) : undefined;
        return view ? (view[name] as (...a: unknown[]) => unknown)(...args) : original[name].apply(this, args);
      },
    }[name];
    Object.defineProperty(storagePrototype, name, { ...descriptor(name), value: wrapper });
  }
  Object.defineProperty(storagePrototype, 'length', {
    ...descriptor('length'),
    get(this: unknown) {
      const view = typeof this === 'object' && this !== null ? views.get(this) : undefined;
      return view ? view.length() : originalLength.call(this);
    },
  });

  const record = { ops, views };
  patched.set(storagePrototype, record);
  return record;
}

/**
 * A `Storage` that reads and writes only the keys under `prefix`, with the prefix out of sight.
 *
 * A Proxy rather than a subclass, because `Storage` exposes its entries as named properties —
 * `localStorage.token = 'x'`, `Object.keys(localStorage)` — and only a Proxy can answer those.
 * Members (`getItem`, `length`…) come from the realm's own `Storage.prototype`, patched to route a
 * view to its own entries.
 */
export function createStorageView(
  native: Storage,
  prefix: string,
  storagePrototype: object,
  /** Told of every write that changes the store, which is every write that raises a `storage` event. */
  onChange: (nativeKey: string, newValue: string | null) => void = () => undefined,
): Storage {
  const { ops, views } = patchStoragePrototype(storagePrototype);

  /**
   * The partition's keys, scanned once and kept until the next microtask: a loop over `key(i)` up
   * to `length` would otherwise rescan the whole origin store at every step. Nothing can change the
   * store inside one synchronous run except this view, whose writes drop the cache.
   */
  let cachedKeys: string[] | null = null;
  const ownKeys = (): string[] => {
    if (!cachedKeys) {
      const keys: string[] = [];
      const total = ops.length(native);
      for (let i = 0; i < total; i++) {
        const key = ops.key(native, i);
        if (key !== null && key.startsWith(prefix)) keys.push(key.slice(prefix.length));
      }
      cachedKeys = keys;
      queueMicrotask(() => {
        cachedKeys = null;
      });
    }
    return cachedKeys;
  };

  const set = (nativeKey: string, value: string): void => {
    const changed = ops.getItem(native, nativeKey) !== value;
    ops.setItem(native, nativeKey, value);
    cachedKeys = null;
    if (changed) onChange(nativeKey, value);
  };
  const remove = (nativeKey: string): void => {
    const existed = ops.getItem(native, nativeKey) !== null;
    ops.removeItem(native, nativeKey);
    cachedKeys = null;
    if (existed) onChange(nativeKey, null);
  };

  const members: ViewMembers = {
    getItem: (...args) => (requireArguments('getItem', args), ops.getItem(native, prefix + String(args[0]))),
    setItem: (...args) => (requireArguments('setItem', args), set(prefix + String(args[0]), String(args[1]))),
    removeItem: (...args) => (requireArguments('removeItem', args), remove(prefix + String(args[0]))),
    // removes this partition's entries one by one, so other partitions and the host keep theirs
    clear: () => [...ownKeys()].forEach((key) => remove(prefix + key)),
    // WebIDL `unsigned long`: NaN and undefined are 0, negatives wrap past the end
    key: (...args) => (requireArguments('key', args), ownKeys()[Number(args[0]) >>> 0] ?? null),
    length: () => ownKeys().length,
  };

  const isMember = (property: PropertyKey): boolean => property in storagePrototype;
  const entry = (property: string): string | null => ops.getItem(native, prefix + property);

  const view = new Proxy(Object.create(storagePrototype) as Storage, {
    get(target, property, receiver) {
      if (typeof property === 'symbol') return Reflect.get(target, property, receiver);
      if (isMember(property)) return Reflect.get(storagePrototype, property, receiver);
      // a named property: the entry, or undefined (not null) like a native Storage
      return entry(property) ?? undefined;
    },
    // as natively: assigning any string property stores an entry (WebIDL's named setter wins on
    // [[Set]]), while reading a member name still finds the member
    set(target, property, value) {
      if (typeof property === 'symbol') return Reflect.set(target, property, value);
      set(prefix + property, String(value));
      return true;
    },
    has(target, property) {
      if (typeof property === 'symbol') return Reflect.has(target, property);
      return isMember(property) || entry(property) !== null;
    },
    deleteProperty(target, property) {
      if (typeof property === 'symbol') return Reflect.deleteProperty(target, property);
      remove(prefix + property);
      return true;
    },
    ownKeys(target) {
      return [...ownKeys(), ...Object.getOwnPropertySymbols(target)];
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property === 'symbol') return Reflect.getOwnPropertyDescriptor(target, property);
      if (isMember(property)) return undefined;
      const value = entry(property);
      return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
    },
    defineProperty(target, property, descriptor) {
      if (typeof property === 'symbol') return Reflect.defineProperty(target, property, descriptor);
      // natively a data descriptor stores its value as an entry
      if (!('value' in descriptor)) return false;
      set(prefix + property, String(descriptor.value));
      return true;
    },
  });

  views.set(view, members);
  return view;
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
  const pending = new Map<string, number[]>();
  const echoes = new WeakSet<Event>();
  const writeId = (area: StorageName, nativeKey: string, newValue: string | null) => JSON.stringify([area, nativeKey, newValue]);
  /** An echo arrives within a task or two; one that never comes must not swallow a later event. */
  const ECHO_WINDOW_MS = 2_000;

  const view = (name: StorageName): Storage => {
    let existing = views.get(name);
    if (!existing) {
      existing = createStorageView(native[name](), prefix, storagePrototype, (nativeKey, newValue) => {
        const id = writeId(name, nativeKey, newValue);
        pending.set(id, [...(pending.get(id) ?? []), Date.now() + ECHO_WINDOW_MS]);
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
      const now = Date.now();
      const live = (pending.get(id) ?? []).filter((expires) => expires > now);
      if (live.length === 0) {
        pending.delete(id);
        return;
      }
      live.shift();
      if (live.length > 0) pending.set(id, live);
      else pending.delete(id);
      echoes.add(event);
    },
    // capture, so it runs before any listener a fragment adds, in either phase
    signal ? { capture: true, signal } : { capture: true },
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
