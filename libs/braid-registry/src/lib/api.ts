import type { FragmentManifest } from '@braidlabs/gateway';
import { createSnapshot, type RegistrySnapshot } from './snapshot.js';
import type { SnapshotStore } from './store.js';
import { diffRegistries, validateRegistry, type RegistryFinding } from './analysis.js';
import { fetchDescriptors, mergeDescriptors, type DescriptorNote } from './descriptor.js';
import type { ShellManifest } from './shell.js';

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
  authorize?: (request: Request, action: RegistryAction) => AuthorizeResult | Promise<AuthorizeResult>;
  /**
   * Who is making the request, as the server knows it — an email or subject from a verified token.
   *
   * When present, every publish records it as `labels.publishedBy`, replacing whatever the client
   * sent. Labels are otherwise client-claimed; this is what makes the attribution an audit trail
   * rather than a note.
   */
  identify?: (request: Request) => string | null | undefined | Promise<string | null | undefined>;
  /** Path the API is mounted at. Defaults to `/__braid/registry-api`. */
  basePath?: string;
  /**
   * Whether publishing probes each fragment for a descriptor and merges it (see
   * `descriptor.ts`). Defaults to false: it costs a fanout of requests, and it is only useful once
   * some fragment actually publishes one.
   */
  fetchDescriptors?: boolean;
  fetch?: typeof fetch;
}

export type RegistryAction = 'read' | 'publish' | 'pin';

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
}

export interface PublishResult {
  snapshot: { id: string; createdAt: string; fragmentCount: number };
  findings: RegistryFinding[];
  descriptorNotes: DescriptorNote[];
  pinned: boolean;
  /** What this snapshot changes about the one HEAD pointed at before, when there was one. */
  diff?: ReturnType<typeof diffRegistries>;
}

export interface RegistryApi {
  /** Handles a request if it belongs to this API; returns null otherwise. */
  handle(request: Request): Promise<Response | null>;
}

export function createRegistryApi(options: RegistryApiOptions): RegistryApi {
  const { store, authorize, identify, basePath = '/__braid/registry-api', fetchDescriptors: probe = false } = options;

  return {
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(basePath)) return null;

      const route = url.pathname.slice(basePath.length) || '/';

      // A browser marks a request another site made with Sec-Fetch-Site: cross-site. Refusing those
      // writes closes CSRF for an `authorize` hook that reads a cookie; bearer tokens are immune
      // anyway, and clients that are not browsers do not send the header.
      if (request.method === 'POST' && request.headers.get('sec-fetch-site') === 'cross-site') {
        return json({ error: 'cross-site writes are refused' }, 403);
      }

      try {
        if (request.method === 'GET' && route === '/snapshots') return await listSnapshots(request, url);
        if (request.method === 'GET' && route.startsWith('/snapshots/')) {
          return await getSnapshot(request, decodeURIComponent(route.slice('/snapshots/'.length)));
        }
        if (request.method === 'GET' && route === '/head') return await getHead(request);
        if (request.method === 'GET' && route === '/permissions') return await permissions(request);
        if (request.method === 'POST' && route === '/snapshots') return await publish(request);
        if (request.method === 'POST' && route === '/head') return await pin(request);

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
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 25;

    return json({ items: await store.list({ limit }), head: (await store.head?.()) ?? null });
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
  async function publish(request: Request): Promise<Response> {
    const denied = await refuse(request, 'publish');
    if (denied) return denied;

    const body = await readJson<PublishRequestBody>(request);
    if (body instanceof Response) return body;
    if (!Array.isArray(body?.manifests)) {
      return json({ error: 'expected { manifests: FragmentManifest[] }' }, 400);
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
    const findings = validateRegistry(manifests, { shells });
    if (findings.some((finding) => finding.severity === 'error')) {
      // Nothing is written, so nothing needs undoing — the snapshot model makes refusal cheap.
      return json({ error: 'the registry has errors and was not published', findings, descriptorNotes }, 422);
    }

    const labels = identify ? await attributed(request, body.labels) : body.labels;

    const snapshot = await createSnapshot({
      manifests,
      shells,
      ...(labels ? { labels } : {}),
    });
    await store.put(snapshot);

    // Checked again just before moving HEAD: descriptor probes above can take seconds, and another
    // publish may have pinned meanwhile. The snapshot stays stored either way — it is immutable and
    // unpinned, so harmless. This narrows the window to two store calls; it does not close it,
    // which needs a compare-and-set in the store.
    if (shouldPin && body.baseId !== undefined) {
      const current = (await store.head?.()) ?? null;
      if (current !== previousId) {
        return json({ error: `HEAD moved to ${current ?? 'nothing'} while publishing — reload before publishing`, head: current }, 409);
      }
    }

    if (shouldPin) await store.setHead?.(snapshot.id);

    const result: PublishResult = {
      snapshot: { id: snapshot.id, createdAt: snapshot.createdAt, fragmentCount: snapshot.manifests.length },
      findings,
      descriptorNotes,
      pinned: shouldPin,
      ...(previous ? { diff: diffRegistries(previous.manifests, snapshot.manifests) } : {}),
    };

    return json(result, 201);
  }

  async function pin(request: Request): Promise<Response> {
    const denied = await refuse(request, 'pin');
    if (denied) return denied;

    const body = await readJson<{ id?: string }>(request);
    if (body instanceof Response) return body;
    const id = body?.id;
    if (!id) return json({ error: 'expected { id }' }, 400);

    const snapshot: RegistrySnapshot | null = await store.get(id);
    if (!snapshot) return json({ error: `no snapshot "${id}" — cannot pin what is not stored` }, 404);

    if (!store.setHead) return json({ error: 'this store does not track a head' }, 501);
    await store.setHead(id);

    return json({ id, pinned: true });
  }

  /**
   * Labels with `publishedBy` owned by the server: set to the verified actor, and never taken from
   * the client — not even when the server cannot identify the caller, since a claimed author on an
   * anonymous publish is exactly the forgery this exists to prevent.
   */
  async function attributed(request: Request, labels: Record<string, string> | undefined): Promise<Record<string, string> | undefined> {
    const rest = Object.fromEntries(Object.entries(labels ?? {}).filter(([key]) => key !== 'publishedBy'));
    const actor = (await identify?.(request)) ?? null;
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
    };
    return json(result);
  }

  /** Returns a refusal response, or null when the action is allowed. */
  async function refuse(request: Request, action: RegistryAction): Promise<Response | null> {
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

    const outcome = await authorize(request, action);
    if (outcome instanceof Response) return outcome;
    return outcome ? null : json({ error: `not authorized to ${action}` }, 403);
  }
}

/** The body as JSON, or a 400 — malformed input is the client's error, not the server's. */
async function readJson<T>(request: Request): Promise<T | Response> {
  try {
    return (await request.json()) as T;
  } catch {
    return json({ error: 'the request body is not valid JSON' }, 400);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store' },
  });
}
