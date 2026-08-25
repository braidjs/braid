import { BraidError } from '../errors.js';
import { Envelope, WeaveErrorPayload, WEAVE_VERSION, weaveId } from './envelope.js';

/**
 * The transport a channel runs over. Two exist: `same-realm` for trusted realms (direct dispatch,
 * no serialization) and `port` for the cross-origin tier (`MessagePort` + structured clone).
 *
 * The interface is this small on purpose. Everything interesting — correlation, deadlines, replies,
 * error propagation, close — lives in the channel above it, so that adding a transport is not an
 * occasion to re-implement any of it slightly differently.
 */
export interface ChannelBacking {
  post(envelope: Envelope): void;
  /** Registers the sole inbound handler. Returns a detach function. */
  receive(handler: (envelope: Envelope) => void): () => void;
  close(): void;
}

/** Context handed to a message handler alongside its payload. */
export interface MessageMeta {
  readonly fragmentId: string;
  readonly instance: string;
  readonly scope: string | undefined;
  readonly type: string;
}

export type MessageHandler = (payload: unknown, meta: MessageMeta) => unknown;

export interface RequestOptions {
  timeoutMs?: number;
  scope?: string;
}

export interface BoundaryChannel {
  /** Fire and forget. No reply is expected and none will be delivered. */
  send(type: string, payload?: unknown, options?: { scope?: string }): void;
  /** Sends and awaits a reply. Rejects on timeout, on a remote throw, or if the channel closes. */
  request<T = unknown>(type: string, payload?: unknown, options?: RequestOptions): Promise<T>;
  /**
   * Handles one message type, optionally on one scope.
   *
   * One handler per **(type, scope)** pair — a second registration for the same pair replaces the
   * first, which keeps a duplicate registration a visible bug rather than a silent double-reply.
   *
   * Scope is part of the address rather than a filter the handler applies itself, and that
   * distinction is load-bearing: a fragment reading both its own bus and the page bus registers
   * `ctx/changed` twice, and with scope as a mere filter the second registration would silently
   * displace the first and one of the two buses would go quiet.
   */
  on(type: string, handler: MessageHandler, options?: { scope?: string }): () => void;
  readonly fragmentId: string;
  readonly instance: string;
  readonly closed: AbortSignal;
  close(): void;
}

export interface CreateChannelOptions {
  backing: ChannelBacking;
  fragmentId: string;
  instance: string;
  /** Closing the channel when the fragment instance is disposed. */
  signal?: AbortSignal;
  /** Default deadline for `request`. */
  defaultTimeoutMs?: number;
}

