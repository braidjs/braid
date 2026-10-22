import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FragmentManifest } from '@braidlabs/gateway';
import type { DescriptorNote, FieldChange, NamedPrincipal, RegistryFinding } from '@braidlabs/registry';
import { AccessPanel } from './access-panel.js';
import {
  fetchHead,
  fetchPermissions,
  publishSnapshot,
  RegistryApiError,
  type ConsoleApi,
  type PublishOutcome,
} from './client.js';
import { accessMatrix, ANONYMOUS } from '@braidlabs/registry';
import {
  addFragment,
  createDraft,
  draftStatus,
  formatList,
  parseList,
  removeFragment,
  resetDraft,
  updateFragment,
  type Draft,
} from './draft.js';
import { ensureStyles } from './styles.js';
import { canChange, startingTags } from './ownership.js';
import type { OwnedTags } from '@braidlabs/registry';

export interface RegistryEditorProps {
  /** Must carry an `apiPath` (or accept the default) — editing needs the write API. */
  api?: ConsoleApi;
  theme?: 'light' | 'dark';
  className?: string;
  /** Called after a successful publish, for hosts that want to react (toast, audit, navigate). */
  onPublished?: (outcome: PublishOutcome) => void;
  /**
   * Principals the access preview tests against, beyond anonymous (which is always included).
   *
   * Held by the host when given, so they can be persisted or shared; otherwise the editor keeps
   * them for the session. Either way they are a what-if, not a directory.
   */
  principals?: NamedPrincipal[];
  onPrincipalsChange?: (principals: NamedPrincipal[]) => void;
}

type Phase =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'publishing' }
  | { status: 'published'; outcome: PublishOutcome }
  | { status: 'error'; error: Error; findings: RegistryFinding[]; notes: DescriptorNote[] };

/**
 * Edit the registry and publish it as a new immutable snapshot.
 *
 * The flow is deliberately: **branch from what is pinned → edit → see what it changes → publish**.
 * Publishing never mutates the snapshot being edited; it mints a new one and moves a pointer, so
 * the previous configuration remains exactly as it was and rollback is re-pinning it.
 */
export function RegistryEditor({
  api,
  theme,
  className,
  onPublished,
  principals,
  onPrincipalsChange,
}: RegistryEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => createDraft([]));
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [ownPrincipals, setOwnPrincipals] = useState<NamedPrincipal[]>([]);
  /** Per-tag ownership from /permissions; null when the registry has none, or did not say. */
  const [owned, setOwned] = useState<OwnedTags | null>(null);

  // Controlled when the host supplies them, uncontrolled otherwise — the same shape as any input.
  const testPrincipals = principals ?? ownPrincipals;
  const setPrincipals = (next: NamedPrincipal[]) => (onPrincipalsChange ?? setOwnPrincipals)(next);

  const apiKey = `${api?.baseUrl ?? ''}|${api?.apiPath ?? ''}`;

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;

    setPhase({ status: 'loading' });
    // Ownership only narrows what the editor offers; if it cannot be read, offer everything and let
    // the server refuse what it refuses.
    fetchPermissions(api, controller.signal).then(
      (permissions) => current && setOwned(permissions.tags ?? null),
      () => undefined,
    );
    fetchHead(api, controller.signal).then(
      (head) => {
        if (!current) return;
        setDraft(createDraft(head.snapshot?.manifests ?? [], head.id));
        setPhase({ status: 'ready' });
      },
      (error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setPhase({ status: 'error', error: asError(error), findings: [], notes: [] });
      },
    );

    return () => {
      current = false;
      controller.abort();
    };
    // apiKey stands in for the api object, which is usually a fresh literal each render
  }, [apiKey]);

  const status = useMemo(() => draftStatus(draft), [draft]);

  // Computed whether or not the panel is open: an access loss is a finding, and a finding hidden
  // behind a toggle nobody pressed is not a finding.
  const accessLosses = useMemo(
    () => accessMatrix(draft.manifests, [ANONYMOUS, ...testPrincipals], draft.base).losses.length,
    [draft.manifests, draft.base, testPrincipals],
  );

  const publish = useCallback(async () => {
    setPhase({ status: 'publishing' });
    try {
      const outcome = await publishSnapshot(api ?? {}, { manifests: draft.manifests });
      // Re-base on what was actually published, so the diff resets and a second publish of the
      // same content is correctly reported as no change. A proposal is not published yet: HEAD is
      // where it was, so the draft stays based on it.
      if (!outcome.pullRequest) setDraft(createDraft(draft.manifests, outcome.snapshot.id));
      setPhase({ status: 'published', outcome });
      onPublished?.(outcome);
    } catch (error) {
      const apiError = error instanceof RegistryApiError ? error : null;
      setPhase({
        status: 'error',
        error: asError(error),
        findings: apiError?.findings ?? [],
        notes: apiError?.descriptorNotes ?? [],
      });
    }
  }, [api, draft.manifests, onPublished]);

  if (phase.status === 'loading') {
    return (
      <div className={rootClass(className)} {...themeAttr(theme)}>
        <p className="braid-console__empty">Loading the pinned registry…</p>
      </div>
    );
  }

  return (
    <div className={rootClass(className)} {...themeAttr(theme)}>
      <div className="braid-console__header">
        <h2 className="braid-console__title">Edit registry</h2>
        <span className="braid-console__count">
          {draft.baseId ? (
            <>
              from <code className="braid-console__mono">{draft.baseId}</code>
            </>
          ) : (
            'nothing published yet'
          )}
        </span>
        <span className="braid-console__spacer" />
        <button className="braid-console__retry" type="button" onClick={() => setDraft(addFragment(draft, startingTags(owned)))}>
          Add fragment
        </button>
      </div>

      {phase.status === 'error' && <ErrorPanel phase={phase} />}
      {phase.status === 'published' && <PublishedPanel outcome={phase.outcome} />}

      {draft.manifests.length === 0 ? (
        <p className="braid-console__empty">No fragments. Add one to get started.</p>
      ) : (
        <ul className="braid-console__list">
          {draft.manifests.map((manifest, index) => (
            <FragmentRow
              key={index}
              manifest={manifest}
              findings={status.findings.filter((finding) => finding.fragmentIds.includes(manifest.id))}
              expanded={expanded === index}
              // Judged by the tags it was published with, so retagging cannot unlock it mid-edit.
              editable={canChange((draft.base.find((base) => base.id === manifest.id) ?? manifest).tags, owned)}
              onToggle={() => setExpanded(expanded === index ? null : index)}
              onChange={(patch) => setDraft(updateFragment(draft, index, patch))}
              onRemove={() => {
                setDraft(removeFragment(draft, index));
                setExpanded(null);
              }}
            />
          ))}
        </ul>
      )}

      {showDiff && <DiffPanel changes={status.diff} />}
      {showAccess && (
        <AccessPanel
          manifests={draft.manifests}
          base={draft.base}
          principals={testPrincipals}
          onPrincipalsChange={setPrincipals}
        />
      )}

      <PublishBar
        status={status}
        phase={phase}
        showDiff={showDiff}
        onToggleDiff={() => setShowDiff(!showDiff)}
        showAccess={showAccess}
        onToggleAccess={() => setShowAccess(!showAccess)}
        accessLosses={accessLosses}
        onReset={() => setDraft(resetDraft(draft))}
        onPublish={publish}
      />
    </div>
  );
}

