# Default working agreement

This applies to every session, every project, unless the project's own CLAUDE.md
overrides it.

## Pipeline

Non-trivial work runs: **PLAN → SIMPLIFY → BUILD → TEST → REVIEW → SHIP → CONTINUE.**

Before starting, size the task in one line and say which path you're taking:

- **Trivial** — typo, comment, rename, version bump, config value, a single
  obvious one-liner with no behavior change. Go straight to BUILD → TEST → SHIP.
- **Standard** — anything touching more than one file, changing behavior,
  adding a dependency, or that you can't fully hold in your head. Run the full pipeline.

When in doubt it is standard. Say which you chose and move — don't ask me.

### 1. PLAN — delegate to the `planner` subagent

Hand it the request and enough context to be useful. It returns a task breakdown
and, critically, **acceptance criteria written as observable outcomes**.

Present the plan to me and stop for approval. This is the one place you wait.

### 2. SIMPLIFY — delegate to the `simplifier` subagent

Before writing code, not after. It cuts scope, kills speculative abstraction, and
finds the smaller version of the plan. Cheaper to delete a step than to delete code.

Fold its cuts into the plan. If it disagrees with the planner on something
material, tell me in one line rather than silently picking a side.

### 3. Lock the goal

Write the approved acceptance criteria to `.claude/current-goal.md` as a checklist
(see `/goal-set`) and run `rm -f .claude/.goal-turns`. From here the Stop hook
keeps you working until every box is checked and tests pass.

### 4. BUILD — you do this yourself, on the main thread

Do not delegate implementation to a subagent. A subagent can't see the plan
discussion, the earlier edits, or my corrections, so delegated code drifts from
what we agreed. Build here where the context lives.

Work one checklist item at a time. Test-driven where tests make sense. Commit per
completed item — small commits are what make `git revert` a real safety net.

### 5. TEST — delegate to `test-engineer`

For finding the gaps in coverage and writing the cases you didn't think of.
You still run the suite yourself; the Stop hook checks it independently.

### 6. REVIEW — delegate, in parallel, in one turn

Spawn `code-reviewer` and `goal-verifier` concurrently. Add `security-auditor`
when the change touches auth, input handling, secrets, network, or file paths.
Add `web-performance-auditor` for anything user-facing.

Send them all in a single message so they run at once.

Fix what comes back. If a verifier disputes a checked item, uncheck it in
`.claude/current-goal.md` and keep working — don't argue with it.

### 7. SHIP — delegate to `shipper`

It writes the commit message from the actual diff and pushes. Feature branches
push automatically. Pushes to `main`/`master` and all force-pushes are blocked by
a hook — that's deliberate, don't try to work around it. If you're on main and the
work warrants a branch, create one.

### 8. CONTINUE

Move to the next unchecked item without checking in. When the list is clean and
tests pass, the Stop hook archives the goal and you can stop.

## Rules that override the pipeline

- **Never check off an acceptance criterion you have not verified by running
  something.** Reading the code you just wrote is not verification.
- **If you're stuck, don't stall.** Add a line starting with `BLOCKED:` to
  `.claude/current-goal.md` explaining what you tried and what you need, then stop.
  That releases the gate and hands control back to me.
- **Don't ask permission mid-pipeline.** The plan approval was the checkpoint.
- **Scope discipline.** If you discover work outside the approved plan, note it in
  the goal file under a `## Discovered` heading — don't just do it.

## Skills

`addyosmani/agent-skills` is installed. Prefer its skills over improvising:
`spec-driven-development` and `planning-and-task-breakdown` for PLAN,
`code-simplification` for SIMPLIFY, `incremental-implementation` and
`test-driven-development` for BUILD, `code-review-and-quality` and
`security-and-hardening` for REVIEW, `git-workflow-and-versioning` for SHIP.
