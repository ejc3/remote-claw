#!/usr/bin/env python3
"""Two-surface proof: the TUI wrapper and our client drive ONE session.

Runs a real `claude --remote-control` worker (the TUI, under a pty we control —
the testing/introspection wrapper) against OUR relay, then:
  • types a message in the TUI  → asserts it + the reply show up in OUR client
  • sends a message via OUR client API → asserts it + the reply show up
Both surfaces share one session through our relay. Exit 0 = pass.
"""
import json, os, pty, re, select, signal, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELAY = os.path.join(ROOT, "relay", "relay.py")
CA = os.path.join(ROOT, "mitm", "certs", "ca.pem")
WRAPPER = os.path.join(ROOT, "remote-claw")
PROXY_PORT, CLIENT_PORT = 8899, 9111
BASE = f"http://127.0.0.1:{CLIENT_PORT}"
TUI_TOK = "KIWI" + str(os.getpid())
CLI_TOK = "PLUM" + str(os.getpid())

def step(m): print(f"\033[1m▶ {m}\033[0m", flush=True)
def ok(m): print(f"  \033[32m✓\033[0m {m}", flush=True)
def fail(m):
    print(f"  \033[31m✗ {m}\033[0m", flush=True); raise SystemExit(1)

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=5) as r: return json.load(r)
def post(path, obj):
    req = urllib.request.Request(BASE + path, data=json.dumps(obj).encode(),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r: return json.load(r)

relay_proc = worker = master = None
def cleanup():
    if worker:
        try: os.kill(worker.pid, signal.SIGTERM)
        except Exception: pass
    if relay_proc:
        try: os.killpg(os.getpgid(relay_proc.pid), signal.SIGTERM)
        except Exception: pass

def client_has(kind, token, timeout):
    """Poll our client API until an event of `kind` contains `token`."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            ss = get("/api/sessions")["sessions"]
            cand = [s for s in ss if s["title"] == "two-surface"]
            if cand:
                for e in get(f"/api/sessions/{cand[0]['id']}/events")["events"]:
                    if e["type"] == kind and token in (e.get("text") or ""):
                        return e
        except Exception:
            pass
        time.sleep(0.3)
    return None

def main():
    global relay_proc, worker, master
    if not os.path.exists(CA):
        subprocess.run([sys.executable, WRAPPER, "certs"], check=True)

    step(f"start relay (proxy {PROXY_PORT}, client {CLIENT_PORT})")
    relay_proc = subprocess.Popen(
        [sys.executable, RELAY, "--proxy-port", str(PROXY_PORT), "--client-port", str(CLIENT_PORT)],
        stdout=open("/tmp/two-surface-relay.log", "w"), stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, start_new_session=True)
    for _ in range(50):
        try: get("/api/sessions"); break
        except Exception: time.sleep(0.2)
    else: fail("relay did not start")
    ok("relay up")

    step("launch the TUI wrapper (claude --remote-control under a pty)")
    env = dict(os.environ)
    env["HTTPS_PROXY"] = env["HTTP_PROXY"] = f"http://127.0.0.1:{PROXY_PORT}"
    env["NODE_EXTRA_CA_CERTS"] = CA
    master, slave = pty.openpty()
    worker = subprocess.Popen(
        ["claude", "--remote-control", "two-surface", "--permission-mode", "bypassPermissions"],
        stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True, close_fds=True)
    os.close(slave)

    step("wait for TUI to reach 'Remote Control active'")
    buf = b""; end = time.time() + 25
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.5)
        if r:
            try: buf += os.read(master, 4096)
            except OSError: break
        if b"Remote Control active" in re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]", b"", buf):
            break
    else:
        fail("TUI never became active")
    ok("TUI active")

    step(f"TYPE IN THE TUI: 'Reply with exactly one word: {TUI_TOK}'")
    time.sleep(2)
    os.write(master, (f"Reply with exactly one word: {TUI_TOK}").encode())
    time.sleep(0.6)
    os.write(master, b"\r")
    if not client_has("assistant", TUI_TOK, 45):
        fail("TUI-typed message did NOT appear answered in our client")
    ok(f"our client received the TUI-driven reply ({TUI_TOK}) → TUI→client works")

    step(f"SEND VIA OUR CLIENT: 'Reply with exactly one word: {CLI_TOK}'")
    sid = [s for s in get("/api/sessions")["sessions"] if s["title"] == "two-surface"][0]["id"]
    post(f"/api/sessions/{sid}/input", {"content": f"Reply with exactly one word: {CLI_TOK}"})
    if not client_has("assistant", CLI_TOK, 45):
        fail("client-sent message was not answered")
    ok(f"our client received the client-driven reply ({CLI_TOK}) → client→TUI works")

    print("\n\033[32m\033[1mPASS\033[0m — both surfaces (TUI + our client) drive one synced session.")
    return 0

if __name__ == "__main__":
    try: rc = main()
    except SystemExit as e: rc = e.code
    except Exception as e: print(f"\033[31mERROR: {e}\033[0m"); rc = 1
    finally: cleanup()
    sys.exit(rc)
