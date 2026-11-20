# Field data: the first shared export and the maintainer's log (2026-11-18)

Sources:

- **Export A**: issue #5, comment 6980963192. 4,621 rows, 2026-11-02 to 2026-11-18, versions 1.11.1, 1.13.0, 1.13.1.
  pi inside T3 Code on a Linux VPS, default profile, Claude Sonnet 5.5 and Opus 5.5, GPT-6.1. 1,223 rows have turns.
- **Log B**: the maintainer's `~/.config/condensed-milk-sessions.jsonl`. 3,940 rows, 2026-11-01 to 2026-11-18,
  versions 1.11.0 to 1.13.1. 3,934 rows have turns; the median is 3 turns (headless runs with `--no-session`).

All numbers below come from rows with `final_turn_count > 0`. Decisions: CM-ADR-008.

## 1. Headline numbers

| | Export A | Log B |
|---|---|---|
| Rows with turns | 1,223 | 3,934 |
| Turns: median / p90 / max | 30 / 120 / 775 | 3 / 7 / 2,506 |
| Sessions with a mask | 645 (53%) | 27 (1%) |
| Unique masked bash / read | 35,487 / 5,072 | 3,199 / 271 |
| Recalls / errors | 279 / 12 | 19 / 1 |
| Sessions that recalled, of sessions that masked | 17% | 37% |
| Re-run after a recall | 18 (6.5%) | 2 (10.5%) |
| Re-reads by read / by bash | 594 / 18 | 81 / 5 |
| Masked reads read again | 11.7% | 29.9% |
| Turns from mask to re-read, median | 7 | 32 |
| Zone entries by pressure / by idle | 596 / 360 | 46 / 37 |
| Idle advances / skipped (32 KB floor) | 360 / 302 | 37 / 1 |
| Failed edits ("could not find") 1.13.0 → 1.13.1 | 5.6% → 1.3% | 2.7% → 1.4% |
| Placeholder calls blocked (1.13.1) | 14 in 11 sessions | 1 |
| Message edits that are not masks | 5 | 547 |
| System prompt edits | 404 (one in each of 404 sessions) | 7 |

Log B has 27 masked sessions. That is too few to set defaults; Export A is the better base.

## 2. What the numbers say

1. **Masking pays.** `bytes_freed` adds the bytes saved in each request. Export A: 6.74 GB, about 1.7 billion tokens (4 bytes per token)
   that were not read from cache, worth about 170M input tokens at the cache-read price. The cost: 235 mask edits on a
   warm cache. In the 36 sessions whose only prefix edit was one mask, the response after it wrote 182k tokens on
   average, so about 43M tokens at 1.15 times the input price (write minus the read it replaces), about 49M. Ratio:
   about 3. Log B: 52M against 6M, about 9. The byte count is low after a compaction (§3), so both ratios are lower
   bounds; the 182k figure is from 36 sessions.
2. **The idle trigger works as designed.** 365 of 443 resumed sessions in Export A entered zone 0 by turn 2, when the
   cache was dead and the mask cost nothing.
3. **The 32 KB floor skips 46% of idle chances** in Export A (302 of 662). 49 sessions only skipped; their median is
   8 turns. The floor stops a mask that would free little. No change.
4. **Failed edits fell after 1.13.1** in both data sets. The workload changed between the versions (962 edits in
   18,455 turns, then 473 in 44,186), so this is a sign and not proof.
5. **The CM-ADR-007 rule keeps `maskArgs` on**: 0.63 and 0.23 blocked calls per 1,000 LLM calls, limit 1.
6. **Recall is used and mostly enough**, but in 17% of the sessions that masked. The export's author found about 9
   sessions where the agent said it could not see a masked result and worked from memory. Decision 5 of CM-ADR-008.
7. **One system prompt edit per session** in 404 sessions of Export A: 237 after a resume, 138 after a startup. In
   the 212 sessions with no other edit, the next response wrote 280k tokens on average. That is more than half of the
   export's `cache_write_after_edit` (202M). condensed-milk's explainer is constant, so the cause is another
   extension, the host, or a side request (§4). Schema 6 records the turn and the position of each system edit.

## 3. Telemetry faults (fixed in schema 6)

