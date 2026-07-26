# Phase 0 — Empirical Findings

> **Captured:** 2026-06-07 · **Claude Code:** v2.1.168 (ARM aarch64 single-exec
> build at `~/.local/share/claude/versions/2.1.168`) · **Auth:** full claude.ai
> first-party login, Max subscription (`authMethod: claude.ai`,
> `apiProvider: firstParty`).

This records what we *actually observed* running Phase 0, versus the
reverse-engineered hypotheses in [`remote-control-research.md`](remote-control-research.md). **The headline
result invalidates the project's original premise on this version.**

---

## 0. TL;DR

- ❌ **`--sdk-url` can no longer point at your own relay in v2.1.168.** It now
  enforces a **hardcoded 5-entry hostname allowlist** + a **wss/https-only**
  scheme check, *before any socket opens*. `ws://localhost` is rejected with:
  `--sdk-url rejected: host "localhost" is not an approved Anthropic endpoint.`
  The "no auth, no host allowlist, no cert pinning" the research relied on has
  been **patched**. There is **no env var / setting / policy** that extends the
  allowlist.
- ✅ The **auth question (§9) is moot on this box** — we have a full claude.ai
  login, so we'd pass Layer 2. But we never get to test it: the host allowlist
  rejects the URL first, before auth/eligibility is even consulted.
- ✅ **The documented `stream-json` headless path still works** and is the
  realistic foundation for "drive Claude with my own client." Captured real
  frames; they differ substantially from the doc's guesses (see §3).

---

## 1. The `--sdk-url` allowlist (exact, from the v2.1.168 binary)

The validator and its callsite, de-minified from the embedded bundle:

```js
// allowlist (defined exactly once; never mutated — no Ii3.add anywhere)
Cd8 = ["https://beacon.claude-ai.staging.ant.dev",
       "https://claude.fedstart.com",
       "https://claude-staging.fedstart.com"];
Ii3 = new Set(["api.anthropic.com","api-staging.anthropic.com",
               ...Cd8.map(q => new URL(q).hostname)]);

function ST5(q){                                   // validates --sdk-url
  let K; try { K = new URL(q); } catch { return `could not parse ${q} as a URL`; }
  if (Ii3.has(K.hostname)) {                        // exact hostname match
    if (K.protocol!=="wss:" && K.protocol!=="https:")
      return `scheme ${K.protocol} is not permitted for host ${K.hostname}; only wss:// and https:// are accepted`;
    return null;                                    // ✅ allowed
  }
  return `host ${K.hostname} is not an approved Anthropic endpoint`;
}

// callsite
if (Hq /* --sdk-url */) {
  if (inputFormat!=="stream-json" || outputFormat!=="stream-json")
    return Error("--sdk-url requires both --input-format=stream-json and --output-format=stream-json");
  let i6 = ST5(Hq);
  if (i6 !== null) {
    sR("tengu_sdk_url_host_rejected", {});          // ← telemetry on rejection
    return Error(`--sdk-url rejected: ${i6}. This flag is reserved for Remote Control worker processes connecting to Anthropic's backend.`);
  }
  if (!process.env.CLAUDE_CODE_REMOTE) {
    if (!f4("allow_remote_control")) return Error("Remote Control is disabled by your organization's policy.");
    // ... disableRemoteControl setting check ...
  }
}
```

### The complete approved-host set (`Ii3`)
| Host | Origin |
| --- | --- |
| `api.anthropic.com` | hardcoded |
| `api-staging.anthropic.com` | hardcoded |
| `beacon.claude-ai.staging.ant.dev` | from `Cd8` |
| `claude.fedstart.com` | from `Cd8` (GovCloud/FedRAMP) |
| `claude-staging.fedstart.com` | from `Cd8` (GovCloud/FedRAMP) |

### What this kills / changes
- **No self-hosted relay via `--sdk-url`.** Host must *exactly* equal one of the
  five. `Cd8` is a static literal — not built from `ANTHROPIC_BASE_URL` or any
  env var — so nothing we can set adds a host.
- **Plaintext `ws://` is dead even for allowed hosts** — only `wss://`/`https://`.
  (Old research claimed `ws://` had "zero restrictions." Patched.)
