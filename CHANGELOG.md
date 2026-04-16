# Changelog

All notable changes to condensed-milk.

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
