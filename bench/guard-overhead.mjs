#!/usr/bin/env node
/**
 * Overhead gate for the prefix guard (§6.1 A): p99 of one comparison < 5 ms
 * at a 1M-token request. Two cases:
 *   shared  - the next request reuses the previous request's strings (what pi
 *             does for unchanged messages) and appends two messages;
 *   copied  - every string is a fresh copy (worst case: no reuse at all).
 * Payload: 1M tokens at the fitted 2.43 chars per token (bench/README.md),
 * as 4,000 tool-use turns with thinking blocks.
 * Run with `node --expose-gc` for the gate: the guard allocates nothing, so a
 * collection pause inside the timing is caused by the bench building the next
 * request, not by the guard. Without the flag the numbers include those pauses.
 */
import { loadTs } from "../tests/harness.mjs";

const G = await loadTs("filters/prefix-guard.ts");
/** inherited: the harness token model (bench/README.md). */
const CHARS_PER_TOKEN = 2.43;
const TARGET_TOKENS = 1_000_000;
const TURNS = 4_000;
const RUNS = 300;

const GATE_P99_MS = 5;

/** Text per tool result, set so the whole payload is TARGET_TOKENS (checked below). */
let textChars = 0;
const turn = (i) => [
	{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: `sig-${i}-${"s".repeat(300)}` }, { type: "tool_use", id: `t${i}`, name: "bash", input: { command: `cat file-${i}.ts` } }] },
	{ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: [{ type: "text", text: `${i}:` + "x".repeat(textChars) }] }] },
];
const overheadPerTurn = JSON.stringify(turn(TURNS)).length;
textChars = Math.max(0, Math.floor((TARGET_TOKENS * CHARS_PER_TOKEN - 25_000) / TURNS) - overheadPerTurn);
const tools = Array.from({ length: 12 }, (_, i) => ({ name: `tool${i}`, description: "d".repeat(300), input_schema: { type: "object", properties: { a: { type: "string" } } } }));
const system = [{ type: "text", text: "s".repeat(20_000) }];
const messages = Array.from({ length: TURNS }, (_, i) => turn(i)).flat();
const prev = { model: "claude-opus-5-5", system, tools, messages };

/** The next request as pi builds it: new outer objects, same strings, a moved cache_control, two appended messages. */
function nextShared() {
	const msgs = messages.map((m) => ({ role: m.role, content: m.content.map((b) => ({ ...b })) }));
	msgs[msgs.length - 1].content[0].cache_control = { type: "ephemeral" };
	return { model: prev.model, system: system.map((b) => ({ ...b })), tools: tools.map((t) => ({ ...t })), messages: [...msgs, ...turn(TURNS)] };
}
const nextCopied = () => JSON.parse(JSON.stringify({ ...prev, messages: [...messages, ...turn(TURNS)] }));

/** arbitrary: unmeasured runs so V8 optimizes the comparison first (CONVENTIONS meas-steady-state). */
const WARMUP_RUNS = 30;

function measure(makeNext) {
	const times = [];
	const order = [];
	for (let r = -WARMUP_RUNS; r < RUNS; r++) {
		const cur = makeNext();
		// With --expose-gc, collect the bench's own garbage first: the guard
		// allocates nothing, so a pause inside the timing would be the bench's.
		globalThis.gc?.();
		const t0 = process.hrtime.bigint();
		const change = G.comparePayloads(prev, cur);
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		if (change.kind !== "none") throw new Error(`overhead bench: expected "none", got ${change.kind}`);
		if (r < 0) continue;
		times.push(ms);
		order.push([ms, r]);
	}
	times.sort((a, b) => a - b);
	const slowest = order.sort((a, b) => b[0] - a[0]).slice(0, 3).map(([ms, r]) => `run ${r}: ${ms.toFixed(2)} ms`);
	return { p50: times[Math.floor(RUNS * 0.5)], p99: times[Math.floor(RUNS * 0.99)], slowest };
}

const chars = JSON.stringify(prev).length;
console.log(`gc before each run: ${typeof globalThis.gc === "function" ? "yes (--expose-gc)" : "no"}`);
console.log(`payload: ${messages.length} messages, ${(chars / 1e6).toFixed(2)}M chars (~${Math.round(chars / CHARS_PER_TOKEN / 1e3)}k tokens), ${RUNS} runs`);
const shared = measure(nextShared);
const copied = measure(nextCopied);
console.log(`shared strings: p50 ${shared.p50.toFixed(2)} ms, p99 ${shared.p99.toFixed(2)} ms (slowest: ${shared.slowest.join(", ")})`);
console.log(`copied strings (worst case): p50 ${copied.p50.toFixed(2)} ms, p99 ${copied.p99.toFixed(2)} ms`);
const pass = shared.p99 < GATE_P99_MS;
console.log(`overhead gate (p99 < ${GATE_P99_MS} ms, shared strings): ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
