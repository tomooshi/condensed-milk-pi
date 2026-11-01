# Research: give agents a way back to masked tool results

Date: 2026-11-01. Scope: condensed-milk-pi v1.10.0. Status: approved by the operator on 2026-11-01
(sections 6 and 9.3, plus the idle trigger), built in v1.11.0. Decisions: `docs/adr/CM-ADR-001`, `CM-ADR-002`.

Correction found during the build: pi's `SessionManager.open()` migrates old session files and
rewrites them, so recall from another session reads the `.jsonl` file directly (CM-ADR-002 §1).

## 1. The problem

Condensed-milk masks old tool results with `[cm-masked bash|read] …` placeholders. The
placeholder names the command or the path, but it gives no way to get the old output back.
The system-prompt explainer tells the agent to "re-run the command or re-read the file".
A re-run gives the current state, not the result the agent saw. Some results cannot be
reproduced: `git status` before a commit, a web page that changed, a slow test run, a
subagent or codemode result.

## 2. Short answer

Build **addressable masking**: every placeholder carries a stable id, and one new tool,
`cm_recall`, returns the exact original from the pi session file. The session file already
keeps every original, because condensed-milk masks only a copy in the `context` event.
The 2026 research converges on this design (ARC, ReFold, Agent-Controlled Forgetting, LCM,
pi-fold). It also shows that the two other popular moves, shrinking output when it arrives and
deleting history per turn, usually cost more money on cached APIs.

## 3. Evidence from your own sessions

Method: 40 pi sessions, 30 days, 48,349 LLM calls, active branch only. Masking is simulated
with your config (`thresholds 0.30/0.45/0.60`, `coverage 0.60/0.80/0.95`) on a 1M window.
Scripts: `/tmp/cmres/*.py` (not kept in the repo).

| Measure | Value |
|---|---|
| Mean context per call (API usage) | 391k tokens |
| Tool results, share of re-read bytes (thinking signatures removed) | about 46% |
| Results masked (simulated) | 27,750 |
| Masked results the agent fetched again with the identical command or read | 63 (0.2%) |
| Of those re-fetches, output identical to the masked original | 55 of 63 (87%) |
| LLM calls from mask to re-fetch | median 60 (p25 30, p75 162) |
| `vcc_recall` calls (history lookup already in use) | 204 calls in 18 of 40 sessions |
| Mean masked placeholders carried per call | 191 |
| Cost of a 10-character id on each placeholder | about 574 tokens per call (0.15%) |
| Longest session branch | 26,241 entries (12,232 tool results) |

Reading of the numbers:

1. Exact re-fetches are rare. When they happen, 87% return the same bytes, so a recall
   would have served them without running the tool again.
2. Agents already look things up in history: 204 `vcc_recall` calls in 30 days.
3. A stable id is cheap (0.15% of context). A head-and-tail preview on each placeholder
   would cost about 9.5k tokens per call (2.4%) for a need that occurs 0.2% of the time.
   So the placeholder gets an id and size metadata, not a preview.

Earlier in this session, a separate analysis found that a land-time shrink in the style of
Context Mode saves re-reads equal to about one full-context call per large result (median).
It pays only if the agent rarely needs the detail.

## 4. What the 2026 research says

### 4.1 Masking works, but it removes evidence that is sometimes needed

- Masking halves cost relative to the raw agent and matches LLM summarization on solve rate.
  Summaries make trajectories about 15% longer [1][2].
- Masking is a token-for-turn trade. It removes observations that the model no longer attends
  to. Observation attention falls to about 0.7% one turn after the most recent turn. The gain
  collapses for strong ("saturated") models, because masking then removes evidence the model
  would have used [3].
- When eviction cannot be undone, most errors are irreversible: 0.67 to 0.73 of the errors
  that restoration fixes at an 80k budget, and 1.00 at 8k [4].
- In practice, Claude Code's microcompact replaces results with
  `[Old tool result content cleared]` and gives no way back. Users report silent loss of
  context and of the audit trail [5].

### 4.2 Deletion and compression often raise the bill on cached APIs

- In 9,400 SWE-bench Verified runs, deleting tool output raised re-fetches up to 7.5 times
  (10.6 times with no delay). The re-fetches reached back 6 to 12 turns. Under
  cache-aware pricing, none of 42 configurations was cheaper. Immediate deletion lowered
  the solve rate [6].
