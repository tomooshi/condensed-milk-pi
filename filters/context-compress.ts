/**
 * Context-level retroactive compression — static-cutoff observation masking.
 *
 * v1.6.0 (ADR-024): cwd-aware invalidation + user-configurable rules.
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
 * v1.7.0 (ADR-025): delayed thresholds [0.30/0.45/0.60] with coverage
 * [0.60/0.80/0.95] measured 0.5–19% cheaper than prior [0.20/0.35/0.50]
 * × [0.50/0.75/0.90] across 4 real sessions. Biggest wins on long
 * sessions with heavy post-zone-2 traffic. See
 * knowledge/findings/adr-020-sweep-and-bash-invalidation-audit.md.
 *
 * Why masking over summarization still holds (ADR-016): deterministic
 * byte-identical placeholders, JetBrains empirical advantage, agent
 * re-reads via just-in-time pattern.
 */

/** Context-usage thresholds that trigger cutoff advancement.
 *  Must be monotonically increasing.
 *
 *  v1.7.0 (ADR-025): delayed from [0.20, 0.35, 0.50] to [0.30, 0.45, 0.60]
 *  after multi-session sweep found it saves 0.5–19% across real workloads
 *  with no regressions. Biggest wins on long sessions that continue past
 *  zone 2 entry — current-default cutoffs crystallize too early relative
 *  to how much session is still coming. Users targeting short sessions
 *  can override via `~/.config/condensed-milk.json`. */
const DEFAULT_THRESHOLDS: readonly number[] = [0.30, 0.45, 0.60];

/** Coverage at each threshold — fraction of current messages masked
 *  when that threshold first fires. Monotonically increasing.
 *  Length MUST match DEFAULT_THRESHOLDS.
 *
 *  v1.7.0: bumped to [0.60, 0.80, 0.95] (from [0.50, 0.75, 0.90]).
 *  Higher coverage was consistent 0.2–0.4% win on all sessions tested. */
const DEFAULT_COVERAGE: readonly number[] = [0.60, 0.80, 0.95];

/** Minimum tool-result size to mask. Below this, placeholder ≈ content → no win. */
const MIN_MASK_LENGTH = 120;

/** Default command-invalidation rules: when `invalidator` command runs,
 *  any earlier output matching `invalidated` becomes stale. These still
 *  fire immediately regardless of cutoff — staleness is semantic, not
 *  position-based.
 *
 *  v1.6.0: matched against `cd`-stripped command text. Matching is
 *  further scoped by cwd tuple in `isCommandInvalidated`. */
const DEFAULT_INVALIDATION_RULES: readonly { invalidator: RegExp; invalidated: RegExp }[] = [
  { invalidator: /^git\s+(add|rm|checkout|reset|stash|merge|rebase|cherry-pick)\b/, invalidated: /^git\s+status\b/ },
  { invalidator: /^git\s+(commit|merge|rebase)\b/, invalidated: /^git\s+(diff|log)\b/ },
  { invalidator: /^(npm|pnpm|yarn|bun)\s+(install|add|remove)\b/, invalidated: /^(npm|pnpm|yarn|bun)\s+(ls|list|outdated)\b/ },
  { invalidator: /^pip\s+install\b/, invalidated: /^pip\s+(list|freeze)\b/ },
];

/** Default basenames always treated as reference — never masked. */
const DEFAULT_REFERENCE_BASENAMES: readonly string[] = [
  // Agent instructions
  "AGENTS.md", "CONVENTIONS.md", "CLAUDE.md", "GEMINI.md",
  "SKILL.md",
  // Lint/format config
  ".ruff.toml", "ruff.toml", "biome.json",
  "pyproject.toml", "package.json", "tsconfig.json",
  "sgconfig.yml", ".shellcheckrc",
  // Project meta often re-read across a session
  "README.md", "CHANGELOG.md",
];

/** Default path substrings — any file under these trees is reference. */
const DEFAULT_REFERENCE_PATH_SUBSTRINGS: readonly string[] = [
  "/knowledge/decisions/",
  "/knowledge/concepts/",
  "/knowledge/patterns/",
  "/.pi/agent/skills/",
  "/.pi/skills/",
  "/rules/",
];

