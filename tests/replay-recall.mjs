/**
 * Replay check on real pi sessions (pass criteria 2 and 3 of the v1.11.0
 * plan). Not part of tests/run.mjs: it needs the operator's session files.
 *
 *   node tests/replay-recall.mjs [sessionsDir] [count] [maxMB]
 *
 * For each of the `count` newest session files (default 40, files over
 * `maxMB` skipped and counted), on the active branch:
 *   1. mask at zone 2 (95% coverage) with the v1.11 templates, twice: the two
 *      passes must be byte-identical (cache stability);
 *   2. every placeholder id must equal sha1(toolCallId + "\0" + timestamp)[0..10] and recall
 *      through the real core (lightEntry → buildRecords → planRecall →
 *      renderRecall) must return the original text byte for byte;
 *   3. placeholder growth: bytes of the masked history with v1.11 templates
 *      against the v1.10 templates, as a share of the v1.10 history.
 * Prints one line per session and the distribution; exit 1 on any mismatch.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS_DIR = process.argv[2] ?? join(homedir(), ".pi", "agent", "sessions");
const COUNT = Number(process.argv[3] ?? 40);
const MAX_MB = Number(process.argv[4] ?? 200);
// arbitrary: generous caps so the round trip compares whole outputs.
const CAPS = { bytesMax: 1e12, linesMax: 1e9 };
const V110 = { bash: "[cm-masked bash] {cmd}", read: "[cm-masked read] {path} ({n} lines, {size})", recall: "[cm-masked recall] {cmd}" };

const { loadTs } = await import("./harness.mjs");
const cc = await loadTs("filters/context-compress.ts");
const R = await loadTs("filters/recall.ts");
const AM = await loadTs("filters/args-mask.ts");

function newestSessions() {
	const files = readdirSync(SESSIONS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.flatMap((d) => readdirSync(join(SESSIONS_DIR, d.name)).filter((f) => f.endsWith(".jsonl")).map((f) => join(SESSIONS_DIR, d.name, f)))
		.map((path) => ({ path, stat: statSync(path) }))
		.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
	return files.slice(0, COUNT);
}

async function readBranch(path) {
	const byId = new Map();
	let last = null;
	const lines = createInterface({ input: createReadStream(path, { flags: "r" }), crlfDelay: Infinity });
	for await (const line of lines) {
		if (!line.trim()) continue;
		let e;
		try { e = JSON.parse(line); } catch { continue; } // a cut last line; the replay only reads
		if (typeof e.id !== "string") continue;
		byId.set(e.id, e);
		last = e.id;
	}
	const branch = [];
	for (let id = last, step = 0; id && step < R.RECALL_SCAN_ENTRIES_MAX * 4; step++) {
		const e = byId.get(id);
		if (!e) break;
		branch.push(e);
		id = e.parentId;
	}
	return branch.reverse();
}

const opts = (messages) => ({ previousCutoff: Math.floor(messages.length * 0.95), zoneEntered: 2, contextUsage: 0.9 });
const growths = [];
let oldBytesSum = 0;
let newBytesSum = 0;
let failures = 0;
let totalChecked = 0;
let skipped = 0;
let argsChecked = 0;

/** 1.13.0 gate C (docs §6.1): with masked arguments on, every masked call's
 *  id resolves to an arguments record, the recalled text is argsText of the
 *  call's original arguments, and argsText parses back to them exactly. */
