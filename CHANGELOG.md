# Changelog

All notable changes to condensed-milk.

## [1.6.0] - 2026-04-17

### Fixed — cd-prefix invisibility + cwd-unaware invalidation

The v1.5.x invalidation regexes anchored at `^git`, which meant
`cd /repo && git commit` never matched as an invalidator — a silent
miss in the most common bash idiom the agent uses. Even once stripped,
matching ignored cwd, so multi-repo sessions could see repo A's commit
spuriously invalidate repo B's git status output.

**Fix (parseCdPrefix):** iterative `cd X && cd Y && CMD` parsing. Last
cd wins as effective cwd; residual command is what regex rules match.

**Fix (cwd scoping):** `buildToolCallIndex` records cwd per bash call.
`isCommandInvalidated` compares the candidate's cwd against each later
invalidator's cwd; invalidation fires only on exact match (including
both-undefined for the single-cwd no-cd common case). Cross-cwd
mismatches no longer invalidate — err toward keeping output visible.

### Added — user-configurable rules

Global `~/.pi/agent/condensed-milk-config.json` + project-local
`./condensed-milk.config.json` (merged additively):

```json
{
  "referenceBasenames": ["spec.yaml"],
  "referencePathSubstrings": ["/my-specs/"],
  "invalidationRules": [
    { "invalidator": "^cargo\\s+(build|update)", "invalidated": "^cargo\\s+(check|clippy)" }
  ],
  "disableDefaults": false
}
```

`disableDefaults: true` replaces built-ins instead of extending; any
file setting it wins.

**Fail-loud:** ENOENT is skipped (optional files). Any other read
error or JSON parse error throws — better than silently running with
wrong rules.

### Architecture

Filter module (`filters/context-compress.ts`) stays pure — no fs IO.
All file reads happen in `index.ts` at extension load; resolved rules
are passed into `compressStaleToolResults` via `opts.rules`. Tests
inject rules the same way, no subprocess or fs mocking needed.

### Cache-safety

Sweep on 926-msg session, default T.20/.35/.50 × C.50/.75/.90:
variants 42 → 42, cost unchanged. Parsing is deterministic per
command; cwd scope strictly narrows invalidation (fewer false
positives never more).

### Tests

6 new v1.6.0 assertions in `test-rereads.mjs`:

- `parseCdPrefix` bare, single, chained cds
- cd-prefix invalidation now fires (git add invalidates git status
  with cd prefix)
- cwd scoping blocks cross-repo invalidation
- user-config `referenceBasenames` protect custom paths
- user-config `invalidationRules` fire (cargo build invalidates
  cargo check)
- `disableDefaults` suppresses built-in git rule

### Stacked-diff tool notes

Built-in rules only match `git`. Tools like `gt` (Graphite), `jj`
(Jujutsu), `spr`, `sapling` are NOT invalidators by default — same as
pre-v1.6.0. Users can add custom rules via config, e.g.:

```json
{ "invalidationRules": [
  { "invalidator": "^gt\\s+(up|down|submit|checkout|sync|restack)", "invalidated": "^git\\s+(status|diff|log)" }
]}
```

Cwd-scope protects the common multi-repo case: a `gt submit` in
`/repoA` won't invalidate `git status` in `/repoB`.

## [1.5.0] - 2026-04-17

### Changed — expanded reference-file protection

`REFERENCE_FILES` was exact-basename match only, which missed the most
frequently re-read categories in real sessions:

- Per-project decision records under `knowledge/decisions/`
- Shared vault concepts and patterns
- Agent skill entry points (`SKILL.md`)
- AST rule definitions under `rules/`

**Change:** `isReferenceFile` now checks two sources:

1. **Basename set** (unchanged semantics, expanded list): added `SKILL.md`,
   `GEMINI.md`, `README.md`, `CHANGELOG.md` alongside existing
   `AGENTS.md`, `CONVENTIONS.md`, `CLAUDE.md`, etc.
