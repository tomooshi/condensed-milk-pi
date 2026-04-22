#!/usr/bin/env node
/**
 * v1.9.0 regression (ADR-030): compound-command stdout must not be
 * collapsed by per-command prefix filters.
 *
 * Bug reproduced by user:
 *   `cd X && git init -b main && git add -A && git status --short | head -10
 *    && echo ... && git status --short | wc -l`
 * Combined stdout got routed to the git-status filter, which returned
 * "on unknown: clean" — hiding all real output.
 *
 * Two defenses covered:
 *   L1 — dispatch skips per-command filters when compound has >=2
 *         non-silent segments.
 *   L2 — git-status filter refuses to compress when detectFormat
 *         cannot find a confident marker.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "cm-compound-"));
// Copy filters dir so relative imports work.
spawnSync("cp", ["-r", "filters", tmp]);

const tsc = spawnSync("npx", ["-y", "-p", "typescript@5.9", "tsc",
  "--target", "es2022",
  "--module", "esnext",
  "--moduleResolution", "bundler",
  "--skipLibCheck",
  "--strict", "false",
  "--noImplicitAny", "false",
  "--outDir", join(tmp, "out"),
  "--rootDir", join(tmp, "filters"),
  ...["dispatch", "git-status", "git-diff", "git-log", "git-mutations",
      "ansi-strip", "json-schema", "pytest", "git-status",
      "file-ops", "tree", "env", "python-traceback", "log-dedup",
      "tsc", "linter", "grep-grouping", "build", "test-runners", "install"
  ].map((m) => join(tmp, "filters", `${m}.ts`)),
], { encoding: "utf-8" });
if (tsc.status !== 0) {
  console.error(tsc.stdout); console.error(tsc.stderr); process.exit(1);
}

// Import dispatch.js (filters self-register via top-level side effects when
// imported by index.ts; here we import them explicitly).
for (const m of ["git-status", "git-diff", "git-log", "git-mutations",
                 "pytest", "file-ops", "tree", "env", "python-traceback",
                 "log-dedup", "tsc", "linter", "grep-grouping",
                 "build", "test-runners", "install"]) {
  await import(join(tmp, "out", `${m}.js`));
}
const { dispatch } = await import(join(tmp, "out", "dispatch.js"));

let fails = 0;
function check(name, pass, detail = "") {
  if (pass) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); fails++; }
}

// Case 1: user's exact repro — compound command with git status at the end,
// preceded by a bd update + echo producing combined stdout.
const compoundCmd =
  "cd /home/tomooshi/Repositories/mojo-template-pi-dev && " +
  "bd update mojo-template-pi-dev-kco2 --claim 2>&1 | tail -1; " +
  "echo \"===SEP===\"; " +
  "cd /home/tomooshi/Repositories/coding-obsidian && " +
  "git status 2>&1 | head -10";

const combinedStdout = [
  "✓ Updated issue: mojo-template-pi-dev-kco2",
  "===SEP===",
  "On branch main",
  "",
  "No commits yet",
  "",
  "Changes to be committed:",
  "  (use \"git rm --cached <file>...\" to unstage)",
  "\tnew file:   CLAUDE.md",
  "\tnew file:   CURRICULUM.md",
].join("\n");

const r1 = dispatch(compoundCmd, combinedStdout);
check(
  "Case 1: compound (bd + git status) — no 'on unknown: clean' collapse",
  r1 === null || !r1.output.includes("on unknown: clean"),
  `result=${JSON.stringify(r1)}`,
);

// Case 2: lone `git status --short` with many files still compresses
// (confident-detection fallback via multiple v1-format lines).
const manyFiles = Array.from({length: 30}, (_, i) => `A  src/module_${i}/file_with_long_name.ts`);
manyFiles.push(" M daily/2026-04-21.md");
manyFiles.push(" M templates/daily.md");
const plainStatusShort = manyFiles.join("\n");
const r2 = dispatch("git status --short", plainStatusShort);
check(
  "Case 2: lone `git status --short` with many files compresses via v1 format",
  r2 !== null && /\d+ staged/.test(r2.output),
  `in=${plainStatusShort.length} result=${JSON.stringify(r2)}`,
);

// Case 3: legitimate `cd repo && git status` (one non-silent segment) still
// compresses. Uses plain format with branch header.
const plainStatus = [
  "On branch main",
  "Changes to be committed:",
  "\tmodified:   src/foo.ts",
  "\tnew file:   src/bar.ts",
  "",
  "Untracked files:",
  "\tsrc/baz.ts",
].join("\n");
const r3 = dispatch("cd /repo && git status", plainStatus);
check(
  "Case 3: `cd repo && git status` (1 non-silent) still compresses",
  r3 !== null && /on main/.test(r3.output),
  `result=${JSON.stringify(r3)}`,
);

// Case 4: non-git-status input with a single coincidental v1-looking line
// must NOT be falsely identified.
const coincidental = [
  "Initialized empty Git repository in /tmp/foo/.git/",
  "A  path",           // one v1-looking line buried in non-git output
  "Other output line",
  "More random output to pad length over MIN_MASK_LENGTH (80 bytes).",
  "Still more filler bytes to ensure dispatch doesn't early-return small.",
].join("\n");
const r4 = dispatch("git status", coincidental);
check(
  "Case 4: coincidental v1-looking line alone doesn't trigger compression",
  r4 === null,
  `result=${JSON.stringify(r4)}`,
);

if (fails > 0) {
  console.error(`\nFAIL — ${fails} case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS — compound-command dispatch guard + git-status confident detection.");
