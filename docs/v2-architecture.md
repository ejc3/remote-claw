# remote-claw v2 — cloud-brokered, zero-knowledge, multi-host (many independent machines, each its own secret)

> Status: **design** (researched 2026-06-07; Vercel facts verified against official
> docs dated 2026-05/06). Supersedes the localhost MITM-relay of Phase 0 for the
> *transport/UX* layer; **reuses** Phase 0's Claude-interception core unchanged.

## 1. What changes and why

Phase 0 put a relay on `localhost` and you reached it over SSH. v2 keeps the same
trick for talking to Claude (MITM `api.anthropic.com`, intercept
`/v1/code/sessions*`) but replaces the localhost client face with a **cloud broker
on Vercel** so you can chat from anywhere — phone included — across **multiple
independent machines** (each with its own secret), with **end-to-end encryption** (in
the **Sealed** mode — §2A) where **Vercel only ever sees ciphertext**.

Goals:
- **`remote-claw` is a transparent wrapper around `claude`** — invoke it exactly
  like `claude` (all flags/args pass through); a reserved `--rc-*` namespace is the
  only thing it consumes. No separate `serve`/`identity` commands.
- Mobile-friendly web app (Vercel) to chat with your sessions.
- Paste a machine's **pass** → watch/steer **every session on THAT machine** and
  decrypt it. (The pass is a derived viewer credential, not the master secret — §4.2a.)
- **Each claude instance is its own space / chat** (gchat-style). Instances are
  grouped by the **machine** they run on (its single identity).
- **Three trust modes behind one seam (§2A):** **Sealed** = today's E2E from the secret
  (Vercel sees only ciphertext); **Open** = trust-the-server, no encryption, loud banner,
  never a silent default; **Managed** (future) = Sealed plus relay-delivered wrapped keys.
  **Non-guessable** secrets; in Sealed/Managed the broker is zero-knowledge. The web app
  gates on **proper SSO** (Better Auth SSO plugin); the
  broker authorizes each request off the per-identity `auth_token` (the unguessable
  128-bit `identity_id` + required `auth_token` *is* the anti-scanning gate — no
  separate app-key) (admission, not confidentiality — §4.5).
- Stateless web client **and** stateless wrapper; **claude's on-disk session is the
  durable record**; the cloud is a stateless ciphertext relay (see §6).

> **Terminology (the core abstraction = the SECRET = one MACHINE's identity).** A *secret*
> derives a **machine identity** — `identity_id` / `auth_token` / content keys. **Each
> machine owns its own secret**, so the secret is the boundary **and** the machine: one
> machine = one secret = one `identity_id`. (You can still point `remote-claw --rc-file`
> at another secret file to run a *different* machine identity on the same box, but the
> norm is one identity per machine.) A *session* = a *space* =
> a *claude instance* = **one chat**: a single running `claude --remote-control`
> **wrapped 1:1 by its own `remote-claw` process** — the *wrapper* is that per-session
> shim, **not** a machine or a daemon. **Every session is fully independent of every
> other**: it holds only its own in-memory relay state and knows nothing about its
> siblings, whether they run on the same box or different ones. **Sessions on one machine
> share that machine's single identity** — they are grouped by the machine's secret; there
> is **no per-host aggregator/daemon** between the identity and its independent sessions.
> The hierarchy is **machine identity → its spaces
> (chats)** (a space *is* one chat, not a folder of sessions); the web client holds **one
> machine's pass at a time** and lists every space on that machine (to watch another
> machine you onboard *its* pass, §7). So `identity_id` is the **machine's public routing
> id** — **not** a "user identity spanning all hosts."

Non-goals (v1): forward secrecy, group/sender-key crypto, metadata privacy
(timing/sizes/seq are visible to the broker). **Fine-grained per-viewer revocation** is
also out of scope — viewers hold a **pass** (§4.2a), but there is no way to cut one pass
without the others; to remove a viewer you **reset the machine** (a new secret — §4.4).

## 1A. User experience & ergonomics (the flow we're building)

The whole design serves this human flow. Two roles (often the same person): the
**operator** runs claude on a machine; the **driver** chats from a phone/laptop.

### A. Operator — on the machine
1. **Use `remote-claw` exactly like `claude`.** It's a **transparent wrapper**:
   every `claude` flag, arg, env var and positional prompt **passes straight
   through** (`remote-claw --continue`, `remote-claw --model opus`,
   `remote-claw -p "…"`, `remote-claw .` …). You get the **exact normal claude TUI** — same
   behavior, same options. The wrapper consumes only a small reserved **`--rc-*`**
   namespace (§3.1) and forwards the rest. There is **no separate `serve`
   command** — `remote-claw` *is* claude, plus remote-control.
