# Remote Control — historical research notes

> **Current context (2026-08-24):** this is an unabridged historical notebook, not current product
> direction. The full product covers Claude Code, Codex, OpenCode, and tmux. A bounded M0 run proved
> lower-fidelity coexistence through the retained tmux route. The M1 native-RC structured text vertical
> now uses the client REST/SSE seam summarized in [Phase 0 findings](phase0-findings.md) and has passed
> focused and authenticated provider-API-path acceptance. Literal official Claude UI proof and M1
> Graduate hardening remain open. Current contracts live in
> [Architecture](v2-architecture.md) and [Product goal and release gates](release-finish-line.md).

> **Purpose of this document.** Capture, in exhaustive detail, everything we
> learned about Claude Code's "Remote Control" feature and how to build our
> **own client** that drives a real `claude --remote-control` session. This is
> the hand-off doc for a fresh implementation session. Read it top to bottom;
> the load-bearing section is **Part 3 (the reverse-engineered protocol)**.

> **Historical status at capture:** research only. No code yet. All protocol details about
> undocumented flags are **reverse-engineered and unsupported** — pin a Claude
> Code version and verify empirically before relying on any frame shape.

> ⛔ **PHASE 0 RESULT (2026-06-07, v2.1.168) — THE CORE PREMISE IS PATCHED.**
> `--sdk-url` now enforces a **hardcoded 5-host allowlist** (`api.anthropic.com`,
> `api-staging.anthropic.com`, `beacon.claude-ai.staging.ant.dev`,
> `claude.fedstart.com`, `claude-staging.fedstart.com`) + **wss/https-only**,
> rejecting any self-hosted relay *before any socket opens* (and firing a
> `tengu_sdk_url_host_rejected` telemetry event). No env/setting extends it.
> **You can no longer point `--sdk-url` at your own server on this version.**
> Parts 3, 5, 6 below describe the *old, now-unreachable* behavior — read them as
> history. The viable path forward is the documented `stream-json` cousin
> (Part 4). **See [`phase0-findings.md`](phase0-findings.md) for the full
> empirical result, the de-minified validator, and corrected frame shapes.**

> **Date captured:** 2026-06-07 · **Claude Code version in research env:** 2.1.168

---

## 0. TL;DR (the whole thing in 10 lines)

- **Goal:** keep using the *real* `claude --remote-control` session, but replace
  Anthropic's web/app frontend with **our own client**.
- **The official relay protocol is private/undocumented** — there is no public
  API to *join* an existing Anthropic-hosted Remote Control session as a third
  client. Trying to speak Anthropic's cloud relay is the genuinely-hard path.
- **BUT** `claude` has an **undocumented `--sdk-url <URL>` (a.k.a. `--sdk-server`)
  flag** that points the Remote Control connection at **any server you choose**.
- So we **stand up our own relay** speaking the **CCRv1** protocol (NDJSON over
  WebSocket), launch `claude --remote-control --sdk-url ws://our-relay`, and our
  client talks to our relay.
- This is **"instead of," not "alongside"** the official app — when redirected,
  Claude connects to *our* relay and not Anthropic's.
- The control message family (`control_request` / `can_use_tool` /
  `control_response`) is the **same** one the CLI uses in headless
  `--input-format stream-json` mode — so the headless docs transfer directly.
- **Security:** the relay side has **no auth, no host allowlist, no cert
  pinning**. Our relay MUST add its own auth and never be exposed unprotected.
- **This research container can't do a real end-to-end test** — its token is an
  inference-only `CLAUDE_CODE_OAUTH_TOKEN`, which **cannot establish Remote
  Control sessions**. Real test needs a machine with a full claude.ai login.
- **Next step:** capture the *actual* handshake frames for a pinned version with
  a tiny logging WebSocket server before designing for real.

---

## 1. Glossary