2. **Path substrings** (new): any path containing `/knowledge/decisions/`,
   `/knowledge/concepts/`, `/knowledge/patterns/`, `/.pi/agent/skills/`,
   `/.pi/skills/`, or `/rules/` is treated as reference.

### Why it's cache-safe

Expanding protection only reduces the masked set; it does not change
the placeholder text for any file that still gets masked. Sweep on a
real 926-message session at the default T.20/.35/.50 × C.50/.75/.90
config:

- Variants: 42 → 42 (unchanged)
- Cost: ≈ identical ($116.21)

### Tests

`test-rereads.mjs` gains a reference-path block: seeds reads for
ADR paths, skill files, rule files, and project meta, forces zone 2
(most aggressive masking), and asserts none end up in `maskedPaths`
nor carry a `[masked read]` placeholder.

### Deferred to v1.6.0

JSON config file (`~/.pi/agent/condensed-milk-config.json`) for
user-defined basenames/substrings/globs, and dynamic promotion of
frequently-read paths. Hardcoded list ships now because the common
cases are covered and the config plumbing is larger than the fix.

## [1.4.0] - 2026-04-17

### Fixed — re-read telemetry bugs exposed by real-session data

Real v1.3.0 telemetry (100 turns, 30% context) showed two bugs:

1. `turnsSinceMask` was always 0.0. pi re-feeds the raw (unmasked)
   session history on every context event, so `compressStaleToolResults`
   re-applies masks each turn. v1.3.0 used `Map.set()` unconditionally
   on each re-application — the stored turn overwrote the first-mask
   turn with the current turn.
   **Fix:** only `.set()` the tracker when the key is absent. An item
   is re-set as "fresh first-mask" only after it was consumed by a
   re-read (`.delete()`).

2. Re-read rate underreported by ~100x. v1.3.0 used
   `reReadCount / contextMasksTotal` where the denominator was the
   cumulative re-application count (re-applied ≈ N masks every turn).
   **Fix:** introduced `everMaskedReads: Set<string>` and
   `everMaskedBashes: Set<string>` as denominators. Rate is now split
   per type: reads X.X% | bashes Y.Y%.

3. `contextMasksTotal` similarly overcounted (every turn added all
   under-cutoff items again). **Fix:** increment only on first-time
   additions to the ever-masked sets.

### Changed — read placeholder enriched

v1.3.0 real-session data showed reads had 33% re-read rate (3/9)
while bashes had 0% (0/52) — the read placeholder `[masked read] /path`
was semantically lossy. The command name in `[masked bash] <cmd>` was
sufficient because the command itself signals freshness.

**New read placeholder:** `[masked read] /path (N lines, SIZE)` where
N is the line count and SIZE is the original content size (e.g. `2.4KB`).
Derived purely from the original content → byte-deterministic per
message → cache prefix stays stable. Verified on real JSONLs: variants
count unchanged (42→42, 6→6 on two sessions); $ delta <0.005%.

**Bash placeholder unchanged.**

### Changed — /compress-stats output

```
Re-read Telemetry (v1.4.0)
  Unique masks: R reads, B bashes
  Currently tracked: R reads, B bashes (evicted on re-read)
  Re-read events: K (R reads, B bashes)
  Re-read rate: reads X.X% | bashes Y.Y%
  Avg turns placeholder held: Z.Z
```

ADR-022 (`knowledge/decisions/022-v1-4-0-telemetry-fixes-and-read-placeholder-enrich.md`).

## [1.3.0] - 2026-04-17

### Added — re-read telemetry (instrumentation only, no behavior change)

Tracks whether the model re-reads a file or re-runs a command AFTER
it was masked. A re-read signals the placeholder wasn't sufficient —
masking was semantically lossy for that item.

**Mechanism:**
- When a read/bash tool result is newly masked, the extension records
  `(path | command, turnNumber)` in an in-memory Map.
- On a subsequent `tool_result`, if the same path or command appears,
  increment `reReadCount`, record `turnsSinceMask` delta, evict the
  entry (consumed).

