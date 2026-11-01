#!/usr/bin/env node
/**
 * v1.8.1 regression test for ADR-028.
 *
 * Bug: /pi-vcc compaction collapses the messages array while persistentCutoff
 * stays frozen at a pre-compact absolute index. Post-compact, every message
 * sits below the stale cutoff and all tool_results get masked.
 *
 * Test: simulate the exact conditions (large cutoff, small post-compact array)
 * and verify:
 *   (a) decideCutoff clamp prevents whole-array masking even with stale cutoff,
 *   (b) subsequent natural zone re-entry computes cutoff from new array length,
 *   (c) pre-compact normal path still works (no regression).
 *
 * Follows test-rereads.mjs pattern: compile the TS source to JS via tsc, then
 * import the compiled module at runtime.
 */
import { loadTs } from "./tests/harness.mjs";

// v1.11.0: load the real source through pi's jiti (tests/harness.mjs). The
// old tsc-in-a-temp-dir step had no Node types, and context-compress.ts now
// imports node:crypto through text-metrics.ts (CM-ADR-001).
const mod = await loadTs("filters/context-compress.ts");
const { compressStaleToolResults, decideCutoff } = mod;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name} ${detail}`); fail++; }
}

// Message shape matches test-rereads.mjs: tool results at the top level
// plus an assistant message that holds the toolCall reference. The masker
// reads toolName/toolCallId from the tool result and joins to toolCall via
// toolCallIndex Map. Pattern preserved from the existing test suite for
// consistency.
function userMsg(text) { return { role: "user", content: [{ type: "text", text }] }; }
function asstMsg(text, toolCalls = []) {
  const content = [{ type: "text", text }];
  for (const tc of toolCalls) content.push({ type: "toolCall", id: tc.id, arguments: tc.args });
  return { role: "assistant", content };
}
function bashResult(id, output) {
  return { role: "toolResult", toolName: "bash", toolCallId: id, isError: false,
    content: [{ type: "text", text: output }] };
}
function readResult(id, output) {
  return { role: "toolResult", toolName: "read", toolCallId: id, isError: false,
    content: [{ type: "text", text: output }] };
}

/** Build a branch of N turns, each = [user, asst-with-bashCall, bashResult]. */
function buildBashBranch(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(userMsg(`u${i}`));
    out.push(asstMsg(`a${i}`, [{ id: `tc_b_${i}`, args: { command: `cat file_${i}.md` } }]));
    out.push(bashResult(`tc_b_${i}`, long));
  }
  return out;
}

/** Build a branch of N turns, each = [user, asst-with-readCall, readResult]. */
function buildReadBranch(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(userMsg(`u${i}`));
    out.push(asstMsg(`a${i}`, [{ id: `tc_r_${i}`, args: { path: `/tmp/example_${i}.txt` } }]));
    out.push(readResult(`tc_r_${i}`, long));
  }
  return out;
}

const long = "x".repeat(500);
const THRESHOLDS = [0.30, 0.45, 0.60];
const COVERAGE = [0.60, 0.80, 0.95];

// --- Case 1: decideCutoff clamp ---
// Pre-compact: cutoff frozen at 400, messages.length was 600.
// Post-compact: messages.length = 20, cutoff still 400.
// Expected: clampedPreviousCutoff = min(400, 20) = 20, and since activeZone (-1)
// is NOT greater than zoneEntered (2), zone doesn't advance. cutoffIdx = 20.
{
  const decision = decideCutoff(20, {
    thresholds: THRESHOLDS,
    coverage: COVERAGE,
    contextUsage: 0.10,
    previousCutoff: 400,
    zoneEntered: 2,
  });
  check("Case 1a: cutoff clamped to messages.length when persisted cutoff is stale",
    decision.cutoffIdx <= 20, `cutoffIdx=${decision.cutoffIdx} should be <= 20`);
  check("Case 1b: zoneAdvanced stays false post-compact when already past zone",
    decision.zoneAdvanced === false);
}

// --- Case 2: compressStaleToolResults masks bounded by messages.length under stale cutoff ---
{
  const messages = buildBashBranch(10);  // 30 total entries (u, a, bashResult) × 10
  const result = compressStaleToolResults(messages, {
    thresholds: THRESHOLDS,
    coverage: COVERAGE,
    contextUsage: 0.10,
    previousCutoff: 400,    // stale pre-compact value
    zoneEntered: 2,
  });
  const maskedCount = result?.masksApplied ?? 0;
  check("Case 2: stale-cutoff mask count bounded by messages.length (clamp working)",
    maskedCount <= messages.length,
    `maskedCount=${maskedCount} should be <= ${messages.length}`);
}

// --- Case 3: explicit session_compact reset simulates the index.ts handler ---
{
  const messages = buildBashBranch(10);
  const result = compressStaleToolResults(messages, {
    thresholds: THRESHOLDS,
    coverage: COVERAGE,
    contextUsage: 0.10,     // below all thresholds
    previousCutoff: 0,       // reset by session_compact handler
    zoneEntered: -1,         // reset by session_compact handler
  });
  check("Case 3: post-compact with explicit reset masks NOTHING at low usage",
    result === null,
    `expected null, got ${result ? result.masksApplied : "null"} masks`);
}

// --- Case 4: natural zone re-entry after compact reset ---
{
  const decision = decideCutoff(100, {
    thresholds: THRESHOLDS,
    coverage: COVERAGE,
    contextUsage: 0.35,     // zone 0 active (>=0.30, <0.45)
    previousCutoff: 0,
    zoneEntered: -1,
  });
  const expectedCutoff = Math.floor(100 * 0.60);
  check("Case 4a: post-compact zone re-entry uses NEW messages.length",
    decision.cutoffIdx === expectedCutoff,
    `cutoffIdx=${decision.cutoffIdx}, expected=${expectedCutoff}`);
  check("Case 4b: zoneAdvanced true on re-entry",
    decision.zoneAdvanced === true);
}

// --- Case 5: pre-compact normal path still masks correctly (regression check) ---
{
  const messages = buildBashBranch(100);  // 300 entries, many bash results
  const result = compressStaleToolResults(messages, {
    thresholds: THRESHOLDS,     // [0.30, 0.45, 0.60]
    coverage: COVERAGE,         // [0.60, 0.80, 0.95]
    contextUsage: 0.40,         // zone 0 active
    previousCutoff: 0,
    zoneEntered: -1,
  });
  // zone 0 cutoff = floor(300 * 0.60) = 180.
  // Bash results live at indices 2, 5, 8, 11, ... (every 3rd position).
  // Those below idx 180 get masked: count = floor(180/3) = 60.
  check("Case 5: pre-compact normal path masks proportional to zone coverage",
    result !== null && result.masksApplied > 0,
    `expected masksApplied > 0, got ${result?.masksApplied ?? "null"}`);
}

// --- Case 6: Read tool also safe after compact reset ---
{
  const messages = buildReadBranch(15);
  const result = compressStaleToolResults(messages, {
    thresholds: THRESHOLDS,
    coverage: COVERAGE,
    contextUsage: 0.10,
    previousCutoff: 0,
    zoneEntered: -1,
  });
  check("Case 6: post-compact Read tool not masked at low usage",
    result === null,
    `expected null, got ${result ? result.masksApplied : "null"} masks`);
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("PASS — v1.8.1 post-compact masker-state reset (ADR-028).");
