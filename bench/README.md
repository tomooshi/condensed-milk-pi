# Replay-cost harness

Measures what a condensed-milk change does to cost and to the model's earlier reasoning, on real pi sessions,
before the change ships. Pass/fail gates for every planned feature are fixed in
`docs/research/2026-11-02-next-features.md` §6.1.

## What it does

1. `replay-cost.mjs list` snapshots session files and their byte lengths, so every run reads the same bytes.
2. `replay-cost.mjs run` replays each session call by call. At every model call it builds the message list with pi's
   own `buildSessionContext`, gives the extension pi's own `estimateContextTokens`, and runs one or more **arms**:
   copies of the real `index.ts` with their own config. It records the token, cache and thinking terms per call.
3. `analyze.mjs` fits the token model on the odd-numbered sessions, checks the harness gate on the even-numbered ones,
   and compares every arm with the first one, paired by session (bootstrap 95% CI, 10,000 resamples, fixed seed).

```bash
node bench/replay-cost.mjs list --days 30 --max-mb 600 --out /tmp/cm-bench/list.tsv
node --max-old-space-size=24000 bench/replay-cost.mjs run --list /tmp/cm-bench/list.tsv \
  --arm base=. --arm candidate=../condensed-milk-feature:/path/to/config-dir --out /tmp/cm-bench/run.json
node bench/analyze.mjs /tmp/cm-bench/run.json --json /tmp/cm-bench/analysis.json
node bench/analyze.mjs --same run-a.json run-b.json          # determinism gate
```

An arm is `name=SOURCE_DIR[:CONFIG_DIR]`. `CONFIG_DIR` holds `condensed-milk.json` and `condensed-milk-config.json`;
without it, the arm uses copies of the operator's real files. Runs read sessions only and write only to `--out`.

## Model

- Prompt tokens = offset + fixed tokens + characters / R. Fixed tokens are each assistant message's recorded output
  tokens (minus its recorded reasoning tokens once its thinking is invalid) and 1,600 per image. R is fitted from
  consecutive calls, where the offset cancels; the offset (tools, framing) comes from each session's first Claude call.
- Cache: a call within the cache lifetime of the last cache touch (last call or a pi `cache_warm`) reads the request's
  unchanged prefix; otherwise nothing. Lifetime is 5 minutes, or 1 hour after a call that wrote to the 1-hour cache.
- Thinking (Claude 5.x prefix rule): an edit invalidates every valid thinking block after it, for good.

## Events the session files do not record

- **Restarts.** pi restarts reset the extension's zones (`session_start`). A cold call whose recorded prompt falls by
  more than 20k tokens, where the baseline arm's own edits explain less than half of the fall, is read as a restart:
  every arm gets `session_start` there. The arms' code still decides how much they mask.
- **Other extensions' edits.** Thinking drops that the recording shows but no arm edit explains are applied to every
  arm at the same position. Cache rewrites below half of the modeled read are applied as shocks to every arm, in the
  comparison only; the harness gate uses reads without shocks, so it cannot pass by construction.

## Validation (2026-11-02, 38 sessions, 51,472 calls, 30 days)

| Gate | Result |
|---|---|
| Two runs byte-identical | Pass |
| Cache reads on 17 held-out sessions within 10% (aggregate and median per session), Spearman >= 0.95 | Pass: -4.9%, 6.2%, 1.000 |
| A/A (two identical arms) | Every difference exactly 0 |
| Positive control (zones off) | +$1,572 [699, 2,667] per 30 days, so the current masking is detected |

Known bias: median prompt-size error per call 3.8% (p90 21%); with shocks, reads -6.1% and writes +13.1% against the
recording. Prices are claude-opus-5-5's (pi `anthropic.json`).

## Other gate tools

- `node --expose-gc bench/guard-overhead.mjs`: prefix-guard overhead at a 1M-token request (gate: p99 < 5 ms).
- `bench/probe/run.sh OUT_DIR [RUNS]`: real-API probe runs (uses the subscription, about 60k tokens per run) for four
  conditions: clean, late tool alias (MCP on), injected mask, injected deletion. `bench/probe/check.py` compares the
  guard's log with the request payloads captured by `pi-claude-code-use`'s debug log.
