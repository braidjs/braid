import { useCallback, useEffect, useState } from 'react';
import type { RegistryPermissions, SnapshotRef } from '@braidlabs/registry';
import { fetchPermissions, listSnapshots, pinSnapshot, type ConsoleApi } from './client.js';
import { EmptyState, emptyKindOf, type EmptyKind } from './empty-state.js';
import { ensureStyles } from './styles.js';

export interface HistoryPanelProps {
  api?: ConsoleApi;
  theme?: 'light' | 'dark';
  className?: string;
  /** Called after HEAD moves, for hosts that want to refresh other views. */
  onPinned?: (id: string) => void;
}

type State =
  | { status: 'loading' }
  | { status: 'empty'; kind: EmptyKind }
  | { status: 'failed'; error: Error }
  | { status: 'ready'; items: SnapshotRef[]; head: string | null; permissions: RegistryPermissions };

/**
 * Published snapshots, newest first, and who published each.
 *
 * **This is rollback.** Snapshots are immutable, so going back is pinning an earlier id — there is
 * no undo log to replay and nothing to reconstruct. Deleting a shell or a fragment is equally safe
 * for the same reason: the snapshot before the delete still has it.
 *
 * `publishedBy` is shown only when the server stamped it from a verified identity; a client-claimed
 * label would be a note, not a record, and the server's `identify` hook is what makes it the latter.
 */
export function HistoryPanel({ api, theme, className, onPinned }: HistoryPanelProps) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [pinning, setPinning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const apiKey = `${api?.baseUrl ?? ''}|${api?.apiPath ?? ''}`;

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ status: 'loading' });

    Promise.all([listSnapshots(api, controller.signal), fetchPermissions(api, controller.signal)]).then(
      ([{ items, head }, permissions]) => current && setState({ status: 'ready', items, head, permissions }),
      (reason: unknown) => {
        if (!current || controller.signal.aborted) return;
        const kind = emptyKindOf(reason);
        setState(kind ? { status: 'empty', kind } : { status: 'failed', error: reason instanceof Error ? reason : new Error(String(reason)) });
      },
    );

    return () => {
      current = false;
      controller.abort();
    };
    // apiKey stands in for the api object, which is usually a fresh literal each render
  }, [apiKey, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const pin = async (id: string) => {
    setPinning(id);
    setError(null);
    try {
      await pinSnapshot(api ?? {}, id);
      onPinned?.(id);
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPinning(null);
    }
  };

  return (
    <div className={`braid-console${className ? ` ${className}` : ''}`} {...(theme ? { 'data-theme': theme } : {})}>
      {state.status === 'loading' ? (
        <p className="braid-console__empty">Loading history…</p>
      ) : state.status === 'empty' ? (
        <EmptyState kind={state.kind} subject="history" onRetry={reload} />
      ) : state.status === 'failed' ? (
        <div className="braid-console__error" role="alert">
          <h3>Could not load history</h3>
          <p>{state.error.message}</p>
          <button className="braid-console__retry" type="button" onClick={reload}>
            Try again
          </button>
        </div>
      ) : (
        <div className="braid-console__shell">
          <div className="braid-console__header">
            <h2 className="braid-console__title">History</h2>
            <span className="braid-console__count">{state.items.length}</span>
          </div>
          <p className="braid-console__notice braid-console__notice--quiet">
            To roll back, pin an earlier snapshot. A gateway that follows HEAD with a refresh interval serves the new pin
            within that interval; one without it picks the pin up on its next restart or deploy.
          </p>
          {error && (
            <p className="braid-console__barstate--error" role="alert">
              {error}
            </p>
          )}
          {state.items.length === 0 ? (
            <p className="braid-console__empty">Nothing has been published yet.</p>
          ) : (
            <table className="braid-console__table">
              <thead>
                <tr>
                  <th scope="col">Snapshot</th>
                  <th scope="col">Published</th>
                  <th scope="col">By</th>
                  <th scope="col">Fragments</th>
                  <th scope="col">
                    <span className="braid-console__sronly">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="braid-console__mono">{item.id}</span>
                      {item.id === state.head && (
                        <>
                          {' '}
                          <span className="braid-console__badge braid-console__badge--loadable">HEAD</span>
                        </>
                      )}
                    </td>
                    <td>
                      <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
                    </td>
                    <td>{item.labels?.['publishedBy'] ?? <span className="braid-console__desc">not recorded</span>}</td>
                    <td>{item.fragmentCount}</td>
                    <td>
                      {item.id !== state.head && state.permissions.pin && (
                        <button
                          type="button"
                          className="braid-console__ghost"
                          disabled={pinning !== null}
                          onClick={() => void pin(item.id)}
                          aria-label={`Pin ${item.id} (roll back to it)`}
                        >
                          {pinning === item.id ? 'Pinning…' : 'Pin'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
