/**
 * Context-level retroactive compression — static-cutoff observation masking.
 *
 * v1.2.0 (ADR-018): static cutoff replaces rolling window.
 *
 * The mask cutoff T advances only when context usage crosses a pressure
 * threshold. Between advances, T is immutable → bytes before T stay
 * byte-identical turn-over-turn → cache prefix stays stable and the
 * mask-frontier drift bug of v1.1.x is eliminated.
 *
 * Measured on a real 1114-turn session:
 * - Rolling window N=10 (v1.1.1):  316 cache variants, $1594
 * - Static cutoff thresholds [0.20/0.35/0.50]:  159 variants, $1346
 * - No masking at all:              157 variants, $1414
 *
 * Rolling window was actively harmful (more expensive than no masking).
 * Static cutoff saves 16% vs rolling and 5% vs no-masking baseline.
 *
 * Why masking over summarization still holds (ADR-016): deterministic
 * byte-identical placeholders, JetBrains empirical advantage, agent
 * re-reads via just-in-time pattern.
 */

/** Context-usage thresholds that trigger cutoff advancement.
 *  Must be monotonically increasing. JetBrains-adjacent pressure curve. */
const DEFAULT_THRESHOLDS: readonly number[] = [0.20, 0.35, 0.50];

/** Coverage at each threshold — fraction of current messages masked
 *  when that threshold first fires. Monotonically increasing.
 *  Length MUST match DEFAULT_THRESHOLDS. */
const DEFAULT_COVERAGE: readonly number[] = [0.50, 0.75, 0.90];

/** Minimum tool-result size to mask. Below this, placeholder ≈ content → no win. */
const MIN_MASK_LENGTH = 120;

/** Command-invalidation rules: when `invalidator` command runs, any
 *  earlier output matching `invalidated` becomes stale. These still fire
 *  immediately regardless of cutoff — staleness is semantic, not
 *  position-based. */
const INVALIDATION_RULES: readonly { invalidator: RegExp; invalidated: RegExp }[] = [
  { invalidator: /^git\s+(add|rm|checkout|reset|stash|merge|rebase|cherry-pick)\b/, invalidated: /^git\s+status\b/ },
  { invalidator: /^git\s+(commit|merge|rebase)\b/, invalidated: /^git\s+(diff|log)\b/ },
  { invalidator: /^(npm|pnpm|yarn|bun)\s+(install|add|remove)\b/, invalidated: /^(npm|pnpm|yarn|bun)\s+(ls|list|outdated)\b/ },
  { invalidator: /^pip\s+install\b/, invalidated: /^pip\s+(list|freeze)\b/ },
];

/** Reference files — docs the model relies on across turns. Never masked. */
const REFERENCE_FILES = new Set([
  "AGENTS.md", "CONVENTIONS.md", "CLAUDE.md",
  ".ruff.toml", "ruff.toml", "biome.json",
  "pyproject.toml", "package.json", "tsconfig.json",
  "sgconfig.yml", ".shellcheckrc",
]);

function isReferenceFile(path: string): boolean {
  return REFERENCE_FILES.has(path.split("/").pop() ?? path);
}

export interface CompressResult {
  messages: any[];
  bytesSaved: number;
  masksApplied: number;
  /** The cutoff index used for this pass. Consumer persists this across
   *  calls so T doesn't regress. */
  cutoffIdx: number;
  /** Paths of read tool results newly masked this call. Caller records
   *  these + the current turn to detect re-reads. (v1.3.0 exp 3.) */
  maskedPaths: string[];
  /** Commands of bash tool results newly masked this call. Full command,
   *  not the 80-char truncated placeholder. */
  maskedCommands: string[];
}

export interface CompressOptions {
  /** Context usage thresholds (monotonically increasing). */
  thresholds?: readonly number[];
  /** Coverage fractions at each threshold (monotonically increasing). */
  coverage?: readonly number[];
  /** Current context usage (0..1). From pi's getContextUsage. */
  contextUsage?: number;
  /** Previous cutoff idx. T never decreases. */
  previousCutoff?: number;
  /** Highest zone ever entered this session. v1.2.1 true-static:
   *  a zone enters EXACTLY once. After that, cutoff is frozen at the
   *  messages.length-at-entry * coverage[zone]. Prevents drift when
   *  messages.length keeps growing past a threshold. */
  zoneEntered?: number;
}

export interface CutoffDecision {
  /** Cutoff to use for this call. */
  cutoffIdx: number;
  /** Zone currently active (-1 if below all thresholds). */
  activeZone: number;
  /** True if this call caused a zone transition (caller should persist
   *  the new zone + cutoff). */
  zoneAdvanced: boolean;
}

/**
 * Decide the cutoff for the current turn.
 *
 * v1.2.1: cutoff is frozen at first entry into a zone. Does NOT
 * re-derive from current messages.length on subsequent turns within
 * the same zone.
 *
 * @param messagesLength Current number of messages in the branch.
 * @param opts previousCutoff + zoneEntered (persisted by caller).
 */
