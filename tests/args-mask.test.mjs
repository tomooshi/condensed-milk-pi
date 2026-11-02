/**
 * CM-ADR-005 spec, part C: mask the long string arguments of old edit, write
 * and bash calls at mask events.
 *
 * Laws: (1) only assistant messages before the cutoff change, and only the
 * long string leaves of edit/write calls and bash commands of 2,048+ chars;
 * `path` and short values stay; (2) a reference path is never masked; (3) the
 * placeholder bytes are exact and carry the arguments id
 * sha1(toolCallId + "\0args\0" + timestamp)[0..10]; (4) with the feature off the
 * output is 1.12.0's; (5) argsText round-trips: every argument comes back
 * byte-identical (property, seeded; replay with CM_SEED=<n>); (6) masking is
 * deterministic and changes no tool-call id, name, order or count.
 */
import { createHash } from "node:crypto";
import { loadTs, makeRunner, assistantCall, toolResult, userMsg, prng, seedFromEnv } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-005 C: masked tool-call arguments");
const cc = await loadTs("filters/context-compress.ts");
const am = await loadTs("filters/args-mask.ts");
const sid = (s, ts = 0) => createHash("sha1").update(`${s}\u0000${ts}`).digest("hex").slice(0, 10);
const aid = (callId, ts = 0) => sid(`${callId}\u0000args`, ts);

const LONG = "row\n".repeat(80) + "end"; // 81 lines, 323 chars
const SHORT = "x = 1";
const HEREDOC = "python3 - <<'EOF'\n" + "print(1)\n".repeat(300) + "EOF"; // 2,721 chars
const ON = { maskArgs: true };
const opts = (n, features = ON) => ({ previousCutoff: n, zoneEntered: 2, contextUsage: 0.9, features });
const callArgs = (m) => m.content.find((c) => c.type === "toolCall").arguments;

const history = () => [
	userMsg("go"),
	assistantCall("w1", "write", { path: "/repo/a.ts", content: LONG }), toolResult("w1", "write", "Successfully wrote 323 bytes"),
	assistantCall("e1", "edit", { path: "/repo/a.ts", edits: [{ oldText: LONG, newText: SHORT }] }), toolResult("e1", "edit", "Successfully replaced 1 block(s)"),
	assistantCall("b1", "bash", { command: HEREDOC }), toolResult("b1", "bash", "1\n".repeat(80)),
	assistantCall("b2", "bash", { command: "ls -la" }), toolResult("b2", "bash", "ok"),
	assistantCall("w2", "write", { path: "/repo/AGENTS.md", content: LONG }), toolResult("w2", "write", "Successfully wrote"),
	assistantCall("w3", "write", { path: "/repo/late.ts", content: LONG }), toolResult("w3", "write", "Successfully wrote"),
	userMsg("next"),
];

// (1)-(3) exact placeholders, scope and protection
{
	const msgs = history();
	const out = cc.compressStaleToolResults(msgs, opts(11)).messages;
	check("write content is masked", callArgs(out[1]), { path: "/repo/a.ts", content: `[cm-masked arg #${aid("w1")}] write content (81 lines, 323B)` });
	check("edit oldText is masked, short newText stays", callArgs(out[3]), {
		path: "/repo/a.ts",
		edits: [{ oldText: `[cm-masked arg #${aid("e1")}] edit edits[0].oldText (81 lines, 323B)`, newText: SHORT }],
	});
	check("a bash command of 2,048+ chars is masked", callArgs(out[5]), { command: `[cm-masked arg #${aid("b1")}] bash command (302 lines, 2.7KB)` });
	check("a short bash command stays", callArgs(out[7]), { command: "ls -la" });
	check("a reference path is never masked", callArgs(out[9]), { path: "/repo/AGENTS.md", content: LONG });
	check("calls after the cutoff stay", callArgs(out[11]), { path: "/repo/late.ts", content: LONG });
	check("tool-call ids, names and order unchanged", out.map((m) => m.content?.[0]?.id ?? m.role), msgs.map((m) => m.content?.[0]?.id ?? m.role));
	check("the input is not mutated", callArgs(msgs[1]).content, LONG);
}

// (4) feature off = 1.12.0 behavior
{
	const msgs = history();
	const off = cc.compressStaleToolResults(msgs, opts(11, { maskArgs: false }));
	check("feature off leaves arguments alone", off === null ? [] : off.messages.filter((m, i) => m !== msgs[i] && m.role === "assistant").length, 0);
	const none = cc.compressStaleToolResults(msgs, { previousCutoff: 11, zoneEntered: 2, contextUsage: 0.9 });
	check("no features option means off", none === null ? [] : none.messages.filter((m, i) => m !== msgs[i] && m.role === "assistant").length, 0);
}

// timestamp is part of the id (providers that reuse call ids, CM-ADR-001 amendment)
{
	const msgs = [userMsg("go"), assistantCall("bash:0", "write", { path: "/r/x", content: LONG }, 1_000), toolResult("bash:0", "write", "ok"), userMsg("n")];
	const out = cc.compressStaleToolResults(msgs, opts(3)).messages;
	check("the arguments id uses the assistant timestamp", callArgs(out[1]).content.slice(0, 30), `[cm-masked arg #${aid("bash:0", 1_000)}]`);
}

