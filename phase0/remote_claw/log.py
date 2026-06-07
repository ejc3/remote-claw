"""Logging with secret redaction.

The relay handles short-lived credentials (`worker_jwt`, oauth bearer tokens) and
user message content. Nothing sensitive should ever reach a log sink, so all
records pass through a redacting filter before formatting.
"""
from __future__ import annotations

import logging
import re
import sys

# Patterns for values that must never be logged verbatim.
_REDACTIONS = [
    (re.compile(r"sk-ant-[a-zA-Z0-9_-]+"), "sk-ant-***"),
    (re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)\S+"), r"\1***"),
    (re.compile(r"(?i)(\"?(?:access|refresh)_?token\"?\s*[:=]\s*\"?)[^\"\s,}]+"), r"\1***"),
    (re.compile(r"(?i)(\"?worker_jwt\"?\s*[:=]\s*\"?)[^\"\s,}]+"), r"\1***"),
    (re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+"), "<jwt>"),
]


def redact(text: str) -> str:
    """Mask credentials in an arbitrary string."""
    for pat, repl in _REDACTIONS:
        text = pat.sub(repl, text)
    return text


class _RedactFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = redact(record.getMessage())
            record.args = ()
        except Exception:
            pass
        return True


def setup(verbose: bool, logfile: str | None = None) -> logging.Logger:
    """Configure the package logger. Idempotent."""
    logger = logging.getLogger("remote_claw")
    logger.setLevel(logging.DEBUG if verbose else logging.INFO)
    logger.handlers.clear()
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s",
                            datefmt="%Y-%m-%dT%H:%M:%S%z")
    redactor = _RedactFilter()

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    sh.addFilter(redactor)
    logger.addHandler(sh)

    if logfile:
        fh = logging.FileHandler(logfile)
        fh.setFormatter(fmt)
        fh.addFilter(redactor)
        logger.addHandler(fh)

    logger.propagate = False
    return logger


def get(name: str = "remote_claw") -> logging.Logger:
    return logging.getLogger(name)
