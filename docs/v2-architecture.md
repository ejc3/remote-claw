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
- **`remote-claw` is a transparent wrapper around `claude`** — invoke it exactly
  like `claude` (all flags/args pass through); a reserved `--rc-*` namespace is the
  only thing it consumes. No separate `serve`/`identity` commands.
- Mobile-friendly web app (Vercel) to chat with your sessions.
- Paste one **secret** → access **every claude instance under that secret** and
  decrypt it.
- **Each claude instance is its own space / chat** (gchat-style). Instances are
  grouped by the **secret** they run under.
- **E2E encrypted** from the secret; **non-guessable** secrets; Vercel
  zero-knowledge. A separate **app access token** (Vercel secret) keeps anonymous
  randos off the API entirely (admission, not confidentiality — §4.5).
- Stateless web client **and** stateless wrapper; **claude's on-disk session is the
  durable record**; the cloud is a stateless ciphertext relay (see §6).

> **Terminology (the core abstraction = the SECRET = a USER IDENTITY).** A *secret*
> derives a **user identity** — `identity_id` / `auth_token` / content keys — that
> **binds *all* of that user's sessions across *all* of their hosts** and is the one
> thing you **share across machines**. The identity is the boundary, **not** the
> machine: one secret can run on many hosts, and (by overriding `remote-claw
> --rc-secret …`) one machine can carry several identities. A *host/wrapper* is just
> a machine running `remote-claw` under an identity (it has an ephemeral
> `wrapper_instance_id`; several can run under one identity). A *claude instance* = a
> *session* = a *space* = **one chat** (a single running `claude` with remote control
> enabled), and it belongs to the **identity**, not the host. The hierarchy is
> **identity → its spaces (chats)** (a space *is* one chat, not a folder of
> sessions); the web lists every space under each pasted secret. So `identity_id` is
> the public id of the **user identity** spanning all their hosts — **not** a
> hardware/host id.

Non-goals (v1): forward secrecy, per-device revocation, group/sender-key crypto,
metadata privacy (timing/sizes/seq are visible to the broker).

## 1A. User experience & ergonomics (the flow we're building)

The whole design serves this human flow. Two roles (often the same person): the
**operator** runs claude on a machine; the **driver** chats from a phone/laptop.

### A. Operator — on the machine
1. **Use `remote-claw` exactly like `claude`.** It's a **transparent wrapper**:
   every `claude` flag, arg, env var and positional prompt **passes straight
   through** (`remote-claw --continue`, `remote-claw --model opus`, `remote-claw -p
   "…"`, `remote-claw .` …). You get the **exact normal claude TUI** — same
   behavior, same options. The wrapper consumes only a small reserved **`--rc-*`**
   namespace (§3.1) and forwards the rest. There is **no separate `serve`
   command** — `remote-claw` *is* claude, plus remote-control.
2. **Get your secret (one-time):** run `remote-claw --rc-identity` → it ensures the
   default identity exists (created locally on first use — a plain `remote-claw` run
   also auto-creates it **silently**, so if you've already launched once, this is a
   quiet status re-run) and prints the `rc1_…` secret to copy. Paste it into the web
   app, or — for a phone — `--rc-web` also prints a **QR / `#fragment` deep link**
   (treat the QR like the raw secret; it's not screen-share-safe). Lost the printout?
   `remote-claw --rc-show-secret` re-reveals it. More identities: `--rc-id NAME
   --rc-identity`; pick one per run with `--rc-secret`/`--rc-id`.
3. **Share a session:** in any `remote-claw` TUI, hit `/remote-control` → it flips
   to "Remote Control active," and **that instance becomes a chat in the web app**.
   (Or launch already-shared with `--rc-share`.)
4. Run **as many instances as you like** — one per repo/branch/task; each is its
   own chat. Close the TUI → that chat goes offline.

*Ergonomic promises:* **zero change to the local workflow** (full claude
passthrough); **opt-in per session** — running `remote-claw` like claude sends
**nothing** to the broker (not even presence) until you `/remote-control`; the MITM
setup is **automatic and invisible**; nothing leaves the box unencrypted.

### B. Driver — on phone/laptop (the web app)
1. **First time:** open the app, paste the `rc1_…` (or open a link with the secret
   in the URL `#fragment`). Keys derive **in the browser**; the secret never hits
   the server.
2. You land on a **list of chats** — every claude instance under that secret,
   most-active first, each with a name + an online dot. Reads like Slack/iMessage.
   (A freshly-pasted identity with nothing shared yet shows up empty — chats appear
   as you `/remote-control` sessions on the host.)
3. **Tap one** → history decrypts locally and live messages stream in. **Type** →
   your message shows in the chat *and* in the real terminal; claude works and the
   reply streams back to your phone.
4. **Add another identity:** paste its secret → its chats join the list (grouped by
   identity). One identity is usually one machine, but it's the *secret* that
   groups, not the hardware.

*Ergonomic promises:* mobile-first, instant, **no login** beyond the pasted secret;
feels like a messaging app; spans many machines.

### C. Naming & organization
- Each chat's default name is meaningful — the wrapper reads the inner session's
  **repo + branch / cwd** and the **title claude already generates** from the first
  prompt, and publishes them as an encrypted `session_register` (under
  `K_session_meta`). Editable from the web (a rename re-publishes the encrypted
  title); stored **encrypted** end-to-end.
- Identities are named too (default = hostname, under `K_identity_meta`); chats group
  under them. One identity = one user, spanning all their hosts; it's the secret that
  groups (not the machine).
- **Online = connected:** a chat shows in the list because its wrapper answered
  "identify" on the identity bus (§6B). Offline wrappers simply don't appear (no greyed
  rows in v1 — that needs the optional store, §6C).

### D. Reconnect / offline (what it feels like)
- Phone drops Wi-Fi mid-reply → on reconnect it **silently catches up**; you never
  lose the thread.
- Host sleeps / you close the TUI → the chat shows **offline**; sending is **rejected
  with "host offline"** (no server-side queue in v1 — §6/§16).
- Bring the host back (`remote-claw --continue` → `/remote-control`) → the chat
  goes live and **history is intact** (it lives with claude, not the cloud).

