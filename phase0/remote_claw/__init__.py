"""remote-claw — self-hosted relay + client for Claude Code Remote Control.

A local `claude --remote-control` TUI and a custom client share one session via a
relay you host: the relay MITMs `api.anthropic.com` per-process, intercepts the
Remote Control endpoints (`/v1/code/sessions*`) to act as the session backend, and
passes model inference (`/v1/messages`) through to the real API.

Stdlib-only by design (no third-party runtime dependencies).
"""

__version__ = "0.1.0"