/**
 * Five seconds: long enough to survive a slow first paint on a cold realm, short enough that a
 * developer watching a wedged fragment gets a named error inside their attention span rather than
 * a spinner that never resolves. Individual calls override it — the handshake uses its own.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

export function createBoundaryChannel(options: CreateChannelOptions): BoundaryChannel {
  const { backing, fragmentId, instance } = options;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Keyed by `type` and `scope` together — see `on`. `\u0000` cannot occur in either. */
  const handlers = new Map<string, MessageHandler>();
  const handlerKey = (type: string, scope: string | undefined) => `${type}\u0000${scope ?? ''}`;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> | undefined }>();
  const closeController = new AbortController();

  const fail = (message: string, fixHint?: string) =>
    new BraidError(message, { fragmentId, stage: 'boundary', ...(fixHint === undefined ? {} : { fixHint }) });

  function settlePending(id: string, settle: (entry: NonNullable<ReturnType<typeof pending.get>>) => void): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    settle(entry);
  }

  function post(envelope: Envelope): void {
    if (closeController.signal.aborted) return;
    backing.post(envelope);
  }

  function onInbound(envelope: Envelope): void {
    if (closeController.signal.aborted) return;

    // A reply: match it to its request and settle. An unmatched reply is dropped rather than
    // reported — it is the normal shape of a request that already timed out, and turning every
    // slow-but-eventual answer into a console error would train people to ignore the console.
    if (envelope.re !== undefined) {
      settlePending(envelope.re, (entry) => {
        if (envelope.error) entry.reject(remoteError(envelope.error, fragmentId));
        else entry.resolve(envelope.payload);
      });
      return;
    }

    const handler = handlers.get(handlerKey(envelope.type, envelope.scope));
    if (!handler) {
      // An unhandled request must be answered, or the caller waits out its whole deadline for a
      // message that was never going to arrive. Say which type was unhandled: the most common
      // cause is a version mismatch between the two ends.
      if (envelope.reply) {
        post(
          replyTo(envelope, undefined, {
            message: `no handler for "${envelope.type}"${envelope.scope === undefined ? '' : ` on scope "${envelope.scope}"`}`,
            stage: 'boundary',
          }),
        );
      }
      return;
    }

    const meta: MessageMeta = {
      fragmentId: envelope.fragmentId,
      instance: envelope.instance,
      scope: envelope.scope,
      type: envelope.type,
    };

    let result: unknown;
    try {
      result = handler(envelope.payload, meta);
    } catch (error) {
      if (envelope.reply) post(replyTo(envelope, undefined, errorPayload(error)));
      // A throw from a fire-and-forget handler has nobody to tell, and swallowing it is how one
      // fragment's bug becomes another fragment's mystery. Report it where it happened.
      else console.error(`[braid:${fragmentId}] a "${envelope.type}" handler threw`, error);
      return;
    }

    if (!envelope.reply) return;

    Promise.resolve(result).then(
      (value) => post(replyTo(envelope, value)),
      (error: unknown) => post(replyTo(envelope, undefined, errorPayload(error))),
    );
  }

  function replyTo(request: Envelope, payload: unknown, error?: WeaveErrorPayload): Envelope {
    return {
      v: WEAVE_VERSION,
      id: weaveId(),
      re: request.id,
      type: request.type,
      fragmentId,
      instance,
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      ...(payload === undefined ? {} : { payload }),
      ...(error === undefined ? {} : { error }),
    };
  }

  // Attached before the channel object exists, so that a backing which delivers eagerly cannot
  // drop a message that arrives between construction and subscription.
  const detach = backing.receive(onInbound);

  const channel: BoundaryChannel = {
    fragmentId,
    instance,
    closed: closeController.signal,

    send(type, payload, sendOptions) {
      post({
        v: WEAVE_VERSION,
        id: weaveId(),
        type,
        fragmentId,
        instance,
        ...(sendOptions?.scope === undefined ? {} : { scope: sendOptions.scope }),
        ...(payload === undefined ? {} : { payload }),
      });
    },

    request<T>(type: string, payload?: unknown, requestOptions?: RequestOptions): Promise<T> {
      if (closeController.signal.aborted) {
        return Promise.reject(fail(`cannot send "${type}": the boundary channel is closed`));
      }

      const id = weaveId();
      const timeoutMs = requestOptions?.timeoutMs ?? defaultTimeoutMs;
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              settlePending(id, (entry) =>
                entry.reject(
                  fail(
                    `"${type}" got no reply within ${timeoutMs}ms`,
                    'the fragment may not have booted, may have wedged, or may not handle this message type',
                  ),
                ),
              );
            }, timeoutMs)
          : undefined;

      pending.set(id, { resolve, reject, timer });

      post({
        v: WEAVE_VERSION,
        id,
        reply: true,
        type,
        fragmentId,
        instance,
        ...(requestOptions?.scope === undefined ? {} : { scope: requestOptions.scope }),
        ...(payload === undefined ? {} : { payload }),
      });

      return promise as Promise<T>;
    },

    on(type, handler, onOptions) {
      const key = handlerKey(type, onOptions?.scope);
      handlers.set(key, handler);
      return () => {
        if (handlers.get(key) === handler) handlers.delete(key);
      };
    },

    close() {
      if (closeController.signal.aborted) return;
      closeController.abort();

      // Every in-flight request is rejected before the transport goes away. The alternative — let
      // them time out — leaves a fragment's teardown path waiting seconds on answers that can no
      // longer arrive, which is exactly the hang Phase 3 exists to prevent.
      for (const id of [...pending.keys()]) {
        settlePending(id, (entry) => entry.reject(fail('the boundary channel closed before a reply arrived')));
      }
      handlers.clear();
      detach();
      backing.close();
    },
  };

  options.signal?.addEventListener('abort', () => channel.close(), { once: true });

  return channel;
}

function errorPayload(error: unknown): WeaveErrorPayload {
  if (error instanceof BraidError) {
    return {
      message: error.message,
      stage: error.stage,
      ...(error.fixHint === undefined ? {} : { fixHint: error.fixHint }),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

/**
 * Rebuilds a remote failure as a local `BraidError`.
 *
 * The remote's stage is preserved rather than flattened to `boundary`: a contract mismatch that
 * happened inside the fragment is a contract error that merely *travelled* over the boundary, and
 * relabelling it would point every reader at the transport instead of at the cause.
 */
function remoteError(payload: WeaveErrorPayload, fragmentId: string): BraidError {
  return new BraidError(payload.message, {
    fragmentId,
    stage: (payload.stage as BraidError['stage']) ?? 'boundary',
    ...(payload.fixHint === undefined ? {} : { fixHint: payload.fixHint }),
  });
}
