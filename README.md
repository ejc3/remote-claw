# remote-claw

An E2E-encrypted multiplayer layer for locally running coding agents. A cloud broker carries sealed
conversation frames between the host and browser clients without receiving content keys or provider
credentials.

> **Status: developer beta, full goal incomplete.** Claude Code's private replacement relay works,
> and the Linux/exact-2.1.237 `claude-native` companion now provides structured, provider-ordered text
> projection while ordinary Anthropic Remote Control stays active. A bounded packed-install run kept
> the exact Claude local TUI, an authenticated Anthropic RC API client, and two remote-claw browsers on
> one native session across two fresh companion projections; broker loss stopped only the companion.
> Literal official Claude web/mobile UI validation and the exact-SHA deployed Preview remain open. See
> [Product goal and release gates](docs/release-finish-line.md).

## Product goal

For each supported coding agent, remote-claw should preserve the agent's own local experience while
adding multiple encrypted browser collaborators:

```text
local native TUI ───────────────────────┐
official provider remote ── when offered│
                                        ├── one native conversation
remote-claw browser A ⇄ sealed broker ⇄ host adapter
remote-claw browser B ⇄ sealed broker ⇄ host adapter
```

The intended surface matrix is:

| Agent surface | Local native UI | Official provider collaboration | remote-claw browsers | Current truth |
| --- | --- | --- | --- | --- |
| Claude Code | Claude TUI | Claude Remote Control | Multiple browsers | Private replacement relay works; the exact-2.1.237 native companion projects structured text to multiple browsers, can reattach a fresh projection to one explicitly named live native session, and preserves the native session on broker loss; literal official-app UI and deployed acceptance remain incomplete |
| Codex | Codex TUI | Codex/ChatGPT Remote where supported | Multiple browsers | Research proves a pinned app-server multi-client seam; product adapter and official coexistence do not |
| OpenCode | OpenCode TUI | Preserve any native collaboration the selected version exposes | Multiple browsers | Experimental HTTP/SSE driver; coexistence and durable recovery are incomplete |
| tmux compatibility | Terminal pane | Plain Claude retains its own provider remote when requested | Multiple browsers | Experimental and deliberately lower fidelity; one Claude 2.1.237 coexistence run passed, but the official app UI was not exercised |

Agent integration and inference routing are separate axes. Claude Code or OpenCode may route model
traffic to Anthropic or Amazon Bedrock; Codex may route through OpenAI or another supported provider.
Changing the model backend must not silently change the collaboration, identity, or broker contract.

“Accountless” has one narrow meaning: **no Anthropic account**. It does not mean credential-free. A
Bedrock/accountless run still needs AWS or Bedrock credentials, a remote-claw machine identity/viewer
pass, and any deployment credential required to reach a protected broker.

## What works today

The implemented Claude modes are:

| Mode | Current behavior |
| --- | --- |
| `--rc-app <origin>` (default `--rc-driver=mitm`) | Runs real Claude Code behind a loopback TLS proxy, answers `/v1/code/sessions/**` locally, and relays through the E2E-encrypted broker. This replaces Anthropic Remote Control, so the official Claude client cannot join. |
| `--rc-trace` | Passes traffic to Anthropic while recording bounded, redacted protocol diagnostics. The official client can drive the session, but remote-claw browsers cannot. |
| `--rc-app <origin> --rc-driver=claude-native --remote-control` | Runs ordinary Anthropic-hosted Remote Control behind a transparent exact-session observer and mirrors provider-ordered text to remote-claw. Linux and exact Claude 2.1.237 only; permissions, questions, interrupts, model/mode changes, attachments, and end stay native/local. |
| `--rc-app <origin> --rc-driver=claude-native --rc-native-session <cse_…>` | Attaches a fresh remote-claw projection to that exact already-running native session. It starts no interactive Claude session or proxy, performs no discovery, and rejects forwarded Claude arguments; the pinned-version probe still runs. |
| `--rc-app <origin> --rc-driver=tmux --remote-control [name]` | Runs plain Claude with its own Anthropic Remote Control intact while the lower-fidelity tmux adapter projects transcript and pane input to remote-claw. A bounded real run passed through the Anthropic API and two browsers; official-app UI acceptance is still pending. |

