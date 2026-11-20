/**
 * Duplicate-call counters (CM-ADR-008 §9, telemetry schema 6).
 *
 * A bash or read call is a duplicate when the same tool ran with the same
 * arguments earlier in the session. The tracker counts calls and duplicates
 * before the first mask of the session and after it. A higher rate after the
 * mask is the sign of an agent that runs things again because their output
 * was masked. Only counts leave the tracker; it keeps a hash of each call.
 */
import { createHash } from "node:crypto";

/** arbitrary: call keys kept per session, 16 hex characters each (about
 *  2 MB). The longest session on record has 7,231 calls. Past the bound the
 *  oldest key is forgotten, so a very old call can be counted as new. */
export const KEYS_MAX = 20_000;

export interface DupCounts {
  calls_before_mask: number;
  dup_calls_before_mask: number;
  calls_after_mask: number;
  dup_calls_after_mask: number;
}

/** Hash of one bash or read call, or null for another tool or a call
 *  without a command or path. */
export function callKey(toolName: string, input: unknown): string | null {
  const args = (input ?? {}) as { command?: unknown; path?: unknown; offset?: unknown; limit?: unknown };
  let text: string;
  if (toolName === "bash" && typeof args.command === "string" && args.command.length > 0) {
    text = `bash\u0000${args.command}`;
  } else if (toolName === "read" && typeof args.path === "string" && args.path.length > 0) {
    text = `read\u0000${args.path}\u0000${args.offset ?? ""}\u0000${args.limit ?? ""}`;
  } else {
    return null;
  }
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

export function newDupTracker() {
  const seen = new Set<string>();
  let masked = false;
  let counts: DupCounts = { calls_before_mask: 0, dup_calls_before_mask: 0, calls_after_mask: 0, dup_calls_after_mask: 0 };
  return {
    /** Count one call; a null key (not a bash or read call) is ignored. */
    note(key: string | null): void {
      if (key === null) return;
      const duplicate = seen.has(key);
      if (masked) {
        counts.calls_after_mask++;
        if (duplicate) counts.dup_calls_after_mask++;
      } else {
        counts.calls_before_mask++;
        if (duplicate) counts.dup_calls_before_mask++;
      }
      if (duplicate) return;
      seen.add(key);
      if (seen.size > KEYS_MAX) seen.delete(seen.values().next().value as string);
    },
    /** The session has had its first mask. */
    markMasked(): void {
      masked = true;
    },
    counts(): DupCounts {
      return { ...counts };
    },
    reset(): void {
      seen.clear();
      masked = false;
      counts = { calls_before_mask: 0, dup_calls_before_mask: 0, calls_after_mask: 0, dup_calls_after_mask: 0 };
    },
  };
}