| Fault | Evidence |
|---|---|
| Rows for sessions with no turns | 3,398 of 4,621 rows in A, median 125 ms |
| `session_id_hash` null | 3,117 rows in A, 3,926 in B, all `startup`: pi has no session file with `--no-session` |
| Mask and re-read counters reset by a compaction | `resetPositionState()` set them to 0; A has 8 resets in 4 sessions, B has 16 in 8 |
| Token totals summed the messages in context | 5 rows in B have `cache_write_after_edit` larger than `total_cache_write`; a resumed session counted its history again in each row |
| `thinking_dropped_after_edit` too large | Larger than `thinking_at_risk` in 37 rows of A and 8 of B; one B row has 3,409 drops and 0 at risk |
| `final_ctx_pct` always null | Every row |

The drop fault, from a session file: Anthropic repeats the full drop list on every response. A response with no list
(83 → 0 → 83 paths) emptied the "previous response" set, and the next edit counted all 83 again.

## 4. The per-prompt message edit was a side request

Log B has 547 message edits that are not masks; their count follows `user_prompts` with a correlation of 0.997
(about 0.66 per prompt, about 40k cache-write tokens after each).

- By `cwd_hash`, 529 of the 547 are in one project, and most of the rest in projects with the same local extensions.
- That project's `watcher` extension asks the model a side question at the end of a run. It sends the main request
  plus the question through pi's hook chain (`before_provider_request`), so the guard sees it. Its log has 733 checks
  in the period.
- The next main request ends with the operator's prompt where the fork had the question. The 1.12.0 guard compared
  only with the newest request and reported "user edited" at the last message (gap 0, 0 thinking blocks at risk,
  which matches the rows).
- A probe of the global setup without that project (pi RPC mode, 4 prompts, 8 requests, guard core from this
  repository) saw 0 edits.

The fork does not change the main request's cache entry, so this was a false positive. The guard now compares with
the newest 4 requests (CM-ADR-008 §4). The 25M `cache_write_after_edit` tokens of Log B are mostly the normal write
of a new prompt, not a loss.

## 5. Study: protection for recently used reads

Question: Export A shows a median of 7 turns from mask to re-read. Would a rule that keeps recently used reads
unmasked avoid re-reads at an acceptable cost?

### 5.1 Method

`bench/replay-cost.mjs run --reads-out` replays sessions through the real extension and records, for its first arm,
every successful read, edit and write with its path and time, the call at which each result is first masked, and the
mask events. For each read of a path that was read before, it records the state of the newest earlier read in the
request that asked for the new one: masked, visible or gone (compacted). `bench/reread-study.mjs` reads that trace.

Rule "recency K": at a mask event a read result stays unmasked when its path was touched in the last K calls; it is
masked at the first later mask event where that is no longer true. Benefit: the tokens of each avoided re-read
(written once, then read on each call it stays in the request). Cost: the kept results, read from cache on each call
they stay. Prices: write 1.25, read 0.1 of the input price; 2.43 characters per token (the harness value).

Data: the maintainer's 41 session files of the last 17 days (at most 600 MB each), 19,389 calls, source at this
commit. Export A's sessions are not available; its author can run the same two commands (the report has numbers only).

### 5.2 Result

| | |
|---|---|
| Reads | 1,549 |
| Reads of a path read before | 839: earlier read visible 679, compacted away 126, **masked 34** |
| Read results that were masked | 733; read again while masked: 34 (4.6%) |
| The 34: file edited between | 10 |
| The 34: not edited, same bytes returned | 4 |
| The 34: not edited, other bytes (another range, or changed outside the tools) | 20 |
| Calls from mask to re-read: p25 / p50 / p75 | 24 / 65 / 151 |
| Calls from the last touch of the path to its mask, the 34: p25 / p50 / p75 | 61 / 81 / 94 |
| The same for all 733 masked results | 38 / 75 / 113 |

| K | Results kept | Re-read rate, touched within K calls | Re-read rate, older | Re-reads avoided | Benefit (tokens) | Cost (tokens) | Benefit / cost |
|---|---|---|---|---|---|---|---|
| 3 | 12 | 0% | 4.7% | 0 | 0 | 284k | 0 |
| 5 | 27 | 0% | 4.8% | 0 | 0 | 605k | 0 |
| 10 | 44 | 6.8% | 4.5% | 1 | 50k | 958k | 0.05 |
| 20 | 114 | 5.3% | 4.5% | 3 | 524k | 2.4M | 0.22 |
| 40 | 190 | 3.7% | 5.0% | 4 | 1.26M | 6.6M | 0.19 |

- Recency does not predict a re-read: the rate is 4.5% to 5% on both sides of every K.
- 30 of the 34 re-reads wanted bytes that the earlier result did not have (the file was edited, or another range).
  For those, a re-read is the correct action and no protection would avoid it.
