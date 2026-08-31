# remote-claw

An E2E-encrypted multiplayer layer for locally running coding agents. A cloud broker carries sealed
conversation frames between the host and browser clients without receiving content keys or provider
credentials.

> **Status: developer beta, full goal incomplete.** Claude Code's private replacement relay works,
> and the Linux/exact-2.1.237 `claude-native` companion now provides structured, provider-ordered text
> projection while ordinary Anthropic Remote Control stays active. A bounded packed-install run kept
> the exact Claude local TUI, an authenticated Anthropic RC API client, and two remote-claw browsers on
> one native session across two fresh companion projections; broker loss stopped only the companion.
> A final bounded run added the literal logged-in official Claude web UI on the user's phone: it
> observed the browser-labelled turn and submitted its own; both turns and their replies appeared once
> in both remote-claw browsers, and a browser turn still completed after the official client
> disconnected. The Graduate commit's separate
> exact-SHA deployed-broker gate is also green. M1 is complete. The pinned OpenCode M2
> text/interrupt adapter also passed its real-TUI, two-browser, interrupt, reload, and companion-
> restart acceptance on 2026-08-30. Its read-only MAIN-session running/idle status follow-on is now
> complete after a separate real-TUI/two-browser acceptance on 2026-08-31.
> Codex M3a is also complete for exact Codex 0.151.0 on Linux arm64:
> one local TUI and two independent remote-claw browsers shared an exact app-server thread, exchanged
> uniquely labelled text once, and left one native approval and one native question solely to the TUI.
> M3b is also complete on an exact official Remote thread through Codex's managed Unix socket and
> legacy full-turn history: official Remote, the TUI, and two browsers exchanged one-copy text, and a
> browser turn remained live while provider transport was disabled. This proves provider-transport
> isolation, not per-device unsubscribe, and does not claim richer controls, restart, or broker-loss.
> M4 is also complete for the lower-fidelity tmux fallback: a packed CLI with exact Claude 2.1.237 on
> Linux arm64 and Bedrock Sonnet 4.6 kept a local pane and two browsers coherent across reload, browser
> departure, a locally approved permission prompt, broker loss, and a later local turn. A browser prompt
> stayed queued without touching the focused permission modal, then completed after both browsers had
> departed and the local owner approved. Tmux does not claim provider-native or official-client
> coexistence.
> See
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
| Claude Code | Claude TUI | Claude Remote Control | Multiple browsers | Private replacement relay works; M1's exact-2.1.237 native companion passed local TUI, literal official web UI on the user's phone, two-browser, fresh-projection restart, broker-loss, packed-install, and exact-SHA deployed-broker acceptance |
| Codex | Codex TUI | Codex Remote through ChatGPT | Multiple browsers | M3a and M3b complete for exact Codex 0.151.0 on Linux arm64: local TUI plus two browsers, native text/status, TUI-owned approvals/questions, and bounded same-thread official Remote coexistence through the managed Unix socket; failure isolation is proved at the provider-transport boundary, not as per-device unsubscribe |
| OpenCode | OpenCode TUI | Preserve any native collaboration the selected version exposes | Multiple browsers | M2 complete for exact OpenCode 1.17.5 on Linux arm64 with the pinned Bedrock Sonnet model, one explicit session, non-empty non-slash text, interrupt, and fresh-projection restart; the separate read-only MAIN running/idle status follow-on is also complete |
| tmux compatibility | Terminal pane | Not claimed by this fallback | Multiple browsers | M4 complete for exact Claude 2.1.237/Linux arm64 with Bedrock Sonnet 4.6: packed CLI, local pane, two browsers, reload, non-empty non-slash text plus attachments, active-turn native-modal isolation, browser departure, and broker-loss isolation; idle-editor concurrency, raw controls, ordering, and native application remain lower fidelity or unsupported |

Agent integration and inference routing are separate axes. Claude Code or OpenCode may route model
traffic to Anthropic or Amazon Bedrock; Codex may route through OpenAI or another supported provider.
Changing the model backend must not silently change the collaboration, identity, or broker contract.

“Accountless” has one narrow meaning: **no Anthropic account**. It does not mean credential-free. A
Bedrock/accountless run still needs AWS or Bedrock credentials, a remote-claw machine identity/viewer
pass, and any deployment credential required to reach a protected broker.

