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

export interface PrefixChange {
  kind: PrefixKind;
  /** Tool index for "tools", message index for "message"/"removed", else null. */
  index: number | null;
  /** Human-readable cause, for example "added mcp__x" or "condensed-milk mask". */
  detail: string;
  /** Thinking blocks after the change: the blocks a Claude 5.x model loses. */
  thinkingAfter: number;
}

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

/** First tool difference, or null. */
function compareTools(prev: unknown[], cur: unknown[]): { index: number; detail: string } | null {
  const shared = Math.min(prev.length, cur.length);
  for (let i = 0; i < shared; i++) {
    if (equalIgnoringCacheControl(prev[i], cur[i])) continue;
    const prevName = toolName(prev[i]);
    const curName = toolName(cur[i]);
    if (prevName === curName) return { index: i, detail: `changed ${curName}` };
    const removed = !cur.some((t) => toolName(t) === prevName);
    return { index: i, detail: removed ? `removed ${prevName}` : `added ${curName}` };
  }
  if (cur.length > prev.length) return { index: shared, detail: `added ${toolName(cur[shared])}` };
  if (prev.length > cur.length) return { index: shared, detail: `removed ${toolName(prev[shared])}` };
  return null;
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  return JSON.stringify(content ?? "");
}

/** Classify a changed message at `index`. */
function messageChange(prev: unknown[], cur: unknown[], index: number): PrefixChange {
  const role = String((prev[index] as { role?: unknown })?.role ?? "message");
  if (index + 1 < prev.length && equalIgnoringCacheControl(prev[index + 1], cur[index])) {
    return { kind: "removed", index, detail: `${role} removed`, thinkingAfter: thinkingBlockCount(cur, index - 1) };
  }
  const masked = textOf(cur[index]).includes(MASK_MARK) && !textOf(prev[index]).includes(MASK_MARK);
  return { kind: "message", index, detail: masked ? "condensed-milk mask" : `${role} edited`, thinkingAfter: thinkingBlockCount(cur, index) };
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
  if (tools) return { kind: "tools", index: tools.index, detail: tools.detail, thinkingAfter: thinkingBlockCount(curMessages, -1) };
  if (!equalIgnoringCacheControl(p.system, c.system)) {
    return { kind: "system", index: null, detail: "system", thinkingAfter: thinkingBlockCount(curMessages, -1) };
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
