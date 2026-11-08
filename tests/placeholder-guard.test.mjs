/**
 * CM-ADR-007 spec: the placeholder guard (1.13.1).
 *
 * Field finding (docs §13): with masked arguments, the model three times put a
 * placeholder with an invented id into its own new call; one `write` succeeded
 * and replaced a 13.1 KB document with the 61-byte placeholder.
 *
 * Laws: (1) a call whose string argument IS a placeholder (the whole value,
 * one line) is blocked, for every built-in kind and for custom profile
 * templates; (2) a value that only contains a placeholder among other text is
 * allowed (documentation about condensed-milk); (3) cm_recall is never blocked;
 * (4) property: every rendered placeholder is caught, and random text without
 * the shape is never caught (seeded; replay with CM_SEED=<n>).
 */
import { loadTs, makeFakePi, makeCtx, makeRunner, prng, seedFromEnv, isolateHome } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-007 placeholder guard");
isolateHome();
const pg = await loadTs("filters/placeholder-guard.ts");
const profiles = await loadTs("filters/profiles.ts");
const T = profiles.DEFAULT_PLACEHOLDERS;
const matchers = pg.placeholderMatchers(T);

// (1) whole-value placeholders, every built-in kind
const cases = {
	write: { path: "notes.md", content: "[cm-masked arg #6dc87b4b46] write content (175 lines, 13.1KB)" },
	bash: { command: "[cm-masked arg #4a3a58a1b5] bash command (16 lines, 3.9KB)", timeout: 60 },
	edit: { path: "a.sh", edits: [{ oldText: "[cm-masked arg #a7a2f7b8a1] edit edits[0].oldText (24 lines, 1.2KB)", newText: "x" }] },
	readKind: { content: "[cm-masked read #0123456789] src/a.ts (12 lines, 340B)" },
	bashKind: { content: "  [cm-masked bash #abcdefabcd] git status (3 lines, 90B)\n" },
	recallKind: { content: "[cm-masked recall #abcdefabcd] id=0123456789 (3 lines, 90B)" },
	noId: { content: "[cm-masked bash] pytest -q" },
};
for (const [name, args] of Object.entries(cases)) {
	check(`${name}: a whole-value placeholder is found`, pg.findPlaceholderArgument(args, matchers) !== null, true);
}
check("the finding names the key path", pg.findPlaceholderArgument(cases.edit, matchers)?.key, "edits[0].oldText");

// (2) allowed values
const allowed = {
	plain: { path: "a.ts", content: "export const x = 1;\n" },
	docs: { path: "README.md", content: "Masked results look like this:\n[cm-masked arg #3f9a2c1d7e] edit edits[0].oldText (81 lines, 3.2KB)\nCall cm_recall to get them." },
	grep: { command: "grep -rn '\\[cm-masked arg #' docs/" },
	twoLines: { content: "[cm-masked arg #6dc87b4b46] write content (1 lines, 1B)\nmore text" },
	number: { path: "a", n: 3, flag: true },
};
for (const [name, args] of Object.entries(allowed)) {
	check(`${name}: allowed`, pg.findPlaceholderArgument(args, matchers), null);
}

// custom profile templates are caught too
{
	const custom = { ...T, arg: "<elided id=\"{id}\" what=\"{cmd}\" lines=\"{n}\" size=\"{size}\"/>" };
	const m = pg.placeholderMatchers(custom);
	check("a custom arg template is caught", pg.findPlaceholderArgument({ content: "<elided id=\"0123456789\" what=\"write content\" lines=\"9\" size=\"1.0KB\"/>" }, m) !== null, true);
	check("the built-in shape stays caught with a custom template", pg.findPlaceholderArgument(cases.write, m) !== null, true);
}

// (4) property
{
	const seed = seedFromEnv();
	const rand = prng(seed);
	const CASES_MAX = 400;
	const pick = (xs) => xs[Math.floor(rand() * xs.length)];
	const hex = () => Array.from({ length: 10 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
	let missed = 0;
	let falseHits = 0;
	for (let c = 0; c < CASES_MAX; c++) {
		const kind = pick(["bash", "read", "recall", "arg"]);
		const text = profiles.renderPlaceholder(T[kind], { id: hex(), cmd: pick(["ls", "edit edits[2].newText", "git log --oneline -5"]), path: pick(["/a/b.ts", "x.md"]), n: Math.floor(rand() * 900), size: pick(["12B", "3.4KB", "1.1MB"]) });
		if (pg.findPlaceholderArgument({ value: text }, matchers) === null) missed++;
		const noise = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => pick(["cm-masked", "[", "]", "#", "lines", "text", " ", "\n", "(3 lines, 1KB)", "arg"])).join("");
		if (!noise.trim().startsWith("[cm-masked ") && pg.findPlaceholderArgument({ value: noise }, matchers) !== null) falseHits++;
	}
	console.log(`  property seed=${seed} (replay: CM_SEED=${seed})`);
	check("every rendered placeholder is caught", missed, 0);
	check("text without the placeholder shape is never caught", falseHits, 0);
}

// extension wiring: tool_call blocks, cm_recall passes, telemetry counts
{
	const ext = (await loadTs("index.ts")).default;
	const { pi, fire } = makeFakePi();
	ext(pi);
	await fire("session_start", { reason: "startup" }, makeCtx());
	const blocked = await fire("tool_call", { toolName: "write", toolCallId: "t1", input: cases.write }, makeCtx());
	check("tool_call blocks a placeholder write", blocked?.block, true);
	check("the reason tells the agent what to do", blocked?.reason,
		"condensed-milk blocked this call: argument `content` is a condensed-milk placeholder, not real content. " +
		"A placeholder only stands for text that is no longer shown; writing it would replace real content with one line. " +
		"Write the full content yourself, or call cm_recall with the id to see the original first.");
	check("a normal call passes", await fire("tool_call", { toolName: "write", toolCallId: "t2", input: allowed.plain }, makeCtx()), undefined);
	check("cm_recall is never blocked", await fire("tool_call", { toolName: "cm_recall", toolCallId: "t3", input: { id: "[cm-masked arg #6dc87b4b46] write content (1 lines, 1B)" } }, makeCtx()), undefined);
}

done();
