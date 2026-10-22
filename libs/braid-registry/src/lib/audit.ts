/**
 * The registry's audit trail: one event per attempt to change what the gateway serves.
 *
 * Snapshots already record who *published* them. That is not an audit trail: it says nothing about
 * who moved HEAD back to an old snapshot, who tried to publish and was refused, or which publish
 * the server rejected and why. These events do, and they are shaped for a SIEM — flat, versioned,
 * one per attempt — rather than for this API's own responses.
 *
 * **Best effort, by design.** Sinks run after the response is decided and cannot change it: an
 * audit pipeline that is down must not stop an operator rolling back a broken page. A deployment
 * that needs fail-closed auditing should put that guarantee where it can be kept — a durable log
 * shipper reading `jsonLinesAuditSink` output — not in a request handler.
 */

export interface AuditEvent {
  /** Bumped when a field changes meaning, so a SIEM parser can tell old events from new. */
  version: 1;
  /** ISO 8601, server time. */
  at: string;
  action: AuditAction;
  /**
   * - `success` — the change was made.
   * - `denied` — the caller lacked the right; nothing was attempted.
   * - `rejected` — the caller had the right, but the server refused the change: a registry with
   *   errors, a HEAD that moved since the draft began, a snapshot that does not exist.
   */
  outcome: 'success' | 'denied' | 'rejected';
  /** Who, as `identify` resolved them from a verified credential. Null when it cannot say. */
  actor: string | null;
  /** The HTTP status the caller received. */
  status: number;
  /** The snapshot the action produced or pointed at, when it got that far. */
  snapshotId?: string;
  /** What HEAD pointed at before, for a change that moves it. */
  previousId?: string | null;
  /** Whether a publish also moved HEAD. */
  pinned?: boolean;
  /** Why a `rejected` or `denied` action did not happen, in the words the caller was given. */
  reason?: string;
  /** How much a successful publish changed, by fragment count — the detail is in the snapshots. */
  diff?: { added: number; removed: number; changed: number };
}

export type AuditAction = 'publish' | 'pin';

/** Receives each event. May be async; nothing waits for it, and nothing it throws reaches a caller. */
export type AuditSink = (event: AuditEvent) => void | Promise<void>;

/**
 * Writes each event as one line of JSON, the format log shippers (Fluent Bit, Vector, the Splunk
 * and Datadog agents, CloudWatch) forward to a SIEM without configuration:
 *
 * ```ts
 * createRegistryApi({ store, ...auth, audit: jsonLinesAuditSink((line) => process.stdout.write(line)) });
 * ```
 *
 * The writer is passed in because this package runs on Workers and Deno too, where there is no
 * `process.stdout` to default to.
 */
export function jsonLinesAuditSink(write: (line: string) => void): AuditSink {
  return (event) => write(`${JSON.stringify(event)}\n`);
}

export interface WebhookAuditSinkOptions {
  /** Where to POST batches: an HTTP event collector, a SIEM ingest URL, a queue's HTTP endpoint. */
  url: string;
  /** Sent with every batch — typically the collector's token. */
  headers?: Record<string, string>;
  /** Send as soon as this many events are queued. Defaults to 50. */
  batchSize?: number;
  /** Send a partial batch after this long. Defaults to 5000ms. */
  flushMs?: number;
  /**
   * The most events held while the endpoint is slow or down. Defaults to 10 000. When full, the
   * oldest are dropped and counted — memory is the thing a request handler must not run out of.
   */
  maxQueue?: number;
  fetch?: typeof fetch;
}

export interface WebhookAuditSink extends AuditSink {
  /** Sends whatever is queued now. Resolves when the attempt finishes, whether or not it succeeded. */
  flush(): Promise<void>;
}

/**
 * POSTs events in batches, as a JSON array, to an HTTP collector.
 *
 * A batch the endpoint refuses (or that fails to send) goes back to the front of the queue for
 * the next flush, so an outage delays events rather than losing them — until `maxQueue`, past
 * which the oldest are dropped and the count is logged.
 */
export function webhookAuditSink(options: WebhookAuditSinkOptions): WebhookAuditSink {
  const { url, headers = {}, batchSize = 50, flushMs = 5000, maxQueue = 10_000 } = options;
  const send = options.fetch ?? globalThis.fetch;

  let queue: AuditEvent[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> | undefined;

  const enqueue = (events: readonly AuditEvent[], front = false): void => {
    queue = front ? [...events, ...queue] : [...queue, ...events];
    if (queue.length > maxQueue) {
      dropped += queue.length - maxQueue;
      queue = queue.slice(queue.length - maxQueue);
    }
  };

  async function flush(): Promise<void> {
    if (sending) await sending;
    clearTimeout(timer);
    timer = undefined;
    if (queue.length === 0) return;

    const batch = queue;
    queue = [];
    if (dropped > 0) {
      console.warn(`[braid-registry] audit webhook queue was full: dropped ${dropped} oldest event(s)`);
      dropped = 0;
    }

    sending = (async () => {
      try {
        const response = await send(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(batch),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        console.warn(`[braid-registry] audit webhook failed (${String(error)}); ${batch.length} event(s) kept for the next flush`);
        enqueue(batch, true);
      }
    })();
    await sending;
    sending = undefined;
  }

  const sink = (event: AuditEvent): void => {
    enqueue([event]);
    if (queue.length >= batchSize) {
      void flush();
    } else if (!timer) {
      timer = setTimeout(() => void flush(), flushMs);
      (timer as { unref?: () => void }).unref?.();
    }
  };

  return Object.assign(sink, { flush });
}

/**
 * Calls every sink, and survives every one of them: a throwing or rejecting sink is reported once
 * and then ignored, so a broken audit pipeline is visible without flooding the log or failing the
 * request it was describing.
 */
export function createAuditEmitter(sinks: AuditSink | readonly AuditSink[] | undefined): (event: AuditEvent) => void {
  const all = sinks === undefined ? [] : Array.isArray(sinks) ? [...sinks] : [sinks as AuditSink];
  const reported = new Set<AuditSink>();

  const report = (sink: AuditSink, error: unknown): void => {
    if (reported.has(sink)) return;
    reported.add(sink);
    console.error('[braid-registry] an audit sink failed; events may be missing from it', error);
  };

  return (event) => {
    for (const sink of all) {
      try {
        const result = sink(event);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((error) => report(sink, error));
        }
      } catch (error) {
        report(sink, error);
      }
    }
  };
}
