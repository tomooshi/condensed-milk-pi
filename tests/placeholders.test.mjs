/**
 * CM-ADR-001 spec: addressable placeholders.
 *
 * Laws checked: (1) exact placeholder bytes per tool kind; (2) the id is the
 * first 10 hex of sha1(toolCallId); (3) masking is deterministic and changes
 * only the text of masked tool results, never order, count, roles or ids
 * (property test over seeded random histories; replay with CM_SEED=<n>);
 * (4) legacy placeholders stay untouched; (5) built-in profiles carry {id},
 * and a custom template without {id} produces a profile warning.
 */
import { createHash } from "node:crypto";
import { loadTs, makeRunner, assistantCall, toolResult, userMsg, textOf, prng, seedFromEnv } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-001 addressable placeholders");
const cc = await loadTs("filters/context-compress.ts");
const profiles = await loadTs("filters/profiles.ts");
const sid = (s) => createHash("sha1").update(s).digest("hex").slice(0, 10);

const BIG = "line\n".repeat(40) + "end"; // 41 lines, 203 chars
const ALL_MASKED = { previousCutoff: 1_000, zoneEntered: 2, contextUsage: 0.9 };

// (1) exact bytes
{
	const msgs = [
		userMsg("go"),
		assistantCall("c0", "bash", { command: "git status" }), toolResult("c0", "bash", BIG),
		assistantCall("r0", "read", { path: "/repo/src/a.ts" }), toolResult("r0", "read", BIG),
		assistantCall("k0", "cm_recall", { id: "#3f9a2c1d7e", grep: "err" }), toolResult("k0", "cm_recall", BIG),
		assistantCall("u0", "bash", {}), toolResult("u0", "bash", BIG),
		userMsg("next"),
	];
	const out = cc.compressStaleToolResults(msgs, { ...ALL_MASKED, previousCutoff: msgs.length }).messages;
	check("bash placeholder", textOf(out[2]), `[cm-masked bash #${sid("c0")}] git status (41 lines, 203B)`);
	check("read placeholder", textOf(out[4]), `[cm-masked read #${sid("r0")}] /repo/src/a.ts (41 lines, 203B)`);
	check("recall placeholder", textOf(out[6]), `[cm-masked recall #${sid("k0")}] id=3f9a2c1d7e grep="err" (41 lines, 203B)`);
	check("bash with unknown command", textOf(out[8]), `[cm-masked bash #${sid("u0")}] (command unknown) (41 lines, 203B)`);
	check("a long command is cut to 80 chars", textOf(cc.compressStaleToolResults(
		[assistantCall("L", "bash", { command: "x".repeat(100) }), toolResult("L", "bash", BIG), userMsg("n")],
		{ ...ALL_MASKED, previousCutoff: 3 },
	).messages[1]), `[cm-masked bash #${sid("L")}] ${"x".repeat(80)} (41 lines, 203B)`);
}

// (4) legacy placeholders are not re-masked
{
	const legacy = [
		assistantCall("a", "bash", { command: "ls" }), toolResult("a", "bash", "[cm-masked bash] ls" + " ".repeat(200)),
		assistantCall("b", "read", { path: "/x" }), toolResult("b", "read", "[masked read] /x" + " ".repeat(200)),
		userMsg("n"),
	];
	check("legacy placeholders stay as they are", cc.compressStaleToolResults(legacy, { ...ALL_MASKED, previousCutoff: 5 }), null);
}

// (3) property: determinism and structure preservation
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const TOOLS = ["bash", "read", "edit", "cm_recall"];
	const HISTORIES_MAX = 200;
	const PAIRS_MAX = 30;
	let violations = 0;
	let masked = 0;
	for (let h = 0; h < HISTORIES_MAX; h++) {
		const msgs = [userMsg("start")];
		const pairs = 1 + Math.floor(rand() * PAIRS_MAX);
		for (let i = 0; i < pairs; i++) {
			const tool = TOOLS[Math.floor(rand() * TOOLS.length)];
			const id = `t${h}_${i}_${Math.floor(rand() * 1e9)}`;
			const args = tool === "read" ? { path: `/p/${i}.ts` } : tool === "cm_recall" ? { match: `m${i}` } : { command: `cmd ${i}` };
			msgs.push(assistantCall(id, tool, args));
			msgs.push(toolResult(id, tool, "z".repeat(50 + Math.floor(rand() * 400)), { isError: rand() < 0.1 }));
		}
		const opts = { ...ALL_MASKED, previousCutoff: Math.floor(rand() * (msgs.length + 1)) };
		const first = cc.compressStaleToolResults(msgs, opts);
		const second = cc.compressStaleToolResults(msgs, opts);
		if (JSON.stringify(first) !== JSON.stringify(second)) violations++;
		const out = first?.messages ?? msgs;
		if (out.length !== msgs.length) violations++;
		out.forEach((m, i) => {
			const before = msgs[i];
			if (JSON.stringify(m) === JSON.stringify(before)) return;
			const text = textOf(m);
			const ok = m.role === "toolResult" && m.role === before.role && m.toolCallId === before.toolCallId &&
				m.toolName === before.toolName && text.startsWith("[cm-masked ") && text.includes(`#${sid(m.toolCallId)}]`);
			if (!ok) violations++;
			else masked++;
		});
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed}); masked ${masked} results`);
	check("masking is deterministic and changes only masked tool-result text", violations, 0);
}

// (5) profiles
{
	const want = {
		bash: "[cm-masked bash #{id}] {cmd} ({n} lines, {size})",
		read: "[cm-masked read #{id}] {path} ({n} lines, {size})",
		recall: "[cm-masked recall #{id}] {cmd} ({n} lines, {size})",
	};
	check("default profile templates", profiles.BUILT_IN_PROFILES.default.placeholderFormat, want);
	check("qwen-vllm profile templates", profiles.BUILT_IN_PROFILES["qwen-vllm"].placeholderFormat, want);
	const r = profiles.resolveProfile("default", { default: { placeholderFormat: { bash: "[cm-masked bash] {cmd}" } } });
	check("a template without {id} warns", r.warnings.some((w) => w.includes("{id}") && w.includes("bash")), true);
	check("the template is still used", r.profile.placeholderFormat.bash, "[cm-masked bash] {cmd}");
	check("renderPlaceholder fills {id}", profiles.renderPlaceholder("#{id} {cmd}", { id: "abc", cmd: "ls" }), "#abc ls");
}

done();