| Term | Meaning |
| --- | --- |
| **Remote Control** | Official Claude Code feature: drive a *local* session from claude.ai/code or the Claude mobile app. Local process runs the real session; web/app are thin windows. Research preview; needs CC ≥ v2.1.51. |
| **Server mode** | `claude remote-control` — terminal acts only as a server hosting sessions; you drive from app/web. No local interactive input. |
| **Interactive RC** | `claude --remote-control` / `--rc`, or `/remote-control` in a live session — full local TUI **and** remote, simultaneously. |
| **CCRv1** | Reverse-engineered name for the WebSocket transport of the Remote Control relay protocol. NDJSON over WS text frames. |
| **CCRv2** | HTTPS variant: SSE (server-sent events) downstream + POST ingress. Enabled via `CLAUDE_CODE_USE_CCR_V2`. Better at traversing restrictive networks. |
| **`--sdk-url` / `--sdk-server`** | Undocumented CLI flag that redirects the RC connection to an arbitrary URL. The crux of this whole project. |
| **stream-json** | Documented headless mode (`--input-format stream-json --output-format stream-json`): newline-delimited JSON over stdin/stdout. Same control-message family as CCRv1. |
| **`can_use_tool`** | Control request the engine sends when it wants to run a tool; the client/relay answers allow/deny — i.e. the remote "approve" button. |

---

## 2. Official Remote Control — how it actually works

(For grounding. This is the supported behavior we are replicating.)

### 2.1 What it does
- Connects claude.ai/code or the Claude iOS/Android app to a Claude Code session
  **running on your machine**. Nothing moves to the cloud; the session, your
  filesystem, MCP servers, tools, and config all stay local.
- **Simultaneous multi-surface:** "the conversation stays in sync across all
  connected devices, so you can send messages from your terminal, browser, and
  phone interchangeably." The web/app are *windows* into the local session.
- Reconnects automatically across laptop sleep / network drops.

### 2.2 The crucial mechanism (verified from docs)
- It synchronizes **application state** (conversation + tool-execution state),
  **NOT** your terminal screen. It is **not** a TTY/framebuffer mirror (this is
  what distinguishes it from ttyd/tmux approaches).
- One **authoritative session object** lives in the local process; every surface
  is a **thin client** rendering that shared state. Any client's input is
  appended to the one conversation; the relay rebroadcasts updated state.

### 2.3 Transport & security (official)
- **Outbound-only.** The local process makes outbound HTTPS, registers the
  session, and **polls for work**. It **never opens an inbound port.**
- The Anthropic API **routes messages** between the web/mobile client and the
  local session over a streaming connection — i.e. the API is a **relay**, not
  the brain.
- TLS throughout; uses **multiple short-lived, narrowly-scoped credentials**,
  each expiring independently (small blast radius).

### 2.4 Invocation modes (official)
| Mode | Command | Local typing? |
| --- | --- | --- |
| Interactive | `claude --remote-control` / `--rc` | ✅ full TUI + remote |
| From existing session | `/remote-control` | ✅ carries over history |
| Server mode | `claude remote-control` | ❌ server only, drive from app/web |
| VS Code | `/remote-control` in extension | n/a |

### 2.5 Limits / gotchas (official)
- **One remote session per interactive process** (server mode for many; `--capacity`, `--spawn worktree|same-dir|session`).
- **Local process must stay alive** — kill it and the session ends.
- **~10 min offline → session times out** and the process exits.
- **Ultraplan disconnects RC** (both occupy the claude.ai/code interface).
- **Local-only commands:** interactive pickers `/mcp`, `/plugin`, `/resume` only
  work from the CLI. Text-output commands (`/compact`, `/clear`, `/context`,
  `/usage`, `/exit`, `/recap`, `/reload-plugins`, …) work from app/web.
- **Auth:** requires claude.ai OAuth (Pro/Max/Team/Enterprise). **API keys and
  inference-only tokens (`setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`) are NOT
  supported.** Bedrock/Vertex/Foundry not supported.

---

## 3. ⭐ The reverse-engineered protocol (how we build our own client)

This is the part that makes the project possible. Source: Origin HQ research
*"All Your Claude Are Belong To Us: Reversing Claude Code's Remote Control
Protocol"* plus community deep-dives (see Sources). **Treat every shape below as
a hypothesis to verify against a pinned binary.**

