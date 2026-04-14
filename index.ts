/**
 * Token Compressor — global pi extension.
 *
 * Intercepts bash tool results and applies semantic compression filters
 * to reduce LLM token consumption. Inspired by ztk (codejunkie99/ztk).
 *
 * Architecture: tool_result post-processor.
 * Pi's 50KB truncation runs first, then we compress the already-capped output.
 * Filters are registered by individual modules at import time.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dispatch, registeredCommands, registerContentFallback } from "./filters/dispatch.js";

// Import filter modules — each self-registers via registerFilter()
import "./filters/pytest.js";
import "./filters/git-status.js";
import "./filters/git-diff.js";
import "./filters/git-mutations.js";
import "./filters/git-log.js";
import "./filters/file-ops.js";
import "./filters/tree.js";
import "./filters/env.js";
import "./filters/python-traceback.js";
import "./filters/log-dedup.js";
import "./filters/tsc.js";
import { filterJsonOutput } from "./filters/json-schema.js";
import { compressStaleToolResults } from "./filters/context-compress.js";

export default function tokenCompressor(pi: ExtensionAPI) {
  // Register content-based fallback filters
  registerContentFallback("json", filterJsonOutput);

  // Subagents: compress too — they benefit from smaller output
  let totalOriginal = 0;
  let totalCompressed = 0;
  let compressedCount = 0;
  let totalCommands = 0;

  pi.on("session_start", async (_event, ctx) => {
    totalOriginal = 0;
    totalCompressed = 0;
    compressedCount = 0;
    totalCommands = 0;
    const cmds = registeredCommands();
    ctx.ui?.setStatus?.("token-savings", `↓0 (${cmds.length}f)`);
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    // Don't skip errors — traceback filter specifically targets error output

    const command = (event.input as { command?: string })?.command;
    if (!command) return;

    // Extract text content from tool result
    const textParts = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);
    const stdout = textParts.join("\n");

    if (stdout.length === 0) return;

    totalCommands++;

    // Try to compress
    const result = dispatch(command, stdout);
    if (!result) return;

    const saved = stdout.length - result.output.length;
    if (saved <= 0) return;

    totalOriginal += stdout.length;
    totalCompressed += result.output.length;
    compressedCount++;

    const totalSaved = totalOriginal - totalCompressed;
    const pct = totalOriginal > 0 ? Math.round((totalSaved / totalOriginal) * 100) : 0;
    _ctx.ui?.setStatus?.(
      "token-savings",
      `↓${formatBytes(totalSaved)} ${compressedCount}/${totalCommands} ${pct}%`,
    );

    const ret: Record<string, unknown> = {
      content: [{ type: "text" as const, text: result.output }],
    };
    if (event.isError) ret.isError = true;
    return ret;
  });

  // Context-level retroactive compression
  // Compresses old bash tool results before each LLM call
  let contextSaved = 0;
  let contextCompressions = 0;

  pi.on("context", async (event, _ctx) => {
    const compressed = compressStaleToolResults(event.messages);
    if (compressed) {
      // Track savings
      const originalLen = JSON.stringify(event.messages).length;
      const compressedLen = JSON.stringify(compressed).length;
      const saved = originalLen - compressedLen;
      if (saved > 0) {
        contextSaved += saved;
        contextCompressions++;
      }
      return { messages: compressed };
    }
  });

  // /compress-stats command
  pi.registerCommand("compress-stats", {
    description: "Show token compression statistics",
    handler: async (_args, ctx) => {
      const cmds = registeredCommands();
      const totalSaved = totalOriginal - totalCompressed;
      const pct = totalOriginal > 0 ? Math.round((totalSaved / totalOriginal) * 100) : 0;
      ctx.ui?.notify?.(
        [
          "Token Compressor Stats",
          `  Filters: ${cmds.join(", ")}`,
          `  Commands processed: ${totalCommands}`,
          `  Commands compressed: ${compressedCount}`,
          `  Original: ${formatBytes(totalOriginal)}`,
          `  Compressed: ${formatBytes(totalCompressed)}`,
          `  Saved: ${formatBytes(totalSaved)} (${pct}%)`,
          `  Context retroactive: ${formatBytes(contextSaved)} saved (${contextCompressions} compressions)`,
        ].join("\n"),
        "info",
      );
    },
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
