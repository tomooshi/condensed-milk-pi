/**
 * Spec (bug fix, 1.12.0): `cacheTtlSeconds` in ~/.config/condensed-milk.json
 * must survive session_start. 1.11.1 rebuilt `config` there without it, so
 * the idle trigger fell back to the model's promptCache and, with no model
 * value, never fired.
 * Set-up: the configured lifetime is 60 s, the model has no promptCache, the
 * last assistant message is 120 s old, and context usage is below every zone.
 * Expected: the idle advance enters zone 0 and masks the older results.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadTs, makeFakePi, makeCtx, makeRunner, isolateHome, assistantCall, toolResult, userMsg, textOf } from "./harness.mjs";

const { check, done } = makeRunner("1.12.0 fix: cacheTtlSeconds survives session_start");
const home = isolateHome();
mkdirSync(join(home, ".config"), { recursive: true });
writeFileSync(join(home, ".config", "condensed-milk.json"), JSON.stringify({ thresholds: [0.3, 0.45, 0.6], coverage: [0.6, 0.8, 0.95], cacheTtlSeconds: 60 }));
const ext = (await loadTs("index.ts")).default;

const NOW = 1_800_000_000_000;
const old = NOW - 120_000;
const history = [userMsg("go", old)];
for (let i = 0; i < 20; i++) {
	history.push(assistantCall(`c${i}`, "bash", { command: `cat f${i}` }, old));
	history.push(toolResult(`c${i}`, "bash", `${"r".repeat(5_000)}${i}`));
}
history.push({ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: old });

const { pi, fire } = makeFakePi();
ext(pi);
await fire("session_start", { reason: "startup" }, makeCtx());
const realNow = Date.now;
Date.now = () => NOW;
const out = await fire("context", { messages: history }, makeCtx({ tokens: 10_000, model: { id: "no-cache-info", contextWindow: 1_000_000 } }));
Date.now = realNow;
const masked = (out?.messages ?? history).filter((m) => m.role === "toolResult" && textOf(m).startsWith("[cm-masked")).length;
check("the idle advance masks older results with the configured lifetime", masked > 0, true);

done();