### 3.1 The undocumented flags
- **`--sdk-url <URL>`** (alias **`--sdk-server`**): redirects Claude Code's
  Remote Control connection to an **arbitrary** server. `ws://` and `wss://`
  both accepted; plaintext `ws://` has "zero restrictions," `wss://` uses
  standard TLS validation.
- These bypass the normal Anthropic infrastructure connection that official RC
  modes use.

> ⚠️ **Why this is undocumented:** it is also an attack primitive. Anyone who can
> influence Claude's launch args can redirect it to attacker C2
> ("living-off-the-land" beaconing coding agent). The relay side has **no
> authentication, no hostname allowlist, no certificate pinning, no domain
> check.** For our *own* use this is fine; for any exposed deployment we MUST
> add our own auth layer.

### 3.2 Server-mode worker architecture
- `claude remote-control` (server mode) spawns **multiple subprocesses (up to
  32)** that connect to the remote host via `--sdk-url`.
- Each subprocess connects to the **`worker/events/stream`** endpoint of the
  given URL → a relay/fan-out architecture where a central server coordinates
  multiple Claude Code instances.
- (For our v1 we likely want **single-session** — `--remote-control` interactive
  or `--spawn session` — not the 32-worker fan-out. Revisit if we want multi-session.)

### 3.3 Transports
- **CCRv1 (WebSocket):** NDJSON (`JSON.stringify(obj) + "\n"`) over **WebSocket
  text frames**. Multiple JSON messages may appear in a single frame (so the
  reader must split on `\n`, not assume one-message-per-frame).
- **CCRv2 (HTTPS):** requires env `CLAUDE_CODE_USE_CCR_V2`. Downstream over
  **SSE**, ingress via **POST**. More likely to traverse restrictive networks
  than raw WebSocket. (Pick CCRv1 for v1 simplicity; CCRv2 if WS is blocked.)

### 3.4 Handshake sequence (CCRv1)
1. **Client (Claude) → Server:** WebSocket upgrade request.
2. **Server → Claude:** `control_request` with `subtype: "initialize"`,
   containing **system prompt, MCP servers, hooks**.
3. **Claude → Server:** `control_response` with `subtype: "success"`,
   containing **available models, available commands, account info, process id**.
4. Steady state begins.

### 3.5 Steady-state message flow
- **Server → Claude:** user messages (prompts), plus control directives.
- **Claude → Server:**
  - streamed **tokens** (incremental deltas),
  - complete **assistant** messages,
  - **`control_request { subtype: "can_use_tool" }`** whenever a tool wants to
    run → server/client must respond allow/deny (this is the remote "approve").
  - `result`-style turn completion (cost/tokens) and `system`/`init`.