The launch form waits for the exact successful bridge request from its Claude child. The attach form
requires the exact native ID explicitly and creates a new projection instead of discovering a session
or reusing the retired projection. Both open live SSE before bounded ascending history and publish no
writable projection until reconciliation is ready. Browser text keeps one UUID/timestamp and is not
automatically retried after an ambiguous POST; the canonical browser receipt and transcript row come
only from provider history/SSE. OAuth remains on the host. The literal official Claude app UI and
exact-SHA deployed Preview remain open; current evidence is tracked in the
[release roadmap](docs/release-finish-line.md).

Existing foundations:

- **`packages/clawsec`** — HKDF key separation, AES-256-GCM sealed frames, wire validation, channel
  tokens, and the `rcp1_` viewer pass.
- **`apps/web`** — authenticated ciphertext broker, durable SQLite/libSQL storage, and the browser
  client. Vercel Workflows remains an experimental backend.
- **`packages/cli`** — identity/pass custody, broker transport, Claude private RC façade and trace
  inspector, the native Anthropic companion/client, and experimental OpenCode/tmux/Bedrock adapters.
- **Provider evidence** — bounded Claude/OpenCode/Codex fixtures and documented Bedrock live runs.
  They establish specific compatibility facts, not whole-product completion.

## Current private-relay beta

```text
remote-claw browser ⇄ sealed broker ⇄ host relay ⇄ local RC façade ⇄ Claude Code
```

Ordinary OAuth and Anthropic inference pass through to Anthropic by default. The proxy binds to
loopback. Browser turns and observed native output cross the sealed broker; local-only TUI prompt text
is not guaranteed to appear in the browser.

The stable private-RC path and the native companion currently require the exact reported Claude Code
version `2.1.237 (Claude Code)`. This is a compatibility check, not launcher-file attestation. Strict
runtime parsing and fail-closed mutation admission remain the protocol safety boundary.

Experimental paths are real product work with narrower current claims:

- OpenCode connects to its HTTP/SSE server and maps the supported native subset.
- tmux captures transcripts and injects pane input when no higher-fidelity native seam is available.
- Bedrock redirects inference while collaboration remains a separate adapter concern.
- Accountless Bedrock seeds isolated Claude state so no Anthropic account is needed; it still requires
  AWS/Bedrock and remote-claw credentials.

## Getting started

```bash
git clone https://github.com/ejc3/remote-claw.git
cd remote-claw
git checkout main
pnpm install --frozen-lockfile
pnpm build:cli
```

The built executable is `dist/remote-claw.js`. A packed installation exposes `remote-claw`.

```bash
node dist/remote-claw.js --rc-identity
node dist/remote-claw.js --rc-pass
node dist/remote-claw.js --rc-show-secret
```

Only identity creation and the explicitly named pass/secret commands print sensitive material.

### Run the current Claude replacement relay

Authenticate Claude, then launch the wrapper against the deployed broker:

```bash
claude auth login
node dist/remote-claw.js --rc-app https://your-app.example --remote-control
```

`RC_APP` may replace `--rc-app`. The launch does not print a viewer credential; obtain one separately
with `remote-claw --rc-pass` and paste it into the viewer. Host and browser must use the same backend;
the durable deployment profile is `BROKER_BACKEND=sqlite` with Turso configuration. The official
Claude web/mobile app cannot see this replacement session.

### Inspect normal Anthropic Remote Control

```bash
node dist/remote-claw.js --rc-trace --remote-control
```

`RC_LOG=debug` records shapes. `RC_LOG=trace` records bounded, recursively credential-redacted JSON.
On POSIX, use an owned mode-`0600` non-symlink `RC_LOG_FILE`. Trace bodies can still contain
conversation text and must be treated as sensitive. Trace mode does not use the remote-claw broker.

When launched from another Claude session, the wrapper scrubs `CLAUDE_CODE_CHILD_SESSION` and
`CLAUDE_CODE_SESSION_ID` so the child is independent instead of a stub or resumed parent.

### Run the native text companion

