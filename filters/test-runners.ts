/**
 * Test runner filter for jest, vitest, mocha, npm/pnpm/yarn/bun test,
 * cargo test and go test. pytest is handled separately by pytest.ts.
 *
 * v1.11.1 (CM-ADR-003, GitHub issue #4): a filter never hides a failure.
 * Only a fully passing run is summarized. Any failure sign, a nonzero exit,
 * or counts that cannot be read leave the output unchanged, because failure
 * details are what the agent needs next. Before this, the parser took the
 * first "N passed" in the output (often the test-FILE count) and missed
 * "failed" in jest/cargo/bun order, so 3-failed/39-passed runs showed as
 * "Test Results: 1 passed" or "39 passed" with every failure dropped.
 *
 * Originally adapted from MasuRii/pi-rtk-optimizer techniques/test-output.ts.
 */
import { registerFilter, type FilterMeta, type FilterResult } from "./dispatch.js";

/** Below this many lines the output is already short; leave it.
 *  inherited: the v1.0 threshold of this filter. */
const MIN_LINES = 10;

/** Signs that some test failed or did not run to the end. One match is
 *  enough to leave the output unchanged; a false match only costs the
 *  compression of that one output. */
const FAILURE_SIGNS: readonly RegExp[] = [
  /^\s*FAIL(?:ED)?\b/m,              // jest/vitest " FAIL  path", go "FAIL", pytest "FAILED x"
  /^\s*---\s+FAIL:/m,                // go test
  /^\s*●\s/m,                        // jest failure block
  /^\s*[✕×✗]\s/m,                    // jest/vitest failed test mark
  /^\s*\(fail\)\s/m,                 // bun
  /\b[1-9]\d*\s+(?:failing|failed|fail|failures?)\b/i, // any positive failed count, any runner
  /test result:\s*FAILED/,           // cargo
  /\bpanicked at\b/,                 // rust
  /^error(?:\[E\d+\])?:/m,           // rustc compile error inside cargo test
  /^\s*not ok\b/m,                  // TAP (tape, node --test tap reporter)
  /^\s*✖\s/m,                       // node --test spec reporter
  /^\s*[#ℹ]?\s*fail(?:ed|ures?)?\s*[:=]?\s+[1-9]\d*\b/im, // "# fail 1", "ℹ fail 3", "Failed: 2"
];

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  /** "tests" for test counts, "packages" for go test package lines. */
  unit: "tests" | "packages";
}

const int = (s: string | undefined): number => (s === undefined ? 0 : Number.parseInt(s, 10) || 0);
const sumOf = (re: RegExp, text: string): number => [...text.matchAll(re)].reduce((n, m) => n + int(m[1]), 0);

/** Count words on one summary line, in any order: "3 failed, 39 passed". */
function countsOnLine(line: string): TestCounts {
  const word = (re: RegExp) => int(re.exec(line)?.[1]);
  return {
    passed: word(/(\d+)\s+pass(?:ed|ing)?\b/i),
    failed: word(/(\d+)\s+fail(?:ed|ing|ures?)?\b/i),
    skipped: word(/(\d+)\s+(?:skipped|skip|pending|todo|ignored)\b/i),
    unit: "tests",
  };
}

/** Read the test counts from the runner's own summary. Each runner has one
 *  summary shape; file-count lines ("Test Suites:", "Test Files") are never
 *  used. Null when no known summary is present: the filter does not guess. */
export function parseTestCounts(text: string, command = ""): TestCounts | null {
  const jest = /^Tests:\s+(.+)$/m.exec(text);                 // jest
  if (jest) return countsOnLine(jest[1]);
  const vitest = /^\s*Tests\s{2,}(.+)$/m.exec(text);          // vitest
  if (vitest) return countsOnLine(vitest[1]);
  if (/test result:/.test(text)) {                             // cargo (one line per crate/doc-test run)
    return {
      passed: sumOf(/test result:\s*\w+\.\s*(\d+)\s+passed/g, text),
      failed: sumOf(/test result:[^\n]*?(\d+)\s+failed/g, text),
      skipped: sumOf(/test result:[^\n]*?(\d+)\s+ignored/g, text),
      unit: "tests",
    };
  }
  if (/^\s*\d+\s+passing\b/m.test(text)) {                    // mocha
    return {
      passed: sumOf(/^\s*(\d+)\s+passing\b/gm, text),
      failed: sumOf(/^\s*(\d+)\s+failing\b/gm, text),
      skipped: sumOf(/^\s*(\d+)\s+pending\b/gm, text),
      unit: "tests",
    };
  }
  if (/^\s*\d+\s+pass\s*$/m.test(text)) {                     // bun
    return {
      passed: sumOf(/^\s*(\d+)\s+pass\s*$/gm, text),
      failed: sumOf(/^\s*(\d+)\s+fail\s*$/gm, text),
      skipped: sumOf(/^\s*(\d+)\s+skip\s*$/gm, text),
      unit: "tests",
    };
  }
  // go test: one "ok" line per package. Only under go test: TAP and custom
  // runners print "ok" lines too (found in the real-data check, CM-ADR-003).
  if (!/^go\s+test\b/.test(command)) return null;
  const goOk = [...text.matchAll(/^ok\s+\S+/gm)].length;
  if (goOk > 0) return { passed: goOk, failed: [...text.matchAll(/^FAIL\s+\S+/gm)].length, skipped: 0, unit: "packages" };
  return null;
}

/** True when the output shows any failure sign. */
export function hasFailureSign(text: string): boolean {
  return FAILURE_SIGNS.some((sign) => sign.test(text));
}

/** Summarize a fully passing run; null (output unchanged) in every other case. */
function filterTestOutput(stdout: string, command: string, meta: FilterMeta): FilterResult | null {
  if (meta?.isError === true) return null;
  if (stdout.split("\n").length < MIN_LINES) return null;
  if (hasFailureSign(stdout)) return null;
  const counts = parseTestCounts(stdout, command);
  if (counts === null || counts.failed > 0 || counts.passed === 0) return null;

  const head = counts.unit === "packages" ? `Test Results: ${counts.passed} packages ok` : `Test Results: ${counts.passed} passed`;
  const lines = counts.skipped > 0 ? [head, `  ${counts.skipped} skipped`] : [head];
  const output = lines.join("\n");
  // Pair assertion with the checks above: a summary never mentions a failure.
  if (/fail/i.test(output)) throw new Error("filterTestOutput: a summary must not describe a failing run");
  return { output, category: "medium" };
}

// Register for test runner prefixes (pytest handled by pytest.ts)
const TEST_COMMANDS = [
  "npm test", "pnpm test", "yarn test", "bun test",
  "npx vitest", "vitest", "pnpm vitest",
  "npx jest", "jest", "pnpm jest",
  "mocha", "npx mocha",
  "cargo test",
  "go test",
];

for (const cmd of TEST_COMMANDS) {
  registerFilter(cmd, filterTestOutput, "medium");
}
