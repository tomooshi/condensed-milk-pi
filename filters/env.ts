/**
 * env/printenv output filter.
 *
 * Masks sensitive values (KEY, SECRET, TOKEN, PASSWORD, API, AUTH, CREDENTIAL).
 * Truncates long values to 50 chars. Caps at 50 vars.
 * Security benefit: prevents API keys from entering LLM context.
 */
import { registerFilter, type FilterResult } from "./dispatch.js";

const SENSITIVE_PATTERNS = ["KEY", "SECRET", "TOKEN", "PASSWORD", "PASS", "API", "AUTH", "CREDENTIAL", "PRIVATE"];

function filterEnv(input: string): FilterResult | null {
  if (input.length === 0) return null;

  const lines = input.split("\n");
  const out: string[] = [];
  let count = 0;

  for (const line of lines) {
    if (line.length === 0) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;

    if (count >= 50) {
      out.push(`[+${lines.filter((l) => l.includes("=")).length - 50} more env vars]`);
      break;
    }

    const key = line.slice(0, eq);
    const val = line.slice(eq + 1);

    if (isSensitive(key)) {
      out.push(`${key}=<masked>`);
    } else {
      const truncated = val.length > 50 ? val.slice(0, 50) + "..." : val;
      out.push(`${key}=${truncated}`);
    }
    count++;
  }

  const result = out.join("\n");
  // sensitive: the raw text holds the secrets this filter masks (CM-ADR-002 §2).
  return result.length < input.length ? { output: result, category: "fast", sensitive: true } : null;
}

function isSensitive(key: string): boolean {
  const upper = key.toUpperCase();
  return SENSITIVE_PATTERNS.some((p) => upper.includes(p));
}

registerFilter("env", filterEnv, "fast");
registerFilter("printenv", filterEnv, "fast");
