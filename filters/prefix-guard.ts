/**
 * Prefix guard core (CM-ADR-004): name the first part of a provider request
 * that differs from the previous request.
 *
 * Why: on Claude 5.x a change before a thinking block invalidates that block
 * for good (the model loses its earlier reasoning), and any change rewrites
 * the prompt cache from that point. Changes come from many places (other
 * extensions, tool registration, restarts, condensed-milk itself), and the
 * session file does not record them. This module only observes; index.ts
 * never changes the request.
 *
 * The comparison follows the provider's cache order: tools, then system,
 * then messages. `cache_control` markers are ignored: pi moves the breakpoint
 * every request and that does not change the cached content.
 *
 * Cost: equality walks the two payloads node by node and compares leaf
 * strings with ===, which is O(1) when pi reuses the same string objects
 * between requests (it does for unchanged messages). So the cost follows the
 * number of blocks, not the number of characters.
 */

/** arbitrary: provider payloads are about 6 levels deep; deeper input is
 *  treated as changed rather than walked (static limit, ADR-032). */
export const PAYLOAD_DEPTH_MAX = 32;

/** Kinds of prefix change, in the order a cache reads the request. */
export type PrefixKind = "first" | "none" | "tools" | "system" | "message" | "removed" | "unsupported";

/** What a changed message is, without its text (CM-ADR-008). An Anthropic
 *  tool result has role "user", so the role alone does not say. */
export type MessageClass = "user" | "assistant" | "tool_result" | "system" | "other";
export const MESSAGE_CLASSES: readonly MessageClass[] = ["user", "assistant", "tool_result", "system", "other"];

/** Where two system prompts first differ, in characters of their joined text. */
export interface SystemSpan {
  offset: number;
  prevLength: number;
  curLength: number;
}

export interface PrefixChange {
  kind: PrefixKind;
  /** Tool index for "tools", message index for "message"/"removed", else null. */
  index: number | null;
  /** Human-readable cause, for example "added mcp__x" or "condensed-milk mask". */
  detail: string;
  /** Thinking blocks after the change: the blocks a Claude 5.x model loses. */
  thinkingAfter: number;
  /** "message" and "removed" (not at the end): the class of the changed message. */
  role?: MessageClass;
  /** "message" and "removed" (not at the end): messages of the previous
   *  request after the changed one. 0 means its last message changed. */
  gap?: number;
  /** "system": where the text first differs. */
  span?: SystemSpan;
  /** "tools": what happened to the first differing tool. */
  toolChange?: "added" | "removed" | "changed";
}

/** arbitrary: characters of each side an excerpt shows; enough to name the
 *  source of an edit (a date, a status line, an injected note). */
export const EXCERPT_CHARS_MAX = 160;
/** arbitrary: the first few messages of the previous request after an edit
 *  are told apart; revisit when the schema-6 exports show the distribution. */
const GAP_NEAR_MAX = 9;

const NONE: PrefixChange = { kind: "none", index: null, detail: "", thinkingAfter: 0 };
/** inherited: the placeholder prefix (CM-ADR-001). */
const MASK_MARK = "[cm-masked ";

/** Deep equality that skips `cache_control` keys. Bounded by PAYLOAD_DEPTH_MAX.
 *  Allocation-free loops: this runs on every request over every block. */
export function equalIgnoringCacheControl(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth >= PAYLOAD_DEPTH_MAX) return false;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) if (!equalIgnoringCacheControl(aa[i], bb[i], depth + 1)) return false;
    return true;
  }
  const oa = a as Record<string, unknown>;
  const ob = b as Record<string, unknown>;
  let countA = 0;
  for (const k in oa) {
    if (k === "cache_control") continue;
    countA++;
    if (!(k in ob) || !equalIgnoringCacheControl(oa[k], ob[k], depth + 1)) return false;
  }
  let countB = 0;
  for (const k in ob) if (k !== "cache_control") countB++;
  return countA === countB;
}

/** Thinking and redacted-thinking blocks in messages after `fromIndex` (exclusive). */
export function thinkingBlockCount(messages: unknown[], fromIndex: number): number {
  let n = 0;
  for (let i = Math.max(0, fromIndex + 1); i < messages.length; i++) {
    const content = (messages[i] as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const type = (block as { type?: unknown })?.type;
      if (type === "thinking" || type === "redacted_thinking") n++;
    }
  }
  return n;
}

function toolName(tool: unknown): string {
  const t = tool as { name?: unknown; function?: { name?: unknown } };
  return String(t?.name ?? t?.function?.name ?? "(unnamed)");
}

