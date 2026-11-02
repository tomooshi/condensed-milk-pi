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
 *
 * v1.10.0 (Phase 1 of vLLM/Qwen support): per-profile placeholder
 * templates and an optional historical thinking-block masking pass.
 *
 * v1.11.0 (CM-ADR-001): placeholders carry `#<id>` (sha1 of the tool-call
 * id) so `cm_recall` can return the original; `cm_recall` results are
 * masked past the cutoff like bash results.
 *
 * v1.13.0 (CM-ADR-005): three changes that only move at mask events, each
 * behind a feature flag: long edit/write/bash arguments are masked past the
 * cutoff (C); superseded reads and duplicate results before the event horizon
 * collapse (D); bash invalidation counts only commands before the event
 * horizon (B1). `eventHorizon` is the message count at the last mask event.
 */

import type { PlaceholderTemplates, ThinkingMaskPolicy } from "./profiles.js";
import { renderPlaceholder, DEFAULT_PLACEHOLDERS } from "./profiles.js";
import { countLines, formatSize, shortId } from "./text-metrics.js";
import { recallLabel } from "./recall.js";
import { argsId, maskArgs } from "./args-mask.js";
import { collapsePlan, type CollapseEntry } from "./collapse.js";

export { countLines, formatSize };

/** Tool name of the recall tool; its results age like bash results (CM-ADR-002 §3). */
export const RECALL_TOOL_NAME = "cm_recall";

/** Placeholder text for a bash result whose command is not known. */
const UNKNOWN_COMMAND = "(command unknown)";

/** The bash placeholder shows at most this many characters of the command.
 *  inherited: the v1.0 placeholder slice, kept so commands render the same prefix. */
const PLACEHOLDER_COMMAND_CHARS_MAX = 80;

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
  /** v1.11.0 (CM-ADR-002 §4): regexes matched against the cd-stripped bash
   *  command; a match marks a task boundary. Empty by default. */
  boundaryCommands: string[];
  /** v1.11.1 (CM-ADR-003, issue #4): filter names to turn off: a command
   *  prefix as registered ("yarn test") or "*<name>" for a content fallback. */
  disabledFilters: string[];
}

export function emptyUserConfig(): UserConfig {
  return { referenceBasenames: [], referencePathSubstrings: [], invalidationRules: [], disableDefaults: false, boundaryCommands: [], disabledFilters: [] };
}

export interface ResolvedRules {
  basenames: ReadonlySet<string>;
  substrings: readonly string[];
  invalidationRules: readonly { invalidator: RegExp; invalidated: RegExp }[];
  boundaryCommands: readonly RegExp[];
  disabledFilters: ReadonlySet<string>;
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
  const boundaryCommands = (user.boundaryCommands ?? []).map((pattern) => new RegExp(pattern));
  const disabledFilters = new Set((user.disabledFilters ?? []).map((name) => String(name).trim()).filter(Boolean));
  return { basenames: new Set(baseNames), substrings: subs, invalidationRules: rules, boundaryCommands, disabledFilters };
}

/** True when the bash command, with its `cd X &&` prefixes removed, matches
 *  a configured boundary pattern (CM-ADR-002 §4). */
export function isBoundaryCommand(command: string, rules: ResolvedRules): boolean {
  if (rules.boundaryCommands.length === 0) return false;
  const stripped = parseCdPrefix(command).cmd;
  return rules.boundaryCommands.some((pattern) => pattern.test(stripped));
}

/** Built-in default rules — used when caller doesn't inject a config.
 *  index.ts loads user JSON and overrides via opts.rules. */
const DEFAULT_RULES: ResolvedRules = resolveRules(emptyUserConfig());

/** v1.10.0: replace any `<think>…</think>` blocks and any
 *  `type: "thinking"` content blocks on an assistant message with a
 *  deterministic empty placeholder. Pure transform — never mutates
 *  the input message; returns a new structure if anything changed.
 *
 *  Both formats are handled because providers vary:
 *  - pi-ai's normalized assistant content uses `{type: "thinking"}` blocks
 *  - some openai-completions paths fold thinking inline as `<think>...</think>`
 *  - some shapes carry a top-level `reasoning_content` string field
 *
 *  The "with-coverage" vs "above-cutoff" distinction is handled by the
 *  caller via the cutoff gate — this function masks unconditionally
 *  when invoked. "above-cutoff" is not yet differentiated from
 *  "with-coverage" in this minimal Phase 1 — both currently mask any
 *  thinking on a pre-cutoff assistant message. Reserved for future
 *  divergence (e.g. "above-cutoff" might also bypass MIN_MASK_LENGTH-
 *  style thresholds we don't currently apply to thinking). */
