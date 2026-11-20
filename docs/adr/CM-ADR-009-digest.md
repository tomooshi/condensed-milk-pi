---
adr: CM-ADR-009
status: proposed
date: 2026-11-18
depends_on: CM-ADR-001, CM-ADR-006, CM-ADR-008
---

# CM-ADR-009: Placeholder digest (opt-in) and the rejected break-even test

## Context

Two ideas came from "Context Has a Price" (arXiv 2611.22238) after the field-data review of CM-ADR-008: mask on a
warm cache only when the saving exceeds the rewrite cost, and put a deterministic digest of the masked text into
the placeholder. Gates for both were written before the build (research doc
`docs/research/2026-11-18-field-data.md` §7.1, §7.2). Results: §7.3.

## Decision

1. **Digest: `features.digest`, default off.** With the flag on, a built-in bash placeholder ends with the last
   line of the result that states an outcome (counts of passed or failed, an error, an exit code), and a read
   placeholder with the names the file defines at column 0, or the headings of a Markdown file:
   `[cm-masked bash #3f9a2c1d7e] npm test (412 lines, 18KB; cm_recall returns it): Tests 2 failed | 87 passed (89)`.
   At most 120 characters, one line, made by fixed code (`filters/digest.ts`), so the bytes never change. A result
   without an outcome line, or a file without such names, gets no digest. Built-in templates carry `{digest}`;
   a custom template gets a digest only if it names `{digest}`.
   - Live probe (real pi, Claude Haiku 5.5, 6 runs for each arm): with the digest the agent named the two failed
     checks with 0 tool calls in 6 of 6 runs; without it, it called `cm_recall` once and was also correct.
   - Replay cost gate: +1.13% cache cost against a limit of 1% (interval up to +2.4%). Failed, so the flag is off.
2. **Break-even test: not shipped.** It made the replay 10.2% dearer, raised the largest prompt by up to 67%, and
   took 71 ms at p99. Deferring a zone postpones the rewrite to a larger request; it does not avoid it. The code
   is removed; the spec and the numbers are in the research doc §7.

## Consequences

- An operator turns the digest on with `{"features": {"digest": true}}` in `~/.config/condensed-milk.json`. The
  change of bytes rewrites the cache once. The A/B switch of CM-ADR-006 gives a controlled comparison; telemetry
  lists `features.digest`.
- To revisit the default: schema-6 exports from more operators. The digest pays when recalls and re-reads per mask
  are several times higher than in the maintainer's sessions.
- The replay harness did not pass its own validity gate on the 17-day list (cache reads 16.2% low). A decision that
  depends on dollar amounts from this list needs a new validation first.

## Verification

| Check | Result |
|---|---|
| Spec tests, written first and seen red | `tests/digest.test.mjs` 20, `tests/extension-1-14.test.mjs` 7 |
| Test suite | 30/30 files under pi 1.0.4 and pi 1.5.0 |
| Flag off changes nothing | The base arm's replay series is byte-identical to the run made before the feature existed |
| Determinism | Two replay runs with the digest arm are byte-identical |
| Placeholder guard | A placeholder with a digest is still recognized and blocked as an argument value |
