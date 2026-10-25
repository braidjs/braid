import { useCallback, useEffect, useRef, useState } from 'react';
import type { RegistryPermissions, SnapshotRef } from '@braidlabs/registry';
import {
  approvePromotion,
  fetchEnvironments,
  fetchPermissions,
  listSnapshots,
  pinSnapshot,
  promoteSnapshot,
  rejectPromotion,
  type ConsoleApi,
  type EnvironmentState,
} from './client.js';
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
  | {
      status: 'ready';
      items: SnapshotRef[];
      head: string | null;
      /** Cursor for the next older page; null when this is all of it. */
      next: string | null;
      permissions: RegistryPermissions;
      environments: EnvironmentState[];
    };

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

    Promise.all([listSnapshots(api, controller.signal), fetchPermissions(api, controller.signal), fetchEnvironments(api, controller.signal)]).then(
      ([{ items, head, next }, permissions, environments]) =>
        current && setState({ status: 'ready', items, head, next: next ?? null, permissions, environments }),
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
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The listing an older page belongs to; a reload in the meantime makes the page stale.
  const listing = useRef(0);
  listing.current = reloadToken;

  /** Appends the next older page. Rollback is only as far back as the history the panel can show. */
  const loadOlder = async () => {
    if (state.status !== 'ready' || !state.next) return;
    setLoadingOlder(true);
    setError(null);
    try {
      const startedOn = listing.current;
      const page = await listSnapshots(api, undefined, { before: state.next });
      if (listing.current !== startedOn) return;
      setState((current) =>
        current.status === 'ready' ? { ...current, items: [...current.items, ...page.items], next: page.next ?? null } : current,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingOlder(false);
    }
  };

  /** Runs one write at a time, reporting its error in the panel and reloading on success. */
  const act = async (key: string, write: () => Promise<unknown>) => {
    setPinning(key);
    setError(null);
    try {
      await write();
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPinning(null);
    }
  };

  const pin = (id: string) =>
    act(id, async () => {
      await pinSnapshot(api ?? {}, id);
      onPinned?.(id);
    });

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
          {state.environments
            .filter((environment) => environment.pending)
            .map((environment) => {
              const pending = environment.pending!;
              const rights = state.permissions.environments?.[environment.name];
              const isRequester = state.permissions.actor !== null && state.permissions.actor === pending.requestedBy;
              return (
                <div key={environment.name} className="braid-console__notice" role="status">
                  <strong>{pending.requestedBy}</strong> asked to promote{' '}
                  <span className="braid-console__mono">{pending.id}</span> to <strong>{environment.name}</strong>.{' '}
                  {rights?.approve && !isRequester && (
                    <button
                      type="button"
                      className="braid-console__ghost"
                      disabled={pinning !== null}
                      onClick={() => void act(`approve:${environment.name}`, () => approvePromotion(api ?? {}, environment.name, pending))}
                    >
                      Approve
                    </button>
                  )}
                  {(rights?.approve || isRequester) && (
                    <button
                      type="button"
                      className="braid-console__ghost"
                      disabled={pinning !== null}
                      onClick={() => void act(`reject:${environment.name}`, () => rejectPromotion(api ?? {}, environment.name))}
                    >
                      {isRequester ? 'Withdraw' : 'Reject'}
                    </button>
                  )}
                  {isRequester && !rights?.approve && <span className="braid-console__desc"> Waiting for someone else to approve.</span>}
                </div>
              );
            })}
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
                      {state.environments
                        .filter((environment) => environment.id === item.id)
                        .map((environment) => (
                          <span key={environment.name}>
                            {' '}
                            <span className="braid-console__badge">{environment.name}</span>
                          </span>
                        ))}
                    </td>
                    <td>
                      <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
                    </td>
                    <td>{item.labels?.['publishedBy'] ?? <span className="braid-console__desc">not recorded</span>}</td>
                    <td>{item.fragmentCount}</td>
                    <td>
                      {promotableTo(item.id, state).map((environment) => (
                        <button
                          key={environment.name}
                          type="button"
                          className="braid-console__ghost"
                          disabled={pinning !== null}
                          onClick={() => void act(`promote:${environment.name}:${item.id}`, () => promoteSnapshot(api ?? {}, environment.name, item.id))}
                          aria-label={`Promote ${item.id} to ${environment.name}`}
                        >
                          {pinning === `promote:${environment.name}:${item.id}` ? 'Promoting…' : `Promote to ${environment.name}`}
                        </button>
                      ))}
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
          {state.next && (
            <button type="button" className="braid-console__ghost" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? 'Loading…' : 'Load older'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The environments a snapshot can be promoted into from this row: the caller may promote there, it
 * is not already there, nothing is waiting for approval there, and — for an environment with a
 * source — it is what the source holds. (A rollback to an earlier one is the server's to allow;
 * the row offers the forward path.)
 */
function promotableTo(id: string, state: Extract<State, { status: 'ready' }>): EnvironmentState[] {
  const refOf = (name: string) => state.environments.find((environment) => environment.name === name)?.id ?? null;
  return state.environments.filter(
    (environment) =>
      state.permissions.environments?.[environment.name]?.promote &&
      environment.id !== id &&
      !environment.pending &&
      (environment.from ? refOf(environment.from) === id : true),
  );
}
