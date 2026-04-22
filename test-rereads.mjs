#!/usr/bin/env node
/**
 * Unit-ish smoke test for the v1.3.0 exp 3 changes.
 *
 * We cannot import context-compress.ts directly without a ts-loader,
 * so we replicate the minimal logic here and assert the contract:
 *   compressStaleToolResults returns maskedPaths and maskedCommands
 *   listing ONLY the newly-masked items.
 *
 * Running this confirms the CompressResult shape matches what index.ts
 * now expects. Real integration happens when pi loads the extension.
 */
import { spawnSync } from "node:child_process";

// Use tsc with a minimal config in a tmp dir to compile context-compress.ts
// and load the compiled output. Avoids any runtime .ts loader dep.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "cm-test-"));
const srcPath = join(tmp, "context-compress.ts");
writeFileSync(srcPath, readFileSync("filters/context-compress.ts", "utf-8"));

const tsc = spawnSync("npx", ["-y", "-p", "typescript@5.9", "tsc",
  "--target", "es2022",
  "--module", "esnext",
  "--moduleResolution", "bundler",
  "--skipLibCheck",
  "--strict", "false",
  "--noImplicitAny", "false",
  "--outDir", tmp,
  srcPath,
], { encoding: "utf-8" });
if (tsc.status !== 0) {
  console.error("tsc failed:");
  console.error(tsc.stdout);
  console.error(tsc.stderr);
  process.exit(1);
}

const mod = await import(join(tmp, "context-compress.js"));
const { compressStaleToolResults, parseCdPrefix, resolveRules, emptyUserConfig } = mod;

// Build a fake 20-message branch with 3 bash + 2 read tool results masked,
// the rest are plain user/assistant text.
function userMsg(text) { return { role: "user", content: [{ type: "text", text }] }; }
function asstMsg(text, toolCalls = [], usage = null) {
  const content = [{ type: "text", text }];
  for (const tc of toolCalls) content.push({ type: "toolCall", id: tc.id, arguments: tc.args });
  const out = { role: "assistant", content };
  if (usage) out.usage = usage;
  return out;
}
function bashResult(id, command, output) {
  return { role: "toolResult", toolName: "bash", toolCallId: id, isError: false,
    content: [{ type: "text", text: output }] };
}
function readResult(id, path, output) {
  return { role: "toolResult", toolName: "read", toolCallId: id, isError: false,
    content: [{ type: "text", text: output }] };
}

const long = "x".repeat(500);
const messages = [];
// Build enough messages that cutoff well > 0
for (let i = 0; i < 10; i++) {
  messages.push(userMsg(`user turn ${i}`));
  messages.push(asstMsg(`assistant turn ${i} calling bash`, [{ id: `tc_b_${i}`, args: { command: `ls /path/${i}` } }], { input: 50000 }));
  messages.push(bashResult(`tc_b_${i}`, `ls /path/${i}`, long));
  messages.push(asstMsg(`assistant turn ${i} calling read`, [{ id: `tc_r_${i}`, args: { path: `/file/${i}.py` } }], { input: 50000 }));
  messages.push(readResult(`tc_r_${i}`, `/file/${i}.py`, long));
}

// Force zone-0 entry: contextUsage > 0.20 and coverage 0.50 → cutoffIdx = 25.
const result = compressStaleToolResults(messages, {
  thresholds: [0.20, 0.35, 0.50],
  coverage: [0.50, 0.75, 0.90],
  contextUsage: 0.25,
  previousCutoff: 0,
  zoneEntered: -1,
});

if (!result) { console.error("FAIL: no masks applied"); process.exit(1); }

console.log("cutoffIdx:     ", result.cutoffIdx);
console.log("masksApplied:  ", result.masksApplied);
console.log("maskedPaths:   ", result.maskedPaths);
console.log("maskedCommands:", result.maskedCommands);

// Assertions
const okPaths = Array.isArray(result.maskedPaths) && result.maskedPaths.length > 0;
const okCmds  = Array.isArray(result.maskedCommands) && result.maskedCommands.length > 0;
const okSum   = result.maskedPaths.length + result.maskedCommands.length === result.masksApplied;
if (!okPaths || !okCmds || !okSum) {
  console.error(`FAIL: shape mismatch  paths=${okPaths} cmds=${okCmds} sum=${okSum}`);
  process.exit(1);
}