### 3.6 Control protocol envelope
Request/response correlated by `request_id`:
```json
{
  "type": "control_request",
  "request_id": "<uuid>",
  "request": { "subtype": "<verb>", "...": "..." }
}
```
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "<same-uuid>",
    "response": { "...": "..." }
  }
}
```

### 3.7 Server → Claude control verbs (known)
| subtype | Effect |
| --- | --- |
| `initialize` | Handshake; sends system prompt, MCP servers, hooks. |
| `set_permission_mode` | Change permission mode. `mode: "bypassPermissions"` **silently auto-approves all tool uses** (no further `can_use_tool`). |
| `set_model` | Switch model mid-session. |
| `interrupt` | Stop the current turn (ESC equivalent). |
| `end_session` | Terminate the session. |
| `keep_alive` | Heartbeat. |
| MCP management | Add/manage MCP servers. |

### 3.8 Permission flow (`can_use_tool`)
- Engine emits `control_request { subtype: "can_use_tool", tool_name, tool_input }`.
- Relay/client answers `control_response` with `{ "behavior": "allow" }` or deny.
- Alternatively `set_permission_mode: bypassPermissions` to auto-approve
  everything (this is what the screenshot we saw — "bypass permissions on" — does).

### 3.9 Building a custom relay (the recipe from the research)
1. Accept WebSocket connections on your chosen port/protocol.
2. Implement the **initialize** handshake (send `control_request(initialize)`).
3. Dispatch **user messages** to Claude.
4. Stream responses **token-by-token** back to your client(s).
5. Handle the **tool-permission** flow (forward `can_use_tool` to your UI, or
   auto-approve via `bypassPermissions`).
6. Launch Claude pointed at your relay:
   ```bash
   claude --remote-control \
     --sdk-url ws://YOUR-HOST:PORT \
     --input-format stream-json \
     --output-format stream-json
   ```
   (The research notes `--input-format=stream-json --output-format=stream-json`
   alongside `--sdk-url`. Verify whether interactive `--remote-control` or
   server `remote-control` is the right base for our single-client case.)

---

## 4. Native CLI `stream-json` reference (foundational / cross-checks Part 3)

The headless control protocol is the **same family** as CCRv1. Use this as the
"documented cousin" to validate frame shapes. Official docs admit `stream-json`
input is underdocumented beyond the flag table (GitHub issue #24594); the
reliable reference is the reverse-engineered `cli-protocol.md` (see Sources).

### 4.1 Relevant CLI flags (from official CLI reference)
| Flag | Purpose |
| --- | --- |
| `-p`, `--print` | Print mode / programmatic. Base for headless. |
| `--input-format stream-json` | **Keeps stdin open** for multiple JSON user messages over time. |
| `--output-format stream-json` | Emit newline-delimited JSON events on stdout. |
| `--include-partial-messages` | Emit partial streaming deltas (live typing). Requires `--print` + `--output-format stream-json`. |
| `--replay-user-messages` | Echo each stdin user message back on stdout (multi-client sync primitive). Requires stream-json in+out. |
| `--include-hook-events` | Include hook lifecycle events. Requires `--output-format stream-json`. |
| `--verbose` | Full turn-by-turn output (usually required with stream-json). |
| `--session-id <uuid>` | Use a specific session UUID. |
| `--resume <id|name>`, `-r` | Resume a session (reattach). |
| `--continue`, `-c` | Resume most recent in cwd. |
| `--fork-session` | On resume, create a new id instead of reusing. |
| `--permission-mode <m>` | `default|acceptEdits|plan|auto|dontAsk|bypassPermissions`. |
| `--permission-prompt-tool <tool>` | Route permission prompts through an MCP tool (non-interactive). Research notes `stdio` value routes via control protocol. |
| `--dangerously-skip-permissions` | = `bypassPermissions`. |
| `--bare` | Skip auto-discovery (hooks/skills/plugins/MCP/CLAUDE.md) for faster scripted starts. |
| `--mcp-config <json>` | Load MCP servers. |
| `--model <id>` | Set model. |
| `--max-turns`, `--max-budget-usd` | Print-mode guardrails. |

### 4.2 stream-json message shapes (reverse-engineered — verify!)
**User input (server/host → Claude), one JSON per line, flush after each:**
```json
{"type":"user","message":"your prompt text"}
```
**Assistant message (Claude → out):**
```json
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
```
**System / init (carries session_id):**
```json
{"type":"system","subtype":"init","session_id":"abc123"}
```
**Result (turn complete):**
```json
{"type":"result","total_cost_usd":0.001,"total_input_tokens":100,"total_output_tokens":50,"session_id":"abc123"}
```
**Partial stream delta:**
```json
{"type":"stream","event":"delta","text":"incremental..."}
```
**Control: initialize (→ Claude):**
```json
{"type":"control_request","request":{"subtype":"initialize","request_id":"req_1","hooks":{"PreToolUse":[{"matcher":"*","hook_callback_ids":["hook_0"]}]},"sdk_mcp_servers":["calculator"]}}
```
**Control: permission request (Claude → out):**
```json
{"type":"sdk_control_request","request":{"subtype":"permission","request_id":"perm_1","tool_name":"Bash","tool_input":{"command":"..."}}}
```
**Control: permission response (→ Claude):**
```json
{"type":"control_response","response":{"subtype":"success","request_id":"perm_1","response":{"behavior":"allow"}}}
```
### 4.3 stream-json operational rules
- Each JSON message **on a single line**; **flush** after each write.
- `request_id`s **unique within a session**.
- Send sequential user messages to the **same persistent process**; CLI keeps
  session state, referenced by `session_id` from init.
- **Graceful shutdown:** close stdin.

---

## 5. Proposed `remote-claw` architecture

```
                         (your transport: relay over WS/WSS; tunnel or LAN)
  ┌──────────────┐                                            ┌────────────────────────────┐
  │ your client  │  user msgs + permission decisions  ──────▶ │  remote-claw relay (CCRv1)  │
  │ web/mobile/  │ ◀──────  assistant/partial/result/         │  - WebSocket server          │
  │ TUI          │          can_use_tool                      │  - NDJSON framing            │
  └──────────────┘                                            │  - initialize handshake      │
                                                              │  - permission fan-out        │
                                                              │  - auth (WE add this)        │
                                                              └──────────────┬───────────────┘
                                                                             │ launches & owns
                                                                             ▼
                                              claude --remote-control --sdk-url ws://localhost:PORT
                                              (the REAL session: your subscription, local FS/MCP/tools)
