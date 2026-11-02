# Research: what to add to condensed-milk next, and how to test it

Date: 2026-11-02. Scope: condensed-milk-pi 1.11.1. Status: research done and verified (section 8), nothing built.
Method: 25 fan-out searches on four engines (Kagi, Exa, DeepSeek, Marginalia) plus two Exa publication
searches; 20 arXiv abstracts, three vendor docs and nine Claude-subscription pi extensions read; seven
measurements on 30 days of the operator's pi sessions (38-40 sessions, about 50,000 LLM calls, active branch
only); 14 controlled pi runs on the operator's subscription (section 8). Scripts: `/tmp/cmres/measure2.py`,
`/tmp/cm-verify/*.py`, `/tmp/cm-verify/exp4/ext/*.ts`.

## 1. Short answer (revised after verification, section 8)

The biggest waste was **prefix edits that rewrite a warm prompt cache and invalidate every earlier thinking
block** on Claude 5.x. Verification found that **most of it came from outside condensed-milk** and that the
largest source is already fixed:

- An old enforcement extension deleted earlier `mode-context` messages at every prompt: `void-marketing`
  (78% of its prompts caused a full rewrite, $224 in 30 days) and `stonk-POL` until its ADR-068 fix.
  Prompt-start rewrites fell from $479 (30 days) to $85 (last 14 days).
- `pi-claude-code-use` (2.2.1 and 3.0.1) registers a `model-only` alias for every non-core tool, including
  tools pi keeps undeclared (codemode exposure). pi activates `model-only` tools on registration, so when an MCP
  server connects during a run, the `tools` list changes and every thinking block drops. Proven 3 of 3 against
  0 of 3 (section 8.8). It hits headless runs that send a prompt at startup; it did not occur in the 9
  interactive sessions since the MCP server was added.
- condensed-milk's own edits are a smaller, real share: in-run rewrites after a zone advance ($82, by design)
  and after a bash invalidation ($83, about half above the base rate).

The recommended order for condensed-milk:

1. **Evaluation harness first** (section 6), so that every step is measured against 1.11.1.
2. **Prefix guard (observe only).** Detect and attribute every change to `system`, `tools` or earlier
   messages, per request. Two outside causes found by hand in this round show its value.
3. **Mask old edit/write arguments at mask events** (option C): about 1.17B tokens a month that are still
   re-read past the cutoff ($233 API-equivalent). The API accepts it (verified).
4. **Collapse superseded, stale and duplicate reads at mask events** (option D): up to $164 a month.
5. **Batch bash invalidation into mask events** (option B1): small ($40-80 a month), simple.
6. **Server-side mode** (option B2): verified to keep thinking blocks on your OAuth account, but it needs
   `clear_at_least`, it cannot protect reference files by path, and it loses the recall ids. Test only.

Outside condensed-milk, and worth more today than any new feature: sync `void-marketing`'s enforcement
extension with the ADR-068 fix, and stop the mid-run alias change (section 8.3).

## 2. What your sessions show (30 days)

### 2.1 Where the money goes (claude-opus-5-5, API list prices recorded by pi)

| Part | Tokens | Recorded cost |
|---|---|---|
| Cache read | 19,443M | $3,889 (44%) |
| Cache write (5-minute tier, 1.25x input) | 501M | $3,974 (45%) |
| Output | 45.8M | $916 (10%) |
| Uncached input | 0.1M | $0 |

The cache hit rate is 97.5% by tokens, yet cache writes cost as much as cache reads, because a write costs
25 times a read. The figures are API-equivalent: with subscription access (`pi-claude-code-use`) you do not
pay per token, but your usage limits follow the same token volumes.

### 2.2 Why the cache is rewritten (rewrites of more than 50% of the prompt)

| Cause | Rewrites | Tokens written | Share | Cost |
|---|---|---|---|---|
| Warm cache, first call after a user prompt (prefix edit) | 421 | 150.9M | 35.7% | $755 |
| Warm cache, inside a run (prefix edit) | 263 | 83.7M | 19.8% | $418 |
| Cache expired: pause over 60 min | 254 | 106.9M | 25.3% | $534 |
| Cache expired: pause of 5-60 min | 216 | 79.1M | 18.7% | $396 |
| After compaction, first call | 80 | 1.9M | 0.5% | $10 |

**55% of rewritten tokens (about $1,170 a month) come from edits to a warm cache.** Expiry after a pause is
normal. A 1-hour cache would cost 2x on every write ($3,974 becomes about $6,360) to save at most $396, so
the 5-minute tier is the right choice. The idle trigger in 1.11 already uses these expiries.

### 2.3 Dropped thinking blocks

- 66,506 of 70,117 Opus 5.5 messages (95%) carry `thinking_dropped` with reason `prefix_binding_mismatch`:
  15.6M dropped blocks in 30 days. pi sends `prefix_mismatch_behavior: "drop_block"` and records each drop
  as an `anthropic_input_transformations` diagnostic.
- 86% of new drop events start at the first call after a user prompt (6.3% of calls are at that point), and
  the first dropped block is always the first thinking block (`messages.2`-`messages.9`). That pattern fits
  a change to `system` or `tools` at prompt start. 19% start right after a pi-vcc compaction (expected).
