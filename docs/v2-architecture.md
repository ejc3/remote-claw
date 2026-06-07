# remote-claw v2 — cloud-brokered, zero-knowledge, multi-host

> Status: **design** (researched 2026-06-07; Vercel facts verified against official
> docs dated 2026-05/06). Supersedes the localhost MITM-relay of Phase 0 for the
> *transport/UX* layer; **reuses** Phase 0's Claude-interception core unchanged.

## 1. What changes and why

Phase 0 put a relay on `localhost` and you reached it over SSH. v2 keeps the same
trick for talking to Claude (MITM `api.anthropic.com`, intercept
`/v1/code/sessions*`) but replaces the localhost client face with a **cloud broker
on Vercel** so you can chat from anywhere — phone included — across **multiple
servers**, with **end-to-end encryption** where **Vercel only ever sees
ciphertext**.

Goals:
- Mobile-friendly web app (Vercel) to chat with your sessions.
- Paste one **secret** → access **every claude instance under that secret** and
  decrypt it.
- **Each claude instance is its own space / chat** (gchat-style). Instances are
  grouped by the **secret** they run under.
- **E2E encrypted** from the secret; **non-guessable** secrets; Vercel
  zero-knowledge.
- Stateless web client **and** stateless wrapper; **claude's on-disk session is the
  durable record**; the cloud is a stateless ciphertext relay (see §6).

> **Terminology (the core abstraction = the SECRET).** A *secret* derives an
> **identity** — `host_id` / `auth_token` / content keys — that authenticates and
> unlocks **all instances under it**. By default a machine has one secret
> (`remote-claw identity`), so "host" ≈ "machine"; **but you can override the
> secret per wrapper** (`serve --secret …`), so one machine can carry **several**
> identities (and, conversely, one secret could span machines). A *claude instance*
> = a *session* = a *space* = **one chat** (a single running `claude` with remote
> control enabled). So **2 secrets × 10 instances = 20 spaces**. The web lists
> spaces (instances), grouped by secret/identity. (`host_id` below = a secret's
> identity, **not** a hardware id.)

Non-goals (v1): forward secrecy, per-device revocation, group/sender-key crypto,
metadata privacy (timing/sizes/seq are visible to the broker).

## 1A. User experience & ergonomics (the flow we're building)

The whole design serves this human flow. Two roles (often the same person): the
**operator** runs claude on a machine; the **driver** chats from a phone/laptop.

### A. Operator — on the machine
1. **One-time:** install, run `remote-claw identity` → copy the printed `rc1_…`
   secret. (That's the default machine identity; you can make more.)
2. **Daily:** instead of `claude`, run `remote-claw serve`. You get the **exact
   normal claude TUI**, locally, as always — *nothing is remote until you opt in*.
3. **Share a session:** hit `/remote-control` in that TUI → it flips to "Remote
   Control active," and that instance becomes a chat in the web app. (Or launch it
   already-shared.)
4. Run **as many instances as you like** — one per repo/branch/task; each is its
   own chat. Close the TUI → that chat goes offline.

*Ergonomic promises:* zero change to the local workflow; **opt-in per session**;
the wrapper is invisible until RC is on; nothing leaves the box unencrypted.

### B. Driver — on phone/laptop (the web app)
1. **First time:** open the app, paste the `rc1_…` (or open a link with the secret
   in the URL `#fragment`). Keys derive **in the browser**; the secret never hits
   the server.
2. You land on a **list of chats** — every claude instance under that secret,
   most-active first, each with a name + an online dot. Reads like Slack/iMessage.
3. **Tap one** → history decrypts locally and live messages stream in. **Type** →
   your message shows in the chat *and* in the real terminal; claude works and the
   reply streams back to your phone.
4. **Add a machine:** paste its secret → its chats join the list (grouped by
   identity).

*Ergonomic promises:* mobile-first, instant, **no login** beyond the pasted secret;
feels like a messaging app; spans many machines.

### C. Naming & organization
- Each chat's default name is meaningful — repo + branch / cwd + the gist of the
  first prompt (the title claude already generates). Editable; stored **encrypted**.
- Identities (machines) are named too (default = hostname); chats group under them.
- **Online/offline per chat** via heartbeat TTL: green when the host is up and the
  instance live; greyed when offline (the chat stays in your list).

### D. Reconnect / offline (what it feels like)
- Phone drops Wi-Fi mid-reply → on reconnect it **silently catches up**; you never
  lose the thread.
- Host sleeps / you close the TUI → the chat shows **offline**; sending says "host
  offline."
- Bring the host back (`serve` → `/remote-control`, or `--continue`) → the chat
  goes live and **history is intact** (it lives with claude, not the cloud).

### E. Security ergonomics (honest with the user)
- The pasted secret is powerful (read + write + decrypt every chat under it) —
  treat it like a password. The app offers **"forget identity"** (wipes it from the
  device).
- Lost/leaked secret → **rotate**: a new secret = a new identity (fresh chats); the
  old one is dead. No partial revoke in v1.
- The cloud never sees plaintext or the secret — only ciphertext + routing metadata
  (who/when/sizes), which it cannot read.

### F. Explicitly NOT in v1 (so we don't over-build)
- Push notifications (nice later; for v1 you open the app to see new messages).
- Per-device revocation / sharing one identity with separately-revocable people.
- Editing/branching past turns from the phone beyond what claude's RC already does.

## 2. Threat model & the zero-knowledge property

- **Broker (Vercel + any managed realtime/store) is untrusted for confidentiality.**
  It routes and persists **ciphertext + routing metadata only** (`host_id`,
  `session_id`, `seq`, `dir`, sizes, timestamps). It can drop/withhold/reorder
  (availability), but it cannot read or forge message bodies.
- ⚠️ **Vercel's own "Workflow E2E encryption" is NOT zero-knowledge** — keys are
  Vercel/deployment-managed and decryptable via the dashboard/CLI. We treat it as
  defense-in-depth only and do **all** crypto ourselves, client-side, passing only
  ciphertext into `start()`, hooks, steps, streams. (Verified: Vercel docs +
  security review of Happy, which got this wrong for stored API keys — see §11.)
- **Trust roots:** the CLI host (holds the secret + runs Claude) and any device
  the user pastes the secret into. A leaked secret = full compromise of that host
  (read + write + decrypt past/future retained ciphertext). Mitigation: rotation
  = new secret = new space (§4.4).

## 3. Components

```
  ┌── server A (your machine) ──────────────┐         ┌──────── Vercel (broker) ────────┐        ┌── phone / laptop ──┐
  │ claude --remote-control                  │         │  ingest Functions (auth: token) │        │  web app (Next.js) │
  │      ▲  MITM (our relay = RC backend)    │  wss/   │  per-session Workflow (buffer)  │  SSE/  │  paste secret →    │
  │      │  + in-memory log (claude=record) │  https  │  (no history — relay only)      │ stream │  derive keys →     │
  │ remote-claw serve --hostname <app> ──────┼────────▶│  live fan-out (SSE + workflow)   │◀──────▶│  decrypt & render  │
  │   (machine identity: secret S, 0600)     │ ciphertext only                          │        │  encrypt & send    │
  └──────────────────────────────────────────┘         └─────────────────────────────────┘        └────────────────────┘
    one machine = one secret/auth; each claude instance on it = one "space"/chat
```

