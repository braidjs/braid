---
name: goal-set
description: Lock in the approved plan as a requirements checklist, then work autonomously until every item is verified and tests pass.
---

Turn the plan we just agreed on into a durable goal, then execute it without
checking in with me.

**Step 1 — write the checklist.** Create `.claude/current-goal.md` in this
project containing every requirement from the approved plan, one per line, as
unchecked boxes:

```markdown
# Goal: <one-line summary of the task>

Approved: <today's date>

## Requirements
- [ ] <requirement, stated as an observable outcome someone else could check>
- [ ] <...>

## Out of scope
- <anything we explicitly decided not to do>
```

Write requirements as **outcomes, not activities**. "Token refresh returns a new
JWT and the old one is rejected" is checkable; "work on token refresh" is not.
If the plan implied acceptance criteria I have not stated, add them and say so.
If $ARGUMENTS is non-empty, treat it as additional requirements to fold in.

Then run: `rm -f .claude/.goal-turns`

**Step 2 — work the list.** Take the unchecked items in order. For each one:
implement it, then verify it yourself by running something — a test, the actual
code path, a command whose output proves it. Only then edit the file and change
that item's `- [ ]` to `- [x]`.

Do not check off an item you have not verified. The checklist is the contract.

**Step 3 — review before you finish.** When the last item is checked, spawn
`goal-verifier` and `code-reviewer` in a single message so they run in parallel.
Add `security-auditor` if the change touches auth, input handling, secrets,
network, or file paths. If any returns FAIL, uncheck the items it disputes and
keep working.

**Step 4 — ship.** Delegate to the `shipper` subagent.

**If you get stuck**, do not ask me and wait. Add a line starting with `BLOCKED:`
to `.claude/current-goal.md` explaining precisely what is blocking you and what
you tried, then stop. That line releases the gate so I get control back.

Do not stop to confirm intermediate steps with me. The plan is already approved.
