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
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
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
import {
  compressStaleToolResults,
  decideCutoff,
  resolveRules,
  emptyUserConfig,
  type UserConfig,
  type ResolvedRules,
} from "./filters/context-compress.js";
import { stripAnsi } from "./filters/ansi-strip.js";

// --- Config ---
// v1.2.0 (ADR-018): static-cutoff algorithm replaces rolling window.
// Cutoff advances only on pressure threshold crossings — bytes before
// the cutoff stay identical turn-over-turn — cache prefix stable.
//
// Migration from v1.1.x: windowSize silently ignored.
interface CompressorConfig {
  /** Context-usage thresholds (monotonically increasing, 0..1) that
   *  trigger cutoff advancement. Default [0.30, 0.45, 0.60] as of v1.7.0
   *  (ADR-025). Users targeting short sessions can override via
   *  `~/.config/condensed-milk.json`. */
  thresholds: number[];
  /** Coverage fractions at each threshold — fraction of messages to
   *  mask when that threshold fires. Must match thresholds length.
   *  Default [0.60, 0.80, 0.95] as of v1.7.0. */
  coverage: number[];
  /** Publish token-savings indicator to pi status bar via ctx.ui.setStatus.
   *  Orthogonal to compression behavior — only controls the footer display.
   *  Default true. Toggle via `/compress-config status on|off`. */
  showStatus: boolean;
}

const DEFAULT_CONFIG: CompressorConfig = {
  thresholds: [0.30, 0.45, 0.60],
  coverage:   [0.60, 0.80, 0.95],
  showStatus: true,
};

// v1.7.1 (ADR-026): recognized prior-version default tuples.
// If a user's config exactly matches one of these, they never customized
// and are just carrying stale auto-persisted defaults from an older version.
// Auto-migrate such configs to current DEFAULT_CONFIG. Any config not in this
// list is treated as an explicit user customization and preserved as-is.
const STALE_DEFAULTS: ReadonlyArray<{ label: string; thresholds: number[]; coverage: number[] }> = [
  { label: "v1.6.x", thresholds: [0.20, 0.35, 0.50], coverage: [0.50, 0.75, 0.90] },
];

const CONFIG_PATH = join(homedir(), ".config", "condensed-milk.json");

// v1.8.0: opt-in local telemetry. Never default on. See ADR-027.
// Path is separate from CONFIG_PATH so deleting one doesn't disturb the other.
const TELEMETRY_LOG_PATH = join(homedir(), ".config", "condensed-milk-sessions.jsonl");
const TELEMETRY_SCHEMA_VERSION = 1;
const PACKAGE_VERSION = "1.8.1";

/** v1.8.0: allowlist of pi built-in tool names. Any tool name from a custom
 *  extension (e.g. user-installed third-party tools with identifying names)
 *  is bucketed into "other" to prevent leaking custom tool identifiers —
 *  even into local logs. Extend this list as pi ships new built-in tools. */
const ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash", "read", "edit", "write", "grep", "find", "ls", "multiedit", "notebook_read", "notebook_edit",
]);

interface TelemetryConfig {
  local: boolean;
}

const DEFAULT_TELEMETRY: TelemetryConfig = { local: false };

/** Read telemetry flag with env-var override. Env var takes precedence over
 *  config file so users can toggle without editing config. Missing config or
 *  env var means disabled — opt-in only, never default on. */
function loadTelemetryConfig(): TelemetryConfig {
  const env = process.env.CONDENSED_MILK_TELEMETRY;
  if (env === "on" || env === "1" || env === "true") return { local: true };
  if (env === "off" || env === "0" || env === "false") return { local: false };
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.telemetry && typeof parsed.telemetry.local === "boolean") {
      return { local: parsed.telemetry.local };
    }
  } catch { /* file absent or invalid → default off */ }
  return { ...DEFAULT_TELEMETRY };
}

function saveTelemetryConfig(cfg: TelemetryConfig): void {
  try {
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch { /* fresh */ }
    existing.telemetry = { local: cfg.local };
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
  } catch { /* best-effort persist */ }
}

function arrEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function matchesStaleDefault(cfg: CompressorConfig): string | null {
  for (const s of STALE_DEFAULTS) {
    if (arrEqual(cfg.thresholds, s.thresholds) && arrEqual(cfg.coverage, s.coverage)) {
      return s.label;
    }
  }
  return null;
}

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
    const showStatus = typeof parsed.showStatus === "boolean" ? parsed.showStatus : DEFAULT_CONFIG.showStatus;
    const cfg: CompressorConfig = { thresholds, coverage, showStatus };
    // Auto-migrate stale defaults to current recommended values.
    // Preserves any non-matching config as explicit user customization.
    const staleLabel = matchesStaleDefault(cfg);
    if (staleLabel !== null) {
      const migrated: CompressorConfig = {
        thresholds: [...DEFAULT_CONFIG.thresholds],
        coverage: [...DEFAULT_CONFIG.coverage],
        showStatus,
      };
      saveConfig(migrated);
      try {
        process.stderr.write(
          `condensed-milk: migrated stale ${staleLabel} defaults in ${CONFIG_PATH} ` +
          `to current recommended [${migrated.thresholds.join(",")}]×` +
          `[${migrated.coverage.join(",")}]. To customize, use /compress-config.\n`,
        );
      } catch { /* stderr write is best-effort */ }
      return migrated;
    }
    return cfg;
  } catch {
    return { thresholds: [...DEFAULT_CONFIG.thresholds], coverage: [...DEFAULT_CONFIG.coverage], showStatus: DEFAULT_CONFIG.showStatus };
  }
}

/** Merge-preserving write: reads existing config, updates only thresholds and
 *  coverage, preserves any other keys (e.g. `telemetry`). Prevents v1.7.1
 *  auto-migration and /compress-config writes from clobbering other fields. */
function saveConfig(cfg: CompressorConfig): void {
  try {
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch { /* fresh */ }
    existing.thresholds = cfg.thresholds;
    existing.coverage = cfg.coverage;
    existing.showStatus = cfg.showStatus;
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
  } catch {
    // Non-fatal — config just won't persist
  }
}

// v1.6.0: user-supplied reference paths and invalidation rules.
// Separate file from CONFIG_PATH because the shape is different and
// we want project-local overrides — which the cutoff config doesn't
// support by design (cache stability requires a single source of truth).
const USER_RULES_GLOBAL_PATH = join(homedir(), ".pi", "agent", "condensed-milk-config.json");
function userRulesProjectPath(): string {
  return join(process.cwd(), "condensed-milk.config.json");
}

/** Merge user-supplied rule config from global + project-local files.
 *  ENOENT: skip silently (optional files). Any other read error or
 *  JSON parse error: throw — fail loud on malformed config rather
 *  than silently running with wrong rules. */
function loadUserRulesConfig(): UserConfig {
  const cfg = emptyUserConfig();
  for (const p of [USER_RULES_GLOBAL_PATH, userRulesProjectPath()]) {
    let raw: string;
    try {
      raw = readFileSync(p, "utf-8");
    } catch (e: any) {
      if (e?.code === "ENOENT") continue;
      throw new Error(`condensed-milk: cannot read rules config '${p}': ${e?.message ?? e}`);
    }
    const c = JSON.parse(raw);
    if (Array.isArray(c.referenceBasenames)) cfg.referenceBasenames.push(...c.referenceBasenames);
    if (Array.isArray(c.referencePathSubstrings)) cfg.referencePathSubstrings.push(...c.referencePathSubstrings);
    if (Array.isArray(c.invalidationRules)) cfg.invalidationRules.push(...c.invalidationRules);
    if (c.disableDefaults === true) cfg.disableDefaults = true;
  }
  return cfg;
}

// Resolved once at extension load. pi reloads the extension on each
// session start, so cwd-based project-local config is captured per
// session — good enough for the single-cwd-per-session common case.
const USER_RULES: ResolvedRules = resolveRules(loadUserRulesConfig());

