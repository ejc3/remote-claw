#!/usr/bin/env python3
"""End-to-end test: TUI worker ↔ our relay ↔ our client (token-gated API)."""
import json
import os
import pty
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from remote_claw.config import Config  # noqa: E402
from remote_claw import certs  # noqa: E402

PROXY, CLIENT = 8899, 9111
TOKEN = "test-token-" + str(os.getpid())
BASE = f"http://127.0.0.1:{CLIENT}"
TOK = "ZEBRA" + str(os.getpid())
H = {"Authorization": f"Bearer {TOKEN}", "content-type": "application/json"}


def _ok(m): print(f"  \033[32m✓\033[0m {m}", flush=True)
def _step(m): print(f"\033[1m▶ {m}\033[0m", flush=True)
def _fail(m): print(f"  \033[31m✗ {m}\033[0m", flush=True); raise SystemExit(1)


def get(path):
    req = urllib.request.Request(BASE + path, headers=H)
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def post(path, obj):
    req = urllib.request.Request(BASE + path, data=json.dumps(obj).encode(), headers=H)
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


relay = worker = None


def cleanup():
    if worker:
        try: os.kill(worker.pid, signal.SIGTERM)
        except Exception: pass
    if relay:
        try: os.killpg(os.getpgid(relay.pid), signal.SIGTERM)
        except Exception: pass


def main():
    global relay, worker
    cfg = Config(proxy_port=PROXY, client_port=CLIENT)
    certs.ensure(cfg)

    _step(f"start relay (proxy {PROXY}, client {CLIENT})")
    env = dict(os.environ, REMOTE_CLAW_TOKEN=TOKEN)
    relay = subprocess.Popen(
        [sys.executable, "-m", "remote_claw", "relay", "--proxy-port", str(PROXY),
         "--client-port", str(CLIENT), "-v"],
        cwd=ROOT, env=env, stdout=open("/tmp/e2e-relay.log", "w"),
        stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    for _ in range(50):
        try:
            urllib.request.urlopen(f"{BASE}/healthz", timeout=2); break
        except Exception:
            time.sleep(0.2)
    else:
        _fail("relay did not come up")
    _ok("relay up")

    _step("reject unauthenticated request")
    try:
        urllib.request.urlopen(f"{BASE}/api/sessions", timeout=5)
        _fail("unauthenticated request was NOT rejected")
    except urllib.error.HTTPError as e:
        if e.code != 401:
            _fail(f"expected 401, got {e.code}")
    _ok("auth enforced (401 without token)")

    _step("launch worker pointed at relay")
    wenv = dict(os.environ,
                HTTPS_PROXY=f"http://127.0.0.1:{PROXY}", HTTP_PROXY=f"http://127.0.0.1:{PROXY}",
                NODE_EXTRA_CA_CERTS=cfg.ca_pem)
    master, slave = pty.openpty()
    worker = subprocess.Popen(
        ["claude", "--remote-control", "e2e", "--permission-mode", "bypassPermissions"],
        stdin=slave, stdout=slave, stderr=slave, env=wenv, start_new_session=True, close_fds=True)
    os.close(slave)

    _step("wait for the session to register with our relay")
    sid = None
    for _ in range(75):
        try:
            cand = [s for s in get("/api/sessions")["sessions"] if s["title"] == "e2e"]
            if cand:
                sid = cand[0]["id"]; break
        except Exception:
            pass
        time.sleep(0.2)
    if not sid:
        _fail("worker never registered")
    _ok(f"session registered: {sid}")

    _step("send a user turn via our client API")
    post(f"/api/sessions/{sid}/input", {"content": f"Reply with exactly one word: {TOK}"})
    _ok("input accepted")

    _step("await assistant reply (inference via passthrough)")
    for _ in range(150):
        try:
            if any(e["type"] == "assistant" and TOK in (e.get("text") or "")
                   for e in get(f"/api/sessions/{sid}/events")["events"]):
                break
        except Exception:
            pass
        time.sleep(0.2)
    else:
        _fail(f"no assistant reply containing {TOK}")
    _ok(f"assistant replied via relay ({TOK})")

    print("\n\033[32m\033[1mPASS\033[0m — worker ↔ our relay ↔ our client round-trip verified.")
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    except SystemExit as e:
        rc = e.code
    except Exception as e:
        print(f"\033[31mERROR: {e}\033[0m"); rc = 1
    finally:
        cleanup()
    sys.exit(rc)
