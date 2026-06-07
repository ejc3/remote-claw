"""Command-line interface for remote-claw."""

from __future__ import annotations

import argparse
import contextlib
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

from . import __version__, certs, server
from .config import Config
from .log import setup

C = {"g": "\033[32m", "r": "\033[31m", "y": "\033[33m", "b": "\033[1m", "x": "\033[0m"}


def _ok(m):
    print(f"{C['g']}✓{C['x']} {m}")


def _bad(m):
    print(f"{C['r']}✗{C['x']} {m}")


def _info(m):
    print(f"{C['y']}•{C['x']} {m}")


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _port_free(port: int) -> bool:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _cfg(a: argparse.Namespace) -> Config:
    return Config(
        proxy_port=a.proxy_port,
        client_port=a.client_port,
        verbose=getattr(a, "verbose", False),
        expose=getattr(a, "expose", False),
    )


# ---------------- commands ----------------
def cmd_doctor(a) -> int:
    setup(False)
    cfg = _cfg(a)
    okall = True

    cl = shutil.which("claude")
    if cl:
        v = subprocess.run([cl, "--version"], capture_output=True, text=True).stdout.strip()
        _ok(f"claude: {cl} ({v})")
    else:
        _bad("claude not found on PATH")
        okall = False

    if shutil.which("openssl"):
        _ok("openssl present")
    else:
        _bad("openssl missing")
        okall = False

    if os.path.exists(cfg.ca_pem):
        _ok(f"certs present ({cfg.certs_dir})")
    else:
        _info("certs not generated — run: remote-claw certs")

    for p in (cfg.proxy_port, cfg.client_port):
        if _port_free(p):
            _ok(f"port {p} free")
        else:
            _bad(f"port {p} in use")
            okall = False

    print(f"\n{C['b']}auth:{C['x']}")
    if cl:
        r = subprocess.run([cl, "auth", "status"], capture_output=True, text=True)
        sys.stdout.write(r.stdout or r.stderr)
    return 0 if okall else 1


def cmd_certs(a) -> int:
    setup(False)
    certs.ensure(_cfg(a), force=a.force)
    _ok("certs ready")
    return 0


def cmd_relay(a) -> int:
    return server.run(_cfg(a))


def _worker_argv(a) -> tuple[list[str], dict]:
    cfg = _cfg(a)
    env = dict(os.environ)
    env["HTTPS_PROXY"] = env["HTTP_PROXY"] = f"http://127.0.0.1:{cfg.proxy_port}"
    env["NODE_EXTRA_CA_CERTS"] = cfg.ca_pem
    cmd = [shutil.which("claude") or "claude", "--remote-control", a.name, "--verbose"]
    if a.permission_mode:
        cmd += ["--permission-mode", a.permission_mode]
    return cmd, env


def cmd_worker(a) -> int:
    cmd, env = _worker_argv(a)
    os.execvpe(cmd[0], cmd, env)


def _healthz(port: int, timeout: float) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2):
                return True
        except Exception:
            time.sleep(0.2)
    return False


def cmd_up(a) -> int:
    setup(a.verbose)
    cfg = _cfg(a)
    certs.ensure(cfg)
    if not _port_free(cfg.proxy_port) or not _port_free(cfg.client_port):
        _bad("relay ports busy — run `remote-claw stop` first")
        return 1
    _info("starting relay…")
    relay_cmd = [
        sys.executable,
        "-m",
        "remote_claw",
        "relay",
        "--proxy-port",
        str(cfg.proxy_port),
        "--client-port",
        str(cfg.client_port),
        "-v",
    ]
    if cfg.expose:
        relay_cmd.append("--expose")
    with open(cfg.relay_log, "w") as log:  # parent closes its copy; child keeps its own fd
        proc = subprocess.Popen(
            relay_cmd, stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True, cwd=ROOT
        )
    if not _healthz(cfg.client_port, 10):
        _bad("relay failed to start; see " + cfg.relay_log)
        proc.terminate()  # don't orphan the spawned relay holding the ports
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=5)
        return 1
    token = server.load_or_create_token(cfg)
    _ok(f"relay up (pid {proc.pid})")
    _ok(f"client UI: http://127.0.0.1:{cfg.client_port}/?token={token}")
    _info(f"forward it:  ssh -L {cfg.client_port}:127.0.0.1:{cfg.client_port} <this-box>")
    print(
        f"{C['y']}launching the TUI below; closing it stops the worker. "
        f"relay stays up — `remote-claw stop` to end it.{C['x']}\n"
    )
    cmd, env = _worker_argv(a)
    with contextlib.suppress(KeyboardInterrupt):
        subprocess.run(cmd, env=env)
    return 0


