# remote-claw

A custom client + relay for driving a **real `claude --remote-control` session**
— your own frontend in place of Anthropic's web/mobile app.

> **Current product status:** the Claude own-relay is a working developer beta. The sole active finish
> line is an installable, failure-safe, truthfully presented
> [remote-claw Claude 1.0](docs/release-finish-line.md). The broader client-driven host runtime,
> OpenCode, Codex, tmux durability, provider façades, and nested collaboration are parked future work;
> they do not block this release.

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
terminates the Anthropic control plane locally. This is an intentional boundary of the current Claude
product, not a claim that Anthropic inference is zero knowledge.

## Status

✅ **Phase 0 done — working own-relay (proved with Claude Code v2.1.168).** The original
`--sdk-url` trick is **patched** (hardcoded 5-host allowlist + wss/https-only,
rejected before any socket opens). But the real Remote Control transport turned
out to be a plain HTTPS API on `api.anthropic.com` (`/v1/code/sessions/…`), so
`remote-claw` instead **MITMs that host per-process**: it intercepts the RC
endpoints to become your own relay, while passing `/v1/messages` through to real
inference. A local `claude --remote-control` TUI and our own web client drive the
same live Claude session for browser-originated turns and observed outputs. Local-TUI prompt text is
not currently projected to viewers; remote-claw does not promise a lossless mirror of local-only input.

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
  bus + per-session relay) with capped Vercel Workflow run streams and durable SQLite/libSQL
  backends. The
  current host and viewer use sealed mode with every backend, so the backend sees only ciphertext and
  routing metadata. It also serves the mobile-first **web client** (paste a pass → discover sessions →
  drive them, decrypted in-browser).
- **`packages/cli`** — the `remote-claw` wrapper: identity/pass management (`--rc-identity`,
  `--rc-pass`), the broker transport (`BrokerClient`), and the **RC MITM backend** (`@remote-claw/cli/rc`:
  `MitmProxy` + `RelayCore`/`Session` + `HostRcRelay`) — the Phase-0 interception core ported to TS.
  Its `host/native` compatibility contract is independent of `Session`; the process-local registrar
  assigns a distinct lease to each intercepted Claude conversation and starts its bridge only after
  validated setup reaches `ready`. The MITM use of that seam is active; expanding it into a durable
  multi-engine host is not.

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

Separately, the native **`stream-json` SDK transport** (`HostRelay` + `ClaudeStreamSession`,
`--print --input-format stream-json`) remains as the **documented cousin** for cross-checking the protocol and
for an inference-agnostic headless path — point it at **Amazon Bedrock**/Vertex (`{ bedrock: true }`)
and claude routes inference via the AWS SDK while remote-claw relays it, never touching the creds.

📐 **Design:** [`docs/v2-architecture.md`](docs/v2-architecture.md) — the full v2 design,
threat model, key hierarchy, broker, and phased plan.

🎯 **Active release finish line:** [`docs/release-finish-line.md`](docs/release-finish-line.md) — the
smallest honest path from the working Claude developer beta to an installable 1.0: one-incarnation
command safety, fail-stop delivery/output, truthful UI states, supported-version and deployment boundaries,
and one required two-leg crash-matrix/real-topology release suite.

🧭 **Parked future platform:** [`docs/client-driven-host-runtime.md`](docs/client-driven-host-runtime.md)
and [`docs/a1-opencode-vertical-slice.md`](docs/a1-opencode-vertical-slice.md) preserve the optional
multi-engine design and its safety requirements. They are not the current delivery sequence.

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

- [`docs/release-finish-line.md`](docs/release-finish-line.md) — the sole active Claude 1.0 outcome,
  safety invariants, scope boundary, and executable release gate.
- [`docs/protocol.md`](docs/protocol.md) — as-built protocol and runtime.
- [`docs/phase0-findings.md`](docs/phase0-findings.md) — reverse-engineered Claude RC evidence.
- [`docs/client-driven-host-runtime.md`](docs/client-driven-host-runtime.md) — parked future-platform
  design, not a Claude 1.0 dependency.
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

There is one required outcome: **remote-claw Claude 1.0**. Keep one live relay owner per random session,
attempt each supported browser mutation at most once across broker and worker reconnects, remove
ambiguous automatic Retry, and report host receipt without claiming native application. Validate and
deduplicate native event identity, serialize projection publication so a failed sequence has no later
successor, and end the remote session on fatal bridge failure with an honestly incomplete tail. Package
the CLI, freeze the supported Claude/deployment profile, and pass both the deterministic fail-stop
matrix and installed real-topology smoke. The exact scope and stop condition are in the
[Claude 1.0 finish line](docs/release-finish-line.md). Multi-engine work resumes only after a separate
product decision.

## ⚠️ Security

The v2 broker authenticates identity-scoped data and recovery requests and sees only sealed frames plus
routing metadata. The optional one-time handoff bootstrap is a separate, unauthenticated high-entropy
capability: if it ships enabled, its proof, short TTL, body cap, single-read store, and edge rate limit
are its gate. The host's
TLS proxy binds to `127.0.0.1`. Keep the machine secret/pass, provider credentials, generated CA key,
and Vercel bypass secret private. The current default Anthropic inference path intentionally forwards
non-RC traffic; the zero-knowledge claim applies to the remote-claw broker, not to the model provider.
The Claude 1.0 target does not require a new multi-provider credential or connector architecture. A
viewer pass grants read and control for every session on that machine identity; pass holders are
mutually trusted and can construct valid sealed frames. There is no per-viewer role or individual
revocation in v1: resetting the machine identity moves future service but does not revoke copied old
credentials on retained routes.

## License

TBD.
