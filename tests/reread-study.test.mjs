/**
 * Spec for the pure part of the re-read study (bench/reread-lib.mjs,
 * CM-ADR-008 §6), on a trace small enough to check by hand.
 *
 * Session: 20 calls. /a is read at call 1 and masked at the mask event of
 * call 10; it is read again at call 15 (the request of call 14 showed the
 * placeholder). /b is read at call 8, masked at call 10 and never read again.
 * /a was last touched 9 calls before its mask, /b 2 calls before.
 */
import { loadTs, makeRunner } from "./harness.mjs";
import { lastTouchAtOrBefore, maskCallUnderRule, studySession, evaluateRule, CHARS_PER_TOKEN, PRICE_READ, PRICE_WRITE } from "../bench/reread-lib.mjs";

await loadTs("filters/text-metrics.ts"); // isolates HOME like every other test
const { check, done } = makeRunner("CM-ADR-008 re-read study core");

const trace = {
	calls: 20,
	maskEvents: [10, 16],
	maskedAt: { a1: 10, b1: 10 },
	touches: [
		{ t: 1, tool: "read", path: "/a", id: "a1", chars: 2_430, range: "|", hash: "h1" },
		{ t: 8, tool: "read", path: "/b", id: "b1", chars: 4_860, range: "|", hash: "h2" },
		{ t: 15, tool: "read", path: "/a", id: "a2", chars: 2_430, range: "|", hash: "h1", prev: { id: "a1", t: 1, state: "masked", sameRange: true, sameHash: true, chars: 2_430 } },
	],
};

check("newest touch at or before a call", [0, 1, 7, 15, 99].map((t) => lastTouchAtOrBefore([1, 15], t)), [null, 1, 1, 15, 15]);
check("K below the age at the mask: masked at the recorded call", maskCallUnderRule(10, [1, 15], [10, 16], 5), 10);
check("K at the age (9): kept at call 10; at event 16 the path was touched 1 call ago: kept to the end", maskCallUnderRule(10, [1, 15], [10, 16], 9), Number.POSITIVE_INFINITY);
check("a path not touched again is masked at the next event past K", maskCallUnderRule(10, [8], [10, 16], 2), 16);
check("the recorded mask is a decision point when it is not a listed event", maskCallUnderRule(12, [8], [10, 16], 2), 12);

const s = studySession(trace);
check("masked read results and their age at the mask", s.items.map((it) => [it.id, it.maskedAt, it.ageAtMask]), [["a1", 10, 9], ["b1", 10, 2]]);
check("the re-read: state, calls held, calls the new copy is carried", s.rereads.map((r) => [r.state, r.held, r.callsCarried, r.editedBetween, r.sameHash]), [["masked", 4, 5, false, true]]);
{
	const edited = studySession({ ...trace, touches: [trace.touches[0], { t: 5, tool: "edit", path: "/a", id: "e1", chars: 10, range: "|", hash: "x" }, trace.touches[1], trace.touches[2]] });
	check("an edit of the path between the two reads is seen", edited.rereads[0].editedBetween, true);
	check("the edit is a touch: /a is 5 calls old at its mask", edited.items[0].ageAtMask, 5);
}
check("not a trace line is an error", (() => { try { studySession({ calls: 1 }); return "no throw"; } catch (e) { return e.message; } })(), "studySession: not a --reads-out trace line");

// K = 5: /b (age 2) is kept from call 10 to event 16: 6 calls x 4,860 chars. /a (age 9) is masked; nothing avoided.
check("recency 5", evaluateRule([s], 5), { k: 5, protectedItems: 1, avoided: 0, benefitTokens: 0, costTokens: Math.round(((6 * 4_860) / CHARS_PER_TOKEN) * PRICE_READ), ratio: 0 });
// K = 9: /a is kept to the end (10 calls x 2,430) and the re-read is avoided. /b is 8 calls old at event 16,
// still within 9, so it is kept to the end too (10 calls x 4,860).
// test-edit: the first draft masked /b at event 16; 16 - 8 = 8 is within K = 9, so the draft was wrong.
{
	const cost = (((20 - 10) * 2_430 + (20 - 10) * 4_860) / CHARS_PER_TOKEN) * PRICE_READ;
	const benefit = (2_430 / CHARS_PER_TOKEN) * (PRICE_WRITE + PRICE_READ * 5);
	check("recency 9", evaluateRule([s], 9), { k: 9, protectedItems: 2, avoided: 1, benefitTokens: Math.round(benefit), costTokens: Math.round(cost), ratio: benefit / cost });
}
check("a rule with nothing to keep has no ratio", evaluateRule([studySession({ calls: 3, maskEvents: [], maskedAt: {}, touches: [] })], 5).ratio, null);

done();
