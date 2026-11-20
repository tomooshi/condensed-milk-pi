/**
 * CM-ADR-008 §2-§3 spec: telemetry schema 6, driven through the real index.ts.
 *
 * Faults found in the schema-5 exports of issue #5 (4,621 and 3,940 rows):
 *   1. A session with no turns wrote a row (3,398 of 4,621).
 *   2. session_id_hash was null when pi had no session file at session_start.
 *   3. A compaction or a branch change reset mask_events, bytes_freed and the
 *      re-read counters to zero.
 *   4. Token totals summed the usage of the messages now in context: too low
 *      after a compaction, and counted again in every row of a resumed session.
 *   5. thinking_dropped_after_edit counted every reported drop again after a
 *      response that carried no report (it was larger than thinking_at_risk).
 *   6. final_ctx_pct was always null.
 * Schema 6 also names the message kind and distance of prefix edits and the
 * turn and position of system and tools edits.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadTs, makeFakePi, makeCtx, makeSessionManager, makeRunner, assistantCall, toolResult, isolateHome } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-008 telemetry schema 6");
const home = isolateHome();
const ext = (await loadTs("index.ts")).default;
const TELEMETRY = join(home, ".config", "condensed-milk-sessions.jsonl");
const rows = () => (existsSync(TELEMETRY) ? readFileSync(TELEMETRY, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
process.env.CONDENSED_MILK_TELEMETRY = "on";

const BIG = "x".repeat(200);
/** n messages: pairs of (assistant bash call, bash result); assistant messages carry `usage`. */
function history(n, usage) {
	const out = [];
	for (let i = 0; out.length < n; i++) {
		out.push({ ...assistantCall(`c${i}`, "bash", { command: `echo ${i}` }), ...(usage ? { usage } : {}) });
		if (out.length < n) out.push(toolResult(`c${i}`, "bash", `${BIG}${i}`));
	}
	return out;
}
const ctxWith = (over = {}, tokens = 350_000) => ({ ...makeCtx({ tokens }), sessionManager: { ...makeSessionManager([]), ...over } });
async function start(ctx = makeCtx()) {
	const f = makeFakePi();
	ext(f.pi);
	await f.fire("session_start", { reason: "startup" }, ctx);
	return f;
}
/** Shut down and return the row the session wrote, or null. */
async function shutdown(f, ctx = makeCtx()) {
	const before = rows().length;
	await f.fire("session_shutdown", {}, ctx);
	const after = rows();
	return after.length > before ? after.at(-1) : null;
}
const usageEnd = (usage) => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage } });

// 1. no turns, no row
{
	const f = await start();
	check("a session with no turns writes no row", await shutdown(f), null);
}

// schema and version
{
	const f = await start();
	await f.fire("context", { messages: history(4) }, makeCtx({ tokens: 1_000 }));
	const row = await shutdown(f);
	check("schema 6, version 1.14.0", [row.schema, row.version], [6, "1.14.0"]);
	check("a session with one turn writes a row", row.final_turn_count, 1);
}

// 2. session id
{
	const f = await start(ctxWith({ getSessionFile: () => undefined, getSessionId: () => "abc" }));
	await f.fire("context", { messages: history(4) }, makeCtx({ tokens: 1_000 }));
	const row = await shutdown(f, ctxWith({ getSessionFile: () => undefined, getSessionId: () => "abc" }));
	check("no session file (--no-session): the hash comes from the session id", row.session_id_hash, sha16("session-id:abc"));
}
{
	const FILE = "/sessions/--repo--/2026-11-18T00-00-00-000Z_abc.jsonl";
	const f = await start(ctxWith({ getSessionFile: () => undefined, getSessionId: () => "abc" }));
	await f.fire("context", { messages: history(4) }, makeCtx({ tokens: 1_000 }));
	const row = await shutdown(f, ctxWith({ getSessionFile: () => FILE, getSessionId: () => "abc" }));
	check("a file that exists only at shutdown is hashed", row.session_id_hash, sha16(FILE));
}
{
	const FILE = "/sessions/--repo--/2026-11-18T00-00-00-000Z_def.jsonl";
	const f = await start(ctxWith({ getSessionFile: () => FILE, getSessionId: () => "def" }));
	await f.fire("context", { messages: history(4) }, makeCtx({ tokens: 1_000 }));
	const row = await shutdown(f, { ui: {}, hasUI: false });
	check("a shutdown context without a session manager keeps the file seen at start", row.session_id_hash, sha16(FILE));
}