- **`CLAUDE_CODE_REMOTE` does not help** — it only skips the *org-policy* check,
  and only *after* `ST5` already passed. It cannot bypass the host allowlist.
- Rejection emits a `tengu_sdk_url_host_rejected` analytics event.

### Reproduction
```
$ claude --remote-control --sdk-url ws://localhost:8787 \
    --input-format stream-json --output-format stream-json --verbose
Error: --sdk-url rejected: host "localhost" is not an approved Anthropic endpoint.
This flag is reserved for Remote Control worker processes connecting to Anthropic's backend.
```
Our logger (`phase0/ws-logger.js`) recorded **zero** connections — the CLI fails
the URL check client-side, before opening any socket.

---

## 2. Remaining theoretical paths (all worse than the original premise)

1. **Impersonate an allowlisted host locally** — e.g. `/etc/hosts:
   127.0.0.1 api.anthropic.com`, run our relay on `wss://api.anthropic.com` with
   a cert the CLI trusts (`NODE_EXTRA_CA_CERTS`, or `NODE_TLS_REJECT_UNAUTHORIZED=0`
   if honored). On *your own* machine/account this is arguably legitimate, but
   it's fragile, hijacks the real API hostname (breaks normal inference while
   active), and we still don't know the post-handshake CCRv1 frames for this
   version. **Only viable route to a real CCRv1 capture on v2.1.168.** Not yet
   attempted.
2. **Downgrade** to a Claude Code version predating the allowlist (what Origin HQ
   reversed) to capture/build the real CCRv1. Relies on running a
   security-patched-out behavior on a pinned old binary; brittle and not
   forward-compatible.
3. **Pivot to `stream-json`** (recommended — see §3). Doesn't use `--sdk-url` at
   all, so the allowlist is irrelevant. This is the supported, documented way to
   drive Claude programmatically; it carries the *same control-message family*
   the relay uses. We lose the "official RC multi-surface sync via Anthropic's
   cloud" angle, but we keep "my own client drives a real local Claude session."

---

## 3. `stream-json` works — real captured frames (v2.1.168)

Command (one user turn, streamed):
```bash
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with exactly the word: PONG"}}' \
  | claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
```
Full capture: `phase0/captures/stream-json-probe.log`.

### Corrections to the research doc's guessed shapes (§4.2 was wrong)
| Frame | Doc guessed | **Actual v2.1.168** |
| --- | --- | --- |
| **User input** | `{"type":"user","message":"text"}` | `{"type":"user","message":{"role":"user","content":"text"}}` — `message` is an **object**, bare string is wrong |
| **init** | `{"type":"system","subtype":"init","session_id":"..."}` | same envelope but **rich**: `tools[]`, `model`, `slash_commands[]`, `agents[]`, `skills[]`, `mcp_servers[]`, `permissionMode`, `cwd`, `apiKeySource`, `claude_code_version`, … |
| **Partial delta** | `{"type":"stream","event":"delta","text":"..."}` | `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}}` — raw **Anthropic Messages API** streaming events wrapped in `stream_event` |
| **assistant** | `{"type":"assistant","message":{"content":[...]}}` | `{"type":"assistant","message":{<full Anthropic msg: model,id,role,content,usage,...>},"session_id":...,"request_id":...}` |
| **result** | flat `total_input_tokens`/`total_output_tokens` | `{"type":"result","subtype":"success","duration_ms":...,"total_cost_usd":...,"usage":{input_tokens,output_tokens,...},"modelUsage":{...},"permission_denials":[],...}` |