function maskAssistantThinking(
  m: any,
  _policy: ThinkingMaskPolicy,
): { message: any; changed: boolean; bytesSaved: number } {
  const msg = m?.message ?? m;
  if (msg?.role !== "assistant") return { message: m, changed: false, bytesSaved: 0 };

  let bytesSaved = 0;
  let changed = false;

  // 1. Content blocks of type "thinking" — replace .thinking with the
  //    empty placeholder. Block kept in place so block count stays
  //    stable (any downstream code counting blocks won't shift).
  let newContent = msg.content;
  if (Array.isArray(msg.content)) {
    let blockChanged = false;
    newContent = msg.content.map((block: any) => {
      if (block?.type !== "thinking") return block;
      const original = typeof block.thinking === "string" ? block.thinking : "";
      if (original.length === 0) return block;  // already empty — skip
      bytesSaved += original.length - MASKED_THINKING_PLACEHOLDER.length;
      blockChanged = true;
      return { ...block, thinking: MASKED_THINKING_PLACEHOLDER };
    });
    // Also strip inline `<think>...</think>` from text blocks (some
    // openai-completions paths fold thinking into text). Conservative:
    // only strip well-formed pairs to avoid corrupting text that
    // legitimately mentions `<think>` substrings.
    newContent = newContent.map((block: any) => {
      if (block?.type !== "text" || typeof block.text !== "string") return block;
      const stripped = block.text.replace(/<think>[\s\S]*?<\/think>/g, "");
      if (stripped === block.text) return block;
      bytesSaved += block.text.length - stripped.length;
      blockChanged = true;
      return { ...block, text: stripped };
    });
    if (blockChanged) changed = true;
  }

  // 2. Top-level reasoning_content field (some shapes; e.g. deepseek-style).
  let newReasoning: string | undefined = msg.reasoning_content;
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
    bytesSaved += msg.reasoning_content.length;
    newReasoning = "";
    changed = true;
  }

  if (!changed) return { message: m, changed: false, bytesSaved: 0 };

  // Rebuild preserving the m / m.message wrapper shape used by the rest
  // of the codebase.
  const updatedMsg: any = { ...msg, content: newContent };
  if (newReasoning !== undefined) updatedMsg.reasoning_content = newReasoning;
  if (m?.message) return { message: { ...m, message: updatedMsg }, changed: true, bytesSaved };
  return { message: updatedMsg, changed: true, bytesSaved };
}

function isReferenceFile(path: string, rules: ResolvedRules): boolean {
  const base = path.split("/").pop() ?? path;
  if (rules.basenames.has(base)) return true;
  for (const sub of rules.substrings) {
    if (path.includes(sub)) return true;
  }
  return false;
}

export interface CompressResult {
  messages: any[];
  bytesSaved: number;
  masksApplied: number;
  /** v1.13.0: tool-call ids whose arguments were masked (C). */
  maskedArgCalls: string[];
  /** v1.13.0: tool-call ids of results collapsed by D. */
  collapsedCalls: string[];
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
  /** v1.10.0: profile-supplied placeholder templates. Falls back to
   *  the v1.9.0 `[cm-masked …]` strings when undefined. */
  placeholderFormat?: PlaceholderTemplates;
  /** v1.10.0: policy for masking historical `<think>` / reasoning
   *  blocks on assistant messages. Defaults to "off" (Anthropic
   *  behavior). See profiles.ts for semantics. */
  maskOldThinking?: ThinkingMaskPolicy;
  /** v1.13.0 (CM-ADR-005): changes that wait for mask events. Absent = off. */
  features?: MaskFeatures;
  /** v1.13.0: message count at the last mask event. D and B1 use only the
   *  messages before it, so their bytes do not change between events. */
  eventHorizon?: number;
}

