#!/usr/bin/env node
/**
 * Replay-cost harness: replay real pi sessions through one or more copies of
 * the condensed-milk extension ("arms") and record, for every model call, the
 * terms of the token and cache model in bench/replay-lib.mjs. bench/analyze.mjs
 * turns the output into calibration gates and paired arm comparisons.
 *
 * How it stays faithful:
 * - pi's own `buildSessionContext` / `sessionEntryToContextMessages` build the
 *   message list at each call, and pi's `estimateContextTokens` gives the usage
 *   the extension saw, so the masking zones fire as they did live.
 * - Each arm is the real index.ts, copied to its own directory and loaded with
 *   its own HOME, so two configs or two code versions run side by side.
 * - The agent's actions are fixed (recorded). What differs between arms is only
 *   what the model would have been sent, and so the cache and thinking terms.
 * - Thinking drops that the recording shows but no arm edit explains (other
 *   extensions' prefix edits) are applied to every arm at the same position.
 *
 * Usage:
 *   node bench/replay-cost.mjs list --days 30 --max-mb 600 --out /tmp/cm-bench/list.tsv
 *   node bench/replay-cost.mjs run --list list.tsv --arm base=. [--arm cand=../wt:configDir] --out run.json
 * An arm is name=SOURCE_DIR[:CONFIG_DIR]. CONFIG_DIR holds condensed-milk.json and
 * condensed-milk-config.json; the default is a copy of the operator's real files.
 */
import { createReadStream, readdirSync, statSync, mkdirSync, mkdtempSync, copyFileSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { isolateHome, loadTsAbsolute, makeFakePi, piNodeModules } from "../tests/harness.mjs";
import { contentChars, imageCount, firstChangedIndex, readPrefix, IMAGE_TOKENS } from "./replay-lib.mjs";

/** inherited: the extension's placeholder prefix (CM-ADR-001). */
const MASK_PREFIX = "[cm-masked ";
/** arbitrary: sessions of test folders (/tmp/...) are not real work. */
const EXCLUDED_DIR_PREFIX = "--tmp";
/** derived: a branch walk visits each entry once; 4x the measured 28,128-line maximum. */
const BRANCH_STEPS_MAX = 131_072;
/** inherited: pi's short prompt-cache lifetime for Anthropic models (anthropic.json promptCache.short). */
const DEFAULT_TTL_SECONDS = 300;
/** arbitrary: a cold call whose recorded prompt falls by more than this, with no
 *  arm edit explaining half of it, is read as a pi restart (session files have
 *  no restart marker; the extension resets its zones on session_start). */
const RESTART_FALL_MIN_TOKENS = 20_000;
/** arbitrary: a recorded cache read below this share of the modeled read marks a
 *  rewrite caused outside condensed-milk (applied to every arm alike). Relative,
 *  because the size model's own error (median 3.8%) scales with the prompt. */
const EXOGENOUS_BREAK_READ_SHARE = 0.5;
/** arbitrary: ignore shortfalls smaller than this (small prompts). */
const EXOGENOUS_BREAK_MIN_TOKENS = 5_000;
/** measured: fitted on the odd-numbered sessions of the 2026-11-02 list (bench/analyze.mjs). */
const DEFAULT_CHARS_PER_TOKEN = 2.43;

const REAL_HOME = process.env.CM_REAL_HOME ?? homedir();

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
}
function args(name) {
	return process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1]] : []));
}

// ── list: a snapshot of session files and their byte lengths, so reruns read the same bytes ──

function makeList() {
	const root = join(REAL_HOME, ".pi", "agent", "sessions");
	const days = Number(arg("days", "30"));
	const maxBytes = Number(arg("max-mb", "600")) * 1024 * 1024;
	const since = Date.now() - days * 86_400_000;
	const rows = readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith(EXCLUDED_DIR_PREFIX))
		.flatMap((d) => readdirSync(join(root, d.name)).filter((f) => f.endsWith(".jsonl")).map((f) => join(root, d.name, f)))
		.map((path) => ({ path, stat: statSync(path) }))
		.filter((r) => r.stat.mtimeMs >= since && r.stat.size <= maxBytes)
		.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
	const out = arg("out", "/tmp/cm-bench/list.tsv");
	mkdirSync(resolve(out, ".."), { recursive: true });
	writeFileSync(out, rows.map((r) => `${r.path}\t${r.stat.size}`).join("\n") + "\n");
	console.log(`${rows.length} sessions -> ${out}`);
}

