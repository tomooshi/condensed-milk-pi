# Conventions

These rules are a subset of the mojo-template-pi-dev `CONVENTIONS.md` (DOD, NASA Power of Ten,
TigerStyle), cut down to what applies to a small TypeScript pi extension with no dependencies.
This repo has no gate scripts, so review checks every rule. A deviation is written in the file
that contains it, with a reason that a reviewer can check.

## Data and code shape

- Data first: define the input shape, the output shape and the smallest transform before code.
- Pure functions live in `filters/`: no I/O, no clock, no environment reads. Clock, randomness and
  config come in as arguments. `index.ts` is the boundary: it reads files, the clock and pi state.
- Plain types and standalone functions, not classes with state.
- Batch over iterate: `.map`/`.filter` over collections, no push-in-loop accumulators.

## Bounds

- Every loop, scan, collection, cache and output has a named upper bound (`UPPER_SNAKE_CASE`) with
  a provenance tag: `inherited:`, `derived:` (show the arithmetic), `measured:` (cite it) or
  `arbitrary:` (state when to revisit).
- The action at the limit is visible to the caller: an error that names the bound, or a cut output
  that says how to get the rest.

## Functions

- New or changed functions: at most 70 lines, at most 7 parameters (use an options object), and
  cyclomatic complexity of at most 15.
- A non-trivial function asserts at least 2 things. Split compound asserts. Every assert message
  names the invariant. Assert each important invariant in two places (entry and inner helper).
- A function over 15 lines has a header comment: what it does, then what the signature does not show.

## Errors

- Fail loud. No silent `catch {}`. A catch either re-throws with context or handles the error with
  a written reason. The one allowed exception is a failed observation (for example, reading context
  usage), which is recoverable: it gets a comment and a counter.
- Tool errors return `isError: true` with the reason. Never pick a default in place of the real value.

## Prompt cache

- Placeholder and system-prompt bytes must be deterministic: no time, no randomness, no counters.
- Any change to placeholder formats or to `CM_EXPLAINER` is a deliberate cache bust and needs an ADR
  in `docs/adr/`.

## Tests

- Tests load the real sources through `tests/harness.mjs`. No copies of the logic under test.
- Write tests from the spec first, and see them fail before the code exists.
- Stateful logic gets a property test with a printed, replayable seed (`CM_SEED=<n>`).
- Cover the negative space: invalid inputs and the boundary between valid and invalid.
- One expected outcome per check. Validate on real session data (`tests/replay-*.mjs`).
- Run all: `node tests/run.mjs`.

## Commits

- `<type>[(scope)]: <description>`, types `feat|fix|refactor|perf|test|docs|chore`, subject at most
  72 characters, imperative.
- A commit that changes code has a body: what was wrong, why the change fixes it, the measured result.
