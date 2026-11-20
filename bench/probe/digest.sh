#!/usr/bin/env bash
# Digest probe gate (docs/research/2026-11-18-field-data.md §7.2, gate 4):
# does a digest in the placeholder let the agent answer from a masked result
# without more tool calls? Real API, the operator's subscription (about 30k
# tokens per run).
#
#   bench/probe/digest.sh OUT_DIR [RUNS]        # RUNS for each arm, default 6
#
# Each run: prompt 1 runs a command that prints 700 lines and ends with a
# summary naming two failed checks, then `echo BOUNDARY` (a configured
# boundary command, so the next request carries the result masked). Prompt 2
# asks which checks failed. Arms: digest on, digest off. The check names are
# random strings, so a correct answer cannot be a guess.
#
# HOME points at a temp dir so condensed-milk reads only the probe config;
# PI_CODING_AGENT_DIR keeps pi's real auth.
set -u
OUT=${1:?out dir}; RUNS=${2:-6}
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
REAL_HOME=${CM_REAL_HOME:-$HOME}
PIBIN=${CM_PI_BIN:-$REAL_HOME/.local/share/pi-versions/1.0.4-pinned/node_modules/.bin/pi}
CCU=$REAL_HOME/.pi/agent/npm/node_modules/@benvargas/pi-claude-code-use/extensions/index.ts
MODEL=${CM_PROBE_MODEL:-anthropic/claude-haiku-5-5}
P1="Do exactly these steps, one bash call per step, and do not explain or summarize anything. Step 1: run: bash run_checks.sh
Step 2: run: echo BOUNDARY
Step 3: run: echo done
Then reply with the single word: finished."
P2="Which checks failed in the run_checks.sh output? Reply with only their exact names, separated by a comma. Use a tool only if you need one."

for arm in digest plain; do
  for i in $(seq 1 "$RUNS"); do
    d="$OUT/$arm-$i"; rm -rf "$d"; mkdir -p "$d/home/.config" "$d/home/.pi/agent" "$d/w"
    on=false; [ "$arm" = digest ] && on=true
    echo "{\"features\":{\"digest\":$on,\}}" > "$d/home/.config/condensed-milk.json"
    echo '{"boundaryCommands":["^echo BOUNDARY"]}' > "$d/home/.pi/agent/condensed-milk-config.json"
    a="check_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')_ledger"; b="check_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')_parser"
    echo "$a $b" > "$d/names.txt"
    cat > "$d/w/run_checks.sh" <<EOF
for i in \$(seq 1 700); do
  if [ \$i = 233 ]; then echo "FAILED $a: expected 4, got 5"
  elif [ \$i = 518 ]; then echo "FAILED $b: unexpected token at line 9"
  else echo "ok   check_\$(printf %04d \$i)_unit_case_abcdefghijklmnopqrstuvwxyz (12 ms)"; fi
done
echo "Summary: 698 passed, 2 failed ($a, $b)"
EOF
    (cd "$d/w" && HOME="$d/home" PI_CODING_AGENT_DIR="$REAL_HOME/.pi/agent" CONDENSED_MILK_TELEMETRY=off \
      CM_PROBE_MESSAGE_LOG="$d/messages.jsonl" CM_PROBE_PAYLOAD_LOG="$d/payloads.jsonl" \
      timeout 600 "$PIBIN" -ne -e "$REPO/index.ts" -e "$HERE/log-payload.ts" -e "$CCU" --no-mcp --no-skills --no-context-files \
      --model "$MODEL" --thinking off --mode json --no-session "$P1" "$P2" > "$d/events.jsonl" 2> "$d/stderr.txt")
    echo "$arm-$i exit $? $(python3 "$HERE/check-digest.py" "$d")"
  done
done
python3 "$HERE/check-digest.py" --summary "$OUT"
