#!/usr/bin/env python3
"""Diagnostic: what does the claude TUI show when we type /remote-control?"""
import fcntl, os, pty, re, select, signal, struct, subprocess, sys, termios, threading, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, ROOT)
from remote_claw import certs  # noqa: E402
from remote_claw.config import Config  # noqa: E402

cfg = Config(proxy_port=8888, client_port=9100); certs.ensure(cfg)
CWD = f"/tmp/rc-diag-{os.getpid()}"; os.makedirs(CWD, exist_ok=True)
ANSI = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\r")

relay = subprocess.Popen([sys.executable, "-m", "remote_claw", "relay", "--proxy-port", "8888",
                          "--client-port", "9100", "-v"], cwd=ROOT,
                         env=dict(os.environ, REMOTE_CLAW_TOKEN="diag"),
                         stdout=open("/tmp/diag-relay.log", "w"), stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, start_new_session=True)
time.sleep(2)

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
buf = bytearray()
env = dict(os.environ, TERM="xterm-256color", HTTPS_PROXY="http://127.0.0.1:8888",
           HTTP_PROXY="http://127.0.0.1:8888", NODE_EXTRA_CA_CERTS=cfg.ca_pem)
proc = subprocess.Popen(["claude", "--permission-mode", "bypassPermissions"],
                        stdin=slave, stdout=slave, stderr=slave, env=env, cwd=CWD,
                        start_new_session=True, close_fds=True)
os.close(slave)
stop = [False]
def reader():
    while not stop[0]:
        r, _, _ = select.select([master], [], [], 0.3)
        if r:
            try: d = os.read(master, 8192)
            except OSError: return
            if not d: return
            buf.extend(d)
threading.Thread(target=reader, daemon=True).start()

def screen(): return ANSI.sub(b" ", bytes(buf)).decode("utf-8", "replace")
def dump(label):
    s = screen()
    print(f"\n========== {label} ==========")
    print("\n".join(l for l in s.splitlines() if l.strip())[-2500:])

time.sleep(2)
if "trust" in screen().lower():
    os.write(master, b"\r"); time.sleep(2)
time.sleep(6)
dump("after launch")

print("\n>>> typing '/remote-control' (no enter yet)")
os.write(master, b"/remote-control"); time.sleep(2.5)
dump("after typing /remote-control (palette state)")

print("\n>>> pressing Enter")
os.write(master, b"\r"); time.sleep(4)
dump("after Enter #1")

print("\n>>> pressing Enter again (in case of name/confirm prompt)")
os.write(master, b"\r"); time.sleep(5)
dump("after Enter #2")

time.sleep(5)
dump("after wait")
print("\nRC active substring present:", "Remote Control active" in screen())

stop[0] = True
for p in (proc, relay):
    try: os.killpg(os.getpgid(p.pid), signal.SIGTERM)
    except Exception: pass