- In 2,848 provider-billed Claude Code runs, tool-output reduction cut delivered tool tokens
  by 38.4% and raised billed cost by 6.8%. Cache writes and reads were about 80% of the bill [7].
- Turn count explains 84% of the variance in log trajectory cost, and mean observation size
  explains 4% [8].
- Per-turn masking cut the prefix-cache hit rate from 84% to 23%. Chunked rewrites (once
  every k=3 steps) keep the cache [9]. Anthropic's `clear_at_least` exists for the same
  reason: clear enough to make the cache break worth it [10].

Condensed-milk's static cutoff already batches mask events into three zone advances, so it is
on the correct side of these findings.

### 4.3 Addressable, reversible removal is the convergent design

- **ARC**: an append-only store keyed by stable ids. A compact citation (id, head and tail
  preview, length, return code, recall hint) replaces old observations. Recall by id does not
  re-run the tool. Needle accuracy rose to 99.40% from 88.12% [11].
- **ReFold**: a rendering layer over the unmodified history. Every stub is reversible. The
  prompt separates `restore <step>` ("exactly as first shown, runs nothing") from a re-run
  ("its current state"). It also says that each one adds a step. With reversibility off, a
  third of the observation tokens could not be recovered [9].
- **Agent-Controlled Forgetting**: `context_recover(ref)` returns the original as a new tool
  result at the end of the conversation. Recovery does not re-run the tool, and the result is
  "evidence of the earlier observation, not a fresh environmental measurement" [12].
- **LCM / Volt**: lossless pointers to every original behind a summary DAG. It beats Claude Code
  on OOLONG at all lengths from 32K to 1M [13].
- **Self-GC**: separates fold (exact payload to a sidecar, plus a recovery pointer) from prune
  (no recovery guarantee). Its failure catalogue names "locator / handle loss" [14].
- **Scroll**: an eviction index keeps landmarks tied to exact log addresses, so the agent goes
  straight to the evicted region and does not search the whole log [15].
- **Industry**: Manus keeps a "full" and a "compact" (path) form of each tool result [16].
  LangChain Deep Agents offload results over 20,000 tokens to a file with a 10-line preview [17].
  Anthropic pairs tool-result clearing with the memory tool, but the agent must save what it
  needs before the clearing happens [10].
- **pi ecosystem**: pi-context-prune summarizes and offers a `context_tree_query` escape
  hatch [18]. pi-dynamic-context-pruning has a cache-aware break-even gate and a manual restore
  picker [19]. pi-fold folds spans into briefs with hash-addressed originals that the agent can
  expand [20].

### 4.4 Recall needs an explicit prompt and a budget

- Agents do not reliably call memory or recall tools unless the prompt tells them to [21][22].
- A recall costs one segment, and the cost is bounded. Its net value depends only on session
  length and recall frequency [23]. ARC caps recalls per step, per recall and in total [11].

## 5. Options

Each option has a short plain explanation ("ELI5"), then its pros and cons.

### A. Keep masking, and point the explainer at `vcc_recall`

ELI5: the papers still go in the bin, but a note on the bin says that another librarian keeps
copies.

- Pros: one string change and no new code.
- Cons: it depends on pi-vcc, which other users may not have. `vcc_recall` searches by keyword,
  so the agent cannot ask for "result #id". Placeholders still carry no handle.

### B. Addressable masking: id in the placeholder, plus `cm_recall` (recommended core)

ELI5: each paper that leaves the desk gets a ticket number. The agent hands in the ticket and
gets the same paper back, exactly as it was.

- Pros: exact and lossless, with no new store, because pi already saves the originals. It is
  cache-safe: the id is fixed and the recall lands at the end. It follows the 2026 consensus
  [9][11][12][13]. It also works for results that compaction dropped.
- Cons: one cache miss at upgrade, because the placeholder bytes change once. Each recall costs
  one turn [8]. The agent must be told to use it [21].

### C. Land-time offload (Context Mode, Deep Agents)

ELI5: big papers never reach the desk. The agent gets a sticky note and must ask for the
paper.

- Pros: smaller context from the first turn, and big headline byte savings.
- Cons: the agent never sees the full output, which is "immediate deletion" in [6] and lowered
  the solve rate there. Billed-cost studies show no saving or a loss [6][7]. On your data, the
  median break-even is about one extra call per result. Context Mode shrinks `read` results
  as well.

### D. Agent-controlled forgetting or folding (ACF, pi-fold, Self-GC planner)

ELI5: the agent decides which papers to file away and writes its own note on each folder.

