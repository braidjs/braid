---
name: pipeline
description: Default working agreement for non-trivial engineering work — plan, cut, build, verify, review, ship, all in the main loop with fresh-context subagents only for review. Use at the start of any change that touches more than one file, changes behavior, or adds a dependency.
---

# Pipeline

Non-trivial work runs: **PLAN → SIMPLIFY → BUILD → TEST → REVIEW → SHIP → CONTINUE.**

Everything except REVIEW happens on the main thread. Planning, cutting, building
and shipping share one context on purpose: each handoff to a subagent loses the
code you already read and the corrections I already made. Subagents are for
verification, where a fresh context with no stake in the work is the point.

Size the task in one line and say which path you're taking:

- **Trivial** — typo, comment, rename, version bump, config value, a single
  obvious one-liner with no behavior change. Go straight to BUILD → TEST → SHIP.
- **Standard** — anything touching more than one file, changing behavior,
  adding a dependency, or that you can't fully hold in your head. Run the full pipeline.

When in doubt it is standard. Say which you chose and move — don't ask me.

## 1. PLAN

Use `planning-and-task-breakdown`. **Read before you plan** — the files that will
change, the conventions in use, the existing tests. A plan written without reading
the codebase is a guess.

Present exactly this:

```
## Understanding
<one paragraph: what is being asked, and what you found in the code that shapes it>

## Acceptance criteria
- [ ] <observable outcome someone else could verify without reading the diff>

## Tasks
1. <task> — touches <files>

## Out of scope
- <what you deliberately excluded>

## Risks
- <what could go wrong, what is uncertain, what you had to assume>
```

**Acceptance criteria are the contract.** Each must be checkable by running
something — a test, a command, a request. Outcomes, not activities:

- Good: "POST /refresh with an expired token returns 401 and does not issue a new JWT"
- Bad: "improve token refresh handling"

Prefer fewer, larger criteria. Six real ones beat twenty restatements. If the
request is ambiguous in a way that changes the design, name the ambiguity under
Risks with the option you assumed.

## 2. SIMPLIFY

Before presenting the plan, attack it yourself (`code-simplification` mindset):

1. Which tasks serve a requirement nobody actually stated? Delete them.
2. What is built for an imagined future — config with one caller, an interface
   with one implementation? Cut it.
3. What already exists in the codebase that does this? Use it.
4. For each task, is there a version that is 60% of the work and 95% of the value?
5. Does a new dependency earn its cost?

Fold the cuts into the plan and list them in one short `## Cut` section so I can
see what you removed. If the plan was already minimal, say so and cut nothing.

**Then present the plan and stop for approval. This is the one place you wait.**

## 3. Lock the goal

Write the approved acceptance criteria to `.claude/current-goal.md` as a checklist
(see `/goal-set`) and run `rm -f .claude/.goal-turns`. From here the Stop hook
keeps you working until every box is checked and tests pass.

## 4. BUILD

Work one checklist item at a time with `incremental-implementation`. Test-driven
where tests make sense (`test-driven-development`) — tests are written here, as
part of each item, not in a later phase. Commit per completed item; small commits
are what make `git revert` a real safety net.

## 5. TEST

Run the full suite yourself. For a large change, you may spawn `agent-skills:test-engineer`
to look for coverage gaps — optional, not a fixed phase.

## 6. REVIEW — fresh-context subagents, in parallel, in one turn

Spawn `goal-verifier` and `code-reviewer` in a single message. Add
`security-auditor` when the change touches auth, input handling, secrets,
network, or file paths. For user-facing web changes, run the `webperf` skill.

Fix what comes back. If a verifier disputes a checked item, uncheck it in
`.claude/current-goal.md` and keep working — don't argue with it.

## 7. SHIP — yourself, using `git-workflow-and-versioning`

You know *why* the change was made; write that into the commit.

1. **Read the real diff.** `git status`, `git diff`, `git diff --staged`, and
   `git log --oneline -10` for the repo's message style. Describe what the diff
   does, not what the plan said it would do.
2. **Before committing:** nothing secret in the diff (keys, tokens, `.env`
   contents, real customer data — stop and report if found); no stray debug
   output or commented-out blocks; nothing unrelated swept in — split mixed
   changes into separate commits.
3. **Branch.** If on `main`/`master`, `git checkout -b <type>/<short-slug>`.
   Pushes to main/master and all force-pushes are blocked by a hook — that's
   deliberate, never route around it.
4. **Message:** imperative subject under 72 chars, blank line, body explaining
   *why* when it isn't obvious.
5. `git push -u origin <branch>`. If it fails, report the error verbatim; do not
   retry with different flags.

## 8. CONTINUE

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
