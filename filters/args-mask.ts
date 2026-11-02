/**
 * Masked tool-call arguments (CM-ADR-005, option C of docs/research/2026-11-02-next-features.md).
 *
 * An edit or write call carries the whole text it changes, and a heredoc bash
 * call carries the whole script. After the call ran, the file holds that text,
 * yet every later request re-sends it. Past the mask cutoff the long string
 * arguments become placeholders; `cm_recall` returns them from the session.
 *
 * Pure: no I/O, no clock. The placeholder bytes depend only on the call, so a
 * masked call renders the same bytes on every turn (cache-stable).
 */
import { countLines, formatSize, shortId } from "./text-metrics.js";

/** derived: an argument placeholder is about 70 characters; below 240 the
 *  gain is under 3x its own size. Revisit with the C telemetry. */
export const ARG_MASK_MIN_CHARS = 240;
/** measured: docs §2.4 splits bash commands at 2 KB; above it they are
 *  heredoc scripts (0.49B re-read tokens in 30 days), below it one-liners
 *  the agent may want to see again. */
export const BASH_COMMAND_MASK_MIN_CHARS = 2_048;
/** arbitrary: argument objects nest at most 3 levels in pi's tools; 8 bounds
 *  the walk for any other shape. */
const LEAF_DEPTH_MAX = 8;
/** arbitrary: an edit call with more than 256 replacements is not seen in 30
 *  days of sessions; the walk stops there. */
const LEAVES_MAX = 256;

/** Tools whose long string arguments are masked. */
const ARG_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash"]);

/** One string argument, addressed by its key path (`edits[0].oldText`). */
export interface ArgLeaf {
  key: string;
  value: string;
}

/** Id of a call's arguments: like a result id, but keyed with "args" so it
 *  never equals the id of the call's result. */
export function argsId(toolCallId: string, timestamp: unknown): string {
  if (typeof toolCallId !== "string") throw new TypeError("argsId: toolCallId must be a string");
  return shortId(`${toolCallId}\u0000args`, timestamp);
}

/** Every leaf of an argument object in walk order, as [key path, value].
 *  Stops one leaf past LEAVES_MAX, so callers can see that the walk was cut. */
function leavesOf(value: unknown, key: string, depth: number, out: [string, unknown][]): void {
  if (out.length > LEAVES_MAX) return;
  const container = value !== null && typeof value === "object";
  const empty = container && Object.keys(value as object).length === 0;
  if (!container || empty || depth >= LEAF_DEPTH_MAX) {
    out.push([key, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leavesOf(v, `${key}[${i}]`, depth + 1, out));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) leavesOf(v, key === "" ? k : `${key}.${k}`, depth + 1, out);
}

function allLeaves(args: unknown): [string, unknown][] {
  const out: [string, unknown][] = [];
  if (args !== null && typeof args === "object") leavesOf(args, "", 0, out);
  return out;
}

/** The string arguments of one call that a mask replaces. Empty for other
 *  tools, for `path`, and for values under the size floors. */
export function maskableLeaves(name: string, args: unknown): ArgLeaf[] {
  if (!ARG_TOOLS.has(name) || args === null || typeof args !== "object") return [];
  const min = name === "bash" ? BASH_COMMAND_MASK_MIN_CHARS : ARG_MASK_MIN_CHARS;
  const leaves = allLeaves(args);
  // At-limit action: a call with more leaves than LEAVES_MAX is never masked,
  // because argsText could not return all of it.
  if (leaves.length > LEAVES_MAX) return [];
  return leaves
    .filter(([key, value]) => typeof value === "string" && key !== "path" && value.length >= min)
    .filter(([key]) => name !== "bash" || key === "command")
    .map(([key, value]) => ({ key, value: value as string }));
}

/** Set one key path in a copy-on-write clone (only the path is copied). */
function setPath(root: any, parts: (string | number)[], value: string): any {
  const [head, ...rest] = parts;
  const copy = Array.isArray(root) ? root.slice() : { ...root };
  copy[head] = rest.length === 0 ? value : setPath(root[head], rest, value);
  return copy;
}

function keyParts(key: string): (string | number)[] {
  return (key.match(/[^.[\]]+|\[\d+\]/g) ?? []).map((p) => (p.startsWith("[") ? Number(p.slice(1, -1)) : p));
}

/** Replace the maskable leaves of one call with placeholders. Null when the
 *  call has none. `render` turns (key path, value) into the placeholder. */
export function maskArgs(
  name: string,
  args: unknown,
  render: (key: string, vars: { n: number; size: string }) => string,
): { args: unknown; saved: number } | null {
  const leaves = maskableLeaves(name, args);
  if (leaves.length === 0) return null;
  let out: any = args;
  let saved = 0;
  for (const leaf of leaves) {
    const placeholder = render(`${name} ${leaf.key}`, { n: countLines(leaf.value), size: formatSize(leaf.value.length) });
    if (placeholder.length >= leaf.value.length) continue;
    out = setPath(out, keyParts(leaf.key), placeholder);
    saved += leaf.value.length - placeholder.length;
  }
  if (out === args) return null;
  if (!(saved > 0)) throw new Error("maskArgs: a changed call must save characters");
  // Pair assertion with maskableLeaves: the masked call keeps its non-string leaves and its key paths.
  if (allLeaves(out).length !== allLeaves(args).length) throw new Error("maskArgs: masking changed the shape of the arguments");
  return { args: out, saved };
}

/** Readable, exact text of a call's arguments for cm_recall. A string becomes
 *  a section `--- <key> (<n> lines) ---` followed by exactly n raw lines, so
 *  grep and offset/limit work per line and every value comes back
 *  byte-identical; any other value is one line `<key>: <JSON>`. */
export function argsText(args: unknown): string {
  const leaves = allLeaves(args);
  if (leaves.length > LEAVES_MAX) throw new RangeError("argsText: more leaves than LEAVES_MAX; such calls are never masked");
  const lines = leaves.flatMap(([key, value]) => {
    if (typeof value !== "string") return [`${key}: ${JSON.stringify(value)}`];
    const header = `--- ${key} (${countLines(value)} lines) ---`;
    return value.length === 0 ? [header] : [header, value];
  });
  return lines.join("\n");
}
