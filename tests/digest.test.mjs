/**
 * CM-ADR-009 spec: the digest at the end of a bash or read placeholder
 * (filters/digest.ts). Fixed code, no model: the same text gives the same
 * digest, so the placeholder's bytes never change.
 *
 * Bash: the last line that states an outcome; "" without one.
 * (test-edit, second version: the first version also gave the first outcome
 * line and, without one, the last line. It failed its replay cost gate, +2.9%
 * against a limit of 1%; 65% of its characters were last-line fallbacks.
 * docs/research/2026-11-18-field-data.md §7.3.)
 * Read: `defines a, b, c` from definitions at column 0 (an optional `export`
 * first); for a Markdown path `sections A; B` from its headings; "" when
 * there is none.
 * Every digest is one line of at most DIGEST_CHARS_MAX (120) characters.
 */
import { loadTs, makeRunner, prng, seedFromEnv } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-009 digest core");
const D = await loadTs("filters/digest.ts");

check("DIGEST_CHARS_MAX", D.DIGEST_CHARS_MAX, 120);

// bash
const run = ["> vitest run", ...Array.from({ length: 40 }, (_, i) => ` ✓ test ${i}`), " FAIL  src/auth.test.ts > login", "AssertionError: expected 1 to be 2", " FAIL  src/cart.test.ts > total", "", "Tests  2 failed | 87 passed (89)", ""].join("\n");
check("test run: the last outcome line", D.digestBash(run), "Tests 2 failed | 87 passed (89)");
check("one outcome line: that line", D.digestBash("building\nlinking\nerror: linker failed\ndone in 3s\n"), "error: linker failed");
check("no outcome line: no digest", D.digestBash("a.txt\nb.txt\nzeta.txt\n\n"), "");
check("the word must stand alone: 'errors.ts' and 'failover' are not outcomes", D.digestBash("src/errors.ts\nsrc/failover.ts\n"), "");
check("counts are outcomes", D.digestBash("x\n12 passed, 0 failed\ny\n"), "12 passed, 0 failed");
check("an exit code line is an outcome", D.digestBash("x\nCommand exited with code 2\n"), "Command exited with code 2");
check("empty text: no digest", [D.digestBash(""), D.digestBash("\n \n")], ["", ""]);
check("whitespace runs and control characters collapse", D.digestBash("x\n\u001b[31mERROR\u001b[0m\t in   main\n"), "ERROR in main");
{
	const long = `error: ${"x".repeat(400)}`;
	const d = D.digestBash(`${long}\nok\nFAILED ${"y".repeat(400)}\n`);
	check("a long line is cut with an ellipsis, 120 at most", [d.length, d.startsWith("FAILED yyy"), d.endsWith("…")], [120, true, true]);
}
check("not a string is an error", (() => { try { D.digestBash(null); return "no throw"; } catch (e) { return e.constructor.name; } })(), "TypeError");

// read
const ts = ["import x from 'y';", "export const LIMIT = 4;", "const hidden = 1;", "export function alpha(a) {", "  const inner = 2;", "  function nested() {}", "}", "export default class Beta {", "  method() {}", "}", "interface Gamma {}", "type Delta = string;", "async function epsilon() {}"].join("\n");
check("code: names defined at column 0, in order", D.digestRead(ts, "/w/src/a.ts"), "defines LIMIT, hidden, alpha, Beta, Gamma, Delta, epsilon");
check("python and rust and go keywords", D.digestRead("def one():\n    def inner(): pass\nclass Two:\n    pass\nfn three() {}\npub fn four() {}\nfunc five() {}\nstruct Six;\n", "/w/x.py"), "defines one, Two, three, four, five, Six");
check("markdown: headings of level 1 to 3", D.digestRead("# Title\ntext\n## Part one\n#### deep\n### Sub\n", "/w/README.md"), "sections Title; Part one; Sub");
check("a '#' line in code is a comment, not a heading", D.digestRead("# comment\nx = 1\n", "/w/a.py"), "");
check("nothing found: no digest", [D.digestRead("just some\nplain text\n", "/w/notes.txt"), D.digestRead("", "/w/a.ts")], ["", ""]);
check("a repeated name is listed once", D.digestRead("function a() {}\nfunction a() {}\nfunction b() {}\n", "/w/a.js"), "defines a, b");
{
	const many = Array.from({ length: 80 }, (_, i) => `function name_number_${i}() {}`).join("\n");
	const d = D.digestRead(many, "/w/a.js");
	check("many names: cut at a name, the rest counted, 120 at most", [d.length <= 120, d.startsWith("defines name_number_0, name_number_1, "), /, \+\d+ more$/.test(d)], [true, true, true]);
	const shown = d.replace(/, \+\d+ more$/, "").split(", ").length;
	check("shown + more = all", shown + Number(/\+(\d+) more$/.exec(d)[1]), 80);
}

// property: form and determinism on random text
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const WORDS = ["error", "FAIL", "passed", "failed", "ok", "function", "class", "def", "#", "##", "x".repeat(300), "\t", "  ", "\u001b[1m", "12", "export", "const", "é", "😀", "|", ""];
	const text = () => Array.from({ length: Math.floor(rand() * 30) }, () => Array.from({ length: Math.floor(rand() * 8) }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ")).join("\n");
	let bad = 0;
	for (let i = 0; i < 1500; i++) {
		const t = text();
		for (const d of [D.digestBash(t), D.digestRead(t, i % 2 ? "/a.md" : "/a.ts")]) {
			// eslint-disable-next-line no-control-regex
			if (d.length > D.DIGEST_CHARS_MAX || /[\n\r\u0000-\u001f]/.test(d) || d !== d.trim()) bad++;
		}
		if (D.digestBash(t) !== D.digestBash(t) || D.digestRead(t, "/a.ts") !== D.digestRead(t, "/a.ts")) bad++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	check("1500 random texts: one line, 120 at most, trimmed, deterministic", bad, 0);
}

done();