### E. Security ergonomics (honest with the user)
- The pasted secret is powerful (read + write + decrypt every chat under it) —
  treat it like a password. The app offers **"forget identity"** — wipes the secret
  from `localStorage` **and** the decrypted-message cache (IndexedDB) for that
  identity, leaving no plaintext on the device.
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
  It routes and persists **ciphertext + routing metadata only** (`identity_id`,
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
  = new secret = new identity (a fresh, empty set of spaces) (§4.4).
- **Admission vs. confidentiality (two independent gates).** Confidentiality is the
  zero-knowledge property above (content keys; broker never reads bodies).
  *Admission* — keeping anonymous randos off the API entirely — is a separate gate:
  an **app access token `T_app`** (a Vercel secret, §4.5) required on every request,
  layered before the per-identity `auth_token`. `T_app` adds no confidentiality; it
  shrinks the attack/abuse surface (strong for wrappers, soft for the public web
  bundle — §4.5). Future: mTLS client identities for per-client, revocable admission.

## 3. Components

```
  ┌── server A (your machine) ──────────────┐         ┌──────── Vercel (broker) ────────┐        ┌── phone / laptop ──┐
  │ claude --remote-control                  │         │  ingest Functions (auth: token) │        │  web app (Next.js) │
  │      ▲  MITM (our relay = RC backend)    │  wss/   │  per-session Workflow (buffer)  │  SSE/  │  paste secret →    │
  │      │  + in-memory log (claude=record) │  https  │  (no history — relay only)      │ stream │  derive keys →     │
  │ remote-claw [claude args] --rc-app <app> ┼────────▶│  live fan-out (SSE + workflow)   │◀──────▶│  decrypt & render  │
  │   (identity: secret S, 0600; 1/machine)  │ ciphertext only                          │        │  encrypt & send    │
  └──────────────────────────────────────────┘         └─────────────────────────────────┘        └────────────────────┘
    one secret = one identity (identity_id/auth); each claude instance under it = one "space"/chat
    (default one identity per machine; override per run with --rc-secret / --rc-id)
```

### 3.1 CLI — one transparent wrapper around `claude`

There is **no `serve`/`identity` subcommand split.** `remote-claw` is a **drop-in
wrapper**: you invoke it **exactly like `claude`** and **every argument, flag, env
var and positional prompt passes straight through** to the inner real `claude`.
The wrapper consumes only a reserved **`--rc-*`** namespace for itself and forwards
everything else verbatim; `--` forces all following args to passthrough. (`claude`
has no `--rc*` flags today; the prefix is our reserved convention.)

```
remote-claw [ANY claude args/flags/prompt] [--rc-* wrapper flags]
# e.g.  remote-claw --continue --model opus      (== claude --continue --model opus, + RC capability)
#       remote-claw -p "summarize this repo"      (passthrough headless prompt)
#       remote-claw --rc-identity                 (identity work; does NOT launch claude)
```

**Wrapper-only flags (`--rc-*`).** (Design settled via a 3-lens panel + adversarial
security review — §14A.)

- **`--rc-identity`** — *the identity command: local, idempotent, create-once,
  **never destructive**.* Ensures the selected identity's **root secret `S`** exists,
  shows you how to use it, and **exits without launching claude** (spawns no TUI,
  arms no MITM, **zero network I/O** — host registration stays lazy; works
  air-gapped). With no selector it operates on the default slot (literally `default`);
  `--rc-id NAME` targets/creates a named sibling.
  - *Slot absent →* generate `S` (32 B CSPRNG), derive `identity_id`/`auth_token`/
    `content_root`/`control_key`/`K_*_meta` (§4.2), write `S` `0600` with
    `O_CREAT|O_EXCL` (atomic; never clobbers a concurrent create) under a per-slot
    state dir (`$XDG_STATE_HOME/remote-claw/identities/<name>/`, with a `0600`
    metadata sidecar for `created_at`/display-name). Print a summary (name, **public**
    `identity_id`, created-at, path) and **the `rc1_…` on its own bare line** (the
    onboarding step). If a **web** URL is configured (`--rc-web`), also print the
    `https://<web>/#<secret>` deep link + a terminal **QR** of it for phone
    onboarding. ⚠️ The QR/deep-link **encode the secret verbatim** — treat them like
    the raw token (shoulder-surf/recording risk); a QR is **not** "safe to
    screen-share." Exit 0.
  - *Slot exists (idempotent re-run) →* **never** regenerates/overwrites `S`; prints
    status only (no secret/QR), ending with "re-show with `--rc-show-secret`."
    Re-running can never lose an identity or its chats — the core anti-footgun.
  - The secret prints **once**, at creation; thereafter only via `--rc-show-secret`.
    Rotation is **not** here — it's the separate, destructive `--rc-rotate`.
  - **Arg rule:** allowed only alongside identity-relevant `--rc-*` flags; **errors**
    if any non-`--rc-*` token (a positional, or anything after `--`) is present, since
    it doesn't launch claude. `--rc-secret` + `--rc-identity` is a usage error.
- **`--rc-id NAME`** — the **single** identity selector, reused everywhere
  (create / `--rc-show-secret` / `--rc-rotate` / run-time launch). Absent ⇒ `default`.
  On a **normal (claude-launching) run**, only the `default` slot auto-creates
  silently; an **unknown** named slot **errors** ("create it with `remote-claw --rc-id
  NAME --rc-identity`") — so a typo'd `--rc-id` can't silently mint a phantom identity.
- **`--rc-secret rc1_…`** — run this instance under an **externally-held** secret
  (override the boundary per run); not a creation input to `--rc-identity`.
- **`--rc-show-secret`** — the **only** post-creation reveal of `S` (+ deep link/QR),
  for re-onboarding a device. On a TTY: a shoulder-surf/scrollback warning (STDERR) +
  Enter pause (skip with `--rc-yes`); non-TTY: bare token to STDOUT, warning to STDERR.
  Never regenerates.
- **`--rc-rotate`** — *the only destructive path:* new `S` ⇒ **new identity**; the old
  identity and **all** its spaces die (§4.4). Bare `--rc-rotate` is a **dry-run
  preview** naming exactly what dies; execution requires `--rc-confirm <identity_id>`
  (a typo/accident guard — `identity_id` is public, **not** an authz control, so rotate
  also requires a TTY unless `--rc-force-noninteractive`). **Securely deletes** the
  old secret by default (overwrite + unlink) — because the same `S` re-derives the
  *same* live keys, a retained copy is a full credential, not "keys to dead data";
  keep a `0600` backup only with explicit `--rc-keep-old` (flagged as still-live).
- **`--rc-web <url>`** — the **web-app** origin used to build the `#fragment` deep
  link/QR (else `REMOTE_CLAW_WEB`). Distinct from `--rc-app` (the broker/API URL); read
  as an opaque local string (no probe). Unset ⇒ QR/deep-link of the bare token, or omit.
- **`--rc-app <url>`** — the Vercel broker URL (else `REMOTE_CLAW_APP` env / config).
- **`--rc-app-key <T_app>`** — the **app access token** (§4.5) sent as `X-RC-App-Key`
  on every broker call (else `REMOTE_CLAW_APP_KEY` env). Required to reach the app.
- **`--rc-share`** — launch **already remote-controlled** (auto-enable RC at startup;
  equivalent to typing `/remote-control` immediately).
- **`--rc-name "label"`** — broker-published friendly name (default = hostname; named
  siblings default to `hostname (NAME)` so multiple identities on one host are
  distinguishable). Published encrypted under `K_identity_meta` only at first RC.
- **`--rc-list`** — list local slots (name, `identity_id`, created-at); **no** secrets.
- **`--rc-json` / `--rc-quiet`** — machine-readable / minimal output. **Never emit the
  raw secret** in either (a script that truly needs it reads the `0600` file directly)
  — JSON/quiet output is exactly what leaks into CI logs. `--rc-json` takes precedence
  over the bare-token form.

**What the wrapper does** (otherwise it's just claude):
- Runs the **real interactive `claude` TUI** with all your passthrough args. The
  **identity is auto-created on first run** if absent (local only — no network).
- **Nothing is sent to the broker until you enable remote control.** Running
  `remote-claw` like `claude` registers nothing and sends no heartbeat.
- When you hit `/remote-control` (or pass `--rc-share`), it makes the inner claude
  RC-eligible **pointed at our local MITM** (not Anthropic's RC relay — §14) by
  **automatically** setting `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` for the child
  process. Our relay is the RC backend; it bridges that traffic E2E-encrypted to the
  app **under the chosen secret**.
- Relay logic (Node/TS, reimplementing the Phase-0 interception knowledge): on each
  worker→relay event, log it, allocate `seq`, encrypt with the per-session key, and
  `POST /api/relay`; subscribe (SSE) to its inbound channel, **dedup by `msg_id`**,
  decrypt, and deliver to Claude **after log commit**, then echo `accepted`.
- **Joins the identity bus** (§6B): on first `/remote-control` it resume-or-starts the
  per-identity bus run (`bus:${identity_id}`) and **tails** it, so it hears `identify?`
  and answers `session_announce{…}` for each of its sessions — that *is* presence
  (connected = listed). It exposes each session's per-session stream
  (`sess:${identity_id}:${session_id}`) for live frames. No heartbeat/registry store.
- Maintains **in-memory** relay state (catch-up log, `msg_id` seen-set, sessions, crypto
  state) — **recoverable from the claude session** by re-enabling `/remote-control` (the
  worker re-backfills), so **no durable store is required**; both wrapper and CLI are
  stateless (claude's on-disk session is the durable layer). Answers encrypted
  `catch_up{since=seq}` from its log, falling back to worker backfill (§6).
- The wrapper does **not** outlive the CLI; on exit it leaves the bus → it stops
  answering `identify?` → its sessions simply **don't appear** in new listings (online =
  answered).

### 3.2 Vercel app (the broker — a ciphertext relay; **no store**)
The broker collapses to **two** ciphertext endpoints over Vercel Workflows; there is
**no registry store, no heartbeat, no read/list functions** — discovery + presence are
answered live on the per-identity **bus** (§6B).
- **Front-door gate (`T_app`, §4.5):** edge middleware rejects **any** `/api/*`
  request lacking the app access token (`X-RC-App-Key`) with `401` before any
  per-identity logic — so randos can't reach the API to push frames or scrape state.
  `T_app` is a **Vercel secret** (env var on the deployment).
- **`POST /api/relay`** (Node, fast + die) — publish one ciphertext frame by
  **value-addressed** `resumeHook(token, frame)`: the per-identity bus token
  `bus:${identity_id}` (discovery/control/announce) or a per-session token
  `sess:${identity_id}:${session_id}` (a prompt/control to one session). Gated by
  `T_app` **and** `auth_token`; **ciphertext only**.
- **`GET /api/stream?identity=… | session=…`** — subscribe: the Function resolves the
  derived token via **`getHookByToken(token).runId` → `getRun(runId).getReadable()`**
  and pipes the durable stream back as SSE (resume by `startIndex`). `HookNotFound` ⇒
  nothing connected ⇒ `200` empty (offline). This is the **only** read path; it leaks
  no existence (absent/mismatch return the same empty).
- **Nothing exists until RC is enabled** (lazy): a wrapper joins the bus only on first
  `/remote-control`. A machine running `remote-claw` (as claude) with RC off is
  invisible — no bus membership, no traffic.
- **Discovery + presence are live, not stored:** a client publishes `identify?` to the
  bus; **connected** wrappers answer with their sessions (= the list; answered = online)
  — §6B. **Multiple wrappers under one identity** coexist because the bus is a single
  relay run that *owns* the hook; wrappers are publishers + stream-readers, not
  hook-owners (so no token collision).
- **Catch-up is wrapper-served, never the cloud.** A `catch_up{since=seq}` control frame
  rides the bus/session channel to the wrapper, which replays from its in-memory log
  (then worker backfill). No `GET /api/messages` history store.

### 3.3 Web client (stateless, mobile-first)
- Paste secret (or open a link with the secret in the **URL fragment** `#…`, which
  browsers never send to the server). Derive keys in-browser (WebCrypto).
- **Spaces** = **every claude instance under every pasted secret**, grouped by
  **identity** (one pasted secret = one identity, unlocking all its instances).
  **Add an identity** = paste another secret. A just-pasted identity with nothing
  shared shows empty until a session is `/remote-control`-ed. Secrets persist in
  `localStorage` (documented risk) or memory-only (re-paste).
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
identity_id       = HKDF-Expand(PRK, "remote-claw/v1/identity-id",       16B)  → PUBLIC routing/identity id (groups this secret's spaces; NOT itself a space)
auth_token    = HKDF-Expand(PRK, "remote-claw/v1/auth",          32B)  → bearer to the Vercel API
content_root  = HKDF-Expand(PRK, "remote-claw/v1/content",       32B)  → CLIENT-ONLY master content key
control_key   = HKDF-Expand(PRK, "remote-claw/v1/control",       32B)  → AEAD key for control frames (catch_up, permission)
K_identity_meta   = HKDF-Expand(PRK, "remote-claw/v1/meta/identity",     32B)  → encrypts host friendly name
K_session_meta= HKDF-Expand(PRK, "remote-claw/v1/meta/session",  32B)  → encrypts session title/cwd
```
- **Confidentiality (zero-knowledge) is scoped to `content_root`/`control_key`/
  meta-keys.** The server is given `identity_id` + `auth_token` only, never `S`/`PRK`/
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
   canonical_AAD = canonical-encode(v, identity_id, session_id, dir, record_kind, seq, msg_id, key_epoch)
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

**Which key encrypts what (content vs control).** Anything that is part of the
transcript is a **content** frame under `K_session` — **including an inbound `user`
prompt** (`dir:in`). A `user` frame is content in *both* directions: the web→wrapper
prompt and the worker→web echo. Only the **control plane** uses `control_key`:
`catch_up`, `permission`, `interrupt`, `set_mode`, `set_model`, `command`, `end`
(§6A). The broker can forge neither (no `K_session`/`control_key`); `dir` is bound
into AAD, so an `in` prompt and its `out` echo derive different `K_msg` and can't be
confused. Inbound frames of **either** key carry `msg_id` (+ `client_msg_id` for a
`user` prompt) and are replay-checked.

### 4.4 Rotation / revocation
Rotation = generate a **new `S`** ⇒ new `identity_id` ⇒ a **new identity** (a fresh,
empty set of spaces); the old identity and **all** its spaces are dead. The CLI verb
is **`--rc-rotate`** (§3.1) — guarded (dry-run preview + `--rc-confirm <identity_id>` +
TTY) and it **securely deletes** the old `S` by default: because the same `S`
deterministically re-derives the *same* keys, a retained copy is a **full live
credential** (it can still decrypt/forge any ciphertext that survives — buffered
frames, the web IndexedDB cache), so keeping it would defeat a leak-driven rotation.
No per-device revocation without rotating (single-secret tradeoff). `info` labels
carry `/v1/` for future migration. Optional v2: split `S` into a
server-registered half + a paste half so a leaked paste can be revoked without
losing stored ciphertext (adds onboarding friction).

### 4.5 App access token (`T_app`) — the front-door gate
A second token, **independent of any user secret**, gates the API as a whole so
**anonymous internet randos can't POST frames or pull (encrypted) state** at all.

- **What it is:** one high-entropy `T_app`, generated once and stored as a **Vercel
  secret / environment variable** on the deployment (not derived from `S`, the same
  for every identity). Every `/api/*` request must carry it (header
  `X-RC-App-Key: T_app`) or be rejected **`401` at the edge/middleware, before** any
  per-identity `auth_token` or storage logic runs.
- **Two layers, two jobs:** `T_app` = *coarse, app-wide admission* (is the caller
  even allowed to talk to this deployment); `auth_token` = *per-identity
  authorization* (may this caller touch **this** host). Both are required.
- **Confidentiality unchanged:** `T_app` adds **no** confidentiality — zero-knowledge
  still rests entirely on the content/meta keys (§4.2). It's an abuse / cost /
  attack-surface gate, not crypto. The broker still sees only ciphertext.
- **How each side gets it:**
  - **Wrapper (the server):** the operator supplies `T_app` out-of-band
    (`REMOTE_CLAW_APP_KEY` env / `--rc-app-key`). This is a **strong** gate — a
    wrapper without it can't reach the app, so randos can't register hosts, push
    frames, or scrape state.
  - **Browser:** the web app injects `T_app` from its **server-side** env into the
    page it serves (or its same-origin route handlers attach it). Be honest: because
    the web bundle is public, `T_app` there is a **soft** gate — it blocks blind API
    scanning, bots, and drive-by abuse, but a determined human who loads the page can
    extract it. The per-identity `auth_token` (which the browser only obtains by
    holding a valid pasted secret) remains the real authz; pasting nothing ⇒ no
    `auth_token` ⇒ nothing readable. Optional hardening: put the **web app itself**
    behind Vercel password/SSO, or mint short-lived per-load tokens.
- **Rotation:** rotate `T_app` by updating the Vercel secret + redeploying and
  redistributing it to wrappers; it's orthogonal to per-identity secret rotation
  (§4.4) and revokes *all* current API access at once.
- **Future (stronger admission): mTLS client identities.** Replace/augment the
  shared `T_app` with **mutual-TLS client certificates** so each wrapper (and,
  later, device) authenticates with its own cert — per-client, individually
  revocable admission instead of one shared bearer. Deferred (cert provisioning +
  Vercel mTLS support add friction); `T_app` is the v1 gate.

## 5. Message flow (both directions, ciphertext only)

The broker keeps **no message bodies** — every frame goes through `POST /api/relay`
(bearer `auth_token`, ciphertext only) and is fanned out over the per-session
**Workflow durable resumable stream**, an in-flight buffer (not the record — §6).

**Worker → web** (assistant output): worker emits event → the wrapper's relay
**logs it (in-memory), allocates `seq`, encrypts** (`K_session`, fresh `K_msg`) →
`POST /api/relay {identity_id, session_id, dir:"out", record_kind, seq, salt, nonce,
ct}` → ingest Fn appends to the session workflow's **out-stream** → web clients
tailing the stream decrypt & render.

**Web → worker** (your prompt): web encrypts a `user` content frame (`dir:"in"`,
`client_msg_id`, under `K_session`) → `POST /api/relay` → the workflow **hook**
wakes the wrapper → wrapper **dedups by `msg_id`**, decrypts, **commits to its log +
assigns `seq`**, injects into Claude via the Phase-0 downstream, and emits
`accepted{client_msg_id, seq}` on the out-stream. Claude replies → the worker→web
path above.

**History is wrapper-served, never read from the cloud.** A client gets backlog by
sending an encrypted `catch_up{since=seq}` control frame (§6), **not** from any
`/api/messages` store (there is none). For live tailing: read by `seq`, dedupe by
`msg_id`, order by `seq` (broker delivery is at-least-once, not FIFO — §6).

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
  in-memory.** The wrapper sees every frame both directions and keeps an
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
  valid old ciphertext*, so the wrapper keeps an **in-memory seen-set keyed by
  `msg_id`** (rebuilt on reconnect with the log) and drops duplicate inbound/control
  frames **before** any side effect.
- **Catch-up is an encrypted control frame to the wrapper.** A client sends an
  **AEAD-encrypted** `catch_up{since=<last-seen seq | 0>, msg_id, expiry}` (control
  frames use a derived control key + replay check — never plaintext the broker
  could inject); the wrapper serves the delta from its log (then worker-backfill
  for ranges older than the log), streaming `historical` frames, then live.
- **The cloud = relay + short live buffer only — no durable store** (§6B). Discovery
  and presence are answered live on the per-identity **bus**, not a store; message
  transport is relay-only. Live ciphertext frames go out over **SSE from a streaming
  Vercel Function**, backed by the **Workflow durable resumable stream**. When the SSE
  connection hits Vercel's duration cap (or drops), the client simply **reconnects and
  resumes by `seq`** — any gap is refilled by the wrapper's `catch_up` (the wrapper is
  the history source, so we need no provider-side message history). Stream retention
  (1–7 d) is irrelevant — it's an in-flight buffer, not the record.
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
`dir`: **out** = wrapper→web, **in** = web→wrapper. Two AEAD keys: **content** frames
use `K_session` (transcript); **control** frames use `control_key` (control plane).

Content frames (transcript; encrypted under **`K_session`**; carry `seq`). A `user`
frame is content in **both** directions — `in` = the typed prompt (carries
`client_msg_id`), `out` = the worker's echo:
| kind | dir | source | notes |
| --- | --- | --- | --- |
| `user` | in / out | client (prompt) / RC (echo) | typed prompt carries `client_msg_id`; echo gets `historical:true` on backfill |
| `assistant` | out | RC | model output (+ partial deltas if we enable them) |
| `result` | out | RC | turn complete (cost / usage) |
| `system` / `status` / `rate_limit` | out | RC | lifecycle (init, "requesting", limits) |
| `can_use_tool` | out | RC | permission request, *if* a mode ever gates a tool |

Control frames (**in** — web client → wrapper → worker; encrypted under
**`control_key`**, carry `msg_id` + `expiry`, replay-checked):
| kind | maps to RC verb | notes |
| --- | --- | --- |
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
| `session_announce` | out (bus) | a wrapper's reply to `identify`: encrypted `{session_id, enc(title), enc(cwd), status, last_activity, …}` — the discovery+presence answer (§6B) |

(`historical` is a **flag** on replayed content frames, not a separate kind. There is
**no** `heartbeat`/registry frame — presence is "answered `identify` on the bus".)

### Channels (two kinds, both addressed by a derived token — §6B)
- **identity bus** (`bus:${identity_id}`): one relay run per identity. Clients publish
  `identify`/control via `resumeHook`; wrappers tail it and answer `session_announce`;
  clients tail it via `getHookByToken→getReadable`. Discovery + presence + control.
- **per-session stream** (`sess:${identity_id}:${session_id}`): the session's durable
  resumable out-stream for live turn frames (high volume — bypasses the event cap) +
  an inbound hook for prompts/`catch_up`. Resolved the same way (token → run).
- No presence channel and no registry — both are subsumed by the bus.

### Ephemeral state a run holds — and why it's "enough"
A run (the bus, or a per-session run) holds ONLY: the **recent in-flight frame buffer**
(durable resumable stream, bounded window — older → `catch_up`); **resume cursors**; the
inbound **hook**; a small **`msg_id` dedup window**. It deliberately does **not** hold
the transcript, long-term history, or any plaintext. Workflow retention is irrelevant
because everything is reconstructible from the claude session via `catch_up`. The
**run** makes live delivery + short-window reconnection seamless; the **wrapper** makes
deep history correct; the **bus** makes discovery + presence live (no store).

### Lifecycle (the natural flow)
RC enabled → wrapper joins the identity **bus** (`bus:${identity_id}`) + opens its
per-session stream. Live turn → `assistant`/`result` flow the session out-stream,
`user` arrives via the session hook; clients tail; wrapper logs + echoes `accepted`.
Brief reconnect (web or wrapper) → resume by `seq`/`startIndex`. Gap older than the
buffer / cold device → `catch_up` → wrapper replays from its log (or worker backfill).
A client opening cold → publishes `identify?` on the bus → connected wrappers answer
`session_announce`. Session ends / wrapper exits (it never outlives the CLI) → it
leaves the bus → it no longer answers `identify?` → its sessions simply stop appearing;
nothing is lost because claude holds the transcript.

## 6B. The per-identity bus & fresh-browser cold start

The "registry" is **not a stored table** — it's a **per-identity message bus**. A
client posts *"identify yourselves"* to the identity's bus; every **connected** wrapper
(on any host under that secret) answers with its sessions; the client renders the
answers as the live list. **Connected = shown = presence.** The same bus carries live
updates and `catch_up`, so it doubles as state-sync. (Settled by a research→design→
verify panel against the SDK type defs — §13/§14A.)

### It's value-addressed — no stored pointer (verified)
The fear was that a Workflow stream is reachable only by its **random `runId`**, forcing
a stored `identity_id → runId` pointer. **It isn't, for the live case.** The SDK exposes
**`getHookByToken(token): Promise<Hook>`** (public, callable from an API route — exact
signature confirmed in `@workflow/core`/`@workflow/world` type defs, §13), and the
returned `Hook` **carries `runId`**. So a **deterministic token is a stable channel
name**, and the whole bridge is:

```
bus channel  =  "bus:" + identity_id                 # client-derivable; no lookup
  publish →   resumeHook("bus:"+identity_id, frame)  # wake/announce (value-addressed)
  subscribe → getHookByToken("bus:"+identity_id).runId
              → getRun(runId).getReadable({startIndex})   # the live stream
```

- **One bus run per identity.** It owns the hook token `bus:${identity_id}`; the token is
  **1:1** (`HookConflictError` blocks a second), which *enforces* a single bus per
  identity. First wrapper online wins the create; others "resume-or-start," then resolve.
- **Long-lived / idle-on-hook.** The bus run never *completes* (it awaits its hook), so
  the hook is never disposed and `getHookByToken` keeps resolving — `start()`'s random
  runId is irrelevant because the **token** is the durable address.
- **Browser path.** `getHookByToken` needs server-side World credentials, so the browser
  doesn't call it directly — it hits our **`GET /api/stream?identity=…`** Function, which
  resolves the token and pipes the run's stream back as SSE (gated by `T_app` + `auth_token`).

So the durable cloud "registry" is **nothing**: no rows, no presence keys, no pointer.
State lives on the bus (announced live) and with claude (transcript via `catch_up`).

### State layers — what persists where
| layer | lives in | durable? |
| --- | --- | --- |
| **transcript (the record)** | claude `.jsonl` + wrapper in-memory log | host-side |
| **the bus** (discovery + presence + control + `catch_up` relay) | **one Workflow run per identity**, addressed by token `bus:${identity_id}` | ephemeral (rolls; idle-persistent) |
| **per-session live frames** (high volume) | per-session Workflow out-stream | ephemeral |
| **functions** | — | **none** |

"**The server is stateless**" holds *maximally*: there is **no store at all** for the
registry — the bus is reached by a derived token, not a stored id.

### Cold-start sequence (paste secret → live list)
Computed live from the bus — **no store, no enumeration, lazy** (nothing exists until a
wrapper enables `/remote-control` and joins the bus):
1. **Derive (no network).** Checksum `rc1_…`; HKDF → `identity_id, auth_token,
   K_identity_meta, K_session_meta, …` (§4.2). Secret never leaves the device.
2. **Subscribe to the bus.** `GET /api/stream?identity=identity_id` (`X-RC-App-Key` gate;
   `Bearer auth_token`). The Function `getHookByToken("bus:"+identity_id)` → **HookNotFound
   ⇒ no bus ⇒ nothing connected ⇒ `200` empty (offline)**; else
   `getRun(runId).getReadable()` → SSE to the browser. (Absent/mismatch returns the same
   empty, so status never leaks whether an identity exists.)
3. **Ask.** Client publishes an encrypted `identify?` control frame → `POST /api/relay`
   → `resumeHook("bus:"+identity_id, frame)`.
4. **Wrappers answer.** Every connected wrapper (tailing the bus) replies
   `session_announce{enc(title), enc(cwd), session_id, wf_run_id, …}` → bus → SSE →
   client builds the list (decrypt titles, most-active first). The wrappers that answered
   are, by definition, online.
5. **Open a chat.** Tap a session → subscribe to **its per-session out-stream** (its
   `wf_run_id` arrived in the announce) + send `catch_up{since}` for history. High-volume
   turn frames flow there, **not** on the bus (so the bus rolls rarely).

### Honest caveats (verified — §13)
- **Online-only.** No connected wrapper ⇒ empty list (no greyed offline rows). This is
  the chosen simplification ("connected wrappers identify themselves"); offline listing
  is the one reason to add a store (§6C).
- **Two-call composition** (`getHookByToken`→`getRun`→`getReadable`) is real but shown
  in **no official example** — integration risk; verify in a P3 spike.
- **Run-roll handoff.** Inbound publishes are events (25k/run cap); the bus rolls
  occasionally. On roll the old run completes → its hook disposes → a new run re-creates
  `bus:${identity_id}`; a brief window may `HookNotFound` → client retries. Keeping
  high-volume frames on per-session streams (stream writes bypass the event cap) keeps
  rolls rare.
- **Size/chunking** (§8): a payload over a hook ≤ **4.5 MB**, a stream chunk ≤ **10 MB**
  → chunk larger announces / `catch_up`.
- **`getHookByToken` is server-creds + live-only** (hooks dispose at terminal state) —
  fine: the browser goes via our Function, the bus is long-lived, and history is
  `catch_up`, never a dead-run read.

### Optional durable fallback (belt-and-suspenders)
If the roll-handoff window ever bites, cache `identity_id → runId` on first resolution
(one tiny value) as a fallback — **not required** for the live bus. A *fuller* store is
only worth it for **offline listing / history browsing** — see §6C.

## 6C. Optional durable stores (only for offline listing / history)

The bus (§6B) is online-only and store-free. Add a small store **only** if you later
want **greyed-offline rows** (a chat stays listed while its host sleeps) or **offline
history browsing**; nothing below is needed for the core flow. Choices (researched
§13/§14A):

| store | first-party? | discovery | presence | note |
| --- | --- | --- | --- | --- |
| **Upstash Redis** | no (Marketplace) | `SMEMBERS` | native `SET … EX` self-evict | best fit; its **pub/sub** also gives a value-addressed bus without `getHookByToken`'s live-only caveat |
| **Vercel Blob** | ✅ | `list({prefix})` *is* the index | no TTL → derive from a self-terminating run's `getRun().status` | true first-party; `list()` is lexicographic (sort client-side); rows write-heavy via `last_activity` |
| **Neon (Postgres)** | no (Marketplace) | `WHERE identity_id` | `last_seen` column | simplest correct shape (ACID, `ORDER BY`); autosuspend cold-start tax |
| **Edge Config** | ✅ | — | — | **refuted**: ≤10 s write propagation, no TTL, tiny 8/64/512 KB total cap |

If offline listing matters, **Upstash Redis** is the cleanest add — and, notably, one
managed dependency would then buy **both** a fully value-addressed pub/sub bus **and**
native presence. Treat any store as a **P3 build-time spike** (verify Blob
read-after-write freshness; `getRun` status latency after self-termination).

## 7. Multi-identity "spaces" & onboarding
Hierarchy: **identity (identity_id) → its spaces (each space = one claude instance =
one chat).** A space is *not* a container of sessions — it **is** one session.
- Each pasted secret = one **identity**; **each claude instance under it = one
  space (chat)**. The web stores the set of secrets (client-side) and renders the
  identity's spaces with decrypted friendly names (default hostname for the
  identity, claude's generated title for each space; editable; stored **encrypted**).
- **Add an identity:** paste another `rc1_…`; the checksum validates it, keys derive,
  and the client subscribes to that identity's **bus** (`GET /api/stream?identity=…`) +
  `identify?` → connected wrappers answer with its spaces (§6B).
- Spaces are listed gchat-style (encrypted title + last-activity, online dot),
  grouped under their identity. Routing metadata (`identity_id`, `session_id`,
  timestamps, sizes) is unavoidably visible to the broker — minimized and documented.

## 8. Data model / API (sketch)
**No durable cloud store** in the core design — discovery, presence and session
metadata live on the per-identity **bus** (§6B), encrypted; the only persistent record
is claude's on-disk transcript (host-side). The session's encrypted name/title/cwd ride
in its `session_announce` frame on the bus, not a stored row. (A durable store is
*optional*, only for offline listing — §6C.)

Transient relay **frame** (rides the bus / a session stream — never a durable row):
```
{ v, identity_id, session_id, dir, record_kind, seq|null, msg_id, client_msg_id?,
  key_epoch, salt, nonce, ct }      // ct includes the GCM tag
AAD = canonical-encode(v, identity_id, session_id, dir, record_kind, seq, msg_id, key_epoch)
```
`record_kind` ∈ (aligned with §6A):
- **content** (AEAD under `K_session`): `user` · `assistant` · `result` · `system` ·
  `status` · `rate_limit` · `can_use_tool` — carry `seq`; `user` may be `dir:in`
  (prompt, with `client_msg_id`) or `dir:out` (echo, optional `historical:true`).
- **control** (AEAD under `control_key`, `dir:in`, `msg_id` + `expiry`,
  replay-checked): `identify` (the bus discovery request) · `catch_up` · `permission` ·
  `interrupt` · `set_mode` · `set_model` · `command` · `end`.
- **meta**: `accepted` (`dir:out`); `session_announce` (`dir:out` on the bus — a
  wrapper's reply to `identify`: `{session_id, enc(title), enc(cwd)<K_*_meta>, status,
  last_activity}` — encrypted, so the broker never reads names/titles).

AAD binds **every** cleartext header field via a single canonical serialization
(length-prefixed or CBOR) — no ad-hoc `a|b|c` concatenation (ambiguous).

Presence is **not stored**: a session is online iff its wrapper, connected to the bus,
answered the latest `identify` (§6B). No heartbeat, no `last_seen`; `last_activity`
(carried in `session_announce`) drives "most-active first" sorting.

Endpoints — **just two** (both gated by `X-RC-App-Key` §4.5 + `Bearer auth_token`,
ciphertext only): **`POST /api/relay`** (publish a frame via `resumeHook(token,…)` —
bus or per-session token) and **`GET /api/stream?identity=… | session=…`** (subscribe
via `getHookByToken→getRun→getReadable`, SSE; resume by `startIndex`). No
`/api/identity`, `/api/sessions`, `/api/heartbeat`, or `/api/messages` — discovery,
presence and history are all on the bus / wrapper-served (§6B).

## 9. Decisions (resolved 2026-06-07)
1. **Durable store / history → W′ (TUI is the brain). No cloud store at all.** The
   wrapper holds an **in-memory** per-session log on the TUI host (rebuilt from claude
   on reconnect) and serves catch-up via message-passing; claude's on-disk session
   (`.jsonl`) is the durable record and the Claude worker backfill is the deep-history
   source on RC connect. The cloud keeps only **ephemeral Workflow runs** (the
   per-identity bus + per-session live buffers — §6B); none holds the transcript or a
   registry. An optional durable store (Upstash/Blob/Neon) is **only** for offline
   listing / history browsing (§6C).
2. **Realtime transport → Vercel-native only (no third party).** SSE from a
   streaming Function backed by the Workflow durable stream; client
   reconnects and resumes by `seq` (gaps refilled by the wrapper's `catch_up`).
   Plain polling of the same buffer (`GET /api/stream?since=seq`, non-streaming) is
   the trivial fallback. No Ably/Pusher.
3. **Browser secret storage → `localStorage` + "forget" button** (with a clear
   risk warning); PIN-wrapped storage is a later option.
4. **Web framework → Next.js on Vercel** (assumed; confirm if not).
5. **CLI shape → one transparent passthrough wrapper, not subcommands** (§3.1).
   `remote-claw` *is* `claude` (all args forwarded); a reserved `--rc-*` namespace
   is consumed by the wrapper (`--rc-identity` does identity work). No `serve`.
6. **API admission → app access token `T_app`** held as a **Vercel secret**,
   required on every `/api/*` call layered before per-identity `auth_token` (§4.5).
   Strong for wrappers, soft for the public web bundle; no confidentiality role.
   Future option: mTLS client identities for per-client revocable admission.
7. **Nothing remote until RC is enabled** (lazy). Running `remote-claw` like `claude`
   sends nothing to the broker; only on first `/remote-control` does the wrapper join
   the identity bus and become discoverable (§3.2, §6B, §15 #2).
8. **Registry → a per-identity value-addressed bus, NO store** (§6B). A Workflow can't
   be a queryable index, but `getHookByToken("bus:"+identity_id)` resolves a derived
   token → run → stream (verified in the SDK types, §13/§14A), so discovery + presence
   are answered **live** by connected wrappers on the bus — no rows, no presence keys,
   no pointer. Two endpoints total (`/api/relay`, `/api/stream`). Trade-off: online-only
   listing. A durable store (Upstash/Blob/Neon) is **optional**, only for offline
   listing (§6C).

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
packages/cli       the Node CLI: `remote-claw` — transparent `claude` wrapper (MITM + relay) + `--rc-*` flags
apps/web           Next.js app (Vercel): /api/relay + /api/stream, the per-identity
                   bus + per-session workflows, web client UI (no store — §6B)
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
- **P2 — CLI: arg-passthrough + identity flags.** `packages/cli` in Node/TS: the
  transparent wrapper skeleton (parse/strip the `--rc-*` namespace, classify tokens,
  forward all other args to `claude`, `--` escape), and the identity surface (§3.1):
  `--rc-identity` (idempotent `O_CREAT|O_EXCL` create-once, derive ids, print `rc1_…`
  + optional `--rc-web` QR/deep-link; host registration deferred to first RC),
  `--rc-id` (selector; default-only auto-create), `--rc-show-secret`, `--rc-rotate`
  (secure-delete + `--rc-confirm`), `--rc-list`, `--rc-name`, `--rc-json/--rc-quiet`
  (never emit `S`). Local only (mock app); unit-test the token classifier + the
  create-once/never-reveal/secure-delete invariants.
- **P3 — Vercel app skeleton (the bus).** `apps/web` (Next.js): **app-key middleware
  (`X-RC-App-Key` = `T_app`, a Vercel secret)** in front of the **two** routes
  (`POST /api/relay`, `GET /api/stream`) + per-identity auth (`sha256(auth_token)`); the
  per-identity bus relay workflow (`bus:${identity_id}` hook + out-stream) and the
  token→stream resolver (`getHookByToken→getRun→getReadable`); per-session workflows.
  Deploy; curl the full `identify`→`session_announce` cold-start + a relay round-trip
  with hand-rolled ciphertext. **First, a build-time spike** of the §6B linchpins:
  the `getHookByToken→getRun→getReadable` composition, run-roll hook re-bind, and the
  size/chunk limits — pin SDK versions (`workflow`/`@workflow/*`).
- **P4 — CLI: `serve` behavior = relay on `/remote-control` (MITM — §14).** Node/TS
  reimpl of the Phase 0 interception: `remote-claw` runs the real interactive
  `claude` (full passthrough) and, when RC is enabled, points it at our local MITM
  (`HTTPS_PROXY` → our proxy with a trusted leaf cert; intercept `/v1/code/sessions*`;
  pass `/v1/messages` through to Anthropic for inference). Our relay is the RC
  backend — Anthropic's RC relay is never used. Then: lazily register host, log each
  frame, allocate `seq`, encrypt → `POST /api/relay` (with `T_app` + `auth_token`);
  subscribe inbound (SSE) → dedup by `msg_id` → decrypt → deliver to Claude only
  after log commit, then echo `accepted`. End-to-end: a curl "web" drives a real
  Claude session through Vercel.
- **P5 — Web client.** Paste/fragment secret, identity + spaces list (each space =
  a chat), message view (history + live), send. Mobile/PWA.
- **P6 — Multi-host + polish.** Add-host, friendly names, reconnect/resume, replay
  from `since=seq`, rotation, error states.
- **P7 — Hardening + review.** `/code-review` + codex pass (as in Phase 0):
  auth/abuse on ingest routes, replay-window correctness, at-least-once dedupe,
  rate-limiting, secret-handling hygiene.

## 12. Risks / inherited fragility
- **Anthropic RC interception** (the Phase 0 MITM of `/v1/code/sessions`, pinned to
  `claude` 2.1.168) underpins v2 too — it can break or be re-gated on any Claude
  upgrade. Keep the capture tool (`mitm/capture-proxy.py`) to re-verify.
- **Single secret per identity** (default one identity per machine) = single point
  of failure; rotating = a new identity (no partial/per-device revocation). Pasting
  into a browser exposes it to that device's XSS/extension/clipboard surface. `rc1_`
  high-entropy tokens trip secret scanners if pasted into a repo.
- **App-key (`T_app`) in the web bundle is a soft gate** (§4.5): public JS means a
  page visitor can extract it, so it stops scanners/bots but not a determined human.
  It is admission, not authz/confidentiality (those stay with `auth_token`/content
  keys). Harden later with web-app SSO/password or mTLS client identities.
- **At-least-once, no FIFO** from the broker ⇒ dedupe + reorder is mandatory.
- **The bus is online-only** (§6B): discovery+presence are answered by *connected*
  wrappers, so an offline host shows **nothing** (no greyed rows). Accepted
  simplification; offline listing requires the optional store (§6C).
- **`getHookByToken→getRun→getReadable` is a verified-by-types but undocumented-as-a-
  pattern composition**, and the run-roll **hook re-bind** has a brief `HookNotFound`
  window → client retry. Both are P3 spike items (§11); a stale resolve is at worst
  "reconnect + `catch_up`," never a wrong attach.
- **Workflow per-run caps** (25 000 events / 10 000 steps / 2 GB; replay degrades past
  ~2 000 events): each **inbound publish is an event**, so the bus **rolls** before the
  cap (re-creating `bus:${identity_id}`); keep high-volume turn frames on per-session
  **out-streams** (stream writes bypass the event cap, billed as Data Written) so rolls
  stay rare. Quantify Events vs Data-Written per active identity before scaling.
- **Metadata leak:** the broker sees `identity_id`, `session_id`, `seq`, sizes,
  timing. Not metadata-private. Pad/normalize later if it matters.
- **Counter/nonce safety:** resolved by per-message HKDF subkeys (§4.3); do **not**
  regress to a shared counter nonce with stateless/multi-device senders.
- **Vercel Queues / WDK surface** still moving (Queues beta); Workflows GA is
  stable — pin SDK versions, isolate behind a thin transport interface. The §6B
  feasibility rests on moving GA numbers (caps/retention, stream event-bypass) +
  Upstash REST — re-verify at build (§11 P3).

## 13. Sources (verified 2026-06-07)
- Vercel Workflows docs / concepts / pricing+limits — https://vercel.com/docs/workflows ·
  /workflows/concepts · /workflows/pricing (GA 2026-04-16; retention & caps as cited)
- Workflow Development Kit (public beta 2025-10-23) — https://vercel.com/changelog/open-source-workflow-dev-kit-is-now-in-public-beta · https://workflow-sdk.dev
- "A new programming model for durable execution" (GA) — https://vercel.com/blog/a-new-programming-model-for-durable-execution
- Vercel Queues (public beta) — https://vercel.com/docs/queues
- Storage: Upstash Redis / Neon via Vercel Marketplace (KV/Postgres retired 2024)
- **Registry-feasibility (why a Workflow can't be the registry — §6B/§14A):**
  `runs.list()` status-only filter + ~50-run enumeration limit (community.vercel.com/t/…/34690);
  no internal-state read, write-only hooks (workflow-sdk.dev/docs/api-reference/workflow-api/get-run · /docs/foundations/hooks);
  `hook_received` is a persisted event (workflow-sdk.dev/docs/how-it-works/event-sourcing);
  out-stream bypasses the event cap (workflow-sdk.dev/docs/foundations/streaming);
  Upstash REST `SET … EX`/pipeline, no connection mgmt (upstash.com/docs/redis/features/restapi).
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
  in-memory `msg_id` seen-set (rebuilt with the log on reconnect); drop dupes before
  side effects. (§6)
- **Control frames are encrypted** under a derived `control_key` with `msg_id` +
  `expiry` + replay-check (catch_up/permission can't be server-injected). (§4.2,§8)
- **Cloud-history contradiction removed.** The broker stores **no message bodies**;
  catch-up is wrapper-served (log → worker backfill). Dropped `GET /api/messages`.
  (§3.2,§6,§8)
- **Overstated "verified replay" corrected.** Only string-presence was confirmed in
  the binary, not a usable seq-range replay; design relies on the wrapper log +
  worker backfill to our relay — NOT Anthropic's cursor API (we're off their relay). (§6,§11,§14)
- **AAD/envelope canonicalized** (binds v, identity_id, session_id, dir, record_kind,
  seq, msg_id, key_epoch via one serialization). (§4.3,§8)
- **Encrypted-metadata keys** added (`K_identity_meta`, `K_session_meta`). (§4.2,§8)
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

## 14A. Design-review log (multi-agent panels)

Beyond §14's plan review, individual decisions are settled with small design panels
(N independent proposals → synthesis → adversarial verification) and folded back here.

- **`--rc-identity` & the identity CLI surface (2026-06-07).** A 3-lens panel
  (security / ergonomics / simplicity) → synthesis → 3 adversarial verifiers settled
  §3.1's identity flags. Confirmed-sound core: local, idempotent, **create-once**
  (`O_CREAT|O_EXCL`), exits without launching claude, **zero network I/O** (lazy
  registration), prints `S` only at creation, quiet status re-runs. Security fixes the
  review forced in (now reflected in §3.1/§4.4): a **QR/deep-link is not
  screen-share-safe** (it encodes `S` verbatim); **`--rc-json`/`--rc-quiet` never emit
  `S`** (CI-log leak); **`--rc-rotate` securely deletes** the old `S` (same secret
  re-derives a live credential — not "keys to dead data"); the deep-link uses a
  separate **`--rc-web`** URL, not the broker `--rc-app`; a normal run only
  auto-creates the **`default`** slot (an unknown `--rc-id` errors) to kill the
  typo-mints-identity footgun; `--rc-confirm <identity_id>` is an accident guard (identity_id
  is public), so rotate also requires a TTY.
- **Registry / state expression (2026-06-07 → -08).** Three research→design→verify
  panels, ending against the **SDK type definitions**. Evolution: (1) a Workflow can't
  be a *queryable* registry (`runs.list()` is status-only, `start()` no custom key,
  heartbeats-as-events blow the 25k cap) → first concluded a managed KV was needed;
  (2) the user simplified to **one user identity binding all sessions across hosts** +
  **an announce bus** (connected wrappers self-identify on request); (3) the linchpin —
  whether the bus is addressable by a derived value — resolved **yes**:
  `getHookByToken(token): Promise<Hook>` is public and returns `runId`, so
  `bus:${identity_id}` → `getHookByToken` → `getRun` → `getReadable` subscribes with
  **no stored pointer**. **Final: a per-identity value-addressed bus, no store** (§6B);
  online-only listing is the trade; a store is optional for offline listing (§6C).
  Caveats (verified): two-call composition is undocumented-as-a-pattern; live-only
  (hooks dispose at terminal state); run-roll re-binds the token; `getHookByToken` is
  server-creds (browser via our Function).

## 15. Use cases / scenario matrix (also the v2 test plan)

Each maps to the frames (§6A), channels, endpoints (§8), and state. **[V]** = an
aspect already empirically verified (Phase 0 MANGO / the P0.5 spikes C1–C5 +
rc_api_bridge); others are specs to build/test.

> **⚠️ Discovery/presence steps below predate §6B's bus and are being reconciled.**
> Some scenarios/sequences still show the earlier registry-KV/heartbeat mechanics
> (`GET /api/identity`, `GET /api/sessions`, `POST /api/heartbeat`, `live:` keys,
> `online=last_seen+TTL`). **§6B is authoritative:** discovery + presence are the
> per-identity **bus** (`identify?` → `session_announce`; connected = online), and the
> broker has only **two** endpoints (`POST /api/relay`, `GET /api/stream`). The
> messaging/control/recovery scenarios are unaffected; only their discovery/presence
> plumbing changes.

**Identity & host bring-up**
1. **Fresh machine bootstrap.** `remote-claw --rc-identity` → generate root `S`
   (0600), derive `identity_id`/`auth_token`/`content_root`/`control_key`/meta-keys,
   print `rc1_…`, exit (does **not** launch claude). Host registration is **lazy**
   (deferred to first RC — §15 #4), so nothing is sent to the broker yet. (secret
   format §4.1, derivation §4.2)
2. **Wrapper launches the real TUI, RC OFF.** `remote-claw` (used exactly like
   `claude`) runs the real interactive `claude` with full passthrough; **no broker
   traffic at all** — no host row, no heartbeat. The machine is invisible to the
   cloud. Local-only. **[V]** (TUI launch)
3. **Work locally, RC still off.** Build a conversation; it lives only in claude's
   on-disk transcript; the broker knows nothing. **[V]** (local history)

**Enabling remote control**
4. **Enable RC mid-session via `/remote-control`.** Wrapper points the inner claude
   at the local MITM → our relay is the RC backend; worker backfills the existing
   transcript as `historical` frames → log seeds; **lazily registers the host**
   (`POST /api/identity`) then `POST /api/sessions {enc(title), enc(cwd)}`; heartbeats
   begin → session goes online. **[V]** C1+C2
5. **Launch with RC on.** `remote-claw --rc-share` → fresh session, our relay is the
   backend from the start, empty history. **[V]** (Phase 0)

**Client onboarding & discovery**
6. **Client first connection.** Open web app, paste `rc1_…` (or `#fragment`) →
   derive keys in-browser → `GET /api/identity` (with the app key, §4.5) → the identity
   (online if any session is live; empty/offline if nothing shared yet); store secret
   in localStorage.
7. **Client second connection, 5 identities.** 5 secrets pasted over time → web lists
   every instance under them **as spaces** (grouped by identity), each online/offline
   (heartbeat TTL §3.2) + last-activity. (the "know the 5 separate claude-code
   wrappers" case — each instance is a space, grouped by its secret/identity)
8. **List an identity's spaces.** `GET /api/sessions?host=identity_id` → decrypt
   titles/cwd client-side → gchat-style list of that identity's spaces (instances),
   each one a chat, with online + last-activity. (A space is a chat, not a folder of
   sessions.)

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

**Multi-identity & naming**
14. **Add an identity.** Paste another `rc1_…` → new `identity_id` → its spaces appear.
15. **Rename identity/space.** Friendly name encrypted under `K_*_meta` → registry
    update; other devices decrypt the new name (default identity = hostname, space =
    claude's generated title).

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
19. **Wrapper/CLI restart (both stateless).** Reboot/crash → relaunch `remote-claw
    --continue` + `/remote-control` → worker re-backfills → log rebuilt; clients
    reconnect + `catch_up`; heartbeat resumes → online. **[V]** C5
20. **Host offline → back.** Wrapper exits (never outlives the CLI) → heartbeat
    stops → after TTL the space(s) show **offline**, client send rejected
    `409 host-offline` (no server-side queue in v1); on return (relaunch +
    `/remote-control`) → online, `catch_up` fills the gap.

Also covered by the same mechanisms (not numbered): **secret rotation** (new `S`
→ new `identity_id` = a new identity with a fresh, empty set of spaces; the old identity
and all its spaces are dead — §4.4), and a **broker (Vercel) outage** (the local TUI
keeps working; remote is unavailable; clients reconnect and `catch_up` when the
broker returns — nothing lost since claude holds the transcript).

## 16. Message sequences (per use case)

Actors: **C**=web/generic client · **V**=Vercel broker (functions+workflow) ·
**W**=wrapper/relay (host side: MITM + relay client) · **T**=real claude TUI ·
**A**=Anthropic API (**inference only**, passthrough). All C↔V↔W payloads are
ciphertext (`{…}` = decrypted view); every C/W→V call carries the **app key**
(`X-RC-App-Key`, §4.5) **and** `Bearer auth_token`. Frame kinds per §6A. `→` one
message; steps are ordered.

> **⚠️ Same caveat as §15:** sequences that *discover/list/presence* still show the
> older `GET /api/identity|sessions` + `heartbeat` plumbing. Under §6B these become:
> client `GET /api/stream?identity=` (subscribe to the bus) + publish `identify?` via
> `POST /api/relay`(`resumeHook bus:${identity_id}`); each connected W answers
> `session_announce`. Per-session live frames and `catch_up` are unchanged in spirit
> (now addressed by the `sess:${identity_id}:${session_id}` token). Full rewrite pending.

**1. Fresh machine bootstrap** (`remote-claw --rc-identity`)
1. W: gen `S`; derive `identity_id, auth_token, content_root, control_key, K_*_meta`
2. W prints `rc1_…`; **exits** *(no T, no session, no broker call — host registration is lazy, deferred to first RC, see #4)*

**2. Wrapper launches real TUI, RC OFF** (`remote-claw …` used as `claude`)
1. W spawns **T** (passthrough args). MITM env (`HTTPS_PROXY→W`,
   `NODE_EXTRA_CA_CERTS`) is **armed but inert** until RC is enabled.
2. T→A inference for local use (passthrough; `/v1/messages` not intercepted)
3. **No broker traffic at all** — no host row, no heartbeat. The machine is invisible.

**3. Work locally, RC OFF**
1. user↔T locally; T→A inference; transcript persists on disk
2. V sees **nothing** — no registration, no heartbeat, no content

**4. Enable `/remote-control` mid-session** *(verified C1+C2)*
1. user types `/remote-control` in T
2. T→W `POST /v1/code/sessions {title, config{cwd,model}}` *(MITM-intercepted)* → W `200 {session{id:sid}}`
3. T→W `POST …/{sid}/bridge` → W `200 {worker_jwt, api_base_url}`
4. T→W `GET …/{sid}/worker/events/stream` (SSE); W→T `control_request{initialize}`
5. T→W `POST …/worker/events [{user historical}, {assistant historical}, …]` *(backfill of prior chat)*
6. W: **lazily registers** `POST /api/identity {identity_id, sha256(auth_token), enc(name=hostname)}` (first time only); log+encrypt each backfilled frame; W→V `POST /api/sessions {identity_id, sid, enc(title), enc(cwd), status:active}`; `POST /api/heartbeat {identity_id, wrapper_instance_id, session_ids:[sid]}` → session online

**5. Launch with RC ON** (`remote-claw --rc-share`) — as #4 steps 2–4 + the lazy register/heartbeat of step 6, **no backfill** (empty history).

**6. Client first connection**
1. user pastes `rc1_…`; C derives `identity_id, auth_token, content_root`
2. C→V `GET /api/identity` → `[{identity_id, enc(name), online}]` (empty if never shared); C decrypts name, renders the identity (its spaces via #8)

**7. Client second connection, 5 identities**
1. C has 5 secrets (localStorage) → 5 `(identity_id, auth_token)`
2. for each: C→V `GET /api/identity` (that host's bearer) → its record + `online` (any session live)
3. C renders all their **instances as spaces**, grouped by identity, each online/offline + last-activity

**8. List an identity's spaces**
1. C→V `GET /api/sessions?host=identity_id` → `[{sid, enc(title), enc(cwd), status, online}]`
2. C decrypts titles → gchat-style list of spaces (each a chat)

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
1. C: encrypt `user{content}` **as a content frame under `K_session`** (it's transcript, not control) → C→V `POST /api/relay {dir:in, kind:user, client_msg_id, msg_id}`
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

**14. Add an identity**
1. user pastes `rc2_…` → C derives `identity_id₂` → C→V `GET /api/identity` (bearer₂) → its spaces appear

**15. Rename identity/space**
1. C: `enc(new_name)` under `K_identity_meta` (identity) or `K_session_meta` (space) → C→V `POST /api/identity|sessions {…, enc(name|title)}` (update)
2. other devices: `GET /api/identity|sessions` → decrypt the new name

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
1. both die → operator relaunches `remote-claw --continue` *(passthrough; resumes the on-disk session)* → W spawns **T** through the MITM
2. user `/remote-control` → register→bridge→stream (as #4) → T→W backfill `POST …/worker/events [full historical transcript]`
3. W rebuilds the log from backfill; W→V re-`POST /api/sessions` + heartbeat → online
4. C reconnects → `catch_up` → W replays the rebuilt log → C re-renders *(state recovered from claude)*

**20. Host offline → back**
1. W/CLI exit → heartbeats stop
2. C→V `GET /api/identity|sessions` → `online=false` (`now − last_seen > TTL`)
3. C→V `POST /api/relay {dir:in,…}` → V: no live hook / no online session → **`409 host-offline`** (no server-side queue in v1) → C shows "offline"
4. host returns: relaunch + `/remote-control` → heartbeat → online; C retries, `catch_up` fills the gap

### 16.1 Primitives used (per scenario)

Compact map of the building blocks each scenario exercises. Vocabulary: `HKDF`
(derive) · `GCM` (AES-256-GCM seal/open) · `AAD` · `sha256` · `CSPRNG` ·
`checksum` · broker: `/api/identity` `/api/sessions` `/api/relay` `/api/stream`(SSE)
`/api/heartbeat` `app-key`(`X-RC-App-Key`=`T_app`) `bearer`(`auth_token`) ·
workflow: `hook` `wf-stream`(durable resumable) `online=last_seen+TTL` ·
host/MITM: `args-passthrough` `--rc-*` `intercept`(/v1/code/sessions*)
`passthrough`(/v1/messages) `bridge`(worker_jwt) `worker-SSE` `/worker/events`
`initialize` `backfill`(historical) `log` `dedup`(msg_id) `seq-alloc`
`lazy-register` `/remote-control`.

| # | Scenario | Primitives |
| --- | --- | --- |
| 1 | Fresh machine bootstrap (`--rc-identity`) | `CSPRNG(S)`, `HKDF`→{identity_id,auth_token,content_root,control_key,K_*_meta}, `checksum`, print `rc1_…` *(local only; no broker call — register is lazy)* |
| 2 | Wrapper launches TUI, RC off | `args-passthrough`, MITM `passthrough`, CA trust *(no broker traffic)* |
| 3 | Work locally, RC off | `passthrough`, claude on-disk transcript (no /v1/code; broker sees nothing) |
| 4 | Enable `/remote-control` | `intercept`, `bridge`, `worker-SSE`, `initialize`, `backfill`, `log`, `GCM`, `lazy-register`(`/api/identity`), `/api/sessions`, `app-key`+`bearer` |
| 5 | Launch with RC on (`--rc-share`) | `intercept`, `bridge`, `worker-SSE`, `initialize`, `log`, `lazy-register` |
| 6 | Client first connection | `HKDF`, `app-key`, `bearer`, `/api/identity`, `GCM-open(name)`, `localStorage` |
| 7 | Discover instances across identities | 5× `HKDF`, `app-key`, 5× `bearer`, `online=last_seen+TTL`, `GCM-open` |
| 8 | List an identity's spaces | `/api/sessions`, `GCM-open(title/cwd)`, `online` |
| 9 | Cold full history sync | `GCM(control_key)`, `hook`, `log-read`, `GCM(content)`, `/api/relay`, `wf-stream/SSE`, `seq` |
| 10 | Reopen — delta sync | `catch_up`, `log-read(>N)`, `IndexedDB` cache, `wf-stream` resume(`startIndex`) |
| 11 | Client → claude → back | `GCM(content)`, `hook`, `dedup(msg_id)`, `log`, `seq-alloc`, `intercept`-inject, `passthrough`, `accepted`, `wf-stream/SSE`, `AAD` |
| 12 | Type in TUI → client | `worker-SSE`(upstream), `log`, `GCM`, `wf-stream/SSE` |
| 13 | Two clients (fan-out) | `wf-stream` multi-reader, `SSE`, `seq`/`dedup` |
| 14 | Add an identity | `HKDF(S₂)`, `app-key`, `bearer₂`, `/api/identity` |
| 15 | Rename host/session | `GCM(K_identity_meta)`, `/api/identity` update |
| 16 | Tool permission | `control_request/response`, `GCM(control_key)`, `hook`, `worker-SSE` |
| 17 | Remote control verbs | control frames (`control_key`), `hook`, RC verbs (`interrupt`/`set_permission_mode`/`set_model`) |
| 18 | Network blip resume | `wf-stream` resume(`startIndex`), `seq` reorder, `dedup` |
| 19 | Wrapper/CLI restart recovery | `--continue`, `/remote-control`, `intercept`, `backfill`, `log-rebuild`, `catch_up` |
| 20 | Host offline → back | heartbeat `TTL`, `online` flag, offline reject/queue, `catch_up` |
