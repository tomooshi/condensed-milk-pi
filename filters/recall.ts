/**
 * Recall core (CM-ADR-002 §1): pure functions that turn a session branch and a
 * `cm_recall` request into the text the agent gets back. No I/O here; the
 * tool (io/recall-tool.ts) reads the branch or the session file and calls in.
 *
 * Data flow, newest-first throughout:
 *   session entries ─lightEntry─► LightEntry[] ─buildRecords─► RecallRecord[]
 *   RecallRecord[] + request ─planRecall─► error | match listing | fetch(record)
 *   fetched message text ─renderRecall─► header + slice of the original bytes
 *
 * Law (property-tested): renderRecall on a record, with no window and no cap
 * hit, returns the original text byte for byte after the first blank line.
 */
import { countLines, formatSize, shortId, SHORT_ID_HEX_CHARS } from "./text-metrics.js";
import { argsId, argsText, maskableLeaves } from "./args-mask.js";

export { shortId, SHORT_ID_HEX_CHARS };

/** inherited: pi DEFAULT_MAX_BYTES (bash and read output cap). */
export const RECALL_OUTPUT_BYTES_MAX = 51_200;
/** arbitrary: one screen of output still fits a tiny window; revisit with the recall telemetry. */
export const RECALL_OUTPUT_BYTES_MIN = 4_096;
/** inherited: pi DEFAULT_MAX_LINES. */
export const RECALL_OUTPUT_LINES_MAX = 2_000;
/** measured: longest branch was 26,241 entries in 30 days of sessions; about 2.5x headroom. */
export const RECALL_SCAN_ENTRIES_MAX = 65_536;
/** arbitrary: revisit if `match` is often followed by another `match`. */
export const RECALL_MATCH_ROWS_MAX = 10;
/** inherited: pi bash truncation caps the text at 50 KB before condensed-milk sees it. */
export const RAW_KEEP_BYTES_MAX = 51_200;
/** measured: the 3 largest session files (456-522 MB) have at most 28,128 lines; about 9x headroom. */
export const SESSION_FILE_LINES_MAX = 262_144;
/** arbitrary: share of the effective window one recall may fill; revisit if agents often recall twice. */
const RECALL_WINDOW_SHARE = 0.05;
/** arbitrary: the usual 4 bytes per token estimate. */
const BYTES_PER_TOKEN = 4;
/** The header and match rows show at most this many characters of a label.
 *  inherited: the placeholder's 80-character command slice. */
const LABEL_CHARS_MAX = 80;
/** arbitrary: characters of a label kept per entry; long codemode or MCP
 *  arguments would otherwise hold megabytes per session scan. */
const LABEL_KEY_CHARS_MAX = 512;

/** What a request may carry; the tool's parameter schema has the same keys. */
export interface RecallRequest {
  id?: string;
  match?: string;
  grep?: string;
  offset?: number;
  limit?: number;
  raw?: boolean;
  session?: string;
}

/** The part of a session entry recall needs. Small, so a 500 MB session file
 *  can be scanned with light entries only (pass 1 of io/session-file.ts). */
export interface LightEntry {
  id: string;
  parentId: string | null;
  kind: "assistant" | "result" | "other";
  /** assistant: tool calls made, with their display labels. */
  calls?: { toolCallId: string; label: string }[];
  /** assistant (v1.13.0, CM-ADR-005): calls whose arguments a mask can
   *  replace, with the size of their argsText. Their id is
   *  argsId(toolCallId, timestamp of the assistant message). */
  argCalls?: { toolCallId: string; toolName: string; lineCount: number; size: number }[];
  /** result: identity and shape of the tool result. The id is
   *  shortId(toolCallId, timestamp), as in the placeholder. */
  toolCallId?: string;
  timestamp?: unknown;
  toolName?: string;
  isError?: boolean;
  lineCount?: number;
  size?: number;
  filtered?: boolean;
  rawWithheld?: string;
}

/** One recallable tool result on the branch. `size` is in characters, the
 *  unit the placeholders use. */
export interface RecallRecord {
  id: string;
  entryId: string;
  toolCallId: string;
  toolName: string;
  label: string;
  lineCount: number;
  size: number;
  turnsAgo: number;
  filtered: boolean;
  rawWithheld?: string;
  isError: boolean;
  /** v1.13.0: "args" = the arguments of a call (masked by C), else a result. */
  kind: "result" | "args";
}

export interface RecallScan {
  records: RecallRecord[];
  scanned: number;
  truncated: boolean;
}