- Persistent drops do not break the cache: a dropped block is not billed, and later requests hit the cache.
  The costs are the rewrite at the edit, and extra output: the model re-creates the reasoning it lost
  (Anthropic: "Dropping blocks can significantly increase output tokens, especially when blocks are
  dropped on every turn").
- Verified causes (section 8): deletion of earlier `mode-context` messages by old enforcement extensions
  (the 86% at prompt start), mid-run alias registration by `pi-claude-code-use` for late MCP tools, and
  condensed-milk's own zone advances and bash invalidations. `pi-claude-code-use` does not otherwise change
  the prefix: across three prompts its `system` and `tools` stayed byte-identical.

### 2.4 What is still re-read after condensed-milk 1.11 masks results

| Item | Share of counted re-reads |
|---|---|
| Edit/write call arguments | 24.3% |
| Bash commands over 2 KB (heredoc scripts) | 11.0% |
| Short bash commands | 20.3% |
| Other call arguments | 2.2% |
| Tool results still live | 42.2% |

Old thinking blocks are larger still (about 44% of session bytes), but they are dropped (2.3), so most are
not billed. Among live tool results: superseded reads (a newer read of the same path exists) 12.5%,
duplicates (identical bytes later) 7.2%, stale reads (the file was edited later) 2.9%.

Edit failures "Could not find the exact text": 70 in 30 days; in 34 the file had changed after its last read.

Past the masking cutoff (what a mask event could remove, minus a 120-byte placeholder): edit/write arguments
1.17B tokens ($233 at the $0.20/M cache-read price), bash commands over 2 KB 0.49B ($99). Live superseded
reads 0.45B ($90), duplicates 0.26B ($52), stale reads 0.11B ($22); these overlap, and a mask event removes
only what is live after it, so $164 is an upper bound.

## 3. What the latest research says

1. **Edits to reusable history multiply work.** Keeping the last five observations cut prompt volume 33% but
   raised uncached prefill 608% and missed the quality gate [P1]. Batched, cost-scheduled replacement with exact
   retrieval cut input cost about 40% [P2]. Anthropic: most edits that invalidate thinking also restart the
   cache [D1].
2. **Mechanical, faithful removal beats summaries.** LLM summaries keep at most 16% of recurring details
   against 79% for mechanical extraction [P3]. Truncate-or-drop-only compaction cut cost up to 50% [P4]. 83% of
   failed runs trace to a summary entry with no source [P5]. Question-aware selection does no better than random
   deletion for later questions [P6].
3. **Stale observations cause errors, and an execution state fixes them.** Concord flags or suppresses stale
   file observations and answered correctly in all constructed cases [P7]. Ledger, a deterministic layer that
   tracks what was observed, modified and attempted, raised SWE-bench Verified Pass@1 from 56.2% to 64.2% and
   cut cost 28.9% (GPT-5 mini); on Codex +3.4 points at 24.4% lower cost [P8].
4. **On 1M-context models the compaction threshold barely matters**, but discarding more content costs some
   models up to 20 points, and compaction silently drops task rules [P9].
5. **Strong models can manage their own context.** With two tools, Opus 5.5 matched Claude Code at 34% lower
   cost [P10]. Learned when-to-compact policies need training [P11, P12], and history predicts compaction harm
   only weakly (AUROC 0.66) [P13].
6. **Tool inputs can be cleared too.** Deep Agents truncates old write/edit arguments [S1]. Anthropic's server-side
   context editing clears tool results, tool inputs (`clear_tool_inputs`) and thinking (`clear_thinking_20251015`),
   and server-side edits do not count as prefix edits [D1, D2].
7. **Read deduplication is fragile when done at the tool.** Field reports: a dedup stub survived an edit, a
   subagent's first read was replaced, and pruning lost data [S2-S5]. Rule from them: never replace the newest copy.

## 4. Options (ELI5, pros, cons)

### A. Prefix guard: measure and attribute every prefix edit (recommended, observe only)
ELI5: a smoke detector that tells you which room the smoke came from.
- What: in `before_provider_request`, hash `system`, each tool and each message; compare with the previous
  request; record the first changed part (system, a named tool, or message N and its kind), the cache write of
  the response, and the dropped thinking blocks from its diagnostics. Show it in `/compress-stats` and in
  telemetry. It returns nothing, so the request is unchanged.
- Verified value: a manual diff of this kind found both outside causes in section 8 within one session.
  Prior art: `@adeildo/pi-providers` lists each cache miss "and why" (pause, prune or server clear,
  compaction, new model, changed system prompt or tool list) [S6].
- Pros: no risk; it also checks condensed-milk's own edits; it catches the next regression early.
- Cons: it only reports. The largest cause it would have found is already fixed (prompt-start rewrites fell
  from $479 to $85), so its value now is early warning, not savings. Extensions that run after
  condensed-milk in the hook chain are not seen; place the check in the response diagnostics too.

### B. Thinking-safe edits by condensed-milk
ELI5: tidy the desk only at fixed times, so that you do not keep knocking over the stack of notes.
- B1 (recommended, small): bash invalidation waits for the next mask event (zone, boundary or idle) instead of
  editing at once. Measured: after an invalidation trigger, in-run big rewrites are 0.8% of calls against 0.4%
  otherwise ($83 in 30 days, about half above base), and new thinking drops 1.0% against 0.48%.
- B2 (test only): a server-side mode that sends `context_management` with `clear_tool_uses_20250919`
  through `before_provider_request`. Verified on your OAuth account: accepted (HTTP 200), and it kept every
  thinking block where a client-side mask dropped them (section 8.4). Anthropic: "On Claude 5.1 and later
  models, server-side context management never invalidates thinking blocks" [D2].
- Pros: B1 removes a measured excess at no risk. B2 keeps the model's earlier reasoning.
- Cons: B1 keeps an invalidated `git status` visible a little longer. B2: without `clear_at_least` it
  rewrites the cache at every call once over the trigger (seen in the test); it clears by tool name only, so
  it cannot protect `AGENTS.md` reads by path; Anthropic writes the placeholder, so the recall id is lost and
  recall falls back to `match`; Anthropic only; beta.

### C. Mask old edit/write arguments (recommended)
ELI5: you do not need a photocopy of every letter you posted if the letter is in the filing cabinet.
- What: at a mask event, replace the long string arguments (`content`, `oldText`, `newText`) of edit and
  write calls past the cutoff with a placeholder that keeps the keys, the path and the size; `cm_recall`
  returns the arguments. Bash commands over 2 KB (heredoc scripts) can follow the same rule.
- Measured: 1.17B tokens a month past the cutoff ($233), plus $99 for long bash commands.
- Verified: the API accepts changed tool-call arguments; the cache rewrite starts at the edit (section 8.5).
  Deep Agents does the same in production [S1].
- Cons: it is a client edit, so it invalidates later thinking (Anthropic lists "change an earlier
  `tool_use` input" as invalid [D1]); run it only at mask events, which already invalidate. Check OpenRouter
  and vLLM before release.

### D. Collapse superseded, stale and duplicate reads (recommended)
ELI5: keep the newest copy of a page and throw away the older copies.
- What: at a mask event, mask an older read when a newer read of the same path exists, or the file was edited
  after it, or a later result has identical bytes. The placeholder names the newer id or says "edited later".
- Measured: up to $164 a month (overlapping counts, section 2.4). It also removes stale content [P7, P8].
- Cons: never touch the newest read (field bugs S2-S4); a range read is not the same as a full read.

### E. Cost-derived mask schedule (test, do not ship yet)
ELI5: empty the bin when it costs more to keep than to empty, not at fixed fill marks.
- What: mask when the re-read cost of maskable bytes since the last event exceeds the rewrite cost [P2].
- Pros: replaces the arbitrary 0.30/0.45/0.60 thresholds with prices (ADR-020).
- Cons: more mask events than zones; the quality effect is unknown; test it in the replay harness first.

### F. Execution-state view, Ledger-style (later)
ELI5: a whiteboard that says which files you changed and which checks you ran.
- Pros: the largest published gain [P8]. Cons: a large build, and a per-turn note at the end of the context
  changes bytes every turn (tail only). Revisit after A-D.

### Not recommended
- LLM summaries [P3, P5]; question-aware selection [P6]; rolling windows such as keep-last-N [P1].
- Learned compaction policies [P11-P13]: they need training data and a model of our own.
- A 1-hour cache (2.2): it costs more than it saves for your work pattern.

## 5. Compliance with CONVENTIONS.md (condensed-milk-pi)

| Rule | How the plan meets it |
|---|---|
| Data first, pure functions in `filters/` | Guard: `prefixFingerprint(payload) -> {system, tools, messages[]}` and `diffPrefix(prev, next) -> FirstChange` are pure; the hook only stores. Collapse rules are pure functions over light entries. |
| Bounds with provenance | `PREFIX_HISTORY_MAX` (arbitrary: requests kept for diffing), `ATTRIBUTION_ROWS_MAX`, and the existing scan bounds; at-limit actions are visible. |
| Fail loud | The guard never throws into the request path, but it counts and reports its own failures (`guard_failures`). |
| Prompt cache | The guard reads only. Any new placeholder (edit/write arguments, superseded reads) is a deliberate cache bust with an ADR. |
| Tests from spec, property tests, negative space | Laws: (1) the guard returns the payload byte-identical; (2) a mask event never edits a message before the previous cutoff unless it is a mask event; (3) collapse never masks the newest read of a path; (4) masked arguments recall byte-identical. Seeded, red first. |
| Real data | Every feature is replayed on real sessions before release (section 6). |

## 6. How to test against 1.11.1

1. **Offline replay harness (build first).** Extend `tests/replay-recall.mjs` into `bench/replay-cost.mjs`:
   replay the same sessions under policy A (1.11.1) and policy B. Per session it reports re-read tokens, cache
   writes (rewrite from the earliest changed message), thinking blocks invalidated (the Claude 5.x prefix rule),
   identical re-fetches after removal, and cost from the pricing table. Paired by session; report the median
   and a bootstrap 95% CI, never a single percentage [conventions: meas-distributions]. Deterministic, seeded,
   no API calls, so it can run on every change.
2. **Controlled probe runs (cheap, real API).** The protocol of section 8, kept as `bench/prefix-probe.sh`:
   a fixed four-step prompt that makes the model think between tool calls, run with `--no-session` and
   `-ne -e <only the extensions under test>`, with `PI_CLAUDE_CODE_USE_DEBUG_LOG` capturing each request.
   It reports, per call, cache read and write, dropped thinking blocks, and the first changed field between
   consecutive requests. Each run costs about 60k tokens. Use it to confirm every new edit type before release.
3. **Live A/B with telemetry schema 3.** Assign the policy per session at random with a logged seed. Add warm
   rewrites, dropped thinking blocks and prefix attribution (option A) to telemetry. Gate on non-inferiority of
   quality proxies: turns per prompt, edit "could not find" errors, recall-then-re-run, tool error rate [P1].
   Your friends' analysis files give baseline data for other models.
4. **Paired continuation replay (optional, costs API money).** Fork real sessions at 20-50 mask events and run
   k steps with and without the change on the same model; count errors and repeated calls after the boundary,
   as TRACE does [P13] and Compact-Bench does with full-history and summary-only pairs [P3].
5. **Gold standard (optional).** 30-50 SWE-bench Verified tasks through pi in headless mode, policy A against
   B: resolve rate (non-inferiority) and cost per solved task [P8, P10].

### 6.1 Pre-registered adoption gates (set 2026-11-02, before any build)

A feature ships only if every gate in its row passes. A failed gate means the feature is not adopted, and the
result is recorded in this file. Offline comparisons are paired by session over the same 30 days (10,000
bootstrap resamples, seed logged); a "reduction" passes only if its 95% CI excludes zero. Live A/B assigns the
policy per session at random (seed logged), runs at least 14 days and at least 30 sessions per arm, and uses
non-inferiority margins fixed here.

| Item | Offline gates (replay) | Probe gates (real API) | Live gates (A/B against 1.11.1) |
|---|---|---|---|
| Harness | Two runs byte-identical; replayed cache reads within 10% of recorded per-session totals (Spearman >= 0.95) | — | — |
| A. Prefix guard | Request bytes identical with and without the guard (property test, 1,000 seeded cases) | Names the right first-changed field in 3 of 3 runs for each injected edit (late alias, client mask, deleted message); 0 false alarms in 3 clean runs; p99 overhead < 5 ms at 1M tokens | — |
| C. Edit/write arguments | Re-read tokens down by >= 0.8B per 30 days (CI excludes 0); extra cache writes <= +5%; recall returns the arguments byte-identical in 100% of cases | Accepted by Anthropic OAuth, OpenRouter and vLLM (3 of 3) | Turns per prompt <= +5%; edit "could not find" rate <= +0.2 points; recall-then-re-run <= +0.2 per 100 calls |
| D. Collapse reads | Re-read tokens down by >= 0.25B per 30 days (CI excludes 0); the newest read of a path is never masked (property test) | Probe accepted (1 run) | Same three gates as C |
| B1. Batched invalidation | Warm in-run rewrites after an invalidation down by >= 50%; drops after an invalidation not above the base rate (CI) | 0 drops at the invalidation point in 3 of 3 runs | Tool error rate <= +0.5 points; turns per prompt <= +5% |
| B2. Server-side mode | — | 0 thinking drops in 3 of 3 runs; with `clear_at_least`, rewrites per run <= the number of clears | Only if all probe gates pass; same gates as C |

## 7. Sources

Papers
- [P1] The Physical Cost of Context: Quality-Constrained Resource Accounting for Coding Agents, arXiv:2610.34763. https://arxiv.org/abs/2610.34763
- [P2] CADOC: Cache-Aware Dynamic Object Context for Long-Horizon Agents, arXiv:2609.37012. https://arxiv.org/abs/2609.37012
- [P3] Compact-Bench: Measuring What Context Compaction Costs Long-Horizon Coding Agents, arXiv:2610.31710. https://arxiv.org/abs/2610.31710
- [P4] CliffCompaction: Cost-Efficient Compaction for Long-Horizon Coding Agents, arXiv:2609.26779. https://arxiv.org/abs/2609.26779
- [P5] Prune the Summary, Not the History: Source-Judged Compaction, arXiv:2610.20927. https://arxiv.org/abs/2610.20927
- [P6] Evaluating Context Compaction on the Questions That Come Later, arXiv:2610.27301. https://arxiv.org/abs/2610.27301
- [P7] When Agent Context Goes Stale: Incoherence in Volatile Agent Context (Concord), arXiv:2610.05281. https://arxiv.org/abs/2610.05281
- [P8] Turning Interaction History into Execution State (Ledger), arXiv:2608.00808. https://arxiv.org/abs/2608.00808
- [P9] Benchmarks Are Surprisingly Compaction-Friendly, arXiv:2610.31778. https://arxiv.org/abs/2610.31778
- [P10] CTXAgent: Self-Controlled Context Management of LLM Agents, arXiv:2610.34425. https://arxiv.org/abs/2610.34425
- [P11] AutoCompact: Learning When to Compact Context in Long-Horizon Coding Agents, arXiv:2610.02163. https://arxiv.org/abs/2610.02163
- [P12] StateComp: Learning When to Compress History in Long Horizon Agents, arXiv:2609.27298. https://arxiv.org/abs/2609.27298
- [P13] Does an Agent's History Tell You When Compaction Will Hurt? (TRACE), arXiv:2610.08722. https://arxiv.org/abs/2610.08722
- Also read: Maximising Transparency in Context Compaction (transparent-compact for pi, compares pi-vcc), arXiv:2610.20116; When to Forget (RECAP), arXiv:2610.22897; Cache-Aware Prompt Compression, arXiv:2607.15516; Bud ContextCompact 2.0, arXiv:2610.25516; REM, arXiv:2610.27377; Counterfactual Rollout Replay, arXiv:2609.33875.

Vendor docs
- [D1] Anthropic, Preserved thinking. https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
- [D2] Anthropic, Context editing. https://platform.claude.com/docs/en/build-with-claude/context-editing
- [D3] Anthropic, Thinking. https://platform.claude.com/docs/en/build-with-claude/thinking

Software and field reports
- [S1] LangChain Deep Agents, TruncateArgsSettings. https://reference.langchain.com/python/deepagents/middleware/summarization/TruncateArgsSettings
- [S2] hermes-agent issue 139793, dedup stub survives edit. https://github.com/NousResearch/hermes-agent/issues/139793
- [S3] lean-ctx issue 1916, a subagent's first read replaced by the stub. https://github.com/yvgude/lean-ctx/issues/1916
- [S4] hermes-agent issue 120582, data loss from proactive prune. https://github.com/NousResearch/hermes-agent/issues/120582
- [S5] opencode PR 39997, file_unchanged stub. https://github.com/anomalyco/opencode/pull/39997
- pi source read locally: pi-ai `anthropic-messages.js` (block_binding drop_block, input_transformations), pi-coding-agent `extensions/runner.js` (before_provider_request can replace the payload), `@benvargas/pi-claude-code-use` 2.2.1 `extensions/index.ts`, mojo-template-pi-dev `.pi/extensions/enforcement/index.ts`.
- [S6] `@adeildo/pi-providers` 5.15.0 README, "Prompt cache" (cache-miss list with causes; context-management beta "only when the account has the capability"). https://www.npmjs.com/package/@adeildo/pi-providers
- [S7] `@gotgenes/pi-anthropic-auth` 3.4.4 README and `src/request-shaping.ts` (billing header, system-prompt shaping, no tool renaming, thinking-signature fix in issue 66). https://github.com/gotgenes/pi-anthropic-auth
- [S8] `pi-anthropic-oauth` 0.3.6 README (billing header and identity blocks, cache retention follows pi). https://github.com/leohenon/pi-anthropic-oauth
- [S9] `pi-claude-bridge` 0.9.3 README (Claude Code through the Agent SDK; session rebuild re-sends the whole conversation; mid-session system-prompt changes may not reach the model). https://github.com/elidickinson/pi-claude-bridge
- [S10] `pi-claude-subscription` 0.2.4 README (Agent SDK provider with pi's loop; anchor registry for the cache prefix; one-hour cache). https://www.npmjs.com/package/pi-claude-subscription
- [S11] `@benvargas/pi-claude-code-use` 3.0.1 README and `extensions/index.ts` (tool aliasing on by default; aliases registered "before each agent turn"). https://github.com/ben-vargas/pi-packages/tree/main/packages/pi-claude-code-use
- [S12] hermes-agent issue 72171, "system-prompt shape routes subscription requests into the meter". https://github.com/NousResearch/hermes-agent/issues/72171
- [S13] pi docs `mcp.md` (background connection; resource tools; exposure) and `cli.md` (`-ne`, `--no-mcp`, `--approve`), read locally for pi 1.0.4.

## 8. Verification (2026-11-02)

All runs used the operator's Claude subscription (`claude-opus-5-5`, OAuth) and pi 1.0.4, in scratch
directories with `--no-session` or a scratch `--session-dir`. Requests were captured with
`PI_CLAUDE_CODE_USE_DEBUG_LOG`; drops were read from each response's `anthropic_input_transformations`
diagnostic. Session analyses cover 30 days unless stated.

### 8.1 Prompt-start rewrites come from project enforcement extensions

| Measure | Result |
|---|---|
| New thinking drops at the first call after a prompt, by project | `void-marketing` 77%, `stonk-POL` 47%, `mojo-template-pi-dev` 10%, others 5-32% |
| Conditional drop rate when a `mode-context` message precedes the call | 89% (636 of 718), against 26% for any user prompt |
| `stonk-POL` by week (ADR-068 fix added 2026-09-26) | 53%, 92%, 43%, then 6%, 3%, 0% |
| `void-marketing` (old code with a `context` handler that deletes earlier `mode-context`, last changed 2026-09-08) | 77-83% every week |
| Warm prompt-start big rewrites (Opus 5.5) | 30 days: 288 of 1,770 prompts, $479 (`void-marketing` $224, `stonk-POL` $112). Last 14 days: 58 of 1,096, $85 |
| Controlled run in a copy of `stonk-POL` with project extensions loaded (`--approve`), 3 prompts | `system` and `tools` byte-identical; 0 drops; `mode-context` added once and never deleted |

### 8.2 `pi-claude-code-use` is clean except for late aliases

In a 3-prompt run, the extension's output `system` and `tools` were identical on all 6 requests, and no
thinking block was dropped. Its only prefix change is in 8.3.

### 8.3 Mid-run alias registration changes `tools`

| Run (four-step thinking prompt) | Tools added mid-run | Drops | Cache at call 3 |
|---|---|---|---|
| Full user config | 3 aliases `mcp__builtin_mcp__…` at request 3 | all earlier thinking | read kept |
| `--no-mcp` | none | 0 | normal |
| Automatic aliases off (`PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS=1`) | none (custom tools are filtered out instead) | 0 | normal |
| Isolated: `-ne` + MCP + codemode + condensed-milk + `pi-claude-code-use` 2.2.1 | 3 aliases at request 3 | 2 blocks | read 2,015, write 9,755 |
| Same with 3.0.1 | 3 aliases at request 3 | 2 blocks | read 2,015, write 9,620 |

Cause: pi connects MCP servers in the background (the `interface-lineage` server offers resources, so pi adds
its three resource tools). The extension registers MCP-style aliases for them in the middle of the run, and
they become active, so `tools` changes once per pi process. Anthropic lists "Add, remove, rename, or edit a
tool in `tools`" as invalid for every thinking block, while "Add a tool with `defer_loading: true` that nothing
has referenced yet" stays valid [D1]. A first run in a new session has a small context, so the rewrite is
small; a resumed long session pays a full rewrite. Fixes outside condensed-milk: disable the MCP server when it
is not needed, or ask the extension's author to register late aliases as deferred tools.

### 8.4 Client-side mask against server-side clear (no MCP)

| Run | Dropped thinking | Cache |
|---|---|---|
| No change | 0 | normal |
| Client-side mask of the first long result from call 4 (what condensed-milk does) | 2 blocks, all after the edit | rewrite from the edit, once |
| Server-side `clear_tool_uses_20250919` (trigger 12k tokens, keep 1, no `clear_at_least`) | 0 | rewrite at calls 3 and 4 (every call over the trigger) |

The OAuth endpoint accepted the `context-management-2025-06-27` beta and the `context_management` field
(HTTP 200, added to `payload.betas` through `before_provider_request`).

### 8.5 Masked tool-call arguments

Replacing the string arguments of an earlier `bash` call with a placeholder from call 3 on: accepted, normal
stop, cache read up to the edit (11,083) and a write of 284 tokens after it.

### 8.6 Effect of condensed-milk's own edits (30 days, Opus 5.5, warm in-run calls)

| After | Calls | Big rewrites | Rewritten | Cost |
|---|---|---|---|---|
| A zone crossing (30/45/60%) | 355 | 53 (14.9%) | 16.4M tokens | $82 |
| A bash invalidation trigger | 4,963 | 40 (0.8%) | 16.7M | $83 |
| Anything else | 41,028 | 153 (0.4%) | 46.3M | $232 |

New thinking drops: 15% of calls right after a zone crossing, 1.0% after an invalidation trigger, 0.42-0.48%
otherwise. Zone advances are the designed three rewrites per session (ADR-018).

### 8.7 Other Claude-subscription extensions for pi

| Extension (monthly downloads) | Approach | Tools | Prefix and cache handling |
|---|---|---|---|
| `pi-claude-bridge` (72,068) | Runs Claude Code through the Agent SDK as the provider | pi tools bridged to Claude Code | Rebuilds Claude Code's session from pi history when they diverge, which re-sends the whole conversation; mid-session system-prompt changes may not reach the model [S9] |
| `@gotgenes/pi-anthropic-auth` (27,880) | Transport wrapper: billing header, system-prompt shaping | Not renamed | Fixed a thinking-signature break (issue 66); no tool-list changes [S7] |
| `@adeildo/pi-providers` (3,286) | Billing header; moves pi's system blocks into the first user message | Not renamed | Learned cache warming; per-session list of cache misses with causes; optional context-management beta [S6] |
| `pi-claude-subscription` (2,075) | Agent SDK provider with pi's own loop | pi tools as in-process MCP | Anchor registry keeps the cache prefix across aborts and forks; one-hour cache [S10] |
| `pi-anthropic-oauth` (1,462) | Full provider override: billing header, identity, "Pi" rewritten to "Claude Code" | Renamed for Claude Code | Cache breakpoints follow pi's retention setting [S8] |
| `@benvargas/pi-claude-code-use` (1,117, yours) | Payload patch: three phrases, MCP-style aliases | Aliased | Late alias registration changes `tools` (8.3) [S11] |
| `pi-claude-oauth-adapter` (884), `pi-claude-subscription-connector` (789) | Payload patches (the second derives from yours) | Removed pi docs block / aliased | Not documented |

Two approaches disagree on what keeps a request on the plan: tool and prompt shape (`pi-claude-code-use`,
hermes issue 72171 [S12]) or the Claude Code billing header (`gotgenes`, `pi-anthropic-oauth`, `adeildo`).
Neither pi 1.0.4 nor `pi-claude-code-use` sends the billing header. This round could not see billing; check
claude.ai usage settings for extra-usage charges.

### 8.8 Repeated A/B for the late-alias cause, and the real-session check

Isolated pi (`-ne` + MCP + codemode + condensed-milk + `pi-claude-code-use` 3.0.1), same four-step prompt,
three runs per arm:

| Arm | `tools` changed mid-run | Thinking dropped | Tools declared |
|---|---|---|---|
| A: automatic aliases (default) | 3 of 3, at request 3 | 3 of 3 runs, all earlier blocks | 7 rising to 10 |
| B: configured aliases only (`PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS=1` + `toolAliases` for codemode and `cm_recall`) | 0 of 3 | 0 of 3 | 7 throughout |

Mechanism in code: `tool-aliases/registry.ts` registers each alias with `exposure: "model-only"`, and pi
activates `direct` and `model-only` tools on registration (pi `extensions.md`). pi's own payload never declared
the flat MCP resource tools; only the aliases appeared.

Real sessions: in the 9 sessions since `mcp.json` was added (2026-10-29), no system message adds the MCP resource
tools or their aliases, at the start or later. The server is listed as `codemode` in the prompt. So the fault
reaches headless runs that send a prompt while the server connects (`pi -p`, `--mode json`, bots), not the
operator's interactive work. Other system-message triggers of drops in real sessions are full system-prompt
rebuilds (all sections change at once: resume or fork into another folder, reload): 63 events in 30 days.

Clean fixes without disabling the server globally, in order: `--no-mcp` on headless launches that do not need MCP;
a project `.pi/mcp.json` entry `{"interface-lineage": {"enabled": false}}` in bot projects; arm B's
configuration (it works, but every custom tool then needs an explicit alias, per project); an upstream change so
that tools pi does not declare get no alias.

### 8.9 The official Earendil provider and OpenCode's Claude Agent

`earendil-works/pi-claude-code` 0.1.0 (MIT, 289 stars, last push 2026-10-12, install from git) and OpenCode
2.2.3's Claude Agent (2026-10-30) use the same design: the real Claude Code CLI sends the model request, and the
harness runs the tools. Comparison with the operator's `pi-claude-code-use` 2.2.1:

| | `pi-claude-code-use` | `pi-claude-code` (Earendil) |
|---|---|---|
| Login | pi's `/login anthropic` OAuth token | Claude Code's own login (`claude auth login`) |
| Request path | pi's Anthropic provider, payload patched (three phrases, tool aliases) | `claude -p` with `stream-json`, through a loopback relay that forwards one request per pi turn |
| Tools | Flat custom tools renamed to `mcp__…` aliases | Exposed as an inert MCP inventory; Claude Code never runs them |
| Mid-run tool changes | Change `tools` (8.3, 8.8) | Injected as native tool additions at their original boundaries; cache kept on supported models |
| Plan protection | None | Stops a turn that Claude Code reports as charged to usage credits (`isUsingOverage`); refuses API-key and proxy overrides |
| Process cost | None | Warm process reuse for exact linear continuations; branches, edits and tool-use boundaries start a fresh process that replays the conversation |
| Billing risk | Anthropic's classifier reads prompt and tool shape | `claude -p` usage counts toward the plan today; the May 2026 plan to move it to a separate Agent SDK credit was paused on 2026-06-16 |
| condensed-milk impact | `before_provider_request` sees the Anthropic payload | It does not: a prefix guard must read response usage, and server-side mode (B2) is not available |

Not tested: Claude Code on this machine is 2.1.105 (OpenCode requires 2.1.248 or later) and its OAuth token is
rejected with 401, so a test needs `claude auth login` and an update first.
Sources: Earendil README and ARCHITECTURE.md; OpenCode `claude-agent.mdx`; The New Stack, "Anthropic pauses
Claude Agent SDK subscription change" (2026-06-16); @opencode on X, 2026-10-30.

### 8.10 Earendil provider against the current setup (gates set before the runs)

Setup: isolated pi (`-ne` + MCP + codemode + condensed-milk 1.11.1) with either `pi-claude-code-use` 2.2.1
(current, `anthropic/claude-opus-5-5`) or a test copy of `earendil-works/pi-claude-code` at `70abb65`
(`claude-code/claude-opus-5-5`, Claude Code 2.1.316, Max plan). The test copy only adds logging to the relay:
hashes of `system`, `tools` and each message, the message shapes, and Anthropic's `input_transformations`.

| Gate | Result | Verdict |
|---|---|---|
| G1 Plan only | `isUsingOverage: false` on every turn; overage `rejected` (`out_of_credits`); weekly utilization 0.78 (`allowed_warning`) | Pass |
| G2 Late tools | `tools` fixed at 7 entries with one hash in 6 of 6 runs; MCP resource tools never declared; no failing block reported | Pass |
| G3 Cache | Median cache-read share 91.6% against 96.3% (within 5 points); writes after a mask equal (313 against 330 tokens) | Pass, narrowly |
| G4 condensed-milk | The mask applied (52,576 bytes to a 131-byte placeholder), `cm_recall` found the masked result, 3 of 3 runs | Pass |
| G5 Speed | Four-step probe median 13.9 s against 13.2 s (1.05x); mask-and-tools test 21-22 s against 21.4 s | Pass |
| G6 Tools | bash, read, edit, write and `cm_recall` worked; files changed as asked, 4 of 4 runs | Pass |

Main difference found: on the Earendil path the request history never contains earlier thinking blocks. Claude
Code sends `context_management: {edits: [{type: "clear_thinking_20251015", keep: "all"}]}` with
`thinking: {type: "adaptive"}` and no `block_binding`, but replays earlier assistant turns as text and tool calls
only (relay shapes `a:U`, `a:t`), although pi stores them with thinking and Earendil's transcript code would pass
signed blocks. So the model always starts each call without its earlier reasoning, and condensed-milk edits cannot
invalidate thinking. On the current setup, earlier thinking is kept until an edit drops it (1 block dropped at the
mask in 2 of 2 runs). Output tokens per probe run were similar (362-527 against 478-508).

Consequences for condensed-milk if the operator switches: options B1 and B2 lose their purpose (no thinking to
protect, and B2 cannot be injected); the prefix guard (A) must read response usage, because pi's
`before_provider_request` never sees Claude Code's request; C and D work unchanged, because they act in pi's
`context` event.

### 8.11 Earlier thinking on the Earendil path: where it is lost, and whether it matters

Question from the operator: is the missing earlier reasoning (8.10) a real problem, and is it discussed elsewhere?

Where it is lost (three captures, same four-step prompt):

| Path | What Anthropic receives for earlier assistant turns |
|---|---|
| Native Claude Code 2.1.316 (`claude -p`, then `claude -p --continue`, through a logging proxy) | Thinking kept in every earlier turn, across the tool loop and the second prompt (`a:TU`, `a:Tt`); `clear_thinking_20251015` with `keep: "all"` |
| Earendil: frames that `pi-claude-code` writes to Claude Code's `stream-json` input | Signed thinking blocks present (`assistant thinking,tool_use`), 968-character signatures |
| Earendil: the request that Claude Code then sends | No thinking in any earlier turn, also inside the same tool loop (`a:U`) |

So Claude Code keeps its own thinking but leaves out thinking that arrives through `stream-json` input. Earendil
passes it correctly. The cause inside Claude Code is not known, and no report of this exact case was found.

Whether it matters:

- Anthropic, April 23 postmortem: a Claude Code bug that cleared older thinking on every turn "made Claude seem
  forgetful and repetitive"; it was treated as a quality regression and fixed. https://www.anthropic.com/engineering/april-23-postmortem
- Anthropic, adaptive thinking docs: "When you have thinking blocks, pass them back unmodified, particularly during
  tool use, where they carry the reasoning behind Claude's tool calls." Opus 4.5 and later keep all prior turns'
  thinking by default (thinking docs, "Thinking block preservation by model").
- claude-code issue 54482 (April-June 2026, closed as inactive): users saw thinking stripped from the prompt on every
  turn of active sessions and described the effect as reasoning "against the visible response trail rather than its
  own prior reasoning"; one user confirmed it on Opus 4.8. Self-reported, not confirmed by Anthropic.
- No controlled measurement of the quality effect on Opus 5.5 was found. The 8.10 probes were too short to show one.

Comparison with the current setup: there, earlier thinking is kept until a prefix edit drops the blocks before the
edit; blocks produced after the edit are kept. On the Earendil path no earlier thinking reaches the model at all.

Decision: the switch is not recommended on current evidence. It would trade a fixable loss (prefix edits, sections
8.1-8.6) for a permanent one. Reopen if Claude Code starts passing `stream-json` thinking through, or if a paired
test shows no quality loss.

## 9. Replay-cost harness: built and validated (2026-11-02)

`bench/` (see `bench/README.md`). It drives copies of the real `index.ts` through pi's own session projection and
usage estimate, on 38 sessions (51,472 calls, 30 days).

### 9.1 Harness gates (§6.1)

| Gate | Result |
|---|---|
| Two runs byte-identical | Pass (two runs, same SHA-256) |
| Replayed cache reads within 10% of recorded per-session totals, Spearman >= 0.95 (17 held-out sessions) | Pass: aggregate -4.9%, median per session 6.2%, Spearman 1.000 |
| A/A check (two identical arms) | Every difference exactly 0 |
| Positive control: zones off | +$1,572 [699, 2,667] and +3.96B prompt tokens per 30 days |

The first version failed the gate (+13.5% reads, median prompt error 12.2%). The cause was pi restarts: the extension
resets its zones on `session_start`, so a resumed session re-enters the highest zone with coverage applied to the
current message count and masks more than a continuous run. Session files record no restart; the harness infers 379
of them (rule in `bench/README.md`). After that, the median prompt error per call is 3.8%.

### 9.2 First findings from the controls (30 days, arm minus 1.11.1 with the operator's config)

| Arm | Cost | Thinking blocks invalidated by edits | Identical re-fetches of masked results |
|---|---|---|---|
| Idle trigger off | +$142 [66, 236] | +12 [-204, 220] (no measurable effect) | 0 [-4, 4] |
| Boundary trigger off (`bd close`) | +$49 [15, 92] | -704 [-1,471, -105] | -30 [-70, -3] |
| Both off | +$191 [99, 304] | -663 [-1,379, -80] | -31 [-70, -4] |

Reading: the idle advance saves money at no measurable cost to reasoning. The task boundary saves less and costs
reasoning and re-fetches; it is a candidate to remove or to tune. Both triggers are 1.11 features that ran live only
since 2026-11-01, so these are replayed effects.

### 9.3 Other findings

- The operator's rules config has `disableDefaults: true` and no invalidation rules (since 2026-10-12), so bash
  invalidation does not run in this setup. The measured B1 excess (§8.6) was a correlation, not condensed-milk's edit.
  B1 is relevant only to users with the default rules.
- Bug in 1.11.1: `session_start` rebuilds `config` without `cacheTtlSeconds`, so that setting is lost after every
  start. To fix in the next release.
- Design question for a later feature: persist the frozen cutoff across restarts (for example in a session entry), so
  that a resume does not re-mask. It would keep more reasoning; whether it costs more must be measured with the harness.
