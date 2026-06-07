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
- Paste one **per-host shared secret** → access that host's sessions + decrypt.
- **Multiple hosts** listed like chat "spaces"; add more by pasting more secrets;
  name each (default = hostname).
- **E2E encrypted** from the secret; **non-guessable** secrets; Vercel
  zero-knowledge.
- Stateless web client + stateless CLI relay; durable state concentrated in the
  Vercel workflow spine (+ a ciphertext store — see §6).

Non-goals (v1): forward secrecy, per-device revocation, group/sender-key crypto,
metadata privacy (timing/sizes/seq are visible to the broker).

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
  │      ▲  MITM (phase0 core/mitm)          │  wss/   │  per-session Workflow (durable) │  SSE/  │  paste secret →    │
  │      │                                   │  https  │  ciphertext store (Redis/SS)    │ stream │  derive keys →     │
  │ remote-claw serve --hostname <app> ──────┼────────▶│  live fan-out (SSE + workflow)   │◀──────▶│  decrypt & render  │
  │   (machine identity: secret S, 0600)     │ ciphertext only                          │        │  encrypt & send    │
  └──────────────────────────────────────────┘         └─────────────────────────────────┘        └────────────────────┘
        multiple such servers = multiple "spaces"
```

### 3.1 CLI — two commands (as requested)

1. **`remote-claw identity`** — create the **machine identity**, used by *all*
   sessions on the machine and for encryption.
   - Generates the per-host **root secret `S`** (32 bytes CSPRNG) once, stores it
     `0600` in the state dir, derives `host_id`/`auth_token`/`content_root` (§4).
   - Registers the host with the app (`POST /api/hosts` with `host_id`,
     `sha256(auth_token)`, and an **encrypted** friendly name defaulting to the
     hostname).
   - Prints the **pasteable secret** `rc1_…` once, for the web app and other
     devices. Re-running prints `host_id` + status (never reprints `S` unless
     `--show`).

2. **`remote-claw serve --hostname <vercel-app-url>`** — the **wrapper**: launches
   `claude --remote-control` with the Phase 0 MITM, and instead of a localhost UI,
   relays to the app.
   - Reuses Phase 0 `remote_claw/core.py` + `mitm.py` verbatim (Claude
     interception, session registration, the `/v1/code/sessions*` endpoints).
   - Replaces `client_api.py` with **`vercel_relay.py`**: on each worker→relay
     event, encrypt with the per-session key and `POST` ciphertext to the app;
     subscribe (SSE/stream) to the host's inbound channel, decrypt, and ingest into
     the worker via the existing downstream path (`Session.push_user_input` /
     `push_control_response`).
   - Maintains local state: a **durable per-session message log** (keyed by `seq`,
     the catch-up source), registered sessions, crypto state, last acked `seq`.
     Answers `catch_up` control frames from its log, falling back to worker RC
     replay for ranges it doesn't hold. Reconnects on drop.

### 3.2 Vercel app (the broker)
- **Ingest Functions** (Node runtime, fast + die): `POST /api/hosts`,
  `POST /api/sessions`, `POST /api/messages` (worker→ and web→), all
  bearer-authed by `auth_token`, all accepting **ciphertext only**.
- **Per-session Vercel Workflow** (the durable spine, §6): ingests each message
  via a `defineHook()`/`hook.resume()`, persists it (step → store), and emits it on
  the run's **durable resumable stream** for live delivery.
- **Read Functions**: `GET /api/hosts`, `GET /api/sessions?host=`,
  `GET /api/messages?session=&since=seq` (history), and a streaming `GET
  /api/stream?session=&since=seq` (live).

### 3.3 Web client (stateless, mobile-first)
- Paste secret (or open a link with the secret in the **URL fragment** `#…`, which
  browsers never send to the server). Derive keys in-browser (WebCrypto).
- **Spaces list** = the set of pasted secrets → one host each (names decrypted
  client-side). **Add host** = paste another secret. Secrets persist in
  `localStorage` (documented risk) or memory-only (re-paste).
- Per host → session list (gchat-style) → message view: load history
  (decrypt) + subscribe live (decrypt) + send (encrypt → POST).
- PWA, responsive; no server-side session state.

## 4. The secret & key hierarchy (token approach)

One **root secret `S`** per host is the only thing copied/pasted. Everything is
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
PRK          = HKDF-Extract(salt="remote-claw/v1", IKM=S)
host_id      = HKDF-Expand(PRK, "remote-claw/v1/host-id",  16B)  → PUBLIC routing id (the "space")
auth_token   = HKDF-Expand(PRK, "remote-claw/v1/auth",     32B)  → bearer to the Vercel API
content_root = HKDF-Expand(PRK, "remote-claw/v1/content",  32B)  → CLIENT-ONLY master content key
```
- The server is **given** `host_id` + `auth_token`, never `S`/`PRK`/`content_root`.
  It stores **`sha256(auth_token)`** (so a DB leak isn't replayable). Recovering
  `content_root` from the siblings requires inverting HMAC-SHA256 (preimage
  resistance) — infeasible. **That is the zero-knowledge guarantee.**

### 4.3 Session → message key flow (answers "do we need a session→key flow?")
Yes — a 3-level hierarchy:
```
content_root
   └─ K_session = HKDF-Expand(content_root, "session:" + session_id, 32B)
         └─ per message:  salt = random 32B
                          K_msg = HKDF-Expand(K_session, "msg:" + salt, 32B)
                          ct = AES-256-GCM(K_msg, nonce=random 12B,
                                           AAD = host_id|session_id|dir|seq|type)