2. **Get your machine's identity (one-time):** run `remote-claw --rc-identity` → it ensures
   this **machine's** identity exists (the master secret lives in one local file, created on
   first use — a plain `remote-claw` run also auto-creates it **silently**, so if you've already
   launched once, this is a quiet status re-run). The raw master secret is the **operator's**
   and is shown only to the operator — `--rc-identity` prints the `rc1_…` master at create, and
   `--rc-show-secret` re-reveals it. The artifact you hand a **viewer** (phone/browser) is a
   **pass**, not the master: with `--rc-app` set it also prints a **QR / `#fragment` deep link**
   carrying the pass for phone onboarding (treat it like a credential; it's not screen-share-safe).
   Need a *different* machine identity for one run? Point `--rc-file <path>` at a different secret
   file for that run.
3. **Share a session:** in any `remote-claw` TUI, hit `/remote-control` → it flips
   to "Remote Control active," and **that instance becomes a chat in the web app**.
   (Or launch already remote-controlled with claude's own `--remote-control`.)
4. Run **as many instances as you like** — one per repo/branch/task; each is its
   own chat. Close the TUI → that chat goes offline.

*Ergonomic promises:* **zero change to the local workflow** (full claude
passthrough); **opt-in per session** — running `remote-claw` like claude sends
**nothing** to the broker (not even presence) until you `/remote-control`; the MITM
setup is **automatic and invisible**; in **Sealed**/**Managed** nothing leaves the box
unencrypted (in **Open** you deliberately trust the server, behind a loud banner — §2A).

### B. Driver — on phone/laptop (the web app)
1. **First time:** open the app, paste (or scan) the machine's **pass** (or open a link
   with the pass in the URL `#fragment`). The pass carries the operational keys; they
   load **in the browser** and never hit the server.
2. You land on a **list of chats** — every claude instance on that machine,
   most-active first, each with a name + an online dot. Reads like Slack/iMessage.
   (A freshly-onboarded machine with nothing shared yet shows up empty — chats appear
   as you `/remote-control` sessions on the host.)
3. **Tap one** → history decrypts locally and live messages stream in. **Type** →
   your message shows in the chat *and* in the real terminal; claude works and the
   reply streams back to your phone.
4. **Switch machine:** the client holds **one pass at a time** — onboard a different
   machine's pass to **replace** the current one (the previous machine is forgotten from the
   device; §1A E "forget identity"). One pass shows that **one machine's** every chat at once;
   to watch a second machine you hold its pass too — switch between them, one active at a time.

*Ergonomic promises:* mobile-first, instant, **no login** beyond the onboarded pass;
feels like a messaging app; one pass per machine, onboard as many machines as you run.

### C. Naming & organization
- Each chat's default name is meaningful — the wrapper reads the inner session's
  **repo + branch / cwd** and the **title claude already generates** from the first
  prompt, and includes them (inside the `K_meta`-encrypted `session_announce`).
  You can **rename**, but with no store this phase a rename is a **client-local alias**
  (kept in the device's `localStorage`); cross-device/persistent rename rides the
  deferred store (§6C).
- Identities default to **hostname** (an `identity_label` inside the `K_meta` announce, announced by the
  wrapper); chats group under them. The label is the machine's name because the identity **is**
  the machine (one secret per machine). Renaming an identity is likewise a
  client-local alias this phase.
- **Online = connected:** a chat shows because its wrapper is **broadcasting** a fresh
  signed announce on the identity bus (§6B). If a chat you're looking at goes quiet
  (host sleeps/crashes), the app **greys it locally** when the announces stop — you see it
  go away in real time. A chat for a host that was *never* connected this session just
  doesn't appear (offline *listing* across cold starts is deferred — §6C).

### D. Reconnect / offline (what it feels like)
- Phone drops Wi-Fi mid-reply → on reconnect it **silently catches up**; you never
  lose the thread.
- Host sleeps / you close the TUI → the chat you're watching **greys out** (its announces
  stopped); sending is **rejected** ("host offline" — no server-side queue, §6/§16).
- Bring the host back (`remote-claw --continue` → `/remote-control`) → the chat
  goes live and **history is intact** (it lives with claude, not the cloud).

### E. Security ergonomics (honest with the user)
- A viewer holds a **pass** (§4.2a): read + steer every chat on that **one machine**, but
  **not** the master secret — a lost phone can't recover `S` or reset the machine. Treat a
  pass like a credential. The app offers **"forget identity"** — wipes the pass
  from `localStorage` **and** the decrypted-message cache (IndexedDB) for that
  machine, leaving no plaintext on the device. (The raw master secret is the machine's,
  shown only to the operator via `--rc-show-secret`/`--rc-identity`.)
- Lost/leaked pass or secret → **reset the machine**: a new secret = a new, unrelated
  identity for **that machine** (fresh chats); the old one is dead; your **other machines
  are untouched**. No partial/per-pass revoke in v1.
- In **Sealed**/**Managed** the cloud never sees plaintext or keys — only ciphertext +
  routing metadata (who/when/sizes), which it cannot read; in **Open** it sees everything
  (you trust the server — §2A).

### F. Explicitly NOT in v1 (so we don't over-build)
- Push notifications (nice later; for v1 you open the app to see new messages).
- Per-device revocation / sharing one identity with separately-revocable people.
- Editing/branching past turns from the phone beyond what claude's RC already does.

## 2. Threat model & the zero-knowledge property

All confidentiality claims below are **mode-relative** (§2A): they hold under **Sealed**
(today's E2E) and **Managed** (future). Under **Open** there is deliberately no
encryption — you trust the server, which sees and can forge everything (loud banner,
never a silent default).

- **Broker (Vercel + any managed realtime/store) is untrusted for confidentiality
  (Sealed/Managed).** It routes and persists **ciphertext + routing metadata only**
  (`identity_id`, `session_id`, `seq`, `dir`, sizes, timestamps). It can
  drop/withhold/reorder **and replay captured frames** (availability + replay), but in
  Sealed/Managed it cannot read or forge **anything inside a frame** — content,
  control, and meta/presence are all AEAD-authenticated under client-held keys, so it
  can't read bodies/titles/status or forge `session_announce`/`accepted`. (In **Open**
  it can read and forge all of these — that is the trade Open makes.)
- ⚠️ **Vercel's own "Workflow E2E encryption" is NOT zero-knowledge** — keys are
  Vercel/deployment-managed and decryptable via the dashboard/CLI. We treat it as
  defense-in-depth only and do **all** crypto ourselves, client-side, passing only
  ciphertext into `start()`, hooks, steps, streams. (Verified: Vercel docs +
  security review of Happy, which got this wrong for stored API keys — see §11.)
- **Trust roots:** the CLI host (holds the **machine's** master secret + runs Claude) and
  any device the user onboards. **Split by what leaks:**
  - A leaked **pass** (§4.2a, a viewer credential) = read **and** steer that **one
    machine's** sessions — and, because the content/presence keys are symmetric, the holder
    can also *produce* valid-looking content/presence for that machine (the symmetric-key
    forge residual). But a pass **cannot** recover the master secret `S` or reset/re-mint
    the machine (HKDF one-wayness, §4.2a).
  - A leaked **machine secret** = full compromise of **that machine only** (read + write +
    decrypt past/future retained ciphertext; can also reset/re-mint it). **Other machines
    are untouched** — blast radius is exactly one machine.

  Mitigation either way: **reset the machine** = new secret = a new, unrelated identity for
  that machine (a fresh, empty set of spaces); other machines keep working (§4.4).
- **Admission vs. confidentiality (two independent gates).** Confidentiality is the
  zero-knowledge property above (content keys; broker never reads bodies).
  *Admission* — keeping anonymous randos off the API entirely — has two parts (§4.5):
  the **web app** gates on **proper SSO** (Better Auth SSO plugin; OIDC via the IdP
  discovery document, plus SAML 2.0 / OAuth2), while the **broker** authorizes each
  `/api/*` request off the per-identity **`auth_token`** alone — self-verifying
  (`identity_id = trunc(SHA256(auth_token))`), so the unguessable 128-bit `identity_id`
  + required `auth_token` *is* the anti-scanning gate (no separate app-key). Neither adds
  confidentiality. Future: mTLS client identities for per-client, revocable admission.

## 2A. Trust modes (one seam, three policies)

The same machine, viewers, and relay run in **three trust modes**, chosen by how much you
trust the relay. A single **`SecurityProvider`** seam sits between the wrapper/app and the
crypto: **the wire format, the channels, and the relay code are identical across all three
modes** — only `seal`/`open` differ. So "E2E" in this doc means specifically the **Sealed**
mode; every unconditional confidentiality claim elsewhere is Sealed/Managed-relative.

| Mode | `seal`/`open` | What the relay sees |
| --- | --- | --- |
| **Open** | pass-through, **no encryption** (loud banner; **never** a silent default) | **Everything** — and it can read, alter, or forge any frame. You are trusting the server. |
| **Sealed** | today's E2E crypto core (§4) — AEAD under the client-held keys | only ciphertext + the cleartext routing header; can't read or forge content/control/meta/presence. |
| **Managed** *(future, not built)* | Sealed, **plus** the relay delivers each device the content key **wrapped to that device's X25519 public key** (an HPKE-style envelope the relay can't open), gated on an out-of-band **device-pairing fingerprint compare** | same as Sealed — it moves sealed key-envelopes it can't open. |

**Open** is for local testing or a server you fully own; its banner is a footgun guard, not
protection. **Sealed** is the default private mode — you hand viewers their keys yourself
(the pass, §4.2a). **Managed** keeps Sealed's secrecy but removes the manual key-passing; its
open problem is safe device pairing (learning a device's real public key without the relay
swapping in its own), so it is **deferred**.

## 3. Components

```
  ┌── server A (your machine) ──────────────┐         ┌──────── Vercel (broker) ─────────┐        ┌── phone / laptop ──┐
  │ claude --remote-control                  │         │  POST /api/relay + GET /api/stream│       │  web app (Next.js) │
  │      ▲  MITM (our relay = RC backend)    │  wss/   │   (auth_token gate)               │  SSE/  │  paste PASS →      │
  │      │  + in-memory log (claude=record) │  https  │  per-identity BUS (discover/pres) │ stream │  load keys →       │
  │ remote-claw [claude args] --rc-app <app> ┼────────▶│  per-session WF (live buffer)     │◀──────▶│  decrypt & render  │
  │   (per-machine identity: secret S, 0600) │ ciphertext only — no store/no history    │        │  encrypt & send    │
  └──────────────────────────────────────────┘         └──────────────────────────────────┘        └────────────────────┘
    one secret = one machine's identity (identity_id/auth); each claude instance on it = one "space"/chat
    (one secret per machine in a local file; override per run with --rc-file)
    the phone holds a PASS derived from S (keys, not S) — §4.2a; Sealed/Managed seal frames, Open does not — §2A
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

- **`--rc-identity`** — *the identity command: local; create-once + idempotent by default, and
  the home of the destructive **reset** (a "machine reset", behind the `--rc-confirm` guard).*
  Ensures this **machine's root secret `S`** exists in its file,
  shows you how to use it, and **exits without launching claude** (spawns no TUI,
  arms no MITM, **zero network I/O** — host registration stays lazy; works
  air-gapped). The secret lives in a **single local file** — the default, or a specific
  one chosen with `--rc-file`. This is the **operator** surface: it prints the raw master
  `S` (at create/reset). The artifact you hand a **viewer** is a **pass** (§4.2a), not `S`.
  - *Secret absent →* generate `S` (32 B CSPRNG), derive `identity_id`/`auth_token`/
    `content_root`/`control_key`/`K_meta` (§4.2), write the **`rc1_…` token** (the §4.1
    encoding of `S`, not raw bytes — so the file *is* the shareable artifact and a
    truncated/corrupt file fails the checksum loudly on read instead of deriving a wrong
    identity) `0600` with `O_CREAT|O_EXCL` (atomic; never clobbers a concurrent create) at
    the **local secret file** (`$XDG_STATE_HOME/remote-claw/secret`, default
    `~/.local/state/remote-claw/secret`; reads refuse symlinks (`O_NOFOLLOW`) and
    group/other-readable modes; a `0600` sidecar holds `created_at`). Print a
    summary (**public** `identity_id`, created-at, path) and **the `rc1_…` on its own bare line** (the
    onboarding step). *(Later, with the broker phase:* if the app origin is configured
    (`--rc-app`), also print the `https://<app>/#<pass>` deep link + a terminal **QR** of it
    for phone onboarding — the artifact you hand a **viewer** carries the **pass** (§4.2a), not
    `S`. ⚠️ The QR/deep-link **encode the pass verbatim** — treat it like a credential
    (shoulder-surf/recording risk); a QR is **not** "safe to screen-share." (A raw-`S` deep
    link exists only on the **operator** path, under `--rc-show-secret` for re-onboarding your
    own device.)*) The
    create itself is local-only; `--rc-identity` accepts `--rc-file`/`--rc-json`/`--rc-quiet` plus
    the replace controls (`--rc-confirm`/`--rc-keep-old`/`--rc-force-noninteractive`). Exit 0.
  - *Secret exists, no `--rc-confirm` (idempotent re-run) →* **never** regenerates/overwrites `S`;
    prints status only (no secret/QR), notes an identity already exists, and shows the exact
    command to **reset** it. A bare re-run can never lose an identity or its chats — the core
    anti-footgun.
  - *Secret exists, `--rc-confirm <identity_id>` →* the **destructive machine reset**: mint a
    **new, unrelated** identity for **this machine** and **abandon** the old one (§4.4); other
    machines are untouched. The confirm
    must match the current **public** `identity_id` (a typo/accident guard — it is not an authz
    control, so a reset also needs a TTY unless `--rc-force-noninteractive`). **Securely deletes**
    the old secret by default (overwrite + unlink); keep a `0600` backup only with explicit
    `--rc-keep-old` (flagged as still-live). This is **abandonment, not revocation** — a leaked old
    secret keeps working until you reconnect the viewers you still trust to the new identity (§4.4).
  - The secret prints **once**, at create or reset; thereafter only via `--rc-show-secret`. There
    is **no separate `--rc-rotate` verb** (rotation was cut) — "resetting" in a store-free,
    single-secret-per-machine model is just re-creating the identity, so it lives here under the
    confirm guard.
  - **Arg rule:** allowed only alongside identity-relevant `--rc-*` flags; **errors**
    if any non-`--rc-*` token (a positional, or anything after `--`) is present, since
    it doesn't launch claude.
- **`--rc-file <path>`** — use a **specific** secret file instead of the default, for both
  creating (`--rc-identity`) and using an identity. The secret stays in the file and never
  appears on argv (`REMOTE_CLAW_SECRET_FILE` sets the same path). The file is written `0600`,
  created atomically + exclusively (`O_CREAT|O_EXCL`), and reads refuse symlinks (`O_NOFOLLOW`)
  and group/other-readable modes — but the **directory** is trusted to be the user's own; a
  world-writable parent defeats create-once (another local user could plant a valid token), so
  point `--rc-file` only at a directory you control (the default under `$XDG_STATE_HOME` is).
- **`--rc-show-secret`** — the **only** post-creation reveal of `S` (+ deep link/QR),
  for re-onboarding a device. On a TTY: a shoulder-surf/scrollback warning (STDERR) +
  Enter pause (skip with `--rc-yes`); non-TTY: bare token to STDOUT, warning to STDERR.
  Never regenerates.
- **`--rc-app <url>`** — the **single app origin** (else `REMOTE_CLAW_APP` env / config): its
  `/api/*` is the Vercel broker the wrapper POSTs ciphertext to, and its web UI is what the
  viewer-facing `https://<app>/#<pass>` deep-link/QR points at (the UI reads the `#fragment`
  client-side; the fragment carries the **pass**, not `S`). One deployment serves both, so
  there is **one** URL — read as an opaque local string (no probe). Unset ⇒ print the bare
  pass for manual onboarding, or omit the link.
  The CLI presents its per-identity `auth_token` to the broker (no app-wide key — §4.5).
- **Starting already remote-controlled** is just claude's own **`--remote-control`** flag,
  which the wrapper forwards verbatim (no separate `--rc-share`).
- **`--help` / `-h`** prints this `--rc-*` help and then **falls through to `claude --help`**,
  so you see both layers in one go.
- The identity's friendly name defaults to the **hostname**, carried as `identity_label`
  inside the `K_meta`-encrypted `session_announce` once RC is on (never sent to the broker
  in the clear). A custom label is a **client-local alias** in the web app (§1A C), not a
  CLI flag.
- **`--rc-json` / `--rc-quiet`** — machine-readable / minimal output. **Never emit the
  raw secret** in either (a script that truly needs it reads the `0600` file directly)
  — JSON/quiet output is exactly what leaks into CI logs. `--rc-json` takes precedence
  over the bare-token form.

**What the wrapper does** (otherwise it's just claude):
- Runs the **real interactive `claude` TUI** with all your passthrough args. The
  **identity is auto-created on first run** if absent (local only — no network).
- **Nothing is sent to the broker until you enable remote control.** Running
  `remote-claw` like `claude` registers nothing and sends no heartbeat.
- When you hit `/remote-control` (or pass claude's `--remote-control`), it makes the inner claude
  RC-eligible **pointed at our local MITM** (not Anthropic's RC relay — §14) by
  **automatically** setting `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` for the child
  process. Our relay is the RC backend; it bridges that traffic E2E-encrypted to the
  app **under the chosen secret**.
- Relay logic (Node/TS, reimplementing the Phase-0 interception knowledge): on each
  worker→relay event, log it, allocate `seq`, encrypt with the per-session key, and
  `POST /api/relay`; subscribe (SSE) to its inbound channel, **dedup by `msg_id`**,
  decrypt, and deliver to Claude **after log commit**, then echo `accepted`.
- **Joins the identity bus** (§6B): on first `/remote-control` it resume-or-starts the
  per-identity bus run (`bus:${identity_id}`) and **periodically broadcasts** its own signed
  `session_announce{…, sent_at}` (every `ANNOUNCE_INTERVAL` + on change) — that *is* both
  discovery and presence (a client shows the session online while its announce is fresh;
  §4.3). It exposes the session's stream (`sess:${identity_id}:${session_id}`) for live
  frames. No server-side heartbeat/registry store.
- Maintains **in-memory** relay state (catch-up log, `msg_id` seen-set, sessions, crypto
  state) — **recoverable from the claude session** by re-enabling `/remote-control` (the
  worker re-backfills), so **no durable store is required**; both wrapper and CLI are
  stateless (claude's on-disk session is the durable layer). Answers encrypted
  `catch_up{since=seq}` from its log, falling back to worker backfill (§6).
- The wrapper does **not** outlive the CLI; on exit it stops broadcasting → its announces
  age out of `FRESH_WINDOW` → clients grey then drop those sessions (online = fresh
  announce).

### 3.2 Vercel app (the broker — a ciphertext relay; **no store**)
The broker collapses to **two** ciphertext endpoints over Vercel Workflows; there is
**no registry store, no heartbeat, no read/list functions** — discovery + presence are
answered live on the per-identity **bus** (§6B).
- **Admission gate (per-identity `auth_token`, §4.5):** every `/api/*` request carries
  the bearer `auth_token`; the broker recomputes `identity_id = trunc(SHA256(auth_token))`
  and rejects anything without a valid token with `401` before any per-identity logic — so
  randos can't reach the API to push frames or scrape state. The unguessable 128-bit
  `identity_id` + required `auth_token` *is* the anti-scanning gate; no separate app-key.
  (The web app separately gates human callers on SSO — §4.5.)
- **`POST /api/relay`** (Node, fast + die) — publish one ciphertext frame by
  **value-addressed** `resumeHook(token, frame)`: the per-identity bus token
  `bus:${identity_id}` (a wrapper's periodic `session_announce` broadcast) or a per-session
  token `sess:${identity_id}:${session_id}` (a prompt/control to one session). Gated by
  `Bearer auth_token`; **ciphertext only**.
- **`GET /api/stream?identity=… | session=…`** — subscribe: the Function resolves the
  derived token via **`getHookByToken(token).runId` → `getRun(runId).getReadable()`**
  and pipes the durable stream back as SSE (resume by `startIndex`). `HookNotFound` ⇒
  nothing connected ⇒ `200` empty. This is the **only** read path; an *offline/absent*
  identity is non-distinguishable (absent/mismatch/no-wrapper all return the same empty),
  though a *connected* identity is observable as a live stream to anyone holding its
  `auth_token`.
- **Nothing exists until RC is enabled** (lazy): a wrapper joins the bus only on first
  `/remote-control`. A machine running `remote-claw` (as claude) with RC off is
  invisible — no bus membership, no traffic.
- **Discovery + presence are live, not stored:** **connected** wrappers periodically
  **broadcast** a signed `session_announce{…, sent_at}` on the bus; a client tails it and
  shows a session online **iff its latest announce is fresh** (`sent_at` within
  `FRESH_WINDOW`), greying it locally when announces stop — client-side, no server state,
  **timestamp-driven** (§4.3/§6B). **Multiple wrappers under one identity** coexist because
  the bus is a single relay run that *owns* the hook; wrappers are publishers +
  stream-readers, not hook-owners (so no token collision).
- **Catch-up is wrapper-served, never the cloud.** A `catch_up{since=seq}` control frame
  rides the **session channel** (`sess:${identity_id}:${session_id}`) to the wrapper,
  which replays from its in-memory log (then worker backfill). No `GET /api/messages`
  history store. (The bus carries only `session_announce` broadcasts — §6B.)

### 3.3 Web client (stateless, mobile-first)
- Onboard a machine's **pass** (paste/scan, or open a link with the pass in the **URL
  fragment** `#…`, which browsers never send to the server). Load keys in-browser (WebCrypto).
- **Spaces** = **the running instances of ONE machine** — one onboarded pass = one machine, so
  the view is simply a **flat list of that machine's instances** (nothing to
  "group by": the client holds **exactly one pass at a time**). To view a different machine
  you onboard **that machine's pass** (forget + onboard), not accumulate several active at once.
  A just-onboarded machine with nothing shared shows empty until a session is `/remote-control`-ed.
  The pass persists in `localStorage` (documented risk) or memory-only (re-onboard).
- Pick a space (instance) → message view: load history (decrypt) + subscribe live
  (decrypt) + send (encrypt → POST).
- PWA, responsive; no server-side session state.

## 4. The secret & key hierarchy (token approach)

One **root secret `S`** per **machine** is the machine's master — held by the operator,
never handed to a viewer. Everything is
derived deterministically with **HKDF-SHA256** (RFC 5869), identical code on CLI
host and web client. A **viewer** receives a derived **pass** (§4.2a) — the operational
keys, not `S`. (All of §4's crypto is the **Sealed** mode; **Open** skips `seal`/`open`
entirely and ships cleartext — §2A.)

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
auth_token    = HKDF-Expand(PRK, "remote-claw/v1/auth",          32B)  → bearer to the Vercel API
identity_id   = trunc(SHA256(auth_token), 16B)                          → PUBLIC identity id = the FIRST (leftmost) 16 bytes of SHA256(auth_token); a FUNCTION of auth_token (so the broker self-verifies the bearer with NO store — hence a leaked bearer can't be revoked without changing identity_id or adding a store, §4.4)
content_root  = HKDF-Expand(PRK, "remote-claw/v1/content",       32B)  → CLIENT-ONLY master content key
control_key   = HKDF-Expand(PRK, "remote-claw/v1/control",       32B)  → AEAD key for control frames (dir:in)
K_meta        = HKDF-Expand(PRK, "remote-claw/v1/meta-frame",    32B)  → AEAD key for ALL meta frames (accepted/session_announce); their whole payload (title/cwd/identity_label/status/last_activity/sent_at) is encrypted+authenticated under it, so the broker can neither read nor forge them
```
*(One meta key. The earlier per-field `K_identity_meta`/`K_session_meta` are dropped —
names/titles ride **inside** the `K_meta`-encrypted meta frame, not as separately-keyed
fields, so there's nothing to double-encrypt and nothing left cleartext.)*
- **Confidentiality (zero-knowledge) is scoped to `content_root`/`control_key`/
  `K_meta`.** The server is given `identity_id` + `auth_token` only, never
  `S`/`PRK`/the content keys. Recovering a content key requires inverting HMAC-SHA256
  (preimage resistance) — infeasible. So the broker **cannot read message or metadata
  bodies, nor forge meta/presence frames**.
- **Self-verifying auth — NO store** (the key to "store-free", §6B).
  `identity_id = trunc(SHA256(auth_token))`, so on a request targeting `bus:${identity_id}` the broker
  recomputes `identity_id` from the presented bearer and checks it matches — **no
  per-identity `sha256(auth_token)` table, no registration**. Knowing the **public**
  `identity_id` alone never grants access (you need `auth_token`; preimage-resistant).
- **Honest scope of `auth_token`:** it's *authorization*, not confidentiality. The live
  bearer is presented on every request, so Vercel's TLS-terminating edge (and any
  request log) **sees a replayable token** — treat the broker as able to act on this
  identity's bus (publish/route), though it still **can't decrypt or forge** content/
  meta. Mitigations: never log the `Authorization` header, constant-time compare of the
  recomputed `identity_id`, rate-limit (§12), and (later) short-lived scoped tokens.

### 4.2a The pass (a viewer credential — not the master secret)
A **pass** is the artifact a viewer (phone/browser) onboards instead of `S`. It is a
serialized bundle of the four **operational keys** derived above — the **address**
(`auth_token`, hence `identity_id`), **content** (`content_root`), **command**
(`control_key`), and **presence** (`K_meta`) keys — but **not** `S` or `PRK`. It is a
distinct encoding from `rc1_` (QR/file-sized, since it carries several keys, not a single
32-byte seed).
- **One tier — read + steer.** There is **no view-only / control split**: a pass carries
  both the content key (read transcripts, see presence) and the command key (send
  prompts/interrupts/mode changes). One pass = full operation of that one machine, minus `S`.
- **What it can't do (HKDF one-wayness).** Holding the four keys never lets a pass invert
  back to `S`/`PRK` (HMAC preimage resistance), so it can **never** re-mint `identity_id`
  or **reset/re-create** the machine — those need the master secret. The hard boundary is
  the master secret / reset, **not** write-vs-read.
- **Revoke = reset the machine.** There is no per-pass revocation; you cut a pass off by
  resetting the machine (a new `S` ⇒ new `identity_id`, §4.4), which cuts off **all** passes
  for that machine at once.
- **Honest residual (symmetric-key forge).** Because content and presence keys are
  *symmetric*, a pass-holder can also **produce** valid-looking content/presence for that
  machine, not only read it — on the wire a pass is about as capable as the machine itself,
  minus `S`. Preventing a holder from injecting frames others accept as the machine's would
  need separate per-writer signing keys, deliberately omitted to keep the scheme symmetric
  and small.

### 4.3 Session → message key flow (answers "do we need a session→key flow?")
Yes — a 3-level hierarchy:
```
content_root
   └─ K_session = HKDF-Expand(content_root, "session:" + session_id, 32B)
         └─ per message:  salt = random 32B
                          K_msg = HKDF-Expand(IKM=K_session, salt=salt,
                                              info="remote-claw/v1/msg" + canonical_AAD, 32B)
                          ct = AES-256-GCM(K_msg, nonce=random 12B, AAD = canonical_AAD)
   canonical_AAD = canonical-encode(v, identity_id, session_id, dir, record_kind, seq, msg_id, client_msg_id?, key_epoch, part, parts)
                   ↑ canonical-encode is the **length-prefixed, injective** serialization defined in §8 (NOT ad-hoc concatenation)
```
*(One canonical AAD, used identically in §8: it binds **every** cleartext header field,
including `part`/`parts` (so chunk indices can't be swapped — §8) and `client_msg_id`
when present. Non-chunked frames use `part=0, parts=1`.)*
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

**Which key encrypts what (three planes).** (1) **Content** (transcript) → `K_session`,
**including an inbound `user` prompt** (`dir:in`); a `user` frame is content in *both*
directions (web→wrapper prompt and worker→web echo). (2) **Control** → `control_key`:
`catch_up`, `permission`, `interrupt`, `set_mode`, `set_model`, `command`, `end`. (3)
**Meta** → `K_meta`: `accepted`, `session_announce` (so the broker **can't forge
presence/announce** — AEAD-authenticated, not plaintext). The broker holds none of these
keys, so it can forge **nothing**; `dir` is bound into AAD, so an `in` prompt and its
`out` echo derive different `K_msg` and can't be confused. **Inbound frames** carry
`msg_id` (+ `client_msg_id` for a `user` prompt) and are replay-checked.

**Presence is timestamp-driven (Design B — §14A).** Recency comes from a **synced wall
clock**, not a client round-trip, which collapses presence to **one signed frame + one
check** (no `identify?`, no challenge, no `beat_seq`, no `wrapper_instance_id`).
- **Each session announces itself; clients subscribe.** A *session* is one `claude`
  wrapped 1:1 by its own `remote-claw` process, **independent of every other session**
  (§1) — there is no per-host aggregator, so each one publishes **its own** announce. While
  RC is on, a session (every `ANNOUNCE_INTERVAL`, and immediately on any change) broadcasts
  `session_announce{session_id, title, cwd, identity_label, status, last_activity, sent_at}`
  on the identity bus — the *whole* payload AEAD under `K_meta`, `sent_at` = the
  wrapper's wall clock **inside the ciphertext** (broker can't forge a fresh one). No
  client→wrapper request.
- **Online = a fresh announce.** A client tails the bus, builds its list keyed by
  `session_id` (globally unique, so independent sessions never collide), and treats a
  session as **online iff its latest announce is fresh** —
  `now − FRESH_WINDOW ≤ sent_at ≤ now + SKEW`. No fresh announce within the window ⇒ the client **greys** that session
  locally.
- **Concrete sizing (defaults; the only knobs).** `ANNOUNCE_INTERVAL = 20 s` (capped
  **≤ 60 s**, so the fuzz below can't balloon), `FRESH_WINDOW = 60 s` (≈3× the interval, so
  one or two dropped announces don't false-grey a live session), `SKEW = 5 s`. **Both**
  bounds must be ≥ the max expected clock skew: `FRESH_WINDOW` (the *past* edge) absorbs a
  **slow** clock so a live session isn't false-greyed; `SKEW` (the *future* edge) absorbs a
  **fast** clock so its announces aren't false-rejected. Keep `SKEW ≪ FRESH_WINDOW` so the
  worst-case false-online (next bullet) is dominated by `FRESH_WINDOW`.
- **One check defeats everything.** `AEAD-valid && in-window` rejects **forgery** (no
  `K_meta`), **replay/withhold-and-dribble** (a re-sent announce carries an old `sent_at`
  → out of window), and **stale-seeding of a fresh/late client** (same). The two-sided
  window also stops a *fast-clock* session's announces being replayable forever (future-dated
  beyond `SKEW` → rejected). No ordering/epoch machinery is needed. **Exact false-online
  bound:** replay/withhold can never *refresh* `sent_at`, so an announce hard-expires at
  `sent_at + FRESH_WINDOW`; a maximally future-skewed clock is accepted out to `now + SKEW`,
  so the **worst observed false-online for a dead session is `FRESH_WINDOW + SKEW`** (≈65 s
  at the defaults) — not exactly one window — after which it greys.
- **Restart / new session / late client just work.** A restarted session simply resumes
  broadcasting fresh announces → clients un-grey on the next one (no instance epoch). A
  newly-started session broadcasts immediately → appears. A late client reads the bus's
  **recent resumable-stream window** on subscribe (sized to span ≥ one `ANNOUNCE_INTERVAL`
  of bus events, so each live session's last announce is present); if that window already
  rolled past a session's last announce, that session renders pending/absent and appears
  within ≤ `ANNOUNCE_INTERVAL` (+jitter) on its next broadcast.
- **The one assumption, and its blast radius.** This trusts wrapper & client clocks to
  agree within ~`FRESH_WINDOW` (NTP, seconds). It is scoped to the **online dot only** —
  message **confidentiality and integrity** are fully clock-free (`K_session`/`control_key`
  AEAD), and **replay** defense is `msg_id`-based (also clock-free). The *only* place a
  clock touches the message plane is a control frame's `expiry` (§6A/§8) — a generously
  sized bound (≫ `FRESH_WINDOW`) on a *delayed-first-delivery* control command, whose worst
  case is a stale command **rejected** (availability), never a breach. A badly-skewed clock
  yields at worst a wrong dot / empty list / a send that bounces `409` — **never** a message
  breach. Residual: a replayed announce can keep a dead session shown for
  ≤ `FRESH_WINDOW + SKEW` before it greys — the price of dropping the round-trip. (A
  zero-clock-trust challenge-handshake variant is recorded in §14A if ever needed.)

### 4.4 Machine reset (a "burn", not a true rotation) & the revocation tension
Resetting a machine here is a credential **replace scoped to one machine**, not a key rotation
(rotation was cut — there is no key rotation, no forward secrecy, no epoch ratchet; the master
deterministically **re-derives** its keys, which is exactly what makes paste-to-reconnect work):
generate a **new `S`** ⇒ new `identity_id` ⇒ a **new, unrelated identity for THIS machine** (a
fresh, empty set of spaces) and **abandon** the old one. **Other machines, each with their own
secret, are untouched** — there is no fleet-wide re-onboard. There is no stable identity with a
swapped credential, and **no broker-side revocation** — see the tension below. The CLI surface is
**`--rc-identity --rc-confirm <identity_id>`** (§3.1) — there is no separate `--rc-rotate` verb,
because in a store-free, single-secret-per-machine model "resetting" *is* re-creating that machine's
identity. It is guarded (the confirm typo-check
+ a TTY, unless `--rc-force-noninteractive`) and **securely deletes** the old `S` by default:
because the same `S` deterministically re-derives the *same* keys, a retained copy is a **full live
credential** (it can still decrypt/forge any ciphertext that survives — buffered frames, the web
IndexedDB cache).

**What a reset does and does *not* do.** It moves **this machine** to a new bus; it does **not**
revoke the old one. Because the broker is store-free (§4.5), `bus:${old_identity_id}` is never torn
down and the old `auth_token` still self-verifies **forever** — anyone still holding the old `S` (or
a pass derived from it, §4.2a) keeps a live credential and can keep
subscribing to, publishing on, and forging authenticated `session_announce` on the abandoned bus.
So this is **abandonment, not revocation**: it contains a leak only for this machine's *future*
traffic (the attacker can't follow it to the new `identity_id`), and only once you reconnect the
viewers you still trust to the new identity. It
gives **no forward secrecy** for past frames and does **nothing** against a *host* compromise (the
§6 worker re-backfills claude's plaintext `.jsonl` history into the new identity, which a
host-resident attacker reads anyway). Secure-deleting *your* copy never denies an attacker who
already has theirs — reconnect the viewers you still want promptly. The blast radius is exactly
**one machine**: the others, on their own secrets, never noticed.

**Running relays re-read the secret file each turn** (the secret is never cached for the process's
lifetime), so a replace — or simply deleting/replacing the file — takes effect on an
**already-running** relay: it stops serving the now-abandoned identity the moment the file changes
(a changed secret ⇒ a different identity its in-flight sessions don't belong to; a removed secret ⇒
it stops broadcasting and its sessions age out). No stale process keeps a replaced-away identity
alive.

**The revocation tension (store-free is the constraint).** `identity_id = f(auth_token) = f(S)` and
the broker self-verifies with **no store** (§4.5), so **{ store-free · stable `identity_id` ·
revoke-a-leak } are mutually exclusive — pick two** (an information-theoretic result: a store-free
broker's admit decision is a *pure function* of the bearer, and a pure function with a fixed output
address can't have a shrinking accept-set). This holds **per machine** — each machine's identity is
its own instance of the tradeoff. To deny a leaked credential you must *either* (a) change
`auth_token` ⇒ change `identity_id` (this reset — sacrifices continuity), *or* (b) give the broker
per-identity memory (a registered admission half — sacrifices store-free). The one scoped upgrade
worth naming, spending exactly one property on purpose:

- **Server-registered split** — `S_server` (broker) + `S_paste` (user); delivers real
  paste-(content)-revocation with a stable identity, but **requires a broker store and weakens
  zero-knowledge** (the broker then holds a content-key input), and never revokes `auth_token`
  itself.

(A stable-identity *epoch ratchet* was previously sketched here; **rotation/forward-secrecy was cut**
from the design, so it is dropped. The `key_epoch` field still bound into the AAD (§4.3/§8) is a
**fixed constant** for wire stability, **not** a rotatable epoch — there is no per-frame re-keying.)

Re-encryption/migration is **moot** here: nothing durable is encrypted under `S` (history is
claude's plaintext `.jsonl`, re-backfilled — §6), so there is no at-rest ciphertext to re-key. (Cf.
the **Happy/Codex mobile app**, which *does* offer per-device revocation — but only because it is
**account-based and not store-free**: a phone-held master secret, per-machine DEKs wrapped to an
account content key, and "remove machine from account" revokes that machine's DEK server-side. That
is the asymmetric, server-stateful end of this same tradeoff — the opposite corner from our
paste-and-go, store-free `S`; see **§18** for the full comparison.) `info` labels carry `/v1/` for
future migration.

### 4.5 Web-app admission (SSO) & broker authz
Two distinct gates — and **no shared bearer baked into a public bundle**. We don't ship an
app-wide token to the browser (it can't be a secret there); instead the web app uses **proper
SSO**, and the broker authorizes per-identity off the user's own `auth_token`.

- **Web app — proper login (SSO via [Better Auth](https://www.better-auth.com)).** The web UI
  sits behind a real auth layer. We use the **Better Auth SSO plugin**, which is
  provider-pluggable: it speaks **OIDC** (auto-configured from the IdP's
  `{issuer}/.well-known/openid-configuration` discovery document), **SAML 2.0**, and OAuth2, so
  any OIDC identity provider (Auth0/Keycloak/Okta/Entra/Google/…) plugs in via
  `registerSSOProvider` with just `{issuer, clientId, clientSecret, domain}` — including
  per-organization providers and domain-based routing. A human authenticates **once** to the
  app; its **same-origin server route handlers** then call the broker. Nothing app-wide is ever
  exposed to the public bundle — there's nothing to extract. This is the coarse *"is this caller
  allowed to use this deployment"* gate (blocks bots, drive-by abuse, cost-runners), done
  honestly rather than via a leakable shared token.
- **Broker — per-identity `auth_token`, self-verifying, no store.** Every `/api/*` request
  carries the bearer `auth_token`; the broker recomputes
  `identity_id = trunc(SHA256(auth_token))` and constant-time-compares it to the requested bus (§4.2). What
  protects a *specific* identity's bus is (a) its 128-bit `identity_id` being **unguessable**
  and (b) needing the matching `auth_token` to publish/subscribe — so an anonymous rando with
  no valid `auth_token` is rejected, and **no separate app-key is needed to stop blind
  scanning**. The broker sees `identity_id` + the bearer (it *could* route/replay on a bus) but
  **can't decrypt or forge** (E2E keys, §4.2). Because admission is a pure function of the bearer
  with **no store**, the broker has **nothing to revoke** — a leaked `auth_token` is denied only by
  changing `identity_id` (a whole-identity replace, §4.4), never per-credential.
- **The CLI is headless:** the wrapper authenticates to the broker with the per-identity
  `auth_token` it derives from its secret (no interactive SSO, no app-key). `--rc-app` only
  names the broker/web origin.
- **Confidentiality unchanged:** this is *authorization*, not confidentiality — zero-knowledge
  still rests entirely on the content/meta keys (§4.2), and only in **Sealed**/**Managed** (in
  **Open** there is no encryption, by design — §2A). The broker sees only ciphertext in
  Sealed/Managed.
- **Future (stronger CLI admission): mTLS client identities.** For the headless CLI path,
  augment the per-identity `auth_token` with **mutual-TLS client certificates** so each wrapper
  (and, later, device) authenticates with its own cert — per-client, individually revocable
  admission. Deferred (cert provisioning + Vercel mTLS support add friction); the per-identity
  `auth_token` is the v1 gate, and the web app's SSO covers human admission.

## 5. Message flow (both directions, ciphertext only)

The broker keeps **no message bodies** — every frame goes through `POST /api/relay`
(bearer `auth_token`, ciphertext only) and is fanned out over the per-session
**Workflow durable resumable stream**, an in-flight buffer (not the record — §6).

**Worker → web** (assistant output): worker emits event → the wrapper's relay
**logs it (in-memory), allocates `seq`, encrypts** (`K_session`, fresh `K_msg`) →
`POST /api/relay {identity_id, session_id, dir:"out", record_kind, seq, salt, nonce, ct}`
→ ingest Fn appends to the session workflow's **out-stream** → web clients
tailing the stream decrypt & render.

**Web → worker** (your prompt): web encrypts a `user` content frame (`dir:"in"`,
`client_msg_id`, under `K_session`) → `POST /api/relay` → the workflow **hook**
wakes the wrapper → wrapper **dedups by `msg_id`**, decrypts, **commits to its log +
assigns `seq`**, **injects into Claude via the Phase-0-verified MITM downstream** (a write
to the worker `/worker/events` path — see [`phase0-findings.md`](phase0-findings.md)), and emits
`accepted{client_msg_id, seq}` on the out-stream. The frame is **logged before the inject**,
so an inject that fails after log-commit is simply **re-injected** (the log is authoritative;
no rollback, `msg_id` keeps it idempotent). Claude replies → the worker→web path above.

**History is wrapper-served, never read from the cloud.** A client gets backlog by
sending an encrypted `catch_up{since=seq}` control frame (§6), **not** from any
`/api/messages` store (there is none). For live tailing: read by `seq`, dedupe by
`msg_id`, order by `seq` (broker delivery is at-least-once, not FIFO — §6).

## 6. The durable spine + persistence + realtime (the core decision)

Verified Vercel facts that shape this:
- **Workflows (GA 2026-04-16)** give durable runs, `defineHook`/`resume` for
  inbound events, and **durable resumable streams** (reconnect by `runId` +
  `startIndex`) — Vercel-native, no separate pub/sub. **But:** completed-run
  retention is **Hobby 1d / Pro 7d / Ent 30d**, per-run caps are **2 GB / 25k
  events / 10k steps**, and replay degrades past ~2k events. ⇒ a single
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
*actually verified* is the cursor-paginated
`GET /v1/code/sessions/{id}/events?sort_order=&cursor=` API. The design below relies only on that + the wrapper's own
log — never on an unproven replay primitive. See §14.)

- **The durable record is claude's on-disk session; the wrapper's log is
  in-memory.** The wrapper sees every frame both directions and keeps an
  **in-memory per-session log** (keyed by `seq`) as the live catch-up source. It is
  **not** persisted: both wrapper and CLI are stateless, and the in-memory log is
  rebuilt from claude on (re)connect (next bullet). The authoritative transcript is
  claude's own `~/.claude/projects/.../<session>.jsonl`.
- **History (and recovery) comes from claude, reseeded by the worker backfilling
  `historical` frames to OUR relay** on RC connect (Phase 0 observed
  `historical: true` events arriving at the relay; reconnect-reseed hardened in P4). The local
  `~/.claude/projects/<cwd>/<session>.jsonl` transcript is a last-resort fallback.
  We do **not** use Anthropic's `/events?cursor=` (we're off Anthropic's relay —
  §14). The TUI owns sessions and `seq` ordering; **the cloud stores no history.**
  - **Backfill = `historical:true` frames, then completeness check.** The backfill is
    the worker's stream of events flagged `historical:true`; it is **complete** when that
    stream **transitions to live** (the RC backend sends history first, then live frames)
    **and** the wrapper's logged `historical` count matches claude's on-disk `.jsonl`
    transcript length (the authoritative record). Until both hold, the backfill is treated
    as **partial → retried** (re-read the worker stream / `.jsonl`), **never served** and
    **no `session_announce` is broadcast** — so a truncated/failed backfill can't leave an
    incomplete log or a gap in the `msg_id` seen-set (which would let a broker replay
    double-deliver, §15 #19). Only a verified-complete log unlocks bus join + broadcast (P4).
- **`seq` is allocated solely by the wrapper.** Clients never assign transcript
  order: a web client sends a `client_msg_id`; the wrapper decrypts, commits to its
  in-memory log, assigns the canonical `seq`, then echoes an `accepted{client_msg_id, seq}`.
  Clients retry until `accepted`; the wrapper forwards a prompt to Claude **only
  after** its log commit (so POST-accepted-by-broker ≠ delivered).
- **Replay/idempotency:** delivery is at-least-once and the broker can *replay a
  valid old ciphertext*, so the wrapper keeps an **in-memory seen-set** (rebuilt on
  reconnect with the log) and drops duplicates **before** any side effect. The seen-set
  key is `msg_id` for whole frames and **`(msg_id, part)`** for chunked ones (so a
  replayed middle chunk is dropped without stalling reassembly, §8). `msg_id` and
  `client_msg_id` are **CSPRNG-unique** per send (never client-local counters), so two
  clients can't collide. **The wrapper is a single process owning one session (§1)**, so
  for every inbound frame the sequence **dedup-check → record `msg_id` in the seen-set →
  log → allocate `seq` → side effect** runs as one serial critical section in that process
  — no distributed lock, no concurrent-hook race. Recording `msg_id` **before** the side
  effect (true for content *and* control frames) is what lets a post-restart rebuild from
  the log reject a replay; a replayed `catch_up` is likewise dropped **before** any history
  is re-streamed.
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
offline). Offline history-browsing (and any durable store) is **deferred** — §6C.

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
`dir`: **out** = wrapper→web, **in** = web→wrapper. **Three AEAD keys** (§4.2):
**content** → `K_session` (transcript); **control** → `control_key` (control plane);
**meta** → `K_meta` (`accepted`/`session_announce`). Every frame is AEAD-authenticated —
the broker forges nothing.

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

Control frames (**in** — web client → wrapper → worker, on the **session** channel;
encrypted under **`control_key`**, carry `msg_id` + `expiry` (both **inside** the
ciphertext, §8), replay-checked). **Replay defense is the `msg_id` seen-set (clock-free);**
`expiry` is only a generously-sized staleness bound (≫ `FRESH_WINDOW`) on a frame the broker
*withheld then released late* — the one clock touch on the message plane, whose worst case is
a stale command **rejected** (availability), never a breach (§4.3):
| kind | maps to RC verb | notes |
| --- | --- | --- |
| `catch_up` | — (ours) | request history `since=seq` |
| `permission` | `control_response` | allow/deny a `can_use_tool` |
| `interrupt` | `interrupt` | ESC / stop the current turn |
| `set_mode` | `set_permission_mode` | e.g. bypassPermissions toggle |
| `set_model` | `set_model` | switch model |
| `command` | (slash) | `/compact` `/clear` `/context` … |
| `end` | `end_session` | terminate the session |

**Ordering & acknowledgement (control plane is not FIFO).** Each control frame is an
**independent, idempotent** command applied on arrival (deduped by `msg_id`); the broker may
reorder, so a client that issues **order-dependent** controls **serializes** them — it sends
the next only after observing the prior's effect on the out-stream (e.g. wait for the
`interrupt` to land before toggling `set_mode`), so a reorder window can't invert them. A
rejected control frame (expired or replayed) simply produces **no effect**; the client's
contract is **bounded timeout + retry** (as content frames "retry until `accepted`") — e.g.
a `catch_up` that yields no `historical`/live frames within the timeout is re-sent with a
fresh `msg_id`/`expiry`. (An explicit `nack{msg_id,reason}` meta frame is a possible future
nicety; not required for correctness.)

Our non-content meta frames (**AEAD under `K_meta`** — broker can't forge them):
| kind | dir | notes |
| --- | --- | --- |
| `accepted` | out | wrapper ack of a client frame: `{client_msg_id, seq}` |
| `session_announce` | out (bus) | the **periodic broadcast** that is *both* discovery and presence: `{session_id, title, cwd, identity_label, status, last_activity, sent_at}`, whole payload AEAD under `K_meta`. Each **independent session** broadcasts **its own**, one per `ANNOUNCE_INTERVAL` (§4.3) + on change; a client keys by `session_id` and treats the session **online iff its latest `sent_at` is within `FRESH_WINDOW`** (timestamp-driven, §4.3). No client request, no challenge/`beat_seq` — a replayed/withheld announce has a stale `sent_at` → ignored. |

(`historical` is a **flag** on replayed content frames, not a separate kind. There is
**no** server-side `heartbeat`/registry and **no** `identify?`/`present` — presence is a
fresh, signed `session_announce` within the window, greyed client-side on staleness.)

### Channels (two kinds, both addressed by a derived token — §6B)
- **identity bus** (`bus:${identity_id}`): one relay run per identity, **identity-level
  only**. Wrappers **periodically broadcast** `session_announce` via `resumeHook`; clients
  tail it via `getHookByToken→getReadable` and compute presence from `sent_at` freshness.
  **Discovery + presence only** — pure push, no client request, no control/turn frames.
- **per-session stream** (`sess:${identity_id}:${session_id}`): the session's durable
  resumable out-stream for live turn frames (high volume — bypasses the event cap) + an
  inbound hook for **all per-session traffic** — prompts, `catch_up`, permissions, RC
  verbs. Resolved the same way (token → run).
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
RC enabled → the session's wrapper joins the identity **bus** (`bus:${identity_id}`), starts
**broadcasting its own `session_announce`**, + opens its per-session stream.
Live turn → `assistant`/`result` flow the session out-stream, `user` arrives via the
session hook; clients tail; wrapper logs + echoes `accepted`. Brief reconnect (web or
wrapper) → resume by `seq`/`startIndex`. Gap older than the buffer / cold device →
`catch_up` → wrapper replays from its log (or worker backfill). A client opening cold →
tails the bus + reads the recent window → sees the latest (fresh) `session_announce`s.
Session ends / wrapper exits (it never outlives the CLI) → it stops broadcasting → its
announces age out of `FRESH_WINDOW` → clients grey then drop those sessions; nothing is
lost because claude holds the transcript.

## 6B. The per-identity bus & fresh-browser cold start

The "registry" is **not a stored table** — it's a **per-machine message bus** (one per
`identity_id`, which is now a machine id). Every
**connected** session (an independent `remote-claw` process on that machine)
**periodically broadcasts** its own signed `session_announce`; a client tails the bus, keys
by `session_id`, and renders the live list, treating a session **online iff its latest
announce is fresh** (`sent_at` within `FRESH_WINDOW`) and **greying it locally** when
announces stop arriving — so the user sees it go away in real time (client-side only, no
server state — distinct from the deferred offline *listing*, §6C). **Timestamp-driven
presence** (§4.3) — no client request, no challenge, no `beat_seq`: a replayed/withheld
announce carries a stale `sent_at` → ignored.
**Channel split:** the **bus** carries only `session_announce` broadcasts; all per-session
traffic — prompts, turn frames, `catch_up`, permissions, RC verbs — flows on that
session's own channel (`sess:${identity_id}:${session_id}`), so the bus stays low-rate.
(Settled by a research→design→verify panel against the SDK type defs — §13/§14A.)

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

- **Creation is explicit `start()`, not `resumeHook`.** The first wrapper to enable RC
  for an identity calls **`start()`** to create the bus run, which immediately
  `createHook("bus:"+identity_id)` (custom token — verified, §13). `resumeHook` only *wakes*
  an existing run; it never creates one (verified). So a wrapper coming online does
  **resume-or-start**: try `getHookByToken`/`resumeHook`; on a missing/dead run `start()`
  then retry **with bounded exponential backoff + jitter** (**50 ms base, ×2, ≤2 s ceiling,
  ±25% jitter**). One bus per identity is **enforced by the SDK**: hook tokens must be unique
  across all running workflows, and a duplicate `createHook` on a held token throws
  **`HookConflictError`** (`@workflow/errors`; verified in the bundled SDK docs, §13) — so the
  create-race loser deterministically catches it and resume-tails the winner; the loser
  resume-tails the winner.
- **Long-lived; durable, no idle reaper (verified §13).** The bus run loops awaiting its
  hook. Vercel sets **no max run duration and no idle-timeout** — a suspended run waits
  **indefinitely** and **consumes no compute while idle** (only storage-retained billing).
  The run is **shared by all of the identity's sessions** (each publish just emits a
  `hook_received` event and resumes it); `getHookByToken` keeps resolving and `start()`'s
  random runId is irrelevant because the **token** is the durable address. **Consequence:**
  when the last session leaves, the bus run does **not** auto-end — it simply goes quiet and
  the token stays resolvable; a cold client then reads the recent window, finds **no fresh
  announce**, and renders empty (presence is "fresh announce," not "bus exists" — below), so
  a lingering idle bus is harmless. The run therefore ends in just **one** way in normal
  operation: (ii) **deliberate cap-roll** (below). *Optional* self-cleanup: to free the token
  on inactivity we can race the hook against a **durable `sleep`** (the documented pattern for
  a hook timeout, vercel/workflow#553) and complete the run if no publish arrives for, say,
  a few `ANNOUNCE_INTERVAL`s — but it's not required for correctness. ("Holds the hook"
  elsewhere = the run stays alive awaiting its hook; no wrapper owns it.)
- **Cap-roll protocol.** Because each inbound publish is an event, before the bus nears
  the 25k-events/run cap a connected wrapper **completes** the current run (which
  **closes its stream and disposes the hook → frees the token**), then immediately
  `start()`s a fresh run (re-`createHook("bus:"+identity_id)`); if two wrappers race, one
  wins and the loser catches **`HookConflictError`** (SDK-enforced unique tokens, §13) and
  resume-tails the winner. **No new frame kind is needed: tailing clients (and wrappers) see
  the stream EOF**, reconnect `GET /api/stream?identity=…` → `getHookByToken` now resolves the
  new run → re-tail (and wrappers resume broadcasting; a brief `HookNotFound` during the swap
  → retry). Open **per-session** chats are untouched (separate runs). So "the bus never
  completes *except* on a **deliberate roll**" (there is no idle-timeout — §13 — so an idle
  bus just persists) — the token is always either live or re-creatable, and the bus still
  carries only `session_announce` broadcasts.