- Pros: notes can be task-aware. Savings of 50% in a noisy trajectory [12].
- Cons: extra tool calls and turns. The paper found no saving in a second pair, one case of
  lower quality, and runs 17% longer [12]. Notes can be wrong. It needs a planner or extra
  model work.

### E. LLM summarization (pi-context-prune, compaction)

ELI5: someone rewrites the old papers as a short summary.

- Pros: keeps the narrative.
- Cons: hides exact evidence, makes trajectories about 15% longer, and adds model calls
  [1][2][14]. ADR-016 already rejected it for condensed-milk.

### F. Full-text search over history (ctx_search, opencode-session-recall, vcc_recall)

ELI5: a search box over every old paper.

- Pros: finds content when the agent does not know the id.
- Cons: ranking can miss, so lookup is not exact [11]. It needs an index or a full scan.
  pi-vcc already does it, so a second copy would duplicate work.

### G. Cache-aware gate on mask events

ELI5: tidy the desk only when the tidy saves more than it costs.

- Pros: protects the prompt cache [10][19].
- Cons: condensed-milk's static cutoff already batches mask events into three zones, so the gain
  is small now.

### H. Deduplicate repeated outputs (ReFold stubs)

ELI5: if the same paper is on the desk twice, keep only the newest copy.

- Pros: 18% to 60% token cuts in ReFold [9].
- Cons: each new stub between zone advances rewrites the cached prefix. The static cutoff
  already masks old duplicates.

## 6. Recommendation

Build option B fully, with three parts that close the remaining gaps. Keep G as it is today.
Do not build C, D, E or H now. Leave F to pi-vcc.

```
tool result lands (tool_result)
  ├─ the filter changed the output ─► keep the raw text in details.condensedMilk.raw
  │                                  (never for secret filters such as env/printenv)
  └─ the content goes to history as today
zone advance (context event, static cutoff, unchanged)
  └─ placeholder: [cm-masked bash #3f9a2c1d7e] git status (412 lines, 23.4KB)
agent needs the old output
  └─ cm_recall({ id, grep?, offset?, limit?, raw? })
       ├─ scan ctx.sessionManager.getBranch() for the entry (bounded scan)
       └─ new tool result at the end: "[cm-recall #3f9a2c1d7e] original output, 88 turns ago,
          not the current state" + the lines asked for
agent does not have the id (for example after compaction)
  └─ cm_recall({ match: "git status" }) ─► at most 10 rows: #id · turn · tool · command · size
```

### 6.1 Parts

1. **Stable id in each placeholder.** `id = first 10 hex chars of sha1(toolCallId)`. The id is
   independent of the provider's id format, and it never changes, so the placeholder bytes stay
   the same on each turn. The length is fixed: ARC-style growth on a collision would rewrite
   earlier placeholders and break the cache. At 12,232 results (the measured maximum) the chance
   of a collision is about 7 in 100,000. `cm_recall` reports an ambiguous id as an error with the
   candidates, and never picks one silently.
2. **`cm_recall` tool.** It returns the original exactly as first shown, read from the session
   branch, which is the authority. It keeps no in-memory archive, so it survives restarts.
   Options: `grep` (matching lines with numbers), `offset` and `limit` (line slice), `raw` (the
   pre-filter text when one was kept), and `match` (find ids by command or path). The header
   always says "old output, not current state", following [9][12].
3. **Raw text for lossy land filters.** When a condensed-milk filter shrinks a bash result, the
   raw text goes into the result's `details` field. pi saves `details` in the session file and
   does not send it to the model. So no spill directory and no cleanup job exist. Secret-masking
   filters never keep raw text, because that would write secrets to the session file.
4. **Recall results can be masked.** A `cm_recall` result ages like any other result and becomes
   `[cm-masked recall #id]` at a zone advance. Recalled text does not pile up.
5. **New explainer, static bytes.** It tells the agent how to use the id and when to re-run
   instead. This follows [21][22] and the ReFold prompt [9]. Proposed text:
   "Old tool results can appear as `[cm-masked bash|read|recall #id] …`. To see one exactly as it
   was, call `cm_recall` with the id (add `grep`, `offset`/`limit` for part of it). To see the
   current state, re-run the command or re-read the file. Each costs one step, so do it only
   when the next step needs the content."
6. **Telemetry (opt-in, as today).** Count recalls, turns from mask to recall, bytes returned,
   use of `grep`/`raw`/`match`, and a recall followed by a re-run of the same command (the
   recall was not enough). This gives the data that ADR-020 is waiting for.

