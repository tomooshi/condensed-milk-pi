/**
 * Spec for the prefix guard's pure core (filters/prefix-guard.ts, CM-ADR-004).
 *
 * comparePayloads(prev, cur) names the first part of a provider request that
 * differs from the previous request, in the provider's cache order (tools,
 * then system, then messages), and counts the thinking blocks after it, which
 * a Claude 5.x model can no longer use.
 * Laws: cache_control markers never count as a change; an append-only request
 * is "none"; the inputs are never mutated.
 */
import { loadTs, makeRunner, prng, seedFromEnv } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-004 prefix guard core");
const G = await loadTs("filters/prefix-guard.ts");

const tool = (name, description = "d") => ({ name, description, input_schema: { type: "object" } });
const text = (role, t) => ({ role, content: [{ type: "text", text: t }] });
const thinking = (sig) => ({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: sig }, { type: "tool_use", id: sig, name: "bash", input: {} }] });
const result = (id, t) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: t }] }] });
const payload = (over = {}) => ({
	model: "claude-opus-5-5",
	system: [{ type: "text", text: "You are pi." }],
	tools: [tool("bash"), tool("read")],
	messages: [text("user", "go"), thinking("s1"), result("s1", "out 1"), thinking("s2"), result("s2", "out 2")],
	...over,
});
const base = payload();
const pick = (c) => [c.kind, c.index, c.detail, c.thinkingAfter];

check("the first request has nothing to compare", G.comparePayloads(null, base).kind, "first");
check("an append-only request is no change", pick(G.comparePayloads(base, payload({ messages: [...base.messages, thinking("s3")] }))), ["none", null, "", 0]);
{
	const moved = payload({ messages: base.messages.map((m, i) => (i === 2 ? { ...m, content: m.content.map((c) => ({ ...c, cache_control: { type: "ephemeral" } })) } : m)) });
	check("a moved cache_control marker is no change", G.comparePayloads(base, moved).kind, "none");
	check("cache_control is ignored in equality", G.equalIgnoringCacheControl({ a: 1, cache_control: { type: "ephemeral" } }, { a: 1 }), true);
}
check("a tool added later changes tools and puts every thinking block at risk",
	pick(G.comparePayloads(base, payload({ tools: [...base.tools, tool("mcp__builtin_mcp__list_mcp_resources")] }))),
	["tools", 2, "added mcp__builtin_mcp__list_mcp_resources", 2]);
check("a removed tool is named", G.comparePayloads(base, payload({ tools: [tool("bash")] })).detail, "removed read");
check("a changed tool is named", G.comparePayloads(base, payload({ tools: [tool("bash", "new text"), tool("read")] })).detail, "changed bash");
check("a changed system prompt", pick(G.comparePayloads(base, payload({ system: [{ type: "text", text: "You are pi. Today is Monday." }] }))), ["system", null, "system", 2]);
check("tools are reported before system and messages (cache order)",
	G.comparePayloads(base, payload({ tools: [tool("bash")], system: [{ type: "text", text: "x" }], messages: [text("user", "other")] })).kind, "tools");
{
	const masked = payload({ messages: base.messages.map((m, i) => (i === 2 ? result("s1", "[cm-masked bash #0123456789] cat f (1 lines, 5B)") : m)) });
	check("an earlier result replaced by a placeholder is a condensed-milk mask", pick(G.comparePayloads(base, masked)), ["message", 2, "condensed-milk mask", 1]);
}
{
	const edited = payload({ messages: base.messages.map((m, i) => (i === 2 ? result("s1", "out 1, edited") : m)) });
	check("an earlier message edited by someone else", pick(G.comparePayloads(base, edited)), ["message", 2, "user edited", 1]);
}
{
	const removed = payload({ messages: [base.messages[0], base.messages[1], base.messages[3], base.messages[4], thinking("s3")] });
	check("a deleted earlier message is named as removed", pick(G.comparePayloads(base, removed)), ["removed", 2, "user removed", 2]);
}
{
	const red = { role: "assistant", content: [{ type: "redacted_thinking", data: "x" }, { type: "text", text: "ok" }] };
	check("redacted thinking blocks count too", G.thinkingBlockCount([text("user", "a"), red, thinking("s9")], 0), 2);
	check("counting starts after the given index", G.thinkingBlockCount([red, thinking("s9")], 0), 1);
}
// OpenAI-style payload: the system prompt is message 0, tools carry function.name
{
	const oa = { model: "x", tools: [{ type: "function", function: { name: "bash" } }], messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }] };
	const oa2 = { ...oa, tools: [...oa.tools, { type: "function", function: { name: "cm_recall" } }] };
	check("function tools are named by function.name", G.comparePayloads(oa, oa2).detail, "added cm_recall");
	check("a system message 0 edit counts as a message change at 0", G.comparePayloads(oa, { ...oa, messages: [{ role: "system", content: "sys 2" }, oa.messages[1]] }).index, 0);
}
// negative space
check("a payload without messages is unsupported", G.comparePayloads(base, { input: [] }).kind, "unsupported");
check("a non-object payload is unsupported", G.comparePayloads(base, "text").kind, "unsupported");
{
	let deep = { v: 1 };
	for (let i = 0; i < G.PAYLOAD_DEPTH_MAX + 5; i++) deep = { n: deep };
	check("structures deeper than PAYLOAD_DEPTH_MAX compare as different", G.equalIgnoringCacheControl(deep, structuredClone(deep)), false);
}

// property: append-only requests with moved cache_control are "none", inputs are never mutated
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const CASES = 1_000;
	let wrong = 0;
	let mutated = 0;
	for (let c = 0; c < CASES; c++) {
		const n = 1 + Math.floor(rand() * 20);
		const msgs = Array.from({ length: n }, (_, i) => (rand() < 0.5 ? thinking(`t${c}-${i}`) : result(`t${c}-${i}`, "x".repeat(Math.floor(rand() * 50)))));
		const prev = payload({ messages: msgs });
		const extra = Array.from({ length: Math.floor(rand() * 3) }, (_, i) => text("user", `more ${i}`));
		const marked = Math.floor(rand() * n);
		const cur = payload({ messages: [...msgs.map((m, i) => (i === marked ? { ...m, content: m.content.map((b) => ({ ...b, cache_control: { type: "ephemeral" } })) } : m)), ...extra] });
		const before = JSON.stringify([prev, cur]);
		if (G.comparePayloads(prev, cur).kind !== "none") wrong++;
		if (JSON.stringify([prev, cur]) !== before) mutated++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	check(`${CASES} append-only requests are "none"`, wrong, 0);
	check(`${CASES} comparisons leave both payloads unchanged`, mutated, 0);
}

done();
