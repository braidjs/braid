import type { FragmentManifest } from '@braidlabs/gateway';
import type { ShellManifest } from './shell.js';

/**
 * A registry snapshot: an immutable, content-addressed set of fragment manifests.
 *
 * Immutability is the whole design. Because a snapshot id names one byte-identical document
 * forever, everything else falls out of it:
 *
 * - **Caching** is unconditional — an id can never mean something different later.
 * - **Rollback** is a pointer move: re-pin the previous id. There is no undo log and no inverse
 *   migration, because nothing was mutated.
 * - **Promotion** is a pointer move, and production pins the *byte-identical* artifact staging
 *   tested — not a re-render of the same intent.
 * - **A store outage stops you changing config, not serving it**, since the pinned snapshot has
 *   already been resolved.
 *
 * The id is a hash of the canonical serialization, so two independently produced snapshots with
 * the same manifests are the same snapshot. That is a feature: publishing an unchanged registry
 * is a no-op rather than a new artifact to reason about.
 */
export interface RegistrySnapshot {
  /** Content address — `reg_` followed by the first 32 hex chars of the SHA-256. */
  readonly id: string;
  /** When this content was first published, ISO 8601. Not part of the content address. */
  readonly createdAt: string;
  readonly manifests: readonly FragmentManifest[];
  /**
   * The shells these fragments compose into, sorted by id. Absent when there are none, which keeps
   * a snapshot without shells byte-identical — and identically addressed — to one minted before
   * shells existed.
   */
  readonly shells?: readonly ShellManifest[];
  /**
   * Free-form attribution: who published, why, which ticket. Not part of the content address —
   * two publishes of identical manifests are the same snapshot regardless of who did it.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

/** A snapshot without its content-derived fields, as handed to {@link createSnapshot}. */
export interface SnapshotInput {
  manifests: readonly FragmentManifest[];
  shells?: readonly ShellManifest[];
  createdAt?: string;
  labels?: Record<string, string>;
}

export const SNAPSHOT_ID_PREFIX = 'reg_';

/**
 * Mints a snapshot from a set of manifests, deriving its content address.
 *
 * `createdAt` and `labels` are deliberately excluded from the hash: they describe the *act* of
 * publishing, not the configuration being published. Including them would mean republishing an
 * unchanged registry produced a new id, which would defeat "the same id is the same config".
 */
export async function createSnapshot(input: SnapshotInput): Promise<RegistrySnapshot> {
  const manifests = [...input.manifests].sort((a, b) => compareIds(a.id, b.id));
  const shells = [...(input.shells ?? [])].sort((a, b) => compareIds(a.id, b.id));
  const id = await contentAddress(manifests, shells);

  return {
    id,
    createdAt: input.createdAt ?? new Date().toISOString(),
    manifests,
    ...(shells.length > 0 ? { shells } : {}),
    ...(input.labels ? { labels: { ...input.labels } } : {}),
  };
}

/**
 * Recomputes a snapshot's content address and compares it to the id it carries.
 *
 * Worth calling after any transport that could have altered the payload. A snapshot whose id does
 * not match its content is not a stale snapshot — it is a corrupt or tampered one, and serving it
 * would silently change which fragments compose which pages.
 */
export async function verifySnapshot(snapshot: RegistrySnapshot): Promise<boolean> {
  return (await contentAddress(snapshot.manifests, snapshot.shells ?? [])) === snapshot.id;
}

/**
 * Serializes a snapshot for storage or transport.
 *
 * Canonical: object keys are emitted in sorted order at every depth, so the bytes depend only on
 * the content and not on the order a producer happened to build its objects in. Anything less
 * would make the content address unstable across runtimes and JSON round trips.
 */
export function serializeSnapshot(snapshot: RegistrySnapshot): string {
  return canonicalJson(snapshot);
}

export function parseSnapshot(json: string): RegistrySnapshot {
  const value = JSON.parse(json) as Partial<RegistrySnapshot>;
  if (typeof value?.id !== 'string' || !Array.isArray(value.manifests)) {
    throw new Error('braid-registry: not a registry snapshot — expected { id, manifests }');
  }
  if (value.shells !== undefined && !Array.isArray(value.shells)) {
    throw new Error('braid-registry: not a registry snapshot — shells must be an array');
  }
  return value as RegistrySnapshot;
}

/**
 * The hash input. Without shells it is the manifests array alone — exactly what every snapshot
 * minted before shells hashed — so adding the field changed no existing id. With shells it is an
 * object, which no manifests-only input can collide with.
 */
async function contentAddress(manifests: readonly FragmentManifest[], shells: readonly ShellManifest[]): Promise<string> {
  const content = shells.length > 0 ? { manifests, shells } : manifests;
  const bytes = new TextEncoder().encode(canonicalJson(content));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${SNAPSHOT_ID_PREFIX}${hex.slice(0, 32)}`;
}

/**
 * JSON with deterministic key order.
 *
 * `undefined` members are dropped exactly as `JSON.stringify` drops them, so a manifest that omits
 * a field and one that sets it to `undefined` address identically — which is what a reader of the
 * two would experience.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);

  return `{${entries.join(',')}}`;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
