# remote-claw

A custom client + relay for driving a **real `claude --remote-control` session**
— your own frontend in place of Anthropic's web/mobile app.

> **Selected next architecture:** evolve the per-session Claude wrapper into a
> [client-driven host runtime](docs/client-driven-host-runtime.md) for Claude Code, Codex, OpenCode,
> and tmux. Native clients keep their real conversation/context; a small local coordinator orders
> input, correlates delivery, and translates between native clients, official Anthropic Remote,
> ChatGPT Remote connections, and remote-claw web. Wrapped inner Claude, Codex, and OpenCode processes
> never contact their providers directly.
> This is under implementation. A0.1 adds the neutral host registration contract and routes Claude
> MITM sessions through one process-local registrar; OpenCode/tmux migration, durable coordination,
> complete inner-provider isolation, Codex, and the official-client connectors remain later phases.

## What this is

Claude Code's official **Remote Control** lets you drive a local Claude Code
session from claude.ai/code or the Claude mobile app: the session keeps running
on your machine (your filesystem, MCP servers, tools), and the web/app are thin
windows that sync conversation **state** (not your terminal screen).

`remote-claw` provides the same local-session shape with **a client you control**. Today it runs the
real Claude Code behind a process-scoped local TLS proxy, answers Claude's
`/v1/code/sessions/**` Remote Control calls, and sends E2E-encrypted frames through a broker to the
remote-claw web client:

```text
remote-claw web ⇄ ciphertext broker ⇄ host relay ⇄ local RC façade ⇄ real Claude Code
```

It does **not** depend on redirecting `--sdk-url`; that route was patched out. The current default
still passes non-RC traffic, including inference/OAuth, to Anthropic, while the Bedrock/accountless mode
terminates the Anthropic control plane locally. The selected next runtime makes that boundary strict
for Claude Code, Codex, and OpenCode: every inner provider-shaped call terminates locally, and
separate remote-claw-owned connectors handle model inference and official Remote clients.

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
- **`apps/web`** — the pluggable **broker** (`POST /api/relay`, `GET /api/stream`; a per-identity
  bus + per-session relay) with ephemeral Vercel Workflow and durable SQLite/libSQL backends. The
  current host and viewer use sealed mode with every backend, so the backend sees only ciphertext and
  routing metadata. It also serves the mobile-first **web client** (paste a pass → discover sessions →
  drive them, decrypted in-browser).
- **`packages/cli`** — the `remote-claw` wrapper: identity/pass management (`--rc-identity`,
  `--rc-pass`), the broker transport (`BrokerClient`), and the **RC MITM backend** (`@remote-claw/cli/rc`:
  `MitmProxy` + `RelayCore`/`Session` + `HostRcRelay`) — the Phase-0 interception core ported to TS.
  Its new `host/native` contract is independent of `Session`; the process-local legacy registrar now
  assigns a distinct lease to each intercepted Claude conversation and starts its bridge only after
  validated setup reaches `ready`.

**The RC backend (the real one, §14/§17.5):** you run `remote-claw` like `claude` (`--rc-app <broker>`
arms it); inside, `/remote-control` lands on **our local TLS MITM of `api.anthropic.com`** (set via
`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`), which serves the `/v1/code/sessions*` worker endpoints itself
and, with the default `--rc-inference=anthropic`, passes `/v1/messages` + OAuth through. With
`--rc-inference=bedrock`, it routes inference to Bedrock and synthesizes the remaining
Anthropic-origin control/API responses locally. The wrapper *is* the RC backend, so it sees every frame
and bridges the session E2E-encrypted to the broker. **Proven end to end** by
`rc-spine.integration.test.ts`: a fake worker speaks the **exact captured `--remote-control` worker
protocol** (register → triggers → bridge → SSE → delivery-ack → events → heartbeat) through the real
MITM, and the browser viewer drives a turn, history replay (catch_up), sub-agents (`Task` + nested
replies), tool-permission grants, and multi-client — all through the real broker on the real Workflow
runtime. The real binary's leg is covered by the in-repo Phase-0 capture + the gated
`real-rc.prove.test.ts` (needs a login + PTY).

