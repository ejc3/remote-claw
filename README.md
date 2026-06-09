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

✅ **Phase 0 done — working own-relay (Claude Code v2.1.168).** The original
`--sdk-url` trick is **patched** (hardcoded 5-host allowlist + wss/https-only,
rejected before any socket opens). But the real Remote Control transport turned
out to be a plain HTTPS API on `api.anthropic.com` (`/v1/code/sessions/…`), so
`remote-claw` instead **MITMs that host per-process**: it intercepts the RC
endpoints to become your own relay, while passing `/v1/messages` through to real
inference. A local `claude --remote-control` TUI and our own web client now drive
**one synced session** — empirically verified end-to-end and covered by an
automated test.

```bash
cd phase0
./remote-claw doctor      # check claude/openssl/certs/ports/auth
./remote-claw up mysession   # relay + TUI; prints a tokenised UI URL (:9100)
./remote-claw test        # automated tests (e2e + two-surface)
```

Hardened: stdlib-only `remote_claw` package, token-gated client face, secret-redacted
logs, 0600 cert keys, graceful shutdown, unit + integration tests, and CI
(`.github/workflows/ci.yml`). See [`phase0/README.md`](phase0/README.md).

## v2 — cloud-brokered, zero-knowledge, E2E-encrypted (BUILT & PROVEN 2026-06-09)

Phase 0 proved the interception. **v2** is the product: drive your machine's claude
sessions from a phone/browser through a **zero-knowledge cloud broker** that sees only
ciphertext. It is built, reviewed, merged, and **proven end-to-end with a real `claude`**.

- **`packages/clawsec`** — the crypto core: the HKDF key hierarchy, per-message AES-256-GCM,
  the §8 wire envelope, the derivable channel tokens, and the `rcp1_` viewer **pass**.
- **`apps/web`** — the **broker** (two routes on Vercel Workflows — `POST /api/relay`,
  `GET /api/stream`; a per-identity bus + per-session relay; **no store**) and the
  mobile-first **web client** (paste a pass → discover sessions → drive them, decrypted
  in-browser).
- **`packages/cli`** — the `remote-claw` wrapper: identity/pass management (`--rc-identity`,
  `--rc-pass`), the broker transport (`BrokerClient`), and the **RC MITM backend** (`@remote-claw/cli/rc`:
  `MitmProxy` + `RelayCore`/`Session` + `HostRcRelay`) — the Phase-0 interception core ported to TS.

**The RC backend (the real one, §14/§17.5):** you run `remote-claw` like `claude` (`--rc-app <broker>`
arms it); inside, `/remote-control` lands on **our local TLS MITM of `api.anthropic.com`** (set via
`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`), which serves the `/v1/code/sessions*` worker endpoints itself
and passes `/v1/messages` + OAuth through. The wrapper *is* the RC backend, so it sees every frame and
bridges the session E2E-encrypted to the broker. **Proven end to end** by `rc-spine.integration.test.ts`:
a fake worker speaks the **exact captured `--remote-control` worker protocol** (register → triggers →
bridge → SSE → delivery-ack → events → heartbeat) through the real MITM, and the browser viewer drives a
turn, history replay (catch_up), sub-agents (`Task` + nested replies), tool-permission grants, and
multi-client — all through the real broker on the real Workflow runtime. The real binary's leg is
covered by the in-repo Phase-0 capture + the gated `real-rc.prove.test.ts` (needs a login + PTY).

The native **`stream-json` SDK transport** (`HostRelay` + `ClaudeStreamSession`, `--print
--input-format stream-json`) remains as the **documented cousin** for cross-checking the protocol and
for an inference-agnostic headless path — point it at **Amazon Bedrock**/Vertex (`{ bedrock: true }`)
and claude routes inference via the AWS SDK while remote-claw relays it, never touching the creds.

📐 **Design:** [`docs/v2-architecture.md`](docs/v2-architecture.md) — the full v2 design,
threat model, key hierarchy, broker, and phased plan.

📄 **[`phase0/README.md`](phase0/README.md)** — how to run it ·
**[`docs/phase0-findings.md`](docs/phase0-findings.md)** — the full reverse-engineered
protocol, the de-minified `--sdk-url` validator, and the build writeup (§4a–4c) ·
**[`phase0/TEST_PLAN.md`](phase0/TEST_PLAN.md)** — test plan.

🔬 The notes below are the **pre-investigation** research — read Parts 3/5/6 of the
research doc as history; the verified protocol is in `phase0-findings.md`.

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