- **"Online" = a fresh announce, not mere bus existence.** A resolvable bus only means *a*
  wrapper once created it; the client treats a session as online iff it holds a
  `session_announce` whose `sent_at` is within `FRESH_WINDOW`. `HookNotFound` and "bus
  resolves but no fresh announces" both render empty.
- **Browser path.** `getHookByToken` needs server-side World credentials, so the browser
  doesn't call it directly — it hits our **`GET /api/stream?identity=…`** Function, which
  resolves the token and pipes the run's stream back as SSE (gated by `Bearer auth_token`).

So the durable cloud "registry" is **nothing**: no rows, no presence keys, no pointer.
State lives on the bus (announced live) and with claude (transcript via `catch_up`).

### State layers — what persists where
| layer | lives in | durable? |
| --- | --- | --- |
| **transcript (the record)** | claude `.jsonl` + wrapper in-memory log | host-side |
| **the bus** (identity-level: discovery + presence only) | **one Workflow run per identity**, addressed by token `bus:${identity_id}` | ephemeral (rolls; idle-persistent) |
| **per-session live frames** (high volume) | per-session Workflow out-stream | ephemeral |
| **functions** | — | **none** |

"**The server is stateless**" holds *maximally*: there is **no store at all** for the
registry — the bus is reached by a derived token, not a stored id.