The maintained M5 accountless claim is deliberately exact: Linux arm64, Claude Code 2.1.237,
`bedrock-mantle` in `us-east-1`, `anthropic.claude-opus-4-8`, and temporary IMDSv2 SigV4. Its real
tools-disabled private-viewer text round-trip passed on 2026-08-31; other capabilities or
Bedrock/account/version tuples need separate qualification.
For that path, Claude's config, secure-storage, and Anthropic-profile roots all point at one owned
temporary directory; known inherited auth/settings overrides are removed, and fixed CCR-host token
files or Linux system-managed settings make launch fail closed rather than silently reusing an
Anthropic account or bypassing administrator policy.

## What works today

The implemented native modes are:

| Mode | Current behavior |
| --- | --- |
| `--rc-app <origin>` (default `--rc-driver=mitm`) | Runs real Claude Code behind a loopback TLS proxy, answers `/v1/code/sessions/**` locally, and relays through the E2E-encrypted broker. This replaces Anthropic Remote Control, so the official Claude client cannot join. |
| `--rc-trace` | Passes traffic to Anthropic while recording bounded, redacted protocol diagnostics. The official client can drive the session, but remote-claw browsers cannot. |
| `--rc-app <origin> --rc-driver=claude-native --remote-control` | Runs ordinary Anthropic-hosted Remote Control behind a transparent exact-session observer and mirrors provider-ordered text to remote-claw. Linux and exact Claude 2.1.237 only; permissions, questions, interrupts, model/mode changes, attachments, and end stay native/local. |
| `--rc-app <origin> --rc-driver=claude-native --rc-native-session <cse_…>` | Attaches a fresh remote-claw projection to that exact already-running native session. It starts no interactive Claude session or proxy, performs no discovery, and rejects forwarded Claude arguments; the pinned-version probe still runs. |
| `--rc-app <origin> --rc-driver=opencode --rc-oc-session <ses_…>` | Attaches a fresh projection to one exact already-running OpenCode 1.17.5 session on Linux arm64. The mutable surface remains non-empty non-slash text plus interrupt. Read-only MAIN-session running/idle status is advertised; native/local UI still owns permissions, questions, model/mode, attachments, and end. |
| `--rc-app <origin> --rc-driver=codex --rc-codex-thread <uuid>` | Attaches a fresh projection to one exact Codex thread through either an explicit-port loopback WebSocket app-server or literal `unix://`, which resolves only the current user's Codex managed control socket. Exact Codex 0.151.0/Linux arm64 only. Non-empty non-slash text and native status are supported; the attached local TUI solely owns approvals and questions, and every other browser control is disabled. |
| `--rc-app <origin> --rc-driver=tmux [claude args]` | Runs plain Claude in a recoverable private tmux pane while the lower-fidelity adapter projects transcript and serializes browser injection against active native turns. It fail-fast requires Linux arm64 and exact Claude 2.1.237 before identity, broker, or pane startup. Browser input is ordinary non-empty non-slash text plus attachments; interrupt, model, mode, and end are disabled. Permissions, questions, and folder trust stay in that local pane unless the caller explicitly bypasses Claude policy. Idle editor/config UI concurrency and independent peer ordering are not isolated. M4's maintained Bedrock tuple is green; provider-native and official-client coexistence are not advertised for this mode. |

The launch form waits for the exact successful bridge request from its Claude child. The attach form
requires the exact native ID explicitly and creates a new projection instead of discovering a session
or reusing the retired projection. Both open live SSE before bounded ascending history and publish no
writable projection until reconciliation is ready. Browser text keeps one UUID/timestamp and is not
automatically retried after an ambiguous POST; the canonical browser receipt and transcript row come
only from provider history/SSE. OAuth remains on the host. M1's literal official-client acceptance and
the Graduate commit's separate exact-SHA deployed-broker gate are green. Current evidence is
tracked in the [release roadmap](docs/release-finish-line.md).

Existing foundations:

- **`packages/clawsec`** — HKDF key separation, AES-256-GCM sealed frames, wire validation, channel
  tokens, and the `rcp1_` viewer pass.
- **`apps/web`** — authenticated ciphertext broker, durable SQLite/libSQL storage, and the browser
  client. Vercel Workflows remains an experimental backend.
- **`packages/cli`** — identity/pass custody, broker transport, Claude private RC façade and trace
  inspector, the native Anthropic companion/client, the pinned OpenCode text/interrupt/status adapter,
  the pinned Codex app-server companion, the maintained lower-fidelity tmux fallback, the exact
  maintained accountless Bedrock connector, and remaining experimental inference connectors.
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

Other supported and experimental paths have narrower current claims:

