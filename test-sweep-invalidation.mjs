#!/usr/bin/env node
/**
 * Bash-invalidation audit sweep — compare cache economics WITH and
 * WITHOUT the built-in bash-invalidation rules (git add→git status etc).
 *
 * Research finding (knowledge/findings/retroactive-invalidation-net-negative-research.md)
 * showed mid-prefix invalidation is cache-costly. This audit measures
 * whether the existing bash rules, which fire mid-session, pay off.
 *
 * Each session is run through two variants:
 *   A: position-based masking only (no invalidation)
 *   B: position-based + bash invalidation rules active
 *
 * Both use default reference-file protection and default cutoff
 * thresholds (T.20/.35/.50 | C.50/.75/.90).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { argv, exit, stderr } from "node:process";
import { basename } from "node:path";

const REFERENCE_BASENAMES = new Set([
  "AGENTS.md", "CONVENTIONS.md", "CLAUDE.md", "GEMINI.md", "SKILL.md",
  ".ruff.toml", "ruff.toml", "biome.json",
  "pyproject.toml", "package.json", "tsconfig.json",
  "sgconfig.yml", ".shellcheckrc",
  "README.md", "CHANGELOG.md",
]);
const REFERENCE_PATH_SUBSTRINGS = [
  "/knowledge/decisions/", "/knowledge/concepts/", "/knowledge/patterns/",
  "/.pi/agent/skills/", "/.pi/skills/", "/rules/",
];
const INVALIDATION_RULES = [
  { invalidator: /^git\s+(add|rm|checkout|reset|stash|merge|rebase|cherry-pick)\b/, invalidated: /^git\s+status\b/ },
  { invalidator: /^git\s+(commit|merge|rebase)\b/, invalidated: /^git\s+(diff|log)\b/ },
  { invalidator: /^(npm|pnpm|yarn|bun)\s+(install|add|remove)\b/, invalidated: /^(npm|pnpm|yarn|bun)\s+(ls|list|outdated)\b/ },
  { invalidator: /^pip\s+install\b/, invalidated: /^pip\s+(list|freeze)\b/ },
];
const MIN_MASK_LENGTH = 120;

function isReferenceFile(path) {
  const base = path.split("/").pop() ?? path;
  if (REFERENCE_BASENAMES.has(base)) return true;
  for (const sub of REFERENCE_PATH_SUBSTRINGS) if (path.includes(sub)) return true;
  return false;
}

function parseCdPrefix(cmd) {
  let cwd;
  let current = cmd;
  for (;;) {
    const m = /^cd\s+(\S+)\s*&&\s*(.+)$/s.exec(current);
    if (!m) break;
    cwd = m[1];
    current = m[2];
  }
  return { cwd, cmd: current };
}

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
      const rawCmd = typeof args.command === "string" ? args.command : undefined;
      const cwd = rawCmd ? parseCdPrefix(rawCmd).cwd : undefined;
      idx.set(id, {
        command: rawCmd,
        path: typeof args.path === "string" ? args.path : undefined,
        cwd,
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

function bashInvalidated(command, msgIdx, messages, toolCallIdx) {
  const self = parseCdPrefix(command);
  const applicable = INVALIDATION_RULES.filter(r => r.invalidated.test(self.cmd));
  if (applicable.length === 0) return false;
  for (let i = msgIdx + 1; i < messages.length; i++) {
    const later = messages[i]?.message ?? messages[i];
    if (!isBashTR(later)) continue;
    const laterRaw = extractCommand(later, toolCallIdx);
    const laterParsed = parseCdPrefix(laterRaw);
    if (self.cwd !== laterParsed.cwd) continue;
    if (applicable.some(r => r.invalidator.test(laterParsed.cmd))) return true;
  }
  return false;
}

function maybeMask(m, msgIdx, messages, toolCallIdx, pastCutoff, useInvalidation) {
  const msg = m.message ?? m;
  if (isAlreadyMasked(msg)) return null;

  if (isBashTR(msg) && !msg.isError) {
    const c = textContent(msg);
    if (c.length < MIN_MASK_LENGTH) return null;
    const cmd = extractCommand(msg, toolCallIdx);
    const inv = !pastCutoff && useInvalidation && bashInvalidated(cmd, msgIdx, messages, toolCallIdx);
    if (pastCutoff || inv) {
      return replaceContent(m, cmd ? `[cm-masked bash] ${cmd.slice(0, 80)}` : `[cm-masked bash]`);
    }
    return null;
  }

  if (isReadTR(msg) && !msg.isError) {
    const p = extractPath(msg, toolCallIdx);
    const c = textContent(msg);
    if (pastCutoff && p && c.length >= MIN_MASK_LENGTH && !isReferenceFile(p)) {
      let lines = 0; if (c.length > 0) { lines = 1; for (let i = 0; i < c.length; i++) if (c.charCodeAt(i) === 10) lines++; }
      const size = c.length < 1024 ? `${c.length}B`
                 : c.length < 1048576 ? `${(c.length/1024).toFixed(1)}KB`
                 : `${(c.length/1048576).toFixed(1)}MB`;
      return replaceContent(m, `[cm-masked read] ${p} (${lines} lines, ${size})`);
    }
    return null;
  }

  return null;
}

function loadSession(path) {
  const rawLines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const fullMessages = [];
  for (const line of rawLines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj.message ?? obj;
    if (["user", "assistant", "toolResult"].includes(msg?.role)) fullMessages.push(obj);
  }
  return fullMessages;
}

function simulate(messages, thresholds, coverage, useInvalidation) {
  const N = messages.length;
  const toolCallIdx = buildToolCallIndex(messages);

  const turnIndices = [];
  const usageCtx = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const msg = messages[i]?.message ?? messages[i];
    if (msg?.role === "assistant" && msg?.usage) {
      turnIndices.push(i);
      const u = msg.usage;
      usageCtx[i] = ((u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)) / 200_000;
    }
  }

  const origLen = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    try { origLen[i] = JSON.stringify(messages[i]?.message ?? messages[i]).length; }
    catch { origLen[i] = 0; }
  }

  let zoneEntered = -1;
  let frozenCutoff = 0;
  let zoneTransitions = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  const seen = new Set();
  let variants = 0;
  let bashInvalidationsApplied = 0;

  for (const ti of turnIndices) {
    const usage = usageCtx[ti];
    let zone = -1;
    for (let z = thresholds.length - 1; z >= 0; z--) {
      if (usage >= thresholds[z]) { zone = z; break; }
    }
    if (zone > zoneEntered) {
      const newCutoff = Math.max(frozenCutoff, Math.floor(ti * coverage[zone]));
      frozenCutoff = newCutoff;
      zoneEntered = zone;
      zoneTransitions++;
    }

    let lui = -1;
    for (let i = ti - 1; i >= 0; i--) {
      const msg = messages[i]?.message ?? messages[i];
      if (msg?.role === "user") { lui = i; break; }
    }
    if (lui < 0) continue;

    const h = createHash("sha256");
    let totalChars = 0;
    for (let i = 0; i <= lui; i++) {
      const pastCutoff = i < frozenCutoff;
      const m = messages[i];
      const msg = m?.message ?? m;
      const maskedRes = maybeMask(m, i, messages, toolCallIdx, pastCutoff, useInvalidation);
      if (maskedRes) {
        const ms = JSON.stringify(maskedRes?.message ?? maskedRes);
        h.update(ms);
        totalChars += ms.length;
        if (!pastCutoff && useInvalidation && isBashTR(msg)) bashInvalidationsApplied++;
      } else {
        h.update(JSON.stringify(msg));
        totalChars += origLen[i];
      }
    }
    const tokens = Math.round(totalChars / 4);
    const digest = h.digest("hex");
    if (seen.has(digest)) {
      cacheReadTokens += tokens;
    } else {
      cacheWriteTokens += tokens;
      seen.add(digest);
      variants++;
    }
  }

  const writeCost = cacheWriteTokens * 6.25 / 1_000_000;
  const readCost = cacheReadTokens * 0.5 / 1_000_000;
  return {
    variants, zoneTransitions, cacheWriteTokens, cacheReadTokens,
    writeCost, readCost, total: writeCost + readCost,
    bashInvalidationsApplied,
  };
}

const paths = argv.slice(2);
if (paths.length === 0) {
  console.error("Usage: node test-sweep-invalidation.mjs <session.jsonl> [...]");
  exit(1);
}

const THRESHOLDS = [0.20, 0.35, 0.50];
const COVERAGE = [0.50, 0.75, 0.90];

console.log("session,turns,invalidation,variants,zt,cache_writes,cache_reads,write_cost,read_cost,total_cost,bash_inv_applied");

for (const p of paths) {
  stderr.write(`\nLoading ${basename(p)}...`);
  const msgs = loadSession(p);
  const turns = msgs.filter(m => {
    const msg = m?.message ?? m;
    return msg?.role === "assistant" && msg?.usage;
  }).length;
  stderr.write(` N=${msgs.length} turns=${turns}\n`);

  const sessLabel = basename(p).slice(0, 40);

  for (const useInv of [false, true]) {
    const t0 = Date.now();
    const r = simulate(msgs, THRESHOLDS, COVERAGE, useInv);
    console.log([
      sessLabel, turns, useInv ? "on" : "off",
      r.variants, r.zoneTransitions, r.cacheWriteTokens, r.cacheReadTokens,
      r.writeCost.toFixed(4), r.readCost.toFixed(4), r.total.toFixed(4),
      r.bashInvalidationsApplied,
    ].join(","));
    stderr.write(`  invalidation=${useInv ? "on" : "off"}: var=${r.variants} zt=${r.zoneTransitions} $${r.total.toFixed(3)} bash_inv=${r.bashInvalidationsApplied} (${((Date.now()-t0)/1000).toFixed(1)}s)\n`);
  }
}
