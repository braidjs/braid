import {
  DestroyRef,
  Injectable,
  type Signal,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { type VersionedStore, isOk } from '@braidlabs/skew';
import { type StepId, type Workflow } from './definition';
import * as engine from './engine';
import { WORKFLOW_OPTIONS, currentDraftScope } from './config';
import { type WorkflowRun, createRun, runSchema } from './run';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface WorkflowRef<TData> {
  readonly current: Signal<StepId>;
  readonly data: Signal<TData>;
  readonly canAdvance: Signal<boolean>;
  readonly canGoBack: Signal<boolean>;
  readonly isComplete: Signal<boolean>;
  readonly progress: Signal<engine.Progress>;
  readonly isDirty: Signal<boolean>;
  readonly isSubmitting: Signal<boolean>;
  /** Persisted on this device. */
  readonly savedLocally: Signal<SaveState>;
  /** Persisted on the server. */
  readonly savedRemotely: Signal<SaveState>;
  readonly runId: Signal<string>;

  patch(partial: Partial<TData>): void;
  advance(partial?: Partial<TData>): Promise<StepId>;
  back(): Promise<StepId>;
  goTo(step: StepId): Promise<StepId>;
  submit(): Promise<unknown>;
  /** Abandons the run and clears the draft. */
  reset(): Promise<void>;
}

/**
 * Binds a workflow definition to Angular: signals, persistence, and routing.
 *
 * Must be called in an injection context.
 *
 * ```ts
 * export class BulletinWizard {
 *   readonly flow = injectWorkflow(bulletinFlow);
 * }
 * ```
 */
export function injectWorkflow<TData>(workflow: Workflow<TData>): WorkflowRef<TData> {
  const runtime = inject(WorkflowRuntime);
  return runtime.attach(workflow);
}

/**
 * Owns every live workflow, so two components binding the same definition
 * share one run rather than racing each other's drafts.
 */
@Injectable({ providedIn: 'root' })
export class WorkflowRuntime {
  private readonly options = inject(WORKFLOW_OPTIONS);
  private readonly router = inject(Router, { optional: true });
  private readonly destroyRef = inject(DestroyRef);
  private readonly attached = new Map<string, WorkflowRef<unknown>>();
  /** Whose runs `attached` holds. Undefined until the first attach. */
  private attachedScope: string | null | undefined;

  attach<TData>(workflow: Workflow<TData>): WorkflowRef<TData> {
    /**
     * A live run holds one person's form data in memory. When someone else signs in without a
     * reload, the next attach must not hand them that run: every run is dropped, and theirs is
     * built from their own drafts.
     */
    if (this.options.scope) {
      const scope = currentDraftScope(this.options.scope);
      if (scope !== this.attachedScope) {
        this.attached.clear();
        this.attachedScope = scope;
      }
    }

    const existing = this.attached.get(workflow.id);
    if (existing) return existing as WorkflowRef<TData>;

    const ref = this.build(workflow);
    this.attached.set(workflow.id, ref as WorkflowRef<unknown>);
    return ref;
  }

  /** Lists drafts left unfinished, so an app can offer to resume them. */
  async pendingRuns(workflows: ReadonlyArray<Workflow<any>>): Promise<
    Array<{ workflowId: string; runId: string; current: StepId; updatedAt: number }>
  > {
    const found: Array<{ workflowId: string; runId: string; current: StepId; updatedAt: number }> = [];
    for (const workflow of workflows) {
      const store = this.storeFor(workflow);
      if (!store) continue;
      const result = await store.get(workflow.id);
      if (isOk(result) && result.value.status !== 'submitted') {
        found.push({
          workflowId: workflow.id,
          runId: result.value.runId,
          current: result.value.current,
          updatedAt: result.value.updatedAt,
        });
      }
    }
    return found.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private storeFor<TData>(workflow: Workflow<TData>): VersionedStore<WorkflowRun<unknown>> | null {
    if (!this.options.draftStore) return null;
    return this.options.draftStore(runSchema);
  }

  private build<TData>(workflow: Workflow<TData>): WorkflowRef<TData> {
    const store = this.storeFor(workflow);
    const run = signal<WorkflowRun<TData>>(
      createRun(workflow.id, workflow.firstStep, workflow.initial),
    );
    const savedLocally = signal<SaveState>('idle');
    const savedRemotely = signal<SaveState>('idle');
    const isSubmitting = signal(false);
    const dirty = signal(false);

    let remoteTimer: ReturnType<typeof setTimeout> | undefined;
    this.destroyRef.onDestroy(() => clearTimeout(remoteTimer));

    // Resume a draft left by an earlier session. Fire-and-forget: the run
    // starts at its initial state and is replaced if a draft turns up, which
    // avoids blocking first paint on storage.
    void (async () => {
      if (!store) return;
      const result = await store.get(workflow.id);
      if (!isOk(result)) {
        if (result.reason === 'ahead') {
          this.options.onDraftError?.(
            `draft for "${workflow.id}" was written by a newer build; not resuming`,
            result,
          );
        }
        return;
      }
      if (result.value.status === 'submitted') return;

      // The envelope unwrapped; now migrate the payload with the workflow's
      // own schema, so a draft written before a data change still opens.
      const payload = workflow.schema.read(result.value.data);
      if (!isOk(payload)) {
        this.options.onDraftError?.(`draft payload for "${workflow.id}" could not be migrated`, payload);
        return;
      }
      run.set({ ...(result.value as WorkflowRun<TData>), data: payload.value });
    })();

    const persistLocal = async (next: WorkflowRun<TData>): Promise<void> => {
      if (!store) return;
      savedLocally.set('saving');
      try {
        await store.set(workflow.id, {
          ...next,
          data: workflow.schema.write(next.data),
        } as unknown as WorkflowRun<unknown>);
        savedLocally.set('saved');
      } catch (error) {
        savedLocally.set('error');
        this.options.onDraftError?.(`failed to persist draft for "${workflow.id}"`, error);
      }
    };

    const scheduleRemote = (next: WorkflowRun<TData>): void => {
      const remote = workflow.persistence?.remote;
      if (!remote) return;
      clearTimeout(remoteTimer);
      remoteTimer = setTimeout(
        () => {
          savedRemotely.set('saving');
          void remote(next.data, {
            runId: next.runId,
            workflowId: next.workflowId,
            startedAt: next.startedAt,
          })
            .then(() => savedRemotely.set('saved'))
            // A failed remote save is not fatal — the local draft still holds
            // the work, and the two states are surfaced separately so the UI
            // can say "saved on this device" honestly.
            .catch(() => savedRemotely.set('error'));
        },
        workflow.persistence?.remoteDebounceMs ?? 1500,
      );
    };

    const commit = async (next: WorkflowRun<TData>): Promise<void> => {
      run.set(next);
      dirty.set(true);
      await persistLocal(next);
      scheduleRemote(next);
    };

    const navigate = async (step: StepId): Promise<void> => {
      const route = workflow.steps[step]?.route;
      if (!route || !this.router || !this.options.basePath) return;
      await this.router.navigate([this.options.basePath, route]);
    };

    return {
      current: computed(() => run().current),
      data: computed(() => run().data),
      runId: computed(() => run().runId),
      canAdvance: computed(() => engine.advance(workflow, run()) !== run()),
      canGoBack: computed(() => run().visited.indexOf(run().current) > 0),
      isComplete: computed(() => engine.isComplete(workflow, run())),
      progress: computed(() => engine.progress(workflow, run())),
      isDirty: dirty.asReadonly(),
      isSubmitting: isSubmitting.asReadonly(),
      savedLocally: savedLocally.asReadonly(),
      savedRemotely: savedRemotely.asReadonly(),

      patch(partial) {
        void commit(engine.patchData(run(), partial));
      },

      async advance(partial) {
        const patched = partial ? engine.patchData(run(), partial) : run();
        const next = engine.advance(workflow, patched);
        await commit(next);
        if (next.current !== run().current || next !== patched) await navigate(next.current);
        return next.current;
      },

      async back() {
        const next = engine.back(run());
        await commit(next);
        await navigate(next.current);
        return next.current;
      },

      async goTo(step) {
        const outcome = engine.goTo(workflow, run(), step);
        await commit(outcome.run);
        await navigate(outcome.landedOn);
        return outcome.landedOn;
      },

      async submit() {
        const step = workflow.steps[run().current];
        if (!step?.submit) {
          throw new Error(`[skew/workflow] step "${run().current}" declares no submit()`);
        }
        if (isSubmitting()) {
          throw new Error('[skew/workflow] submit is already in flight');
        }

        isSubmitting.set(true);
        try {
          const current = run();
          const result = await step.submit(current.data, {
            runId: current.runId,
            workflowId: current.workflowId,
            startedAt: current.startedAt,
          });
          run.set({ ...current, status: 'submitted' });
          dirty.set(false);
          if (store) await store.remove(workflow.id);
          return result;
        } finally {
          isSubmitting.set(false);
        }
      },

      async reset() {
        clearTimeout(remoteTimer);
        run.set(createRun(workflow.id, workflow.firstStep, workflow.initial));
        dirty.set(false);
        savedLocally.set('idle');
        savedRemotely.set('idle');
        if (store) await store.remove(workflow.id);
      },
    };
  }
}