**Surfaced in `/compress-stats`:**
```
Re-read Telemetry (v1.3.0 exp 3)
  Tracked masks: N reads, M bashes
  Re-read events: K (R reads, B bashes)
  Re-read rate: X.X% of masks refetched
  Avg turns since mask: Y.Y
```

**Defaults unchanged** (ADR-020 defers the default-threshold change
from the v1.3.0 exp 1 sweep until this telemetry produces a signal).

**API change:** `CompressResult` now includes `maskedPaths: string[]`
and `maskedCommands: string[]` listing newly-masked items this call.
Callers that only read `.masksApplied` are unaffected.

ADR-021 (`knowledge/decisions/021-re-read-telemetry-for-condensed-milk-masking.md`).

## [1.2.1] - 2026-04-16

### Fixed — drift bug in v1.2.0 static-cutoff algorithm

v1.2.0 recomputed `targetCutoff = floor(messages.length × coverage[zone])`
every turn. When at zone 2 (>50% context) and messages keep appending,
the cutoff crept forward by ~1 message per new message — effectively a
rolling window at rate 0.9, not a static cutoff.

Observed live: ~6 drift-write events per 275-turn session at zone 2,
each costing ~$0.60 cache write.

### Changed — true-static cutoff

Cutoff now freezes at the moment a zone is first entered and does NOT
re-derive from `messages.length` on subsequent turns. Exactly 3
cache-write events per session (one per zone crossing) instead of
drift-firing every ~10-15 turns.

API addition: `decideCutoff(messagesLength, opts)` returns
`{cutoffIdx, activeZone, zoneAdvanced}`. Caller persists `zoneEntered`
and `cutoffIdx` across turns; filter is pure.

### Measured (same 1114-turn session used to validate v1.2.0)

| Algorithm | Variants | Total cost |
|---|---|---|
| Rolling N=10 (v1.1.1) | 340 | $1789 |
| Static semi (v1.2.0) | 175 | $1545 |
| **True-static (v1.2.1)** | 175 | $1549 |

Cost delta vs v1.2.0 is within noise on multi-zone sessions. The win is
predictability + correctness: the algorithm now behaves as the ADR-018
thesis describes. Single-zone long sessions (typical zone-2 tails) will
save drift writes not visible in the aggregate multi-zone number.

### Migration

Automatic. No config changes. Existing installs picking up v1.2.1 will
transparently use the frozen-on-zone-entry behavior.

## [1.2.0] - 2026-04-16

### Fixed — cache-thrash bug in rolling-window masking (ADR-018)

The rolling-window algorithm introduced in v1.1.0 was measured to be
**actively harmful**: it produced 2x more distinct cache prefix variants
than no masking at all, costing 11% MORE than doing nothing.

Root cause: mask frontier at `messages.length - windowSize` shifts by 1
every turn a new tool result appends. Anything hashed up through BP2
(last-user-message cache breakpoint) that included that position must
be re-cached. Classic frontier-drift thrash.

### Changed — static-cutoff algorithm replaces rolling window

The cutoff T advances only when context usage crosses a pressure
threshold. Between advances, T is immutable — bytes before T stay
byte-identical turn-over-turn — cache prefix stays stable.

- Default thresholds: `[0.20, 0.35, 0.50]` of context window usage
- Default coverage:   `[0.50, 0.75, 0.90]` fraction of messages masked

T monotonically advances. Once a message is masked, it stays masked.

### Measured on a real 1114-turn session JSONL (test-replay.mjs)

| Algorithm | Cache variants | Write cost | Read cost | Total |
|---|---|---|---|---|
| No retroactive masking | 157 | $1386 | $28 | **$1414** |
| Rolling window N=10 (v1.1.1) | 316 | $1564 | $30 | **$1594** |
| Static cutoff (v1.2.0) | 159 | $1320 | $26 | **$1346** |

Static cutoff saves **16% vs rolling window** and **5% vs no masking**.

### Config changes

