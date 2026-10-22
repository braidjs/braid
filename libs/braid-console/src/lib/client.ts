import type { DiscoveryEntry, DiscoveryPage, FragmentManifest } from '@braidlabs/gateway';
import type {
  DescriptorNote,
  RegistryDiff,
  RegistryFinding,
  RegistryPermissions,
  ShellManifest,
  SnapshotRef,
} from '@braidlabs/registry';

/**
 * How the console reaches a gateway.
 *
 * Identity belongs to the host, exactly as it does for the gateway's own `principal` resolver:
 * this takes a base URL and a headers hook (or a whole `fetch`) and never performs a login. A
 * console mounted inside an internal admin app should inherit that app's session, not open a
 * second one.
 */
export interface ConsoleApi {
  /** Where the gateway is. Defaults to the page's own origin. */
  baseUrl?: string;
  /** Path of the discovery listing. Defaults to `/__braid/registry`. */
  discoveryPath?: string;
  /**
   * Path the registry write API is mounted at. Defaults to `/__braid/registry-api`.
   *
   * Editing needs this API; the read-only console does not. A gateway that has not mounted one is
   * simply not editable, which is the common case and not an error.
   */
  apiPath?: string;
  /** Called before every request, so a short-lived token can be refreshed by the host. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Full override, for hosts with their own fetch wrapper (retries, tracing, mTLS). */
  fetch?: typeof fetch;
}

export const DEFAULT_DISCOVERY_PATH = '/__braid/registry';

export interface RegistryListing {
  entries: DiscoveryEntry[];
  total: number;
  /** True when the gateway is in development mode and skipped access filtering. */
  unfiltered: boolean;
  protocolVersion: string;
}

/**
 * Reads a gateway's registry listing, following pagination to the end.
 *
 * The listing is what the *caller* may see — the gateway filters by `access.list` — so a console
 * showing fewer fragments than the operator expects is usually correct and worth surfacing rather
 * than hiding. {@link RegistryListing.unfiltered} distinguishes "you are seeing everything because
 * this gateway is in development" from "you are seeing what you are allowed to see".
 */
export async function fetchRegistry(api: ConsoleApi = {}, signal?: AbortSignal): Promise<RegistryListing> {
  const doFetch = api.fetch ?? globalThis.fetch;
  const base = api.baseUrl?.replace(/\/$/, '') ?? '';
  const path = api.discoveryPath ?? DEFAULT_DISCOVERY_PATH;

  const entries: DiscoveryEntry[] = [];
  let page = 1;
  let last: DiscoveryPage | undefined;

  do {
    const url = `${base}${path}?page=${page}`;
    const response = await doFetch(url, {
      headers: { accept: 'application/json', ...(await resolveHeaders(api)) },
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) throw new RegistryFetchError(url, response.status);

    last = (await response.json()) as DiscoveryPage;
    entries.push(...last.items);
    page += 1;
    // guard against a gateway that reports hasMore forever
  } while (last.hasMore && page <= last.totalPages && page < 1000);

  return {
    entries,
    total: last?.total ?? entries.length,
    unfiltered: last?.unfiltered === true,
    protocolVersion: last?.protocolVersion ?? 'unknown',
  };
}

export class RegistryFetchError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(
      status === 404
        ? `No registry at ${url}. Discovery is off unless the gateway is configured with it — pass \`discovery\` to createGateway.`
        : status === 401 || status === 403
          ? `Not authorized to list the registry at ${url}.`
          : `Reading the registry at ${url} failed with HTTP ${status}.`,
    );
    this.name = 'RegistryFetchError';
  }
}

async function resolveHeaders(api: ConsoleApi): Promise<Record<string, string>> {
  return api.headers ? await api.headers() : {};
}

// ---------------------------------------------------------------------------
// Write API — only needed for editing
// ---------------------------------------------------------------------------

export const DEFAULT_API_PATH = '/__braid/registry-api';

export interface HeadState {
  id: string | null;
  snapshot: {
    id: string;
    createdAt: string;
    manifests: FragmentManifest[];
    /** Absent when the snapshot has no shells, and from servers that predate them. */
    shells?: ShellManifest[];
    labels?: Record<string, string>;
  } | null;
}

export interface PublishOutcome {
  snapshot: { id: string; createdAt: string; fragmentCount: number };
  findings: RegistryFinding[];
  descriptorNotes: DescriptorNote[];
  pinned: boolean;
  diff?: RegistryDiff;
}

/** The currently pinned snapshot, or `{ id: null }` when nothing has been published. */
export async function fetchHead(api: ConsoleApi = {}, signal?: AbortSignal): Promise<HeadState> {
  return apiRequest<HeadState>(api, '/head', { method: 'GET' }, signal);
}

