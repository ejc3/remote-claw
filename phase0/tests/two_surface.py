#!/usr/bin/env python3
"""Two-surface test: TUI wrapper + our client drive one synced session, both ways."""

import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import contextlib

from remote_claw import certs  # noqa: E402
from remote_claw.config import Config  # noqa: E402

PROXY, CLIENT = 8899, 9111
TOKEN = "test-token-" + str(os.getpid())
BASE = f"http://127.0.0.1:{CLIENT}"
TUI_TOK = "KIWI" + str(os.getpid())
CLI_TOK = "PLUM" + str(os.getpid())
H = {"Authorization": f"Bearer {TOKEN}", "content-type": "application/json"}


def _ok(m):
    print(f"  \033[32m✓\033[0m {m}", flush=True)


def _step(m):
    print(f"\033[1m▶ {m}\033[0m", flush=True)


def _fail(m):
    print(f"  \033[31m✗ {m}\033[0m", flush=True)
    raise SystemExit(1)


def get(path):
    req = urllib.request.Request(BASE + path, headers=H)
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def post(path, obj):
    req = urllib.request.Request(BASE + path, data=json.dumps(obj).encode(), headers=H)
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


relay = worker = master = None


def cleanup():
    if worker:
        with contextlib.suppress(Exception):
            os.kill(worker.pid, signal.SIGTERM)
    if relay:
        with contextlib.suppress(Exception):
            os.killpg(os.getpgid(relay.pid), signal.SIGTERM)


def client_has(kind, token, timeout):
    end = time.time() + timeout
    while time.time() < end:
        try:
            cand = [s for s in get("/api/sessions")["sessions"] if s["title"] == "two-surface"]
            if cand:
                for e in get(f"/api/sessions/{cand[0]['id']}/events")["events"]:
                    if e["type"] == kind and token in (e.get("text") or ""):
                        return e
        except Exception:
            pass
        time.sleep(0.3)
    return None


def main():
    global relay, worker, master
    cfg = Config(proxy_port=PROXY, client_port=CLIENT)
    certs.ensure(cfg)

    _step(f"start relay (proxy {PROXY}, client {CLIENT})")
    env = dict(os.environ, REMOTE_CLAW_TOKEN=TOKEN)
    relay = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "remote_claw",
            "relay",
            "--proxy-port",
            str(PROXY),
            "--client-port",
            str(CLIENT),
            "-v",
        ],
        cwd=ROOT,
        env=env,
        stdout=open("/tmp/two-surface-relay.log", "w"),
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(50):
        try:
            urllib.request.urlopen(f"{BASE}/healthz", timeout=2)
            break
        except Exception:
            time.sleep(0.2)
    else:
        _fail("relay did not start")
    _ok("relay up")

    _step("launch the TUI wrapper (claude --remote-control under a pty)")
    wenv = dict(
        os.environ,
        HTTPS_PROXY=f"http://127.0.0.1:{PROXY}",
        HTTP_PROXY=f"http://127.0.0.1:{PROXY}",
        NODE_EXTRA_CA_CERTS=cfg.ca_pem,
    )
    master, slave = pty.openpty()
    worker = subprocess.Popen(
        ["claude", "--remote-control", "two-surface", "--permission-mode", "bypassPermissions"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=wenv,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)

    _step("wait for TUI to reach 'Remote Control active'")
    buf = b""
    end = time.time() + 25
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.5)
        if r:
            try:
                buf += os.read(master, 4096)
            except OSError:
                break
        if b"Remote Control active" in re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]", b"", buf):
            break
    else:
        _fail("TUI never became active")
    _ok("TUI active")

    _step(f"TYPE IN THE TUI: …{TUI_TOK}")
    time.sleep(2)
    os.write(master, f"Reply with exactly one word: {TUI_TOK}".encode())
    time.sleep(0.6)
    os.write(master, b"\r")
    if not client_has("assistant", TUI_TOK, 45):
        _fail("TUI-typed message did not reach our client")
    _ok(f"our client saw the TUI-driven reply ({TUI_TOK}) → TUI→client")

    _step(f"SEND VIA OUR CLIENT: …{CLI_TOK}")
    sid = [s for s in get("/api/sessions")["sessions"] if s["title"] == "two-surface"][0]["id"]
    post(f"/api/sessions/{sid}/input", {"content": f"Reply with exactly one word: {CLI_TOK}"})
    if not client_has("assistant", CLI_TOK, 45):
        _fail("client-sent message was not answered")
    _ok(f"our client saw the client-driven reply ({CLI_TOK}) → client→TUI")

    print("\n\033[32m\033[1mPASS\033[0m — both surfaces drive one synced session.")
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    except SystemExit as e:
        rc = e.code
    except Exception as e:
        print(f"\033[31mERROR: {e}\033[0m")
        rc = 1
    finally:
        cleanup()
    sys.exit(rc)
