import type { FragmentManifest } from '@braidlabs/gateway';
import { createSnapshot, type RegistrySnapshot } from './snapshot.js';
import { isAfterCursor, isEnvironmentName, refCursor, type SnapshotStore } from './store.js';
import { diffRegistries, validateRegistry, type RegistryFinding } from './analysis.js';
import { fetchDescriptors, mergeDescriptors, type DescriptorNote } from './descriptor.js';
import type { ShellManifest } from './shell.js';
import { createAuditEmitter, type AuditAction, type AuditEvent, type AuditSink } from './audit.js';
import { describeViolations, ownershipViolations, type OwnedTags, type RegistryContent } from './ownership.js';
import type { SnapshotPublisher } from './github-publisher.js';

/**
 * The registry write API — fetch-native, like the gateway, so it mounts on any runtime.
 *
 * Specified here rather than inside the console for a reason: a team that wants their own UI, or
 * wants to publish from a pipeline, should not have to reverse-engineer an API out of a React app.
 * The console is one client of this, not its owner.
 *
 * **Drafts are not here.** A draft lives in whatever is editing it — the console keeps one in the
 * browser — and only *published* snapshots are server state. That keeps this small and sidesteps
 * multi-editor draft reconciliation entirely; the cost is that drafts do not follow you between
 * devices, which is the right trade until someone actually needs that.
 */
export interface RegistryApiOptions {
  store: SnapshotStore;
  /**
   * Who may read and who may publish — **required for writes**.
   *
   * There is no permissive default. An unauthenticated publish endpoint is remote control of which
   * fragments compose which pages, so omitting this leaves writes refused rather than open. Reads
   * are allowed by default, matching the registry's own public-by-default posture.
   *
   * Return a `Response` to refuse with it as-is — a 401 carrying `WWW-Authenticate` for a missing
   * or invalid token, say, where `false` would only ever mean 403.
   *
   * A publish that also pins (the default) is checked for both `publish` and `pin`, so a role that
   * may only publish candidates cannot move HEAD by leaving `pin` unset.
   */
  authorize?: (request: Request, action: RegistryAction, context?: AuthorizeContext) => AuthorizeResult | Promise<AuthorizeResult>;
  /**
   * Who is making the request, as the server knows it — an email or subject from a verified token.
   *
   * When present, every publish records it as `labels.publishedBy`, replacing whatever the client
   * sent. Labels are otherwise client-claimed; this is what makes the attribution an audit trail
   * rather than a note.
   */
  identify?: (request: Request) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * A stable identifier for the caller — the token's issuer and subject, say — for comparisons that
   * must not be fooled by display names. `identify` returns whatever a token carries (an email from
   * one client, a username from another), so the same person can look like two; approval compares
   * this instead when it is set. `createOidcAuthorizer` provides it.
   */
  subject?: (request: Request) => string | null | undefined | Promise<string | null | undefined>;
  /** Path the API is mounted at. Defaults to `/__braid/registry-api`. */
  basePath?: string;
  /**
   * Whether publishing probes each fragment for a descriptor and merges it (see
   * `descriptor.ts`). Defaults to false: it costs a fanout of requests, and it is only useful once
   * some fragment actually publishes one.
   */
  fetchDescriptors?: boolean;
  fetch?: typeof fetch;
  /**
   * Origins a fragment's URL endpoint may be on, e.g. `['https://billing.internal']`. A publish
   * with an endpoint anywhere else is refused (422, `endpoint-not-allowed`). Omit to allow any.
   *
   * Worth setting whenever publishers are not all trusted operators: the gateway proxies
   * `/__braid/frag/:id/*` to a fragment's endpoint, so whoever registers one decides what part of
   * the internal network that path opens to the internet.
   */
  endpointOrigins?: readonly string[];
  /**
   * The largest request body a write accepts, in bytes. Defaults to 5 MB — a registry of a few
   * thousand fragments. Larger is refused with 413 before it is parsed.
   */
  maxBodyBytes?: number;
  /**
   * Where audit events go — one per attempted write, whether it succeeded, was refused for lack of
   * rights, or was rejected by the server. Reads are not audited. See `audit.ts` for the event and
   * the `jsonLinesAuditSink` and `webhookAuditSink` helpers.
   *
   * Pair it with `identify`: an event's `actor` is whoever `identify` names, and is null without it.
   */
  audit?: AuditSink | readonly AuditSink[];
  /**
   * The tags whose fragments and shells the caller may change — per-tag ownership. Return `'*'`
   * for everything.
   *
   * When set, a publish or pin that would add, change or remove an item outside the caller's tags
   * is refused with 403 and the items named. The caller must own one of an item's old tags and one
   * of its new ones, so nothing can be taken over by retagging it; an untagged item needs `'*'`.
   * Unset, `publish` and `pin` rights are all there is. `createOidcAuthorizer({ tagMap })` provides
   * this from token groups.
   */
  owns?: (request: Request) => OwnedTags | null | undefined | Promise<OwnedTags | null | undefined>;
  /**
   * GitOps: propose each publish for review instead of making it. A valid publish — validated,
   * ownership-checked, minted exactly as it would be stored — is handed to the publisher (a GitHub
   * pull request with `githubPublisher`), the store and HEAD are left alone, and the answer is 202
   * with the pull request. Merging is what publishes, through whatever deploys the registry from
   * the repository. Pins still act directly on the store, so under GitOps leave pinning to merges.
   */
  publisher?: SnapshotPublisher;
  /**
   * Named environments with promotion, and optionally approval. See {@link EnvironmentConfig}.
   * Needs a store with environment support (both bundled stores have it), and `identify` when any
   * environment requires approval — an approval is only worth anything if it comes from someone
   * other than the requester.
   */
  environments?: readonly EnvironmentConfig[];
}

