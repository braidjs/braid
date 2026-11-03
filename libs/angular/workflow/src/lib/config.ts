import {
  type EnvironmentProviders,
  InjectionToken,
  makeEnvironmentProviders,
} from '@angular/core';
import {
  type StorageDriver,
  type VersionedSchema,
  type VersionedStore,
  createVersionedStore,
  webStorageDriver,
} from '@braidlabs/skew';

export interface WorkflowOptions {
  /**
   * Persistence for drafts. Return `null` to keep runs in memory, which means
   * a refresh loses the user's progress — appropriate only for short flows
   * with nothing worth resuming.
   */
  readonly draftStore?: <T>(schema: VersionedSchema<T>) => VersionedStore<T>;
  /**
   * Route prefix the workflow's step routes live under, used for navigation.
   * Omit to run the workflow without touching the URL.
   */
  readonly basePath?: string;
  /**
   * Reports draft trouble: a draft from a newer build, a failed migration, a
   * storage write that did not land.
   *
   * Worth wiring to telemetry — a draft that silently fails to save looks
   * identical to one that saved, right up until the user comes back.
   */
  readonly onDraftError?: (message: string, detail?: unknown) => void;
}

export const WORKFLOW_OPTIONS = new InjectionToken<WorkflowOptions>('SKEW_WORKFLOW_OPTIONS');

export interface WorkflowOptionsInput extends Omit<WorkflowOptions, 'draftStore'> {
  readonly draftStore?: WorkflowOptions['draftStore'];
  /** Convenience: persist drafts in Web Storage. */
  readonly persistDrafts?: boolean;
  readonly buildId?: string;
  /**
   * Whose drafts these are, read on every draft read and write: `() => tenancy.partition()`, or
   * the signed-in user's id. Set it on any device more than one person signs in to. Drafts are kept
   * device-wide in localStorage, so without a scope the next person to open the wizard resumes the
   * last person's draft. Pair it with `clearWorkflowDrafts(scope)` at sign-out.
   */
  readonly scope?: () => string;
  /** Where the default store writes drafts. Defaults to localStorage. */
  readonly draftDriver?: StorageDriver;
}

const DRAFT_SCOPE_PREFIX = 'braid-draft:';

/** Keys every draft under the current scope, so one person's drafts are invisible to the next. */
function scopedDriver(inner: StorageDriver, scope: () => string): StorageDriver {
  const prefix = () => `${DRAFT_SCOPE_PREFIX}${scope()}:`;
  return {
    sync: inner.sync,
    get: (key) => inner.get(prefix() + key),
    set: (key, value) => inner.set(prefix() + key, value),
    remove: (key) => inner.remove(prefix() + key),
    keys: async () => {
      const at = prefix();
      return ((await inner.keys?.()) ?? []).filter((key) => key.startsWith(at)).map((key) => key.slice(at.length));
    },
  };
}

/**
 * Deletes every draft kept under `scope`. Call it at sign-out with the scope the person was using.
 * Drafts kept with no scope are device-wide and are not touched.
 */
export async function clearWorkflowDrafts(scope: string, driver: StorageDriver = webStorageDriver('local')): Promise<void> {
  const prefix = `${DRAFT_SCOPE_PREFIX}${scope}:`;
  for (const key of (await driver.keys?.()) ?? []) {
    if (key.startsWith(prefix)) await driver.remove(key);
  }
}

export function resolveWorkflowOptions(input: WorkflowOptionsInput = {}): WorkflowOptions {
  const draftStore =
    input.draftStore ??
    (input.persistDrafts === false
      ? undefined
      : <T>(schema: VersionedSchema<T>) =>
          createVersionedStore(schema, {
            driver: input.scope
              ? scopedDriver(input.draftDriver ?? webStorageDriver('local'), input.scope)
              : (input.draftDriver ?? webStorageDriver('local')),
            ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
          }));

  return {
    ...(draftStore === undefined ? {} : { draftStore }),
    ...(input.basePath === undefined ? {} : { basePath: input.basePath }),
    ...(input.onDraftError === undefined ? {} : { onDraftError: input.onDraftError }),
  };
}

/**
 * Enables workflows.
 *
 * ```ts
 * provideSkewWorkflow({
 *   basePath: '/bulletins/new',
 *   buildId: BUILD_ID,
 *   onDraftError: (message, detail) => telemetry.warn(message, detail),
 * });
 * ```
 */
export function provideSkewWorkflow(input: WorkflowOptionsInput = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: WORKFLOW_OPTIONS, useValue: resolveWorkflowOptions(input) },
  ]);
}
