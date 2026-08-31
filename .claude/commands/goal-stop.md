---
name: goal-stop
description: Release the autonomous goal gate and hand control back to me.
---

Archive the current goal and stop the gate:

```bash
mkdir -p .claude/goal-archive
[ -f .claude/current-goal.md ] && mv .claude/current-goal.md ".claude/goal-archive/$(date +%Y%m%d-%H%M%S)-stopped.md"
rm -f .claude/.goal-turns .claude/.goal-pause
```

Then tell me, in a few sentences: which requirements were checked off, which
were not, and what you would do next if we resumed. Do not start new work.
