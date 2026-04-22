#!/usr/bin/env node
/**
 * Integration test: run compressStaleToolResults against a real session
 * JSONL and report mask counts. No mocks. Validates the v1.1.0
 * observation-masking algorithm against the exact shape pi produces.
 *
 * Usage: node test-masking.mjs <session.jsonl> [window-size]
 *
 * Exit 0 on success; exit 1 if assertions fail.
 */
import { readFileSync } from "node:fs";
import { argv, exit } from "node:process";

// Minimal inline reimplementation matching filters/context-compress.ts.
// We can't import the .ts directly without ts-loader, and the logic is
// simple enough to mirror here. This test validates the algorithm shape
// against real data, not the TS file directly (that's what a proper
// vitest setup would do — follow-up).

const DEFAULT_WINDOW = 10;
const MIN_MASK_LENGTH = 120;
const REFERENCE_FILES = new Set([
  "AGENTS.md", "CONVENTIONS.md", "CLAUDE.md",
  ".ruff.toml", "ruff.toml", "biome.json",
  "pyproject.toml", "package.json", "tsconfig.json",
  "sgconfig.yml", ".shellcheckrc",
]);

function isReferenceFile(path) {
  const basename = path.split("/").pop() ?? path;
  return REFERENCE_FILES.has(basename);
}

