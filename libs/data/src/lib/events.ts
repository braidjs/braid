import type { VersionedSchema } from '@braidlabs/skew';
import { drainOutbox, type FlushResult } from './flush.js';
import { sharedInvalidator, type BroadcastChannelLike, type Invalidator } from './invalidation.js';
import { createOutbox, type Outbox } from './outbox.js';
import { storageKey, type RecordDriver } from './record-store.js';
import type { Conflict, ConflictPolicy } from './query.js';
import {
  createIntentRegistry,
  NoIntentHandlerError,
  type IntentCandidate,
  type IntentHandlerOptions,
  type IntentRegistry,
  type IntentResult,
  type LocalIntentHandler,
  type RaiseOptions,
  type RemoteIntentHandler,
} from './intents.js';

/**
 * Eventing across independently deployed applications: channels, durable queues, and conflict.
 *
 * This lives in `@braidlabs/data` rather than in Braid because none of it is about composition — it is
 * about a queue, a lock, and a versioned payload, which is what this package already is. A Module
 * Federation deployment with no Braid at all should be able to use it, and Braid's context bus should
 * be able to sit on top rather than beside it.
 *
 * **Almost nothing here is new.** Durability is the outbox, one record per entry. Draining is
 * `drainOutbox`, with its ordering, its cross-context lock, and its give-up rule. Waking another
 * realm is the invalidator. Surviving version skew is `versioned()`. The parts that are genuinely
 * new are the two decisions below.
 *
 * **1. State is not an event.** FDC3 conflates them: `broadcast` sets a channel's current context
 * *and* replays it to late joiners, so it means both "this happened" and "this is now true". That
 * works for a selected row and fails for anything with a verb. Here `broadcast`/`state` is the
 * former and `emit`/`addEventListener` is the latter.
 *
 * **2. Durable fan-out is one queue per consumer, not one queue with acknowledgements.** An
 * at-least-once event is written once per registered consumer, into that consumer's own queue, and
 * *deletion on success is the acknowledgement*. It costs N copies of the payload and buys three
 * things: no new storage shape, no ack bookkeeping to keep consistent, and — the one that matters —
 * a consumer whose handler keeps failing blocks only itself. A shared entry with an ack set gives
 * every consumer the same head-of-line blocking.
 */

export type Delivery = 'at-most-once' | 'at-least-once';

export interface BusEvent<T = unknown> {
  /** Stable per emit, so an at-least-once consumer can dedupe if it must. */
  eventId: string;
  channel: string;
  type: string;
  payload: T;
  /** ISO 8601. Used for the retention window. */
  at: string;
  /** Which application emitted it. */
  source: string;
}

export interface EventBusOptions {
  /**
   * This application's identity, as the outbox's `owner` is. Durable delivery is addressed to it,
   * and two applications sharing one name will replay each other's events.
   */
  consumer: string;
  /** Tenant partition. Events are scoped like every other record. */
  partition?: () => string;
  /** Storage for durable channels. Without it, `at-least-once` is refused rather than downgraded. */
  driver?: RecordDriver;
  /**
   * Every application that may consume a durable event on this origin.
   *
   * Fan-out writes one entry per name, so a queue cannot wait for an acknowledgement from a consumer
   * it does not know exists. In a Braid deployment this comes from the manifests; anywhere else it is
   * a list. A registered consumer that is not currently mounted is *waiting*, not gone.
   */
  consumers?: readonly string[];
  /** Cross-context wake-up and page-scoped fan-out. Defaults to the shared one for the partition. */
  invalidator?: Invalidator;
  /** The transport between contexts. Injectable for tests; defaults to a `BroadcastChannel`. */
  broadcastChannel?: (name: string) => BroadcastChannelLike | undefined;
  /**
   * Which page this bus is on, for `scope: 'page'` channels: buses that name the same page share
   * them, and a bus on another page — another tab — does not.
   *
   * In a browser it defaults to the top-level document, which every Braid realm on the page shares
   * and no other tab does: each fragment's realm is its own JavaScript context, as isolated from
   * the others in memory as a tab is, so without a transport a page-scoped channel would reach no
   * further than the bus that wrote to it. Outside a browser there is no page, and a page-scoped
   * channel stays within this bus unless one is named here.
   */
  page?: string;
  /**
   * How long a raised intent waits for a handler in another context to answer before it fails.
   * Defaults to 30 seconds. A context that closes answers its pending calls at once.
   */
  intentTimeoutMs?: number;
  /** Attempts before a queued event is abandoned. */
  maxAttempts?: number;
  /** Never silent: retention drops and abandoned handlers are reported here. */
  onEventError?: (message: string, detail?: unknown) => void;
}

