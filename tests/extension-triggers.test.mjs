/**
 * CM-ADR-002 §4-5, §7 spec, extension wiring: task-boundary trigger (event,
 * command, configured bash pattern), its byte floor, the idle-aligned advance,
 * and schema-2 telemetry. Drives the real index.ts through a fake pi.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadTs, makeFakePi, makeCtx, makeRunner, assistantCall, toolResult, userMsg, entriesFor, textOf, isolateHome } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-002 extension: triggers and telemetry");
const home = isolateHome();
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
writeFileSync(join(home, ".pi", "agent", "condensed-milk-config.json"), JSON.stringify({ boundaryCommands: ["^bd close\\b"] }));
const ext = (await loadTs("index.ts")).default;
// CM-ADR-001 amendment: the id key is toolCallId + "\0" + timestamp; the builders use timestamp 0.
const sid = (s, ts = 0) => createHash("sha1").update(`${s}\u0000${ts}`).digest("hex").slice(0, 10);

/** [user, (call, result) x pairs]; results of `size` chars; assistant timestamps `ts`. */
function history(pairs, size, ts = 0) {
	const out = [userMsg("go", ts)];
	for (let i = 0; i < pairs; i++) {
		out.push(assistantCall(`c${i}`, "bash", { command: `cat f${i}` }, ts));
		out.push(toolResult(`c${i}`, "bash", `${"r".repeat(size)}${i}`));
	}
	return out;
}
/** The history plus the agent's closing message: every result has been seen. */
const closed = (h) => [...h, { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 0 }];
const masked = (ms) => ms.map((m, i) => (m.role === "toolResult" && textOf(m).startsWith("[cm-masked") ? i : -1)).filter((i) => i >= 0);
async function fresh() {
	const f = makeFakePi();
	ext(f.pi);
	await f.fire("session_start", { reason: "startup" }, makeCtx());
	return f;
}
async function pass(fire, messages, ctxOpts = {}) {
	const r = await fire("context", { messages }, makeCtx({ tokens: 100_000, ...ctxOpts }));
	return masked(r?.messages ?? messages);
}

// boundary from pi.events
{
	const { pi, fire } = await fresh();
	const h = closed(history(10, 5_000));
	check("no masks below the zones", await pass(fire, h), []);
	pi.events.emit("condensed-milk:boundary", { reason: "task done" });
	check("an event boundary masks every result", (await pass(fire, h)).length, 10);
	const h2 = [...h, assistantCall("n1", "bash", { command: "echo new" }), toolResult("n1", "bash", "n".repeat(5_000))];
	check("results after the boundary stay", (await pass(fire, h2)).length, 10);
}
// results the model has not seen yet stay (no immediate deletion, arXiv 2610.35496)
{
	const { pi, fire } = await fresh();
	const h = history(10, 5_000);
	pi.events.emit("condensed-milk:boundary", {});
	const unseen = await pass(fire, h);
	check("a boundary keeps results after the newest assistant message", unseen.includes(h.length - 1), false);
	check("a boundary masks the results before it", unseen.length, 9);
}
// byte floor
{
	const { pi, fire } = await fresh();
	const h = history(3, 300);
	pi.events.emit("condensed-milk:boundary", {});
	check("a boundary under BOUNDARY_MIN_BYTES is skipped", await pass(fire, h), []);
}
// /cm-boundary command
{
	const { commands, fire } = await fresh();
	await commands.get("cm-boundary").handler("", makeCtx());
	check("the /cm-boundary command masks every result", (await pass(fire, closed(history(10, 5_000)))).length, 10);
}
// configured bash pattern
{
	const { fire } = await fresh();
	await fire("tool_result", { toolName: "bash", toolCallId: "b1", input: { command: "cd /repo && bd close abc-1" }, content: [{ type: "text", text: "✓ Closed abc-1" }], isError: false }, makeCtx());
	check("a boundaryCommands match masks every result", (await pass(fire, closed(history(10, 5_000)))).length, 10);
}
// idle-aligned advance
{
	const now = Date.now();
	const model = { promptCache: { short: 300, long: 3600 } };
	const idleHist = history(10, 8_000, now - 2 * 3_600_000);
	check("idle past the lifetime enters zone 0 (cutoff 12 of 21)", await pass((await fresh()).fire, idleHist, { model, entries: entriesFor(idleHist) }), [2, 4, 6, 8, 10]);
	const busy = history(10, 8_000, now - 10_000);
	check("not idle: no masks", await pass((await fresh()).fire, busy, { model, entries: entriesFor(busy) }), []);
	check("unknown cache lifetime: no masks", await pass((await fresh()).fire, idleHist, { entries: entriesFor(idleHist) }), []);
	const warmed = entriesFor(idleHist);
	warmed.push({ type: "usage", kind: "cache_warm", id: "w1", parentId: warmed.at(-1).id, timestamp: new Date(now - 10_000).toISOString(), provider: "anthropic", model: "m", usage: {} });
	check("a recent cache_warm entry means not idle", await pass((await fresh()).fire, idleHist, { model, entries: warmed }), []);
	process.env.PI_CACHE_RETENTION = "long";
	const halfHour = history(10, 8_000, now - 1_800_000);
	check("long retention: 30 minutes is not idle", await pass((await fresh()).fire, halfHour, { model, entries: entriesFor(halfHour) }), []);
	delete process.env.PI_CACHE_RETENTION;
}
// telemetry schema 2
{
	process.env.CONDENSED_MILK_TELEMETRY = "on";
	const { pi, fire, tools } = await fresh();
	const h = history(10, 5_000);
	const ctx = makeCtx({ tokens: 100_000, entries: entriesFor(h) });
	await tools.get("cm_recall").execute("k1", { id: sid("c3") }, undefined, undefined, ctx);
	await tools.get("cm_recall").execute("k2", { id: "zz" }, undefined, undefined, ctx);
	await fire("tool_result", { toolName: "bash", toolCallId: "c99", input: { command: "cat f3" }, content: [{ type: "text", text: "again" }], isError: false }, ctx);
	pi.events.emit("condensed-milk:boundary", {});
	await fire("context", { messages: h }, ctx);
	await fire("session_shutdown", {}, ctx);
	delete process.env.CONDENSED_MILK_TELEMETRY;
	const lines = readFileSync(join(home, ".config", "condensed-milk-sessions.jsonl"), "utf-8").trim().split("\n");
	const entry = JSON.parse(lines.at(-1));
	check("telemetry schema", entry.schema, 2);
	check("telemetry version", entry.version, "1.11.1");
	check("recall counters", [entry.recalls_by_id, entry.recalls_by_match, entry.recall_errors, entry.recall_then_rerun], [1, 0, 1, 1]);
	check("boundary counters", [entry.boundaries_applied, entry.boundaries_skipped, entry.idle_advances], [1, 0, 0]);
	check("bytes returned is counted", entry.recall_bytes_returned > 5_000, true);
}

done();
