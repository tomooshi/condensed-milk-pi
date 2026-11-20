/**
 * Pure functions of the re-read study (bench/reread-study.mjs, CM-ADR-008 §6).
 * No I/O. Tested by tests/reread-study.test.mjs. The trace format is in the
 * header of bench/reread-study.mjs.
 */

/** The K values compared. arbitrary: spans the observed median turns held (7 and 32 in two exports). */
export const K_VALUES = [3, 5, 10, 20, 40];
/** inherited: bench/replay-cost.mjs DEFAULT_CHARS_PER_TOKEN. */
export const CHARS_PER_TOKEN = 2.43;
/** inherited: Anthropic price ratios to uncached input (cache read, 5-minute cache write). */
export const PRICE_READ = 0.1;
export const PRICE_WRITE = 1.25;

export const quantile = (sorted, q) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
export const dist = (values) => {
	const s = values.slice().sort((a, b) => a - b);
	return { n: s.length, p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75), p90: quantile(s, 0.9) };
};

/** Newest touch time of each path at or before `t`, from that path's sorted touch times. */
export function lastTouchAtOrBefore(times, t) {
	let lo = 0;
	let hi = times.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (times[mid] <= t) lo = mid + 1;
		else hi = mid;
	}
	return lo === 0 ? null : times[lo - 1];
}

/** Call at which a read result is masked under recency K: the first mask
 *  event at or after its recorded mask whose distance to the path's newest
 *  touch is more than K. Infinity when no such event exists. */
export function maskCallUnderRule(maskedAt, pathTimes, maskEvents, k) {
	// The recorded mask is a decision point too, also when it was not counted as an edit (a cold start).
	for (const e of [maskedAt, ...maskEvents.filter((x) => x > maskedAt)]) {
		const last = lastTouchAtOrBefore(pathTimes, e);
		if (last === null || e - last > k) return e;
	}
	return Number.POSITIVE_INFINITY;
}

/** Everything the report needs from one session's trace. */
export function studySession(session) {
	const { touches, maskedAt, maskEvents, calls } = session;
	if (!Array.isArray(touches) || typeof maskedAt !== "object") throw new Error("studySession: not a --reads-out trace line");
	const timesByPath = new Map();
	for (const x of touches) timesByPath.set(x.path, [...(timesByPath.get(x.path) ?? []), x.t]);
	const order = new Map(touches.map((x, i) => [x.id, i]));
	const reads = touches.filter((x) => x.tool === "read");
	// Every read result that was masked at some call: the items a rule could protect.
	const items = reads.filter((x) => maskedAt[x.id] !== undefined).map((x) => {
		const at = maskedAt[x.id];
		const last = lastTouchAtOrBefore(timesByPath.get(x.path), at);
		return { id: x.id, path: x.path, chars: x.chars, maskedAt: at, ageAtMask: at - (last ?? x.t) };
	});
	const itemById = new Map(items.map((it) => [it.id, it]));
	const rereads = reads.filter((x) => x.prev).map((x) => {
		const from = order.get(x.prev.id);
		const to = order.get(x.id);
		const editedBetween = from !== undefined && touches.slice(from + 1, to).some((y) => y.path === x.path && y.tool !== "read");
		const item = itemById.get(x.prev.id);
		return {
			state: x.prev.state, sameHash: x.prev.sameHash, sameRange: x.prev.sameRange, editedBetween, t: x.t, chars: x.chars, path: x.path,
			prevId: x.prev.id, held: item ? x.t - 1 - item.maskedAt : null, ageAtMask: item ? item.ageAtMask : null,
			// Calls the new copy stays in the request unmasked: the price of the duplicate.
			callsCarried: Math.max(0, (maskedAt[x.id] ?? calls) - x.t),
		};
	});
	return { calls, reads: reads.length, items, rereads, timesByPath, maskEvents };
}

/** Benefit and cost of recency K over the studied sessions, in input-token equivalents. */
export function evaluateRule(sessions, k) {
	let protectedItems = 0;
	let keptCharCalls = 0;
	let avoided = 0;
	let avoidedTokens = 0;
	for (const s of sessions) {
		const maskCall = new Map(s.items.map((it) => [it.id, maskCallUnderRule(it.maskedAt, s.timesByPath.get(it.path), s.maskEvents, k)]));
		for (const it of s.items) {
			const until = Math.min(maskCall.get(it.id), s.calls);
			if (until > it.maskedAt) protectedItems++;
			keptCharCalls += (until - it.maskedAt) * it.chars;
		}
		for (const r of s.rereads) {
			if (r.state !== "masked") continue;
			const at = maskCall.get(r.prevId);
			if (at === undefined) throw new Error("evaluateRule: a masked earlier read has no mask call");
			if (at <= r.t - 1) continue;
			avoided++;
			avoidedTokens += (r.chars / CHARS_PER_TOKEN) * (PRICE_WRITE + PRICE_READ * r.callsCarried);
		}
	}
	const costTokens = (keptCharCalls / CHARS_PER_TOKEN) * PRICE_READ;
	return { k, protectedItems, avoided, benefitTokens: Math.round(avoidedTokens), costTokens: Math.round(costTokens), ratio: costTokens > 0 ? avoidedTokens / costTokens : null };
}