export interface ChannelOptions {
  /**
   * `'page'` reaches every realm on this page; `'origin'` reaches every tab as well.
   *
   * Per channel rather than per bus, because the answer differs by channel on the same page: a
   * selected row is page state, a sign-out is origin-wide. One global setting is how a UI selection
   * ends up broadcast to five tabs.
   */
  scope?: 'page' | 'origin';
  /** What to do when two publishers disagree about this channel's state. Defaults to `'raise'`. */
  onConflict?: ConflictPolicy<unknown>;
  /** How long a queued event stays deliverable. Defaults to one hour. */
  ttlMs?: number;
  /** Queue depth per consumer *on this channel*, after which the oldest is dropped loudly. Defaults to 500. */
  maxDepth?: number;
  /**
   * Instances this channel per entity: a fund, a tenant, a portfolio, a conversation.
   *
   * `channel('selection', { entity: 'fund:f1' })` and `channel('selection', { entity: 'fund:f2' })`
   * are two separate contexts that happen to share a shape. State does not cross between them,
   * events are addressed to one of them, and an origin-scoped pair gets a transport each.
   *
   * **Deliberately not a `scope` value.** Reach and instance are different questions and a channel
   * has to answer both: this fund's selection is page state, while this fund's orders want to reach
   * every tab. Folding entity into `scope` would force one answer for both.
   *
   * Not a security boundary — that is what a partition is. Two entities in one partition are
   * separated here for correctness and clarity, not for isolation; a different *tenant* belongs in a
   * different partition, and then none of this applies because the storage differs too.
   */
  entity?: string;
  /**
   * Keep this channel's state across reloads, in the bus's `driver`: the last value this context
   * broadcast is stored, and a bus that opens the channel later — after a reload, with no other
   * context alive to ask — starts from it. Stored per partition, as a versioned envelope when a
   * contract is registered for the channel, so a newer or older build reads it at its own version.
   *
   * A stored value is a fallback, not the truth: a value broadcast since, or a fresher one another
   * context holds, wins over it. Needs a `driver`, and is refused without one rather than quietly
   * not persisting.
   */
  persist?: boolean;
}

export interface SubscribeOptions {
  /** The contract version this subscriber speaks. Projected per subscriber, as the context bus does. */
  as?: number;
  signal?: AbortSignal;
  consumer?: string;
}

export interface Channel<S = unknown> {
  readonly name: string;
  /** Sets this channel's current state. Last value wins; late subscribers receive it. */
  broadcast(value: S): void;
  /** The current state, projected to `as`. */
  state(options?: { as?: number }): S | undefined;
  /** Subscribes to state. Called immediately with the current value when there is one. */
  subscribe(listener: (value: S) => void, options?: SubscribeOptions): () => void;
  /** Publishes an occurrence. Not replayed unless it is durable and unacknowledged. */
  emit<T>(type: string, payload: T, options?: { delivery?: Delivery }): Promise<void>;
  /** Handles occurrences of one type. */
  addEventListener<T>(
    type: string,
    handler: (event: BusEvent<T>) => void | Promise<void>,
    options?: SubscribeOptions,
  ): () => void;
  /** The last state conflict raised on this channel, if any. */
  conflict(): Conflict<unknown> | null;
  acknowledgeConflict(): void;
}

export interface EventBus extends Pick<IntentRegistry, 'candidates'> {
  channel<S = unknown>(name: string, options?: ChannelOptions): Channel<S>;
  /** Registers a handler for an intent raised by any application on this page. */
  addIntentListener<T>(intent: string, options: IntentHandlerOptions<T>): () => void;
  /** Asks whoever can handle this to handle it. Resolution policy decides between candidates. */
  raiseIntent<R = unknown>(intent: string, payload: unknown, options?: RaiseOptions): Promise<IntentResult<R>>;
  /** Declares the contract a state key or event type carries, so delivery can project per reader. */
  register<T>(type: string, schema: VersionedSchema<T>): void;
  /** Drains this consumer's queue of durable events. Called on wake-up; call it after mounting. */
  flush(): Promise<FlushResult>;
  close(): void;
}

const EVENT_COLLECTION = 'skew-events';
/** Where `persist` channels keep their state between reloads: one record per channel per partition. */
const STATE_COLLECTION = 'skew-channel-state';

/**
 * The collections an event bus writes to its `driver`: durable event queues and persisted channel
 * state. A driver that must declare its collections up front — IndexedDB — needs these among them.
 */
export const EVENT_BUS_COLLECTIONS = [EVENT_COLLECTION, STATE_COLLECTION] as const;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_DEPTH = 500;

