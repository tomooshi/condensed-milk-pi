---
adr: CM-ADR-008
status: proposed
date: 2026-11-18
depends_on: CM-ADR-001, CM-ADR-002, CM-ADR-004, CM-ADR-007
---

# CM-ADR-008: Fixes from the first shared telemetry (1.14.0)

## Context

Issue #5 received the first export from another operator: 4,621 rows, 2026-11-02 to 2026-11-18, versions 1.11.1 to
1.13.1, 1,223 sessions with turns. It was compared with the maintainer's own log (3,940 rows, same period). The
analysis is in `docs/research/2026-11-18-field-data.md`. It found one tool fault, six telemetry faults, one
prefix-guard fault and one message that agents misread.

## Decision

1. **`cm_recall` `grep` accepts a leading inline flag group.** `(?i)`, `(?m)` and `(?s)` move into the RegExp flags.
   Any other inline flag is an error that names the flag. Every `invalid grep pattern` error now ends with
   "grep is a JavaScript regular expression; a leading (?i), (?m) or (?s) is accepted." 8 of the 12 recall errors in
   the export were `(?i)…`. The tool description names `(?i)`.
2. **Telemetry schema 6.**
   - A session with no model call writes no row (3,398 of 4,621 rows were such rows).
   - `session_id_hash`: the session file at shutdown, else the file at start, else `sha256("session-id:" + id)`.
     pi has no file with `--no-session`, which is why the 1.13.1 fix left 3,117 and 3,926 rows null.
   - `mask_events`, `bytes_freed`, `unique_masks_*`, `re_reads_*` and `avg_turns_held` add the segments before each
     compaction or branch change. Unique masks are unique within a segment, as the re-read counters are.
     `compactions` and `position_resets` count the resets.
   - `total_tokens_input`, `total_cache_read`, `total_cache_write`, `total_output` and `cache_hit_rate` are the sum
     over this run's assistant responses (`llm_responses`). Schema 5 summed the messages in context: too low after a
     compaction, and counted again in each row of a resumed session.
   - `thinking_dropped_after_edit` counts a drop path once per history, and never more than the blocks at risk of
     the edit. Anthropic repeats the full list on every response; a response with no list (an aborted call) emptied
     the old "previous response" set and the next edit counted every drop again.
   - `final_ctx_pct` is the context usage at the newest model call.
3. **Prefix edits say what changed, without text.** `prefix_edits_by_role` (user, assistant, tool_result, system,
   other) and `prefix_edits_by_gap` (messages after the edited one: 0, 1, 2-9, 10 or more) cover message edits that
   are not condensed-milk masks. `system_edits` lists turn, first differing character and both lengths;
   `tools_edits` lists turn and added/removed/changed. Each list keeps the first 8. `CM_PREFIX_GUARD_LOG` lines carry
   the same fields and the turn; with `CM_PREFIX_GUARD_LOG_TEXT=1` they also carry at most 160 characters of each
   side from the first difference. That text is conversation content and goes only to that local file.
4. **A side request is not a prefix edit.** The guard compares a request with the newest 4 requests and reports the
   comparison that shares the longest prefix. A fork that asks the model a side question, or a summary call, sits
   between two main requests; 1.12.0 compared only with the newest request and counted the next main request as
   "user edited". `prefix_side_requests` counts the skipped requests.
5. **Built-in placeholders end with `; cm_recall returns it`**, for example
   `[cm-masked bash #3f9a2c1d7e] git status (41 lines, 2.0KB; cm_recall returns it)`. About 9 sessions in the
   export had an agent that said it could not see a masked result and worked from memory. The explainer in the
   system prompt is far from the placeholder in a long context; the placeholder now carries the way back itself.
   A placeholder that is not shorter than the content is no longer applied (it added bytes and hid the text).
   This is a deliberate cache bust: a session resumed after the upgrade rewrites its cache once from the first
   placeholder. `CM_EXPLAINER` does not change. Custom templates do not change.
6. **No protection for recently used reads.** The study (research doc §5) replayed 41 sessions: recency does not
   predict a re-read (4.5% to 5% above and below every K), and a rule that keeps reads touched in the last K calls
   costs 5 to 20 times what it saves. The gate for any later candidate is fixed in the research doc §5.3.