// 3. counters survive a compaction and a branch change
{
	const one = await start();
	await one.fire("context", { messages: history(20) }, makeCtx({ tokens: 350_000 }));
	const single = await shutdown(one);
	check("baseline: one masking pass", [single.mask_events > 0, single.bytes_freed > 0, single.compactions, single.position_resets], [true, true, 0, 0]);

	const f = await start();
	await f.fire("context", { messages: history(20) }, makeCtx({ tokens: 350_000 }));
	await f.fire("tool_result", { toolName: "bash", toolCallId: "again", input: { command: "echo 0" }, content: [{ type: "text", text: "x" }], isError: false }, makeCtx());
	await f.fire("session_compact", {}, makeCtx());
	await f.fire("context", { messages: history(20) }, makeCtx({ tokens: 350_000 }));
	await f.fire("session_tree", {}, makeCtx());
	await f.fire("context", { messages: history(20) }, makeCtx({ tokens: 350_000 }));
	const row = await shutdown(f);
	check("mask_events adds up across resets", row.mask_events, 3 * single.mask_events);
	check("bytes_freed adds up across resets", row.bytes_freed, 3 * single.bytes_freed);
	check("unique masks add up across resets (unique within each segment)", row.unique_masks_bashes, 3 * single.unique_masks_bashes);
	check("a re-read before the compaction is kept", [row.re_reads_total, row.re_reads_by_bash], [1, 1]);
	check("compactions and position resets are counted", [row.compactions, row.position_resets], [1, 2]);
}

// 4. token totals: only the responses of this run
{
	const f = await start();
	const old = { input: 1_000, output: 1_000, cacheRead: 1_000_000, cacheWrite: 50_000 };
	await f.fire("context", { messages: history(6, old) }, makeCtx({ tokens: 1_000 }));
	await f.fire("message_end", usageEnd({ input: 10, output: 5, cacheRead: 900, cacheWrite: 90 }), makeCtx());
	await f.fire("session_compact", {}, makeCtx());
	await f.fire("context", { messages: history(2, old) }, makeCtx({ tokens: 1_000 }));
	await f.fire("message_end", usageEnd({ input: 20, output: 7, cacheRead: 1_800, cacheWrite: 180 }), makeCtx());
	await f.fire("message_end", { message: { role: "user", content: [], usage: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 } } }, makeCtx());
	const row = await shutdown(f);
	check("token totals are the sum of this run's assistant responses", [row.total_tokens_input, row.total_cache_read, row.total_cache_write, row.total_output], [3_000, 2_700, 270, 12]);
	check("cache_hit_rate uses the same totals", row.cache_hit_rate, 0.9);
	check("responses are counted", row.llm_responses, 2);
}

// 6. final_ctx_pct
{
	const f = await start();
	await f.fire("context", { messages: history(4) }, makeCtx({ tokens: 100_000 }));
	await f.fire("context", { messages: history(6) }, makeCtx({ tokens: 250_000 }));
	check("final_ctx_pct is the usage at the last model call", (await shutdown(f)).final_ctx_pct, 0.25);
}
{
	const f = await start();
	await f.fire("context", { messages: history(4) }, { ...makeCtx(), getContextUsage: () => undefined });
	check("final_ctx_pct is null when pi gives no usage", (await shutdown(f)).final_ctx_pct, null);
}