### Additional event types observed (not in the doc)
- `{"type":"system","subtype":"status","status":"requesting"}` — turn lifecycle.
- `{"type":"rate_limit_event","rate_limit_info":{status,resetsAt,rateLimitType,...}}`.
- Streaming envelope sequence per turn: `message_start` → `content_block_start`
  → `content_block_delta`(×N) → (full `assistant`) → `content_block_stop` →
  `message_delta` → `message_stop` → `result`.

### Operational notes confirmed
- `--sdk-url` **requires** `--input-format=stream-json --output-format=stream-json`
  (enforced before the host check).
- `--input-format=stream-json` requires `--output-format=stream-json`.
- One JSON object per line; session id surfaces in the `init` frame and tags
  every subsequent frame.

---

## 4. Recommendation for the project

The original thesis — *redirect `--sdk-url` to a relay you own* — is **closed on
v2.1.168** and likely on all current/future versions (it was deliberately
patched as an attack-primitive mitigation, with telemetry on rejection). Three
honest options:

- **(A) Re-scope to `stream-json`** as the client/relay substrate. Build the
  custom client/relay around `claude -p --input-format stream-json
  --output-format stream-json` (+ `--include-partial-messages`,
  `--replay-user-messages`, `--resume`/`--session-id`). Same control-message
  family; fully supported; works *today* on this box. **Recommended.**
- **(B) Local host-impersonation capture** (§2.1) only if we specifically need
  the *real CCRv1 relay frames* — accept the fragility and the API-hostname
  hijack.
- **(C) Version-pin an old binary** for CCRv1 research only; do not build a
  product on it.

Phase 1+ in the research doc should be rewritten against whichever path we pick.
If (A): the `can_use_tool`/permission flow, multi-client fan-out, and resume all
still apply — just over stream-json + our own transport, not over a redirected
RC socket.

---

## 4a. Chosen path: RC interception (keep TUI + custom remote)

Decision (2026-06-07): pursue **custom remote via RC interception** — the only
option that preserves the local TUI *and* makes the remote surface ours.

### What the interactive RC transport actually is
The official Remote Control session API is plain HTTPS on `BASE_API_URL`, not the
`--sdk-url` websocket:
- `POST /v1/code/sessions` — register a session
- `GET  /v1/code/sessions/{id}/events?cursor=…` — poll for events (cursor-paginated)
- `/v1/code/triggers/{id}/run`, `/v1/code/agent-proxy`, `/v1/code/egress/gateway`,
  `/v1/code/upstreamproxy`, github/slack — related RC surface
- gated by `if(!az()) throw "Remote sessions are only available on the
  first-party Anthropic API provider."`

`BASE_API_URL` comes from `F_()`:
```js
function F_(){
  let q = ({local:gYO(), staging:QYO??Xy7, prod:Xy7})[Ty7()];   // Ty7() picks env
  let K = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
  if(K){ if(!Cd8.includes(K)) throw "...not an approved endpoint."; q={...q,BASE_API_URL:K,...} }
  return q;
}
Xy7 /*prod*/ = { BASE_API_URL: "https://api.anthropic.com", ... }
function gYO(){ /*local*/ return { BASE_API_URL: process.env.CLAUDE_LOCAL_OAUTH_API_BASE ?? "http://localhost:8000",
                                   CLIENT_ID:"22422756-…", OAUTH_FILE_SUFFIX:"-local-oauth", ... } }
```

### Why there is no clean redirect lever
- **`--sdk-url`** — allowlisted hosts only (§1), wss/https only, "reserved for
  worker processes." Not the interactive transport.
- **`CLAUDE_CODE_CUSTOM_OAUTH_URL`** — overrides `BASE_API_URL` but is checked
  against the same `Cd8` allowlist.
- **"local" env** (`Ty7()→local`, `CLAUDE_LOCAL_OAUTH_API_BASE`) — *does* point
  `BASE_API_URL` at `http://localhost:8000` with **no allowlist**, BUT it also
  switches to a local OAuth `CLIENT_ID`, `-local-oauth` token file, and local
  token endpoint → it expects Anthropic's internal dev stack and **breaks your
  real claude.ai auth + inference**. Not usable for us.