/** v1.6.0: strip iterative `cd <path> && ` prefixes, returning the
 *  last-seen cwd (effective working directory after all chained cds)
 *  and the residual command to match against invalidation regexes.
 *
 *  Pure function. Deterministic. Cache-safe. */
export function parseCdPrefix(cmd: string): { cwd?: string; cmd: string } {
  let cwd: string | undefined;
  let current = cmd;
  for (;;) {
    const m = /^cd\s+(\S+)\s*&&\s*(.+)$/s.exec(current);
    if (!m) break;
    cwd = m[1];
    current = m[2];
  }
  return { cwd, cmd: current };
}

// ── v1.6.0 config + rule resolution (pure, no IO) ──

/** User-supplied config shape. Populated from JSON files by index.ts
 *  (IO at the extension boundary; filter module stays pure). */
export interface UserConfig {
  referenceBasenames: string[];
  referencePathSubstrings: string[];
  invalidationRules: { invalidator: string; invalidated: string }[];
  disableDefaults: boolean;
}

export function emptyUserConfig(): UserConfig {
  return { referenceBasenames: [], referencePathSubstrings: [], invalidationRules: [], disableDefaults: false };
}

export interface ResolvedRules {
  basenames: ReadonlySet<string>;
  substrings: readonly string[];
  invalidationRules: readonly { invalidator: RegExp; invalidated: RegExp }[];
}

/** Pure transform UserConfig → ResolvedRules. Compiles user regex
 *  strings once; merges with or replaces defaults per disableDefaults. */
export function resolveRules(user: UserConfig): ResolvedRules {
  const baseNames = user.disableDefaults
    ? user.referenceBasenames
    : [...DEFAULT_REFERENCE_BASENAMES, ...user.referenceBasenames];
  const subs = user.disableDefaults
    ? user.referencePathSubstrings
    : [...DEFAULT_REFERENCE_PATH_SUBSTRINGS, ...user.referencePathSubstrings];
  const userRules = user.invalidationRules.map((r) => ({
    invalidator: new RegExp(r.invalidator),
    invalidated: new RegExp(r.invalidated),
  }));
  const rules = user.disableDefaults
    ? userRules
    : [...DEFAULT_INVALIDATION_RULES, ...userRules];
  return { basenames: new Set(baseNames), substrings: subs, invalidationRules: rules };
}

/** Built-in default rules — used when caller doesn't inject a config.
 *  index.ts loads user JSON and overrides via opts.rules. */
const DEFAULT_RULES: ResolvedRules = resolveRules(emptyUserConfig());

function isReferenceFile(path: string, rules: ResolvedRules): boolean {
  const base = path.split("/").pop() ?? path;
  if (rules.basenames.has(base)) return true;
  for (const sub of rules.substrings) {
    if (path.includes(sub)) return true;
  }
  return false;
}

