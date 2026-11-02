/**
 * Probe helper: write every provider request and every finished assistant
 * message to JSONL files, for providers whose debug log does not capture the
 * payload (OpenRouter, vLLM). Observes only; changes nothing.
 *   CM_PROBE_PAYLOAD_LOG  one line per request: the payload as sent
 *   CM_PROBE_MESSAGE_LOG  one line per assistant message: stop reason, error, usage, dropped thinking
 */
import { appendFileSync } from "node:fs";

export default function (pi: any) {
	pi.on("before_provider_request", (event: any) => {
		const path = process.env.CM_PROBE_PAYLOAD_LOG;
		if (path) appendFileSync(path, JSON.stringify(event.payload) + "\n");
		return undefined;
	});
	pi.on("message_end", (event: any) => {
		const m = event.message;
		const path = process.env.CM_PROBE_MESSAGE_LOG;
		if (!path || m?.role !== "assistant") return undefined;
		const drops = (m.diagnostics ?? []).flatMap((d: any) => (d?.details?.transformations ?? []).filter((t: any) => t?.type === "thinking_dropped").map((t: any) => t.path));
		appendFileSync(path, JSON.stringify({ stopReason: m.stopReason, error: m.errorMessage ?? null, usage: m.usage ?? null, drops, calls: (m.content ?? []).filter((c: any) => c?.type === "toolCall").map((c: any) => ({ name: c.name, command: String(c.arguments?.command ?? c.arguments?.path ?? "").slice(0, 80) })) }) + "\n");
		return undefined;
	});
}