// Every masked command/path must be one we actually put in messages below cutoff.
for (const c of result.maskedCommands) {
  if (!/^ls \/path\/\d+$/.test(c)) { console.error("FAIL: bad cmd", c); process.exit(1); }
}
for (const p of result.maskedPaths) {
  if (!/^\/file\/\d+\.py$/.test(p)) { console.error("FAIL: bad path", p); process.exit(1); }
}

// v1.4.0: verify enriched read placeholder format.
const maskedMsgs = result.messages.slice(0, result.cutoffIdx);
let readPlaceholdersChecked = 0;
for (const m of maskedMsgs) {
  const msg = m?.message ?? m;
  if (msg?.role !== "toolResult" || msg?.toolName !== "read") continue;
  const text = msg.content?.[0]?.text ?? "";
  if (!text.startsWith("[cm-masked read]")) continue;
  // Expected: "[cm-masked read] /file/N.py (L lines, SIZE)"
  const match = /^\[cm-masked read\] (\S+) \((\d+) lines, ([\d.]+(?:B|KB|MB))\)$/.exec(text);
  if (!match) { console.error("FAIL: read placeholder format", text); process.exit(1); }
  readPlaceholdersChecked++;
}
if (readPlaceholdersChecked === 0) { console.error("FAIL: no read placeholders checked"); process.exit(1); }
console.log(`Read placeholders validated: ${readPlaceholdersChecked}`);

// v1.4.0: determinism — same input → same placeholder (cache-safety invariant).
const r2 = compressStaleToolResults(messages, {
  thresholds: [0.20, 0.35, 0.50],
  coverage: [0.50, 0.75, 0.90],
  contextUsage: 0.25,
  previousCutoff: 0,
  zoneEntered: -1,
});
const firstPlaceholders = result.messages.slice(0, result.cutoffIdx)
  .map(m => (m?.message?.content ?? m?.content)?.[0]?.text ?? "");
const secondPlaceholders = r2.messages.slice(0, r2.cutoffIdx)
  .map(m => (m?.message?.content ?? m?.content)?.[0]?.text ?? "");
if (firstPlaceholders.join("|") !== secondPlaceholders.join("|")) {
  console.error("FAIL: placeholders are not deterministic — cache-safety broken");
  process.exit(1);
}
console.log("Determinism: OK (same input produces byte-identical placeholders)");

// v1.5.0: reference-path protection — certain paths must NEVER be masked
// even when they fall before the cutoff. Covers basenames (SKILL.md,
// README.md) and path substrings (/knowledge/decisions/, /.pi/agent/skills/,
// /rules/).
const refMessages = [];
const refPaths = [
  "/proj/knowledge/decisions/023-foo.md",
  "/proj/knowledge/concepts/dod.md",
  "/home/u/.pi/agent/skills/review/SKILL.md",
  "/proj/rules/no-broad-except.yml",
  "/proj/README.md",
  "/proj/CHANGELOG.md",
  "/proj/AGENTS.md",
];
for (let i = 0; i < 8; i++) {
  refMessages.push(userMsg(`ref turn ${i}`));
  refMessages.push(asstMsg(`calling read`, [{ id: `rc_${i}`, args: { path: refPaths[i % refPaths.length] } }], { input: 50000 }));
  refMessages.push(readResult(`rc_${i}`, refPaths[i % refPaths.length], long));
}
const refResult = compressStaleToolResults(refMessages, {
  thresholds: [0.20, 0.35, 0.50],
  coverage: [0.50, 0.75, 0.90],
  contextUsage: 0.50,
  previousCutoff: 0,
  zoneEntered: -1,
});
if (refResult) {
  const leakedRefs = refResult.maskedPaths.filter(p => refPaths.includes(p));
  if (leakedRefs.length > 0) {
    console.error("FAIL: reference paths were masked:", leakedRefs);
    process.exit(1);
  }
  for (const m of refResult.messages) {
    const msg = m?.message ?? m;
    if (msg?.role !== "toolResult" || msg?.toolName !== "read") continue;
    const text = msg.content?.[0]?.text ?? "";
    if (!text.startsWith("[cm-masked read]")) continue;
    const pathMatch = /^\[cm-masked read\] (\S+)/.exec(text);
    const maskedPath = pathMatch?.[1];
    if (maskedPath && refPaths.includes(maskedPath)) {
      console.error("FAIL: reference path has masked placeholder:", maskedPath);
      process.exit(1);
    }
  }
  console.log(`Reference protection: OK (${refPaths.length} ref paths survived masking)`);
} else {
  console.log("Reference protection: OK (no masks applied — all reads protected)");
}

console.log("\nPASS — v1.5.0 enriched placeholder + determinism + reference protection.");

