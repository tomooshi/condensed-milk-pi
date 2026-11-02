---
adr: CM-ADR-005
status: accepted
date: 2026-11-02
depends_on: CM-ADR-001, CM-ADR-002, CM-ADR-004
---

# CM-ADR-005: Edits that wait for mask events (masked arguments, batched invalidation)

## Context

After 1.11, the largest re-read that condensed-milk never touched was the arguments of old tool calls: an edit or
write call carries the whole text it changes, and a heredoc bash call the whole script. Past the cutoff they were
1.17B tokens a month for edit/write and 0.49B for long bash commands (docs/research/2026-11-02-next-features.md §2.4).
On Claude 5.x any change of an earlier message, a tool-call input included, invalidates the thinking blocks after
it and rewrites the cache from there [D1], so such edits may only happen when condensed-milk already rewrites:
at a mask event (zone, idle, boundary).

Default rules also mask an invalidated `git status` at once, mid-run, which edits the prefix outside a mask event.

## Decision

1. **C, masked arguments (`features.maskArgs`, on).** In an assistant message before the cutoff, each string
   argument of an edit or write call of 240 characters or more, and a bash command of 2,048 characters or more,
   becomes `[cm-masked arg #<id>] <tool> <key path> (<n> lines, <size>)`. `path` and short values stay, so the
   call still reads as a call. Reference paths are never masked. The id is sha1(tool-call id + "\0args\0" +
   assistant timestamp)[0..10], so it differs from the result's id. `cm_recall` returns the arguments as
   sections `--- <key> (<n> lines) ---` with the raw text, so every value comes back byte-identical and grep and
   offset/limit work per line.
2. **B1, batched invalidation (`features.batchInvalidation`, on).** Bash invalidation (ADR-024) counts only
   invalidating commands before the event horizon, the message count at the last mask event.
3. **Explainer.** It names masked arguments and says: "Never copy a placeholder into a new tool call." This and
   the new placeholder kind are a deliberate, one-time cache bust.

Each flag can be turned off in `~/.config/condensed-milk.json` (`"features": {"maskArgs": false}`).

## Verification (gates fixed in §6.1 and §11 before the build)

| Gate | Result |
|---|---|
| C: re-read tokens down >= 0.8B per 30 days, CI excludes 0 | Pass: -2,929M [-5,438, -1,111] (38 sessions, 51,472 calls) |
| C: extra cache writes <= +5% | Pass: -6.9% (-37.9M [-72.1, -11.0]) |
| C: recall returns the arguments byte-identical in 100% | Pass: 8,314 masked calls in 40 real sessions, 0 failures (`node tests/replay-recall.mjs`) |
| C: accepted by Anthropic OAuth, OpenRouter, vLLM (3 of 3) | Pass: 3 of 3 (`bench/probe/features.sh`; Opus 5.5 via pi-claude-code-use, openai/gpt-4.1-mini via OpenRouter, Qwen2.5-1.5B-Instruct on a local vLLM CPU server) |
| B1: invalidation-caused rewrites down >= 50% (default rules; arm minus a no-invalidation control) | Pass: 1.12.0 163, B1 -8, so all of them |
| B1: thinking drops after an invalidation not above base (CI) | Pass: -594 [-1,151, -167] |
| B1: 0 drops at the invalidation point in 3 of 3 probe runs | Pass: 3 of 3 with 0; the 1.12.0 control run dropped 1 |

Measured side effect of C, not gated: thinking blocks invalidated by edits +865 [347, 1,525] (+4.1%), because a mask
event that masked no new result before now also masks arguments, and earlier positions change. Cost -$767
[-1,364, -304] per 30 days at Opus 5.5 cache prices.

## Not adopted (failed their pre-registered gates, removed before the release)

- **D, collapse superseded and duplicate results.** Re-read down -211M [-419, -45], below the 250M gate; cache
  writes +1.1%, cost -$12 [-32, +1]. Most superseded reads are already masked by the cutoff. Code in db5746e.
- **R, keep the cutoff across a pi restart.** Thinking blocks invalidated -7,462
  [-13,689, -2,837], but cost +$1,119 [348, 2,075] (+17%) against a 1% gate: the re-mask after a restart is a
  large saving. A choice between reasoning and cost; recorded in docs §12. Code in db5746e.

## Live gates (after release)

Turns per prompt <= +5%, edit "could not find" rate <= +0.2 points, recall then re-run <= +0.2 per 100 calls, tool
error rate <= +0.5 points: read from schema-4 telemetry of the live A/B (CM-ADR-006) after at least 14 days and 30
sessions per arm. A failed live gate turns the feature off by default in the next release.