/** The queue owner for a consumer's events, kept clear of its mutation outbox's lock and records. */
const queueOwner = (consumer: string) => `events:${consumer}`;
/** The tag that says "your event queue moved" — the same wake-up trick the overlay uses. */
const wakeTag = (consumer: string) => `skew:events#${consumer}`;
/** One mutation id per channel+type, so `drainOutbox` can find the handler by name after a reload. */
const runnerId = (channel: string, type: string) => `event:${channel}:${type}`;

/** What crosses a channel's wire between contexts. */
type WireMessage =
  | { kind: 'state'; value: unknown; at: number }
  | { kind: 'event'; event: BusEvent }
  | { kind: 'state-request'; request: string }
  | { kind: 'state-reply'; request: string; value: unknown; at: number };

/** How long a new bus's directory of other realms' intent handlers may take to fill. */
const INTENT_DISCOVERY_MS = 100;

/** What crosses a page's intents wire: each bus's handlers, and calls to run one. */
type IntentWireMessage =
  | { kind: 'intents-hello'; from: string }
  | { kind: 'intents-list'; from: string; handlers: LocalIntentHandler[] }
  | { kind: 'intents-bye'; from: string }
  | { kind: 'intent-call'; call: string; from: string; to: string; handler: string; payload: unknown }
  | { kind: 'intent-return'; call: string; to: string; ok: true; result: unknown }
  | { kind: 'intent-return'; call: string; to: string; ok: false; error: string };

/**
 * How long a context that holds state it did not publish waits before answering a state request,
 * at most — in case the publisher is gone. The publisher answers at once, and any answer cancels
 * the rest, so a page of many realms sends one reply, not one per realm.
 */
const FALLBACK_REPLY_MS = 60;

/**
 * The page this context is on, named by when its document started: the highest ancestor document
 * this context can read, which every same-origin realm composed onto the page reaches and no
 * other tab does. Read, never written: nothing is installed on the host. A cross-origin ancestor
 * (the whole app embedded in another site) stops the walk at the last same-origin one, which is
 * still the composed page. Undefined outside a browser.
 */
function currentPage(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  let page: Window = window;
  for (let depth = 0; depth < 32; depth += 1) {
    let parent: Window;
    try {
      parent = page.parent;
      if (!parent || parent === page) break;
      // throws for a cross-origin parent
      void parent.performance.timeOrigin;
    } catch {
      break;
    }
    page = parent;
  }
  try {
    return String(page.performance.timeOrigin);
  } catch {
    return undefined;
  }
}

