import type { FragmentManifest, RegistrySource } from '@braidlabs/gateway';
import { validateRegistry } from './analysis.js';

/**
 * Gateway federation: a team's Braid gateway joins an org gateway as a **subgraph**, and the org
 * gateway serves the composed **supergraph** — every team's fragments in one registry.
 *
 * ```ts
 * createGateway({
 *   registry: supergraph([
 *     orgManifests,
 *     subgraph({ name: 'orders', url: 'https://orders.internal', registry: 'https://orders.internal/braid-registry.json' }),
 *   ]),
 * });
 * ```
 *
 * The idea is Apollo Federation's: flatten at composition time, not at request time. Without it, a
 * team's routes reach the org page as a shell inside a shell — the org pierces the team's shell,
 * whose own `<fragment-slot>`s then ask the *org* origin for fragments it has never heard of. With
 * it, the org gateway knows every fragment in the graph and pierces each one directly: one shell,
 * one piercing pass, one realm per fragment.
 *
 * The team's gateway does not change. Its fragments are reached **through** it, at its raw
 * `/__braid/frag/<id>/` namespace, so team origins stay private to the team's network and the HTML
 * is prepared exactly once, by the org gateway.
 */

type FragmentCapabilities = NonNullable<FragmentManifest['capabilities']>;

export interface SubgraphOptions {
  /** Names this subgraph in composition errors. */
  name: string;
  /**
   * Where the team's gateway is reachable from the org gateway, including its `basePath` if it has
   * one: `https://orders.internal` or `https://orders.internal/team`.
   */
  url: string;
  /**
   * The team's manifests, from any registry source — the array it already passes to
   * `createGateway`, a URL to it, or a `snapshotRegistry()` loader. Endpoints are replaced, so
   * function and private-network endpoints are fine here.
   */
  registry: RegistrySource;
  /**
   * The page paths this subgraph may pierce into, as path prefixes: `['/orders', '/refunds']`.
   *
   * A team's registry is the team's to write, and a pierce pattern decides which org pages its
   * HTML lands in — and, with `forwardCredentials`, which pages send the user's cookies to the
   * team. With `routes`, a pattern outside them fails composition. Without it, only claims on the
   * whole site (`/`, `/*`, a leading parameter) fail.
   */
  routes?: readonly string[];
  /**
   * Capability grants for this subgraph's fragments, by fragment id.
   *
   * Capabilities are host-owned — a grant the grantee can write is not a grant — so whatever the
   * team's registry declares is dropped, and these, written by the org, are what the org serves.
   */
  capabilities?: Readonly<Record<string, FragmentCapabilities>>;
  /** How long to wait for a URL registry before failing composition. Defaults to 5000ms. */
  timeoutMs?: number;
}

/** A registry source that knows which subgraph it came from. */
export type SubgraphSource = (() => Promise<FragmentManifest[]>) & { readonly subgraphName: string };

const FRAGMENT_NAMESPACE = '/__braid/frag/';
const DEFAULT_LOAD_TIMEOUT_MS = 5000;

/**
 * A team gateway's fragments, re-pointed so the org gateway proxies to them through the team
 * gateway.
 *
 * `endpoint` is replaced, and paths on it (`src`, `documentPath`, a relative `entry`) still
 * resolve, because the team gateway strips its namespace prefix before proxying. Routing and
 * access rules are the team's to declare and arrive as written, inside the limits the org sets:
 * pierce patterns must stay within `routes`, `entry` must be relative so module code is served
 * through the same path as everything else, and capabilities come from the org, never the team.
 */
