# 🥛 Condensed Milk

**Semantic token compression for [pi terminal](https://github.com/badlogic/pi-mono).** Cuts LLM token consumption by compressing bash tool output and retroactively shrinking stale conversation history.

Inspired by [ztk](https://github.com/codejunkie99/ztk) (Zig) and [RTK](https://github.com/rtk-ai/rtk) (Rust) — standalone CLI proxies for Claude Code — rebuilt as a native pi extension using `tool_result` post-processing and pi's `context` event. ANSI stripping, linter aggregation, and grep grouping techniques adapted from [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) by MasuRii. This architecture gives Condensed Milk capabilities that standalone proxies structurally cannot have.

## What It Does

### Tool Result Compression

Intercepts bash command output before the model sees it and applies semantic compression — not blind truncation but domain-aware filters that preserve meaning while dropping noise.

**ANSI escape codes are stripped from ALL bash output** before any other filter runs — zero information loss, pure token savings.

| Command | Before | After | Savings |
|---------|--------|-------|---------|
| `python -m pytest` | 50+ lines of progress dots, headers, timing | `pytest: 125 passed, 15 skipped in 5.6s` | ~95% |
| `git status` | Branch info, staging area, working tree | `on main: 3 staged, 2 modified [file1, file2]` | ~75% |
| `git diff` (large) | Full patch with metadata headers | Changed lines only, context collapsed | ~70% |
| `git log` (verbose) | Author/Date/body per commit | `hash subject` per commit | ~80% |
| `git add/commit/push` | Transfer progress, CRLF warnings | `ok abc1234` | ~90% |
| `ls -la` (>20 files) | Permission bits, dates, owners | Extension counts + first 10 names | ~80% |
| `find` (>30 results) | Full path listing | Dir/type summary + first 15 paths | ~70% |
| `grep/rg` (>15 matches) | All matches | Grouped by file, match counts, lines truncated to 70 chars | ~65% |
| `eslint/ruff/mypy/pylint` | Verbose per-file errors | Error/warning counts, top rules, top files | ~70% |
| `cargo build/npm run build/make` | Compiling, Downloading, Linking noise | Errors + warnings + summary only | ~80% |
| `vitest/jest/mocha/cargo test/go test` | Progress dots, setup noise | Pass/fail/skip counts + failure details | ~85% |
| `npm install/pnpm install/pip install` | Resolution, download, deprecation warnings | Summary line + errors only | ~90% |
| `tree` | Full tree with noise dirs | Stripped `.git/node_modules/.venv/__pycache__` | ~50-90% |
| `env` | All variables, secrets in plain text | Secrets masked, values truncated | ~60% + security |
| Python traceback | Full stack trace | First 2 + last 2 frames + exception | ~50% |
| `tsc` | Verbose TS errors | Grouped by file, 3 samples each | ~60% |
| Log output | Repeated lines with timestamps | Collapsed to `line [xN]` | Variable |
| JSON output (>1KB) | Full values, deeply nested | Keys + types + array lengths | ~80% |

**Log dedup normalization** (from RTK): UUIDs, hex addresses, and large numbers are normalized before dedup matching, so lines differing only in request IDs or memory addresses collapse together.

### Context Retroactive Compression

The killer feature that standalone proxies **cannot** do.

Pi's `context` event fires before every LLM call with a deep copy of the conversation history. Condensed Milk retroactively compresses old tool results that the model already processed but are still consuming context:

**Bash results** older than 8 turns → compressed via filter dispatch or line-count fallback (first 3 + last 3 lines preserved).

**Command invalidation** — certain commands immediately stale preceding output without waiting for 8 turns:
- `git add` / `git checkout` / `git reset` invalidates `git status`
- `git commit` / `git merge` / `git rebase` invalidates `git diff` and `git log`
- `npm install` / `pnpm add` invalidates `npm ls` / `npm outdated`
- `pip install` invalidates `pip list` / `pip freeze`

**Read (file) results** use smart staleness:
- **Kept fresh** if the file was written/edited after being read (model is actively working on it)
- **Kept fresh** if it's a reference file (AGENTS.md, CONVENTIONS.md, configs, package.json, etc.)
- **Compressed** if >8 turns old and never subsequently written
- **Compressed** if a newer read of the same file exists (older duplicate superseded)
- Compressed reads preserve the file path + first 3 lines (imports/header)

In practice, this saves **hundreds of KB per session** from stale file reads and old command outputs — effectively doubling context runway before compaction.

#### Cache-Aware Mode

Retroactive compression modifies conversation history, which can invalidate Anthropic's prompt cache. Enable cache-aware mode to defer compression until the cache TTL expires:

```
/compress-config cache-aware on     # Wait for cache TTL before compressing
/compress-config cache-ttl 300      # Set TTL in seconds (default: 300 = 5min)
```

When enabled, the context hook checks the timestamp of the last assistant message. If less than the TTL has passed, compression is skipped — the cache stays warm. Once the cache goes cold (idle for >5 min), compression runs freely.

The TTL auto-adjusts based on pi's `PI_CACHE_RETENTION` environment variable:
- **Default (unset):** 300s (5 min) — Anthropic's standard TTL
- **`PI_CACHE_RETENTION=long`:** 3600s (1 hour) — automatically detected, no manual config needed

Use `/compress-stats` to see whether cache-aware mode is helping your session:

```
Cache Impact
  Total input: 175.99M
  Cache hits:   162.72M (92.5%) @ $1.50/M = $244.08
  Cache writes: 13.27M  (7.5%)  @ $18.75/M = $248.78
  Uncached:     924     (0.0%)  @ $15/M = $0.01

Tradeoff
  Context freed: 865.8KB (~221.6K tokens)
  Cache-aware: ON (TTL: 300s)
  Compressions skipped (cache warm): 4

Recent turns (last 5):
  T7: hit 92% | write 8% | read 356K | new 30K | compressed 77KB
  T8: hit 95% | write 5% | read 380K | new 20K | compressed 0B [cache-wait]
```

### Compound Command Handling

Real-world commands are chains:

```bash
source .venv/bin/activate && python -m pytest -q 2>&1 | tail -3 && ruff check src/
```

The dispatcher splits on `&&`/`||`/`;`, strips pipe tails (`| head`, `| tail`, `| wc`), cleans env vars and redirects, then matches each segment against registered filters. Last matching segment wins (it produced the output).

### Secret Masking

The `env`/`printenv` filter masks values for keys containing `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `API`, `AUTH`, or `CREDENTIAL`. This prevents API keys and secrets from entering the LLM context window.

## Install

Copy to your pi global extensions directory:

```bash
git clone https://github.com/tomooshi/condensed-milk-pi.git
cp -r condensed-milk-pi ~/.pi/agent/extensions/condensed-milk
```

Or symlink:

```bash
git clone https://github.com/tomooshi/condensed-milk-pi.git ~/condensed-milk-pi
ln -s ~/condensed-milk-pi ~/.pi/agent/extensions/condensed-milk
```

Then restart pi or run `/reload`.

## Usage

The extension works automatically — no configuration needed. Every bash command the model runs goes through the compression pipeline.

### Commands

| Command | Description |
|---------|-------------|
| `/compress-stats` | Show compression statistics, cache impact analysis, and per-turn breakdown |
| `/compress-config` | View current configuration |
| `/compress-config cache-aware on\|off` | Enable/disable cache-aware compression (default: off) |
| `/compress-config cache-ttl <seconds>` | Set cache TTL in seconds (default: 300) |

### Status Bar

Shows a running total: `↓12.5KB saved (15/42 cmds, 68%)`

### Cache Impact Analysis

`/compress-stats` shows full cache tradeoff data:

- **Cache hit rate** — percentage of input tokens served from Anthropic's prompt cache
- **Cache writes** — tokens where new cache entries were created (potential invalidation indicator)
- **Cost breakdown** — per-category costs at Opus 4.6 pricing
- **Per-turn history** — last 5 turns showing hit/write rates and compression amounts
- **`[cache-wait]` tags** — turns where compression was skipped due to cache-aware mode

## Architecture

```
condensed-milk/
├── index.ts                    # Extension entry — tool_result + context hooks + cache instrumentation
├── filters/
│   ├── dispatch.ts             # Command matching + compound splitting
│   ├── ansi-strip.ts           # ANSI escape code removal (runs on ALL bash output)
│   ├── pytest.ts               # pytest/python -m pytest
│   ├── test-runners.ts         # vitest/jest/mocha/cargo test/go test
│   ├── build.ts                # cargo build/npm run build/make/go build
│   ├── install.ts              # npm/pnpm/yarn/pip install
│   ├── git-status.ts           # git status (porcelain v1/v2/plain)
│   ├── git-diff.ts             # git diff (strip headers, condense context)
│   ├── git-mutations.ts        # git add/commit/push
│   ├── git-log.ts              # git log (verbose → hash subject)
│   ├── file-ops.ts             # ls, find
│   ├── grep-grouping.ts        # grep/rg result grouping by file
│   ├── linter.ts               # eslint/ruff/mypy/pylint/flake8/clippy aggregation
│   ├── tree.ts                 # tree (strip noise dirs)
│   ├── env.ts                  # env/printenv (mask secrets)
│   ├── python-traceback.ts     # Python crash output
│   ├── log-dedup.ts            # journalctl, tail, docker logs, tmux
│   ├── tsc.ts                  # TypeScript compiler
│   ├── json-schema.ts          # JSON structure extraction (content-based)
│   └── context-compress.ts     # Retroactive context compression + command invalidation
└── package.json
```

### How It Works

1. **`tool_result` hook** — runs after pi's built-in 50KB truncation, before the model sees the output. First strips ANSI codes from all bash output, then matches the command against registered filters and returns compressed content. Preserves non-text content blocks (e.g., images).

2. **`context` event hook** — runs before each LLM API call. Walks the conversation history, identifies stale tool results (bash >8 turns, read with smart file-ops tracking), and replaces them with compressed summaries. Optionally defers compression when prompt cache is warm (cache-aware mode).

3. **Filter dispatch** — splits compound commands, strips pipes/redirects/env vars, and matches against registered filter prefixes. Longest prefix wins. Filters return `null` to decline (output passes through unchanged).

4. **Cache instrumentation** — tracks per-turn cache hit rates, cache write rates, and compression amounts. Reports cumulative cost analysis at Opus 4.6 pricing via `/compress-stats`.

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

Categories: `"fast"` (ls, grep), `"medium"` (test runners, linters), `"slow"` (git log), `"immutable"` (never changes), `"mutation"` (git add/commit/push).

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
| Source code filtering | **Harmful for coding agents.** Stripping comments/bodies from file reads breaks the model's ability to write correct edits. RTK offers this as an option but we intentionally skip it. |

**Contributing stack-specific filters is welcome.** The dispatch system is designed for easy extension — register a prefix and a function.

## vs ztk, RTK, and pi-rtk-optimizer

| | [ztk](https://github.com/codejunkie99/ztk) | [RTK](https://github.com/rtk-ai/rtk) | [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) | Condensed Milk |
|---|-----|-----|-----|----------------|
| Language | Zig | Rust | TypeScript | TypeScript |
| Target | Claude Code | Claude Code | pi terminal | pi terminal |
| Architecture | Standalone binary | Standalone binary | Native extension, tool_result hook | Native extension, tool_result + context hooks |
| Context compression | ❌ | ❌ | ❌ | ✅ Retroactively compresses stale results (**biggest savings**) |
| Cache-aware mode | ❌ | ❌ | ❌ | ✅ Defers compression until cache TTL expires |
| Cache instrumentation | ❌ | ❌ | ❌ | ✅ Per-turn hit/write rates + cost analysis |
| ANSI stripping | ❌ | ❌ | ✅ | ✅ (adapted from pi-rtk-optimizer) |
| Linter aggregation | ❌ | ❌ | ✅ | ✅ (adapted from pi-rtk-optimizer) |
| Search/grep grouping | ❌ | ❌ | ✅ | ✅ (adapted from pi-rtk-optimizer) |
| Read compression | ❌ | ✅ Language-aware filtering | ✅ Source code filtering | ✅ Smart file-ops-aware staleness |
| Secret masking | ❌ | ❌ | ❌ | ✅ env filter masks API keys/tokens/passwords |
| JSON structure | ❌ | ✅ Schema extraction | ❌ | ✅ Content-based schema extraction |
| Session dedup | ✅ mmap shared memory | ❌ | ❌ | Unnecessary (context compression subsumes it) |
| Code filtering | ✅ Strips function bodies | ✅ 3 filter levels | ✅ Minimal/aggressive | ❌ Intentionally — harmful for coding agents |
| Command rewriting | ❌ | ❌ | ✅ (`--no-pager`, etc.) | ❌ |
| TOML filter DSL | ❌ | ✅ 60+ declarative filters | ❌ | ❌ All filters are code |
| Log normalization | Timestamps only | ✅ UUIDs, hex, numbers, paths | ❌ | ✅ UUIDs, hex, numbers (from RTK) |
| Adaptive learning | ❌ | ✅ Mistake detection + suggestions | ❌ | ❌ |
| Analytics | ❌ | ✅ Rich per-day/week/month + API cost | ✅ Basic savings metrics | ✅ Cache-aware cost analysis |
| Traceback compression | ❌ | ❌ (pytest only) | ❌ | ✅ Generic Python traceback |
| Stack coverage | Broad (Rust, Go, Zig, Docker, K8s) | Very broad (60+ TOML filters) | Moderate | Python/TypeScript/Git focused |
| Install | Homebrew / zig build | Homebrew / cargo install | npm | Copy to ~/.pi/agent/extensions/ |

### Where Condensed Milk wins

- **Context retroactive compression** — ztk, RTK, and pi-rtk-optimizer only see output once. Condensed Milk compresses stale tool results in conversation history before each LLM call. This saved **9.4MB in a single session** — more than all tool-result filters combined.
- **Cache-aware mode** — defers retroactive compression until the provider's prompt cache TTL expires, preserving cache hit rates while still freeing context.
- **Cache instrumentation** — built-in per-turn analysis showing cache hit rate, write rate, cost breakdown, and tradeoff metrics. No other tool provides this visibility.
- **Smart read staleness** — tracks file operations across the session. Keeps reads where the file was subsequently edited (model is working on it). Compresses old exploratory reads.
- **Python traceback compression** — generic crash output compression (first 2 + last 2 frames + exception). RTK only has pytest-specific filtering. Handles Python 3.13 pointer lines.
- **Secret masking** — prevents API keys from entering the LLM context sent to Anthropic.
- **Compound command dispatch** — handles `source && pytest | tail` chains that real coding sessions produce.

### Where pi-rtk-optimizer wins

- **Command rewriting** — rewrites commands to add `--no-pager`, `--color=never`, etc. before execution.
- **Source code filtering** — language-aware comment/import stripping for file reads (though we consider this harmful for coding agents).
- **Smart truncate** — content-aware truncation preserving signatures and imports.

### Where RTK wins

- **Breadth** — 60+ TOML filters covering Rust, Go, .NET, Ruby, Docker, K8s, Terraform, Ansible, and more.
- **TOML DSL** — declarative filter definitions with `strip_lines_matching`, `match_output`, `max_lines`, and inline tests.
- **Adaptive learning** — watches for repeated CLI mistakes and suggests corrections.
- **Analytics** — rich per-day/week/month reporting with API cost integration.

## Measured Results

From a real coding session:

```
Token Compressor Stats
  Commands processed: 88
  Commands compressed: 13
  Original: 4.4KB → Compressed: 1.4KB (68% saved)
  Context retroactive: 9.4MB saved (163 compressions)

Cache Impact
  Total input: 175.99M
  Cache hits:   162.72M (92.5%) @ $1.50/M = $244.08
  Cache writes: 13.27M  (7.5%)  @ $18.75/M = $248.78
  Uncached:     924     (0.0%)  @ $15/M = $0.01
  Session cost: $508.02
  vs no cache:  $2704.78 (saving $2196.76)
```

The context retroactive compression is the dominant savings — **9.4MB in one session** from compressing stale file reads and old command outputs.

## Attribution

- **[ztk](https://github.com/codejunkie99/ztk)** — original inspiration for the CLI proxy approach to token compression
- **[RTK](https://github.com/rtk-ai/rtk)** — log normalization techniques (UUID, hex, number dedup)
- **[pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer)** by MasuRii — ANSI stripping, linter output aggregation, and search/grep result grouping techniques adapted for Condensed Milk. Cache-aware compression approach inspired by community discussion with warren.

## License

MIT
