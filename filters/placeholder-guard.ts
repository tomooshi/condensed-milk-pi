/**
 * Placeholder guard (CM-ADR-007, 1.13.1). Pure: tool-call arguments and the
 * active placeholder templates in, the first offending argument out.
 *
 * Field finding (docs/research/2026-11-02-next-features.md §13): once 1.13.0
 * masked the model's own earlier tool-call arguments, the model three times
 * copied the pattern into a new call with an invented id. One `write`
 * succeeded and replaced a 13.1 KB document with the 61-byte placeholder.
 * A placeholder is never real content, so a call whose string argument IS one
 * (the whole value, one line) is blocked before it runs. A value that only
 * contains a placeholder among other text (documentation, a grep pattern) is
 * allowed.
 */
import type { PlaceholderTemplates } from "./profiles.js";

/** The built-in placeholder shape of every version since 1.9 (ids since 1.11). */
const BUILT_IN = /^\[cm-masked (bash|read|recall|arg)( #[0-9a-f]{10})?\][^\n]*$/;
/** arbitrary: argument objects nest at most 3 levels in pi's tools; 8 bounds
 *  the walk for any other shape (same bound as filters/args-mask.ts). */
const DEPTH_MAX = 8;
/** arbitrary: string leaves checked per call; an edit with more replacements
 *  than this is not seen in 30 days of sessions. */
const LEAVES_MAX = 512;
/** Template variables and what each may match (no newlines anywhere). */
const VARIABLE = /\{(id|cmd|path|n|size)\}/g;
/** arbitrary: a custom template needs this much fixed text, or its matcher
 *  would match ordinary one-line values (a template of only "{cmd}"). */
const TEMPLATE_LITERAL_CHARS_MIN = 6;

export interface PlaceholderArgument {
  key: string;
  value: string;
}

/** Escape a literal for a RegExp. */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-value matchers: the built-in shape plus one per configured template
 *  (custom profiles may use another format, for example an XML element). */
export function placeholderMatchers(templates: Partial<PlaceholderTemplates>): RegExp[] {
  const custom = Object.values(templates)
    .filter((t): t is string => typeof t === "string" && t.includes("{"))
    .filter((t) => t.replace(VARIABLE, "").trim().length >= TEMPLATE_LITERAL_CHARS_MIN)
    .map((t) => {
      const parts = t.split(VARIABLE);
      // split with a capture group alternates literal, variable name, literal, ...
      const body = parts.map((p, i) => (i % 2 === 0 ? escapeRegExp(p) : p === "id" ? "[0-9a-f]{0,10}" : "[^\\n]*")).join("");
      return new RegExp(`^${body}$`);
    });
  const matchers = [BUILT_IN, ...custom];
  if (matchers.some((m) => m.flags.includes("g"))) throw new Error("placeholderMatchers: a stateful (global) matcher would skip matches");
  return matchers;
}

/** The first string argument (walk order) that is a whole-value placeholder,
 *  or null. Leading and trailing whitespace is ignored; a value of more than
 *  one line never matches. */
export function findPlaceholderArgument(args: unknown, matchers: RegExp[]): PlaceholderArgument | null {
  if (matchers.length === 0) throw new RangeError("findPlaceholderArgument: need at least one matcher");
  const stack: { value: unknown; key: string; depth: number }[] = [{ value: args, key: "", depth: 0 }];
  for (let seen = 0; stack.length > 0 && seen < LEAVES_MAX; seen++) {
    const { value, key, depth } = stack.pop()!;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed.includes("\n") && matchers.some((m) => m.test(trimmed))) return { key, value };
      continue;
    }
    if (value === null || typeof value !== "object" || depth >= DEPTH_MAX) continue;
    const entries = Array.isArray(value)
      ? value.map((v, i) => [`${key}[${i}]`, v] as const)
      : Object.entries(value as Record<string, unknown>).map(([k, v]) => [key === "" ? k : `${key}.${k}`, v] as const);
    // Reverse so the stack pops in walk order (first key first).
    for (const [k, v] of entries.reverse()) stack.push({ value: v, key: k, depth: depth + 1 });
  }
  return null;
}

/** The text the agent sees when a call is blocked. */
export function blockReason(found: PlaceholderArgument): string {
  if (!found.key) throw new Error("blockReason: a finding needs its key path");
  return `condensed-milk blocked this call: argument \`${found.key}\` is a condensed-milk placeholder, not real content. ` +
    "A placeholder only stands for text that is no longer shown; writing it would replace real content with one line. " +
    "Write the full content yourself, or call cm_recall with the id to see the original first.";
}
