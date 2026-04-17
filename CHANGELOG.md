# Changelog

All notable changes to condensed-milk.

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
