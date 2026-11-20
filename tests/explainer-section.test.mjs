/**
 * CM-ADR-008 §8 spec: the explainer is a prompt section, not a forced prompt.
 *
 * pi (1.3 and later) builds the system prompt from sections and sends a later
 * change (a tool added, a section changed) as a small system message at the
 * end of the request. A `before_agent_start` handler that returns
 * `systemPrompt` forces the whole prompt instead: pi then folds every such
 * change into the head of the request, which rewrites the prompt cache and
 * drops the signed thinking blocks (llblab/pi-telegram#353,
 * pingdotgg/t3code#18933). condensed-milk returned `systemPrompt` on every
 * run up to 1.13.1.
 *
 * Contract:
 *   - sections available, nothing forced: set `sections.condensed_milk` to
 *     the explainer text and return nothing.
 *   - an earlier extension forced the prompt: append to the forced text (a
 *     section would not be rendered).
 *   - no sections (older pi): append, as before.
 */
import { loadTs, makeFakePi, makeCtx, makeRunner, isolateHome } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-008 explainer as a prompt section");
isolateHome();
const ext = (await loadTs("index.ts")).default;
const f = makeFakePi();
ext(f.pi);

const BODY =
	"condensed-milk: old tool results and long tool-call arguments can appear as\n" +
	"`[cm-masked bash|read|recall|arg #id] …` to keep the prompt cache stable. To see one\n" +
	"exactly as it was first shown, call `cm_recall` with the id (add `grep`, or\n" +
	"`offset`/`limit`, for part of it). To see the current state, re-run the command or\n" +
	"re-read the file. Each costs one step, so do it only when the next step needs the content.\n" +
	"Never copy a placeholder into a new tool call.";

{
	const options = { sections: { other: "x" }, selectedTools: [] };
	const out = await f.fire("before_agent_start", { systemPrompt: "BASE", systemPromptOptions: options }, makeCtx());
	check("with sections: nothing is returned, so pi does not force the prompt", out, undefined);
	check("with sections: the explainer is the condensed_milk section; other sections stay", options.sections, { other: "x", condensed_milk: BODY });
	check("with sections: forceSystemPrompt stays unset", "forceSystemPrompt" in options, false);
	await f.fire("before_agent_start", { systemPrompt: "BASE", systemPromptOptions: options }, makeCtx());
	check("a second run sets the same bytes", options.sections.condensed_milk, BODY);
}
{
	const options = { sections: {}, forceSystemPrompt: "FORCED" };
	const out = await f.fire("before_agent_start", { systemPrompt: "FORCED", systemPromptOptions: options }, makeCtx());
	check("an earlier forced prompt: the explainer is appended to it", out, { systemPrompt: "FORCED\n\n" + BODY });
	check("an earlier forced prompt: no section is added", options.sections, {});
}
check("no systemPromptOptions (older pi): appended", await f.fire("before_agent_start", { systemPrompt: "BASE" }, makeCtx()), { systemPrompt: "BASE\n\n" + BODY });
check("options without sections: appended", await f.fire("before_agent_start", { systemPrompt: "BASE", systemPromptOptions: {} }, makeCtx()), { systemPrompt: "BASE\n\n" + BODY });

// The section name must pass pi's own check and render inside its tag.
{
	const { piNodeModules } = await import("./harness.mjs");
	const { pathToFileURL } = await import("node:url");
	const { join } = await import("node:path");
	const { existsSync } = await import("node:fs");
	// test-edit: the publish workflow installs pi-ai and jiti only, not pi-coding-agent.
	// Without pi this one check is skipped, and the line below says so.
	const file = join(await piNodeModules(), "@earendil-works", "pi-coding-agent", "dist", "core", "system-prompt.js");
	if (existsSync(file)) {
		const sp = await import(pathToFileURL(file).href);
		const options = { sections: {}, selectedTools: [], cwd: "/w" };
		await f.fire("before_agent_start", { systemPrompt: "", systemPromptOptions: options }, makeCtx());
		const text = sp.buildSystemPrompt(options);
		check("pi renders the section", text.includes(`<condensed_milk>\n${BODY}\n</condensed_milk>`), true);
	} else {
		console.log("SKIP: pi-coding-agent is not installed; 'pi renders the section' did not run");
	}
}

done();
