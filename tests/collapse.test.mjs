/**
 * CM-ADR-005 spec, parts D and B1: changes that wait for a mask event.
 *
 * `eventHorizon` is the message count at the last mask event. Every decision
 * below uses only messages before it, so the bytes do not change between
 * mask events.
 *
 * D (collapseReads): an older read is masked when a newer successful read of
 * the same path and range exists before the horizon; an older bash result is
 * masked when a newer bash or read result before the horizon has the same
 * text. The newest read of a path and range is never masked.
 * B1 (batchInvalidation): bash invalidation (ADR-024) counts only invalidating
 * commands before the horizon.
 *
 * Property tests are seeded; replay with CM_SEED=<n>.
 */
import { createHash } from "node:crypto";
import { loadTs, makeRunner, assistantCall, toolResult, userMsg, textOf, prng, seedFromEnv } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-005 D and B1: collapse and batched invalidation");
const cc = await loadTs("filters/context-compress.ts");
const sid = (s, ts = 0) => createHash("sha1").update(`${s}\u0000${ts}`).digest("hex").slice(0, 10);

const A = "alpha\n".repeat(40) + "end"; // 41 lines, 243B
const B = "beta\n".repeat(40) + "end";
const D = { collapseReads: true };
const at = (horizon, features = D, cutoff = 1) => ({ previousCutoff: cutoff, zoneEntered: 2, contextUsage: 0.9, eventHorizon: horizon, features });
const run = (msgs, o) => cc.compressStaleToolResults(msgs, o)?.messages ?? msgs;
const read = (id, path, text, args = {}) => [assistantCall(id, "read", { path, ...args }), toolResult(id, "read", text)];
const bash = (id, command, text) => [assistantCall(id, "bash", { command }), toolResult(id, "bash", text)];

// D: superseded and identical reads
{
	const msgs = [userMsg("go"), ...read("r1", "/a.ts", A), ...read("r2", "/a.ts", B), ...read("r3", "/b.ts", A), ...read("r4", "/b.ts", A), userMsg("n")];
	const out = run(msgs, at(msgs.length));
	check("an older read with a newer read of the path is masked", textOf(out[2]), `[cm-masked read #${sid("r1")}] /a.ts (41 lines, 243B) — newer read #${sid("r2")}`);
	check("the newest read of a path stays", textOf(out[4]), B);
	check("an identical newer read says same text", textOf(out[6]), `[cm-masked read #${sid("r3")}] /b.ts (41 lines, 243B) — same text as #${sid("r4")}`);
	check("the newest identical read stays", textOf(out[8]), A);
}
{
	const msgs = [userMsg("go"), ...read("r1", "/a.ts", A, { offset: 1, limit: 50 }), ...read("r2", "/a.ts", B), ...read("r3", "/c.ts", A, { offset: 100 }), ...read("r4", "/c.ts", B, { offset: 100 }), userMsg("n")];
	const out = run(msgs, at(msgs.length));
	check("a range read is not superseded by a full read", textOf(out[2]), A);
	check("the same range is superseded", textOf(out[6]).endsWith(`— newer read #${sid("r4")}`), true);
}
{
	const msgs = [userMsg("go"), ...read("r1", "/a.ts", A), ...read("r2", "/a.ts", B), userMsg("n")];
	check("a newer read at or after the horizon does not count", textOf(run(msgs, at(3))[2]), A);
	const failed = [userMsg("go"), ...read("r1", "/a.ts", A), assistantCall("r2", "read", { path: "/a.ts" }), toolResult("r2", "read", "ENOENT: no such file " + "x".repeat(200), { isError: true }), userMsg("n")];
	check("a failed newer read does not count", textOf(run(failed, at(failed.length))[2]), A);
	check("feature off: 1.12.0 behavior", textOf(run(msgs, at(msgs.length, {}))[2]), A);
	const ref = [userMsg("go"), ...read("r1", "/repo/AGENTS.md", A), ...read("r2", "/repo/AGENTS.md", A), userMsg("n")];
	const refOut = run(ref, at(ref.length));
	check("an older copy of a reference file is collapsed", textOf(refOut[2]).startsWith(`[cm-masked read #${sid("r1")}]`), true);
	check("the newest copy of a reference file stays", textOf(refOut[4]), A);
}