export function createEventBus(options: EventBusOptions): EventBus {
  const partition = options.partition ?? (() => 'default');
  const page = options.page ?? currentPage();
  const invalidator = options.invalidator ?? sharedInvalidator({ partition: partition() });
  const schemas = new Map<string, VersionedSchema<unknown>>();
  const channels = new Map<string, ChannelState>();
  const handlers = new Map<string, Set<(event: BusEvent) => void | Promise<void>>>();
  const maxAttempts = options.maxAttempts ?? 5;

  /** This consumer's own durable queue. One outbox, every channel's events. */
  const queue: Outbox | null = options.driver
    ? createOutbox({
        driver: options.driver,
        owner: queueOwner(options.consumer),
        partition: partition(),
        collection: EVENT_COLLECTION,
      })
    : null;

  interface ChannelState {
    /** The logical name — what the payload's contract is registered under. */
    readonly name: string;
    /** Name plus entity: what state, transports, and queued events are keyed by. */
    readonly key: string;
    readonly options: ChannelOptions;
    state: unknown;
    /** What this context last broadcast — what a conflict is judged against. */
    published: unknown;
    /** Whether any state has been set here or heard from elsewhere, `undefined` included. */
    heard: boolean;
    /** Whether the current state was set live — here, or broadcast by another context — rather than caught up. */
    live: boolean;
    /** When the current state was set, by its publisher's clock; how a caught-up value is judged. */
    at: number | undefined;
    /** Whether the current state is this context's own broadcast, so it answers requests at once. */
    authored: boolean;
    /** The request this context sent for state, until it is answered or state arrives otherwise. */
    asked?: string;
    /** Fallback replies waiting to go out, cancelled when someone else answers first. */
    readonly replying: Map<string, ReturnType<typeof setTimeout>>;
    /** Requests already answered, so one that arrives after its answer is not answered again. */
    readonly answered: Set<string>;
    conflict: Conflict<unknown> | null;
    readonly stateListeners: Set<{ listener: (value: unknown) => void; as?: number }>;
    /** To other contexts: every tab for origin scope, this page's realms for page scope. */
    readonly wire?: BroadcastChannelLike | undefined;
  }

  /** Projects a value to one reader's version, exactly as the context bus does. */
  function project(type: string, value: unknown, as: number | undefined): unknown {
    const schema = schemas.get(type);
    if (!schema) return structuredClone(value);

    const envelope = as === undefined || as === schema.version ? schema.write(value) : schema.write(value, { as });
    return structuredClone(envelope.payload);
  }

  function openWire(name: string): BroadcastChannelLike | undefined {
    const wireName = `skew:events:${partition()}:${name}`;
    if (options.broadcastChannel) return options.broadcastChannel(wireName);
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(wireName);
    // Node — a test environment with a `window` — would otherwise stay alive for an open channel
    (channel as unknown as { unref?: () => void }).unref?.();
    return channel as unknown as BroadcastChannelLike;
  }

  /**
   * Sends to other contexts. A value that cannot be cloned has already reached this context's
   * subscribers and handlers, so the failure is reported rather than thrown after the fact.
   */
  function post(channel: ChannelState, message: WireMessage): void {
    try {
      channel.wire?.postMessage(message);
    } catch (error) {
      options.onEventError?.(`[skew/data] "${channel.name}" could not be sent to other contexts`, error);
    }
  }

  /**
   * Asks other contexts for the channel's state, once, the first time this context reads it. A
   * channel used only for events never asks.
   */
  function askForState(channel: ChannelState): void {
    if (!channel.wire || channel.live || channel.asked !== undefined) return;
    channel.asked = crypto.randomUUID();
    post(channel, { kind: 'state-request', request: channel.asked });
  }

  function answer(channel: ChannelState, request: string): void {
    if (!channel.heard || channel.state === undefined || channel.replying.has(request) || channel.answered.has(request)) return;
    const reply = () => {
      channel.replying.delete(request);
      post(channel, { kind: 'state-reply', request, value: channel.state, at: channel.at ?? 0 });
    };
    if (channel.authored) return reply();
    const timer = setTimeout(reply, Math.random() * FALLBACK_REPLY_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    channel.replying.set(request, timer);
  }

  function channelState(name: string, channelOptions: ChannelOptions): ChannelState {
    // One entity's channel is not another's, so the identity carries it — while the contract stays
    // registered under the logical name, because every fund's selection has the same shape.
    const key = channelOptions.entity ? `${name}@${channelOptions.entity}` : name;
    const existing = channels.get(key);
    if (existing) return existing;

    const scope = channelOptions.scope ?? 'page';
    const wire = scope === 'origin' ? openWire(key) : page === undefined ? undefined : openWire(`page:${page}:${key}`);
    const created: ChannelState = {
      name,
      key,
      options: channelOptions,
      state: undefined,
      published: undefined,
      heard: false,
      live: false,
      at: undefined,
      authored: false,
      replying: new Map(),
      answered: new Set(),
      conflict: null,
      stateListeners: new Set(),
      wire,
    };

    // A BroadcastChannel never delivers to its own sender, so a message arriving here is always from
    // another context — no de-duplication needed, which is the same property invalidation relies on.
    wire?.addEventListener('message', (event) => {
      const message = event.data as WireMessage | undefined;
      if (message?.kind === 'state') applyState(created, message.value, { local: false, at: message.at });
      if (message?.kind === 'event' && message.event) deliverLive(message.event);
      // A context that reads the channel after its state was set asks for it once (askForState).
      if (message?.kind === 'state-request') answer(created, message.request);
      if (message?.kind === 'state-reply') {
        // someone answered: nobody else needs to
        clearTimeout(created.replying.get(message.request));
        created.replying.delete(message.request);
        created.answered.add(message.request);
        // a few recent ones are enough: a request is answered within FALLBACK_REPLY_MS
        if (created.answered.size > 64) created.answered.delete(created.answered.values().next().value as string);
        // Only the asker takes it, and only as a catch-up: a reply that arrives after a newer
        // broadcast, or after state was cleared, must not set it back.
        if (message.request === created.asked) catchUp(created, message.value, message.at);
      }
    });

    channels.set(key, created);
    if (channelOptions.persist) restore(created);
    return created;
  }

  /**
   * Applies a new state value and tells the subscribers.
   *
   * Conflict is compared only against a value this context published: another context's broadcast is
   * news, not a disagreement. Two publishers racing end in last-write-wins, and the policy decides
   * whether anyone is told — the same contract, and the same words, as a mutation's confirmation.
   */
  function applyState(
    channel: ChannelState,
    value: unknown,
    { local, at = Date.now(), live = true }: { local: boolean; at?: number; live?: boolean },
  ): void {
    const previous = channel.published;
    let stored = value;

    if (local && previous !== undefined && !same(previous, value)) {
      const policy = channel.options.onConflict ?? 'raise';
      const conflict: Conflict<unknown> = {
        expected: previous,
        actual: value,
        paths: differingKeys(previous, value),
      };

      if (typeof policy === 'function') stored = policy(conflict);
      else if (policy === 'raise') channel.conflict = conflict;
    }

    channel.state = stored;
    channel.heard = true;
    channel.live = channel.live || live;
    channel.at = at;
    channel.authored = local;
    if (live) channel.asked = undefined;
    if (local) {
      channel.published = stored;
      if (channel.options.persist) store(channel);
    }

    for (const subscription of [...channel.stateListeners]) {
      // Isolated per subscriber: one application's bad deploy must not present as a different
      // application silently failing to update.
      try {
        subscription.listener(project(channel.name, stored, subscription.as));
      } catch (error) {
        options.onEventError?.(`[skew/data] a "${channel.name}" state subscriber threw`, error);
      }
    }
  }

  /**
   * A value from somewhere other than a live broadcast — a peer's answer to a state request, or
   * what was stored before a reload. Taken only while nothing live has arrived, and only when it is
   * newer than what this context already caught up to.
   */
  function catchUp(channel: ChannelState, value: unknown, at: number): void {
    if (channel.live || (channel.at !== undefined && at <= channel.at)) return;
    applyState(channel, value, { local: false, at, live: false });
  }

  function storedId(channel: ChannelState): string {
    return storageKey(partition(), channel.key);
  }

  function store(channel: ChannelState): void {
    const driver = options.driver!;
    const write =
      channel.state === undefined
        ? driver.delete(STATE_COLLECTION, storedId(channel))
        : driver.put(STATE_COLLECTION, {
            id: storedId(channel),
            key: channel.key,
            partition: partition(),
            seq: channel.at ?? Date.now(),
            envelope: envelopeOf(channel.name, channel.state),
            owner: options.consumer,
          });
    write.catch((error: unknown) => options.onEventError?.(`[skew/data] "${channel.name}" state could not be stored`, error));
  }

  function restore(channel: ChannelState): void {
    options
      .driver!.get(STATE_COLLECTION, storedId(channel))
      .then((record) => {
        if (!record) return;
        const value = valueOf(channel.name, record.envelope);
        if (value.ok) catchUp(channel, value.value, record.seq);
        else options.onEventError?.(`[skew/data] stored "${channel.name}" state could not be read`, value.error);
      })
      .catch((error: unknown) => options.onEventError?.(`[skew/data] stored "${channel.name}" state could not be read`, error));
  }

  /** The stored form: a versioned envelope under the channel's contract, when it has one. */
  function envelopeOf(type: string, value: unknown) {
    const schema = schemas.get(type);
    return schema ? schema.write(value) : { v: 0, payload: structuredClone(value) };
  }

  function valueOf(type: string, envelope: { v: number; payload: unknown }): { ok: true; value: unknown } | { ok: false; error: unknown } {
    const schema = schemas.get(type);
    if (!schema) return { ok: true, value: envelope.payload };
    const result = schema.read(envelope);
    return result.ok ? { ok: true, value: result.value } : { ok: false, error: result };
  }

  /** Fan-out to handlers in this context. Used by at-most-once, and by the queue drain. */
  function deliverLive(event: BusEvent): void {
    for (const handler of [...(handlers.get(runnerId(event.channel, event.type)) ?? [])]) {
      try {
        void handler(event);
      } catch (error) {
        options.onEventError?.(`[skew/data] a "${event.type}" handler threw`, error);
      }
    }
  }

  /**
   * Writes one entry per registered consumer, then wakes them.
   *
   * The emitting application is included: its own handlers are served by draining, not by a direct
   * call, so a durable event is delivered by exactly one path no matter who is listening. Two paths
   * would mean a mounted consumer handled the event twice.
   */
  async function enqueue(event: BusEvent, channel: ChannelState): Promise<void> {
    if (!options.driver) {
      throw new TypeError(
        '[skew/data] at-least-once delivery needs a `driver` on the bus: an event that must survive ' +
          'a reload has to be written somewhere. Pass one, or emit at-most-once.',
      );
    }

    const recipients = options.consumers?.length ? options.consumers : [options.consumer];
    const ttl = channel.options.ttlMs ?? DEFAULT_TTL_MS;
    const depth = channel.options.maxDepth ?? DEFAULT_MAX_DEPTH;

    for (const consumer of recipients) {
      const consumerQueue = createOutbox({
        driver: options.driver,
        owner: queueOwner(consumer),
        partition: partition(),
        collection: EVENT_COLLECTION,
      });

      await trim(consumerQueue, consumer, channel.key, ttl, depth);
      await consumerQueue.enqueue({ mutationId: runnerId(event.channel, event.type), input: event });
    }

    // One tag for every consumer: the wake-up crosses realms and, with cross-context invalidation on,
    // tabs — which is the whole reason a queued event reaches an application that was not running.
    invalidator.invalidate(...recipients.map(wakeTag));
  }

  /**
   * Enforces the retention bounds before adding to a queue.
   *
   * Both bounds are needed and both are reported. Fan-out retention is unbounded by nature —
   * consumers × events × until-handled — so a queue with no policy is a storage quota that dies
   * unattended, and one that drops silently is worse than one that fills up.
   */
  async function trim(
    consumerQueue: Outbox,
    consumer: string,
    channelKey: string,
    ttlMs: number,
    maxDepth: number,
  ): Promise<void> {
    // Scoped to this channel: one consumer's queue holds every channel's events, and a busy channel
    // must not evict a quiet one's — least of all one entity's evicting another's.
    const mine = (await consumerQueue.mine()).filter((entry) => (entry.input as BusEvent).channel === channelKey);
    const cutoff = Date.now() - ttlMs;

    for (const entry of mine) {
      const event = entry.input as BusEvent;
      if (Date.parse(event.at) >= cutoff) continue;
      await consumerQueue.remove(entry.id);
      options.onEventError?.(
        `[skew/data] dropped "${event.type}" for "${consumer}" — it sat in the queue past its ${ttlMs}ms window`,
        event,
      );
    }

    const remaining = (await consumerQueue.mine()).filter(
      (entry) => (entry.input as BusEvent).channel === channelKey,
    );
    const excess = remaining.length + 1 - maxDepth;
    for (const entry of remaining.slice(0, Math.max(0, excess))) {
      await consumerQueue.remove(entry.id);
      options.onEventError?.(
        `[skew/data] dropped "${(entry.input as BusEvent).type}" for "${consumer}" — the queue is at its ${maxDepth} limit`,
        entry.input,
      );
    }
  }

  /**
   * Drains this consumer's queue through `drainOutbox`.
   *
   * Everything about *how* a queue drains — one at a time across tabs, oldest first, stop at the
   * first failure, abandon loudly after `maxAttempts` — is the same code that replays mutations. A
   * second implementation of those rules would be a second set of bugs, and this package already
   * paid for that lesson once.
   */
  /**
   * Serializes this bus's own flushes, for the reason the data client had to.
   *
   * The cross-context lock declines a drain another context is already running, which is right —
   * waiting would drain a queue that context has already emptied. Applied to *one* bus's overlapping
   * calls that rule is a trap: an emit wakes us, the wake-up flush is still finishing, and the
   * caller's own `flush()` reports `skipped` and quietly does nothing. Within one bus, a second
   * flush waits for the first and then runs, picking up whatever arrived in between.
   */
  let flushing: Promise<FlushResult> | null = null;

  async function flush(): Promise<FlushResult> {
    if (flushing) await flushing.catch(() => undefined);

    const run = drain();
    flushing = run;
    try {
      return await run;
    } finally {
      if (flushing === run) flushing = null;
    }
  }

  async function drain(): Promise<FlushResult> {
    if (!queue) return { sent: 0, failed: 0, remaining: 0, skipped: false };

    return drainOutbox({
      outbox: queue,
      owner: queueOwner(options.consumer),
      runnerFor: (mutationId) => {
        const registered = handlers.get(mutationId);
        if (!registered?.size) return undefined;
        return async (input) => {
          const event = input as BusEvent;
          // Sequentially: handlers for one event type on one consumer are ordered by registration,
          // and a throwing handler must fail the entry so it is retried rather than lost.
          for (const handler of [...registered]) await handler(event);
        };
      },
      maxAttempts,
      ...(options.onEventError === undefined ? {} : { onError: options.onEventError }),
    });
  }

  /**
   * Intents across this page's realms. Each bus announces its own handlers and keeps a directory of
   * everyone else's, so `candidates()` stays synchronous; a raise that picks a handler in another
   * realm calls it over the wire. Page scope only: an intent is "somebody on this page handle
   * this", and a handler in another tab is not on the page.
   */
  const busId = crypto.randomUUID();
  const intentWire = page === undefined ? undefined : openWire(`page:${page}:intents`);
  const directory = new Map<string, LocalIntentHandler[]>();
  const calls = new Map<string, { to: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const intentTimeoutMs = options.intentTimeoutMs ?? 30_000;

  function sendIntents(message: IntentWireMessage): void {
    try {
      intentWire?.postMessage(message);
    } catch (error) {
      options.onEventError?.('[skew/data] an intent message could not be sent to other contexts', error);
    }
  }

  function announce(): void {
    sendIntents({ kind: 'intents-list', from: busId, handlers: intents.local() });
  }

  function remoteHandlers(intent: string): RemoteIntentHandler[] {
    return [...directory].flatMap(([source, handlers]) =>
      handlers
        .filter((handler) => handler.intent === intent)
        .map(({ id, ...candidate }) => ({ ...candidate, source, run: (payload: unknown) => callRemote(source, id, payload, candidate) })),
    );
  }

  function callRemote(to: string, handler: string, payload: unknown, candidate: IntentCandidate): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const call = crypto.randomUUID();
      const timer = setTimeout(() => {
        calls.delete(call);
        reject(new Error(`[skew/data] the "${candidate.intent}" handler in ${candidate.consumer} did not answer within ${intentTimeoutMs}ms`));
      }, intentTimeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      calls.set(call, { to, resolve, reject, timer });
      try {
        intentWire!.postMessage({ kind: 'intent-call', call, from: busId, to, handler, payload } satisfies IntentWireMessage);
      } catch (error) {
        clearTimeout(timer);
        calls.delete(call);
        // `cause` set by hand: Angular builds of this package compile against a lib without Error options
        reject(Object.assign(new Error(`[skew/data] the "${candidate.intent}" payload could not be sent to ${candidate.consumer}`), { cause: error }));
      }
    });
  }

  function settle(call: string, outcome: { ok: true; result: unknown } | { ok: false; error: Error }): void {
    const pending = calls.get(call);
    if (!pending) return;
    calls.delete(call);
    clearTimeout(pending.timer);
    if (outcome.ok) pending.resolve(outcome.result);
    else pending.reject(outcome.error);
  }

  intentWire?.addEventListener('message', (event) => {
    const message = event.data as IntentWireMessage | undefined;
    switch (message?.kind) {
      case 'intents-hello':
        // a context that just arrived: tell it what is here
        if (intents.local().length > 0) announce();
        return;
      case 'intents-list':
        if (message.handlers.length > 0) directory.set(message.from, message.handlers);
        else directory.delete(message.from);
        return;
      case 'intents-bye':
        directory.delete(message.from);
        // nobody there will answer these
        for (const [call, pending] of calls) {
          if (pending.to === message.from) settle(call, { ok: false, error: new Error('[skew/data] the context handling this intent closed') });
        }
        return;
      case 'intent-call': {
        if (message.to !== busId) return;
        const reply = (outcome: { ok: true; result: unknown } | { ok: false; error: string }) => {
          try {
            intentWire?.postMessage({ kind: 'intent-return', call: message.call, to: message.from, ...outcome } as IntentWireMessage);
          } catch {
            intentWire?.postMessage({ kind: 'intent-return', call: message.call, to: message.from, ok: false, error: 'the handler returned a result that could not be sent back' } satisfies IntentWireMessage);
          }
        };
        intents.runLocal(message.handler, message.payload).then(
          (result) => reply({ ok: true, result }),
          (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
        return;
      }
      case 'intent-return':
        if (message.to !== busId) return;
        settle(message.call, message.ok ? { ok: true, result: message.result } : { ok: false, error: new Error(message.error) });
        return;
    }
  });

  const intents = createIntentRegistry({
    consumer: options.consumer,
    // Intents project through the same registered contracts state and events do, so an application
    // declares a shape once and every path respects it.
    schemaFor: (intent) => schemas.get(intent),
    ...(options.onEventError === undefined ? {} : { onEventError: options.onEventError }),
    ...(intentWire ? { remote: remoteHandlers, onChange: announce } : {}),
  });
  sendIntents({ kind: 'intents-hello', from: busId });
  /** Until then, other realms' answers to the hello may still be on their way. */
  const directoryReadyAt = intentWire ? Date.now() + INTENT_DISCOVERY_MS : 0;

  /**
   * A raise that finds nobody in the bus's first moments waits for the directory once and retries,
   * so a fragment that raises as it mounts is not told "nothing can handle this" while the other
   * realms' answers are still in flight.
   */
  async function raiseIntent<R>(intent: string, payload: unknown, raiseOptions?: RaiseOptions): Promise<IntentResult<R>> {
    try {
      return await intents.raiseIntent<R>(intent, payload, raiseOptions);
    } catch (error) {
      const wait = directoryReadyAt - Date.now();
      if (!(error instanceof NoIntentHandlerError) || wait <= 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
      return intents.raiseIntent<R>(intent, payload, raiseOptions);
    }
  }

  // A realm that goes away without closing its bus — its iframe removed — still says so.
  const sayBye = () => sendIntents({ kind: 'intents-bye', from: busId });
  if (intentWire && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', sayBye);
  }

  // Woken by any context that queued something for us — including our own emit.
  const stopWaking = invalidator.subscribe(
    () => [wakeTag(options.consumer)],
    () => void flush().catch(() => undefined),
  );

  return {
    channel<S>(name: string, channelOptions: ChannelOptions = {}): Channel<S> {
      if (channelOptions.persist && !options.driver) {
        throw new TypeError(
          `[skew/data] channel "${name}" asks to persist its state, which needs a \`driver\` on the bus — ` +
            'without one it would quietly forget on reload',
        );
      }
      const channel = channelState(name, channelOptions);

      return {
        name,

        broadcast(value: S): void {
          applyState(channel, value, { local: true });
          post(channel, { kind: 'state', value: channel.state, at: channel.at ?? Date.now() });
        },

        state(readOptions): S | undefined {
          askForState(channel);
          return channel.state === undefined ? undefined : (project(name, channel.state, readOptions?.as) as S);
        },

        subscribe(listener, subscribeOptions): () => void {
          if (subscribeOptions?.signal?.aborted) return () => undefined;
          const subscription = {
            listener: listener as (value: unknown) => void,
            ...(subscribeOptions?.as === undefined ? {} : { as: subscribeOptions.as }),
          };
          channel.stateListeners.add(subscription);

          // Called immediately with the current value: a fragment that mounts late still needs to
          // know what is true, which is the half of FDC3's broadcast that *is* state.
          if (channel.state !== undefined) {
            try {
              subscription.listener(project(name, channel.state, subscription.as));
            } catch (error) {
              options.onEventError?.(`[skew/data] a "${name}" state subscriber threw on subscribe`, error);
            }
          }

          const unsubscribe = () => void channel.stateListeners.delete(subscription);
          subscribeOptions?.signal?.addEventListener('abort', unsubscribe, { once: true });
          // nothing here yet: another context may hold it, and its answer arrives as an update
          askForState(channel);
          return unsubscribe;
        },

        async emit<T>(type: string, payload: T, emitOptions?: { delivery?: Delivery }): Promise<void> {
          const event: BusEvent<T> = {
            eventId: crypto.randomUUID(),
            // The instance, not the logical name: a handler on fund f1 must not be handed f2's
            // event, and retention must not let one entity evict another's queue.
            channel: channel.key,
            type,
            payload,
            at: new Date().toISOString(),
            source: options.consumer,
          };

          if ((emitOptions?.delivery ?? 'at-most-once') === 'at-least-once') {
            await enqueue(event as BusEvent, channel);
            return;
          }

          deliverLive(event as BusEvent);
          post(channel, { kind: 'event', event: event as BusEvent });
        },

        addEventListener<T>(
          type: string,
          handler: (event: BusEvent<T>) => void | Promise<void>,
          subscribeOptions?: SubscribeOptions,
        ): () => void {
          const id = runnerId(channel.key, type);
          let registered = handlers.get(id);
          if (!registered) {
            registered = new Set();
            handlers.set(id, registered);
          }

          const wrapped = async (event: BusEvent) => {
            await handler({
              ...event,
              payload: project(type, event.payload, subscribeOptions?.as) as T,
            });
          };
          registered.add(wrapped);

          const unsubscribe = () => void registered.delete(wrapped);
          subscribeOptions?.signal?.addEventListener('abort', unsubscribe, { once: true });
          return unsubscribe;
        },

        conflict: () => channel.conflict,
        acknowledgeConflict: () => void (channel.conflict = null),
      };
    },

    register<T>(type: string, schema: VersionedSchema<T>): void {
      schemas.set(type, schema as VersionedSchema<unknown>);
    },

    addIntentListener: intents.addIntentListener,
    raiseIntent,
    candidates: intents.candidates,

    flush,

    close(): void {
      stopWaking();
      sayBye();
      if (intentWire && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('pagehide', sayBye);
      }
      for (const call of [...calls.keys()]) settle(call, { ok: false, error: new Error('[skew/data] the bus closed before the intent was answered') });
      intentWire?.close();
      for (const channel of channels.values()) {
        channel.replying.forEach((timer) => clearTimeout(timer));
        channel.wire?.close();
      }
      channels.clear();
      handlers.clear();
      invalidator.close();
    },
  };
}

/** Which top-level keys two states disagree about. Same rule as a mutation's conflict. */
function differingKeys(previous: unknown, next: unknown): string[] {
  const before = (previous ?? {}) as Record<string, unknown>;
  const after = (next ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !same(before[key], after[key]));
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
