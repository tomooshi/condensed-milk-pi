/**
 * Pure decisions for the two v1.11.0 mask triggers (CM-ADR-002 §4-5): the
 * task boundary and the idle-aligned advance. The clock, the environment and
 * the model are read by index.ts and passed in; nothing here reads them.
 */

/** arbitrary: a boundary or idle advance that frees less than this is not
 *  worth a cache rewrite; revisit with the boundary telemetry. */
export const BOUNDARY_MIN_BYTES = 32_768;
/** arbitrary: entries walked back from the leaf to find the last cache touch. */
export const IDLE_SCAN_ENTRIES_MAX = 512;

/** Lifetime of the prompt cache in ms: the configured seconds, else the
 *  model's promptCache tier for the retention in use. Undefined when unknown,
 *  which turns the idle trigger off. Same rule as pi's getPromptCacheTtlMs. */
export function cacheTtlMs(input: {
  configSeconds?: number;
  promptCache?: { short?: number; long?: number };
  retention: "short" | "long";
}): number | undefined {
  if (typeof input.configSeconds === "number" && Number.isFinite(input.configSeconds) && input.configSeconds > 0) {
    return input.configSeconds * 1000;
  }
  const seconds = input.promptCache?.[input.retention];
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

const positive = (ms: unknown): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms > 0;

/** Last time the provider cache was touched: the newest assistant message,
 *  or a later `cache_warm` usage entry (pi's cache warmer). Timestamps of 0
 *  or less mean unknown. */
export function lastCacheTouchMs(input: { messages: any[]; tailEntries: any[] }): number | undefined {
  const fromMessages = input.messages
    .map((m) => m?.message ?? m)
    .filter((msg) => msg?.role === "assistant" && positive(msg.timestamp))
    .map((msg) => msg.timestamp as number);
  const fromWarm = input.tailEntries
    .filter((e) => e?.type === "usage" && e?.kind === "cache_warm")
    .map((e) => Date.parse(e.timestamp))
    .filter(positive);
  // reduce, not Math.max(...all): a long branch has tens of thousands of messages.
  const all = [...fromMessages, ...fromWarm];
  return all.length > 0 ? all.reduce((a, b) => (b > a ? b : a)) : undefined;
}

/** Zone to enter because the cache has expired, or null. Idle means strictly
 *  longer than the lifetime; at the last zone nothing happens. */
export function decideIdleZone(input: {
  nowMs: number;
  lastTouchMs: number | undefined;
  ttlMs: number | undefined;
  zoneEntered: number;
  zoneCount: number;
}): number | null {
  if (input.ttlMs === undefined || input.lastTouchMs === undefined) return null;
  if (input.nowMs - input.lastTouchMs <= input.ttlMs) return null;
  const next = input.zoneEntered + 1;
  return next < input.zoneCount ? next : null;
}

/** True when moving the cutoff frees at least minBytes more than the current
 *  cutoff does. */
export function passesMinBytes(input: { candidateSaved: number; currentSaved: number; minBytes: number }): boolean {
  if (!(input.minBytes >= 0)) throw new RangeError("passesMinBytes: minBytes must be zero or more");
  return input.candidateSaved - input.currentSaved >= input.minBytes;
}
