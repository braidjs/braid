import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FragmentManifest } from '@braidlabs/gateway';
import {
  parseAreas,
  formatAreas,
  validateShells,
  SHELL_FRAMEWORKS,
  type RegistryFinding,
  type RegistryPermissions,
  type ShellFramework,
  type ShellManifest,
  type ShellRoute,
} from '@braidlabs/registry';
import type { OwnedTags } from '@braidlabs/registry';
import {
  fetchHead,
  fetchPermissions,
  publishSnapshot,
  RegistryApiError,
  type ConsoleApi,
  type PublishOutcome,
} from './client.js';
import { EmptyState, emptyKindOf, type EmptyKind } from './empty-state.js';
import { filterBy, shellItem } from './query.js';
import { SHELL_TARGETS, shellCode } from './shell-codegen.js';
import { ensureStyles } from './styles.js';
import { TagChip } from './tag-chip.js';
import { tagColor } from './tags.js';
import { tagQuery } from './registry-console.js';
import { canChange, startingTags } from './ownership.js';

export interface ShellsPanelProps {
  /** Needs the registry write API: shells live in snapshots, which discovery does not serve. */
  api?: ConsoleApi;
  theme?: 'light' | 'dark';
  className?: string;
  /**
   * The open shell's id, when the host keeps it in its URL. Uncontrolled when omitted.
   * `onSelect` reports opens, closes and renames, so the host can follow.
   */
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  onPublished?: (outcome: PublishOutcome) => void;
  /**
   * Whether there are unpublished changes, for a host that wants to warn before leaving. The
   * panel does not touch `beforeunload` itself: the page is the host's.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Change it to have the panel reload HEAD — after a rollback elsewhere, say. Ignored while there
   * are unpublished changes: those publish against their own base and a stale one is a 409.
   */
  refreshKey?: unknown;
}

interface Workspace {
  /** Fragments as pinned. Shells are published alongside them, unchanged. */
  manifests: FragmentManifest[];
  base: ShellManifest[];
  shells: ShellManifest[];
  baseId: string | null;
  permissions: RegistryPermissions;
}

type Phase =
  | { status: 'loading' }
  | { status: 'empty'; kind: EmptyKind }
  | { status: 'failed'; error: Error }
  | { status: 'ready' }
  | { status: 'publishing' }
  | { status: 'published'; outcome: PublishOutcome }
  | { status: 'refused'; error: Error; findings: RegistryFinding[]; conflict: boolean };

/**
 * Shells: list, design, and publish them.
 *
 * Same contract as the fragment editor: **branch from what is pinned → edit → publish a new
 * snapshot**. A draft lives in the browser until then. Publishing sends the pinned fragments back
 * unchanged with the edited shells, and `baseId`, so a publish that would overwrite someone else's
 * is refused rather than silently winning.
 *
 * The head a shell declares — meta tags, scripts, stylesheets — is edited as data and never
 * injected into this page. Rendering it here would run third-party code in the admin origin with
 * an operator's token in reach; the preview draws the grid and nothing else.
 */
