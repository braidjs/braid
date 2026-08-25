/**
 * @braidlabs/data — the local-first data layer.
 *
 * Persistence-first: IndexedDB is the source of truth and memory is a derived view. Every record is
 * enveloped by `@braidlabs/skew` and projected to *this* reader's version on the way out, which is
 * what lets independently deployed apps read the same store at different contract versions.
 *
 * Framework-neutral. Angular bindings live in `@braidlabs/angular-data`.
 */

export { createRecordStore } from './lib/record-store.js';
export type {
  RecordStore,
  RecordStoreOptions,
  RecordDriver,
  StoredRecord,
  ProjectedRecord,
} from './lib/record-store.js';

export { memoryRecordDriver } from './lib/memory-driver.js';
export { indexedDbRecordDriver } from './lib/indexeddb-driver.js';
export type { IndexedDbDriverOptions } from './lib/indexeddb-driver.js';

export { withLock, hasCrossContextLocks, outboxFlushLock } from './lib/locks.js';
export type { LockResult, LockOptions } from './lib/locks.js';

export { createDataClient } from './lib/query.js';
export type {
  DataClient,
  DataClientOptions,
  Query,
  QueryDefinition,
  QueryState,
  QueryStatus,
  Conflict,
  ConflictPolicy,
  MutationDefinition,
  MutationOutcome,
  MutationRegistration,
} from './lib/query.js';

export { drainOutbox } from './lib/flush.js';
export { flushOnClosing, trackDirty } from './lib/closing.js';
export type { ClosingEnv, FlushOnClosingOptions } from './lib/closing.js';
export type { DrainOptions, FlushResult, MutationRunner } from './lib/flush.js';

export { createInvalidator, sharedInvalidator, resetSharedInvalidators } from './lib/invalidation.js';
export type { Invalidator, InvalidationOptions, BroadcastChannelLike } from './lib/invalidation.js';

export { createOutbox, OutboxEntrySchema } from './lib/outbox.js';
export type { Outbox, OutboxOptions, OutboxEntry, QueuedEntry, OptimisticOverlay } from './lib/outbox.js';

export { createTenancy, partitionKey, TenancyRecordSchema } from './lib/tenancy.js';
export type { Tenancy, TenancyOptions, Principal, AdoptOptions } from './lib/tenancy.js';

export { copyPartition } from './lib/partitions.js';
export type {
  CopyPartitionOptions,
  CopyPartitionResult,
  PartitionConflictPolicy,
} from './lib/partitions.js';

export { fromPull } from './lib/adapters.js';
export type {
  PullAdapter,
  PushAdapter,
  PushConnection,
  PushRecord,
  PushSink,
  CommandAdapter,
} from './lib/adapters.js';

export { createEventBus } from './lib/events.js';
export type {
  EventBus,
  EventBusOptions,
  Channel,
  ChannelOptions,
  SubscribeOptions,
  BusEvent,
  Delivery,
} from './lib/events.js';

export { createIntentRegistry, NoIntentHandlerError } from './lib/intents.js';
export type {
  IntentRegistry,
  IntentRegistryOptions,
  IntentHandlerOptions,
  IntentCandidate,
  IntentResult,
  ResolvePolicy,
  RaiseOptions,
} from './lib/intents.js';

