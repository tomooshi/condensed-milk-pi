/**
 * Filter dispatch — matches bash commands to compression filters.
 *
 * Each filter spec has a command prefix (e.g., "git status") and a filter
 * function that transforms stdout into a compressed representation.
 * Longest-prefix match wins, so "git status" beats "git".
 */

export interface FilterResult {
  output: string;
  category: "fast" | "medium" | "slow" | "immutable" | "mutation";
  /** v1.11.0 (CM-ADR-002 §2): the filter hides secrets, so the text from
   *  before the filter must never be kept (not even in the session file). */
  sensitive?: boolean;
}

/** v1.11.1 (CM-ADR-003): facts about the run that the output text alone
 *  does not show. `isError` is true when the command exited nonzero. */
export interface FilterMeta {
  isError: boolean;
}

export type FilterFn = (input: string, command: string, meta: FilterMeta) => FilterResult | null;

/** v1.11.1 (CM-ADR-003, issue #4): per-call options. `disabled` holds
 *  registered filter names to skip: a command prefix as passed to
 *  registerFilter() ("yarn test"), or "*<name>" for a content fallback ("*json"). */
export interface DispatchOptions {
  disabled?: ReadonlySet<string>;
  isError?: boolean;
}

interface FilterSpec {
  /** Command prefix to match (e.g., "git status", "pytest") */
  command: string;
  filter: FilterFn;
  category: FilterResult["category"];
}

const specs: FilterSpec[] = [];

/**
 * Register a filter for a command prefix.
 * Call this from individual filter modules at load time.
 */
export function registerFilter(
  command: string,
  filter: FilterFn,
  category: FilterResult["category"] = "fast",
): void {
  specs.push({ command, filter, category });
  // Keep sorted by command length descending for longest-prefix-first matching
  specs.sort((a, b) => b.command.length - a.command.length);
}

/**
 * Match a command string against registered filters and run the best match.
 * Returns null if no filter matches or the filter declines (returns null).
 *
 * Handles compound commands: "source .venv/bin/activate && python -m pytest -q"
 * is split on &&/||/; and each segment is checked. The LAST matching segment
 * wins (it produced the final output).
 */
// v1.9.0 (ADR-029 follow-up): a compound command with multiple
// output-producing segments gives us a concatenated stdout that no
// single per-command filter can interpret safely. Only these commands
// are known to produce no visible output or only trivially short
// output, so their presence in a chain is ignorable for producer
// counting.
const SILENT_COMMANDS = new Set([
  "cd", "export", "set", "unset", "source", ".",
  "true", "false", ":",
]);
function firstWord(seg: string): string {
  const trimmed = seg.trim();
  const sp = trimmed.indexOf(" ");
  return sp < 0 ? trimmed : trimmed.slice(0, sp);
}
function isSilentSegment(seg: string): boolean {
  return SILENT_COMMANDS.has(firstWord(seg));
}

export function dispatch(command: string, stdout: string, options: DispatchOptions = {}): FilterResult | null {
  // Skip tiny outputs — compression overhead exceeds savings
  if (stdout.length < 80) return null;
  const disabled = options.disabled ?? NO_DISABLED;
  const meta: FilterMeta = { isError: options.isError === true };
  const fallbacks = contentFallbacks.filter((fb) => !disabled.has(`*${fb.name}`));

  // Split compound commands and try each segment
  const segments = splitCompoundCommand(command);

  // v1.9.0 (ADR-029 follow-up): when the compound has ≥2 non-silent
  // segments, the captured stdout is a concatenation of multiple
  // commands' outputs. Per-command prefix filters would misinterpret
  // non-matching bytes (e.g. `bd update … && git status` produced
  // 'on unknown: clean' because git-status parsing ran on the combined
  // stdout). Fall through to content fallbacks instead.
  const nonSilentSegments = segments.filter(
    (s) => s.trim().length > 0 && !isSilentSegment(s),
  );
  if (nonSilentSegments.length >= 2) return runFallbacks(fallbacks, stdout, command, meta);

  // Try segments in reverse — last command in chain produced the output
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i].trim();
    if (segment.length === 0) continue;

    // Strip redirects and env var prefixes
    const cleaned = cleanSegment(segment);
    if (cleaned.length === 0) continue;

    for (const spec of specs) {
      if (commandMatches(cleaned, spec.command)) {
        // A disabled filter counts as "matched but declined" (issue #4).
        if (disabled.has(spec.command)) break;
        const result = spec.filter(stdout, cleaned, meta);
        if (result && result.output.length < stdout.length) {
          return result;
        }
        break; // Matched but filter declined — fall through to content fallbacks
      }
    }
  }

  // No command-prefix match — try content-based fallbacks
  return runFallbacks(fallbacks, stdout, command, meta);
}

/** First content fallback that makes the output shorter, or null. */
function runFallbacks(
  fallbacks: readonly { name: string; filter: FilterFn }[],
  stdout: string,
  command: string,
  meta: FilterMeta,
): FilterResult | null {
  for (const fb of fallbacks) {
    const result = fb.filter(stdout, command, meta);
    if (result && result.output.length < stdout.length) return result;
  }
  return null;
}

/**
 * Split a compound bash command on &&, ||, and ;.
 * Also strips trailing pipe chains (| head -5, | tail -3) since
 * those modify output before we see it but don't change the command identity.
 */
function splitCompoundCommand(command: string): string[] {
  const segments = command.split(/\s*(?:&&|\|\||;)\s*/);
  return segments.map((seg) =>
    seg.replace(/\s*\|\s*(?:head|tail|wc|sort|uniq)\b.*$/i, "").trim(),
  );
}

/**
 * Strip leading env vars (FOO=bar), 2>&1 redirects, and source/cd noise.
 */
function cleanSegment(segment: string): string {
  let s = segment;
  s = s.replace(/\s*2>&1\s*/g, " ").trim();
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "").trim();
  return s;
}

/**
 * Matches when command equals spec exactly OR starts with spec followed by
 * a space/tab. So "git status -s" matches "git status" but "git statusfoo" doesn't.
 */
function commandMatches(command: string, spec: string): boolean {
  if (command.length < spec.length) return false;
  if (!command.startsWith(spec)) return false;
  return command.length === spec.length || command[spec.length] === " " || command[spec.length] === "\t";
}

const NO_DISABLED: ReadonlySet<string> = new Set();

// Content-based fallback filters (not command-prefix based)
let contentFallbacks: Array<{ name: string; filter: FilterFn }> = [];

/**
 * Register a content-based fallback filter that runs when no
 * command-prefix filter matches. Used for JSON detection, etc.
 */
export function registerContentFallback(name: string, filter: FilterFn): void {
  // Replace by name: the extension registers on every load, and a push would
  // grow the list by one entry per session start.
  contentFallbacks = [...contentFallbacks.filter((f) => f.name !== name), { name, filter }];
}

/** List registered filter commands (for debugging/stats). */
export function registeredCommands(): string[] {
  return [...specs.map((s) => s.command), ...contentFallbacks.map((f) => `*${f.name}`)];
}
