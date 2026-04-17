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
const { compressStaleToolResults } = mod;

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

console.log("\nPASS — CompressResult exposes maskedPaths + maskedCommands correctly.");