// D: identical bash output
{
	const msgs = [userMsg("go"), ...bash("b1", "pytest -q", A), ...bash("b2", "pytest -q", A), ...bash("b3", "git log", B), ...bash("b4", "git log", A + "x"), userMsg("n")];
	const out = run(msgs, at(msgs.length));
	check("an older identical bash result is masked", textOf(out[2]), `[cm-masked bash #${sid("b1")}] pytest -q (41 lines, 243B) — same text as #${sid("b2")}`);
	check("the newest identical bash result stays", textOf(out[4]), A);
	check("a bash result with other text stays", textOf(out[6]), B);
}

// B1: invalidation waits for the next mask event
{
	const rules = cc.resolveRules(cc.emptyUserConfig()); // default rules include git add -> git status
	const msgs = [userMsg("go"), ...bash("s1", "git status", A), ...bash("a1", "git add -A", "ok"), userMsg("n")];
	const now = run(msgs, { ...at(0, {}), rules });
	check("1.12.0: git add invalidates git status at once", textOf(now[2]).startsWith(`[cm-masked bash #${sid("s1")}]`), true);
	const B1 = { batchInvalidation: true };
	check("batched: no mask before a mask event saw the git add", textOf(run(msgs, { ...at(4, B1), rules })[2]), A);
	check("batched: masked once a mask event saw it", textOf(run(msgs, { ...at(5, B1), rules })[2]).startsWith(`[cm-masked bash #${sid("s1")}]`), true);
}

// Properties: newest read never masked; nothing at or after the horizon changes; append-stable
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const CASES_MAX = 250;
	const rules = cc.resolveRules(cc.emptyUserConfig());
	let newestMasked = 0;
	let afterHorizon = 0;
	let appendUnstable = 0;
	for (let c = 0; c < CASES_MAX; c++) {
		const msgs = [userMsg("go")];
		const n = 3 + Math.floor(rand() * 12);
		for (let i = 0; i < n; i++) {
			const r = rand();
			const text = [A, B, A + i][Math.floor(rand() * 3)];
			if (r < 0.55) msgs.push(...read(`k${i}`, `/f${Math.floor(rand() * 3)}`, text, rand() < 0.3 ? { offset: 10 } : {}));
			else msgs.push(...bash(`k${i}`, ["git status", "git add -A", "pytest", "ls"][Math.floor(rand() * 4)], text));
		}
		const horizon = 1 + Math.floor(rand() * msgs.length);
		const o = { ...at(horizon, { collapseReads: true, batchInvalidation: true }), rules };
		const out = run(msgs, o);
		const newest = new Map();
		msgs.forEach((m, i) => {
			if (m.role !== "toolResult" || m.toolName !== "read") return;
			const args = msgs[i - 1].content[0].arguments;
			newest.set(`${args.path}|${args.offset}|${args.limit}`, i);
		});
		for (const i of newest.values()) if (textOf(out[i]) !== textOf(msgs[i])) newestMasked++;
		if (out.some((m, i) => i >= horizon && m !== msgs[i])) afterHorizon++;
		const longer = [...msgs, ...read("z1", "/f0", B), ...bash("z2", "git add -A", "ok")];
		const out2 = run(longer, o);
		if (JSON.stringify(out2.slice(0, msgs.length)) !== JSON.stringify(out)) appendUnstable++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	check("the newest read of a path and range is never masked", newestMasked, 0);
	check("nothing at or after the horizon changes (cutoff 1)", afterHorizon, 0);
	check("messages added after the horizon change nothing before it", appendUnstable, 0);
}

done();
