/**
 * Run every test: tests/*.test.mjs, then the self-contained top-level
 * test-*.mjs files that need no session argument. Each file runs in its own
 * process, so module-level state (HOME, loaded config) never leaks.
 * Exit 0 only when every file exits 0.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./harness.mjs";

const LEGACY = ["test-back-compat.mjs", "test-compact-reset.mjs", "test-compound-cmd.mjs", "test-profiles.mjs", "test-rereads.mjs"];
// derived: the slowest file (legacy tests that run `npx tsc`) takes about 20 s; 10x margin.
const FILE_TIMEOUT_MS = 200_000;

const files = [
	...readdirSync(join(REPO, "tests")).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => join("tests", f)),
	...LEGACY,
];
const failed = files.filter((file) => {
	const run = spawnSync(process.execPath, [file], { cwd: REPO, encoding: "utf-8", timeout: FILE_TIMEOUT_MS, env: process.env });
	const last = (run.stdout || "").trim().split("\n").at(-1) ?? "";
	const ok = run.status === 0;
	console.log(`${ok ? "ok  " : "FAIL"} ${file}  ${last}`);
	if (!ok) console.log((run.stdout || "") + (run.stderr || "") + (run.error ? String(run.error) : ""));
	return !ok;
});
console.log(`\n${files.length - failed.length}/${files.length} files passed`);
process.exit(failed.length === 0 ? 0 : 1);
