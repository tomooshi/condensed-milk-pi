---
adr: CM-ADR-003
status: accepted
date: 2026-11-01
depends_on: none
---

# CM-ADR-003: A filter never hides a failure; `disabledFilters`

## Context

GitHub issue #4 reported that the test-runner filter drops failure details and has no opt-out. The
check before the 1.11 publish found a worse fault: the filter reported failing runs as passing.
With realistic output (3 failed, 39 passed) it returned `Test Results: 1 passed` for jest and
vitest (it read the test-FILE line) and `39 passed` for mocha, cargo test and bun test (it missed
"failed" in their order and separators), and dropped every failure. On 2,758 real test-runner
outputs from 90 days of the operator's sessions, the old filter would summarize 815; 338 of those
hide a failure or a nonzero exit.

An agent that reads "39 passed" after a failing run can report success. The cost of not
compressing one output is a few kilobytes; the cost of hiding a failure is a wrong conclusion.

## Decision

1. **Fail-safe rule.** The test-runner filter summarizes only a fully passing run. It returns the
   output unchanged when: the command exited nonzero (`isError`, now passed to every filter as
   `FilterMeta`); any failure sign appears (`FAIL`, `●`, `✕`/`×`, `(fail)`, `not ok`, `✖`, a
   positive failed/failing count in any order, `test result: FAILED`, `panicked at`, a rustc
   `error:`); or the counts cannot be read.
2. **Counts from the runner's own test summary** (jest `Tests:`, vitest `Tests`, cargo
   `test result:` summed over crates, mocha `passing`/`failing`/`pending`, bun `pass`/`fail`/`skip`,
   go `ok` package lines only under `go test`). File-count lines are never used, and the old
   fallback that counted lines containing "ok" is removed: no guessing.
3. **`disabledFilters`** in the rules config (global and project-local, merged): registered filter
   names to skip, a command prefix (`"yarn test"`) or `"*json"` for the JSON content fallback.
   Unknown names are listed in `/compress-stats`. Disabling `env`/`printenv` lets secrets reach
   the model; that is the user's choice and the README says so.

## Consequences

- Real data: the new filter summarizes 416 passing runs (435 KB saved) and hides 0 failures. A
  failing run now costs its full output, which is what the agent needs next.
- A false failure sign (a passing test named "3 failed retries") only skips compression.
- Other filters were checked for the same fault: pytest keeps its failure section, the build
  filter keeps compiler errors, and `npm run build` with tsc errors passes through. They are
  unchanged.
- Released as 1.11.1. The `v1.11.0` tag and GitHub release stay as published; npm goes from
  1.9.0 to 1.11.1.