type ToolDifference = { index: number; detail: string; toolChange: "added" | "removed" | "changed" };

/** First tool difference, or null. */
function compareTools(prev: unknown[], cur: unknown[]): ToolDifference | null {
  const shared = Math.min(prev.length, cur.length);
  for (let i = 0; i < shared; i++) {
    if (equalIgnoringCacheControl(prev[i], cur[i])) continue;
    const prevName = toolName(prev[i]);
    const curName = toolName(cur[i]);
    if (prevName === curName) return { index: i, detail: `changed ${curName}`, toolChange: "changed" };
    const removed = !cur.some((t) => toolName(t) === prevName);
    return removed
      ? { index: i, detail: `removed ${prevName}`, toolChange: "removed" }
      : { index: i, detail: `added ${curName}`, toolChange: "added" };
  }
  if (cur.length > prev.length) return { index: shared, detail: `added ${toolName(cur[shared])}`, toolChange: "added" };
  if (prev.length > cur.length) return { index: shared, detail: `removed ${toolName(prev[shared])}`, toolChange: "removed" };
  return null;
}

/** Class of a provider message: an Anthropic tool result is a "user" message
 *  with a tool_result block, an OpenAI one has role "tool". */
export function messageClass(message: unknown): MessageClass {
  const m = message as { role?: unknown; content?: unknown } | null;
  const role = typeof m === "object" && m !== null ? m.role : undefined;
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return "system";
  if (role === "tool" || role === "toolResult") return "tool_result";
  if (role !== "user") return "other";
  const blocks = Array.isArray(m!.content) ? (m!.content as unknown[]) : [];
  return blocks.some((b) => (b as { type?: unknown })?.type === "tool_result") ? "tool_result" : "user";
}

/** Telemetry bucket for a gap: "0", "1", "2_9" or "10_plus". */
export function gapBucket(gap: number): "0" | "1" | "2_9" | "10_plus" {
  if (!Number.isInteger(gap) || gap < 0) throw new RangeError(`gapBucket: gap must be a whole number of at least 0 (got ${gap})`);
  if (gap === 0) return "0";
  if (gap === 1) return "1";
  return gap <= GAP_NEAR_MAX ? "2_9" : "10_plus";
}

/** Text of a system prompt: a string, or the `text` of its blocks joined. */
function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return system === undefined || system === null ? "" : JSON.stringify(system);
  return system.map((b) => (typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : JSON.stringify(b ?? ""))).join("");
}

/** Length of the shared start of two strings. Bounded by the shorter one. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i > max) throw new Error("commonPrefixLength: walked past the shorter string");
  return i;
}

/** Where two system prompts first differ. */
function systemSpan(prev: unknown, cur: unknown): SystemSpan {
  const a = systemText(prev);
  const b = systemText(cur);
  return { offset: commonPrefixLength(a, b), prevLength: a.length, curLength: b.length };
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  return JSON.stringify(content ?? "");
}

/** Classify a changed message at `index`. */
function messageChange(prev: unknown[], cur: unknown[], index: number): PrefixChange {
  if (!(index >= 0 && index < prev.length)) throw new RangeError("messageChange: index must be inside the previous messages");
  const role = String((prev[index] as { role?: unknown })?.role ?? "message");
  const where = { role: messageClass(prev[index]), gap: prev.length - 1 - index };
  if (index + 1 < prev.length && equalIgnoringCacheControl(prev[index + 1], cur[index])) {
    return { kind: "removed", index, detail: `${role} removed`, thinkingAfter: thinkingBlockCount(cur, index - 1), ...where };
  }
  const masked = textOf(cur[index]).includes(MASK_MARK) && !textOf(prev[index]).includes(MASK_MARK);
  return { kind: "message", index, detail: masked ? "condensed-milk mask" : `${role} edited`, thinkingAfter: thinkingBlockCount(cur, index), ...where };
}

/** Both sides of a change from the first differing character, at most
 *  EXCERPT_CHARS_MAX each; null for a change with no text to show. This is
 *  conversation text: index.ts writes it only to the debug log, and only when
 *  the operator sets CM_PREFIX_GUARD_LOG_TEXT=1. Never in telemetry. */