/** Count newlines + 1 (matches `wc -l` + 1 semantics for non-trailing-newline files). */
function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** Deterministic size string — must not depend on locale or time. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
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
  /** v1.6.0: override the module-level DEFAULT_RULES. Tests inject a
   *  custom ResolvedRules here; prod callers leave unset. */
  rules?: ResolvedRules;
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

  // v1.8.1 (ADR-028) defense-in-depth: clamp the persisted cutoff to the
  // current array length. /pi-vcc compaction shrinks messages.length but
  // does not renumber indices consistently with the old cutoff value.
  // Without this clamp, every post-compact message sits below the stale
  // cutoff and all tool_results get masked. With it, at worst a compact
  // event that we missed degrades to "mask everything prior to the compact
  // boundary" which is still a correct bound since nothing prior exists.
  const clampedPreviousCutoff = Math.min(previousCutoff, messagesLength);

  // True-static: only compute a new cutoff if we've entered a higher
  // zone than previously seen. Otherwise keep previousCutoff exactly.
  let cutoffIdx = clampedPreviousCutoff;
  let zoneAdvanced = false;
  if (activeZone > zoneEntered) {
    const newCutoff = Math.floor(messagesLength * coverage[activeZone]);
    cutoffIdx = Math.max(clampedPreviousCutoff, newCutoff);
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
  const rules = opts.rules ?? DEFAULT_RULES;
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
      const invalidated = !pastCutoff && isCommandInvalidated(command, messages, idx, toolCallIndex, rules);

      if (pastCutoff || invalidated) {
        // v1.9.0 (ADR-029): `cm-` prefix brands placeholder as a
        // condensed-milk artifact (not a tool failure) — self-documenting
        // for self-sufficient looping agents who only see placeholder text
        // post-context_checkout. Bytes stay deterministic per message.
        const placeholder = command
          ? `[cm-masked bash] ${command.slice(0, 80)}`
          : `[cm-masked bash]`;
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

      if (path && content.length >= MIN_MASK_LENGTH && !isReferenceFile(path, rules) && idx < cutoffIdx) {
        // v1.4.0: enrich read placeholder with deterministic size/line
        // metadata so the model can decide whether to re-read without
        // actually re-reading. Derived purely from the original content
        // → byte-identical per message → cache prefix stays stable.
        const lineCount = countLines(content);
        const sizeStr = formatSize(content.length);
        // v1.9.0 (ADR-029): `cm-` prefix (see bash branch above).
        const placeholder = `[cm-masked read] ${path} (${lineCount} lines, ${sizeStr})`;
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

/** Scan messages, return Map<toolCallId, {command, path, cwd}> from
 *  assistant toolCall blocks. `command` is the RAW tool-call argument
 *  (preserved for the bash placeholder, which wants the cd-prefix
 *  visible to the model). `cwd` is parsed from a `cd X && ` prefix
 *  and used for invalidation scoping.
 *  Handles live + persisted shapes. */
type ToolCallEntry = { command?: string; path?: string; cwd?: string };
function buildToolCallIndex(messages: any[]): Map<string, ToolCallEntry> {
  const idx = new Map<string, ToolCallEntry>();
  for (const m of messages) {
    const msg = m?.message ?? m;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "toolCall") continue;
      const id = block.id ?? block.toolCallId;
      if (!id) continue;
      const args = block.arguments ?? block.input ?? {};
      const rawCmd = typeof args.command === "string" ? args.command : undefined;
      const cwd = rawCmd ? parseCdPrefix(rawCmd).cwd : undefined;
      idx.set(id, {
        command: rawCmd,
        path: typeof args.path === "string" ? args.path : undefined,
        cwd,
      });
    }
  }
  return idx;
}

/** v1.6.0: cwd-aware invalidation.
 *
 *  Both the candidate (self) and each later command are stripped of
 *  their `cd X && ` prefixes before regex matching. Invalidation fires
 *  only when their cwds match exactly. `undefined === undefined` counts
 *  as a match (the common single-cwd case where neither command has
 *  explicit cd), so existing sessions behave identically. Cross-cwd
 *  cases (mvdirty's multi-repo pattern) no longer spuriously invalidate. */
function isCommandInvalidated(
  command: string,
  messages: any[],
  fromIdx: number,
  toolCallIndex: Map<string, ToolCallEntry>,
  rules: ResolvedRules,
): boolean {
  const self = parseCdPrefix(command);
  const applicable = rules.invalidationRules.filter((r) => r.invalidated.test(self.cmd));
  if (applicable.length === 0) return false;
  for (let i = fromIdx + 1; i < messages.length; i++) {
    const later = messages[i]?.message ?? messages[i];
    if (!isBashToolResult(later)) continue;
    const laterRaw = extractCommand(later, toolCallIndex);
    const laterParsed = parseCdPrefix(laterRaw);
    if (self.cwd !== laterParsed.cwd) continue;
    if (applicable.some((r) => r.invalidator.test(laterParsed.cmd))) return true;
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
  // v1.9.0 (ADR-029): accept `[cm-masked ` (current) and `[masked `
  // (pre-v1.9.0 legacy, persisted in older session files on disk).
  return (
    text.startsWith("[cm-masked ") ||
    text.startsWith("[masked ") ||
    text.startsWith("[compressed]")
  );
}

function extractCommand(msg: any, toolCallIndex?: Map<string, ToolCallEntry>): string {
  const fromDetails = msg?.details?.command ?? msg?.input?.command;
  if (fromDetails) return fromDetails;
  if (toolCallIndex && msg?.toolCallId) return toolCallIndex.get(msg.toolCallId)?.command ?? "";
  return "";
}
function extractPath(msg: any, toolCallIndex?: Map<string, ToolCallEntry>): string {
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
