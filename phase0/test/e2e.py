#!/usr/bin/env python3
"""remote-claw end-to-end test.

Proves the core mission: a real `claude --remote-control` worker connects to OUR
relay, a turn sent through OUR client API is answered by the worker (inference
passing through to the real API), and the reply is readable via OUR client API.

Self-contained: generates certs, starts the relay on private ports, launches a
headless worker (under a pty), drives one round-trip, asserts the answer, tears
everything down. Exit 0 = pass.
"""
import json, os, pty, signal, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELAY = os.path.join(ROOT, "relay", "relay.py")
CA = os.path.join(ROOT, "mitm", "certs", "ca.pem")
WRAPPER = os.path.join(ROOT, "remote-claw")
PROXY_PORT, CLIENT_PORT = 8899, 9111
BASE = f"http://127.0.0.1:{CLIENT_PORT}"
TOKEN = "ZEBRA" + str(os.getpid())

def step(m): print(f"\033[1m▶ {m}\033[0m", flush=True)
def ok(m): print(f"  \033[32m✓\033[0m {m}", flush=True)
def fail(m):
    print(f"  \033[31m✗ {m}\033[0m", flush=True)
    raise SystemExit(1)

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=5) as r:
        return json.load(r)

def post(path, obj):
    data = json.dumps(obj).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)

relay_proc = worker_pid = None

def cleanup():
    global relay_proc, worker_pid
    if worker_pid:
        try: os.kill(worker_pid, signal.SIGTERM)
        except Exception: pass
    if relay_proc:
        try: os.killpg(os.getpgid(relay_proc.pid), signal.SIGTERM)
        except Exception: pass

def main():
    global relay_proc, worker_pid
    step("ensure certs")
    if not os.path.exists(CA):
        subprocess.run([sys.executable, WRAPPER, "certs"], check=True)
    ok("certs present")

    step(f"start relay on proxy:{PROXY_PORT} client:{CLIENT_PORT}")
    relay_proc = subprocess.Popen(
        [sys.executable, RELAY, "--proxy-port", str(PROXY_PORT), "--client-port", str(CLIENT_PORT)],
        stdout=open("/tmp/e2e-relay.log", "w"), stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, start_new_session=True)
    for _ in range(50):
        try:
            get("/api/sessions"); break
        except Exception:
            time.sleep(0.2)
    else:
        fail("relay did not come up")
    ok("relay up")

    step("launch worker (claude --remote-control) pointed at relay")
    env = dict(os.environ)
    env["HTTPS_PROXY"] = env["HTTP_PROXY"] = f"http://127.0.0.1:{PROXY_PORT}"
    env["NODE_EXTRA_CA_CERTS"] = CA
    # pty so the interactive TUI starts in this headless harness
    master, slave = pty.openpty()
    worker = subprocess.Popen(
        ["claude", "--remote-control", "e2e-test", "--permission-mode", "bypassPermissions", "--verbose"],
        stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True, close_fds=True)
    worker_pid = worker.pid
    os.close(slave)

    step("wait for the session to register with our relay")
    sid = None
    for _ in range(75):  # up to ~15s
        try:
            ss = get("/api/sessions")["sessions"]
            cand = [s for s in ss if s["title"] == "e2e-test"]
            if cand:
                sid = cand[0]["id"]; break
        except Exception:
            pass
        time.sleep(0.2)
    if not sid:
        fail("worker never registered a session with the relay")
    ok(f"session registered: {sid}")

    step("send a user turn via OUR client API")
    post(f"/api/sessions/{sid}/input", {"content": f"Reply with exactly one word: {TOKEN}"})
    ok("input accepted")

    step("await assistant reply (worker runs inference via passthrough)")
    reply = None
    for _ in range(150):  # up to ~30s
        try:
            evs = get(f"/api/sessions/{sid}/events")["events"]
            for e in evs:
                if e["type"] == "assistant" and TOKEN in (e.get("text") or ""):
                    reply = e["text"]; break
        except Exception:
            pass
        if reply:
            break
        time.sleep(0.2)
    if not reply:
        fail(f"no assistant reply containing {TOKEN} within timeout")
    ok(f"assistant replied via relay: {reply!r}")

    print("\n\033[32m\033[1mPASS\033[0m — TUI worker ↔ our relay ↔ our client round-trip verified.")
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
