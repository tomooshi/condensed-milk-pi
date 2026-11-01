---
adr: CM-ADR-001
status: accepted
date: 2026-11-01
supersedes: none (extends ADR-029 placeholder format, mojo-template-pi-dev series)
---

# CM-ADR-001: Addressable placeholders and a new explainer (one deliberate cache bust)

## Context

Masked results show `[cm-masked bash] <cmd>` or `[cm-masked read] <path> (n lines, size)`. The
placeholder names the command, but it gives no way back to the output the agent saw. The explainer
says "re-run or re-read", which returns the current state, not the old output. Results that cannot
be reproduced (a `git status` before a commit, a changed web page, a slow test run) are lost.

The 2026 research converges on reversible removal through a stable address (ARC arXiv:2607.25066,
ReFold arXiv:2610.07863, Agent-Controlled Forgetting arXiv:2610.10590, LCM arXiv:2605.04050).
Agents use a recall tool only when the prompt tells them to (StructMemEval arXiv:2602.11243).
Evidence and sources: `docs/research/2026-11-01-addressable-recall.md`.

## Decision

1. Every masked placeholder carries `#<id>`: the first 10 hex characters of
   `sha1(toolCallId + "\0" + timestamp)` (see the amendment below; the first draft used
   `sha1(toolCallId)`).
   The length is fixed. Growing the id on a collision (ARC's method) would rewrite earlier
   placeholders and break the cache, so a collision is reported by `cm_recall` instead.
2. New default templates (both built-in profiles):
   - bash: `[cm-masked bash #{id}] {cmd} ({n} lines, {size})`
   - read: `[cm-masked read #{id}] {path} ({n} lines, {size})`
   - recall: `[cm-masked recall #{id}] {cmd} ({n} lines, {size})` (`{cmd}` is the recall label)
   A bash result whose command is unknown renders `{cmd}` as `(command unknown)`.
3. No head or tail preview in the placeholder.
4. `CM_EXPLAINER` becomes:

   > condensed-milk: old tool results can appear as `[cm-masked bash|read|recall #id] …` to keep
   > the prompt cache stable. To see one exactly as it was first shown, call `cm_recall` with the
   > id (add `grep`, or `offset`/`limit`, for part of it). To see the current state, re-run the
   > command or re-read the file. Each costs one step, so do it only when the next step needs
   > the content.

5. A custom template without `{id}` still works, and a profile warning says that `cm_recall` cannot
   address results masked with it.

## Consequences

- One cache miss per session at upgrade: the system prompt and every existing placeholder change
  bytes once. After that the bytes are fixed again, because the id depends only on the tool-call id.
- Cost: measured on 40 sessions (30 days), 191 placeholders are live per call on average. About
  12 extra bytes each is about 574 tokens per call, 0.15% of the 391k mean context. A preview would
  cost about 2.4% for a need that occurs on 0.2% of masked results.
- `derived:` collision bound: 12,232 results in the largest measured session; with 40 bits the
  birthday estimate is n²/2⁴¹ ≈ 7e-5.
## Amendment (2026-11-01, during the build): the timestamp is part of the id key

The replay on 40 real sessions found 15 placeholders that recalled the wrong result. Kimi through
OpenRouter reuses tool-call ids such as `bash:0` in every turn: 17 repeats on one branch. With
`sha1(toolCallId)` those results shared one id, and recall returned the newest. The key is now
`toolCallId + "\0" + timestamp` of the tool-result message. The context event and the session file
carry the same timestamp. Measured on 28,279 results in 30 days: every result has a numeric
timestamp, and no (toolCallId, timestamp) pair repeats. After the change the replay checked 29,300
placeholders with 0 failures. The spec tests' `sid` helper changed with this amendment as its reason.

- Tests that pinned the v1.9.0 bytes (`test-back-compat.mjs`, `test-profiles.mjs`) change with this
  ADR as their reason. Legacy `[masked …]` and `[cm-masked …]` placeholders without ids are still
  recognized as masked.