function isBashToolResult(msg) {
  return msg?.role === "toolResult" && msg?.toolName === "bash";
}
function isReadToolResult(msg) {
  return msg?.role === "toolResult" && msg?.toolName === "read";
}
function isAlreadyMasked(msg) {
  if (msg?.role !== "toolResult") return false;
  const content = (msg.content ?? [])[0];
  if (!content || content.type !== "text") return false;
  const text = content.text ?? "";
  return text.startsWith("[cm-masked ") || text.startsWith("[compressed]");
}
function buildToolCallIndex(messages) {
  const idx = new Map();
  for (const m of messages) {
    const msg = m?.message ?? m;
    if (msg?.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "toolCall") continue;
      const id = block.id ?? block.toolCallId;
      if (!id) continue;
      const args = block.arguments ?? block.input ?? {};
      idx.set(id, {
        command: typeof args.command === "string" ? args.command : undefined,
        path: typeof args.path === "string" ? args.path : undefined,
      });
    }
  }
  return idx;
}
function extractCommand(msg, toolCallIndex) {
  const fromDetails = msg?.details?.command ?? msg?.input?.command;
  if (fromDetails) return fromDetails;
  if (toolCallIndex && msg?.toolCallId) return toolCallIndex.get(msg.toolCallId)?.command ?? "";
  return "";
}
function extractPath(msg, toolCallIndex) {
  const fromDetails = msg?.details?.path ?? msg?.input?.path;
  if (fromDetails) return fromDetails;
  if (toolCallIndex && msg?.toolCallId) return toolCallIndex.get(msg.toolCallId)?.path ?? "";
  return "";
}
function extractTextContent(msg) {
  return (msg.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function compressStaleToolResults(messages, windowSize = DEFAULT_WINDOW) {
  if (messages.length <= windowSize) return null;
  const staleBeforeIdx = messages.length - windowSize;
  const toolCallIndex = buildToolCallIndex(messages);

  let bytesSaved = 0;
  let masksApplied = 0;

  const result = messages.map((m, idx) => {
    const msg = m?.message ?? m;
    if (isAlreadyMasked(msg)) return m;

    if (isBashToolResult(msg) && !msg.isError) {
      const content = extractTextContent(msg);
      if (content.length < MIN_MASK_LENGTH) return m;
      if (idx < staleBeforeIdx) {
        const cmd = extractCommand(msg, toolCallIndex);
        const placeholder = cmd ? `[cm-masked bash] ${cmd.slice(0, 80)}` : `[cm-masked bash]`;
        bytesSaved += content.length - placeholder.length;
        masksApplied++;
        return { ...m, message: { ...msg, content: [{ type: "text", text: placeholder }] } };
      }
    }

    if (isReadToolResult(msg) && !msg.isError) {
      const path = extractPath(msg, toolCallIndex);
      const content = extractTextContent(msg);
      if (path && content.length >= MIN_MASK_LENGTH && !isReferenceFile(path) && idx < staleBeforeIdx) {
        const placeholder = `[cm-masked read] ${path}`;
        bytesSaved += content.length - placeholder.length;
        masksApplied++;
        return { ...m, message: { ...msg, content: [{ type: "text", text: placeholder }] } };
      }
    }
    return m;
  });

  if (masksApplied === 0) return null;
  return { messages: result, bytesSaved, masksApplied };
}

// ---- Load JSONL ----
const path = argv[2];
const window = argv[3] ? Number.parseInt(argv[3], 10) : DEFAULT_WINDOW;
if (!path) {
  console.error("Usage: node test-masking.mjs <session.jsonl> [window-size]");
  exit(1);
}

const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
const messages = [];
for (const line of lines) {
  const obj = JSON.parse(line);
  const msg = obj.message ?? obj;
  if (msg?.role === "user" || msg?.role === "assistant" || msg?.role === "toolResult") {
    messages.push(obj);
  }
}

console.log(`Loaded ${messages.length} role-bearing entries from ${path}`);

// ---- Baseline counts ----
const bashTotal = messages.filter((m) => isBashToolResult(m.message ?? m) && !(m.message ?? m).isError).length;
const readTotal = messages.filter((m) => isReadToolResult(m.message ?? m) && !(m.message ?? m).isError).length;
console.log(`  bash toolResults (non-error): ${bashTotal}`);
console.log(`  read toolResults (non-error): ${readTotal}`);

// ---- Run masker ----
const result = compressStaleToolResults(messages, window);

if (!result) {
  console.error(`FAIL: no masks applied on ${messages.length} messages with window=${window}`);
  console.error(`  staleBeforeIdx would be: ${messages.length - window}`);
  exit(1);
}

console.log(`\nWith window=${window}:`);
console.log(`  masks applied:  ${result.masksApplied}`);
console.log(`  bytes saved:    ${result.bytesSaved}  (~${Math.round(result.bytesSaved / 4)} tokens)`);

// ---- Spot-check: print first 3 masks ----
console.log("\nFirst 3 masks (verify placeholder shape):");
let shown = 0;
for (let i = 0; i < result.messages.length && shown < 3; i++) {
  const orig = messages[i].message ?? messages[i];
  const masked = result.messages[i].message ?? result.messages[i];
  if (orig.role === "toolResult" && masked !== messages[i]) {
    const origLen = extractTextContent(orig).length;
    const maskedText = extractTextContent(masked);
    console.log(`  idx ${i}: ${orig.toolName} ${origLen}B -> "${maskedText}"`);
    shown++;
  }
}

// ---- Assertions ----
let failed = 0;

// 1. Every masked message should start with "[cm-masked "
for (let i = 0; i < result.messages.length; i++) {
  const origRaw = messages[i];
  const newRaw = result.messages[i];
  if (origRaw === newRaw) continue; // unchanged
  const newMsg = newRaw.message ?? newRaw;
  if (newMsg.role !== "toolResult") continue;
  const text = extractTextContent(newMsg);
  if (!text.startsWith("[cm-masked ")) {
    console.error(`FAIL: idx ${i} was changed but doesn't start with '[cm-masked ': ${text.slice(0, 60)}`);
    failed++;
  }
}

// 2. Window messages should be untouched
for (let i = messages.length - window; i < messages.length; i++) {
  if (result.messages[i] !== messages[i]) {
    console.error(`FAIL: idx ${i} inside window (last ${window}) was modified`);
    failed++;
  }
}

// 3. Idempotent: running again should return null
const secondPass = compressStaleToolResults(result.messages, window);
if (secondPass !== null) {
  console.error(`FAIL: idempotency violated — second pass produced ${secondPass.masksApplied} more masks`);
  failed++;
}

// 4. Reference files should never be masked
const tci = buildToolCallIndex(messages);
for (let i = 0; i < result.messages.length - window; i++) {
  const orig = messages[i].message ?? messages[i];
  if (orig.role !== "toolResult" || orig.toolName !== "read") continue;
  const path = extractPath(orig, tci);
  if (path && isReferenceFile(path)) {
    if (result.messages[i] !== messages[i]) {
      console.error(`FAIL: reference file ${path} at idx ${i} was masked`);
      failed++;
    }
  }
}

if (failed === 0) {
  console.log("\nAll assertions passed.");
  exit(0);
} else {
  console.error(`\n${failed} assertion(s) failed.`);
  exit(1);
}
