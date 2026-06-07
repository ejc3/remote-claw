#!/usr/bin/env python3
"""P0.5 spike: can the host wrapper be a pure CLIENT of Anthropic's RC API
(no MITM)? Validates inject + live client-SSE + cursor history catch-up against a
real `claude --remote-control` session. Resolves the §14 MITM-vs-bridge decision
and the history/replay question for docs/v2-architecture.md.

Stdlib only. Reads the claude.ai oauth token from ~/.claude/.credentials.json,
drives an already-running session titled `api-bridge-spike`.
"""
import json
import os
import sys
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone

BASE = "https://api.anthropic.com"
AV = "2023-06-01"
TITLE = "api-bridge-spike"
CAP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "captures",
                   "spike-rc-api-bridge.log")


def token():
    d = json.load(open(os.path.expanduser("~/.claude/.credentials.json")))
    return d["claudeAiOauth"]["accessToken"]


TOK = token()
H = {"Authorization": f"Bearer {TOK}", "anthropic-version": AV, "Content-Type": "application/json"}
cap = open(CAP, "w")


def log(*a):
    line = " ".join(str(x) for x in a)
    print(line, flush=True)
    cap.write(line + "\n"); cap.flush()


def api(method, path, body=None, stream=False, timeout=30):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=H, method=method)
    return urllib.request.urlopen(req, timeout=timeout)


def get_json(path, timeout=30):
    with api("GET", path, timeout=timeout) as r:
        return json.load(r)


def find_session():
    for _ in range(90):
        try:
            for s in get_json("/v1/code/sessions").get("data", []):
                if s.get("title") == TITLE and s.get("status") == "active":
                    return s["id"]
        except Exception as e:
            log("  (list err:", e, ")")
        time.sleep(1)
    return None


def inject(sid, text):
    ev = {"payload": {"type": "user", "message": {"role": "user", "content": text},
                      "uuid": str(uuid.uuid4()), "session_id": sid,
                      "timestamp": datetime.now(timezone.utc).isoformat(),
                      "parent_tool_use_id": None}}
    with api("POST", f"/v1/code/sessions/{sid}/events", {"events": [ev]}) as r:
        return json.load(r)


def assistant_with(sid, token_str, timeout=45):
    """Poll cursor history until an assistant event contains token_str."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            evs = get_json(f"/v1/code/sessions/{sid}/events?sort_order=asc").get("data", [])
            for e in evs:
                p = e.get("payload", {})
                if p.get("type") == "assistant":
                    c = p.get("message", {}).get("content")
                    txt = c if isinstance(c, str) else " ".join(
                        b.get("text", "") for b in (c or []) if isinstance(b, dict))
                    if token_str in txt:
                        return e
        except Exception:
            pass
        time.sleep(1)
    return None


def main():
    results = {}
    log("=== P0.5 spike: RC-API client bridge (no MITM) ===")
    log("waiting for session", repr(TITLE), "...")
    sid = find_session()
    if not sid:
        log("FAIL: session never appeared"); return 1
    log("session:", sid)

    # ---- STEP 1: inject + read back via cursor history (client-side drive) ----
    log("\n[1] inject APPLE, read back via GET /events cursor")
    inject(sid, "Reply with exactly one word: APPLE")
    a = assistant_with(sid, "APPLE")
    results["inject+history_read"] = bool(a)
    if a:
        log("    OK assistant APPLE, sequence_num=", a.get("sequence_num"),
            "event_type=", a.get("event_type"), "source=", a.get("source"))

    # ---- STEP 2: second turn, then full ordered catch-up + pagination ----
    log("\n[2] inject BERRY; then full cursor catch-up + monotonic seq + pagination")
    inject(sid, "Reply with exactly one word: BERRY")
    assistant_with(sid, "BERRY")
    # full history asc
    full = get_json(f"/v1/code/sessions/{sid}/events?sort_order=asc")
    evs = full.get("data", [])
    seqs = [int(e["sequence_num"]) for e in evs if str(e.get("sequence_num", "")).isdigit()]
    monotonic = seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    has_apple = any("APPLE" in json.dumps(e) for e in evs)
    has_berry = any("BERRY" in json.dumps(e) for e in evs)
    results["history_complete_ordered"] = monotonic and has_apple and has_berry
    log("    events=", len(evs), "monotonic_seq=", monotonic,
        "has_APPLE=", has_apple, "has_BERRY=", has_berry,
        "next_cursor=", str(full.get("next_cursor"))[:24])
    # pagination: page with limit=2 and follow next_cursor
    try:
        p1 = get_json(f"/v1/code/sessions/{sid}/events?sort_order=asc&limit=2")
        cur = p1.get("next_cursor")
        paged = len(p1.get("data", [])) <= 2 and cur is not None
        if cur:
            p2 = get_json(f"/v1/code/sessions/{sid}/events?sort_order=asc&limit=2&cursor={cur}")
            paged = paged and len(p2.get("data", [])) >= 1
        results["pagination"] = paged
        log("    pagination: page1=", len(p1.get("data", [])), "cursor?", cur is not None, "->", paged)
    except Exception as e:
        results["pagination"] = False
        log("    pagination err:", e)

    # ---- STEP 3: live client SSE stream ----
    log("\n[3] live client SSE: open /events/stream, inject CHERRY, expect it live")
    seen = {"cherry": False}
    raw_frames = []

    def reader():
        try:
            with api("GET", f"/v1/code/sessions/{sid}/events/stream", stream=True, timeout=40) as r:
                end = time.time() + 35
                for raw in r:
                    line = raw.decode("utf-8", "replace").rstrip("\n")
                    if line:
                        raw_frames.append(line)
                    if "CHERRY" in line:
                        seen["cherry"] = True
                        return
                    if time.time() > end:
                        return
        except Exception as e:
            log("    stream err:", e)

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    time.sleep(2)  # let the stream attach
    inject(sid, "Reply with exactly one word: CHERRY")
    t.join(timeout=35)
    results["live_client_sse"] = seen["cherry"]
    log("    live CHERRY on client SSE:", seen["cherry"], "(", len(raw_frames), "frames seen )")
    if raw_frames:
        log("    sample frame:", raw_frames[0][:160])

    # ---- verdict ----
    log("\n=== RESULTS ===")
    for k, v in results.items():
        log(f"  {'PASS' if v else 'FAIL'}  {k}")
    allpass = all(results.values())
    log("\nVERDICT:", "RC-API CLIENT BRIDGE VIABLE (no MITM needed)" if allpass
        else "partial — see failures")
    return 0 if allpass else 2


if __name__ == "__main__":
    try:
        rc = main()
    except Exception as e:
        log("ERROR:", e); rc = 1
    finally:
        cap.close()
    sys.exit(rc)
