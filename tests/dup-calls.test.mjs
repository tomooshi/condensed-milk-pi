/**
 * CM-ADR-008 §9 spec: duplicate-call counters (telemetry schema 6).
 *
 * A bash or read call is a duplicate when the same tool ran with the same
 * arguments earlier in the session (bash: the command; read: path, offset and
 * limit). The row counts calls and duplicates before the first mask of the
 * session and after it, so the two rates can be compared. Only counts are
 * stored; the tracker keeps a hash of each call, no text.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTs, makeFakePi, makeCtx, makeRunner, assistantCall, toolResult, userMsg, isolateHome } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-008 duplicate-call counters");
const D = await loadTs("filters/dup-calls.ts");

// pure
check("bash key depends on the command", [D.callKey("bash", { command: "ls" }) === D.callKey("bash", { command: "ls" }), D.callKey("bash", { command: "ls" }) === D.callKey("bash", { command: "ls -a" })], [true, false]);
check("read key depends on path, offset and limit", [
	D.callKey("read", { path: "/a" }) === D.callKey("read", { path: "/a", offset: null, limit: null }),
	D.callKey("read", { path: "/a" }) === D.callKey("read", { path: "/a", offset: 10 }),
	D.callKey("read", { path: "/a", offset: 10, limit: 5 }) === D.callKey("read", { path: "/a", offset: 10, limit: 5 }),
], [true, false, true]);
check("bash and read never share a key", D.callKey("bash", { command: "/a" }) === D.callKey("read", { path: "/a" }), false);
check("other tools and empty arguments have no key", [D.callKey("edit", { path: "/a" }), D.callKey("bash", {}), D.callKey("read", null)], [null, null, null]);
check("a key holds no text", /^[0-9a-f]{16}$/.test(D.callKey("bash", { command: "cat secret.txt" })), true);
{
	const t = D.newDupTracker();
	for (const c of ["a", "b", "a"]) t.note(D.callKey("bash", { command: c }));
	t.markMasked();
	for (const c of ["a", "c", "c", "d"]) t.note(D.callKey("bash", { command: c }));
	t.note(null);
	check("counts before and after the first mask", t.counts(), { calls_before_mask: 3, dup_calls_before_mask: 1, calls_after_mask: 4, dup_calls_after_mask: 2 });
	t.reset();
	check("reset", t.counts(), { calls_before_mask: 0, dup_calls_before_mask: 0, calls_after_mask: 0, dup_calls_after_mask: 0 });
}
check("KEYS_MAX", D.KEYS_MAX, 20_000);
{
	const t = D.newDupTracker();
	for (let i = 0; i <= D.KEYS_MAX; i++) t.note(D.callKey("bash", { command: `c${i}` }));
	t.note(D.callKey("bash", { command: "c0" }));
	t.note(D.callKey("bash", { command: `c${D.KEYS_MAX}` }));
	check("over KEYS_MAX the oldest key is forgotten", t.counts().dup_calls_before_mask, 1);
}

// extension: the row
{
	const home = isolateHome();
	mkdirSync(join(home, ".config"), { recursive: true });
	process.env.CONDENSED_MILK_TELEMETRY = "on";
	const ext = (await loadTs("index.ts")).default;
	const f = makeFakePi();
	ext(f.pi);
	const ctx = makeCtx({ tokens: 650_000 });
	await f.fire("session_start", { reason: "startup" }, ctx);
	const run = (toolName, input) => f.fire("tool_result", { toolName, toolCallId: "x", input, content: [{ type: "text", text: "out" }], isError: false }, ctx);
	await run("bash", { command: "npm test" });
	await run("bash", { command: "npm test" });
	await run("read", { path: "/w/a.ts" });
	await run("edit", { path: "/w/a.ts" });
	const h = [userMsg("go")];
	for (let i = 0; i < 10; i++) h.push(assistantCall(`c${i}`, "bash", { command: `cat f${i}` }), toolResult(`c${i}`, "bash", "r".repeat(5_000)));
	const out = await f.fire("context", { messages: h }, ctx);
	check("the context call masks", out !== undefined && out !== null, true);
	await run("read", { path: "/w/a.ts" });
	await run("read", { path: "/w/a.ts", offset: 50 });
	await run("bash", { command: "ls" });
	await f.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } }, ctx);
	await f.fire("session_shutdown", {}, ctx);
	delete process.env.CONDENSED_MILK_TELEMETRY;
	const row = JSON.parse(readFileSync(join(home, ".config", "condensed-milk-sessions.jsonl"), "utf8").trim().split("\n").at(-1));
	check("telemetry row", [row.calls_before_mask, row.dup_calls_before_mask, row.calls_after_mask, row.dup_calls_after_mask], [3, 1, 3, 1]);
}
done();