// ────────── v1.6.0 tests ──────────

// parseCdPrefix: pure function. Iterative cd stripping, last cwd wins.
const pc1 = parseCdPrefix("git status");
if (pc1.cwd !== undefined || pc1.cmd !== "git status") { console.error("FAIL: parseCdPrefix bare", pc1); process.exit(1); }
const pc2 = parseCdPrefix("cd /repo && git commit -m x");
if (pc2.cwd !== "/repo" || pc2.cmd !== "git commit -m x") { console.error("FAIL: parseCdPrefix single", pc2); process.exit(1); }
const pc3 = parseCdPrefix("cd /a && cd /b && make build");
if (pc3.cwd !== "/b" || pc3.cmd !== "make build") { console.error("FAIL: parseCdPrefix chained", pc3); process.exit(1); }
console.log("parseCdPrefix: OK (bare, single, chained)");

// cd-prefix invalidation: `cd /repo && git commit` now invalidates an
// earlier `cd /repo && git status` in the same cwd. The v1.5.x regex
// (anchored at `^git`) never matched either command and so missed this.
function bashCall(idx, cmd) {
  return asstMsg(`call ${idx}`, [{ id: `b_${idx}`, args: { command: cmd } }], { input: 50000 });
}
function bashResp(idx, cmd) {
  return bashResult(`b_${idx}`, cmd, long);
}

// cd-prefix invalidation test: put status AFTER cutoff so only the
// invalidation path (not the position-based pastCutoff path) can mask
// it. With 20 turns × 3 msgs = 60 and coverage 0.50, cutoff = 30.
// Status at turn 12 (msg idx ~37) and commit at turn 18 (msg idx ~55)
// are both after cutoff — status is masked only if invalidation fires.
const cdMsgs = [];
for (let i = 0; i < 20; i++) {
  cdMsgs.push(userMsg(`turn ${i}`));
  // rule 0: git {add,rm,checkout,...} invalidates git status
  const cmd = i === 12 ? "cd /repo && git status"
            : i === 18 ? "cd /repo && git add ."
            : `cd /repo && echo ${i}`;
  cdMsgs.push(bashCall(i, cmd));
  cdMsgs.push(bashResp(i, cmd));
}
const cdResult = compressStaleToolResults(cdMsgs, {
  thresholds: [0.20, 0.35, 0.50],
  coverage: [0.50, 0.75, 0.90],
  contextUsage: 0.25,
  previousCutoff: 0,
  zoneEntered: -1,
});
if (!cdResult) { console.error("FAIL: cd-prefix invalidation — no masks applied"); process.exit(1); }
const statusInvalidated = cdResult.maskedCommands.some((c) => /cd \/repo && git status/.test(c));
if (!statusInvalidated) { console.error("FAIL: cd /repo && git status not invalidated by cd /repo && git add", cdResult.maskedCommands); process.exit(1); }
console.log("cd-prefix invalidation: OK (git status in /repo invalidated by git add in /repo)");

// cwd-scoped invalidation: commit in /A must NOT invalidate status in /B.
const mixedMsgs = [];
for (let i = 0; i < 20; i++) {
  mixedMsgs.push(userMsg(`turn ${i}`));
  const cmd = i === 12 ? "cd /repoA && git status"
            : i === 13 ? "cd /repoB && git status"
            : i === 18 ? "cd /repoA && git add ."
            : `cd /scratch && echo ${i}`;
  mixedMsgs.push(bashCall(i, cmd));
  mixedMsgs.push(bashResp(i, cmd));
}
const mixedResult = compressStaleToolResults(mixedMsgs, {
  thresholds: [0.20, 0.35, 0.50],
  coverage: [0.50, 0.75, 0.90],
  contextUsage: 0.25,
  previousCutoff: 0,
  zoneEntered: -1,
});
if (!mixedResult) { console.error("FAIL: cwd-scoped invalidation — no masks applied"); process.exit(1); }
const aInvalidated = mixedResult.maskedCommands.some((c) => /cd \/repoA && git status/.test(c));
const bInvalidated = mixedResult.maskedCommands.some((c) => /cd \/repoB && git status/.test(c));
if (!aInvalidated) { console.error("FAIL: repoA status should have been invalidated", mixedResult.maskedCommands); process.exit(1); }
if (bInvalidated) { console.error("FAIL: repoB status spuriously invalidated by repoA commit", mixedResult.maskedCommands); process.exit(1); }
console.log("cwd-scoped invalidation: OK (repoA status masked, repoB status preserved)");