⇒ Because the RC session API shares the host with inference
(`api.anthropic.com`), interception requires a **TLS MITM of `api.anthropic.com`**.

### Interception recipe (the build)
1. `/etc/hosts`: `127.0.0.1 api.anthropic.com` (scoped to the claude process if
   possible).
2. Generate a CA + leaf cert for `api.anthropic.com`; trust via
   `NODE_EXTRA_CA_CERTS` (binary references it). Dev fallback:
   `NODE_TLS_REJECT_UNAUTHORIZED=0`.
3. Reverse proxy on :443:
   - **pass through** to the real upstream IP: `/v1/messages` (inference) and the
     OAuth/token endpoints — so auth + model calls keep working.
   - **intercept / implement ourselves**: `/v1/code/sessions*` (register, events
     poll, input submit) and related RC routes — this is our relay; our own
     clients attach here.
4. Launch interactive `claude --remote-control` → local TUI renders; its RC
   backend is now us; our clients are the remote surface. ⇒ parallel TUI + remote
   on one session.

### Open unknowns to settle next (capture step)
- Exact payloads for `POST /v1/code/sessions` (registration) and how **remote
  user input** is delivered to the host (a POST? an event in the poll stream?).
- The full event schema in `GET /v1/code/sessions/{id}/events` (the doc's CCRv1
  frame guesses do **not** apply here — this is the HTTP sessions API).
- Whether the Bun binary honors `NODE_EXTRA_CA_CERTS` (vs needing
  `NODE_TLS_REJECT_UNAUTHORIZED=0`).
- Lower-invasiveness capture aid: `CLAUDE_CODE_REMOTE_RAW_EVENTS_FILE` env var —
  appears to dump raw RC events to a file (try before building the MITM).
- Does interactive `--remote-control` start without a TTY in our harness, and
  does inference still flow through the passthrough?

## 4b. ⭐ Historical breakthrough: the client REST API needs no interception

**Status:** the protocol finding remains valid, but the architecture recommendation recorded below was
superseded by the §4c decision to own the relay through the MITM. The July 2026 native-passthrough scope
reopens a distinct observe-first mode as a proposal only; it has not changed current `--rc-app` behavior.

While capturing the worker protocol via MITM, I discovered the **remote-client
side of Remote Control is a plain, directly-callable REST/SSE API** on
`api.anthropic.com`, reachable with the normal claude.ai oauth token. **You do
not need a MITM, `--sdk-url`, or any interception to add your own remote client.**

Empirically verified end-to-end (2026-06-07): with a real `claude
--remote-control` session running (local TUI live), I sent a user turn purely via
`POST /v1/code/sessions/{id}/events` from a separate process (curl + oauth
token). The host received it on its worker SSE stream, ran inference, and replied
"BANANA" — which I then read back via `GET /v1/code/sessions/{id}/events`. That
is **local TUI + custom remote client driving one synced session** — the exact
requirement — over supported infrastructure, zero interception.

### Full protocol map (empirically verified, v2.1.168)

**Auth:** `Authorization: Bearer <claude.ai oauth accessToken>`,
`anthropic-version: 2023-06-01`. (Worker endpoints use the `worker_jwt` from
`/bridge` instead.)

**Worker/host side** (what `claude --remote-control` does; what a *relay* would
serve if you went the interception route):

