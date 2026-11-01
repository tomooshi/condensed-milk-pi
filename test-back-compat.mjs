#!/usr/bin/env node
/**
 * v1.9.0 (ADR-029) scenario 5 regression: legacy `[masked ...]` placeholders
 * in pre-v1.9.0 persisted sessions must still be recognized as already-masked
 * by isAlreadyMasked() / isMaskedText() so /compress-stats counts and
 * re-read telemetry stay correct when resuming old sessions.
 *
 * Follows test-compact-reset.mjs pattern: compile TS → import at runtime,
 * exercise real exported surface (no inline mocks).
 */
import { loadTs } from "./tests/harness.mjs";

// v1.11.0: load the real source through pi's jiti (tests/harness.mjs). The
// old tsc-in-a-temp-dir step had no Node types, and context-compress.ts now
// imports node:crypto through text-metrics.ts (CM-ADR-001).
const mod = await loadTs("filters/context-compress.ts");
const { compressStaleToolResults, resolveRules, emptyUserConfig } = mod;

const rules = resolveRules(emptyUserConfig());
// Force everything below cutoff: high contextUsage + 1.0 coverage.
const opts = {
  rules,
  contextUsage: 0.99,
  previousCutoff: 0,
  zoneEntered: -1,
  thresholds: [0.3, 0.45, 0.6],
  coverage: [1.0, 1.0, 1.0],
};

// Build a synthetic session with mixed legacy + current-format placeholders
// and one fresh unmasked tool_result that SHOULD get masked.
function mkMsg(role, text, extra = {}) {
  return {
    role,
    content: [{ type: "text", text }],
    ...extra,
  };
}

function mkBashResult(text, id) {
  return mkMsg("toolResult", text, {
    toolName: "bash",
    toolCallId: id,
    isError: false,
  });
}

function mkAssistantToolCall(id, command) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
  };
}

// 200-byte filler so messages exceed MIN_MASK_LENGTH.
const filler = (n) => "x".repeat(n);

const messages = [];
// 0..5: pairs of toolCall + toolResult, legacy '[masked ...]' already in place
for (let i = 0; i < 3; i++) {
  messages.push(mkAssistantToolCall(`leg${i}`, `echo legacy${i}`));
  messages.push(mkBashResult(`[masked bash] echo legacy${i}`, `leg${i}`));
}
// 6..11: pairs, v1.9.0 '[cm-masked ...]' already in place
for (let i = 0; i < 3; i++) {
  messages.push(mkAssistantToolCall(`cur${i}`, `echo current${i}`));
  messages.push(mkBashResult(`[cm-masked bash] echo current${i}`, `cur${i}`));
}
// 12..13: fresh unmasked pair — long enough to mask
messages.push(mkAssistantToolCall("fresh0", "echo fresh0"));
messages.push(mkBashResult(filler(500), "fresh0"));

// Force cutoff to cover everything.
const result = compressStaleToolResults(messages, opts);

function check(name, cond, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
    process.exitCode = 1;
  }
}

const masksApplied = result?.masksApplied ?? 0;
const maskedCommands = result?.maskedCommands ?? [];

// Expectation: the 6 already-masked messages (3 legacy + 3 current format)
// are NOT re-masked. Only the 1 fresh long bash result is newly masked.
check("Case 1: legacy [masked ...] recognized as already-masked (not double-masked)",
  masksApplied === 1,
  `got masksApplied=${masksApplied} expected 1 (only fresh0); if >1 then either legacy or cm-masked placeholders got re-processed`);

check("Case 2: fresh tool_result still gets masked",
  maskedCommands.includes("echo fresh0"),
  `maskedCommands=${JSON.stringify(maskedCommands)}`);

// v1.11.0 (CM-ADR-001): the current format carries "#<10 hex id>".
check("Case 3: fresh tool_result output replaced with [cm-masked bash #id] prefix (current format)",
  /^\[cm-masked bash #[0-9a-f]{10}\] /.test(result.messages[13].content[0].text),
  `got: ${result.messages[13].content[0].text}`);

check("Case 4: legacy [masked bash] placeholders left byte-identical",
  messages.slice(0, 6).every((m, i) =>
    result.messages[i].content[0].text === m.content[0].text),
  "legacy placeholders were modified in place (back-compat broken)");

check("Case 5: current [cm-masked bash] placeholders left byte-identical",
  messages.slice(6, 12).every((m, i) =>
    result.messages[i + 6].content[0].text === m.content[0].text),
  "current placeholders were modified (should be no-op)");

if (process.exitCode) {
  console.error("\nFAIL — v1.9.0 back-compat regression (ADR-029 scenario 5).");
  process.exit(1);
}
console.log("\nPASS — v1.9.0 back-compat (ADR-029 scenario 5).");