// maskable leaves
check("maskable leaves: edit", am.maskableLeaves("edit", { path: "/p", edits: [{ oldText: LONG, newText: LONG }] }).map((l) => l.key), ["edits[0].oldText", "edits[0].newText"]);
check("maskable leaves: path never", am.maskableLeaves("write", { path: "/" + "p".repeat(400), content: SHORT }).map((l) => l.key), []);
check("maskable leaves: other tools never", am.maskableLeaves("grep", { pattern: LONG }).map((l) => l.key), []);
check("maskable leaves: bash under 2,048 chars", am.maskableLeaves("bash", { command: "x".repeat(2047) }).map((l) => l.key), []);
check("maskable leaves: edits sent as one JSON string", am.maskableLeaves("edit", { path: "/p", edits: JSON.stringify([{ oldText: LONG, newText: SHORT }]) }).map((l) => l.key), ["edits"]);

// (5) argsText round trip, property
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const CASES_MAX = 300;
	const pick = (xs) => xs[Math.floor(rand() * xs.length)];
	const str = () => Array.from({ length: Math.floor(rand() * 12) }, () => pick(["a", "\n", "  ", "--- x (3 lines) ---", "é", "\t", "}", "\"", "line"])).join("");
	let bad = 0;
	for (let c = 0; c < CASES_MAX; c++) {
		const args = { path: `/r/${c}`, edits: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({ oldText: str(), newText: str() })), flag: rand() < 0.5, n: Math.floor(rand() * 9) };
		if (JSON.stringify(parseArgsText(am.argsText(args))) !== JSON.stringify(args)) bad++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	check("argsText round-trips every argument byte-identical", bad, 0);
}

// (6) determinism and invariants, property over random histories
{
	const seed = seedFromEnv() + 1;
	const rand = prng(seed);
	const CASES_MAX = 150;
	let unstable = 0;
	let shapeChanged = 0;
	let afterCutoffChanged = 0;
	for (let c = 0; c < CASES_MAX; c++) {
		const msgs = [userMsg("go")];
		const n = 2 + Math.floor(rand() * 10);
		for (let i = 0; i < n; i++) {
			const kind = ["write", "edit", "bash", "read"][Math.floor(rand() * 4)];
			const args = kind === "write" ? { path: `/r/${i}`, content: rand() < 0.5 ? LONG : SHORT }
				: kind === "edit" ? { path: `/r/${i}`, edits: [{ oldText: rand() < 0.5 ? LONG : SHORT, newText: LONG }] }
				: kind === "bash" ? { command: rand() < 0.5 ? HEREDOC : "ls" } : { path: `/r/${i}` };
			msgs.push(assistantCall(`k${i}`, kind, args, i), toolResult(`k${i}`, kind, LONG));
		}
		const cut = Math.floor(rand() * msgs.length);
		const a = cc.compressStaleToolResults(msgs, opts(cut));
		const b = cc.compressStaleToolResults(msgs, opts(cut));
		if (JSON.stringify(a) !== JSON.stringify(b)) unstable++;
		const out = a?.messages ?? msgs;
		if (out.length !== msgs.length || out.some((m, i) => m.role !== msgs[i].role || JSON.stringify((m.content ?? []).map((x) => [x.type, x.id, x.name])) !== JSON.stringify((msgs[i].content ?? []).map((x) => [x.type, x.id, x.name])))) shapeChanged++;
		if (out.some((m, i) => i >= cut && m.role === "assistant" && m !== msgs[i])) afterCutoffChanged++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed - 1})`);
	check("two passes give the same bytes", unstable, 0);
	check("no id, name, role, order or count changes", shapeChanged, 0);
	check("no assistant message at or after the cutoff changes", afterCutoffChanged, 0);
}

done();

/** Test-side parser of argsText: sections `--- <key> (<n> lines) ---` hold raw
 *  strings of exactly n lines; other lines are `<key>: <JSON>`. */
function parseArgsText(text) {
	const out = {};
	const lines = text.split("\n");
	const set = (key, value) => {
		const parts = key.match(/[^.[\]]+|\[\d+\]/g);
		let node = out;
		parts.forEach((p, i) => {
			const k = p.startsWith("[") ? Number(p.slice(1, -1)) : p;
			if (i === parts.length - 1) { node[k] = value; return; }
			if (node[k] === undefined) node[k] = parts[i + 1].startsWith("[") ? [] : {};
			node = node[k];
		});
	};
	for (let i = 0; i < lines.length; i++) {
		const section = /^--- (.+) \((\d+) lines\) ---$/.exec(lines[i]);
		if (section) {
			const n = Number(section[2]);
			set(section[1], lines.slice(i + 1, i + 1 + n).join("\n"));
			i += n;
			continue;
		}
		const scalar = /^(.+?): (.*)$/.exec(lines[i]);
		if (scalar) set(scalar[1], JSON.parse(scalar[2]));
	}
	return out;
}