export function ShellsPanel({ api, theme, className, selected, onSelect, onPublished, onDirtyChange, refreshKey }: ShellsPanelProps) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });
  const [ownOpen, setOwnOpen] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const apiKey = `${api?.baseUrl ?? ''}|${api?.apiPath ?? ''}`;

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;

    setPhase({ status: 'loading' });
    Promise.all([fetchHead(api, controller.signal), fetchPermissions(api, controller.signal)]).then(
      ([head, permissions]) => {
        if (!current) return;
        const shells = head.snapshot?.shells ?? [];
        setWorkspace({ manifests: head.snapshot?.manifests ?? [], base: shells, shells, baseId: head.id, permissions });
        setPhase({ status: 'ready' });
      },
      (error: unknown) => {
        if (!current || controller.signal.aborted) return;
        const kind = emptyKindOf(error);
        setPhase(kind ? { status: 'empty', kind } : { status: 'failed', error: asError(error) });
      },
    );

    return () => {
      current = false;
      controller.abort();
    };
    // apiKey stands in for the api object, which is usually a fresh literal each render
  }, [apiKey, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  // Controlled by id when the host passes one; an id that is mid-edit (and so matches nothing)
  // keeps the current shell open rather than closing it under the person typing.
  // The shell already open wins when it carries the selected id, so renaming it onto another
  // shell's id (a duplicate, flagged as an error) does not jump the designer to that other shell.
  const open = useMemo(() => {
    if (selected === undefined || !workspace) return ownOpen;
    if (selected === null) return null;
    if (ownOpen !== null && workspace.shells[ownOpen]?.id === selected) return ownOpen;
    const index = workspace.shells.findIndex((shell) => shell.id === selected);
    return index >= 0 ? index : ownOpen;
  }, [selected, workspace, ownOpen]);

  const choose = (index: number | null) => {
    setOwnOpen(index);
    onSelect?.(index === null ? null : (workspace?.shells[index]?.id ?? null));
  };

  // Shells only: the fragments are the pinned ones and cannot change here, and re-checking them
  // (pierce overlaps are quadratic) on every keystroke costs ~100 ms at a few hundred fragments.
  const manifests = workspace?.manifests;
  const shells = workspace?.shells;
  const findings = useMemo(() => (shells && manifests ? validateShells(shells, manifests) : []), [shells, manifests]);
  const base = workspace?.base;
  const dirty = useMemo(() => Boolean(shells && base) && JSON.stringify(shells) !== JSON.stringify(base), [shells, base]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    // onDirtyChange is a notification; depending on it would re-notify on every host render.
  }, [dirty]);

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    if (!dirtyRef.current) setReloadToken((token) => token + 1);
  }, [refreshKey]);

  if (phase.status === 'loading' || (!workspace && phase.status !== 'empty' && phase.status !== 'failed')) {
    return (
      <div className={rootClass(className)} {...themeAttr(theme)}>
        <p className="braid-console__empty">Loading shells…</p>
      </div>
    );
  }

  if (phase.status === 'empty' || phase.status === 'failed' || !workspace) {
    return (
      <div className={rootClass(className)} {...themeAttr(theme)}>
        {phase.status === 'empty' ? (
          <EmptyState kind={phase.kind} onRetry={reload} />
        ) : (
          <div className="braid-console__error" role="alert">
            <h3>Could not load shells</h3>
            <p>{phase.status === 'failed' ? phase.error.message : ''}</p>
            <button className="braid-console__retry" type="button" onClick={reload}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  const { permissions } = workspace;
  const canEdit = permissions.publish;
  /** Per-tag ownership: publishing rights, narrowed to the shells whose tags the caller owns. */
  const owned = permissions.tags ?? null;
  const errors = findings.filter((finding) => finding.severity === 'error');

  const update = (shells: ShellManifest[]) => {
    setWorkspace({ ...workspace, shells });
    if (phase.status === 'published' || phase.status === 'refused') setPhase({ status: 'ready' });
  };

  const create = () => {
    const shells = [...workspace.shells, newShell(workspace.shells, startingTags(owned))];
    update(shells);
    setOwnOpen(shells.length - 1);
    onSelect?.(shells[shells.length - 1]?.id ?? null);
  };

  const remove = (index: number) => {
    update(workspace.shells.filter((_, position) => position !== index));
    choose(null);
  };

  const publish = async (pin: boolean) => {
    setPhase({ status: 'publishing' });
    // What was sent, not what is in state when the answer arrives: edits typed while the request
    // was in flight are newer than the publish and must survive it.
    const sent = workspace.shells;
    try {
      const outcome = await publishSnapshot(api ?? {}, {
        manifests: workspace.manifests,
        shells: sent,
        baseId: workspace.baseId,
        pin,
      });
      // Only a pinned publish moves the base. A candidate leaves HEAD where it was, so the draft
      // still differs from what is live, and Discard still means "back to HEAD".
      if (outcome.pinned) setWorkspace((current) => (current ? { ...current, base: sent, baseId: outcome.snapshot.id } : current));
      setPhase({ status: 'published', outcome });
      onPublished?.(outcome);
    } catch (error) {
      const apiError = error instanceof RegistryApiError ? error : null;
      setPhase({ status: 'refused', error: asError(error), findings: apiError?.findings ?? [], conflict: apiError?.status === 409 });
    }
  };

  const shell = open !== null ? workspace.shells[open] : undefined;

  return (
    <div className={rootClass(className)} {...themeAttr(theme)}>
      {shell && open !== null ? (
        <ShellDesigner
          key={open}
          shell={shell}
          manifests={workspace.manifests}
          findings={findings.filter((finding) => finding.shellIds?.includes(shell.id))}
          readOnly={!(canEdit && canChange(workspace.base.find((base) => base.id === shell.id)?.tags ?? shell.tags, owned))}
          onChange={(next) => {
            update(workspace.shells.map((current, position) => (position === open ? next : current)));
            if (next.id !== shell.id) {
              // Track the open shell by position from here on, so the id can change under it.
              setOwnOpen(open);
              // An emptied id is mid-edit, not a deselection: keep the URL on the last real id.
              if (next.id !== '') onSelect?.(next.id);
            }
          }}
          onBack={() => choose(null)}
          onDelete={() => remove(open)}
        />
      ) : (
        <ShellList
          shells={workspace.shells}
          query={query}
          onQuery={setQuery}
          canEdit={canEdit}
          owned={owned}
          base={workspace.base}
          onOpen={choose}
          onCreate={create}
          onDelete={remove}
        />
      )}

      {canEdit && (dirty || phase.status !== 'ready') && (
        <PublishBar
          phase={phase}
          dirty={dirty}
          errors={errors.length}
          canPin={permissions.pin}
          actor={permissions.actor}
          onPublish={publish}
          onDiscard={() => {
            update(workspace.base);
            setPhase({ status: 'ready' });
          }}
          onReload={reload}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function ShellList({
  shells,
  query,
  onQuery,
  canEdit,
  owned,
  base,
  onOpen,
  onCreate,
  onDelete,
}: {
  shells: ShellManifest[];
  query: string;
  onQuery: (query: string) => void;
  canEdit: boolean;
  owned: OwnedTags | null;
  /** The published shells: ownership is judged by the tags an item was published with. */
  base: readonly ShellManifest[];
  onOpen: (index: number) => void;
  onCreate: () => void;
  onDelete: (index: number) => void;
}) {
  const indexed = shells.map((shell, index) => ({ shell, index }));
  const visible = filterBy(indexed, query, ({ shell }) => shellItem(shell));

  return (
    <div className="braid-console__shell">
      <div className="braid-console__header">
        <h2 className="braid-console__title">Shells</h2>
        <span className="braid-console__count">{shells.length}</span>
        <span className="braid-console__spacer" />
        <input
          className="braid-console__search"
          type="search"
          value={query}
          placeholder="Filter — text, or tag:core framework:react"
          aria-label="Filter shells"
          onChange={(event) => onQuery(event.target.value)}
        />
        {canEdit && (
          <button className="braid-console__retry" type="button" onClick={onCreate}>
            New shell
          </button>
        )}
      </div>

      {shells.length === 0 ? (
        <EmptyState kind="empty" {...(canEdit ? { onCreate } : {})} />
      ) : visible.length === 0 ? (
        <p className="braid-console__empty">Nothing matches “{query}”.</p>
      ) : (
        <table className="braid-console__table">
          <thead>
            <tr>
              <th scope="col">Shell</th>
              <th scope="col">Framework</th>
              <th scope="col">Routes</th>
              <th scope="col">
                <span className="braid-console__sronly">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ shell, index }) => (
              <tr key={`${index}:${shell.id}`}>
                <td>
                  <div className="braid-console__id">{shell.id || '(no id)'}</div>
                  {shell.title && <div className="braid-console__desc">{shell.title}</div>}
                  {shell.tags?.map((tag) => <TagChip key={tag} tag={tag} onSelect={(t) => onQuery(tagQuery(t))} />)}
                </td>
                <td className="braid-console__mono">{frameworkLabel(shell.framework)}</td>
                <td>
                  <div className="braid-console__patterns">
                    {shell.routes.map((route) => (
                      <span className="braid-console__mono" key={route.path}>
                        {route.path}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="braid-console__actions">
                  <button type="button" className="braid-console__ghost" onClick={() => onOpen(index)}>
                    {canEdit && canChange((base.find((b) => b.id === shell.id) ?? shell).tags, owned) ? 'Edit' : 'View'}
                  </button>
                  {canEdit && canChange((base.find((b) => b.id === shell.id) ?? shell).tags, owned) && (
                    <button type="button" className="braid-console__ghost" onClick={() => onDelete(index)} aria-label={`Delete ${shell.id}`}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Designer
// ---------------------------------------------------------------------------

type DesignerTab = 'layout' | 'head' | 'code';

function ShellDesigner({
  shell,
  manifests,
  findings,
  readOnly,
  onChange,
  onBack,
  onDelete,
}: {
  shell: ShellManifest;
  manifests: FragmentManifest[];
  findings: RegistryFinding[];
  readOnly: boolean;
  onChange: (shell: ShellManifest) => void;
  onBack: () => void;
  onDelete: () => void;
}) {
  const [tab, setTab] = useState<DesignerTab>('layout');
  const [requestedRoute, setRouteIndex] = useState(0);
  // Clamped once and used everywhere: Discard or a reload can remove the route that was selected.
  const routeIndex = Math.max(0, Math.min(requestedRoute, shell.routes.length - 1));
  const route = shell.routes[routeIndex];
  const set = (patch: Partial<ShellManifest>) => onChange({ ...shell, ...patch });

  const setRoute = (patch: Partial<ShellRoute>) =>
    set({ routes: shell.routes.map((current, index) => (index === routeIndex ? { ...current, ...patch } : current)) });

  return (
    <div className="braid-console__shell braid-console__designer">
      <div className="braid-console__header">
        <button type="button" className="braid-console__ghost" onClick={onBack}>
          ← Shells
        </button>
        <h2 className="braid-console__title braid-console__mono">{shell.id || '(no id)'}</h2>
        <span className="braid-console__spacer" />
        {!readOnly && (
          <button type="button" className="braid-console__ghost" onClick={onDelete}>
            Delete shell
          </button>
        )}
      </div>

      <fieldset className="braid-console__fields braid-console__shellmeta" disabled={readOnly}>
        <legend className="braid-console__sronly">Shell</legend>
        <TextField label="Id" value={shell.id} mono onChange={(id) => set({ id })} />
        <TextField label="Title" value={shell.title ?? ''} onChange={(title) => set(optional('title', title))} />
        <label className="braid-console__field">
          <span className="braid-console__fieldlabel">Framework</span>
          <select value={shell.framework} onChange={(event) => set({ framework: event.target.value as ShellFramework })}>
            {SHELL_FRAMEWORKS.map((framework) => (
              <option key={framework} value={framework}>
                {frameworkLabel(framework)}
              </option>
            ))}
          </select>
        </label>
        <TextField
          label="Tags"
          hint="comma-separated"
          value={(shell.tags ?? []).join(', ')}
          onChange={(text) => set(optionalList('tags', text))}
        />
        {shell.tags && shell.tags.length > 0 && (
          <div className="braid-console__tagrow" aria-label="Tags">
            {shell.tags.map((tag) => (
              <TagChip key={tag} tag={tag} />
            ))}
          </div>
        )}
      </fieldset>

      <p className="braid-console__notice braid-console__notice--quiet">
        The framework chooses the code this shell generates. The gateway still serves the shell app you deploy; serving
        shells straight from this definition is planned.
      </p>

      {findings.length > 0 && (
        <ul className="braid-console__findings" aria-label="Problems with this shell">
          {findings.map((finding, index) => (
            <li key={index} className={`braid-console__finding braid-console__finding--${finding.severity}`}>
              <span className="braid-console__mono">{finding.code}</span> {finding.message}
              {finding.hint && <span className="braid-console__desc"> {finding.hint}</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="braid-console__tabs" role="tablist" aria-label="Shell sections">
        {(['layout', 'head', 'code'] as const).map((id) => (
          <button key={id} type="button" role="tab" className="braid-console__tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {id === 'layout' ? 'Routes & layout' : id === 'head' ? 'Head & assets' : 'Code'}
          </button>
        ))}
      </div>

      {tab === 'layout' && (
        <div className="braid-console__designerbody">
          <div className="braid-console__routes" role="group" aria-label="Routes">
            {shell.routes.map((current, index) => (
              <button
                key={index}
                type="button"
                className="braid-console__routebutton braid-console__mono"
                aria-pressed={index === routeIndex}
                onClick={() => setRouteIndex(index)}
              >
                {current.path || '(no path)'}
              </button>
            ))}
            {!readOnly && (
              <button
                type="button"
                className="braid-console__ghost"
                onClick={() => {
                  set({ routes: [...shell.routes, { path: '/new', layout: { areas: 'main' }, slots: {} }] });
                  setRouteIndex(shell.routes.length);
                }}
              >
                + Route
              </button>
            )}
          </div>

          {route ? (
            <RouteEditor
              route={route}
              manifests={manifests}
              readOnly={readOnly}
              onChange={setRoute}
              {...(shell.routes.length > 1 && !readOnly
                ? {
                    onRemove: () => {
                      set({ routes: shell.routes.filter((_, index) => index !== routeIndex) });
                      setRouteIndex(0);
                    },
                  }
                : {})}
            />
          ) : (
            <p className="braid-console__empty">This shell has no routes. Add one to give it a layout.</p>
          )}
        </div>
      )}

      {tab === 'head' && <HeadEditor shell={shell} readOnly={readOnly} onChange={(head) => set({ head })} />}

      {tab === 'code' && <CodeView shell={shell} manifests={manifests} />}
    </div>
  );
}

function RouteEditor({
  route,
  manifests,
  readOnly,
  onChange,
  onRemove,
}: {
  route: ShellRoute;
  manifests: FragmentManifest[];
  readOnly: boolean;
  onChange: (patch: Partial<ShellRoute>) => void;
  onRemove?: () => void;
}) {
  const parsed = useMemo(() => parseAreas(route.layout.areas), [route.layout.areas]);
  const [area, setArea] = useState<string | null>(null);
  const current = area && parsed.areas.some((a) => a.name === area) ? area : (parsed.areas[0]?.name ?? null);
  const slots = route.slots ?? {};
  const byId = useMemo(() => new Map(manifests.map((manifest) => [manifest.id, manifest])), [manifests]);
  const setLayout = (patch: Partial<ShellRoute['layout']>) => onChange({ layout: { ...route.layout, ...patch } });
  const layoutId = `braid-layout-${route.path}`;

  return (
    <div className="braid-console__routeeditor">
      <fieldset className="braid-console__fields" disabled={readOnly}>
        <legend className="braid-console__sronly">Route</legend>
        <TextField label="Path" hint="URLPattern, e.g. /orders/*" value={route.path} mono onChange={(path) => onChange({ path })} />
        <div className="braid-console__layoutrow">
          <label className="braid-console__field braid-console__field--grow">
            <span className="braid-console__fieldlabel">Layout</span>
            <span className="braid-console__desc" id={`${layoutId}-hint`}>
              Type it like ASCII art: each word names an area, repeat it to span cells, <code>.</code> leaves a cell empty.
            </span>
            <textarea
              className="braid-console__ascii"
              value={route.layout.areas}
              rows={Math.max(3, route.layout.areas.split('\n').length + 1)}
              spellCheck={false}
              aria-describedby={`${layoutId}-hint`}
              aria-invalid={parsed.errors.length > 0}
              onChange={(event) => setLayout({ areas: event.target.value })}
            />
          </label>
          <div className="braid-console__tracks">
            <TextField label="Columns" value={route.layout.columns ?? ''} mono onChange={(columns) => setLayout(optional('columns', columns))} />
            <TextField label="Rows" value={route.layout.rows ?? ''} mono onChange={(rows) => setLayout(optional('rows', rows))} />
            <TextField label="Gap" value={route.layout.gap ?? ''} mono onChange={(gap) => setLayout(optional('gap', gap))} />
          </div>
        </div>
        {onRemove && (
          <button type="button" className="braid-console__ghost" onClick={onRemove}>
            Remove this route
          </button>
        )}
      </fieldset>

      {parsed.errors.length > 0 ? (
        <ul className="braid-console__findings" role="alert">
          {parsed.errors.map((error) => (
            <li key={error} className="braid-console__finding braid-console__finding--error">
              {error}
            </li>
          ))}
        </ul>
      ) : (
        <div className="braid-console__preview">
          <div className="braid-console__previewhead">
            <span>Preview</span>
            <span className="braid-console__desc">Pick an area, then the fragment that fills it.</span>
          </div>
          <div
            className="braid-console__gridpreview"
            style={{
              gridTemplateAreas: formatAreas(parsed.cells).join(' '),
              ...(route.layout.columns ? { gridTemplateColumns: route.layout.columns } : {}),
              ...(route.layout.rows ? { gridTemplateRows: route.layout.rows } : {}),
            }}
          >
            {parsed.areas.map(({ name }) => {
              const fragment = slots[name];
              const tag = fragment ? byId.get(fragment)?.tags?.[0] : undefined;
              return (
                <button
                  key={name}
                  type="button"
                  className={`braid-console__area${fragment ? ' is-filled' : ''}${tag ? ` braid-console__tag--c${tagColor(tag)}` : ''}`}
                  style={{ gridArea: name }}
                  aria-pressed={name === current}
                  aria-label={`Area ${name}, ${fragment ? `holds ${fragment}` : 'empty'}`}
                  onClick={() => setArea(name)}
                >
                  <span className="braid-console__areaname">{name}</span>
                  <span className="braid-console__areafragment">{fragment ?? 'empty'}</span>
                </button>
              );
            })}
          </div>

          {current && (
            <label className="braid-console__field">
              <span className="braid-console__fieldlabel">
                Fragment in <span className="braid-console__mono">{current}</span>
              </span>
              <select
                value={slots[current] ?? ''}
                disabled={readOnly}
                onChange={(event) => {
                  const next = { ...slots };
                  if (event.target.value) next[current] = event.target.value;
                  else delete next[current];
                  onChange({ slots: next });
                }}
              >
                <option value="">— empty —</option>
                {manifests.map((manifest) => (
                  <option key={manifest.id} value={manifest.id}>
                    {manifest.id}
                    {manifest.title && manifest.title !== manifest.id ? ` — ${manifest.title}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

function HeadEditor({ shell, readOnly, onChange }: { shell: ShellManifest; readOnly: boolean; onChange: (head: ShellManifest['head']) => void }) {
  const head = shell.head ?? {};
  const meta = head.meta ?? [];
  const scripts = head.scripts ?? [];
  const sheets = head.stylesheets ?? [];
  const set = (patch: Partial<NonNullable<ShellManifest['head']>>) => onChange(prune({ ...head, ...patch }));

  return (
    <fieldset className="braid-console__fields braid-console__head" disabled={readOnly}>
      <legend className="braid-console__sronly">Document head</legend>
      <p className="braid-console__notice braid-console__notice--quiet">
        Nothing here loads in the console. Scripts and stylesheets are data until a shell serves them.
      </p>
      <TextField label="Document title" value={head.title ?? ''} onChange={(title) => set(optional('title', title))} />

      <h4 className="braid-console__subhead">Meta tags</h4>
      {meta.map((entry, index) => (
        <div className="braid-console__row" key={index}>
          <TextField label="Name" value={entry.name ?? entry.property ?? ''} mono onChange={(name) => set({ meta: replace(meta, index, metaName(entry, name)) })} />
          <TextField label="Content" value={entry.content} onChange={(content) => set({ meta: replace(meta, index, { ...entry, content }) })} />
          <RemoveButton label={`Remove meta tag ${entry.name ?? entry.property ?? index + 1}`} onClick={() => set({ meta: meta.filter((_, i) => i !== index) })} />
        </div>
      ))}
      <AddButton label="+ Meta tag" onClick={() => set({ meta: [...meta, { name: '', content: '' }] })} />

      <h4 className="braid-console__subhead">Scripts</h4>
      <p className="braid-console__desc">By URL only — https: or a root-relative path. Inline JavaScript is not part of a shell.</p>
      {scripts.map((script, index) => (
        <div className="braid-console__row" key={index}>
          <TextField label="Script URL" value={script.src} mono onChange={(src) => set({ scripts: replace(scripts, index, { ...script, src }) })} />
          <label className="braid-console__field">
            <span className="braid-console__fieldlabel">Type</span>
            <select
              value={script.type ?? 'classic'}
              onChange={(event) => set({ scripts: replace(scripts, index, { ...script, type: event.target.value as 'module' | 'classic' }) })}
            >
              <option value="module">module</option>
              <option value="classic">classic</option>
            </select>
          </label>
          <label className="braid-console__check">
            <input type="checkbox" checked={script.defer === true} onChange={(event) => set({ scripts: replace(scripts, index, optionalFlag(script, 'defer', event.target.checked)) })} />
            defer
          </label>
          <label className="braid-console__check">
            <input type="checkbox" checked={script.async === true} onChange={(event) => set({ scripts: replace(scripts, index, optionalFlag(script, 'async', event.target.checked)) })} />
            async
          </label>
          <TextField label="Integrity" value={script.integrity ?? ''} mono onChange={(integrity) => set({ scripts: replace(scripts, index, { ...script, ...optional('integrity', integrity) }) })} />
          <RemoveButton label={`Remove script ${index + 1}`} onClick={() => set({ scripts: scripts.filter((_, i) => i !== index) })} />
        </div>
      ))}
      <AddButton label="+ Script" onClick={() => set({ scripts: [...scripts, { src: '', type: 'module', defer: true }] })} />

      <h4 className="braid-console__subhead">Stylesheets</h4>
      {sheets.map((sheet, index) => (
        <div className="braid-console__row" key={index}>
          <TextField label="Stylesheet URL" value={sheet.href} mono onChange={(href) => set({ stylesheets: replace(sheets, index, { ...sheet, href }) })} />
          <RemoveButton label={`Remove stylesheet ${index + 1}`} onClick={() => set({ stylesheets: sheets.filter((_, i) => i !== index) })} />
        </div>
      ))}
      <AddButton label="+ Stylesheet" onClick={() => set({ stylesheets: [...sheets, { href: '' }] })} />
    </fieldset>
  );
}

function CodeView({ shell, manifests }: { shell: ShellManifest; manifests: FragmentManifest[] }) {
  const [target, setTarget] = useState<ShellFramework>(shell.framework);
  const files = useMemo(() => shellCode(shell, manifests, target), [shell, manifests, target]);

  return (
    <div className="braid-console__codeview">
      <div className="braid-console__tabs" role="tablist" aria-label="Generated code target">
        {SHELL_TARGETS.map(({ id, label }) => (
          <button key={id} type="button" role="tab" className="braid-console__tab" aria-selected={target === id} onClick={() => setTarget(id)}>
            {label}
          </button>
        ))}
      </div>
      {files.map((file) => (
        <section key={file.name} className="braid-console__codefile" aria-label={file.name}>
          <div className="braid-console__codehead">
            <span className="braid-console__mono">{file.name}</span>
            <button type="button" className="braid-console__ghost" onClick={() => void navigator.clipboard?.writeText(file.code)}>
              Copy
            </button>
          </div>
          <pre className="braid-console__code">{file.code}</pre>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Publish bar
// ---------------------------------------------------------------------------

function PublishBar({
  phase,
  dirty,
  errors,
  canPin,
  actor,
  onPublish,
  onDiscard,
  onReload,
}: {
  phase: Phase;
  dirty: boolean;
  errors: number;
  canPin: boolean;
  actor: string | null;
  onPublish: (pin: boolean) => void;
  onDiscard: () => void;
  onReload: () => void;
}) {
  const busy = phase.status === 'publishing';

  return (
    <div className="braid-console__bar" role="region" aria-label="Publish shells">
      <span className="braid-console__barstate" role="status">
        {phase.status === 'published' && phase.outcome.pullRequest ? (
          <>
            Proposed as{' '}
            <a href={phase.outcome.pullRequest.url} target="_blank" rel="noreferrer">
              pull request #{phase.outcome.pullRequest.number}
            </a>
            . It is published when the pull request is merged.
          </>
        ) : phase.status === 'published' ? (
          <>
            Published <code className="braid-console__mono">{phase.outcome.snapshot.id}</code>
            {phase.outcome.pinned ? ' and pinned.' : ' as a candidate, not pinned.'} A gateway following HEAD serves a new pin
            within its refresh interval, or on restart without one.
          </>
        ) : phase.status === 'refused' ? (
          <span className="braid-console__barstate--error">
            {phase.conflict ? 'Someone published since you started. ' : ''}
            {phase.error.message}
            {phase.findings.length > 0 && ` (${phase.findings.map((finding) => finding.code).join(', ')})`}
          </span>
        ) : errors > 0 ? (
          `${errors} error${errors === 1 ? '' : 's'} to fix before publishing.`
        ) : (
          <>Unpublished changes{actor ? <> · recorded as <strong>{actor}</strong></> : null}</>
        )}
      </span>
      <span className="braid-console__spacer" />
      {phase.status === 'refused' && phase.conflict ? (
        <button type="button" className="braid-console__retry" onClick={onReload}>
          Reload pinned (discards this draft)
        </button>
      ) : (
        <>
          <button type="button" className="braid-console__ghost" onClick={onDiscard} disabled={busy || !dirty}>
            Discard
          </button>
          {canPin ? (
            <button type="button" className="braid-console__retry" onClick={() => onPublish(true)} disabled={busy || !dirty || errors > 0}>
              {busy ? 'Publishing…' : 'Publish & pin'}
            </button>
          ) : (
            <button
              type="button"
              className="braid-console__retry"
              onClick={() => onPublish(false)}
              disabled={busy || !dirty || errors > 0}
              title="Your role may publish but not pin; a publisher pins the candidate."
            >
              {busy ? 'Publishing…' : 'Publish as candidate'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function TextField({
  label,
  value,
  onChange,
  hint,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <label className="braid-console__field">
      <span className="braid-console__fieldlabel">{label}</span>
      <input className={mono ? 'braid-console__mono' : undefined} value={value} spellCheck={false} onChange={(event) => onChange(event.target.value)} />
      {hint && <span className="braid-console__desc">{hint}</span>}
    </label>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="braid-console__ghost braid-console__add" onClick={onClick}>
      {label}
    </button>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="braid-console__ghost" onClick={onClick} aria-label={label}>
      ✕
    </button>
  );
}

/**
 * A starting shell: a three-row page. Its id and its route are both unique, so two new shells
 * never collide — a page has one shell, and validation refuses two on the same route.
 */
export function newShell(existing: readonly ShellManifest[], tags?: string[]): ShellManifest {
  const ids = new Set(existing.map((shell) => shell.id));
  const paths = new Set(existing.flatMap((shell) => shell.routes.map((route) => route.path)));
  let id = 'new-shell';
  for (let n = 2; ids.has(id) || paths.has(`/${id}`); n += 1) id = `new-shell-${n}`;
  return {
    id,
    framework: 'react',
    ...(tags ? { tags } : {}),
    routes: [{ path: `/${id}`, layout: { areas: 'header header\nnav main\nfooter footer', columns: '220px 1fr', rows: 'auto 1fr auto' }, slots: {} }],
  };
}

function frameworkLabel(framework: ShellFramework): string {
  return SHELL_TARGETS.find((target) => target.id === framework)?.label ?? framework;
}

/** Clearing a field removes it: an empty input means unset, the same rule as the fragment editor. */
function optional<K extends string>(key: K, value: string): { [P in K]?: string } {
  return (value.trim() === '' ? { [key]: undefined } : { [key]: value }) as { [P in K]?: string };
}

function optionalList<K extends string>(key: K, text: string): { [P in K]?: string[] } {
  const list = text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return (list.length ? { [key]: list } : { [key]: undefined }) as { [P in K]?: string[] };
}

function optionalFlag<T extends object>(value: T, key: 'defer' | 'async', on: boolean): T {
  const next = { ...value } as Record<string, unknown>;
  if (on) next[key] = true;
  else delete next[key];
  return next as T;
}

/** `og:` names are properties in Open Graph; everything else is a plain name. */
function metaName(entry: { content: string }, name: string): { name?: string; property?: string; content: string } {
  return name.startsWith('og:') ? { property: name, content: entry.content } : { name, content: entry.content };
}

function replace<T>(list: readonly T[], index: number, value: T): T[] {
  return list.map((item, position) => (position === index ? value : item));
}

function prune<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0));
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

function rootClass(className?: string): string {
  return `braid-console${className ? ` ${className}` : ''}`;
}

function themeAttr(theme?: 'light' | 'dark'): Record<string, string> {
  return theme ? { 'data-theme': theme } : {};
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
