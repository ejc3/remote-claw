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
from .log import get, setup
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
    certs.ensure(cfg)
    token = load_or_create_token(cfg)
    core = RelayCore()
    stop = threading.Event()

    proxy = MitmProxy(cfg, core, stop)
    client = ClientServer(cfg, core, token)

    t_proxy = threading.Thread(target=proxy.serve, name="mitm-proxy", daemon=True)
    t_client = threading.Thread(target=client.serve, name="client-api", daemon=True)
    t_proxy.start()
    t_client.start()

    url = f"http://{'<this-host>' if cfg.expose else '127.0.0.1'}:{cfg.client_port}/?token={token}"
    log.info("client UI: %s", url)
    if cfg.expose:
        log.warning(
            "client face EXPOSED on 0.0.0.0:%d — token-gated, but prefer SSH forwarding", cfg.client_port
        )

    with open(cfg.pid_file, "w") as f:
        f.write(str(os.getpid()))

    def _shutdown(*_a):
        log.info("shutting down…")
        stop.set()
        core.close_all()
        proxy.shutdown()
        client.shutdown()

    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(ValueError):  # ValueError if not in the main thread
            signal.signal(sig, _shutdown)

    stop.wait()
    # give SSE threads a moment to unwind
    t_proxy.join(timeout=2)
    with contextlib.suppress(OSError):
        os.remove(cfg.pid_file)
    get().info("stopped")
    return 0
