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
import { compressStaleToolResults, decideCutoff } from "./filters/context-compress.js";
import { stripAnsi } from "./filters/ansi-strip.js";

// --- Config ---
// v1.2.0 (ADR-018): static-cutoff algorithm replaces rolling window.
// Cutoff advances only on pressure threshold crossings — bytes before
// the cutoff stay identical turn-over-turn — cache prefix stable.
//
// Migration from v1.1.x: windowSize silently ignored.
interface CompressorConfig {
  /** Context-usage thresholds (monotonically increasing, 0..1) that
   *  trigger cutoff advancement. Default [0.20, 0.35, 0.50]. */
  thresholds: number[];
  /** Coverage fractions at each threshold — fraction of messages to
   *  mask when that threshold fires. Must match thresholds length. */
  coverage: number[];
}

const DEFAULT_CONFIG: CompressorConfig = {
  thresholds: [0.20, 0.35, 0.50],
  coverage:   [0.50, 0.75, 0.90],
};

const CONFIG_PATH = join(homedir(), ".config", "condensed-milk.json");

function loadConfig(): CompressorConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const isValidArr = (v: unknown, len?: number) =>
      Array.isArray(v) && v.every((x) => typeof x === "number" && x >= 0 && x <= 1) &&
      (len === undefined || v.length === len);
    const thresholds = isValidArr(parsed.thresholds) ? parsed.thresholds : DEFAULT_CONFIG.thresholds;
    const coverage = isValidArr(parsed.coverage, thresholds.length)
      ? parsed.coverage
      : DEFAULT_CONFIG.coverage;
    return { thresholds, coverage };
  } catch {
    return { thresholds: [...DEFAULT_CONFIG.thresholds], coverage: [...DEFAULT_CONFIG.coverage] };
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
    contextSaved = 0;
    contextMaskEvents = 0;
    contextMasksTotal = 0;
    persistentCutoff = 0;
    zoneEntered = -1;
    maskedReadPaths.clear();
    maskedBashCommands.clear();
    reReadCount = 0;
    reReadByRead = 0;
    reReadByBash = 0;
    reReadTurnsDeltaSum = 0;
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
    // v1.3.0 exp 3: re-read detection for read tool.
    // If a path was previously masked and the model just re-read it,
    // the mask was semantically lossy — record it.
    if (event.toolName === "read") {
      const path = (event.input as { path?: string })?.path;
      if (path && maskedReadPaths.has(path)) {
        const maskedTurn = maskedReadPaths.get(path)!;
        reReadCount++;
        reReadByRead++;
        reReadTurnsDeltaSum += Math.max(0, turnCounter - maskedTurn);
        maskedReadPaths.delete(path);  // consumed — the re-read replaces the stale mask
      }
      return;  // read output untouched by compressor filters
    }
    if (event.toolName !== "bash") return;
    // Don't skip errors — traceback filter specifically targets error output

    const command = (event.input as { command?: string })?.command;
    if (!command) return;

    // v1.3.0 exp 3: re-read detection for bash.
    if (maskedBashCommands.has(command)) {
      const maskedTurn = maskedBashCommands.get(command)!;
      reReadCount++;
      reReadByBash++;
      reReadTurnsDeltaSum += Math.max(0, turnCounter - maskedTurn);
      maskedBashCommands.delete(command);
    }

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
  let contextSaved = 0;          // cumulative bytes freed by masking across session
  let contextMaskEvents = 0;      // distinct context events that applied ≥1 mask
  let contextMasksTotal = 0;      // cumulative individual tool results masked
  let persistentCutoff = 0;       // ADR-018: T never regresses across turns
  let zoneEntered = -1;           // v1.2.1: highest pressure zone ever entered; cutoff frozen on zone transition

  // v1.3.0 exp 3: re-read telemetry.
  // Map<path, turnMasked> for reads; Map<command, turnMasked> for bashes.
  // On tool_result, if the same path/command appears, this is a re-read:
  // the model discarded the placeholder and refetched. Records turn
  // delta (turns between mask and re-read) to measure mask longevity.
  const maskedReadPaths = new Map<string, number>();
  const maskedBashCommands = new Map<string, number>();
  let reReadCount = 0;
  let reReadByRead = 0;
  let reReadByBash = 0;
  let reReadTurnsDeltaSum = 0;  // sum of (currentTurn - turnMasked); mean = sum / reReadCount

  pi.on("context", async (event, ctx) => {
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

    // Read current context usage to drive static-cutoff decision.
    let contextUsage = 0;
    try {
      const usage = (ctx as any).getContextUsage?.();
      if (usage?.tokens && usage?.contextWindow) {
        contextUsage = usage.tokens / usage.contextWindow;
      }
    } catch {}

    // v1.2.1 true-static cutoff: cutoff freezes at zone entry and does
    // NOT re-derive from messages.length on subsequent turns. Eliminates
    // the drift-write pattern observed in v1.2.0 at zone 2.
    const decision = decideCutoff(event.messages.length, {
      thresholds: config.thresholds,
      coverage: config.coverage,
      contextUsage,
      previousCutoff: persistentCutoff,
      zoneEntered,
    });
    if (decision.zoneAdvanced) {
      zoneEntered = decision.activeZone;
      persistentCutoff = decision.cutoffIdx;
    }

    const result = compressStaleToolResults(event.messages, {
      thresholds: config.thresholds,
      coverage: config.coverage,
      contextUsage,
      previousCutoff: persistentCutoff,
      zoneEntered,
    });
    const turnBytesCompressed = result?.bytesSaved ?? 0;
    const turnMasksApplied = result?.masksApplied ?? 0;

    if (result) {
      contextSaved += result.bytesSaved;
      contextMaskEvents++;
      contextMasksTotal += result.masksApplied;
      // v1.3.0 exp 3: record newly-masked items so we can detect later re-reads.
      for (const p of result.maskedPaths) maskedReadPaths.set(p, turnCounter);
      for (const c of result.maskedCommands) maskedBashCommands.set(c, turnCounter);
      // persistentCutoff already updated on zone transition; nothing to do here
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

      const lines = [
        "Token Compressor Stats",
        `  Filters: ${cmds.join(", ")}`,
        `  Commands processed: ${totalCommands}`,
        `  Commands compressed: ${compressedCount}`,
        `  Original: ${formatBytes(totalOriginal)}`,
        `  Compressed: ${formatBytes(totalCompressed)}`,
        `  Saved: ${formatBytes(totalSaved)} (${pct}%)`,
        "",
        "Retroactive Masking (v1.2.0: static cutoff)",
        `  Tool results masked: ${contextMasksTotal} across ${contextMaskEvents} events`,
        `  Bytes freed: ${formatBytes(contextSaved)} (~${formatTokens(Math.round(contextSaved / 4))})`,
        `  Current cutoff: msg #${persistentCutoff}`,
        "",
        "Re-read Telemetry (v1.3.0 exp 3)",
        `  Tracked masks: ${maskedReadPaths.size} reads, ${maskedBashCommands.size} bashes`,
        `  Re-read events: ${reReadCount} (${reReadByRead} reads, ${reReadByBash} bashes)`,
        `  Re-read rate: ${contextMasksTotal > 0 ? ((reReadCount / contextMasksTotal) * 100).toFixed(1) : "0.0"}% of masks refetched`,
        `  Avg turns since mask: ${reReadCount > 0 ? (reReadTurnsDeltaSum / reReadCount).toFixed(1) : "—"}`,
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
        `  Turns tracked: ${cacheHistory.length}`,
        `  Thresholds: [${config.thresholds.join(", ")}]  coverage: [${config.coverage.join(", ")}]`,
        `  (cutoff advances only when context crosses a threshold — cache-stable)`,
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
    description: "Configure token compressor (thresholds, coverage)",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const key = parts[0]?.toLowerCase();
      const value = parts.slice(1).join(" ");

      if (!key) {
        ctx.ui?.notify?.(
          [
            "Compressor Config (v1.2.0: static-cutoff masking)",
            `  thresholds: [${config.thresholds.join(", ")}]`,
            `  coverage:   [${config.coverage.join(", ")}]`,
            "",
            "Usage:",
            "  /compress-config thresholds 0.20,0.35,0.50   # context-% triggers (monotonic)",
            "  /compress-config coverage 0.50,0.75,0.90     # mask fraction per trigger",
            "",
            "How it works: cutoff T advances only when context usage crosses a",
            "threshold. Bytes before T stay byte-identical turn-over-turn —",
            "cache prefix stays stable. Deterministic placeholders, no thrash.",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (key === "thresholds" || key === "coverage") {
        const arr = value.split(/[\s,]+/).filter(Boolean).map(Number);
        if (arr.length === 0 || arr.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
          ctx.ui?.notify?.(`Usage: /compress-config ${key} 0.20,0.35,0.50  (values in [0,1])`, "warning");
          return;
        }
        // Check monotonic
        for (let i = 1; i < arr.length; i++) {
          if (arr[i] <= arr[i - 1]) {
            ctx.ui?.notify?.(`${key} must be strictly increasing`, "warning");
            return;
          }
        }
        if (key === "thresholds") {
          config.thresholds = arr;
          if (config.coverage.length !== arr.length) {
            ctx.ui?.notify?.(
              `thresholds set to [${arr.join(", ")}]. Now also set coverage with the same length.`,
              "warning",
            );
          }
        } else {
          if (arr.length !== config.thresholds.length) {
            ctx.ui?.notify?.(
              `coverage length (${arr.length}) must match thresholds length (${config.thresholds.length})`,
              "warning",
            );
            return;
          }
          config.coverage = arr;
        }
        saveConfig(config);
        ctx.ui?.notify?.(`${key} set to [${arr.join(", ")}]`, "info");
        return;
      }

      ctx.ui?.notify?.(`Unknown config key: ${key}. Use thresholds or coverage.`, "warning");
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
