#!/usr/bin/env python3
"""Check one 1.13.0 probe run (bench/probe/features.sh). Prints one line.

cd mode: the first request whose payload holds "[cm-masked arg #" (C); PASS
when every response from that request on has no error. (D, collapse, failed
its offline gate and was removed in 1.13.0.)
b1 modes: new thinking drops in the response to the request that carries the
`echo INVALIDATE` result (the invalidation point), and condensed-milk mask edits seen
by the guard after the boundary.
"""
import json, sys, os

d, mode = sys.argv[1], sys.argv[2]
def jl(name):
    p = os.path.join(d, name)
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []
payloads, messages, guard = jl("payloads.jsonl"), jl("messages.jsonl"), jl("guard.jsonl")
new_drops, seen = [], set()
for m in messages:
    cur = set(m.get("drops") or [])
    new_drops.append(len(cur - seen)); seen = cur
errors = [i for i, m in enumerate(messages) if m.get("error") or m.get("stopReason") == "error"]
if mode == "cd":
    s = [json.dumps(p) for p in payloads]
    c_at = next((i for i, x in enumerate(s) if "[cm-masked arg #" in x), None)
    answered = c_at is not None and len(messages) > c_at and not any(e >= c_at for e in errors)
    last_cmds = [c.get("command") for m in messages for c in m.get("calls", [])]
    print(f"{'PASS' if answered else 'FAIL'} requests={len(payloads)} responses={len(messages)} C_masked_request={c_at} errors_at={errors} calls={last_cmds}")
else:
    add_i = next((i for i, m in enumerate(messages) if any("echo INVALIDATE" in (c.get("command") or "") for c in m.get("calls", []))), None)
    at_point = new_drops[add_i + 1] if add_i is not None and add_i + 1 < len(new_drops) else None
    masks = [g for g in guard if g.get("detail") == "condensed-milk mask"]
    ok = at_point == 0 if mode == "b1" else at_point is not None and at_point > 0
    print(f"{'PASS' if ok else 'FAIL'} drops_at_invalidation={at_point} new_drops={new_drops} cm_mask_edits={len(masks)} errors_at={errors}")
