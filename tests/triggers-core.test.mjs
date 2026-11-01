/**
 * CM-ADR-002 §4-5 spec: pure trigger decisions (filters/triggers.ts).
 * Clock values are injected; nothing here reads Date.now().
 */
import { loadTs, makeRunner } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-002 trigger decisions");
const T = await loadTs("filters/triggers.ts");
const iso = (ms) => new Date(ms).toISOString();

// cache lifetime
check("config seconds win", T.cacheTtlMs({ configSeconds: 120, promptCache: { short: 300, long: 3600 }, retention: "long" }), 120_000);
check("long tier from the model", T.cacheTtlMs({ promptCache: { short: 300, long: 3600 }, retention: "long" }), 3_600_000);
check("short tier from the model", T.cacheTtlMs({ promptCache: { short: 300, long: 3600 }, retention: "short" }), 300_000);
check("unknown lifetime", T.cacheTtlMs({ retention: "short" }), undefined);
check("missing tier is unknown", T.cacheTtlMs({ promptCache: { short: 300 }, retention: "long" }), undefined);

// last cache touch
const assistant = (ts) => ({ role: "assistant", content: [], timestamp: ts });
const user = (ts) => ({ role: "user", content: [], timestamp: ts });
const warm = (ms) => ({ type: "usage", kind: "cache_warm", id: `w${ms}`, parentId: null, timestamp: iso(ms) });
check("newest assistant message", T.lastCacheTouchMs({ messages: [assistant(1_000), assistant(2_000), user(9_000)], tailEntries: [] }), 2_000);
check("a later cache_warm entry wins", T.lastCacheTouchMs({ messages: [assistant(1_000)], tailEntries: [warm(3_000)] }), 3_000);
check("an older cache_warm entry loses", T.lastCacheTouchMs({ messages: [assistant(5_000)], tailEntries: [warm(3_000)] }), 5_000);
check("other usage kinds do not count", T.lastCacheTouchMs({ messages: [assistant(1_000)], tailEntries: [{ ...warm(3_000), kind: "compaction" }] }), 1_000);
check("nothing known", T.lastCacheTouchMs({ messages: [user(1)], tailEntries: [] }), undefined);

// idle zone
const idle = { nowMs: 10_000, lastTouchMs: 1_000, ttlMs: 5_000, zoneEntered: -1, zoneCount: 3 };
check("idle past the lifetime enters the next zone", T.decideIdleZone(idle), 0);
check("from zone 1 to zone 2", T.decideIdleZone({ ...idle, zoneEntered: 1 }), 2);
check("at the last zone nothing happens", T.decideIdleZone({ ...idle, zoneEntered: 2 }), null);
check("exactly at the lifetime is not idle", T.decideIdleZone({ ...idle, lastTouchMs: 5_000 }), null);
check("unknown lifetime", T.decideIdleZone({ ...idle, ttlMs: undefined }), null);
check("unknown last touch", T.decideIdleZone({ ...idle, lastTouchMs: undefined }), null);

// minimum gain
check("gain at the floor applies", T.passesMinBytes({ candidateSaved: 40_000, currentSaved: 7_232, minBytes: T.BOUNDARY_MIN_BYTES }), true);
check("gain under the floor is skipped", T.passesMinBytes({ candidateSaved: 40_000, currentSaved: 7_233, minBytes: T.BOUNDARY_MIN_BYTES }), false);
check("BOUNDARY_MIN_BYTES", T.BOUNDARY_MIN_BYTES, 32_768);

done();
