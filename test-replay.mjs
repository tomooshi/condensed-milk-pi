#!/usr/bin/env node
/**
 * Offline replay harness — compare rolling-window vs static-cutoff
 * masking against a real session JSONL.
 *
 * Simulates what pi would have sent to the LLM on each turn under each
 * algorithm. Hashes the message prefix up to the last user turn. A
 * distinct hash = a distinct cache variant. Counts variants + estimates
 * cache-write vs cache-read cost.
 *
 * Usage: node test-replay.mjs <session.jsonl> [threshold]
 *   threshold defaults to 0.25 (advance cutoff when contextUsage crosses
 *   15%, 25%, 40%)
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { argv, exit } from "node:process";

// ---------- Shared helpers ----------
const REFERENCE_FILES = new Set([
  "AGENTS.md", "CONVENTIONS.md", "CLAUDE.md",
  ".ruff.toml", "ruff.toml", "biome.json",
  "pyproject.toml", "package.json", "tsconfig.json",
  "sgconfig.yml", ".shellcheckrc",
]);
const MIN_MASK_LENGTH = 120;
function isReferenceFile(path) {
  return REFERENCE_FILES.has(path.split("/").pop() ?? path);
}
function isBashTR(m) { return m?.role === "toolResult" && m?.toolName === "bash"; }
function isReadTR(m) { return m?.role === "toolResult" && m?.toolName === "read"; }
function isAlreadyMasked(m) {
  if (m?.role !== "toolResult") return false;
  const c = (m.content ?? [])[0];
  return c?.type === "text" && (c.text?.startsWith("[cm-masked ") || c.text?.startsWith("[compressed]"));
}
function textContent(m) {
  return (m?.content ?? []).filter(c => c?.type === "text").map(c => c.text ?? "").join("\n");
}
function buildToolCallIndex(messages) {
  const idx = new Map();
  for (const m of messages) {
    const msg = m?.message ?? m;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b?.type !== "toolCall") continue;
      const id = b.id ?? b.toolCallId;
      if (!id) continue;
      const args = b.arguments ?? b.input ?? {};
      idx.set(id, {
        command: typeof args.command === "string" ? args.command : undefined,
        path: typeof args.path === "string" ? args.path : undefined,
      });
    }
  }
  return idx;
}
function extractCommand(m, idx) {
  const fd = m?.details?.command ?? m?.input?.command;
  if (fd) return fd;
  return idx?.get(m?.toolCallId)?.command ?? "";
}
function extractPath(m, idx) {
  const fd = m?.details?.path ?? m?.input?.path;
  if (fd) return fd;
  return idx?.get(m?.toolCallId)?.path ?? "";
}
function replaceContent(m, text) {
  const msg = m.message ?? m;
  if (m.message) return { ...m, message: { ...msg, content: [{ type: "text", text }] } };
  return { ...m, content: [{ type: "text", text }] };
}

// ---------- Algorithm A: rolling window (current v1.1.1) ----------
function maskRolling(messages, windowSize) {
  if (messages.length <= windowSize) return messages;
  const staleBeforeIdx = messages.length - windowSize;
  const toolCallIdx = buildToolCallIndex(messages);
  return messages.map((m, idx) => {
    const msg = m.message ?? m;
    if (isAlreadyMasked(msg)) return m;
    if (isBashTR(msg) && !msg.isError) {
      const c = textContent(msg);
      if (c.length < MIN_MASK_LENGTH) return m;
      if (idx < staleBeforeIdx) {
        const cmd = extractCommand(msg, toolCallIdx);
        return replaceContent(m, cmd ? `[cm-masked bash] ${cmd.slice(0, 80)}` : `[cm-masked bash]`);
      }
    }
    if (isReadTR(msg) && !msg.isError) {
      const p = extractPath(msg, toolCallIdx);
      const c = textContent(msg);
      if (p && c.length >= MIN_MASK_LENGTH && !isReferenceFile(p) && idx < staleBeforeIdx) {
        return replaceContent(m, `[cm-masked read] ${p}`);
      }
    }
    return m;
  });
}

// ---------- Algorithm B: static cutoff (Option A proposal) ----------
// Cutoff T advances only when contextUsage crosses a pressure threshold.
// Between advances, T is fixed → mask frontier doesn't drift → cache prefix
// bytes at position <T stay identical turn-over-turn.
function maskStaticCutoff(messages, cutoffIdx) {
  if (cutoffIdx <= 0) return messages;
  const toolCallIdx = buildToolCallIndex(messages);
  return messages.map((m, idx) => {
    if (idx >= cutoffIdx) return m;
    const msg = m.message ?? m;
    if (isAlreadyMasked(msg)) return m;
    if (isBashTR(msg) && !msg.isError) {
      const c = textContent(msg);
      if (c.length < MIN_MASK_LENGTH) return m;
      const cmd = extractCommand(msg, toolCallIdx);
      return replaceContent(m, cmd ? `[cm-masked bash] ${cmd.slice(0, 80)}` : `[cm-masked bash]`);
    }
    if (isReadTR(msg) && !msg.isError) {
      const p = extractPath(msg, toolCallIdx);
      const c = textContent(msg);
      if (p && c.length >= MIN_MASK_LENGTH && !isReferenceFile(p)) {
        return replaceContent(m, `[cm-masked read] ${p}`);
      }
    }
    return m;
  });
}

// ---------- Cache simulation ----------
// Treat the message array as pi would: hash bytes up to and including
// the last user message ("prefix cached at BP2"). A new distinct hash
// = a new cache variant; all tokens inside it must be rewritten. If
// the hash was seen before, all tokens are cache-reads.

function lastUserIdx(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]?.message ?? messages[i];
    if (msg?.role === "user") return i;
  }
  return -1;
}

function prefixHash(messages, upToInclusive) {
  const h = createHash("sha256");
  for (let i = 0; i <= upToInclusive; i++) {
    h.update(JSON.stringify(messages[i]?.message ?? messages[i]));
  }
  return h.digest("hex");
}

function prefixTokens(messages, upToInclusive) {
  // Approximate: 4 chars per token (same rule-of-thumb condensed-milk uses)
  let chars = 0;
  for (let i = 0; i <= upToInclusive; i++) {
    chars += JSON.stringify(messages[i]?.message ?? messages[i]).length;
  }
  return Math.round(chars / 4);
}

// Simulate one "API call" = hash prefix, compare to seen set.
function simulate(turnMessages) {
  let seen = new Set();
  let cacheWrites = 0;
  let cacheReads = 0;
  let variants = 0;
  for (const messages of turnMessages) {
    const idx = lastUserIdx(messages);
    if (idx < 0) continue;
    const h = prefixHash(messages, idx);
    const tokens = prefixTokens(messages, idx);
    if (seen.has(h)) {
      cacheReads += tokens;
    } else {
      cacheWrites += tokens;
      seen.add(h);
      variants++;
    }
  }
  return { variants, cacheWrites, cacheReads };
}

// ---------- Main ----------
const sessionPath = argv[2];
if (!sessionPath) {
  console.error("Usage: node test-replay.mjs <session.jsonl>");
  exit(1);
}

console.log("Loading session:", sessionPath);
const rawLines = readFileSync(sessionPath, "utf-8").split("\n").filter(Boolean);
const fullMessages = [];
for (const line of rawLines) {
  const obj = JSON.parse(line);
  const msg = obj.message ?? obj;
  if (["user", "assistant", "toolResult"].includes(msg?.role)) {
    fullMessages.push(obj);
  }
}
console.log(`Total role-bearing messages: ${fullMessages.length}`);
console.log();

// Simulate turn-by-turn: on each turn, reconstruct the branch up to that
// turn, apply the masking algorithm, observe what prefix would be sent.
// "Turn" = index of an assistant message with usage.
const turnIndices = [];
for (let i = 0; i < fullMessages.length; i++) {
  const msg = fullMessages[i]?.message ?? fullMessages[i];
  if (msg?.role === "assistant" && msg?.usage) turnIndices.push(i);
}
console.log(`Assistant turns with usage: ${turnIndices.length}`);

// Helper: context usage at a given turn index (using assistant usage data)
function ctxUsageAt(turnIdx) {
  const msg = fullMessages[turnIdx]?.message ?? fullMessages[turnIdx];
  const u = msg?.usage;
  if (!u) return 0;
  // Approximate contextWindow = 200K; Anthropic Sonnet/Opus default
  const tokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return tokens / 200_000;
}

function runAlgo(label, maskFn) {
  const turnMessages = [];
  for (const ti of turnIndices) {
    // Messages visible at time of this turn = everything up to (including) this assistant message's parent context.
    // Pi's context event fires BEFORE the assistant turn, so visible = everything before ti.
    const visible = fullMessages.slice(0, ti);
    turnMessages.push(maskFn(visible, ti));
  }
  const sim = simulate(turnMessages);
  const writeCost = sim.cacheWrites * 6.25 / 1_000_000;
  const readCost = sim.cacheReads * 0.5 / 1_000_000;
  console.log(`\n${label}`);
  console.log(`  variants:       ${sim.variants}`);
  console.log(`  cache-writes:   ${sim.cacheWrites.toLocaleString()} tokens  ($${writeCost.toFixed(4)})`);
  console.log(`  cache-reads:    ${sim.cacheReads.toLocaleString()} tokens  ($${readCost.toFixed(4)})`);
  console.log(`  TOTAL:          $${(writeCost + readCost).toFixed(4)}`);
  return { writeCost, readCost, variants: sim.variants, writes: sim.cacheWrites, reads: sim.cacheReads };
}

// Rolling window (current v1.1.1)
const rolling = runAlgo("Rolling window (current v1.1.1, N=10)",
  (visible, _ti) => maskRolling(visible, 10));

// Static cutoff at various thresholds — Option A
// At each turn, decide the cutoff based on cumulative context usage.
// Cutoff advances only when usage crosses the threshold pressure zones.
function makeStaticCutoffFn(thresholds) {
  let currentCutoff = 0;
  let lastZone = -1;
  return (visible, ti) => {
    const usage = ctxUsageAt(ti);
    // Determine pressure zone
    let zone = -1;
    for (let z = thresholds.length - 1; z >= 0; z--) {
      if (usage >= thresholds[z]) { zone = z; break; }
    }
    // Advance cutoff only on zone transition (one-shot batch)
    if (zone > lastZone) {
      // Each zone masks progressively more of the oldest messages
      const fraction = 0.5 + zone * 0.25;  // zone 0: 50%, zone 1: 75%, zone 2: 90%
      currentCutoff = Math.max(currentCutoff, Math.floor(visible.length * fraction));
      lastZone = zone;
    }
    return maskStaticCutoff(visible, currentCutoff);
  };
}

const staticA = runAlgo("Static cutoff (Option A, thresholds=[0.15, 0.25, 0.40])",
  makeStaticCutoffFn([0.15, 0.25, 0.40]));

const staticB = runAlgo("Static cutoff v1.2.0 semi-rolling (thresholds=[0.20, 0.35, 0.50])",
  makeStaticCutoffFn([0.20, 0.35, 0.50]));

// v1.2.1 true-static: cutoff freezes at zone entry, does NOT re-derive
// from messages.length on subsequent turns.
function makeTrueStaticFn(thresholds) {
  const coverage = [0.50, 0.75, 0.90];
  let zoneEntered = -1;
  let frozenCutoff = 0;
  return (visible, ti) => {
    const usage = ctxUsageAt(ti);
    let zone = -1;
    for (let z = thresholds.length - 1; z >= 0; z--) {
      if (usage >= thresholds[z]) { zone = z; break; }
    }
    if (zone > zoneEntered) {
      // Freeze cutoff at CURRENT length × coverage[zone]. Do NOT update later.
      frozenCutoff = Math.max(frozenCutoff, Math.floor(visible.length * coverage[zone]));
      zoneEntered = zone;
    }
    return maskStaticCutoff(visible, frozenCutoff);
  };
}

const trueStatic = runAlgo("TRUE-STATIC v1.2.1 (frozen at zone entry, thresholds=[0.20, 0.35, 0.50])",
  makeTrueStaticFn([0.20, 0.35, 0.50]));

// No masking baseline
const noMask = runAlgo("No retroactive masking (baseline)",
  (visible, _ti) => visible);

// Summary
console.log(`\n${'='.repeat(70)}`);
console.log("SUMMARY");
console.log("="+'='.repeat(69));
const rollingTotal = rolling.writeCost + rolling.readCost;
const rows = [
  ["Algorithm", "Variants", "Write $", "Read $", "Total $", "vs rolling"],
  ["No masking", noMask.variants, noMask.writeCost.toFixed(2), noMask.readCost.toFixed(2), (noMask.writeCost+noMask.readCost).toFixed(2), ((noMask.writeCost+noMask.readCost)/rollingTotal*100).toFixed(0)+"%"],
  ["Rolling N=10 (v1.1.1)", rolling.variants, rolling.writeCost.toFixed(2), rolling.readCost.toFixed(2), rollingTotal.toFixed(2), "100%"],
  ["Static semi [.15/.25/.40]", staticA.variants, staticA.writeCost.toFixed(2), staticA.readCost.toFixed(2), (staticA.writeCost+staticA.readCost).toFixed(2), ((staticA.writeCost+staticA.readCost)/rollingTotal*100).toFixed(0)+"%"],
  ["Static semi [.20/.35/.50] v1.2.0", staticB.variants, staticB.writeCost.toFixed(2), staticB.readCost.toFixed(2), (staticB.writeCost+staticB.readCost).toFixed(2), ((staticB.writeCost+staticB.readCost)/rollingTotal*100).toFixed(0)+"%"],
  ["TRUE-STATIC v1.2.1", trueStatic.variants, trueStatic.writeCost.toFixed(2), trueStatic.readCost.toFixed(2), (trueStatic.writeCost+trueStatic.readCost).toFixed(2), ((trueStatic.writeCost+trueStatic.readCost)/rollingTotal*100).toFixed(0)+"%"],
];
for (const row of rows) {
  console.log(row.map((c, i) => String(c).padEnd(i === 0 ? 24 : 12)).join(""));
}
