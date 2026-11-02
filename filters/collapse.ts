/**
 * Collapse superseded and duplicate results (CM-ADR-005, option D of
 * docs/research/2026-11-02-next-features.md).
 *
 * At a mask event, an older read is masked when a newer successful read of the
 * same path and range exists, and an older bash result is masked when a newer
 * bash or read result has the same text. Only messages before `horizon` (the
 * message count at the last mask event) count, so the plan does not change
 * between mask events. The newest read of a path and range is never masked:
 * agents edit from it (field bugs S2-S4 in the research).
 *
 * Pure: messages and a lookup in, a plan out.
 */

/** What collapse needs from a tool call: the read's path and range. */
export interface CallArgs {
  path?: string;
  offset?: unknown;
  limit?: unknown;
}

/** Why a result is masked, and which newer result holds the content. */
export interface CollapseEntry {
  reason: "newer read" | "same text";
  newerToolCallId: string;
  newerTimestamp: unknown;
}

interface Holder {
  toolCallId: string;
  timestamp: unknown;
  text: string;
}

/** Text of a result's text blocks, joined like the masker joins them. */
function textOf(msg: any): string {
  return (msg.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("\n");
}

/** Index -> collapse decision for results before `horizon`. Results that are
 *  errors, shorter than `minChars`, or placeholders already never take part.
 *  The scan runs newest first, so each key keeps its newest holder. */
export function collapsePlan(
  messages: any[],
  horizon: number,
  callArgs: (toolCallId: string) => CallArgs | undefined,
  options: { minChars: number; isPlaceholder: (msg: any) => boolean },
): Map<number, CollapseEntry> {
  const plan = new Map<number, CollapseEntry>();
  const newestRead = new Map<string, Holder>();
  const newestText = new Map<string, Holder>();
  const end = Math.min(horizon, messages.length);
  for (let i = end - 1; i >= 0; i--) {
    const msg = messages[i]?.message ?? messages[i];
    if (msg?.role !== "toolResult" || msg.isError === true || options.isPlaceholder(msg)) continue;
    if (msg.toolName !== "read" && msg.toolName !== "bash") continue;
    const text = textOf(msg);
    if (text.length < options.minChars) continue;
    const self: Holder = { toolCallId: String(msg.toolCallId ?? ""), timestamp: msg.timestamp, text };
    const decided = msg.toolName === "read" ? decideRead(self, callArgs, newestRead) : decideBash(self, newestText);
    if (decided) {
      plan.set(i, decided);
      continue;
    }
    // Only a kept result may hold text for older duplicates; a collapsed one
    // would point them at a placeholder.
    if (!newestText.has(text)) newestText.set(text, self);
  }
  if (plan.size > end) throw new Error("collapsePlan: more decisions than messages before the horizon");
  return plan;
}

const holderEntry = (reason: CollapseEntry["reason"], h: Holder): CollapseEntry =>
  ({ reason, newerToolCallId: h.toolCallId, newerTimestamp: h.timestamp });

/** A read is collapsed by the newest read of the same path and range. */
function decideRead(self: Holder, callArgs: (id: string) => CallArgs | undefined, newestRead: Map<string, Holder>): CollapseEntry | null {
  const args = callArgs(self.toolCallId);
  if (!args?.path) return null;
  const key = `${args.path}|${String(args.offset)}|${String(args.limit)}`;
  const newer = newestRead.get(key);
  if (!newer) {
    newestRead.set(key, self);
    return null;
  }
  return holderEntry(newer.text === self.text ? "same text" : "newer read", newer);
}

/** A bash result is collapsed by the newest bash or read result with its text. */
function decideBash(self: Holder, newestText: Map<string, Holder>): CollapseEntry | null {
  const newer = newestText.get(self.text);
  return newer ? holderEntry("same text", newer) : null;
}