// User-config: inject a custom invalidation rule + custom reference
// basename and verify they take effect.
const customRules = resolveRules({
  referenceBasenames: ["CUSTOM.md"],
  referencePathSubstrings: ["/my-specs/"],
  invalidationRules: [{ invalidator: "^cargo\\s+(build|update)", invalidated: "^cargo\\s+(check|clippy)" }],
  disableDefaults: false,
});
// custom reference basename
const refCfgMsgs = [];
for (let i = 0; i < 8; i++) {
  refCfgMsgs.push(userMsg(`t${i}`));
  refCfgMsgs.push(asstMsg(`read`, [{ id: `rc_${i}`, args: { path: "/proj/docs/CUSTOM.md" } }], { input: 50000 }));
  refCfgMsgs.push(readResult(`rc_${i}`, "/proj/docs/CUSTOM.md", long));
}
const refCfgResult = compressStaleToolResults(refCfgMsgs, {
  thresholds: [0.20, 0.35, 0.50],
  coverage: [0.50, 0.75, 0.90],
  contextUsage: 0.50,
  previousCutoff: 0,
  zoneEntered: -1,
  rules: customRules,
});
if (refCfgResult && refCfgResult.maskedPaths.includes("/proj/docs/CUSTOM.md")) {
  console.error("FAIL: user-config referenceBasenames did not protect CUSTOM.md", refCfgResult.maskedPaths);
  process.exit(1);
}
console.log("user-config referenceBasenames: OK (CUSTOM.md protected)");

// custom invalidation rule
const cargoMsgs = [];
for (let i = 0; i < 20; i++) {
  cargoMsgs.push(userMsg(`t${i}`));
  const cmd = i === 12 ? "cargo check"
            : i === 18 ? "cargo build"
            : `echo ${i}`;
  cargoMsgs.push(bashCall(i, cmd));
  cargoMsgs.push(bashResp(i, cmd));
}
const cargoResult = compressStaleToolResults(cargoMsgs, {
  thresholds: [0.20, 0.35, 0.50],
  coverage: [0.50, 0.75, 0.90],
  contextUsage: 0.25,
  previousCutoff: 0,
  zoneEntered: -1,
  rules: customRules,
});
if (!cargoResult) { console.error("FAIL: custom invalidation produced no masks"); process.exit(1); }
if (!cargoResult.maskedCommands.some((c) => c === "cargo check")) {
  console.error("FAIL: user-config invalidationRules did not invalidate cargo check by cargo build", cargoResult.maskedCommands);
  process.exit(1);
}
console.log("user-config invalidationRules: OK (cargo check invalidated by cargo build)");

// disableDefaults: built-in git rule should stop firing when user
// replaces rule set entirely.
const replaceRules = resolveRules({
  referenceBasenames: [],
  referencePathSubstrings: [],
  invalidationRules: [{ invalidator: "^fake-never-matches", invalidated: "^also-never" }],
  disableDefaults: true,
});
const disableMsgs = [];
for (let i = 0; i < 20; i++) {
  disableMsgs.push(userMsg(`t${i}`));
  const cmd = i === 12 ? "cd /repo && git status"
            : i === 18 ? "cd /repo && git add ."
            : `echo ${i}`;
  disableMsgs.push(bashCall(i, cmd));
  disableMsgs.push(bashResp(i, cmd));
}
const disableResult = compressStaleToolResults(disableMsgs, {
  thresholds: [0.20, 0.35, 0.50],
  coverage: [0.50, 0.75, 0.90],
  contextUsage: 0.25,
  previousCutoff: 0,
  zoneEntered: -1,
  rules: replaceRules,
});
// Post-cutoff status (turn 12, msg idx 37) should NOT be masked because
// defaults were replaced and the replacement rule doesn't match git.
if (disableResult) {
  const cutoff = disableResult.cutoffIdx;
  const postCutoffMasked = disableResult.messages.slice(cutoff).some((m) => {
    const msg = m?.message ?? m;
    if (msg?.role !== "toolResult" || msg?.toolName !== "bash") return false;
    const text = msg.content?.[0]?.text ?? "";
    return /git status/.test(text) && text.startsWith("[cm-masked");
  });
  if (postCutoffMasked) {
    console.error("FAIL: disableDefaults did not suppress built-in git rule (post-cutoff status masked)");
    process.exit(1);
  }
}
console.log("disableDefaults: OK (built-in git rule suppressed)");

console.log("\nPASS — v1.6.0 cwd-aware invalidation + user config.");
