#!/usr/bin/env python3
"""Check one run of bench/probe/digest.sh, or summarize all runs (--summary OUT_DIR).

One run passes its sanity checks when the request that answers prompt 2 carries
the masked result (with a digest in the digest arm only). The gate (research
doc §7.2, gate 4): the digest arm answers correctly in every run, and its mean
number of tool calls after the question is not higher than the plain arm's.
"""
import json, os, sys

def run(d):
    names = open(os.path.join(d, "names.txt")).read().split()
    events = []
    for line in open(os.path.join(d, "events.jsonl")):
        try: events.append(json.loads(line))
        except ValueError: pass
    starts = [i for i, e in enumerate(events) if e.get("type") == "agent_start"]
    if len(starts) < 2:
        return {"ok": False, "why": f"{len(starts)} agent runs, need 2"}
    second = events[starts[1]:]
    calls = [e.get("toolName") for e in second if e.get("type") == "tool_execution_start"]
    texts = [c.get("text", "") for e in second if e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant"
             for c in e["message"].get("content", []) if c.get("type") == "text"]
    answer = texts[-1] if texts else ""
    errors = [e["message"].get("errorMessage") for e in second if e.get("type") == "message_end" and e.get("message", {}).get("errorMessage")]
    # The first request of prompt 2: the one after the last request of prompt 1.
    payloads = [json.loads(l) for l in open(os.path.join(d, "payloads.jsonl"))]
    masked = [p for p in payloads if "[cm-masked bash" in json.dumps(p.get("messages", []))]
    first_masked = json.dumps(masked[0]["messages"]) if masked else ""
    has_digest = "cm_recall returns it): " in first_masked
    return {"ok": not errors, "why": "; ".join(map(str, errors)), "correct": all(n in answer for n in names), "calls": calls,
            "masked": bool(masked), "digest": has_digest, "answer": answer[:120]}

def main():
    if sys.argv[1] == "--summary":
        out = sys.argv[2]
        arms = {}
        for name in sorted(os.listdir(out)):
            d = os.path.join(out, name)
            if not os.path.isdir(d) or "-" not in name: continue
            arms.setdefault(name.rsplit("-", 1)[0], []).append(run(d))
        report = {}
        for arm, runs in arms.items():
            valid = [r for r in runs if r["ok"] and r["masked"] and r["digest"] == (arm == "digest")]
            report[arm] = {"runs": len(runs), "valid": len(valid), "correct": sum(r["correct"] for r in valid),
                           "mean_calls": sum(len(r["calls"]) for r in valid) / max(1, len(valid)),
                           "calls": [len(r["calls"]) for r in valid]}
        dg, pl = report.get("digest"), report.get("plain")
        gate = bool(dg and pl and dg["valid"] == dg["runs"] and pl["valid"] == pl["runs"] and dg["correct"] == dg["valid"] and dg["mean_calls"] <= pl["mean_calls"])
        print(json.dumps({"arms": report, "gate": "PASS" if gate else "FAIL"}))
    else:
        print(json.dumps(run(sys.argv[1])))

main()