### 6.2 Kept unchanged on purpose

- Thresholds and coverage stay as they are. Change one variable at a time, and let the recall
  telemetry decide later (ADR-020).
- No land-time shrink: the evidence is in section 4.2.

### 6.3 Named bounds (with provenance)

| Bound | Value | Provenance |
|---|---|---|
| `RECALL_OUTPUT_BYTES_MAX` | 51,200 | inherited: pi `DEFAULT_MAX_BYTES` (50 KB) |
| `RECALL_OUTPUT_LINES_MAX` | 2,000 | inherited: pi `DEFAULT_MAX_LINES` |
| `RECALL_SCAN_ENTRIES_MAX` | 65,536 | measured: longest branch 26,241 entries in 30 days, about 2.5x headroom |
| `RECALL_MATCH_ROWS_MAX` | 10 | arbitrary: revisit if telemetry shows `match` followed by a second `match` |
| `RAW_KEEP_BYTES_MAX` | 51,200 | inherited: pi bash truncation already caps the raw text |
| `SHORT_ID_HEX_CHARS` | 10 | derived: 12,232 results, birthday bound n²/2⁴¹ ≈ 7e-5 |

At-limit actions are visible to the caller: a cut output ends with a line that says how to page
with `offset`. A scan that hits the limit returns an error that names the bound.

## 7. Compliance with CONVENTIONS.md

Source: `mojo-template-pi-dev/CONVENTIONS.md`. condensed-milk-pi has no copy and none of the
template's gate scripts, so each rule below is applied by hand and checked in review.

| Rule | How the change meets it |
|---|---|
| DOD data-first, separate data from behavior | Plain shapes (`MaskRef`, `RecallRequest`, `RecallSlice`) and pure functions (`shortId`, `renderPlaceholder`, `findResultById`, `sliceLines`). I/O only in the tool's `execute` boundary. |
| Batch over iterate | `.filter`/`.map` over branch entries, no push-in-loop. |
| Level-triggered logic, no in-memory progress | Recall reads the session branch on each call. It does not keep an archive in memory. |
| Fail loud, no silent swallow | An unknown id, an ambiguous id, a bad regex or an offset past the end returns `isError: true` with the reason. The `catch {}` sites in the touched functions get fixed. |
| Static limit on everything (ADR-032), bound provenance (ADR-044) | Table 6.3. Every scan loop names its bound. |
| Power of Ten: functions ≤ 70 lines, ≥ 2 assertions, complexity ≤ 15, ≤ 7 args | New functions stay small. Options structs replace long argument lists. |
| TigerStyle: split asserts with messages, pair assertions (ADR-038) | The id format is asserted at render (L3) and at recall parse (L2). The round trip is asserted in tests. |
| Explicit options at call sites | Pass all slice and scan limits explicitly. Do not rely on defaults. |
| Tests from spec, property test with printed seed, negative space | Properties: (1) recall(id(placeholder(r))) returns the original bytes exactly, (2) the placeholder renders the same bytes twice, (3) masking with ids changes only placeholder text, never order or count. Negative cases: unknown id, ambiguous id, bad regex, offset past end, scan bound hit, secret filter keeps no raw text. A seeded PRNG keeps the repo free of new dependencies. Write the tests red first. |
| Test on real data | Replay on real session files with `test-replay.mjs`. |
| Commit format, say why | `feat(recall): …` with a body that gives the problem, the fix and the measured result. |
| ADR for a cache bust | The placeholder and explainer changes are deliberate cache busts. The code comment at `CM_EXPLAINER` requires an ADR. |
| First-principles protocol (ADR-035) | Speed-of-light sketch: "the agent asks for result #id and gets the same bytes back". Constraints: (1) cache-stable bytes, (2) no new store, (3) bounded scans, (4) secrets never persisted, (5) the agent must know when to recall and when to re-run. |
| Measurement discipline, adverse interest | Judge success by cost per solved task and by the cache-hit ratio, not by token counts [7]. Report the recall rate and the recall-then-re-run rate. |

## 8. Validation plan

1. Offline: replay 40 real sessions. Check that placeholders render the same bytes on each turn,
   that every id resolves to its original, and that the placeholder growth is about 0.15%.
2. Live: about two weeks with telemetry on. Watch the recall rate, recall then re-run, the
   cache-hit ratio and the cost per session against the weeks before.
3. Decide on threshold changes (ADR-020) only after step 2.

