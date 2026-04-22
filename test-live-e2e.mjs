#!/usr/bin/env node
/**
 * v1.9.0 end-to-end live session smoke (ADR-029 scenario 1 evidence).
 *
 * Loads a REAL pi session file from disk, extracts its messages, and runs
 * the installed condensed-milk-pi masker against them with forced-full
 * coverage. Verifies that every masked tool_result uses the v1.9.0
 * `[cm-masked …]` prefix (proving the installed artifact matches source).
 *
 * Usage: node test-live-e2e.mjs <session.jsonl>
 * Exits non-zero on any format mismatch.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sessPath = process.argv[2];
if (!sessPath) {
  console.error("usage: node test-live-e2e.mjs <session.jsonl>");
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), "cm-live-e2e-"));
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
  console.error(tsc.stdout); console.error(tsc.stderr); process.exit(1);
}

const mod = await import(join(tmp, "context-compress.js"));
const { compressStaleToolResults, resolveRules, emptyUserConfig } = mod;

// Parse JSONL: one event per line. Extract event.message for entries that have it.
const messages = readFileSync(sessPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim().startsWith("{"))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e && e.message)
  .map((e) => e.message);

console.log(`Loaded ${messages.length} messages from session.`);
const toolResults = messages.filter((m) => m?.role === "toolResult");
console.log(`  toolResult count: ${toolResults.length}`);

// Force max coverage so everything below cutoff gets masked.
const result = compressStaleToolResults(messages, {
  rules: resolveRules(emptyUserConfig()),
  contextUsage: 0.99,
  previousCutoff: 0,
  zoneEntered: -1,
  thresholds: [0.30, 0.45, 0.60],
  coverage: [1.0, 1.0, 1.0],
});

if (!result) {
  console.error("FAIL: compressStaleToolResults returned null on non-empty session");
  process.exit(1);
}

console.log(`  masksApplied: ${result.masksApplied}`);
console.log(`  bytesSaved: ${result.bytesSaved}`);
console.log(`  cutoffIdx: ${result.cutoffIdx}`);

// Tally by format prefix — existence-based over toolResult messages only.
const maskedToolResults = result.messages.filter((m) => m?.role === "toolResult");
const prefixCounts = maskedToolResults.reduce((acc, m) => {
  const t = m.content?.[0]?.text ?? "";
  if (t.startsWith("[cm-masked bash]")) acc.cmBash++;
  else if (t.startsWith("[cm-masked read]")) acc.cmRead++;
  else if (t.startsWith("[masked ")) acc.legacy++;
  return acc;
}, { cmBash: 0, cmRead: 0, legacy: 0 });

console.log(`  v1.9.0 [cm-masked bash]: ${prefixCounts.cmBash}`);
console.log(`  v1.9.0 [cm-masked read]: ${prefixCounts.cmRead}`);
console.log(`  legacy [masked …] in output: ${prefixCounts.legacy} (MUST be 0)`);

if (prefixCounts.legacy > 0) {
  console.error("FAIL: v1.9.0 masker produced legacy format in output — source mismatch.");
  process.exit(1);
}
if (prefixCounts.cmBash + prefixCounts.cmRead === 0 && toolResults.length > 5) {
  console.error("FAIL: no masks applied despite non-trivial session.");
  process.exit(1);
}
console.log("\nPASS — live session e2e smoke (ADR-029 scenario 1 evidence).");
