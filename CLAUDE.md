# Working agreement

Non-trivial work — more than one file, a behavior change, or a new dependency —
follows the `pipeline` skill (`.claude/skills/pipeline/`). Planning, cutting scope,
building and shipping all happen in the main loop, where the context lives.
Subagents are only for fresh-context review: `goal-verifier` and `code-reviewer` in
parallel, plus `security-auditor` when the change touches auth, input handling,
secrets, network, or file paths.

- `/goal-set` locks an approved plan into `.claude/current-goal.md`. The Stop hook
  (`.claude/hooks/goal-gate.sh`) keeps work going until every criterion is checked
  off and the suite in `.claude/test-cmd` passes. `/goal-stop` releases it.
- Never check off a criterion you have not verified by running something.
- Pushes to `main`/`master` and all force-pushes are blocked by
  `.claude/hooks/push-guard.sh`. Work on a feature branch.