// 5 and §3. the prefix guard: drops, roles, gaps, system and tools edits
{
	const tool = (name) => ({ name, description: "d", input_schema: { type: "object" } });
	const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
	const think = (sig) => ({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: sig }, { type: "tool_use", id: sig, name: "bash", input: {} }] });
	const res = (id, t) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: t }] }] });
	const payload = (tools, messages, system = "sys") => ({ model: "claude-opus-5-5", system: [{ type: "text", text: system }], tools, messages });
	const end = (dropped) => ({
		message: {
			role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 100 },
			diagnostics: dropped.length ? [{ type: "anthropic_input_transformations", details: { transformations: dropped.map((p) => ({ type: "thinking_dropped", reason: "prefix_binding_mismatch", path: `messages.${p}.content.0` })) } }] : [],
		},
	});
	const logPath = join(home, "guard-6.jsonl");
	process.env.CM_PREFIX_GUARD_LOG = logPath;
	const f = await start();
	const ctx = makeCtx({ tokens: 1_000 });
	const request = async (p) => { await f.fire("context", { messages: [] }, ctx); await f.fire("before_provider_request", { payload: p }, ctx); };
	const T1 = [tool("bash")];
	const T2 = [tool("bash"), tool("late")];
	const m1 = [user("go"), think("a1"), res("a1", "one")];
	const m2 = [...m1, think("a2"), res("a2", "two")];
	const m3 = [...m2, think("a3"), res("a3", "three")];
	const m4 = m3.map((m, i) => (i === 0 ? user("go, edited") : m));
	const m5 = m4.map((m, i) => (i === 4 ? res("a2", "two, edited") : m));

	await request(payload(T1, m1));                 // turn 1: first
	await f.fire("message_end", end([]), ctx);
	await request(payload(T2, m2));                 // turn 2: tools edit, 2 thinking blocks at risk
	await f.fire("message_end", end([1, 3]), ctx);  // both dropped: +2
	await request(payload(T2, m3));                 // turn 3: append only
	await f.fire("message_end", end([]), ctx);      // a response with no report
	await request(payload(T2, m4));                 // turn 4: user text edited at 0, 3 at risk
	await f.fire("message_end", end([1, 3]), ctx);  // the same two drops again: +0 (schema 5 counted 2)
	await request(payload(T2, m5));                 // turn 5: tool result edited at 4, 1 at risk
	await f.fire("message_end", end([1, 3, 5, 7]), ctx); // two new paths, but only 1 block was at risk: +1
	await request(payload(T2, m5, "sys, changed")); // turn 6: system edit
	await f.fire("message_end", end([1, 3, 5, 7]), ctx);

	const notes = [];
	await f.commands.get("compress-stats").handler("", { ...ctx, ui: { ...ctx.ui, notify: (m) => notes.push(m) } });
	const stats = notes.join("\n");
	check("stats: other message edits by kind", stats.includes("Other message edits: user 1, assistant 0, tool result 1, system 0, other 0"), true);
	check("stats: distance from the end", stats.includes("Messages after the edit: none 0, one 0, 2-9 2, 10 or more 0"), true);

	const logged = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("the debug log names kind, role and gap", logged.map((l) => [l.kind, l.role ?? null, l.gap ?? null]), [["tools", null, null], ["message", "user", 6], ["message", "tool_result", 2], ["system", null, null]]);
	check("the debug log carries the turn", logged.map((l) => l.turn), [2, 4, 5, 6]);
	check("the debug log has no text unless CM_PREFIX_GUARD_LOG_TEXT=1", logged.some((l) => "excerpt" in l), false);

	process.env.CM_PREFIX_GUARD_LOG_TEXT = "1";
	await request(payload(T2, m5, "sys, changed again")); // turn 7: system edit, logged with text
	await f.fire("message_end", end([1, 3, 5, 7]), ctx);
	delete process.env.CM_PREFIX_GUARD_LOG_TEXT;
	delete process.env.CM_PREFIX_GUARD_LOG;
	check("with CM_PREFIX_GUARD_LOG_TEXT=1 the log carries an excerpt", JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").at(-1)).excerpt, { prev: "", cur: " again" });

	const row = await shutdown(f, ctx);
	check("prefix edit counters", [row.prefix_edits_tools, row.prefix_edits_system, row.prefix_edits_messages, row.prefix_edits_cm_mask], [1, 2, 2, 0]);
	check("thinking at risk: 2 + 3 + 1 + 3 + 3", row.thinking_at_risk, 12);
	check("drops are counted once and never above the blocks at risk", row.thinking_dropped_after_edit, 3);
	check("prefix_edits_by_role", row.prefix_edits_by_role, { user: 1, assistant: 0, tool_result: 1, system: 0, other: 0 });
	check("prefix_edits_by_gap", row.prefix_edits_by_gap, { "0": 0, "1": 0, "2_9": 2, "10_plus": 0 });
	check("system_edits: turn and position, no text", row.system_edits, [{ at_turn: 6, offset: 3, prev_len: 3, cur_len: 12 }, { at_turn: 7, offset: 12, prev_len: 12, cur_len: 18 }]);
	check("tools_edits: turn and kind of change, no tool name", row.tools_edits, [{ at_turn: 2, change: "added" }]);
}

// the logged edit lists are bounded
{
	const f = await start();
	const ctx = makeCtx({ tokens: 1_000 });
	const N = 12;
	for (let i = 0; i < N; i++) {
		await f.fire("context", { messages: [] }, ctx);
		await f.fire("before_provider_request", { payload: { system: `sys ${i}`, tools: [], messages: [{ role: "user", content: "go" }] } }, ctx);
	}
	const row = await shutdown(f, ctx);
	check("every system edit is counted", row.prefix_edits_system, N - 1);
	check("system_edits keeps the first PREFIX_EDITS_LOGGED_MAX (8)", row.system_edits.length, 8);
	check("the kept entries are the first ones", row.system_edits[0].at_turn, 2);
}

delete process.env.CONDENSED_MILK_TELEMETRY;
done();
