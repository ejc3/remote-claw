#!/usr/bin/env python3
"""P0.5 — full TUI-side verification for the MITM design.

Proves, against a REAL interactive `claude` TUI driven through our Phase-0 MITM
relay:
  C1  enabling `/remote-control` (slash command, mid-session) works and points RC
      at OUR relay (HTTPS_PROXY), not Anthropic's.
  C2  the wrapper/relay receives the session's PRIOR chat history on enable
      (worker backfills it) — i.e. the wrapper has access to chat history.
  C3  a message from a GENERIC client (our relay client API) reaches the real TUI
      and the assistant reply comes back to the client (full bidirectional control).
  C4  the same exchange appears in the local TUI (one synced session).
  C5  in-memory recovery: after the relay loses all state (restart), re-enabling
      `/remote-control` makes the worker re-backfill the full history → state is
      recoverable from the underlying claude session, so the wrapper can be
      memory-only.

Drives the claude TUI via a pty (types real keystrokes), talks to the relay's
token-gated client API. Stdlib only.
"""
import json
import os
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import fcntl  # noqa: E402
import pty  # noqa: E402

from remote_claw import certs  # noqa: E402
from remote_claw.config import Config  # noqa: E402

PROXY, CLIENT = 8888, 9100
TOKEN = "tui-verify-" + str(os.getpid())
BASE = f"http://127.0.0.1:{CLIENT}"
H = {"Authorization": f"Bearer {TOKEN}", "content-type": "application/json"}
ANSI = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\r")

cfg = Config(proxy_port=PROXY, client_port=CLIENT)
CWD = f"/tmp/rc-verify-{os.getpid()}"  # dedicated dir so `--continue` resumes OUR session
results = {}


def ok(m): print(f"  \033[32m✓\033[0m {m}", flush=True)
def bad(m): print(f"  \033[31m✗ {m}\033[0m", flush=True)
def step(m): print(f"\033[1m▶ {m}\033[0m", flush=True)


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=8) as r:
        return json.load(r)


def post(path, obj):
    req = urllib.request.Request(BASE + path, data=json.dumps(obj).encode(), headers=H)
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.load(r)


