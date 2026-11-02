/**
 * Profiles — backend-specific tuning bundles.
 *
 * v1.10.0 (Phase 1 of vLLM/Qwen support).
 *
 * Each profile bundles every knob that should change between Anthropic
 * (the original tuning target) and vLLM/Qwen (different cache model,
 * different long-context behavior, different placeholder norms). A user
 * picks one profile per session via `profile: "<name>"` in
 * `~/.config/condensed-milk.json`. No auto-detection — explicit only.
 *
 * Extending: drop a new entry in BUILT_IN_PROFILES, or add a custom
 * profile via the user config's `profiles` map.
 */

/** Policy for masking historical `<think>` / reasoning blocks.
 *  - "off"            never mask thinking (Anthropic default — extended
 *                     thinking is already cache-controlled)
 *  - "with-coverage"  mask thinking the same way tool results are masked
 *                     (idx < cutoffIdx; respects the static-cutoff zone)
 *  - "above-cutoff"   mask any thinking block at idx < cutoffIdx without
 *                     the MIN_MASK_LENGTH gate; aggressive mode for
 *                     long-context models with `preserve_thinking` on
 *                     where old reasoning is highest-value to drop */
export type ThinkingMaskPolicy = "off" | "with-coverage" | "above-cutoff";

/** Placeholder template strings. `{id}`, `{cmd}`, `{path}`, `{n}`, `{size}`
 *  are substituted at mask time. Templates MUST be deterministic — no
 *  timestamps, no random values — or cache prefix stability is broken.
 *  `{id}` is the short id of the tool call (sha1, fixed length), so it is
 *  deterministic too.
 *
 *  v1.11.0 (CM-ADR-001): every built-in template carries `#{id}` so that
 *  `cm_recall` can return the original. This changed the bytes once, a
 *  deliberate cache bust recorded in the ADR. A custom template without
 *  `{id}` still works; resolveProfile warns that its results cannot be
 *  recalled by id. */
export interface PlaceholderTemplates {
  /** Substituted: {id}, {cmd} = first 80 chars of the bash command, {n}, {size}. */
  bash: string;
  /** Substituted: {id}, {path}, {n} (line count), {size} (formatted size). */
  read: string;
  /** Substituted: {id}, {cmd} = the recall label (`id=… grep="…"`), {n}, {size}. */
  recall: string;
  /** v1.13.0 (CM-ADR-005): one masked string argument of an edit, write or
   *  bash call. Substituted: {id} = the arguments id, {cmd} = `<tool> <key
   *  path>` (for example `edit edits[0].oldText`), {n}, {size}. */
  arg: string;
}

/** CM-ADR-001 default templates, shared by both built-in profiles. */
export const DEFAULT_PLACEHOLDERS: PlaceholderTemplates = {
  bash: "[cm-masked bash #{id}] {cmd} ({n} lines, {size})",
  read: "[cm-masked read #{id}] {path} ({n} lines, {size})",
  recall: "[cm-masked recall #{id}] {cmd} ({n} lines, {size})",
  arg: "[cm-masked arg #{id}] {cmd} ({n} lines, {size})",
};

/** Profile shape — every backend-specific knob in one place. */
export interface Profile {
  /** Human-readable label. Shown in /compress-stats. */
  label: string;
  /** Pressure thresholds (monotonically increasing, 0..1). Cutoff
   *  advances when context usage crosses one of these. */
  thresholds: readonly number[];
  /** Coverage at each threshold (length === thresholds.length). */
  coverage: readonly number[];
  /** Effective context window cap. When set, used as the denominator
   *  in pressure math instead of the model's advertised context window.
   *  For Qwen3.6-27B at vLLM's 262144 we recommend 131072 — quality
   *  degrades past ~128K with YaRN scaling, so we trigger compression
   *  earlier than the advertised window would suggest. null = use the
   *  model's advertised context window unchanged. */
  effectiveContextCap: number | null;
  placeholderFormat: PlaceholderTemplates;
  maskOldThinking: ThinkingMaskPolicy;
}

/** Default profile — Anthropic-tuned. Thresholds and coverage as in
 *  v1.9.0; placeholders carry ids since v1.11.0 (CM-ADR-001). */
const DEFAULT_PROFILE: Profile = {
  label: "default (Anthropic-tuned)",
  thresholds: [0.30, 0.45, 0.60],
  coverage: [0.60, 0.80, 0.95],
  effectiveContextCap: null,
  placeholderFormat: DEFAULT_PLACEHOLDERS,
  maskOldThinking: "off",
};