function checkArgs(messages, branch, scan, byEntry) {
	const out = cc.compressStaleToolResults(messages, { ...opts(messages), features: { maskArgs: true } })?.messages ?? messages;
	let checked = 0;
	let bad = 0;
	out.forEach((m, i) => {
		if (m.role !== "assistant" || m === messages[i]) return;
		for (const [j, block] of (m.content ?? []).entries()) {
			const original = messages[i].content[j];
			if (block?.type !== "toolCall" || JSON.stringify(block.arguments) === JSON.stringify(original.arguments)) continue;
			checked++;
			const id = /\[cm-masked arg #([0-9a-f]{10})\]/.exec(JSON.stringify(block.arguments))?.[1];
			if (id !== AM.argsId(original.id, messages[i].timestamp)) { bad++; continue; }
			const plan = R.planRecall(scan.records, { id }, scan);
			if (plan.kind !== "fetch" || plan.record.kind !== "args") { bad++; continue; }
			const call = byEntry.get(plan.record.entryId).message.content.find((c) => c?.type === "toolCall" && c.id === plan.record.toolCallId);
			const text = AM.argsText(call.arguments);
			if (text !== AM.argsText(original.arguments) || JSON.stringify(parseArgsText(text)) !== JSON.stringify(original.arguments)) bad++;
		}
	});
	return { checked, bad };
}

/** Same parser as tests/args-mask.test.mjs. */
function parseArgsText(text) {
	const out = {};
	const lines = text.split("\n");
	const set = (key, value) => {
		const parts = key.match(/[^.[\]]+|\[\d+\]/g);
		let node = out;
		parts.forEach((p, i) => {
			const k = p.startsWith("[") ? Number(p.slice(1, -1)) : p;
			if (i === parts.length - 1) { node[k] = value; return; }
			if (node[k] === undefined) node[k] = parts[i + 1].startsWith("[") ? [] : {};
			node = node[k];
		});
	};
	for (let i = 0; i < lines.length; i++) {
		const section = /^--- (.+) \((\d+) lines\) ---$/.exec(lines[i]);
		if (section) {
			const n = Number(section[2]);
			set(section[1], lines.slice(i + 1, i + 1 + n).join("\n"));
			i += n;
			continue;
		}
		const scalar = /^(.+?): (.*)$/.exec(lines[i]);
		if (scalar) set(scalar[1], JSON.parse(scalar[2]));
	}
	return out;
}
for (const { path, stat } of newestSessions()) {
	if (stat.size > MAX_MB * 1024 * 1024) { skipped++; continue; }
	const branch = await readBranch(path);
	const messages = branch.filter((e) => e.type === "message").map((e) => e.message);
	const first = cc.compressStaleToolResults(messages, opts(messages));
	const second = cc.compressStaleToolResults(messages, opts(messages));
	const stable = JSON.stringify(first) === JSON.stringify(second);
	const scan = R.buildRecords(branch.map(R.lightEntry), R.RECALL_SCAN_ENTRIES_MAX);
	const byEntry = new Map(branch.map((e) => [e.id, e]));
	let checked = 0;
	let bad = 0;
	(first?.messages ?? []).forEach((m, i) => {
		const text = m.role === "toolResult" ? R.toolResultText(m) : "";
		const original = messages[i];
		if (!text.startsWith("[cm-masked ") || R.toolResultText(original) === text) return;
		checked++;
		const id = /#([0-9a-f]{10})\]/.exec(text)?.[1];
		if (id !== R.shortId(original.toolCallId, original.timestamp)) { bad++; return; }
		const plan = R.planRecall(scan.records, { id }, scan);
		if (plan.kind !== "fetch") { bad++; return; }
		const fetched = byEntry.get(plan.record.entryId).message;
		const out = R.renderRecall({ record: plan.record, text: R.toolResultText(fetched), raw: undefined, request: { id }, ...CAPS });
		const body = out.text.slice(out.text.indexOf("\n\n") + 2);
		if (body !== R.toolResultText(original)) bad++;
	});
	const args = checkArgs(messages, branch, scan, byEntry);
	checked += args.checked;
	bad += args.bad;
	argsChecked += args.checked;
	const old = cc.compressStaleToolResults(messages, { ...opts(messages), placeholderFormat: V110 });
	const oldBytes = JSON.stringify(old?.messages ?? messages).length;
	const growth = (JSON.stringify(first?.messages ?? messages).length - oldBytes) / oldBytes;
	growths.push(growth);
	oldBytesSum += oldBytes;
	newBytesSum += oldBytes * (1 + growth);
	totalChecked += checked;
	failures += bad + (stable ? 0 : 1);
	console.log(`${stable && bad === 0 ? "ok  " : "FAIL"} ${path.split("/").pop().slice(0, 40)} msgs=${messages.length} masked=${checked} bad=${bad} stable=${stable} growth=${(growth * 100).toFixed(3)}%`);
}
growths.sort((a, b) => a - b);
const pct = (q) => (growths[Math.min(growths.length - 1, Math.floor(q * growths.length))] * 100).toFixed(3);
console.log(`\nsessions=${growths.length} skipped_over_${MAX_MB}MB=${skipped} placeholders_checked=${totalChecked} (of which masked calls ${argsChecked}) failures=${failures}`);
console.log(`growth vs v1.10 placeholders: median ${pct(0.5)}%, p90 ${pct(0.9)}%, max ${pct(1)}%`);
// Size-weighted: cost follows bytes, so long sessions count for more.
console.log(`size-weighted growth: ${(((newBytesSum - oldBytesSum) / oldBytesSum) * 100).toFixed(3)}% of ${(oldBytesSum / 1e6).toFixed(0)} MB masked history`);
process.exit(failures === 0 ? 0 : 1);
