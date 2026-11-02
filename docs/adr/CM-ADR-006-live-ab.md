---
adr: CM-ADR-006
status: accepted
date: 2026-11-02
depends_on: CM-ADR-005
---

# CM-ADR-006: Live A/B switch and telemetry schema 4

## Context

Offline replay measures cost and the model's earlier reasoning, but not whether the agent works as well. The
pre-registered live gates of CM-ADR-005 need sessions with and without the new features, assigned at random, and
counts that show quality: turns per prompt, failed edits, re-runs after a recall, tool errors
(docs/research/2026-11-02-next-features.md §6.1, §11.3).

## Decision

1. `"experiment": {"ab": true}` in `~/.config/condensed-milk.json` assigns each session to `control` (every
   1.13.0 feature off, the 1.12.0 behavior) or `treatment` (the configured features). The arm is the parity of
   the first 32 bits of sha256("cm-ab-1:" + session id). It is fixed per session, so a resumed session keeps its
   arm and its bytes. Without the key every session is `default` (features as configured).
2. Telemetry schema 4 (local, opt-in as before) adds: `arm`, `features`, `user_prompts`, `tool_results`,
   `tool_errors`, `edit_not_found` (edit errors that say "Could not find"), `args_masked`.
3. Live gates are read after at least 14 days and at least 30 sessions per arm. Turns per prompt is LLM calls
   (`final_turn_count`) divided by `user_prompts`.

## Consequences

- Control sessions miss the C saving (about $25 a day at the operator's rate) for the length of the experiment.
- The arm is decided from the session id, not from a stored seed: the salt `cm-ab-1` is the seed, logged in this
  ADR; a new experiment changes the salt.