/** v1.13.0 (CM-ADR-005) feature flags of the masker. */
export interface MaskFeatures {
  maskArgs?: boolean;
  collapseReads?: boolean;
  batchInvalidation?: boolean;
}


/** v1.10.0 deterministic constant for masked thinking blocks. Empty
 *  string keeps prefix bytes minimal AND identical across turns —
 *  same content, same hash, same prefix-cache lookup. */
const MASKED_THINKING_PLACEHOLDER = "";

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
 *
 * Each message goes through maskMessage(); this function only sums the
 * outcomes. Order, count, roles and tool-call ids never change; only the
 * text of masked results does (property-tested in tests/placeholders.test.mjs).
 */
export function compressStaleToolResults(
  messages: any[],
  opts: CompressOptions = {},
): CompressResult | null {
  const { cutoffIdx } = decideCutoff(messages.length, opts);
  const features = opts.features ?? {};
  const horizon = Math.min(Math.max(0, opts.eventHorizon ?? 0), messages.length);
  // With D and B1 off this is 1.12.0's rule exactly: no cutoff, no masks.
  const horizonWorks = horizon > 0 && (features.collapseReads === true || features.batchInvalidation === true);
  if (cutoffIdx <= 0 && !horizonWorks) return null;
  if (cutoffIdx > messages.length) throw new Error("compressStaleToolResults: cutoff past the end of messages");

  const toolCallIndex = buildToolCallIndex(messages);
  const scope: MaskScope = {
    messages,
    cutoffIdx,
    rules: opts.rules ?? DEFAULT_RULES,
    templates: { ...DEFAULT_PLACEHOLDERS, ...(opts.placeholderFormat ?? {}) },
    thinkingPolicy: opts.maskOldThinking ?? "off",
    toolCallIndex,
    features,
    invalidationLimit: features.batchInvalidation ? horizon : messages.length,
    collapse: features.collapseReads
      ? collapsePlan(messages, horizon, (id) => toolCallIndex.get(id), { minChars: MIN_MASK_LENGTH, isPlaceholder: isAlreadyMasked })
      : new Map(),
  };
  const outcomes = messages.map((m: any, idx: number) => maskMessage(m, idx, scope));
  if (outcomes.length !== messages.length) throw new Error("compressStaleToolResults: masking changed the message count");
  const applied = outcomes.filter((o) => o.bytesSaved !== null);
  if (applied.length === 0) return null;

  return {
    messages: outcomes.map((o) => o.message),
    bytesSaved: applied.reduce((sum, o) => sum + (o.bytesSaved ?? 0), 0),
    masksApplied: applied.length,
    cutoffIdx,
    maskedPaths: applied.flatMap((o) => (o.path ? [o.path] : [])),
    maskedCommands: applied.flatMap((o) => (o.command ? [o.command] : [])),
    maskedArgCalls: applied.flatMap((o) => o.argCalls ?? []),
    collapsedCalls: applied.flatMap((o) => (o.collapsedCall ? [o.collapsedCall] : [])),
  };
}

/** Everything maskMessage() needs that is the same for every message of one pass. */
interface MaskScope {
  messages: any[];
  cutoffIdx: number;
  rules: ResolvedRules;
  templates: PlaceholderTemplates;
  thinkingPolicy: ThinkingMaskPolicy;
  toolCallIndex: Map<string, ToolCallEntry>;
  features: MaskFeatures;
  /** Invalidating commands count only below this index (B1: the horizon). */
  invalidationLimit: number;
  /** D: index -> why the result collapses (empty when D is off). */
  collapse: Map<number, CollapseEntry>;
}

/** One message after masking. `bytesSaved` is null when nothing changed. */
interface MaskOutcome {
  message: any;
  bytesSaved: number | null;
  command?: string;
  path?: string;
  argCalls?: string[];
  collapsedCall?: string;
}

/** Decide and apply the mask for one message: a tool result (by tool kind)
 *  or old thinking. Errors, short results and placeholders are never masked. */
