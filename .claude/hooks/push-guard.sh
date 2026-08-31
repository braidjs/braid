#!/usr/bin/env bash
# push-guard.sh — PreToolUse(Bash) hook.
# Blocks: pushes to main/master, and every force-push. Everything else passes.
# This is what makes it safe to auto-approve `git push` in permissions.allow.

set -uo pipefail

payload=$(cat)

deny() {
  printf '%s' "$1" | awk '
    BEGIN { printf "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"" }
    { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); printf "%s\\n", $0 }
    END { printf "\"}}\n" }
  '
  exit 0
}

# Extract the command. Prefer a real JSON parser; degrade to the raw payload.
cmd=""
if command -v python3 >/dev/null 2>&1; then
  cmd=$(printf '%s' "$payload" | python3 -c \
    'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: print("")' 2>/dev/null)
elif command -v node >/dev/null 2>&1; then
  cmd=$(printf '%s' "$payload" | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).tool_input||{}).command||"")}catch(e){console.log("")}})' 2>/dev/null)
fi
# Fail closed: if parsing produced nothing, scan the raw payload instead of
# waving the command through.
[ -z "$cmd" ] && cmd="$payload"

# Not a push? Not our business.
# Strip quotes before matching, so `sh -c "git push origin main"` and
# `sh -c 'git push origin main'` are seen the same as a bare push.
scan=$(printf '%s' "$cmd" | tr -d "\"'")

printf '%s' "$scan" | grep -qE '(^|[;&|(`[:space:]])git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*push([[:space:]]|$)' || exit 0

# --- force pushes: always blocked
if printf '%s' "$scan" | grep -qE '(--force([^-]|$)|--force-with-lease|--force-if-includes|[[:space:]]-[a-zA-Z]*f([[:space:]]|$))'; then
  deny "Force-push blocked by push-guard. Force-pushing rewrites history that other clones and CI may already have. If this is genuinely needed, run it yourself."
fi

# --- explicit refspec naming the default branch, e.g. `git push origin main`
if printf '%s' "$scan" | grep -qE '(^|[[:space:]])(main|master|HEAD:(refs/heads/)?(main|master)|(refs/heads/)?(main|master):(refs/heads/)?(main|master))([[:space:]]|$)'; then
  deny "Push to main/master blocked by push-guard. Create a feature branch (git checkout -b <type>/<slug>), push that, and open a PR."
fi

# --- bare `git push` while checked out on the default branch
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  # A push that explicitly names some other branch is fine even from here.
  if ! printf '%s' "$scan" | grep -qE 'push[[:space:]]+[^[:space:]]+[[:space:]]+[^-][^[:space:]]*'; then
    deny "You are on '$branch' and push-guard blocks pushes to the default branch. Create a feature branch (git checkout -b <type>/<slug>) and push that instead."
  fi
fi

exit 0
