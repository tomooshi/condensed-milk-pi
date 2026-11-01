/**
 * CM-ADR-003 spec: a filter never hides a failure (GitHub issue #4).
 *
 * Laws: (1) a failing run of any supported runner passes through unchanged
 * (dispatch returns null), whatever order or separator the runner uses;
 * (2) a fully passing run is summarized with the TEST count, not the file
 * count; (3) a nonzero exit (isError) is never summarized; (4) property:
 * any passing output plus one failure sign is never summarized (seeded;
 * replay with CM_SEED=<n>); (5) disabledFilters turns off a prefix filter or
 * a content fallback by its registered name.
 */
import { loadTs, makeRunner, prng, seedFromEnv } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-003 test-runner filter never hides a failure");
const d = await loadTs("filters/dispatch.ts");
await loadTs("filters/test-runners.ts");
const { filterJsonOutput } = await loadTs("filters/json-schema.ts");
d.registerContentFallback("json", filterJsonOutput);

const PAD = Array.from({ length: 12 }, (_, i) => `  ✓ case ${i} (1 ms)`).join("\n");
const jestBlock = (i) => `  ● Calc › adds ${i}\n\n    expect(received).toBe(expected)\n\n    Expected: ${i}\n    Received: ${i + 1}\n\n      at Object.<anonymous> (src/calc.test.ts:11:26)\n`;

/** Failing output per runner (3 failed, 39 passed). */
const FAILING = {
	jest: ["yarn test", [" FAIL  src/calc.test.ts", jestBlock(0), jestBlock(1), jestBlock(2), " PASS  src/other.test.ts", "",
		"Test Suites: 1 failed, 1 passed, 2 total", "Tests:       3 failed, 39 passed, 42 total", "Time:        2.1 s"].join("\n")],
	vitest: ["npx vitest run", [" ❯ src/calc.test.ts  (4 tests | 3 failed) 5ms", "   × Calc > adds 0", "     → expected 1 to be +0", PAD, "",
		" FAIL  src/calc.test.ts > Calc > adds 0", "AssertionError: expected 1 to be +0", "",
		" Test Files  1 failed | 1 passed (2)", "      Tests  3 failed | 39 passed (42)", "   Duration  1.20s"].join("\n")],
	mocha: ["npx mocha", `${PAD}\n\n  39 passing (2s)\n  3 failing\n\n  1) Calc\n       adds:\n     AssertionError: expected 1 to equal 0\n      at Context.<anonymous> (test/calc.js:11:26)\n`],
	cargo: ["cargo test", `running 42 tests\n${PAD}\ntest calc::adds ... FAILED\n\nfailures:\n\n---- calc::adds stdout ----\nthread 'calc::adds' panicked at src/lib.rs:11:9:\nassertion failed\n\ntest result: FAILED. 39 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n`],
	bun: ["bun test", `${PAD}\nsrc/calc.test.ts:\n(fail) Calc > adds [0.12ms]\n  error: expect(received).toBe(expected)\n\n 39 pass\n 3 fail\n 45 expect() calls\nRan 42 tests across 2 files. [12.00ms]\n`],
	// Found in the real-data check: TAP (tape, node --test with the tap reporter) under npm test.
	tap: ["npm test", `TAP version 13\n${Array.from({ length: 12 }, (_, i) => `ok ${i + 1} - case ${i}`).join("\n")}\nnot ok 13 - adds\n  ---\n  expected: 0\n  actual: 1\n  ...\n1..13\n# tests 13\n# pass 12\n# fail 1\n`],
	nodeTest: ["npm test", `${PAD}\n✖ adds (1.2ms)\nℹ tests 42\nℹ suites 2\nℹ pass 39\nℹ fail 3\nℹ duration_ms 120\n`],
	go: ["go test ./...", `${PAD}\n--- FAIL: TestAdd (0.00s)\n    calc_test.go:11: add(0,1) = 1, want 0\nFAIL\nFAIL\texample.com/calc\t0.012s\nok  \texample.com/other\t0.010s\nFAIL\n`],
};