- The rule costs 5 to 20 times what it saves. The estimate leaves out a cost that makes it worse: a kept result is a
  hole before the cutoff, and the mask event that closes it rewrites the cache from the hole.
- The live counter (`re_reads_by_read / unique_masks_reads`, 29.9% in Log B) is higher than 4.6% because it counts
  paths and not results, counts a read after a compaction, and includes the 728 MB session that the replay left out.

**Decision: no protection for recently used reads.** The built-in reference list and `referenceBasenames` stay the
way to keep a file.

### 5.3 Gate for any later candidate (fixed now)

A rule that keeps some read results unmasked ships only if all of these hold on at least 30 sessions of at least two
operators, with `bench/replay-cost.mjs` and a real candidate arm (so the hole rewrite is measured):

1. Cache cost of the candidate arm is not higher than the base arm: the paired bootstrap 95% interval of the
   difference is at or below 0.
2. Re-reads of a masked read whose bytes are identical fall by at least 50%.
3. Thinking blocks invalidated by condensed-milk's own edits do not rise by more than 2%.
4. Determinism: two runs are byte-identical.

### 5.4 Limits

- One operator, 27 sessions with masks, 34 events. Export A's shorter hold time (7 turns) may be another workload.
- First-order estimate: the other calls of a session stay as recorded.
- "Other bytes" does not separate another range from a file changed outside the tools.

## 6. Web check of the open points (2026-11-18)

1. **System prompt edit per session: found, and it was ours.** llblab/pi-telegram#353 and pingdotgg/t3code#18933
   describe the fault: a `before_agent_start` handler that returns `systemPrompt` forces the prompt, and pi folds
   every later prompt or tool change into the request head. condensed-milk did the same. Reproduced and fixed
   (CM-ADR-008 §8): cache read 0 → 19,471 tokens on the prompt after a tool became active.
