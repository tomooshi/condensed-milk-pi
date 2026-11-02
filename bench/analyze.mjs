#!/usr/bin/env node
/**
 * Analyze a replay-cost run (bench/replay-cost.mjs): fit the token model on
 * the odd-numbered sessions, check the harness gates on the even-numbered ones,
 * and compare every arm with the first arm (paired by session, bootstrap CI).
 *
 *   node bench/analyze.mjs RUN.json [--seed N] [--json out.json]
 *   node bench/analyze.mjs --same A.json B.json        # determinism gate
 *
 * Pre-registered harness gates (docs/research/2026-11-02-next-features.md §6.1):
 *   two runs byte-identical; replayed cache reads within 10% of the recorded
 *   per-session totals, Spearman >= 0.95 (claude calls, held-out sessions).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fitCharsPerToken, spearman, bootstrapPairedSum } from "./replay-lib.mjs";
import { prng } from "../tests/harness.mjs";

/** inherited: claude-opus-5-5 prices in pi's anthropic.json, $ per million tokens. */
const PRICE = { cacheRead: 0.2, cacheWrite: 5 };
/** inherited: the pre-registered harness gate (§6.1). */
const GATE = { readErrorMax: 0.1, spearmanMin: 0.95 };
/** inherited: §6.1 fixes 10,000 bootstrap resamples. */
const RESAMPLES = 10_000;

const REC = { prompt: 0, read: 1, write: 2, output: 3, reasoning: 4, newDrops: 5, warm: 6, claude: 7 };
const SER = { chars: 0, fixed: 1, readChars: 2, readFixed: 3, shockReadChars: 4, shockReadFixed: 5 };

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Rows for the ratio fit: consecutive claude calls with no drop and growing characters. */
function fitRows(sessions, armIndex) {
	return sessions.flatMap((s) => {
		const ser = s.arms[armIndex].series;
		const rows = [];
		for (let i = 1; i < s.rec.length; i++) {
			const a = s.rec[i - 1];
			const b = s.rec[i];
			if (!a[REC.claude] || !b[REC.claude] || b[REC.newDrops] > 0) continue;
			const dChars = ser[i][SER.chars] - ser[i - 1][SER.chars];
			const dRest = b[REC.prompt] - a[REC.prompt] - (ser[i][SER.fixed] - ser[i - 1][SER.fixed]);
			if (dChars > 0 && dRest > 0) rows.push({ dChars, dRest });
		}
		return rows;
	});
}

/** Per-session offset from the first claude call (tools, framing). */
function offsetOf(session, armIndex, charsPerToken) {
	const i = session.rec.findIndex((r) => r[REC.claude] === 1);
	if (i < 0) return null;
	const s = session.arms[armIndex].series[i];
	return session.rec[i][REC.prompt] - s[SER.fixed] - s[SER.chars] / charsPerToken;
}

/** Token totals of one session for one arm (claude calls only). `shocks`
 *  applies the recorded exogenous rewrites (for comparisons, not the gate). */