```
**Why per-message subkeys instead of a global counter nonce:** the web client is
*stateless* and the secret can be pasted into *several devices/tabs at once* →
multiple concurrent senders share a key. A monotonic-counter nonce (the other
candidate) would collide across those senders and AES-GCM nonce reuse is
catastrophic. Deriving a fresh `K_msg` from a random 256-bit salt makes a
collision require the same salt **and** nonce (~2⁻³⁵²) — safe for unlimited
concurrent stateless senders, with **zero per-sender state**, all in WebCrypto
(no libsodium/WASM). `seq` is carried in cleartext metadata + bound into AAD for
ordering/replay; it is **not** the nonce, so ordering is decoupled from crypto
safety. (Alternative if we ever want misuse-resistance without per-message HKDF:
XChaCha20-Poly1305 192-bit random nonces via libsodium — heavier; not needed.)

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

This mirrors how official RC already works (the worker backfills its transcript on
connect — verified: `replaysOnReconnect` / `backfill` / `catch-up` / `replayLog` /
`historical:true` in the binary) and concentrates every "smart" on the TUI host.

- **State lives in the wrapper (primary), worker transcript is the fallback.**
  The `serve` wrapper sits in the MITM and sees every frame both directions, so it
  keeps its **own durable per-session log** (on the TUI host, keyed by `seq`) — the
  fast catch-up source. The worker's local transcript (`~/.claude/projects/<cwd>/
  <session>.jsonl`) is the ultimate source of truth for deep history / cold start.
  The TUI owns sessions, `seq` ordering, history, and replay; **the cloud stores no
  history.**
- **Catch-up is message-passing to the wrapper, on demand.** A connecting client
  sends a `catch_up{since=<last-seen seq | 0>}` control frame; the cloud relays it
  to the wrapper, which:
  1. serves the delta from its own per-session log (the normal path), or
  2. if the range predates its log (fresh/restarted wrapper, trimmed log), asks the
     **Claude worker to replay** via the RC backfill mechanism (`replayLog` /
     `historical:true` events), ingests those, and relays them.
  Frames stream back as `historical`, then live tailing resumes. No cloud history.
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

## 7. Multi-host "spaces" & onboarding
- Each pasted secret = one host = one space. The web stores the set of secrets
  (client-side) and renders spaces with decrypted friendly names (default
  hostname, editable; name stored **encrypted** in the host registry).
- **Add a host:** paste another `rc1_…`; the checksum validates it, keys derive,
  `GET /api/sessions?host=host_id` lists that host's sessions.
- Within a space: sessions listed gchat-style (encrypted title + last-activity),
  grouped by repo/cwd. Session metadata (id, timestamps) is unavoidably visible to
  the broker — minimized and documented.

## 8. Data model / API (sketch)
- `host`     : `{ host_id, sha256(auth_token), enc(name), created_at, last_seen }`
- `session`  : `{ host_id, session_id, enc(title), enc(cwd), status, last_activity }`
- `message`  : `{ host_id, session_id, dir, seq, msg_id, salt, nonce, ct, ts }`
- Endpoints (all bearer `auth_token`, all ciphertext): `POST /api/hosts`,
  `GET /api/hosts`, `POST /api/sessions`, `GET /api/sessions`,
  `POST /api/messages`, `GET /api/messages?since=`, `GET /api/stream?since=`.

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
- **P1 — Crypto core.** `packages/clawsec` (TypeScript): secret gen/parse/checksum,
  HKDF hierarchy, AES-256-GCM encrypt/decrypt, AAD, envelope format. Vitest unit
  tests (incl. round-trip + tamper/AAD-rejection). No network. Runs in Node +
  browser unchanged.
- **P2 — CLI: `identity`.** `packages/cli` in Node/TS: generate/store `S`, derive
  ids, print `rc1_…`, register host. Local only (mock app).
- **P3 — Vercel app skeleton.** `apps/web` (Next.js): ingest/read API routes + auth
  (`sha256(auth_token)`), per-session workflow with hook + durable stream, SSE
  endpoint. Deploy; curl round-trip with hand-rolled ciphertext.
- **P4 — CLI: `serve` relay.** Node/TS reimplementation of the Phase 0 MITM +
  relay: terminate TLS with our leaf (worker trusts it via `NODE_EXTRA_CA_CERTS`),
  intercept `/v1/code/sessions*`, pass `/v1/messages` through; encrypt worker
  events → POST to the app; subscribe inbound (SSE) → decrypt → ingest; maintain
  the per-session catch-up log. End-to-end: a curl "web" drives a real Claude
  session through Vercel.
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
