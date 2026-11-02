/**
 * CM-ADR-005/006/007 spec, extension wiring for 1.13.0: masked arguments and
 * collapse at mask events, the cutoff kept across a pi restart (session
 * entry), the live A/B switch, schema-4 telemetry, recall of masked
 * arguments, and the new explainer. Drives the real index.ts through a fake pi.
 */
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadTs, makeFakePi, makeCtx, makeSessionManager, makeRunner, assistantCall, toolResult, userMsg, entriesFor, textOf, isolateHome } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-005/006/007 extension: 1.13.0 features");
const home = isolateHome();
mkdirSync(join(home, ".config"), { recursive: true });
const CONFIG = join(home, ".config", "condensed-milk.json");
const ext = (await loadTs("index.ts")).default;
const am = await loadTs("filters/args-mask.ts");
const sid = (s, ts = 0) => createHash("sha1").update(`${s}\u0000${ts}`).digest("hex").slice(0, 10);
const aid = (callId, ts = 0) => sid(`${callId}\u0000args`, ts);
const LONG = "row\n".repeat(80) + "end";

/** [user, (write call, result) x pairs] with long write content. */
function history(pairs) {
	const out = [userMsg("go")];
	for (let i = 0; i < pairs; i++) {
		out.push(assistantCall(`w${i}`, "write", { path: `/repo/f${i}.ts`, content: `${LONG}${i}` }));
		out.push(toolResult(`w${i}`, "write", `wrote ${"r".repeat(5_000)} ${i}`));
	}
	return out;
}
/** [user, (bash call, result) x pairs] with 5,000-char distinct results. */
function bashHistory(pairs) {
	const out = [userMsg("go")];
	for (let i = 0; i < pairs; i++) {
		out.push(assistantCall(`c${i}`, "bash", { command: `cat f${i}` }));
		out.push(toolResult(`c${i}`, "bash", `${"r".repeat(5_000)}${i}`));
	}
	return out;
}
const maskedResults = (ms) => ms.filter((m) => m.role === "toolResult" && textOf(m).startsWith("[cm-masked")).length;
const maskedArgs = (ms) => ms.filter((m) => m.role === "assistant" && JSON.stringify(m.content).includes("[cm-masked arg")).length;
const ctxFor = (entries, tokens, sessionId = "test-session") => ({ ...makeCtx({ tokens, entries }), sessionManager: { ...makeSessionManager(entries), getSessionId: () => sessionId } });
async function fresh(entries = [], sessionId = "test-session") {
	const f = makeFakePi();
	ext(f.pi);
	await f.fire("session_start", { reason: "startup" }, ctxFor(entries, 0, sessionId));
	return f;
}
async function pass(f, messages, tokens, entries = [], sessionId = "test-session") {
	const r = await f.fire("context", { messages }, ctxFor(entries, tokens, sessionId));
	return r?.messages ?? messages;
}

// explainer (CM-ADR-005: names arguments, warns against copying placeholders)
{
	const f = await fresh();
	const EXPLAINER = "\n\ncondensed-milk: old tool results and long tool-call arguments can appear as\n" +
		"`[cm-masked bash|read|recall|arg #id] …` to keep the prompt cache stable. To see one\n" +
		"exactly as it was first shown, call `cm_recall` with the id (add `grep`, or\n" +
		"`offset`/`limit`, for part of it). To see the current state, re-run the command or\n" +
		"re-read the file. Each costs one step, so do it only when the next step needs the content.\n" +
		"Never copy a placeholder into a new tool call.";
	check("explainer bytes", (await f.fire("before_agent_start", { systemPrompt: "BASE" }, makeCtx())).systemPrompt, "BASE" + EXPLAINER);
}

// C at a zone entry; state written once per change (R)
{
	const f = await fresh();
	const h = history(20); // 41 messages
	const out = await pass(f, h, 700_000);
	check("zone 2 masks the arguments before the cutoff", maskedArgs(out), 19);
	check("one state entry after the zone entry", f.appended, [{ customType: "condensed-milk-state", data: { v: 1, cutoff: 38, zone: 2, horizon: 41 } }]);
	await pass(f, h, 700_000);
	check("no new state entry without a change", f.appended.length, 1);
}

