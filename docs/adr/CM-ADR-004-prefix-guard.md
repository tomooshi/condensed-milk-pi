---
adr: CM-ADR-004
status: accepted
date: 2026-11-02
depends_on: none
---

# CM-ADR-004: Prefix guard (observe and attribute every prefix change)

## Context

On Claude 5.x a change before a thinking block invalidates that block for good, so the model loses its earlier
reasoning, and any change rewrites the prompt cache from that point (Anthropic, preserved-thinking docs). The
research round (docs/research/2026-11-02-next-features.md §8) found such changes in three places that nobody saw
at the time: old enforcement extensions deleting earlier context messages, `pi-claude-code-use` adding and removing
tool aliases during a run, and condensed-milk's own masks. Session files record none of them.

## Decision

1. condensed-milk handles `before_provider_request`, compares the request with the previous one in the provider's
   cache order (tools, then system, then messages, ignoring `cache_control`), and records the first change: its kind,
   position, cause (`added <tool>`, `condensed-milk mask`, `user removed`, ...) and the thinking blocks after it.
2. It always returns nothing, so the request is never changed. A failure to observe is counted and reported once;
   the request still goes out (CONVENTIONS loop-bounded-observation).
3. `message_end` joins the change with the response: the cache write and the thinking blocks that Anthropic reports
   as newly dropped.
4. `/compress-stats` shows the counts and the last change. Telemetry schema 3 adds them. `CM_PREFIX_GUARD_LOG=<file>`
   writes one JSON line per change, for probes.

Not done: blocking or repairing changes. The guard reports; the owners of the change fix it.

## Verification (gates fixed in §6.1 before the build)

| Gate | Result |
|---|---|
| Request bytes identical with and without the guard (1,000 seeded payloads) | Pass: nothing returned, payload unchanged in 1,000 of 1,000 |
| Names the right first change in 3 of 3 runs per injected edit (late alias, client mask, deleted message), against payloads captured independently | Pass: 9 of 9 |
| 0 false alarms in 3 clean runs | Pass: 0 |
| p99 overhead < 5 ms at a 1M-token request | Pass at steady state: p99 2.1-2.6 ms in 5 of 5 runs (`node --expose-gc bench/guard-overhead.mjs`); the first comparisons before V8 optimizes the function can take up to about 6 ms |
| Masking unchanged (replay of 38 sessions, 1.11.1 against 1.12.0) | Every cost and thinking difference exactly 0 |

## Consequences

- Extensions that load after condensed-milk can still change the request after the guard has seen it; the response's
  drop report catches their effect on thinking.
- "Thinking blocks at risk" sums the blocks after each change; a block can be counted again by a later change, so it
  is an upper bound. "Dropped by Anthropic after an edit" is the measured count.
