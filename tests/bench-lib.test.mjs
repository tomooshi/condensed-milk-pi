/**
 * Spec for bench/replay-lib.mjs, the pure core of the replay-cost harness.
 * Laws: an unchanged request is a prefix of the next one; a cold call reads
 * nothing; the fitted R recovers a known R from noiseless rows; Spearman is 1
 * for any monotone transform; a zero difference bootstraps to zero.
 */
import { makeRunner, prng, seedFromEnv } from "./harness.mjs";
import {
	contentChars,
	imageCount,
	firstChangedIndex,
	readPrefix,
	tokensOf,
	fitCharsPerToken,
	spearman,
	bootstrapPairedSum,
} from "../bench/replay-lib.mjs";

const { check, done } = makeRunner("bench replay-lib");
const msg = (role, text) => ({ role, content: [{ type: "text", text }] });

// contentChars
check("string content counts characters", contentChars({ content: "abcd" }), 4);
check("array content counts its JSON", contentChars({ content: [{ type: "text", text: "ab" }] }), JSON.stringify([{ type: "text", text: "ab" }]).length);
check("image data is not counted as characters", contentChars({ content: [{ type: "image", data: "x".repeat(99999), mimeType: "image/png" }] }), JSON.stringify([{ type: "image" }]).length);
check("images are counted separately", imageCount({ content: [{ type: "image" }, { type: "text", text: "a" }, { type: "image" }] }), 2);

// firstChangedIndex
const a = [msg("user", "a"), msg("assistant", "b"), msg("toolResult", "c")];
check("same objects plus an append: prefix end is the old length", firstChangedIndex(a, [...a, msg("user", "d")]), 3);
check("equal content in new objects is unchanged", firstChangedIndex(a, a.map((m) => ({ ...m, content: [...m.content] }))), 3);
check("a masked middle result changes at its index", firstChangedIndex(a, [a[0], a[1], msg("toolResult", "[cm-masked bash #x]")]), 2);
check("a role change counts as a change", firstChangedIndex(a, [msg("custom", "a"), a[1], a[2]]), 0);
check("a shorter request changes at the cut", firstChangedIndex(a, a.slice(0, 2)), 2);

// readPrefix and tokensOf
const sizes = [{ chars: 400, assistantTokens: 0 }, { chars: 0, assistantTokens: 50 }, { chars: 800, assistantTokens: 0 }];
const model = { charsPerToken: 4, offset: 1000 };
check("warm call reads the unchanged prefix", readPrefix(sizes, 2, true), { chars: 400, assistantTokens: 50, offset: true });
check("cold call reads nothing", readPrefix(sizes, 3, false), { chars: 0, assistantTokens: 0, offset: false });
check("tokens add offset, assistant tokens and chars / R", tokensOf({ chars: 400, assistantTokens: 50, offset: true }, model), 1150);
check("no offset on a cold read", tokensOf({ chars: 0, assistantTokens: 0, offset: false }, model), 0);
let threw = false;
try { tokensOf({ chars: 1, assistantTokens: 0, offset: false }, { charsPerToken: 0, offset: 0 }); } catch { threw = true; }
check("R must be positive", threw, true);

// fitCharsPerToken recovers a known ratio
{
	const rows = Array.from({ length: 50 }, (_, i) => ({ dChars: 100 + i * 37, dRest: (100 + i * 37) / 3.7 }));
	check("noiseless rows recover R = 3.7", Math.round(fitCharsPerToken(rows) * 1000) / 1000, 3.7);
	let few = false;
	try { fitCharsPerToken(rows.slice(0, 5)); } catch { few = true; }
	check("too few rows is an error", few, true);
}

// spearman
check("monotone transform gives 1", spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25]), 1);
check("reversed order gives -1", spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
check("ties use average ranks", Math.round(spearman([1, 2, 2, 3], [1, 2, 2, 3]) * 1e9) / 1e9, 1);

// bootstrapPairedSum
{
	const seed = seedFromEnv();
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	const zero = bootstrapPairedSum([0, 0, 0, 0], 1000, prng(seed));
	check("zero differences give a zero interval", [zero.estimate, zero.low, zero.high], [0, 0, 0]);
	const pos = bootstrapPairedSum([5, 6, 7, 8, 9, 10], 2000, prng(seed));
	check("all-positive differences give a positive interval", pos.low > 0, true);
	check("the estimate is the plain sum", pos.estimate, 45);
	check("the interval contains the estimate", pos.low <= 45 && 45 <= pos.high, true);
	const again = bootstrapPairedSum([5, 6, 7, 8, 9, 10], 2000, prng(seed));
	check("the same seed gives the same interval", [again.low, again.high], [pos.low, pos.high]);
}

done();