export function subgraph(options: SubgraphOptions): SubgraphSource {
  const { name } = options;
  const owner = `subgraph "${name}"`;
  const base = options.url.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base) || !URL.canParse(base)) {
    throw new Error(`braid-registry: ${owner} url "${options.url}" must be an absolute http(s) URL`);
  }
  const routes = options.routes?.map((route) => route.replace(/\/+$/, '') || '/');

  const load = async (): Promise<FragmentManifest[]> => {
    const manifests = await loadSource(options.registry, owner, options.timeoutMs);
    return manifests.map((manifest) => {
      for (const pattern of manifest.pierce ?? []) {
        const problem = routeProblem(pattern, routes);
        if (problem) {
          throw new Error(`braid-registry: ${owner} fragment "${manifest.id}" pierces "${pattern}", ${problem}`);
        }
      }
      if (manifest.entry !== undefined && /^([a-z][a-z\d+.-]*:|\/\/)/i.test(manifest.entry)) {
        throw new Error(
          `braid-registry: ${owner} fragment "${manifest.id}" declares an absolute entry "${manifest.entry}" — ` +
            `a federated entry must be a path on the fragment's endpoint, so it is served through the org gateway`,
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped: capabilities are the org's to grant
      const { capabilities: _declaredByTeam, ...rest } = manifest;
      const granted = options.capabilities?.[manifest.id];
      return {
        ...rest,
        endpoint: `${base}${FRAGMENT_NAMESPACE}${encodeURIComponent(manifest.id)}/`,
        ...(granted === undefined ? {} : { capabilities: granted }),
      };
    });
  };
  return Object.assign(load, { subgraphName: name });
}

/** Why a subgraph may not pierce `pattern`, or undefined when it may. */
function routeProblem(pattern: string, routes: readonly string[] | undefined): string | undefined {
  if (routes) {
    const allowed = routes.some(
      (route) => route === '/' || pattern === route || pattern.startsWith(`${route}/`),
    );
    return allowed ? undefined : `outside its routes (${routes.join(', ')})`;
  }
  // No declared routes: still refuse a claim on every page of the org's site.
  return pattern === '/' || /^\/[*:(]/.test(pattern)
    ? 'which claims the whole site — declare the subgraph\'s routes to allow it'
    : undefined;
}

/**
 * Composes registry sources — the org's own and any number of `subgraph()`s — into one.
 *
 * Composition fails closed: a fragment id claimed twice is an error naming both owners, because a
 * gateway that silently kept one would serve one team's fragment where another team expected its
 * own. Every other `validateRegistry` error fails it too. Warnings — routes two teams both pierce,
 * say — are logged and composition proceeds, as they would for a single registry.
 *
 * Concurrent calls share one composition, and a failed one is forgotten so the next call retries.
 * The gateway does not cache a failed registry load, so while a subgraph is unreachable every
 * request that needs the registry waits up to the subgraph's timeout and then fails. In
 * production, compose ahead of time and serve the result from a snapshot:
 * `createSnapshot({ manifests: await supergraph([...])() })`, then `snapshotRegistry()` with its
 * last-known-good cache.
 */
export function supergraph(sources: ReadonlyArray<RegistrySource | SubgraphSource>): () => Promise<FragmentManifest[]> {
  let composing: Promise<FragmentManifest[]> | undefined;
  return () => {
    composing ??= compose(sources).catch((error: unknown) => {
      composing = undefined;
      throw error;
    });
    return composing;
  };
}

async function compose(sources: ReadonlyArray<RegistrySource | SubgraphSource>): Promise<FragmentManifest[]> {
  const loaded = await Promise.all(
    sources.map(async (source, index) => {
      const owner = isSubgraph(source) ? `subgraph "${source.subgraphName}"` : `source #${index}`;
      return { owner, manifests: await loadSource(source, owner) };
    }),
  );

  const owners = new Map<string, string>();
  const collisions: string[] = [];
  for (const { owner, manifests } of loaded) {
    for (const { id } of manifests) {
      const first = owners.get(id);
      if (first !== undefined) collisions.push(`fragment id "${id}" is claimed by both ${first} and ${owner}`);
      else owners.set(id, owner);
    }
  }
  if (collisions.length > 0) {
    throw new Error(`braid-registry: supergraph composition failed:\n  ${collisions.join('\n  ')}`);
  }

  const manifests = loaded.flatMap(({ manifests }) => manifests);
  const findings = validateRegistry(manifests);
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `braid-registry: supergraph composition failed:\n  ${errors.map((e) => `${e.code}: ${e.message}`).join('\n  ')}`,
    );
  }
  for (const warning of findings.filter((finding) => finding.severity !== 'error')) {
    console.warn(`braid-registry: supergraph ${warning.code}: ${warning.message}`);
  }

  return manifests;
}

function isSubgraph(source: RegistrySource | SubgraphSource): source is SubgraphSource {
  return typeof source === 'function' && 'subgraphName' in source;
}

/** Loads a registry source the way the gateway's own `Registry` does, but bounded in time and shape. */
async function loadSource(
  source: RegistrySource,
  owner: string,
  timeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
): Promise<FragmentManifest[]> {
  let manifests: unknown;
  if (typeof source === 'function') {
    manifests = await source();
  } else if (Array.isArray(source)) {
    manifests = source;
  } else {
    const response = await fetch(source, { signal: AbortSignal.timeout(timeoutMs) }).catch((error: unknown) => {
      throw new Error(`braid-registry: loading ${owner} from "${source}" failed: ${String(error)}`, { cause: error });
    });
    if (!response.ok) {
      throw new Error(`braid-registry: loading ${owner} from "${source}" failed with HTTP ${response.status}`);
    }
    manifests = await response.json();
  }

  if (!Array.isArray(manifests)) {
    throw new Error(`braid-registry: ${owner} is not an array of fragment manifests`);
  }
  return manifests as FragmentManifest[];
}
