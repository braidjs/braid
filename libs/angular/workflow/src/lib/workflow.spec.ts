import { Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createVersionedStore, memoryDriver, versioned } from '@braidlabs/skew';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_OPTIONS, clearWorkflowDrafts, resolveWorkflowOptions } from './config';
import { defineWorkflow } from './definition';
import { injectWorkflow } from './workflow';

interface Data {
  templateId: string;
  body: string;
}

const flow = defineWorkflow<Data>({
  id: 'bulletin',
  initial: { templateId: '', body: '' },
  steps: {
    template: { route: 'template', validate: (d) => !!d.templateId, next: 'content' },
    content: { route: 'content', validate: (d) => !!d.body, next: 'review' },
    review: { route: 'review', terminal: true, submit: async () => ({ ok: true }) },
  },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function configure(options: {
  storage?: Map<string, string>;
  onDraftError?: (message: string, detail?: unknown) => void;
  persist?: boolean;
} = {}) {
  const storage = options.storage ?? new Map<string, string>();
  const driver = memoryDriver(storage);

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: WORKFLOW_OPTIONS,
        useValue: resolveWorkflowOptions({
          ...(options.persist === false
            ? { persistDrafts: false }
            : { draftStore: (schema) => createVersionedStore(schema, { driver }) }),
          ...(options.onDraftError ? { onDraftError: options.onDraftError } : {}),
        }),
      },
    ],
  });

  return { injector: TestBed.inject(Injector), storage };
}

beforeEach(() => TestBed.resetTestingModule());

describe('injectWorkflow', () => {
  it('starts at the first step with the initial data', () => {
    const { injector } = configure();
    const wf = runInInjectionContext(injector, () => injectWorkflow(flow));

    expect(wf.current()).toBe('template');
    expect(wf.data()).toEqual({ templateId: '', body: '' });
    expect(wf.canAdvance()).toBe(false);
  });

  it('advances when the step is satisfied', async () => {
    const { injector } = configure();
    const wf = runInInjectionContext(injector, () => injectWorkflow(flow));

    const landed = await wf.advance({ templateId: 'missale' });

    expect(landed).toBe('content');
    expect(wf.current()).toBe('content');
  });

  it('shares one run between two consumers of the same definition', () => {
    const { injector } = configure();
    const a = runInInjectionContext(injector, () => injectWorkflow(flow));
    const b = runInInjectionContext(injector, () => injectWorkflow(flow));

    // Two components binding the same workflow must not race separate drafts.
    expect(a.runId()).toBe(b.runId());
    a.patch({ templateId: 'x' });
    expect(b.data().templateId).toBe('x');
  });

  it('persists the draft locally as the user works', async () => {
    const { injector, storage } = configure();
    const wf = runInInjectionContext(injector, () => injectWorkflow(flow));

    wf.patch({ templateId: 'missale' });
    await settle();

    expect(wf.savedLocally()).toBe('saved');
    expect(storage.size).toBeGreaterThan(0);
  });

  it('resumes a draft left by an earlier session', async () => {
    const storage = new Map<string, string>();

    const first = configure({ storage });
    const a = runInInjectionContext(first.injector, () => injectWorkflow(flow));
    await a.advance({ templateId: 'missale' });
    await settle();
    const originalRunId = a.runId();

    // A refresh: same storage, everything else new.
    const second = configure({ storage });
    const b = runInInjectionContext(second.injector, () => injectWorkflow(flow));
    await settle();

    expect(b.current()).toBe('content');
    expect(b.data().templateId).toBe('missale');
    // Same run id, so a resumed submit still deduplicates against the original.
    expect(b.runId()).toBe(originalRunId);
  });

  it('does not resume a draft written by a newer build', async () => {
    const storage = new Map<string, string>();
    storage.set(
      'skew-workflow-run:bulletin',
      JSON.stringify({ v: 99, payload: { runId: 'x', current: 'review' } }),
    );
    const onDraftError = vi.fn();
    const { injector } = configure({ storage, onDraftError });

    const wf = runInInjectionContext(injector, () => injectWorkflow(flow));
    await settle();

    expect(wf.current()).toBe('template');
    expect(onDraftError).toHaveBeenCalledWith(
      expect.stringContaining('newer build'),
      expect.anything(),
    );
  });

  it('migrates a draft payload written under an older data schema', async () => {
    interface OldData {
      template: string;
      body: string;
    }
    const schema = versioned<OldData>('bulletin-data').next<Data>('rename template', (p) => ({
      templateId: p.template,
      body: p.body,
    }));
    const migrating = defineWorkflow<Data>({ ...flow, schema });

    const storage = new Map<string, string>();
    storage.set(
      'skew-workflow-run:bulletin',
      JSON.stringify({
        v: 1,
        payload: {
          runId: 'bulletin:old',
          workflowId: 'bulletin',
          current: 'content',
          data: { v: 1, payload: { template: 'legacy', body: 'text' } },
          visited: ['template', 'content'],
          startedAt: 1,
          updatedAt: 1,
          status: 'active',
        },
      }),
    );

    const { injector } = configure({ storage });
    const wf = runInInjectionContext(injector, () => injectWorkflow(migrating));
    await settle();

    expect(wf.data().templateId).toBe('legacy');
  });

  it('carries the run id into submit as an idempotency key', async () => {
    const submit = vi.fn(async () => ({ ok: true }));
    const submitting = defineWorkflow<Data>({
      ...flow,
      steps: { ...flow.steps, review: { route: 'review', terminal: true, submit } },
    });
    const { injector } = configure();
    const wf = runInInjectionContext(injector, () => injectWorkflow(submitting));

    await wf.advance({ templateId: 't' });
    await wf.advance({ body: 'text' });
    const runId = wf.runId();
    await wf.submit();

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'text' }),
      expect.objectContaining({ runId, workflowId: 'bulletin' }),
    );
  });

  it('clears the draft once submitted', async () => {
    const { injector, storage } = configure();
    const wf = runInInjectionContext(injector, () => injectWorkflow(flow));

    await wf.advance({ templateId: 't' });
    await wf.advance({ body: 'text' });
    await wf.submit();

    expect(wf.isDirty()).toBe(false);
    expect(storage.has('skew-workflow-run:bulletin')).toBe(false);
  });

  it('refuses to submit from a non-terminal step', async () => {
    const { injector } = configure();
    const wf = runInInjectionContext(injector, () => injectWorkflow(flow));

    await expect(wf.submit()).rejects.toThrow(/declares no submit/);
  });

  it('refuses a concurrent submit', async () => {
    let release: (() => void) | undefined;
    const submitting = defineWorkflow<Data>({
      ...flow,
      steps: {
        ...flow.steps,
        review: {
          route: 'review',
          terminal: true,
          submit: () => new Promise((r) => (release = () => r(undefined))),
        },
      },
    });
    const { injector } = configure();
    const wf = runInInjectionContext(injector, () => injectWorkflow(submitting));
    await wf.advance({ templateId: 't' });
    await wf.advance({ body: 'text' });

    const first = wf.submit();
    // Double-clicking a Publish button must not send two requests.
    await expect(wf.submit()).rejects.toThrow(/already in flight/);

    release?.();
    await first;
  });

  it('separates local and remote save state', async () => {
    const remote = vi.fn(async () => undefined);
    const withRemote = defineWorkflow<Data>({
      ...flow,
      persistence: { remote, remoteDebounceMs: 1 },
    });
    const { injector } = configure();
    const wf = runInInjectionContext(injector, () => injectWorkflow(withRemote));

    wf.patch({ templateId: 't' });
    await settle();
    expect(wf.savedLocally()).toBe('saved');

    await new Promise((r) => setTimeout(r, 10));
    expect(remote).toHaveBeenCalled();
    expect(wf.savedRemotely()).toBe('saved');
  });

  it('keeps the local draft when the remote save fails', async () => {
    const withRemote = defineWorkflow<Data>({
      ...flow,
      persistence: {
        remote: async () => {
          throw new Error('server down');
        },
        remoteDebounceMs: 1,
      },
    });
    const { injector } = configure();
    const wf = runInInjectionContext(injector, () => injectWorkflow(withRemote));

    wf.patch({ templateId: 't' });
    await new Promise((r) => setTimeout(r, 10));

    // "Saved on this device" is still true and worth telling the user.
    expect(wf.savedRemotely()).toBe('error');
    expect(wf.savedLocally()).toBe('saved');
  });

  it('resets to a fresh run', async () => {
    const { injector, storage } = configure();
    const wf = runInInjectionContext(injector, () => injectWorkflow(flow));
    await wf.advance({ templateId: 't' });
    const firstRunId = wf.runId();

    await wf.reset();

    expect(wf.current()).toBe('template');
    expect(wf.runId()).not.toBe(firstRunId);
    expect(storage.has('skew-workflow-run:bulletin')).toBe(false);
  });

  it('works without persistence', async () => {
    const { injector } = configure({ persist: false });
    const wf = runInInjectionContext(injector, () => injectWorkflow(flow));

    await wf.advance({ templateId: 't' });

    expect(wf.current()).toBe('content');
  });
});

