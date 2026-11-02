/**
 * Mask state across pi restarts (CM-ADR-006) and the live A/B switch
 * (CM-ADR-007). Pure: session entries and parsed config in, values out.
 *
 * Restart: the extension resets its zones on `session_start`, so a resumed
 * session re-entered the highest zone with coverage applied to the current
 * length and re-masked from an earlier point (docs §9.1, 379 restarts in 30
 * days). The state after each mask event is written as a custom session entry
 * (never sent to the model) and read back on `session_start`. A state entry
 * written before a compaction or a branch summary is never used, because those
 * change the message list that the cutoff indexes.
 */
import { createHash } from "node:crypto";

/** customType of the state entry. */
export const STATE_ENTRY_TYPE = "condensed-milk-state";
/** inherited: RECALL_SCAN_ENTRIES_MAX (filters/recall.ts), the bound of every branch scan. */
export const STATE_SCAN_ENTRIES_MAX = 65_536;
/** Format version of the state entry's data. */
const STATE_VERSION = 1;

/** What a mask event decides: the frozen cutoff, the highest zone entered
 *  and the event horizon (message count at the event). */
export interface MaskState {
  cutoff: number;
  zone: number;
  horizon: number;
}

/** Data of a state entry. */
export function stateEntryData(state: MaskState): { v: number } & MaskState {
  if (!(state.cutoff >= 0 && state.horizon >= state.cutoff)) throw new RangeError("stateEntryData: need 0 <= cutoff <= horizon");
  return { v: STATE_VERSION, cutoff: state.cutoff, zone: state.zone, horizon: state.horizon };
}

const validState = (d: any): d is MaskState =>
  d?.v === STATE_VERSION && Number.isInteger(d.cutoff) && Number.isInteger(d.zone) && Number.isInteger(d.horizon) &&
  d.cutoff >= 0 && d.horizon >= d.cutoff && d.zone >= -1;

/** The newest valid state entry on the branch, or null when none exists or a
 *  compaction or branch summary comes after it. Scans newest first, at most
 *  STATE_SCAN_ENTRIES_MAX entries. */
export function restoreState(branch: any[]): MaskState | null {
  const end = Math.max(0, branch.length - STATE_SCAN_ENTRIES_MAX);
  for (let i = branch.length - 1; i >= end; i--) {
    const e = branch[i];
    if (e?.type === "compaction" || e?.type === "branch_summary") return null;
    if (e?.type === "custom" && e.customType === STATE_ENTRY_TYPE && validState(e.data)) {
      return { cutoff: e.data.cutoff, zone: e.data.zone, horizon: e.data.horizon };
    }
  }
  return null;
}

// ── features and the live A/B (CM-ADR-007) ──

/** The 1.13.0 features. Each one changes bytes only at mask events. */
export interface Features {
  maskArgs: boolean;
  collapseReads: boolean;
  batchInvalidation: boolean;
  persistCutoff: boolean;
}

/** Defaults: the features that passed their offline and probe gates (docs §12). */
export const DEFAULT_FEATURES: Features = { maskArgs: true, collapseReads: true, batchInvalidation: true, persistCutoff: true };
/** The control arm: 1.12.0 behavior. */
const OFF_FEATURES: Features = { maskArgs: false, collapseReads: false, batchInvalidation: false, persistCutoff: false };
/** Salt of the arm hash; a new experiment gets a new salt. */
const AB_SALT = "cm-ab-1";

export type Arm = "default" | "control" | "treatment";

/** Arm of one session: sha256(salt + ":" + session id), first 32 bits, even =
 *  control. Deterministic, so a resumed session keeps its arm. */
export function assignArm(sessionId: string): "control" | "treatment" {
  const bits = parseInt(createHash("sha256").update(`${AB_SALT}:${sessionId}`).digest("hex").slice(0, 8), 16);
  return bits % 2 === 0 ? "control" : "treatment";
}

/** Features of one session from the parsed config file: `features` overrides
 *  the defaults key by key; `experiment.ab` true assigns an arm, and the
 *  control arm turns every feature off. */
export function resolveFeatures(config: any, sessionId: string): { arm: Arm; features: Features } {
  const overrides = config?.features && typeof config.features === "object" ? config.features : {};
  const keys = Object.keys(DEFAULT_FEATURES) as (keyof Features)[];
  const configured = Object.fromEntries(keys.map((k) => [k, typeof overrides[k] === "boolean" ? overrides[k] : DEFAULT_FEATURES[k]])) as unknown as Features;
  if (config?.experiment?.ab !== true) return { arm: "default", features: configured };
  const arm = assignArm(sessionId);
  return { arm, features: arm === "control" ? { ...OFF_FEATURES } : configured };
}
