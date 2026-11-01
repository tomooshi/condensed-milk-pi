---
adr: CM-ADR-002
status: accepted
date: 2026-11-01
depends_on: CM-ADR-001
---

# CM-ADR-002: `cm_recall`, raw text, and two new mask triggers

## Context

CM-ADR-001 gives every masked result a stable id. The agent needs a tool that turns the id back into
the exact output. Two more needs came from the research (`docs/research/2026-11-01-addressable-recall.md`
§9): fleets of bots and task switching want a mask at the end of a task (CWL arXiv:2606.11213,
Agent-Controlled Forgetting arXiv:2610.10590), and an idle session pays a full cache rewrite anyway
when the cache lifetime has passed (Claude Code's time-based microcompact uses this trigger).

Constraints: (1) placeholder bytes stay cache-stable; (2) no new store; (3) every scan is bounded;
(4) secrets are never written to the session file; (5) the agent must know when to recall and when
to re-run. Speed-of-light sketch: "the agent asks for result #id and gets the same bytes back".

## Decision

### 1. `cm_recall` tool

- Parameters: exactly one of `id` (10 hex, `#` optional) or `match` (case-insensitive substring of
  `tool · label`). With `id`: optional `offset` (1-based line) and `limit` select a line window,
  `grep` (a JavaScript regular expression) keeps the matching lines in that window, and `raw`
  returns the text from before a condensed-milk filter ran. Optional `session` (a session id or a
  `.jsonl` path) reads another session.
- Source of truth: the current branch from `ctx.sessionManager.getBranch()`. There is no in-memory
  archive, so recall works after a restart, after compaction and after hibernation.
- Another session: the `.jsonl` file is streamed and parsed by condensed-milk, never written. Session
  files reach 522 MB, more than one JavaScript string can hold, so pass 1 keeps light metadata per line
  and pass 2 reads only the chosen line by its byte offset. pi's
  `SessionManager.open()` migrates old files and rewrites them, so it is not used. The path must be
  inside the pi sessions directory (`$PI_CODING_AGENT_DIR/sessions`, default `~/.pi/agent/sessions`).
  The branch is the parent chain from the last entry in the file.
- Output header: `[cm-recall #<id>] <tool>: <label> — original output as first shown, <N> turns ago,
  not the current state.` `N` counts assistant messages after the result on its branch.
- `match` returns at most `RECALL_MATCH_ROWS_MAX` rows, newest first:
  `#<id> · <N> turns ago · <tool> · <label> · <n> lines, <size>`.
- Errors return `isError: true` with the reason: no or both of id and match, a malformed id, an
  unknown id, an ambiguous id (with the candidates), an invalid `grep`, an `offset` past the end,
  `raw` on a result whose filter hides secrets, a session that cannot be found or is outside the
  sessions directory, and a scan that reaches its bound.

### 2. Raw text in `details`

When a condensed-milk bash filter changes the output, the tool result's `details` gets
`condensedMilk: { raw }` (the ANSI-stripped text before the filter). pi saves `details` in the session
file and does not send it to the model. Filters that hide secrets (`env`, `printenv`) mark their
result `sensitive`; then `details` gets `condensedMilk: { rawWithheld: "secret" }` and no raw text.

### 3. Recall results age

`cm_recall` results are masked at the cutoff like bash results, as `[cm-masked recall #id] …`.

### 4. Task-boundary trigger

Sources: the `pi.events` channel `condensed-milk:boundary`, the `/cm-boundary` command, and
`boundaryCommands` (regular expressions in the rules config, matched against the `cd`-stripped bash
command; empty by default). At the next context event the candidate cutoff is the message count,
minus the tool results after the newest assistant message: the model has not seen those yet, and
masking them would be the immediate deletion that lowered solve rates (arXiv 2610.35496). This
refinement was made during the build; the spec tests' fixtures end with the agent's closing
message, and one check covers unseen results. The boundary applies only when it masks at least
`BOUNDARY_MIN_BYTES` more than the current cutoff. The cutoff never moves back, and protected
reference files are never masked.

### 5. Idle-aligned advance

At a context event, if the time since the last cache touch (the newest of the last assistant message
and the last `cache_warm` usage entry on the branch) is longer than the cache lifetime, the cutoff
advances by one zone (to that zone's coverage), with the same `BOUNDARY_MIN_BYTES` floor. The
lifetime is `cacheTtlSeconds` from `~/.config/condensed-milk.json`, else the model's `promptCache`
for the active tier (`PI_CACHE_RETENTION=long` → `long`, else `short`). An unknown lifetime turns
the trigger off. At the last zone the trigger does nothing.

### 6. Bounds

| Bound | Value | Provenance |
|---|---|---|
| `RECALL_OUTPUT_BYTES_MAX` | 51,200 | inherited: pi `DEFAULT_MAX_BYTES` |
| `RECALL_OUTPUT_BYTES_MIN` | 4,096 | arbitrary: one screen of output still fits a tiny window; revisit with the recall telemetry |
| `RECALL_OUTPUT_LINES_MAX` | 2,000 | inherited: pi `DEFAULT_MAX_LINES` |
| recall cap per call | min(51,200, 5% of the effective window × 4 bytes per token) | arbitrary: revisit if agents often recall twice |
| `RECALL_SCAN_ENTRIES_MAX` | 65,536 | measured: longest branch 26,241 entries in 30 days |
| `RECALL_MATCH_ROWS_MAX` | 10 | arbitrary: revisit if `match` is often followed by another `match` |
| `RAW_KEEP_BYTES_MAX` | 51,200 | inherited: pi bash truncation caps the text first |
| `SESSION_FILE_LINES_MAX` | 262,144 | measured: the 3 largest session files (456-522 MB) have at most 28,128 lines; about 9x headroom |
| `BOUNDARY_MIN_BYTES` | 32,768 | arbitrary: revisit with the boundary telemetry |
| `IDLE_SCAN_ENTRIES_MAX` | 512 | arbitrary: entries walked back from the leaf to find the last cache touch |
| `SESSION_LOOKUP_FILES_MAX` | 65,536 | arbitrary: file names listed while looking up a session id; revisit if a sessions dir holds more |
| `LABEL_KEY_CHARS_MAX` | 512 | arbitrary: characters of a call label kept per entry, so long codemode or MCP arguments do not hold megabytes per scan |
| `RECALL_RERUN_TRACKED_MAX` | 256 | arbitrary: recalls remembered for `recall_then_rerun`; revisit with the telemetry |

At-limit actions: a cut output ends with a footer that names the next `offset` (a first line longer
than the cap is cut inside the line, and the footer says so). A scan that hits a bound returns an
error that names it. Raw text over `RAW_KEEP_BYTES_MAX` is not kept, and `raw` then returns an
error that says why.

### 7. Telemetry (opt-in, local, as today)

Schema 2 adds recall counts by mode, errors, bytes returned, turns from result to recall, recalls
followed by a re-run of the same command or path, and boundary and idle events (applied and skipped).

## Consequences

- One recall costs one turn. Turn count drives cost (TurnCost, ACM PromptOps 2026), so the explainer
  says to recall only when the next step needs the content.
- Thresholds and coverage do not change in this release (ADR-020: one variable at a time).
- A boundary or idle advance costs one cache rewrite, the same as a zone advance. The idle advance
  costs nothing extra when the cache has already expired.
- Hosts whose sessions are not local `.jsonl` files can recall in the current session only.