function FragmentRow({
  manifest,
  findings,
  expanded,
  editable,
  onToggle,
  onChange,
  onRemove,
}: {
  manifest: FragmentManifest;
  findings: RegistryFinding[];
  expanded: boolean;
  editable: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<FragmentManifest>) => void;
  onRemove: () => void;
}) {
  const errors = findings.filter((finding) => finding.severity === 'error');

  const fieldsId = `braid-fields-${manifest.id || 'new'}`;

  return (
    <li className={`braid-console__card${expanded ? ' is-open' : ''}`}>
      {/* Two controls open the same panel on purpose. The caret is what a reader who already knows
          this pattern reaches for; the labelled button is what everyone else needs, because a 6px
          glyph is not an advertisement that a record is editable at all. */}
      <div className="braid-console__cardhead">
        <button
          className="braid-console__disclose"
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={fieldsId}
        >
          <span className="braid-console__caret" aria-hidden="true">
            ▸
          </span>
          <span className="braid-console__id">{manifest.id || '(no id)'}</span>
        </button>
        <span className="braid-console__mono">{String(manifest.endpoint || '(no endpoint)')}</span>
        {/* A collapsed card should still read as the record it is, rather than an id and a button. */}
        {!expanded && manifest.pierce?.length ? (
          <span className="braid-console__cardmeta">
            pierces <span className="braid-console__mono">{formatList(manifest.pierce)}</span>
          </span>
        ) : null}
        <span className="braid-console__spacer" />
        {errors.length > 0 && (
          <span className="braid-console__badge braid-console__badge--error">{errors.length} error</span>
        )}
        {editable ? (
          <>
            <button
              className="braid-console__ghost"
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-controls={fieldsId}
            >
              {expanded ? 'Done' : 'Edit'}
            </button>
            <button className="braid-console__ghost" type="button" onClick={onRemove} aria-label={`Remove ${manifest.id}`}>
              Remove
            </button>
          </>
        ) : (
          <span className="braid-console__desc" title="Owned by another team's tags">
            read-only
          </span>
        )}
      </div>

      {findings.length > 0 && (
        <ul className="braid-console__findings">
          {findings.map((finding, index) => (
            <li key={index} className={`braid-console__finding braid-console__finding--${finding.severity}`}>
              {finding.message}
              {finding.hint && <span className="braid-console__desc"> {finding.hint}</span>}
            </li>
          ))}
        </ul>
      )}

      {expanded && editable && <FragmentFields manifest={manifest} onChange={onChange} id={fieldsId} />}
    </li>
  );
}

