/**
 * Re-read study (CM-ADR-008 §6): would keeping recently used reads unmasked
 * avoid re-reads, and at what cost? Reads the trace that
 * `replay-cost.mjs run --reads-out reads.jsonl` writes for its first arm.
 * No model call, no session file; the trace holds file paths, so it and this
 * report's input stay on the operator's machine. The report has numbers only.
 *
 *   node bench/reread-study.mjs /tmp/cm-bench/reads.jsonl [--json out.json]
 *
 * Trace, one line per session:
 *   calls        model calls in the session
 *   maskEvents   calls at which the arm edited the prefix (a mask event)
 *   maskedAt     tool call id -> call at which its result was first masked
 *   touches      successful read/edit/write results in order: { t, tool, path, id, chars, range, hash,
 *                prev?: { id, t, state: masked|visible|gone, sameRange, sameHash, chars } }
 *                `t` is the number of calls made before the result; `prev` is the newest earlier
 *                read of the same path and its state in the request that asked for this read.
 *
 * Rule under study, "recency K": at a mask event, a read result stays
 * unmasked when its path was touched (read, edit or write) in the last K
 * calls. It is masked at the first later mask event at which that is no
 * longer true. First-order estimate: the session's other calls stay as
 * recorded. Two costs are NOT in the estimate and belong to the gate of a
 * real candidate: a kept result is a hole before the cutoff, so the mask
 * event that closes it rewrites the cache from the hole; and the count of
 * avoided re-reads assumes the model re-read only because of the mask.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { K_VALUES, dist, studySession, evaluateRule } from "./reread-lib.mjs";

function report(sessions) {
	const all = sessions.flatMap((s) => s.rereads);
	const masked = all.filter((r) => r.state === "masked");
	const items = sessions.flatMap((s) => s.items);
	const rereadIds = new Set(masked.map((r) => r.prevId));
	const byAge = K_VALUES.map((k) => {
		const young = items.filter((it) => it.ageAtMask <= k);
		const old = items.filter((it) => it.ageAtMask > k);
		const rate = (xs) => (xs.length === 0 ? null : xs.filter((it) => rereadIds.has(it.id)).length / xs.length);
		return { k, youngItems: young.length, youngRereadRate: rate(young), oldItems: old.length, oldRereadRate: rate(old) };
	});
	return {
		sessions: sessions.length,
		sessionsWithMasks: sessions.filter((s) => s.items.length > 0).length,
		calls: sessions.reduce((n, s) => n + s.calls, 0),
		reads: sessions.reduce((n, s) => n + s.reads, 0),
		maskedReadItems: items.length,
		readsOfAPathReadBefore: { total: all.length, earlierMasked: masked.length, earlierVisible: all.filter((r) => r.state === "visible").length, earlierGone: all.filter((r) => r.state === "gone").length },
		maskedRereads: {
			total: masked.length,
			editedBetween: masked.filter((r) => r.editedBetween).length,
			notEditedSameBytes: masked.filter((r) => !r.editedBetween && r.sameHash).length,
			notEditedOtherBytes: masked.filter((r) => !r.editedBetween && !r.sameHash).length,
			sameRange: masked.filter((r) => r.sameRange).length,
			callsHeld: dist(masked.map((r) => r.held)),
			ageAtMask: dist(masked.map((r) => r.ageAtMask)),
		},
		allMaskedItemsAgeAtMask: dist(items.map((it) => it.ageAtMask)),
		rereadRateByAge: byAge,
		rules: K_VALUES.map((k) => evaluateRule(sessions, k)),
	};
}

const tracePath = process.argv[2];
if (!tracePath) {
	console.error("usage: reread-study.mjs READS.jsonl [--json OUT.json]");
	process.exit(2);
}
const sessions = readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map((l) => studySession(JSON.parse(l)));
const result = report(sessions);
const jsonAt = process.argv.indexOf("--json");
if (jsonAt >= 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
