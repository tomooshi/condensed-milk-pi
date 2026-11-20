/**
 * CM-ADR-008 §1 spec: `cm_recall` accepts a leading PCRE-style inline flag
 * group in `grep`.
 *
 * Field data (issue #5, 1,223 sessions): 8 of 12 recall errors were a pattern
 * such as `(?i)wrap|close`, which JavaScript's RegExp rejects. compileGrep
 * moves a leading `(?i)`, `(?m)` or `(?s)` group into RegExp flags. Any other
 * inline flag is an error that names the flag. A group that is not first is
 * left to RegExp.
 */
import { createHash } from "node:crypto";
import { loadTs, makeRunner, assistantCall, toolResult, userMsg, entriesFor, prng, seedFromEnv } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-008 recall grep inline flags");
const R = await loadTs("filters/recall.ts");
const sid = (s, ts = 0) => createHash("sha1").update(`${s}\u0000${ts}`).digest("hex").slice(0, 10);
const shape = (c) => (c.kind === "ok" ? ["ok", c.regex.source, c.regex.flags] : ["error", c.text]);
const HINT = "grep is a JavaScript regular expression; a leading (?i), (?m) or (?s) is accepted.";

check("no inline flags: the pattern is used as given", shape(R.compileGrep("wrap|close")), ["ok", "wrap|close", ""]);
check("(?i) becomes the i flag", shape(R.compileGrep("(?i)wrap|close|settle")), ["ok", "wrap|close|settle", "i"]);
check("several flags in one group", shape(R.compileGrep("(?ims)a.b")), ["ok", "a.b", "ims"]);
check("a repeated flag is used once", shape(R.compileGrep("(?ii)a")), ["ok", "a", "i"]);
check("flags only: the empty pattern matches every line", R.compileGrep("(?i)").regex.test("anything"), true);
check("an unsupported inline flag is named", shape(R.compileGrep("(?x)a b")), ["error", `invalid grep pattern: inline flag "x" is not supported. ${HINT}`]);
check("one unsupported flag among supported ones is named", shape(R.compileGrep("(?ix)a")), ["error", `invalid grep pattern: inline flag "x" is not supported. ${HINT}`]);
check("a broken pattern keeps the RegExp reason and adds the hint", [R.compileGrep("(").kind, R.compileGrep("(").text.startsWith("invalid grep pattern: "), R.compileGrep("(").text.endsWith(` ${HINT}`)], ["error", true, true]);
check("a flag group that is not first is left to RegExp (an error)", R.compileGrep("a(?i)b").kind, "error");
check("a non-capturing group is not a flag group", shape(R.compileGrep("(?:a|b)c")), ["ok", "(?:a|b)c", ""]);
check("a lookahead is not a flag group", shape(R.compileGrep("(?=a)a")), ["ok", "(?=a)a", ""]);
check("the compiled pattern is never global or sticky (stateful test)", /[gy]/.test(R.compileGrep("(?i)a").regex.flags), false);

// through the recall pipeline
{
	const OUT = ["Wrap the order", "close position", "nothing", "SETTLE trade"].join("\n");
	const msgs = [userMsg("go"), assistantCall("c1", "bash", { command: "cat log" }), toolResult("c1", "bash", OUT), { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0 }];
	const scan = R.buildRecords(entriesFor(msgs).map(R.lightEntry), R.RECALL_SCAN_ENTRIES_MAX);
	const run = (request) => {
		const plan = R.planRecall(scan.records, request, scan);
		if (plan.kind !== "fetch") return plan;
		return R.renderRecall({ record: plan.record, text: OUT, raw: undefined, request, bytesMax: 51_200, linesMax: 2_000 });
	};
	const body = (r) => r.text.split("\n\n").slice(1).join("\n\n");
	check("(?i) in a recall keeps the lines of any case", body(run({ id: sid("c1"), grep: "(?i)wrap|close|settle" })), "1: Wrap the order\n2: close position\n4: SETTLE trade");
	check("without the flag the match is case-sensitive", body(run({ id: sid("c1"), grep: "wrap|close|settle" })), "2: close position");
	check("the second line shows the pattern as the agent wrote it", run({ id: sid("c1"), grep: "(?i)wrap" }).text.split("\n")[1], "Matching /(?i)wrap/ in lines 1-4 of 4: 1 line(s).");
	check("an unsupported flag is a recall error", run({ id: sid("c1"), grep: "(?x)a" }), { kind: "error", text: `cm_recall: invalid grep pattern: inline flag "x" is not supported. ${HINT}` });
}

// property: (?i)<literal> matches exactly the lines that contain the literal in any case
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const CASES = 500;
	const ALPHABET = "abcXYZ019 _-";
	const word = (n) => Array.from({ length: n }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join("");
	let wrong = 0;
	for (let c = 0; c < CASES; c++) {
		const needle = word(1 + Math.floor(rand() * 3));
		const line = word(Math.floor(rand() * 12));
		const expected = line.toLowerCase().includes(needle.toLowerCase());
		const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (R.compileGrep(`(?i)${escaped}`).regex.test(line) !== expected) wrong++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	check(`${CASES} random literals: (?i) equals a case-insensitive contains`, wrong, 0);
}

done();
