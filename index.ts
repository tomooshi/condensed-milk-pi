/**
 * Token Compressor — global pi extension.
 *
 * Intercepts bash tool results and applies semantic compression filters
 * to reduce LLM token consumption. Inspired by ztk (codejunkie99/ztk).
 *
 * Architecture: tool_result post-processor.
 * Pi's 50KB truncation runs first, then we compress the already-capped output.
 * Filters are registered by individual modules at import time.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { dispatch, registeredCommands, registerContentFallback } from "./filters/dispatch.js";

// Import filter modules — each self-registers via registerFilter()
import "./filters/pytest.js";
import "./filters/git-status.js";
import "./filters/git-diff.js";
import "./filters/git-mutations.js";
import "./filters/git-log.js";
import "./filters/file-ops.js";
import "./filters/tree.js";
import "./filters/env.js";
import "./filters/python-traceback.js";
import "./filters/log-dedup.js";
import "./filters/tsc.js";
import "./filters/linter.js";
import "./filters/grep-grouping.js";
import "./filters/build.js";
import "./filters/test-runners.js";
import "./filters/install.js";
import { filterJsonOutput } from "./filters/json-schema.js";
import { compressStaleToolResults } from "./filters/context-compress.js";
import { stripAnsi } from "./filters/ansi-strip.js";

// --- Config ---
// v1.1.0: cacheAware gate removed (was broken AND unnecessary under
// masking — deterministic placeholders self-stabilize cache). Only
// tunable is rolling window size.
interface CompressorConfig {
  windowSize: number;  // Messages-from-HEAD kept unmasked. JetBrains default: 10.
}

const DEFAULT_CONFIG: CompressorConfig = {
  windowSize: 10,
};

const CONFIG_PATH = join(homedir(), ".config", "condensed-milk.json");

function loadConfig(): CompressorConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      windowSize: typeof parsed.windowSize === "number" && parsed.windowSize > 0
        ? parsed.windowSize
        : DEFAULT_CONFIG.windowSize,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg: CompressorConfig): void {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  } catch {
    // Non-fatal — config just won't persist
  }
}

// --- Per-turn telemetry ---
interface TurnCacheData {
  turn: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  bytesCompressed: number;
  masksApplied: number;
}

export default function tokenCompressor(pi: ExtensionAPI) {
  // Register content-based fallback filters
  registerContentFallback("json", filterJsonOutput);

  // Subagents: compress too — they benefit from smaller output
  let totalOriginal = 0;
  let totalCompressed = 0;
  let compressedCount = 0;
  let totalCommands = 0;

  // Config
  let config: CompressorConfig = loadConfig();

  // Cache tracking
  let cacheHistory: TurnCacheData[] = [];
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let turnCounter = 0;

  pi.on("session_start", async (_event, ctx) => {
    totalOriginal = 0;
    totalCompressed = 0;
    compressedCount = 0;
    totalCommands = 0;
    cacheHistory = [];
    totalCacheRead = 0;
    totalCacheWrite = 0;
    totalInput = 0;
    totalOutput = 0;
    turnCounter = 0;
    const cmds = registeredCommands();
    ctx.ui?.setStatus?.("token-savings", `↓0 (${cmds.length}f)`);
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    // Don't skip errors — traceback filter specifically targets error output

    const command = (event.input as { command?: string })?.command;
    if (!command) return;

    // Extract text content from tool result (preserve non-text blocks like images)
    const textParts = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);
    const nonTextBlocks = event.content.filter((c) => c.type !== "text");
    const originalText = textParts.join("\n");

    if (originalText.length === 0) return;

    // ANSI strip runs first on ALL bash output (zero info loss)
    let stdout = stripAnsi(originalText);

    totalCommands++;

    // Try semantic compression
    const result = dispatch(command, stdout);
    const finalOutput = result ? result.output : stdout;

    const saved = originalText.length - finalOutput.length;
    if (saved <= 0) return;

    totalOriginal += originalText.length;
    totalCompressed += finalOutput.length;
    compressedCount++;

    const totalSaved = totalOriginal - totalCompressed;
    const pct = totalOriginal > 0 ? Math.round((totalSaved / totalOriginal) * 100) : 0;
    _ctx.ui?.setStatus?.(
      "token-savings",
      `↓${formatBytes(totalSaved)} ${compressedCount}/${totalCommands} ${pct}%`,
    );

    const content: Record<string, unknown>[] = [
      { type: "text" as const, text: finalOutput },
      ...nonTextBlocks,
    ];
    const ret: Record<string, unknown> = { content };
    if (event.isError) ret.isError = true;
    return ret;
  });

  // Context-level retroactive compression
  // Compresses old bash tool results before each LLM call
  let contextSaved = 0;
  let contextCompressions = 0;

  pi.on("context", async (event, _ctx) => {
    turnCounter++;

    // Recalculate cumulative cache stats from all assistant messages.
    // Analytical sum — no full-history JSON.stringify (v1.1.0 perf fix).
    totalCacheRead = 0;
    totalCacheWrite = 0;
    totalInput = 0;
    totalOutput = 0;
    let lastUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;

    for (const m of event.messages) {
      const msg = (m as any)?.message ?? m;
      if (msg?.role === "assistant" && msg?.usage) {
        const u = msg.usage;
        totalCacheRead += u.cacheRead ?? 0;
        totalCacheWrite += u.cacheWrite ?? 0;
        totalInput += u.input ?? 0;
        totalOutput += u.output ?? 0;
        lastUsage = {
          input: u.input ?? 0,
          output: u.output ?? 0,
          cacheRead: u.cacheRead ?? 0,
          cacheWrite: u.cacheWrite ?? 0,
        };
      }
    }

    // Apply masking. Returns null if nothing to mask, else { messages,
    // bytesSaved, masksApplied } — analytical stats, no JSON.stringify.
    const result = compressStaleToolResults(event.messages, config.windowSize);
    const turnBytesCompressed = result?.bytesSaved ?? 0;
    const turnMasksApplied = result?.masksApplied ?? 0;

    if (result) {
      contextSaved += result.bytesSaved;
      contextCompressions++;
    }

    // Record this turn
    if (lastUsage) {
      cacheHistory.push({
        turn: turnCounter,
        cacheRead: lastUsage.cacheRead,
        cacheWrite: lastUsage.cacheWrite,
        input: lastUsage.input,
        output: lastUsage.output,
        bytesCompressed: turnBytesCompressed,
        masksApplied: turnMasksApplied,
      });
    }

    if (result) {
      return { messages: result.messages };
    }
  });

  // /compress-stats command
  pi.registerCommand("compress-stats", {
    description: "Show token compression and cache tradeoff statistics",
    handler: async (_args, ctx) => {
      const cmds = registeredCommands();
      const totalSaved = totalOriginal - totalCompressed;
      const pct = totalOriginal > 0 ? Math.round((totalSaved / totalOriginal) * 100) : 0;

      // Cache analysis
      const totalAllInput = totalInput + totalCacheRead + totalCacheWrite;
      const cacheHitRate = totalAllInput > 0 ? (totalCacheRead / totalAllInput) * 100 : 0;
      const cacheWriteRate = totalAllInput > 0 ? (totalCacheWrite / totalAllInput) * 100 : 0;
      const uncachedRate = totalAllInput > 0 ? (totalInput / totalAllInput) * 100 : 0;

      // Cost calculation (Opus 4.7 pricing)
      const PRICE_INPUT = 5;         // $/MTok uncached
      const PRICE_CACHE_READ = 0.5;  // $/MTok cached
      const PRICE_CACHE_WRITE = 6.25; // $/MTok cache write
      const PRICE_OUTPUT = 25;       // $/MTok output

      const costInput = (totalInput / 1_000_000) * PRICE_INPUT;
      const costCacheRead = (totalCacheRead / 1_000_000) * PRICE_CACHE_READ;
      const costCacheWrite = (totalCacheWrite / 1_000_000) * PRICE_CACHE_WRITE;
      const costOutput = (totalOutput / 1_000_000) * PRICE_OUTPUT;
      const totalCost = costInput + costCacheRead + costCacheWrite + costOutput;

      // What would cost be with NO cache (all input at full price)?
      const costNoCacheInput = (totalAllInput / 1_000_000) * PRICE_INPUT;
      const costNoCache = costNoCacheInput + costOutput;
      const cacheSavings = costNoCache - totalCost;

      // Context runway estimate (~4 chars per token)
      const tokensSaved = Math.round(contextSaved / 4);

      const lines = [
        "Token Compressor Stats",
        `  Filters: ${cmds.join(", ")}`,
        `  Commands processed: ${totalCommands}`,
        `  Commands compressed: ${compressedCount}`,
        `  Original: ${formatBytes(totalOriginal)}`,
        `  Compressed: ${formatBytes(totalCompressed)}`,
        `  Saved: ${formatBytes(totalSaved)} (${pct}%)`,
        `  Context retroactive: ${formatBytes(contextSaved)} saved (${contextCompressions} compressions)`,
        "",
        "Cache Impact",
        `  Total input: ${formatTokens(totalAllInput)}`,
        `  Cache hits:   ${formatTokens(totalCacheRead)} (${cacheHitRate.toFixed(1)}%) @ $${PRICE_CACHE_READ}/M = $${costCacheRead.toFixed(2)}`,
        `  Cache writes: ${formatTokens(totalCacheWrite)} (${cacheWriteRate.toFixed(1)}%) @ $${PRICE_CACHE_WRITE}/M = $${costCacheWrite.toFixed(2)}`,
        `  Uncached:     ${formatTokens(totalInput)} (${uncachedRate.toFixed(1)}%) @ $${PRICE_INPUT}/M = $${costInput.toFixed(2)}`,
        `  Output:       ${formatTokens(totalOutput)} @ $${PRICE_OUTPUT}/M = $${costOutput.toFixed(2)}`,
        `  Session cost: $${totalCost.toFixed(2)}`,
        `  vs no cache:  $${costNoCache.toFixed(2)} (saving $${cacheSavings.toFixed(2)})`,
        "",
        "Tradeoff",
        `  Context freed: ${formatBytes(contextSaved)} (~${formatTokens(tokensSaved)})`,
        `  Turns tracked: ${cacheHistory.length}`,
        `  Rolling window: ${config.windowSize} messages`,
      ];

      // Show last 5 turns cache data
      if (cacheHistory.length > 0) {
        lines.push("");
        lines.push("Recent turns (last 5):");
        const recent = cacheHistory.slice(-5);
        for (const t of recent) {
          const turnTotal = t.input + t.cacheRead + t.cacheWrite;
          const hitRate = turnTotal > 0
            ? ((t.cacheRead / turnTotal) * 100).toFixed(0)
            : "0";
          const writeRate = (t.input + t.cacheRead + t.cacheWrite) > 0
            ? ((t.cacheWrite / (t.input + t.cacheRead + t.cacheWrite)) * 100).toFixed(0)
            : "0";
          const maskTag = t.masksApplied > 0 ? ` [+${t.masksApplied} mask${t.masksApplied > 1 ? "s" : ""}]` : "";
          lines.push(
            `  T${t.turn}: hit ${hitRate}% | write ${writeRate}% | read ${formatTokens(t.cacheRead)} | new ${formatTokens(t.cacheWrite)} | uncached ${formatTokens(t.input)} | masked ${formatBytes(t.bytesCompressed)}${maskTag}`,
          );
        }
      }

      ctx.ui?.notify?.(lines.join("\n"), "info");
    },
  });

  // /compress-config command
  pi.registerCommand("compress-config", {
    description: "Configure token compressor (window-size <N>)",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const key = parts[0]?.toLowerCase();
      const value = parts[1];

      if (!key) {
        ctx.ui?.notify?.(
          [
            "Compressor Config",
            `  window-size: ${config.windowSize}`,
            "",
            "Usage:",
            "  /compress-config window-size 10   # messages-from-HEAD kept unmasked (default: 10)",
            "",
            "Masking (v1.1.0): deterministic [masked <tool>] placeholders.",
            "Older tool results outside the window get replaced with a",
            "byte-stable placeholder. Cache-safe by design.",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (key === "window-size") {
        const n = Number.parseInt(value ?? "", 10);
        if (Number.isNaN(n) || n < 1) {
          ctx.ui?.notify?.("Usage: /compress-config window-size <positive integer>", "warning");
          return;
        }
        config.windowSize = n;
        saveConfig(config);
        ctx.ui?.notify?.(`Rolling window set to ${n} messages`, "info");
        return;
      }

      ctx.ui?.notify?.(`Unknown config key: ${key}. Use window-size.`, "warning");
    },
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}
