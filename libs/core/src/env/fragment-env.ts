import type { CloseReason, CloseSummary } from '../weave/closing.js';

/**
 * `FragmentEnv` — the contract object graph a fragment sees instead of patched globals.
 *
 * Contract-mode fragments receive this env through their adapter's `mount(env, entry)` call and
 * never touch realm globals. Compat-mode fragments (the only adapter shipped in this build) do
 * not consume the env — the compat adapter installs the full document/window illusion instead —
 * but the contract is defined here because it is the heart of the project and the adapter
 * interface is written against it.
 *
 * Design rules: every member is a real object with a stable identity (no getters that change
 * shape), every mutation path is explicit, and nothing on `FragmentEnv` requires the realm.
 */

export interface EnvDocument {
  /** Sets or reads the fragment's logical document title. Bound fragments propagate it to the host. */
  title: string;
  /** Appends a stylesheet or other head-scoped element to the fragment's head region. */
  appendToHead(element: HTMLElement): void;
  readonly activeElement: Element | null;
  readonly adoptedStyleSheets: CSSStyleSheet[];
}

export interface EnvLocation {
  readonly href: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  /** The base path the fragment is mounted under; adapters feed this into router configuration. */
  readonly basePath: string;
}

export interface EnvHistory {
  push(url: string, state?: unknown): void;
  replace(url: string, state?: unknown): void;
  back(): void;
  /** Subscribes to location changes; automatically unsubscribed when `env.signal` aborts. */
  onChange(listener: (location: EnvLocation) => void): () => void;
}

export interface EnvContext {
  get(key: string): unknown;
  subscribe(key: string, listener: (value: unknown) => void, options?: { signal?: AbortSignal }): () => void;
}

export interface FragmentEnv {
  readonly contractVersion: '1.0';
  /** Mount point inside the fragment's shadow root. */
  readonly root: HTMLElement;
  readonly document: EnvDocument;
  readonly location: EnvLocation;
  readonly history: EnvHistory;
  readonly context: EnvContext;
  readonly props: Readonly<Record<string, unknown>>;
  onPropsChanged(listener: (props: Readonly<Record<string, unknown>>) => void): () => void;
  /** Fragment → host event channel, surfaced as `braid:event` on the slot element. */
  emit(type: string, detail?: unknown): void;
  /**
   * Registers work to run *before* `signal` aborts: flush an outbox, persist a draft, release a
   * lock. Return `{ flushed, dropped }` to report what happened; the host aggregates across
   * handlers and surfaces the totals.
   *
   * Bounded by the host's close deadline. A handler that has not settled by then does not stop the
   * teardown — it is reported as unconfirmed, because a page the user is trying to leave must be
   * able to leave.
   */
  onClosing(handler: (reason: CloseReason) => void | Partial<CloseSummary> | Promise<void | Partial<CloseSummary>>): () => void;
  /**
   * Declares that the fragment holds unsaved work, or clears the declaration with `null`.
   *
   * Pushed as it changes rather than asked for at close time, so a host can answer "will this lose
   * data?" synchronously — which is the only way to answer it inside a `beforeunload` handler.
   * Braid never installs that handler itself; the host opts in via `slot.dirty`.
   */
  setDirty(reason: string | null): void;
  /** Fires on unmount, after every `onClosing` handler has settled or the deadline has passed. */
  readonly signal: AbortSignal;
}
