/**
 * CM-ADR-002 §1 spec: the pure recall core (filters/recall.ts).
 *
 * Pipeline under test, as index.ts uses it:
 *   lightEntry(entry) → buildRecords(branch) → planRecall(records, request, scan)
 *   → (fetch) → renderRecall({ record, text, raw, request, bytesMax, linesMax }).
 * Laws: recall by id returns the original bytes exactly (property, seeded);
 * every error case returns its exact message; outputs respect the caps.
 */
import { createHash } from "node:crypto";
import { loadTs, makeRunner, assistantCall, toolResult, userMsg, entriesFor, prng, seedFromEnv } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-002 recall core");
const R = await loadTs("filters/recall.ts");
const cc = await loadTs("filters/context-compress.ts");
// CM-ADR-001 amendment: the id key is toolCallId + "\0" + timestamp; the builders use timestamp 0.
const sid = (s, ts = 0) => createHash("sha1").update(`${s}\u0000${ts}`).digest("hex").slice(0, 10);

const OUT = Array.from({ length: 30 }, (_, i) => `row ${i + 1}${i === 4 ? " ERROR here" : ""}`).join("\n");
const SIZE = cc.formatSize(OUT.length);
const msgs = [
	userMsg("go"),
	assistantCall("c0", "bash", { command: "pytest -q" }), toolResult("c0", "bash", "3 passed", { details: { condensedMilk: { raw: OUT } } }),
	assistantCall("c1", "bash", { command: "git status" }), toolResult("c1", "bash", OUT),
	assistantCall("c2", "bash", { command: "env" }), toolResult("c2", "bash", "PATH=/bin", { details: { condensedMilk: { rawWithheld: "secret" } } }),
	assistantCall("r0", "read", { path: "/a/b.ts" }), toolResult("r0", "read", OUT),
	{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 0 },
];
const entries = entriesFor(msgs);
const byEntryId = new Map(entries.map((e) => [e.id, e.message]));
const scan = R.buildRecords(entries.map(R.lightEntry), R.RECALL_SCAN_ENTRIES_MAX);
const CAPS = { bytesMax: R.RECALL_OUTPUT_BYTES_MAX, linesMax: R.RECALL_OUTPUT_LINES_MAX };

/** The index.ts pipeline, minus I/O. */
function recall(request, s = scan, caps = CAPS) {
	const plan = R.planRecall(s.records, request, s);
	if (plan.kind !== "fetch") return plan;
	const message = byEntryId.get(plan.record.entryId);
	return R.renderRecall({ record: plan.record, text: R.toolResultText(message), raw: message.details?.condensedMilk?.raw, request, ...caps });
}
const h1 = (id, tool, label, turns, kind = "original output as first shown") =>
	`[cm-recall #${id}] ${tool}: ${label} — ${kind}, ${turns} turns ago, not the current state.`;

// ids
check("shortId is sha1 hex, first 10", R.shortId("c1", 0), sid("c1"));
check("parseRecallId accepts # and upper case", R.parseRecallId("#ABCDEF0123"), "abcdef0123");
check("parseRecallId rejects a short id", R.parseRecallId("abc"), null);
check("records are newest first", scan.records.map((r) => r.toolCallId), ["r0", "c2", "c1", "c0"]);
check("turns ago counts later assistant messages", scan.records.map((r) => r.turnsAgo), [1, 2, 3, 4]);

