---
adr: CM-ADR-007
status: accepted
date: 2026-11-07
depends_on: CM-ADR-005
---

# CM-ADR-007: Placeholder guard

## Context

1.13.0 (CM-ADR-005) masks long arguments of the model's own earlier tool calls. In the first 5 days of live use
(docs/research/2026-11-02-next-features.md §13), the model three times wrote a placeholder with an invented id into a
new call: a bash command (failed, "command not found"), an edit `oldText` (failed, "could not find") and a `write`
`content`, which succeeded and replaced a 13.1 KB document with the 61-byte placeholder. None of the 87,546 tool calls
in the 40 days before showed this; result placeholders, which sit in tool results and not in the model's own turns,
were never copied. The pre-registered live gates of CM-ADR-005 (failed edits, turns per prompt, tool errors) passed
and did not cover a write that succeeds with a placeholder.

## Decision

1. A `tool_call` handler blocks any call, except `cm_recall`, whose string argument is a whole-value placeholder:
   one line that matches the built-in shape `[cm-masked bash|read|recall|arg( #id)] …` or a configured template
   (custom templates need 6 or more fixed characters). The agent gets the reason as an error result:
   "condensed-milk blocked this call: argument `<key>` is a condensed-milk placeholder, not real content. …"
2. A value that only contains a placeholder among other text (documentation, a grep pattern) is allowed.
3. Telemetry schema 5 counts `placeholder_calls_blocked`; `/compress-stats` shows it.
4. Rule fixed now: if blocked calls exceed 1 per 1,000 LLM calls in sessions that masked arguments, `maskArgs`
   becomes off by default in the next release.
5. `session_id_hash` now hashes the current session file (`sessionManager.getSessionFile()`); it read
   `previousSessionFile`, which pi sets only on a switch, so it was null.

## Verification

| Check | Result |
|---|---|
| Spec tests (written first, red) | `tests/placeholder-guard.test.mjs` 21 checks, property over rendered placeholders and random text; telemetry checks in `tests/extension-1-13.test.mjs` |
| Real pi 1.5 process, write through pi's tool pipeline | placeholder write blocked (`isError`, reason shown, file not created); a normal write in the same call succeeds |
| All tool calls of 40 days of sessions | 87,546 calls: blocks exactly the 3 fabrications, 0 others |
| Test suite | 21/21 under pi 1.5 and under pi 1.0.4 |

## Consequences

- A fabricated placeholder costs one extra turn instead of a lost file.
- The guard runs on every tool call: a walk of at most 512 string leaves, 8 levels deep.