export function decideCutoff(
  messagesLength: number,
  opts: CompressOptions = {},
): CutoffDecision {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const coverage = opts.coverage ?? DEFAULT_COVERAGE;
  const usage = opts.contextUsage ?? 0;
  const previousCutoff = opts.previousCutoff ?? 0;
  const zoneEntered = opts.zoneEntered ?? -1;

  // Determine current pressure zone.
  let activeZone = -1;
  for (let z = thresholds.length - 1; z >= 0; z--) {
    if (usage >= thresholds[z]) { activeZone = z; break; }
  }

  // True-static: only compute a new cutoff if we've entered a higher
  // zone than previously seen. Otherwise keep previousCutoff exactly.
  let cutoffIdx = previousCutoff;
  let zoneAdvanced = false;
  if (activeZone > zoneEntered) {
    const newCutoff = Math.floor(messagesLength * coverage[activeZone]);
    cutoffIdx = Math.max(previousCutoff, newCutoff);
    zoneAdvanced = true;
  }

  return { cutoffIdx, activeZone, zoneAdvanced };
}

/**
 * Process messages with static-cutoff masking.
 * Returns null if nothing to mask at the current cutoff.
 */
export function compressStaleToolResults(
  messages: any[],
  opts: CompressOptions = {},
): CompressResult | null {
  const { cutoffIdx } = decideCutoff(messages.length, opts);

  if (cutoffIdx <= 0) return null;

  const toolCallIndex = buildToolCallIndex(messages);

  let bytesSaved = 0;
  let masksApplied = 0;
  const maskedPaths: string[] = [];
  const maskedCommands: string[] = [];

  const result = messages.map((m: any, idx: number) => {
    const msg = m?.message ?? m;
    if (isAlreadyMasked(msg)) return m;

    // BASH: past cutoff OR invalidated by later command
    if (isBashToolResult(msg) && !msg.isError) {
      const content = extractTextContent(msg);
      if (content.length < MIN_MASK_LENGTH) return m;

      const command = extractCommand(msg, toolCallIndex);
      const pastCutoff = idx < cutoffIdx;
      const invalidated = !pastCutoff && isCommandInvalidated(command, messages, idx, toolCallIndex);

      if (pastCutoff || invalidated) {
        const placeholder = command
          ? `[masked bash] ${command.slice(0, 80)}`
          : `[masked bash]`;
        bytesSaved += content.length - placeholder.length;
        masksApplied++;
        if (command) maskedCommands.push(command);
        return replaceContent(m, placeholder);
      }
    }

    // READ: past cutoff AND not reference file
    if (isReadToolResult(msg) && !msg.isError) {
      const path = extractPath(msg, toolCallIndex);
      const content = extractTextContent(msg);

      if (path && content.length >= MIN_MASK_LENGTH && !isReferenceFile(path) && idx < cutoffIdx) {
        const placeholder = `[masked read] ${path}`;
        bytesSaved += content.length - placeholder.length;
        masksApplied++;
        maskedPaths.push(path);
        return replaceContent(m, placeholder);
      }
    }

    return m;
  });

  if (masksApplied === 0) return null;

  return { messages: result, bytesSaved, masksApplied, cutoffIdx, maskedPaths, maskedCommands };
}

/** Scan messages, return Map<toolCallId, {command, path}> from assistant
 *  toolCall blocks. Handles live + persisted shapes. */
function buildToolCallIndex(messages: any[]): Map<string, { command?: string; path?: string }> {
  const idx = new Map<string, { command?: string; path?: string }>();
  for (const m of messages) {
    const msg = m?.message ?? m;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
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

function isCommandInvalidated(
  command: string,
  messages: any[],
  fromIdx: number,
  toolCallIndex: Map<string, { command?: string; path?: string }>,
): boolean {
  const applicable = INVALIDATION_RULES.filter((r) => r.invalidated.test(command));
  if (applicable.length === 0) return false;
  for (let i = fromIdx + 1; i < messages.length; i++) {
    const later = messages[i]?.message ?? messages[i];
    if (!isBashToolResult(later)) continue;
    const laterCmd = extractCommand(later, toolCallIndex);
    if (applicable.some((r) => r.invalidator.test(laterCmd))) return true;
  }
  return false;
}

function isBashToolResult(msg: any): boolean {
  return msg?.role === "toolResult" && msg?.toolName === "bash";
}
function isReadToolResult(msg: any): boolean {
  return msg?.role === "toolResult" && msg?.toolName === "read";
}
function isAlreadyMasked(msg: any): boolean {
  if (msg?.role !== "toolResult") return false;
  const content = (msg.content ?? [])[0];
  if (!content || content.type !== "text") return false;
  const text = content.text ?? "";
  return text.startsWith("[masked ") || text.startsWith("[compressed]");
}

function extractCommand(msg: any, toolCallIndex?: Map<string, { command?: string; path?: string }>): string {
  const fromDetails = msg?.details?.command ?? msg?.input?.command;
  if (fromDetails) return fromDetails;
  if (toolCallIndex && msg?.toolCallId) return toolCallIndex.get(msg.toolCallId)?.command ?? "";
  return "";
}
function extractPath(msg: any, toolCallIndex?: Map<string, { command?: string; path?: string }>): string {
  const fromDetails = msg?.details?.path ?? msg?.input?.path;
  if (fromDetails) return fromDetails;
  if (toolCallIndex && msg?.toolCallId) return toolCallIndex.get(msg.toolCallId)?.path ?? "";
  return "";
}

function extractTextContent(msg: any): string {
  return (msg.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

function replaceContent(m: any, text: string): any {
  if (m?.message) return { ...m, message: { ...m.message, content: [{ type: "text", text }] } };
  return { ...m, content: [{ type: "text", text }] };
}
