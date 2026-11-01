/**
 * CM-ADR-003 spec, extension wiring: `disabledFilters` from the rules config
 * reaches dispatch, and the bash result's isError reaches the filters.
 * Drives the real index.ts through a fake pi with HOME in a temp dir.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadTs, makeFakePi, makeCtx, makeRunner, isolateHome } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-003 extension: disabledFilters and isError");
const home = isolateHome();
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
writeFileSync(join(home, ".pi", "agent", "condensed-milk-config.json"), JSON.stringify({ disabledFilters: ["yarn test"] }));
const ext = (await loadTs("index.ts")).default;
const { pi, fire } = makeFakePi();
ext(pi);
await fire("session_start", { reason: "startup" }, makeCtx());

const PAD = Array.from({ length: 12 }, (_, i) => `  ✓ case ${i} (1 ms)`).join("\n");
const PASSING = `${PAD}\n\nTest Suites: 2 passed, 2 total\nTests:       42 passed, 42 total\nTime:        2.1 s\n`;
const result = (command, text, isError = false) => fire("tool_result", {
	toolName: "bash", toolCallId: `t-${command}`, input: { command }, content: [{ type: "text", text }], details: undefined, isError,
}, makeCtx());

check("a disabled filter leaves the output unchanged", await result("yarn test", PASSING), undefined);
check("an enabled filter still summarizes a passing run", (await result("npm test", PASSING))?.content?.[0]?.text, "Test Results: 42 passed");
check("a nonzero exit is not summarized", await result("npm test", `${PASSING}\n\nCommand exited with code 1`, true), undefined);

done();