| Method/Path | Purpose |
| --- | --- |
| `POST /v1/code/sessions` | register session — body `{title, bridge:{}, tags:["remote-control-repl"], config:{cwd, model, sources:[{type:"git_repository",url,revision}], outcomes, reuse_outcome_branches}}` → returns session `{id:"cse_…", status, environment_kind:"bridge", …}` |
| `POST /v1/code/sessions/{id}/bridge` | body `{}` → mints `{api_base_url, expires_in:14400, worker_epoch, worker_jwt:"sk-ant-si-…"}` (JWT role=worker, scoped to session) |
| `GET  /v1/code/sessions/{id}/worker/events/stream` | **SSE downstream** — relay→host. Frames: `event: client_event` with `data:{event_type, source:"client", payload:{…}}`. This v2.1.168 reference capture begins with `control_request{subtype:"initialize"}`. |
| `POST /v1/code/sessions/{id}/worker/events/delivery` | host acks delivery of downstream events |
| `POST /v1/code/sessions/{id}/worker/events` | **host→relay output** — posts user-echo, `assistant`, `result` events upstream |
| `PUT  /v1/code/sessions/{id}/worker` | host status — `{worker_status:"idle"\|"busy", worker_epoch, external_metadata:{current_branches,…}}` |
| `POST /v1/code/sessions/{id}/worker/heartbeat` | keepalive — `{session_id, worker_epoch}` every ~20s |
| `GET  /v1/code/triggers` | triggers list |

**Client/remote side** (what the web app does; **what our custom client calls
directly — no interception**):

| Method/Path | Purpose |
| --- | --- |
| `GET  /v1/code/sessions` | list sessions (`{data:[…], next_cursor, resume_token}`) |
| `GET  /v1/code/sessions/{id}` | session detail |
| `POST /v1/code/sessions/{id}/events` | **send input** — body `{events:[{payload:{type:"user", message:{role:"user", content:"…"}, uuid, session_id, timestamp, parent_tool_use_id:null}}]}` → `{results:[{duplicate,event_id,sequence_num}]}` |
| `GET  /v1/code/sessions/{id}/events?sort_order=asc\|desc[&cursor=]` | read events (history + poll) |
| `GET  /v1/code/sessions/{id}/events/stream` | **SSE** live output stream (client side) |
| `POST /v1/code/sessions/{id}/client/presence` | presence |
| `POST /v1/code/sessions/{id}/mark_read` | read receipts |
| `POST /v1/code/sessions/{id}/archive` · `/unarchive` | lifecycle |

### Event envelope (from `GET /events`)
```jsonc
{ "event_id":"uuid", "event_type":"user|assistant|result|control_request|control_response",
  "sequence_num":"3", "source":"client|worker", "created_at":"…",
  "sent_by_account_id":null, "device_attestation_status":"…",
  "payload": { /* type-specific; user → {type:"user", message:{role,content}, uuid, session_id, timestamp} */ } }
```
In this v2.1.168 reference capture, the verified turn sequence is
`control_request(initialize)` → `control_response` → `user` (source:client) → `assistant` → `result`.
That initialize-first ordering is not yet a universal Anthropic guarantee: a separate manual local
capture did not show initialize before a sequence-1 user event. Our synthetic relay intentionally keeps
initialize-first, while native passthrough must tolerate either observed shape and reconfirm it in a
sanitized gated proof.

### Historical implication — superseded by §4c

At this point in the investigation, the spike showed that RC interception **worked but was not
technically required** for the local-TUI-plus-custom-client requirement. The candidate architecture was:

- User runs the normal `claude --remote-control` (real TUI, real session — no
  flags, no system changes).
- `remote-claw` is a **pure client** of the documented-by-behavior REST/SSE API
  above (oauth token + refresh). It coexists with the TUI and the official app on
  one synced session.

This made option “cloud-relay join” from the earlier menu look technically simpler than expected because
the client API is a plain REST/SSE surface. The subsequent product decision in §4c rejected that
architecture for current `--rc-app`: remote traffic stays on our MITM-owned relay, while MITM tracing
remains the protocol-inspection path. See `docs/v2-architecture.md` §14 for the authoritative decision,
§17.5 for the implementation mapping, and `docs/native-rc-passthrough-scoping.md` for the later,
explicitly unadopted passthrough proposal.

## 4c. ✅ Option 2 BUILT & WORKING — own-relay via MITM

Decision: build the self-hosted relay (own the sync layer). Implemented in
`phase0/relay/relay.py` (stdlib only) and **verified end-to-end on v2.1.168**.