### Cold-start sequence (paste pass → live list)
Computed live from the bus — **no store, no enumeration, no request, lazy** (nothing
exists until a wrapper enables `/remote-control` and starts broadcasting):
1. **Load the pass (no network).** Parse/validate the machine's **pass**; load its four
   operational keys (`auth_token` → `identity_id`, `content_root`, `control_key`, `K_meta`,
   §4.2a) — no HKDF, no `S`. The pass never leaves the device.
2. **Subscribe to the bus.** `GET /api/stream?identity=identity_id`
   (`Bearer auth_token` — broker recomputes `identity_id=trunc(SHA256(auth_token))` and
   checks it matches, §4.2). The Function `getHookByToken("bus:"+identity_id)` →
   **HookNotFound ⇒ no bus ⇒ nothing connected ⇒ `200` empty**; else
   `getRun(runId).getReadable({startIndex:recent})` → SSE, **reading the recent stream
   window** — sized to span ≥ one `ANNOUNCE_INTERVAL` of bus events so each live session's
   last (still-fresh) `session_announce` is present and arrives at once. (If the window
   already rolled past a session's last announce, that session simply appears within ≤
   `ANNOUNCE_INTERVAL` (+jitter) on its next broadcast — a brief gap, not a miss.)
   (Offline/absent/mismatch all return the same empty, so status never leaks an *offline*
   identity; a *connected* one is observable to anyone holding its `auth_token`.)
3. **Render — pure subscribe, no ask.** For each `session_announce{…, sent_at}` (AEAD
   `K_meta`) whose `sent_at` is within `FRESH_WINDOW`, decrypt and add/refresh the session;
   stale (out-of-window) announces are ignored. The list fills from the recent window
   immediately and stays fresh from the wrappers' periodic broadcasts + on-change ones.
   No client→wrapper request is ever sent.
4. **Open a chat.** Tap a session → subscribe to **its per-session stream**, addressed by
   the **derived token** `sess:${identity_id}:${session_id}`
   (`GET /api/stream?identity=…&session=…` → `getHookByToken`→`getRun`→`getReadable`) + send
   `catch_up{since}` for history. High-volume turn frames flow there, **not** on the bus.

### Live greying (timestamp-driven, client-local)
While RC is on, each **independent session** (its own `remote-claw` process) **broadcasts**
`session_announce{…, sent_at}` on the bus every `ANNOUNCE_INTERVAL` (=20 s default, §4.3) +
immediately on change, AEAD under `K_meta` (`sent_at` = wrapper wall clock, inside the
ciphertext). A client keeps, per `session_id`, the freshest valid `sent_at` it has seen, and
shows the session **online iff that `sent_at` is within `FRESH_WINDOW`**
(`now − FRESH_WINDOW ≤ sent_at ≤ now + SKEW`; `FRESH_WINDOW = 60 s`, `SKEW = 5 s`, §4.3). When broadcasts stop
(host sleeps/crashes), the freshest `sent_at` ages past the window → the client **greys** it
— visibly "goes away"; when it resumes, or a new session starts, the next fresh announce
**un-greys/adds it automatically** — no request, no epoch, no `beat_seq`.
**Replay/withhold-proof:** a re-sent or hoarded announce carries an old `sent_at` → out of
window → it can neither keep a dead session green (beyond the **`FRESH_WINDOW + SKEW`** fuzz,
§4.3) nor seed a fresh client (§4.3). **Purely client-side** (no server state); it does
**not** resurrect offline *listing* — a fresh browser still won't see a session never
connected this run (deferred store, §6C). Cost: each session's announce is a bus **event**
(one per session per interval, broadcast even when no client is watching) → they nudge the
bus toward a roll, so keep high-volume turn frames on per-session streams (cap-free) and the
interval generous (§12).

### Honest caveats (verified — §13)
- **Online-only by design.** No connected wrapper ⇒ empty list (a sleeping/closed host
  shows nothing on a fresh open). Intended this phase — "connected wrappers broadcast
  themselves"; live greying (above) covers a session *leaving* while you watch. Offline
  *listing* across cold starts is **deferred** (§6C).
- **Presence is timestamp-driven** (§4.3): correctness of the *online dot* assumes
  wrapper/client clocks within ~`FRESH_WINDOW` (NTP), and a dead session can show online for
  ≤ `FRESH_WINDOW + SKEW` (≈65 s at defaults) before greying. Scoped to the dot only — never
  message security (§12).
