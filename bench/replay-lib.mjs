/**
 * Pure functions of the replay-cost harness (bench/replay-cost.mjs). No I/O,
 * no clock, no randomness except through an injected PRNG. Tested by
 * tests/bench-lib.test.mjs.
 *
 * Token model (fitted in bench/replay-cost.mjs --calibrate, never per call):
 *   prompt tokens = offset + Σ fixed tokens + Σ other characters / R
 * where fixed tokens are an assistant message's recorded output tokens (minus
 * its recorded reasoning tokens once its thinking is invalid) and IMAGE_TOKENS
 * per image, and `offset`
 * (tool schemas and request framing) is fitted once per session from its
 * first call. Cache model: a call within the cache lifetime of the last
 * cache touch reads the unchanged prefix of the previous request; otherwise
 * it reads nothing.
 */

/** inherited: Anthropic bills an image by pixels, about 1,600 tokens at the
 *  1.15-megapixel limit that pi resizes to (vision docs). Fixed, not fitted. */
export const IMAGE_TOKENS = 1_600;

/** Characters of a message's content as the request carries it, without
 *  image data (an image is billed by pixels, see imageCount). */
export function contentChars(message) {
	const content = message?.content;
	if (typeof content === "string") return content.length;
	const blocks = Array.isArray(content) ? content : [];
	return JSON.stringify(blocks.map((b) => (b?.type === "image" ? { type: "image" } : b))).length;
}

/** Number of image blocks in a message. */
export function imageCount(message) {
	const content = message?.content;
	return Array.isArray(content) ? content.filter((b) => b?.type === "image").length : 0;
}

/** Stable key for prefix comparison: identical objects share it cheaply. */
export function contentKey(message) {
	return `${message?.role}|${JSON.stringify(message?.content ?? null)}`;
}

/**
 * Index of the first message that differs between the previous request and
 * this one, comparing only the previous length (this request may append).
 * Returns `previous.length` when the previous request is a prefix of this one.
 * Messages that are the same object are equal without serialization.
 */
export function firstChangedIndex(previous, current) {
	const shared = Math.min(previous.length, current.length);
	for (let i = 0; i < shared; i++) {
		if (previous[i] === current[i]) continue;
		if (contentKey(previous[i]) !== contentKey(current[i])) return i;
	}
	return shared;
}

/**
 * Cache read of one call in characters and assistant tokens (the offset is
 * added later). `prefixEnd` is the first index that changed; `warm` says
 * whether the call is within the cache lifetime of the last touch.
 */
export function readPrefix(sizes, prefixEnd, warm) {
	if (!warm) return { chars: 0, assistantTokens: 0, offset: false };
	let chars = 0;
	let assistantTokens = 0;
	const end = Math.min(prefixEnd, sizes.length);
	for (let i = 0; i < end; i++) {
		chars += sizes[i].chars;
		assistantTokens += sizes[i].assistantTokens;
	}
	return { chars, assistantTokens, offset: true };
}

/** Tokens from the model terms. */
export function tokensOf({ chars, assistantTokens, offset }, model) {
	if (!(model.charsPerToken > 0)) throw new RangeError("tokensOf: charsPerToken must be positive");
	return (offset ? model.offset : 0) + assistantTokens + chars / model.charsPerToken;
}

/**
 * Fit characters per token from consecutive calls, where the offset cancels:
 *   Δ(recorded prompt) - Δ(assistant tokens) = Δ(characters) / R
 * Least squares through the origin on rows {dChars, dRest}. Returns R.
 */
export function fitCharsPerToken(rows) {
	const usable = rows.filter((r) => r.dChars > 0 && Number.isFinite(r.dRest));
	if (usable.length < 10) throw new Error(`fitCharsPerToken: only ${usable.length} usable rows`);
	const sxy = usable.reduce((s, r) => s + r.dChars * r.dRest, 0);
	const sxx = usable.reduce((s, r) => s + r.dChars * r.dChars, 0);
	const slope = sxy / sxx; // tokens per character
	if (!(slope > 0)) throw new Error(`fitCharsPerToken: non-positive slope ${slope}`);
	return 1 / slope;
}

/** Spearman rank correlation (average ranks for ties). */
export function spearman(xs, ys) {
	if (xs.length !== ys.length) throw new Error("spearman: length mismatch");
	if (xs.length < 3) throw new Error("spearman: need at least 3 pairs");
	const rank = (v) => {
		const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
		const r = new Array(v.length);
		for (let i = 0; i < order.length; ) {
			let j = i;
			while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
			for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1;
			i = j + 1;
		}
		return r;
	};
	const rx = rank(xs);
	const ry = rank(ys);
	const mean = (rx.length + 1) / 2;
	let num = 0;
	let dx = 0;
	let dy = 0;
	for (let i = 0; i < rx.length; i++) {
		num += (rx[i] - mean) * (ry[i] - mean);
		dx += (rx[i] - mean) ** 2;
		dy += (ry[i] - mean) ** 2;
	}
	return num / Math.sqrt(dx * dy);
}

/**
 * Paired bootstrap of the summed difference B - A over sessions: resample
 * sessions with replacement `resamples` times. Returns the point estimate and
 * the 2.5% / 97.5% percentiles.
 */
export function bootstrapPairedSum(diffs, resamples, rand) {
	if (diffs.length === 0) throw new Error("bootstrapPairedSum: no sessions");
	if (!(resamples >= 100)) throw new RangeError("bootstrapPairedSum: need at least 100 resamples");
	const sums = new Float64Array(resamples);
	for (let r = 0; r < resamples; r++) {
		let s = 0;
		for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rand() * diffs.length)];
		sums[r] = s;
	}
	sums.sort();
	const at = (q) => sums[Math.min(resamples - 1, Math.floor(q * resamples))];
	return { estimate: diffs.reduce((a, b) => a + b, 0), low: at(0.025), high: at(0.975) };
}
