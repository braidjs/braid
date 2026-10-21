import type { DiscoveryEntry } from '@braidlabs/gateway';
import type { ShellManifest } from '@braidlabs/registry';

/**
 * The composition topology of a gateway, derived from a discovery listing.
 *
 * **Why this is not a dependency graph.** Fragments do not import each other — that is the
 * property the whole composition layer exists to provide, and a graph drawing `billing → reviews`
 * edges would be drawing relationships that provably do not exist. What *does* relate fragments is
 * where they compose and what serves them:
 *
 * - a **route** pierces one or more fragments into a page, so fragments sharing a route share a
 *   document, a viewport, and a failure blast radius;
 * - an **origin** serves one or more fragments, so fragments sharing an origin share a deploy.
 *
 * Those are the two real coupling surfaces, and both are already in the listing. Co-occupancy on a
 * route is the same condition the registry's overlap findings warn about, which is why selecting a
 * route here is the visual form of that warning rather than a second opinion about it.
 *
 * Everything is derived from `DiscoveryEntry` alone: no new gateway endpoint, and a production
 * listing that withholds endpoints simply yields a graph without the origin column.
 */

export type TopologyNodeKind = 'shell' | 'route' | 'fragment' | 'origin';

export interface TopologyNode {
  /** Unique within the graph. Prefixed by kind, since a route and an origin can read alike. */
  id: string;
  kind: TopologyNodeKind;
  label: string;
  /** Fragment nodes only: the entry this came from, for the detail panel. */
  entry?: DiscoveryEntry;
  /** Shell nodes only: the shell this came from. */
  shell?: ShellManifest;
  /** How many fragments a route or origin touches. Drives the count badge. */
  degree: number;
  /**
   * Route nodes only: true when more than one fragment pierces this pattern.
   *
   * This is the state worth seeing. One fragment on a route is ordinary; two is a composed page,
   * which is either the intent or the bug the overlap finding reports.
   */
  shared?: boolean;
}

export interface TopologyEdge {
  from: string;
  to: string;
  /**
   * `composes`: a route pierces a fragment (gateway routing). `served-by`: a fragment's origin.
   * `hosts`: a shell declares a route. `slots`: a shell's layout places a fragment on that route.
   */
  kind: 'composes' | 'served-by' | 'hosts' | 'slots';
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** Empty unless shells were given. */
  shells: TopologyNode[];
  routes: TopologyNode[];
  fragments: TopologyNode[];
  origins: TopologyNode[];
  /**
   * Fragments with no pierce pattern at all.
   *
   * Not an error and not a gap in the data: an unbound fragment is a widget — header chrome, a
   * global search box — that appears wherever a host places a slot for it. No route pierces it,
   * so nothing can honestly draw an edge to one, and pretending otherwise would invent placement
   * the gateway never promised.
   */
  unrouted: TopologyNode[];
  /** True when the listing withheld endpoints, so the origin column is unavailable rather than empty. */
  originsUnknown: boolean;
}

export const SHELL_PREFIX = 'shell:';
export const ROUTE_PREFIX = 'route:';
export const FRAGMENT_PREFIX = 'fragment:';
export const ORIGIN_PREFIX = 'origin:';

/**
 * Builds the topology from a listing.
 *
 * Deterministic: routes sort by how many fragments they carry (the shared ones first, since they
 * are what an operator is looking for) and then by name, so a reload does not reshuffle the
 * picture under someone reading it.
 */