# ---------- pty-driven TUI ----------
class Tui:
    def __init__(self, env, extra=None):
        self.master, slave = pty.openpty()
        # give the TUI a sane window size so it renders + accepts input
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        self.buf = bytearray()
        cmd = ["claude", "--permission-mode", "bypassPermissions"] + (extra or [])
        self.proc = subprocess.Popen(
            cmd, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=CWD,
            start_new_session=True, close_fds=True)
        os.close(slave)
        self._stop = False
        threading.Thread(target=self._reader, daemon=True).start()

    def accept_trust(self):
        """A fresh cwd shows a 'Do you trust the files…' dialog — accept the default."""
        if self.wait_for("trust the files", 8) or "trust" in self.screen().lower():
            os.write(self.master, b"\r")
            time.sleep(2)

    def _reader(self):
        while not self._stop:
            r, _, _ = select.select([self.master], [], [], 0.3)
            if r:
                try:
                    d = os.read(self.master, 8192)
                except OSError:
                    return
                if not d:
                    return
                self.buf += d

    def screen(self):
        return ANSI.sub(b" ", bytes(self.buf)).decode("utf-8", "replace")

    def wait_for(self, token, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if token in self.screen():
                return True
            time.sleep(0.4)
        return False

    def send(self, text, enter=True, settle=0.6):
        os.write(self.master, text.encode())
        time.sleep(settle)  # let the slash-command palette register before Enter
        if enter:
            os.write(self.master, b"\r")

    def kill(self):
        self._stop = True
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except Exception:
            pass


relay = None
tui = None


def start_relay():
    env = dict(os.environ, REMOTE_CLAW_TOKEN=TOKEN, RELAY_DUMP_UPSTREAM="/tmp/tui-verify-upstream.jsonl")
    return subprocess.Popen(
        [sys.executable, "-m", "remote_claw", "relay", "--proxy-port", str(PROXY),
         "--client-port", str(CLIENT), "-v"],
        cwd=ROOT, env=env, stdout=open("/tmp/tui-verify-relay.log", "a"),
        stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)


def relay_up(timeout=12):
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(f"{BASE}/healthz", timeout=2); return True
        except Exception:
            time.sleep(0.3)
    return False


def session_id(title_substr="", timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try:
            ss = get("/api/sessions")["sessions"]
            if ss:
                return ss[-1]["id"]  # most recent
        except Exception:
            pass
        time.sleep(0.5)
    return None


def events_text(sid):
    try:
        return [e for e in get(f"/api/sessions/{sid}/events")["events"]]
    except Exception:
        return []


def has_token(sid, kind, token, timeout):
    end = time.time() + timeout
    while time.time() < end:
        for e in events_text(sid):
            if e.get("type") == kind and token in (e.get("text") or ""):
                return True
        time.sleep(0.6)
    return False


def cleanup():
    if tui:
        tui.kill()
    if relay:
        try:
            os.killpg(os.getpgid(relay.pid), signal.SIGTERM)
        except Exception:
            pass


def main():
    global relay, tui
    certs.ensure(cfg)

    step("start relay (MITM proxy + client API)")
    relay = start_relay()
    if not relay_up():
        bad("relay did not start"); return 1
    ok("relay up")

    step("launch a REAL interactive claude TUI through the MITM (no --remote-control yet)")
    os.makedirs(CWD, exist_ok=True)
    env = dict(os.environ, TERM="xterm-256color",
               HTTPS_PROXY=f"http://127.0.0.1:{PROXY}", HTTP_PROXY=f"http://127.0.0.1:{PROXY}",
               NODE_EXTRA_CA_CERTS=cfg.ca_pem)
    tui = Tui(env)
    tui.accept_trust()
    if not tui.wait_for("Try", 30) and not tui.wait_for("for shortcuts", 5):
        time.sleep(6)
    ok(f"TUI launched in {CWD}")

    step("build LOCAL history in the TUI (no RC yet): teach it a word, confirm recall")
    tui.send("Remember this word: ELEPHANT. Reply with exactly: OK")
    tui.wait_for("OK", 60)
    tui.send("What word did I tell you to remember? Reply with only that word.")
    recalled = tui.wait_for("ELEPHANT", 60)
    results["local_history_works"] = recalled
    (ok if recalled else bad)("local session recalled ELEPHANT (history exists pre-RC)")

    step("[C1] enable /remote-control (slash command, mid-session)")
    time.sleep(20)                                   # ensure the prior turn finished (claude idle)
    os.write(tui.master, b"\x1b"); time.sleep(1.5)   # Escape — clear any leftover input/palette state
    tui.send("/remote-control", settle=3.0)
    rc_active = tui.wait_for("Remote Control active", 45)
    if not rc_active:                                # one retry (palette can miss the first time)
        os.write(tui.master, b"\x1b"); time.sleep(1.5)
        tui.send("/remote-control", settle=3.0)
        rc_active = tui.wait_for("Remote Control active", 45)
    results["C1_remote_control_enables"] = rc_active
    (ok if rc_active else bad)("/remote-control → 'Remote Control active' (RC on OUR relay)")
    sid = session_id() if rc_active else None
    if sid:
        ok(f"relay registered session {sid}")

    if sid:
        step("[C2] wrapper has the PRIOR chat history (worker backfilled it)")
        got_hist = has_token(sid, "user", "ELEPHANT", 25) or any(
            "ELEPHANT" in json.dumps(e) for e in events_text(sid))
        results["C2_wrapper_has_history"] = got_hist
        (ok if got_hist else bad)("relay received the pre-RC ELEPHANT exchange as history")

        step("[C3] generic client → TUI → back")
        post(f"/api/sessions/{sid}/input", {"content": "Reply with exactly one word: GIRAFFE"})
        c3 = has_token(sid, "assistant", "GIRAFFE", 60)
        results["C3_client_roundtrip"] = c3
        (ok if c3 else bad)("client-sent prompt answered (GIRAFFE) via the relay")

        step("[C4] the same exchange shows in the local TUI (one synced session)")
        c4 = tui.wait_for("GIRAFFE", 30)
        results["C4_tui_synced"] = c4
        (ok if c4 else bad)("GIRAFFE appears in the local TUI")

        step("[C5] kill BOTH (wrapper + claude CLI — both stateless), reboot, recover from claude session")
        tui.kill()
        try:
            os.killpg(os.getpgid(relay.pid), signal.SIGTERM)
        except Exception:
            pass
        time.sleep(3)
        ok("killed wrapper(relay) + claude CLI")
        relay = start_relay()
        relay_up()
        ok("relay rebooted (empty in-memory state)")
        # relaunch claude resuming the SAME on-disk session, then re-enable RC
        tui = Tui(env, extra=["--continue"])
        tui.accept_trust()
        time.sleep(12)                                   # let --continue resume + reach idle
        os.write(tui.master, b"\x1b"); time.sleep(1.5)
        tui.send("/remote-control", settle=3.0)
        rc2 = tui.wait_for("Remote Control active", 45)
        if not rc2:
            os.write(tui.master, b"\x1b"); time.sleep(1.5)
            tui.send("/remote-control", settle=3.0)
            rc2 = tui.wait_for("Remote Control active", 45)
        sid2 = session_id(timeout=25) if rc2 else None
        recovered = False
        if sid2:
            # full history must reappear, sourced only from claude's persisted session
            recovered = (has_token(sid2, "user", "ELEPHANT", 30) or
                         any("ELEPHANT" in json.dumps(e) for e in events_text(sid2))) and \
                        any("GIRAFFE" in json.dumps(e) for e in events_text(sid2))
        results["C5_kill_reboot_recovers"] = recovered
        (ok if recovered else bad)(
            "after killing both and rebooting (claude --continue + /remote-control), the full "
            "transcript (ELEPHANT + GIRAFFE) recovered from claude's persisted session → both stateless")

    print("\n=== RESULTS ===")
    for k, v in results.items():
        print(f"  {'PASS' if v else 'FAIL'}  {k}")
    allpass = all(results.values()) and len(results) >= 5
    print("\nVERDICT:", "TUI-SIDE MODEL FULLY VERIFIED" if allpass else "INCOMPLETE — see failures")
    return 0 if allpass else 2


if __name__ == "__main__":
    try:
        rc = main()
    except Exception as e:
        import traceback
        traceback.print_exc()
        rc = 1
    finally:
        cleanup()
    sys.exit(rc)