- The pinned OpenCode path connects to an exact loopback HTTP/SSE server and maps native-ordered text
  plus interrupt. It also advertises read-only MAIN-session status: native `busy`/`retry` maps to
  running, while an ordinary idle lifecycle transition is published only after exact history/status
  reproof. Child activity never drives MAIN status, and reconnect retains the last verified viewer
  state until exact reproof.
  Other versions, models, and platforms are unsupported; permission mirroring is a separate
  experimental opt-in. A separate 2026-08-31 real-TUI/two-browser run accepted the status surface.
- The pinned Codex M3a acceptance used an explicit-port loopback app-server and remains the historical
  text/status result. The current companion also accepts literal `unix://` for Codex's same-user
  managed control socket; it rejects arbitrary Unix paths. The local TUI must stay attached and owns
  approvals/questions. M3b's exact official-Remote/TUI/two-browser coexistence and provider-transport
  isolation gate is complete; richer controls, restart/backfill, and broker-loss remain separate.
- tmux captures transcripts and injects ordinary non-empty non-slash text plus attachments when no
  higher-fidelity native seam is available. Node loads a private tmux buffer before a fixed helper
  takes a shared Linux `flock`, claims the content-free gate, and holds the lock through paste, settle,
  and Enter. Synchronous `UserPromptSubmit` and `SessionEnd` use the same helper and lock. Startup probes
  `flock`; every prompt-hook helper failure becomes Claude blocking status 2. `SessionEnd` retires the
  remote projection and best-effort closes the gate (with a fallback retirement marker) while leaving
  the pane usable. There is no global Enter binding or TUI parser. This protects an active model turn
  and its native permission/question modal, not the idle editor, partial drafts, slash/config UIs, generic idle
  modals, or independent peer ordering. Those idle surfaces share one keystream and must not be
  manipulated locally while remote viewers may submit. Every raw browser control is disabled.
  To preserve that terminal
  boundary, the viewer and relay reject C0/C1 controls other than TAB/LF in text/captions, and injection
  checks every resulting prompt again before tmux. Permissions, questions, and folder trust remain in
  the local pane. Exact 2.1.237's post-loop `system/turn_duration` record conditionally releases only a
  strictly older gate generation; an old/backfilled completion cannot delete a newer local turn's gate.
  Exact latched-interrupt records use the same generation-safe release. Exact current-launch
  hook-rejection warnings instead retire only the projection, leaving the gate closed and pane usable,
  because concurrent-hook ordering is ambiguous. Old backfill and generic warnings do neither;
  `Stop`, `StopFailure`, and asynchronous notification hooks never release the gate.
  The viewer labels local versus bypass only from a direct bypass argument, the current SessionStart
  event when it supplies a mode, or a timestamped matching-session record written after the current
  transcript attach. Every attached backfill is ignored; rotation clears the prior session's mode and
  immediately reannounces without a mode, which maps posture to `unknown`. A fresh lazy transcript also publishes explicit `unknown`: the viewer says the mode is being confirmed and
  keeps text and attachments enabled. Later timestamped native evidence updates presence and follows
  local changes.
  Explicit bypass or a legacy missing posture shows permissions off; no settings parser, permission
  hook, request, or decision bridge is added.
- Bedrock redirects inference while collaboration remains a separate adapter concern. The exact M5
  tuple above is maintained; broader tuples are not implied.
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

`RC_APP` may replace `--rc-app`. The value must be an exact root origin: remote brokers require HTTPS,
while HTTP is accepted only for loopback; credentials, paths, queries, and fragments are rejected. If
`VERCEL_AUTOMATION_BYPASS_SECRET` is set for a protected remote deployment, `RC_APP` is also the
independent trust pin and must canonically match `--rc-app`; the bypass is never sent to loopback. The
launch does not print a viewer credential; obtain one separately with `remote-claw --rc-pass` and paste
it into the viewer. Host and browser must use the same backend; the durable deployment profile is
`BROKER_BACKEND=sqlite` with Turso configuration. The official Claude web/mobile app cannot see this
replacement session.

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

### Run the pinned OpenCode companion

Start and configure `opencode serve` separately, create or select the native session in OpenCode, then
attach remote-claw to that exact `ses_*`:

```bash
node dist/remote-claw.js --rc-app https://your-app.example \
  --rc-driver=opencode --rc-oc-session ses_0123456789abcdef
```

