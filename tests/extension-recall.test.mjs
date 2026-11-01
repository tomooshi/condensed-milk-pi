/**
 * CM-ADR-001/002 spec, extension wiring: the cm_recall tool, the explainer,
 * raw text in details, and read-only recall from another session file.
 * Drives the real index.ts through a fake pi with HOME and
 * PI_CODING_AGENT_DIR in a temp dir.
 */
import { writeFileSync, mkdirSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { loadTs, makeFakePi, makeCtx, makeRunner, assistantCall, toolResult, userMsg, entriesFor, isolateHome } from "./harness.mjs";

const { check, done } = makeRunner("CM-ADR-001/002 extension: recall wiring");
const home = isolateHome();
const agentDir = join(home, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
// CM-ADR-001 amendment: the id key is toolCallId + "\0" + timestamp; the builders use timestamp 0.
const sid = (s, ts = 0) => createHash("sha1").update(`${s}\u0000${ts}`).digest("hex").slice(0, 10);
const ext = (await loadTs("index.ts")).default;
const { pi, tools, fire } = makeFakePi();
ext(pi);
await fire("session_start", { reason: "startup" }, makeCtx());
const tool = tools.get("cm_recall");
const textOfResult = (r) => r.content.map((c) => c.text).join("\n");
const bodyOf = (r) => { const t = textOfResult(r); return t.slice(t.indexOf("\n\n") + 2); };

// registration and explainer
check("cm_recall is registered", tool?.name, "cm_recall");
check("cm_recall parameters", Object.keys(tool.parameters.properties).sort(), ["grep", "id", "limit", "match", "offset", "raw", "session"]);
const EXPLAINER = "\n\ncondensed-milk: old tool results can appear as `[cm-masked bash|read|recall #id] …`\n" +
	"to keep the prompt cache stable. To see one exactly as it was first shown, call\n" +
	"`cm_recall` with the id (add `grep`, or `offset`/`limit`, for part of it). To see the\n" +
	"current state, re-run the command or re-read the file. Each costs one step, so do it\n" +
	"only when the next step needs the content.";
check("explainer bytes", (await fire("before_agent_start", { systemPrompt: "BASE" }, makeCtx())).systemPrompt, "BASE" + EXPLAINER);

// raw text in details
const JSON_OUT = JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item-${i}`, tags: ["a", "b"] })) });
{
	const ret = await fire("tool_result", {
		toolName: "bash", toolCallId: "j1", input: { command: "curl -s http://x/api" },
		content: [{ type: "text", text: JSON_OUT }], details: { truncation: null, fullOutputPath: "/tmp/full.txt" }, isError: false,
	}, makeCtx());
	check("a filter changed the output", ret.content[0].text === JSON_OUT, false);
	check("details keep pi's fields and add raw", ret.details, { truncation: null, fullOutputPath: "/tmp/full.txt", condensedMilk: { raw: JSON_OUT } });
	const ENV_OUT = Array.from({ length: 10 }, (_, i) => `VAR_${i}=${"v".repeat(60)}`).join("\n") + "\nOPENAI_API_KEY=sk-supersecret-value-123";
	const env = await fire("tool_result", {
		toolName: "bash", toolCallId: "v1", input: { command: "env" }, content: [{ type: "text", text: ENV_OUT }], details: undefined, isError: false,
	}, makeCtx());
	check("env withholds raw text", env.details, { condensedMilk: { rawWithheld: "secret" } });
	check("the secret is nowhere in the env result", JSON.stringify(env).includes("supersecret"), false);
	const plain = await fire("tool_result", {
		toolName: "bash", toolCallId: "p1", input: { command: "echo hi" }, content: [{ type: "text", text: "x".repeat(200) }], details: undefined, isError: false,
	}, makeCtx());
	check("unfiltered output is not changed", plain, undefined);
}

// recall in the current session
const STATUS = "On branch main\n" + Array.from({ length: 20 }, (_, i) => `\tmodified: src/f${i}.ts`).join("\n");
const hist = [
	userMsg("go"),
	assistantCall("g1", "bash", { command: "git status" }), toolResult("g1", "bash", STATUS),
	assistantCall("j1", "bash", { command: "curl -s http://x/api" }), toolResult("j1", "bash", "JSON object {items: array[40]}", { details: { condensedMilk: { raw: JSON_OUT } } }),
	{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0 },
];
const ctx = makeCtx({ entries: entriesFor(hist) });
{
	const r = await tool.execute("k1", { id: sid("g1") }, undefined, undefined, ctx);
	check("recall by id: no error", Boolean(r.isError), false);
	check("recall by id: original bytes", bodyOf(r), STATUS);
	check("recall by id: header", textOfResult(r).split("\n")[0], `[cm-recall #${sid("g1")}] bash: git status — original output as first shown, 2 turns ago, not the current state.`);
	check("recall raw", bodyOf(await tool.execute("k2", { id: sid("j1"), raw: true }, undefined, undefined, ctx)), JSON_OUT);
	check("recall by match", textOfResult(await tool.execute("k3", { match: "curl" }, undefined, undefined, ctx)).includes(`#${sid("j1")}`), true);
	const bad = await tool.execute("k4", { id: "0000000000" }, undefined, undefined, ctx);
	check("unknown id is an error", bad.isError, true);
	check("unknown id message", textOfResult(bad).startsWith("cm_recall: no tool result #0000000000"), true);
}

// recall from another session file (read-only)
{
	const dir = join(agentDir, "sessions", "--tmp-project--");
	mkdirSync(dir, { recursive: true });
	const uuid = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
	const file = join(dir, `2026-11-01T00-00-00-000Z_${uuid}.jsonl`);
	const FAIL = "FAILED test_x - AssertionError\n" + "y".repeat(300);
	const other = [userMsg("prev"), assistantCall("p1", "bash", { command: "pytest -q" }), toolResult("p1", "bash", FAIL), { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 0 }];
	const header = { type: "session", version: 3, id: uuid, timestamp: "2026-11-01T00:00:00.000Z", cwd: "/tmp/project" };
	writeFileSync(file, [header, ...entriesFor(other)].map((e) => JSON.stringify(e)).join("\n") + "\n" + '{"type":"mess');
	const before = { bytes: readFileSync(file).toString("base64"), mtime: statSync(file).mtimeMs };
	const byId = await tool.execute("k5", { session: uuid, id: sid("p1") }, undefined, undefined, makeCtx());
	check("session by id: no error", Boolean(byId.isError), false);
	check("session by id: original bytes", bodyOf(byId), FAIL);
	check("session by id: header names the session", textOfResult(byId).split("\n")[0].endsWith(` From session ${uuid}.`), true);
	const byPath = await tool.execute("k6", { session: file, match: "pytest" }, undefined, undefined, makeCtx());
	check("session by path: match finds the id", textOfResult(byPath).includes(`#${sid("p1")}`), true);
	check("the session file bytes did not change", readFileSync(file).toString("base64"), before.bytes);
	check("the session file mtime did not change", statSync(file).mtimeMs, before.mtime);

	const outside = join(mkdtempSync(join(tmpdir(), "cm-outside-")), `x_${uuid}.jsonl`);
	writeFileSync(outside, readFileSync(file));
	const out = await tool.execute("k7", { session: outside, id: sid("p1") }, undefined, undefined, makeCtx());
	check("a file outside the sessions dir is refused", textOfResult(out).startsWith("cm_recall: session file must be inside "), true);
	check("refusal is an error", out.isError, true);
	const missing = await tool.execute("k8", { session: "0199aaaa-0000-7000-8000-000000000000", id: sid("p1") }, undefined, undefined, makeCtx());
	check("unknown session id", textOfResult(missing).startsWith(`cm_recall: no session file for id "0199aaaa-0000-7000-8000-000000000000"`), true);
	const junk = await tool.execute("k9", { session: "../etc/passwd", id: sid("p1") }, undefined, undefined, makeCtx());
	check("a session value that is neither id nor .jsonl", textOfResult(junk), `cm_recall: session must be a session id or a .jsonl path (got "../etc/passwd").`);
	const v2 = join(dir, "2026-01-01T00-00-00-000Z_0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002.jsonl");
	writeFileSync(v2, JSON.stringify({ ...header, version: 2 }) + "\n");
	const old = await tool.execute("k10", { session: v2, match: "x" }, undefined, undefined, makeCtx());
	check("an old session format is refused", textOfResult(old).endsWith("is session format version 2; cm_recall reads version 3."), true);
	const broken = join(dir, "2026-01-02T00-00-00-000Z_0199aaaa-bbbb-7ccc-8ddd-eeeeffff0003.jsonl");
	writeFileSync(broken, [JSON.stringify(header), "{not json", JSON.stringify(entriesFor(other)[0])].join("\n") + "\n");
	const bad = await tool.execute("k11", { session: broken, match: "x" }, undefined, undefined, makeCtx());
	check("a bad line in the middle is an error", textOfResult(bad).endsWith("line 2 is not valid JSON."), true);
}

done();