/** Qwen on vLLM profile — built from Phase 1 research synthesis.
 *
 *  Thresholds shifted earlier ([0.20, 0.35, 0.55]) because vLLM has no
 *  rescue tier (no Anthropic-style cache_control breakpoints) and Qwen
 *  long-context degrades past ~128K. Coverage slightly relaxed
 *  ([0.50, 0.75, 0.92]) because a 27B dense model is more sensitive to
 *  elided context than the 480B MoE the JetBrains paper measured.
 *
 *  effectiveContextCap = 131072: cap pressure math at half the
 *  advertised window. Lets a 262144-served model still compress
 *  aggressively enough to keep the working set inside the proven
 *  long-context regime.
 *
 *  Placeholder format is the same as the default profile, so users
 *  switching profiles don't get a prefix-format change as a side effect.
 *  The XML self-closing form is documented as a custom-profile recipe
 *  (see README) for users who want to A/B it.
 *
 *  maskOldThinking = "with-coverage": Qwen3.6 ships with
 *  `preserve_thinking` on, so historical `<think>` blocks accumulate in
 *  context. Masking them via the same coverage gate as tool results is
 *  the conservative middle ground — JetBrains-aligned but not as
 *  aggressive as `above-cutoff`. */
const QWEN_VLLM_PROFILE: Profile = {
  label: "qwen-vllm (Qwen3.x on vLLM)",
  thresholds: [0.20, 0.35, 0.55],
  coverage: [0.50, 0.75, 0.92],
  effectiveContextCap: 131072,
  placeholderFormat: DEFAULT_PLACEHOLDERS,
  maskOldThinking: "with-coverage",
};

export const BUILT_IN_PROFILES: Readonly<Record<string, Profile>> = {
  default: DEFAULT_PROFILE,
  "qwen-vllm": QWEN_VLLM_PROFILE,
};

/** Partial override shape that users can supply per-profile in their
 *  config. Every field is optional — missing fields fall back to the
 *  built-in profile (or the default profile if the name isn't built in). */
export interface ProfileOverride {
  label?: string;
  thresholds?: readonly number[];
  coverage?: readonly number[];
  effectiveContextCap?: number | null;
  placeholderFormat?: Partial<PlaceholderTemplates>;
  maskOldThinking?: ThinkingMaskPolicy;
}

/** Resolve the active profile from:
 *   1. built-in profile by name (or built-in "default" if name unknown)
 *   2. user override under `profiles[name]`
 *   3. legacy top-level `thresholds`/`coverage` (back-compat for users
 *      with v1.9.x configs that predate profiles)
 *
 *  Validation: thresholds and coverage must remain monotonic and same
 *  length. Invalid overrides are silently dropped (logged via
 *  warnings[]) — never throws, so a malformed profile can't crash a
 *  session start.
 *
 *  Returns the resolved Profile plus warnings to surface in /compress-stats. */
export function resolveProfile(
  activeName: string,
  userProfiles: Record<string, ProfileOverride> | undefined,
  legacyTopLevel: { thresholds?: unknown; coverage?: unknown } = {},
): { profile: Profile; activeName: string; warnings: string[] } {
  const warnings: string[] = [];

  // 1. Pick base profile by name.
  let base: Profile;
  let resolvedName = activeName;
  if (activeName in BUILT_IN_PROFILES) {
    base = BUILT_IN_PROFILES[activeName];
  } else if (userProfiles && activeName in userProfiles) {
    base = BUILT_IN_PROFILES.default;  // Custom name with no built-in → start from default.
  } else {
    warnings.push(
      `unknown profile "${activeName}", falling back to "default". ` +
      `Built-in: ${Object.keys(BUILT_IN_PROFILES).join(", ")}.`,
    );
    base = BUILT_IN_PROFILES.default;
    resolvedName = "default";
  }

  // 2. Apply user override under profiles[name], if present.
  const override = userProfiles?.[resolvedName];
  let merged = applyOverride(base, override, warnings, `profiles.${resolvedName}`);

  // 3. Apply legacy top-level thresholds/coverage as a final override.
  //    Only when the active profile is "default" — applying legacy values
  //    to qwen-vllm would silently undo the profile's whole point.
  if (resolvedName === "default") {
    merged = applyOverride(
      merged,
      {
        thresholds: legacyTopLevel.thresholds as readonly number[] | undefined,
        coverage: legacyTopLevel.coverage as readonly number[] | undefined,
      },
      warnings,
      "top-level (legacy)",
    );
  }

  return { profile: merged, activeName: resolvedName, warnings };
}