export function changeExcerpt(prev: unknown, cur: unknown, change: PrefixChange): { prev: string; cur: string } | null {
  const p = prev as { system?: unknown; messages?: unknown } | null;
  const c = cur as { system?: unknown; messages?: unknown } | null;
  const sides = (a: string, b: string) => {
    const at = commonPrefixLength(a, b);
    return { prev: a.slice(at, at + EXCERPT_CHARS_MAX), cur: b.slice(at, at + EXCERPT_CHARS_MAX) };
  };
  if (change.kind === "system") return sides(systemText(p?.system), systemText(c?.system));
  if (change.kind !== "message" || change.index === null) return null;
  if (!Array.isArray(p?.messages) || !Array.isArray(c?.messages)) throw new Error("changeExcerpt: a message change needs both message arrays");
  return sides(textOf(p.messages[change.index]), textOf(c.messages[change.index]));
}

/**
 * Compare two provider payloads. `prev` null means this is the first request.
 * Supports Anthropic payloads ({tools, system, messages}) and OpenAI-style
 * payloads (system as message 0, tools with `function.name`).
 */
export function comparePayloads(prev: unknown, cur: unknown): PrefixChange {
  const c = cur as { tools?: unknown; system?: unknown; messages?: unknown };
  if (typeof cur !== "object" || cur === null || !Array.isArray(c.messages)) {
    return { kind: "unsupported", index: null, detail: "no messages array", thinkingAfter: 0 };
  }
  const curMessages = c.messages as unknown[];
  if (prev === null || prev === undefined) return { kind: "first", index: null, detail: "", thinkingAfter: 0 };
  const p = prev as { tools?: unknown; system?: unknown; messages?: unknown };
  const prevMessages = Array.isArray(p.messages) ? (p.messages as unknown[]) : [];
  const tools = compareTools(Array.isArray(p.tools) ? p.tools : [], Array.isArray(c.tools) ? c.tools : []);
  if (tools) return { kind: "tools", index: tools.index, detail: tools.detail, thinkingAfter: thinkingBlockCount(curMessages, -1), toolChange: tools.toolChange };
  if (!equalIgnoringCacheControl(p.system, c.system)) {
    return { kind: "system", index: null, detail: "system", thinkingAfter: thinkingBlockCount(curMessages, -1), span: systemSpan(p.system, c.system) };
  }
  const shared = Math.min(prevMessages.length, curMessages.length);
  for (let i = 0; i < shared; i++) {
    if (!equalIgnoringCacheControl(prevMessages[i], curMessages[i])) return messageChange(prevMessages, curMessages, i);
  }
  if (curMessages.length < prevMessages.length) {
    return { kind: "removed", index: shared, detail: "messages removed at the end", thinkingAfter: 0 };
  }
  return NONE;
}

/** arbitrary: recent requests a new request is compared with. A side request
 *  (a fork that asks the model a question, a summary call) sits between two
 *  main requests; 4 covers three side requests in a row. Revisit if
 *  `prefix_side_requests` is often followed by a counted edit. */
export const LINEAGE_MAX = 4;

/** How much of the request a change leaves intact, in cache order: a tools
 *  change leaves nothing, a system change the tools, a message change the
 *  messages before it. Larger is better; no change is Infinity. */
function sharedDepth(change: PrefixChange): number {
  if (change.kind === "none") return Number.POSITIVE_INFINITY;
  if (change.kind === "tools") return 0;
  if (change.kind === "system") return 1;
  if (change.kind !== "message" && change.kind !== "removed") throw new Error(`sharedDepth: no depth for kind ${change.kind}`);
  if (change.index === null) throw new Error("sharedDepth: a message change needs its index");
  return 2 + change.index;
}

/**
 * Compare a request with the recent requests (newest first) and return the
 * comparison that shares the longest prefix. `base` is the position in
 * `lineage` of the request it was compared with: above 0 means the newer
 * requests were side requests that `cur` does not continue (CM-ADR-008 §4).
 * The provider's cache is keyed by prefix, so appending to any recent request
 * edits nothing. Ties go to the newest request.
 */
export function compareWithLineage(lineage: readonly unknown[], cur: unknown): { change: PrefixChange; base: number } {
  if (lineage.length > LINEAGE_MAX) throw new RangeError(`compareWithLineage: at most LINEAGE_MAX (${LINEAGE_MAX}) requests, got ${lineage.length}`);
  const newest = comparePayloads(lineage.length > 0 ? lineage[0] : null, cur);
  if (newest.kind === "first" || newest.kind === "unsupported" || newest.kind === "none") return { change: newest, base: 0 };
  let best = { change: newest, base: 0 };
  for (let i = 1; i < lineage.length; i++) {
    const change = comparePayloads(lineage[i], cur);
    if (change.kind === "first" || change.kind === "unsupported") throw new Error("compareWithLineage: an earlier request cannot be empty or unsupported");
    if (sharedDepth(change) > sharedDepth(best.change)) best = { change, base: i };
  }
  return best;
}
