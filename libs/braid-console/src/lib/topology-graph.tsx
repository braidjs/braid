import { useMemo, useState } from 'react';
import type { DiscoveryEntry } from '@braidlabs/gateway';
import type { ShellManifest } from '@braidlabs/registry';
import {
  buildTopology,
  coTenants,
  edgeKey,
  neighborhood,
  type Topology,
  type TopologyNode,
} from './topology.js';

export interface TopologyGraphProps {
  entries: readonly DiscoveryEntry[];
  /** Adds a shells column on the left, with the routes they host and the fragments they slot. */
  shells?: readonly ShellManifest[];
  /** Notified when the selection changes, so a host can drive its own detail pane. */
  onSelect?: (entry: DiscoveryEntry | null) => void;
  /** Asked to show the embed snippet for a fragment. */
  onEmbed?: (entry: DiscoveryEntry) => void;
}

/**
 * The composition topology, drawn as columns: (shells →) routes → fragments → origins.
 *
 * **Laid out, not simulated.** A force-directed graph looks impressive and answers no question: it
 * settles somewhere different every load, so an operator cannot learn its shape, point at it in a
 * review, or compare two screenshots. Columns are stable, and the only thing a reader has to
 * understand is that edges go left to right. It also means no layout library, which is what keeps
 * this inside the console's size budget.
 *
 * Rendered as inline SVG with the console's own custom properties, so it themes with everything
 * else and needs no canvas, no measurement pass, and no resize observer.
 */
export function TopologyGraph({ entries, shells, onSelect, onEmbed }: TopologyGraphProps) {
  const topology = useMemo(() => buildTopology(entries, shells ? { shells } : {}), [entries, shells]);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const active = hovered ?? selected;
  const lit = useMemo(() => neighborhood(topology, active), [topology, active]);

  const layout = useMemo(() => layoutTopology(topology), [topology]);

  function select(node: TopologyNode | null): void {
    const next = node && node.id !== selected ? node.id : null;
    setSelected(next);
    const entry = next && node?.kind === 'fragment' ? (node.entry ?? null) : null;
    onSelect?.(entry);
  }

  if (topology.fragments.length === 0) {
    return <p className="braid-console__empty">Nothing is registered, so there is no topology to draw.</p>;
  }

  const selectedNode = topology.nodes.find((node) => node.id === selected) ?? null;

  return (
    <div className="braid-console__graphwrap">
      <div className="braid-console__graphmain">
        {/* Placed by the same geometry as the columns, so a heading sits over its column however
            many columns there are. */}
        <div className="braid-console__collabels" aria-hidden="true">
          {columnLabels(topology).map((text, index) => (
            <span
              key={text}
              style={{ left: `${((index * (NODE_W + COL_GAP)) / layout.width) * 100}%`, width: `${(NODE_W / layout.width) * 100}%` }}
            >
              {text}
            </span>
          ))}
        </div>

        <svg
          className="braid-console__graph"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label="Composition topology: routes, the fragments they compose, and the origins serving them"
          style={{ height: `${layout.height}px` }}
        >
          <g className="braid-console__edges">
            {layout.edges.map((edge) => (
              <path
                key={edge.key}
                d={edge.d}
                className={`braid-console__edge braid-console__edge--${edge.kind}${
                  active ? (lit.edges.has(edge.key) ? ' is-lit' : ' is-dim') : ''
                }`}
              />
            ))}
          </g>

          {layout.nodes.map((placed) => {
            const dimmed = active && !lit.nodes.has(placed.node.id);
            return (
              <g
                key={placed.node.id}
                className={`braid-console__node braid-console__node--${placed.node.kind}${
                  dimmed ? ' is-dim' : ''
                }${placed.node.id === selected ? ' is-selected' : ''}${
                  placed.node.shared ? ' is-shared' : ''
                }`}
                transform={`translate(${placed.x}, ${placed.y})`}
                tabIndex={0}
                role="button"
                aria-pressed={placed.node.id === selected}
                aria-label={describe(placed.node, topology)}
                onMouseEnter={() => setHovered(placed.node.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(placed.node.id)}
                onBlur={() => setHovered(null)}
                onClick={() => select(placed.node)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  select(placed.node);
                }}
              >
                <rect className="braid-console__nodebox" width={NODE_W} height={NODE_H} rx="4" />
                <text className="braid-console__nodelabel" x="10" y={NODE_H / 2 + 4}>
                  {truncate(placed.node.label)}
                </text>
                {placed.node.kind !== 'fragment' && (
                  <text className="braid-console__nodecount" x={NODE_W - 10} y={NODE_H / 2 + 4} textAnchor="end">
                    {placed.node.degree}
                  </text>
                )}
                {placed.node.kind === 'fragment' && placed.node.entry?.loadable === false && (
                  <circle className="braid-console__nodegate" cx={NODE_W - 12} cy={NODE_H / 2} r="3.5" />
                )}
              </g>
            );
          })}
        </svg>

        {topology.unrouted.length > 0 && (
          <p className="braid-console__graphnote">
            <strong>{topology.unrouted.length}</strong> unbound{' '}
            {topology.unrouted.length === 1 ? 'fragment' : 'fragments'} ({topology.unrouted.map((n) => n.label).join(', ')}
            ) — widgets with no pierce pattern, placed by whichever host asks for them. No route
            claims them, so nothing here can honestly draw one.
          </p>
        )}
        {topology.originsUnknown && (
          <p className="braid-console__graphnote">
            This listing does not publish endpoints, so origins are not shown. That is a production
            gateway behaving correctly, not missing data.
          </p>
        )}
      </div>

      <TopologyDetail node={selectedNode} topology={topology} onClear={() => select(null)} onEmbed={onEmbed} />
    </div>
  );
}