export type RegistryAction = 'read' | 'publish' | 'pin' | 'promote' | 'approve';

/** What an action is about, for rights scoped narrower than the action — `promote` to `production`. */
export interface AuthorizeContext {
  environment?: string;
}

/**
 * A named environment — `staging`, `production` — that points at a snapshot, beside HEAD.
 *
 * HEAD stays where publishing lands. An environment moves only by **promotion**, and a gateway
 * that follows it (`snapshotRegistry({ environment })`) serves what was promoted, not what was
 * published.
 */
export interface EnvironmentConfig {
  /** Lowercase letters, digits and `-`, starting with a letter. */
  name: string;
  /**
   * The environment this one is promoted from. A promotion must take that environment's current
   * snapshot (or roll back to one this environment served before). Without it, a promotion takes
   * HEAD, or any snapshot named explicitly.
   */
  from?: string;
  /**
   * How many people other than the requester must approve a promotion before it moves the
   * environment. 0 (the default) or 1.
   */
  approvals?: 0 | 1;
}

export type AuthorizeResult = boolean | Response;

export interface PublishRequestBody {
  manifests: FragmentManifest[];
  /**
   * The shells to publish. **Omit to keep HEAD's shells**; send `[]` to remove them all.
   *
   * Carrying forward on omission is what lets a client that only knows about fragments — an older
   * console, a CI job — publish without silently deleting every shell.
   */
  shells?: ShellManifest[];
  labels?: Record<string, string>;
  /** Point HEAD at the new snapshot. Defaults to true. */
  pin?: boolean;
  /**
   * The snapshot id the client's draft was branched from, or null if nothing was pinned then.
   *
   * When sent, a publish is refused with 409 if HEAD has moved since, so two editors cannot
   * silently overwrite each other. Omit it to publish last-write-wins, as a pipeline might.
   *
   * The check is made on arrival and again just before HEAD moves, without a lock: two publishes
   * landing within the same moment can still both pass. A store with compare-and-set would close it.
   */
  baseId?: string | null;
}

/** What `GET /permissions` answers: the caller's own rights, for a UI to offer only what will work. */
export interface RegistryPermissions {
  read: boolean;
  publish: boolean;
  pin: boolean;
  actor: string | null;
  /** Promote and approve rights per environment, when the API has environments. */
  environments?: Record<string, { promote: boolean; approve: boolean }>;
  /**
   * The tags the caller may change, `'*'` for all, or null when the API has no tag ownership.
   * Optional because a server from before per-tag ownership does not send it; read absent as null.
   */
  tags?: OwnedTags | null;
}

export interface PublishResult {
  snapshot: { id: string; createdAt: string; fragmentCount: number };
  findings: RegistryFinding[];
  descriptorNotes: DescriptorNote[];
  pinned: boolean;
  /** What this snapshot changes about the one HEAD pointed at before, when there was one. */
  diff?: ReturnType<typeof diffRegistries>;
  /** Present when a GitOps publisher proposed the snapshot instead of publishing it (status 202). */
  pullRequest?: { url: string; number: number };
}

