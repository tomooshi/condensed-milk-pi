#!/usr/bin/env bash
# 1.13.0 probe gates (docs §6.1, §11): real provider requests with masked
# arguments (C), a collapsed read (D) and batched invalidation (B1).
#
#   bench/probe/features.sh OUT_DIR anthropic|openrouter|vllm [cd|cd2|b1|b1-base] [RUNS]
#
# cd       write a file, read CONVENTIONS.md twice, make 40 KB of output, then
#          `echo BOUNDARY` (a configured boundary command) so the next request
#          carries masked arguments (C). (The two reads probed D, collapse, which
#          failed its offline gate and was removed.) Gate: the request with the masks is
#          accepted and answered.
# b1       default rules plus one invalidation rule (`echo INVALIDATE` makes an
#          earlier `cat notes.txt` stale). A boundary sets the cutoff, then cat,
#          think, echo INVALIDATE, think, echo last. Gate: 0 new thinking drops
#          in the response to the request after the invalidation.
# b1-base  the same run on 1.12.0 behavior (features off): the positive control.
#
# HOME points at a temp dir so condensed-milk reads only the probe config;
# PI_CODING_AGENT_DIR keeps pi's real auth (Anthropic OAuth, OpenRouter key).
# Anthropic runs use the operator's subscription (about 60k tokens per run).
set -u
OUT=${1:?out dir}; PROVIDER=${2:?provider}; MODE=${3:-cd}; RUNS=${4:-1}
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
REAL_HOME=${CM_REAL_HOME:-$HOME}
PIBIN=${CM_PI_BIN:-$REAL_HOME/.local/share/pi-versions/1.0.4-pinned/node_modules/.bin/pi}
CCU=$REAL_HOME/.pi/agent/npm/node_modules/@benvargas/pi-claude-code-use/extensions/index.ts
LINE="The quick brown fox jumps over the lazy dog while the probe checks masked arguments."
CONTENT="$LINE $LINE $LINE $LINE"

P_CD="Do exactly these steps, one tool call per step, and do not explain. Step 1: call the write tool with path probe.txt and content: $CONTENT
Step 2: call the read tool on CONVENTIONS.md. Step 3: call the read tool on CONVENTIONS.md again. Step 4: call the bash tool with: seq 1 1200 | awk '{print \"line \" \$1 \" abcdefghijklmnopqrstuvwxyz\"}'
Step 5: call the bash tool with: echo BOUNDARY. Step 6: call the bash tool with: echo done. Then reply with the single word: finished."
# cd2: the same edits for small local models that put every call in one
# message: prompt 1 does the work, prompt 2 runs the boundary command.
P_CD2A="Call these tools now: the write tool with path probe.txt and content: $CONTENT
Then the read tool on CONVENTIONS.md, the read tool on CONVENTIONS.md again, and the bash tool with command: bash big.sh"
P_CD2B="Call the bash tool with command: echo BOUNDARY"
P_CD2C="Call the bash tool with command: echo done"
P_B1="Work in five steps, one bash call per step. Step 1: run seq 1 1200 | awk '{print \"line \" \$1 \" abcdefghijklmnopqrstuvwxyz\"}'. Step 2: run echo BOUNDARY. Step 3: run cat notes.txt, then think carefully about which prime numbers lie between 1 and 60. Step 4: run echo INVALIDATE, then think carefully about which prime numbers lie between 60 and 120. Step 5: run echo last, then think about how many primes you found in total. Then reply with only that total."

for i in $(seq 1 "$RUNS"); do
  d="$OUT/$PROVIDER-$MODE-$i"; rm -rf "$d"; mkdir -p "$d/home/.config" "$d/home/.pi/agent" "$d/w"
  features='{"maskArgs":true,"batchInvalidation":true}'
  [ "$MODE" = b1-base ] && features='{"maskArgs":false,"batchInvalidation":false}'
  echo "{\"features\":$features}" > "$d/home/.config/condensed-milk.json"
  if [ "$MODE" = cd ] || [ "$MODE" = cd2 ]; then
    echo '{"boundaryCommands":["^echo BOUNDARY"]}' > "$d/home/.pi/agent/condensed-milk-config.json"
    printf '# Conventions\n%s\n%s\n%s\n%s\n' "$LINE" "$LINE" "$LINE" "$LINE" > "$d/w/CONVENTIONS.md"
    echo 'for i in $(seq 1 1200); do echo "line $i abcdefghijklmnopqrstuvwxyz"; done' > "$d/w/big.sh"
    prompts=("$P_CD")
    [ "$MODE" = cd2 ] && prompts=("$P_CD2A" "$P_CD2B" "$P_CD2C")
  else
    # Default reference and invalidation rules, plus the probe's boundary command
    # and one invalidation rule whose stale output is long enough to mask.
    echo '{"boundaryCommands":["^echo BOUNDARY"],"invalidationRules":[{"invalidator":"^echo INVALIDATE","invalidated":"^cat notes"}]}' > "$d/home/.pi/agent/condensed-milk-config.json"
    for n in $(seq 1 12); do echo "note $n: $LINE"; done > "$d/w/notes.txt"
    prompts=("$P_B1")
  fi
  agent=$REAL_HOME/.pi/agent
  extra=(-e "$HERE/log-payload.ts")
  case $PROVIDER in
    anthropic) extra+=(-e "$CCU"); model=();;
    openrouter) model=(--provider openrouter --model "${CM_PROBE_OPENROUTER_MODEL:-openai/gpt-4.1-mini}");;
    vllm)
      agent="$d/agent"; mkdir -p "$agent"
      cat > "$agent/models.json" <<EOF
{"providers":{"vllm":{"baseUrl":"http://127.0.0.1:8011/v1","api":"openai-completions","apiKey":"none","models":[{"id":"Qwen/Qwen2.5-1.5B-Instruct","contextWindow":32768,"maxTokens":1024}]}}}
EOF
      model=(--provider vllm --model Qwen/Qwen2.5-1.5B-Instruct);;
  esac
  thinking=(--thinking medium); [ "$PROVIDER" = vllm ] && thinking=()
  (cd "$d/w" && HOME="$d/home" PI_CODING_AGENT_DIR="$agent" CONDENSED_MILK_TELEMETRY=off \
    CM_PREFIX_GUARD_LOG="$d/guard.jsonl" CM_PROBE_PAYLOAD_LOG="$d/payloads.jsonl" CM_PROBE_MESSAGE_LOG="$d/messages.jsonl" \
    timeout 1800 "$PIBIN" -ne -e "$REPO/index.ts" "${extra[@]}" --no-mcp "${model[@]}" "${thinking[@]}" \
    --mode json --no-session "${prompts[@]}" > "$d/events.jsonl" 2> "$d/stderr.txt")
  echo "$PROVIDER-$MODE-$i exit $? $(python3 "$HERE/check-features.py" "$d" "${MODE%2}")"
done