```

**Three components:**
1. **Relay/host** — a WebSocket server speaking CCRv1; spawns/owns the `claude`
   process via `--sdk-url`, performs the `initialize` handshake, tracks
   `session_id`, fans messages out to connected clients, manages the
   `can_use_tool` permission flow. **Adds our own auth.**
2. **Transport** — LAN/localhost first; then Cloudflare/Tailscale tunnel or a
   hosted broker for internet access.
3. **Client(s)** — render the event stream (assistant text, partial deltas, tool
   activity) and send user turns + permission decisions. Multiple clients
   subscribed to one relay session = the simultaneous multi-surface behavior.

**Key nuance (must internalize):** with `--sdk-url` you **become the relay** —
Claude connects to *us*, not Anthropic. So this **replaces** the official app
(matches "my own client instead of Anthropic's"). Having the official app AND a
custom client on the *same* session is NOT supported (would require bridging
into Anthropic's private cloud).

---

## 6. Implementation plan (suggested phases)

**Phase 0 — Empirical protocol capture (do this FIRST).**
- Write a ~30-line logging WebSocket server (Node `ws` or Python `websockets`).
- Launch `claude --remote-control --sdk-url ws://localhost:PORT --input-format stream-json --output-format stream-json --verbose` against it.
- Dump **every frame verbatim** to a file. Confirm: upgrade → `initialize`
  request shape → `success` response shape → user-message shape →
  assistant/partial shapes → `can_use_tool` shape → control verbs.
- **Pin the Claude Code version** you captured against.
- This same run also **settles the auth Case A/B question** (see §9): note
  whether it errors on RC eligibility *before* any WS connects, or proceeds
  straight to the `initialize` handshake against your logger.

**Phase 1 — Minimal relay.**
- Implement the handshake (respond/initiate correctly), keep-alive, and a
  request_id correlation table.
- Get one round-trip: send a user message, stream assistant text back to a
  trivial CLI client.

**Phase 2 — Permissions.**
- Surface `can_use_tool` to the client; implement allow/deny; offer a
  `bypassPermissions` toggle (mirrors "bypass permissions on").

**Phase 3 — Client UX.**
- Build the first real client surface (web app recommended: phone-friendly, one
  codebase). Render partial deltas, tool activity, permission prompts.

**Phase 4 — Multi-client + sync.**
- Fan-out to multiple connected clients; use a `--replay-user-messages`-style
  echo so all clients see the same input land. Decide authoritative-state model.

**Phase 5 — Transport + auth hardening.**
- Add relay auth (token/QR pairing like RC). Add tunnel (Cloudflare/Tailscale)
  or hosted broker for off-LAN. Never expose unauthenticated.

**Phase 6 — Resilience.**
- Reconnect handling, session resume (`--resume`/`--session-id`), process
  lifecycle/supervision, version-pinning guard.