## 9. Fit by workflow

### 9.1 The operator's workflow (long interactive sessions)

Data: 23 of 40 sessions reach the first zone (300k tokens), 19 reach 45%, 13 reach 60%, and 14
compact. The median session has 404 LLM calls. All of them run a frontier model on a 1M window.

- Masking fires in most long sessions, so the recall path gets used where the cost is.
- A frontier model is in the "saturated" regime, where masking can remove evidence that the
  model would use [3]. Reversible removal is the remedy.
- The cost is in the cache, so land-time shrink and per-turn deletion are the wrong tools [6][7].
- Most `vcc_recall` queries look for operator decisions, which are conversation, not tool output.
  Compaction loses those, not masking. Addressable masking does not fix that. pi-vcc and
  pi-context stay responsible for it.
- Sessions often switch tasks (several beads in one session). A task-boundary trigger (9.3)
  helps here too [12].

### 9.2 A fleet of parallel bots with lifecycle management

Two shapes exist, and they need different things.

1. **Short-lived bots, one task per session.** On a 1M window they never reach the first zone.
   None of the 11 operator sessions under 100 calls went past 258k tokens. On small windows
   (200k, or a 131k profile cap) the zones fire at 60k or 39k tokens, so recall matters there.
   The cost drivers are turn count [8] and fan-out: subagents used 2.6 to 5.9 times the input
   tokens of sequential work [29]. Those are outside condensed-milk. The land filters still help
   from turn 1. A successor bot needs evidence from its predecessor's session [28].
2. **Long-lived bots that work a queue in one session.** CWL ran 89 sequential tasks across
   80 million tokens in one session by evicting finished episodes [27]. Agent-Controlled
   Forgetting saved 50% when an unrelated task followed a debug task [12]. A task boundary is
   the natural point to mask: one cache rewrite per task, and recall keeps it reversible.

Properties that matter for fleets and that the design already has:

- No shared store. Each bot reads its own session, so hundreds of bots do not contend for one
  database. Context Mode uses one SQLite database per project, which all bots in that project
  share.
- `cm_recall` calls `ctx.sessionManager`, not a file path, so it also works on hosts whose
  session storage is not a local JSONL file, such as Pi Durable on Durable Objects [30].
- Deterministic placeholders and level-triggered recall survive restart and hibernation.
- The audit trail stays: each id maps to a session entry. Compare the Claude Code complaints in [5].
- Masking never touches user messages or the system prompt, and protected reference files
  (`AGENTS.md`, `CONVENTIONS.md`, rules) are never masked. Compaction that drops standing
  instructions raised violation rates from 0% to 30% (up to 59%) [26].

### 9.3 Additions for fleets (and for task switching)

1. **Task-boundary trigger.** A lifecycle signal advances the cutoff to the current message once.
   Sources: a `pi.events` message from an orchestrator extension, a `/cm-boundary` command, or a
   configured command pattern (for example `bd close`) through the existing rule matcher. The
   cost is one cache rewrite per task, the same as a zone advance.
2. **Recall from a predecessor session.** `cm_recall({ session, id | match })` reads another
   session read-only, so a handoff can cite `#id` evidence. It is bounded by the same scan limit
   and resolved through pi's session API.
3. **Window-relative bounds.** The recall output cap becomes
   `min(RECALL_OUTPUT_BYTES_MAX, 5% of the effective window)`. 50 KB is about 10% of a 131k
   window. The profile supplies the window, as `effectiveContextCap` does today. Small models
   need the explicit recall prompt most [21].
4. **Idle-aligned advance (proposed after the approval list).** When the time since the last
   assistant message is longer than the cache TTL (1 hour with `PI_CACHE_RETENTION=long`), the
   next call rewrites the whole prefix anyway. Advancing the cutoff by one zone at that moment
   adds no cache cost and makes the forced rewrite smaller. Claude Code's time-based
   microcompact uses the same trigger, but without recall [5]. Recent results stay, because the
   operator usually comes back to the same task.

## 10. Sources