export interface RegistryApi {
  /** Handles a request if it belongs to this API; returns null otherwise. */
  handle(request: Request): Promise<Response | null>;
}

export function createRegistryApi(options: RegistryApiOptions): RegistryApi {
  const { store, authorize, identify, basePath = '/__braid/registry-api', fetchDescriptors: probe = false } = options;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const emitAudit = options.audit === undefined ? null : createAuditEmitter(options.audit);
  const environments = new Map((options.environments ?? []).map((environment) => [environment.name, environment]));

  // Configuration mistakes fail at startup, where they are cheap to read, not on the first promote.
  for (const environment of environments.values()) {
    if (!isEnvironmentName(environment.name)) {
      throw new Error(`braid-registry: environment name "${environment.name}" must be lowercase letters, digits and "-", starting with a letter`);
    }
    if (environment.from !== undefined && (environment.from === environment.name || !environments.has(environment.from))) {
      throw new Error(`braid-registry: environment "${environment.name}" is promoted from "${environment.from}", which is not a configured environment`);
    }
    if (environment.approvals && !identify) {
      throw new Error(`braid-registry: environment "${environment.name}" requires approval, which needs identify — an approval must come from someone other than the requester`);
    }
  }
  for (const origin of options.endpointOrigins ?? []) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {
      // reported below
    }
    if (!parsed || parsed.origin !== origin.replace(/\/+$/, '')) {
      throw new Error(`braid-registry: endpointOrigins entry "${origin}" must be an origin like https://billing.internal`);
    }
  }
  if (environments.size > 0 && (!store.ref || !store.setRef || !store.refLog || !store.pending || !store.setPending)) {
    throw new Error('braid-registry: environments need a store with environment support (ref, setRef, refLog, pending, setPending)');
  }

  /**
   * What a write handler learned on its way to a response, for the audit event that describes it —
   * and who the caller is, resolved once and used for both the event and `labels.publishedBy`.
   */
  type AuditDetail = Pick<AuditEvent, 'snapshotId' | 'previousId' | 'pinned' | 'diff' | 'environment' | 'pending' | 'requestedBy' | 'pullRequest'> & {
    actor: string | null;
  };

  /**
   * One promotion step at a time per environment. Promote, approve and reject are each a read, a
   * check and a write; interleaved, two promotes could both see "nothing pending", or an approval
   * could apply a request that was just withdrawn. This serializes them in-process; across several
   * API instances, a store with compare-and-set is what closes it.
   */
  const locks = new Map<string, Promise<unknown>>();
  function serialized<T>(environment: string, step: () => Promise<T>): Promise<T> {
    const previous = locks.get(environment) ?? Promise.resolve();
    const next = previous.then(step, step);
    locks.set(environment, next.catch(() => undefined));
    return next;
  }

  /** The caller's stable identity for four-eyes: `subject` when configured, else the actor. */
  async function subjectOf(request: Request, actor: string | null): Promise<string | null> {
    if (!options.subject) return actor;
    try {
      return (await options.subject(request)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Runs a write and audits it from the response it produced, so every path out of the handler —
   * refusal, validation error, conflict, success — is recorded the same way, and none can be missed
   * by a branch that forgot to emit.
   */
  async function audited(
    request: Request,
    action: AuditAction,
    run: (detail: AuditDetail) => Response | Promise<Response>,
  ): Promise<Response> {
    let actor: string | null = null;
    try {
      actor = (await identify?.(request)) ?? null;
    } catch {
      // an unidentifiable caller is recorded as such; authorize decides whether that is allowed
    }
    const detail: AuditDetail = { actor };

    const record = (status: number, reason: string | undefined): void => {
      if (!emitAudit) return;
      const outcome =
        status >= 500 ? 'error' : detail.pullRequest ? 'proposed' : status < 300 ? 'success' : status === 401 || status === 403 ? 'denied' : 'rejected';
      const { actor: who, ...rest } = detail;
      emitAudit({
        version: 1,
        at: new Date().toISOString(),
        action,
        outcome,
        actor: who,
        status,
        ...rest,
        ...(reason === undefined ? {} : { reason: reason.slice(0, 500) }),
      });
    };

    let response: Response;
    try {
      response = await run(detail);
    } catch (error) {
      // A write that failed partway — the snapshot stored, HEAD not yet moved — is exactly the
      // event an auditor needs, so it is recorded before the error becomes a 500.
      record(500, error instanceof Error ? error.message : String(error));
      throw error;
    }
    record(response.status, response.status < 300 ? undefined : await errorOf(response));
    return response;
  }

  return {
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(basePath)) return null;

      const route = url.pathname.slice(basePath.length) || '/';

      try {
        if (request.method === 'GET' && route === '/snapshots') return await listSnapshots(request, url);
        if (request.method === 'GET' && route.startsWith('/snapshots/')) {
          return await getSnapshot(request, decodeURIComponent(route.slice('/snapshots/'.length)));
        }
        if (request.method === 'GET' && route === '/head') return await getHead(request);
        if (request.method === 'GET' && route === '/permissions') return await permissions(request);
        if (request.method === 'POST' && route === '/snapshots') {
          return await audited(request, 'publish', (d) => crossSite(request) ?? publish(request, d));
        }
        if (request.method === 'POST' && route === '/head') {
          return await audited(request, 'pin', (d) => crossSite(request) ?? pin(request, d));
        }
        if (request.method === 'GET' && route === '/environments') return await listEnvironments(request);
        const environmentRoute = /^\/environments\/([^/]+)\/(promote|approve|reject)$/.exec(route);
        if (request.method === 'POST' && environmentRoute) {
          const [, name, step] = environmentRoute as unknown as [string, string, 'promote' | 'approve' | 'reject'];
          const environment = environments.get(decodeURIComponent(name));
          if (!environment) return json({ error: `no environment "${decodeURIComponent(name)}"` }, 404);
          return await audited(request, step, (d) => {
            d.environment = environment.name;
            const handler = step === 'promote' ? promote : step === 'approve' ? approve : reject;
            return crossSite(request) ?? serialized(environment.name, () => handler(request, environment, d));
          });
        }
        if (request.method === 'POST' && crossSite(request)) return crossSite(request)!;

        return json({ error: `no route for ${request.method} ${route}` }, 404);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  };

  async function listSnapshots(request: Request, url: URL): Promise<Response> {
    const denied = await refuse(request, 'read');
    if (denied) return denied;

    const limitParam = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 100) : 25;
    const before = url.searchParams.get('before') ?? undefined;
    if (before !== undefined && (before.length > 200 || !before.includes('~'))) {
      return json({ error: 'expected before to be a cursor from a previous page\'s next' }, 400);
    }

    // Filtered here too: a custom store from before paging ignores `before`, and would otherwise
    // answer every page with the first one. It then ends the listing rather than looping.
    const items = (await store.list({ limit, ...(before !== undefined ? { before } : {}) })).filter(
      (ref) => before === undefined || isAfterCursor(ref, before),
    );
    const last = items.at(-1);
    return json({
      items,
      head: (await store.head?.()) ?? null,
      next: items.length === limit && last ? refCursor(last) : null,
    });
  }

  async function getSnapshot(request: Request, id: string): Promise<Response> {
    const denied = await refuse(request, 'read');
    if (denied) return denied;

    const snapshot = await store.get(id);
    return snapshot ? json(snapshot) : json({ error: `no snapshot "${id}"` }, 404);
  }

  async function getHead(request: Request): Promise<Response> {
    const denied = await refuse(request, 'read');
    if (denied) return denied;

    const id = (await store.head?.()) ?? null;
    const snapshot = id ? await store.get(id) : null;
    return json({ id, snapshot });
  }

  /**
   * Validates, merges descriptors, mints, stores, and optionally re-pins.
   *
   * Validation runs **here**, on the server, whatever the client already did. The console
   * validates as you type because that is good to use, not because it is trusted; this is the
   * check that decides whether a snapshot exists.
   */
  /**
   * A browser marks a request another site made with Sec-Fetch-Site: cross-site. Refusing those
   * writes closes CSRF for an `authorize` hook that reads a cookie; bearer tokens are immune
   * anyway, and clients that are not browsers do not send the header. Refused inside `audited`,
   * because a forged write is the refusal an auditor most wants to see.
   */
  function crossSite(request: Request): Response | null {
    if (request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'cross-site writes are refused' }, 403);
    // A browser can send a text/plain or form POST to another origin without a preflight, from a
    // sibling subdomain as easily as from the same site. Requiring JSON from browsers makes every
    // write one the API's CORS policy has to approve first. Non-browser clients (no Origin, no
    // Sec-Fetch-Site) are unaffected — they cannot be forged by a page.
    const fromBrowser = request.headers.has('sec-fetch-site') || request.headers.has('origin');
    const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (fromBrowser && type !== 'application/json') {
      return json({ error: 'writes from a browser must be sent as application/json' }, 415);
    }
    return null;
  }

  async function publish(request: Request, audit: AuditDetail): Promise<Response> {
    const denied = await refuse(request, 'publish');
    if (denied) return denied;

    const body = await readJson<PublishRequestBody>(request, maxBody);
    if (body instanceof Response) return body;
    if (!Array.isArray(body?.manifests)) {
      return json({ error: 'expected { manifests: FragmentManifest[] }' }, 400);
    }
    if (body.baseId !== undefined && body.baseId !== null && !isSnapshotId(body.baseId)) {
      return json({ error: 'expected baseId to be a snapshot id or null' }, 400);
    }
    if (body.shells !== undefined && !Array.isArray(body.shells)) {
      return json({ error: 'expected shells to be an array of ShellManifest' }, 400);
    }

    // Checked before anything is written: a refused pin must not leave a stored snapshot behind.
    const shouldPin = body.pin !== false;
    if (shouldPin) {
      const pinDenied = await refuse(request, 'pin');
      if (pinDenied) return pinDenied;
    }

    const previousId = (await store.head?.()) ?? null;
    audit.previousId = previousId;
    if (body.baseId !== undefined && body.baseId !== previousId) {
      return json(
        {
          error: `HEAD moved to ${previousId ?? 'nothing'} since this draft was branched from ${body.baseId ?? 'nothing'} — reload before publishing`,
          head: previousId,
        },
        409,
      );
    }
    const previous = previousId ? await store.get(previousId) : null;
    const shells = body.shells ?? previous?.shells ?? [];

    // Judged on what the caller sent, before descriptors are merged: a descriptor filling in
    // another team's fragment is not this caller changing it, and a refused publish should not
    // cost a fan-out of probes first.
    const ownership = await ownershipRefusal(
      request,
      { manifests: previous?.manifests ?? [], shells: previous?.shells ?? [] },
      { manifests: body.manifests, shells },
    );
    if (ownership) return ownership;

    let manifests = body.manifests;
    let descriptorNotes: DescriptorNote[] = [];

    if (probe) {
      const merged = mergeDescriptors(
        manifests,
        await fetchDescriptors(manifests, options.fetch ? { fetch: options.fetch } : {}),
      );
      manifests = merged.manifests;
      descriptorNotes = merged.notes;
    }

    // Carried-forward shells are validated too: deleting a fragment a shell still slots is refused
    // here, by name, rather than publishing a shell with a hole in it.
    const findings = validateRegistry(manifests, {
      shells,
      ...(options.endpointOrigins ? { endpointOrigins: options.endpointOrigins } : {}),
    });
    if (findings.some((finding) => finding.severity === 'error')) {
      // Nothing is written, so nothing needs undoing — the snapshot model makes refusal cheap.
      return json({ error: 'the registry has errors and was not published', findings, descriptorNotes }, 422);
    }

    // Server-owned whenever it is a record: with identify, and always under GitOps, where the
    // snapshot file in the repository is the record of who published it.
    const labels = identify || options.publisher ? attributed(audit.actor, body.labels) : body.labels;

    const snapshot = await createSnapshot({
      manifests,
      shells,
      ...(labels ? { labels } : {}),
    });

    if (options.publisher) {
      audit.snapshotId = snapshot.id;
      audit.pinned = false;
      const diff = previous ? diffRegistries(previous.manifests, snapshot.manifests) : undefined;
      let proposed: Awaited<ReturnType<SnapshotPublisher['propose']>>;
      try {
        proposed = await options.publisher.propose({ snapshot, pin: shouldPin, actor: audit.actor, findings, ...(diff ? { diff } : {}) });
      } catch (error) {
        // The registry API is fine; the place it proposes changes to is not.
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
      audit.pullRequest = proposed.pullRequest.url;
      if (diff) audit.diff = { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length };
      return json(
        {
          snapshot: { id: snapshot.id, createdAt: snapshot.createdAt, fragmentCount: snapshot.manifests.length },
          findings,
          descriptorNotes,
          pinned: false,
          pullRequest: proposed.pullRequest,
          ...(diff ? { diff } : {}),
        },
        202,
      );
    }

    await store.put(snapshot);
    audit.snapshotId = snapshot.id;
    audit.pinned = false;

    // Checked again just before moving HEAD: descriptor probes above can take seconds, and another
    // publish may have pinned meanwhile. The snapshot stays stored either way — it is immutable and
    // unpinned, so harmless. This narrows the window to two store calls; it does not close it,
    // which needs a compare-and-set in the store.
    // Always, under tag ownership: the check above was against `previous`, and a HEAD that moved
    // since would otherwise be replaced by a copy of it that reverts another team's change.
    if (shouldPin && (body.baseId !== undefined || options.owns)) {
      const current = (await store.head?.()) ?? null;
      if (current !== previousId) {
        return json({ error: `HEAD moved to ${current ?? 'nothing'} while publishing — reload before publishing`, head: current }, 409);
      }
    }

    if (shouldPin) await store.setHead?.(snapshot.id);
    audit.pinned = shouldPin;

    const result: PublishResult = {
      snapshot: { id: snapshot.id, createdAt: snapshot.createdAt, fragmentCount: snapshot.manifests.length },
      findings,
      descriptorNotes,
      pinned: shouldPin,
      ...(previous ? { diff: diffRegistries(previous.manifests, snapshot.manifests) } : {}),
    };
    if (result.diff) {
      audit.diff = { added: result.diff.added.length, removed: result.diff.removed.length, changed: result.diff.changed.length };
    }

    return json(result, 201);
  }

  async function pin(request: Request, audit: AuditDetail): Promise<Response> {
    const denied = await refuse(request, 'pin');
    if (denied) return denied;

    const body = await readJson<{ id?: string }>(request, maxBody);
    if (body instanceof Response) return body;
    const id = body?.id;
    if (!isSnapshotId(id)) return json({ error: 'expected { id } with a snapshot id' }, 400);

    const snapshot: RegistrySnapshot | null = await store.get(id);
    if (!snapshot) return json({ error: `no snapshot "${id}" — cannot pin what is not stored` }, 404);

    if (!store.setHead) return json({ error: 'this store does not track a head' }, 501);
    audit.previousId = (await store.head?.()) ?? null;

    // A pin is checked by what it changes about what is served, so it cannot do what a publish
    // may not — pinning someone else's edit is changing their fragment.
    const current = audit.previousId ? await store.get(audit.previousId) : null;
    const ownership = await ownershipRefusal(
      request,
      { manifests: current?.manifests ?? [], shells: current?.shells ?? [] },
      { manifests: snapshot.manifests, shells: snapshot.shells ?? [] },
    );
    if (ownership) return ownership;

    if (options.owns && ((await store.head?.()) ?? null) !== audit.previousId) {
      return json({ error: 'HEAD moved while this pin was being checked — reload and try again' }, 409);
    }
    await store.setHead(id);
    audit.snapshotId = id;

    return json({ id, pinned: true });
  }

  /**
   * Labels with `publishedBy` owned by the server: set to the verified actor, and never taken from
   * the client — not even when the server cannot identify the caller, since a claimed author on an
   * anonymous publish is exactly the forgery this exists to prevent.
   */
  function attributed(actor: string | null, labels: Record<string, string> | undefined): Record<string, string> | undefined {
    const rest = Object.fromEntries(Object.entries(labels ?? {}).filter(([key]) => key !== 'publishedBy'));
    const result = actor ? { ...rest, publishedBy: actor } : rest;
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * The caller's own rights. Answered for anyone — it reveals nothing beyond what the caller could
   * learn by trying — so a UI can hide what would be refused instead of offering it and failing.
   */
  async function permissions(request: Request): Promise<Response> {
    const allowed = async (action: RegistryAction) => (await refuse(request, action)) === null;
    const result: RegistryPermissions = {
      read: await allowed('read'),
      publish: await allowed('publish'),
      pin: await allowed('pin'),
      actor: (identify ? await identify(request) : null) ?? null,
      tags: options.owns ? ((await options.owns(request)) ?? []) : null,
    };
    if (environments.size > 0) {
      result.environments = {};
      for (const name of environments.keys()) {
        result.environments[name] = {
          promote: (await refuse(request, 'promote', { environment: name })) === null,
          approve: (await refuse(request, 'approve', { environment: name })) === null,
        };
      }
    }
    return json(result);
  }

  /** Every environment, where it points, and what is waiting for approval in it. */
  async function listEnvironments(request: Request): Promise<Response> {
    const denied = await refuse(request, 'read');
    if (denied) return denied;

    const items = [];
    for (const environment of environments.values()) {
      items.push({
        name: environment.name,
        from: environment.from ?? null,
        approvals: environment.approvals ?? 0,
        id: await store.ref!(environment.name),
        pending: await store.pending!(environment.name),
      });
    }
    return json({ items });
  }

  /**
   * Moves an environment to a snapshot — or, where approval is required, asks to.
   *
   * What may be promoted: the source environment's current snapshot, or one this environment has
   * served before (a rollback). With no source: HEAD, or any snapshot named.
   */
  async function promote(request: Request, environment: EnvironmentConfig, audit: AuditDetail): Promise<Response> {
    const denied = await refuse(request, 'promote', { environment: environment.name });
    if (denied) return denied;

    const body = await readJson<{ id?: unknown }>(request, maxBody);
    if (body instanceof Response) return body;
    if (body?.id !== undefined && !isSnapshotId(body.id)) return json({ error: 'expected { id } to be a snapshot id' }, 400);

    const current = await store.ref!(environment.name);
    audit.previousId = current;
    const source = environment.from ? await store.ref!(environment.from) : ((await store.head?.()) ?? null);
    const id = (body?.id as string | undefined) ?? source;
    if (!id) {
      return json({ error: `nothing to promote — ${environment.from ? `"${environment.from}" points at nothing yet` : 'nothing is published'}` }, 409);
    }

    const servedBefore = (await store.refLog!(environment.name)).some((move) => move.id === id);
    if (environment.from && id !== source && !servedBefore) {
      return json(
        { error: `"${environment.name}" is promoted from "${environment.from}", which points at ${source ?? 'nothing'} — promote that, or a snapshot "${environment.name}" served before` },
        409,
      );
    }

    const target = await store.get(id);
    if (!target) return json({ error: `no snapshot "${id}"` }, 404);
    audit.snapshotId = id;

    const before = current ? await store.get(current) : null;
    const ownership = await ownershipRefusal(
      request,
      { manifests: before?.manifests ?? [], shells: before?.shells ?? [] },
      { manifests: target.manifests, shells: target.shells ?? [] },
    );
    if (ownership) return ownership;

    if (environment.approvals) {
      if (await store.pending!(environment.name)) {
        return json({ error: `a promotion into "${environment.name}" is already waiting for approval — approve or reject it first` }, 409);
      }
      const requestedSubject = await subjectOf(request, audit.actor);
      if (!audit.actor || !requestedSubject) {
        return json({ error: 'a promotion that needs approval needs an identified requester' }, 403);
      }
      const pending = {
        id,
        base: current,
        requestedBy: audit.actor,
        ...(options.subject ? { requestedSubject } : {}),
        requestedAt: new Date().toISOString(),
      };
      await store.setPending!(environment.name, pending);
      audit.pending = true;
      return json({ environment: environment.name, pending }, 202);
    }

    await store.setRef!(environment.name, id, audit.actor);
    return json({ environment: environment.name, id });
  }

  /** Approves the pending promotion: by someone with the right who did not ask for it. */
  async function approve(request: Request, environment: EnvironmentConfig, audit: AuditDetail): Promise<Response> {
    const denied = await refuse(request, 'approve', { environment: environment.name });
    if (denied) return denied;

    const pending = await store.pending!(environment.name);
    if (!pending) return json({ error: `nothing is waiting for approval in "${environment.name}"` }, 404);
    audit.snapshotId = pending.id;
    audit.previousId = pending.base;
    audit.requestedBy = pending.requestedBy;

    // An approval names what it approves. Without this, a requester could withdraw the request the
    // approver reviewed and ask for something else, and the approval would land on that instead.
    const body = await readJson<{ id?: unknown; requestedAt?: unknown }>(request, maxBody);
    if (body instanceof Response) return body;
    if (body?.id !== pending.id || body?.requestedAt !== pending.requestedAt) {
      return json({ error: 'that is not the promotion waiting for approval — reload and review the current one', pending }, 409);
    }

    const approver = await subjectOf(request, audit.actor);
    const requester = pending.requestedSubject ?? pending.requestedBy;
    if (!audit.actor || !approver || approver === requester) {
      return json({ error: 'a promotion must be approved by someone other than whoever requested it' }, 403);
    }
    // The approver saw a change from `base`. If the environment has moved since, that is no
    // longer the change being made, and approving it would be approving something unseen.
    if ((await store.ref!(environment.name)) !== pending.base) {
      return json({ error: `"${environment.name}" moved since this promotion was requested — reject it and request again` }, 409);
    }

    await store.setRef!(environment.name, pending.id, audit.actor);
    await store.setPending!(environment.name, null);
    return json({ environment: environment.name, id: pending.id, approvedBy: audit.actor });
  }

  /** Withdraws the pending promotion: the requester changing their mind, or an approver declining. */
  async function reject(request: Request, environment: EnvironmentConfig, audit: AuditDetail): Promise<Response> {
    const pending = await store.pending!(environment.name);
    if (!pending) return json({ error: `nothing is waiting for approval in "${environment.name}"` }, 404);
    audit.snapshotId = pending.id;
    audit.previousId = pending.base;
    audit.requestedBy = pending.requestedBy;

    // The requester may withdraw — while they still hold the right to promote there; anyone else
    // needs the right to approve.
    const caller = await subjectOf(request, audit.actor);
    const isRequester = caller !== null && caller === (pending.requestedSubject ?? pending.requestedBy);
    const denied = await refuse(request, isRequester ? 'promote' : 'approve', { environment: environment.name });
    if (denied) return denied;

    await store.setPending!(environment.name, null);
    return json({ environment: environment.name, rejected: pending.id });
  }

  /** A 403 naming every item the caller may not change, or null when tag ownership allows it all. */
  async function ownershipRefusal(request: Request, before: RegistryContent, after: RegistryContent): Promise<Response | null> {
    if (!options.owns) return null;
    let owned: OwnedTags;
    try {
      owned = (await options.owns(request)) ?? [];
    } catch (error) {
      // Fails closed, and says nothing about why: the cause (an IdP URL, a key fetch) is for the
      // operator's log, not the caller.
      console.warn('[braid-registry] owns failed; refusing the write', error);
      return json({ error: 'ownership could not be determined — try again' }, 503);
    }
    const items = ownershipViolations(before, after, owned);
    return items.length > 0 ? json({ error: describeViolations(items), items }, 403) : null;
  }

  /** Returns a refusal response, or null when the action is allowed. */
  async function refuse(request: Request, action: RegistryAction, context?: AuthorizeContext): Promise<Response | null> {
    if (!authorize) {
      if (action === 'read') return null;
      return json(
        {
          error:
            'this registry API has no `authorize` hook, so writes are refused. ' +
            'Publishing changes which fragments compose which pages — wire it to your own session before enabling it.',
        },
        403,
      );
    }

    const outcome = await authorize(request, action, context);
    if (outcome instanceof Response) return outcome;
    return outcome ? null : json({ error: `not authorized to ${action}` }, 403);
  }
}

/** The body as JSON, or a 400 — malformed input is the client's error, not the server's. */
async function readJson<T>(request: Request, limit: number): Promise<T | Response> {
  const tooLarge = () => json({ error: `the request body is larger than ${limit} bytes` }, 413);
  if (Number(request.headers.get('content-length')) > limit) return tooLarge();

  // Read with a running count rather than trusting content-length, which a chunked body omits.
  let text = '';
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return json({ error: 'the request body is not valid JSON' }, 400);
  }
}

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store' },
  });
}

/** A snapshot id as the API mints them — checked before one is echoed into an error or an audit record. */
function isSnapshotId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/**
 * The `error` a refusal carried, for the audit record of why. Read only from a JSON body: an
 * `authorize` hook may return its own Response, and a streamed one must not hold the request open.
 */
async function errorOf(response: Response): Promise<string | undefined> {
  if (!response.headers.get('content-type')?.includes('json')) return undefined;
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return typeof body?.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}
