/**
 * v1.10.1 regression: masking state resets when the history shrinks.
 *
 * Spec: (1) a `session_tree` event (branch navigation) resets the cutoff and
 * zone exactly like `session_compact`. (2) A persisted cutoff larger than the
 * current message count is treated as a missed shrink and resets, instead of
 * clamping to "mask everything".
 *
 * Method: drive the real extension through a fake pi. Zone 0 (usage 0.35,
 * coverage 0.60) on 20 messages freezes the cutoff at 12. Then the history
 * changes, and the test reads which tool results come back masked.
 */
import { loadTs, makeFakePi, makeCtx, assistantCall, toolResult, textOf, makeRunner } from "./harness.mjs";

const { check, done } = makeRunner("v1.10.1 reset on branch change and on shrunk history");
const ext = (await loadTs("index.ts")).default;

const BIG = "x".repeat(200);
/** n messages: pairs of (assistant toolCall, bash toolResult). */
function history(n) {
	const out = [];
	for (let i = 0; out.length < n; i++) {
		out.push(assistantCall(`c${i}`, "bash", { command: `echo ${i}` }));
		if (out.length < n) out.push(toolResult(`c${i}`, "bash", `${BIG}${i}`));
	}
	return out;
}
function maskedIndexes(messages) {
	return messages.map((m, i) => (m.role === "toolResult" && textOf(m).startsWith("[cm-masked") ? i : -1)).filter((i) => i >= 0);
}
async function contextPass(fire, messages) {
	const res = await fire("context", { messages }, makeCtx({ tokens: 350_000 }));
	return maskedIndexes(res?.messages ?? messages);
}

// (1) session_tree resets: 15-message branch after a 20-message zone entry.
{
	const { pi, fire } = makeFakePi();
	ext(pi);
	await fire("session_start", { reason: "startup" }, makeCtx());
	check("zone 0 on 20 messages masks results below 12", await contextPass(fire, history(20)), [1, 3, 5, 7, 9, 11]);
	await fire("session_tree", {}, makeCtx());
	check("after session_tree the zone re-enters on the new branch (cutoff 9)", await contextPass(fire, history(15)), [1, 3, 5, 7]);
}

// (2) cutoff beyond the array resets, with no event at all.
{
	const { pi, fire } = makeFakePi();
	ext(pi);
	await fire("session_start", { reason: "startup" }, makeCtx());
	await contextPass(fire, history(20));
	check("a shrunk history (8 < cutoff 12) re-enters the zone (cutoff 4), not mask-all", await contextPass(fire, history(8)), [1, 3]);
}

done();
