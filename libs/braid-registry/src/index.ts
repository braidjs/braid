/**
 * @braidlabs/registry — immutable snapshots of a Braid fragment registry, and analysis over
 * them.
 *
 * ```ts
 * import { createSnapshot, memorySnapshotStore, snapshotRegistry } from '@braidlabs/registry';
 *
 * const snapshot = await createSnapshot({ manifests });
 * await store.put(snapshot);
 *
 * createGateway({ registry: snapshotRegistry({ store, pinned: snapshot.id }) });
 * ```
 *
 * Everything exported here is platform-neutral — it runs on Node, Workers, Deno, Bun, and in a
 * browser. The filesystem store lives at `@braidlabs/registry/node`.
 */

export { createSnapshot, verifySnapshot, serializeSnapshot, parseSnapshot, SNAPSHOT_ID_PREFIX } from './lib/snapshot.js';
export type { RegistrySnapshot, SnapshotInput } from './lib/snapshot.js';

export { memorySnapshotStore, toRef } from './lib/store.js';
export type { SnapshotStore, SnapshotRef } from './lib/store.js';

export { snapshotRegistry } from './lib/source.js';
export type { SnapshotRegistryOptions, SnapshotDiagnostic } from './lib/source.js';

export { validateRegistry, findPierceOverlaps, diffRegistries, fieldOwner } from './lib/analysis.js';

export { subgraph, supergraph } from './lib/supergraph.js';
export type { SubgraphOptions, SubgraphSource } from './lib/supergraph.js';

export { parseAreas, formatAreas, validateShells, isSafeAssetUrl, isSafeTrackList, SHELL_FRAMEWORKS } from './lib/shell.js';
export type {
  ShellManifest,
  ShellFramework,
  ShellRoute,
  ShellLayout,
  ShellHead,
  ShellMeta,
  ShellScript,
  ShellStylesheet,
  GridArea,
  ParsedAreas,
} from './lib/shell.js';

export { fetchDescriptors, mergeDescriptors, DEFAULT_DESCRIPTOR_PATH } from './lib/descriptor.js';
export type {
  FragmentDescriptor,
  DescriptorNote,
  DescriptorNoteKind,
  DescriptorMergeResult,
  FetchDescriptorsOptions,
} from './lib/descriptor.js';

export {
  createRoutingObservations,
  serializeObservations,
  parseObservations,
} from './lib/observations.js';
export type {
  RoutingObservations,
  RoutingObservationsOptions,
  ObservationSet,
  PathObservation,
} from './lib/observations.js';

export { routingImpact } from './lib/routing-impact.js';
export type { RoutingImpact, PathImpact, FragmentImpact } from './lib/routing-impact.js';

export { accessMatrix, parsePrincipal, ANONYMOUS } from './lib/access-matrix.js';
export type {
  AccessMatrix,
  AccessRow,
  AccessCell,
  AccessOutcome,
  AccessAction,
  AccessTransition,
  NamedPrincipal,
} from './lib/access-matrix.js';

export { createRegistryApi } from './lib/api.js';
export { jsonLinesAuditSink, webhookAuditSink } from './lib/audit.js';
export type { AuditEvent, AuditAction, AuditSink, WebhookAuditSink, WebhookAuditSinkOptions } from './lib/audit.js';
export type {
  RegistryApi,
  RegistryApiOptions,
  PublishRequestBody,
  PublishResult,
  RegistryAction,
  AuthorizeResult,
  RegistryPermissions,
} from './lib/api.js';
export type {
  RegistryFinding,
  FindingCode,
  FindingSeverity,
  RegistryDiff,
  FieldChange,
  FieldOwner,
} from './lib/analysis.js';