// ── session loading (read-only, bounded by the snapshot length) ──

async function readEntries(path, bytes) {
	const entries = [];
	const lines = createInterface({ input: createReadStream(path, { flags: "r", start: 0, end: Math.max(0, bytes - 1) }), crlfDelay: Infinity });
	for await (const line of lines) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (typeof e?.id === "string") entries.push(e);
		} catch (err) {
			// The snapshot can end inside a line that pi was still writing; it is skipped.
			if (!(err instanceof SyntaxError)) throw err;
		}
	}
	return entries;
}

function branchOf(entries) {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const branch = [];
	let cur = entries.at(-1);
	for (let step = 0; cur && step < BRANCH_STEPS_MAX; step++) {
		branch.push(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	if (cur) throw new Error(`branchOf: branch longer than BRANCH_STEPS_MAX (${BRANCH_STEPS_MAX})`);
	return { branch: branch.reverse(), byId };
}

// ── arms ──

async function prepareArm(spec, root, index) {
	const [name, rest] = spec.split("=");
	const [sourceDir, configDir] = rest.split(":");
	const dir = join(root, `arm-${index}-${name}`);
	const src = join(dir, "src");
	mkdirSync(src, { recursive: true });
	copyFileSync(join(resolve(sourceDir), "index.ts"), join(src, "index.ts"));
	for (const sub of ["filters", "io"]) cpSync(join(resolve(sourceDir), sub), join(src, sub), { recursive: true });
	const home = join(dir, "home");
	mkdirSync(join(home, ".config"), { recursive: true });
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	const from = configDir ? resolve(configDir) : null;
	const pick = (file, real) => (from ? join(from, file) : real);
	const cfg = pick("condensed-milk.json", join(REAL_HOME, ".config", "condensed-milk.json"));
	const rules = pick("condensed-milk-config.json", join(REAL_HOME, ".pi", "agent", "condensed-milk-config.json"));
	if (existsSync(cfg)) copyFileSync(cfg, join(home, ".config", "condensed-milk.json"));
	if (existsSync(rules)) copyFileSync(rules, join(home, ".pi", "agent", "condensed-milk-config.json"));
	process.env.HOME = home;
	const ext = (await loadTsAbsolute(join(src, "index.ts"))).default;
	const { pi, fire } = makeFakePi();
	ext(pi);
	return { name, home, fire, sourceHash: hashDir(src) };
}

function hashDir(dir) {
	const h = createHash("sha1");
	const walk = (d) => readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((e) => {
		const p = join(d, e.name);
		if (e.isDirectory()) walk(p);
		else h.update(e.name).update(readFileSync(p));
	});
	walk(dir);
	return h.digest("hex").slice(0, 12);
}

// ── per-call bookkeeping ──

function thinkingKey(message) {
	return message?.role === "assistant" && (message.content ?? []).some((c) => c?.type === "thinking" && c.thinkingSignature)
		? `${message.timestamp}|${message.responseId ?? ""}`
		: null;
}

function recordedDrops(message) {
	const paths = new Set();
	for (const d of message?.diagnostics ?? []) {
		for (const t of d?.details?.transformations ?? []) if (t?.type === "thinking_dropped") paths.add(String(t.path).split(".content")[0]);
	}
	return paths;
}

function toolKey(entry, argsById) {
	const m = entry.message;
	const args = argsById.get(m.toolCallId) ?? {};
	if (m.toolName === "bash") return typeof args.command === "string" ? `b:${args.command.replace(/\s+/g, " ").trim()}` : null;
	if (m.toolName === "read") return `r:${args.path}|${args.offset}|${args.limit}`;
	return null;
}

const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n") : String(m?.content ?? ""));

/** Message sizes for the token model. An assistant message costs its recorded
 *  output tokens, minus its reasoning tokens once its thinking is invalid. */
function sizesOf(messages, usageByTs, valid) {
	return messages.map((m) => {
		if (m?.role !== "assistant") return { chars: contentChars(m), assistantTokens: imageCount(m) * IMAGE_TOKENS };
		const u = usageByTs.get(m.timestamp);
		if (!u) return { chars: contentChars(m), assistantTokens: 0 };
		const key = thinkingKey(m);
		const dropped = key !== null && valid.get(key) === false;
		return { chars: 0, assistantTokens: (u.output ?? 0) - (dropped ? (u.reasoning ?? 0) : 0) };
	});
}

/** Invalidate valid thinking blocks after `from` (exclusive) in one arm; returns the count. */
function invalidateAfter(transformed, valid, from) {
	let n = 0;
	for (let i = from + 1; i < transformed.length; i++) {
		const key = thinkingKey(transformed[i]);
		if (key !== null && valid.get(key) === true) {
			valid.set(key, false);
			n++;
		}
	}
	return n;
}

/** Index of the k-th newest valid thinking message (the position of an
 *  edit that drops the newest k blocks), or null. */
function positionOfNewest(transformed, valid, k) {
	let seen = 0;
	for (let i = transformed.length - 1; i >= 0; i--) {
		const key = thinkingKey(transformed[i]);
		if (key !== null && valid.get(key) === true && ++seen === k) return i;
	}
	return null;
}

/** Fire the context event for one arm and return the messages it sends. */
async function fireContext(arm, a, index, call, state, ctx) {
	process.env.HOME = arm.home;
	const tokens = index === 0 ? call.usageTokens : Math.max(0, call.usageTokens - (state.arms[0].promptPrev - a.promptPrev));
	const out = await arm.fire("context", { messages: call.raw }, { ...ctx, getContextUsage: () => ({ tokens, contextWindow: ctx.model.contextWindow }) });
	return out?.messages ?? call.raw;
}

/** True when the recorded prompt fell much more than the baseline arm's own
 *  edits explain: a pi restart, after which the extension starts fresh. */
function looksLikeRestart(call, transformed, state) {
	if (call.prevRecPrompt === null || !call.claude) return false;
	const recFall = call.prevRecPrompt - call.recPrompt;
	if (recFall <= RESTART_FALL_MIN_TOKENS || call.recRead >= 0.5 * call.prevRecPrompt) return false;
	const sizes = sizesOf(transformed, state.usageByTs, state.arms[0].valid);
	const now = sizes.reduce((t, x) => t + x.assistantTokens + x.chars / state.charsPerToken, 0);
	return state.arms[0].promptPrev - now < 0.5 * recFall;
}

/** Run one call through every arm and append its row to each arm's series. */
async function processCall(call, arms, state, ctx) {
	const rows = [];
	for (const [index, arm] of arms.entries()) {
		const a = state.arms[index];
		let transformed = await fireContext(arm, a, index, call, state, ctx);
		if (index === 0 && looksLikeRestart(call, transformed, state)) {
			state.restarts++;
			for (const other of arms) {
				process.env.HOME = other.home;
				await other.fire("session_start", { reason: "resume" }, ctx);
			}
			transformed = await fireContext(arm, a, index, call, state, ctx);
		}
		for (const m of transformed) {
			const key = thinkingKey(m);
			if (key !== null && !a.valid.has(key)) a.valid.set(key, true);
		}
		const armJ = firstChangedIndex(a.prev, transformed);
		const editAt = Math.min(armJ, call.rawJ);
		const edited = editAt < a.prev.length;
		const invalidated = edited ? invalidateAfter(transformed, a.valid, editAt) : 0;
		if (edited && armJ < call.rawJ) a.counters.cmEdits++;
		if (edited && armJ < call.rawJ) a.counters.thinkingInvalidatedByEdit += invalidated;
		rows.push({ a, transformed, armJ, editAt, invalidated });
	}
	const exoK = Math.max(0, call.newDrops - rows[0].invalidated);
	const exoAt = exoK > 0 ? positionOfNewest(rows[0].transformed, rows[0].a.valid, exoK) : null;
	const prefixEnds = rows.map((r) => {
		if (exoAt === null) return r.editAt;
		r.a.counters.thinkingInvalidatedExogenous += invalidateAfter(r.transformed, r.a.valid, exoAt - 1);
		return Math.min(r.editAt, exoAt);
	});
	const breakAt = exogenousBreak(call, rows[0].transformed, prefixEnds[0], state);
	rows.forEach((r, i) => finishArmCall(r, prefixEnds[i], breakAt, call, state));
}

/** Position of a cache rewrite that the recording shows but no modeled edit
 *  explains: where the baseline's cumulative tokens pass the recorded read.
 *  null when the recorded read is not well below the modeled one. */
function exogenousBreak(call, transformed, prefixEnd, state) {
	if (!call.claude || !call.warm) return null;
	const sizes = sizesOf(transformed, state.usageByTs, state.arms[0].valid);
	if (state.offset === null) state.offset = call.recPrompt - sizes.reduce((t, x) => t + x.assistantTokens + x.chars / state.charsPerToken, 0);
	let cum = state.offset;
	let breakAt = null;
	for (let i = 0; i < Math.min(prefixEnd, sizes.length); i++) {
		if (breakAt === null && cum >= call.recRead) breakAt = i;
		cum += sizes[i].assistantTokens + sizes[i].chars / state.charsPerToken;
	}
	if (cum - call.recRead < EXOGENOUS_BREAK_MIN_TOKENS || call.recRead >= EXOGENOUS_BREAK_READ_SHARE * cum) return null;
	return breakAt ?? 0;
}

/** Size the request, record the row and remember the masked results. The row
 *  holds the modeled read (for the gate) and the read with exogenous breaks
 *  (for arm comparisons). */
function finishArmCall(r, prefixEnd, breakAt, call, state) {
	const { a, transformed } = r;
	const sizes = sizesOf(transformed, state.usageByTs, a.valid);
	const total = sizes.reduce((s, x) => ({ chars: s.chars + x.chars, assistantTokens: s.assistantTokens + x.assistantTokens }), { chars: 0, assistantTokens: 0 });
	const read = readPrefix(sizes, prefixEnd, call.warm);
	const shocked = readPrefix(sizes, breakAt === null ? prefixEnd : Math.min(prefixEnd, breakAt), call.warm);
	a.series.push([total.chars, total.assistantTokens, read.chars, read.assistantTokens, shocked.chars, shocked.assistantTokens]);
	a.masked = new Set(transformed.filter((m) => m?.role === "toolResult" && textOf(m).startsWith(MASK_PREFIX)).map((m) => m.toolCallId));
	a.counters.masksAtLastCall = a.masked.size;
	a.promptPrev = total.assistantTokens + total.chars / state.charsPerToken;
	a.prev = transformed;
}

const STRUCTURAL = new Set(["compaction", "context_edit", "branch_summary"]);

/** Replay one session through all arms. Returns the recorded series and each arm's series and counters. */
async function replaySession(path, bytes, arms, pi) {
	const entries = await readEntries(path, bytes);
	const { branch, byId } = branchOf(entries);
	const usageByTs = new Map(branch.filter((e) => e.message?.role === "assistant" && e.message.usage).map((e) => [e.message.timestamp, e.message.usage]));
	const state = {
		usageByTs,
		charsPerToken: Number(arg("chars-per-token", String(DEFAULT_CHARS_PER_TOKEN))),
		restarts: 0,
		offset: null,
		arms: arms.map(() => ({ prev: [], valid: new Map(), masked: new Set(), promptPrev: 0, series: [], counters: { cmEdits: 0, thinkingInvalidatedByEdit: 0, thinkingInvalidatedExogenous: 0, refetchIdenticalAfterMask: 0, masksAtLastCall: 0 } })),
	};
	for (const arm of arms) {
		process.env.HOME = arm.home;
		await arm.fire("session_start", { reason: "startup" }, minimalCtx(branch, -1, byId, undefined));
	}
	const rec = [];
	let raw = [];
	let prevRaw = [];
	let structuralSince = false;
	let prevDrops = new Set();
	let lastTouch = null;
	let ttlMs = DEFAULT_TTL_SECONDS * 1000;
	const argsById = new Map();
	const lastResultByKey = new Map();
	for (let k = 0; k < branch.length; k++) {
		const e = branch[k];
		const ts = Date.parse(e.timestamp);
		const m = e.type === "message" ? e.message : undefined;
		if (e.type === "usage" && e.kind === "cache_warm") lastTouch = Math.max(lastTouch ?? 0, ts);
		if (m?.role === "assistant" && m.usage) {
			const drops = recordedDrops(m);
			const u = m.usage;
			const call = {
				raw,
				claude: String(m.model).startsWith("claude"),
				recPrompt: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
				recRead: u.cacheRead ?? 0,
				prevRecPrompt: rec.length > 0 && rec.at(-1)[7] === 1 ? rec.at(-1)[0] : null,
				rawJ: structuralSince ? firstChangedIndex(prevRaw, raw) : prevRaw.length,
				usageTokens: pi.estimateContextTokens(raw).tokens,
				warm: lastTouch !== null && ts - lastTouch <= ttlMs,
				newDrops: [...drops].filter((p) => !prevDrops.has(p)).length,
			};
			const ctx = minimalCtx(branch, k - 1, byId, modelFor(pi, m));
			globalThis.Date.now = () => ts;
			await processCall(call, arms, state, ctx);
			rec.push([(u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), u.cacheRead ?? 0, u.cacheWrite ?? 0, u.output ?? 0, u.reasoning ?? 0, call.newDrops, call.warm ? 1 : 0, String(m.model).startsWith("claude") ? 1 : 0]);
			prevDrops = drops;
			prevRaw = raw.slice();
			structuralSince = false;
			lastTouch = ts;
			ttlMs = (u.cacheWrite1h ?? 0) > 0 ? 3_600_000 : DEFAULT_TTL_SECONDS * 1000;
			for (const c of m.content ?? []) if (c?.type === "toolCall") argsById.set(c.id, c.arguments ?? {});
		}
		if (STRUCTURAL.has(e.type)) {
			raw = pi.buildSessionContext(entries, e.id, byId).messages.slice();
			structuralSince = true;
			const event = e.type === "compaction" ? "session_compact" : e.type === "branch_summary" ? "session_tree" : null;
			if (e.type === "compaction") prevDrops = new Set();
			if (event) for (const arm of arms) { process.env.HOME = arm.home; await arm.fire(event, {}, minimalCtx(branch, k, byId, undefined)); }
		} else {
			raw.push(...pi.sessionEntryToContextMessages(e));
		}
		if (m?.role === "toolResult") await afterToolResult(e, arms, state, argsById, lastResultByKey, branch, k, byId);
	}
	return { calls: rec.length, restarts: state.restarts, rec, arms: state.arms.map((a) => ({ series: a.series, counters: a.counters })) };
}

/** Feed a bash result to each arm (boundary detection) and count identical re-fetches of masked results. */
async function afterToolResult(e, arms, state, argsById, lastResultByKey, branch, k, byId) {
	const m = e.message;
	const args = argsById.get(m.toolCallId) ?? {};
	if (m.toolName === "bash" && typeof args.command === "string") {
		for (const arm of arms) {
			process.env.HOME = arm.home;
			await arm.fire("tool_result", { toolName: "bash", toolCallId: m.toolCallId, input: args, content: m.content ?? [], details: m.details, isError: m.isError === true }, minimalCtx(branch, k, byId, undefined));
		}
	}
	const key = m.isError ? null : toolKey(e, argsById);
	if (key === null) return;
	const hash = createHash("sha1").update(textOf(m)).digest("hex");
	const prev = lastResultByKey.get(key);
	if (prev && prev.hash === hash) {
		for (const a of state.arms) if (a.masked.has(prev.toolCallId)) a.counters.refetchIdenticalAfterMask++;
	}
	lastResultByKey.set(key, { toolCallId: m.toolCallId, hash });
}

function minimalCtx(branch, leafIndex, byId, model) {
	return {
		getContextUsage: () => ({ tokens: 0, contextWindow: model?.contextWindow ?? 1_000_000 }),
		ui: { setStatus() {}, notify() {} },
		hasUI: false,
		model,
		sessionManager: {
			getBranch: () => branch.slice(0, leafIndex + 1),
			getLeafEntry: () => (leafIndex >= 0 ? branch[leafIndex] : undefined),
			getEntry: (id) => byId.get(id),
			getSessionFile: () => undefined,
			getSessionId: () => "bench",
		},
	};
}

function modelFor(pi, message) {
	return pi.catalog.get(message.model) ?? { id: message.model, provider: message.provider, contextWindow: 1_000_000, promptCache: { short: DEFAULT_TTL_SECONDS, long: 3600 } };
}

async function loadPi() {
	const nm = await piNodeModules();
	const core = join(nm, "@earendil-works", "pi-coding-agent", "dist", "core");
	const sm = await import(pathToFileURL(join(core, "session-manager.js")).href);
	const comp = await import(pathToFileURL(join(core, "compaction", "compaction.js")).href);
	const data = JSON.parse(readFileSync(join(nm, "@earendil-works", "pi-ai", "dist", "providers", "data", "anthropic.json"), "utf8"));
	const catalog = new Map();
	const walk = (x) => {
		if (Array.isArray(x)) return x.forEach(walk);
		if (!x || typeof x !== "object") return;
		if (typeof x.id === "string" && typeof x.contextWindow === "number") catalog.set(x.id, x);
		else Object.values(x).forEach(walk);
	};
	walk(data);
	return { buildSessionContext: sm.buildSessionContext, sessionEntryToContextMessages: sm.sessionEntryToContextMessages, estimateContextTokens: comp.estimateContextTokens, catalog };
}

async function run() {
	const listPath = arg("list") && resolve(arg("list"));
	if (!listPath) throw new Error("run: --list is required");
	// Resolve paths before the working directory changes below.
	const specs = args("arm").map((spec) => {
		const [name, rest = ""] = spec.split("=");
		return `${name}=${rest.split(":").map((p) => resolve(p)).join(":")}`;
	});
	if (specs.length === 0) throw new Error("run: at least one --arm name=SOURCE_DIR is required");
	const out = resolve(arg("out", "/tmp/cm-bench/run.json"));
	const realDate = Date.now;
	isolateHome();
	process.env.CONDENSED_MILK_TELEMETRY = "off";
	const root = mkdtempSync(join(tmpdir(), "cm-bench-"));
	process.chdir(root);
	const pi = await loadPi();
	const arms = [];
	for (const [i, spec] of specs.entries()) arms.push(await prepareArm(spec, root, i));
	const list = readFileSync(listPath, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
	const sessions = [];
	for (const [i, [path, bytes]] of list.entries()) {
		const t0 = realDate();
		sessions.push({ index: i, ...(await replaySession(path, Number(bytes), arms, pi)) });
		process.stderr.write(`  session ${i + 1}/${list.length}: ${sessions.at(-1).calls} calls, ${((realDate() - t0) / 1000).toFixed(1)}s\n`);
	}
	globalThis.Date.now = realDate;
	const listHash = createHash("sha1").update(readFileSync(listPath)).digest("hex").slice(0, 12);
	const result = { harness: "replay-cost", version: 2, listHash, charsPerToken: Number(arg("chars-per-token", String(DEFAULT_CHARS_PER_TOKEN))), arms: arms.map((a) => ({ name: a.name, sourceHash: a.sourceHash })), sessions };
	mkdirSync(resolve(out, ".."), { recursive: true });
	writeFileSync(out, JSON.stringify(result));
	console.log(`wrote ${out}: ${sessions.length} sessions, ${sessions.reduce((s, x) => s + x.calls, 0)} calls, arms ${arms.map((a) => `${a.name}@${a.sourceHash}`).join(", ")}`);
}

const command = process.argv[2];
if (command === "list") makeList();
else if (command === "run") await run();
else {
	console.error("usage: replay-cost.mjs list|run [options]  (see the header of this file)");
	process.exit(2);
}