export type RecallPlan =
  | { kind: "error"; text: string }
  | { kind: "match"; text: string }
  | { kind: "fetch"; record: RecallRecord };

export type RecallRendered = { kind: "ok"; text: string; bytes: number } | { kind: "error"; text: string };

/** Parse an id as the agent writes it: `#` optional, any case. Null when it
 *  is not exactly SHORT_ID_HEX_CHARS hex characters. */
export function parseRecallId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().replace(/^#/, "").toLowerCase();
  return new RegExp(`^[0-9a-f]{${SHORT_ID_HEX_CHARS}}$`).test(id) ? id : null;
}

/** Deterministic label of a cm_recall call, used in its placeholder and in
 *  match rows. Key order is fixed (id, match, grep, offset, limit, raw,
 *  session) so the same call always gives the same bytes. */
export function recallLabel(args: RecallRequest | Record<string, unknown>): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const quote = (v: unknown) => JSON.stringify(String(v));
  const parts = [
    a.id !== undefined ? `id=${parseRecallId(a.id) ?? quote(a.id)}` : "",
    a.match !== undefined ? `match=${quote(a.match)}` : "",
    a.grep !== undefined ? `grep=${quote(a.grep)}` : "",
    a.offset !== undefined ? `offset=${String(a.offset)}` : "",
    a.limit !== undefined ? `limit=${String(a.limit)}` : "",
    a.raw === true ? "raw" : "",
    a.session !== undefined ? `session=${quote(a.session)}` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/** Text of a tool-result message: its text blocks joined by newlines (the
 *  same join the masker measures). */
export function toolResultText(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

/** A label in the form records keep: whitespace runs become one space, cut
 *  to LABEL_KEY_CHARS_MAX. index.ts compares commands in this form. */
export function labelKey(label: string): string {
  return String(label).replace(/\s+/g, " ").trim().slice(0, LABEL_KEY_CHARS_MAX);
}

/** Display label of a tool call: the command, the path, the recall label,
 *  or the compact arguments for any other tool. */
function callLabel(name: string, args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (name === "cm_recall") return recallLabel(args);
  return JSON.stringify(args);
}

/** The calls of an assistant message: labels for every call, and the calls
 *  whose arguments a mask can replace (CM-ADR-005), with their argsText size. */
function assistantCalls(msg: any): Pick<LightEntry, "kind" | "calls" | "argCalls" | "timestamp"> {
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const toolCalls = blocks.filter((b: any) => b?.type === "toolCall" && typeof (b.id ?? b.toolCallId) === "string");
  const calls = toolCalls.map((b: any) => ({ toolCallId: b.id ?? b.toolCallId, label: labelKey(callLabel(String(b.name ?? ""), b.arguments ?? b.input ?? {})) }));
  // Only calls a mask can change get a record; argsText needs maskable leaves.
  const argCalls = toolCalls
    .filter((b: any) => maskableLeaves(String(b.name ?? ""), b.arguments ?? b.input).length > 0)
    .map((b: any) => {
      const text = argsText(b.arguments ?? b.input);
      return { toolCallId: b.id ?? b.toolCallId, toolName: String(b.name), lineCount: countLines(text), size: text.length };
    });
  if (argCalls.length > calls.length) throw new Error("assistantCalls: more argument records than calls");
  return { kind: "assistant", calls, argCalls, timestamp: msg.timestamp };
}

/** Reduce a session entry to what recall needs. Pure. */
export function lightEntry(entry: any): LightEntry {
  if (typeof entry?.id !== "string") throw new TypeError("lightEntry: entry has no string id");
  const base = { id: entry.id, parentId: typeof entry.parentId === "string" ? entry.parentId : null };
  const msg = entry.type === "message" ? entry.message : undefined;
  if (msg?.role === "assistant") return { ...base, ...assistantCalls(msg) };
  if (msg?.role === "toolResult" && typeof msg.toolCallId === "string") {
    const text = toolResultText(msg);
    const keep = msg.details?.condensedMilk;
    return {
      ...base,
      kind: "result",
      toolCallId: msg.toolCallId,
      timestamp: msg.timestamp,
      toolName: String(msg.toolName ?? "unknown"),
      isError: msg.isError === true,
      lineCount: countLines(text),
      size: text.length,
      filtered: typeof keep?.raw === "string",
      rawWithheld: typeof keep?.rawWithheld === "string" ? keep.rawWithheld : undefined,
    };
  }
  return { ...base, kind: "other" };
}

/** The branch that ends at the last entry: follow parentId links back, at
 *  most scanMax entries. Returned oldest first. */
export function branchFromEntries(light: LightEntry[], scanMax: number): { branch: LightEntry[]; truncated: boolean } {
  if (!(scanMax > 0)) throw new RangeError("branchFromEntries: scanMax must be positive");
  const byId = new Map(light.map((e) => [e.id, e]));
  const branch: LightEntry[] = [];
  let current: LightEntry | undefined = light[light.length - 1];
  for (let step = 0; step < scanMax && current; step++) {
    branch.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  if (branch.length > scanMax) throw new Error("branchFromEntries: walked past scanMax");
  return { branch: branch.reverse(), truncated: current !== undefined };
}

/** Recallable records of a branch (oldest first in), newest first out. Scans
 *  at most scanMax entries from the newest end. `turnsAgo` counts assistant
 *  messages after the result. */
export function buildRecords(branch: LightEntry[], scanMax: number): RecallScan {
  if (!(scanMax > 0)) throw new RangeError("buildRecords: scanMax must be positive");
  const window = branch.slice(Math.max(0, branch.length - scanMax)).reverse();
  const labels = new Map(window.flatMap((e) => (e.calls ?? []).map((c) => [c.toolCallId, c.label] as [string, string])));
  const assistantsAfter = window.reduce<number[]>((acc, e, i) => {
    acc.push((i === 0 ? 0 : acc[i - 1]) + (i > 0 && window[i - 1].kind === "assistant" ? 1 : 0));
    return acc;
  }, []);
  const records = window.flatMap((e, i): RecallRecord[] => {
    if (e.kind === "assistant") {
      return (e.argCalls ?? []).map((c) => ({
        id: argsId(c.toolCallId, e.timestamp), entryId: e.id, toolCallId: c.toolCallId, toolName: c.toolName,
        label: `${labels.get(c.toolCallId) ?? "(unknown)"} (arguments)`, lineCount: c.lineCount, size: c.size,
        turnsAgo: assistantsAfter[i], filtered: false, isError: false, kind: "args" as const,
      }));
    }
    if (e.kind !== "result" || !e.toolCallId) return [];
    const label = labels.get(e.toolCallId) ?? "(command unknown)";
    return [{
      id: shortId(e.toolCallId, e.timestamp), entryId: e.id, toolCallId: e.toolCallId, toolName: e.toolName ?? "unknown",
      label, lineCount: e.lineCount ?? 0, size: e.size ?? 0, turnsAgo: assistantsAfter[i],
      filtered: e.filtered === true, rawWithheld: e.rawWithheld, isError: e.isError === true, kind: "result" as const,
    }];
  });
  if (records.length > window.length) throw new Error("buildRecords: more records than scanned entries");
  if (records.some((r) => r.turnsAgo < 0)) throw new Error("buildRecords: turnsAgo must not be negative");
  return { records, scanned: window.length, truncated: branch.length > scanMax };
}

/** Look up an id. Records of the same session entry are one result. */
export function findById(records: RecallRecord[], id: string):
  { kind: "found"; record: RecallRecord } | { kind: "missing" } | { kind: "ambiguous"; records: RecallRecord[] } {
  const hits = records.filter((r) => r.id === id);
  const distinct = hits.filter((r, i) => hits.findIndex((o) => o.entryId === r.entryId) === i);
  if (distinct.length === 0) return { kind: "missing" };
  if (distinct.length === 1) return { kind: "found", record: distinct[0] };
  return { kind: "ambiguous", records: distinct };
}

const err = (text: string): { kind: "error"; text: string } => ({ kind: "error", text: `cm_recall: ${text}` });
const oneLine = (s: string) => labelKey(s).slice(0, LABEL_CHARS_MAX);
const row = (r: RecallRecord) =>
  `#${r.id} · ${r.turnsAgo} turns ago · ${r.toolName} · ${oneLine(r.label)} · ${r.lineCount} lines, ${formatSize(r.size)}`;

/** Check the request shape; null when it is valid. Pure. */
function validateRequest(request: RecallRequest): string | null {
  const hasId = request.id !== undefined;
  const hasMatch = request.match !== undefined;
  if (hasId === hasMatch) return "give exactly one of id or match.";
  const idOnly = [request.grep, request.offset, request.limit, request.raw].some((v) => v !== undefined);
  if (hasMatch && idOnly) return "grep, offset, limit and raw work only with id.";
  if (hasMatch && String(request.match).trim() === "") return "match must not be empty.";
  if (hasId && parseRecallId(request.id) === null) {
    return `id must be ${SHORT_ID_HEX_CHARS} hex characters, for example #3f9a2c1d7e (got ${JSON.stringify(String(request.id))}).`;
  }
  for (const key of ["offset", "limit"] as const) {
    const v = request[key];
    if (v !== undefined && !(Number.isInteger(v) && v >= 1)) return `${key} must be a whole number of at least 1 (got ${String(v)}).`;
  }
  if (request.grep !== undefined) {
    try {
      new RegExp(request.grep);
    } catch (e) {
      // An invalid pattern from the agent is an expected outcome: report it as a value.
      return `invalid grep pattern: ${(e as Error).message}`;
    }
  }
  return null;
}

/** List results whose `tool · label` contains the match text (any case). */
function planMatch(records: RecallRecord[], match: string, scan: RecallScan): RecallPlan {
  const needle = match.toLowerCase();
  const hits = records.filter((r) => `${r.toolName} · ${oneLine(r.label)}`.toLowerCase().includes(needle));
  const title = `[cm-recall match ${JSON.stringify(match)}]`;
  if (hits.length === 0) {
    const where = scan.truncated ? `in the newest ${scan.scanned} entries (RECALL_SCAN_ENTRIES_MAX)` : `on this branch (scanned ${scan.scanned} entries)`;
    return { kind: "match", text: `${title} nothing matches ${where}.` };
  }
  const shown = hits.slice(0, RECALL_MATCH_ROWS_MAX);
  const more = hits.length - shown.length;
  const lines = [`${title} ${shown.length} of ${hits.length} tool results, newest first:`, ...shown.map(row)];
  if (more > 0) lines.push(`… ${more} more. Give a longer match.`);
  return { kind: "match", text: lines.join("\n") };
}

/** Decide what a request does: an error, a match listing, or a fetch of one
 *  record. Errors carry the exact message the agent sees. */
export function planRecall(records: RecallRecord[], request: RecallRequest, scan: RecallScan): RecallPlan {
  const invalid = validateRequest(request);
  if (invalid !== null) return err(invalid);
  if (request.match !== undefined) return planMatch(records, String(request.match), scan);
  const id = parseRecallId(request.id);
  if (id === null) throw new Error("planRecall: id passed validation but does not parse");
  const found = findById(records, id);
  if (found.kind === "missing") {
    return scan.truncated
      ? err(`no tool result #${id} in the newest ${scan.scanned} entries (RECALL_SCAN_ENTRIES_MAX). Use match, or check the id.`)
      : err(`no tool result #${id} on this branch (scanned ${scan.scanned} entries). Use match to find ids.`);
  }
  if (found.kind === "ambiguous") {
    const head = `cm_recall: #${id} is shared by ${found.records.length} tool results, so it cannot pick one. Re-run the command or re-read the file instead:`;
    return { kind: "error", text: [head, ...found.records.map(row)].join("\n") };
  }
  if (request.raw === true && found.record.kind === "args") {
    return err(`#${id} is the arguments of a call; raw works only with tool results.`);
  }
  if (request.raw === true && found.record.rawWithheld === "secret") {
    return err(`#${id} has no raw text, because its filter hides secrets.`);
  }
  if (request.raw === true && found.record.rawWithheld === "size") {
    return err(`#${id} has no raw text, because it was larger than RAW_KEEP_BYTES_MAX (${RAW_KEEP_BYTES_MAX} bytes).`);
  }
  return { kind: "fetch", record: found.record };
}

/** Bytes one recall may return: 5% of the effective window at 4 bytes per
 *  token, inside [RECALL_OUTPUT_BYTES_MIN, RECALL_OUTPUT_BYTES_MAX]. An
 *  unknown window gets the maximum. */
export function recallBytesCap(windowTokens: number | undefined): number {
  if (windowTokens === undefined || !Number.isFinite(windowTokens) || windowTokens <= 0) return RECALL_OUTPUT_BYTES_MAX;
  const share = Math.floor(windowTokens * RECALL_WINDOW_SHARE * BYTES_PER_TOKEN);
  return Math.min(RECALL_OUTPUT_BYTES_MAX, Math.max(RECALL_OUTPUT_BYTES_MIN, share));
}

/** Header kind for the text being returned. */
function sourceKind(raw: boolean, rawText: string | undefined, kind: RecallRecord["kind"]): string {
  if (kind === "args") return "arguments as first sent";
  if (!raw) return "original output as first shown";
  return rawText !== undefined
    ? "raw output from before the condensed-milk filter"
    : "original output as first shown (no filter changed it, so it is also the raw output)";
}

/** Numbered lines that survive the grep, inside the offset/limit window. */
function selectLines(lines: string[], request: RecallRequest): { numbered: { n: number; text: string }[]; first: number; last: number } {
  const first = request.offset ?? 1;
  const last = Math.min(lines.length, request.limit !== undefined ? first + request.limit - 1 : lines.length);
  const window = lines.slice(first - 1, last).map((text, i) => ({ n: first + i, text }));
  if (request.grep === undefined) return { numbered: window, first, last };
  const pattern = new RegExp(request.grep);
  return { numbered: window.filter((l) => pattern.test(l.text)), first, last };
}

/** Lines that fit the caps. A first line longer than bytesMax is cut inside
 *  the line, so the agent never gets an empty page it cannot move past. */
function fitCaps(
  lines: { n: number; text: string }[],
  format: (l: { n: number; text: string }) => string,
  caps: { bytesMax: number; linesMax: number },
): { body: string[]; shown: number; footer: string | null } {
  const body: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(0, caps.linesMax)) {
    const text = format(line);
    const add = Buffer.byteLength(text) + (body.length > 0 ? 1 : 0);
    if (bytes + add > caps.bytesMax) {
      if (body.length > 0) return { body, shown: body.length, footer: `[cut at ${caps.bytesMax} bytes; continue with offset=${line.n}]` };
      const cut = Buffer.from(text).subarray(0, caps.bytesMax).toString().replace(/\uFFFD+$/, "");
      return { body: [cut], shown: 1, footer: `[cut at ${caps.bytesMax} bytes inside line ${line.n}; the rest of that line is not shown; continue with offset=${line.n + 1}]` };
    }
    body.push(text);
    bytes += add;
  }
  if (body.length > caps.linesMax) throw new Error("fitCaps: kept more lines than linesMax");
  if (bytes > caps.bytesMax) throw new Error("fitCaps: kept more bytes than bytesMax");
  if (lines.length > caps.linesMax) return { body, shown: body.length, footer: `[cut at ${caps.linesMax} lines; continue with offset=${lines[caps.linesMax].n}]` };
  return { body, shown: body.length, footer: null };
}

/** Render a fetched record: header, a line that says which lines follow,
 *  a blank line, then the lines. `sessionId` marks a recall from another
 *  session. */
export function renderRecall(input: {
  record: RecallRecord;
  text: string;
  raw: string | undefined;
  request: RecallRequest;
  bytesMax: number;
  linesMax: number;
  sessionId?: string;
}): RecallRendered {
  const { record, request } = input;
  if (!(input.bytesMax > 0)) throw new RangeError("renderRecall: bytesMax must be positive");
  if (!(input.linesMax > 0)) throw new RangeError("renderRecall: linesMax must be positive");
  // Pair assertion with shortId (CM-ADR-001): every record id has the fixed form.
  if (parseRecallId(record.id) !== record.id) throw new Error(`renderRecall: record id ${JSON.stringify(record.id)} is not ${SHORT_ID_HEX_CHARS} lowercase hex`);
  const source = request.raw === true ? (input.raw ?? input.text) : input.text;
  const lines = source.length === 0 ? [] : source.split("\n");
  if (request.offset !== undefined && request.offset > lines.length) {
    return err(`offset ${request.offset} is past the end of #${record.id} (${lines.length} lines).`);
  }
  const from = input.sessionId ? ` From session ${input.sessionId}.` : "";
  const header = `[cm-recall #${record.id}] ${record.toolName}: ${oneLine(record.label)} — ${sourceKind(request.raw === true, input.raw, record.kind)}, ${record.turnsAgo} turns ago, not the current state.${from}`;
  const picked = selectLines(lines, request);
  const grep = request.grep !== undefined;
  const fit = fitCaps(picked.numbered, grep ? (l) => `${l.n}: ${l.text}` : (l) => l.text, input);
  const shownLast = fit.shown > 0 ? picked.numbered[fit.shown - 1].n : picked.first - 1;
  const span = lines.length === 0 ? "0-0" : `${picked.first}-${grep ? picked.last : shownLast}`;
  const second = grep
    ? `Matching /${request.grep}/ in lines ${span} of ${lines.length}: ${picked.numbered.length} line(s).`
    : `Lines ${span} of ${lines.length} (${formatSize(source.length)}).`;
  const body = grep && picked.numbered.length === 0 ? "(no lines match)" : fit.body.join("\n");
  const text = `${header}\n${second}\n\n${body}${fit.footer ? `\n${fit.footer}` : ""}`;
  return { kind: "ok", text, bytes: Buffer.byteLength(text) };
}