7. **`maskArgs` stays on.** The CM-ADR-007 rule (more than 1 blocked placeholder call per 1,000 LLM calls in
   sessions with masked arguments turns it off) measured 0.63 (other operator, 14 in 22,221) and 0.23 (maintainer,
   1 in 4,395).

8. **The explainer is a prompt section, not a forced prompt.** Up to 1.13.1 the `before_agent_start` handler
   returned `systemPrompt`. pi then forces the whole prompt for the run and folds every later prompt or tool change
   into the head of the request: a full cache rewrite, and dropped thinking blocks on Claude 5.x. Without a forced
   prompt, pi sends such a change as a small system message at the end of the request. The handler now sets
   `systemPromptOptions.sections.condensed_milk` and returns nothing. It appends as before when pi has no sections
   or an earlier extension already forced the prompt. The text is the same; its position and tag change once (part
   of the cache bust of decision 5). This is the likely cause of the one system edit per session in the export
   (404 sessions, about 280k tokens each): a resume or a late tool changes the prompt once. Same fault and fix in
   other extensions: llblab/pi-telegram#353, pingdotgg/t3code#18933.

9. **Duplicate-call counters.** The row counts bash and read calls, and those that repeat an earlier call of the
   session (same command; same path, offset and limit), before the first mask and after it
   (`filters/dup-calls.ts`). The tracker keeps a 16-character hash of each call, at most 20,000. The two rates show
   whether a mask makes the agent run things again, which a fixed-action replay cannot show (research doc §8).
   Spec: `tests/dup-calls.test.mjs`, 11 checks.

## Verification

| Check | Result |
|---|---|
| Spec tests, written first and seen red | `tests/recall-grep-flags.test.mjs` 17, `tests/prefix-guard-roles.test.mjs` 29, `tests/prefix-guard-lineage.test.mjs` 16, `tests/telemetry-6.test.mjs` 33, `tests/reread-study.test.mjs` 13, `tests/explainer-section.test.mjs` 9; 3 new checks in `tests/placeholders.test.mjs` |
| Test suite | 30/30 files under pi 1.0.4 and under pi 1.5.0 |
| Real pi 1.0.4 process, working copy, Claude Haiku 5.5 | `cm_recall({ id, grep: "(?i)alpha" })` returns `1: Alpha one` and `3: ALPHA three`; no error |
| Forced prompt, real pi 1.0.4, Claude Haiku 5.5, a tool activated at prompt 2, 19k-token prompt | 1.13.1: prompt 2 reads 0 and writes 19,497; prompt 3 reads 1,975 and writes 17,553. Working copy: reads 19,471 and 19,736, writes 265 and 111 |
| The same probe on pi 1.5.0 and pi 1.5.2 (newest on npm, 2026-11-18) | 1.13.1: prompts 2 and 3 read 1,975 and write about 17,400 each. Working copy: read 19,326 and 19,575 (1.5.0), 19,275 and 19,524 (1.5.2); writes 95 to 249 |
| Prefix-guard overhead at a 1M-token request (gate p99 < 5 ms) | p50 0.93 ms, p99 1.36 ms |
| Cause of the per-prompt edits | 529 of 547 foreign message edits are in one project; its `watcher` extension sends `main + question` through pi's hook chain; its log has 733 checks in the period. RPC probe of the global setup without that project: 8 requests, 0 edits |
| Drop-count fault | Reproduced from a session file: a response with no report is followed by the full list (83 → 0 → 83) |
| Re-read study | `bench/reread-study.mjs` on 41 sessions, 19,389 calls (research doc §5) |

Not verified: that the new placeholder text lowers the "worked from memory" cases. Telemetry cannot see them. The
proxies to watch in schema-6 exports: recalls per masked result (0.7% in the export) goes up, `recall_then_rerun`
stays under 10%, `placeholder_calls_blocked` stays under the CM-ADR-007 limit.

## Consequences

- Schema 6 rows are not comparable with schema 5 rows in the token totals and the seven mask counters. Analyses
  filter on `schema`.
- The guard keeps 4 request payloads instead of 1. The strings are shared with pi's messages; the added memory is
  the object skeletons.
- A side request with other tools or another system prompt is still counted once, when it is sent. Only the main
  request after it is no longer counted.
- Each built-in placeholder is 24 characters longer (about 6 tokens).
