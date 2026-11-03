# @braidlabs/angular-workflow

Durable multi-step workflows for Angular — router-integrated, resumable, and with **versioned drafts** that survive a deploy.

Signals throughout. Headless. No NgModules.

---

## Why not just use a state machine

XState is a fine state machine, and it knows nothing about URLs, guards, resumption, or `CanDeactivate`. The machine is the easy part.

What no library owns is the **integration**:

- step ↔ route mapping
- guard-checked deep links — step four with step two blank redirects to step two
- a back button that walks the *workflow*, not raw browser history
- resumption after refresh, and after a deploy that changed the draft's shape
- idempotency for the terminal submit

That's what this package is for.

---

## Define

```ts
export const bulletinFlow = defineWorkflow({
  id: 'bulletin-creation',
  initial: { templateId: '', parishId: '', needsSetup: false, body: '' },
  steps: {
    template: { route: 'template', validate: (d) => !!d.templateId, next: 'parish' },
    parish:   { route: 'parish',   validate: (d) => !!d.parishId,
                next: (d) => (d.needsSetup ? 'setup' : 'content') },
    setup:    { route: 'setup',    next: 'content' },
    content:  { route: 'content',  validate: (d) => d.body.length > 0, next: 'review' },
    review:   { route: 'review',   terminal: true,
                submit: (d, ctx) => api.publish(d, { idempotencyKey: ctx.runId }) },
  },
});
```

Mistakes are caught at definition time, not halfway through a user's session: a `next` pointing at an unknown step, a step that neither advances nor terminates, two steps sharing a route.

## Use

```ts
export class BulletinWizard {
  readonly flow = injectWorkflow(bulletinFlow);
}
```

```ts
flow.current();        // Signal<StepId>
flow.data();           // Signal<TData>
flow.canAdvance();     // Signal<boolean>
flow.progress();       // Signal<{ done, total, percent }>
flow.savedLocally();   // Signal<'idle'|'saving'|'saved'|'error'>
flow.savedRemotely();

await flow.advance({ templateId: 'missale' });
await flow.goTo('parish');
await flow.submit();
```

Two components binding the same definition share one run — they can't race each other's drafts.

## Route

```ts
export const routes: Routes = [
  {
    path: 'bulletins/new',
    children: workflowRoutes(bulletinFlow, {
      template: () => import('./steps/template').then((m) => m.TemplateStep),
      parish:   () => import('./steps/parish').then((m) => m.ParishStep),
      // …
    }),
  },
];
```

Each step gets a guarded route plus a redirect from the base path to the first step. The guard is a *question*, never a state transition — it uses the pure `pathTo()` and redirects to the furthest reachable step.

---

## Decisions worth knowing

**Idempotency is established at the start, not at submit.** A `runId` is minted when the run begins and carried into the terminal `submit`. Users double-click, networks retry, and a workflow resumed on another device is still the same intent — without a key fixed up front, every one of those creates a duplicate. The run id survives every transition *and* a resume.

**Local and remote saves are surfaced separately.** "Safe on this device" and "safe on the server" are different promises and users can tell. A failed remote save leaves `savedLocally() === 'saved'`, which is honest and still worth showing.

**Progress follows the branch the data selects.** Counting every declared step would strand a user on the short path at 60% forever.

**Drafts are versioned via `@braidlabs/skew`.** A draft written by build 41 and resumed under 57 is the same boundary as a client calling a newer server — the counterparty is your own past deployment.

```ts
defineWorkflow({
  id: 'bulletin-creation',
  schema: versioned<DataV1>('bulletin-data')
    .next<DataV2>('rename template to templateId', (p) => ({ ...p, templateId: p.template })),
  // …
});
```

Without this, every schema change silently corrupts drafts already in flight. A draft from a *newer* build is left alone rather than mangled — `@braidlabs/skew` reports it as `ahead`.

**Concurrent submits are refused.** Double-clicking Publish throws rather than sending twice.

---

## Testing

Workflows are exactly the code that breaks in production and is miserable to exercise through a UI. The engine is pure, so transitions assert without a TestBed, a router, or a rendered component:

```ts
const run = testWorkflow(bulletinFlow)
  .advance({ templateId: 'missale' })
  .advance({ parishId: 'p', needsSetup: true });

expect(run.current()).toBe('setup');           // took the branch
expect(testWorkflow(bulletinFlow).goTo('review').current()).toBe('template');  // deep link blocked

const seeded = testWorkflow(bulletinFlow).at('content', { body: 'text' });     // jump to a state
```

---

## Setup

```ts
provideSkewWorkflow({
  basePath: '/bulletins/new',   // omit to run without touching the URL
  buildId: BUILD_ID,
  onDraftError: (message, detail) => telemetry.warn(message, detail),
});
```

`onDraftError` is worth wiring: a draft that silently fails to save looks identical to one that saved, right up until the user comes back.

**On a device more than one person signs in to, scope the drafts.** They live in localStorage, which
the whole device shares, so without a scope the next person to open the wizard resumes the last
person's half-filled form. Scope them to the signed-in person and clear them at sign-out:

```ts
provideSkewWorkflow({ scope: () => tenancy.partition() });

// at sign-out, before the partition changes
await clearWorkflowDrafts(tenancy.partition());
```

---

## API

| Export | Purpose |
|---|---|
| `defineWorkflow(def)` | Declare and validate a flow |
| `injectWorkflow(flow)` | Bind it to signals, persistence, routing |
| `workflowRoutes(flow, components)` | Generate guarded routes |
| `workflowGuard(flow, step)` | The guard, if you build routes yourself |
| `testWorkflow(flow, initial?)` | Headless harness |
| `pathTo` · `resolveNext` · `progress` · `isComplete` | Pure engine functions |
| `provideSkewWorkflow(options)` | Wire it up |
| `clearWorkflowDrafts(scope)` | Delete one person's drafts, at sign-out |

---

## Known limitation

Steps share a single `TData` shape rather than accumulating a per-step type (step 3 statically knowing steps 1–2's fields). A fully generic accumulation chain is expressible, but produces type errors that are very hard to read, and validation libraries already own the per-step shape. Documented as a deliberate trade rather than an oversight — see the [Technical Appendix](../../../technical-appendix.md).