---

## 7. Security considerations (do not skip)

- **No built-in auth on the relay side.** Anyone who reaches the WS port can
  drive a Claude with your local FS/tool access. **Mandatory:** our own auth
  (bearer token / pairing code), bind to localhost by default, explicit opt-in
  to expose.
- **`bypassPermissions` = full auto-approve.** Powerful and dangerous; gate it
  behind explicit user action.
- **Undocumented = unstable.** `--sdk-url` and frame shapes can change between
  versions. Pin the binary; add a handshake/version check that fails loudly.
- **Dual-use awareness.** This same mechanism is a documented attack primitive
  (redirect Claude to C2). Our use (own machine, own account, own relay) is
  legitimate; keep it that way — no shipping a tool that redirects *other
  people's* Claude installs.
- **TLS for any non-localhost hop** (`wss://` or tunnel-provided TLS).

---

## 8. Open questions to resolve empirically

1. Exact `initialize` request payload + the `success` response fields for our
   pinned version (models/commands/account/pid).
2. Whether `--remote-control` (interactive) vs `remote-control` (server) is the
   right base when using `--sdk-url` for a **single** client. Does interactive
   mode still also render a local TUI?
3. Does `--sdk-url ws://localhost` **bypass the claude.ai-subscription
   eligibility check** (since we never touch Anthropic's relay)? If yes, an
   inference-only token might suffice for dev. **Verify.** See **§9** for the
   full two-layer model (Case A vs Case B) and the exact test.
4. Exact `user` message schema for a turn (string vs content-block array; how
   attachments / `@file` references are represented).
5. `can_use_tool` full schema and the deny / "ask again" response variants.
6. How partial token deltas are framed in CCRv1 vs the `stream-json` `stream`
   events — are they identical?
7. Heartbeat/keep-alive cadence and timeout (the official ~10-min offline
   timeout — does our relay need to emit keep-alive?).
8. CCRv2 (SSE/POST) — exact endpoints and whether we need it for tunneling.
9. Multi-worker (`worker/events/stream`, up to 32) — needed for multi-session,
   or skip for v1?
10. How `/`-commands (compact/clear/context) are transported — as user messages
    or control requests?

---

## 9. Authentication & Remote Control eligibility (the two-layer model)

The single most likely setup blocker. There are **two separate auth checks**,
with different requirements.

- **Layer 1 — Inference auth (always required).** Model calls always go to
  `api.anthropic.com`; the CLI needs a valid credential to run inference *no
  matter how you connect*. Every auth type below satisfies this.
- **Layer 2 — Remote Control eligibility (the strict gate).** Official RC
  additionally **registers the session with Anthropic's relay** and verifies the
  account is allowed to use RC. This is the step with the hard requirements.

| Auth type | Layer 1 (inference) | Layer 2 (official RC) |
| --- | --- | --- |
| **Full claude.ai login** (`claude auth login`) | ✅ | ✅ supported (uses Pro/Max sub) |
| **`ANTHROPIC_API_KEY`** (Console billing) | ✅ | ❌ *"requires a claude.ai subscription"* |
| **`CLAUDE_CODE_OAUTH_TOKEN` / `setup-token`** (long-lived) | ✅ | ❌ *"requires a full-scope login token"* — inference-only, cannot establish RC |

(This research container has the inference-only token → runs inference fine, but
cannot establish official RC.)

### 9.1 The `--sdk-url` open question — Case A vs Case B
When redirected via `--sdk-url ws://localhost`, we replace Anthropic's relay with
our own. **Unknown** whether the CLI still performs the Layer-2 eligibility
handshake with Anthropic:

- **Case A — bypassed.** The CLI only needs inference + our relay → *any* working
  inference auth suffices (even an inference-only token or API key). Ideal for
  servers/CI.
- **Case B — still enforced.** The CLI checks RC eligibility against Anthropic
  regardless → a **full `claude auth login` is required** even when pointed at
  our own relay.

### 9.2 How to settle it (do during Phase 0)
On the target box, point a real RC launch at a throwaway logging WS server and
watch **where** it fails:
```bash
# tiny logger first, e.g.:  npx wscat -l 8787   (or a ~10-line ws server)
claude --remote-control --sdk-url ws://localhost:8787 \
  --input-format stream-json --output-format stream-json --verbose
```
- Errors *"requires a full-scope login token / claude.ai subscription"* **before**
  any WS connects → **Case B** (need `claude auth login`).
- **Opens the WS and sends `initialize`** to your logger → **Case A**
  (inference-only auth is enough). Bonus: you capture the real handshake frames
  at the same time.

### 9.3 Recommendations
- **Safe default for the server:** run `claude auth login` with your claude.ai
  (Max) account — full-scope, works under *both* cases, uses your subscription.
- **Only if you need fully non-interactive auth** (headless/CI) do Case A vs B
  matter — `setup-token`/API key work for RC *only if Case A holds*.
- **Billing note:** interactive `--remote-control` counts as normal interactive
  usage. But `claude -p` / Agent-SDK usage on subscription plans draws from a
  **separate monthly Agent SDK credit pool as of 2026-06-15** — relevant only if
  the `--sdk-url` path turns out to require `-p`.

---

## 10. Research-environment notes

- `claude` present at `/opt/node22/bin/claude`, **v2.1.168**.
- Auth = `CLAUDE_CODE_OAUTH_TOKEN` (inference-only, file-descriptor). Per docs
  this **cannot establish official Remote Control sessions**. Implication: we
  can build/unit-test the relay+client against captured frames here, but a real
  end-to-end RC test needs a machine with a **full claude.ai login** — OR we
  confirm question #3 (localhost `--sdk-url` sidesteps eligibility).
- `~/.claude/` exists with `projects/`, `sessions/`, `session-env/`, hooks,
  skills, `launcher-settings.json`, `policy-limits.json`. Worth inspecting
  `sessions/` and `projects/` for on-disk session/transcript formats during impl.

---

## 11. Reference commands (copy/paste starters)

```bash
# Version pin check
claude --version

# Phase 0: point a real RC session at a local logging WS server
claude --remote-control \
  --sdk-url ws://localhost:8787 \
  --input-format stream-json \
  --output-format stream-json \
  --verbose

# Server (multi-worker) variant — only if we want fan-out
claude remote-control --sdk-url ws://localhost:8787 --spawn session

# Headless stream-json (the documented cousin, for protocol cross-checks)
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --replay-user-messages \
  --session-id "$(uuidgen)"

# Useful env
export CLAUDE_CODE_USE_CCR_V2=1   # switch relay transport to SSE/HTTPS (CCRv2)
```

---

## 12. Sources

- Official Remote Control docs — https://code.claude.com/docs/en/remote-control
- Official Security (Remote Control section) — https://code.claude.com/docs/en/security
- Official CLI reference — https://code.claude.com/docs/en/cli-reference
- Agent SDK overview (for contrast; we are NOT using the SDK) — https://code.claude.com/docs/en/agent-sdk/overview
- **Origin HQ — "Reversing Claude Code's Remote Control Protocol"** — https://www.originhq.com/research/reversing-remote-control
- Deep Dive: How Claude Code Remote Control Actually Works (Upskill) — https://tryupskill.app/blog/claude-code-remote-control-interview-guide
- DEV mirror of the deep dive — https://dev.to/chwu1946/deep-dive-how-claude-code-remote-control-actually-works-50p6
- Reverse-engineered CLI stream-json protocol — https://github.com/Roasbeef/claude-agent-sdk-go/blob/main/docs/cli-protocol.md
- GitHub issue: stream-json input underdocumented (#24594) — https://github.com/anthropics/claude-code/issues/24594
- Prior-art open-source clients to mine: Happy (https://happy.engineering/ , https://github.com/slopus/happy), CloudCLI (https://github.com/siteboon/claudecodeui)

---

*End of research notes. Verify Part 3/Part 4 frame shapes empirically (Phase 0)
before building on them — they are reverse-engineered and version-sensitive.*
