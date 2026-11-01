/**
 * Read-only access to another pi session file for `cm_recall({ session })`
 * (CM-ADR-002 §1). This is the I/O boundary; parsing of entries is the pure
 * `lightEntry` in filters/recall.ts.
 *
 * Session files reach 522 MB, more than one JavaScript string can hold, so
 * the file is streamed twice:
 *   pass 1  split into lines, keep a LightEntry and the byte span per entry
 *   pass 2  read only the chosen entry's bytes by offset
 * The file is opened with flag "r" only and never written. pi's
 * SessionManager.open() is not used, because it migrates old files in place.
 */
import { createReadStream, promises as fsp, realpathSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { lightEntry, SESSION_FILE_LINES_MAX, type LightEntry } from "../filters/recall.js";

/** inherited: pi session format version 3 (session-format.md). */
const SESSION_FORMAT_VERSION = 3;
/** arbitrary: file names listed while looking up a session id; revisit if a sessions dir holds more. */
const SESSION_LOOKUP_FILES_MAX = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Located = { kind: "ok"; path: string } | { kind: "error"; text: string };
export type ByteSpan = { offset: number; length: number };
export type SessionIndex =
  | { kind: "ok"; sessionId: string; light: LightEntry[]; spans: Map<string, ByteSpan> }
  | { kind: "error"; text: string };

const fail = (text: string): { kind: "error"; text: string } => ({ kind: "error", text: `cm_recall: ${text}` });

/** Real path, or null when the path does not exist. */
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (e) {
    // A missing path is an expected outcome here; the caller reports it.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Find a session file by id or check a given path. The file must be inside
 *  the pi sessions directory, after symlinks are resolved. */
export function locateSessionFile(session: string, sessionsDir: string): Located {
  const dir = realOrNull(sessionsDir);
  if (dir === null) return fail(`the sessions directory ${sessionsDir} does not exist.`);
  if (session.endsWith(".jsonl")) {
    const real = realOrNull(resolve(session));
    if (real === null) return fail(`no session file at ${JSON.stringify(session)}.`);
    if (!real.startsWith(dir + sep)) return fail(`session file must be inside ${dir} (got ${JSON.stringify(session)}).`);
    return { kind: "ok", path: real };
  }
  if (!UUID.test(session)) return fail(`session must be a session id or a .jsonl path (got ${JSON.stringify(session)}).`);
  const suffix = `_${session.toLowerCase()}.jsonl`;
  const projects = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).slice(0, SESSION_LOOKUP_FILES_MAX);
  let listed = 0;
  for (const project of projects) {
    const names = readdirSync(join(dir, project.name));
    listed += names.length;
    const hit = names.find((name) => name.toLowerCase().endsWith(suffix));
    if (hit) return { kind: "ok", path: join(dir, project.name, hit) };
    if (listed > SESSION_LOOKUP_FILES_MAX) return fail(`stopped looking for session ${session} after ${SESSION_LOOKUP_FILES_MAX} files (SESSION_LOOKUP_FILES_MAX). Give the .jsonl path.`);
  }
  return fail(`no session file for id "${session}" in ${dir}.`);
}

/** Stream a file and hand each line (without its newline) and its byte
 *  offset to `onLine`. Stops at the first non-null return, which it returns.
 *  The last line is passed with `last` true. Bounded by SESSION_FILE_LINES_MAX. */
async function forEachLine(
  path: string,
  onLine: (line: Buffer, offset: number, lineNumber: number, last: boolean) => string | null,
): Promise<string | null> {
  const stream = createReadStream(path, { flags: "r" });
  const pending: Buffer[] = [];
  let lineStart = 0;
  let chunkStart = 0;
  let lineNumber = 0;
  try {
    // Bounded by the file size: each chunk is consumed once.
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let from = 0;
      for (let nl = chunk.indexOf(0x0a, from); nl >= 0; nl = chunk.indexOf(0x0a, from)) {
        pending.push(chunk.subarray(from, nl));
        const line = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        pending.length = 0;
        lineNumber++;
        if (lineNumber > SESSION_FILE_LINES_MAX) return `cm_recall: ${path} has more than ${SESSION_FILE_LINES_MAX} lines (SESSION_FILE_LINES_MAX).`;
        if (lineStart > chunkStart + nl) throw new Error("forEachLine: line starts after its own newline");
        const stop = onLine(line, lineStart, lineNumber, false);
        if (stop !== null) return stop;
        from = nl + 1;
        lineStart = chunkStart + from;
      }
      if (from < chunk.length) pending.push(chunk.subarray(from));
      chunkStart += chunk.length;
    }
    if (pending.length === 0) return null;
    return onLine(Buffer.concat(pending), lineStart, lineNumber + 1, true);
  } finally {
    stream.destroy();
  }
}

/** Pass 1: index every entry of a session file. A line that is not JSON is
 *  an error unless it is the last line (a write cut short by a crash). */
export async function indexSessionFile(path: string): Promise<SessionIndex> {
  const light: LightEntry[] = [];
  const spans = new Map<string, ByteSpan>();
  let sessionId = "";
  let badLine: number | null = null;
  const stop = await forEachLine(path, (line, offset, lineNumber, last) => {
    if (line.length === 0 || line.toString("utf8").trim() === "") return null;
    if (badLine !== null) return `cm_recall: ${path} line ${badLine} is not valid JSON.`;
    let entry: any;
    try {
      entry = JSON.parse(line.toString("utf8"));
    } catch (e) {
      // Recorded, not thrown: only a bad line followed by more lines is an error.
      if (!(e instanceof SyntaxError)) throw e;
      badLine = lineNumber;
      return lineNumber === 1 && !last ? `cm_recall: ${path} line 1 is not valid JSON.` : null;
    }
    if (lineNumber === 1) {
      if (entry?.type !== "session") return `cm_recall: ${path} line 1 is not a session header.`;
      const version = typeof entry.version === "number" ? entry.version : 1;
      if (version !== SESSION_FORMAT_VERSION) return `cm_recall: ${path} is session format version ${version}; cm_recall reads version ${SESSION_FORMAT_VERSION}.`;
      sessionId = String(entry.id ?? "");
      return null;
    }
    if (typeof entry?.id !== "string") return null;
    light.push(lightEntry(entry));
    spans.set(entry.id, { offset, length: line.length });
    return null;
  });
  if (stop !== null) return { kind: "error", text: stop };
  if (sessionId === "") return fail(`${path} has no session header.`);
  if (spans.size > light.length) throw new Error("indexSessionFile: more byte spans than entries");
  return { kind: "ok", sessionId, light, spans };
}

/** Pass 2: read and parse one entry by its byte span. */
export async function readEntryAt(path: string, span: ByteSpan): Promise<{ kind: "ok"; entry: any } | { kind: "error"; text: string }> {
  if (!(span.length > 0)) throw new RangeError("readEntryAt: span length must be positive");
  const handle = await fsp.open(path, "r");
  try {
    const buffer = Buffer.alloc(span.length);
    const { bytesRead } = await handle.read(buffer, 0, span.length, span.offset);
    if (bytesRead !== span.length) return fail(`${path} changed while it was read; try again.`);
    try {
      return { kind: "ok", entry: JSON.parse(buffer.toString("utf8")) };
    } catch (e) {
      // The bytes moved between pass 1 and pass 2: the file was rewritten.
      if (!(e instanceof SyntaxError)) throw e;
      return fail(`${path} changed while it was read; try again.`);
    }
  } finally {
    await handle.close();
  }
}
