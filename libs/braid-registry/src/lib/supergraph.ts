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
}

/** A registry source that knows which subgraph it came from. */
export type SubgraphSource = (() => Promise<FragmentManifest[]>) & { readonly subgraphName: string };

const FRAGMENT_NAMESPACE = '/__braid/frag/';

/**
 * A team gateway's fragments, re-pointed so the org gateway proxies to them through the team
 * gateway.
 *
 * Only `endpoint` changes. Paths on the endpoint (`src`, `documentPath`, a relative `entry`) still
 * resolve, because the team gateway strips its namespace prefix before proxying. Routing, access
 * rules and capabilities are the team's to declare and arrive as written.
 */
export function subgraph(options: SubgraphOptions): SubgraphSource {
  const { name } = options;
  const base = options.url.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base) || !URL.canParse(base)) {
    throw new Error(`braid-registry: subgraph "${name}" url "${options.url}" must be an absolute http(s) URL`);
  }

  const load = async (): Promise<FragmentManifest[]> => {
    const manifests = await loadSource(options.registry, `subgraph "${name}"`);
    return manifests.map((manifest) => ({
      ...manifest,
      endpoint: `${base}${FRAGMENT_NAMESPACE}${encodeURIComponent(manifest.id)}/`,
    }));
  };
  return Object.assign(load, { subgraphName: name });
}

/**
 * Composes registry sources — the org's own and any number of `subgraph()`s — into one.
 *
 * Composition fails closed: a fragment id claimed twice is an error naming both owners, because a
 * gateway that silently kept one would serve one team's fragment where another team expected its
 * own. Every other `validateRegistry` error fails it too. Warnings — routes two teams both pierce,
 * say — are logged and composition proceeds, as they would for a single registry.
 *
 * It loads every source each time it is called, and the gateway calls it once. A subgraph that is
 * unreachable then keeps the org registry failing, so in production compose ahead of time and
 * serve the result from a snapshot: `createSnapshot({ manifests: await supergraph([...])() })`,
 * then `snapshotRegistry()` with its last-known-good cache.
 */
export function supergraph(sources: ReadonlyArray<RegistrySource | SubgraphSource>): () => Promise<FragmentManifest[]> {
  return async () => {
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
  };
}

function isSubgraph(source: RegistrySource | SubgraphSource): source is SubgraphSource {
  return typeof source === 'function' && 'subgraphName' in source;
}

/** Loads a registry source the way the gateway's own `Registry` does. */
async function loadSource(source: RegistrySource, owner: string): Promise<FragmentManifest[]> {
  if (typeof source === 'function') return source();
  if (Array.isArray(source)) return source;

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`braid-registry: loading ${owner} from "${source}" failed with HTTP ${response.status}`);
  }
  return (await response.json()) as FragmentManifest[];
}
