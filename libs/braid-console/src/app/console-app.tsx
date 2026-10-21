import { useEffect, useState } from 'react';
import type { RegistryPermissions, ShellManifest } from '@braidlabs/registry';
import { RegistryConsole } from '../lib/registry-console.js';
import { RegistryEditor } from '../lib/registry-editor.js';
import { ShellsPanel } from '../lib/shells-panel.js';
import { HistoryPanel } from '../lib/history-panel.js';
import { ensureStyles } from '../lib/styles.js';
import { fetchHead, fetchPermissions, type ConsoleApi } from '../lib/client.js';
import { readRoute, routeHash, type Route, type View } from './routes.js';
import type { Session } from './auth.js';

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

  useEffect(() => {
    ensureStyles();
  }, []);

  // Back and forward should move between views, since the tabs put entries in history.
  useEffect(() => {
    const onHashChange = () => setRoute(readRoute(window.location.hash, edit));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [edit]);

  // Both are advisory and optional: a gateway without the write API has neither, and the console
  // still lists fragments. Failures are therefore silent here; the panels that need the API say
  // why when they are opened.
  useEffect(() => {
    let current = true;
    fetchPermissions(api).then(
      (result) => current && setPermissions(result),
      () => current && setPermissions(null),
    );
    fetchHead(api).then(
      (head) => current && setShells(head.snapshot?.shells ?? []),
      () => current && setShells(undefined),
    );
    return () => {
      current = false;
    };
    // `api` is built once by main.tsx; pinToken refreshes after a rollback.
  }, [api, pinToken]);

  function go(next: Route): void {
    window.location.hash = routeHash(next);
    setRoute(next);
  }

  // Edit is offered only to a caller who could save. The server enforces that regardless; hiding
  // the tab avoids an editor whose every publish fails.
  const canEdit = edit && permissions?.publish !== false;
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
                onClick={() => go({ view: entry.id })}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === 'edit' ? (
        <RegistryEditor api={api} />
      ) : view === 'shells' ? (
        <ShellsPanel
          api={api}
          selected={route.shell ?? null}
          onSelect={(id) => go(id ? { view: 'shells', shell: id } : { view: 'shells' })}
          onPublished={() => setPinToken((token) => token + 1)}
        />
      ) : view === 'history' ? (
        <HistoryPanel api={api} onPinned={() => setPinToken((token) => token + 1)} />
      ) : (
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