function maskMessage(m: any, idx: number, scope: MaskScope): MaskOutcome {
  const unchanged: MaskOutcome = { message: m, bytesSaved: null };
  const msg = m?.message ?? m;
  if (isAlreadyMasked(msg)) return unchanged;
  const pastCutoff = idx < scope.cutoffIdx;
  if (msg?.role === "toolResult") {
    const content = msg.isError ? "" : extractTextContent(msg);
    if (content.length < MIN_MASK_LENGTH) return unchanged;
    const target: MaskTarget = { m, msg, idx, content, pastCutoff };
    const vars = { id: shortId(String(msg.toolCallId ?? ""), msg.timestamp), n: countLines(content), size: formatSize(content.length) };
    if (msg.toolName === "bash") return maskBash(target, vars, scope) ?? maskCollapsed(target, vars, scope) ?? unchanged;
    if (msg.toolName === "read") return maskRead(target, vars, scope) ?? maskCollapsed(target, vars, scope) ?? unchanged;
    if (msg.toolName === RECALL_TOOL_NAME) return maskRecall(target, vars, scope) ?? unchanged;
    return unchanged;
  }
  if (!pastCutoff || msg?.role !== "assistant") return unchanged;
  return maskAssistant(m, scope) ?? unchanged;
}

/** An assistant message before the cutoff: long call arguments (C) and, by
 *  profile, old thinking (v1.10.0). Both replacements are deterministic, so
 *  the bytes stay identical turn-over-turn. */
function maskAssistant(m: any, scope: MaskScope): MaskOutcome | null {
  const args = scope.features.maskArgs ? maskCallArguments(m, scope) : null;
  const base = args?.message ?? m;
  const thinking = scope.thinkingPolicy === "off" ? null : maskAssistantThinking(base, scope.thinkingPolicy);
  if (!args && !thinking?.changed) return null;
  return {
    message: thinking?.changed ? thinking.message : base,
    bytesSaved: (args?.bytesSaved ?? 0) + (thinking?.changed ? thinking.bytesSaved : 0),
    argCalls: args?.argCalls,
  };
}

/** C: replace the long string arguments of edit/write/bash calls with
 *  placeholders that carry the arguments id; reference paths stay. */
function maskCallArguments(m: any, scope: MaskScope): MaskOutcome | null {
  const msg = m?.message ?? m;
  if (!Array.isArray(msg?.content)) return null;
  let saved = 0;
  const argCalls: string[] = [];
  const content = msg.content.map((block: any) => {
    if (block?.type !== "toolCall") return block;
    const args = block.arguments ?? block.input;
    if (typeof args?.path === "string" && isReferenceFile(args.path, scope.rules)) return block;
    const id = argsId(String(block.id ?? block.toolCallId ?? ""), msg.timestamp);
    const masked = maskArgs(String(block.name ?? ""), args, (cmd, vars) => renderPlaceholder(scope.templates.arg, { id, cmd, ...vars }));
    if (!masked) return block;
    saved += masked.saved;
    argCalls.push(String(block.id ?? block.toolCallId));
    return block.arguments !== undefined ? { ...block, arguments: masked.args } : { ...block, input: masked.args };
  });
  if (argCalls.length === 0) return null;
  const updated = { ...msg, content };
  return { message: m?.message ? { ...m, message: updated } : updated, bytesSaved: saved, argCalls };
}

/** D: a result that a newer one supersedes; the placeholder names the newer id. */
function maskCollapsed(t: MaskTarget, vars: PlaceholderVars, scope: MaskScope): MaskOutcome | null {
  const entry = scope.collapse.get(t.idx);
  if (!entry) return null;
  const newer = shortId(entry.newerToolCallId, entry.newerTimestamp);
  const suffix = entry.reason === "same text" ? ` — same text as #${newer}` : ` — newer read #${newer}`;
  const base = t.msg.toolName === "read"
    ? renderPlaceholder(scope.templates.read, { ...vars, path: extractPath(t.msg, scope.toolCallIndex) })
    : renderPlaceholder(scope.templates.bash, { ...vars, cmd: (extractCommand(t.msg, scope.toolCallIndex) || UNKNOWN_COMMAND).slice(0, PLACEHOLDER_COMMAND_CHARS_MAX) });
  const outcome = applyMask(t.m, t.content, base + suffix, {});
  return { ...outcome, collapsedCall: String(t.msg.toolCallId ?? "") };
}

/** One tool result that is long enough to mask. */
interface MaskTarget { m: any; msg: any; idx: number; content: string; pastCutoff: boolean }
type PlaceholderVars = { id: string; n: number; size: string };

