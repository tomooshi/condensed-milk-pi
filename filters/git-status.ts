/**
 * git status output filter.
 *
 * Parses porcelain v2, v1 (--short), and plain format.
 * Output: "on <branch>: N staged, N modified, N untracked [file1, file2, ...]"
 * Passthrough if input < 80 bytes (already compact).
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

interface Counts {
  branch: string;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
}

function filterGitStatus(input: string): FilterResult | null {
  if (input.length === 0) return { output: "git status: no output", category: "fast" };
  if (input.length < 80) return null; // Already compact

  // v1.9.0 (ADR-029 follow-up): confident-detection guard. When dispatch
  // routes us the combined stdout of a compound command (e.g.
  // `bd update … && git status`), the non-git-status bytes at the start
  // used to trip detectFormat into a default 'v2' interpretation, then
  // parsing counted nothing and we emitted 'on unknown: clean' — hiding
  // the user's real output. Require at least one git-status marker
  // anywhere in the input before we're willing to compress.
  const format = detectFormat(input);
  if (format === null) return null;

  const counts: Counts = { branch: "unknown", staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  const files: string[] = [];

  const lines = input.split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;

    if (format === "v2") {
      if (line.startsWith("# branch.head ")) {
        counts.branch = line.slice("# branch.head ".length);
      } else if (line[0] === "1" && line[1] === " " && line.length > 3) {
        countV2(line[2], line[3], counts);
        if (files.length < 15) files.push(lastField(line));
      } else if (line[0] === "2" && line[1] === " " && line.length > 3) {
        countV2(line[2], line[3], counts);
        if (files.length < 15) files.push(renameFile(line));
      } else if (line[0] === "?" && line.length > 2) {
        counts.untracked++;
        if (files.length < 15) files.push(line.slice(2));
      } else if (line[0] === "u" && line[1] === " ") {
        counts.conflicted++;
        if (files.length < 15) files.push(lastField(line));
      }
    } else if (format === "v1") {
      parseV1Line(line, counts, files);
    } else {
      parsePlainLine(line, counts);
    }
  }

  const total = counts.staged + counts.modified + counts.untracked + counts.conflicted;
  if (total === 0) return { output: `on ${counts.branch}: clean`, category: "fast" };

  const parts: string[] = [];
  if (counts.staged > 0) parts.push(`${counts.staged} staged`);
  if (counts.modified > 0) parts.push(`${counts.modified} modified`);
  if (counts.untracked > 0) parts.push(`${counts.untracked} untracked`);
  if (counts.conflicted > 0) parts.push(`${counts.conflicted} conflicted`);

  let result = `on ${counts.branch}: ${parts.join(", ")}`;
  if (files.length > 0) result += ` [${files.join(", ")}]`;

  return { output: result, category: "fast" };
}

type Format = "v2" | "v1" | "plain";

// v1 --short status lines look like two-char code + space + path, where
// each code char is one of the known git porcelain status codes. Used as
// a confidence marker when no format header is present.
const STATUS_CODES = new Set([" ", "M", "A", "D", "R", "C", "U", "?", "!", "T"]);
function looksLikeV1Line(line: string): boolean {
  if (line.length < 4) return false;
  if (line[2] !== " ") return false;
  return STATUS_CODES.has(line[0]) && STATUS_CODES.has(line[1]);
}

function detectFormat(input: string): Format | null {
  const lines = input.split("\n");
  let v1Hits = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith("# branch.")) return "v2";
    if (line.startsWith("## ")) return "v1";
    if (line.startsWith("On branch ")) return "plain";
    if (looksLikeV1Line(line)) v1Hits++;
  }
  // Confident v1 only if multiple status-format lines observed anywhere.
  // Single-hit could be a coincidental line in non-git output.
  return v1Hits >= 2 ? "v1" : null;
}

function countV2(c1: string, c2: string, counts: Counts): void {
  if (c1 !== ".") counts.staged++;
  if (c2 !== ".") counts.modified++;
}

function lastField(line: string): string {
  const tab = line.lastIndexOf("\t");
  if (tab >= 0) return line.slice(tab + 1);
  const space = line.lastIndexOf(" ");
  if (space >= 0) return line.slice(space + 1);
  return line;
}

function renameFile(line: string): string {
  const tab = line.lastIndexOf("\t");
  if (tab >= 0) {
    const segment = line.slice(tab + 1);
    const arrow = segment.indexOf(" -> ");
    return arrow >= 0 ? segment.slice(arrow + 4) : segment;
  }
  return lastField(line);
}

function parseV1Line(line: string, counts: Counts, files: string[]): void {
  if (line.startsWith("## ")) {
    const branchPart = line.slice(3);
    const dotDot = branchPart.indexOf("...");
    counts.branch = dotDot >= 0 ? branchPart.slice(0, dotDot) : branchPart;
    return;
  }
  if (line.length < 4) return;
  const x = line[0];
  const y = line[1];
  if (x === "?") { counts.untracked++; }
  else {
    if (x !== " " && x !== "?") counts.staged++;
    if (y !== " " && y !== "?") counts.modified++;
  }
  if (files.length < 15) files.push(line.slice(3).trim());
}

function parsePlainLine(line: string, counts: Counts): void {
  if (line.startsWith("On branch ")) {
    counts.branch = line.slice("On branch ".length);
  } else if (line.includes("modified:")) {
    counts.modified++;
  } else if (line.includes("new file:")) {
    counts.staged++;
  } else if (line.includes("deleted:")) {
    counts.staged++;
  } else if (line.includes("Untracked files:")) {
    // Next lines are untracked — simplified: just count
    counts.untracked++;
  }
}

// Register for both short and long forms
registerFilter("git status", filterGitStatus, "fast");