function TopologyDetail({
  node,
  topology,
  onClear,
  onEmbed,
}: {
  node: TopologyNode | null;
  topology: Topology;
  onClear: () => void;
  onEmbed?: (entry: DiscoveryEntry) => void;
}) {
  if (!node) {
    return (
      <aside className="braid-console__detail braid-console__detail--empty">
        <p>Select a node to see what it touches.</p>
        <p className="braid-console__detailhint">
          A route lit with more than one fragment is a composed page: those fragments share a
          document and a blast radius.
        </p>
      </aside>
    );
  }

  const peers = node.kind === 'fragment' ? coTenants(topology, node.id) : [];
  const connected = topology.edges
    .filter((edge) => edge.from === node.id || edge.to === node.id)
    .map((edge) => (edge.from === node.id ? edge.to : edge.from));

  return (
    <aside className="braid-console__detail">
      <div className="braid-console__detailhead">
        <span className={`braid-console__kind braid-console__kind--${node.kind}`}>{node.kind}</span>
        <button type="button" className="braid-console__detailclose" onClick={onClear} aria-label="Clear selection">
          ✕
        </button>
      </div>
      <h3 className="braid-console__detailtitle">{node.label}</h3>

      {node.entry && (
        <>
          {node.entry.title !== node.entry.id && <p className="braid-console__detaildesc">{node.entry.title}</p>}
          {node.entry.description && <p className="braid-console__detaildesc">{node.entry.description}</p>}
          <dl className="braid-console__props">
            <dt>Adapter</dt>
            <dd className="braid-console__mono">{node.entry.adapter}</dd>
            <dt>Mount</dt>
            <dd className="braid-console__mono">{node.entry.mount}</dd>
            {node.entry.contractVersion && (
              <>
                <dt>Contract</dt>
                <dd className="braid-console__mono">v{node.entry.contractVersion}</dd>
              </>
            )}
            <dt>Access</dt>
            <dd>
              <span
                className={`braid-console__badge braid-console__badge--${node.entry.loadable ? 'loadable' : 'gated'}`}
              >
                {node.entry.loadable ? 'loadable' : 'gated'}
              </span>
            </dd>
          </dl>
        </>
      )}

      {node.kind === 'fragment' && node.entry && onEmbed && (
        <div className="braid-console__detailsection">
          <button type="button" className="braid-console__ghost" onClick={() => onEmbed(node.entry!)}>
            Embed this fragment
          </button>
        </div>
      )}

      {node.kind === 'fragment' && (
        <div className="braid-console__detailsection">
          <h4>Shares a page with</h4>
          {peers.length === 0 ? (
            <p className="braid-console__detaildesc">
              Nothing. This fragment is alone on every route it pierces.
            </p>
          ) : (
            <ul className="braid-console__peerlist">
              {peers.map((peer) => (
                <li key={peer} className="braid-console__mono">
                  {label(topology, peer)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {node.kind !== 'fragment' && (
        <div className="braid-console__detailsection">
          <h4>{node.kind === 'shell' ? 'Hosts' : node.kind === 'route' ? 'Composes' : 'Serves'}</h4>
          <ul className="braid-console__peerlist">
            {connected.map((id) => (
              <li key={id} className="braid-console__mono">
                {label(topology, id)}
              </li>
            ))}
          </ul>
          {node.kind === 'route' && node.shared && (
            <p className="braid-console__detailwarn">
              More than one fragment pierces this pattern. Intentional when the page composes both;
              a mistake when one pattern is wider than intended.
            </p>
          )}
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const NODE_W = 150;
const NODE_H = 26;
const ROW_GAP = 10;
const COL_GAP = 96;
const PAD = 8;

interface PlacedNode {
  node: TopologyNode;
  x: number;
  y: number;
}

interface PlacedEdge {
  key: string;
  d: string;
  kind: string;
}

/**
 * Places nodes in columns and routes edges as horizontal cubic curves.
 *
 * Columns are centred against the tallest one so short columns do not sit at the top with a gulf
 * beneath them. Edges leave the right face of one node and enter the left face of the next, with
 * control points at the midpoint — the standard flow-diagram curve, which reads as a connection
 * without implying direction the way an arrowhead would.
 */
export function layoutTopology(topology: Topology): {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
} {
  const columns: TopologyNode[][] = [
    ...(topology.shells?.length ? [topology.shells] : []),
    topology.routes,
    topology.fragments,
    ...(topology.originsUnknown ? [] : [topology.origins]),
  ];

  const tallest = Math.max(1, ...columns.map((column) => column.length));
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP;
  const width = columns.length * NODE_W + (columns.length - 1) * COL_GAP;

  const placed: PlacedNode[] = [];
  const position = new Map<string, { x: number; y: number }>();

  columns.forEach((column, columnIndex) => {
    const span = column.length * NODE_H + Math.max(0, column.length - 1) * ROW_GAP;
    const top = (height - span) / 2;
    const x = columnIndex * (NODE_W + COL_GAP);

    column.forEach((node, rowIndex) => {
      const y = top + rowIndex * (NODE_H + ROW_GAP);
      placed.push({ node, x, y });
      position.set(node.id, { x, y });
    });
  });

  const edges: PlacedEdge[] = [];
  for (const edge of topology.edges) {
    const from = position.get(edge.from);
    const to = position.get(edge.to);
    if (!from || !to) continue;

    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;

    edges.push({
      key: edgeKey(edge),
      kind: edge.kind,
      d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
    });
  }

  return { nodes: placed, edges, width, height };
}

function columnLabels(topology: Topology): string[] {
  return [...(topology.shells?.length ? ['Shells'] : []), 'Routes', 'Fragments', ...(topology.originsUnknown ? [] : ['Origins'])];
}

function describe(node: TopologyNode, topology: Topology): string {
  if (node.kind === 'fragment') {
    const peers = coTenants(topology, node.id).length;
    return `Fragment ${node.label}${peers > 0 ? `, shares a page with ${peers} other` : ''}`;
  }
  if (node.kind === 'route') {
    return `Route ${node.label}, composes ${node.degree} fragment${node.degree === 1 ? '' : 's'}`;
  }
  if (node.kind === 'shell') {
    return `Shell ${node.label}, hosts ${node.degree} route${node.degree === 1 ? '' : 's'}`;
  }
  return `Origin ${node.label}, serves ${node.degree} fragment${node.degree === 1 ? '' : 's'}`;
}

function label(topology: Topology, nodeId: string): string {
  return topology.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}

/** Keeps a long pattern from spilling out of its box; the full value is in the detail panel. */
function truncate(value: string, max = 20): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
