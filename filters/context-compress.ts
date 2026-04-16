/**
 * Context-level retroactive compression — observation masking.
 *
 * Per JetBrains Research (Lindenbauer et al., Dec 2025) and Anthropic's
 * Effective Context Engineering guide: observation masking outperforms
 * LLM-style summarization for long-running agent sessions.
 *
 * Algorithm: fixed rolling window of last N messages kept in full. Older
 * bash and read tool results replaced with deterministic placeholders of
 * the form "[masked <tool>] <command-or-path>". Reference files
 * (AGENTS.md, CONVENTIONS.md, etc.) are never masked. Bash commands
 * invalidated by a later mutation (git add invalidates git status, etc.)
 * are masked immediately regardless of window position.
 *
 * Why masking over summarization:
 *   1. Byte-identical placeholders → single cache miss per tool-result
 *      ever compressed, then stable forever (vs summarization where each
 *      content change is a new miss).
 *   2. JetBrains empirical: masking matches/beats summarization on
 *      solve rate (-52% cost, +2.6% solve on Qwen3-Coder 480B).
 *   3. Summaries cause trajectory elongation (+13-15% more turns) by
 *      smoothing over stop-signals.
 *   4. Agent can re-read files or re-run commands if needed
 *      (just-in-time pattern per Anthropic).
 *
 * See knowledge/decisions/016-observation-masking... for full rationale.
 */

/** Messages older than HEAD by this many entries get masked.
 *  JetBrains found N=10 optimal for SWE-agent; tunable via config. */
const DEFAULT_WINDOW = 10;

/** Tool results shorter than this aren't worth masking — cost of the
 *  mask bytes approaches the content bytes. */
const MIN_MASK_LENGTH = 120;

/** Command-invalidation rules: when the `invalidator` command runs, any
 *  earlier output matching `invalidated` becomes stale immediately
 *  (ignore rolling window for these). */
const INVALIDATION_RULES: readonly { invalidator: RegExp; invalidated: RegExp }[] = [
  { invalidator: /^git\s+(add|rm|checkout|reset|stash|merge|rebase|cherry-pick)\b/, invalidated: /^git\s+status\b/ },
  { invalidator: /^git\s+(commit|merge|rebase)\b/, invalidated: /^git\s+(diff|log)\b/ },
  { invalidator: /^(npm|pnpm|yarn|bun)\s+(install|add|remove)\b/, invalidated: /^(npm|pnpm|yarn|bun)\s+(ls|list|outdated)\b/ },
  { invalidator: /^pip\s+install\b/, invalidated: /^pip\s+(list|freeze)\b/ },
];

/** Files that should never be masked — reference docs, project configs
 *  the model relies on across turns. */
const REFERENCE_FILES = new Set([
  "AGENTS.md", "CONVENTIONS.md", "CLAUDE.md",
  ".ruff.toml", "ruff.toml", "biome.json",
  "pyproject.toml", "package.json", "tsconfig.json",
  "sgconfig.yml", ".shellcheckrc",
]);

function isReferenceFile(path: string): boolean {
  const basename = path.split("/").pop() ?? path;
  return REFERENCE_FILES.has(basename);
}

export interface CompressResult {
  messages: any[];
  bytesSaved: number;
  masksApplied: number;
}

/**
 * Process messages array from context event.
 * Returns new array with masks applied + byte-savings count.
 * Returns null if nothing changed.
 */
export function compressStaleToolResults(
  messages: any[],
  windowSize: number = DEFAULT_WINDOW,
): CompressResult | null {
  if (messages.length <= windowSize) return null;

  // Everything at idx < staleBeforeIdx is outside the window → candidate for mask.
  const staleBeforeIdx = messages.length - windowSize;

  // Build toolCallId → { command, path } lookup from preceding assistant
  // toolCalls. Needed because persisted toolResults lack `details`/`input`
  // fields — the command/path only lives on the assistant toolCall block.
  // In live `context` events `details` is populated, but the lookup is
  // cheap and makes the transform robust to both shapes.
  const toolCallIndex = buildToolCallIndex(messages);

  let bytesSaved = 0;
  let masksApplied = 0;

  const result = messages.map((m: any, idx: number) => {
    const msg = m?.message ?? m;

    // Already masked — pass through untouched (idempotent, cache-stable).
    if (isAlreadyMasked(msg)) return m;

    // BASH: mask if past window OR invalidated by later command.
    if (isBashToolResult(msg) && !msg.isError) {
      const content = extractTextContent(msg);
      if (content.length < MIN_MASK_LENGTH) return m;

      const command = extractCommand(msg, toolCallIndex);
      const pastWindow = idx < staleBeforeIdx;
      const invalidated = !pastWindow && isCommandInvalidated(command, messages, idx, toolCallIndex);

      if (pastWindow || invalidated) {
        const placeholder = command
          ? `[masked bash] ${command.slice(0, 80)}`
          : `[masked bash]`;
        bytesSaved += content.length - placeholder.length;
        masksApplied++;
        return replaceContent(m, placeholder);
      }
    }

    // READ: mask if past window AND not a reference file.
    if (isReadToolResult(msg) && !msg.isError) {
      const path = extractPath(msg, toolCallIndex);
      const content = extractTextContent(msg);

      if (path && content.length >= MIN_MASK_LENGTH && !isReferenceFile(path) && idx < staleBeforeIdx) {
        const placeholder = `[masked read] ${path}`;
        bytesSaved += content.length - placeholder.length;
        masksApplied++;
        return replaceContent(m, placeholder);
      }
    }

    return m;
  });

  if (masksApplied === 0) return null;

  return { messages: result, bytesSaved, masksApplied };
}

/** Scan messages, return Map<toolCallId, {command, path}> built from
 *  assistant toolCall blocks. Supports both `id` and `toolCallId` keys
 *  (live vs persisted variants). */
function buildToolCallIndex(messages: any[]): Map<string, { command?: string; path?: string }> {
  const idx = new Map<string, { command?: string; path?: string }>();
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
  // Live path: details populated
  const fromDetails = msg?.details?.command ?? msg?.input?.command;
  if (fromDetails) return fromDetails;
  // Persisted path: look up via toolCallId
  if (toolCallIndex && msg?.toolCallId) {
    return toolCallIndex.get(msg.toolCallId)?.command ?? "";
  }
  return "";
}

function extractPath(msg: any, toolCallIndex?: Map<string, { command?: string; path?: string }>): string {
  const fromDetails = msg?.details?.path ?? msg?.input?.path;
  if (fromDetails) return fromDetails;
  if (toolCallIndex && msg?.toolCallId) {
    return toolCallIndex.get(msg.toolCallId)?.path ?? "";
  }
  return "";
}

function extractTextContent(msg: any): string {
  return (msg.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

function replaceContent(m: any, text: string): any {
  if (m?.message) {
    return {
      ...m,
      message: { ...m.message, content: [{ type: "text", text }] },
    };
  }
  return { ...m, content: [{ type: "text", text }] };
}
