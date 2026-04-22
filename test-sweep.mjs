#!/usr/bin/env node
/**
 * Parameter sweep harness — grid over (thresholds × coverage) for
 * condensed-milk-pi true-static cutoff. Replays real session JSONLs.
 *
 * Optimized: pre-serializes each message once, computes per-message
 * sha256 for original + masked variant, chains prefix hash over the
 * per-message digests (O(N) per turn, not O(N²)).
 *
 * Output: CSV to stdout + progress to stderr.
 *
 * Usage: node test-sweep.mjs <session.jsonl> [session.jsonl ...]
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { argv, exit, stderr } from "node:process";
import { basename } from "node:path";

// ---------- Masking helpers ----------
const REFERENCE_FILES = new Set([
  "AGENTS.md", "CONVENTIONS.md", "CLAUDE.md",
  ".ruff.toml", "ruff.toml", "biome.json",
  "pyproject.toml", "package.json", "tsconfig.json",
  "sgconfig.yml", ".shellcheckrc",
]);
const MIN_MASK_LENGTH = 120;
const isReferenceFile = (p) => REFERENCE_FILES.has(p.split("/").pop() ?? p);
const isBashTR = (m) => m?.role === "toolResult" && m?.toolName === "bash";
const isReadTR = (m) => m?.role === "toolResult" && m?.toolName === "read";
function isAlreadyMasked(m) {
  if (m?.role !== "toolResult") return false;
  const c = (m.content ?? [])[0];
  return c?.type === "text" && (c.text?.startsWith("[cm-masked ") || c.text?.startsWith("[compressed]"));
}
const textContent = (m) => (m?.content ?? []).filter(c => c?.type === "text").map(c => c.text ?? "").join("\n");
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
const extractCommand = (m, idx) => m?.details?.command ?? m?.input?.command ?? idx?.get(m?.toolCallId)?.command ?? "";
const extractPath = (m, idx) => m?.details?.path ?? m?.input?.path ?? idx?.get(m?.toolCallId)?.path ?? "";
function replaceContent(m, text) {
  const msg = m.message ?? m;
  if (m.message) return { ...m, message: { ...msg, content: [{ type: "text", text }] } };
  return { ...m, content: [{ type: "text", text }] };
}

// Return masked message OR null if this message is not maskable.
function maybeMask(m, toolCallIdx) {
  const msg = m.message ?? m;
  if (isAlreadyMasked(msg)) return null;
  if (isBashTR(msg) && !msg.isError) {
    const c = textContent(msg);
    if (c.length < MIN_MASK_LENGTH) return null;
    const cmd = extractCommand(msg, toolCallIdx);
    return replaceContent(m, cmd ? `[cm-masked bash] ${cmd.slice(0, 80)}` : `[cm-masked bash]`);
  }
  if (isReadTR(msg) && !msg.isError) {
    const p = extractPath(msg, toolCallIdx);
    const c = textContent(msg);
    if (p && c.length >= MIN_MASK_LENGTH && !isReferenceFile(p)) {
      // v1.4.0 enriched placeholder — deterministic per message.
      let lines = 0; if (c.length > 0) { lines = 1; for (let i = 0; i < c.length; i++) if (c.charCodeAt(i) === 10) lines++; }
      const size = c.length < 1024 ? `${c.length}B`
                : c.length < 1048576 ? `${(c.length/1024).toFixed(1)}KB`
                : `${(c.length/1048576).toFixed(1)}MB`;
      return replaceContent(m, `[cm-masked read] ${p} (${lines} lines, ${size})`);
    }
  }
  return null;
}

// ---------- Session loading + pre-computation ----------
function loadSession(path) {
  const rawLines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const fullMessages = [];
  let parseFails = 0;
  for (const line of rawLines) {
    let obj;
    try { obj = JSON.parse(line); } catch { parseFails++; continue; }
    const msg = obj.message ?? obj;
    if (["user", "assistant", "toolResult"].includes(msg?.role)) {
      fullMessages.push(obj);
    }
  }
  if (parseFails > 0) stderr.write(`  (${parseFails} unparseable lines skipped)\n`);

  const toolCallIdx = buildToolCallIndex(fullMessages);
  const N = fullMessages.length;

  // Pre-compute for every message:
  //   origSer[i]    — JSON of original message
  //   origHash[i]   — sha256 digest bytes of origSer[i]
  //   maskedHash[i] — sha256 digest bytes of masked serialization, OR equal to origHash[i] if not maskable
  //   origLen[i]    — char length of origSer[i]
  //   maskedLen[i]  — char length of masked ser, or origLen[i]
  //   isLastUserCandidate[i] — msg is role=user
  //   isTurn[i]     — assistant with usage
  //   usageCtx[i]   — fractional context at turn i (0 otherwise)
  const origSer = new Array(N);
  const origHash = new Array(N);
  const maskedHash = new Array(N);
  const origLen = new Int32Array(N);
  const maskedLen = new Int32Array(N);
  const isUser = new Uint8Array(N);
  const isTurn = new Uint8Array(N);
  const usageCtx = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    const m = fullMessages[i];
    const msg = m?.message ?? m;
    let s;
    try { s = JSON.stringify(m?.message ?? m); }
    catch { s = ""; }
    origSer[i] = s;
    origLen[i] = s.length;
    origHash[i] = createHash("sha256").update(s).digest();
    if (msg?.role === "user") isUser[i] = 1;
    if (msg?.role === "assistant" && msg?.usage) {
      isTurn[i] = 1;
      const u = msg.usage;
      usageCtx[i] = ((u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)) / 200_000;
    }
    const maskedMsg = maybeMask(m, toolCallIdx);
    if (maskedMsg) {
      let ms;
      try { ms = JSON.stringify(maskedMsg?.message ?? maskedMsg); } catch { ms = s; }
      maskedLen[i] = ms.length;
      maskedHash[i] = createHash("sha256").update(ms).digest();
    } else {
      maskedLen[i] = origLen[i];
      maskedHash[i] = origHash[i];
    }
  }

  // Cumulative len arrays for O(1) prefix token lookup.
  // cumOrig[i] = sum(origLen[0..i-1]); cumOrig[i+1] - cumOrig[0] = prefix chars
  const cumOrig = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) cumOrig[i + 1] = cumOrig[i] + origLen[i];

  // Delta per masked position: maskedLen - origLen (≤ 0 usually)
  const deltaLen = new Float64Array(N);
  for (let i = 0; i < N; i++) deltaLen[i] = maskedLen[i] - origLen[i];
  const cumDelta = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) cumDelta[i + 1] = cumDelta[i] + deltaLen[i];

  const turnIndices = [];
  for (let i = 0; i < N; i++) if (isTurn[i]) turnIndices.push(i);

  // For each turn index t, find lastUserIdx within messages[0..t-1].
  // Precompute: lastUserBefore[i] = greatest j<i with isUser[j], else -1.
  const lastUserBefore = new Int32Array(N + 1);
  let lu = -1;
  lastUserBefore[0] = -1;
  for (let i = 0; i < N; i++) {
    lastUserBefore[i + 1] = lu;
    if (isUser[i]) lu = i;
  }

  return { N, origHash, maskedHash, cumOrig, cumDelta, turnIndices, usageCtx, lastUserBefore };
}

// ---------- Run one (thresholds, coverage) on one pre-computed session ----------
function runConfig(session, thresholds, coverage) {
  const { N, origHash, maskedHash, cumOrig, cumDelta, turnIndices, usageCtx, lastUserBefore } = session;

  let zoneEntered = -1;
  let frozenCutoff = 0;
  let zoneTransitions = 0;

  // Current per-position hash array: starts as origHash everywhere. As
  // cutoff advances, positions [prev..new) swap to maskedHash.
  const curHash = origHash.slice();  // refs to digest Buffers; safe
  // deltaApplied[i] == 1 if position i currently uses maskedHash.
  // Tracked via nextMaskPos pointer since cutoff is monotone.
  let nextMaskPos = 0;

  const seen = new Set();
  let cacheWrites = 0;
  let cacheReads = 0;
  let variants = 0;

  // Scratch hasher accumulator — must re-hash prefix each turn (O(prefixLen)
  // per turn, ~32 bytes per message → fast).
  for (const ti of turnIndices) {
    const usage = usageCtx[ti];
    let zone = -1;
    for (let z = thresholds.length - 1; z >= 0; z--) {
      if (usage >= thresholds[z]) { zone = z; break; }
    }
    // visible.length is ti (messages 0..ti-1)
    if (zone > zoneEntered) {
      const newCutoff = Math.max(frozenCutoff, Math.floor(ti * coverage[zone]));
      // Apply masked hash for positions [nextMaskPos..newCutoff)
      for (let i = nextMaskPos; i < newCutoff; i++) curHash[i] = maskedHash[i];
      nextMaskPos = Math.max(nextMaskPos, newCutoff);
      frozenCutoff = newCutoff;
      zoneEntered = zone;
      zoneTransitions++;
    }
    const lui = lastUserBefore[ti];
    if (lui < 0) continue;

    // prefix token count = (cumOrig[lui+1]) + (cumDelta adjustment for masked range within [0..lui])
    const maskedUpto = Math.min(frozenCutoff, lui + 1);
    const prefixChars = cumOrig[lui + 1] + cumDelta[maskedUpto];
    const tokens = Math.round(prefixChars / 4);

    // Chained sha256 over curHash[0..lui]
    const h = createHash("sha256");
    for (let i = 0; i <= lui; i++) h.update(curHash[i]);
    const digest = h.digest("hex");

    if (seen.has(digest)) {
      cacheReads += tokens;
    } else {
      cacheWrites += tokens;
      seen.add(digest);
      variants++;
    }
  }

  const writeCost = cacheWrites * 6.25 / 1_000_000;
  const readCost = cacheReads * 0.5 / 1_000_000;
  return { variants, cacheWrites, cacheReads, writeCost, readCost, total: writeCost + readCost, zoneTransitions };
}

// ---------- Grid ----------
const THRESHOLD_SETS = [
  { name: "T.15/.30/.45", vals: [0.15, 0.30, 0.45] },
  { name: "T.20/.35/.50", vals: [0.20, 0.35, 0.50] },  // current default
  { name: "T.25/.40/.55", vals: [0.25, 0.40, 0.55] },
  { name: "T.30/.45/.60", vals: [0.30, 0.45, 0.60] },
];
const COVERAGE_SETS = [
  { name: "C.50/.75/.90", vals: [0.50, 0.75, 0.90] },  // current default
  { name: "C.40/.70/.90", vals: [0.40, 0.70, 0.90] },
  { name: "C.60/.80/.95", vals: [0.60, 0.80, 0.95] },
];

const paths = argv.slice(2);
if (paths.length === 0) {
  console.error("Usage: node test-sweep.mjs <session.jsonl> [...]");
  exit(1);
}

console.log("session,turns,threshold,coverage,variants,zone_transitions,cache_writes,cache_reads,write_cost,read_cost,total_cost");

for (const p of paths) {
  const t0 = Date.now();
  stderr.write(`\nLoading ${basename(p)}...`);
  const sess = loadSession(p);
  stderr.write(` N=${sess.N} turns=${sess.turnIndices.length} (${((Date.now()-t0)/1000).toFixed(1)}s)\n`);
  const sessLabel = basename(p).slice(0, 40);
  for (const T of THRESHOLD_SETS) {
    for (const C of COVERAGE_SETS) {
      const tc = Date.now();
      const r = runConfig(sess, T.vals, C.vals);
      console.log([
        sessLabel, sess.turnIndices.length, T.name, C.name,
        r.variants, r.zoneTransitions, r.cacheWrites, r.cacheReads,
        r.writeCost.toFixed(4), r.readCost.toFixed(4), r.total.toFixed(4),
      ].join(","));
      stderr.write(`  ${T.name} × ${C.name}: var=${r.variants} zt=${r.zoneTransitions} $${r.total.toFixed(3)} (${((Date.now()-tc)/1000).toFixed(1)}s)\n`);
    }
  }
}