function totals(session, armIndex, model, shocks = false) {
	const offset = offsetOf(session, 0, model.charsPerToken);
	const t = { prompt: 0, read: 0, write: 0, recPrompt: 0, recRead: 0, recWrite: 0, calls: 0, promptErrors: [] };
	if (offset === null) return t;
	session.rec.forEach((r, i) => {
		if (!r[REC.claude]) return;
		const s = session.arms[armIndex].series[i];
		const prompt = offset + s[SER.fixed] + s[SER.chars] / model.charsPerToken;
		const rc = shocks ? SER.shockReadChars : SER.readChars;
		const rf = shocks ? SER.shockReadFixed : SER.readFixed;
		const read = r[REC.warm] ? Math.min(prompt, offset + s[rf] + s[rc] / model.charsPerToken) : 0;
		t.prompt += prompt;
		t.read += read;
		t.write += prompt - read;
		t.recPrompt += r[REC.prompt];
		t.recRead += r[REC.read];
		t.recWrite += r[REC.write];
		t.calls++;
		if (r[REC.prompt] > 0) t.promptErrors.push(Math.abs(prompt - r[REC.prompt]) / r[REC.prompt]);
	});
	return t;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const quantile = (xs, q) => {
	const v = [...xs].sort((a, b) => a - b);
	return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : NaN;
};

/** Harness gates on the held-out sessions. */
function gates(heldOut, model) {
	const used = heldOut.filter((s) => {
		const t = totals(s, 0, model);
		return t.calls > 0 && t.recRead > 0;
	});
	const ts = used.map((s) => totals(s, 0, model));
	const shocked = used.map((s) => totals(s, 0, model, true));
	const recRead = ts.reduce((a, t) => a + t.recRead, 0);
	const estRead = ts.reduce((a, t) => a + t.read, 0);
	const perSession = ts.map((t) => Math.abs(t.read - t.recRead) / t.recRead);
	const promptErrors = ts.flatMap((t) => t.promptErrors);
	const result = {
		sessions: ts.length,
		aggregateReadError: (estRead - recRead) / recRead,
		medianSessionReadError: quantile(perSession, 0.5),
		spearmanRead: spearman(ts.map((t) => t.recRead), ts.map((t) => t.read)),
		aggregateWriteError: (ts.reduce((a, t) => a + t.write, 0) - ts.reduce((a, t) => a + t.recWrite, 0)) / ts.reduce((a, t) => a + t.recWrite, 0),
		promptErrorMedian: quantile(promptErrors, 0.5),
		promptErrorP90: quantile(promptErrors, 0.9),
	};
	result.shockedWriteError = (shocked.reduce((a, t) => a + t.write, 0) - ts.reduce((a, t) => a + t.recWrite, 0)) / ts.reduce((a, t) => a + t.recWrite, 0);
	result.shockedReadError = (shocked.reduce((a, t) => a + t.read, 0) - recRead) / recRead;
	result.pass = Math.abs(result.aggregateReadError) <= GATE.readErrorMax && result.medianSessionReadError <= GATE.readErrorMax && result.spearmanRead >= GATE.spearmanMin;
	return result;
}

/** Paired comparison of arm k against arm 0 on all sessions. */
function compare(sessions, k, model, seed) {
	const metric = (s, arm) => {
		const t = totals(s, arm, model, true);
		const c = s.arms[arm].counters;
		return {
			promptMtok: t.prompt / 1e6,
			writeMtok: t.write / 1e6,
			costUsd: (t.read * PRICE.cacheRead + t.write * PRICE.cacheWrite) / 1e6,
			thinkingInvalidatedByEdit: c.thinkingInvalidatedByEdit,
			cmEdits: c.cmEdits,
			refetchIdenticalAfterMask: c.refetchIdenticalAfterMask,
		};
	};
	const pairs = sessions.map((s) => [metric(s, 0), metric(s, k)]);
	return Object.fromEntries(Object.keys(pairs[0][0]).map((key) => {
		const diffs = pairs.map(([a, b]) => b[key] - a[key]);
		const ci = bootstrapPairedSum(diffs, RESAMPLES, prng(seed));
		return [key, { base: pairs.reduce((s, [a]) => s + a[key], 0), arm: pairs.reduce((s, [, b]) => s + b[key], 0), ...ci }];
	}));
}

function main() {
	if (process.argv.includes("--same")) {
		const [a, b] = process.argv.slice(process.argv.indexOf("--same") + 1);
		const h = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
		const same = h(a) === h(b);
		console.log(`determinism gate: ${same ? "PASS" : "FAIL"} (${h(a).slice(0, 16)} vs ${h(b).slice(0, 16)})`);
		process.exit(same ? 0 : 1);
	}
	const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
	const seed = Number(arg("seed", "20261102"));
	const train = run.sessions.filter((s) => s.index % 2 === 1);
	const heldOut = run.sessions.filter((s) => s.index % 2 === 0);
	const rows = fitRows(train, 0);
	const model = { charsPerToken: fitCharsPerToken(rows) };
	const g = gates(heldOut, model);
	console.log(`run ${run.listHash}; arms ${run.arms.map((a) => `${a.name}@${a.sourceHash}`).join(", ")}; seed ${seed}`);
	console.log(`token model: ${model.charsPerToken.toFixed(3)} chars per token (fitted on ${train.length} sessions, ${rows.length} call pairs)`);
	console.log(`harness gate on ${g.sessions} held-out sessions: ${g.pass ? "PASS" : "FAIL"}`);
	console.log(`  cache read: aggregate error ${pct(g.aggregateReadError)}, median per-session error ${pct(g.medianSessionReadError)}, Spearman ${g.spearmanRead.toFixed(3)}`);
	console.log(`  prompt size per call: median error ${pct(g.promptErrorMedian)}, p90 ${pct(g.promptErrorP90)}; cache write aggregate error ${pct(g.aggregateWriteError)} (informative)`);
	console.log(`  with recorded exogenous rewrites (used for comparisons): read error ${pct(g.shockedReadError)}, write error ${pct(g.shockedWriteError)}`);
	const comparisons = run.arms.slice(1).map((arm, j) => ({ arm: arm.name, metrics: compare(run.sessions, j + 1, model, seed) }));
	for (const c of comparisons) {
		console.log(`\n${c.arm} - ${run.arms[0].name} (sum over ${run.sessions.length} sessions, 95% CI):`);
		for (const [key, v] of Object.entries(c.metrics)) console.log(`  ${key.padEnd(26)} ${v.base.toFixed(2)} -> ${v.arm.toFixed(2)}  diff ${v.estimate.toFixed(2)} [${v.low.toFixed(2)}, ${v.high.toFixed(2)}]`);
	}
	const out = arg("json");
	if (out) writeFileSync(out, JSON.stringify({ listHash: run.listHash, arms: run.arms, seed, model, gates: g, comparisons }, null, 1));
}

main();
