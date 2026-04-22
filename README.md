# 🥛 Condensed Milk

**Semantic token compression for [pi terminal](https://github.com/badlogic/pi-mono).** Cuts LLM token consumption by compressing bash tool output and retroactively shrinking stale conversation history.

Inspired by [ztk](https://github.com/codejunkie99/ztk) (Zig) and [RTK](https://github.com/rtk-ai/rtk) (Rust) — standalone CLI proxies for Claude Code — rebuilt as a native pi extension using `tool_result` post-processing and pi's `context` event. ANSI stripping, linter aggregation, and grep grouping techniques adapted from [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) by MasuRii. This architecture gives Condensed Milk capabilities that standalone proxies structurally cannot have.

## What It Does

### Tool Result Compression

Intercepts bash command output before the model sees it and applies semantic compression — not blind truncation but domain-aware filters that preserve meaning while dropping noise.

| Command | Before | After | Savings |
|---------|--------|-------|---------|
| `python -m pytest` | 50+ lines of progress dots, headers, timing | `pytest: 125 passed, 15 skipped in 5.6s` | ~95% |
| `git status` | Branch info, staging area, working tree | `on main: 3 staged, 2 modified [file1, file2]` | ~75% |
| `git diff` (large) | Full patch with metadata headers | Changed lines only, context collapsed | ~70% |
| `git log` (verbose) | Author/Date/body per commit | `hash subject` per commit | ~80% |
| `git add/commit/push` | Transfer progress, CRLF warnings | `ok abc1234` | ~90% |
| `ls -la` (>20 files) | Permission bits, dates, owners | Extension counts + first 10 names | ~80% |
| `find` (>30 results) | Full path listing | Dir/type summary + first 15 paths | ~70% |
| `grep/rg` (>30 matches) | All matches | File summary + first 10 matches | ~65% |
| `tree` | Full tree with noise dirs | Stripped `.git/node_modules/.venv/__pycache__` | ~50-90% |
| `env` | All variables, secrets in plain text | Secrets masked, values truncated | ~60% + security |
| Python traceback | Full stack trace | First 2 + last 2 frames + exception | ~50% |
| `tsc` | Verbose TS errors | Grouped by file, 3 samples each | ~60% |
| Log output | Repeated lines with timestamps | Collapsed to `line [xN]` | Variable |
| JSON output (>1KB) | Full values, deeply nested | Keys + types + array lengths | ~80% |

**Log dedup normalization** (from RTK): UUIDs, hex addresses, and large numbers are normalized before dedup matching, so lines differing only in request IDs or memory addresses collapse together.

### Context Retroactive Compression (v1.6.0: static-cutoff masking + cwd-aware invalidation)

The killer feature that standalone proxies **cannot** do.

Pi's `context` event fires before every LLM call with a deep copy of the conversation history. Condensed Milk retroactively masks old tool results so the model sees a short deterministic placeholder instead of the original payload.

**Algorithm (v1.2.0+ static cutoff, ADR-018):** a cutoff index T advances only when context usage crosses a pressure threshold. Between advances T is immutable — bytes before T stay byte-identical turn-over-turn — cache prefix stable. Defaults: thresholds `[0.20, 0.35, 0.50]` of context used, coverage `[0.50, 0.75, 0.90]` of messages masked at each zone.

**Placeholders (v1.9.0, ADR-029):**

- `[cm-masked bash] <command truncated to 80 chars>` — for bash results
- `[cm-masked read] <path> (N lines, SIZE)` — for read results (v1.4.0: size metadata helps the model decide whether to re-read)

The `cm-` prefix brands the placeholder as a condensed-milk artifact so fresh agents (e.g. parachuted in via `context_checkout`) don't misread them as tool failures. v1.9.0 also appends a constant explainer to every turn's system prompt via `before_agent_start` so looping agents always know that `[cm-masked …]` means "re-run or re-read to get current content" — cache-stable (same bytes every turn) and amortized across the session regardless of how many items are masked. Legacy `[masked …]` placeholders in pre-v1.9.0 session files are still recognized by `/compress-stats` via back-compat prefix match.

**Reference files are never masked.** v1.6.0 protects by basename set (`AGENTS.md`, `CONVENTIONS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, `README.md`, `CHANGELOG.md`, `package.json`, `tsconfig.json`, `pyproject.toml`, `biome.json`, etc.) *and* by path substrings (`/knowledge/decisions/`, `/knowledge/concepts/`, `/knowledge/patterns/`, `/.pi/agent/skills/`, `/.pi/skills/`, `/rules/`). Add your own via config — see [Configuration](#configuration).

**Command invalidation fires immediately, regardless of cutoff.** Built-in rules:

- `git {add,rm,checkout,reset,stash,merge,rebase,cherry-pick}` invalidates earlier `git status`
- `git {commit,merge,rebase}` invalidates earlier `git diff` / `git log`
- `{npm,pnpm,yarn,bun} {install,add,remove}` invalidates earlier `{ls,list,outdated}`
- `pip install` invalidates earlier `pip {list,freeze}`

**v1.6.0 cwd-awareness:** invalidation now strips `cd <path> &&` prefix before matching, then scopes by cwd tuple. A commit in `/repoA` will NOT spuriously invalidate `git status` output that was actually run in `/repoB`. Single-cwd sessions behave identically to before (both cwds undefined → treated as same scope).

**Add your own invalidation rules via config** (see [Configuration](#configuration)) — useful for stacked-diff tools like `gt` / `jj` / `spr` that aren't matched by built-in git rules.

**Why masking over summarization** (per JetBrains Research Dec 2025 and Anthropic's own engineering guide):

- Byte-identical placeholders produce a **single cache miss per tool-result lifetime**, then the cache stays warm. Summaries changed bytes every turn → repeated cache misses.
- JetBrains empirical result: masking matches or beats LLM-style summarization on solve rate, -52% cost on Qwen3-Coder 480B.
- Summaries cause "trajectory elongation" (+13-15% more turns) by smoothing over stop-signals. Masks don't.
- The agent can re-read files or re-run commands if it needs the content again — just-in-time pattern endorsed by Anthropic. Masks preserve the command / file path so the agent knows what to re-fetch.

**Measured result** on a 926-message real session at defaults: 42 cache variants, static cutoff yields ~$0.10 vs ≈$0.19 with no cache — ≈47% cost reduction, and prefix stays stable across full session length.

### Compound Command Handling

Real-world commands are chains:

```bash
source .venv/bin/activate && python -m pytest -q 2>&1 | tail -3 && ruff check src/
```

The dispatcher splits on `&&`/`||`/`;`, strips pipe tails (`| head`, `| tail`, `| wc`), cleans env vars and redirects, then matches each segment against registered filters. Last matching segment wins (it produced the output).

**Multi-producer guard (v1.9.0, ADR-030).** If the compound has ≥ 2 *non-silent* segments (anything not in the allowlist `cd / export / set / unset / source / . / true / false / :`), prefix filters are skipped and the raw stdout passes through. Otherwise a filter matching the tail segment would be handed the combined stdout of every prior command and parse it as if it were its own format — the symptom was `cd repo && git init && git add -A && git status --short | head -10 && echo "..." && git status --short | wc -l` collapsing to `on unknown: clean`. Content-based fallbacks (JSON etc.) still run. Single-segment compounds like `cd repo && git status` are unaffected (one non-silent segment).

### Secret Masking

The `env`/`printenv` filter masks values for keys containing `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `API`, `AUTH`, or `CREDENTIAL`. This prevents API keys and secrets from entering the LLM context window.

## Install

### Recommended: via `pi install` (pi package manager)

```bash
pi install npm:@tomooshi/condensed-milk-pi
```

Registers the package in `~/.pi/agent/settings.json` and auto-loads on every session. Updatable with `pi update`, removable with `pi remove npm:@tomooshi/condensed-milk-pi`.

### Alternative: raw npm install

```bash
npm i -g @tomooshi/condensed-milk-pi
```

Works if your pi setup autoloads global npm modules. Reload pi (Ctrl+R) or restart.

### Alternative: clone-and-symlink (for local hacking)

```bash
git clone https://github.com/tomooshi/condensed-milk-pi.git ~/condensed-milk-pi
ln -s ~/condensed-milk-pi ~/.pi/agent/extensions/condensed-milk
```

Use this when you want to modify the source yourself — pi will auto-discover the symlink and hot-reload via `/reload`.

### Verify

```bash
npm ls -g @tomooshi/condensed-milk-pi
```

Confirms the installed version. After install, run `/compress-stats` inside pi — you should see a `Re-read Telemetry` block. Telemetry shape is stable since v1.4.0 so the header doesn't bump per minor version; the installed `package.json` version is the source of truth.

## Usage

The extension works automatically — no configuration needed. Every bash command the model runs goes through the compression pipeline, and retroactive masking activates on its own once context pressure crosses the first threshold.

### Commands

| Command | Description |
|---------|-------------|
| `/compress-stats` | Show compression + masking statistics for the current session, including re-read telemetry (v1.4.0) |
| `/compress-config` | Show or update thresholds/coverage (`thresholds 0.15,0.30,0.45`, `coverage 0.5,0.75,0.9`) |

### Status Bar

Shows a running total: `↓12.5KB saved (15/42 cmds, 68%)`

## Configuration

Two config files, two different concerns, both optional.

### 1. Cutoff behavior — `~/.config/condensed-milk.json`

Controls when and how aggressively masking fires. Single source of truth for cache stability (no project-local overrides — intentional).

```json
{
  "thresholds": [0.30, 0.45, 0.60],
  "coverage":   [0.60, 0.80, 0.95]
}
```

v1.8.0 auto-migrates configs matching any recognized prior default tuple (e.g. v1.6.x `[0.20, 0.35, 0.50] × [0.50, 0.75, 0.90]`) to the current recommended values on next session start. Customizations (any non-matching tuple) are preserved.

| Field | Meaning |
|---|---|
| `thresholds` | Context-usage fractions (0..1) that trigger cutoff advancement. Monotonically increasing. |
| `coverage` | Fraction of messages masked when each threshold fires. Same length as `thresholds`. |

Also editable via `/compress-config`. Changes take effect on next session.

### 2. Telemetry (opt-in, local-only) — `~/.config/condensed-milk-sessions.jsonl`

**Default: off. Never enabled without your explicit action.**

condensed-milk can optionally log one JSONL line per session to the file above
on graceful shutdown. The data feeds an upcoming per-user threshold adapter.
It stays on your machine — nothing is uploaded, automatically or otherwise.

**What's recorded per session:** session duration, final turn count, pressure
zones entered (turn + context% at each), tool-call counts by type, mask
statistics, thresholds and coverage in use, cache hit rate, total tokens by
bucket, condensed-milk version, and sha256-truncated (16-char) hashes of the
session path and cwd.

**What's NOT recorded:** any message or tool output content, file paths or
tool inputs (only hashes), environment variables, API keys, or identity info.

**Three ways to opt in:**

```
/compress-telemetry enable-local-logging    # slash command (verbose verb is deliberate)
export CONDENSED_MILK_TELEMETRY=on          # env var
```

Or add `{"telemetry": {"local": true}}` to `~/.config/condensed-milk.json`
(merged with your existing cutoff config).

**Control:**

```
/compress-telemetry                        # show status + full disclosure
/compress-telemetry enable-local-logging   # opt in
/compress-telemetry disable                # opt out
/compress-telemetry export                 # write a timestamped copy to ~/ for manual sharing
cat ~/.config/condensed-milk-sessions.jsonl | jq   # view raw
rm ~/.config/condensed-milk-sessions.jsonl         # delete local log
```

If you want to help improve defaults, you can review the file and send it to
the author manually. No automated upload path exists — by design.

### 3. Rules — `~/.pi/agent/condensed-milk-config.json` (global) + `./condensed-milk.config.json` (project-local)

Custom reference files and invalidation rules. Both files optional; when both exist they merge additively (project-local extends global).

**Full schema with all fields:**

```json
{
  "referenceBasenames": ["FILENAME.md", "spec.yaml"],
  "referencePathSubstrings": ["/my-specs/", "/docs/adr/"],
  "invalidationRules": [
    {
      "invalidator": "^cargo\\s+(build|update)\\b",
      "invalidated": "^cargo\\s+(check|clippy)\\b"
    }
  ],
  "disableDefaults": false
}
```

| Field | Type | Purpose |
|---|---|---|
| `referenceBasenames` | `string[]` | File basenames (no path) that should never be masked. Matched against `path.split("/").pop()`. |
| `referencePathSubstrings` | `string[]` | Any file whose path contains one of these substrings is protected. Good for "all files under this directory". |
| `invalidationRules` | `{invalidator, invalidated}[]` | Each rule is a pair of regex source strings (NOT compiled `/regex/` literals — plain strings). When an `invalidator` command runs later, it invalidates earlier matching `invalidated` commands in the same cwd. |
| `disableDefaults` | `boolean` | If `true`, your arrays *replace* the built-ins instead of extending them. Default `false`. |

**Regex notes:**

- Strings are passed to `new RegExp(...)`. Escape backslashes once: `"^git\\s+status"`, not `/^git\s+status/`.
- Matching runs against the `cd`-stripped command. So your `invalidator` should match the bare tool invocation, not `cd /repo && tool ...`.
- Invalidation only fires when both commands have the same cwd (both set to the same path, or both unset — the common single-cwd case).

**Example 1 — add a custom spec-file protection:**

Project uses OpenAPI specs under `./openapi/` that should stay inline all session.

```json
{
  "referencePathSubstrings": ["/openapi/"]
}
```

**Example 2 — add Graphite / stacked-diff invalidation:**

Graphite's `gt submit`, `gt up`, `gt down` change git state but don't match built-in `^git` rules.

```json
{
  "invalidationRules": [
    { "invalidator": "^gt\\s+(up|down|submit|checkout|sync|restack)\\b", "invalidated": "^git\\s+(status|diff|log)\\b" },
    { "invalidator": "^gt\\s+(create|modify|commit|absorb)\\b",          "invalidated": "^git\\s+(status|diff|log)\\b" }
  ]
}
```

**Example 3 — language-specific build invalidation:**

```json
{
  "invalidationRules": [
    { "invalidator": "^cargo\\s+(build|update|add|remove)\\b", "invalidated": "^cargo\\s+(check|clippy|test)\\b" },
    { "invalidator": "^go\\s+(get|mod)\\b",                    "invalidated": "^go\\s+(build|test|vet)\\b" },
    { "invalidator": "^zig\\s+build\\b",                       "invalidated": "^zig\\s+(test|run)\\b" }
  ]
}
```

**Example 4 — replace defaults entirely (advanced):**

```json
{
  "disableDefaults": true,
  "referenceBasenames": ["MY-AGENT.md"],
  "referencePathSubstrings": ["/my-project/docs/"],
  "invalidationRules": [
    { "invalidator": "^mytool\\s+update\\b", "invalidated": "^mytool\\s+status\\b" }
  ]
}
```

**Failure modes (intentional fail-loud):**

- File missing (ENOENT): silently skipped. Optional by design.
- Permission denied / other IO error: throws at extension load — pi will surface the error.
- Invalid JSON: throws with the file path in the error message. Fix the file or delete it.

**Config precedence:**

For a given setting, effective value = `defaults` ++ `global file` ++ `project-local file`, with `disableDefaults: true` anywhere removing the `defaults` tier. Arrays concatenate (don't de-duplicate — duplicates are cheap to iterate).

**Cache-safety guarantee:**

Expanding protection (adding referenceBasenames / referencePathSubstrings) only *reduces* the masked set; it never changes placeholder bytes for already-masked items. Adding invalidation rules can only *mask more* bash results, but masking is still deterministic per message — prefix stability holds. You cannot break cache economics via config.

## Architecture

```
condensed-milk/
├── index.ts                    # Extension entry — tool_result + context hooks
├── filters/
│   ├── dispatch.ts             # Command matching + compound splitting
│   ├── pytest.ts               # pytest/python -m pytest
│   ├── git-status.ts           # git status (porcelain v1/v2/plain)
│   ├── git-diff.ts             # git diff (strip headers, condense context)
│   ├── git-mutations.ts        # git add/commit/push
│   ├── git-log.ts              # git log (verbose → hash subject)
│   ├── file-ops.ts             # ls, find, grep, rg
│   ├── tree.ts                 # tree (strip noise dirs)
│   ├── env.ts                  # env/printenv (mask secrets)
│   ├── python-traceback.ts     # Python crash output
│   ├── log-dedup.ts            # journalctl, tail, docker logs, tmux
│   ├── tsc.ts                  # TypeScript compiler
│   ├── json-schema.ts          # JSON structure extraction (content-based)
│   └── context-compress.ts     # Retroactive context compression
└── package.json
```

### How It Works

1. **`tool_result` hook** — runs after pi's built-in 50KB truncation, before the model sees the output. Matches the command against registered filters and returns compressed content. Deterministic per input, cache-safe.

2. **`context` event hook** — runs before each LLM API call on a `structuredClone` of the conversation history (pi-mono guarantees non-destructive). Applies observation masking to tool results outside the rolling window. Placeholders are byte-identical across turns, so BP2 (last-user-message breakpoint) stabilizes after one miss per tool result.

3. **Filter dispatch** — splits compound commands, strips pipes/redirects/env vars, and matches against registered filter prefixes. Longest prefix wins. Filters return `null` to decline (output passes through unchanged).

### Adding Filters

```typescript
import { registerFilter, type FilterResult } from "./dispatch.js";

function filterMyCommand(input: string): FilterResult | null {
  if (input.length === 0) return null;
  // Your compression logic here
  return { output: "compressed", category: "fast" };
}

registerFilter("my-command", filterMyCommand, "fast");
```

Categories: `"fast"` (ls, grep), `"medium"` (test runners), `"slow"` (git log), `"immutable"` (never changes), `"mutation"` (git add/commit/push).

## What's NOT Supported

These filters exist in [ztk](https://github.com/codejunkie99/ztk) but are intentionally not ported:

| Filter | Why not |
|--------|---------|
| `cat` / file content | **Harmful for coding agents.** The model needs full file content to write correct edits. Stripping function bodies breaks line numbers. |
| `cargo test/build` | Rust stack — add if you need it |
| `go test` | Go stack — add if you need it |
| `zig build/test` | Zig stack — add if you need it |
| `kubectl`, `docker` | Container orchestration — add if you need it |
| `gh` (GitHub CLI) | Low frequency |
| `curl` JSON schema | Too risky — model often needs actual values |
| `make`, `terraform`, `helm`, `gradle`, `mvn`, `dotnet`, etc. | 25 regex-based runtime filters for stacks we don't use. See ztk for patterns. |
| Session dedup (mmap) | Context retroactive compression handles this more effectively |

**Contributing stack-specific filters is welcome.** The dispatch system is designed for easy extension — register a prefix and a function.

## vs ztk and RTK

| | [ztk](https://github.com/codejunkie99/ztk) | [RTK](https://github.com/rtk-ai/rtk) | Condensed Milk |
|---|-----|-----|----------------|
| Language | Zig | Rust | TypeScript |
| Target | Claude Code | Claude Code | pi terminal |
| Architecture | Standalone binary, PreToolUse hook | Standalone binary, PreToolUse hook | Native extension, tool_result + context hooks |
| Context compression | ❌ | ❌ | ✅ Retroactively compresses stale results (**biggest savings**) |
| Read compression | ❌ | ✅ Language-aware file filtering | ✅ Smart file-ops-aware staleness (keeps files being edited) |
| Secret masking | ❌ | ❌ | ✅ env filter masks API keys/tokens/passwords |
| JSON structure | ❌ | ✅ Schema extraction | ✅ Content-based schema extraction |
| Session dedup | ✅ mmap shared memory | ❌ | Unnecessary (context compression subsumes it) |
| Code filtering | ✅ Strips function bodies | ✅ 3 filter levels (None/Minimal/Aggressive) | ❌ Intentionally — harmful for coding agents |
| TOML filter DSL | ❌ | ✅ 60+ declarative filters | ❌ All filters are code |
| Log normalization | Timestamps only | ✅ UUIDs, hex, numbers, paths | ✅ UUIDs, hex, numbers (from RTK) |
| Adaptive learning | ❌ | ✅ Mistake detection + suggestions | ❌ |
| Analytics | ❌ | ✅ Rich per-day/week/month + API cost | Basic session stats in status bar |
| Traceback compression | ❌ | ❌ (pytest only) | ✅ Generic Python traceback (first 2 + last 2 frames) |
| Performance | ⚡ Zig + SIMD | ⚡ Rust | Fast enough (TypeScript on <50KB post-truncation) |
| Stack coverage | Broad (Rust, Go, Zig, Docker, K8s) | Very broad (60+ TOML filters) | Python/TypeScript/Git focused |
| Install | Homebrew / zig build | Homebrew / cargo install | `pi install npm:@tomooshi/condensed-milk-pi` or `npm i -g @tomooshi/condensed-milk-pi` |

### Where Condensed Milk wins

- **Context retroactive compression** — ztk and RTK are standalone proxies that only see output once. Condensed Milk compresses stale tool results in conversation history before each LLM call. This saved **1.4MB in a single session** — more than all tool-result filters combined.
- **Smart read staleness** — tracks file operations across the session. Keeps reads where the file was subsequently edited (model is working on it). Compresses old exploratory reads.
- **Python traceback compression** — generic crash output compression (first 2 + last 2 frames + exception). RTK only has pytest-specific filtering. Handles Python 3.13 pointer lines.
- **Secret masking** — prevents API keys from entering the LLM context sent to Anthropic.
- **Compound command dispatch** — handles `source && pytest | tail` chains that real coding sessions produce.

### Where RTK wins

- **Breadth** — 60+ TOML filters covering Rust, Go, .NET, Ruby, Docker, K8s, Terraform, Ansible, and more.
- **TOML DSL** — declarative filter definitions with `strip_lines_matching`, `match_output`, `max_lines`, and inline tests.
- **Adaptive learning** — watches for repeated CLI mistakes and suggests corrections.
- **Analytics** — rich per-day/week/month reporting with API cost integration.
- **File read filtering** — language-aware comment/import stripping (though we consider this harmful for coding agents).

## Measured Results

From a real coding session:

```
Token Compressor Stats
  Commands processed: 42
  Commands compressed: 15
  Original: 11.0KB → Compressed: 4.8KB (56% saved)
  Context retroactive: 1.4MB saved (8 compressions)
```

The context retroactive compression is the dominant savings — **1.4MB in one session** from compressing stale file reads and old command outputs.

## License

MIT
