/**
 * The `cm_recall` tool (CM-ADR-002 §1): the I/O boundary around the pure
 * recall core. It reads the current branch from pi's session manager, or
 * another session file read-only, then plans, fetches and renders.
 *
 * There is no in-memory archive: every call reads the authority again, so
 * recall works after a restart, a compaction or a hibernation.
 */
import { Type } from "@earendil-works/pi-ai";
import {
  branchFromEntries,
  buildRecords,
  lightEntry,
  planRecall,
  recallBytesCap,
  renderRecall,
  toolResultText,
  RECALL_OUTPUT_LINES_MAX,
  RECALL_SCAN_ENTRIES_MAX,
  type RecallRecord,
  type RecallRequest,
  type RecallScan,
} from "../filters/recall.js";
import { indexSessionFile, locateSessionFile, readEntryAt } from "./session-file.js";

/** What one call did, for the opt-in telemetry in index.ts. */
export interface RecallOutcome {
  mode: "id" | "match" | "invalid";
  ok: boolean;
  bytes: number;
  request: RecallRequest;
  record?: RecallRecord;
}

/** Values the tool reads from index.ts state at call time. */
export interface RecallToolDeps {
  sessionsDir: () => string;
  windowTokens: (ctx: any) => number | undefined;
}

/** A branch ready to plan against, plus how to fetch one entry's message. */
interface Source {
  scan: RecallScan;
  sessionId?: string;
  fetch: (entryId: string) => Promise<{ kind: "ok"; message: any } | { kind: "error"; text: string }>;
}

type Built = { kind: "ok"; source: Source } | { kind: "error"; text: string };

/** The current branch from pi. Only the newest RECALL_SCAN_ENTRIES_MAX
 *  entries are reduced, so a long branch costs one bounded pass. */
function currentSource(ctx: any): Built {
  const sessionManager = ctx?.sessionManager;
  if (typeof sessionManager?.getBranch !== "function") {
    return { kind: "error", text: "cm_recall: this host gives no session branch to extensions, so there is nothing to recall." };
  }
  const branch: any[] = sessionManager.getBranch();
  const window = branch.slice(-RECALL_SCAN_ENTRIES_MAX);
  const built = buildRecords(window.filter((e) => typeof e?.id === "string").map(lightEntry), RECALL_SCAN_ENTRIES_MAX);
  const byId = new Map(window.map((e) => [e?.id, e]));
  const scan = { ...built, truncated: branch.length > RECALL_SCAN_ENTRIES_MAX };
  const fetch = async (entryId: string) => {
    const entry = byId.get(entryId);
    if (!entry?.message) throw new Error(`cm_recall: entry ${entryId} was planned but is not on the branch`);
    return { kind: "ok" as const, message: entry.message };
  };
  return { kind: "ok", source: { scan, fetch } };
}

/** Another session, streamed read-only from its .jsonl file. */
async function fileSource(session: string, sessionsDir: string): Promise<Built> {
  const located = locateSessionFile(session, sessionsDir);
  if (located.kind === "error") return located;
  const index = await indexSessionFile(located.path);
  if (index.kind === "error") return index;
  const walked = branchFromEntries(index.light, RECALL_SCAN_ENTRIES_MAX);
  const built = buildRecords(walked.branch, RECALL_SCAN_ENTRIES_MAX);
  const scan = { ...built, truncated: built.truncated || walked.truncated };
  const fetch = async (entryId: string) => {
    const span = index.spans.get(entryId);
    if (!span) throw new Error(`cm_recall: entry ${entryId} was planned but has no byte span`);
    const read = await readEntryAt(located.path, span);
    return read.kind === "ok" ? { kind: "ok" as const, message: read.entry?.message } : read;
  };
  return { kind: "ok", source: { scan, sessionId: index.sessionId, fetch } };
}

const reply = (text: string, isError: boolean) => ({ content: [{ type: "text" as const, text }], details: undefined, isError });

/** Run one recall request end to end and report the outcome. */
async function runRecall(request: RecallRequest, ctx: any, deps: RecallToolDeps): Promise<{ text: string; outcome: RecallOutcome }> {
  const mode = request.match !== undefined && request.id === undefined ? "match" : request.id !== undefined ? "id" : "invalid";
  const failed = (text: string) => ({ text, outcome: { mode, ok: false, bytes: 0, request } as RecallOutcome });
  const built = request.session !== undefined ? await fileSource(String(request.session), deps.sessionsDir()) : currentSource(ctx);
  if (built.kind === "error") return failed(built.text);
  const { scan, sessionId, fetch } = built.source;
  const plan = planRecall(scan.records, request, scan);
  if (plan.kind === "error") return failed(plan.text);
  if (plan.kind === "match") return { text: plan.text, outcome: { mode, ok: true, bytes: Buffer.byteLength(plan.text), request } };
  const fetched = await fetch(plan.record.entryId);
  if (fetched.kind === "error") return failed(fetched.text);
  const rendered = renderRecall({
    record: plan.record,
    text: toolResultText(fetched.message),
    raw: fetched.message?.details?.condensedMilk?.raw,
    request,
    bytesMax: recallBytesCap(deps.windowTokens(ctx)),
    linesMax: RECALL_OUTPUT_LINES_MAX,
    sessionId,
  });
  if (rendered.kind === "error") return failed(rendered.text);
  if (!rendered.text.startsWith(`[cm-recall #${plan.record.id}]`)) throw new Error("runRecall: rendered text does not start with its header");
  return { text: rendered.text, outcome: { mode, ok: true, bytes: rendered.bytes, request, record: plan.record } };
}

/** Tool definition for pi.registerTool. `onOutcome` receives every call's outcome. */
export function createRecallTool(deps: RecallToolDeps, onOutcome: (outcome: RecallOutcome) => void) {
  return {
    name: "cm_recall",
    label: "Recall masked result",
    description:
      "Return an earlier tool result exactly as it was first shown, by the #id in a `[cm-masked … #id]` " +
      "placeholder. It runs nothing: it shows the old output, not the current state (re-run the command " +
      "for that). Give `id`, or `match` (text in the command or path) to list ids. With `id`: `grep` " +
      "(a JavaScript regular expression) keeps matching lines, `offset`/`limit` select lines, `raw` " +
      "returns the text from before a condensed-milk filter. `session` reads another pi session (id or .jsonl path).",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "The 10-character id from a placeholder, with or without #" })),
      match: Type.Optional(Type.String({ description: "Case-insensitive text in the tool name, command or path; lists matching ids" })),
      grep: Type.Optional(Type.String({ description: "JavaScript regular expression; keeps only matching lines (with numbers)" })),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to return (1-based)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Number of lines to return" })),
      raw: Type.Optional(Type.Boolean({ description: "Return the text from before the condensed-milk filter" })),
      session: Type.Optional(Type.String({ description: "Another pi session: its id or its .jsonl path" })),
    }),
    async execute(_toolCallId: string, params: RecallRequest, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const { text, outcome } = await runRecall(params ?? {}, ctx, deps);
      onOutcome(outcome);
      return reply(text, !outcome.ok);
    },
  };
}
