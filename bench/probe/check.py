#!/usr/bin/env python3
"""Ground truth for a prefix-probe run: compare consecutive request payloads
(captured by pi-claude-code-use's debug log, the input to condensed-milk's
guard) in cache order and check the guard's log names the same first change.
Usage: check.py RUN_DIR"""
import json, sys, os
run = sys.argv[1]
raw = [r.strip() for r in open(os.path.join(run, "payloads.log")).read().split("\n---\n") if r.strip()]
after = [json.loads(r.partition("\n")[2])["payload"] for r in raw if '"stage": "after"' in r[:300]]
def strip(v):
    if isinstance(v, list): return [strip(x) for x in v]
    if isinstance(v, dict): return {k: strip(x) for k, x in v.items() if k != "cache_control"}
    return v
truth = []
for a, b in zip(after, after[1:]):
    ta, tb = strip(a.get("tools") or []), strip(b.get("tools") or [])
    if ta != tb:
        i = next((i for i in range(min(len(ta), len(tb))) if ta[i] != tb[i]), min(len(ta), len(tb)))
        truth.append(["tools", i]); continue
    if strip(a.get("system")) != strip(b.get("system")):
        truth.append(["system", None]); continue
    ma, mb = strip(a["messages"]), strip(b["messages"])
    i = next((i for i in range(min(len(ma), len(mb))) if ma[i] != mb[i]), None)
    if i is not None:
        kind = "removed" if i + 1 < len(ma) and ma[i + 1] == mb[i] else "message"
        truth.append([kind, i])
log = os.path.join(run, "guard.jsonl")
guard = [[e["kind"], e["index"] if e["kind"] in ("message", "removed", "tools") else None] for e in (json.loads(l) for l in open(log))] if os.path.exists(log) else []
details = [json.loads(l)["detail"] for l in open(log)] if os.path.exists(log) else []
drops = 0
for l in open(os.path.join(run, "events.jsonl")):
    e = json.loads(l)
    if e.get("type") == "message_end" and (e.get("message") or {}).get("role") == "assistant":
        for d in e["message"].get("diagnostics") or []:
            drops += sum(1 for t in (d.get("details") or {}).get("transformations") or [] if t.get("type") == "thinking_dropped")
print(json.dumps({"requests": len(after), "truth": truth, "guard": guard, "details": details, "match": truth == guard, "dropsReported": drops}))
