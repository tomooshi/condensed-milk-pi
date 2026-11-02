/**
 * CM-ADR-004 spec, extension wiring of the prefix guard.
 * Gate (§6.1 A, offline): the request is byte-identical with and without the
 * guard: the before_provider_request handler returns nothing and never mutates
 * the payload (1,000 seeded payloads). The guard counts prefix changes by kind,
 * joins them with the response's cache write and Anthropic's thinking-drop
 * report, shows them in /compress-stats and in telemetry schema 3, and writes
 * one JSON line per change when CM_PREFIX_GUARD_LOG names a file.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadTs, makeFakePi, makeCtx, makeRunner, isolateHome, prng, seedFromEnv } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-004 extension: prefix guard");
const home = isolateHome();
const ext = (await loadTs("index.ts")).default;
const logPath = join(home, "prefix-guard.jsonl");

const tool = (name) => ({ name, description: "d", input_schema: { type: "object" } });
const thinkingMsg = (sig) => ({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: sig }, { type: "tool_use", id: sig, name: "bash", input: {} }] });
const resultMsg = (id, t) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: t }] }] });
const payload = (tools, messages) => ({ model: "claude-opus-5-5", system: [{ type: "text", text: "sys" }], tools, messages });
const assistantEnd = (cacheWrite, dropped) => ({
	message: {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		usage: { input: 2, output: 10, cacheRead: 1000, cacheWrite, reasoning: 0 },
		diagnostics: dropped.length ? [{ type: "anthropic_input_transformations", details: { transformations: dropped.map((p) => ({ type: "thinking_dropped", reason: "prefix_binding_mismatch", path: `messages.${p}.content.0` })) } }] : [],
	},
});

const { pi, fire: emit, commands } = makeFakePi();
ext(pi);
const ctx = makeCtx();
await emit("session_start", { reason: "startup" }, ctx);

// gate: the handler returns nothing and leaves the payload byte-identical
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const CASES = 1_000;
	let returned = 0;
	let mutated = 0;
	for (let c = 0; c < CASES; c++) {
		const msgs = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, i) => (rand() < 0.5 ? thinkingMsg(`p${c}-${i}`) : resultMsg(`p${c}-${i}`, "y".repeat(Math.floor(rand() * 40)))));
		const tools = rand() < 0.3 ? [tool("bash"), tool(`t${c}`)] : [tool("bash")];
		const p = payload(tools, msgs);
		const before = JSON.stringify(p);
		const r = await emit("before_provider_request", { type: "before_provider_request", payload: p }, ctx);
		if (r !== undefined) returned++;
		if (JSON.stringify(p) !== before) mutated++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	check(`${CASES} requests: the handler returns nothing`, returned, 0);
	check(`${CASES} requests: the payload is unchanged`, mutated, 0);
}

// counting, joining with the response, stats, telemetry and the log
process.env.CONDENSED_MILK_TELEMETRY = "on"; // read at session_start
// test-edit: the log is switched on only for this phase; the property loop above also makes edits.
process.env.CM_PREFIX_GUARD_LOG = logPath;
await emit("session_start", { reason: "startup" }, ctx);
const m1 = [resultMsg("u", "go"), thinkingMsg("a1"), resultMsg("a1", "one")];
await emit("before_provider_request", { payload: payload([tool("bash")], m1) }, ctx);
await emit("message_end", assistantEnd(9000, []), ctx);
const m2 = [...m1, thinkingMsg("a2"), resultMsg("a2", "two")];
await emit("before_provider_request", { payload: payload([tool("bash"), tool("mcp__builtin_mcp__read_mcp_resource")], m2) }, ctx);
await emit("message_end", assistantEnd(12000, [1, 3]), ctx);
const m3 = m2.map((m, i) => (i === 2 ? resultMsg("a1", "[cm-masked bash #0123456789] x (1 lines, 3B)") : m));
await emit("before_provider_request", { payload: payload([tool("bash"), tool("mcp__builtin_mcp__read_mcp_resource")], m3) }, ctx);
await emit("message_end", assistantEnd(500, [1, 3]), ctx);

const notes = [];
await commands.get("compress-stats").handler("", { ...ctx, ui: { ...ctx.ui, notify: (m) => notes.push(m) } });
const stats = notes.join("\n");
check("stats show the prefix guard section", stats.includes("Prefix guard (v1.12.0)"), true);
check("stats count edits by kind", stats.includes("Prefix edits: tools 1, system 0, messages 1 (condensed-milk masks 1), removed 0"), true);
// test-edit: at risk is the sum over edits, 2 (tool added) + 1 (mask before a2) = 3; the first draft said 2 by mistake.
check("stats show thinking at risk and dropped", stats.includes("Thinking blocks at risk: 3 | dropped by Anthropic after an edit: 2"), true);
check("stats name the last edit", stats.includes("Last edit: message 2: condensed-milk mask"), true);

check("the debug log has one line per edit", existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l).kind) : [], ["tools", "message"]);

await emit("session_shutdown", {}, ctx);
delete process.env.CONDENSED_MILK_TELEMETRY;
const telemetryFile = join(home, ".config", "condensed-milk-sessions.jsonl");
const entry = existsSync(telemetryFile) ? JSON.parse(readFileSync(telemetryFile, "utf8").trim().split("\n").at(-1)) : {};
// test-edit: schema 4 and version 1.13.0 since CM-ADR-007; the schema-3 fields below are unchanged.
check("telemetry schema 4", [entry.schema, entry.version], [4, "1.13.0"]);
check("telemetry prefix counters", [entry.prefix_edits_tools, entry.prefix_edits_system, entry.prefix_edits_messages, entry.prefix_edits_cm_mask, entry.prefix_edits_removed], [1, 0, 1, 1, 0]);
check("telemetry thinking and cache counters", [entry.thinking_at_risk, entry.thinking_dropped_after_edit, entry.cache_write_after_edit], [3, 2, 12500]);

done();
