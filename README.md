# remote-claw

A custom client + relay for driving a **real `claude --remote-control` session**
— your own frontend in place of Anthropic's web/mobile app.

## What this is

Claude Code's official **Remote Control** lets you drive a local Claude Code
session from claude.ai/code or the Claude mobile app: the session keeps running
on your machine (your filesystem, MCP servers, tools), and the web/app are thin
windows that sync conversation **state** (not your terminal screen).

`remote-claw` replicates that — but with **a client you control**. The key is the
undocumented **`--sdk-url`** flag, which redirects a real `claude --remote-control`
connection to a relay *you* run instead of Anthropic's cloud:

```
 your client  ◀──CCRv1 (NDJSON/WebSocket)──▶  remote-claw relay  ──spawns──▶  claude --remote-control --sdk-url ws://localhost:PORT
 (web/mobile/TUI)                              (you run this)                  (the real session: your subscription, local FS/MCP/tools)
```

> **You become the relay.** With `--sdk-url`, Claude connects to *your* server,
> not Anthropic's — so this is "instead of" the official app, not "alongside" it.

## Status

🔬 **Research / pre-implementation.** No client or relay code yet. The protocol
details are **reverse-engineered and version-sensitive** — verify before building.

## Start here

📄 **[`docs/remote-control-research.md`](docs/remote-control-research.md)** — the
exhaustive hand-off doc:

- How official Remote Control works (state-sync architecture, transport, limits)
- ⭐ The reverse-engineered **CCRv1** protocol: `--sdk-url`/`--sdk-server`, the
  `initialize` handshake, control envelope, `can_use_tool` permission flow, and
  the relay recipe
- Native `stream-json` reference (the documented cousin) for cross-checking
- Proposed `remote-claw` architecture + a **phased implementation plan**
- Security considerations and open questions to verify empirically
- **§9 — Authentication & Remote Control eligibility** (read before setup)

## Getting started

Clone on your server and check out `main`:

```bash
# git
git clone https://github.com/ejc3/remote-claw.git
cd remote-claw && git checkout main

# or GitHub CLI
gh repo clone ejc3/remote-claw -- --branch main
```

Then read the docs and begin at Phase 0:

```bash
cat README.md
cat docs/remote-control-research.md
```

**Auth (do this first).** A real end-to-end test needs `claude` authenticated
with a **full claude.ai login** — an inference-only `CLAUDE_CODE_OAUTH_TOKEN` or
an `ANTHROPIC_API_KEY` **cannot establish a Remote Control session**:

```bash
claude auth login      # full-scope; uses your Pro/Max subscription
claude auth status
```

Whether the undocumented `--sdk-url` path relaxes this (Case A vs Case B) is an
open question — see **§9** of the research doc, and settle it during Phase 0.

## Implementation plan (summary)

| Phase | Goal |
| --- | --- |
| **0** | Capture the **real** handshake frames against a pinned `claude` version with a logging WebSocket server. **Do this first.** |
| **1** | Minimal relay: handshake + one user-message → assistant round-trip |
| **2** | Permission flow (`can_use_tool` allow/deny, `bypassPermissions` toggle) |
| **3** | First client surface (web recommended) |
| **4** | Multi-client fan-out + state sync |
| **5** | Transport + **auth** hardening (tunnel/broker; never expose unauthenticated) |
| **6** | Reconnect / session resume / process supervision / version pinning |

## ⚠️ Security

The relay side of this protocol has **no auth, no host allowlist, no cert
pinning** — it's also a known attack primitive (redirecting Claude to a malicious
C2). Legitimate use only (your machine, your account, your relay). Any relay we
build **must** add its own auth and bind to localhost by default.

## License

TBD.