### 3.1 CLI — two commands (as requested)

1. **`remote-claw identity`** — create an **identity** (the default machine
   identity). The **secret is the boundary**, not the hardware.
   - Generates a **root secret `S`** (32 bytes CSPRNG), stores it `0600` in the
     state dir, derives `host_id`/`auth_token`/`content_root` (§4).
   - Registers the identity (`POST /api/hosts` with `host_id`, `sha256(auth_token)`,
     and an **encrypted** friendly name, default = hostname).
   - Prints the **pasteable secret** `rc1_…` once. Re-running prints `host_id` +
     status (never reprints `S` unless `--show`). You can create **more than one**
     identity and pick among them with `--secret` below — so one machine can present
     several "accounts."

2. **`remote-claw serve --hostname <app> [--secret rc1_… | --id NAME]`** — the
   **wrapper**. Runs the **real interactive `claude` TUI** and, when the user
   enables remote control, makes it RC-eligible **pointed at our local MITM** (not
   Anthropic's RC relay — §14). Our relay is the RC backend; it bridges that traffic
   E2E-encrypted to the app **under the chosen secret** (default = the machine
   identity; override to run instances under a different identity on the same box).
   - Encodes the relay logic in Node/TS (reimplementing the Phase-0 interception
     knowledge): on each worker→relay event, log it, allocate `seq`, encrypt with
     the per-session key, and `POST /api/relay`; subscribe (SSE) to the host's
     inbound channel, **dedup by `msg_id`**, decrypt, and deliver to Claude **after
     log commit**, then echo `accepted`.
   - Maintains in-memory relay state (catch-up log, `msg_id` seen-set, registered
     sessions, crypto state) — **recoverable from the claude session** by
     re-enabling `/remote-control` (the worker re-backfills), so no durable store is
     required; both wrapper and CLI are stateless (claude's on-disk session is the
     durable layer). Answers encrypted `catch_up{since=seq}` from its log, falling
     back to worker backfill (§6).
   - **Heartbeats with a TTL:** while RC is enabled, the wrapper `POST
     /api/heartbeat {host_id, session_ids[], ts}` every ≈15 s so the broker/web can
     show which hosts/sessions are online (§3.2). Stops when the wrapper/CLI exits
     (the wrapper does **not** outlive the CLI) → the session goes offline after the
     TTL.

### 3.2 Vercel app (the broker — relays ciphertext, stores no chat history)
- **Ingest Functions** (Node runtime, fast + die): `POST /api/relay` (a ciphertext
  frame in either direction), `POST /api/hosts`, `POST /api/sessions`, all
  bearer-authed by `auth_token`, all accepting **ciphertext only**.
- **Live fan-out:** a per-session Vercel **Workflow durable resumable stream**
  carries in-flight frames; a streaming `GET /api/stream?session=&since=seq`
  delivers live and lets a client resume by `seq` after a drop. This is a **buffer,
  not the record** (§6).
- **Catch-up is proxied to the wrapper, not served from the cloud.** A
  `catch_up{since=seq}` control frame is relayed to the wrapper, which replies with
  `historical` frames from its log (then worker backfill). There is **no**
  `GET /api/messages` history store.
- **Presence / heartbeat (TTL):** the wrapper `POST /api/heartbeat {host_id,
  session_ids[], ts}` every `HEARTBEAT_INTERVAL` (≈15 s); the broker updates
  `last_seen` on the host + each active session. **Online ≡ `now − last_seen <
  HEARTBEAT_TTL`** (≈45 s = 3 missed beats), computed at read time — so the web can
  show which hosts/sessions are up without any push. The heartbeat carries only
  routing metadata (ids + ts), no content → zero-knowledge holds. (Distinct from
  the worker→relay keep-alive of the RC protocol; this is host→broker presence.)
- **Read Functions:** `GET /api/hosts`, `GET /api/sessions?host=` (return the
  latest *encrypted* registry snapshot the wrapper published — names/titles only,
  not message history — **plus a computed `online` flag** from `last_seen`+TTL).

### 3.3 Web client (stateless, mobile-first)
- Paste secret (or open a link with the secret in the **URL fragment** `#…`, which
  browsers never send to the server). Derive keys in-browser (WebCrypto).
- **Spaces** = **every claude instance across all your machines**, grouped by
  machine (one pasted secret unlocks all of a machine's instances). **Add a
  machine** = paste its secret. Secrets persist in `localStorage` (documented
  risk) or memory-only (re-paste).
- Pick a space (instance) → message view: load history (decrypt) + subscribe live
  (decrypt) + send (encrypt → POST).
- PWA, responsive; no server-side session state.

## 4. The secret & key hierarchy (token approach)

One **root secret `S`** per identity is the only thing copied/pasted. Everything is
derived deterministically with **HKDF-SHA256** (RFC 5869), identical code on CLI
host and web client.

### 4.1 Secret format (non-guessable, mobile-pasteable)
```
rc1_<base64url(S, 32 bytes = 256 bits, no padding)><4-char Crockford-base32 checksum of sha256(S)>
```
~52 chars, one contiguous token (no spaces → safe on iOS/Android paste); the
checksum fails fast on a mistyped/truncated paste before any network call.
256-bit CSPRNG ⇒ not guessable. (BIP39 24-word form offered only as an optional
human-readable *backup* export.)

### 4.2 Derivation (domain-separated siblings)
```
PRK           = HKDF-Extract(salt="remote-claw/v1", IKM=S)
host_id       = HKDF-Expand(PRK, "remote-claw/v1/host-id",       16B)  → PUBLIC routing id (the "space")
auth_token    = HKDF-Expand(PRK, "remote-claw/v1/auth",          32B)  → bearer to the Vercel API
content_root  = HKDF-Expand(PRK, "remote-claw/v1/content",       32B)  → CLIENT-ONLY master content key
control_key   = HKDF-Expand(PRK, "remote-claw/v1/control",       32B)  → AEAD key for control frames (catch_up, permission)
K_host_meta   = HKDF-Expand(PRK, "remote-claw/v1/meta/host",     32B)  → encrypts host friendly name
K_session_meta= HKDF-Expand(PRK, "remote-claw/v1/meta/session",  32B)  → encrypts session title/cwd
```
- **Confidentiality (zero-knowledge) is scoped to `content_root`/`control_key`/
  meta-keys.** The server is given `host_id` + `auth_token` only, never `S`/`PRK`/
  the content keys. Recovering a content key from the siblings requires inverting
  HMAC-SHA256 (preimage resistance) — infeasible. So the broker **cannot read
  message or metadata bodies**.
- **Honest scope of `auth_token`:** it's *authorization*, not confidentiality. The
  server stores `sha256(auth_token)` so a **DB-at-rest** leak isn't replayable —
  but the live bearer is presented on every request, so Vercel's TLS-terminating
  edge (and any request log) **sees a replayable token**. Treat the broker as able
  to act with that token (write/route to this host) — it still can't decrypt.
  Mitigations: never log the `Authorization` header, constant-time hash compare,
  rate-limit, and (later) short-lived scoped tokens minted from `auth_token`.

### 4.3 Session → message key flow (answers "do we need a session→key flow?")
Yes — a 3-level hierarchy:
```
content_root
   └─ K_session = HKDF-Expand(content_root, "session:" + session_id, 32B)
         └─ per message:  salt = random 32B
                          K_msg = HKDF-Expand(IKM=K_session, salt=salt,
                                              info="remote-claw/v1/msg" + canonical_AAD, 32B)
                          ct = AES-256-GCM(K_msg, nonce=random 12B, AAD = canonical_AAD)
   canonical_AAD = canonical-encode(v, host_id, session_id, dir, record_kind, seq, msg_id, key_epoch)
```
**Why per-message subkeys instead of a global counter nonce:** the web client is
*stateless* and the secret can be pasted into *several devices/tabs at once* →
multiple concurrent senders share a key. A monotonic-counter nonce would collide
across those senders and AES-GCM nonce reuse is catastrophic. A fresh random
256-bit `salt` per message gives an independent `K_msg`, so a fatal nonce reuse
requires the **same 256-bit salt and the same 96-bit nonce on the same key** —
negligible for any realistic message volume, with **zero per-sender state**, all
in WebCrypto (no libsodium/WASM). Folding `canonical_AAD` into the `K_msg` `info`
adds key-level domain separation at no cost. `seq` is cleartext metadata bound
into AAD for ordering/replay — **not** the nonce, so ordering is decoupled from
crypto safety. (We will publish formal limits + cross-runtime test vectors in P1
rather than rely on a back-of-envelope bound. Alternative for misuse-resistance
without per-message HKDF: XChaCha20-Poly1305 — heavier; not needed.)

### 4.4 Rotation / revocation
Rotation = generate a **new `S`** ⇒ new `host_id` ⇒ a new space; delete the old.
No per-device revocation without rotating (single-secret tradeoff). `info` labels
carry `/v1/` for future migration. Optional v2: split `S` into a
server-registered half + a paste half so a leaked paste can be revoked without
losing stored ciphertext (adds onboarding friction).

## 5. Message flow (both directions, ciphertext only)

**Worker → web** (assistant output): worker emits event → `vercel_relay` encrypts
(`K_session`, fresh `K_msg`) → `POST /api/messages {host_id, session_id, dir:"out",
seq, salt, nonce, ct}` (bearer `auth_token`) → ingest Fn resumes the session
workflow hook → workflow step persists ciphertext to the store **and** writes it
to the run's durable stream → web clients tailing the stream decrypt & render.

**Web → worker** (your prompt): web encrypts (`dir:"in"`) → `POST /api/messages`
→ workflow persists + streams on the `in` channel → `vercel_relay` (subscribed)
decrypts → ingests into Claude via the Phase 0 downstream. Claude replies → the
worker→web path above.

Both sides: read history first (`GET /api/messages?since=seq`, decrypt), then tail
live; dedupe by `msg_id`, order by `seq` (broker delivery is at-least-once, not
FIFO — §6).

## 6. The durable spine + persistence + realtime (the core decision)

Verified Vercel facts that shape this:
- **Workflows (GA 2026-04-16)** give durable runs, `defineHook`/`resume` for
  inbound events, and **durable resumable streams** (reconnect by `runId` +
  `startIndex`) — Vercel-native, no separate pub/sub. **But:** completed-run
  retention is **Hobby 1d / Pro 7d / Ent 30d**, per-run caps are **2 GB / 25 000
  events / 10 000 steps**, and replay degrades past ~2 000 events. ⇒ a single
  ever-growing per-session workflow is **not** a durable history store.
- **No native WebSockets** on Vercel; SSE-from-Function is capped (300s Hobby /
  800s Pro and you pay for idle) ⇒ not a forever-socket.
- **Vercel KV/Postgres were retired** → Upstash Redis / Neon via Marketplace.
  **Vercel Queues** exists but is **beta** (`queue/v2beta`), at-least-once, no FIFO,
  7-day retention.

**DECISION (chosen): W′ — the TUI is the brain; the cloud is a dumb,
zero-knowledge pipe; the web is a thin renderer.**

It concentrates every "smart" on the TUI host. (⚠️ Plan-review correction: an
earlier draft claimed the worker's "replay/backfill" was *verified* — that was an
overstatement. Phase 0 confirmed those **strings exist in the binary** but did
**not** prove a usable seq-range replay request; the only worker-side history we
*actually verified* is the cursor-paginated `GET /v1/code/sessions/{id}/events?
sort_order=&cursor=` API. The design below relies only on that + the wrapper's own
log — never on an unproven replay primitive. See §14.)

- **The durable record is claude's on-disk session; the wrapper's log is
  in-memory.** The `serve` wrapper sees every frame both directions and keeps an
  **in-memory per-session log** (keyed by `seq`) as the live catch-up source. It is
  **not** persisted: both wrapper and CLI are stateless, and the in-memory log is
  rebuilt from claude on (re)connect (next bullet). The authoritative transcript is
  claude's own `~/.claude/projects/.../<session>.jsonl`.
- **History (and recovery) comes from claude, reseeded by the worker backfilling
  `historical` frames to OUR relay** on RC connect (Phase 0 observed `historical:
  true` events arriving at the relay; reconnect-reseed hardened in P4). The local
  `~/.claude/projects/<cwd>/<session>.jsonl` transcript is a last-resort fallback.
  We do **not** use Anthropic's `/events?cursor=` (we're off Anthropic's relay —
  §14). The TUI owns sessions and `seq` ordering; **the cloud stores no history.**
- **`seq` is allocated solely by the wrapper.** Clients never assign transcript
  order: a web client sends a `client_msg_id`; the wrapper decrypts, commits to its
  in-memory log, assigns the canonical `seq`, then echoes an `accepted{client_msg_id, seq}`.
  Clients retry until `accepted`; the wrapper forwards a prompt to Claude **only
  after** its log commit (so POST-accepted-by-broker ≠ delivered).
- **Replay/idempotency:** delivery is at-least-once and the broker can *replay a
  valid old ciphertext*, so the wrapper keeps a **durable seen-set keyed by
  `msg_id`** and drops duplicate inbound/control frames **before** any side effect.
- **Catch-up is an encrypted control frame to the wrapper.** A client sends an
  **AEAD-encrypted** `catch_up{since=<last-seen seq | 0>, msg_id, expiry}` (control
  frames use a derived control key + replay check — never plaintext the broker
  could inject); the wrapper serves the delta from its log (then worker-backfill
  for ranges older than the log), streaming `historical` frames, then live.
- **The cloud = relay + short live buffer only (Vercel-native, no third party).**
  Live ciphertext frames go out over **SSE from a streaming Vercel Function**,
  backed by the per-session **Workflow durable resumable stream**. When the SSE
  connection hits Vercel's duration cap (or drops), the client simply
  **reconnects and resumes by `seq`** — any gap is refilled by the wrapper's
  `catch_up` (the wrapper is the history source, so we need no provider-side
  message history). Trivial fallback if streaming is ever a problem: plain
  polling `GET /messages?since=seq`. Stream retention (1–7 d) is irrelevant — it's
  an in-flight buffer, not the record.
- **The web client caches what it has seen** (IndexedDB, keyed by `seq`) purely as
  an optimization: a reconnect pulls only the delta; a fresh device asks the TUI
  for everything. The TUI stays authoritative.

Consequence (accepted): browsing history requires the TUI to be **online** — which
a live Claude session needs anyway (RC sessions end ~10 min after the worker goes
offline). If offline history-browsing is ever wanted, add an optional Upstash
Redis ciphertext log later (drop-in; the cloud already speaks ciphertext+`seq`).

Invariants either way: **the broker sees ciphertext only**; ordering is by
TUI-assigned `seq`; live delivery is **at-least-once** so clients dedupe by
`msg_id` and reorder by `seq`; crypto happens in the TUI + browser and in thin
Functions/steps, **never** inside the deterministic `'use workflow'` body (random
nonces / stream reads break replay determinism).

## 6A. Message types, channels & ephemeral workflow state

The broker stays dumb and the wrapper/claude stay authoritative. Here is every
frame, every channel, and exactly what (little) state the workflow keeps so that
live delivery + reconnection feel natural without the workflow becoming the record.

### Frame types (`record_kind`)
All frames share the §8 envelope (AEAD ciphertext + cleartext routing header).
`dir`: **out** = wrapper→web, **in** = web→wrapper.

Content frames (**out** — from the claude worker, via our relay; encrypted under the per-session content key):
| kind | seq | source | notes |
| --- | --- | --- | --- |
| `user` | ✓ | RC | user-message echo; `historical:true` on backfill |
| `assistant` | ✓ | RC | model output (+ partial deltas if we enable them) |
| `result` | ✓ | RC | turn complete (cost / usage) |
| `system` / `status` / `rate_limit` | ✓ | RC | lifecycle (init, "requesting", limits) |
| `can_use_tool` | ✓ | RC | permission request, *if* a mode ever gates a tool |

Control frames (**in** — from the web client → wrapper → worker; encrypted under `control_key`, carry `msg_id` + `expiry`, replay-checked):
| kind | maps to RC verb | notes |
| --- | --- | --- |
| `user` | (prompt) | a typed message; carries `client_msg_id` |
| `catch_up` | — (ours) | request history `since=seq` |
| `permission` | `control_response` | allow/deny a `can_use_tool` |
| `interrupt` | `interrupt` | ESC / stop the current turn |
| `set_mode` | `set_permission_mode` | e.g. bypassPermissions toggle |
| `set_model` | `set_model` | switch model |
| `command` | (slash) | `/compact` `/clear` `/context` … |
| `end` | `end_session` | terminate the session |

Our non-content meta frames:
| kind | dir | notes |
| --- | --- | --- |
| `accepted` | out | wrapper ack of a client frame: `{client_msg_id, seq}` |
| `heartbeat` | wrapper→broker | presence `{host_id, session_ids[], ts}` (TTL, §3.2) |
| `host_register` / `session_register` / `session_update` | wrapper→broker | latest-wins **encrypted** name/title/cwd/status snapshots |

(`historical` is a **flag** on replayed content frames, not a separate kind.)

### Channels / queues (per session; names derived from `host_id`+`session_id`)
- **out-stream** (wrapper→web): the per-session **Workflow durable resumable
  stream**; web tails by `startIndex`/`seq`.
- **in-queue** (web→wrapper): web `POST /api/relay`; delivered to the wrapper via a
  Workflow **hook** (`defineHook`/`resume`) — or a second resumable stream the
  wrapper tails. No polling.
- **presence**: heartbeats update `last_seen` (not a stream).
- **registry**: host/session snapshot rows (latest-wins, not a stream).

### Ephemeral state the workflow holds — and why it's "enough"
**One workflow run per active session** (started on RC-enable/registration; idles
out after the session goes offline past TTL). It holds ONLY:
1. the **recent in-flight frame buffer** (both directions), as the durable
   resumable streams — bounded to a recent window, so a client reconnecting within
   the window resumes seamlessly by `startIndex`; anything older → `catch_up`.
2. **resume cursors** (last out-`seq` delivered, last in-`seq` accepted).
3. the inbound **hook** so web frames wake the wrapper's tail without polling.
4. a small **recent `msg_id` dedup window** (broker is at-least-once; the wrapper
   dedups authoritatively — this just avoids obvious buffer dupes).
5. **presence/`last_seen`** for the online flag.

It deliberately does **not** hold: the durable transcript (claude's on-disk session),
long-term history, or any plaintext. Its 1–7 day retention is irrelevant because
everything in it is reconstructible from the claude session via `catch_up`. That is
the "just enough ephemeral state to be natural" line: the **workflow** makes live
delivery + short-window reconnection seamless; the **wrapper** makes deep history
correct.

### Lifecycle (the natural flow)
RC enabled → wrapper registers host/session + starts/relinks the session workflow →
streams open. Live turn → `assistant`/`result` flow out-stream, `user` flows
in-queue via the hook; clients tail; wrapper logs + echoes `accepted`. Brief
reconnect (web or wrapper) → resume by `seq` from the workflow buffer. Gap older
than the buffer / cold device → `catch_up` → wrapper replays from its log (or worker
backfill). Session ends / wrapper exits (it never outlives the CLI) → heartbeats
stop → `online=false` after TTL → workflow idles and its retention expires; nothing
is lost because claude holds the transcript.

## 7. Multi-host "spaces" & onboarding
- Each pasted secret = one **identity**; **each claude instance under it = one space**. The web stores the set of secrets
  (client-side) and renders spaces with decrypted friendly names (default
  hostname, editable; name stored **encrypted** in the host registry).
- **Add a host:** paste another `rc1_…`; the checksum validates it, keys derive,
  `GET /api/sessions?host=host_id` lists that host's sessions.
- Within a space: sessions listed gchat-style (encrypted title + last-activity),
  grouped by repo/cwd. Session metadata (id, timestamps) is unavoidably visible to
  the broker — minimized and documented.

## 8. Data model / API (sketch)
Cloud-persistent (registry snapshots only — **no message bodies kept**):
- `host`    : `{ host_id, sha256(auth_token), enc(name), created_at, last_seen }`
  (name encrypted under `K_host_meta`)
- `session` : `{ host_id, session_id, enc(title), enc(cwd), status, last_activity }`
  (title/cwd encrypted under `K_session_meta`; `status`/timestamps are cleartext
  metadata — visible to broker)

Transient relay **frame** (buffered in the live stream, not a durable row):
```
{ v, host_id, session_id, dir, record_kind, seq|null, msg_id, client_msg_id?,
  key_epoch, salt, nonce, ct }      // ct includes the GCM tag
AAD = canonical-encode(v, host_id, session_id, dir, record_kind, seq, msg_id, key_epoch)
```
`record_kind` ∈ `user | assistant | result | control | accepted | catch_up`.
Control/`catch_up` frames are AEAD-encrypted under a derived **control key** with
`msg_id` + `expiry` and are replay-checked. AAD binds **every** cleartext header
field via a single canonical serialization (length-prefixed or CBOR) — no ad-hoc
`a|b|c` concatenation (ambiguous).

Registry rows also carry `last_seen` (updated by heartbeat) → `online` is computed
`now − last_seen < HEARTBEAT_TTL` (§3.2).

Endpoints (all bearer `auth_token`, all ciphertext): `POST /api/hosts`,
`GET /api/hosts`, `POST /api/sessions`, `GET /api/sessions`, `POST /api/relay`,
`POST /api/heartbeat`, `GET /api/stream?session=&since=seq`. (No `GET /api/messages`
— history is wrapper-served, §6.)

## 9. Decisions (resolved 2026-06-07)
1. **Durable store / history → W′ (TUI is the brain).** No cloud history. The
   `serve` wrapper holds a durable per-session log on the TUI host and serves
   catch-up via message-passing; the Claude worker transcript is the deep-history
   fallback (RC backfill). Cloud is a dumb ciphertext pipe + short live buffer.
   Optional Upstash Redis ciphertext log can be added later for offline browsing.
2. **Realtime transport → Vercel-native only (no third party).** SSE from a
   streaming Function backed by the Workflow durable stream; client
   reconnects and resumes by `seq` (gaps refilled by the wrapper's `catch_up`).
   Plain polling `GET /messages?since=seq` is the trivial fallback. No Ably/Pusher.
3. **Browser secret storage → `localStorage` + "forget" button** (with a clear
   risk warning); PIN-wrapped storage is a later option.
4. **Web framework → Next.js on Vercel** (assumed; confirm if not).

## 10. Language & layout

**TypeScript everywhere** — one language for the CLI wrapper (Node), the shared
crypto, and the web app. No Python. The crypto core is genuinely shared code (both
Node and the browser use the same WebCrypto API), so there are no cross-language
test vectors to maintain. The Phase 0 Python relay (`phase0/remote_claw`) stays as
the **reference implementation** of the Claude-interception protocol; v2
reimplements that protocol fresh in Node/TS.

Proposed monorepo (pnpm workspaces) in this repo:
```
packages/clawsec   shared crypto (TS, WebCrypto; runs in Node + browser)
packages/cli       the Node CLI: `remote-claw identity` + `serve` (MITM + relay)
apps/web           Next.js app (Vercel): API routes, workflow, web client UI
phase0/            unchanged — the Python reference + protocol findings
```

## 11. Phased plan
- **P0.5 — Capture spikes (DONE 2026-06-07, all PASS).** Settled every open
  TUI-side question on `claude` 2.1.168:
  - `rc_api_bridge.py` — the RC-API-client bridge is *viable* but **rejected**
    (routes remote through Anthropic's relay, §14). MITM is chosen.
  - `tui_remote_control.py` — drove a **real interactive TUI** through our MITM and
    proved all 6 claims: **C1** `/remote-control` (mid-session slash command) enables
    RC on our relay; **C2** the wrapper receives the **prior** chat history (worker
    backfill); **C3** a **generic client message reaches the real TUI and the reply
    comes back**; **C4** the same exchange shows in the local TUI (one synced
    session); **C5** kill **both** wrapper+CLI, reboot (`claude --continue` +
    `/remote-control`) → the **full transcript recovers from claude's persisted
    session** → both components are stateless / in-memory is sufficient. Verdict:
    *TUI-SIDE MODEL FULLY VERIFIED*.
- **P1 — Crypto core.** `packages/clawsec` (TypeScript): secret gen/parse/checksum,
  HKDF hierarchy, AES-256-GCM encrypt/decrypt, AAD, envelope format. Vitest unit
  tests (incl. round-trip + tamper/AAD-rejection). No network. Runs in Node +
  browser unchanged.
- **P2 — CLI: `identity`.** `packages/cli` in Node/TS: generate/store `S`, derive
  ids, print `rc1_…`, register host. Local only (mock app).
- **P3 — Vercel app skeleton.** `apps/web` (Next.js): ingest/read API routes + auth
  (`sha256(auth_token)`), per-session workflow with hook + durable stream, SSE
  endpoint. Deploy; curl round-trip with hand-rolled ciphertext.
- **P4 — CLI: `serve` relay (MITM — §14).** Node/TS reimpl of the Phase 0
  interception: the wrapper runs the real interactive `claude` and, when RC is
  enabled, points it at our local MITM (`HTTPS_PROXY` → our proxy with a trusted
  leaf cert; intercept `/v1/code/sessions*`; pass `/v1/messages` through to
  Anthropic for inference). Our relay is the RC backend — Anthropic's RC relay is
  never used. Then: log each frame, allocate `seq`, encrypt → `POST /api/relay`;
  subscribe inbound (SSE) → dedup by `msg_id` → decrypt → deliver to Claude only
  after log commit, then echo `accepted`. End-to-end: a curl "web" drives a real
  Claude session through Vercel.
- **P5 — Web client.** Paste/fragment secret, spaces list, session list, message
  view (history + live), send. Mobile/PWA.
- **P6 — Multi-host + polish.** Add-host, friendly names, reconnect/resume, replay
  from `since=seq`, rotation, error states.
- **P7 — Hardening + review.** `/code-review` + codex pass (as in Phase 0):
  auth/abuse on ingest routes, replay-window correctness, at-least-once dedupe,
  rate-limiting, secret-handling hygiene.

## 12. Risks / inherited fragility
- **Anthropic RC interception** (the Phase 0 MITM of `/v1/code/sessions`, pinned to
  `claude` 2.1.168) underpins v2 too — it can break or be re-gated on any Claude
  upgrade. Keep the capture tool (`mitm/capture-proxy.py`) to re-verify.
- **Single per-host secret** = single point of failure; no per-device revocation
  without rotation. Pasting into a browser exposes it to that device's XSS/
  extension/clipboard surface. `rc1_` high-entropy tokens trip secret scanners if
  pasted into a repo.
- **At-least-once, no FIFO** from the broker ⇒ dedupe + reorder is mandatory.
- **Metadata leak:** the broker sees `host_id`, `session_id`, `seq`, sizes,
  timing. Not metadata-private. Pad/normalize later if it matters.
- **Counter/nonce safety:** resolved by per-message HKDF subkeys (§4.3); do **not**
  regress to a shared counter nonce with stateless/multi-device senders.
- **Vercel Queues / WDK surface** still moving (Queues beta); Workflows GA is
  stable — pin SDK versions, isolate behind a thin transport interface.

## 13. Sources (verified 2026-06-07)
- Vercel Workflows docs / concepts / pricing+limits — https://vercel.com/docs/workflows ·
  /workflows/concepts · /workflows/pricing (GA 2026-04-16; retention & caps as cited)
- Workflow Development Kit (public beta 2025-10-23) — https://vercel.com/changelog/open-source-workflow-dev-kit-is-now-in-public-beta · https://workflow-sdk.dev
- "A new programming model for durable execution" (GA) — https://vercel.com/blog/a-new-programming-model-for-durable-execution
- Vercel Queues (public beta) — https://vercel.com/docs/queues
- Storage: Upstash Redis / Neon via Vercel Marketplace (KV/Postgres retired 2024)
- Realtime constraints (no native WS; SSE duration caps) — Vercel Functions docs
- HKDF RFC 5869; AES-GCM nonce limits (NIST SP 800-38D); WebCrypto SubtleCrypto
- Prior art: Happy (https://github.com/slopus/happy ; security review Discussion #680 — server-side key handling = what to avoid); OpenCode E2EE RC proposal #15236 (secret-in-URL-fragment, blind relay)

## 14. Plan review (2026-06-07) — findings, revisions, open decision

Two independent reviewers (the `/code-review` multi-agent design workflow + codex
gpt-5.5) evaluated this plan and **converged** on the same load-bearing issues.
The crypto/secret core was judged **sound**; the protocol/reliability layer needed
tightening. Accepted fixes are already folded into §3–§8 above:

- **`seq` is wrapper-allocated, with commit semantics.** Clients never assign
  transcript order; they send `client_msg_id`, the wrapper logs + assigns `seq` +
  echoes `accepted{client_msg_id, seq}`; Claude receives a prompt only after log
  commit. (§6)
- **Replay protection ≠ AEAD.** The broker can replay a valid old ciphertext →
  durable `msg_id` seen-set; drop dupes before side effects. (§6)
- **Control frames are encrypted** under a derived `control_key` with `msg_id` +
  `expiry` + replay-check (catch_up/permission can't be server-injected). (§4.2,§8)
- **Cloud-history contradiction removed.** The broker stores **no message bodies**;
  catch-up is wrapper-served (log → worker backfill). Dropped `GET /api/messages`.
  (§3.2,§6,§8)
- **Overstated "verified replay" corrected.** Only string-presence was confirmed in
  the binary, not a usable seq-range replay; design relies on the wrapper log +
  worker backfill to our relay — NOT Anthropic's cursor API (we're off their relay). (§6,§11,§14)
- **AAD/envelope canonicalized** (binds v, host_id, session_id, dir, record_kind,
  seq, msg_id, key_epoch via one serialization). (§4.3,§8)
- **Encrypted-metadata keys** added (`K_host_meta`, `K_session_meta`). (§4.2,§8)
- **Honest zero-knowledge scope:** confidentiality covers content/meta keys only;
  `auth_token` is authz and the **live bearer is visible to the broker** (sha256
  protects only the at-rest DB). Never log it; rate-limit; constant-time compare.
  (§4.2)
- **Crypto claims toned down:** formal limits + cross-runtime test vectors in P1
  instead of a back-of-envelope bound; `K_msg` info now folds the canonical AAD.
  (§4.3)
- Labeling: treat `(v1)` non-goals as **"this release / MVP"**; reserve "v2" for
  the doc title. No-forward-secrecy / single-secret-blast-radius called out louder
  in §12.
- Keep realtime behind a **transport interface** (Workflows are event-log runs, not
  chat rooms — batch frames; SSE needs heartbeat/reconnect/`startIndex`/polling
  fallback). (§6)

### RESOLVED decision: MITM (not the RC-API bridge)
Both reviewers raised that an RC-API-client bridge could avoid the MITM, and the
**P0.5 spike confirmed it works** (`phase0/spikes/rc_api_bridge.py` →
`captures/spike-rc-api-bridge.log`: inject + cursor-history catch-up + live client
SSE all PASS as a pure client). **But the bridge routes the remote channel through
Anthropic's RC relay, which is exactly what we will NOT do.** Decision (user,
2026-06-07): **all remote traffic goes through OUR MITM**; Anthropic's RC relay is
never in the loop — only model inference (`/v1/messages`) passes through to
Anthropic.

So the wrapper runs the **real interactive `claude` TUI** and, when the user
enables remote control, makes it RC-eligible **pointed at our local MITM** (Phase
0 method: `HTTPS_PROXY` → our proxy intercepts `/v1/code/sessions*`; our relay is
the RC backend — verified end-to-end in Phase 0, the MANGO test). The wrapper is
the RC backend, so it sees and logs **every** frame; it then E2E-encrypts to
Vercel. The bridge is recorded as a **rejected alternative** (keeps the protocol
shapes it validated; we serve the same shapes ourselves).

Consequence for history (supersedes earlier "events-cursor" wording): since we are
**off Anthropic's relay**, deep history does **not** come from Anthropic's
`/events?cursor=` API. Sources are: (1) the wrapper's **in-memory log** (a live buffer,
rebuilt from claude on restart); (2) for a session that predates the log, the worker
**backfills `historical` frames to OUR relay on RC connect** (Phase 0 observed
`historical:true` events arriving at the relay) — harden reconnect-reseed in P4;
(3) the local `.jsonl` transcript as a last resort. No Anthropic cloud history.

## 15. Use cases / scenario matrix (also the v2 test plan)

Each maps to the frames (§6A), channels, endpoints (§8), and state. **[V]** = an
aspect already empirically verified (Phase 0 MANGO / the P0.5 spikes C1–C5 +
rc_api_bridge); others are specs to build/test.

**Identity & host bring-up**
1. **Fresh machine bootstrap.** `remote-claw identity` → generate root `S` (0600),
   derive `host_id`/`auth_token`/`content_root`/`control_key`/meta-keys, `POST
   /api/hosts {host_id, sha256(auth_token), enc(name=hostname)}`, print `rc1_…`
   once. (secret format §4.1, derivation §4.2)
2. **Wrapper launches the real TUI, RC OFF.** `remote-claw serve` runs the real
   interactive `claude`; no remote traffic except (optional) host heartbeat → host
   shows online with **no sessions**. Local-only. **[V]** (TUI launch)
3. **Work locally, RC still off.** Build a conversation; it lives only in claude's
   on-disk transcript; the broker knows nothing. **[V]** (local history)

**Enabling remote control**
4. **Enable RC mid-session via `/remote-control`.** Wrapper points the inner claude
   at the local MITM → our relay is the RC backend; worker backfills the existing
   transcript as `historical` frames → log seeds; `POST /api/sessions {enc(title),
   enc(cwd)}`; session goes online. **[V]** C1+C2
5. **Launch with RC on.** `serve --remote-control` → fresh session, our relay is the
   backend from the start, empty history. **[V]** (Phase 0)

**Client onboarding & discovery**
6. **Client first connection.** Open web app, paste `rc1_…` (or `#fragment`) →
   derive keys in-browser → `GET /api/hosts` → one space, online via heartbeat;
   store secret in localStorage.
7. **Client second connection, 5 wrappers.** 5 secrets pasted over time → web lists
   all their **instances as spaces** (grouped by secret), each with online/offline (heartbeat TTL §3.2) +
   last-activity. (the "know the 5 separate claude-code wrappers" case)
8. **List sessions in a host.** Select space → `GET /api/sessions?host=` → decrypt
   titles/cwd client-side → gchat-style session list with online + last-activity.

**History sync**
9. **Open a session cold (full sync).** Client sends encrypted `catch_up{since=0}`
   → Vercel → wrapper replays full log (or triggers worker backfill) as `historical`
   → client decrypts/renders, then tails live. (the "grab current history to sync")
10. **Reopen a session (delta sync).** Client cached up to `seq=N` (IndexedDB) →
    `catch_up{since=N}` → wrapper sends only `>N`; or resume from the workflow buffer
    by `startIndex` if within the window.

**Messaging (the core loop)**
11. **Send from client → underlying claude.** Client encrypts a `user` frame
    (`client_msg_id`) → `POST /api/relay` → workflow in-queue → wrapper hook → dedup
    by `msg_id` → log → decrypt → inject into claude via MITM downstream → echo
    `accepted{client_msg_id, seq}`; claude replies → `assistant`/`result` out-stream
    → client renders. **[V]** C3 (the "how a message routes to the underlying CLI")
12. **Type in the local TUI → appears in client.** Worker emits `user`+`assistant`
    upstream → out-stream → all clients render (`source=worker`). **[V]** C4
13. **Two clients, one session (fan-out).** Phone + laptop both tail the out-stream;
    a message from either shows on both + the TUI. (multi-client)

**Multi-host & naming**
14. **Add a host.** Paste another `rc1_…` → new `host_id` → new space appears.
15. **Rename host/session.** Friendly name encrypted under `K_*_meta` → registry
    update; other devices decrypt the new name (default = hostname).

**Control & permissions**
16. **Tool permission (`can_use_tool`).** If a tool gates, worker emits a
    `control_request` → out-stream → client Allow/Deny → encrypted `permission`
    control frame → wrapper → `control_response` to claude. (plumbed; RC auto-runs today)
17. **Remote control verbs.** Client sends `interrupt` (ESC) / `set_mode` /
    `set_model` / `command` (`/compact`,`/clear`) control frames → wrapper → claude.

**Resilience**
18. **Network blip mid-turn.** Client SSE drops → reconnect `GET /api/stream?since=
    seq` → resume from the workflow buffer; at-least-once → dedup by `msg_id`; no
    missed/dup frames.
19. **Wrapper/CLI restart (both stateless).** Reboot/crash → relaunch `claude
    --continue` + `/remote-control` → worker re-backfills → log rebuilt; clients
    reconnect + `catch_up`; heartbeat resumes → online. **[V]** C5
20. **Host offline → back.** Wrapper exits (never outlives the CLI) → heartbeat
    stops → after TTL the space/sessions show **offline**, client sends rejected
    ("host offline"); on return (relaunch + `/remote-control`) → online, `catch_up`
    fills the gap.

Also covered by the same mechanisms (not numbered): **secret rotation** (new `S`
→ new `host_id` = new space; old space dead — §4.4), and a **broker (Vercel)
outage** (the local TUI keeps working; remote is unavailable; clients reconnect and
`catch_up` when the broker returns — nothing lost since claude holds the transcript).

## 16. Message sequences (per use case)

Actors: **C**=web/generic client · **V**=Vercel broker (functions+workflow) ·
**W**=wrapper/relay (host side: MITM + relay client) · **T**=real claude TUI ·
**A**=Anthropic API (**inference only**, passthrough). All C↔V↔W payloads are
ciphertext (`{…}` = decrypted view); every C/W→V call carries `Bearer auth_token`.
Frame kinds per §6A. `→` one message; steps are ordered.

**1. Fresh machine bootstrap** (`remote-claw identity`)
1. W: gen `S`; derive `host_id, auth_token, content_root, control_key, K_*_meta`
2. W→V `POST /api/hosts {host_id, sha256(auth_token), enc(name=hostname)}`
3. V→W `200`; W prints `rc1_…`  *(no T, no session)*

**2. Wrapper launches real TUI, RC OFF** (`remote-claw serve`)
1. W spawns **T** with `HTTPS_PROXY→W`, `NODE_EXTRA_CA_CERTS`
2. T→A inference for local use (passthrough; `/v1/messages` not intercepted)
3. W→V `POST /api/heartbeat {host_id, session_ids:[], ts}` → host online, 0 sessions

**3. Work locally, RC OFF**
1. user↔T locally; T→A inference; transcript persists on disk
2. V sees only heartbeats `{host_id, ts}` — no content, no session

**4. Enable `/remote-control` mid-session** *(verified C1+C2)*
1. user types `/remote-control` in T
2. T→W `POST /v1/code/sessions {title, config{cwd,model}}` *(MITM-intercepted)* → W `200 {session{id:sid}}`
3. T→W `POST …/{sid}/bridge` → W `200 {worker_jwt, api_base_url}`
4. T→W `GET …/{sid}/worker/events/stream` (SSE); W→T `control_request{initialize}`
5. T→W `POST …/worker/events [{user historical}, {assistant historical}, …]` *(backfill of prior chat)*
6. W: log+encrypt each; W→V `POST /api/sessions {host_id, sid, enc(title), enc(cwd), status:active}`; `POST /api/heartbeat {session_ids:[sid]}` → session online

**5. Launch with RC ON** (`serve --remote-control`) — as #4 steps 2–4 (register→bridge→stream→initialize), **no backfill** (empty history).

**6. Client first connection**
1. user pastes `rc1_…`; C derives `host_id, auth_token, content_root`
2. C→V `GET /api/hosts` → `[{host_id, enc(name), online}]`; C decrypts name, renders the space

**7. Client second connection, 5 wrappers**
1. C has 5 secrets (localStorage) → 5 `(host_id, auth_token)`
2. for each: C→V `GET /api/hosts` (that host's bearer) → its record + `online` (last_seen+TTL)
3. C renders **5 spaces**, each online/offline + last-activity

**8. List sessions in a host**
1. C→V `GET /api/sessions?host=host_id` → `[{sid, enc(title), enc(cwd), status, online}]`
2. C decrypts titles → gchat-style session list

**9. Open a session cold — full history sync**
1. C: encrypt `catch_up{since:0, msg_id, expiry}` (control_key) → C→V `POST /api/relay {dir:in, kind:control}`
2. V→W via hook; W decrypts `catch_up`
3. W replays its log from 0: for each frame W→V `POST /api/relay {dir:out, kind:user|assistant|result, historical:true, seq}`
4. V→C SSE out-stream → C decrypts + renders history, then tails live

**10. Reopen — delta sync**
1. C cached to `seq=N` → C→V `POST /api/relay catch_up{since:N}`
2. V→W hook → W replays log `seq>N` → out-stream → C
   *(or, if within the workflow buffer window: C→V `GET /api/stream?since=N` resumes from the buffer, W untouched)*

**11. Send from client → underlying claude** *(verified C3 — the core loop)*
1. C: encrypt `user{content}` → C→V `POST /api/relay {dir:in, kind:user, client_msg_id}`
2. V appends in-queue → `hook.resume(sid, frame)`
3. W: hook fires → **dedup by msg_id** → decrypt → **log** → allocate `seq`
4. W→T inject the user message on the worker SSE *(MITM downstream)*
5. W→V `POST /api/relay {dir:out, kind:accepted, client_msg_id, seq}` → V→C SSE → C clears "pending"
6. T→A `POST /v1/messages` *(inference, passthrough)*
7. T→W `POST …/worker/events [{assistant},{result}]`
8. W: log+encrypt → W→V `POST /api/relay {dir:out, kind:assistant, seq}` then `{result, seq}`
9. V→C SSE → C decrypts + renders

**12. Type in the local TUI → appears in client** *(verified C4)*
1. user↔T; T→A inference; T→W `POST …/worker/events [{user source:worker},{assistant},{result}]`
2. W log+encrypt → W→V `POST /api/relay {dir:out …}` → V→C SSE → all clients render

**13. Two clients, one session (fan-out)**
1. C₁,C₂ each: C→V `GET /api/stream?session=sid&since=seq` (two readers on the workflow out-stream)
2. any out frame → V fans to both; an `in` frame from either → V→W→T→ out-stream → both + T

**14. Add a host**
1. user pastes `rc2_…` → C derives `host_id₂` → C→V `GET /api/hosts` (bearer₂) → new space appears

**15. Rename host/session**
1. C: `enc(new_name)` under `K_host_meta` → C→V `POST /api/hosts {host_id, enc(name)}` (update)
2. other devices: `GET /api/hosts` → decrypt the new name *(default = hostname)*

**16. Tool permission (`can_use_tool`)**
1. T→W `POST …/worker/events [{control_request can_use_tool, request_id, tool_name, tool_input}]`
2. W→V→C out-stream → C shows Allow/Deny
3. C: `enc permission{request_id, behavior}` (control_key) → C→V `POST /api/relay {dir:in, kind:control}`
4. V→W hook → W→T `control_response{request_id, behavior}` on the worker SSE → T proceeds/denies

**17. Remote control verbs**
1. C: `enc {interrupt | set_mode | set_model | command}` (control_key) → C→V `POST /api/relay {dir:in, kind:control}`
2. V→W hook → W→T the matching RC control verb (interrupt / set_permission_mode / set_model / slash) → T acts

**18. Network blip mid-turn**
1. C's SSE drops → C→V `GET /api/stream?session=sid&since=lastSeq` → V resumes from the workflow buffer by `startIndex`
2. C dedups by `msg_id`, reorders by `seq` → no gap, no dup

**19. Wrapper/CLI restart (both stateless)** *(verified C5)*
1. both die → W relaunches **T** as `claude --continue` *(resume on-disk session)* through the MITM
2. user `/remote-control` → register→bridge→stream (as #4) → T→W backfill `POST …/worker/events [full historical transcript]`
3. W rebuilds the log from backfill; W→V re-`POST /api/sessions` + heartbeat → online
4. C reconnects → `catch_up` → W replays the rebuilt log → C re-renders *(state recovered from claude)*

**20. Host offline → back**
1. W/CLI exit → heartbeats stop
2. C→V `GET /api/hosts|sessions` → `online=false` (`now − last_seen > TTL`)
3. C→V `POST /api/relay {dir:in,…}` → V: no live hook → `202 queued` or `409 host-offline` → C shows "offline"
4. host returns: relaunch + `/remote-control` → heartbeat → online; C `catch_up` fills the gap

### 16.1 Primitives used (per scenario)

Compact map of the building blocks each scenario exercises. Vocabulary: `HKDF`
(derive) · `GCM` (AES-256-GCM seal/open) · `AAD` · `sha256` · `CSPRNG` ·
`checksum` · broker: `/api/hosts` `/api/sessions` `/api/relay` `/api/stream`(SSE)
`/api/heartbeat` `bearer` · workflow: `hook` `wf-stream`(durable resumable)
`online=last_seen+TTL` · host/MITM: `intercept`(/v1/code/sessions*)
`passthrough`(/v1/messages) `bridge`(worker_jwt) `worker-SSE` `/worker/events`
`initialize` `backfill`(historical) `log` `dedup`(msg_id) `seq-alloc`
`/remote-control`.

| # | Scenario | Primitives |
| --- | --- | --- |
| 1 | Fresh machine bootstrap | `CSPRNG(S)`, `HKDF`→{host_id,auth_token,content_root,control_key,K_*_meta}, `sha256`, `GCM(name)`, `checksum`, `/api/hosts`, `bearer` |
| 2 | Wrapper launches TUI, RC off | MITM `passthrough`, CA trust, `/api/heartbeat`, `online` |
| 3 | Work locally, RC off | `passthrough`, claude on-disk transcript (no /v1/code) |
| 4 | Enable `/remote-control` | `intercept`, `bridge`, `worker-SSE`, `initialize`, `backfill`, `log`, `GCM`, `/api/sessions` |
| 5 | Launch with RC on | `intercept`, `bridge`, `worker-SSE`, `initialize`, `log` |
| 6 | Client first connection | `HKDF`, `bearer`, `/api/hosts`, `GCM-open(name)`, `localStorage` |
| 7 | Discover instances across secrets | 5× `HKDF`, 5× `bearer`, `online=last_seen+TTL`, `GCM-open` |
| 8 | List sessions | `/api/sessions`, `GCM-open(title/cwd)`, `online` |
| 9 | Cold full history sync | `GCM(control_key)`, `hook`, `log-read`, `GCM(content)`, `/api/relay`, `wf-stream/SSE`, `seq` |
| 10 | Reopen — delta sync | `catch_up`, `log-read(>N)`, `IndexedDB` cache, `wf-stream` resume(`startIndex`) |
| 11 | Client → claude → back | `GCM(content)`, `hook`, `dedup(msg_id)`, `log`, `seq-alloc`, `intercept`-inject, `passthrough`, `accepted`, `wf-stream/SSE`, `AAD` |
| 12 | Type in TUI → client | `worker-SSE`(upstream), `log`, `GCM`, `wf-stream/SSE` |
| 13 | Two clients (fan-out) | `wf-stream` multi-reader, `SSE`, `seq`/`dedup` |
| 14 | Add a host | `HKDF(S₂)`, `bearer₂`, `/api/hosts` |
| 15 | Rename host/session | `GCM(K_host_meta)`, `/api/hosts` update |
| 16 | Tool permission | `control_request/response`, `GCM(control_key)`, `hook`, `worker-SSE` |
| 17 | Remote control verbs | control frames (`control_key`), `hook`, RC verbs (`interrupt`/`set_permission_mode`/`set_model`) |
| 18 | Network blip resume | `wf-stream` resume(`startIndex`), `seq` reorder, `dedup` |
| 19 | Wrapper/CLI restart recovery | `--continue`, `/remote-control`, `intercept`, `backfill`, `log-rebuild`, `catch_up` |
| 20 | Host offline → back | heartbeat `TTL`, `online` flag, offline reject/queue, `catch_up` |
