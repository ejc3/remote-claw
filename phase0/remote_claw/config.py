"""Configuration and on-disk paths for remote-claw."""
from __future__ import annotations

import os
from dataclasses import dataclass, field

#: Host whose Remote Control traffic we intercept (also the real inference host).
MITM_HOST = "api.anthropic.com"

#: Endpoints we serve ourselves (the relay). Everything else is passed through.
INTERCEPT_PREFIXES = ("/v1/code/sessions", "/v1/code/triggers")


def _root() -> str:
    # phase0/ — the package lives in phase0/remote_claw/
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@dataclass
class Config:
    """Runtime configuration, assembled from CLI flags / environment."""

    proxy_port: int = 8888
    client_port: int = 9100
    #: Bind address for the client face. Localhost by default; only widen with care.
    client_host: str = "127.0.0.1"
    verbose: bool = False
    #: When True, the client face is reachable off-host (still token-gated).
    expose: bool = False

    root: str = field(default_factory=_root)

    @property
    def certs_dir(self) -> str:
        return os.path.join(self.root, "mitm", "certs")

    @property
    def ca_pem(self) -> str:
        return os.path.join(self.certs_dir, "ca.pem")

    @property
    def ca_key(self) -> str:
        return os.path.join(self.certs_dir, "ca.key")

    @property
    def leaf_pem(self) -> str:
        return os.path.join(self.certs_dir, "leaf.pem")

    @property
    def leaf_key(self) -> str:
        return os.path.join(self.certs_dir, "leaf.key")

    @property
    def state_dir(self) -> str:
        d = os.environ.get("REMOTE_CLAW_STATE", os.path.join(self.root, ".state"))
        os.makedirs(d, mode=0o700, exist_ok=True)
        return d

    @property
    def token_file(self) -> str:
        return os.path.join(self.state_dir, "client-token")

    @property
    def relay_log(self) -> str:
        return os.path.join(self.state_dir, "relay.log")

    @property
    def pid_file(self) -> str:
        return os.path.join(self.state_dir, "relay.pid")
