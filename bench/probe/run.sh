#!/usr/bin/env bash
# Prefix-guard probe gate (§6.1 A): 4 conditions x N runs on the real API.
# Uses the operator's subscription (about 60k tokens per run, mostly cache reads).
#   bench/probe/run.sh OUT_DIR [RUNS]
set -u
OUT=${1:?out dir}; RUNS=${2:-3}
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
CCU=$HOME/.pi/agent/npm/node_modules/@benvargas/pi-claude-code-use/extensions/index.ts
P1="Work in four steps. In each step, first think carefully about which prime numbers lie in the range, then call the bash tool once. Step 1: run seq 1 600 and think which primes are below 50. Step 2: run seq 601 1200 and think which primes are between 50 and 100. Step 3: run seq 1201 1800 and think which primes are between 100 and 150. Step 4: run echo last and think how many primes you found in total. Then reply with only that total."
P2="Think briefly, then use the bash tool to run: echo second. Reply with only the output."
for cond in clean latealias inject-mask inject-delete; do
  for i in $(seq 1 "$RUNS"); do
    d="$OUT/$cond-$i"; mkdir -p "$d/w"; rm -f "$d"/*.log "$d"/*.jsonl
    extra=(--no-mcp); case $cond in latealias) extra=(-e builtin:mcp);; inject-mask) extra+=(-e "$HERE/inject-mask.ts");; inject-delete) extra+=(-e "$HERE/inject-delete.ts");; esac
    (cd "$d/w" && CM_PREFIX_GUARD_LOG="$d/guard.jsonl" PI_CLAUDE_CODE_USE_DEBUG_LOG="$d/payloads.log" CONDENSED_MILK_TELEMETRY=off \
      timeout 900 pi -ne -e builtin:codemode -e "$CCU" -e "$REPO/index.ts" "${extra[@]}" --mode json --no-session --thinking medium "$P1" "$P2" > "$d/events.jsonl" 2> "$d/stderr.txt")
    echo "$cond-$i exit $? $(python3 "$HERE/check.py" "$d")"
  done
done
