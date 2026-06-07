"""MITM certificate authority + leaf cert management (via openssl).

Generates a throwaway CA and a leaf for `api.anthropic.com`. The CA is trusted by
the worker process only, via `NODE_EXTRA_CA_CERTS` — never installed system-wide.
Private keys are written 0600.
"""

from __future__ import annotations

import contextlib
import os
import subprocess

from .config import MITM_HOST, Config
from .log import get

log = get()
_VALIDITY_DAYS = "365"


def ensure(cfg: Config, force: bool = False) -> bool:
    """Generate the CA + leaf if absent. Returns True if it (re)generated."""
    os.makedirs(cfg.certs_dir, mode=0o700, exist_ok=True)
    if os.path.exists(cfg.ca_pem) and os.path.exists(cfg.leaf_pem) and not force:
        return False
    if not _have_openssl():
        raise RuntimeError("openssl not found on PATH; cannot generate certs")

    d = cfg.certs_dir

    def run(*args: str) -> None:
        subprocess.run(
            ["openssl", *args], check=True, cwd=d, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )

    run("genrsa", "-out", "ca.key", "2048")
    run(
        "req",
        "-x509",
        "-new",
        "-nodes",
        "-key",
        "ca.key",
        "-sha256",
        "-days",
        _VALIDITY_DAYS,
        "-out",
        "ca.pem",
        "-subj",
        "/CN=remote-claw-CA",
    )
    run("genrsa", "-out", "leaf.key", "2048")
    run("req", "-new", "-key", "leaf.key", "-out", "leaf.csr", "-subj", f"/CN={MITM_HOST}")
    with open(os.path.join(d, "leaf.ext"), "w") as f:
        f.write(f"subjectAltName=DNS:{MITM_HOST}\nextendedKeyUsage=serverAuth\n")
    run(
        "x509",
        "-req",
        "-in",
        "leaf.csr",
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        "leaf.pem",
        "-days",
        _VALIDITY_DAYS,
        "-sha256",
        "-extfile",
        "leaf.ext",
    )

    for name in ("ca.key", "leaf.key"):
        with contextlib.suppress(OSError):
            os.chmod(os.path.join(d, name), 0o600)
    log.info("generated CA + leaf cert in %s", d)
    return True


def _have_openssl() -> bool:
    return any(
        os.access(os.path.join(p, "openssl"), os.X_OK)
        for p in os.environ.get("PATH", "").split(os.pathsep)
        if p
    )