function applyOverride(
  base: Profile,
  override: ProfileOverride | undefined,
  warnings: string[],
  ctx: string,
): Profile {
  if (!override) return base;
  const out: Profile = {
    label: override.label ?? base.label,
    thresholds: base.thresholds,
    coverage: base.coverage,
    effectiveContextCap: base.effectiveContextCap,
    placeholderFormat: base.placeholderFormat,
    maskOldThinking: base.maskOldThinking,
  };

  if (override.thresholds !== undefined || override.coverage !== undefined) {
    const t = override.thresholds ?? base.thresholds;
    const c = override.coverage ?? base.coverage;
    if (validateMonotonic(t, ctx + ".thresholds", warnings) &&
        validateMonotonic(c, ctx + ".coverage", warnings) &&
        t.length === c.length) {
      out.thresholds = t;
      out.coverage = c;
    } else if (t.length !== c.length) {
      warnings.push(`${ctx}: thresholds.length (${t.length}) !== coverage.length (${c.length}) — keeping base profile values`);
    }
  }

  if (override.effectiveContextCap !== undefined) {
    if (override.effectiveContextCap === null ||
        (typeof override.effectiveContextCap === "number" &&
         override.effectiveContextCap > 0 &&
         Number.isFinite(override.effectiveContextCap))) {
      out.effectiveContextCap = override.effectiveContextCap;
    } else {
      warnings.push(`${ctx}.effectiveContextCap must be null or positive number — keeping base value`);
    }
  }

  if (override.placeholderFormat) {
    out.placeholderFormat = {
      bash: override.placeholderFormat.bash ?? base.placeholderFormat.bash,
      read: override.placeholderFormat.read ?? base.placeholderFormat.read,
      recall: override.placeholderFormat.recall ?? base.placeholderFormat.recall,
      arg: override.placeholderFormat.arg ?? base.placeholderFormat.arg ?? DEFAULT_PLACEHOLDERS.arg,
    };
    // CM-ADR-001 §5: a template without {id} still works, but cm_recall
    // cannot address what it masks, so say so where the user looks.
    const kinds = Object.keys(out.placeholderFormat) as (keyof PlaceholderTemplates)[];
    const missing = kinds.filter((kind) => !out.placeholderFormat[kind].includes("{id}"));
    warnings.push(...missing.map((kind) =>
      `${ctx}.placeholderFormat.${kind} has no {id}; cm_recall cannot find results masked with it by id (use match)`));
  }

  if (override.maskOldThinking !== undefined) {
    if (override.maskOldThinking === "off" ||
        override.maskOldThinking === "with-coverage" ||
        override.maskOldThinking === "above-cutoff") {
      out.maskOldThinking = override.maskOldThinking;
    } else {
      warnings.push(`${ctx}.maskOldThinking must be "off" | "with-coverage" | "above-cutoff" — keeping base value`);
    }
  }

  return out;
}

function validateMonotonic(arr: readonly number[] | undefined, ctx: string, warnings: string[]): boolean {
  if (!Array.isArray(arr) || arr.length === 0) {
    warnings.push(`${ctx} must be non-empty number[]`);
    return false;
  }
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== "number" || !Number.isFinite(arr[i]) || arr[i] < 0 || arr[i] > 1) {
      warnings.push(`${ctx}[${i}] = ${arr[i]} must be number in [0, 1]`);
      return false;
    }
    if (i > 0 && arr[i] <= arr[i - 1]) {
      warnings.push(`${ctx} must be strictly increasing (got ${arr[i - 1]} >= ${arr[i]} at index ${i})`);
      return false;
    }
  }
  return true;
}

/** Render a placeholder template with substitutions. Unknown placeholders
 *  are left as-is rather than throwing, so a user-supplied template that
 *  uses a token we don't substitute (e.g. `{stderr}`) just shows literally. */
export function renderPlaceholder(
  template: string,
  vars: { id?: string; cmd?: string; path?: string; n?: number; size?: string },
): string {
  // Function replacers: a `$&` or `$1` inside a command or path must stay literal.
  return template
    .replace(/\{id\}/g, () => vars.id ?? "")
    .replace(/\{cmd\}/g, () => vars.cmd ?? "")
    .replace(/\{path\}/g, () => vars.path ?? "")
    .replace(/\{n\}/g, () => (vars.n !== undefined ? String(vars.n) : ""))
    .replace(/\{size\}/g, () => vars.size ?? "");
}