// v1.9.0 (ADR-029): constant system-prompt addendum that teaches a
// self-sufficient looping agent what `[cm-masked …]` placeholders mean
// and how to recover content. Module-level const — bytes MUST be
// deterministic turn-over-turn so chained `before_agent_start`
// systemPrompt contributions keep the cache prefix stable. Any future
// edit here is a deliberate cache bust and MUST be ADR'd.
const CM_EXPLAINER = `

condensed-milk: tool results older than the current cutoff appear as
\`[cm-masked bash|read] …\` to keep the prompt cache stable. Re-run the
command or re-read the file to get current content. \`/compress-stats\`
for details.`;

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

  // v1.9.0 (ADR-029): append CM_EXPLAINER to every turn's system prompt.
  // Chained by pi across extensions (per BeforeAgentStartEventResult docs)
  // — safe to compose with other extensions contributing systemPrompt.
  // Constant string → byte-identical turn-over-turn → cache-stable.
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + CM_EXPLAINER,
  }));

  // Subagents: compress too — they benefit from smaller output
  let totalOriginal = 0;
  let totalCompressed = 0;
  let compressedCount = 0;
  let totalCommands = 0;

  // Config
  let config: CompressorConfig = loadConfig();

  // v1.8.0: telemetry state. Captured regardless of opt-in; written to disk
  // at session_shutdown ONLY if telemetry.local is true. Zero-cost when off.
  let telemetryConfig: TelemetryConfig = loadTelemetryConfig();
  let sessionStartIso = new Date().toISOString();
  let sessionStartReason: string = "startup";
  let sessionSessionFile: string | undefined;
  const toolCounts = new Map<string, number>();
  const zonesEnteredLog: Array<{ zone: number; at_turn: number; at_ctx_pct: number }> = [];

  // Cache tracking
  let cacheHistory: TurnCacheData[] = [];
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let turnCounter = 0;

  pi.on("session_start", async (event, ctx) => {
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
    everMaskedReads.clear();
    everMaskedBashes.clear();
    reReadByRead = 0;
    reReadByBash = 0;
    reReadTurnsDeltaSum = 0;
    cacheHistory = [];
    totalCacheRead = 0;
    totalCacheWrite = 0;
    totalInput = 0;
    totalOutput = 0;
    turnCounter = 0;
    // v1.8.0: reset telemetry session state
    sessionStartIso = new Date().toISOString();
    sessionStartReason = (event as any)?.reason ?? "startup";
    sessionSessionFile = (event as any)?.previousSessionFile;
    toolCounts.clear();
    zonesEnteredLog.length = 0;
    // Reload telemetry config at session start so toggle via /compress-telemetry
    // in a previous session is honored without requiring full pi restart.
    telemetryConfig = loadTelemetryConfig();
    const cmds = registeredCommands();
    if (config.showStatus) {
      ctx.ui?.setStatus?.("token-savings", `↓0 (${cmds.length}f)`);
    }
  });

  // v1.8.1 (ADR-028): /pi-vcc compaction collapses the messages array while
  // the masker's persistentCutoff is frozen at a pre-compact absolute index.
  // Without this reset, every post-compact tool_result sits below the stale
  // cutoff and gets masked (symptom: `cat file.md`, Read tool, etc. all return
  // `[cm-masked bash] <cmd>` / `[cm-masked read] <path>` for fresh content;
  // v1.9.0 (ADR-029) renamed the prefix from `[masked …]` to `[cm-masked …]`).
  // Reset all position-based state and re-enter zones naturally on next
  // context event that crosses a threshold.
  pi.on("session_compact", async (_event, _ctx) => {
    persistentCutoff = 0;
    zoneEntered = -1;
    // Clear mask trackers: placeholders in compact summary aren't tracked by
    // us, and re-read telemetry should restart clean since the
    // "original placeholder turn" recorded in these maps no longer
    // corresponds to a real message index post-compact.
    maskedReadPaths.clear();
    maskedBashCommands.clear();
    everMaskedReads.clear();
    everMaskedBashes.clear();
    reReadByRead = 0;
    reReadByBash = 0;
    reReadTurnsDeltaSum = 0;
    // Context mask counters reset so /compress-stats reflects post-compact
    // state rather than showing a carryover cutoff index that no longer
    // corresponds to any message in the array.
    contextSaved = 0;
    contextMaskEvents = 0;
    contextMasksTotal = 0;
  });

  // v1.8.0: on shutdown, if opt-in, append one JSONL line. Never writes without
  // explicit opt-in. Runs on graceful shutdown only (Ctrl+C/D, SIGHUP, SIGTERM);
  // crashed sessions skipped, which is acceptable — we only want clean data.
  pi.on("session_shutdown", async (_event, _ctx) => {
    if (!telemetryConfig.local) return;
    try {
      const endedIso = new Date().toISOString();
      const startMs = Date.parse(sessionStartIso);
      const endMs = Date.parse(endedIso);
      const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : 0;
      const totalAllInput = totalInput + totalCacheRead + totalCacheWrite;
      const cacheHitRate = totalAllInput > 0 ? totalCacheRead / totalAllInput : 0;
      const toolCountsObj: Record<string, number> = {};
      for (const [k, v] of toolCounts) toolCountsObj[k] = v;
      const cwdHash = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
      const sessionIdHash = sessionSessionFile
        ? createHash("sha256").update(sessionSessionFile).digest("hex").slice(0, 16)
        : null;
      const reReads = reReadByRead + reReadByBash;
      const entry = {
        schema: TELEMETRY_SCHEMA_VERSION,
        version: PACKAGE_VERSION,
        session_id_hash: sessionIdHash,
        cwd_hash: cwdHash,
        started_at: sessionStartIso,
        ended_at: endedIso,
        duration_ms: durationMs,
        start_reason: sessionStartReason,
        final_turn_count: turnCounter,
        final_ctx_pct: null,  // captured on last context event if available; left null if unknown
        zones_entered: zonesEnteredLog.slice(),
        tool_counts: toolCountsObj,
        mask_events: contextMaskEvents,
        unique_masks_reads: everMaskedReads.size,
        unique_masks_bashes: everMaskedBashes.size,
        re_reads_total: reReads,
        re_reads_by_read: reReadByRead,
        re_reads_by_bash: reReadByBash,
        avg_turns_held: reReads > 0 ? reReadTurnsDeltaSum / reReads : null,
        thresholds_used: config.thresholds.slice(),
        coverage_used: config.coverage.slice(),
        total_tokens_input: totalAllInput,
        total_cache_read: totalCacheRead,
        total_cache_write: totalCacheWrite,
        total_output: totalOutput,
        cache_hit_rate: cacheHitRate,
        commands_processed: totalCommands,
        commands_compressed: compressedCount,
        bytes_freed: contextSaved,
      };
      mkdirSync(dirname(TELEMETRY_LOG_PATH), { recursive: true });
      appendFileSync(TELEMETRY_LOG_PATH, JSON.stringify(entry) + "\n");
    } catch {
      // Silent failure — telemetry must never crash a session shutdown.
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    // v1.8.0: tool-call counter for telemetry (cheap: map increment per event).
    // Captured unconditionally; only written to disk if opt-in is true.
    const rawTn = event.toolName ?? "unknown";
    const tn = ALLOWED_TOOL_NAMES.has(rawTn) ? rawTn : "other";
    toolCounts.set(tn, (toolCounts.get(tn) ?? 0) + 1);
    // v1.4.0: re-read detection for read tool. Uses FIRST-mask turn.
    if (event.toolName === "read") {
      const path = (event.input as { path?: string })?.path;
      if (path && maskedReadPaths.has(path)) {
        const maskedTurn = maskedReadPaths.get(path)!;
        reReadByRead++;
        reReadTurnsDeltaSum += Math.max(0, turnCounter - maskedTurn);
        maskedReadPaths.delete(path);  // consumed; if re-masked later, set again as fresh first-mask
      }
      return;  // read output untouched by compressor filters
    }
    if (event.toolName !== "bash") return;
    // Don't skip errors — traceback filter specifically targets error output

    const command = (event.input as { command?: string })?.command;
    if (!command) return;

    // v1.4.0: re-read detection for bash. Uses FIRST-mask turn.
    if (maskedBashCommands.has(command)) {
      const maskedTurn = maskedBashCommands.get(command)!;
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
    if (config.showStatus) {
      _ctx.ui?.setStatus?.(
        "token-savings",
        `↓${formatBytes(totalSaved)} ${compressedCount}/${totalCommands} ${pct}%`,
      );
    }

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

  // v1.4.0: re-read telemetry with first-mask-turn semantics.
  // pi re-feeds original (unmasked) messages every context event, so we
  // re-apply masks every turn. maskedReadPaths / maskedBashCommands record
  // the FIRST turn we masked each path/command (only set if absent).
  // When an item is re-read, we delete it from the tracker. Rate
  // denominators use ever-masked sets which are never evicted.
  const maskedReadPaths = new Map<string, number>();
  const maskedBashCommands = new Map<string, number>();
  const everMaskedReads = new Set<string>();
  const everMaskedBashes = new Set<string>();
  let reReadByRead = 0;
  let reReadByBash = 0;
  let reReadTurnsDeltaSum = 0;  // sum of (currentTurn - firstMaskedTurn)

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
      // v1.8.0: record zone entry for telemetry.
      zonesEnteredLog.push({
        zone: decision.activeZone,
        at_turn: turnCounter,
        at_ctx_pct: contextUsage,
      });
    }

    const result = compressStaleToolResults(event.messages, {
      thresholds: config.thresholds,
      coverage: config.coverage,
      contextUsage,
      previousCutoff: persistentCutoff,
      zoneEntered,
      rules: USER_RULES,
    });
    const turnBytesCompressed = result?.bytesSaved ?? 0;
    const turnMasksApplied = result?.masksApplied ?? 0;

    if (result) {
      contextSaved += result.bytesSaved;
      contextMaskEvents++;
      // v1.4.0: record each item only on its FIRST mask. pi re-feeds the
      // raw messages each context event so the same items re-appear in
      // result.maskedPaths/maskedCommands every turn — ignore repeats.
      for (const p of result.maskedPaths) {
        if (!everMaskedReads.has(p)) {
          everMaskedReads.add(p);
          contextMasksTotal++;
        }
        if (!maskedReadPaths.has(p)) maskedReadPaths.set(p, turnCounter);
      }
      for (const c of result.maskedCommands) {
        if (!everMaskedBashes.has(c)) {
          everMaskedBashes.add(c);
          contextMasksTotal++;
        }
        if (!maskedBashCommands.has(c)) maskedBashCommands.set(c, turnCounter);
      }
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
        "Re-read Telemetry (v1.4.0)",
        `  Unique masks: ${everMaskedReads.size} reads, ${everMaskedBashes.size} bashes`,
        `  Currently tracked: ${maskedReadPaths.size} reads, ${maskedBashCommands.size} bashes (evicted on re-read)`,
        `  Re-read events: ${reReadByRead + reReadByBash} (${reReadByRead} reads, ${reReadByBash} bashes)`,
        // v1.6.1: ratio (events / unique) not percentage. Can legally
        // exceed 1.0× when the same path is re-read multiple times, which
        // was confusing as a percentage ("108%"). × notation makes the
        // >1 case natural.
        `  Re-read ratio: reads ${everMaskedReads.size > 0 ? (reReadByRead / everMaskedReads.size).toFixed(2) : "0.00"}× | bashes ${everMaskedBashes.size > 0 ? (reReadByBash / everMaskedBashes.size).toFixed(2) : "0.00"}× (events per unique mask)`,
        `  Avg turns placeholder held: ${(reReadByRead + reReadByBash) > 0 ? (reReadTurnsDeltaSum / (reReadByRead + reReadByBash)).toFixed(1) : "—"}`,
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
            `  statusbar:  ${config.showStatus ? "on" : "off"}`,
            "",
            "Usage:",
            "  /compress-config thresholds 0.30,0.45,0.60   # context-% triggers (monotonic)",
            "  /compress-config coverage 0.60,0.80,0.95     # mask fraction per trigger",
            "  /compress-config status on|off               # token-savings footer toggle",
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
          ctx.ui?.notify?.(`Usage: /compress-config ${key} 0.30,0.45,0.60  (values in [0,1])`, "warning");
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

      if (key === "status") {
        const arg = value.trim().toLowerCase();
        if (arg !== "on" && arg !== "off") {
          ctx.ui?.notify?.("Usage: /compress-config status on|off", "warning");
          return;
        }
        const show = arg === "on";
        config.showStatus = show;
        saveConfig(config);
        if (show) {
          // Re-publish current savings so footer reappears immediately.
          const totalSaved = totalOriginal - totalCompressed;
          const pct = totalOriginal > 0 ? Math.round((totalSaved / totalOriginal) * 100) : 0;
          const label = totalCommands > 0
            ? `↓${formatBytes(totalSaved)} ${compressedCount}/${totalCommands} ${pct}%`
            : `↓0 (${registeredCommands().length}f)`;
          ctx.ui?.setStatus?.("token-savings", label);
        } else {
          ctx.ui?.setStatus?.("token-savings", undefined);
        }
        ctx.ui?.notify?.(
          show ? "compress statusbar on." : "compress statusbar off. Compression unchanged.",
          "info",
        );
        return;
      }

      ctx.ui?.notify?.(`Unknown config key: ${key}. Use thresholds, coverage, or status.`, "warning");
    },
  });

  // /compress-telemetry — v1.8.0 opt-in local telemetry control.
  // Opt-in verb is deliberately verbose ("enable-local-logging") so it cannot
  // be triggered accidentally. See ADR-027.
  pi.registerCommand("compress-telemetry", {
    description: "Local session telemetry (opt-in, never shared). See full disclosure with no args.",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      const current = loadTelemetryConfig();
      const envOverride = process.env.CONDENSED_MILK_TELEMETRY;
      const envOverrideActive = envOverride === "on" || envOverride === "off" || envOverride === "1" || envOverride === "0" || envOverride === "true" || envOverride === "false";

      if (!sub) {
        // Status + full disclosure.
        const logSize = existsSync(TELEMETRY_LOG_PATH) ? statSync(TELEMETRY_LOG_PATH).size : 0;
        const logLines = logSize > 0 ? countLines(TELEMETRY_LOG_PATH) : 0;
        const state = current.local ? "ENABLED (local only)" : "DISABLED";
        const envNote = envOverrideActive
          ? `  (currently forced by env var CONDENSED_MILK_TELEMETRY=${envOverride})`
          : "";
        const lines = [
          `Telemetry — currently ${state}${envNote}`,
          "",
          "condensed-milk can log per-session summaries to:",
          `  ${TELEMETRY_LOG_PATH}`,
          "",
          "What would be recorded (per session, at graceful shutdown only):",
          "  · session duration + final turn count",
          "  · pressure zones entered (turn and ctx% at each)",
          "  · tool call counts by type (read/bash/edit/grep/etc.)",
          "  · mask events, unique masks, re-reads, avg placeholder hold",
          "  · thresholds and coverage in use",
          "  · cache hit rate + total tokens by bucket",
          "  · condensed-milk version",
          "  · sha256-truncated hashes of session file path + cwd (16 chars)",
          "",
          "What is NOT recorded:",
          "  × ANY message or tool output content",
          "  × file paths or tool inputs (only hashes)",
          "  × environment variables, API keys, or identity info",
          "",
          "Data stays on your machine. No network. No automatic upload.",
          "Opt-in only — default is OFF, always.",
          "",
          current.local
            ? `Log file: ${TELEMETRY_LOG_PATH}  (${logLines} sessions recorded, ${formatBytes(logSize)})`
            : "To enable:  /compress-telemetry enable-local-logging",
          current.local
            ? "Disable:   /compress-telemetry disable"
            : "Env alt:   set CONDENSED_MILK_TELEMETRY=on",
          current.local ? "Export for manual sharing: /compress-telemetry export" : "",
          current.local ? `View raw:  cat ${TELEMETRY_LOG_PATH} | jq` : "",
          current.local ? `Delete:    rm ${TELEMETRY_LOG_PATH}` : "",
        ].filter(Boolean);
        ctx.ui?.notify?.(lines.join("\n"), "info");
        return;
      }

      if (sub === "enable-local-logging") {
        if (envOverrideActive) {
          ctx.ui?.notify?.(
            `Env var CONDENSED_MILK_TELEMETRY=${envOverride} overrides config. Unset it first with: unset CONDENSED_MILK_TELEMETRY`,
            "warning",
          );
          return;
        }
        saveTelemetryConfig({ local: true });
        telemetryConfig = { local: true };
        ctx.ui?.notify?.(
          [
            "Local telemetry ENABLED.",
            `Writing per-session summaries to ${TELEMETRY_LOG_PATH} on graceful shutdown.`,
            "Data stays on your machine. Nothing is uploaded.",
            "",
            "To disable:  /compress-telemetry disable",
            "To view:     /compress-telemetry",
            "To export:   /compress-telemetry export",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "enable" || sub === "on" || sub === "enable-logging") {
        // Nudge toward the explicit verbose verb to make opt-in deliberate.
        ctx.ui?.notify?.(
          [
            "Opt-in requires the explicit command:",
            "  /compress-telemetry enable-local-logging",
            "(verbose verb is deliberate so this cannot be triggered accidentally)",
          ].join("\n"),
          "warning",
        );
        return;
      }

      if (sub === "disable" || sub === "off") {
        if (envOverrideActive) {
          ctx.ui?.notify?.(
            `Env var CONDENSED_MILK_TELEMETRY=${envOverride} overrides config. Unset it first with: unset CONDENSED_MILK_TELEMETRY`,
            "warning",
          );
          return;
        }
        saveTelemetryConfig({ local: false });
        telemetryConfig = { local: false };
        ctx.ui?.notify?.(
          [
            "Local telemetry DISABLED.",
            "No further session summaries will be written.",
            `Existing log at ${TELEMETRY_LOG_PATH} is untouched. Remove with:  rm ${TELEMETRY_LOG_PATH}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "export" || sub === "export-raw") {
        if (!existsSync(TELEMETRY_LOG_PATH)) {
          ctx.ui?.notify?.(
            `No telemetry log exists at ${TELEMETRY_LOG_PATH}. Enable logging first with: /compress-telemetry enable-local-logging`,
            "warning",
          );
          return;
        }
        const anonymize = sub === "export";  // default: anonymize. "export-raw" opts into keeping hashes.
        const suffix = anonymize ? "anonymized" : "raw";
        const exportPath = join(homedir(), `condensed-milk-sessions-export-${suffix}-${Date.now()}.jsonl`);
        try {
          const raw = readFileSync(TELEMETRY_LOG_PATH, "utf-8");
          let output: string;
          if (anonymize) {
            // Replace session_id_hash and cwd_hash with sequential IDs. Brute-forcing
            // a 64-bit hash against known candidates is possible for a recipient
            // who knows the user's repo/session patterns; sequential IDs close that.
            const sessionIdMap = new Map<string, string>();
            const cwdMap = new Map<string, string>();
            const lines = raw.split("\n").filter(Boolean);
            const out: string[] = [];
            for (const line of lines) {
              try {
                const obj = JSON.parse(line) as Record<string, unknown>;
                if (typeof obj.session_id_hash === "string") {
                  const h = obj.session_id_hash;
                  if (!sessionIdMap.has(h)) sessionIdMap.set(h, `session_${String(sessionIdMap.size + 1).padStart(4, "0")}`);
                  obj.session_id_hash = sessionIdMap.get(h);
                }
                if (typeof obj.cwd_hash === "string") {
                  const h = obj.cwd_hash;
                  if (!cwdMap.has(h)) cwdMap.set(h, `cwd_${String.fromCharCode(65 + (cwdMap.size % 26))}${cwdMap.size >= 26 ? Math.floor(cwdMap.size / 26) : ""}`);
                  obj.cwd_hash = cwdMap.get(h);
                }
                out.push(JSON.stringify(obj));
              } catch {
                // Skip malformed lines rather than failing whole export
              }
            }
            output = out.join("\n") + "\n";
          } else {
            output = raw;
          }
          writeFileSync(exportPath, output);
          const lineCount = countLines(TELEMETRY_LOG_PATH);
          ctx.ui?.notify?.(
            [
              `Exported ${lineCount} sessions to:`,
              `  ${exportPath}`,
              "",
              anonymize
                ? "Anonymized export: session_id_hash and cwd_hash replaced with sequential IDs."
                : "Raw export: original hashes preserved (use /compress-telemetry export for anonymized).",
              "No message content or tool output in either format — only session-shape stats.",
              "",
              "Review before sharing:",
              `  cat ${exportPath} | jq`,
              "",
              "No automated upload exists. You share this file manually or not at all.",
            ].join("\n"),
            "info",
          );
        } catch (e: any) {
          ctx.ui?.notify?.(`Export failed: ${e?.message ?? e}`, "warning");
        }
        return;
      }

      ctx.ui?.notify?.(
        [
          `Unknown subcommand: ${sub}`,
          "Valid: (no args) | enable-local-logging | disable | export | export-raw",
        ].join("\n"),
        "warning",
      );
    },
  });
}

/** Count newline-terminated lines in a file without loading it fully. */
function countLines(path: string): number {
  try {
    const buf = readFileSync(path);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    return n;
  } catch { return 0; }
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