Separately, the native **`stream-json` SDK transport** (`HostRelay` + `ClaudeStreamSession`, `--print
--input-format stream-json`) remains as the **documented cousin** for cross-checking the protocol and
for an inference-agnostic headless path — point it at **Amazon Bedrock**/Vertex (`{ bedrock: true }`)
and claude routes inference via the AWS SDK while remote-claw relays it, never touching the creds.

📐 **Design:** [`docs/v2-architecture.md`](docs/v2-architecture.md) — the full v2 design,
threat model, key hierarchy, broker, and phased plan.

🧭 **Next host runtime:** [`docs/client-driven-host-runtime.md`](docs/client-driven-host-runtime.md) —
the selected inside-adapter → coordinator → outside-adapter design for Claude Code, Codex, OpenCode,
tmux, official Remote clients, and remote-claw web.

🔑 **Credential handoff:** [`docs/ephemeral-handoff.md`](docs/ephemeral-handoff.md) — the one-time-key
(OTK) ephemeral handoff that replaces the forever pass-in-QR with a single-use, short-TTL bootstrap
token sealed in a zero-knowledge broker store.

📄 **[`phase0/README.md`](phase0/README.md)** — how to run it ·
**[`docs/phase0-findings.md`](docs/phase0-findings.md)** — the full reverse-engineered
protocol, the de-minified `--sdk-url` validator, and the build writeup (§4a–4c) ·
**[`phase0/TEST_PLAN.md`](phase0/TEST_PLAN.md)** — test plan.

🔬 The Phase 0 notes are **pre-investigation research**. Read Parts 3/5/6 of the research doc as
history; the verified current protocol is in `protocol.md` and `phase0-findings.md`.

## Start here

For the current implementation, read:

- [`docs/protocol.md`](docs/protocol.md) — as-built protocol and runtime.
- [`docs/client-driven-host-runtime.md`](docs/client-driven-host-runtime.md) — selected next
  architecture and delivery order.
- [`docs/phase0-findings.md`](docs/phase0-findings.md) — reverse-engineered Claude RC evidence.
- [`docs/remote-control-research.md`](docs/remote-control-research.md) — historical research that led
  to Phase 0.

## Getting started

Clone on your server and check out `main`:

```bash
# git
git clone https://github.com/ejc3/remote-claw.git
cd remote-claw && git checkout main

# or GitHub CLI
gh repo clone ejc3/remote-claw -- --branch main
```

Then install dependencies and run the repository gates:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm test
```

**Auth for current default Anthropic inference.** A real end-to-end test needs `claude` authenticated
with a full claude.ai login. An inference-only `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY` cannot establish an official Remote Control session:

```bash
claude auth login      # full-scope; uses your Pro/Max subscription
claude auth status
```

The current `--rc-inference=bedrock --rc-accountless` path is separate: remote-claw supplies the
private RC/control façade and routes inference to Bedrock, so it does not create an official
Anthropic Remote session.

## Next implementation

The active sequence is A0.2 OpenCode/tmux registration → A1 runtime owner/control journal → A2
OpenCode vertical slice → wrapped Claude → wrapped Codex/ChatGPT Remote → tmux recovery. A0.1, the
neutral seam plus Claude MITM migration, is implemented. The proof gates and per-PR boundaries are in
[Client-driven Host Runtime §13](docs/client-driven-host-runtime.md#13-delivery-plan).

## ⚠️ Security

The v2 broker authenticates requests and sees only sealed frames plus routing metadata; the host's TLS
proxy binds to `127.0.0.1`. Keep the machine secret/pass, provider credentials, generated CA key, and
Vercel bypass secret private. The current default Anthropic inference path intentionally forwards
non-RC traffic and is not yet the selected runtime's process-isolation boundary. The release target
requires synthetic inner credentials, separate connector credentials, and a network fence that
prevents direct provider fallback.

## License

TBD.