- `windowSize` replaced by `thresholds` + `coverage` arrays
- Old config files with `windowSize` silently ignored, defaults applied
- `/compress-config thresholds 0.20,0.35,0.50`
- `/compress-config coverage   0.50,0.75,0.90`

### Validation

- test-replay.mjs: offline harness that replays any pi session JSONL
  through both algorithms and reports cache-variant counts + cost.
- Proves directionally correct; live A/B should follow.

### Migration

Automatic. Existing `~/.config/condensed-milk.json` with
`{windowSize: 10}` will be silently overwritten with new defaults on
next config save. No user action needed.

### References

- ADR-018 (mojo-template-pi vault) — supersedes parts of ADR-016
- Measurement: `test-replay.mjs` committed to repo

## [1.1.1] - 2026-04-16

### Fixed

- `/compress-stats` output now correctly reports retroactive masking:
  total tool results masked, distinct mask events, bytes freed — instead
  of the stale `Context retroactive: X saved (N compressions)` line
  which conflated per-event counts with per-mask counts.
- Context-retroactive counters (`contextSaved`, `contextMaskEvents`,
  `contextMasksTotal`) now reset on `session_start` along with the
  other per-session state.
- Removed unused `tokensSaved` local variable.

## [1.1.0] - 2026-04-16

### Changed — retroactive compression switched from summarization to observation masking

The `context`-event compression path now uses **observation masking** with a
fixed rolling window instead of turn-distance summarization. This follows
JetBrains Research (Lindenbauer et al., Dec 2025) empirical finding that
masking outperforms LLM-style summarization on agent sessions, and
Anthropic's endorsement of "tool result clearing" as the safest lightest
form of compaction.

**Algorithm:**
- Fixed rolling window: last N messages (default 10) kept unmasked
- Older bash and read tool results replaced with deterministic placeholders:
  `[masked bash] <command>` and `[masked read] <path>`
- Reference files (AGENTS.md, CONVENTIONS.md, package.json, etc.) never masked
- Command-invalidation rules still honored (git add invalidates git status etc.)

**Why masking over summarization:**
- Byte-identical placeholders → single cache miss per tool-result lifetime,
  then stable forever. Summarization changed bytes every turn → repeated
  cache misses.
- JetBrains empirical: masking matches or beats summarization on solve
  rate, -52% cost on Qwen3-Coder 480B
- Summaries cause trajectory elongation (+13-15% more turns) by smoothing
  over stop-signals
- Simpler code, fewer edge cases, lower per-turn CPU
- Agent can re-fetch via `read` or re-run commands (just-in-time pattern
  per Anthropic)

**Measured on a real 1074-message session that previously produced 0
compressions:** 301 masks applied, ~420KB saved, ~105K tokens freed.

### Removed

- `STALE_THRESHOLD` turn-distance heuristic (replaced by rolling window)
- `buildFileOpsMap` / file-op tracking (masking is self-correcting)
- `cacheAware` config toggle + `cacheTtlMs` — was structurally broken
  (relied on missing `createdAt` field) and unnecessary under masking
- `JSON.stringify(messages).length` savings measurement — replaced with
  analytical sum computed during the pass (MB-per-turn overhead gone)

### Added

- `window-size` config key: `/compress-config window-size <N>`
- `masksApplied` field in per-turn telemetry
- Robust toolCallId → command/path lookup: works on both live in-memory
  context events (where `details` is populated) and persisted JSONL
  shapes (where `details` is dropped)

### Migration

Existing config files with `cacheAware` / `cacheTtlMs` will be silently
ignored and replaced on next save. Default behavior change: compression now
fires on every session with >10 messages. Previously it often produced 0
compressions on post-branch-summary sessions.

### References

- ADR-016 in the mojo-template-pi vault (full rationale)
- JetBrains: https://blog.jetbrains.com/research/2025/12/efficient-context-management/
- Anthropic: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Chroma Context Rot: https://research.trychroma.com/context-rot

## [1.0.0] - 2026-04-14

Initial release.
