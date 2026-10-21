import { lazy, Suspense, useEffect, useState } from 'react';
import type { RegistryPermissions, ShellManifest } from '@braidlabs/registry';
import { RegistryConsole } from '../lib/registry-console.js';
import { ensureStyles } from '../lib/styles.js';
import { fetchHead, fetchPermissions, type ConsoleApi } from '../lib/client.js';
import { readRoute, routeHash, type Route, type View } from './routes.js';
import type { Session } from './auth.js';

// Loaded when first opened: most visits are the fragment list, and these are most of the bundle.
const RegistryEditor = lazy(() => import('../lib/registry-editor.js').then((m) => ({ default: m.RegistryEditor })));
const ShellsPanel = lazy(() => import('../lib/shells-panel.js').then((m) => ({ default: m.ShellsPanel })));
const HistoryPanel = lazy(() => import('../lib/history-panel.js').then((m) => ({ default: m.HistoryPanel })));

/**
 * The standalone deployment's shell.
 *
 * This lives in `app/`, not `lib/`, on purpose: it owns a page — a title, a tab strip, the URL, and
 * when configured a sign-in — and every one of those is something the library must *not* own when
 * it mounts inside someone else's admin app. Keeping the page-level concerns here is what lets the
 * panels stay embeddable.
 *
 * The view is in the URL hash rather than in state alone, so a topology someone is looking at is
 * a link they can paste into a ticket. That is the difference between a console an operator uses
 * and one they screenshot.
 */
export function ConsoleApp({ api, edit, session }: { api: ConsoleApi; edit: boolean; session?: Session }) {
  const [route, setRoute] = useState<Route>(() => readRoute(window.location.hash, edit));
  const [permissions, setPermissions] = useState<RegistryPermissions | null>(null);
  const [shells, setShells] = useState<ShellManifest[] | undefined>(undefined);
  const [pinToken, setPinToken] = useState(0);
  // Views with a draft stay mounted once opened, hidden when not shown, so switching tabs or going
  // Back never throws away unpublished edits.
  const [visited, setVisited] = useState<Set<View>>(() => new Set([route.view]));
  const [shellsDirty, setShellsDirty] = useState(false);
  // The Shells tab returns to the shell that was open, the way the panel kept its draft.
  const [lastShell, setLastShell] = useState<string | undefined>(route.shell);

  useEffect(() => {
    ensureStyles();
  }, []);

  // Back and forward should move between views, since the tabs put entries in history.
  useEffect(() => {
    const onHashChange = () => {
      const next = readRoute(window.location.hash, edit);
      setRoute(next);
      if (next.view === 'shells') setLastShell(next.shell);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [edit]);

  // Both are advisory and optional: a gateway without the write API has neither, and the console
  // still lists fragments. Failures are therefore silent here; the panels that need the API say
  // why when they are opened.
  useEffect(() => {
    let current = true;
    fetchPermissions(api).then(
      (result) => {
        if (!current) return;
        // Signed in here, yet the server cannot say who we are: it rejected the token.
        if (session && result.actor === null && !result.read && session.signInAgain()) return;
        setPermissions(result);
      },
      () => current && setPermissions(null),
    );
    fetchHead(api).then(
      (head) => current && setShells(head.snapshot?.shells ?? []),
      () => current && setShells(undefined),
    );
    return () => {
      current = false;
    };
    // `api` and `session` are built once by main.tsx; pinToken refreshes after a rollback.
  }, [api, session, pinToken]);

  useEffect(() => {
    setVisited((current) => (current.has(route.view) ? current : new Set([...current, route.view])));
  }, [route.view]);

  // A reload or a closed tab is the one way left to lose a draft; the browser asks first.
  useEffect(() => {
    if (!shellsDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [shellsDirty]);

  function go(next: Route): void {
    // Renaming the open shell rewrites its link in place, rather than leaving one history entry
    // per keystroke for Back to step through.
    const rename = next.view === 'shells' && route.view === 'shells' && Boolean(next.shell && route.shell);
    if (rename) history.replaceState(null, '', `#${routeHash(next)}`);
    else window.location.hash = routeHash(next);
    setRoute(next);
    if (next.view === 'shells') setLastShell(next.shell);
  }

  // Edit is offered only to a caller who could save. The server enforces that regardless; hiding
  // the tab avoids an editor whose every publish fails.
  // Unknown until /permissions answers, and unknown means hidden: a read-only user should not see
  // an editor flash up and vanish.
  const canEdit = edit && permissions?.publish === true;
  const tabs: { id: View; label: string }[] = [
    { id: 'fragments', label: 'Fragments' },
    { id: 'topology', label: 'Topology' },
    { id: 'shells', label: 'Shells' },
    { id: 'history', label: 'History' },
    ...(canEdit ? ([{ id: 'edit', label: 'Edit fragments' }] as const) : []),
  ];
  const view: View = route.view === 'edit' && !canEdit ? 'fragments' : route.view;

  return (
    <div className="braid-console">
      <div className="braid-console__shell">
        <div className="braid-console__titlebar">
          <h1 className="braid-console__producttitle">Braid gateway</h1>
          <span className="braid-console__breadcrumb">
            <span aria-hidden="true">·</span>
            <code>{api.baseUrl || window.location.host}</code>
          </span>
          <span className="braid-console__spacer" />
          {session && (
            <span className="braid-console__identity">
              <span>{session.user}</span>
              {permissions && <span className="braid-console__rolebadge">{roleLabel(permissions)}</span>}
              <button type="button" className="braid-console__ghost" onClick={() => void session.signOut()}>
                Sign out
              </button>
            </span>
          )}
        </div>

        <div className="braid-console__commandbar">
          <div className="braid-console__tabs" role="tablist" aria-label="Console views">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                className="braid-console__tab"
                aria-selected={view === entry.id}
                onClick={() => go(entry.id === 'shells' && lastShell ? { view: 'shells', shell: lastShell } : { view: entry.id })}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <Suspense fallback={<p className="braid-console__empty">Loading…</p>}>
        {canEdit && visited.has('edit') && (
          <div hidden={view !== 'edit'}>
            <RegistryEditor api={api} />
          </div>
        )}
        {visited.has('shells') && (
          <div hidden={view !== 'shells'}>
            <ShellsPanel
              api={api}
              selected={route.shell ?? null}
              onSelect={(id) => go(id ? { view: 'shells', shell: id } : { view: 'shells' })}
              onPublished={(outcome) => outcome.pinned && setPinToken((token) => token + 1)}
              onDirtyChange={setShellsDirty}
            />
          </div>
        )}
        {view === 'history' && <HistoryPanel api={api} onPinned={() => setPinToken((token) => token + 1)} />}
      </Suspense>
      {(view === 'fragments' || view === 'topology') && (
        // `chrome={false}` because the shell above already renders the heading, and `view` because
        // it already renders the tabs — the console keeps its command bar, filter, and stats.
        <RegistryConsole api={api} chrome={false} view={view} {...(shells ? { shells } : {})} />
      )}
    </div>
  );
}

function roleLabel({ publish, pin }: RegistryPermissions): string {
  if (publish && pin) return 'can publish';
  if (publish) return 'can publish candidates';
  return 'read-only';
}
