/**
 * CM-ADR-005 spec, part B1: bash invalidation (ADR-024) counts only
 * invalidating commands before `eventHorizon`, the message count at the last
 * mask event, so its bytes do not change between mask events.
 *
 * test-edit: D (collapse) failed its pre-registered gate (docs §12) and was
 * removed in 1.13.0; its checks left this file, the B1 checks are unchanged.
 * Property tests are seeded; replay with CM_SEED=<n>.
 */
import { createHash } from "node:crypto";
import { loadTs, makeRunner, assistantCall, toolResult, userMsg, textOf, prng, seedFromEnv } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-005 B1: batched invalidation");
const cc = await loadTs("filters/context-compress.ts");
const sid = (s, ts = 0) => createHash("sha1").update(`${s}\u0000${ts}`).digest("hex").slice(0, 10);

const A = "alpha\n".repeat(40) + "end"; // 41 lines, 243B
const B = "beta\n".repeat(40) + "end";
const at = (horizon, features = {}, cutoff = 1) => ({ previousCutoff: cutoff, zoneEntered: 2, contextUsage: 0.9, eventHorizon: horizon, features });
const run = (msgs, o) => cc.compressStaleToolResults(msgs, o)?.messages ?? msgs;
const read = (id, path, text, args = {}) => [assistantCall(id, "read", { path, ...args }), toolResult(id, "read", text)];
const bash = (id, command, text) => [assistantCall(id, "bash", { command }), toolResult(id, "bash", text)];

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

// Properties: nothing at or after the horizon changes; append-stable
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const CASES_MAX = 250;
	const rules = cc.resolveRules(cc.emptyUserConfig());
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
		const o = { ...at(horizon, { batchInvalidation: true }), rules };
		const out = run(msgs, o);
		if (out.some((m, i) => i >= horizon && m !== msgs[i])) afterHorizon++;
		const longer = [...msgs, ...read("z1", "/f0", B), ...bash("z2", "git add -A", "ok")];
		const out2 = run(longer, o);
		if (JSON.stringify(out2.slice(0, msgs.length)) !== JSON.stringify(out)) appendUnstable++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	check("nothing at or after the horizon changes (cutoff 1)", afterHorizon, 0);
	check("messages added after the horizon change nothing before it", appendUnstable, 0);
}

done();
