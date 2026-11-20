/**
 * Digest at the end of a bash or read placeholder (CM-ADR-009). Pure and
 * deterministic: fixed code, no model, no clock. The same text gives the same
 * digest, so the bytes of a placeholder never change between requests.
 *
 * The digest tells the agent the main fact of a masked result (the outcome of
 * a command, what a file defines), so that it often needs no recall, no
 * re-run and no guess (arXiv 2611.22238, Appendix H).
 */

/** arbitrary: longest digest in characters, about 30 tokens. A digest costs
 *  on every later request: the first version (160, with a last-line fallback)
 *  failed its replay cost gate. Revisit with the recall counts of schema 6. */
export const DIGEST_CHARS_MAX = 120;
/** arbitrary: lines of a result that the digest reads; a result is filtered
 *  and truncated before it gets here, this only bounds the loop. */
const DIGEST_LINES_MAX = 20_000;

const ELLIPSIS = "…";

/** A line that states an outcome: a count of passed/failed/errors/warnings, a
 *  status word that stands alone, or an exit code. */
const OUTCOME = /(?:^|[^\w./-])(?:\d+\s+(?:passed|passing|failed|failing|errors?|warnings?|skipped)|PASS(?:ED)?|FAIL(?:ED|URE)?|ERROR|[Ee]rror|fatal|panic|Traceback|exited with code \d+|exit code \d+)(?![\w./-])/;

/** A definition at column 0: optional export/pub and modifiers, a keyword, a name. */
const DEFINITION = /^(?:export\s+)?(?:default\s+)?(?:pub(?:\([a-z]+\))?\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|module)\s+([A-Za-z_$][\w$]*)/;
const HEADING = /^#{1,3}\s+(\S.*)$/;
const MARKDOWN_PATH = /\.(?:md|mdx|markdown)$/i;

/** One clean line: no control characters or ANSI codes, single spaces, trimmed. */
function clean(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Cut to `max` characters; a cut text ends with an ellipsis. Cuts by code
 *  point so a surrogate pair is never split. */
function cut(text: string, max: number): string {
  if (!(max >= 1)) throw new RangeError("cut: max must be 1 or more");
  if (text.length <= max) return text;
  const points = Array.from(text);
  let out = "";
  for (const p of points) {
    if (out.length + p.length > max - ELLIPSIS.length) break;
    out += p;
  }
  return out.trimEnd() + ELLIPSIS;
}

function linesOf(content: string, caller: string): string[] {
  if (typeof content !== "string") throw new TypeError(`${caller}: content must be a string`);
  return content.split("\n", DIGEST_LINES_MAX).map(clean).filter((l) => l !== "");
}

/** Bash: the last line that states an outcome (a test or build summary is
 *  near the end); "" without one. A result without an outcome line gets no
 *  digest: its last line says little and costs on every request. */
export function digestBash(content: string): string {
  const outcomes = linesOf(content, "digestBash").filter((l) => OUTCOME.test(l));
  return outcomes.length === 0 ? "" : cut(outcomes[outcomes.length - 1], DIGEST_CHARS_MAX);
}

/** Join names up to the limit; the names that do not fit are counted. */
function listNames(label: string, names: string[], separator: string): string {
  if (names.length === 0) return "";
  let out = `${label} ${cut(names[0], DIGEST_CHARS_MAX - label.length - 1 - 12)}`;
  let shown = 1;
  for (; shown < names.length; shown++) {
    const more = names.length - shown - 1;
    const tail = more > 0 ? `${separator}+${more} more` : "";
    const next = out + separator + names[shown];
    if (next.length + tail.length > DIGEST_CHARS_MAX) break;
    out = next;
  }
  const rest = names.length - shown;
  const done = rest > 0 ? `${out}${separator}+${rest} more` : out;
  if (done.length > DIGEST_CHARS_MAX) throw new Error("listNames: digest over DIGEST_CHARS_MAX");
  return done;
}

/** Read: names defined at column 0, or the headings of a Markdown file. */
export function digestRead(content: string, path: string): string {
  if (typeof content !== "string") throw new TypeError("digestRead: content must be a string");
  if (typeof path !== "string") throw new TypeError("digestRead: path must be a string");
  const raw = content.split("\n", DIGEST_LINES_MAX);
  const pattern = MARKDOWN_PATH.test(path) ? HEADING : DEFINITION;
  const names = raw.map((l) => pattern.exec(l)?.[1]).filter((n): n is string => typeof n === "string").map(clean).filter((n) => n !== "");
  const unique = [...new Set(names)];
  return MARKDOWN_PATH.test(path) ? listNames("sections", unique, "; ") : listNames("defines", unique, ", ");
}
