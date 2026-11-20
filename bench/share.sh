#!/usr/bin/env bash
# Replay your own pi sessions through condensed-milk and write two files of
# numbers that are safe to share (for example on a GitHub issue).
#
#   bench/share.sh [DAYS] [SESSIONS_DIR]      # default: 30 days, pi's session folder
#
# What it does: reads your session files (read-only), replays each one through
# this copy of condensed-milk without any API call, and writes
#   OUT/run.json      per call: sizes and token counts, for the cost model
#   OUT/reread.json   totals of the re-read study
# Neither file holds a prompt, an output, a command or a path. The script
# checks that before it ends. A third file with file paths (reads.jsonl) is
# needed in between and is deleted at the end.
# Needs node 22 and pi (for its TypeScript loader). About 10 s per 1,000 calls.
set -euo pipefail
DAYS=${1:-30}
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/.." && pwd)
OUT=${CM_SHARE_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/cm-share.XXXXXX")}
mkdir -p "$OUT"
dir_args=(); [ -n "${2:-}" ] && dir_args=(--sessions-dir "$2")
trap 'rm -f "$OUT/reads.jsonl" "$OUT/list.tsv"' EXIT
cd "$REPO"
node bench/replay-cost.mjs list --days "$DAYS" --out "$OUT/list.tsv" "${dir_args[@]}"
[ -s "$OUT/list.tsv" ] && [ "$(tr -d '[:space:]' < "$OUT/list.tsv" | wc -c)" -gt 0 ] || { echo "no sessions found in the last $DAYS days" >&2; exit 1; }
node --max-old-space-size="${CM_SHARE_HEAP_MB:-8000}" bench/replay-cost.mjs run --list "$OUT/list.tsv" --arm base=. --out "$OUT/run.json" --reads-out "$OUT/reads.jsonl"
node bench/reread-study.mjs "$OUT/reads.jsonl" --json "$OUT/reread.json" > /dev/null
# Privacy check: no path separator and no home-directory name in the two files.
node -e '
const fs = require("fs"), os = require("os");
const user = os.userInfo().username;
for (const f of process.argv.slice(1)) {
  const strings = new Set();
  (function walk(x) { if (typeof x === "string") strings.add(x); else if (x && typeof x === "object") for (const v of Object.values(x)) walk(v); })(JSON.parse(fs.readFileSync(f, "utf8")));
  const bad = [...strings].filter((s) => /[\/\\\s]/.test(s) || s.length > 40 || (user.length > 2 && s.includes(user)));
  if (bad.length) { console.error(`privacy check FAILED for ${f}: ${bad.length} unexpected strings; do not share it`); process.exit(1); }
}' "$OUT/run.json" "$OUT/reread.json"
echo
echo "privacy check passed. Files to share:"
ls -l "$OUT/run.json" "$OUT/reread.json" | awk '{print "  " $NF " (" $5 " bytes)"}'