// R: restore after a restart; never across a compaction
{
	const h2 = bashHistory(40); // 81 messages; zone 2 at 41 messages froze the cutoff at 38
	const stateEntry = { type: "custom", customType: "condensed-milk-state", data: { v: 1, cutoff: 38, zone: 2, horizon: 41 }, id: "s1", parentId: "e40", timestamp: new Date(1_700_000_040_500).toISOString() };
	const ents = entriesFor(h2);
	const withState = [...ents.slice(0, 41), stateEntry, ...ents.slice(41)];
	const restored = await fresh(withState);
	check("a restart keeps the cutoff (results 2..36)", maskedResults(await pass(restored, h2, 700_000, withState)), 18);
	const plain = await fresh(ents);
	check("without a state entry the restart re-masks at the new length (results 2..74)", maskedResults(await pass(plain, h2, 700_000, ents)), 37);
	const compaction = { type: "compaction", id: "c1", parentId: "s1", timestamp: stateEntry.timestamp, summary: "x", firstKeptEntryId: "e41", tokensBefore: 1 };
	const afterCompaction = [...ents.slice(0, 41), stateEntry, compaction, ...ents.slice(41)];
	const compacted = await fresh(afterCompaction);
	check("a state entry before a compaction is not used", maskedResults(await pass(compacted, h2, 700_000, afterCompaction)), 37);
}

// cm_recall returns masked arguments byte-identical
{
	const f = await fresh();
	const h = history(3);
	const ents = entriesFor([...h, userMsg("more")]);
	const res = await f.tools.get("cm_recall").execute("t1", { id: `#${aid("w1")}` }, undefined, undefined, ctxFor(ents, 0));
	const text = res.content[0].text;
	check("recall header names the call", text.split("\n")[0].startsWith(`[cm-recall #${aid("w1")}] write: /repo/f1.ts (arguments) — arguments as first sent,`), true);
	check("recall body is argsText of the arguments", text.slice(text.indexOf("\n\n") + 2), am.argsText(h[3].content[0].arguments));
	check("recall is not an error", res.isError, false);
}

// A/B: arm from sha256("cm-ab-1:" + session id); control = 1.12.0 behavior
{
	const armOf = (id) => (parseInt(createHash("sha256").update(`cm-ab-1:${id}`).digest("hex").slice(0, 8), 16) % 2 === 0 ? "control" : "treatment");
	const ids = Array.from({ length: 40 }, (_, i) => `s${i}`);
	const controlId = ids.find((id) => armOf(id) === "control");
	const treatmentId = ids.find((id) => armOf(id) === "treatment");
	writeFileSync(CONFIG, JSON.stringify({ experiment: { ab: true } }));
	const c = await fresh([], controlId);
	check("control: no masked arguments", maskedArgs(await pass(c, history(20), 700_000, [], controlId)), 0);
	check("control: no state entry", c.appended.length, 0);
	const t = await fresh([], treatmentId);
	check("treatment: masked arguments", maskedArgs(await pass(t, history(20), 700_000, [], treatmentId)), 19);
	writeFileSync(CONFIG, JSON.stringify({ features: { maskArgs: false } }));
	const off = await fresh();
	check("features.maskArgs false turns C off", maskedArgs(await pass(off, history(20), 700_000)), 0);
	rmSync(CONFIG);
}

// telemetry schema 4
{
	process.env.CONDENSED_MILK_TELEMETRY = "on";
	const f = await fresh();
	await f.fire("before_agent_start", { systemPrompt: "" }, makeCtx());
	await pass(f, history(20), 700_000);
	await f.fire("tool_result", { toolName: "edit", toolCallId: "x1", input: { path: "/a" }, content: [{ type: "text", text: "Could not find the exact text in /a. The old text must match exactly including all whitespace and newlines." }], isError: true }, makeCtx());
	await f.fire("tool_result", { toolName: "read", toolCallId: "x2", input: { path: "/a" }, content: [{ type: "text", text: "ok" }], isError: false }, makeCtx());
	await f.fire("session_shutdown", {}, makeCtx());
	delete process.env.CONDENSED_MILK_TELEMETRY;
	const entry = JSON.parse(readFileSync(join(home, ".config", "condensed-milk-sessions.jsonl"), "utf-8").trim().split("\n").at(-1));
	check("schema", entry.schema, 4);
	check("version", entry.version, "1.13.0");
	check("arm", entry.arm, "default");
	check("features", entry.features, { maskArgs: true, collapseReads: true, batchInvalidation: true, persistCutoff: true });
	check("quality proxies", [entry.user_prompts, entry.tool_results, entry.tool_errors, entry.edit_not_found], [1, 2, 1, 1]);
	check("feature counters", [entry.args_masked, entry.collapsed, entry.state_restored, entry.state_writes], [19, 0, false, 1]);
}

done();