1. Lindenbauer et al., "The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management", arXiv:2508.21433 (2025). https://arxiv.org/abs/2508.21433
2. K. Pandey, PREreview of The Complexity Trap (2026-10-06). https://prereview.org/en-us/reviews/23176605
3. "Masking Stale Observations Helps Search Agents — Until It Doesn't: A Regime Map and Its Mechanism", arXiv:2606.00408, EMNLP 2026. https://arxiv.org/abs/2606.00408
4. "What Eviction Destroys: A Restore-Counterfactual Audit of Forgetting in Agent Memory", arXiv:2609.08279 (2026). https://arxiv.org/abs/2609.08279
5. anthropics/claude-code issue #42542, "Silent context degradation — tool results cleared without notification" (2026). https://github.com/anthropics/claude-code/issues/42542
6. "The Hidden Costs of Forgetting: A Study of Trajectory Deletion in Software Engineering Agents", arXiv:2610.35496 (2026). https://arxiv.org/abs/2610.35496
7. "Token Reduction Is Not Cost Reduction: An Empirical Study of End-to-End Efficiency in API-Based Coding Agents", arXiv:2607.12161 (2026). https://arxiv.org/abs/2607.12161
8. "TurnCost: Turns, Not Observations: Cache-Aware Loop Engineering for Coding Agents", PromptOps workshop, ACM (2026). https://dl.acm.org/doi/10.1145/3843779.3844635
9. "ReFold: Training-Free Reversible Inter-Turn Context Folding for Long-Horizon Agents", arXiv:2610.07863 (2026). https://arxiv.org/abs/2610.07863
10. Anthropic, "Context editing", Claude Platform Docs. https://platform.claude.com/docs/en/build-with-claude/context-editing
11. Ichikawa et al., "Addressable Recall Compaction for Long Context-Window Control in AI Agents", arXiv:2607.25066 (2026). https://arxiv.org/abs/2607.25066
12. "Agent-Controlled Forgetting for Tool-Using Agents: Reversible Context Curation in Practice", arXiv:2610.10590 (2026). https://arxiv.org/abs/2610.10590
13. "LCM: Lossless Context Management", arXiv:2605.04050 (2026). https://arxiv.org/abs/2605.04050
14. "Self-GC: Self-Governing Context for Long-Horizon LLM Agents", arXiv:2607.00692 (2026). https://arxiv.org/abs/2607.00692
15. "Context as an Environment: Programmatic Context Management for Long-Horizon Agents" (Scroll), arXiv:2608.21690 (2026). https://arxiv.org/abs/2608.21690
16. L. Martin, "Context Engineering in Manus" (2025-10-15). https://rlancemartin.github.io/2025/10/15/manus/
17. LangChain, "Context Management for Deep Agents" (2026-01-28). https://www.langchain.com/blog/context-management-for-deepagents
18. championswimmer/pi-context-prune. https://github.com/championswimmer/pi-context-prune
19. pi-dynamic-context-pruning. https://pi.dev/packages/pi-dynamic-context-pruning
20. S. Conner, "fold: Lossless Context Folding" (pi-fold). https://shaneconner.com/projects/pi-fold/
21. "StructMemEval", arXiv:2602.11243 (2026). https://arxiv.org/abs/2602.11243
22. agentpatterns.ai, "Addressable Recall Compaction: Compact to Citations, Not Summaries". https://agentpatterns.ai/context-engineering/addressable-recall-compaction/
23. "An Empirical Cost Attribution of Context-Compression Gateways in Multi-Turn Coding Agents", arXiv:2609.22114 (2026). https://arxiv.org/abs/2609.22114
24. "TokenPilot: Cache-Efficient Context Management for LLM Agents", arXiv:2606.17016, EMNLP 2026 Findings. https://arxiv.org/abs/2606.17016
25. "Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks", arXiv:2601.06007 (2026). https://arxiv.org/abs/2601.06007
26. "Governance Decay: How Context Compaction Silently Erases Safety Constraints in Long-Horizon LLM Agents", arXiv:2606.22528 (2026). https://arxiv.org/abs/2606.22528
27. "Beyond Compaction: Structured Context Eviction for Long-Horizon Agents" (CWL), arXiv:2606.11213 (2026). https://arxiv.org/abs/2606.11213
28. "Continuity Evidence Records for Delegated Agent Systems", IETF draft-watts-agent-continuity-evidence-00 (2026-10-20). https://www.ietf.org/archive/id/draft-watts-agent-continuity-evidence-00.html
29. Systima, "The Subagent Tax" (2026-07-22). https://systima.ai/blog/subagent-tax
30. Earendil, "Pi Durable on Cloudflare" (2026-10-16). https://earendil.com/posts/pi-durable-on-cloudflare/
31. Context Mode Engine docs and package `context-mode@2.0.0-next.24` (`pi/index.js`, read 2026-11-01). https://contextmode.ai/docs/engine/how-it-works
