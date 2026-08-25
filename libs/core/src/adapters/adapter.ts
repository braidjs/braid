import { BraidError } from '../errors.js';
import { FragmentEnv } from '../env/fragment-env.js';
import { RealmHandle, RealmKind } from '../realm/realm-manager.js';

/**
 * The adapter authoring surface: framework adapters map a `FragmentEnv` into the
 * framework's own extension points (Angular's `DOCUMENT` DI token, React's `createRoot`, …).
 * Teardown is signal-driven via `env.signal`.
 */
export interface BraidAdapter {
  mount(env: FragmentEnv, entry: unknown): Promise<void> | void;
}

/**
 * Everything the runtime hands an installed adapter to boot a fragment instance. This is the
 * internal counterpart of {@link BraidAdapter}: contract adapters only need `env` + `entry`,
 * while the compat adapter — which owns the full emulation layer — additionally drives the
 * realm and the fragment's DOM directly.
 */
export interface AdapterBootContext {
  fragmentId: string;
  /** The fragment's shadow root (owned by the <fragment-slot> element). */
  shadowRoot: ShadowRoot;
  /** The <braid-document> element acting as the fragment's virtual document element. */
  contentRoot: HTMLElement;
  /** The fragment's already-created realm. */
  realm: RealmHandle;
  /**
   * The fragment's HTML, fetched from the gateway namespace, or null when {@link pierced} —
   * a pierced fragment's content is already in `contentRoot`, put there by the parser.
   */
  html: string | null;
  /**
   * Whether the fragment's content was server-rendered into the page by the gateway. It is
   * already neutralized (scripts inert, singletons renamed) and already in the DOM; the adapter
   * activates it in place instead of building it.
   */
  pierced: boolean;
  /** The fragment's logical route URL (pathname + search). */
  routeUrl: string;
  /** Whether the fragment's navigation is bound to the host window's navigation. */
  bound: boolean;
  env: FragmentEnv;
  /**
   * The entry module, when the host supplies it directly rather than through the gateway.
   *
   * Gateway-composed fragments carry their entry on the realm stub, stamped from the manifest, and
   * an adapter reads it from `realm.adapterOptions`. A gateway-free contract fragment has no stub —
   * that is the point — so the host declares the entry in markup and it arrives here instead.
   * Adapters that need an entry should prefer this and fall back to the stub.
   */
  entry?: string;
  /** Aborts when the fragment is being torn down. */
  signal: AbortSignal;
}

/**
 * An installed adapter: which realm kind its fragments boot in, and the boot routine itself.
 */
export interface InstalledAdapter {
  readonly name: string;
  readonly realmKind: RealmKind;
  /**
   * Whether the adapter needs the fragment's *document* — the markup the gateway prepares for
   * the host's DOM. True unless stated otherwise.
   *
   * Contract adapters generally build their own UI from an entry module and never look at
   * fragment HTML. Saying so here means a fragment that serves no document (a lone custom
   * element, say) is not reported as broken for failing to serve one.
   */
  readonly needsDocument?: boolean;
  boot(ctx: AdapterBootContext): Promise<void>;
}

/**
 * The adapter every fragment runs under when its manifest does not declare one.
 *
 * This build ships only the compat adapter — the contained emulation
 * layer — and makes it the default, so legacy apps compose with zero app-code changes.
 */
export const DEFAULT_ADAPTER = 'compat';

const installedAdapters = new Map<string, InstalledAdapter>();

export function installAdapter(adapter: InstalledAdapter): void {
  installedAdapters.set(adapter.name, adapter);
}

/**
 * Resolves an adapter by its manifest-declared name, defaulting to {@link DEFAULT_ADAPTER}.
 * An unknown adapter is a named error, not a silent fallback.
 */
export function resolveAdapter(name: string | null | undefined, fragmentId: string): InstalledAdapter {
  const adapterName = name || DEFAULT_ADAPTER;
  const adapter = installedAdapters.get(adapterName);
  if (!adapter) {
    throw new BraidError(`no adapter named "${adapterName}" is installed in this client`, {
      fragmentId,
      stage: 'adapter-resolution',
      fixHint:
        adapterName === DEFAULT_ADAPTER
          ? 'call initBraid() before any <fragment-slot> connects, so the default compat adapter is installed'
          : `this build of @braidlabs/core ships only the "compat" adapter; either set "adapter": "compat" in the fragment's manifest (or omit it — compat is the default), or install a client build that provides "${adapterName}"`,
    });
  }
  return adapter;
}

/** Exposed for tests. */
export function clearInstalledAdapters(): void {
  installedAdapters.clear();
}
