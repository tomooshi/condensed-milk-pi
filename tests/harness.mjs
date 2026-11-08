/**
 * Test harness: load the real TypeScript sources and drive the extension
 * through a fake `pi` object. No copies of the logic under test.
 *
 * How: pi ships jiti, which resolves the sources' `./x.js` imports to
 * `./x.ts`. The harness finds that jiti (CM_JITI overrides the search),
 * aliases `@earendil-works/pi-ai` to the sibling package in the same
 * node_modules, and points HOME at a temp dir before the extension
 * loads, so no test reads or writes the operator's real config.
 */
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// arbitrary: pi keeps a handful of pinned versions; revisit if the list grows past this.
const PI_VERSIONS_SCANNED_MAX = 64;

function jitiCandidates() {
	const realHome = process.env.CM_REAL_HOME ?? homedir();
	const fromEnv = process.env.CM_JITI ? [process.env.CM_JITI] : [];
	const versionsDir = join(realHome, ".local", "share", "pi-versions");
	const versions = existsSync(versionsDir) ? readdirSync(versionsDir).sort().reverse().slice(0, PI_VERSIONS_SCANNED_MAX) : [];
	const pinned = versions.map((v) => join(versionsDir, v, "node_modules", "jiti", "lib", "jiti.mjs"));
	return [...fromEnv, ...pinned];
}

async function loadJitiFactory() {
	const candidates = jitiCandidates();
	const found = candidates.find((p) => existsSync(p));
	if (!found) {
		throw new Error(`harness: no jiti found. Set CM_JITI to jiti/lib/jiti.mjs. Tried: ${candidates.join(", ") || "(none)"}`);
	}
	const mod = await import(pathToFileURL(found).href);
	const nodeModules = resolve(dirname(found), "..", "..");
	return { createJiti: mod.createJiti, nodeModules };
}

let jitiInstance = null;
let testHome = null;

/** Point HOME at a fresh temp dir once per process, before any source loads. */
export function isolateHome() {
	if (testHome) return testHome;
	process.env.CM_REAL_HOME = process.env.CM_REAL_HOME ?? homedir();
	testHome = mkdtempSync(join(tmpdir(), "cm-test-home-"));
	process.env.HOME = testHome;
	delete process.env.CONDENSED_MILK_TELEMETRY;
	return testHome;
}

/** Import a repo-relative TypeScript module through jiti. */
export async function loadTs(relPath) {
	return loadTsAbsolute(join(REPO, relPath));
}

/** Import a TypeScript module by absolute path through the same jiti (bench arms load copies of the source). */
export async function loadTsAbsolute(absPath) {
	isolateHome();
	if (!jitiInstance) {
		const { createJiti, nodeModules } = await loadJitiFactory();
		jitiInstance = createJiti(import.meta.url, {
			moduleCache: true,
			alias: { "@earendil-works/pi-ai": piAiForExtensions(nodeModules) },
		});
	}
	return jitiInstance.import(absPath);
}

/** What `@earendil-works/pi-ai` means inside an extension. pi 1.5 removed
 *  TypeBox's `Type` from pi-ai's root and gives extensions a compat view that
 *  keeps it (pi-coding-agent dist/core/extensions/loader.js getAliases);
 *  pi 1.0.x exports `Type` from pi-ai itself. Use the view when it exists. */
function piAiForExtensions(nodeModules) {
	const view = join(nodeModules, "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "pi-ai-extension-view.js");
	return existsSync(view) ? view : join(nodeModules, "@earendil-works", "pi-ai");
}

/** The node_modules directory of the pi install whose jiti the harness uses. */
export async function piNodeModules() {
	return (await loadJitiFactory()).nodeModules;
}

/** Fake ExtensionAPI: records handlers, tools and commands; fires events in order. */
export function makeFakePi() {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const busHandlers = new Map();
	const pi = {
		on(name, fn) {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(fn);
		},
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, spec) { commands.set(name, spec); },
		events: {
			on(channel, fn) {
				if (!busHandlers.has(channel)) busHandlers.set(channel, []);
				busHandlers.get(channel).push(fn);
				return () => busHandlers.set(channel, busHandlers.get(channel).filter((h) => h !== fn));
			},
			emit(channel, data) { for (const fn of busHandlers.get(channel) ?? []) fn(data); },
		},
	};
	async function fire(name, event, ctx) {
		let last;
		for (const fn of handlers.get(name) ?? []) last = await fn(event, ctx);
		return last;
	}
	return { pi, handlers, tools, commands, fire };
}

/** Fake session manager over a list of session entries (the branch, in order). */
export function makeSessionManager(entries) {
	const byId = new Map(entries.map((e) => [e.id, e]));
	return {
		getBranch: () => entries.slice(),
		getLeafEntry: () => entries[entries.length - 1],
		getEntry: (id) => byId.get(id),
		getSessionFile: () => undefined,
		getSessionId: () => "test-session",
	};
}

/** Fake ExtensionContext for context/tool_result/command handlers. */
export function makeCtx({ tokens = 0, contextWindow = 1_000_000, entries = [], model, notes } = {}) {
	return {
		getContextUsage: () => ({ tokens, contextWindow }),
		ui: { setStatus() {}, notify: (msg) => notes?.push(msg) },
		sessionManager: makeSessionManager(entries),
		model,
		hasUI: false,
	};
}

// ── message builders (pi AgentMessage shapes) ──

export function userMsg(text, timestamp = 0) {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}
export function assistantCall(id, name, args, timestamp = 0) {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp };
}
export function toolResult(id, name, text, extra = {}) {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 0, ...extra };
}
export function textOf(msg) {
	return (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
/** Session entries for a message list: ids e0..eN chained by parentId. */
export function entriesFor(messages) {
	return messages.map((message, i) => ({
		type: "message",
		id: `e${i}`,
		parentId: i === 0 ? null : `e${i - 1}`,
		timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
		message,
	}));
}

// ── seeded PRNG for property tests (mulberry32); the seed is printed by the caller ──

export function prng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
export function seedFromEnv() {
	const fromEnv = Number(process.env.CM_SEED);
	return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : (Date.now() % 2_147_483_647) + 1;
}

// ── minimal runner: one expected outcome per check ──

export function makeRunner(title) {
	let pass = 0;
	let fail = 0;
	const failures = [];
	function check(name, actual, expected) {
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		if (a === e) { pass++; return; }
		fail++;
		failures.push(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`);
	}
	function done() {
		for (const f of failures) console.log(f);
		console.log(`${fail === 0 ? "PASS" : "FAIL"} — ${title}: ${pass} passed, ${fail} failed`);
		process.exit(fail === 0 ? 0 : 1);
	}
	return { check, done };
}