2. **Re-reads.** "Context Has a Price" (arXiv 2611.22238, more than 20,000 runs) agrees with §5: only 12% of
   observation tokens are provably stale, re-reads are mostly checks of the agent's own edits, and a keep-the-latest
   rule that masks on every turn costs 38% to 116% more at a tenth-price cache. Batched masking, which
   condensed-milk's zones are, is the variant that does not lose. No change.
   (Corrected in §8: that holds only with the agent's actions held fixed.)
3. **Candidate: a break-even check before a warm mask.** The same paper masks only when `R·c·B > (1−c)·S`
   (R remaining requests, B tokens removed, S tokens after the change point, c the cache price ratio). It cost 46%
   to 52% less than rolling masking. condensed-milk measures B and S already; R needs an estimate. The 32 KB idle
   floor is a fixed form of this test. Not built: it needs the replay gate of §5.3, items 1, 3 and 4.
4. **Agents that work from memory.** Claude Code's `[Old tool result content cleared]` has the same report
   (anthropics/claude-code#42542: "the agent will paraphrase from memory"). Anthropic's context editing pairs
   clearing with a warning before content is cleared. The paper found that a deterministic digest in place of a
   placeholder cost 17.7% less than a bare placeholder. A digest is a candidate for a later release; the placeholder
   text of CM-ADR-008 §5 is the small step.

## 7. Two candidates: gates fixed before the build (2026-11-18)

Both candidates are feature flags (`features.breakEven`, `features.digest`). A flag is on by default only if every
gate of its candidate passes. A failed gate leaves the flag off and the code in place for a later test. (Written
before the runs. §7.3 has the results and one deviation from this sentence.)

### 7.1 Break-even check (`breakEven`)

Rule: on a warm cache, a pressure zone or a task boundary masks only when `R × B > K × S`.

- `B`: characters the mask removes. `S`: characters of the request from the first changed message to the end.
- `K = (cache write price − cache read price) / cache read price`, from the model's prices (24 for Claude Opus 5.5,
  11.5 for Claude Sonnet 5.5; 11.5 when the prices are unknown).
- `R`: estimate of the model calls still to come: 7 when the run has fewer than 5 calls, else the larger of 24 and
  half the calls so far. Fitted on the medians of the 596 pressure entries of Export A (remaining calls after the
  entry: 7 below turn 5, about 24 from turn 5 to 50, about half the turn number above 100).
- A zone that does not pay is not entered; the next call tests it again. The last zone is always entered, so the
  context cannot fill up because of the rule. A cold cache or an unknown cache lifetime skips the test (the rewrite
  costs nothing extra). The idle trigger is not changed.

Gates, on the 41-session list of §5 (`bench/replay-cost.mjs`, base arm = same source with both flags off):

1. Cache cost: the paired bootstrap 95% interval of candidate minus base is at or below 0.
2. Thinking blocks invalidated by condensed-milk's own edits: not more than 2% above base.
3. Largest prompt of each session (modeled tokens): not more than 5% above base in any session.
4. Determinism: two runs are byte-identical.
5. Overhead: the `context` handler with the test active, 8,000 messages: p99 below 20 ms.

### 7.2 Digest (`digest`)

Rule: a bash or read placeholder ends with a digest of at most 160 characters, made by fixed code from the masked
text. Bash: the first and the last line that state an outcome (counts of passed or failed, an error), else the last
line. Read: the names the file defines at column 0, or the headings of a Markdown file; nothing when it finds none.

A replay holds the agent's actions fixed, so it can measure only what the digest costs. The benefit is a change of
behavior (fewer recalls, re-runs and guesses). The source paper found the same split (arXiv 2611.22238, Appendix H).

Gates:

1. Replay cost: candidate minus base is at most 1% of the base cache cost (upper end of the 95% interval).
2. Form: property test over random text: one line, at most 160 characters, the same output for the same input.
3. Determinism: two replay runs are byte-identical.
4. Live probe (real API, Claude Haiku 5.5, 6 runs for each arm): a command prints 300 lines that end with a test
   summary naming two failed tests; later its result is masked; the agent is asked which tests failed. Pass: the
   digest arm answers correctly in every run, and its mean number of tool calls after the question is not higher
   than the arm without a digest.

Not a gate, to watch in schema-6 exports after release: `recall_then_rerun`, re-reads per masked read, and
turns per prompt, with the A/B switch of CM-ADR-006 for an operator who wants a controlled comparison.

### 7.3 Results (2026-11-18)

Replay: 41 sessions, 19,389 calls, base cache cost $1,872. The base arm's series is byte-identical to the run made
before either candidate existed, so the code with both flags off behaves as before.

The harness's own validity gate did not pass on this list: modeled cache reads are 16.2% below the recorded ones
on the 19 held-out sessions (limit 10%; median per session 4.0%, Spearman 0.988). The list is dominated by one
session of 7,231 calls. The arm comparisons below share that bias, so read the signs and sizes, not the dollars.

**Break-even: failed, removed.**

| Gate | Result | Verdict |
|---|---|---|
| 1. Cache cost at or below base | +$190.80 (+10.2%), interval [+43.86, +426.40]; dearer in 12 sessions, cheaper in 1 | Fail |
| 2. Thinking invalidated by own edits | −140 of 9,397 (−1.5%) | Pass |
| 3. Largest prompt, any session, at most +5% | +67.1% in one session, above +5% in 8 | Fail |
| 4. Determinism | not run (gate 1 failed) | — |
| 5. Handler p99 below 20 ms | p50 36 ms, p99 71 ms | Fail |

Why: the rule compares "mask now" with "never mask". In condensed-milk the other choice is "mask later": the last
zone is always entered, and by then the request is larger, so the rewrite costs more and every call before it read
more. A deferral pays only when the session ends before the next zone, and these sessions are long (median 230
calls after a pressure entry, against 24 in Export A). The rule may do better on short sessions; that needs the
other operator's sessions. Following the rule of `filters/features.ts` (a feature that fails its gates does not
ship), the code is removed. This differs from the sentence at the top of §7, which kept failed code in place: a
flag that makes 12 of 41 sessions dearer is a trap for an operator who turns it on.

**Digest: opt-in, off by default.**

| Gate | First version (160 chars, first + last outcome line, last-line fallback) | Second version (120 chars, last outcome line, no fallback) |
|---|---|---|
| 1. Replay cost at most +1% (upper end of the interval) | +2.9%, interval up to +5.9%: fail | +1.13% ($21.16), interval [+0.3%, +2.4%]: **fail** |
| 2. Form (property test, 1,500 texts) | Pass | Pass |
| 3. Determinism | — | Pass (two runs byte-identical) |
| 4. Live probe, 6 runs for each arm | Pass: 6 of 6 correct, 0 tool calls against 1.33 | Pass: 6 of 6 correct, 0 tool calls against 1.0 |

The first version spent 65% of its characters on last-line fallbacks (14,008 of 18,077 bash results had no outcome
line), so the second version dropped them. The limits did not change between the versions. The second version was
tuned on the same 41 sessions that tested it, which favors it; it still fails gate 1.