/** Bash: masked past the cutoff, or earlier when a later command in the same
 *  cwd invalidates it (ADR-024). */
function maskBash(t: MaskTarget, vars: PlaceholderVars, scope: MaskScope): MaskOutcome | null {
  const command = extractCommand(t.msg, scope.toolCallIndex);
  const invalidated = !t.pastCutoff && command !== "" && t.idx < scope.invalidationLimit &&
    isCommandInvalidated(command, scope.messages, t.idx, scope.toolCallIndex, scope.rules, scope.invalidationLimit);
  if (!t.pastCutoff && !invalidated) return null;
  const cmd = command ? command.slice(0, PLACEHOLDER_COMMAND_CHARS_MAX) : UNKNOWN_COMMAND;
  return applyMask(t.m, t.content, renderPlaceholder(scope.templates.bash, { ...vars, cmd }), { command: command || undefined });
}

/** Read: masked past the cutoff unless the path is a reference file. */
function maskRead(t: MaskTarget, vars: PlaceholderVars, scope: MaskScope): MaskOutcome | null {
  const path = extractPath(t.msg, scope.toolCallIndex);
  if (!path || !t.pastCutoff || isReferenceFile(path, scope.rules)) return null;
  return applyMask(t.m, t.content, renderPlaceholder(scope.templates.read, { ...vars, path }), { path });
}

/** cm_recall: masked past the cutoff, labelled with its arguments (CM-ADR-002 §3). */
function maskRecall(t: MaskTarget, vars: PlaceholderVars, scope: MaskScope): MaskOutcome | null {
  if (!t.pastCutoff) return null;
  const cmd = scope.toolCallIndex.get(t.msg.toolCallId)?.recallLabel ?? UNKNOWN_COMMAND;
  return applyMask(t.m, t.content, renderPlaceholder(scope.templates.recall, { ...vars, cmd }), {});
}

/** Replace a result's content with its placeholder and report what it saved. */
function applyMask(m: any, content: string, placeholder: string, what: { command?: string; path?: string }): MaskOutcome {
  return { message: replaceContent(m, placeholder), bytesSaved: content.length - placeholder.length, ...what };
}

/** Scan messages, return Map<toolCallId, {command, path, cwd, recallLabel}>
 *  from assistant toolCall blocks. `command` is the RAW tool-call argument
 *  (preserved for the bash placeholder, which wants the cd-prefix visible to
 *  the model). `cwd` is parsed from a `cd X && ` prefix and used for
 *  invalidation scoping. `recallLabel` is set for cm_recall calls.
 *  Handles live + persisted shapes. */
type ToolCallEntry = { command?: string; path?: string; offset?: unknown; limit?: unknown; cwd?: string; recallLabel?: string };
function buildToolCallIndex(messages: any[]): Map<string, ToolCallEntry> {
  const calls = messages
    .map((m: any) => m?.message ?? m)
    .filter((msg: any) => msg?.role === "assistant" && Array.isArray(msg.content))
    .flatMap((msg: any) => msg.content.filter((block: any) => block?.type === "toolCall" && (block.id ?? block.toolCallId)));
  return new Map(calls.map((block: any) => {
    const args = block.arguments ?? block.input ?? {};
    const rawCmd = typeof args.command === "string" ? args.command : undefined;
    const entry: ToolCallEntry = {
      command: rawCmd,
      path: typeof args.path === "string" ? args.path : undefined,
      offset: args.offset,
      limit: args.limit,
      cwd: rawCmd ? parseCdPrefix(rawCmd).cwd : undefined,
      recallLabel: block.name === RECALL_TOOL_NAME ? recallLabel(args) : undefined,
    };
    return [block.id ?? block.toolCallId, entry] as [string, ToolCallEntry];
  }));
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
  limit: number,
): boolean {
  const self = parseCdPrefix(command);
  const applicable = rules.invalidationRules.filter((r) => r.invalidated.test(self.cmd));
  if (applicable.length === 0) return false;
  // Bounded by the message list; B1 (v1.13.0) lowers `limit` to the event horizon.
  for (let i = fromIdx + 1; i < Math.min(limit, messages.length); i++) {
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