def cmd_stop(a) -> int:
    setup(False)
    cfg = _cfg(a)
    # Only the relay we tracked — never a broad `pkill -f remote-control`, which
    # would also kill the user's OTHER `claude --remote-control` sessions.
    if not os.path.exists(cfg.pid_file):
        _info("no tracked relay running")
        return 0
    try:
        with open(cfg.pid_file) as f:
            pid = int(f.read().strip())
        os.kill(pid, signal.SIGTERM)
        _ok(f"stopped relay (pid {pid})")
    except (ProcessLookupError, ValueError):
        _info("tracked relay not running")
    with contextlib.suppress(OSError):
        os.remove(cfg.pid_file)
    _info("workers stop when you close their TUI")
    return 0


def cmd_logs(a) -> int:
    cfg = _cfg(a)
    if not os.path.exists(cfg.relay_log):
        _info("no relay log yet — start one with `remote-claw up` or `relay`")
        return 1
    with contextlib.suppress(KeyboardInterrupt):
        subprocess.call(["tail", "-f", cfg.relay_log])
    return 0


def cmd_test(a) -> int:
    rc = subprocess.call([sys.executable, os.path.join(ROOT, "tests", "e2e.py")])
    if rc:
        return rc
    print()
    return subprocess.call([sys.executable, os.path.join(ROOT, "tests", "two_surface.py")])


# ---------------- parser ----------------
def build_parser() -> argparse.ArgumentParser:
    # Ports are accepted both before AND after the subcommand. The top-level
    # parser carries the real defaults; the subcommand copy uses SUPPRESS so that
    # `remote-claw --proxy-port N relay` is NOT silently overwritten by a default.
    top_ports = argparse.ArgumentParser(add_help=False)
    top_ports.add_argument("--proxy-port", type=int, default=8888)
    top_ports.add_argument("--client-port", type=int, default=9100)
    sub_ports = argparse.ArgumentParser(add_help=False)
    sub_ports.add_argument("--proxy-port", type=int, default=argparse.SUPPRESS)
    sub_ports.add_argument("--client-port", type=int, default=argparse.SUPPRESS)

    ap = argparse.ArgumentParser(
        prog="remote-claw",
        parents=[top_ports],
        description="Self-hosted relay + client for Claude Code Remote Control.",
    )
    ap.add_argument("--version", action="version", version=f"remote-claw {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", parents=[sub_ports], help="check environment + auth")
    pc = sub.add_parser("certs", parents=[sub_ports], help="generate the MITM CA + leaf cert")
    pc.add_argument("--force", action="store_true")
    pr = sub.add_parser("relay", parents=[sub_ports], help="run the relay in the foreground")
    pr.add_argument("-v", "--verbose", action="store_true")
    pr.add_argument("--expose", action="store_true", help="bind client face to 0.0.0.0 (token-gated)")
    for name, helptext in (("worker", "launch the TUI worker"), ("up", "relay (bg) + worker (TUI)")):
        sp = sub.add_parser(name, parents=[sub_ports], help=helptext)
        sp.add_argument("name", nargs="?", default="remote-claw")
        sp.add_argument("--permission-mode", choices=["default", "acceptEdits", "plan", "bypassPermissions"])
        sp.add_argument("-v", "--verbose", action="store_true")
        if name == "up":
            sp.add_argument("--expose", action="store_true")
    sub.add_parser("stop", parents=[sub_ports], help="stop the background relay + workers")
    sub.add_parser("test", parents=[sub_ports], help="run the integration tests")
    sub.add_parser("logs", parents=[sub_ports], help="tail the relay event flow")
    return ap


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    return {
        "doctor": cmd_doctor,
        "certs": cmd_certs,
        "relay": cmd_relay,
        "worker": cmd_worker,
        "up": cmd_up,
        "stop": cmd_stop,
        "logs": cmd_logs,
        "test": cmd_test,
    }[a.cmd](a) or 0