/** Passing output per runner, and the summary it must give. */
const PASSING = {
	jest: ["npx jest", `${PAD}\n PASS  src/a.test.ts\n PASS  src/b.test.ts\n\nTest Suites: 2 passed, 2 total\nTests:       2 skipped, 40 passed, 42 total\nTime:        2.1 s\n`, "Test Results: 40 passed\n  2 skipped"],
	vitest: ["npx vitest run", `${PAD}\n ✓ src/a.test.ts (20 tests) 5ms\n\n Test Files  2 passed (2)\n      Tests  42 passed (42)\n   Duration  1.20s\n`, "Test Results: 42 passed"],
	mocha: ["npx mocha", `${PAD}\n\n  41 passing (2s)\n  1 pending\n`, "Test Results: 41 passed\n  1 skipped"],
	cargo: ["cargo test", `running 30 tests\n${PAD}\ntest result: ok. 30 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n\nrunning 12 tests\ntest result: ok. 12 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.20s\n`, "Test Results: 42 passed\n  1 skipped"],
	bun: ["bun test", `${PAD}\n\n 42 pass\n 0 fail\n 45 expect() calls\nRan 42 tests across 2 files. [12.00ms]\n`, "Test Results: 42 passed"],
	go: ["go test ./...", `${PAD}\nok  \texample.com/calc\t0.012s\nok  \texample.com/other\t0.010s\n?   \texample.com/cmd\t[no test files]\n`, "Test Results: 2 packages ok"],
};

// (1) failing runs pass through
for (const [name, [cmd, out]] of Object.entries(FAILING)) {
	check(`${name}: a failing run passes through unchanged`, d.dispatch(cmd, out), null);
}
// (2) passing runs: test count, not file count
for (const [name, [cmd, out, want]] of Object.entries(PASSING)) {
	check(`${name}: a passing run is summarized with the test count`, d.dispatch(cmd, out)?.output, want);
}
// (3) a nonzero exit is never summarized (a passing-looking tail of a failed run)
check("isError: a nonzero exit passes through", d.dispatch("npx jest", PASSING.jest[1], { isError: true }), null);
// "ok" lines count as Go packages only under go test (a TAP or custom runner prints them too)
check("ok lines under npm test are not Go packages", d.dispatch("npm test", `${PAD}\nok   a.mjs  PASS\nok   b.mjs  PASS\n2/2 files passed\n`), null);
// counts that cannot be read: no guess
check("unreadable counts pass through", d.dispatch("npm test", `${PAD}\nall done, ok ok ok\n`), null);
check("zero tests pass through", d.dispatch("npx jest", `${PAD}\nTests:       0 total\n`), null);

// (4) property: passing output + one failure sign is never summarized
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const SIGNS = [" FAIL  src/x.test.ts", "  ● Suite › case", "  ✕ case (3 ms)", "  × case", "(fail) Suite > case",
		"  2 failing", "test result: FAILED. 1 passed; 1 failed; 0 ignored", "thread 'x' panicked at src/lib.rs:1:1:",
		"--- FAIL: TestX (0.00s)", "FAILED tests/x.py::test_y", "Tests:       1 failed, 41 passed, 42 total", " 7 fail",
		"not ok 3 - case", "# fail 2", "ℹ fail 1", "✖ case (1ms)"];
	const CASES_MAX = 400;
	let leaks = 0;
	const runners = Object.values(PASSING);
	for (let c = 0; c < CASES_MAX; c++) {
		const [cmd, out] = runners[Math.floor(rand() * runners.length)];
		const lines = out.split("\n");
		lines.splice(Math.floor(rand() * (lines.length + 1)), 0, SIGNS[Math.floor(rand() * SIGNS.length)]);
		if (d.dispatch(cmd, lines.join("\n")) !== null) leaks++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	check("no passing output with a failure sign is summarized", leaks, 0);
}

// (5) disabledFilters
{
	const off = new Set(["npx jest"]);
	check("a disabled prefix filter does not run", d.dispatch("npx jest", PASSING.jest[1], { disabled: off }), null);
	check("other prefixes still run", d.dispatch("npx vitest run", PASSING.vitest[1], { disabled: off })?.output, "Test Results: 42 passed");
	const json = JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item-${i}` })) });
	check("the json fallback runs by default", d.dispatch("curl -s x", json) === null, false);
	check("a disabled content fallback (*json) does not run", d.dispatch("curl -s x", json, { disabled: new Set(["*json"]) }), null);
}

done();
