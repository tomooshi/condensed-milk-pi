/**
 * CM-ADR-009 spec, extension wiring: the digest in placeholders
 * (features.digest, off by default). Bash and read placeholders end with
 * `: <digest>`. Drives the real index.ts through a fake pi.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadTs, makeFakePi, makeCtx, makeRunner, assistantCall, toolResult, userMsg, textOf, isolateHome } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-009 extension: digest");
const home = isolateHome();
mkdirSync(join(home, ".config"), { recursive: true });
const CONFIG = join(home, ".config", "condensed-milk.json");
const setFeatures = (features) => writeFileSync(CONFIG, JSON.stringify({ features }));
const ext = (await loadTs("index.ts")).default;
const sid = (s, ts = 0) => createHash("sha1").update(`${s}\u0000${ts}`).digest("hex").slice(0, 10);

/** [user, (call, result) x pairs]. */
function history(pairs, size, ts = 0, talk = 0) {
	const out = [userMsg("go", ts)];
	for (let i = 0; i < pairs; i++) {
		out.push(assistantCall(`c${i}`, "bash", { command: `cat f${i}` }, ts));
		out.push(toolResult(`c${i}`, "bash", `${"r".repeat(size)}${i}`));
	}
	if (talk > 0) out.push(userMsg("t".repeat(talk), ts));
	return out;
}
const masked = (ms) => ms.map((m, i) => (m.role === "toolResult" && textOf(m).startsWith("[cm-masked") ? i : -1)).filter((i) => i >= 0);
async function fresh() {
	const f = makeFakePi();
	ext(f.pi);
	await f.fire("session_start", { reason: "startup" }, makeCtx());
	return f;
}
// ── digest ──
{
	setFeatures({ digest: true });
	const f = await fresh();
	const out = ["> vitest run", ...Array.from({ length: 60 }, (_, i) => ` ✓ test ${i}`), " FAIL  src/auth.test.ts > login", "Tests  1 failed | 60 passed (61)"].join("\n");
	const code = ["export function alpha() {", ...Array.from({ length: 40 }, () => "  work();"), "}", "export class Beta {}"].join("\n");
	const h = [
		userMsg("go"),
		assistantCall("t1", "bash", { command: "npm test" }), toolResult("t1", "bash", out),
		assistantCall("r1", "read", { path: "/w/src/a.ts" }), toolResult("r1", "read", code),
		assistantCall("l1", "bash", { command: "ls" }), toolResult("l1", "bash", Array.from({ length: 60 }, (_, i) => `file${i}.txt`).join("\n")),
		...history(6, 300).slice(1),
	];
	const r = await f.fire("context", { messages: h }, makeCtx({ tokens: 650_000 }));
	const lines = out.split("\n").length;
	check("bash placeholder ends with the outcome digest", textOf(r.messages[2]),
		`[cm-masked bash #${sid("t1")}] npm test (${lines} lines, ${out.length}B; cm_recall returns it): Tests 1 failed | 60 passed (61)`);
	check("read placeholder ends with the names", textOf(r.messages[4]).endsWith("; cm_recall returns it): defines alpha, Beta"), true);
	check("no outcome line: no digest", textOf(r.messages[6]).endsWith("; cm_recall returns it)"), true);
	const again = await f.fire("context", { messages: h }, makeCtx({ tokens: 650_000 }));
	check("the same bytes on the next call", again.messages.map(textOf), r.messages.map(textOf));
	const guard = (await loadTs("filters/placeholder-guard.ts"));
	const profiles = await loadTs("filters/profiles.ts");
	check("the placeholder guard still knows a placeholder with a digest",
		guard.findPlaceholderArgument({ content: textOf(r.messages[2]) }, guard.placeholderMatchers(profiles.DEFAULT_PLACEHOLDERS))?.key, "content");
}
{
	setFeatures({ digest: false });
	const f = await fresh();
	const h = [userMsg("go"), assistantCall("t1", "bash", { command: "npm test" }), toolResult("t1", "bash", `${"x\n".repeat(100)}2 failed`), ...history(6, 300).slice(1)];
	const r = await f.fire("context", { messages: h }, makeCtx({ tokens: 650_000 }));
	check("feature off: no digest", textOf(r.messages[2]), `[cm-masked bash #${sid("t1")}] npm test (101 lines, 208B; cm_recall returns it)`);
}
{
	// a custom template without {digest} is not changed
	setFeatures({ digest: true });
	const cc = await loadTs("filters/context-compress.ts");
	const msgs = [assistantCall("t1", "bash", { command: "npm test" }), toolResult("t1", "bash", `${"x\n".repeat(100)}2 failed`), userMsg("n")];
	const out = cc.compressStaleToolResults(msgs, { previousCutoff: 3, zoneEntered: 2, contextUsage: 0.9, features: { digest: true }, placeholderFormat: { bash: "<<{cmd}>>" } });
	check("a custom template without {digest} gets none", textOf(out.messages[1]), "<<npm test>>");
}

done();