On Linux with exact Claude Code 2.1.237, keep normal Anthropic Remote Control active while adding the
remote-claw viewers:

```bash
node dist/remote-claw.js --rc-app https://your-app.example \
  --rc-driver=claude-native --remote-control
```

Use a durable `sqlite`/Turso broker profile and the same backend in the viewer. This is a text-only
developer-beta surface. Native/local UI owns every permission, question, interrupt, model/mode,
attachment, and end action.

To restart only the companion for a still-running native session, explicitly supply that session's
exact `cse_*` ID:

```bash
node dist/remote-claw.js --rc-app https://your-app.example \
  --rc-driver=claude-native --rc-native-session cse_exact_native_id
```

This attach-only form accepts no forwarded Claude arguments, including `--remote-control`. Apart from
the required `claude --version` compatibility probe, it does not start or own an interactive Claude
session, stand up a proxy, scan native sessions, or reuse the old remote-claw projection.

## Development gates

After a change is frozen:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm test:install
```

Add only the gate relevant to the changed surface: a provider-native run for an adapter, Turso faults
for durable storage, browser tests and reviewed light/dark screenshots for UI work, or an exact-commit
Preview smoke for deployment changes. Product gates test observable coexistence and safety; they do
not require custom receipt chains or machine/tool byte attestation. Use E2E to discover and sentinel
real outcomes, then move each regression to the earliest trustworthy deterministic boundary instead
of copying the scenario into every layer.

## Security boundary

These are release invariants for supported or advertised paths. Experimental adapters must disclose
any gap instead of inheriting a blanket guarantee from this list.

- Broker records contain ciphertext and routing metadata, never conversation plaintext, content
  keys, viewer passes, or provider credentials.
- Provider credentials stay on the host and out of argv, browser state, broker storage, and normal
  logs.
- Broker-controlled rejection bodies/status text, SSE error data, malformed-frame parser details, and
  invalid-success parse details are discarded rather than copied into normal CLI errors.
- Every browser mutation has one stable identity. An ambiguous native write is not converted into a
  second logical command by an automatic fresh-ID retry.
- Malformed, unauthenticated, colliding, or unsupported events fail closed before a native side
  effect.
- Relay failure ends the affected projection without pretending a native action succeeded. Wherever
  the native surface permits it, the local agent and official provider collaboration remain usable.
- A viewer pass is an indefinite full bearer credential granting read, control, and record-forging
  authority for all retained sessions under one machine identity; it is not a room-scoped invitation.
  Pass holders are mutually trusted. V1 graduation requires every join or enabled pairing UI to say so;
  a one-time handoff transfers this same indefinite credential. Per-viewer identity, roles, and revocation
  are not implemented.
- One-time handoff remains default-off. It may be enabled as a separate short-lived, single-use
  delivery path only after the pre-claim UI and browser test distinguish the one-time link from its
  indefinite machine-wide pass and the deployment's external per-IP rate limit is verified.

The zero-knowledge claim applies to the remote-claw broker. A selected inference or native
collaboration provider necessarily sees the plaintext that its own API requires.

## Documentation

- [Product goal and release gates](docs/release-finish-line.md) — full target, current gaps, milestone
  order, and proportionate gates.
- [Architecture](docs/v2-architecture.md) and [Protocol](docs/protocol.md) — as-built shared system and
  current wire/runtime contracts.
- [Native Claude coexistence](docs/native-rc-passthrough-scoping.md) — the implemented text slice and
  current M1 evidence and remaining gates.
- [Pluggable harness](docs/pluggable-harness.md) — adapter seam and honest capability model.
- [OpenCode driver](docs/opencode-driver.md), [tmux driver](docs/tmux-driver.md), and
  [Bedrock routing](docs/bedrock-rc.md) — current alternate-surface truth and limits.
- [Codex evidence](docs/codex-app-server-multiclient-proof.md) and
  [OpenCode evidence](docs/opencode-native-proof.md) — pinned native observations.
- [Phase 0 findings](docs/phase0-findings.md) — historical Claude RC protocol observations. The old
  executable prototype remains available through Git history, not as maintained product code.

## License

TBD.