**Architecture (two faces):**
- **MITM face** (`HTTPS_PROXY` :8888): claude is pointed at it; it intercepts
  `/v1/code/sessions*` + `/v1/code/triggers` and serves them from an in-process
  `RelayCore` (our relay IS the worker's backend). Everything else — crucially
  `/v1/messages` inference and oauth/token — passes through to the real
  `api.anthropic.com`, so auth + model calls keep working.
- **Client face** (HTTP :9100): a tiny web UI + JSON/SSE API our own client uses
  (`GET /api/sessions`, `POST /api/sessions/{id}/input`, `GET
  /api/sessions/{id}/stream`).

**Verified flow:**
1. `claude --remote-control` launched with `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`
   → registers against our relay, bridges (we mint a `worker_jwt`), opens the
   worker SSE (we send `initialize`), reaches **"Remote Control active"** with the
   **local TUI live** — all against our relay, not Anthropic's.
2. Sent `"…one word: MANGO"` via our client API → relay pushed it down the worker
   SSE as a `user` client_event → worker ran inference (passed through) → posted
   `assistant:"MANGO"` back to our `/worker/events`.
3. The **local TUI displayed the MANGO exchange** (proving one synced session),
   and our client read-stream delivered `control_response → user → assistant
   (MANGO) → result`.

⇒ **Parallel input from the TUI and our own remote client on one session, over a
relay we host.** The original requirement, achieved via Option 2.

**Run it** (hardened CLI; see `phase0/README.md`):
```bash
cd phase0
./remote-claw up mysession     # certs + relay (bg) + claude --remote-control (TUI)
# prints a tokenised URL; forward the port → http://127.0.0.1:9100/?token=…
./remote-claw test             # automated e2e + two-surface tests
```
The relay is the `remote_claw` package (config/log/certs/core/mitm/client_api/
server/cli); `relay.py` was refactored into it during hardening. The client face
is token-gated; logs are secret-redacted; cert keys are 0600.

**Relay endpoints implemented** (worker side): `POST /sessions`, `GET
/sessions/{id}`, `POST /sessions/{id}/bridge`, `GET|PUT /sessions/{id}/worker`,
`GET /sessions/{id}/worker/events/stream` (SSE + initialize), `POST
/sessions/{id}/worker/events`, `POST /sessions/{id}/worker/events/delivery`,
`POST /sessions/{id}/worker/heartbeat`, `GET /triggers`.

**Bidirectional sync verified.** `test/two_surface.py` runs the TUI wrapper under
a controlled pty + our client against the relay and asserts both directions on one
session: a message **typed in the TUI** is answered and appears in **our client**
(`KIWI…`), and a message **sent from our client** is answered (`PLUM…`). PASS.

**Permission flow — resolved (faithful).** Verified against BOTH our relay and
Anthropic's real relay: Remote Control **auto-executes tools with no
`can_use_tool` prompt**, even in `--permission-mode default` (real flow for
`echo REALPERM-987`: `user → assistant(tool_use) → user(tool_result) →
assistant`). Our relay matches this; `--permission-mode` controls the posture.
Relay keeps the `control_request`→client→`control_response` plumbing for
completeness, though RC doesn't currently gate.

**Roles.** The **TUI wrapper** (`remote-claw worker`/`up`/`logs`) is the
testing/introspection harness; **our client** (web chat UI) is the proof.

**Still TODO (Phase 2+):** client-face auth, reconnect/`worker_epoch` handling,
multi-client fan-out, graceful session teardown, streaming deltas in the client UI.

## 5. Artifacts
- `phase0/ws-logger.js` — zero-dep WebSocket logger (unused for capture since the
  CLI never connected; kept for path (B) / old-version capture).
- `phase0/captures/capture-2026-06-07T18-22-11-954Z.log` — logger run showing no
  inbound connection (the rejection is client-side).
- `phase0/captures/stream-json-probe.log` — real stream-json frames, v2.1.168.
