/**
 * CM-ADR-008 §3 spec: the prefix guard says which kind of message changed,
 * how far from the end it was, and where a system prompt changed.
 *
 * Field data (issue #5): 404 of 1,223 sessions had one system-prompt edit of
 * about 280k cache-write tokens, and one local setup had one message edit per
 * user prompt. Telemetry schema 5 could not name either cause. The additions:
 *   messageClass(message)          user | assistant | tool_result | system | other
 *   change.role, change.gap        for "message" and "removed" changes
 *   change.span                    for "system": first differing character and both lengths
 *   changeExcerpt(prev, cur, c)    short text around the difference, for the opt-in debug log only
 */
import { loadTs, makeRunner } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-008 prefix guard: roles, gap, system span");
const G = await loadTs("filters/prefix-guard.ts");

const tool = (name) => ({ name, description: "d", input_schema: { type: "object" } });
const text = (role, t) => ({ role, content: [{ type: "text", text: t }] });
const thinking = (sig) => ({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: sig }, { type: "tool_use", id: sig, name: "bash", input: {} }] });
const result = (id, t) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: t }] }] });
const payload = (over = {}) => ({
	model: "claude-opus-5-5",
	system: [{ type: "text", text: "You are pi." }],
	tools: [tool("bash")],
	messages: [text("user", "go"), thinking("s1"), result("s1", "out 1"), thinking("s2"), result("s2", "out 2")],
	...over,
});
const base = payload();
const swap = (i, m) => payload({ messages: base.messages.map((x, j) => (j === i ? m : x)) });

// messageClass
check("a user text message", G.messageClass(text("user", "hi")), "user");
check("a user message with string content", G.messageClass({ role: "user", content: "hi" }), "user");
check("an Anthropic tool result (role user, tool_result block)", G.messageClass(result("a", "x")), "tool_result");
check("an OpenAI tool message", G.messageClass({ role: "tool", tool_call_id: "a", content: "x" }), "tool_result");
check("an assistant message", G.messageClass(thinking("s")), "assistant");
check("a system message", G.messageClass({ role: "system", content: "s" }), "system");
check("a developer message counts as system", G.messageClass({ role: "developer", content: "s" }), "system");
check("an unknown role", G.messageClass({ role: "custom", content: "s" }), "other");
check("not a message", G.messageClass(null), "other");

// role and gap on message changes
{
	const c = G.comparePayloads(base, swap(2, result("s1", "out 1, edited")));
	check("an edited tool result: role and gap", [c.kind, c.role, c.gap], ["message", "tool_result", 2]);
}
{
	const c = G.comparePayloads(base, swap(0, text("user", "go now")));
	check("an edited user text: role and gap", [c.kind, c.role, c.gap], ["message", "user", 4]);
}
{
	const last = payload({ messages: [...base.messages.slice(0, 4), result("s2", "out 2 changed"), thinking("s3")] });
	const c = G.comparePayloads(base, last);
	check("an edit of the previous request's last message has gap 0", [c.kind, c.role, c.gap], ["message", "tool_result", 0]);
}
{
	const c = G.comparePayloads(base, swap(2, result("s1", "[cm-masked bash #0123456789] cat f (1 lines, 5B; cm_recall returns it)")));
	check("a condensed-milk mask carries the role too", [c.detail, c.role, c.gap], ["condensed-milk mask", "tool_result", 2]);
}
{
	const c = G.comparePayloads(base, payload({ messages: [base.messages[0], base.messages[2], base.messages[3], base.messages[4]] }));
	check("a removed assistant message", [c.kind, c.role, c.gap], ["removed", "assistant", 3]);
}
{
	const c = G.comparePayloads(base, payload({ messages: base.messages.slice(0, 3) }));
	check("messages removed at the end have no role", [c.kind, c.role ?? null, c.gap ?? null], ["removed", null, null]);
}
check("a tools change has no role, gap or span", (({ role, gap, span }) => [role ?? null, gap ?? null, span ?? null])(G.comparePayloads(base, payload({ tools: [tool("bash"), tool("x")] }))), [null, null, null]);
{
	const oa = { model: "x", messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }] };
	const c = G.comparePayloads(oa, { ...oa, messages: [{ role: "system", content: "sys 2" }, oa.messages[1]] });
	check("OpenAI style: an edited system message 0 has role system", [c.kind, c.role, c.gap], ["message", "system", 1]);
}

// span of a system change
{
	const c = G.comparePayloads(base, payload({ system: [{ type: "text", text: "You are pi. Today is Monday." }] }));
	check("text appended to the system prompt", [c.kind, c.span], ["system", { offset: 11, prevLength: 11, curLength: 28 }]);
}
{
	const c = G.comparePayloads(base, payload({ system: [{ type: "text", text: "Hello. You are pi." }] }));
	check("text put before the system prompt", c.span, { offset: 0, prevLength: 11, curLength: 18 });
}
{
	const two = (a, b) => payload({ system: [{ type: "text", text: a }, { type: "text", text: b }] });
	check("the span counts over all system blocks in order", G.comparePayloads(two("head", "tail 1"), two("head", "tail 2")).span, { offset: 9, prevLength: 10, curLength: 10 });
}
check("a string system prompt", G.comparePayloads({ ...base, system: "abc" }, { ...base, system: "abd" }).span, { offset: 2, prevLength: 3, curLength: 3 });
check("a block added with the same text before it", G.comparePayloads(base, payload({ system: [{ type: "text", text: "You are pi." }, { type: "text", text: "x" }] })).span, { offset: 11, prevLength: 11, curLength: 12 });

// changeExcerpt: for the opt-in debug log
{
	const cur = payload({ system: [{ type: "text", text: "You are pi. Today is Monday." }] });
	check("system excerpt starts at the first difference", G.changeExcerpt(base, cur, G.comparePayloads(base, cur)), { prev: "", cur: " Today is Monday." });
}
{
	const cur = swap(2, result("s1", "out 1, edited"));
	const e = G.changeExcerpt(base, cur, G.comparePayloads(base, cur));
	check("message excerpt shows both sides from the first difference", [e.prev.startsWith('"}]'), e.cur.startsWith(", edited")], [true, true]);
}
{
	const long = "x".repeat(5_000);
	const cur = payload({ system: [{ type: "text", text: `You are pi.${long}` }] });
	check("an excerpt is cut at EXCERPT_CHARS_MAX", G.changeExcerpt(base, cur, G.comparePayloads(base, cur)).cur.length, G.EXCERPT_CHARS_MAX);
}
check("no excerpt for a tools change", G.changeExcerpt(base, payload({ tools: [] }), G.comparePayloads(base, payload({ tools: [] }))), null);
check("no excerpt when nothing changed", G.changeExcerpt(base, base, G.comparePayloads(base, base)), null);

// gapBucket: telemetry histogram keys
check("gap buckets", [0, 1, 2, 9, 10, 500].map(G.gapBucket), ["0", "1", "2_9", "2_9", "10_plus", "10_plus"]);
check("a negative gap is a broken invariant", (() => { try { G.gapBucket(-1); return "no throw"; } catch (e) { return e.constructor.name; } })(), "RangeError");

done();
