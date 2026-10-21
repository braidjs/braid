import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiscoveryEntry } from '@braidlabs/gateway';
import type { ShellManifest } from '@braidlabs/registry';
import { fetchRegistry, type ConsoleApi, type RegistryListing } from './client.js';
import { ensureStyles } from './styles.js';
import { buildTopology } from './topology.js';
import { TopologyGraph } from './topology-graph.js';
import { IntegrationPanel } from './integration-panel.js';
import { filterBy, fragmentItem } from './query.js';
import { TagChip } from './tag-chip.js';

export interface RegistryConsoleProps {
  /** How to reach the gateway. Defaults to this origin's `/__braid/registry`. */
  api?: ConsoleApi;
  /**
   * Force a theme. Omit to follow the viewer's OS setting — which is right for a standalone
   * deployment and usually wrong inside an admin shell that has already made the choice.
   */
  theme?: 'light' | 'dark';
  /** Extra class on the root, for hosts that want to size or position it. */
  className?: string;
  /** Called whenever a listing loads, for hosts that want their own chrome (counts, timestamps). */
  onLoaded?: (listing: RegistryListing) => void;
  /**
   * Hide the title bar, for a host that already renders its own page heading.
   *
   * Defaults to showing it, because the standalone deployment is a whole page and a page with no
   * title is disorienting. An admin shell embedding this usually has a heading already, and two
   * competing ones read as a bug.
   */
  chrome?: boolean;
  /**
   * Which panel to show, when the host wants to own the tab strip.
   *
   * Uncontrolled by default — the console renders its own tabs, which is what a library embedder
   * dropping it into a page wants. A host that has its own chrome (or that deep-links views into
   * its router) passes this and renders the switcher itself, rather than ending up with two rows
   * of tabs disagreeing about which one is selected.
   */
  view?: ConsoleView;
  /**
   * Shells to draw on the topology, from the pinned snapshot. The discovery listing this console
   * reads knows only fragments, so a host with the write API passes them in.
   */
  shells?: readonly ShellManifest[];
}

export type ConsoleView = 'fragments' | 'topology';

type State =
  | { status: 'loading' }
  | { status: 'ready'; listing: RegistryListing }
  | { status: 'error'; error: Error };

/**
 * A read-only view of what a gateway has registered.
 *
 * **Needs nothing deployed.** It reads the discovery endpoint the gateway already serves, so it
 * works against a gateway whose manifests are defined in code — which is every gateway today. No
 * snapshot store, no write API.
 *
 * What it deliberately does not do: own the URL, own a session, or style anything outside itself.
 * See `styles.ts` for the second, and `ConsoleApi` for the first two.
 */