/** One device, two people. A draft holds what someone typed into a form; it is theirs alone. */
describe('drafts on a shared device', () => {
  function signedInAs(user: { current: string }, storage: Map<string, string>) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WORKFLOW_OPTIONS,
          useValue: resolveWorkflowOptions({ scope: () => user.current, draftDriver: memoryDriver(storage) }),
        },
      ],
    });
    return runInInjectionContext(TestBed.inject(Injector), () => injectWorkflow(flow));
  }

  it("never resumes one person's draft for another, and resumes it for its owner", async () => {
    const storage = new Map<string, string>();
    const user = { current: 'alice' };

    await signedInAs(user, storage).advance({ templateId: 'missale' });
    await settle();

    user.current = 'bob';
    const bobs = signedInAs(user, storage);
    await settle();
    expect(bobs.current()).toBe('template');
    expect(bobs.data().templateId).toBe('');

    user.current = 'alice';
    const alices = signedInAs(user, storage);
    await settle();
    expect(alices.current()).toBe('content');
    expect(alices.data().templateId).toBe('missale');
  });

  it("clears a person's drafts at sign-out, and only theirs", async () => {
    const storage = new Map<string, string>();
    const user = { current: 'alice' };
    await signedInAs(user, storage).advance({ templateId: 'missale' });
    user.current = 'bob';
    await signedInAs(user, storage).advance({ templateId: 'graduale' });
    await settle();

    await clearWorkflowDrafts('alice', memoryDriver(storage));

    user.current = 'alice';
    const alices = signedInAs(user, storage);
    await settle();
    expect(alices.data().templateId).toBe('');

    user.current = 'bob';
    const bobs = signedInAs(user, storage);
    await settle();
    expect(bobs.data().templateId).toBe('graduale');
  });
});