export async function listSnapshots(api: ConsoleApi = {}, signal?: AbortSignal): Promise<{ items: SnapshotRef[]; head: string | null }> {
  return apiRequest(api, '/snapshots', { method: 'GET' }, signal);
}

/**
 * Publishes a draft.
 *
 * The server re-validates whatever arrives, so a 422 here is not a client bug — it is the
 * authoritative check disagreeing with the optimistic one, and its findings are what to show.
 */
export async function publishSnapshot(
  api: ConsoleApi,
  body: {
    manifests: FragmentManifest[];
    /** Omit to keep HEAD's shells; `[]` removes them. */
    shells?: ShellManifest[];
    labels?: Record<string, string>;
    pin?: boolean;
    /** The id the draft started from; the server refuses with 409 if HEAD has moved since. */
    baseId?: string | null;
  },
): Promise<PublishOutcome> {
  return apiRequest<PublishOutcome>(api, '/snapshots', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * What the signed-in caller may do, so the UI offers only what will work. The server still
 * decides every request; this is advice for drawing buttons.
 *
 * A server too old to have the endpoint answers 404, and that reads as "everything allowed": the
 * server will refuse what it refuses, which is the behavior such a server always had.
 */
export async function fetchPermissions(api: ConsoleApi = {}, signal?: AbortSignal): Promise<RegistryPermissions> {
  try {
    return await apiRequest<RegistryPermissions>(api, '/permissions', { method: 'GET' }, signal);
  } catch (error) {
    if (error instanceof RegistryApiError && error.status === 404) return { read: true, publish: true, pin: true, actor: null, tags: null };
    throw error;
  }
}

/** An environment as `GET /environments` describes it. */
export interface EnvironmentState {
  name: string;
  from: string | null;
  approvals: number;
  id: string | null;
  pending: { id: string; base: string | null; requestedBy: string; requestedAt: string } | null;
}

/**
 * The registry's environments. A server with none — or too old to have them — answers 404, which
 * reads as an empty list: there is nothing to promote to.
 */
export async function fetchEnvironments(api: ConsoleApi = {}, signal?: AbortSignal): Promise<EnvironmentState[]> {
  try {
    return (await apiRequest<{ items: EnvironmentState[] }>(api, '/environments', { method: 'GET' }, signal)).items;
  } catch (error) {
    if (error instanceof RegistryApiError && error.status === 404) return [];
    throw error;
  }
}

/** Promotes a snapshot into an environment; `pending` when the environment needs approval. */
export async function promoteSnapshot(api: ConsoleApi, environment: string, id: string): Promise<{ pending?: unknown }> {
  return apiRequest(api, `/environments/${encodeURIComponent(environment)}/promote`, { method: 'POST', body: JSON.stringify({ id }) });
}

/**
 * Approves the promotion the approver was shown. The server refuses (409) if what is pending is
 * not that one any more, so an approval cannot land on a request swapped in after review.
 */
export async function approvePromotion(api: ConsoleApi, environment: string, shown: { id: string; requestedAt: string }): Promise<void> {
  await apiRequest(api, `/environments/${encodeURIComponent(environment)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ id: shown.id, requestedAt: shown.requestedAt }),
  });
}

export async function rejectPromotion(api: ConsoleApi, environment: string): Promise<void> {
  await apiRequest(api, `/environments/${encodeURIComponent(environment)}/reject`, { method: 'POST', body: '{}' });
}

/** Re-points HEAD. Rollback is this and nothing else. */
export async function pinSnapshot(api: ConsoleApi, id: string): Promise<void> {
  await apiRequest(api, '/head', { method: 'POST', body: JSON.stringify({ id }) });
}

export class RegistryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly findings: RegistryFinding[] = [],
    readonly descriptorNotes: DescriptorNote[] = [],
  ) {
    super(message);
    this.name = 'RegistryApiError';
  }
}

async function apiRequest<T>(api: ConsoleApi, route: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const doFetch = api.fetch ?? globalThis.fetch;
  const base = api.baseUrl?.replace(/\/$/, '') ?? '';
  const url = `${base}${api.apiPath ?? DEFAULT_API_PATH}${route}`;

  const response = await doFetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(await resolveHeaders(api)),
    },
    ...(signal ? { signal } : {}),
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    throw new RegistryApiError(
      typeof body.error === 'string' ? body.error : `HTTP ${response.status} from ${url}`,
      response.status,
      (body.findings as RegistryFinding[]) ?? [],
      (body.descriptorNotes as DescriptorNote[]) ?? [],
    );
  }

  return body as T;
}