export function RegistryConsole({ api, theme, className, onLoaded, chrome = true, view, shells }: RegistryConsoleProps) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [ownTab, setOwnTab] = useState<ConsoleView>('fragments');
  const tab = view ?? ownTab;
  const [reloadToken, setReloadToken] = useState(0);
  /** The fragment whose embed snippet is open, if any. */
  const [embedding, setEmbedding] = useState<DiscoveryEntry | null>(null);

  // The api object is usually an inline literal, so a new identity every render. Depending on it
  // directly would refetch forever; these fields are what actually determine the request.
  const apiKey = `${api?.baseUrl ?? ''}|${api?.discoveryPath ?? ''}`;

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;

    setState({ status: 'loading' });
    fetchRegistry(api, controller.signal).then(
      (listing) => {
        if (!current) return;
        setState({ status: 'ready', listing });
        onLoaded?.(listing);
      },
      (error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      },
    );

    return () => {
      current = false;
      controller.abort();
    };
    // Deliberately not exhaustive: `apiKey` stands in for the api object (see above), and
    // `onLoaded` is a notification — depending on it would retrigger the fetch that produced it.
  }, [apiKey, reloadToken]);

  const entries = state.status === 'ready' ? state.listing.entries : [];
  const visible = useMemo(() => filterEntries(entries, query), [entries, query]);

  // The graph reads the *filtered* set, so the search box narrows both views the same way. A graph
  // that ignored the filter would contradict the table sitting one tab away from it.
  const topology = useMemo(() => buildTopology(visible), [visible]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return (
    <div className={`braid-console${className ? ` ${className}` : ''}`} {...(theme ? { 'data-theme': theme } : {})}>
      {state.status === 'error' ? (
        <ErrorPanel error={state.error} onRetry={reload} />
      ) : (
        <div className="braid-console__shell">
          {chrome && (
            <div className="braid-console__titlebar">
              <h2 className="braid-console__producttitle">Fragment registry</h2>
              <span className="braid-console__breadcrumb">
                <span aria-hidden="true">·</span>
                <code>{api?.baseUrl || 'this origin'}</code>
                {state.status === 'ready' && <span>protocol {state.listing.protocolVersion}</span>}
              </span>
            </div>
          )}

          <div className="braid-console__commandbar">
            {view === undefined && (
            <div className="braid-console__tabs" role="tablist" aria-label="Registry views">
              <button
                type="button"
                role="tab"
                className="braid-console__tab"
                aria-selected={tab === 'fragments'}
                onClick={() => setOwnTab('fragments')}
              >
                Fragments
                <span className="braid-console__tabcount">{visible.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                className="braid-console__tab"
                aria-selected={tab === 'topology'}
                onClick={() => setOwnTab('topology')}
              >
                Topology
                <span className="braid-console__tabcount">{topology.routes.length}</span>
              </button>
            </div>
            )}

            <span className="braid-console__spacer" />

            <button type="button" className="braid-console__command" onClick={reload} disabled={state.status === 'loading'}>
              <span className="braid-console__commandicon" aria-hidden="true">
                ⟳
              </span>
              {state.status === 'loading' ? 'Refreshing…' : 'Refresh'}
            </button>
            <span className="braid-console__commandsep" aria-hidden="true" />
            <input
              className="braid-console__search"
              type="search"
              value={query}
              placeholder="Filter — text, or tag:finance is:gated route:/billing/*"
              aria-label="Filter fragments"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {state.status === 'ready' && <StatStrip listing={state.listing} entries={visible} topology={topology} />}

          {state.status === 'ready' && state.listing.unfiltered && (
            <p className="braid-console__notice" role="status">
              <span aria-hidden="true">◆</span>
              <span>
                This gateway is in <strong>development mode</strong>, so the listing skips access filtering and may
                include endpoints. A production gateway shows only what the caller may list.
              </span>
            </p>
          )}

          {state.status === 'loading' ? (
            <p className="braid-console__empty">Loading the registry…</p>
          ) : visible.length === 0 ? (
            <p className="braid-console__empty">
              {entries.length === 0 ? 'No fragments are registered.' : `Nothing matches “${query}”.`}
            </p>
          ) : tab === 'fragments' ? (
            <FragmentTable entries={visible} onEmbed={setEmbedding} onTag={(tag) => setQuery(tagQuery(tag))} />
          ) : (
            <TopologyGraph entries={visible} {...(shells ? { shells } : {})} onEmbed={setEmbedding} />
          )}

          {embedding && <IntegrationPanel entry={embedding} onClose={() => setEmbedding(null)} />}
        </div>
      )}
    </div>
  );
}

/**
 * The four numbers worth reading before scrolling.
 *
 * "Shared routes" earns its place over a prettier metric because it is the only one that can be
 * wrong: it counts pages where two fragments compose, which is either the design or the overlap
 * bug, and an operator who does not know which should be looking.
 */
function StatStrip({
  listing,
  entries,
  topology,
}: {
  listing: RegistryListing;
  entries: readonly DiscoveryEntry[];
  topology: ReturnType<typeof buildTopology>;
}) {
  const shared = topology.routes.filter((route) => route.shared).length;
  const gated = entries.filter((entry) => !entry.loadable).length;

  return (
    <div className="braid-console__stats">
      <div className="braid-console__stat">
        <span className="braid-console__statvalue">{listing.total}</span>
        <span className="braid-console__statlabel">Fragments registered</span>
      </div>
      <div className="braid-console__stat">
        <span className="braid-console__statvalue">{topology.routes.length}</span>
        <span className="braid-console__statlabel">Route patterns</span>
      </div>
      <div className={`braid-console__stat${shared > 0 ? ' braid-console__stat--warn' : ''}`}>
        <span className="braid-console__statvalue">{shared}</span>
        <span className="braid-console__statlabel">Shared routes</span>
      </div>
      <div className="braid-console__stat">
        <span className="braid-console__statvalue">{gated}</span>
        <span className="braid-console__statlabel">Gated for you</span>
      </div>
    </div>
  );
}

function FragmentTable({
  entries,
  onEmbed,
  onTag,
}: {
  entries: DiscoveryEntry[];
  onEmbed: (entry: DiscoveryEntry) => void;
  onTag: (tag: string) => void;
}) {
  return (
    <table className="braid-console__table">
      <thead>
        <tr>
          <th scope="col">Fragment</th>
          <th scope="col">Adapter</th>
          <th scope="col">Pierces</th>
          <th scope="col">Mount</th>
          <th scope="col">Access</th>
          <th scope="col">
            <span className="braid-console__sronly">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id}>
            <td>
              <div className="braid-console__id">{entry.id}</div>
              {entry.title !== entry.id && <div className="braid-console__desc">{entry.title}</div>}
              {entry.description && <div className="braid-console__desc">{entry.description}</div>}
              {entry.tags?.map((tag) => (
                <TagChip tag={tag} key={tag} onSelect={onTag} />
              ))}
            </td>
            <td className="braid-console__mono">{entry.adapter}</td>
            <td>
              <div className="braid-console__patterns">
                {entry.pierce?.length ? (
                  entry.pierce.map((pattern) => (
                    <span className="braid-console__mono" key={pattern}>
                      {pattern}
                    </span>
                  ))
                ) : (
                  <span className="braid-console__mono">—</span>
                )}
              </div>
            </td>
            <td className="braid-console__mono">{entry.mount}</td>
            <td>
              {/* `loadable` is this caller's permission, not a property of the fragment: listing
                  and loading are separate rules, so "listed but gated" is a real, legitimate state
                  rather than a broken row. */}
              <span
                className={`braid-console__badge braid-console__badge--${entry.loadable ? 'loadable' : 'gated'}`}
                title={entry.loadable ? 'You may load this fragment' : 'Listed, but you may not load it'}
              >
                {entry.loadable ? 'loadable' : 'gated'}
              </span>
            </td>
            <td>
              <button
                type="button"
                className="braid-console__ghost"
                onClick={() => onEmbed(entry)}
                aria-label={`Show code to embed ${entry.id}`}
              >
                Embed
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ErrorPanel({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="braid-console__error" role="alert">
      <h3>Could not read the registry</h3>
      <p>{error.message}</p>
      <button className="braid-console__retry" type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/** The query that filters by one tag, quoted when the tag has spaces. */
export function tagQuery(tag: string): string {
  return /\s/.test(tag) ? `tag:"${tag}"` : `tag:${tag}`;
}

/**
 * Matches across everything visible in a row, so the filter finds what the eye can see — plus the
 * `key:value` terms of the query language (see `query.ts`), e.g. `tag:finance -is:gated`.
 */
export function filterEntries(entries: readonly DiscoveryEntry[], query: string): DiscoveryEntry[] {
  return filterBy(entries, query, fragmentItem);
}
