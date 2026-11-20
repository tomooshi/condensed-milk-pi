/**
 * CM-ADR-008 §4 spec: a side request is not a prefix edit.
 *
 * Found in live use: an extension that asks the model a side question sends
 * `main request + question` through pi's hook chain. The next main request
 * then differs from that fork at the question, and the 1.12.0 guard, which
 * compared only with the newest request, counted "user edited" (529 of the
 * 547 foreign message edits in 17 days came from one such extension). The
 * provider's cache is keyed by prefix, so a request that only appends to ANY
 * recent request edits nothing.
 *
 * compareWithLineage(lineage, cur): `lineage` holds recent requests, newest
 * first. The result is the comparison that shares the longest prefix with
 * `cur` (ties go to the newest), and `base` says which request that was.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTs, makeFakePi, makeCtx, makeRunner, isolateHome, prng, seedFromEnv } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-008 prefix guard: side requests");
const home = isolateHome();
const G = await loadTs("filters/prefix-guard.ts");

const tool = (name) => ({ name, description: "d", input_schema: { type: "object" } });
const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const think = (sig) => ({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: sig }, { type: "tool_use", id: sig, name: "bash", input: {} }] });
const res = (id, t) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: t }] }] });
const reply = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });
const payload = (messages, over = {}) => ({ model: "m", system: [{ type: "text", text: "sys" }], tools: [tool("bash")], messages, ...over });
const pick = (r) => [r.change.kind, r.change.index, r.base];

const m1 = [user("go"), think("a1"), res("a1", "one")];
const main1 = payload(m1);
const fork = payload([...m1, reply("done"), user("side question?")]);
const main2 = payload([...m1, reply("done"), user("next prompt")]);

check("an empty lineage is the first request", pick(G.compareWithLineage([], main1)), ["first", null, 0]);
check("a fork that appends to the main request is no change", pick(G.compareWithLineage([main1], fork)), ["none", null, 0]);
check("the next main request continues the request before the fork", pick(G.compareWithLineage([fork, main1], main2)), ["none", null, 1]);
check("without the older request it looks like an edit (the 1.12.0 result)", pick(G.compareWithLineage([fork], main2)), ["message", 4, 0]);
{
	const masked = payload([m1[0], m1[1], res("a1", "[cm-masked bash #0123456789] x (1 lines, 300B; cm_recall returns it)"), reply("done"), user("next prompt")]);
	const r = G.compareWithLineage([fork, main1], masked);
	check("a real edit is reported against the newest request when no request shares more", [r.change.kind, r.change.index, r.change.detail, r.base], ["message", 2, "condensed-milk mask", 0]);
}
{
	const other = payload([user("summarise")], { system: [{ type: "text", text: "summariser" }], tools: [] });
	check("a side request with other tools is a tools change when it is sent", pick(G.compareWithLineage([main1], other)), ["tools", 0, 0]);
	check("the main request after it is no change", pick(G.compareWithLineage([other, main1], main2)), ["none", null, 1]);
}
{
	const sysEdit = payload(main2.messages, { system: [{ type: "text", text: "sys 2" }] });
	check("a system change beats no shared request: reported against the newest", pick(G.compareWithLineage([fork, main1], sysEdit)), ["system", null, 0]);
}
{
	const lineage = [fork, main1, payload([user("a")]), payload([user("b")]), payload([user("c")]), payload([user("d")])];
	check("more than LINEAGE_MAX requests is a broken invariant", (() => { try { G.compareWithLineage(lineage, main2); return "no throw"; } catch (e) { return e.constructor.name; } })(), "RangeError");
	check("LINEAGE_MAX", G.LINEAGE_MAX, 4);
}
check("an unsupported payload is unsupported", pick(G.compareWithLineage([main1], { input: [] })), ["unsupported", null, 0]);

// property: after any number of forks (up to LINEAGE_MAX - 1), an append-only main request is "none"
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const CASES = 500;
	let wrong = 0;
	for (let c = 0; c < CASES; c++) {
		const base = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, i) => (i % 2 === 0 ? think(`t${c}-${i}`) : res(`t${c}-${i}`, "x".repeat(Math.floor(rand() * 30)))));
		const forks = Array.from({ length: Math.floor(rand() * G.LINEAGE_MAX) }, (_, i) => payload([...base, user(`fork ${c}-${i}`)]));
		const next = payload([...base, reply("r"), user("prompt")]);
		const r = G.compareWithLineage([...forks.reverse(), payload(base)], next);
		if (r.change.kind !== "none" || r.base !== forks.length) wrong++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	check(`${CASES} main requests after 0-3 forks are "none" and name the main request as base`, wrong, 0);
}

// through the extension: the watcher pattern counts no edit
{
	process.env.CONDENSED_MILK_TELEMETRY = "on";
	const ext = (await loadTs("index.ts")).default;
	const f = makeFakePi();
	ext(f.pi);
	const ctx = makeCtx({ tokens: 1_000 });
	await f.fire("session_start", { reason: "startup" }, ctx);
	const end = { message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 500 } } };
	await f.fire("context", { messages: [] }, ctx);
	await f.fire("before_provider_request", { payload: main1 }, ctx);
	await f.fire("message_end", end, ctx);
	await f.fire("before_provider_request", { payload: fork }, ctx); // the side question: no context event, no message_end
	await f.fire("context", { messages: [] }, ctx);
	await f.fire("before_provider_request", { payload: main2 }, ctx);
	await f.fire("message_end", end, ctx);
	const notes = [];
	await f.commands.get("compress-stats").handler("", { ...ctx, ui: { ...ctx.ui, notify: (m) => notes.push(m) } });
	check("stats show the side request", notes.join("\n").includes("Side requests skipped: 1"), true);
	await f.fire("session_shutdown", {}, ctx);
	delete process.env.CONDENSED_MILK_TELEMETRY;
	const row = JSON.parse(readFileSync(join(home, ".config", "condensed-milk-sessions.jsonl"), "utf8").trim().split("\n").at(-1));
	check("no prefix edit is counted", [row.prefix_edits_tools, row.prefix_edits_system, row.prefix_edits_messages, row.prefix_edits_removed], [0, 0, 0, 0]);
	check("no cache write is charged to an edit", row.cache_write_after_edit, 0);
	check("the side request is counted", row.prefix_side_requests, 1);
}

done();
