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
   * - `error` — the server failed partway (a store that threw). `snapshotId` and `pinned` say how
   *   far the write got: a stored but unpinned snapshot is harmless, and worth knowing about.
   */
  outcome: 'success' | 'denied' | 'rejected' | 'error';
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
  /** The environment a promotion, approval or rejection was in. */
  environment?: string;
}

export type AuditAction = 'publish' | 'pin' | 'promote' | 'approve' | 'reject';

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
  /** Sent with every batch — typically the collector's token. Keep tokens out of the URL. */
  headers?: Record<string, string>;
  /** The most events per POST, and how many queued events trigger a send. Defaults to 50. */
  batchSize?: number;
  /** Send a partial batch after this long. Defaults to 5000ms. */
  flushMs?: number;
  /** Abandon a POST that has not answered after this long, and keep its events. Defaults to 10 000ms. */
  timeoutMs?: number;
  /**
   * The most events held while the endpoint is slow or down. Defaults to 10 000. When full, the
   * oldest are dropped and counted — memory is the thing a request handler must not run out of.
   */
  maxQueue?: number;
  fetch?: typeof fetch;
}

export interface WebhookAuditSink extends AuditSink {
  /**
   * Sends everything queued now, batch by batch, stopping at the first failure. Call it on
   * shutdown: the timer is unref'd, so a process that exits can otherwise leave up to `flushMs` of
   * events unsent. On Workers, pass it to `ctx.waitUntil`.
   */
  flush(): Promise<void>;
  /** Events waiting to be sent. */
  readonly pending: number;
}

/**
 * POSTs events in batches, as a JSON array, to an HTTP collector.
 *
 * One request is in flight at a time, carrying at most `batchSize` events. A batch the endpoint
 * refuses, or that does not answer within `timeoutMs`, goes back to the front of the queue, and
 * the sink backs off — doubling from `flushMs` up to a minute — rather than retrying on every new
 * event: an outage costs one request per backoff period and one warning, however busy the API is.
 * Past `maxQueue`, the oldest events are dropped and the count is logged.
 */
export function webhookAuditSink(options: WebhookAuditSinkOptions): WebhookAuditSink {
  const { url, headers = {}, batchSize = 50, flushMs = 5000, timeoutMs = 10_000, maxQueue = 10_000 } = options;
  const send = options.fetch ?? globalThis.fetch;
  const MAX_BACKOFF_MS = 60_000;

  const queue: AuditEvent[] = [];
  let dropped = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<boolean> | undefined;

  const trim = (): void => {
    if (queue.length <= maxQueue) return;
    const excess = queue.length - maxQueue;
    queue.splice(0, excess);
    dropped += excess;
  };

  const schedule = (delay: number): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  };

  /** Sends one batch. Resolves true when it was accepted. */
  async function sendBatch(): Promise<boolean> {
    const batch = queue.splice(0, batchSize);
    if (dropped > 0) {
      console.warn(`[braid-registry] audit webhook queue was full: dropped ${dropped} oldest event(s)`);
      dropped = 0;
    }
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(new Error(`no answer after ${timeoutMs}ms`)), timeoutMs);
    try {
      const response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(batch),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (failures > 0) console.warn(`[braid-registry] audit webhook recovered after ${failures} failed attempt(s)`);
      failures = 0;
      return true;
    } catch (error) {
      // Warned once per outage, not per attempt.
      if (failures === 0) {
        console.warn(`[braid-registry] audit webhook failed (${String(error)}); events are kept and retried with backoff`);
      }
      failures += 1;
      queue.unshift(...batch);
      trim();
      return false;
    } finally {
      clearTimeout(deadline);
    }
  }

  async function flush(): Promise<void> {
    while (inFlight) await inFlight;
    clearTimeout(timer);
    timer = undefined;
    while (queue.length > 0) {
      inFlight = sendBatch();
      const ok = await inFlight;
      inFlight = undefined;
      if (!ok) {
        schedule(Math.min(flushMs * 2 ** failures, MAX_BACKOFF_MS));
        return;
      }
    }
  }

  const sink = (event: AuditEvent): void => {
    queue.push(event);
    trim();
    // While backing off, new events wait for the retry rather than each forcing a send.
    if (failures > 0 || inFlight) return schedule(flushMs);
    if (queue.length >= batchSize) void flush();
    else schedule(flushMs);
  };

  // defineProperty, not Object.assign: assign would copy the getter's value once, freezing it at 0
  return Object.defineProperty(Object.assign(sink, { flush }), 'pending', { get: () => queue.length, enumerable: true }) as WebhookAuditSink;
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
