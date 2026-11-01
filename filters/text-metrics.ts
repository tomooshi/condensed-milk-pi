/**
 * Deterministic text measures shared by the masker (context-compress.ts) and
 * the recall core (recall.ts). Kept in one leaf module so neither of those
 * imports the other for a helper.
 *
 * Every function here is pure: the same input gives the same bytes on every
 * turn, which is what keeps placeholders cache-stable (ADR-018, CM-ADR-001).
 */
import { createHash } from "node:crypto";

/** derived: 40 bits; at 12,232 results (largest measured session) the
 *  birthday estimate n²/2⁴¹ is about 7e-5 (CM-ADR-001). */
export const SHORT_ID_HEX_CHARS = 10;

/** Stable short id of a tool result: the first SHORT_ID_HEX_CHARS hex
 *  characters of sha1(toolCallId + "\0" + timestamp). The timestamp is part
 *  of the key because some providers reuse call ids in every turn (Kimi via
 *  OpenRouter sends "bash:0"; 17 repeats on one branch). Measured on 28,279
 *  results in 30 days: every result has a numeric timestamp and no
 *  (toolCallId, timestamp) pair repeats (CM-ADR-001 amendment). */
export function shortId(toolCallId: string, timestamp?: unknown): string {
  if (typeof toolCallId !== "string") throw new TypeError("shortId: toolCallId must be a string");
  const key = `${toolCallId}\u0000${timestamp ?? ""}`;
  const id = createHash("sha1").update(key).digest("hex").slice(0, SHORT_ID_HEX_CHARS);
  if (id.length !== SHORT_ID_HEX_CHARS) throw new Error("shortId: sha1 hex is shorter than SHORT_ID_HEX_CHARS");
  return id;
}

/** Count newlines + 1 (matches `wc -l` + 1 for text without a trailing newline). Empty text has 0 lines. */
export function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** Deterministic size string; must not depend on locale or time. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