function FragmentFields({
  manifest,
  onChange,
  id,
}: {
  manifest: FragmentManifest;
  onChange: (patch: Partial<FragmentManifest>) => void;
  id: string;
}) {
  const endpointIsFunction = typeof manifest.endpoint === 'function';

  return (
    <div className="braid-console__fields" id={id}>
      <Field label="id" hint="addresses the fragment; no “/”">
        <input value={manifest.id} onChange={(event) => onChange({ id: event.target.value })} />
      </Field>

      <Field label="endpoint" hint={endpointIsFunction ? 'an in-process fetch function' : 'absolute URL'} owner="gateway">
        <input
          value={endpointIsFunction ? '(function)' : String(manifest.endpoint ?? '')}
          disabled={endpointIsFunction}
          onChange={(event) => onChange({ endpoint: event.target.value })}
        />
      </Field>

      <Field label="pierce" hint="page URL patterns, comma separated" owner="gateway">
        <input
          value={formatList(manifest.pierce)}
          onChange={(event) => onChange({ pierce: parseList(event.target.value) })}
        />
      </Field>

      <Field label="title">
        <input value={manifest.title ?? ''} onChange={(event) => onChange({ title: event.target.value })} />
      </Field>

      <Field label="description">
        <input
          value={manifest.description ?? ''}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </Field>

      <Field label="tags" hint="comma separated">
        <input value={formatList(manifest.tags)} onChange={(event) => onChange({ tags: parseList(event.target.value) })} />
      </Field>

      <Field label="adapter">
        <select value={manifest.adapter ?? ''} onChange={(event) => onChange({ adapter: event.target.value })}>
          <option value="">compat (default)</option>
          <option value="compat">compat</option>
          <option value="custom-element">custom-element</option>
        </select>
      </Field>

      {manifest.adapter === 'custom-element' && (
        <>
          <Field label="entry" hint="module to evaluate in the realm">
            <input value={manifest.entry ?? ''} onChange={(event) => onChange({ entry: event.target.value })} />
          </Field>
          <Field label="element" hint="tag name that module defines">
            <input value={manifest.element ?? ''} onChange={(event) => onChange({ element: event.target.value })} />
          </Field>
        </>
      )}

      <Field label="fallback" hint="when SSR of this fragment fails" owner="gateway">
        <select
          value={manifest.fallback ?? ''}
          onChange={(event) => onChange({ fallback: (event.target.value || undefined) as FragmentManifest['fallback'] })}
        >
          <option value="">placeholder (default)</option>
          <option value="placeholder">placeholder</option>
          <option value="omit">omit</option>
          <option value="error-html">error-html</option>
        </select>
      </Field>

      <Field label="access.list" hint="roles, any-of — blank is public" owner="gateway">
        <input
          value={formatList(manifest.access?.list?.roles)}
          onChange={(event) => onChange({ access: withRoles(manifest, 'list', parseList(event.target.value)) })}
        />
      </Field>

      <Field label="access.fetch" hint="roles, any-of — blank is public" owner="gateway">
        <input
          value={formatList(manifest.access?.fetch?.roles)}
          onChange={(event) => onChange({ access: withRoles(manifest, 'fetch', parseList(event.target.value)) })}
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  hint,
  owner,
  children,
}: {
  label: string;
  hint?: string;
  owner?: 'gateway';
  children: React.ReactNode;
}) {
  return (
    <label className="braid-console__field">
      <span className="braid-console__fieldlabel">
        {label}
        {/* Gateway-owned fields are marked because their blast radius is different in kind: a
            fragment descriptor may never supply these, and changing one alters routing or who can
            reach what rather than how a row is labelled. */}
        {owner === 'gateway' && (
          <span className="braid-console__owner" title="Gateway-owned: routing or exposure">
            gateway
          </span>
        )}
      </span>
      {children}
      {hint && <span className="braid-console__desc">{hint}</span>}
    </label>
  );
}