- **Two-call composition** (`getHookByToken`→`getRun`→`getReadable`): each call is
  **docs-confirmed** (§13) — incl. the `getRun(id).getReadable({startIndex})` reconnect in
  the resumable-streams guide — but the *cross-process bus wiring* (resolve a derived token to
  another process's runId, then tail it) is **our** composition, so it's a P3 integration
  check, not a re-derivation.
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

## 6C. Deferred: offline listing & durable stores

**Out of scope this phase.** The bus (§6B) is intentionally **online-only and
store-free** — a host that isn't connected simply doesn't appear. *If* greyed-offline
rows (a chat staying listed while its host sleeps) or offline history browsing are ever
wanted, a small durable store could be added then. We investigated the options (Upstash
Redis / Vercel Blob / Neon; Edge Config doesn't fit) and they're viable, but adding any
of them now would pollute a deliberately lean design — **explicitly deferred.**

## 7. Identity, "spaces" & onboarding (one machine at a time)
Hierarchy: **machine (identity_id) → its spaces (each space = one claude instance =
one chat).** A space is *not* a container of sessions — it **is** one session.
- The onboarded pass = one **machine**; **each claude instance on it = one
  space (chat)**. The client holds **exactly one pass at a time** (no multi-machine
  list) and renders that machine's spaces with decrypted friendly names (default hostname
  for the machine, claude's generated title for each space — both from the `K_meta`
  `session_announce`; rename is a **client-local alias** this phase, §1A/§6C). One pass
  surfaces that **one machine's** every chat at once; to watch a second machine you onboard
  *its* pass too (one active at a time).
- **Switch machine:** onboard a different machine's pass to **replace** the current one — its
  keys load, the prior pass is forgotten from the device (§1A E),
  and the client subscribes to the new machine's **bus** (`GET /api/stream?identity=…`) →
  its connected sessions' broadcast `session_announce`s populate its spaces (§6B).
- Spaces are listed gchat-style (encrypted title + last-activity, online dot), all under
  the one active machine. Routing metadata (`identity_id`, `session_id`, timestamps,
  sizes) is unavoidably visible to the broker — minimized and documented.

## 8. Data model / API (sketch)
**No durable cloud store** in the core design — discovery, presence and session
metadata live on the per-identity **bus** (§6B), encrypted; the only persistent record
is claude's on-disk transcript (host-side). The session's encrypted name/title/cwd ride
in its `session_announce` frame on the bus, not a stored row. (Offline listing /
durable stores are **deferred** — §6C.)

Transient relay **frame** (rides the bus / a session stream — never a durable row):
```
{ v, identity_id, session_id, dir, record_kind, seq|null, msg_id, client_msg_id?,
  key_epoch, salt, nonce, ct, part?, parts? }   // ct includes the GCM tag
AAD = canonical-encode(v, identity_id, session_id, dir, record_kind, seq, msg_id, client_msg_id?, key_epoch, part, parts)   // identical to §4.3 canonical_AAD
```
**Chunking (size limits, §6B).** A payload over a **hook** (inbound `POST /api/relay`,
the Vercel Function body) is capped at **4.5 MB**; a **stream chunk** (outbound
`writer.write`) at **10 MB**. A message whose plaintext would exceed the limit is split
into `parts` **independently-AEAD'd chunks** sharing one `msg_id`, each its own frame with
its own `salt`/`nonce` and `part` (0-based) bound into AAD. The receiver **decrypts each
chunk on arrival** (AEAD-verifying `part`/`parts`/`msg_id`), then reassembles the
**plaintext** in `part` order once all `parts` are present — so a forged/replayed chunk
fails AEAD before it can corrupt the buffer. **Replay dedup for chunked frames keys on
`(msg_id, part)`** (§6), so re-sending one chunk is dropped without stalling the others'
reassembly. Use ~8 MB targets for headroom. Applies to large assistant output and full
`catch_up` replays (over session streams). **`catch_up` is idempotent:** history is
immutable and `seq`-addressed, so even a re-served range is deduped by `seq` at the client —
re-serving never corrupts the transcript.

`record_kind` ∈ (aligned with §6A):
- **content** (AEAD under `K_session`): `user` · `assistant` · `result` · `system` ·
  `status` · `rate_limit` · `can_use_tool` — carry `seq`; `user` may be `dir:in`
  (prompt, with `client_msg_id`) or `dir:out` (echo, optional `historical:true`).
- **control** (AEAD under `control_key`, `dir:in`, on the **session** channel,
  replay-checked by the `msg_id` seen-set): `catch_up` · `permission` · `interrupt` ·
  `set_mode` · `set_model` · `command` · `end`. The control payload (e.g. `catch_up`'s
  `since`, and an `expiry`) lives **inside `ct`** — AEAD-authenticated by the GCM tag, **not**
  an envelope/AAD field — so the broker can't read or alter it. `expiry` is only a generously
  sized staleness bound on a *withheld-then-released-late* command (the lone clock touch on
  the message plane; worst case = a stale command rejected, never a breach — §4.3/§6A); the
  clock-free `msg_id` seen-set is the actual replay defense.
- **meta** (AEAD under `K_meta`, `dir:out`): `accepted` `{client_msg_id, seq}`;
  `session_announce` (bus, the **periodic broadcast**)
  `{session_id, title, cwd, identity_label, status, last_activity, sent_at}` — **the whole payload is inside the
  ciphertext**, so the broker reads none of it.

AAD binds **every** cleartext header field via a single canonical serialization
(length-prefixed or CBOR) — no ad-hoc `a|b|c` concatenation (ambiguous). The presence
fields (`sent_at`, names/titles/status) live **inside** the `K_meta` payload, not the
cleartext header. Presence replay-protection (§4.3) is **one check**: a `session_announce`
counts only if AEAD-valid **and** `sent_at` is in-window
(`now − FRESH_WINDOW ≤ sent_at ≤ now + SKEW`) — a replayed/withheld announce carries a stale `sent_at` and is ignored (worst
dead-session false-online = `FRESH_WINDOW + SKEW`, §4.3).

Presence is **not stored on the server**: a session is online iff its own broadcast
`session_announce` is **fresh** (`sent_at` in-window); a client **greys it locally** when
that session's announces stop, and the next fresh broadcast un-greys/adds it automatically
(§6B). No server-side `heartbeat`/`last_seen`; `last_activity` (in the decrypted announce)
drives client-side "most-active first" sorting.

Endpoints — **just two** (both gated by `Bearer auth_token` §4.5, self-verifying,
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
   registry. Offline listing / history browsing (and any durable store) is **deferred**
   (§6C).
2. **Realtime transport → Vercel-native only (no third party).** SSE from a
   streaming Function backed by the Workflow durable stream; client
   reconnects and resumes by `seq` (gaps refilled by the wrapper's `catch_up`).
   Plain polling of the same buffer (`GET /api/stream?identity=…&session=…&since=seq`, non-streaming) is
   the trivial fallback. No Ably/Pusher.
3. **Browser secret storage → `localStorage` + "forget" button** (with a clear
   risk warning); PIN-wrapped storage is a later option.
4. **Web framework → Next.js on Vercel** (assumed; confirm if not).
5. **CLI shape → one transparent passthrough wrapper, not subcommands** (§3.1).
   `remote-claw` *is* `claude` (all args forwarded); a reserved `--rc-*` namespace
   is consumed by the wrapper (`--rc-identity` does identity work). No `serve`.
6. **API admission → SSO (web) + per-identity `auth_token` (broker).** The web app
   gates human callers behind **proper SSO** (Better Auth SSO plugin — OIDC via the IdP
   discovery document, plus SAML 2.0 / OAuth2); the broker authorizes each `/api/*` call
   off the bearer `auth_token` alone (`identity_id = trunc(SHA256(auth_token))`), and the
   unguessable 128-bit `identity_id` + required `auth_token` *is* the anti-scanning gate —
   no separate app-key (§4.5). No confidentiality role.
   Future option: mTLS client identities for per-client revocable admission.
7. **Nothing remote until RC is enabled** (lazy). Running `remote-claw` like `claude`
   sends nothing to the broker; only on first `/remote-control` does the wrapper join
   the identity bus and become discoverable (§3.2, §6B, §15 #2).
8. **Registry → a per-identity value-addressed bus, NO store** (§6B). A Workflow can't
   be a queryable index, but `getHookByToken("bus:"+identity_id)` resolves a derived
   token → run → stream (verified in the SDK types, §13/§14A), so discovery + presence
   are answered **live** by connected wrappers on the bus — no rows, no presence keys,
   no pointer. Two endpoints total (`/api/relay`, `/api/stream`). Online-only by design;
   offline listing (and any durable store) is **deferred** (§6C).

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
  `--rc-identity` (idempotent `O_CREAT|O_EXCL` create-once into the single local secret
  file, derive ids, print `rc1_…` + optional `--rc-app` QR/deep-link; host registration
  deferred to first RC; and `--rc-confirm <identity_id>` to **replace** it — secure-delete +
  re-create, §4.4), `--rc-file` (use a specific secret file), `--rc-show-secret`,
  `--rc-json/--rc-quiet` (never emit `S`). **Depends on P1 `clawsec`** for all key work (HKDF derivation +
  `rc1_` parse/checksum); also wires the broker config (the `--rc-app` origin,
  §3.1/§4.5) used later in P4. Local only (mock app); unit-test the token
  classifier + the create-once/never-reveal/secure-delete invariants.
- **P3 — Vercel app skeleton (the bus).** `apps/web` (Next.js): **per-identity bearer
  auth (recompute `identity_id = trunc(SHA256(auth_token))` from the bearer, constant-time
  compare to the target token — **no stored hash**, §4.2)** in front of the **two** routes
  (`POST /api/relay`, `GET /api/stream`) — the unguessable `identity_id` + required
  `auth_token` is the anti-scanning gate, no app-key; SSO gates the web UI separately
  (Better Auth SSO plugin, §4.5); the
  per-identity bus relay workflow (`bus:${identity_id}` hook + out-stream) and the
  token→stream resolver (`getHookByToken→getRun→getReadable`); **per-session runs are
  resume-or-`start()`ed exactly like the bus** (first inbound/out frame on
  `sess:${identity_id}:${session_id}` creates the run + hook; same 1:1-token / backoff rules
  as §6B). Deploy; curl the cold-start (subscribe → recent-window `session_announce`
  broadcasts) + a relay round-trip with hand-rolled ciphertext.
  **First, a small build-time spike — ✓ RAN & PASSED on Vercel 2026-06-08 (§14A).** Most of
  the §6B linchpins are now **docs-confirmed** (web-verified 2026-06-08, §13) *and
  empirically verified* on a throwaway deployment — `getHookByToken→getRun→getReadable`, custom hook tokens,
  `resumeHook` (resume-not-create), negative-`startIndex` recent window, stream-writes-bypass-
  events, no-max-run-duration/idle-free, no caller-chosen `runId`, and the caps. So the spike
  is now a **pure integration smoke-test** — every primitive (incl. the duplicate-token
  conflict) is docs-confirmed (§13), so this just proves *our wiring* on real infra (pin
  `workflow`/`@workflow/*`):
  1. End-to-end **`getHookByToken→getRun→getReadable` from an API route** with server World
     creds (each call is documented; the cross-process composition is ours to wire).
  2. **`getReadable({startIndex:-N})`** delivers the last *N* chunks and keeps streaming new
     ones — pick *N* so the window spans ≥ one `ANNOUNCE_INTERVAL`; a rolled/short window
     degrades to ≤ `ANNOUNCE_INTERVAL` latency, not a miss (negatives + `getTailIndex()`
     docs-confirmed §13; note: live-stream pagination over negatives isn't exact — fine for
     "recent," §13).
  3. **One-bus-per-identity**: a duplicate `createHook` on a held token throws
     `HookConflictError` (docs-confirmed §13) → confirm the create-race loser catches it and
     resume-tails. (No idle-timeout exists, §13 — the run persists; only the cap-roll frees the token.)
  4. **Cap-roll handoff** observable: readers see stream **EOF** on the old run's completion
     and `getHookByToken` resolves the new run after re-`start()`; brief `HookNotFound` → retry.
  5. Browser path: `GET /api/stream` obtains World creds (per-request vs cached — measure),
     pipes SSE within the Function `maxDuration` (300s Hobby / 800s Pro, §13 — reconnect by
     `seq` past it); `HookNotFound` ⇒ `200` empty.
  6. Size/chunk limits (hook ≤ 4.5 MB, stream chunk ≤ 10 MB, payload ≤ 50 MB) + `(msg_id, part)` dedup.
- **P4 — CLI: `serve` behavior = relay on `/remote-control` (MITM — §14).** Node/TS
  reimpl of the Phase 0 interception: `remote-claw` runs the real interactive
  `claude` (full passthrough) and, when RC is enabled, points it at our local MITM
  (`HTTPS_PROXY` → our proxy with a trusted leaf cert; intercept `/v1/code/sessions*`;
  pass `/v1/messages` through to Anthropic for inference). Our relay is the RC
  backend — Anthropic's RC relay is never used. Then, in order: **commit the worker
  backfill to the in-memory log + seen-set first** (detect completeness — §6 backfill
  rule), **then join the identity bus** (resume-or-`start()` `bus:${identity_id}`) **and open
  the per-session run/out-stream** (`sess:${identity_id}:${session_id}`, resume-or-`start()`),
  and only then **periodically broadcast** a signed `session_announce{…, sent_at}` for the
  session; per frame log it, allocate `seq`, encrypt → `POST /api/relay` (with
  `Bearer auth_token`) on the session token; subscribe inbound (SSE) → dedup by `msg_id` → decrypt →
  deliver to Claude only after log commit, then echo `accepted`. End-to-end: a curl "web"
  drives a real Claude session through Vercel.
- **P5 — Web client.** Paste/fragment secret, identity + spaces list (each space =
  a chat), message view (history + live), send. Mobile/PWA.
- **P6 — Multiple machines + polish.** Onboard several independent machines (each its own
  secret), friendly names, reconnect/resume, replay from `since=seq`, machine reset, error states.
- **P7 — Hardening + review.** `/code-review` + codex pass (as in Phase 0):
  auth/abuse on ingest routes, replay-window correctness, at-least-once dedupe,
  rate-limiting, secret-handling hygiene.

## 12. Risks / inherited fragility
- **Anthropic RC interception** (the Phase 0 MITM of `/v1/code/sessions`, pinned to
  `claude` 2.1.168) underpins v2 too — it can break or be re-gated on any Claude
  upgrade. Keep the capture tool (`mitm/capture-proxy.py`) to re-verify.
- **One secret per machine** (one local file; override per run with `--rc-file`) is the
  **intended boundary**, not a flaw: a steal/reset blast radius is exactly **one machine**, with
  the others untouched. The honest cost is no partial/per-pass revocation — resetting a machine =
  a new identity that cuts off *all* its passes at once (§4.2a/§4.4). A viewer holds a **pass**, not
  `S`; onboarding a pass into a browser still exposes it to that device's XSS/extension/clipboard
  surface (and a stolen pass can read/steer that machine until reset). `rc1_`/pass
  high-entropy tokens trip secret scanners if pasted into a repo.
- **Web-app admission is SSO, not a baked-in token** (§4.5): the web UI sits behind the
  Better Auth SSO plugin (OIDC via the IdP discovery document, plus SAML 2.0 / OAuth2), so
  nothing app-wide is exposed to the public bundle. The broker's own gate is the
  per-identity `auth_token` (unguessable `identity_id` + required token = anti-scanning);
  it is admission, not authz/confidentiality (those stay with `auth_token`/content keys).
  Harden later with mTLS client identities.
- **At-least-once, no FIFO** from the broker ⇒ dedupe + reorder is mandatory.
- **The bus is online-only** (§6B): discovery+presence are answered by *connected*
  sessions, so an offline session shows **nothing** (no greyed rows). Intended this phase;
  offline listing is **deferred** (§6C).
- **Presence is timestamp-driven — its one assumption** (§4.3/§6B): online = a signed
  `session_announce` whose `sent_at` is in-window
  (`now − FRESH_WINDOW ≤ sent_at ≤ now + SKEW`). This **assumes wrapper/client clocks are NTP-synced within ~seconds**;
  concretely (§4.3) `FRESH_WINDOW = 60 s`, `SKEW = 5 s`, `ANNOUNCE_INTERVAL = 20 s` (capped
  ≤ 60 s), with **both** `FRESH_WINDOW` and `SKEW` ≥ max expected skew and
  `SKEW ≪ FRESH_WINDOW`. A replayed/withheld announce carries a stale `sent_at` → ignored, so the
  broker can't resurrect a dead session beyond a **`FRESH_WINDOW + SKEW`** fuzz (≈65 s). The
  assumption's **blast radius is the online dot only** — message **confidentiality/integrity**
  are clock-free (`K_session`/`control_key` AEAD) and **replay** defense is `msg_id`-based
  (clock-free); the lone clock touch on the message plane is a control `expiry` (a stale
  command is rejected — availability, never a breach, §6A/§8). A badly-skewed clock degrades
  to a wrong dot / empty list / a send that bounces `409`, **never** a message breach. (A
  zero-clock-trust challenge-handshake variant is recorded in §14A if ever needed.)
- **`getHookByToken→getRun→getReadable` is a verified-by-types but undocumented-as-a-
  pattern composition**, and the run-roll **hook re-bind** has a brief `HookNotFound`
  window → client retry. Both are P3 spike items (§11); a stale resolve is at worst
  "reconnect + `catch_up`," never a wrong attach.
- **Bus run never auto-frees its token** (verified §13: no idle-timeout, no max run
  duration): a bus run, once started, lives **indefinitely** (idle = free compute, but
  storage-retained is billed), so the token stays held even with no connected sessions. This
  is benign — a cold client just sees "no fresh announce → empty" — and the token is freed
  only by the **cap-roll** (deliberate complete + re-`start()`). If we want idle buses to
  self-clean, race the hook against a durable `sleep` (§6B). One-bus-per-identity is
  SDK-enforced (a duplicate `createHook` on a held token throws `HookConflictError`,
  docs-confirmed §13 — the create-race loser catches it and resume-tails).
- **Workflow per-run caps** (25k events / 10k steps / 2 GB; replay degrades past
  ~2k events): each **inbound publish is an event**, so the bus **rolls** before the
  cap (re-creating `bus:${identity_id}`); keep high-volume turn frames on per-session
  **out-streams** (stream writes bypass the event cap, billed as Data Written) so rolls
  stay rare. Quantify Events vs Data-Written per active identity before scaling.
- **Metadata leak:** the broker sees the cleartext **routing header** (`identity_id`,
  `session_id`, `dir`, `record_kind`, `seq`), plus frame **sizes/timing** and the
  `session_announce` **broadcast cadence**. Everything *inside* a frame — titles/cwd/
  status/last_activity/identity_label as well as message bodies — is AEAD-encrypted
  (`K_meta`/`K_session`/`control_key`), so the broker reads none of it. Not fully
  metadata-private (it still learns which `session_id`s exist + activity timing); salt
  `session_id`s + pad/normalize sizes later if that matters.
- **Counter/nonce safety:** resolved by per-message HKDF subkeys (§4.3); do **not**
  regress to a shared counter nonce with stateless/multi-device senders.
- **Vercel Queues / WDK surface** still moving (Queues beta); Workflows GA is
  stable — pin SDK versions, isolate behind a thin transport interface. The §6B caps,
  retention, stream-event-bypass and the API primitives are now **web-verified against the
  live docs** (§13, 2026-06-08) — incl. `HookConflictError` on duplicate tokens; only the
  *integration* (our cross-process token→stream wiring) remains a P3 smoke-test, and SDK
  versions can still drift — re-confirm at build (§11 P3).
- **Relay flooding / DoS.** The broadcast model removes the old `identify?`
  request-triggered fan-out (no client request exists), but any caller holding a valid
  `auth_token` can still `POST /api/relay` junk. Mitigate with a broker-side per-`identity_id`
  rate-limit on `/api/relay` and per-session debounce of redundant on-change
  `session_announce`s (sessions are independent processes, so there is no cross-session
  coalescer — each only debounces its own). (P7; named explicitly so it isn't lost in
  generic "rate-limiting".)
- **Bus event budget / roll.** Each `session_announce` broadcast is a bus event — **one per
  session per `ANNOUNCE_INTERVAL`** (sessions are independent processes with no per-host
  aggregator — §1), **sent even when no client is watching** (push model). So the bus event
  rate scales with **total live sessions** under an identity:
  `Σ sessions × 86400 / ANNOUNCE_INTERVAL`. At the 20 s default that's ~4 320/day **per session** → the
  25k-events/run cap in ~5.8 d for a single session, proportionally faster with more (e.g.
  5 sessions → ~1.2 d). So the bus **must** roll (re-`start()` under the same token — §6B);
  keep all high-volume turn frames on per-session out-streams (stream writes bypass the event
  cap, billed as Data Written), and a longer `ANNOUNCE_INTERVAL` (≤ 60 s) linearly slows
  rolls at the cost of a larger presence fuzz. Quantify Events vs Data-Written per active
  identity in P3.

## 13. Sources (verified 2026-06-07; Workflow runtime semantics **web- + bundled-SDK-verified 2026-06-08**, against the installed `workflow` package's `node_modules/workflow/docs`)
- Vercel Workflows docs / concepts / pricing+limits — https://vercel.com/docs/workflows ·
  /workflows/concepts · /workflows/pricing (GA 2026-04-16; retention & caps as cited).
  The official docs delegate the SDK/API reference to the open-source **Workflow SDK** at
  https://workflow-sdk.dev (linked verbatim from vercel.com/docs/workflows).
- **Web-verified 2026-06-08 (the §6B linchpins — now docs-confirmed, not just type-confirmed):**
  - `getHookByToken(token): Promise<Hook>` is a runtime fn callable **from outside a workflow**
    (an API route); the returned `Hook` carries `runId` — workflow-sdk.dev/docs/api-reference/workflow-api/get-hook-by-token.
  - Hooks accept a **caller-chosen custom token** ("a custom token that external systems can
    reconstruct"); `resumeHook(token,data)` resumes an existing run (emits `hook_received`),
    does **not** create one — /docs/foundations/hooks · /docs/api-reference/workflow-api/resume-hook.
  - `getRun(id).getReadable({startIndex})` reconnects by `runId`+`startIndex` and returns a
    `WorkflowReadableStream` with a **`getTailIndex()`** helper ("index of the last chunk, or
    −1") — handy for cold-start. **`startIndex` supports negatives** ("`-5` starts 5 chunks
    before the current end"; "read only the last 10 chunks") — the recent-window read is a
    **native, client-chosen offset** and later chunks still stream; caveat: exact pagination
    over a live stream via negatives isn't supported (fine for "recent") —
    /docs/foundations/streaming · /docs/api-reference/workflow-api/get-run · /docs/ai/resumable-streams.
  - **One-bus-per-identity is SDK-enforced:** "hook tokens must be unique across all running
    workflows"; a duplicate `createHook` on a held token throws **`HookConflictError`**
    (`@workflow/errors`, `HookConflictError.is(e)`, `e.token`) — /docs/errors/hook-conflict.
    Hooks are **`AsyncIterable`** (`for await … of hook` per `resumeHook`) — the bus loop.
  - **Stream data bypasses the event log** ("flows directly without being stored in the event
    log"), so out-stream writes do **not** count toward the 25k event cap (billed as Data
    Written; max stream storage Unlimited; **chunk ≤10 MB**, ≤1,000 chunks/s/stream).
  - **No idle-timeout / no max run duration** ("Maximum run duration: No limit"; suspended
    runs wait indefinitely; **a built-in hook timeout is an open request, vercel/workflow#553**
    — the documented bound is racing the hook against a durable `sleep`). A suspended run
    **suspends without consuming resources** (idle = free compute; storage-retained still billed).
  - **`start()` takes no caller-chosen `runId`/idempotency key** (only `deploymentId`;
    vercel/workflow#85 open) → value-addressing **must** be by token, not runId.
  - Run caps confirmed exactly: **25k events / 10k steps / 2 GB per run**; replay degrades
    past **2k events or 1 GB**; **max payload 50 MB**; **max replay duration 240s**; retention
    **1d/7d/30d** Hobby/Pro/Ent — vercel.com/docs/workflows/pricing.
  - Functions SSE (Node runtime, Fluid): **maxDuration 300s Hobby / 800s Pro·Ent**; idle CPU
    not billed, provisioned memory billed for the stream window — vercel.com/docs/functions/limitations · /usage-and-pricing.
- Workflow Development Kit (public beta 2025-10-23) — https://vercel.com/changelog/open-source-workflow-dev-kit-is-now-in-public-beta · https://workflow-sdk.dev
- "A new programming model for durable execution" (GA) — https://vercel.com/blog/a-new-programming-model-for-durable-execution
- Vercel Queues (public beta) — https://vercel.com/docs/queues
- Storage: Upstash Redis / Neon via Vercel Marketplace (KV/Postgres retired 2024)
- **Registry-feasibility (why a Workflow can't be the registry — §6B/§14A):**
  `world.runs.list()` is **cursor-paginated only — no status/key filter** (workflow-sdk.dev/docs/api-reference/workflow-api/world/storage);
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
- **Meta-frame key.** Meta frames (`accepted`/`session_announce`) are AEAD under a single
  **`K_meta`** (the earlier per-field `K_identity_meta`/`K_session_meta` were collapsed
  into it). (§4.2,§6A,§8)
- **Honest zero-knowledge scope:** confidentiality covers `content_root`/`control_key`/
  `K_meta`; `auth_token` is authz and the **live bearer is visible to the broker** —
  there is **no stored token**: the broker recomputes
  `identity_id = trunc(SHA256(auth_token))` and constant-time-compares it to the requested bus (§4.2,
  §6B). Never log it; rate-limit.
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

- **Per-machine identity + viewer passes + trust modes; rotation cut (2026-06-08).**
  Reversed the earlier "one user identity binding all sessions across hosts" model: **each
  machine now owns its own secret `S` → its own `identity_id` → its own bus**; `identity_id`
  is a **machine's public routing id**, not a user identity spanning hosts. Blast radius of a
  steal/reset is exactly **one machine**; to watch another machine you onboard *its* credential.
  Introduced the **pass** (§4.2a) — a viewer credential carrying the operational keys
  {address/content/command/presence} but **not** `S`/`PRK`, one read+steer tier (no view/control
  split), uninvertible to `S` by HKDF one-wayness; revoke = reset the machine; honest
  symmetric-key forge residual. Introduced the **three trust modes** behind one `SecurityProvider`
  seam (§2A): **Open** (trust-server, no crypto, loud banner), **Sealed** (today's E2E), **Managed**
  (future relay-delivered wrapped keys) — identical wire/relay, only `seal`/`open` differ; every
  unconditional confidentiality claim is now Sealed/Managed-relative. **Rotation/forward-secrecy
  was cut** (the master re-derives its keys — that is what makes paste-to-reconnect work); the
  destructive action is "**reset the machine**," and `key_epoch` is a fixed AAD constant, not a
  rotatable epoch. (The crypto core — HKDF labels, 3-level content key flow, per-message AEAD,
  canonical AAD, the §4.4 pick-two theorem, the blind store-free relay — is unchanged.) The earlier
  "one user identity across hosts" entry below is **SUPERSEDED** by this.
- **`--rc-identity` & the identity CLI surface (2026-06-07).** A 3-lens panel
  (security / ergonomics / simplicity) → synthesis → 3 adversarial verifiers settled
  §3.1's identity flags. Confirmed-sound core: local, idempotent, **create-once**
  (`O_CREAT|O_EXCL`), exits without launching claude, **zero network I/O** (lazy
  registration), prints `S` only at creation, quiet status re-runs. Security fixes the
  review forced in (now reflected in §3.1/§4.4): a **QR/deep-link is not
  screen-share-safe** (it encodes `S` verbatim); **`--rc-json`/`--rc-quiet` never emit
  `S`** (CI-log leak); **the replace (`--rc-identity --rc-confirm`) securely deletes** the old
  `S` (same secret re-derives a live credential — not "keys to dead data"); the deep-link is built from the
  **one `--rc-app` origin** (its web UI reads the `#fragment`; its `/api` is the broker — one
  Vercel deployment, so no separate `--rc-web`); `--rc-confirm <identity_id>` is an
  accident guard (identity_id is public), so the reset (the destructive
  `--rc-identity --rc-confirm`) also requires a TTY.
  - **CLI surface trim (2026-06-08, user call):** dropped `--rc-share` (claude's own
    `--remote-control`, forwarded verbatim by the wrapper, already starts a session
    remote-controlled) and `--rc-web` (collapsed into the one `--rc-app` origin). `--help`/`-h`
    prints the `--rc-*` help and then falls through to `claude --help` so both layers show.
- **Registry / state expression (2026-06-07 → -08).** Three research→design→verify
  panels, ending against the **SDK type definitions** (and later **web-verified against the
  live docs**, §13). Evolution: (1) a Workflow can't be a *queryable* registry
  (`world.runs.list()` is cursor-paginated only — no status/key filter; `start()` takes no
  custom `runId`; heartbeats-as-events blow the 25k cap) → first concluded a managed KV was
  needed;
  (2) the user simplified to **one user identity binding all sessions across hosts** +
  **an announce bus** (connected wrappers self-identify on request) — **[SUPERSEDED
  2026-06-08: identity is now per-machine, see the entry above]**; (3) the linchpin —
  whether the bus is addressable by a derived value — resolved **yes**:
  `getHookByToken(token): Promise<Hook>` is public and returns `runId`, so
  `bus:${identity_id}` → `getHookByToken` → `getRun` → `getReadable` subscribes with
  **no stored pointer**. **Final: a per-identity value-addressed bus, no store** (§6B);
  online-only listing is the trade; a store is optional for offline listing (§6C).
  Caveats (verified): two-call composition is undocumented-as-a-pattern; live-only
  (hooks dispose at terminal state); run-roll re-binds the token; `getHookByToken` is
  server-creds (browser via our Function).
- **Presence model: pull (challenge) → push (timestamp) (2026-06-08).** Five
  research/design/verify loops (codex gpt-5.5 + the review workflow) hardened presence.
  A pushed `present` beat is replay/withhold-vulnerable: monotonic `beat_seq` proves
  *ordering*, not *recency*, so a hoard-and-dribble broker resurrects a dead session. The
  first sound form was a **challenge–response** (`identify?{challenge}` → `in_reply_to`),
  which gets recency from a client round-trip with **no clock trust** — but it needs the
  round-trip + challenge/`beat_seq`/`wrapper_instance_id` machinery. **Adopted (user
  choice, 2026-06-08): Design B — timestamp-driven push.** Wrappers periodically broadcast
  a signed `session_announce{…, sent_at}`; online = a within-`FRESH_WINDOW` announce. One
  signed frame + one freshness check replaces `identify?`/challenge/`beat_seq`/
  `wrapper_instance_id`/`present`. Trade: assumes **NTP-synced clocks (~seconds)** — but
  the assumption's blast radius is the **online dot only** (message security stays
  clock-free), and a replayed/withheld announce is stale → rejected. The challenge variant
  is retained here as the **zero-clock-trust fallback** if device clocks ever can't be
  trusted.
- **Design B assessor pass + the independent-session model (2026-06-08).** codex
  (gpt-5.5) + the review workflow re-ran against Design B. Verdict: **sound** under the
  bounded-clock assumption (codex: "minor-issues"); no forge/replay path can keep a dead
  session online past the timestamp expiry. Precision fixes folded in: (1) the exact
  false-online bound is **`FRESH_WINDOW + SKEW`**, not "one window" (the acceptance
  predicate allows `sent_at ≤ now + SKEW`); (2) **both** `FRESH_WINDOW` and `SKEW` must be
  ≥ max skew (the past edge guards a slow clock from false-grey, the future edge guards a
  fast clock from false-reject), with concrete defaults `20 s / 60 s / 5 s`; (3) the
  "clock-free message plane" claim is scoped honestly — a control frame's `expiry` (inside
  `ct`) is the one clock touch, bounding a *withheld-then-released-late* command, worst case
  a rejected stale command; (4) the cold-start recent-window read is sized to span ≥ one
  `ANNOUNCE_INTERVAL`, with a ≤ `ANNOUNCE_INTERVAL` fallback if it rolled; (5) §2 now lists
  **replay** among broker powers. A *mid-pass batching idea* (one announce per host covering
  many sessions) was **rejected** on the user's clarification that **a wrapper is 1:1 with a
  session and sessions are mutually independent processes with no per-host aggregator (§1)** —
  there is nothing to batch, so presence stays **per-session**, and the bus event budget is
  honestly `Σ sessions × 86400 / ANNOUNCE_INTERVAL` (§12).
- **P3 spike — empirically verified on Vercel (2026-06-08).** Built a throwaway Next.js +
  Workflow DevKit app (`workflow@4.3.1`, `next@16.2.7`) and deployed it to Vercel (Vercel
  World, `iad1`), then drove the §6B bus end-to-end with `vercel curl`. All four linchpins
  passed on real infra: (1) **cross-process value-addressing** — `POST /api/publish`
  resume-or-`start()`s a `bus:<token>` run and `resumeHook`s an announce; `GET /api/subscribe`
  resolves the derived token via `getHookByToken→getRun→getReadable` and tails it (3 publishes
  → one `runId`, read back `[{n:1},{n:2},{n:3}]`, `tailIndex:2`). (2) **recent window** —
  `getReadable({startIndex:-2})` returned exactly the last two. (3) **one-bus-per-identity** —
  a second `createHook` on the held token threw **`HookConflictError`** ("Hook token … is
  already in use by another workflow"), so the create-race loser deterministically resume-tails.
  (4) **completion → dispose → token frees** — after a `__close` the run completes, the token
  stops resolving (`getHookByToken` → `HookNotFound`), and a subscribe renders empty — the
  cap-roll/teardown path. So the bus is no longer just docs-confirmed but **observed working**;
  the only remaining build-out is wiring it into the real broker (P3 proper) with
  per-identity `auth_token` auth, chunking, and the per-session streams.

## 15. Use cases / scenario matrix (also the v2 test plan)

Each maps to the frames (§6A), channels, endpoints (§8), and state. **[V]** = an
aspect already empirically verified (Phase 0 MANGO / the P0.5 spikes C1–C5 +
rc_api_bridge); others are specs to build/test.

(Discovery + presence = the per-identity **bus** (§6B); the two endpoints = §8; offline
*listing* across cold starts is deferred, §6C.)

**Identity & bring-up**
1. **Fresh identity bootstrap.** `remote-claw --rc-identity` → generate `S` (0600),
   derive `identity_id`/`auth_token`/`content_root`/`control_key`/meta-keys, print
   `rc1_…`, **exit** (no claude, **no network** — lazy). (§4.1, §4.2)
2. **Wrapper launches the real TUI, RC OFF.** `remote-claw` (used exactly like
   `claude`) runs the real interactive `claude`, full passthrough; **no broker traffic
   at all** — not on any bus, invisible to the cloud. Local-only. **[V]** (TUI launch)
3. **Work locally, RC still off.** Conversation lives only in claude's on-disk
   transcript; the broker knows nothing. **[V]** (local history)

**Enabling remote control**

4. **Enable RC mid-session via `/remote-control`.** Wrapper points the inner claude at
   the local MITM (our relay = RC backend); worker backfills the prior transcript as
   `historical` frames → **log + seen-set seeded first**. *Only then* does the wrapper
   **join the identity bus** (`bus:${identity_id}`, resume-or-`start()`) and start
   **broadcasting** `session_announce` for the session + open its stream
   (`sess:${identity_id}:${session_id}`) — so an announce never precedes a complete log
   (§16 #4). **[V]** C1+C2
5. **Launch with RC on.** `remote-claw --remote-control` → fresh session, relay is the
   backend from the start, empty history, joins the bus + broadcasts. **[V]** (Phase 0)

**Client onboarding & discovery (the bus)**

6. **Client first connection.** Onboard the machine's **pass** (paste/scan or `#fragment`) →
   load its keys → `GET /api/stream?identity=identity_id` (subscribe the bus) → reads the
   recent window → renders fresh `session_announce`s (empty if none connected). Store the
   **pass** in localStorage. No request sent.
7. **One MACHINE, 5 independent sessions.** On one machine (one secret), 5
   separate `remote-claw` processes each broadcast their **own**
   `session_announce`; the client subscribes that machine's single bus and renders all 5 as
   separate spaces, each with **independent** presence (online = its own fresh announce).
   Tests the per-session/no-aggregator model (§1) — no batching, one pass on the client. (To
   watch several **machines** from one viewer you hold several passes, one active at a time.)
8. **List an identity's spaces.** = the wrappers' broadcast `session_announce`s on that
   identity's bus; decrypt titles/cwd → gchat-style list. (A space is a chat; online = its
   latest announce is **fresh**, §4.3.)

**History sync**

9. **Open a session cold (full sync).** Client sends `catch_up{since=0}` on the session
   channel → wrapper replays its log (or worker backfill) as `historical` → client
   renders, then tails live.
10. **Reopen (delta sync).** Cached to `seq=N` → `catch_up{since=N}` → wrapper sends
    only `>N`; or resume the session out-stream by `startIndex` if within the window.

**Messaging (the core loop)**

11. **Send from client → underlying claude.** Client encrypts a `user` frame
    (`client_msg_id`) → `POST /api/relay` (`resumeHook sess:…`) → wrapper hook → dedup
    by `msg_id` → log → decrypt → inject into claude via MITM downstream → echo
    `accepted{client_msg_id, seq}`; claude replies → `assistant`/`result` on the session
    out-stream → client renders. **[V]** C3
12. **Type in the local TUI → appears in client.** Worker emits `user`+`assistant`
    upstream → session out-stream → all clients render (`source=worker`). **[V]** C4
13. **Two clients, one session (fan-out).** Phone + laptop both tail the session
    out-stream (each resolves the same `sess:` token → same run → multi-reader); a
    message from either shows on both + the TUI. **Connected at different times:** a
    late-joining laptop independently subscribes the bus → reads the recent window → gets
    the *same* live list from the wrappers' broadcast announces, opens the session +
    `catch_up{since=0}` → full history, then both tail live in lockstep (ordering by
    wrapper-assigned `seq`, dedup by `msg_id`). One client closing its SSE doesn't affect
    the other (no per-client server state). (multi-client)

**Switch machine & naming**

14. **Switch machine (replace, not accumulate).** Onboard a different machine's pass. In order:
    (1) **close the old machine's SSE** (so no late frame re-populates the cache mid-wipe),
    (2) **forget** the prior pass — wipe it from `localStorage` **and** the decrypted
    IndexedDB cache (§1A E; a retained pass is a live credential, §4.2a/§4.4), (3) **then**
    load keys for `identity_id₂` and subscribe the **new** machine's bus → its
    connected sessions' announces render its spaces. The client holds **one pass at a
    time** (§7). (Client-local rename aliases are keyed by `identity_id`/`session_id` (#15),
    so they stay scoped to their machine — invisible after a switch, intact on switch-back.)
15. **Rename identity/space.** This phase a rename is a **client-local alias** (stored in
    the device's `localStorage`, mapped by `identity_id`/`session_id` — so it survives an
    identity switch and only reappears when that identity is re-pasted) — no broker write,
    no cross-device sync. Defaults stay authoritative (identity = hostname, space =
    claude's title, from the wrapper's `session_announce`). Persistent/shared rename is
    deferred with the store (§6C).

**Control & permissions**

16. **Tool permission (`can_use_tool`).** Worker emits a `control_request` → session
    out-stream → client Allow/Deny → encrypted `permission` control frame → wrapper →
    `control_response` to claude. (plumbed; RC auto-runs today)
17. **Remote control verbs.** Client sends `interrupt` (ESC) / `set_mode` / `set_model`
    / `command` (`/compact`,`/clear`) control frames (session channel) → wrapper → claude.

**Resilience**

18. **Network blip mid-turn.** Client SSE drops → reconnect
    `GET /api/stream?identity=id&session=sid` (resolve token → run → resume by `startIndex`);
    at-least-once → dedup by `msg_id`; no missed/dup frames.
19. **Wrapper/CLI restart (both stateless).** Reboot/crash → relaunch
    `remote-claw --continue` + `/remote-control` → worker re-backfills → log **and `msg_id` seen-set**
    rebuilt. The backfill must be **complete before W resumes** (claude's on-disk transcript
    is authoritative; a partial/failed backfill POST is retried, not served) — otherwise the
    rebuilt seen-set would miss a `msg_id` and a broker replay of that gap frame could
    double-deliver. Only then does the wrapper **rejoin the bus and resume broadcasting**
    fresh `session_announce`s. A still-connected tab greys the session when announces lapse,
    then **un-greys automatically on the next fresh broadcast** (no epoch/handshake — a fresh
    `sent_at` is just accepted, §4.3; a broker replay of pre-restart announces can't extend
    liveness past `FRESH_WINDOW + SKEW`); clients reconnect + `catch_up`. **[V]** C5
20. **Host offline → back.** Wrapper exits (never outlives the CLI) → **stops
    broadcasting** → its announces age out of `FRESH_WINDOW` → a client *watching* its
    spaces **greys them locally**, then drops them; a *fresh* cold open just won't list
    them (offline *listing* deferred §6C). The bus run **persists either way** (no
    idle-timeout — §6B/§13): with other sessions still broadcasting it stays active; with the
    last one gone it just goes **quiet** (token still resolvable) and a cold open reads the
    recent window, finds no fresh announce, and renders empty — "online = fresh announce," not
    "bus exists."
    A send to the gone session is rejected **client-side** (greyed → send disabled). If a
    frame is sent anyway it is **best-effort**: while the session run is still alive (wrapper
    briefly offline) it *may* land when the wrapper returns and read it, deduped by `msg_id`;
    but once the run idles out and the hook disposes, `POST /api/relay` → `HookNotFound` →
    **`409` and the send is lost** (**no durable server queue** — idempotency only protects a
    frame the wrapper actually receives, not one dropped at a dead hook). The client treats a
    greyed session as send-disabled and **re-sends after it re-appears**. On return (relaunch
    + `/remote-control`) → rejoins → broadcasts again; `catch_up` fills the gap.
21. **Bus rolls mid-session (event cap).** The bus run nears 25k events → wrapper(s)
    `start()` a fresh bus run under the same token `bus:${identity_id}` (1:1 token frees
    on the old run completing). A tailing client's bus SSE ends → it reconnects
    `GET /api/stream?identity=…` → `getHookByToken` now resolves the **new** run → it
    re-tails (and wrappers resume broadcasting onto it). Brief `HookNotFound` during the
    handoff → client retries. **Open per-session chats are unaffected** (their `sess:`
    streams are separate runs).
22. **Client returns after being away (cold tab).** A client that closed comes back:
    re-derive (or read `localStorage`) → subscribe bus → recent-window announces → live
    list; open a chat → `catch_up{since=cached_seq}` (delta from its IndexedDB cache, or
    `since=0`) → caught up. No server-side per-client state was kept; nothing was lost
    (claude holds the transcript). **Cache-retention rule:** an empty bus or a `catch_up`
    `HookNotFound` means *offline*, not *gone* (the two are indistinguishable by design,
    §6B) — the client **keeps** its IndexedDB cache and retries with backoff; it only wipes
    on an explicit machine reset (§4.4) or forget-identity (§1A E).
23. **Two wrappers, one machine, one drops.** Two `remote-claw` processes on one machine
    (one secret) both
    broadcast on `bus:${identity_id}` (each its own session's announces). A client sees
    both sets of spaces. One process exits → only *its* announces age out → client greys
    *those* locally; the other process's sessions + the bus run stay live (the survivor keeps
    broadcasting, re-waking the run — §6B).

**Adversarial / threat-model coverage** (the broker is hostile per §2 — drop/withhold/
reorder/**replay**, no keys)

24. **Broker replays a stale announce to a watching client.** Session announces at `T`
    (`sent_at=T`); client sees it online. Wrapper dies; by `T + FRESH_WINDOW + SKEW` the
    client has **greyed** it. The broker replays the captured `T` announce later: its
    `sent_at` is now outside the window → **ignored**; the session stays greyed. (Replay can
    only *extend* a live dot to ≤ `FRESH_WINDOW + SKEW`, never resurrect — §4.3.)
25. **Two wrappers race the initial bus create.** Both sessions of a cold identity enable RC
    at once → both `resumeHook`→`HookNotFound`→`start()`. The 1:1 token lets one win; the
    loser catches `HookConflictError` → resume-tails the winner (bounded backoff, §6B). Both
    end up broadcasting on the one bus; no announce lost.
26. **Clean session end (vs crash).** `/end` (or the wrapper exiting) stops that session's
    announces; it greys then drops within `FRESH_WINDOW + SKEW` — same as a crash, since
    presence is broadcast-driven (no special "left" frame needed). An explicit `end` control
    frame also tells claude to tear down the RC session.
27. **Control reorder / expired control.** The broker reorders or withholds control frames.
    Order-dependent ones are **serialized client-side** (send the next only after the prior's
    effect shows on the out-stream — §6A), so e.g. `interrupt` can't be inverted with a later
    `set_mode`. A withheld-past-`expiry` control frame is **rejected** (no effect); the client
    **times out and re-sends** with a fresh `msg_id` (no hang). A replayed control frame is
    dropped by the `(msg_id)` seen-set before any side effect.

Also covered by the same mechanisms (not numbered): **machine reset** (new `S`
→ new `identity_id` = a new identity for that machine with a fresh, empty set of spaces; the
old identity and all its spaces are dead, other machines untouched — §4.4), and a **broker
(Vercel) outage** (the local TUI
keeps working; remote is unavailable; clients reconnect, re-subscribe and `catch_up`
when the broker returns — nothing lost since claude holds the transcript).

## 16. Message sequences (per use case)

Actors: **C**=web/generic client · **V**=Vercel broker (functions+workflow) ·
**W**=wrapper/relay (host side: MITM + relay client) · **T**=real claude TUI ·
**A**=Anthropic API (**inference only**, passthrough). All C↔V↔W payloads are
ciphertext (`{…}` = decrypted view); every C/W→V call carries
`Bearer auth_token` (§4.5; the web app additionally gates human callers on SSO). Frame kinds per §6A. `→` one
message; steps are ordered.

Channels are addressed by **derived tokens** (§6B): the identity **bus**
`bus:${identity_id}` and per-session `sess:${identity_id}:${session_id}`.
`POST /api/relay` = `resumeHook(token, frame)` (publish);
`GET /api/stream?identity=|session=` = `getHookByToken(token)→getRun(runId)→getReadable()` over SSE (subscribe).
No `/api/identity`, `/api/sessions`, or `/api/heartbeat`.

**1. Fresh identity bootstrap** (`remote-claw --rc-identity`)
1. W: gen `S`; derive `identity_id, auth_token, content_root, control_key, K_meta`
2. W prints `rc1_…`; **exits** *(no T, no session, no broker call — lazy)*

**2. Wrapper launches real TUI, RC OFF** (`remote-claw …` used as `claude`)
1. W spawns **T** (passthrough args). MITM env (`HTTPS_PROXY→W`, `NODE_EXTRA_CA_CERTS`)
   is **armed but inert** until RC is enabled.
2. T→A inference for local use (passthrough; `/v1/messages` not intercepted)
3. **No broker traffic at all** — W is not on any bus. The machine is invisible.

**3. Work locally, RC OFF**
1. user↔T locally; T→A inference; transcript persists on disk
2. V sees **nothing** — no bus membership, no content

**4. Enable `/remote-control` mid-session** *(verified C1+C2)*
1. user types `/remote-control` in T
2. T→W `POST /v1/code/sessions {title, config{cwd,model}}` *(MITM-intercepted)* → W `200 {session{id:sid}}`
3. T→W `POST …/{sid}/bridge` → W `200 {worker_jwt, api_base_url}`
4. T→W `GET …/{sid}/worker/events/stream` (SSE); W→T `control_request{initialize}`
5. T→W `POST …/worker/events [{user historical}, {assistant historical}, …]` *(backfill of prior chat)*
6. W **commits the backfill to its in-memory log first** (log+encrypt all `historical` frames + seed the `msg_id` seen-set), **then** joins the bus: `resumeHook("bus:"+identity_id, …)` (resume-or-**start** the bus run, bounded-backoff retry on `HookNotFound`/`HookConflictError`); opens the session stream `sess:${identity_id}:${sid}`. Only **after** the log is seeded does W **broadcast** `session_announce{…, sent_at}` (every `ANNOUNCE_INTERVAL` + on change) — so a client that races in with `catch_up{since=0}` the instant it sees the announce gets the *complete* history, never a partial log.

**5. Launch with RC ON** (`remote-claw --remote-control`) — as #4 steps 2–4 + the join-bus/broadcast of step 6, **no backfill** (empty history).

**6. Client first connection**
1. user onboards the machine's **pass**; C loads `{identity_id/auth_token, content_root, control_key, K_meta}` from it (no derivation, no `rc1_`)
2. C→V `GET /api/stream?identity=identity_id` → V `getHookByToken("bus:"+identity_id)`→`getRun`→`getReadable({startIndex:recent})` → SSE *(HookNotFound ⇒ `200` empty: nothing connected)*
3. the recent window already holds each connected W's last `session_announce{sid, title, cwd, identity_label, status, last_activity, sent_at}` (AEAD `K_meta`); C accepts those with **`sent_at` within `FRESH_WINDOW`** (rejects stale/replayed), decrypts, renders the list. No request sent; the wrappers' periodic broadcasts keep it fresh.

**7. One MACHINE, 5 independent sessions**
1. one machine's secret → one `(identity_id, auth_token, …)`; 5 separate `remote-claw` processes on that machine each broadcast their **own** `session_announce` on the one bus
2. C subscribes that single bus (as #6) → recent-window holds all 5 sessions' last announces
3. C renders all 5 as separate spaces, each with **independent** presence (online = its own fresh announce) — per-session, no aggregator (§1). To watch several **machines** from one viewer, hold several passes (one active at a time)

**8. List an identity's spaces** = the connected wrappers' broadcast `session_announce`s on that identity's bus; C accepts fresh ones, decrypts titles → gchat-style list (each a chat).

**9. Open a session cold — full history sync**
1. C: encrypt `catch_up{since:0, msg_id, expiry}` (control_key) → C→V `POST /api/relay` → `resumeHook("sess:"+identity_id+":"+sid,…)`
2. V→W via the session hook; W decrypts `catch_up`
3. W replays its log from 0: each frame → W→V session out-stream `{historical:true, seq}`
4. V→C SSE → C decrypts + renders history, then tails live

**10. Reopen — delta sync**
1. C cached to `seq=N` → `catch_up{since:N}` on the session channel
2. V→W session hook → W replays log `seq>N` → out-stream → C
   *(or, if within the buffer window: C→V `GET /api/stream?identity=id&session=sid` resumes by `startIndex`, W untouched)*

**11. Send from client → underlying claude** *(verified C3 — the core loop)*
1. C: encrypt `user{content}` **as a content frame under `K_session`** → C→V `POST /api/relay {kind:user, client_msg_id, msg_id}` → `resumeHook("sess:…",…)`
2. V `hook.resume(sess token, frame)`
3. W: hook fires → **dedup by msg_id** → decrypt → **log** → allocate `seq`
4. W→T inject the user message on the worker SSE *(MITM downstream)*
5. W→V session out-stream `{kind:accepted, client_msg_id, seq}` → V→C SSE → C clears "pending"
6. T→A `POST /v1/messages` *(inference, passthrough)*
7. T→W `POST …/worker/events [{assistant},{result}]`
8. W: log+encrypt → W→V session out-stream `{assistant, seq}` then `{result, seq}`
9. V→C SSE → C decrypts + renders

**12. Type in the local TUI → appears in client** *(verified C4)*
1. user↔T; T→A inference; T→W `POST …/worker/events [{user source:worker},{assistant},{result}]`
2. W log+encrypt → W→V session out-stream → V→C SSE → all clients render

**13. Two clients, one session (fan-out)**
1. C₁,C₂ each: C→V `GET /api/stream?identity=id&session=sid` (two readers on the session out-stream, via token→run)
2. any out frame → V fans to both; an `in` frame from either → session hook → W→T → out-stream → both + T

**14. Switch machine (replace, not accumulate)**
1. user onboards machine 2's pass → C **closes the old SSE** → **forgets** the prior pass (`localStorage` + IndexedDB plaintext cache, §1A E) → loads keys for `identity_id₂` → subscribes the **new** bus (as #6) → its connected sessions' announces render its spaces. One pass on the client at a time (§7); aliases stay keyed by `identity_id` so they don't leak across the switch.

**15. Rename identity/space** *(client-local this phase — no broker write)*
1. C stores `alias[identity_id|session_id] = new_name` in its own `localStorage`
2. C renders the alias over the default from `session_announce`; **no** frame is sent, nothing syncs to other devices. (Cross-device/persistent rename → deferred store, §6C.)

**16. Tool permission (`can_use_tool`)**
1. T→W `POST …/worker/events [{control_request can_use_tool, request_id, tool_name, tool_input}]`
2. W→V session out-stream → C shows Allow/Deny
3. C: `enc permission{request_id, behavior}` (control_key) → C→V `POST /api/relay` → `resumeHook("sess:…")`
4. V→W session hook → W→T `control_response{request_id, behavior}` on the worker SSE → T proceeds/denies

**17. Remote control verbs**
1. C: `enc {interrupt | set_mode | set_model | command}` (control_key) → C→V `POST /api/relay` (sess token)
2. V→W session hook → W→T the matching RC verb (interrupt / set_permission_mode / set_model / slash) → T acts

**18. Network blip mid-turn**
1. C's SSE drops → C→V `GET /api/stream?identity=id&session=sid` (token→run; resume by `startIndex`)
2. C dedups by `msg_id`, reorders by `seq` → no gap, no dup

**19. Wrapper/CLI restart (both stateless)** *(verified C5)*
1. both die → operator relaunches `remote-claw --continue` *(passthrough; resumes the on-disk session)* → W spawns **T** through the MITM
2. user `/remote-control` → bridge→stream (as #4) → T→W backfill `POST …/worker/events [full historical transcript]`
3. W rebuilds the log; **rejoins the bus and resumes broadcasting** fresh `session_announce`s (re-creating bus/session runs as needed)
4. a still-connected C greys the session when announces lapse, then **un-greys automatically on the next fresh broadcast** (a fresh `sent_at` is just accepted — no epoch/handshake, §4.3) + `catch_up` → W replays the rebuilt log → C re-renders *(state recovered from claude)*

**20. Host offline → back**
1. W/CLI exit → W **stops broadcasting**; its announces age out of `FRESH_WINDOW`
2. C (tailing the bus) **greys** the session locally, then drops it; a fresh open reads the recent window and finds no fresh announce → empty (the bus run **persists** regardless — no idle-timeout, §6B/§13; `HookNotFound` only if the bus was *never* created or mid-roll)
3. send is blocked **client-side** (greyed → disabled); if sent anyway it is **best-effort**: it *may* land if W returns while the run is still alive (deduped by `msg_id`), but once the session run idles out the hook disposes → `POST /api/relay` → `resumeHook` **`HookNotFound`** → **`409`, send lost** (no durable queue; idempotency can't save a frame dropped at a dead hook) → client re-sends after the session re-appears
4. host returns: relaunch + `/remote-control` → W **rejoins the bus** → broadcasts again; C un-greys on the next fresh announce; `catch_up` fills the gap

**21. Bus rolls mid-session (event cap)**
1. a connected W sees the bus run nearing 25k events → **completes** the old run (closes its stream, disposes the hook → frees the 1:1 token) → `start()`s a fresh run re-`createHook("bus:"+identity_id)` (race: loser catches `HookConflictError`, resume-tails the winner)
2. tailing C's bus SSE hits **EOF** → C→V `GET /api/stream?identity=id` → `getHookByToken` resolves the **new** run → re-tail (wrappers resume broadcasting onto it; brief `HookNotFound` during swap → retry)
3. open **per-session** chats untouched (separate `sess:` runs)

**22. Client returns cold (was away)**
1. C re-derives (or reads `localStorage`) → C→V `GET /api/stream?identity=id` (subscribe bus) → recent-window `session_announce`s
2. C accepts fresh ones → renders list *(no per-client server state was kept)*
3. open a chat → `catch_up{since=cached_seq}` (IndexedDB delta, or `since=0`) → caught up

**23. Two wrappers, one identity, one drops**
1. W₁,W₂ (same secret) both **broadcast** on `bus:${id}` (each its own sessions' announces); C lists both sets
2. W₁ sleeps → its announces age out of `FRESH_WINDOW` → C greys **only W₁'s** sessions; W₂'s sessions + the bus run stay live (W₂ keeps broadcasting, re-waking the run — §6B)
3. W₁ returns → rejoins → broadcasts again → C un-greys W₁'s sessions on the next fresh announce

### 16.1 Primitives used (per scenario)

Compact map of the building blocks each scenario exercises. Vocabulary: `HKDF`
(derive) · `GCM` (AES-256-GCM seal/open) · `AAD` · `sha256` · `CSPRNG` ·
`checksum` · broker (2 endpoints): `/api/relay`(`resumeHook`) `/api/stream`(SSE via
`getHookByToken`→`getRun`→`getReadable`) `bearer`(`auth_token`, self-verifying)
`sso`(web UI, Better Auth) · bus: `bus:${id}` `sess:${id}:${sid}` (derived tokens)
`session_announce`(periodic broadcast, `sent_at`) `online=fresh-announce`(within
`FRESH_WINDOW`) `grey-local` ·
workflow: `hook` `wf-stream`(durable resumable) · host/MITM: `args-passthrough`
`--rc-*` `intercept`(/v1/code/sessions*) `passthrough`(/v1/messages) `bridge`(worker_jwt)
`worker-SSE` `/worker/events` `initialize` `backfill`(historical) `log` `dedup`(msg_id)
`seq-alloc` `/remote-control`.

| # | Scenario | Primitives |
| --- | --- | --- |
| 1 | Fresh identity bootstrap (`--rc-identity`) | `CSPRNG(S)`, `HKDF`→{identity_id,auth_token,content_root,control_key,K_meta}, `checksum`, print `rc1_…` *(local only; no broker call)* |
| 2 | Wrapper launches TUI, RC off | `args-passthrough`, MITM `passthrough`, CA trust *(no broker traffic; not on bus)* |
| 3 | Work locally, RC off | `passthrough`, claude on-disk transcript (no /v1/code; broker sees nothing) |
| 4 | Enable `/remote-control` | `intercept`, `bridge`, `worker-SSE`, `initialize`, `backfill`, `log`, `GCM`, **join-bus**(`resumeHook bus:${id}`), broadcast `session_announce`, `bearer` |
| 5 | Launch with RC on (`--remote-control`) | `intercept`, `bridge`, `worker-SSE`, `initialize`, `log`, join-bus + broadcast |
| 6 | Client first connection | `HKDF`, `sso`, `bearer`, `/api/stream`(`getHookByToken bus:${id}`, recent window), `session_announce`(fresh), `GCM-open(name)`, `localStorage` |
| 7 | One MACHINE, 5 independent sessions | 1× `HKDF`, `bearer`, **1× bus subscribe**, 5× per-session `session_announce`, `online=fresh-announce`, `GCM-open`, no aggregator (§1) |
| 8 | List an identity's spaces | broadcast `session_announce` (bus), `online=fresh-announce`, `GCM-open(title/cwd)`, `grey-local` |
| 9 | Cold full history sync | `GCM(control_key)`, `catch_up`, session `hook`, `log-read`, `GCM(content)`, `/api/relay`, `wf-stream/SSE`, `seq` |
| 10 | Reopen — delta sync | `catch_up`, `log-read(>N)`, `IndexedDB` cache, `wf-stream` resume(`startIndex`) |
| 11 | Client → claude → back | `GCM(content)`, `resumeHook sess:`, `dedup(msg_id)`, `log`, `seq-alloc`, `intercept`-inject, `passthrough`, `accepted`, `wf-stream/SSE`, `AAD` |
| 12 | Type in TUI → client | `worker-SSE`(upstream), `log`, `GCM`, session `wf-stream/SSE` |
| 13 | Two clients (fan-out) | `wf-stream` multi-reader (session), `SSE`, `seq`/`dedup` |
| 14 | Switch machine (replace) | forget prior pass, load machine 2's keys, `sso`, `bearer`, **new** bus subscribe → broadcast `session_announce`s (one pass on client) |
| 15 | Rename identity/space | client-local `alias` in `localStorage` *(no broker write; cross-device deferred §6C)* |
| 16 | Tool permission | `control_request/response`, `GCM(control_key)`, session `hook`, `worker-SSE` |
| 17 | Remote control verbs | control frames (`control_key`), session `hook`, RC verbs (`interrupt`/`set_permission_mode`/`set_model`) |
| 18 | Network blip resume | `/api/stream?identity=&session=` (token→run), `wf-stream` resume(`startIndex`), `seq` reorder, `dedup` |
| 19 | Wrapper/CLI restart recovery | `--continue`, `/remote-control`, `intercept`, `backfill`, `log-rebuild`, **rejoin-bus + resume broadcast**, fresh-announce un-grey, `catch_up` |
| 20 | Host offline → back | stop-broadcast, announces age out, `grey-local`, `409`(no live session), rejoin + rebroadcast, `catch_up` |
| 21 | Bus rolls mid-session | cap-roll: complete old run, `start()` new (same token), `HookConflictError` race, client EOF→reconnect→re-tail; sessions untouched |
| 22 | Client returns cold | `localStorage`/re-derive, bus subscribe (recent window), `catch_up{since=cached}`, IndexedDB delta *(no per-client server state)* |
| 23 | Two wrappers, one drops | both broadcast on the bus, survivor keeps broadcasting (re-wakes the run), `grey-local` only the dropped wrapper's spaces |
| 24 | Broker replays stale announce | replayed `session_announce`, `sent_at` out of window → ignored, stays `grey-local` (replay extends a live dot ≤ `FRESH_WINDOW+SKEW`, never resurrects) |
| 25 | Two wrappers race bus create | `resumeHook`→`HookNotFound`→`start()`, 1:1 token, `HookConflictError`→resume-tail (bounded backoff), no announce lost |
| 26 | Clean session end (vs crash) | stop-broadcast → `grey-local`+drop within `FRESH_WINDOW+SKEW`; optional `end` control frame tears down RC |
| 27 | Control reorder / expired | client-serialized order-dependent controls, `dedup(msg_id)`, `expiry`-reject → timeout+re-send (no hang) |

## 17. Appendix — Claude's Remote Control protocol (reverse-engineered)

> **What this is.** The Anthropic-side protocol that `claude --remote-control` speaks, which the
> remote-claw wrapper MITMs to become the RC backend (§3.1, §14). Empirically captured on **Claude
> Code v2.1.168** (Phase 0 — [`docs/phase0-findings.md`](phase0-findings.md), [`docs/remote-control-research.md`](remote-control-research.md));
> **undocumented and version-sensitive** — re-verify on any claude upgrade. Inference
> (`/v1/messages`) and OAuth are **not** part of this; the wrapper passes those straight through to
> Anthropic untouched.

### 17.1 Two transports — and which one we intercept

Claude Code has two distinct RC transports:

- **Interactive RC = a plain HTTPS sessions API** on `api.anthropic.com` under `/v1/code/sessions*`.
  This is what `claude --remote-control` (and the `/remote-control` slash command) actually use,
  and **what remote-claw intercepts.** It shares the host with inference, so interception is a TLS
  **MITM of `api.anthropic.com`**: serve `/v1/code/sessions*` ourselves, pass `/v1/messages` + the
  OAuth/token endpoints through to the real upstream.
- **`--sdk-url` worker WebSocket (CCRv1 — NDJSON over WS):** a *separate* transport for server-mode
  worker fan-out. On v2.1.168 it is locked to a **hardcoded 5-host Anthropic allowlist + wss/https
  only**, rejecting any self-hosted relay *before a socket opens* (with a `tengu_sdk_url_host_rejected`
  telemetry event). So it is **not usable** for a self-hosted relay and is **not** how interactive RC
  works — history only.

### 17.2 Endpoint map (the HTTPS sessions API, v2.1.168)

Auth: `Authorization: Bearer <claude.ai OAuth accessToken>` + `anthropic-version: 2023-06-01`
(first-party provider only — `ANTHROPIC_API_KEY` and inference-only `CLAUDE_CODE_OAUTH_TOKEN`/
`setup-token` are **rejected** for RC). Worker endpoints instead use a session-scoped `worker_jwt`
(`sk-ant-si-…`) minted by `/bridge`.

**Worker / host side** — what `claude --remote-control` calls; **what our MITM relay serves**:

| Method · Path | Purpose |
| --- | --- |
| `POST /v1/code/sessions` | register a session → `{id:"cse_…", status, environment_kind:"bridge"}` |
| `POST /v1/code/sessions/{id}/bridge` | mint `{api_base_url, worker_jwt:"sk-ant-si-…", worker_epoch, expires_in:14400}` |
| `GET  /v1/code/sessions/{id}/worker/events/stream` | **SSE downstream** (relay→host): `event: client_event`, `data:{event_type, source:"client", payload}`; the **first frame** is `control_request{subtype:"initialize"}` |
| `POST /v1/code/sessions/{id}/worker/events` | host→relay **output** (user-echo, `assistant`, `result`) |
| `POST /v1/code/sessions/{id}/worker/events/delivery` | host acks downstream delivery |
| `PUT  /v1/code/sessions/{id}/worker` | host status `{worker_status:"idle"\|"busy", worker_epoch}` |
| `POST /v1/code/sessions/{id}/worker/heartbeat` | keepalive (~20 s) |

**Client / remote side** — what the official web app calls; **what a remote client could call
directly** (this side needs **no** interception — Phase 0 §4b drove a live session with just the
OAuth token):

| Method · Path | Purpose |
| --- | --- |
| `POST /v1/code/sessions/{id}/events` | **send input** — `{events:[{payload:{type:"user", message:{role:"user", content}, uuid, session_id, timestamp}}]}` |
| `GET  /v1/code/sessions/{id}/events?sort_order=asc\|desc[&cursor=]` | read events (history + cursor poll) |
| `GET  /v1/code/sessions/{id}/events/stream` | **SSE** live output stream |
| `GET  /v1/code/sessions` · `GET /v1/code/sessions/{id}` | list / detail |
| `POST …/client/presence` · `…/mark_read` · `…/archive` · `…/unarchive` | presence / receipts / lifecycle |

### 17.3 Event envelope & turn sequence

Every event (from `GET …/events`) shares one envelope:

```jsonc
{ "event_id": "uuid",
  "event_type": "user|assistant|result|control_request|control_response",
  "sequence_num": "3", "source": "client|worker", "created_at": "…",
  "payload": { /* type-specific; user → {type:"user", message:{role,content}, uuid, session_id, timestamp} */ } }
```

A turn, verified end-to-end: `control_request(initialize)` → `control_response` → `user`
(`source:"client"`) → `assistant` → `result`. Streaming deltas arrive as raw **Anthropic
Messages-API** events (`message_start` → `content_block_delta`×N → `message_stop`), wrapped in a
`stream_event`.

### 17.4 Permissions — RC auto-executes (no approve gate)

Verified against both our relay and Anthropic's real relay: in Remote Control, tools
**auto-execute with no `can_use_tool` prompt**, even under `--permission-mode default`. The real
flow for a tool turn is `user → assistant(tool_use) → user(tool_result) → assistant`.
`--permission-mode` sets the posture; the `control_request`/`control_response` plumbing exists but
RC does not currently gate on it.

### 17.5 How remote-claw maps onto it (§3.1, §6A, §14)

The wrapper runs the **real** `claude --remote-control` behind a TLS MITM of `api.anthropic.com`:
it **serves** the worker `/v1/code/sessions*` endpoints itself (becoming the RC backend) and
**passes** `/v1/messages` + OAuth through, so inference and auth keep working. It maps these worker
events onto its own E2E-encrypted frame types (§6A):

- the SSE `initialize` and client `user` events → inbound (`dir:in`) frames delivered to claude;
- the host's `assistant` / `result` / `system`·`status` outputs → outbound (`dir:out`) content
  frames broadcast to subscribers;
- the cursor-paginated `GET …/events` → the catch-up / **worker backfill** source (§6) that seeds
  the in-memory log + `msg_id` seen-set on (re)connect.

Phase 0 verified this two-surface sync end-to-end on v2.1.168 (the **MANGO** own-relay test, and
the **KIWI**/**PLUM** bidirectional TUI↔client tests).

> **Pinned to v2.1.168.** Every shape here is reverse-engineered from a single binary and can change
> on any claude upgrade — the original `--sdk-url` premise was already patched out once (§17.1). Keep
> `phase0/` (the capture tooling + `mitm/capture-proxy.py`) to re-verify, and have the wrapper **fail
> loudly** on an unrecognized RC-API shape rather than guessing (§12).

## 18. Appendix — Happy/Codex (the account-based alternative) & the revocation tradeoff

**Happy** (`happy.engineering`, open-source `slopus/happy`) is the closest existing system to
remote-claw: a mobile + web client that drives **Claude Code / Codex** running on your machine
through an **E2E-encrypted relay**, with realtime + voice. It sits at the *opposite corner* of the
same design space — **account-based and server-stateful** where remote-claw is **store-free and
per-machine-secret** — so it is the clearest mirror for what our model gives up (per-viewer
revocation, §4.4) and what it gains (paste-and-go, no accounts).

> Drawn from Happy's public docs (security / how-it-works); a few protocol details (exact ECDH /
> derivation) are marked "diagram needed" there, so the crypto specifics below are the **documented
> model**, not a verified wire spec.

### 18.1 Happy's approach (asymmetric, per-device, account-rooted)

- **Master secret — once per account, phone-only.** A 32-byte master secret is generated at signup,
  **lives only on the mobile device, and never leaves it**. Everything derives from it via HKDF,
  including an **asymmetric content keypair** (the secret half stays on the phone; only the
  `content_public_key` is ever shared).
- **Per-machine DEK.** Each CLI machine mints its own **Data Encryption Key** (32-byte random
  AES-256) and encrypts that machine's session content under it. The DEK is **wrapped to the account
  `content_public_key`**, and the *wrapped* copy is parked on the server — so the phone (holding the
  content secret key) can recover any machine's DEK, but the server never sees a usable one. A
  separate **local machine key** encrypts the CLI's on-disk cache and is never sent anywhere.
- **Pairing = QR + ECDH.** `happy` shows a QR carrying an **ephemeral public key + session id**; the
  phone scans it, runs an ECDH exchange (the ephemeral keypair discarded right after), and a shared
  secret is established **without the server seeing it**.
- **Auth = zero-round-trip challenge-response.** Each device picks its **own** random challenge,
  signs it with its secret key, and sends `challenge + signature + public key` in one shot; the
  server verifies the signature and matches it against a stored **hash** of the public key. No
  back-and-forth.
- **What the server stores.** Encrypted DEKs, encrypted content (timestamped, for history replay),
  and a **hash of each device's public key**. It is zero-knowledge for content ("even if someone
  hacks the server, they can't read your data") but it is **not store-free** — there is an account, a
  device list, and a per-machine encrypted-DEK store.

### 18.2 Message flow (what travels)

1. You type on the phone → the phone **encrypts** the prompt E2E → POSTs ciphertext to the relay.
2. The relay sees only an **encrypted blob + routing metadata + timestamp**; it stores and forwards.
3. The subscribed machine **decrypts** with its DEK and feeds the prompt to the real local Claude
   Code / Codex session it wraps.
4. Output is **encrypted chunk-by-chunk** by the machine and relayed back; the phone decrypts and
   renders the live stream (and voice). A reconnecting device **replays from the server's stored
   encrypted blobs**.

### 18.3 The tradeoff vs remote-claw (opposite corners)

remote-claw and Happy answer the same problem with inverted primitives:

| dimension | **remote-claw** | **Happy** |
|---|---|---|
| Root of trust | one symmetric `S` **per machine** (a ~52-char paste) | phone-held asymmetric master + content keypair |
| Per-device keys | the **pass** (§4.2a) — a derived, non-master per-viewer credential (read+steer one machine, **not** `S`) | per-machine DEK, wrapped to the account key |
| Broker state | **store-free** (self-verifying `identity_id`, no registry) | account + device list + encrypted-DEK store |
| Durable history | none on the broker (claude's own `.jsonl`, re-backfilled) | **server stores** encrypted history (timestamped, replayable) |
| Onboarding | **paste-and-go** (any device, no account) | scan a QR → pair a device → account |
| Steal one key | scoped to **one machine**: a stolen pass reads/steers that machine but is **not** `S`; a stolen `S` is full compromise of **that machine only** (others untouched) | scoped: one DEK reads **that machine's** content only |
| Revoke a leak | **no per-pass revoke** — reset the machine (cuts all its passes; §4.4) | **"remove machine from account"** revokes that DEK server-side |
| Forward secrecy | none | future-only after a device removal |

The honest summary: **Happy spends a server-side store + a pairing step to buy per-device,
*revocable* access and a stable account identity; remote-claw spends per-viewer revocability to buy a
store-free broker and a one-string, account-less, paste-and-go cold start.** (remote-claw already
gets *scoped compromise* for free — one secret per machine bounds a steal to one machine; what Happy
buys on top is **per-device revocation**.) Neither is strictly
better — they are the two ends of the §4.4 impossibility (`{ store-free · stable id · revoke-a-leak
}`, pick two), applied per machine. Happy picks *stable id + revoke* (and pays with the store);
remote-claw picks *store-free* (and pays with per-viewer revocation).

### 18.4 If remote-claw ever needs per-viewer revocation

Per-machine identity already buys **scoped compromise** (one steal = one machine), so the
Happy-shaped migration is **not** about scope — it is about **per-viewer revocation** (cutting one
pass without resetting the machine). The migration target maps onto the **server-registered split**
named in §4.4 (`S_server` + `S_paste` = an account half + a paste half), which delivers
revocable, per-viewer access at the cost of an account/registry, a broker store, and weakened
zero-knowledge — i.e. moving toward Happy's corner. It is a deliberate, deferred decision, **not** a
v1 default. Until a hard need appears (revoke one shared pass while keeping the machine), the
paste-and-go, store-free, per-machine model stands.

**Sources:** Happy docs — `https://happy.engineering/docs/security/`,
`https://happy.engineering/docs/how-it-works/`; repo `https://github.com/slopus/happy`.
