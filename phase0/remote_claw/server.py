"""Process orchestration: token, MITM proxy + client face, graceful shutdown."""

from __future__ import annotations

import contextlib
import os
import secrets
import signal
import threading

from . import certs
from .client_api import ClientServer
from .config import Config
from .core import RelayCore
from .log import setup
from .mitm import MitmProxy


def load_or_create_token(cfg: Config) -> str:
    """Stable per-install client token (0600). Override with REMOTE_CLAW_TOKEN."""
    env = os.environ.get("REMOTE_CLAW_TOKEN")
    if env:
        return env
    path = cfg.token_file
    if os.path.exists(path):
        with open(path) as f:
            tok = f.read().strip()
        if tok:
            return tok
    tok = secrets.token_hex(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(tok)
    return tok


def run(cfg: Config) -> int:
    """Run the relay in the foreground until SIGINT/SIGTERM."""
    log = setup(cfg.verbose, logfile=cfg.relay_log)
    with contextlib.suppress(OSError):
        os.chmod(cfg.relay_log, 0o600)  # the log may carry session content
    certs.ensure(cfg)
    token = load_or_create_token(cfg)
    core = RelayCore()
    stop = threading.Event()

    proxy = MitmProxy(cfg, core, stop)
    client = ClientServer(cfg, core, token, stop)

    t_proxy = threading.Thread(target=proxy.serve, name="mitm-proxy", daemon=True)
    t_client = threading.Thread(target=client.serve, name="client-api", daemon=True)
    t_proxy.start()
    t_client.start()

    # NEVER log the token (the relay log is persisted). The token lives 0600 in
    # token_file; `remote-claw up` reads it and prints the URL to the user's terminal.
    host = "<this-host>" if cfg.expose else "127.0.0.1"
    log.info("client UI on http://%s:%d/ (token in %s)", host, cfg.client_port, cfg.token_file)
    if cfg.expose:
        log.warning(
            "client face EXPOSED on 0.0.0.0:%d over PLAINTEXT HTTP — the token rides "
            "the wire in clear. Prefer SSH forwarding; only expose on a trusted network.",
            cfg.client_port,
        )

    with open(cfg.pid_file, "w") as f:
        f.write(str(os.getpid()))

    # Signal handlers must be cheap and async-signal-safe: only flip the flag.
    # The actual teardown runs below on the main thread after stop.wait().
    def _on_signal(*_a):
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(ValueError):  # ValueError if not in the main thread
            signal.signal(sig, _on_signal)

    try:
        stop.wait()
    except KeyboardInterrupt:
        stop.set()
    log.info("shutting down…")
    core.close_all()  # wake worker/client SSE followers so they exit promptly
    proxy.shutdown()
    client.shutdown()
    t_proxy.join(timeout=3)
    t_client.join(timeout=3)
    with contextlib.suppress(OSError):
        os.remove(cfg.pid_file)
    log.info("stopped")
    return 0
