/**
 * Feature flags of 1.13.0 and the live A/B switch (CM-ADR-006). Pure: the
 * parsed config and the session id in, the session's arm and features out.
 *
 * Only features that passed their pre-registered offline and probe gates
 * (docs/research/2026-11-02-next-features.md §12) exist here. The live gates
 * (turns per prompt, edit "could not find" errors, recall then re-run, tool
 * errors) are read from schema-4 telemetry after at least 14 days.
 */
import { createHash } from "node:crypto";

/** The 1.13.0 features. Each one changes bytes only at mask events. */
export interface Features {
  /** C: mask long edit/write arguments and bash commands of 2 KB+ before the cutoff. */
  maskArgs: boolean;
  /** B1: bash invalidation waits for the next mask event. */
  batchInvalidation: boolean;
}

/** Defaults: the features that passed their gates (docs §12). */
export const DEFAULT_FEATURES: Features = { maskArgs: true, batchInvalidation: true };
/** The control arm: 1.12.0 behavior. */
const OFF_FEATURES: Features = { maskArgs: false, batchInvalidation: false };
/** Salt of the arm hash; a new experiment gets a new salt. */
const AB_SALT = "cm-ab-1";

export type Arm = "default" | "control" | "treatment";

/** Arm of one session: sha256(salt + ":" + session id), first 32 bits, even =
 *  control. Deterministic, so a resumed session keeps its arm and its bytes. */
export function assignArm(sessionId: string): "control" | "treatment" {
  if (typeof sessionId !== "string") throw new TypeError("assignArm: sessionId must be a string");
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
  const features = arm === "control" ? { ...OFF_FEATURES } : configured;
  if (Object.keys(features).length !== keys.length) throw new Error("resolveFeatures: every feature needs a value");
  return { arm, features };
}