export function buildTopology(entries: readonly DiscoveryEntry[], options: { shells?: readonly ShellManifest[] } = {}): Topology {
  const routes = new Map<string, TopologyNode>();
  const origins = new Map<string, TopologyNode>();
  const fragments: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];

  for (const entry of entries) {
    const fragmentId = `${FRAGMENT_PREFIX}${entry.id}`;
    fragments.push({ id: fragmentId, kind: 'fragment', label: entry.id, entry, degree: 0 });

    for (const pattern of entry.pierce ?? []) {
      const routeId = `${ROUTE_PREFIX}${pattern}`;
      const route = routes.get(routeId) ?? { id: routeId, kind: 'route' as const, label: pattern, degree: 0 };
      route.degree += 1;
      routes.set(routeId, route);
      edges.push({ from: routeId, to: fragmentId, kind: 'composes' });
    }

    const origin = originOf(entry.endpoint);
    if (origin) {
      const originId = `${ORIGIN_PREFIX}${origin}`;
      const node = origins.get(originId) ?? { id: originId, kind: 'origin' as const, label: origin, degree: 0 };
      node.degree += 1;
      origins.set(originId, node);
      edges.push({ from: fragmentId, to: originId, kind: 'served-by' });
    }
  }

  // Shells add the layer above routes. A shell's route and a pierce pattern written identically
  // are one node, which is what lets the map show a slotted fragment and its routing side by side.
  // `slots` is drawn only where routing does not already connect the pair.
  const shells: TopologyNode[] = [];
  const known = new Set(fragments.map((fragment) => fragment.id));
  for (const shell of options.shells ?? []) {
    const shellId = `${SHELL_PREFIX}${shell.id}`;
    shells.push({ id: shellId, kind: 'shell', label: shell.id, shell, degree: shell.routes.length });

    for (const route of shell.routes) {
      const routeId = `${ROUTE_PREFIX}${route.path}`;
      if (!routes.has(routeId)) routes.set(routeId, { id: routeId, kind: 'route', label: route.path, degree: 0 });
      edges.push({ from: shellId, to: routeId, kind: 'hosts' });

      for (const fragment of new Set(Object.values(route.slots ?? {}))) {
        const fragmentId = `${FRAGMENT_PREFIX}${fragment}`;
        if (!known.has(fragmentId)) continue;
        if (edges.some((edge) => edge.from === routeId && edge.to === fragmentId)) continue;
        edges.push({ from: routeId, to: fragmentId, kind: 'slots' });
        const node = routes.get(routeId);
        if (node) node.degree += 1;
      }
    }
  }

  for (const route of routes.values()) route.shared = route.degree > 1;

  const routeList = [...routes.values()].sort(byDegreeThenLabel);
  const originList = [...origins.values()].sort(byDegreeThenLabel);
  const fragmentList = [...fragments].sort((a, b) => a.label.localeCompare(b.label));

  for (const fragment of fragmentList) {
    fragment.degree = edges.filter((edge) => edge.to === fragment.id || edge.from === fragment.id).length;
  }

  const routed = new Set(edges.filter((edge) => edge.kind === 'composes').map((edge) => edge.to));
  const shellList = shells.sort((a, b) => a.label.localeCompare(b.label));

  return {
    nodes: [...shellList, ...routeList, ...fragmentList, ...originList],
    edges,
    shells: shellList,
    routes: routeList,
    fragments: fragmentList,
    origins: originList,
    unrouted: fragmentList.filter((fragment) => !routed.has(fragment.id)),
    // No entry carried an endpoint. In production that is the gateway declining to publish them,
    // not an empty deployment — so the column is hidden rather than drawn with nothing in it.
    originsUnknown: entries.length > 0 && originList.length === 0,
  };
}

/**
 * Everything reachable from one node, as a set of node and edge ids.
 *
 * Selection is the graph's primary answer to "what does this touch?", so it walks both directions
 * — a fragment's routes *and* its origin — rather than following edge direction. One hop is
 * deliberate: two hops from a shared route reaches most of the graph and highlights nothing.
 */
export function neighborhood(topology: Topology, nodeId: string | null): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  if (!nodeId) return { nodes, edges };

  nodes.add(nodeId);
  for (const edge of topology.edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    edges.add(edgeKey(edge));
    nodes.add(edge.from);
    nodes.add(edge.to);
  }

  // From a fragment, also reach the fragments it shares a route with — the co-tenants. That is the
  // question a shared route actually raises: "who else is on this page with me?"
  if (nodeId.startsWith(FRAGMENT_PREFIX)) {
    for (const edge of topology.edges) {
      if (edge.kind !== 'composes' || !nodes.has(edge.from)) continue;
      edges.add(edgeKey(edge));
      nodes.add(edge.to);
    }
  }

  // From a shell, reach what it composes: its routes' fragments, however they arrive.
  if (nodeId.startsWith(SHELL_PREFIX)) {
    for (const edge of topology.edges) {
      if ((edge.kind !== 'composes' && edge.kind !== 'slots') || !nodes.has(edge.from)) continue;
      edges.add(edgeKey(edge));
      nodes.add(edge.to);
    }
  }

  return { nodes, edges };
}

export function edgeKey(edge: TopologyEdge): string {
  return `${edge.from}→${edge.to}`;
}

/** The fragments sharing a route with this one, by fragment id. */
export function coTenants(topology: Topology, fragmentId: string): string[] {
  const routes = topology.edges.filter((edge) => edge.kind === 'composes' && edge.to === fragmentId).map((edge) => edge.from);
  const peers = new Set<string>();

  for (const edge of topology.edges) {
    if (edge.kind === 'composes' && routes.includes(edge.from) && edge.to !== fragmentId) peers.add(edge.to);
  }

  return [...peers].sort();
}

/**
 * The host of an endpoint, or null when there is none to show.
 *
 * A listing outside development usually omits `endpoint` entirely, and a manifest may carry a
 * `fetch` function rather than a URL — in both cases there is no origin to draw, which is a
 * different statement from "the origin is unknown" and is why this returns null rather than a
 * placeholder.
 */
function originOf(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

function byDegreeThenLabel(a: TopologyNode, b: TopologyNode): number {
  return b.degree - a.degree || a.label.localeCompare(b.label);
}