The acceptance-proved tuple is Linux arm64, exact OpenCode 1.17.5,
`amazon-bedrock/global.anthropic.claude-sonnet-4-6`, `AWS_REGION=us-west-1`, and explicit temporary
SigV4 credential environment values in the OpenCode server process. The server—not the browser—must
have its provider credentials. The `global.` model profile did not remove the SDK's region
requirement, and that OpenCode run did not consume the normal shared AWS configuration. Other regions
or credential modes require their own gate. `--rc-oc-url` accepts only an explicit-port literal HTTP
loopback origin. No forwarded Claude/OpenCode arguments are accepted.

Permission handling stays native/local by default. The browser can neither answer nor bypass native
gates. `--rc-oc-mirror-permissions` is a separate experimental positive opt-in that mutates the native
session's append-only policy; it is not part of the supported M2 tuple.

Viewer status is observation-only. MAIN `busy` and `retry` map to running; an ordinary idle lifecycle
transition appears only after exact history/status reproof. Child sessions never drive MAIN status.
SSE loss pauses write admission without inventing a new viewer state, and reconnect re-proves the exact
state before convergence. A MAIN error re-reads exact status for display without opening admission.
At 2026-08-31T05:09:54Z, an attached TUI drove the exact pinned session from native busy to idle; two
independent Chromium contexts both showed and cleared “working,” with one user and assistant copy each.

### Run the pinned Codex companion

On Linux arm64, run these in separate terminals: start exact Codex 0.151.0 app-server, attach its TUI,
then attach remote-claw to that same exact thread for the companion's entire lifetime:

```bash
codex app-server --listen ws://127.0.0.1:4500
codex --remote ws://127.0.0.1:4500
node dist/remote-claw.js --rc-app https://your-app.example \
  --rc-driver=codex --rc-codex-url ws://127.0.0.1:4500 \
  --rc-codex-thread 01234567-89ab-7cde-8fab-0123456789ab
```

Use the real UUIDv7 supplied by Codex. remote-claw resumes/joins only that thread; it never starts or
stops app-server, discovers/selects/creates/deletes/stops a thread, or owns the TUI. Only non-empty,
non-slash browser text is accepted. Approvals and questions stay in the local Codex TUI. Interrupt,
model/mode, files, attachments, and end are disabled. A durable SQLite/libSQL broker is required.

For the Codex-managed daemon used by the current Remote topology, keep the exact thread and substitute
`--rc-codex-url unix://`. That literal token maps only to
`$CODEX_HOME/app-server-control/app-server-control.sock`, or
`~/.codex/app-server-control/app-server-control.sock` when `CODEX_HOME` is unset. An arbitrary
`unix:///path` is rejected; the only other accepted transport is the historical explicit-port
`ws://127.0.0.1:<port>` or `ws://[::1]:<port>` form.

After `thread/resume`, Codex's returned `historyMode` selects the bounded history API. `paginated`
uses ascending `thread/items/list`; `legacy` uses ascending `thread/turns/list` with
`itemsView:"full"`. Both paths discard every item family except supported user/assistant text before
the 10,000 projected-item limit is counted. Projected identity is the immutable
`(turnId,itemId)` pair: replay of the same pair and bytes deduplicates, while changed projected bytes
at the same pair fence the companion.

The bounded M3b gate used an exact official Remote thread on Codex 0.151.0/Linux arm64 with literal
`unix://`, legacy full-turn hydration, the local TUI, and two independent browsers. The TUI remained
the sole approval/question owner. A provider marker appeared exactly once in both browsers; a browser
prompt and acknowledgement appeared exactly once in official Remote, the TUI, and both browsers, and
the sending browser showed its host receipt. While an ephemeral provider transport stayed disabled, a
browser-B turn completed and the managed daemon, TUI, companion, and both browsers stayed live; provider
transport then restored to connected. This proves provider-transport isolation, not per-device
unsubscribe. Richer controls, restart/backfill, and broker-loss remain unclaimed.

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
- [Native Claude coexistence](docs/native-rc-passthrough-scoping.md) — the completed M1 text slice and
  its bounded evidence.
- [Pluggable harness](docs/pluggable-harness.md) — adapter seam and honest capability model.
- [OpenCode driver](docs/opencode-driver.md), [tmux driver](docs/tmux-driver.md), and
  [Bedrock routing](docs/bedrock-rc.md) — current alternate-surface truth and limits.
- [Codex companion and evidence](docs/codex-app-server-multiclient-proof.md) and
  [OpenCode evidence](docs/opencode-native-proof.md) — pinned native observations.
- [Phase 0 findings](docs/phase0-findings.md) — historical Claude RC protocol observations. The old
  executable prototype remains available through Git history, not as maintained product code.

## License

TBD.