// by id
{
	const r = recall({ id: sid("c1") });
	check("id: ok", r.kind, "ok");
	check("id: exact text", r.text, `${h1(sid("c1"), "bash", "git status", 3)}\nLines 1-30 of 30 (${SIZE}).\n\n${OUT}`);
	check("id with #: same text", recall({ id: `#${sid("c1")}` }).text, r.text);
	check("read result label is the path", recall({ id: sid("r0") }).text.split("\n")[0], h1(sid("r0"), "read", "/a/b.ts", 1));
}
// a provider that reuses call ids in every turn (Kimi via OpenRouter: "bash:0")
{
	const reused = [
		userMsg("go"),
		assistantCall("bash:0", "bash", { command: "date" }), toolResult("bash:0", "bash", "first output", { timestamp: 1_000 }),
		assistantCall("bash:0", "bash", { command: "uptime" }), toolResult("bash:0", "bash", "second output", { timestamp: 2_000 }),
	];
	const ents = entriesFor(reused);
	const s = R.buildRecords(ents.map(R.lightEntry), R.RECALL_SCAN_ENTRIES_MAX);
	check("reused call ids get distinct ids", s.records.map((r) => r.id), [sid("bash:0", 2_000), sid("bash:0", 1_000)]);
	const older = R.planRecall(s.records, { id: sid("bash:0", 1_000) }, s);
	check("the older result is found by its own id", older.record?.entryId, "e2");
	const masked = cc.compressStaleToolResults([...reused, userMsg("n")].map((m) => ({ ...m, content: m.role === "toolResult" ? [{ type: "text", text: "x".repeat(200) }] : m.content })),
		{ previousCutoff: 6, zoneEntered: 2, contextUsage: 0.9 }).messages;
	check("placeholders use the same ids", [masked[2], masked[4]].map((m) => /#([0-9a-f]{10})\]/.exec(m.content[0].text)[1]), [sid("bash:0", 1_000), sid("bash:0", 2_000)]);
}
// window and grep
{
	const lines = OUT.split("\n");
	check("offset+limit", recall({ id: sid("c1"), offset: 5, limit: 3 }).text,
		`${h1(sid("c1"), "bash", "git status", 3)}\nLines 5-7 of 30 (${SIZE}).\n\n${lines.slice(4, 7).join("\n")}`);
	check("grep", recall({ id: sid("c1"), grep: "ERROR" }).text,
		`${h1(sid("c1"), "bash", "git status", 3)}\nMatching /ERROR/ in lines 1-30 of 30: 1 line(s).\n\n5: row 5 ERROR here`);
	check("grep with no match", recall({ id: sid("c1"), grep: "nope" }).text.endsWith("0 line(s).\n\n(no lines match)"), true);
}
// raw
{
	check("raw of a filtered result", recall({ id: sid("c0"), raw: true }).text,
		`${h1(sid("c0"), "bash", "pytest -q", 4, "raw output from before the condensed-milk filter")}\nLines 1-30 of 30 (${SIZE}).\n\n${OUT}`);
	check("raw of an unfiltered result", recall({ id: sid("c1"), raw: true }).text.split("\n")[0],
		h1(sid("c1"), "bash", "git status", 3, "original output as first shown (no filter changed it, so it is also the raw output)"));
	check("raw withheld for secrets", recall({ id: sid("c2"), raw: true }),
		{ kind: "error", text: `cm_recall: #${sid("c2")} has no raw text, because its filter hides secrets.` });
}
// match
{
	check("match", recall({ match: "GIT" }),
		{ kind: "match", text: `[cm-recall match "GIT"] 1 of 1 tool results, newest first:\n#${sid("c1")} · 3 turns ago · bash · git status · 30 lines, ${SIZE}` });
	const many = [userMsg("go")];
	for (let i = 0; i < 12; i++) many.push(assistantCall(`e${i}`, "bash", { command: `echo ${i}` }), toolResult(`e${i}`, "bash", `out ${i}`));
	const s = R.buildRecords(entriesFor(many).map(R.lightEntry), R.RECALL_SCAN_ENTRIES_MAX);
	const text = R.planRecall(s.records, { match: "echo" }, s).text;
	check("match caps rows at RECALL_MATCH_ROWS_MAX", text.split("\n").length, 1 + R.RECALL_MATCH_ROWS_MAX + 1);
	check("match says how many more", text.split("\n").at(-1), "… 2 more. Give a longer match.");
	check("match with nothing", R.planRecall(s.records, { match: "zzz" }, s).text, `[cm-recall match "zzz"] nothing matches on this branch (scanned 25 entries).`);
}
// errors
{
	const err = (text) => ({ kind: "error", text });
	check("neither id nor match", recall({}), err("cm_recall: give exactly one of id or match."));
	check("both id and match", recall({ id: sid("c1"), match: "x" }), err("cm_recall: give exactly one of id or match."));
	check("malformed id", recall({ id: "xyz" }), err(`cm_recall: id must be 10 hex characters, for example #3f9a2c1d7e (got "xyz").`));
	check("grep with match", recall({ match: "x", grep: "y" }), err("cm_recall: grep, offset, limit and raw work only with id."));
	check("offset 0", recall({ id: sid("c1"), offset: 0 }), err("cm_recall: offset must be a whole number of at least 1 (got 0)."));
	check("limit 1.5", recall({ id: sid("c1"), limit: 1.5 }), err("cm_recall: limit must be a whole number of at least 1 (got 1.5)."));
	check("empty match", recall({ match: "" }), err("cm_recall: match must not be empty."));
	check("invalid grep", recall({ id: sid("c1"), grep: "(" }).text.startsWith("cm_recall: invalid grep pattern: "), true);
	check("offset past end", recall({ id: sid("c1"), offset: 31 }), err(`cm_recall: offset 31 is past the end of #${sid("c1")} (30 lines).`));
	check("unknown id", recall({ id: "0000000000" }), err("cm_recall: no tool result #0000000000 on this branch (scanned 10 entries). Use match to find ids."));
	const small = R.buildRecords(entries.map(R.lightEntry), 4);
	check("scan bound named in the error", recall({ id: "0000000000" }, small),
		err("cm_recall: no tool result #0000000000 in the newest 4 entries (RECALL_SCAN_ENTRIES_MAX). Use match, or check the id."));
	const dup = [...scan.records, { ...scan.records[2], toolCallId: "other", label: "git log", entryId: "eX" }];
	check("ambiguous id", R.findById(dup, sid("c1")).kind, "ambiguous");
	check("ambiguous id lists both", R.planRecall(dup, { id: sid("c1") }, scan).text.split("\n").length, 3);
}
// caps
{
	check("line cap", recall({ id: sid("c1") }, scan, { bytesMax: 51_200, linesMax: 10 }).text.split("\n").slice(1).join("\n"),
		`Lines 1-10 of 30 (${SIZE}).\n\n${OUT.split("\n").slice(0, 10).join("\n")}\n[cut at 10 lines; continue with offset=11]`);
	const byBytes = recall({ id: sid("c1") }, scan, { bytesMax: 50, linesMax: 2_000 }).text;
	check("byte cap footer", byBytes.split("\n").at(-1), "[cut at 50 bytes; continue with offset=7]"); // lines 1-6 are 46 bytes; line 7 would make 52
	check("cap: no window", R.recallBytesCap(undefined), 51_200);
	check("cap: 1M window", R.recallBytesCap(1_000_000), 51_200);
	check("cap: 131k window", R.recallBytesCap(131_072), 26_214);
	check("cap: tiny window keeps the floor", R.recallBytesCap(1_000), R.RECALL_OUTPUT_BYTES_MIN);
}
// labels and branches
{
	check("recall label", R.recallLabel({ id: "#ABCDEF0123", grep: "a b", offset: 2, limit: 3, raw: true, session: "s1" }),
		`id=abcdef0123 grep="a b" offset=2 limit=3 raw session="s1"`);
	const e = entriesFor([userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")]);
	const branchSwitch = [...e, { ...entriesFor([userMsg("x")])[0], id: "x1", parentId: "e1" }, { ...entriesFor([userMsg("y")])[0], id: "y1", parentId: "x1" }];
	check("branch follows parents from the last entry", R.branchFromEntries(branchSwitch.map(R.lightEntry), 100).branch.map((l) => l.id), ["e0", "e1", "x1", "y1"]);
}
// property: exact round trip
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const CASES_MAX = 300;
	const ALPHABET = ["a", "Z", " ", "\n", "\t", "é", "漢", "😀", "\\", "\"", "\r\n"];
	let mismatches = 0;
	for (let c = 0; c < CASES_MAX; c++) {
		const len = Math.floor(rand() * 400);
		const text = Array.from({ length: len }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join("");
		const m = [userMsg("go"), assistantCall("p", "bash", { command: "x" }), toolResult("p", "bash", text)];
		const s = R.buildRecords(entriesFor(m).map(R.lightEntry), R.RECALL_SCAN_ENTRIES_MAX);
		const plan = R.planRecall(s.records, { id: sid("p") }, s);
		const out = R.renderRecall({ record: plan.record, text, raw: undefined, request: { id: sid("p") }, ...CAPS });
		const body = out.text.slice(out.text.indexOf("\n\n") + 2);
		if (body !== text) mismatches++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	check("recall by id returns the original bytes", mismatches, 0);
}

done();