function DiffPanel({ changes }: { changes: ReturnType<typeof draftStatus>['diff'] }) {
  if (changes.identical) {
    return <p className="braid-console__empty">No changes yet.</p>;
  }

  return (
    <div className="braid-console__diff">
      {changes.added.map((manifest) => (
        <div key={`+${manifest.id}`} className="braid-console__diffline braid-console__diffline--add">
          + {manifest.id}
        </div>
      ))}
      {changes.removed.map((manifest) => (
        <div key={`-${manifest.id}`} className="braid-console__diffline braid-console__diffline--remove">
          − {manifest.id}
        </div>
      ))}
      {changes.changed.map(({ id, changes: fields }) => (
        <div key={`~${id}`} className="braid-console__diffline">
          <div>~ {id}</div>
          {fields.map((change: FieldChange) => (
            <div key={change.field} className="braid-console__diffield">
              <span className="braid-console__mono">{change.field}</span>{' '}
              <span className={`braid-console__owner braid-console__owner--${change.owner}`}>{change.owner}</span>
              <div className="braid-console__mono">
                {short(change.before)} → {short(change.after)}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function PublishBar({
  status,
  phase,
  showDiff,
  onToggleDiff,
  showAccess,
  onToggleAccess,
  accessLosses,
  onReset,
  onPublish,
}: {
  status: ReturnType<typeof draftStatus>;
  phase: Phase;
  showDiff: boolean;
  onToggleDiff: () => void;
  showAccess: boolean;
  onToggleAccess: () => void;
  accessLosses: number;
  onReset: () => void;
  onPublish: () => void;
}) {
  const errors = status.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = status.findings.length - errors;

  return (
    <div className="braid-console__bar">
      <span className={errors > 0 ? 'braid-console__barstate--error' : 'braid-console__barstate'}>
        {errors > 0
          ? `${errors} error${errors === 1 ? '' : 's'} — cannot publish`
          : status.clean
            ? 'No changes'
            : `Ready${warnings > 0 ? ` — ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`}
      </span>
      <span className="braid-console__spacer" />
      {accessLosses > 0 && (
        <span className="braid-console__barstate--error">
          {accessLosses} access loss{accessLosses === 1 ? '' : 'es'}
        </span>
      )}
      <button className="braid-console__ghost" type="button" onClick={onToggleAccess}>
        {showAccess ? 'Hide access' : 'Show access'}
      </button>
      <button className="braid-console__ghost" type="button" onClick={onToggleDiff}>
        {showDiff ? 'Hide changes' : 'Show changes'}
      </button>
      <button className="braid-console__ghost" type="button" onClick={onReset} disabled={status.clean}>
        Discard
      </button>
      <button
        className="braid-console__primary"
        type="button"
        onClick={onPublish}
        disabled={status.blocked || status.clean || phase.status === 'publishing'}
      >
        {phase.status === 'publishing' ? 'Publishing…' : 'Publish'}
      </button>
    </div>
  );
}

function PublishedPanel({ outcome }: { outcome: PublishOutcome }) {
  if (outcome.pullRequest) {
    return (
      <div className="braid-console__notice braid-console__notice--ok" role="status">
        <span aria-hidden="true">✓</span>
        <span>
          Proposed as{' '}
          <a href={outcome.pullRequest.url} target="_blank" rel="noreferrer">
            pull request #{outcome.pullRequest.number}
          </a>
          . It is published when the pull request is merged.
        </span>
      </div>
    );
  }
  return (
    <div className="braid-console__notice braid-console__notice--ok" role="status">
      <span aria-hidden="true">✓</span>
      <span>
        Published <code className="braid-console__mono">{outcome.snapshot.id}</code> —{' '}
        {outcome.snapshot.fragmentCount} fragment{outcome.snapshot.fragmentCount === 1 ? '' : 's'}
        {outcome.pinned ? ', now pinned.' : ', not pinned.'}{' '}
        {outcome.pinned && 'A gateway following HEAD serves it within its refresh interval, or on restart without one.'}
      </span>
    </div>
  );
}

function ErrorPanel({ phase }: { phase: Extract<Phase, { status: 'error' }> }) {
  return (
    <div className="braid-console__error" role="alert">
      <h3>Could not publish</h3>
      <p>{phase.error.message}</p>
      {phase.findings.length > 0 && (
        <ul className="braid-console__findings">
          {phase.findings.map((finding, index) => (
            <li key={index}>{finding.message}</li>
          ))}
        </ul>
      )}
      {phase.notes.length > 0 && (
        <ul className="braid-console__findings">
          {phase.notes.map((note, index) => (
            <li key={index}>{note.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function withRoles(manifest: FragmentManifest, key: 'list' | 'fetch', roles: string[]) {
  const access = { ...(manifest.access ?? {}) };
  if (roles.length === 0) delete access[key];
  else access[key] = { ...access[key], roles };
  return access;
}

function short(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (typeof value === 'function') return '(function)';
  const json = JSON.stringify(value);
  return json.length > 48 ? `${json.slice(0, 45)}…` : json;
}

const rootClass = (className?: string) => `braid-console${className ? ` ${className}` : ''}`;
const themeAttr = (theme?: 'light' | 'dark') => (theme ? { 'data-theme': theme } : {});
const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