In the probe the arm without a digest also answered correctly every time: it called `cm_recall` once (the new
placeholder text of CM-ADR-008 §5 at work). So the digest's measured benefit is one saved tool call when the agent
needs a fact that the digest holds. On these sessions that does not pay for itself: 1.1% of the cache cost is
about the price of 350 saved calls, and the telemetry of the same period shows about 100 recalls and re-reads.
A workload with more recalls for each mask may differ, so the feature stays as `features.digest`, default off.

## 8. Second web check (2026-11-18, after the gates)

Sources were fetched and read; numbers are quoted from the pages. None of them measures condensed-milk.

| Our result | Outside evidence | Verdict |
|---|---|---|
| Break-even test made the replay dearer | arXiv 2611.22238, Table: break-even masking against no masking at a tenth-price cache costs +2.8% / +1.8% (two models), +9.6% (SWE-agent), +14% (Gemma-4), −13% (GLM-4.7-Flash). The rule halves the premium of per-turn masking; it does not beat doing nothing | Agrees |
| Zones (threshold, batched) over per-step masking | arXiv 2609.32961 (65 policies, 3 models): tool-result clearing at a threshold bills 0.71x of full context, the same clearing on every step 0.95x, with similar success. arXiv 2606.17016 (TokenPilot) evicts in batches for the same reason | Agrees |
| 32 KB floor on a warm mask | Anthropic context editing has `clear_at_least` for this purpose ("clear enough tokens to make the cache invalidation worthwhile") | Agrees |
| Idle advance on a cold cache | Claude Code's time-based microcompact clears old tool results after an idle gap longer than the cache lifetime (third-party analyses of the client, not an Anthropic statement) | Agrees |
| Forced system prompt breaks the cache | arXiv 2610.34817: 97 of 120 prompt-cache defects in 10 agent projects corrupt the outgoing request | Same defect class |
| Read protection does not pay | One practitioner report (claudelab.net) saw duplicate calls fall from 0.28 to 0.05 when `keep` went from 3 to 6. That is clearing 3 calls behind the head; a zone masks much older results | Does not conflict |
| Digest: saves a call, costs tokens | Pointer plus preview is common practice (Haystack: first 200 characters; LangChain Deep Agents; B4.run). No source measures its cost under caching. arXiv 2607.12161 (2,908 billed Claude Code runs): tokens removed do not predict the bill (r = 0.15); 87% of cost is cache traffic | Cost not verified outside |

**Correction to §2 item 1 and §6 item 1.** "Masking pays by a factor of about 3" and "batched masking does not lose"
are fixed-action estimates. arXiv 2611.22238 reports that with fixed actions batched and break-even masking save
3–22% at a tenth-price cache, and that with a reacting agent no tested combination was cheaper than no masking,
because the agent runs longer. Our replay and `bytes_freed` are fixed-action too. What masking surely buys is
context room (later compaction, no overflow); a dollar saving on a warm, tenth-price cache is not shown.

Usable ideas, not built:

1. **Reduce at ingestion, not afterwards** (TokenPilot; LangChain offloads results over 20,000 tokens with a
   preview). Text removed before the first cache write costs no rewrite. condensed-milk's fresh-output filters
   already work there; an offload of oversized results with a recall id would extend them.
2. **Duplicate-call rate around a mask event** as a telemetry field (same tool and arguments before and after),
   the measure the practitioner report used. It needs no text.
3. **A live A/B of masking against no masking** with CM-ADR-006's switch, on cost per session, to replace the
   fixed-action estimate.
4. Claude Code is reported to delete tool results from the server cache without a rewrite (`cache_edits`). This
   is not in the public API documentation; the public `clear_tool_uses` edit does bill a cache write.

## 9. Reproduce

```bash
node bench/replay-cost.mjs list --days 17 --max-mb 600 --out /tmp/cm-bench/list.tsv
node --max-old-space-size=16000 bench/replay-cost.mjs run --list /tmp/cm-bench/list.tsv --arm base=. \
  --out /tmp/cm-bench/run.json --reads-out /tmp/cm-bench/reads.jsonl     # reads.jsonl holds file paths: keep it local
node bench/reread-study.mjs /tmp/cm-bench/reads.jsonl                    # numbers only

# §7: digest arm against base (config dirs hold condensed-milk.json with features.digest false / true)
node --max-old-space-size=16000 bench/replay-cost.mjs run --list /tmp/cm-bench/list.tsv \
  --arm base=.:/tmp/cm-bench/cfg-base --arm dg=.:/tmp/cm-bench/cfg-dg --out /tmp/cm-bench/g2.json
node bench/analyze.mjs /tmp/cm-bench/g2.json
bench/probe/digest.sh /tmp/cm-probe 6                                    # real API, about 30k tokens per run
```
