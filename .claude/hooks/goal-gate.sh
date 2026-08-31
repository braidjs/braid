#!/usr/bin/env bash
# goal-gate.sh — Stop hook: keeps Claude working until the goal is actually met.
#
# Gate 1: every requirement in .claude/current-goal.md is checked off.
# Gate 2: the project's test suite passes (auto-detected; skipped if none found).
#
# No goal file in the project => this hook does nothing. That is deliberate:
# it is installed globally, so it must stay silent in ordinary sessions.
#
# Escape hatches (so you are never trapped in a loop):
#   - delete .claude/current-goal.md            (or run /goal-stop)
#   - touch .claude/.goal-pause                 (pauses the gate, keeps the file)
#   - put a line starting with BLOCKED: in the goal file
#   - the turn cap (GOAL_MAX_TURNS, default 25) releases the gate no matter what

set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
GOAL_FILE="$PROJECT_DIR/.claude/current-goal.md"
STATE_DIR="$PROJECT_DIR/.claude"
TURN_FILE="$STATE_DIR/.goal-turns"
PAUSE_FILE="$STATE_DIR/.goal-pause"
MAX_TURNS="${GOAL_MAX_TURNS:-25}"
TEST_TIMEOUT="${GOAL_TEST_TIMEOUT:-300}"

cat >/dev/null 2>&1 || true   # drain hook stdin; we do not need it

allow() { exit 0; }

block() {
  # $1 = reason shown to Claude as the instruction to keep going
  printf '%s' "$1" | awk '
    BEGIN { printf "{\"hookSpecificOutput\":{\"hookEventName\":\"Stop\",\"decision\":\"block\",\"blockDecisionReason\":\"" }
    { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, " "); printf "%s\\n", $0 }
    END { printf "\"}}\n" }
  '
  exit 0
}

# ---------------------------------------------------------------- preconditions
[ -f "$GOAL_FILE" ] || allow
[ -f "$PAUSE_FILE" ] && allow
grep -qE '^[[:space:]]*BLOCKED:' "$GOAL_FILE" && allow

# ---------------------------------------------------------------- loop guard
turns=0
[ -f "$TURN_FILE" ] && turns=$(tr -cd '0-9' < "$TURN_FILE")
[ -z "$turns" ] && turns=0
turns=$((turns + 1))
printf '%s' "$turns" > "$TURN_FILE"

if [ "$turns" -gt "$MAX_TURNS" ]; then
  allow   # cap reached: hand control back to the human rather than spin
fi

# ---------------------------------------------------------------- gate 1: requirements
# Unchecked items look like "- [ ] ..."; checked ones "- [x] ..." (case-insensitive).
unchecked=$(grep -nE '^[[:space:]]*[-*][[:space:]]+\[[[:space:]]\]' "$GOAL_FILE" 2>/dev/null || true)

if [ -n "$unchecked" ]; then
  remaining=$(printf '%s\n' "$unchecked" | head -n 12 | sed 's/^[0-9]*://')
  block "Not done yet — these requirements in .claude/current-goal.md are still unchecked:

$remaining

Keep working. Implement the next unchecked item, verify it yourself, then edit .claude/current-goal.md and change its '- [ ]' to '- [x]'. Only check off an item you have actually verified. If an item turns out to be impossible or wrong, do not silently check it — add a line starting with 'BLOCKED:' to the goal file explaining why, and stop so I can look."
fi

# ---------------------------------------------------------------- gate 2: tests
detect_test_cmd() {
  cd "$PROJECT_DIR" || return 1
  # An explicit override always wins. One command per project, first line of
  # .claude/test-cmd. Required for any runner that defaults to watch mode
  # (ng test, nx run-many, vitest, jest --watch) - a watching suite never exits
  # and would stall this hook until the timeout on every single turn.
  if [ -s "$STATE_DIR/test-cmd" ]; then
    head -n 1 "$STATE_DIR/test-cmd" | sed 's/[[:space:]]*$//'
    return 0
  fi
  if [ -f package.json ] && grep -qE '"test"[[:space:]]*:' package.json; then
    if   [ -f pnpm-lock.yaml ]; then echo "pnpm test"
    elif [ -f yarn.lock ];      then echo "yarn test"
    else                             echo "npm test --silent"
    fi
    return 0
  fi
  if [ -f Cargo.toml ];                       then echo "cargo test -q";  return 0; fi
  if [ -f go.mod ];                           then echo "go test ./...";  return 0; fi
  if [ -f Makefile ] && grep -qE '^test:' Makefile; then echo "make test"; return 0; fi
  if [ -f pytest.ini ] || [ -f tox.ini ] || [ -f setup.cfg ] \
     || { [ -f pyproject.toml ] && grep -qi 'pytest' pyproject.toml; } \
     || [ -d tests ] || [ -d test ]; then
    command -v pytest >/dev/null 2>&1 && { echo "pytest -q"; return 0; }
  fi
  return 1
}

TEST_CMD=$(detect_test_cmd) || allow   # nothing to run; requirements gate already passed

out_file=$(mktemp 2>/dev/null || echo "/tmp/goal-gate.$$")
( cd "$PROJECT_DIR" && eval "$TEST_CMD" ) >"$out_file" 2>&1 &
test_pid=$!

waited=0
while kill -0 "$test_pid" 2>/dev/null; do
  if [ "$waited" -ge "$TEST_TIMEOUT" ]; then
    kill -9 "$test_pid" 2>/dev/null
    rm -f "$out_file"
    allow   # a hung suite is a human problem, not a reason to loop
  fi
  sleep 1
  waited=$((waited + 1))
done
wait "$test_pid"; status=$?

if [ "$status" -ne 0 ]; then
  tail_out=$(tail -n 30 "$out_file")
  rm -f "$out_file"
  block "All requirements are checked off, but the test suite is failing (\`$TEST_CMD\` exited $status). Do not stop. Fix the failures, then re-run the suite yourself to confirm. Last 30 lines:

$tail_out"
fi

rm -f "$out_file"

# ---------------------------------------------------------------- done
# Requirements complete and tests green: archive the goal so the next session starts clean.
mkdir -p "$STATE_DIR/goal-archive"
mv "$GOAL_FILE" "$STATE_DIR/goal-archive/$(date +%Y%m%d-%H%M%S).md" 2>/dev/null || true
rm -f "$TURN_FILE"
allow
