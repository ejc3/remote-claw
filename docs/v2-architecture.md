# remote-claw v2 — cloud-brokered, zero-knowledge, multi-host (many independent machines, each its own secret)

> Status: **historical v2 design and rationale for an implemented baseline** (researched 2026-06-07;
> Vercel facts verified against official docs dated 2026-05/06). The as-built authority is
> [Protocol & Runtime](protocol.md). Component, storage, transcript, rollout, and phase-status claims
> below are planning-era snapshots unless that document or current code confirms them. The shipped v2
> baseline superseded the localhost MITM-relay of Phase 0 for the *transport/UX* layer and reused its
> Claude-interception core.

> **Architecture evolution (selected 2026-07-26):**
> [Client-driven host runtime](client-driven-host-runtime.md) adds a host-wide adapter and coordinator
> above this document's one-wrapper-per-Claude-chat implementation. It preserves one paired Codex host
> with many projects/chats and lets official clients participate. At the innermost boundary, one person
> uses the real native TUI while remote-claw occupies one native collaborator attachment. Claude may
> realize that as a session connection, Codex as one daemon-wide bridge, and OpenCode as an
> endpoint-enforced adapter lease over HTTP/SSE; the product's native harness is still the arbiter.
> Each remote-claw server orders and deduplicates only its own direct collaborators and decides which
> proposals to offer inward; the native harness owns final TUI/remote interleaving, acceptance,
> execution, and mutation. A whole remote-claw server may itself be one collaborator of another server,
> recursively and without reflection loops, but only the innermost end contains Claude Code, Codex, or
> OpenCode. The native-client-facing boundary is a drop-in compatibility contract: changing only the
> Codex/OpenCode server endpoint or launching Claude inside the wrapper must preserve the pinned native
> product's supported protocol and behavior. The retained Codex proofs cover two independently
> initialized clients on one native thread, a real TUI plus raw peer on one thread, and three raw
> connections where the two top-level creators own the native subscriptions while non-owners remain
> `notSubscribed` and lack the selected correlated detailed events until one host observer explicitly
> resumes both.
> Pinned `0.146.0` separately best-effort attaches every initialized connection for core child-agent
> thread notifications. The target preserves and differentially proves those native subscription,
> broadcast, and routing semantics for trusted direct TUIs plus exactly one remote-claw bridge; it
> does not replace them with another attachment policy or a second Codex-server implementation.
> Pinned Codex source also shows that normal official Remote streams and local socket clients enter one
> daemon through the same transport-event/`MessageProcessor` seam and that each physical connection
> owns native initialization and lifecycle state. That is the outward fidelity oracle, not the selected
> inward topology. The target keeps one daemon, moves official Remote transport/enrollment outside its
> isolation boundary, retains each official stream's protocol and subscription state in the gateway,
> and routes admitted semantic native mutations through exactly one native remote-claw bridge with a
> logical binding and aggregate subscription per managed top-level chat thread. Stream-local lifecycle
> changes reconcile the union of current host/collaborator demand to zero or one fenced native
> subscription transition. A child-thread notification remains nested native evidence until lineage proof explicitly
> establishes a different outward mapping. Official
> streams never become native connections or writers. Only compatibility or source-lease metadata that
> differential proof requires may accompany an admitted bridge request, without independent authority.
>
> Every remote-origin proposal crosses one common adjudication boundary. Its frozen decision selects
> exactly one arm of the closed executor-evidence union: native server, native binding, nested
> management, or nested chat edge. A native or nested attempt and its effect gate must
> composite-foreign-key the exact immutable signed admitted-result tuple
> `(collaborationServerId, commandId, admittingCommandResultId, canonicalCommandRecordDigest,
> admittingCommandResultSignedRecordDigest)` and the same decision/executor evidence. An unsigned,
> decision-reserved, queued, rejected, different-command, or different-result record cannot authorize
> an effect. The person at a trusted direct TUI is deliberately outside this remote command path:
> their action enters the native harness directly, and that harness interleaves it with the one
> admitted remote-claw bridge just as it would without remote-claw.
>
> Nested management and nested chat decisions use a compound signing group. The common result signs
> first; only then may the current secondary lineage preparation in that same group sign. The
> management hop also binds the exact signed-result digest. One joint finalizer then atomically
> publishes the signed result, signed lineage, outbox, attempt, and effect gate. The generic result
> finalizer accepts only decisions with no secondary artifact; it cannot finalize either nested arm.
> A downstream nested receipt is a closed
> proof bundle that binds the exact request to the target source event, command, decision/executor
> evidence, and signed result. That target result is terminal version `1` with a null predecessor;
> continuing after a queued result requires a fresh authenticated source event rather than mutating
> the acknowledged result.
>
> The same evidence standard applies to the other adapters. Claude worker delivery ACK is private-RC
> replay bookkeeping, not native acceptance; permission/question resolution closes only from proved
> native terminal evidence, and the exact RC/transcript/provider/turn join remains a retained-fixture
> gate. OpenCode's retained [model-free proof](opencode-native-proof.md) establishes its exact metadata marker and caller-message-ID
> read-back, while a second same-ID `noReply:true` send in one server incarnation appends another part;
> model-bearing behavior, TUI coexistence, controls, permissions, SSE recovery, and takeover remain
> gated. Tmux is lower fidelity because person
> and injector share one editor keystream, so simultaneous drafts can merge and terminal-control
> receipt cannot prove native application.
>
> Inner Claude, Codex, and OpenCode processes have no direct provider connection: remote-claw terminates
> their provider-shaped traffic, drives each through its native control boundary, and independently owns
> model-inference and official-Remote connectors. The local runtime owner, native endpoint, façade, and
> inference connector remain usable without the collaboration coordinator; remote mutations fail closed
> until its journal and epoch recover. [Protocol & Runtime](protocol.md) remains the as-built
> source of truth; this document is the rationale that led to the shipped v2 baseline, not a current
> implementation inventory. The selected host runtime replaces its flat session identity and changes its
> authority and recovery model. In that shipped baseline, the broker-visible `session_id`, viewer row,
> channel suffix, and private synthetic Claude RC `cse_*` are the same value. In the selected target they
> are not: `(collaborationServerId, logicalChatId)` is the server-scoped chat identity, nested edges map
> distinct server/chat pairs, and inner `cse_*`, Claude conversation UUID, Codex/OpenCode IDs, and
> outward-provider session IDs remain separate bindings. Detailed A1 Claude resume/`cse_*` recovery
> passages later in this historical document describe only the terminal Claude edge; outer layers
> reconnect server/chat edges and never create another native app.
>
> A1.0 through A1.3 have landed. A1.0 supplies the shared canonical writer and
> host-state contracts; A1.1 supplies the Linux secure-SQLite kernel and verified protected artifacts;
> A1.2 supplies schema v3 and its high-level server/project/chat/binding/edge/coordinator repository.
> Migration `003-durable-host-records` has 81 ordered statements and digest
> `cMLS59JfiV7fRoK68n1kZz3DN9Vo4yu7VZAX_HxHpq4`; the exact full v3 manifest has 91 objects: 13 tables,
> 24 indexes, and 54 triggers. It can bootstrap and inventory many recovering chats, replace a
> terminal selector generation without retargeting old chats, reconcile persistence outcomes, and
> validate an existing supported v3 graph in one coherent read-only snapshot before writable open;
> a newly migrated graph is validated before the handle returns.
> Persisted chats name their exact selector mapping and use random `rcie_*` installing native edges.
> Evidence refs/digests remain opaque until A1.4; actor scopes are addresses only until A1.7; nested
> mappings and remote-server edges remain rejected until N1.
>
> A1.3 supplies schema v4 and the runtime-owner repository/semantic validator, an independently
> supervised Linux daemon, authenticated bounded local RPC with a 64-connection and 1,024-byte
> pre-authentication inbound ceiling, process-start-bound service leases and
> takeover, wrapped Ed25519 custody, and durable multi-runtime/multi-conversation ownership records.
> Migration `004-runtime-owner-durability` has 141 ordered statements and digest
> `zx52EtAFNY9hEZneG3RW14zRCYR18gg7ysnltHbOkT0`; the complete v4 manifest has 231 rows: 30 tables,
> 57 indexes, and 144 triggers. The exact derivation now locks
> `rcrt_9eXZ6t2i1B6q6KnTszDoABv6BWYw0blCRXoNgPxF1WM` for the selected vector.
> Wrapped `--rc-app` MITM, OpenCode, and tmux paths connect to or best-effort autostart the owner;
> plain and help paths, trace mode, and the local `--rc-identity` action do not. The only successful
> production owner operation is authenticated health; its dispatch registry is empty, and health
> reports `ownerOperationsWritable:false` and `nativeRegistrationEnabled:false`. A0 driver behavior
> remains unchanged and owner unavailability falls back to the exact A0 path. Wrapper exit closes only
> the owner's RPC collaborator and leaves the owner service alive; existing A0 native teardown remains
> separate. No durable owner registration, A1 binding activation, terminal root, owner dispatch, or new
> A1 remote mutation, inference, or broker capability is enabled; A1.4 is next.

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
  **Non-guessable** secrets; in Sealed/Managed the broker is zero-knowledge. The production
  Vercel deployment may be placed behind **Vercel Deployment Protection**; this repository does
  not implement a human-login layer of its own. The broker authorizes each identity-scoped
  data/recovery request with the per-identity `auth_token` (the unguessable
  128-bit `identity_id` + required `auth_token` *is* the anti-scanning gate — no
  separate app-key) (admission, not confidentiality — §4.5).
- The web client keeps its wrapped, tab-scoped credential locally; transcript and ordering state are
  memory-only. Shipped A0 wrapper state is process-local. Claude's on-disk session is the separate
  durable native record; the optional SQLite/libSQL broker retains sealed projection frames, and
  selected A1 adds the authoritative durable coordinator (§6).

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
also out of scope—viewers hold a **pass** (§4.2a), and there is no in-place way to revoke even one
copied pass on retained old routes. To exclude it from future legitimate service, stop every old
relay, **reset the machine** to a new identity, and re-onboard the viewers you still trust (§4.4).

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
   **pass**, not the master: with `--rc-app` set, `--rc-qr` uploads the pass as a **one-time, TTL-bounded
   handoff** so the QR carries only `<app>/#otk1_<OTK>` — a single-use bootstrap token, not the pass
   (see [ephemeral-handoff.md](ephemeral-handoff.md)). Still treat the QR as sensitive (single-use; expires).
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

*Ergonomic promises:* mobile-first, instant, and no repository-owned account/login beyond the
onboarded pass (an operator may still enable Vercel Deployment Protection at the edge); feels like
a messaging app; one pass per machine, onboard as many machines as you run.

### C. Naming & organization
- Each chat's default name is meaningful — the wrapper reads the inner session's
  **repo + branch / cwd** and the **title claude already generates** from the first
  prompt, and includes them (inside the `K_meta`-encrypted `session_announce`).
  Rename is not shipped in A0; local aliases and cross-device/persistent rename are
  deferred (§6C).
- Identities default to **hostname** (an `identity_label` inside the `K_meta` announce, announced by the
  wrapper); chats group under them. The label is the machine's name because the identity **is**
  the machine (one secret per machine). Identity rename is likewise deferred.
- **Online = connected:** a chat shows connected while the latest accepted signed announce has
  `age < 45 s`; its wrapper normally refreshes that announce every 20 s on the identity bus (§6B).
  If a chat you're looking at goes quiet
  (host sleeps/crashes), the app moves its retained row through **reconnecting** to
  **offline**. On a cold open, the shipped viewer also renders any older announcements selected by
  its last-64-frame bus read as reconnecting/offline rows; it has no complete
  durable offline registry (§6C).

### D. Reconnect / offline (what it feels like)
- Phone drops Wi-Fi mid-reply → on reconnect it **silently catches up**; you never
  lose the thread.
- Host sleeps / you close the TUI → the chat you're watching **greys out** (its announces
  stopped); the client **rejects** sending as "host offline." The product has no semantic/native
  command queue. If that client guard is bypassed, shipped A0's transport can still retain an opaque
  relay frame without a live native attachment; that is ambiguous transport buffering, not an
  admitted command, and is covered explicitly in §16 scenario 20.
- Bring the host back (`remote-claw --continue` → `/remote-control`) → Claude's native local history
  is intact, but shipped A0 does not re-stream it over RC. A non-durable relaunch exposes a new,
  initially empty viewer row; a durable broker can retain the old route's sealed projection, but A0
  still lacks the stable logical binding needed to make the relaunched process transparently reclaim
  that row. The selected A1 recovery model supplies that binding (§6/§16).

### E. Security ergonomics (honest with the user)
- A viewer holds a **pass** (§4.2a): read + steer every chat on that **one machine**, but
  **not** the master secret — a lost phone can't recover `S` or reset the machine. Treat a
  pass like a credential. The app stores only pass ciphertext in tab-scoped
  `sessionStorage`, encrypted under a non-extractable AES-GCM `CryptoKey` held by
  IndexedDB. **"Forget identity"** removes that wrapped blob, best-effort deletes the
  device key, and drops the in-memory viewer/transcript state. There is no persistent
  decrypted-message cache. (The raw master secret is the machine's, shown only to the
  operator via `--rc-show-secret`/`--rc-identity`.)
- Lost/leaked pass or secret → stop every running relay for that identity, then **reset the machine**
  and restart: a new secret = a new, unrelated identity for **that machine** (fresh chats); your
  **other machines are untouched**. This abandons rather than revokes the old identity. Copied old
  credentials can still use retained old routes, so there is no partial/per-pass revoke in v1.
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

  Containment requires stopping every relay that captured the old identity, performing the guarded
  machine reset, restarting on the new unrelated identity, and reconnecting trusted viewers there;
  other machines keep working (§4.4). This moves future traffic but does not revoke copied old
  credentials or retained old routes, which remain usable because A0 admission has no
  credential-revocation store.
- **Admission vs. confidentiality (two independent gates).** Confidentiality is the
  zero-knowledge property above (content keys; broker never reads bodies).
  *Admission* — keeping anonymous callers off the selected deployment and identity routes — has
  two independent parts (§4.5): an operator may put the entire Vercel deployment behind
  **Vercel Deployment Protection**, while the **broker** authorizes each identity-scoped
  data/recovery request off the per-identity **`auth_token`** alone—self-verifying
  (`identity_id = trunc(SHA256(auth_token))`), so the unguessable 128-bit `identity_id`
  and required `auth_token` together form the anti-scanning gate (no separate app-key). Neither adds
  confidentiality. Deployment Protection is external to this codebase; an unprotected or self-hosted
  deployment has no repository-owned human-login gate. `/api/handoff` is a separate one-time bootstrap capability (`id` plus proof over a
  sealed TTL row), while cron/dev-admin routes have their own gates. Future: mTLS client identities
  for per-client, revocable admission.

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

```text
  ┌── server A (your machine) ──────────────┐         ┌──── Vercel Workflow profile ─────┐        ┌── phone / laptop ──┐
  │ claude --remote-control                  │         │  POST /api/relay + GET /api/stream│       │  web app (Next.js) │
  │      ▲  MITM (our relay = RC backend)    │  wss/   │   (auth_token gate)               │  SSE/  │  paste PASS →      │
  │      │  + in-memory log (claude=record) │  https  │  per-identity BUS (discover/pres) │ stream │  load keys →       │
  │ remote-claw [claude args] --rc-app <app> ┼────────▶│  per-session WF (resumable stream)│◀──────▶│  decrypt & render  │
  │   (per-machine identity: secret S, 0600) │ ciphertext retained for the run lifetime │        │  encrypt & send    │
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

```text
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
    onboarding step). *(With the broker phase:* if the app origin is configured (`--rc-app`), `--rc-qr`
    uploads the pass as a **one-time, TTL-bounded handoff** and prints `https://<app>/#otk1_<OTK>` + a
    terminal **QR** of it — a single-use bootstrap token, **not the pass verbatim** (the broker stores only
    a hash + an opaque blob; see [ephemeral-handoff.md](ephemeral-handoff.md)). ⚠️ Still treat the QR as a
    credential (single-use, short-TTL; shoulder-surf/recording risk) — **not** "safe to screen-share." It
    **fails closed**: if the upload fails, no QR is printed (never a forever-pass QR). (A raw-`S` deep
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
    secret keeps working on retained old routes indefinitely. Reconnecting viewers you still trust to
    the new identity moves future traffic but does not revoke a copied old credential (§4.4).
  - The secret prints **once**, at create or reset; thereafter only via `--rc-show-secret`. There
    is **no separate symmetric-credential `--rc-rotate` verb** (that rotation was cut) — "resetting" in a
    credential-registry-free, single-secret-per-machine model is just re-creating the identity, so it lives here under the
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
  `/api/*` is the Vercel broker the wrapper POSTs ciphertext to (incl. the one-time `/api/handoff`), and
  its web UI is what the viewer-facing `https://<app>/#otk1_<OTK>` deep-link/QR points at (the UI reads the
  `#fragment` client-side, claims the one-time handoff, and recovers the **pass**, never `S`). One deployment serves both, so
  there is **one** URL — read as an opaque local string (no probe). Unset ⇒ print the bare
  pass for manual onboarding, or omit the link.
  The CLI presents its per-identity `auth_token` to the broker (no app-wide key — §4.5).
- **Starting already remote-controlled** is just claude's own **`--remote-control`** flag,
  which the wrapper forwards verbatim (no separate `--rc-share`).
- **`--help` / `-h`** prints this `--rc-*` help and then **falls through to `claude --help`**,
  so you see both layers in one go.
- The identity's friendly name defaults to the **hostname**, carried as `identity_label`
  inside the `K_meta`-encrypted `session_announce` once RC is on (never sent to the broker
  in the clear). Custom labels and rename are not shipped in A0; they are deferred rather
  than exposed as a CLI flag (§1A C).
- **`--rc-json` / `--rc-quiet`** — machine-readable / minimal output. **Never emit the
  raw secret** in either (a script that truly needs it reads the `0600` file directly)
  — JSON/quiet output is exactly what leaks into CI logs. `--rc-json` takes precedence
  over the bare-token form.

**What the shipped v2/A0 wrapper does** (otherwise it's just claude):
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
  worker→relay event, allocate `seq`, encrypt with the per-session key, and
  `POST /api/relay`; on a non-durable backend also append it to host `#log`. Subscribe to the
  inbound channel (Workflow SSE or SQLite/libSQL log polling), **dedup by `msg_id`**, decrypt,
  allocate `seq`, emit `accepted`, echo and record the user frame, and only then enqueue it for
  Claude. `accepted` is relay receipt/order, not native acceptance.
- **Joins the identity bus** (§6B): on first `/remote-control` it opens the derived per-identity
  channel (`bus:${identity_id}`) on the selected broker backend and **periodically broadcasts** its own signed
  `session_announce{…, sent_at}` (every `ANNOUNCE_INTERVAL` + on change) — that *is* both
  discovery and presence (the shipped client shows it connected while announce age is <45 s, then
  reconnecting and disconnected; §4.3). It exposes the session's stream (`sess:${identity_id}:${session_id}`) for live
  frames. No server-side heartbeat/registry store.
- Maintains **in-memory** relay state (`msg_id` seen-set, sessions, crypto state) accumulated live
  over the process lifetime. On the operationally non-durable Workflow path it also keeps host `#log` and answers
  encrypted `catch_up{since=seq}` from that log. On the durable SQLite/libSQL path, the broker replays
  its sealed frame log and host `#log` stays empty. Claude's on-disk session remains the separate
  native durable layer but is **not** re-streamed over RC; neither broker path gets worker backfill
  (§6).
- The wrapper does **not** outlive the CLI; on exit it stops broadcasting → its announces
  age through the client's 45 s connected threshold + 30 s reconnecting grace → a mounted viewer
  retains those rows as disconnected.

### 3.2 Vercel app (the broker—no registry or plaintext message store)
The Workflow profile collapses to **two data-plane** ciphertext endpoints; there is
**no registry store, no heartbeat, and no message/registry read-list functions** — discovery + presence are
answered live on the per-identity **bus** (§6B).
- **Admission gate (per-identity `auth_token`, §4.5):** every identity-scoped data/recovery request carries
  the bearer `auth_token`; the broker recomputes `identity_id = trunc(SHA256(auth_token))`
  and rejects anything without a valid token with `401` before any per-identity logic — so
  randos can't reach the API to push frames or scrape state. The unguessable 128-bit
  `identity_id` + required `auth_token` *is* the anti-scanning gate; no separate app-key.
  (Vercel Deployment Protection may separately gate the whole deployed origin. `/api/handoff` and
  admin/cron surfaces use the distinct gates described in §4.5.)
- **`POST /api/relay`** (Node, fast + die) — publish one ciphertext frame by
  **value-addressed** `resumeHook(token, frame)`: the per-identity bus token
  `bus:${identity_id}` (a wrapper's periodic `session_announce` broadcast) or a per-session
  token `sess:${identity_id}:${session_id}` (a prompt/control to one session). Gated by
  `Bearer auth_token`; **ciphertext only**.
- **`GET /api/stream?identity=… | session=…`** — subscribe: the Function resolves the
  derived token via **`getHookByToken(token).runId` → `getRun(runId).getReadable()`**
  and pipes the durable stream back as SSE (resume by `startIndex`). `HookNotFound` ⇒
  no channel ⇒ `200` empty. This is the **only frame read path**. A retained offline channel can
  replay old announcements to anyone holding its `auth_token`, while an absent/mismatched identity
  returns empty; there is no independently queryable registry.
- **No relay bus/session channel exists until RC is enabled** (lazy): a wrapper joins the bus only on
  first `/remote-control`. A machine running `remote-claw` (as Claude) with RC off is invisible on
  the relay plane. A separately requested pre-RC `/api/handoff` may hold its sealed short-TTL pairing
  row.
- **Discovery + presence have no materialized server state:** **connected** wrappers periodically
  **broadcast** a signed `session_announce{…, sent_at}` on the bus; a client tails it and
  applies the 45 s connected + 30 s reconnecting display ladder, retaining the row as disconnected
  afterward. A0 admits by incarnation/generation rather than rejecting on age. There is no server
  `heartbeat`/`last_seen` record; SQLite/libSQL may retain the sealed announce frame.
  **Timestamp-driven** (§4.3/§6B). **Multiple wrappers under one identity** coexist because
  the bus is a single relay run that *owns* the hook; wrappers are publishers +
  stream-readers, not hook-owners (so no token collision).
- **Catch-up is wrapper-served on this Workflow profile.** A `catch_up{since=seq}` control frame
  rides the **session channel** (`sess:${identity_id}:${session_id}`) to the wrapper, which replays
  host `#log` (no worker backfill and no `GET /api/messages` store). The durable SQLite/libSQL
  alternative in §6D instead replays sealed frames from its broker log and leaves host `#log` empty.
  The bus carries only `session_announce` broadcasts (§6B).

### 3.3 Web client (stateless, mobile-first)
- Onboard a machine's **pass** (paste/scan, or open a link with the pass in the **URL
  fragment** `#…`, which browsers never send to the server). Load keys in-browser (WebCrypto).
- **Spaces** = **the running instances of ONE machine** — one onboarded pass = one machine, so
  the view is simply a **flat list of that machine's instances** (nothing to
  "group by": the client holds **exactly one pass at a time**). To view a different machine
  you onboard **that machine's pass** (forget + onboard), not accumulate several active at once.
  A just-onboarded machine with nothing shared shows empty until a session is `/remote-control`-ed.
  On a successful connection the client wraps the pass under a non-extractable AES-GCM
  `CryptoKey` in IndexedDB and keeps only the ciphertext in tab-scoped `sessionStorage`.
  Closing the tab removes the wrapped credential, so a new tab must onboard again.
- Pick a space (instance) → message view: request available relay history (decrypt) +
  subscribe live (decrypt) + send (encrypt → POST). Transcript messages and ordering state
  exist only in memory; a persistent browser transcript cache is not shipped.
- PWA, responsive; no server-side session state.

## 4. The secret & key hierarchy (token approach)

One **root secret `S`** per **machine** is the machine's master — held by the operator,
never handed to a viewer. Everything is
derived deterministically with **HKDF-SHA256** (RFC 5869), identical code on CLI
host and web client. A **viewer** receives a derived **pass** (§4.2a) — the operational
keys, not `S`. (All of §4's crypto is the **Sealed** mode; **Open** skips `seal`/`open`
entirely and ships cleartext — §2A.)

### 4.1 Secret format (non-guessable, mobile-pasteable)

```text
rc1_<base64url(S, 32 bytes = 256 bits, no padding)><4-char Crockford-base32 checksum of sha256(S)>
```
~52 chars, one contiguous token (no spaces → safe on iOS/Android paste); the
checksum fails fast on a mistyped/truncated paste before any network call.
256-bit CSPRNG ⇒ not guessable. (BIP39 24-word form offered only as an optional
human-readable *backup* export.)

### 4.2 Derivation (domain-separated siblings)

```text
PRK           = HKDF-Extract(salt="remote-claw/v1", IKM=S)
auth_token    = HKDF-Expand(PRK, "remote-claw/v1/auth",          32B)  → bearer to the Vercel API
identity_id   = trunc(SHA256(auth_token), 16B)                          → PUBLIC identity id = the FIRST (leftmost) 16 bytes of SHA256(auth_token); a FUNCTION of auth_token (so the broker self-verifies the bearer with NO store — changing identity abandons the old routes but does not revoke their bearer; actual revocation requires broker state, §4.4)
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
- **Self-verifying identity auth—no credential lookup store** (§6B).
  `identity_id = trunc(SHA256(auth_token))`, so on a request targeting `bus:${identity_id}` the broker
  recomputes `identity_id` from the presented bearer and checks it matches — **no
  per-identity `sha256(auth_token)` table, no registration**. Knowing the **public**
  `identity_id` alone never grants access (you need `auth_token`; preimage-resistant).
- **Honest scope of `auth_token`:** it is *authorization*, not confidentiality. The live
  bearer is presented on every identity-scoped data/recovery request, so Vercel's TLS-terminating edge (and any
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
  prompts/interrupts/mode changes). One pass grants full viewer/input operation for that one machine,
  minus `S` and the server's separately held Ed25519 output-signing key.
- **What it can't do (HKDF one-wayness).** Holding the four keys never lets a pass invert
  back to `S`/`PRK` (HMAC preimage resistance), so it can **never** re-mint `identity_id`
  or **reset/re-create** the machine — those need the master secret. The hard boundary is
  the master secret / reset, **not** write-vs-read.
- **Reset switches future service; it does not revoke copied passes.** There is no per-pass or old-route
  broker revocation. A new `S` moves the legitimate host and newly paired viewers to another
  `identity_id`, but a copied old pass can still read retained old ciphertext and authenticate
  publishes to retained old routes. It does not learn the new identity.
- **Honest residual (symmetric input authority).** A pass holder can produce valid authenticated
  inbound proposals because the command key is deliberately shared. It can also construct
  AEAD-valid output-shaped ciphertext, but selected A1 viewers reject it without the certified
  server Ed25519 signature. Thus the pass cannot forge a server projection, action result, or
  discovery announcement. The shipped A0 baseline has no such asymmetric output proof.

### 4.3 Session → message key flow (answers "do we need a session→key flow?")
Yes. The shipped A0 baseline uses this three-level hierarchy:

```text
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

**Which key encrypts what (three planes).** In shipped A0: (1) **Content** (transcript) → `K_session`:
`user`, `assistant`, `assistant_sub`, `assistant_thinking`, `assistant_thinking_sub`, `result`,
`system`, `status`, `rate_limit`, `can_use_tool`, `tool_use`, `tool_result`, `task`, and
`permission_request`. This includes an inbound `user` prompt (`dir:in`); a `user` frame is content in
both directions (web→wrapper prompt and wrapper→web echo). (2) **Control** → `control_key`:
`catch_up`, `permission`, `interrupt`, `set_mode`, `set_model`, `end`, `attachment`, plus the reserved
but currently unused `command` kind; slash commands use `user`. (3)
**Meta** → `K_meta`: `accepted`, `session_announce`, and replayable native/projection state
`permission_resolved` (so the broker **can't forge presence, acknowledgements, or gate state** —
AEAD-authenticated, not plaintext).

Selected A1 keeps those plane assignments and adds meta `action_result` for the exact coordinator
decision payload in §6. `permission_resolved` remains a native/projection gate-state observation; it
does not substitute for `action_result` and does not prove that a coordinator-admitted action applied.
The broker holds none of these
keys, so it cannot create AEAD-valid content; a pass holder does share them, so selected A1 additionally
requires the certified host-output signature below before rendering any `dir:"out"` frame. `dir` is bound into AAD, so an `in` prompt and its
`out` echo derive different `K_msg` and can't be confused. **Inbound frames** carry
`msg_id` (+ `client_msg_id` for a `user` prompt) and are replay-checked.

**Presence liveness is timestamp-driven (Design B — §14A).** Recency comes from a **synced wall
clock**, not a client round-trip, which keeps presence to **one signed frame + one
client-side fold** (no `identify?`, no challenge, no `beat_seq`).

- **Session identity is baseline-specific.** In the shipped v2/A0 path, `session_id` below is the
  synthetic Claude RC `cse_*` and also the broker row/channel key. In the selected A1 host runtime,
  `session_id` on one server's broker-facing announce is its stable `logicalChatId`; the globally
  meaningful identity is `(collaborationServerId, logicalChatId)`, and nested edges map distinct pairs.
  The inner `cse_*` and any outward-provider session IDs remain private binding metadata and never
  select a second viewer row on that server.
- **Selected A1 server scope is explicit and authenticated.** `collaborationServerId` is a persisted
  random 128-bit ID encoded as `rcs_<base64url>`; it is not inferred from a title, URL, machine ID, or
  chat. The server's identity key signs, in order,
  `str("remote-claw/server-scope-certificate/v1")`, `uint(1)`, `str(scopeCertificateId)`,
  `bytes(identity_id)`, `str(collaborationServerId)`, `str(subjectIdentityKeyId)`,
  `str(subjectKeyAlgorithm)`, `bytes(rawSubjectPublicKey)`, `uint(keyGeneration)`,
  `uint(issuedAtMs)`, `optionalStr(supersedesScopeCertificateId)`,
  `str(signerIdentityKeyId)`, `uint(signerSequence)`,
  `optionalUint(supersededSignerMaxSequence)`, `str(signatureAlgorithm)`, and
  `str(canonicalPayloadDigestAlgorithm)`, using the exact A1 primitives below. A1 fixes the algorithm
  fields to `Ed25519` and `SHA-256`. Public keys are stored as unpadded base64url of 32 raw Ed25519
  bytes but decoded before serialization; digests are unpadded base64url of 32 bytes, and signatures
  are unpadded base64url of 64 raw Ed25519 bytes. Wrapped, padded, or aliased encodings are rejected.
  The record's digest and signature cover the canonical bytes; their values and mutable certificate
  state do not. Initial enrollment/re-pair is self-signed by the out-of-band pinned subject key. A
  continuity rotation names the new subject key separately from the old trusted signer key.

  The A1 onboarding bundle carries an oldest-to-newest certificate chain and a byte-for-byte matching
  pinned current subject key over the same out-of-band path as the viewer credential. The first
  certificate is the operator-approved self-signed anchor; each next certificate is signed by its
  immediate predecessor and increments the generation exactly once. An already paired viewer may
  receive a suffix beginning with its exact locally current certificate. The verifier requires exact
  `supersedes` links, immutable key-ID-to-public-key bindings, and an atomic compare-and-swap from its
  locally current `(certificate ID, key generation, identity key ID)` to the chain tip; the stored
  current key generation always equals the current certificate's `keyGeneration`. Stale, rollback,
  skipped-generation, concurrent-fork, revoked-signer, or caller-supplied mutable-state claims fail
  closed. The same transaction retires the prior certificate, installs intermediate chain items as
  retired, and makes the tip the server's sole current certificate without ever overwriting a revoked
  status. A cold client can therefore
  verify the complete server scope before subscribing. Nested-server handshakes carry the same
  certified scope.
  `collaborationServerId` is routing identity, not a second bearer; broker admission still requires the
  machine's `auth_token`. Before any route/KDF work, onboarding decodes the four canonical 32-byte key
  strings, recomputes `identity_id = trunc16(SHA-256(auth_token))`, requires exact bundle/certificate
  identity and server-ID equality, matches the pinned subject key, and verifies the certificate
  digest/signature. It also verifies the current server key's versioned
  `ViewerOnboardingKeyAttestationV1`, which binds domain-separated commitments to the decoded
  `authToken`, `contentRoot`, `controlKey`, and `metaKey`; substituting any operational key fails before
  a route or KDF is used. Exact current-tip replay is an idempotent no-op, while only a non-empty
  successor suffix retires the prior certificate. A mismatch is a local splice error, not a broker-auth
  fallback.

  Server signing-key rotation is distinct from A1's deliberately fixed symmetric machine credential
  and `key_epoch=0`. Every server signature receives one durable, globally monotonic signer sequence.
  The old lease drains, then uses its final sequence to sign a successor certificate containing the
  predecessor cutoff; only after that certificate and its public broker update are durable does one
  transaction swap the key/certificate/lease and retire the old private key. Existing viewers fetch a
  contiguous public successor chain when they encounter an unknown signer. A newly observed
  retired-key record needs current-key historical reattestation; exact records accepted before the
  cutoff may replay. The exact custody, canonical certificate/attestation bytes, reattestation, fork
  boundary, and recovery rules are in
  [Client-driven Host Runtime — Reference §4](client-driven-host-runtime-reference.md#4-host-wide-native-client-adapters).
- **Selected A1 routing uses the complete server/chat-or-control scope and injective addresses.** No A1 address
  uses `logicalChatId` alone or raw delimiter concatenation. Define
  `scopeAddress = base64url(SHA256(canonical-encode("remote-claw/a1/scope", identity_id, collaborationServerId)))`
  ,
  `serverControlAddress = base64url(SHA256(canonical-encode("remote-claw/a1/server-control", identity_id, collaborationServerId)))`,
  and
  `chatAddress = base64url(SHA256(canonical-encode("remote-claw/a1/chat", identity_id, collaborationServerId, logicalChatId)))`,
  using the length-prefixed canonical encoding from §8. The discovery token is
  `bus:a1:${scopeAddress}`, the server-control token is `ctl:a1:${serverControlAddress}`, the chat token
  is `sess:a1:${chatAddress}`. Viewer-row keys—and any future local-alias or persistent
  browser-cache keys, if implemented—use
  `(identity_id, collaborationServerId, logicalChatId)`. The session key is derived
  from a canonical encoding of both server/chat coordinates, and A1 AAD binds
  `identity_id`, `collaborationServerId`, and `logicalChatId` separately. The shorter
  `bus:${identity_id}`, `sess:${identity_id}:${session_id}`, and AAD forms elsewhere in this
  historical document describe only the shipped A0 baseline; A0 has neither local aliases nor a
  persistent browser transcript cache.
  Every A1 broker hook/run/cache key, viewer/client row, and channel—and any future alias or
  browser-cache key—therefore commits to the complete machine/server/route scope through one of
  those derived addresses or the explicit tuple. No machine-facing A1 route address, broker hook/run
  cache, viewer/client row, channel, future alias/browser-cache key, frame-plane KDF, or AAD is keyed
  by `identity_id` or `logicalChatId` alone.
  A1 broker requests carry those clear routing fields alongside the opaque derived token. The broker
  recomputes `identity_id` from `auth_token`, recomputes the matching scope, server-control, or chat address from the
  canonical tuple, and constant-time compares both the supplied identity and token before resolving a
  hook. That preserves credential-registry-free bearer-to-route binding; the broker need not understand the signed
  server certificate or plaintext payload.
- **Selected A1 has one byte-level wire contract.** The public
  `@remote-claw/clawsec` `CanonicalWriter` now implements the selected primitive field encoding, and
  shipped A0 `canonicalAad` uses that same writer with its locked byte vector unchanged. This does not
  mean the A1 frame parser, encryption route, or signing path has landed. The primitive encodings are:

  ```text
  bytes(x)         = u32be(byteLength(x)) || x
  str(s)           = bytes(UTF8(s))
  uint(n)          = bytes(u64be(n))
  optionalUint(∅)  = 0x00
  optionalUint(n)  = 0x01 || uint(n)
  optionalStr(∅)   = 0x00
  optionalStr(s)   = 0x01 || str(s)
  optionalBytes(∅) = 0x00
  optionalBytes(x) = 0x01 || bytes(x)
  ```

  In this public writer, `∅` is explicit JavaScript `null`; `undefined` is not an A1 absence encoding.
  The older A0 `FrameHeader` may omit `clientMsgId`, so `canonicalAad` alone adapts that legacy property
  to `null` at its boundary. Integers are non-negative, are not negative zero, and are at most
  `2^53−1`; one encoded bytes/string field is at most `2^32−1` bytes because its length prefix is u32. `finish()` seals the writer and
  returns a fresh defensive copy; caller mutation of input or returned bytes cannot change its
  canonical snapshot. Strings must be well-formed Unicode scalar sequences; lone UTF-16 surrogates
  are rejected. No Unicode normalization or delimiter joining occurs.

  Emitted wire and stored `identity_id` values are exactly 32 lowercase hexadecimal characters.
  The legacy A0 wire decoder also accepts upper- or mixed-case hex and immediately reduces it to the
  same 16 identity bytes; selected A1 storage remains lowercase-only. Selected A1 has these exact
  canonical ID namespaces:

  - random 16-byte bodies: `rcs_` collaboration server, `rcpj_` project, `rcl_` logical chat, `rcie_`
    inward collaboration edge, `rcnb_` native binding, `rccl_` coordinator lease, `rcra_` registration
    attempt, `rcncl_` native conversation lease, and `rcph_` protected handle;
  - SHA-256-derived 32-byte bodies: `rcrt_` native runtime, `ptm_` project-target-selector mapping,
    and `nat_` native delivery attempt. A1.3 now locks the exact domain-separated `rcrt_*` derivation
    and vector documented in the [host-runtime reference](client-driven-host-runtime-reference.md#4-host-wide-native-client-adapters).

  Every body is canonical unpadded base64url. Other selected A1 safe IDs are 1–128 ASCII bytes, must
  match `[A-Za-z0-9._:-]+`, and are never raw provider/native IDs; adapters map unsafe external
  identifiers to durable safe IDs. A1 digests and one-use dispatch authorizations are canonical
  unpadded base64url of exactly 32 bytes. Generic strings accepted by the A1.0 host-state
  parser are 1–1,024 UTF-16 code units, contain only Unicode scalar values, and exclude `U+0000`.
  `record_kind` is one of
  the versioned protocol values.
  `client_msg_id` is either absent or a non-empty safe ID, and `seq` is either null or an integer.
  Certificate IDs and identity-key IDs use the same safe alphabet;
  `supersedesScopeCertificateId|null` uses `optionalStr`.

  The A1 frame header is version 2 and has exactly this canonical-AAD order:

  ```text
  uint(v=2)
  bytes(identity_id)
  str(collaborationServerId)
  optionalStr(logicalChatId)
  str(dir)
  str(record_kind)
  optionalUint(seq)
  str(msg_id)
  str(delivery_attempt_id)
  optionalStr(client_msg_id)
  uint(key_epoch=0)
  uint(part)
  uint(parts)
  optionalUint(server_key_generation)
  optionalStr(host_signer_identity_key_id)
  optionalStr(host_scope_certificate_id)
  optionalUint(host_signature_sequence)
  ```

  `dir` is `in` or `out`; `parts >= 1`, `0 <= part < parts`; non-chunked frames use `0/1`.
  `msg_id` is the stable semantic source/result ID. `delivery_attempt_id` is a fresh random
  `rda_<base64url-128-bit>` for one transport attempt and is identical on all of that attempt's parts;
  a transport retry reuses it, while a later semantic retry creates another. Every chat frame,
  including a bus-carried announce, has a non-null `logicalChatId`. A server-control frame alone has a
  null `logicalChatId`: inbound is typed `new_chat`, and outbound is its
  `chat_creation_result`. For `dir: "in"`, all five host
  authentication fields, including `host_signature`, are null. For `dir: "out"`, all five are non-null and name the certified server key and
  globally unique signer sequence that produced the host signature. Any other combination is invalid.

  The JSON transport object has exactly these fields; `client_msg_id` is omitted when absent, while
  `seq` is present and null when absent:

  ```ts
  interface A1EncryptedFrameV2 {
    v: 2;
    identity_id: string;
    collaboration_server_id: string;
    logical_chat_id: string | null;
    dir: "in" | "out";
    record_kind: string;
    seq: number | null;
    msg_id: string;
    delivery_attempt_id: string;
    client_msg_id?: string;
    key_epoch: 0;
    salt: string;
    nonce: string;
    ct: string;
    part: number;
    parts: number;
    server_key_generation: number | null;
    host_signer_identity_key_id: string | null;
    host_scope_certificate_id: string | null;
    host_signature_sequence: number | null;
    host_signature: string | null;
  }
  ```

  `salt`, `nonce`, `ct`, and non-null `host_signature` are canonical unpadded base64url. `salt` decodes
  to exactly 32 bytes, `nonce` to exactly 12 bytes, `ct` to ciphertext followed by the 16-byte AES-GCM
  authentication tag, and the signature to exactly 64 Ed25519 bytes; `ct` is therefore at least 16
  bytes. Unknown fields, padded or non-canonical encodings, split tag fields, and
  wrong lengths are rejected before decryption. A parser must reject duplicate member names before
  object construction, especially duplicate routing/AAD/signature fields; first-key/last-key behavior is
  forbidden. Every JSON number token (`v`, non-null `seq`, `key_epoch`, `part`, `parts`, non-null
  `server_key_generation`, and non-null `host_signature_sequence`) must use
  canonical non-negative safe-integer spelling `0|[1-9][0-9]*`, at most `2^53−1`; signs (including
  `-0`), leading zeroes, fractions, and exponents are rejected before numeric conversion. JSON member
  order is not security-significant.

  For an outbound frame, define
  `hostSignaturePayload = str("remote-claw/a1/host-output-signature/v1") ||
  str(brokerRouteId) || bytes(AAD) || bytes(salt) || bytes(nonce) || bytes(ct)`. The current fenced
  server signing lease signs exactly that payload. The signature is excluded from its own preimage but
  its key generation, key ID, certificate ID, and sequence are inside AAD. An inbound frame has no host
  signature payload or signature.

  `hostSignedRecordDigest` is the canonical unpadded-base64url SHA-256 of
  `hostSignaturePayload`. Signer-sequence acceptance and historical reattestation key this digest, not
  the transport digest that additionally includes the signature.

  Define the normalized transport bytes as
  `str("remote-claw/a1/transport-frame/v2") || bytes(AAD) || bytes(salt) || bytes(nonce) || bytes(ct) ||
  optionalBytes(host_signature)`.
  `transportFrameDigest` is unpadded-base64url SHA-256 of those bytes. Selected A1 requires a durable
  ciphertext broker whose unique key is route-wide `(route token, delivery_attempt_id, part)`. The
  broker parses the exact clear frame and recomputes normalized bytes/digest rather than trusting a
  supplied digest. Its first insert atomically stores `(channelGeneration, frameIndex)` and that
  `transportFrameDigest`; a retry before or after rollover returns the original cursor only if the
  recomputed digest is identical, while unequal normalized bytes fail closed as a transport collision.
  The host's unique lookup key is
  `(brokerRouteId, delivery_attempt_id)`; it durably binds the
  source namespace, result, header, and part count as immutable data and classifies a new position as
  an exact semantic retry or a collision. The stored attempt-header digest is unpadded-base64url
  SHA-256 of `str("remote-claw/a1/attempt-header/v1") || bytes(stableLogicalHeader)`. Multipart
  grouping uses `(route token, delivery_attempt_id)`, while semantic adjudication uses the full
  server/chat/source-namespace scope plus `msg_id`. Inner `cse_*`, native session IDs, and
  outward-provider IDs never enter this header. The capped, no-rollover Workflow broker remains supported for
  shipped A0 only and cannot advertise A1 recovery.

  A viewer first binds the externally selected route, validates the exact frame shape, and resolves the
  signer through the certified server scope. For outbound frames it verifies the server sequence and
  Ed25519 signature before AEAD open or render. A current key is accepted directly; an exact
  previously accepted retired-key record may replay only at or below its signed cutoff, while a newly
  observed retired-key record requires a retained current-key historical reattestation. An unknown key
  pauses the route while the viewer fetches the retained public certificate-successor chain. Missing,
  forked, unsigned, wrong-route, or invalidly signed output is quarantined and never rendered. A viewer
  cannot see the server-local signing lease; the host signing service enforces that fence, and the host
  coordinator separately requires the frame to match its immutable signed outbox row before
  classifying it as known host output. Thus a copied A1 pass can authenticate an inbound
  proposal but cannot forge a server projection or discovery announcement.

  Physical ordering is per authenticated route, not per parsed chat. Define
  `brokerRouteId = rcr_${base64url(SHA256(str("remote-claw/a1/broker-route/v1") ||
  bytes(identity_id) || str(collaborationServerId) || str(routeKind) ||
  optionalStr(logicalChatId)))}`. `routeKind` is `scope_bus` or `server_control` with a null route
  chat, or `chat` with the exact non-null chat. The scope bus therefore has one cursor/manifest
  sequence shared by all announcements, the server-control lane has a separate management-ingress
  sequence, and each chat stream has another. Every position is first recorded under
  `(brokerRouteId, channelGeneration, frameIndex)` from the authenticated request route and raw-byte
  digest. Same cursor/same bytes is idempotent redelivery. Same cursor/different bytes durably records
  broker equivocation, quarantines that route, and performs no parsing, decryption, semantic mutation,
  or cursor advance.

  Each route is atomically created with open generation zero. A null cursor means before `(0,0)`;
  it never means “start at the broker's latest generation.” Mutating chat recovery requires the retained
  contiguous cursor or the complete immutable manifest chain from genesis. The mutating
  server-control route has the same requirement. Missing genesis or a broker
  that starts at `N > 0` is non-writable. The scope bus alone may use a fresh, separately
  host-signed checkpoint for discovery-only cold start: the broker first seals an exact generation and
  opens its successor, then the host signs separate metadata over that sealed tip. It is not a frame,
  cannot seed a chat cursor, and cannot acknowledge a mutation. Open/empty/rollover, freshness, and
  checkpoint-equivocation rules are exact in the runtime reference.

  For a new position, route matching precedes KDF selection/open. The frame identity/server must equal
  the selected route; a chat route also requires its exact non-null chat and rejects
  `session_announce`, `new_chat`, and `chat_creation_result`. The scope bus accepts only outbound
  `session_announce` with a non-null announced chat belonging to its server. The server-control route
  requires a null chat and accepts only inbound `new_chat` or outbound `chat_creation_result`.
  Cross-machine, cross-server, cross-chat, bus↔control↔chat, and null/non-null transplants become invalid positions on the
  selected route and are never dispatched by the transplanted header. A malformed bus position can
  quarantine only the scope-bus cursor actor; it cannot block or be misfiled into one chat stream.

  A sealed generation's digest is unpadded-base64url SHA-256 of
  `str("remote-claw/a1/broker-generation-manifest/v1") || str(brokerRouteId) ||
  uint(channelGeneration) || uint(frameCount) || uint(nextGeneration) || str("sealed")`; the successor
  is exactly `generation + 1`. Open rows have null count/successor/digest, while sealed rows have all
  three non-null. The first accepted tuple is immutable. Exact duplicate manifests are idempotent; a changed count/state/successor or a position
  at or beyond sealed `frameCount` records durable manifest equivocation and quarantines the route
  without rewriting order. The complete schema and recovery transition are in
  [Client-driven Host Runtime — Reference §4](client-driven-host-runtime-reference.md#4-host-wide-native-client-adapters).

  A1 retains chat and server-control ciphertext frame bodies from genesis so newly paired clients can
  traverse their mutating history. Only a sealed scope-bus generation covered by a fresh host-signed
  successor checkpoint may compact its discovery-only ciphertext after every supported recovery lease
  has passed. Every route keeps the route-wide attempt/part→original-cursor/digest tombstone and
  generation manifest indefinitely.
  Selected A1 defines no safe collection transition: closing a local chat or resetting one machine does
  not revoke copied bearer/key material, and A1 has no broker-enforced route revocation or in-place key
  epoch. A future bounded-retention design needs a separate authenticated broker-enforced revocation
  protocol; ordinary retention, chat closure, and machine reset do not authorize collection.

  Route inputs use the same primitives and exact order:

  ```text
  scopeBytes =
    str("remote-claw/a1/scope") ||
    bytes(identity_id) ||
    str(collaborationServerId)

  serverControlBytes =
    str("remote-claw/a1/server-control") ||
    bytes(identity_id) ||
    str(collaborationServerId)

  chatBytes =
    str("remote-claw/a1/chat") ||
    bytes(identity_id) ||
    str(collaborationServerId) ||
    str(logicalChatId)
  ```

  `scopeAddress`, `serverControlAddress`, and `chatAddress` are unpadded base64url SHA-256 of those
  corresponding bytes. A scope request carries `identity_id`, `collaborationServerId`, and
  `bus:a1:${scopeAddress}`. A server-control request carries the same identity/server coordinates and
  `ctl:a1:${serverControlAddress}`. A chat request also carries `logicalChatId` and
  `sess:a1:${chatAddress}`. The three token prefixes and address domains cannot alias.

  Plane keys are derived byte-for-byte as follows. The onboarding bundle's serialized `metaKey` field
  decodes to the mathematical `K_meta` input below:

  ```text
  chatInfo(label) =
    str(label) ||
    bytes(identity_id) ||
    str(collaborationServerId) ||
    str(logicalChatId)

  serverControlInfo(label) =
    str(label) ||
    bytes(identity_id) ||
    str(collaborationServerId)

  K_session_a1 = HKDF-Expand-SHA256(content_root,
    chatInfo("remote-claw/a1/content-key/v1"), 32)
  K_control_a1 = HKDF-Expand-SHA256(control_key,
    chatInfo("remote-claw/a1/control-key/v1"), 32)
  K_meta_a1 = HKDF-Expand-SHA256(K_meta,
    chatInfo("remote-claw/a1/meta-key/v1"), 32)
  K_server_control_in_a1 = HKDF-Expand-SHA256(control_key,
    serverControlInfo("remote-claw/a1/server-control-in-key/v1"), 32)
  K_server_control_out_a1 = HKDF-Expand-SHA256(K_meta,
    serverControlInfo("remote-claw/a1/server-control-out-key/v1"), 32)
  ```

  A scope-bus announcement uses the announced chat's `K_meta_a1`; an ordinary chat frame uses its
  chat-scoped content/control/meta plane; an inbound server-control `new_chat` uses
  `K_server_control_in_a1`, while its outbound `chat_creation_result` uses
  `K_server_control_out_a1` plus the mandatory host signature. The selected authenticated route and exact nullable-chat/kind rules are
  checked before choosing that key. Then compute the A1 canonical AAD above and derive
  `K_msg = HKDF-SHA256(IKM=planeKey, salt=salt,
  info=str("remote-claw/a1/msg-key/v1") || bytes(AAD), L=32)`. Encrypt with AES-256-GCM using the
  12-byte nonce and that AAD. No A0 `session_id` KDF/AAD form is accepted when `v=2`.

  Durable semantic digests deliberately exclude transport-attempt randomness. Define
  `stableLogicalHeader` with the same writer and this exact order:

  ```text
  uint(v=2)
  bytes(identity_id)
  str(collaborationServerId)
  optionalStr(logicalChatId)
  str(dir)
  str(record_kind)
  optionalUint(seq)
  str(msg_id)
  optionalStr(client_msg_id)
  uint(key_epoch=0)
  ```

  After a part has successfully opened under the full AAD, compute
  `authenticatedPartDigest = SHA256(str("remote-claw/a1/stable-part/v1") ||
  bytes(stableLogicalHeader) || uint(part) || uint(parts) || bytes(openedPart))`. Compute
  `canonicalMessageDigest = SHA256(str("remote-claw/a1/logical-message/v1") ||
  bytes(stableLogicalHeader) || uint(parts) || bytes(completeReassembledPlaintext))`.
  Both stored digest strings are the canonical unpadded-base64url encoding of the 32 digest bytes.
  These local digest values are not exposed to the broker. Fresh `delivery_attempt_id`, salt, and
  nonce therefore change ciphertext/AAD but not the stable part or logical-message digest for an exact
  semantic retry.
- **Each session announces itself; clients subscribe.** A *session* has its own relay controller,
  **independent of every other session** (§1); one wrapper process may host several controllers, and
  each publishes **its own** announce. While RC is on, a session (every `ANNOUNCE_INTERVAL`, and
  immediately on any change) broadcasts
  `session_announce{session_id, title, cwd, identity_label, status, last_activity, sent_at, incarnation, incarnation_started_at, announce_seq}`
  on the identity bus — the *whole* payload AEAD under `K_meta`, `sent_at` and
  `incarnation_started_at` are the wrapper's wall clock **inside the ciphertext** (broker can't forge a
  fresh or later one). No client→wrapper request.
- **Shipped A0 presence is a display-state ladder, not an announce-admission window.** A client tails
  the bus and builds its list keyed by `session_id`; `shouldAcceptAnnounce` folds valid decrypted
  announcements by incarnation/generation ordering but does **not** reject one merely because
  `sent_at` is old or future-skewed. `connState` shows **connected** while
  `age < CONNECTED_WINDOW = 45 s`, then **reconnecting** for a
  `RECONNECTING_WINDOW = 30 s` countdown anchored when that row is first observed stale, then
  **disconnected**. The row remains in memory. A cold viewer may therefore seed a disconnected row
  from an old announcement in its last-64-frame bus slice.
  `FRESH_WINDOW = 60 s` is the separate current expiry-stamping constant: the four direct verbs
  enforce it, while `catch_up` ignores its stamped expiry. It is not the A0 presence threshold.
- **Selected A1 tightens admission.** Its row is keyed by
  `(identity_id, collaborationServerId, logicalChatId)`; the machine coordinate keeps broker routes,
  viewer rows, and any future browser-cache keys from colliding. A1 requires the exact server
  scope/key/status/sequence and certified host signature before AEAD open, plus the two-sided
  `now − FRESH_WINDOW ≤ sent_at ≤ now + SKEW` check. Its intended defaults are
  `ANNOUNCE_INTERVAL = 20 s`, `FRESH_WINDOW = 60 s`, and `SKEW = 5 s`; both window edges must
  accommodate expected clock skew, with `SKEW ≪ FRESH_WINDOW`.
- **The liveness check defeats stale replay.** In A1,
  `route-bound && certified-host-signature-valid && AEAD-valid && in-window` rejects server-output
  **forgery** even by a pass holder, and rejects **replay/withhold-and-dribble** (a re-sent announce carries an old `sent_at`
  → out of window), and **stale-seeding of a fresh/late client** (same). The two-sided
  window also stops a *fast-clock* session's announces being replayable forever (future-dated
  beyond `SKEW` → rejected). Inside that window, `incarnation_started_at` and `announce_seq` prevent
  broker/request reordering from rolling current-host state backward; they are a wall-clock fence, not a
  durable epoch. **Exact false-online
  bound:** replay/withhold can never *refresh* `sent_at`, so an announce hard-expires at
  `sent_at + FRESH_WINDOW`; a maximally future-skewed clock is accepted out to `now + SKEW`,
  so the **worst observed false-online for a dead session is `FRESH_WINDOW + SKEW`** (≈65 s
  at the defaults) — not exactly one window — after which it greys.
- **Restart / new session / late client.** In current A0, a restarted relay that somehow retains the
  same `session_id` broadcasts a later `incarnation_started_at` and clients un-grey that row. An
  ordinary wrapper/Claude restart instead mints a new synthetic RC `session_id`, so an already-open
  viewer keeps the old row as disconnected and adds a separate row. A cold reload reads the broker's
  last-64-frame bus slice and can show both the stale disconnected row and the new connected row; it
  is not a complete offline registry. That is a current implementation fact, not the selected
  recovery model.
  A1 persists the `(collaborationServerId, logicalChatId)` scope and uses its durable coordinator
  epoch for restart ordering. It first resumes the stored Claude conversation UUID and tries the known
  private `cse_*`; if Claude needs a replacement `cse_*`, that value becomes a new fenced inner
  transport attachment under the same canonical `(collaborationServerId, logicalChatId)` chat and
  native binding. Its broker channel and viewer row remain keyed by the full
  `(identity_id, collaborationServerId, logicalChatId)` scope.
  Either way, the new worker epoch is tied to the current native-process incarnation and coordinator
  epoch. The RC worker still supplies no historical backfill.
  A newly-created logical chat broadcasts immediately and appears as a new row. A late client asks
  for the bus's **last 64 retained frames** with `startIndex=-64`. That tail slice normally includes
  each live session's latest announce; if activity displaced one, that session renders absent until
  its next broadcast within ≤ `ANNOUNCE_INTERVAL` (+jitter).
- **Clock assumption and blast radius.** Shipped A0 uses the wrapper's `sent_at` directly for its
  display-state age and does not apply a future-skew admission bound, so a badly skewed timestamp can
  produce a wrong dot or a long-lived stale row. That remains scoped to presence display: message
  **confidentiality and integrity** are clock-free (`K_session`/`control_key` AEAD), and message
  replay defense is `msg_id`-based. The shipped message-plane clock check is encrypted `expiry` on
  `interrupt`, `set_model`, `set_mode`, and `end` (§6A/§8); `catch_up` carries but does not enforce
  it, and `permission` currently omits it. HTTP `409` is reserved for the separately typed transient
  channel-disposal/replacement publish race. Selected A1's certified two-sided window supplies the
  bounded `FRESH_WINDOW + SKEW` false-online claim; current A0 does not. A zero-clock-trust
  challenge-handshake variant is recorded in §14A.

### 4.4 Machine reset (a "burn", not a true rotation) & the revocation tension
Resetting a machine here is a symmetric credential **replace scoped to one machine**, not an in-place
machine-key rotation (there is no symmetric-key rotation, forward secrecy, or epoch ratchet; the master
deterministically **re-derives** its keys, which is exactly what makes paste-to-reconnect work):
generate a **new `S`** ⇒ new `identity_id` ⇒ a **new, unrelated identity for THIS machine** (a
fresh, empty set of spaces) and **abandon** the old one. **Other machines, each with their own
secret, are untouched** — there is no fleet-wide re-onboard. There is no stable identity with a
swapped credential, and **no broker-side revocation** — see the tension below. The CLI surface is
**`--rc-identity --rc-confirm <identity_id>`** (§3.1) — there is no separate `--rc-rotate` verb,
because in a credential-registry-free, single-secret-per-machine model "resetting" *is* re-creating that machine's
identity. It is guarded (the confirm typo-check
and a TTY, unless `--rc-force-noninteractive`) and **securely deletes** the old `S` by default:
because the same `S` deterministically re-derives the *same* keys, a retained copy is a **full live
viewer/input credential (it can still decrypt retained ciphertext and authenticate inbound proposals
on old routes). This statement does not preclude the separate server Ed25519 signing-key continuity
rotation in §4.3; that rotation neither changes A1 route/KDF keys nor revokes a pass.

**What a reset does and does *not* do.** It moves **this machine** to a new bus; it does **not**
revoke the old one. Because the broker keeps no credential/revocation registry (§4.5),
`bus:${old_identity_id}` is never torn down and the old `auth_token` still self-verifies **forever** —
anyone still holding the old `S` (or
a pass derived from it, §4.2a) keeps a live credential and can keep
subscribing to and publishing on the abandoned routes. It can forge inbound proposals, but selected A1
viewers reject forged `session_announce` or other server output without the old server's certified
signature.
So this is **abandonment, not revocation**: it contains a leak only for this machine's *future*
traffic (the attacker can't follow it to the new `identity_id`), and only once you reconnect the
viewers you still trust to the new identity. It
gives **no forward secrecy** for past frames and does **nothing** against a *host* compromise
(claude's plaintext `.jsonl` history sits on the host regardless of identity, which a
host-resident attacker reads anyway). Secure-deleting *your* copy never denies an attacker who
already has theirs — reconnect the viewers you still want promptly. The blast radius is exactly
**one machine**: the others, on their own secrets, never noticed.

**Running relays capture their derived identity at launch.** Replacing or deleting the secret file
does not notify an already-running MITM, OpenCode, or tmux relay: that process can keep broadcasting
and accepting old-pass input under the old identity until it exits. A safe operator reset therefore
stops every relay launched from the old secret, performs the guarded replace, and starts fresh
processes from the new secret. Process supervision that atomically enforces that stop-before-replace
sequence is not implemented; reset alone is neither runtime containment nor credential revocation.

**The revocation tension (credential-registry-free identity admission is the constraint).**
`identity_id = f(auth_token) = f(S)` and the broker self-verifies with **no credential/revocation
store** (§4.5), so **{ registry-free admission · stable `identity_id` ·
revoke-a-leak } are mutually exclusive — pick two** (an information-theoretic result: a registry-free
broker's admit decision is a *pure function* of the bearer, and a pure function with a fixed output
address can't have a shrinking accept-set). This holds **per machine** — each machine's identity is
  its own instance of the tradeoff. Changing `auth_token` and `identity_id` abandons the old identity
  and sacrifices continuity, but it does **not** deny the leaked credential on retained old routes; it
  only moves trusted future traffic elsewhere. Actually denying that old credential requires broker
  memory for revocation, sacrificing registry-free admission. The one scoped upgrade worth naming,
  spending exactly one property on purpose:

- **Server-registered split** — `S_server` (broker) + `S_paste` (user); delivers real
  paste-(content)-revocation with a stable identity, but **requires a broker store and weakens
  zero-knowledge** (the broker then holds a content-key input), and never revokes `auth_token`
  itself.

(A stable-identity *epoch ratchet* was previously sketched here; **rotation/forward-secrecy was cut**
from the design, so it is dropped. The `key_epoch` field still bound into the AAD (§4.3/§8) is a
**fixed constant** for wire stability, **not** a rotatable epoch — there is no per-frame re-keying.)

Reset performs no re-encryption or migration. Native conversation history is claude's plaintext
`.jsonl` on the host (§6), so there is no native transcript ciphertext under `S` to re-key.
Separately, selected A1 retains broker ciphertext encrypted under chat/server-control plane keys
ultimately rooted in the operational keys derived from `S` (§4.2–§4.3). Replacing `S` starts
unrelated routes and protects future frames with new keys; it neither re-encrypts nor deletes or
revokes ciphertext retained on the old routes, which an old `S` or pass can still access and
decrypt. Any future old-route migration or revocation therefore needs an explicit stateful
protocol. (Cf.
the **Happy/Codex mobile app**, which *does* offer per-device revocation — but only because it is
**account-based and server-stateful**: a phone-held master secret, per-machine DEKs wrapped to an
account content key, and "remove machine from account" revokes that machine's DEK server-side. That
is the asymmetric, server-stateful end of this same tradeoff — the opposite corner from our
paste-and-go `S` with no credential registry; see **§18** for the full comparison.) `info` labels carry `/v1/` for
future migration.

### 4.5 Deployment admission & broker authz

These are separate gates, and **no shared bearer is baked into the public bundle**.

- **Deployment perimeter—Vercel Deployment Protection when enabled.** The production/preview
  deployment can sit behind Vercel's edge authentication. Human browsers complete that external
  login; headless host requests carry `x-vercel-protection-bypass`, sourced from
  `VERCEL_AUTOMATION_BYPASS_SECRET`, so they can reach the same protected origin. The CLI scrubs
  that bypass secret from the native child process. This is deployment-wide abuse protection, not
  identity authorization or E2E confidentiality.
- **No repository-owned human login yet.** `apps/web` has no Better Auth dependency, auth
  middleware, user table, or session implementation. An unprotected/self-hosted origin therefore
  exposes the UI and capability endpoints directly, subject only to each route's gate below.
  Operators must supply a perimeter if they want coarse human admission. A repository-owned OIDC
  or SAML login layer remains a future option; it must not be described as shipped.
- **Broker data/recovery plane—per-identity `auth_token`, self-verifying, no credential store.**
  Every identity-scoped data/recovery request carries the bearer `auth_token`; the broker recomputes
  `identity_id = trunc(SHA256(auth_token))` and constant-time-compares it to the requested bus (§4.2). What
  protects a *specific* identity's bus is (a) its 128-bit `identity_id` being **unguessable**
  and (b) needing the matching `auth_token` to publish/subscribe — so an anonymous rando with
  no valid `auth_token` is rejected, and **no separate app-key is needed to stop blind
  scanning**. The broker sees `identity_id` + the bearer (it *could* route/replay on a bus) but
  **can't decrypt or forge** (E2E keys, §4.2). Because admission is a pure function of the bearer
  with **no store**, the broker has **nothing to revoke**. A whole-identity replacement moves trusted
  future traffic to a new `identity_id` but leaves the leaked `auth_token` valid on retained old
  routes; denying that credential requires a stateful revocation design (§4.4).
- **One-time bootstrap plane—`/api/handoff`.** This route does not take the identity bearer. It is an
  unauthenticated high-entropy capability endpoint: the host stores a sealed short-TTL row under an
  OTK-derived ID/proof hash, and one claimant proves the OTK-derived secret to atomically return and
  burn it. The dedicated handoff store is ciphertext-only but stateful; WAF rate limiting is a deploy
  gate. Cron and dev-admin routes use their own secrets/environment restrictions
  ([Ephemeral Handoff](ephemeral-handoff.md)).
- **The CLI is headless:** the wrapper authenticates to the broker with the per-identity
  `auth_token` it derives from its secret (no interactive login, no app-key), plus the optional
  deployment-protection bypass when the selected origin requires it. `--rc-app` only names the
  broker/web origin.
- **Confidentiality unchanged:** this is *authorization*, not confidentiality — zero-knowledge
  still rests entirely on the content/meta keys (§4.2), and only in **Sealed**/**Managed** (in
  **Open** there is no encryption, by design — §2A). The broker sees only ciphertext in
  Sealed/Managed.
- **Future (stronger CLI admission): mTLS client identities.** For the headless CLI path,
  augment the per-identity `auth_token` with **mutual-TLS client certificates** so each wrapper
  (and, later, device) authenticates with its own cert — per-client, individually revocable
  admission. Deferred (cert provisioning + Vercel mTLS support add friction); the per-identity
  `auth_token` is the v1 gate; any deployment-wide human admission is presently supplied outside
  this repository.

## 5. Message flow (both directions, ciphertext only)

The broker receives **no plaintext message bodies**. Every frame goes through `POST /api/relay`
(bearer `auth_token`, ciphertext only). The Workflow profile appends it to a persistent,
absolute-indexed resumable stream for that run. The stream retains its chunks for the run lifetime;
it is not a rolling window, but the shipped adapter has no rollover or recovery fence at the
25,000-event run cap and therefore treats this profile as non-durable. The durable SQLite/libSQL
profile persists the sealed frame row in an indexed ciphertext log with explicit recovery cursors
(§6D).

**Worker → web** (assistant output): worker emits event → the wrapper's relay allocates `seq` and
encrypts it (`K_session`, fresh `K_msg`), appending to host `#log` only on a non-durable backend →
`POST /api/relay {identity_id, session_id, dir:"out", record_kind, seq, salt, nonce, ct}` → the
selected backend appends it to the Workflow out-stream or SQLite/libSQL frame log → subscribed web
clients decrypt and render.

**Web → worker** (your prompt): web encrypts a `user` content frame (`dir:"in"`,
`client_msg_id`, under `K_session`) → `POST /api/relay` → the selected channel subscription wakes or
is read by the wrapper → wrapper **dedups by `msg_id`**, decrypts, assigns `seq`, emits
`accepted{client_msg_id, seq}` on the outbound channel, echoes and records the user frame, and then
**injects into Claude via the Phase-0-verified MITM downstream** (the worker SSE path — see
[`phase0-findings.md`](phase0-findings.md)). The user frame is recorded before the inject, but
`accepted` itself is only relay receipt/order and is deliberately emitted before native delivery.
The current relay does not have a native idempotency key: if delivery may have crossed the
worker boundary and its acknowledgement is lost, a later legacy retry can execute the prompt twice.
`msg_id` deduplicates the relay/viewer frame, not Claude execution. The selected host runtime records
that case as `outcome_unknown` and does not retry automatically. Claude replies → the worker→web path
above.

**History follows the selected relay path, never the worker.** A Workflow subscriber can re-read the
current run's persistent stream by absolute `startIndex`; because that profile lacks safe cap
rollover and durable host-recovery fencing, the wrapper also keeps host `#log` and serves encrypted
`catch_up{since=seq}`. A durable SQLite/libSQL subscription replays sealed frames directly and the
host ignores `catch_up`. Neither path has a plaintext `/api/messages` store. For live tailing: read
by `seq`, dedupe by `msg_id`, and order by `seq` (broker delivery is at-least-once, not FIFO—§6).

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

It concentrates every "smart" on the TUI host. (⚠️ Grounded correction: an earlier
draft claimed the worker "replays/backfills" prior turns to our relay on RC connect;
a later plan-review softened that to *unproven*. Fresh `--rc-trace` captures now
**disprove** it outright (see §17 and `docs/protocol.md` §12): `POST …/bridge` returns
only a `worker_jwt` (no transcript), the worker SSE stream carries only **new** inputs,
a `--resume`d worker is streamed **no** prior history, and `historical` appears in
**zero** captures. Projection history therefore comes from the remote-claw relay path—the current
Workflow run's sealed resumable stream plus host `#log`, or the SQLite/libSQL sealed frame log—**never**
worker backfill or Anthropic's cursor API (`GET …/events?cursor=`, which the wrapper does **not**
call). See §14.)

- **In shipped A0, Claude's on-disk session is the separate durable native record; projection history
  is backend-specific.** The wrapper sees every frame in both directions. A Workflow run retains its
  sealed stream chunks and supports absolute-index replay for that run; the adapter nevertheless
  reports `durable:false` because it has no 25,000-event rollover, `maxSeq`, or `frameCount` recovery
  fence. The wrapper therefore also keeps an in-memory per-session `#log` keyed by `seq`; that log
  covers only this wrapper process and is never reseeded from Claude. On the durable SQLite/libSQL
  profile, the broker retains the sealed frame log and host `#log` stays empty. Neither projection
  source is Claude's full `~/.claude/projects/.../<session>.jsonl`.
- **In-session projected history has no worker backfill.** A viewer joining or reconnecting gets every
  frame still available on the selected relay path since RC enabled: Workflow first replays the
  current run's persistent stream and can also receive the wrapper's `catch_up{since=seq}` replay;
  SQLite/libSQL replays its durable broker log (both host-catch-up and durable-log paths are covered by
  the `relay.test.ts` reconnect suite). Claude owns the native session and final applied order; the
  wrapper allocates the separate viewer-projection `seq`; the broker receives no plaintext. There is
  no worker completeness gate: the wrapper joins the bus and broadcasts `session_announce` as soon as
  it is serving, and a racing client receives whatever the selected relay path has accumulated.
  - **Residual gap the worker genuinely can't fill** (grounded, accepted): a `--resume`d
    session's pre-resume turns are not replayed on the RC wire. Current A0 loses its logical-chat
    binding on wrapper restart; Workflow loses host `#log` even though the old run may still retain
    that old route's sealed stream, while SQLite/libSQL may retain the old route's sealed projection.
    An ordinary relaunch still exposes a new broker-visible session and row, so neither old route
    automatically repairs the replacement. A1 does not ask the worker to repair that:
    it persists the stable `(collaborationServerId, logicalChatId)` scope, first resumes the stored
    Claude conversation UUID and known private `cse_*`, and otherwise records a replacement `cse_*` as
    a new inner transport attachment under the same native binding and broker row/channel. The transport
    attachment and native-process incarnation advance independently; each worker epoch records which
    process currently owns it. History repair comes from persisted synthetic RC state and proven native
    transcript evidence, never worker backfill.
- **`seq` is allocated solely by the wrapper.** Clients never assign transcript
  order: a web client sends a `client_msg_id`; the wrapper decrypts, commits to its
  relay path, assigns the canonical `seq`, emits `accepted{client_msg_id, seq}`, then
  echoes/records the user frame before forwarding it to Claude. `accepted` is relay receipt/order
  rather than proof of native delivery or application.
- **Shipped A0 replay behavior has a known acknowledgement gap.** Delivery is at-least-once, and the
  current relay uses an unbounded process-local `msg_id` `Set` (plus chunk reassembly) before acting.
  An already-seen frame is silently dropped; the original `accepted` result is not retained or
  re-emitted. The durable sampled inbound floor skips older broker indices after restart, but it is not
  a semantic idempotency record: it cannot prove the outcome of a command whose acknowledgement was
  lost, and the same source ID re-appended above the floor meets an empty set. The shipped behavior is
  documented exactly in [Protocol & Runtime](protocol.md) §§5–6 and must not be called exactly-once.
- **Selected A1 replay is durable, authenticated, and result-bearing.** Before forwarding a proposal,
  the coordinator authenticates and fully reassembles it. The unique durable result key is
  `(brokerRouteId, sourceEventNamespaceId, msg_id)` and stores the canonical
  whole-message digest, decision, command order, explicitly separate viewer-projection `seq`, action
  result, stable semantic result ID, exact result payload, and ingress cursor. Part rows inherit that
  full scope through the result foreign key. Chat and server-control ciphertext/plaintext part bodies
  are retained from genesis; only checkpointed discovery-only scope-bus bodies may be compacted. The
  expected part count and complete part-digest vector remain with every result indefinitely. A single
  old part never returns success: after completion, every
  expected part of a replay candidate must match before the stored result is eligible. Changed
  coordinates, part count, part digest, or final whole-message digest are quarantined as a collision.

  The stable semantic result ID is exactly
  `rrs_${base64url(SHA256(str("remote-claw/a1/semantic-result/v1") || bytes(identity_id) ||
  str(collaborationServerId) || str(routeKind) || optionalStr(logicalChatId) ||
  str(sourceEventNamespaceId) || str(msg_id)))}`.
  The result row, outbound frame `msg_id`, and payload `result_id` all use that value. For a complete
  semantic A1 proposal, first derive
  `sourceCommandIdentityDigest = SHA256(str("remote-claw/command-source/a1/v1") ||
  bytes(identity_id) || str(collaborationServerId) || str(routeKind) ||
  optionalStr(logicalChatId) || str(sourceEventNamespaceId) || str(msg_id))`. Its common command ID is
  `rcm_${base64url(SHA256(str("remote-claw/collaboration-command/v1") ||
  str(collaborationServerId) || str("a1_ingress") ||
  bytes(base64urlDecode(sourceCommandIdentityDigest))))}`. This is the same common adjudication identity
  used by official, automation, and nested sources after each derives its source-identity digest. No
  result, command, effect gate, or attempt is keyed by source `msg_id` alone.

  The deciding transaction freezes one exact arm of the closed executor-evidence union:
  `native_server`, `native_binding`, `nested_management`, or `nested_chat_edge`. Every later native or
  nested attempt and command-wide effect gate composite-foreign-keys
  `(collaborationServerId, commandId, admittingCommandResultId, canonicalCommandRecordDigest,
  admittingCommandResultSignedRecordDigest)` to that one immutable signed
  `disposition:"admitted"` result and repeats its decision/executor evidence. No transport ACK,
  attempt, gate, file write, native request, or nested send can exist before the admitted result is
  signed and atomically finalized. A decision-reserved or unsigned result, a queued/rejected result,
  or a result from another command or executor fails closed. Actions typed directly in a trusted
  native TUI do not masquerade as common remote commands: they enter the native harness on its
  separate native path, and the harness remains the final arbiter of their order against remote-claw.

  The A1 web `sourceEventNamespaceId` is immutable for the route's full lifetime and is derived as
  unpadded-base64url SHA-256 of
  `str("remote-claw/a1/web-source-namespace/v1") || bytes(identity_id) ||
  str(collaborationServerId) || str(routeKind) || optionalStr(logicalChatId)`, prefixed `wns_`. It does not change on reconnect,
  coordinator replacement, broker rollover, local chat closure, or machine reset. Selected A1 provides
  no namespace-change transition for an existing route, so withholding an unseen old ciphertext cannot
  move it into a new namespace. A reset creates a distinct new identity/routes without reclassifying or
  garbage-collecting the old route. Official and nested connectors retain their separate authenticated
  namespace contracts.

  A retry keeps the stable `msg_id` and logical bytes but uses a fresh authenticated
  `delivery_attempt_id`; all parts of that candidate share it. New, pending-duplicate,
  terminal-replay, collision, incomplete-expiry, and restart behavior use the
  atomic state machine in
  [Client-driven Host Runtime — Reference §4](client-driven-host-runtime-reference.md#4-host-wide-native-client-adapters).
  Partial groups are size/count/deadline bounded; terminal incomplete tombstones let the contiguous
  cursor advance and cannot later resurrect. A terminal exact replay creates no echo, log entry,
  projection sequence, command, or inward delivery. Instead it enqueues the same stored semantic
  result in a fresh persisted delivery envelope: `msg_id` remains the stable result ID and
  `delivery_attempt_id` is new. A1 broker/viewer transport deduplication uses
  route-wide `(route token, delivery_attempt_id, part)` and returns the original cursor across
  generations; after opening, the viewer folds the encrypted
  result by stable `result_id`.

  An admitted `user` or `attachment` proposal uses meta `record_kind: "accepted"` and exact compact UTF-8 JSON
  `{v:1,result_id,client_msg_id,seq}`, where `seq` is the separately stored viewer-projection order.
  Every queued/rejected proposal, and every admitted control other than `attachment`, uses meta
  `record_kind: "action_result"` and exact compact UTF-8 JSON
  `{v:1,result_id,source_msg_id,source_record_kind,decision,command_seq}`. Keys are emitted in that
  order with no extra fields; `decision` is `admitted`, `queued`, or `rejected`, and `command_seq` may
  be null. Every string value is either one of those fixed literals or an A1 safe ID matching
  `[A-Za-z0-9._:-]+`, so JSON escaping is never needed; quotes, backslashes, controls, non-ASCII, and
  optional slash escaping are rejected rather than normalized. Payload `v` is exactly the token `1`.
  `seq` and non-null `command_seq` use the canonical non-negative safe-integer token
  `0|[1-9][0-9]*`, at most `2^53−1`; a sign, leading zero, fraction, or exponent is rejected. Null
  `command_seq` is the literal `null`. These are coordinator admission/order results, not proof of
  native application. An admitted attachment from any source always uses
  `canonicalCommandPayloadSchemaId:"remote-claw/command-payload/attachment/v1"` and these exact
  common bytes:

  ```text
  str("remote-claw/command-payload/attachment/v1") || uint(1) ||
  optionalStr(caption) || uint(itemCount) || bytes(base64urlDecode(itemVectorDigest))
  ```

  An omitted source caption is canonical null; an explicitly present empty caption is a non-null empty
  string, so adapters cannot silently conflate them.
  The retained item vector contains the exact ordered filename, media type, byte length, and decoded
  content digest for every item under the canonical item/vector schemas in the
  [runtime reference](client-driven-host-runtime-reference.md#4-host-wide-native-client-adapters);
  its count, every item digest, and every content ref/digest must recompute. Adapter JSON, a
  source-base64 spelling, and an `unsupported_recognized` payload cannot substitute for that chain.
  The selected target family must name the same common attachment schema plus its proved native
  translator/read-back contract before the command can be admitted. Semantic validation performs no file write; the
  decision-reservation transaction allocates exactly one viewer-projection sequence and freezes the
  common decision/result payload, but creates no ACK, projection intent, or native attempt. After
  protected-key signing, the non-nested generic finalizer verifies that no secondary artifact is
  required, then atomically stores the signed common result, retained `accepted` projection payload,
  user attachment projection intent, and write-ahead-fenced native attempt. A later dispatcher
  performs the file write and offers the prompt to the harness. Exact replay creates no second
  file, projection, sequence, or native attempt; it only redelivers the stored `accepted` result.
  Changed attachment bytes under the same semantic ID are a collision. Thus neither the broker nor an
  A0-style `msg_id` orderer suppresses a later result delivery. Controls use the same
  identity/digest/result rule. This is the contract that makes retrying the complete exact logical frame
  safe.

  The server-control route is the only no-chat ingress. It accepts one non-chunked
  `record_kind:"new_chat"` with null `logical_chat_id`/`seq`, required `client_msg_id`, and exact
  compact JSON `{v:1,intent,project_id,workspace_selector_id}` in that key order. `intent` is
  `first_bootstrap` or `new_chat`; the two selectors are safe IDs. No caller target/native ID,
  directory/header alias, title/history match, provider coordinate, marker, or extra field is allowed.
  Every complete proposal receives the server-wide command order. A rejected proposal returns
  host-signed `chat_creation_result`
  `{v:1,result_id,source_msg_id,decision:"rejected",target_logical_chat_id:null,command_seq}`.
  An admitted one allocates one random target chat and returns the same shape with
  `decision:"admitted"` and that non-null ID. Its server-control header has `dir:"out"`, null
  `logical_chat_id`, `seq=command_seq`, required `client_msg_id` exactly echoing the proposal, the
  stable result ID as `msg_id`, `part=0`, `parts=1`, and all five host-authentication fields non-null.
  The decision-reservation transaction atomically allocates the target chat route/genesis and recovering
  record, freezes the selected executor, and creates the exact common-result preparation/signing
  reservation plus its compound signing group; it creates no result output, native/nested attempt, or
  effect gate. A terminal-native arm requires no secondary artifact: after protected-key signing, the
  generic finalizer atomically inserts the signed common/A1 result, output intent, starting native
  binding, fenced native creation reservation, and command-wide creation effect gate. A nested-server
  arm instead pre-reserves its management-lineage preparation in that group. The common result signs
  first, the secondary lineage hop binds that exact signed-result digest and signs second, and only
  the nested joint finalizer may atomically insert the signed common/A1 result, signed lineage, output
  intent, nested-management attempt, and effect gate. The generic result finalizer cannot finalize
  this arm, and the nested arm creates no native binding.

  The target answers a nested-management attempt with one closed receipt-proof bundle. It binds the
  exact request and source event to the target common command, canonical command digest,
  decision/executor evidence, and complete signed result. The target result is terminal version `1`
  with a null predecessor; exact replay returns the same proof and bytes, while a different result,
  another version, or a non-null predecessor quarantines the attempt. Because server-control creation
  admits or rejects rather than queues, only an admitted target may proceed. The source installs a chat
  edge only after that admitted proof, readiness, rooted path, two-party install, and live handshake
  all verify. Exact source replay returns identical bytes/target/executor and cannot allocate another
  chat, native POST, or nested send. A management binding is writable only after both servers sign the
  same live TLS-exporter transcript and make the resulting lease current locally; a one-sided install
  is non-writable. If a nested-management or ordinary nested-chat transport is
  replaced before any byte could have been sent, only a signed continuation over the exact old/new
  leases and capability snapshots, unchanged semantic target/request/family, and positive
  never-started evidence may install a successor. The transport writer first creates one immutable
  `armed@1` authorization. It may consume that authorization only in the final send CAS, which also
  moves the physical child and command-wide gate to `started`; only then may a byte be written. A
  pre-send abandonment instead CASes the still-armed authorization to `revoked@2`, leaves the gate
  `never_started`, and produces the exact source-server-signed positive-never-started attestation.
  Continuation installation verifies that signature and every command, result, request, target,
  lease, capability, typed authorization reference, canonical dispatch digest, state-version, and
  revocation-journal binding, then inserts one fresh `armed@1` successor while the same gate remains
  `never_started`. It never rewrites a started gate. A consumed, started, or uncertain predecessor
  permanently forbids another send. Ordinary chat and scope-bus routes reject both creation kinds.

  A complete authenticated but unsupported proposal still receives an ordered command and rejected
  `action_result`; it receives no viewer-projection sequence, user projection, file write, or native
  attempt. OpenCode attachments take this path until the exact binding/incarnation capability snapshot
  proves native file-part request and read-back fidelity. Exact replay only redelivers the rejection;
  changed bytes collide.
- **Shipped non-durable A0 catch-up is an encrypted control frame to the wrapper.** A client sends an
  **AEAD-encrypted** `catch_up{since=<last-seen seq | 0>, msg_id, expiry}` (control
   frames use a derived control key + replay check — never plaintext the broker
   could inject); the wrapper serves the delta from its log (re-posting the logged
   frames with their original `seq`/`msg_id`; the client's orderer dedups), then live.
   **As built, `catch_up` is stamped with `expiry` but the host does not validate it**; see
   [Protocol & Runtime](protocol.md) §11. On a durable SQLite/libSQL backend, subscription itself
   replays the sealed frame log; host `#log` is empty and any `catch_up` received by the host is
   ignored.
  Selected A1 preserves each stored semantic `msg_id` and projection `seq`, but every catch-up
  delivery is a fresh persisted outbox row with a fresh `delivery_attempt_id`; retries of that same row
  reuse its attempt ID. The receiver transport-deduplicates the attempt, then folds the opened frame by
  stable semantic result/projection identity. Reusing the original delivery attempt for catch-up is
  forbidden because same-generation broker dedup would suppress it.
- **Shipped A0 Workflow relay profile = persistent per-run stream with an unhandled cap cliff**
  (§6B). Discovery and presence are messages on the per-identity **bus**, not rows in an application
  registry. Ciphertext frames go out over **SSE from a streaming Vercel Function**, backed by the
  Workflow persistent resumable stream. A subscriber can resume that run from an absolute
  `startIndex`, including index 0; the stream is not a rolling recent-frame buffer. When the SSE
  connection hits Vercel's function-duration cap (or drops), the client reconnects to the same run.
  The wrapper also keeps host `#log` and answers `catch_up`, but current production has no
  pre-25,000-event rollover, generation handoff, or host recovery cursor for Workflow, so the adapter
  correctly reports `durable:false` and cannot promise continuity across the run-cap cliff.
  Shipped A0 also has the SQLite/libSQL profile, whose sealed broker log supplies replay while host
  `#log` stays empty (§6D). Selected A1 requires more than either A0 profile: a
  durable ciphertext frame log with atomic route-wide delivery-attempt uniqueness, generation
  manifests, and cursor reads. The broker still receives no plaintext.
- **The shipped web client keeps transcript messages and its `FrameOrderer` only in memory.**
  A cold viewer asks the selected relay history path for available projection frames from the
  beginning; it has no IndexedDB transcript cache or cached `seq`. While a transcript generator
  remains live, its in-memory orderer makes transport re-subscription idempotent. A persistent
  browser transcript cache is deferred. In this historical baseline, the wrapper relay owns
  viewer-frame order while Claude's native state remains the semantic execution record; the selected
  host runtime replaces this with the split authority described at the top of this document.

Historical Workflow-baseline consequence: a known current run can replay its retained sealed stream
even when the TUI is briefly offline, but host `#log` catch-up requires the wrapper and neither source
bridges the unhandled run-cap cliff or a new A0 route after relaunch. (Live Claude RC sessions
themselves end roughly 10 minutes after the worker goes offline.) The shipped SQLite/libSQL profile
can replay a known route's sealed projection without host `#log`; an offline registry/listing and
independently queryable history index remain deferred (§6C).

Historical baseline invariants across the broker backends discussed here: **the broker sees ciphertext only**; ordering is by
wrapper-assigned `seq`; live delivery is **at-least-once** so clients dedupe by
`msg_id` and reorder by `seq`; crypto happens in the TUI + browser and in thin
Functions/steps, **never** inside the deterministic `'use workflow'` body (random
nonces / stream reads break replay determinism).

## 6A. Message types, channels & Workflow run state

For the current baseline, the broker stays dumb, the wrapper owns viewer-frame order, and Claude owns
native execution state. Here is every
frame, every channel, and exactly what the current Workflow run retains so that
live delivery + reconnection feel natural without the workflow becoming the record.

### Frame types (`record_kind`)
All frames share the §8 envelope (AEAD ciphertext + cleartext routing header).
`dir`: **out** = wrapper→web, **in** = web→wrapper. **Three AEAD keys** (§4.2):
**content** → `K_session` (transcript); **control** → `control_key` (control plane);
**meta** → `K_meta` (`accepted`/`session_announce`). Every frame is AEAD-authenticated —
the broker forges nothing.

Content frames (transcript; encrypted under **`K_session`**; carry `seq`). A `user`
frame is content in **both** directions — `in` = the typed prompt (carries
`client_msg_id`), `out` = the wrapper's echo:

| kind | dir | source | notes |
| --- | --- | --- | --- |
| `user` | in / out | client (prompt) / wrapper (echo) | typed prompt carries `client_msg_id`; `out` echo carries the wrapper-assigned `seq` |
| `assistant` | out | RC | model output (+ partial deltas if we enable them) |
| `result` | out | RC | turn complete (cost / usage) |
| `system` / `status` / `rate_limit` | out | RC | lifecycle (init, "requesting", limits) |
| `can_use_tool` | out | RC | permission request, *if* a mode ever gates a tool |

Control frames (**in** — web client → wrapper → worker, on the **session** channel;
encrypted under **`control_key`** and carrying `msg_id` in the authenticated header, §8).
**Shipped A0 replay defense is the process-local `msg_id` seen-set (clock-free).** For `interrupt`,
`set_model`, `set_mode`, and `end`, the encrypted body also carries `expiry`, stamped exactly
`FRESH_WINDOW = 60 s` after viewer creation; transport delay consumes that window, and those verbs
reject a first delivery after it expires. `catch_up` is stamped with the same field, but the current host does not
validate it; `permission` currently carries no expiry and its branch performs no expiry check. Thus an
old authenticated `catch_up` can cause redundant replay after a non-durable host restart, while a
withheld permission answer can act if its native gate is still open (§4.3 and
[Protocol & Runtime §11](protocol.md#11-control-verbs-and-freshness)):

| kind | maps to RC verb | notes |
| --- | --- | --- |
| `catch_up` | — (ours) | request history `since=seq` |
| `permission` | `control_response` | allow/deny a `can_use_tool` |
| `interrupt` | `interrupt` | ESC / stop the current turn |
| `set_mode` | `set_permission_mode` | e.g. bypassPermissions toggle |
| `set_model` | `set_model` | switch model |
| `end` | no worker verb in the current relay | clear open relay permission gates; native session stays alive |
| `command` | — | reserved control-plane kind; the current viewer sends slash commands as `user` content |

**Ordering & acknowledgement (control plane is not FIFO).** The broker may reorder controls, so a
client that issues **order-dependent** controls serializes them and observes the prior native effect
before sending the next. Shipped A0 does not provide a general safe-retry acknowledgement contract:
an exact same-`msg_id` retry during one relay incarnation is silently dropped, while a retry with a
fresh ID can repeat an action whose earlier outcome was merely unobserved. A read-only `catch_up` may
be re-sent with a fresh `msg_id`, accepting redundant replay; a mutating control must instead reconcile
native state/effect or surface an ambiguous outcome rather than blindly retry. Selected A1 stores each
control's authenticated digest and action-specific result before advancing its ingress cursor, so an
exact replay returns that result without applying the action again. A
`nack{msg_id,reason}` remains an optional projection of that durable result, not a substitute for it.

Our non-content meta frames (**AEAD under `K_meta`** — broker can't forge them):

| kind | dir | notes |
| --- | --- | --- |
| `accepted` | out | wrapper ack of a client frame: `{client_msg_id, seq}` |
| `session_announce` | out (bus) | the **periodic broadcast** that is *both* discovery and presence: `{session_id, title, cwd, identity_label, status, last_activity, sent_at, incarnation, incarnation_started_at, announce_seq}`, whole payload AEAD under `K_meta`. Each **independent session controller** broadcasts **its own**, one per `ANNOUNCE_INTERVAL` (§4.3) + on change. Shipped A0 keys by `session_id`, folds by incarnation/generation (legacy `sent_at` fallback), and classifies the retained row with the 45 s connected + 30 s reconnecting ladder; it does not freshness-reject an old announce at admission. Selected A1 adds the certified two-sided freshness check. No client discovery request frame reaches the wrapper, and there is no challenge/`beat_seq`. |

(`catch_up` on a non-durable backend re-posts the original content frames with their
`seq`/`msg_id`; durable subscription replay yields the stored frames directly. The client's orderer
dedups either path—there is **no** separate `historical` kind or wire flag. There is
**no** server-side `heartbeat`/registry and **no** `identify?`/`present` — presence is a
signed `session_announce` reduced to a client-side connected/reconnecting/disconnected state.)

### Channels (two logical kinds, both addressed by a derived token—§6B)

- **identity bus** (`bus:${identity_id}`): one channel per identity, **identity-level only**.
  Wrappers periodically broadcast `session_announce`; clients tail it and compute presence from
  `sent_at` freshness. **Discovery + presence only**—no client discovery request frame to the
  wrapper and no control/turn frames.
- **per-session stream** (`sess:${identity_id}:${session_id}`): live turn frames plus all
  per-session traffic—prompts, outputs, `catch_up`, permissions, and RC verbs.
- **Backend mapping:** Workflow maps each token to one relay run, `resumeHook` publisher, and
  resumable out-stream. SQLite/libSQL maps each token to one channel database, idempotent insert, and
  indexed subscription poll. The Workflow path consumes hook/step events in both directions; the
  SQLite path retains sealed frames.
- No presence channel and no registry — both are subsumed by the bus.

### A0 transport and host state

On the Workflow backend, a broker run (the bus or a per-session run) holds the persistent resumable
stream, its absolute-index replay positions, and the inbound **hook**; stream chunks remain available
for that run rather than rolling out of a recent-frame window. It has no `msg_id` dedup set, and the
shipped adapter has no safe rollover or recovery fence at the 25,000-event run cap, so it is
operationally non-durable. On the durable SQLite backend, each channel's database retains the sealed
frame log, while `UNIQUE(gen, msg_id, part)` makes an exact physical re-POST idempotent inside that
channel generation. Neither transport is a durable semantic command/result map.

The viewer's `FrameOrderer` separately has a bounded 8,192-key rendering-dedup window. On
both backends, the host wrapper's per-session relay has an incarnation-long, unbounded
`msg_id` seen-set. That set prevents a re-read from re-injecting an old command during the
same relay lifetime, but it is lost on restart and remains a known A0 memory/recovery
limitation. Host `#log` contains projected history only on a non-durable backend; it stays
empty when durable broker subscription supplies that sealed history
([Protocol & Runtime §5](protocol.md#5-delivery-discipline-viewer-frameorderer-host-command-dedup)).
The Workflow run provides live delivery and same-run absolute-index replay up to its unsupported cap
boundary; the durable backend retains ciphertext projection history with explicit recovery cursors.
The host supplies incarnation-local replay suppression, and the bus provides discovery/presence
messages. None proves a durable semantic command outcome.

### Lifecycle (the natural flow)
RC enabled → the session's wrapper joins the identity **bus** (`bus:${identity_id}`), starts
**broadcasting its own `session_announce`**, + opens its per-session stream.
Live turn → `assistant`/`result` flow the session out-stream, `user` arrives via the
session channel; clients tail; the wrapper emits `accepted`, then echoes/records the user
frame before native injection. Brief reconnect (web or
wrapper) → resume by `seq`/`startIndex`. Workflow can replay the current run from the requested
absolute index, and the wrapper additionally serves `catch_up` from host `#log`; on a durable
SQLite/libSQL backend, subscription replays the broker frame log and the host ignores `catch_up`. A
client opening cold tails the bus from `startIndex=-64` → sees up to the last 64 retained
`session_announce` frames at connection time, including stale ones that become
reconnecting/disconnected rows.
Session ends / wrapper exits (it never outlives the CLI) → it stops broadcasting → its last announce
ages through the 45 s connected threshold and 30 s reconnecting grace → clients mark the row
disconnected. Claude retains native history, but it does
not backfill RC; viewer projection may remain on an old Workflow run or in a durable broker frame log,
but an A0 relaunch starts a new logical row and does not bind either old route to it.

## 6B. The per-identity bus & fresh-browser cold start

The "registry" is **not a stored table** — it's a **per-machine message bus** (one per
`identity_id`, which is now a machine id). Every
**connected** session (an independent relay controller; one wrapper process may host several)
**periodically broadcasts** its own signed `session_announce`; a client tails the bus, keys
by `session_id`, and renders every generation-accepted announce among the last 64 retained bus frames
requested at connection time.
It classifies a row **connected** for 45 s, then **reconnecting** for 30 s, then
**disconnected**. Stale rows are retained rather than freshness-rejected. There is no materialized
server `heartbeat`/`last_seen` state; both Workflow and SQLite/libSQL may retain sealed announce
frames, but the client's `startIndex=-64` request provides only incomplete offline listing (§6C).
**Timestamp-driven presence**
(§4.3)—no client discovery request frame to the wrapper, no challenge, and no `beat_seq`.
**Channel split:** the **bus** carries only `session_announce` broadcasts; all per-session
traffic — prompts, turn frames, `catch_up`, permissions, RC verbs — flows on that
session's own channel (`sess:${identity_id}:${session_id}`), so the bus stays low-rate.
(Settled by a research→design→verify panel against the SDK type defs — §13/§14A.)

The logical bus contract above is backend-independent. The detailed
`getHookByToken`/`getRun`/`resumeHook` mechanics below describe the Workflow
implementation. The shipped SQLite/libSQL implementation derives the same token, maps it to one
channel database, publishes by idempotent insert, and subscribes by indexed polling/replay; it does
not create a Workflow run or hook.

### It's value-addressed — no stored pointer (verified)
The fear was that a Workflow stream is reachable only by its **random `runId`**, forcing
a stored `identity_id → runId` pointer. **It isn't, for the live case.** The SDK exposes
**`getHookByToken(token): Promise<Hook>`** (public, callable from an API route — exact
signature confirmed in `@workflow/core`/`@workflow/world` type defs, §13), and the
returned `Hook` **carries `runId`**. So a **deterministic token is a stable channel
name**, and the whole bridge is:

```text
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
  create-race loser's run dies with that error while its caller keeps polling `getHookByToken` and
  resolves (resume-tails) the winner — nothing in our code `catch`es the conflict; the losing
  *workflow run* terminates. This create conflict is not returned to the caller and is not an HTTP
  `409`; only the separately typed vanished-hook race between channel resolution and publish has
  that retryable response. Within a *single* broker process, concurrent publishers to the same
  token (one wrapper's near-simultaneous announce + serve + presence heartbeat) are collapsed by an
  **in-process singleflight** on `ensureChannel`: only one `start()` is in flight per token while
  `resolveOrStartChannel` runs (the map entry clears on settle), so the SDK conflict path is reached
  only by genuinely distinct wrapper processes racing — not by a single wrapper racing itself.
- **Long-lived; durable, no idle reaper (verified §13).** The bus run loops awaiting its
  hook. Vercel sets **no max run duration and no idle-timeout** — a suspended run waits
  **indefinitely** and **consumes no compute while idle** (only storage-retained billing).
  The run is **shared by all of the identity's sessions** (each publish just emits a
  `hook_received` event and resumes it); `getHookByToken` keeps resolving and `start()`'s
  random runId is irrelevant because the **token** is the durable address. **Consequence:**
  when the last session leaves, the bus run does **not** auto-end — it simply goes quiet and
  the token stays resolvable. A cold client classifies any announcements in its last-64-frame tail slice
  as reconnecting/disconnected, or renders an empty list if none remain; either result is harmless
  for liveness. The run ends only if the workflow returns, fails, is cancelled, or is explicitly
  closed. *Optional* self-cleanup: to free the token
  on inactivity we can race the hook against a **durable `sleep`** (the documented pattern for
  a hook timeout, vercel/workflow#553) and complete the run if no publish arrives for, say,
  a few `ANNOUNCE_INTERVAL`s — but it's not required for correctness. ("Holds the hook"
  elsewhere = the run stays alive awaiting its hook; no wrapper owns it.)
- **The cap-roll primitive exists; the shipped controller does not.** The internal `__close` payload
  makes the workflow close its stream, return, and dispose the token; a later publisher can start a new
  run under the same token. Integration tests exercise that explicit transition. Production
  `POST /api/relay` rejects `__close`, however, and neither the host nor broker counts run events or
  initiates a pre-cap close. Therefore current A0 must not claim a deliberate or lossless 25k-event
  rollover. Behavior at the platform cap remains an availability release gap. A finished future
  controller must fence publishers, close before the cap, publish a durable generation handoff, and
  prove retry/cursor behavior. Selected A1 instead requires the durable generation-manifest broker in
  §4.3.
- **"Connected" derives from announce age, not mere bus existence.** A resolvable bus only means a
  wrapper once created it. A0 renders generation-accepted announcements from the requested
  last-64-frame slice and applies its
  45 s connected + 30 s reconnecting ladder; an old replay can therefore create a disconnected row.
  `HookNotFound` renders empty, while a resolved bus with stale retained announcements need not.
- **Browser path.** `getHookByToken` needs server-side World credentials, so the browser
  doesn't call it directly — it hits our **`GET /api/stream?identity=…`** Function, which
  resolves the token and pipes the run's stream back as SSE (gated by `Bearer auth_token`).

So the application registry is **nothing**: no rows, presence keys, or pointer. Discovery/presence
live as sealed frames on the bus. Projection history comes from the current Workflow run's persistent
sealed stream plus host `#log`/`catch_up`, or from sealed broker replay in SQLite/libSQL; Claude's
native transcript remains separate.

### State layers in the Workflow backend

| layer | lives in | durable? |
| --- | --- | --- |
| **native transcript/effects (the record)** | Claude `.jsonl` plus the working tree/processes it mutated | durable host evidence |
| **viewer projection history** | current Workflow run's persistent out-stream + wrapper in-memory `#log` | provider-backed for that run and process-local backup; no safe run-cap/restart handoff |
| **the bus** (identity-level: discovery + presence only) | **one Workflow run per identity**, addressed by token `bus:${identity_id}` | provider-backed for that run; shipped cap rollover is not implemented |
| **per-session frames** (high volume) | per-session Workflow out-stream | provider-backed for that run; 25,000-event cap cliff |
| **functions** | — | **none** |

"**There is no application registry store**": the provider persists each run's opaque stream, but
remote-claw stores no separate identity/session row or token→run pointer. The bus is reached by a
derived hook token.

### Cold-start sequence (paste pass → live list)
Computed live from the bus — **no store, no enumeration, no discovery request frame, lazy** (nothing
exists until a wrapper enables `/remote-control` and starts broadcasting):

1. **Load the pass (no network).** Parse/validate the machine's **pass**; load its four
   operational keys (`auth_token` → `identity_id`, `content_root`, `control_key`, `K_meta`,
   §4.2a) — no HKDF, no `S`. The pass never leaves the device.
2. **Subscribe to the bus.** `GET /api/stream?identity=identity_id`
   (`Bearer auth_token` — broker recomputes `identity_id=trunc(SHA256(auth_token))` and
   checks it matches, §4.2). The Function `getHookByToken("bus:"+identity_id)` →
   **HookNotFound ⇒ no bus ⇒ nothing connected ⇒ `200` empty**; else
   `getRun(runId).getReadable({startIndex:-64})` → SSE, reading the **last 64 retained bus
   frames**. Each live session's latest `session_announce` is normally present and arrives at once.
   If activity displaced one from that tail slice, the session appears within ≤
   `ANNOUNCE_INTERVAL` (+jitter) on its next broadcast — a brief gap, not a permanent miss.
   (Offline/absent/mismatch all return the same empty, so status never leaks an *offline*
   identity; a *connected* one is observable to anyone holding its `auth_token`.)
3. **Render—pure subscribe, no ask.** Decrypt each `session_announce{…, sent_at}` (AEAD
   `K_meta`), fold it by incarnation/generation, and add/refresh the row. `connState` classifies it
   connected, reconnecting, or disconnected from its age; A0 does not discard it merely for being
   stale. The list fills from that last-64-frame slice and stays current from the wrappers' periodic +
   on-change broadcasts. No client→wrapper discovery request frame is sent.
4. **Open a chat.** Tap a session → subscribe to **its per-session stream**, addressed by
   the **derived token** `sess:${identity_id}:${session_id}`
   (`GET /api/stream?identity=…&session=…` → `getHookByToken`→`getRun`→`getReadable`) + send
   `catch_up{since}` for history. High-volume turn frames flow there, **not** on the bus.

### Live greying (timestamp-driven, client-local)
While RC is on, each **independent session controller** **broadcasts**
`session_announce{…, sent_at}` on the bus every `ANNOUNCE_INTERVAL` (=20 s default, §4.3) +
immediately on change, AEAD under `K_meta` (`sent_at` = wrapper wall clock, inside the
ciphertext). Current wrappers also include an opaque `incarnation`, its wall-clock
`incarnation_started_at`, and a strict per-incarnation `announce_seq`. A client folds each
session by that restart/generation order (legacy frames fall back to `sent_at`), then shows it
**connected while `age < 45 s`**, **reconnecting** for a 30 s grace anchored when first observed
stale, then **disconnected**. When broadcasts stop (host sleeps/crashes), the retained row moves
through that ladder; when it resumes, or a new session starts, the next announce
un-greys/adds it automatically—without a discovery request frame to the wrapper or a
challenge/`beat_seq`. `FRESH_WINDOW = 60 s` is the separate direct-control expiry bound
(`catch_up` is stamped but does not enforce it), not this presence threshold. The incarnation start is
only a wall-clock restart fence, **not** a durable coordinator epoch: a clock-regressed start fails
stable, while equal starts use opaque-incarnation lexical order. That order prevents flips but cannot
prove which process is newer; A1 removes that ambiguity.
**Replay/withhold behavior:** an old timestamp does not become fresh merely because the broker
replays it, so under an honest clock it cannot turn a disconnected row back to connected. A0 does
not, however, freshness-reject that frame: a cold viewer may seed an offline row from it, and there
is no future-skew bound. Selected A1 adds the certified two-sided admission window (§4.3).
This is a **purely client-side liveness reduction** with no materialized server presence state; the
recent broker window offers incomplete, opportunistic offline listing rather than a durable registry
(§6C). Cost: each session's announce is a bus **event**
(one per session per interval, broadcast even when no client is watching) → they nudge the
Workflow bus toward its unsupported event-cap cliff. High-volume turn frames stay on separate
per-session runs, isolating the bus budget,
but they still consume hook/step events on those runs. Keep the interval generous (§12).

### Honest caveats (verified — §13)
- **Offline listing is opportunistic, not complete.** A cold viewer can show stale rows selected by
  its last-64-frame bus read, but there is no independently queryable registry and older rows may
  fall outside that client-requested slice (§6C).
- **Presence is timestamp-driven** (§4.3): shipped A0's dot/state ladder trusts the wrapper timestamp
  without a future-skew admission bound. Clock error can therefore produce a wrong or long-lived dot,
  but never changes message security (§12). Selected A1 adds the bounded certified window.
- **Two-call composition** (`getHookByToken`→`getRun`→`getReadable`): each call is
  **docs-confirmed** (§13) — incl. the `getRun(id).getReadable({startIndex})` reconnect in
  the resumable-streams guide — but the *cross-process bus wiring* (resolve a derived token to
  another process's runId, then tail it) is **our** composition, so it's a P3 integration
  check, not a re-derivation.
- **Run-roll handoff is not shipped.** Every publish in either direction enters through a hook and
  `emit` step and approaches the 25k-event cap. The explicit-close/recreate primitive works, and a
  publisher retries a transient disposal race, but no production component currently decides when to
  close or proves a complete handoff. Separate per-session tokens isolate the identity-bus budget; they
  do not solve the cap.
- **Size/chunking** (§8): the shared relay route rejects decoded ciphertext above **3.3 MB** so
  base64url JSON stays below the approximately **4.5 MB** edge/request limit. Workflow's later hook
  request and **10 MB** stream-chunk ceilings do not raise that shared limit. Split larger logical
  payloads into independently sealed frame parts.
- **`getHookByToken` is server-creds + live-only** (hooks dispose at terminal state) —
  fine: the browser goes via our Function, the bus is long-lived, and history is
  `catch_up`, never a dead-run read.

## 6C. Deferred: offline registry, listing, and browsable history

**A complete offline registry is out of scope this phase.** The bus's client-requested last-64-frame
tail slice can opportunistically seed stale reconnecting/disconnected rows on a cold viewer, but it is neither
complete nor independently queryable. A durable application registry/index would be required for
reliable offline listing or a history browser. Upstash Redis, Vercel Blob, and Neon were investigated
(Edge Config does not fit), but that registry/index is explicitly deferred. This does not defer the
shipped SQLite/libSQL broker's sealed per-channel frame log (§6D); that log supplies transport replay,
not an offline chat registry or plaintext history service.

## 6D. Broker backends — execution-model comparison (why Vercel Workflows, vs per-channel SQLite — and why not Temporal)

The broker is a **pluggable port** (`BrokerBackend` in `apps/web/lib/broker/backend.ts`):
`publish(token, frame)` and `subscribe(token, {startIndex})`, selected per-request via the
`x-broker-backend` header / `?backend=`. Three implementations ship — `vercel` (live default),
`sqlite` (one libSQL database per channel token—local file or Turso Cloud), `local` (dev/test). They divide on **one
axis: who runs the execution, and whether reads are push or poll.** Temporal was evaluated as a fourth
backend and **deliberately not adopted** (it doesn't fit a live relay's shape — the analysis below);
the implementation has been removed. This section captures the verified design of each so the choice of
default is auditable.

### Vercel Workflows — the live default (per-event materialization, push reads)

The headline property: **there is no orchestrator service and no standing worker.** An SWC plugin
compiles each `"use workflow"` and `"use step"` into separate **Vercel Function** handlers reachable
only through **Vercel Queues**. When an event needs handling the **platform invokes a function**, runs
the orchestration to the next `await step()`, persists, suspends, and **scales to zero**. So when no
viewer is connected and the relay run is parked on its hook, **nothing runs and nothing polls** — cost
is the stored event-log rows only. (This is the literal answer to "what is the executor doing with no
clients connected": on Vercel, nothing.)

Durability is **event-sourced deterministic replay** (verified against bundled `workflow@4.4.0` docs,
`how-it-works/event-sourcing.mdx`): an append-only log of `run_*`/`step_*`/`hook_*`/`wait_*` events
(ULID-keyed, so always read in order); resume = re-run from the top replaying cached step results.
The `"use workflow"` body runs in a **VM sandbox** (seeded `Math.random`/`Date.now`) precisely because
it is replayed and must be deterministic; all side effects are quarantined into `"use step"` (full
Node, runs once, retried, journaled).

Two properties make it the right shape for *our* real-time fan-out, both **verified in the 4.4.0 docs
and proven by our own `vercel.ts`**:

- **Reads are true push, multi-subscriber.** Each viewer opens its own
  `getRun(runId).getReadable({ startIndex })` cursor against the one relay run's persistent (Redis-backed) stream — catch-up then
  live, no polling. The streaming doc confirms concurrent readers/writers on one stream; our
  `subscribe()` *is* this, one cursor per viewer. (Public docs couldn't confirm multi-reader; our
  shipped code is the proof.)
- **Stream bytes bypass event-log storage; frame delivery does not.** The platform writes stream chunks
  without storing their bytes as events. Shipped `VercelBackend.publish`, however, sends every inbound
  and outbound frame through `resumeHook`, and `relayWorkflow` runs one journaled `emit` step for it.
  Thus output, result, announce, and catch-up traffic consume hook/step events just like prompts; the
  payload bytes themselves are billed/stored as stream data.

Publish maps onto a **reusable hook**: `relayWorkflow` runs `for await (const payload of hook)`, and
each `resumeHook(token, frame)` delivers a `hook_received` (hook stays `active`, takes many events). A
`hook_conflict` is recorded **only at create-time** when the token is already held by another active
hook → `HookConflictError` — which is exactly the `ensureChannel` registration race we hardened (§13);
once created, publishing never conflicts.

The **limits envelope** (Vercel pricing page, dated 2026-06-02 — current for this build) is why the
host keeps `#log` as system-of-record and the Workflow stream is not relied on as a durable store. A
production pre-cap handoff is still missing:

| limit | value | bearing on the relay |
| --- | --- | --- |
| max run duration | no limit | a channel run can live indefinitely |
| events per run | **25,000** (replay degrades past ~2k) | every shipped frame: hook receipt + emit-step events, both directions |
| Function request / stream storage / chunk | 4.5 MB / unlimited / 10 MB | the shared route first caps decoded ciphertext at 3.3 MB (~4.5 MB base64url JSON), then Workflow crosses the hook; the 10 MB stream ceiling does not enlarge an accepted frame |
| stream chunks/sec/stream | 1,000 | per-channel publish-rate ceiling |
| event creations/run/sec | 200 | `resumeHook` publish-rate ceiling per channel, both directions |
| max replay duration | 240 s | another reason a bounded-run handoff is required |
| idle on a hook | no compute billed | a parked channel = storage only |

There is **no `continueAsNew`**; the SDK documents explicit recursion through `start()` for bounded
runs. The host `#log` remains the history source-of-record, but that does not itself implement or prove
the live channel's pre-cap transition.

### Temporal — durable orchestration, but a poll-read pub/sub anti-pattern (evaluated, not adopted)

Temporal was prototyped as a backend and rejected; it is the opposite substrate to the two we kept: a
**standing worker fleet long-polls task queues**, orchestrated by a separate server. Web research
(Temporal docs + forum, May 2026) confirmed the mismatch for a live relay:

- **No server→client push exists.** A subscriber reads workflow state by **polling a query**; that's
  what the prototype's `subscribe()` did (poll a `state` query every `pollMs`). `Update` lowers write
  latency but writes to Event History; the `workflow-streams` contrib long-polls and is scoped to
  "tens, not thousands" of subscribers.
- **In-workflow pub/sub is an explicit anti-pattern**, bounded by a **51,200-event / 50 MB history**
  cap (→ termination) and a **2,000 pending-signal** cap (with no worker draining, publishes buffer to
  2,000 then the workflow task fails/retries — the failure mode of the "no standing worker" idea).
- The newer **Serverless Workers** (May 2026, pre-release) remove the standing-worker pain (event-
  invoked, scale-to-zero) **but run compute in your own cloud** (AWS Lambda, 15-min limit, "not ideal
  for sustained high-throughput") — self-hosted-but-elastic, not managed-execution.

The supported scalable Temporal design is therefore the **split**: Temporal for durable orchestration
and an **external pub/sub** (Redis Streams / NATS / Kafka) for the fan-out — i.e. an admission that
Temporal alone is not a broker. That is strictly more infrastructure than either shipped backend for no
gain on this workload — so Temporal was dropped rather than kept as an opt-in backend.

### Per-channel SQLite — the no-worker durable log (the durability answer)

The `sqlite` backend sidesteps the push/poll question: an **ordered libSQL log per channel token** with **no
worker at all**—broker subscription serves replay directly from the database. Reads are a poll
(`SELECT … WHERE id > cursor`), but
replay and live are the *same* query (no gap/dupe boundary), and unlike Vercel it is **flagged
durable**, so broker subscription serves replay and the host can retire its `#log`/`catch_up` replay. The defining choice
is **one database PER channel token** (not one shared log): physical isolation, retention = drop the db,
a per-channel write lock, and no cross-channel at-rest exposure. The **only** deployment variable is
where each db lives — a local `file:` (dev) or a Turso Cloud database created on demand via the Platform
API and connected with a group token (prod) — behind the `DbLocator` seam, with no code change. Schema
and the RC-event/broker-frame split are in `docs/durable-log-design.md`. (This is our **own**
`BrokerBackend` port talking to libSQL directly — `publish`=`INSERT`, `subscribe`=poll — **not** a
Workflow DevKit "World"; the World note below covers why building one would be more machinery for less.)

### The World abstraction (why "no worker" is a Vercel property, not universal)

Workflow DevKit's runtime/queues/persistence are a swappable **World** that bundles three jobs:
**Storage** (the append-only event log + materialized runs/steps/hooks, written via atomic events),
**Queue** (`queue()` to enqueue an invocation + a `createQueueHandler` the platform POSTs to —
at-least-once with retries), and **Streamer** (per-run named streams). The shipped **first-party**
Worlds are only three: **Vercel** (managed — Functions + Queues + encrypted store), **Local** (dev),
and **Postgres** (the self-hosted reference). The `@workflow/world` interface is public, so other infra
*can* be adapted with a custom World (the ecosystem page lists community ones), but those aren't bundled.
The Postgres reference uses **graphile-worker**, which **requires a long-lived process polling the DB** —
its own docs state it "does not work on serverless environments." So "event-driven, zero-cost idle, no
worker" is specifically the **Vercel World**, not a universal DevKit guarantee.

A **Turso World is buildable but not first-party, and wouldn't help us.** Turso gives Storage + Streamer
almost for free (they're just libSQL tables — our `frames` table already *is* a Streamer in shape), but
the **Queue is the gap**: on Vercel Functions (serverless, no polling worker) something must turn "a
pending-invocation row exists" into "HTTP POST the `createQueueHandler` Function," and **a database
can't push**. So a serverless Turso World would still need an external push-queue (Upstash QStash or
Vercel Queues) to dispatch — Turso for durable state, QStash for durable dispatch, Functions for
compute. That's strictly more machinery than our direct per-channel libSQL log, which runs **no**
workflows at all (no event-log replay, no step queue, no executor) — the DB *is* the relay. A Turso World would only
matter if we wanted the full durable-execution programming model (steps, hooks, replay) backed by Turso
instead of Vercel's managed platform; the relay doesn't need that model.

### Verdict (the auditable default)

| | reads | writes | who runs compute | standing process | durability | infra pieces |
| --- | --- | --- | --- | --- | --- | --- |
| **Vercel** (default) | **push** (`getReadable` cursor/viewer) | `resumeHook` (event-driven) | **Vercel**, per-event | **none** | capped stream + host `#log`; cap handoff not shipped | 1 |
| **Sqlite** | poll (`id > cursor`) | `INSERT … ON CONFLICT` | nobody (DB serves reads) | **none** | **ordered log per channel token** (file or Turso Cloud) | 1 |
| *Temporal (evaluated, not adopted)* | poll a query | signal (2k pending cap) | your worker | standing worker | history (capped → terminates) | 1 (wrong-shaped) / 2 with Redis |

Vercel Workflows is the one managed system giving **event-driven execution + push fan-out + zero hosted
infra** in a single piece (hence the live default); per-channel **SQLite** is the clean **durable-log**
backend (local files in dev, one Turso Cloud database per channel token in prod). Temporal is durable orchestration
that would need an external pub/sub bolted on to be a broker — strictly more infra for no gain here, so
it was evaluated and dropped, not shipped.

### Worked example — a no-viewer fleet (the cap cliff and viewer-gating gap)

A stress case that exposes the real over-time behavior: **100 channel tokens (100 `relayWorkflow`
runs), 1000 claudes pumping ~10 frames/sec/run (~1000/sec aggregate), and *no viewers connected.***

The load-bearing fact: **the host posts unconditionally.** `#pumpUpstream` (`host/rc/relay.ts`)
`#emit`s every frame the worker produces as it happens, and never checks for a viewer — it *can't*,
because the zero-knowledge broker API gives the host **no viewer-presence back-channel** (the
bus carries host→viewer announces; there is no viewer→host "I'm watching" beat). So zero viewers does
**not** reduce the publish load — the fleet pays full relay price to broadcast into the void.

Per-frame cost on a run's event log ≈ **~4 events**: 1 `hook_received` (the `resumeHook`) + the `emit`
step's `step_created`/`step_started`/`step_completed`. The frame *bytes* go onto the stream and bypass
the event log, but the step lifecycle still journals — so cost is ~4 events/frame regardless of frame
size.

What one run does over time, against the caps (25k events, 10k steps, replay degrades past ~2k events,
240 s max replay), at **10 frames/sec ≈ 40 events/sec**:

| t | what happens |
| --- | --- |
| 0 | run `start()`ed; hook loop emits into a stream nobody reads |
| ~50 s | crosses **2,000 events** → replay slows → each `resumeHook` waits longer to resume → **publish latency creeps up** |
| ~10 min | projects to **~25,000 events**; current code has no pre-cap close/handoff controller |
| afterward | platform response and channel availability are not retained-proven; a clean EOF/recreate, complete retry, and no-loss cursor handoff must not be assumed |

This is a **cap cliff**, not a working roll cycle. The explicit `__close` primitive proves that a run
can be closed and a token reused, but no shipped production path invokes it before the cap. The host
`#log` can rebuild viewer history after a new channel exists; it cannot by itself prove whether the
cap-boundary publish landed or make the handoff lossless.

Fleet-level, with no viewers, 100 streams fill with unread chunks and cross the 2k replay knee out of
phase, producing rising latency and full event/data-written cost until the unhandled cap boundary.
Post-cap run-creation rate, retained-data accumulation, and self-healing behavior are unknown until a
retained production-equivalent rollover proof exists.

**The gap this surfaces (tracked):** the host has **no outbound viewer-gating** — there is no mechanism
to stop pumping the transcript when nobody is watching, because the broker exposes no viewer presence
to the host. The honest mitigations, in order: (a) add a sealed presence beat so the host can gate
outbound on ≥1 viewer (drops an idle fleet to the ~20 s `ANNOUNCE_KEEPALIVE_MS` announce floor); (b)
use the **Turso** backend, which has no per-run event cap (publish is `INSERT`, so the Workflow replay
tax vanishes—the cost shifts to libSQL write throughput and at-rest ciphertext retention); or (c)
implement and retain-proof a fenced pre-cap close/generation handoff. Today's Vercel default has both
the viewer-gating and cap-handoff gaps.

## 7. Identity, "spaces" & onboarding (one machine at a time)
Hierarchy: **machine (identity_id) → its spaces (each space = one claude instance =
one chat).** A space is *not* a container of sessions — it **is** one session.
- The onboarded pass = one **machine**; **each claude instance on it = one
  space (chat)**. The client holds **exactly one pass at a time** (no multi-machine
  list) and renders that machine's spaces with decrypted friendly names (default hostname
  for the machine, claude's generated title for each space — both from the `K_meta`
  `session_announce`; rename and local aliases are deferred, §1A/§6C). One pass
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
The Workflow relay profile has **no application registry, semantic message table, or recovery
manifest**: discovery, presence, and session metadata are sealed frames on the per-identity **bus**
(§6B), while Claude's on-disk transcript is the host-side durable native record. Workflow itself
persistently backs each run's opaque resumable stream, but remote-claw has no rollover or recovery
fence at the run cap and therefore does not classify that profile as durable. The session's encrypted
name/title/cwd ride in its `session_announce` frame on the bus, not in an application metadata row.
Offline registry/listing is still deferred (§6C). The shipped SQLite/libSQL broker profile adds an
explicit indexed frame log and recovery cursors, while retaining no plaintext transcript or durable
semantic command/result map (§6D). The separate `/api/handoff` bootstrap plane uses its own sealed
short-TTL store (§4.5).

Shipped A0 relay **wire frame** (`session_announce` alone rides the identity bus; every other frame
rides its per-session stream). Workflow retains it as an opaque chunk for the current run; the durable
SQLite/libSQL profile stores it as an indexed sealed frame row with recovery cursors:

```text
{ v, identity_id, session_id, dir, record_kind, seq|null, msg_id, client_msg_id?,
  key_epoch, salt, nonce, ct, part?, parts? }   // ct includes the GCM tag
AAD = canonical-encode(v, identity_id, session_id, dir, record_kind, seq, msg_id, client_msg_id?, key_epoch, part, parts)   // identical to §4.3 canonical_AAD
```

Selected A1 uses the version-2 frame and exact encoder in §4.3: it replaces A0 `session_id` with
separate `collaborationServerId` and `logicalChatId`, adds `delivery_attempt_id`, derives chat-scoped
plane keys, and never accepts one version's KDF/AAD as the other.

**Chunking (size limits, §6B).** The shared `/api/relay` route rejects decoded ciphertext at
**3.3 MB**, keeping its base64url JSON request below the deployment's approximately **4.5 MB** edge
limit; the current encoder therefore targets about 3 MB of plaintext per frame. On the Workflow
profile that accepted request next crosses the inbound hook and its later `writer.write` stream chunk
is capped at **10 MB**. SQLite/libSQL instead inserts and polls frame rows, so it avoids those
Workflow hook/writer boundaries but not the shared relay-route cap. A larger message is split
into `parts` **independently-AEAD'd chunks** sharing one `msg_id`, each its own frame with
its own `salt`/`nonce` and `part` (0-based) bound into AAD. The receiver **decrypts each
chunk on arrival** (AEAD-verifying `part`/`parts`/`msg_id`), then reassembles the
**plaintext** in `part` order once all `parts` are present — so a forged/replayed chunk
fails AEAD before it can corrupt the buffer. In shipped A0, replay dedup for chunked frames keys on
`(msg_id, part)` (§6). In selected A1, transport insertion instead uses route-wide
`(route token, delivery_attempt_id, part)` plus the normalized-frame digest from §4.3, while durable
host replay adjudication uses the full server/chat/source scope plus `msg_id`.
Applies to large assistant output and full `catch_up` replays (over session streams).

**`catch_up` is idempotent:** history is
immutable and `seq`-addressed, so even a re-served range is deduped by `seq` at the client —
re-serving never corrupts the transcript.

Shipped A0 `record_kind` belongs to this closed taxonomy (aligned with §6A):

- **content** (AEAD under `K_session`): `user` · `assistant` · `result` · `system` ·
  `assistant_sub` · `assistant_thinking` · `assistant_thinking_sub` · `status` · `rate_limit` ·
  `can_use_tool` · `tool_use` · `tool_result` · `task` · `permission_request` — carry `seq`; `user`
  may be `dir:in` (prompt, with `client_msg_id`) or `dir:out` (echo, carrying the assigned `seq`).
- **control** (AEAD under `control_key`, `dir:in`, on the **session** channel,
  replay-checked by the `msg_id` seen-set): `catch_up` · `permission` · `interrupt` ·
  `set_mode` · `set_model` · `end` · `attachment` · reserved/unused `command`. Slash commands instead
  ride the `user` content path. The control payload (e.g. `catch_up`'s
  `since`, and an `expiry`) lives **inside `ct`** — AEAD-authenticated by the GCM tag, **not**
  an envelope/AAD field — so the broker can't read or alter it. Shipped A0 validates `expiry` only
  for `interrupt`, `set_mode`, `set_model`, and `end`; its `catch_up` branch ignores the stamped value,
  while current `permission` frames omit it and their branch performs no expiry check. Its clock-free
  `msg_id` seen-set is incarnation-local replay suppression, not a durable result map (§4.3/§6A).
- **meta** (AEAD under `K_meta`, `dir:out`): `accepted` `{client_msg_id, seq}`;
  `permission_resolved` (replayable native/projection gate state);
  `session_announce` (bus, the **periodic broadcast**)
  `{session_id, title, cwd, identity_label, status, last_activity, sent_at, incarnation, incarnation_started_at, announce_seq}`
  — **the whole payload is inside the ciphertext**, so the broker reads none of it.

Selected A1 keeps those content, chat-control, and meta families and adds meta `action_result`; its
accepted/action-result payloads are the exact §4.3/§6 shapes. It also adds a distinct
**server-control** family on the null-chat `server_control` route: inbound `new_chat` uses
`K_server_control_in_a1`, while outbound `chat_creation_result` uses
`K_server_control_out_a1`. A creation result is therefore not a generic meta frame. Unknown kinds fail
closed. In A1, `permission_resolved` still means native/projection gate state and remains distinct from
the coordinator's `action_result`.

After plane selection, A1 enforces this closed header-validity matrix before semantic classification:

| Kind family | `dir` | `seq` | `client_msg_id` | Certified host-output signature |
| --- | --- | --- | --- | --- |
| inbound `user` | `in` | null | required | forbidden; all host-authentication fields are null |
| outbound `user` projection/echo | `out` | non-null | optional; present only for a correlated client proposal | required; all host-authentication fields are non-null |
| every other content kind | `out` | non-null | forbidden | required; all host-authentication fields are non-null |
| inbound `attachment` | `in` | null | required | forbidden; all host-authentication fields are null |
| every other chat-control kind | `in` | null | forbidden | forbidden; all host-authentication fields are null |
| every meta kind, including A1 `action_result` | `out` | null | forbidden | required; all host-authentication fields are non-null |
| server-control `new_chat` | `in` | null | required | forbidden; all host-authentication fields are null |
| server-control `chat_creation_result` | `out` | non-null and exactly its payload `command_seq` | required and exactly echoes the proposal | required; all host-authentication fields are non-null |

An unknown kind or any other direction/sequence/client-ID combination is an invalid physical channel
position: it produces no semantic ingress record, no acknowledgement, and follows the explicit
invalid-frame quarantine/cursor transition in
[Client-driven Host Runtime — Reference §4](client-driven-host-runtime-reference.md#4-host-wide-native-client-adapters).
Shared encryption keys do not make an inbound `accepted`, sequenced control, or outbound interrupt
valid.

The server-control rows also require null `logical_chat_id`, `part=0`, and `parts=1`.
`chat_creation_result` uses the stable semantic result ID as `msg_id`; an unsigned result or any
direction, sequence, client-ID, signature, or chunk-shape mismatch is quarantined rather than
reclassified as meta or chat traffic.

AAD binds **every** cleartext header field through shipped A0 `canonicalAad`, which now uses the public
shared canonical writer: each byte/string field has a u32-BE length prefix, each integer is a
length-prefixed u64-BE, and each optional has a one-byte presence tag. Selected A1 is specified to use
that same writer in the exact §4.3 order, but its frame parser and encryption route are not implemented
by A1.0; CBOR and ad-hoc `a|b|c` concatenation are not alternatives. The presence
fields (`sent_at`, ordering tags, names/titles/status) live **inside** the `K_meta` payload, not the
cleartext header. Shipped A0 opens an AEAD-valid announce, folds it by
`incarnation_started_at`/`announce_seq`, and applies the 45 s connected + 30 s reconnecting display
ladder; it does not freshness-reject an old or future-skewed frame at admission. Selected A1 adds the
certified two-sided `now − FRESH_WINDOW ≤ sent_at ≤ now + SKEW` liveness check, which supplies its
bounded stale-replay claim (§4.3).

Presence has **no materialized server state**. Shipped A0 retains a generation-accepted
`session_announce` row and derives connected/reconnecting/disconnected from its age; the next
broadcast un-greys/adds it automatically (§6B). A durable broker may retain the sealed announce
frame, but there is no server-side `heartbeat`/`last_seen`; `last_activity` (in the decrypted
announce) drives client-side "most-active first" sorting. Selected A1 adds strict certified
freshness admission.

The outward data plane has **two endpoints** (both gated by `Bearer auth_token` §4.5,
self-verifying, ciphertext only): **`POST /api/relay`** publishes a bus or per-session frame, and
**`GET /api/stream?identity=… | session=…`** subscribes with a `startIndex`. In the Workflow profile
those operations map to `resumeHook` and `getHookByToken→getRun→getReadable` over SSE; the current
run replays by absolute index and the host can additionally serve `catch_up` from `#log`. In the
durable SQLite/libSQL profile they map to an idempotent frame-row insert and indexed log subscription;
broker replay supplies history and host `#log` stays empty. Two authenticated cursor endpoints also
ship: **`GET /api/seq`** returns effective durability plus the highest projected `seq`; the host uses
the high-water value to resume outbound allocation, while the viewer uses `durable` to select its
incarnation-recovery path. **`GET /api/frame-count`** is host-only and returns the publish-order frame
count used to fence a new durable host incarnation. Neither profile adds `/api/identity`,
`/api/sessions`, `/api/heartbeat`, or
`/api/messages`; discovery and presence use the identity bus (§6B/§6D).

## 9. Decisions (resolved 2026-06-07)
1. **Durable store / history → W′ (TUI is the brain), with two shipped broker profiles.** In the
   Workflow profile, each run persistently retains its opaque resumable stream, while the wrapper
   also holds an **in-memory** per-session log on the TUI host (accumulated live over the session,
   **not** reseeded from Claude) and serves catch-up via message-passing. Because the Workflow adapter
   has no 25,000-event rollover or host recovery cursors, it reports `durable:false` (§6B). In the
   durable SQLite/libSQL profile, the broker persists and replays sealed
   projection frames, so host `#log` stays empty (§6D). In both profiles, Claude's on-disk session
   (`.jsonl`) remains the separate durable native record and is **not** re-streamed over RC—there is
   no worker backfill (grounded—§6/§17). Neither profile persists a plaintext transcript, semantic
   command/result map, or offline registry; offline listing remains deferred (§6C).
2. **Realtime transport → pluggable, with no third-party fan-out service.** The live-default Workflow
   profile uses SSE from a streaming Function backed by the Workflow persistent resumable stream;
   subscribers replay the current run by absolute index, and host `#log`/`catch_up` supplies a
   redundant process-local projection source. The shipped SQLite/libSQL profile exposes the
   same stream endpoint over indexed frame-log polling and supplies replay itself. No Ably/Pusher.
3. **Browser credential storage → wrapped, tab-scoped credential + "forget" button.**
   The pass is AES-GCM ciphertext in `sessionStorage`; its non-extractable wrapping
   `CryptoKey` is held by IndexedDB. Forget removes the blob, best-effort deletes the key,
   and drops in-memory viewer/transcript state. No persistent transcript cache or local
   alias store is shipped; both remain deferred.
4. **Web framework → Next.js on Vercel** (assumed; confirm if not).
5. **CLI shape → one transparent passthrough wrapper, not subcommands** (§3.1).
   `remote-claw` *is* `claude` (all args forwarded); a reserved `--rc-*` namespace
   is consumed by the wrapper (`--rc-identity` does identity work). No `serve`.
6. **API admission → deployment perimeter plus surface-specific broker gates.** Vercel
   Deployment Protection may gate the whole deployed origin, but the repository has no built-in
   human-login layer; the broker authorizes each identity-scoped data/recovery call off the bearer `auth_token` alone
   (`identity_id = trunc(SHA256(auth_token))`), and the
   unguessable 128-bit `identity_id` + required `auth_token` *is* the anti-scanning gate —
   no separate app-key (§4.5). `/api/handoff` instead uses its OTK-derived ID/proof and sealed TTL
   store; cron/admin routes have separate gates. None of these admission checks supplies
   confidentiality.
   Future option: mTLS client identities for per-client revocable admission.
7. **Nothing remote until RC is enabled** (lazy). Running `remote-claw` like `claude`
   sends nothing to the broker; only on first `/remote-control` does the wrapper join
   the identity bus and become discoverable (§3.2, §6B, §15 #2).
8. **Registry → a per-identity value-addressed bus, NO application registry store** (§6B). A Workflow can't
   be a queryable index, but `getHookByToken("bus:"+identity_id)` resolves a derived
   token → run → stream (verified in the SDK types, §13/§14A), so discovery + presence
   are answered **live** by connected wrappers on the bus — no rows, no presence keys,
   no pointer. The two data-plane endpoints are `/api/relay` and `/api/stream`; `/api/seq` exposes the
   effective durability bit to both host and viewer plus the host's outbound sequence high-water,
   while host-only `/api/frame-count` supplies the durable inbound fence. Cold discovery may include
   stale rows from the last-64-frame replay slice, but a complete durable offline registry/listing
   service is **deferred** (§6C). The shipped sealed SQLite/libSQL frame log is transport history, not
   that registry.

## 10. Language & layout

**TypeScript everywhere** — one language for the CLI wrapper (Node), the shared
crypto, and the web app. No Python. The crypto core is genuinely shared code (both
Node and the browser use the same WebCrypto API), so there are no cross-language
test vectors to maintain. The Phase 0 Python relay (`phase0/remote_claw`) stays as
the **reference implementation** of the Claude-interception protocol; v2
reimplements that protocol fresh in Node/TS.

Proposed monorepo (pnpm workspaces) in this repo:

```text
packages/clawsec   shared crypto (TS, WebCrypto; runs in Node + browser)
packages/cli       the Node CLI: `remote-claw` — transparent `claude` wrapper (MITM + relay) + `--rc-*` flags
apps/web           Next.js app: pluggable Workflow/SQLite/local ciphertext broker,
                   recovery cursors, per-identity bus, and web client UI (§6B/§6D)
phase0/            unchanged — the Python reference + protocol findings
```

## 11. Phased plan
- **P0.5 — Capture spikes (DONE 2026-06-07, all PASS).** Settled every open
  TUI-side question on `claude` 2.1.168:
  - `rc_api_bridge.py` — the RC-API-client bridge is *viable* but **rejected**
    (routes remote through Anthropic's relay, §14). MITM is chosen.
  - `tui_remote_control.py` — drove a **real interactive TUI** through our MITM. It
    verified **C1** `/remote-control` (mid-session slash command) enables RC on our
    relay; **C3** a **generic client message reaches the real TUI and the reply comes
    back**; **C4** the same exchange shows in the local TUI (one synced session). Two
    early claims were **later DISPROVEN by `--rc-trace` capture** (see §17): **C2**
    "the wrapper receives the prior chat history via a worker backfill" — it does
    **not** (`POST …/bridge` returns only a `worker_jwt`, the worker SSE carries only
    **new** inputs, and `historical` is in **zero** captures); and **C5** — while
    `claude --continue` does reload the **full transcript into claude's own local TUI**,
    that history is **not** re-streamed over RC to our relay/viewer. That A0 experiment
    exposed a new RC session because the wrapper did not restore a prior binding; it did
    not prove that Claude can never resume its UUID or rebridge a known `cse_*`. The
    grounded result is narrower: the worker is never a history-repair source. Verdict:
    *TUI-side live relay verified; cross-(re)connect history does NOT come from the worker.*
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
- **P3 — Vercel app (the bus). ✅ BUILT 2026-06-09 (`apps/web`, PR10 — §14A).** The two data-plane routes,
  the per-identity-bus / per-session relay workflow, the `Bearer auth_token` admission gate, the §8
  wire codec, resume-or-`start()` backoff, and the bus-only-announce guard are implemented and
  **proven end-to-end on the real Workflow runtime** (in-process `@workflow/vitest`): a sealed
  announce/turn round-trips host → bus/session → viewer and the broker sees only ciphertext. The rest
  of this bullet is the original plan it fulfils. `apps/web` (Next.js): **per-identity bearer
  auth (recompute `identity_id = trunc(SHA256(auth_token))` from the bearer, constant-time
  compare to the target token — **no stored hash**, §4.2)** in front of the **two data-plane** routes
  (`POST /api/relay`, `GET /api/stream`) — the unguessable `identity_id` + required
  `auth_token` is the anti-scanning gate, no app-key; Vercel Deployment Protection may gate the
  whole deployment separately (§4.5); the
  per-identity bus relay workflow (`bus:${identity_id}` hook + out-stream) and the
  token→stream resolver (`getHookByToken→getRun→getReadable`); **per-session runs are
  resume-or-`start()`ed exactly like the bus** (first inbound/out frame on
  `sess:${identity_id}:${session_id}` creates the run + hook; same 1:1-token / backoff rules
  as §6B). Deploy; curl the cold-start (subscribe → tail-slice `session_announce`
  broadcasts) + a relay round-trip with hand-rolled ciphertext.
  **First, a small build-time spike — ✓ RAN & PASSED on Vercel 2026-06-08 (§14A).** Most of
  the §6B linchpins are now **docs-confirmed** (web-verified 2026-06-08, §13) *and
  empirically verified* on a throwaway deployment — `getHookByToken→getRun→getReadable`, custom hook tokens,
  `resumeHook` (resume-not-create), negative-`startIndex` tail-relative read, stream-writes-bypass-
  events, no-max-run-duration/idle-free, no caller-chosen `runId`, and the caps. So the spike
  is now a **pure integration smoke-test** — every primitive (incl. the duplicate-token
  conflict) is docs-confirmed (§13), so this just proves *our wiring* on real infra (pin
  `workflow`/`@workflow/*`):
  1. End-to-end **`getHookByToken→getRun→getReadable` from an API route** with server World
     creds (each call is documented; the cross-process composition is ours to wire).
  2. **`getReadable({startIndex:-N})`** delivers the last *N* chunks and keeps streaming new
     ones — choose *N* large enough to normally include every live session's latest periodic
     announce; displacement from a short tail slice degrades to ≤ `ANNOUNCE_INTERVAL` latency, not a
     permanent miss (negatives + `getTailIndex()`
     docs-confirmed §13; note: live-stream pagination over negatives isn't exact — fine for
     "recent," §13).
  3. **One-bus-per-identity**: a duplicate `createHook` on a held token throws
     `HookConflictError` (docs-confirmed §13) → confirm the losing workflow terminates while its
     caller, which never receives or catches that error, polls the deterministic token and
     resume-tails the winner. This create race is not an HTTP `409`. (No idle-timeout exists, §13 —
     the winning run persists until explicit close/failure.)
  4. **Cap-roll handoff** remains a release gate: add a production pre-cap controller and prove readers
     see stream **EOF**, publishers are fenced across close/re-`start()`, and no accepted frame or
     cursor is lost; the existing explicit-`__close` test proves only the primitive.
  5. Browser path: `GET /api/stream` obtains World creds (per-request vs cached — measure),
     pipes SSE within the Function `maxDuration` (300s Hobby / 800s Pro, §13 — reconnect by
     `seq` past it); `HookNotFound` ⇒ `200` empty.
  6. Shipped-A0 size/chunk limits (the shared relay route rejects decoded ciphertext at 3.3 MB;
     Workflow then crosses its hook and ≤10 MB writer chunk; target ~3 MB plaintext frames) +
     `(msg_id, part)` dedup.
- **P4 — CLI: host relay + a real claude (the §14/§17.5 MITM).** ✅ DONE 2026-06-09 — the **real RC
  MITM backend** is built in TypeScript (`@remote-claw/cli/rc`), a faithful port of the Phase-0
  interception (`phase0/remote_claw/{mitm,core,certs}.py`, the MANGO/KIWI/PLUM tests):
  - `certs.ts` — a throwaway CA + leaf for `api.anthropic.com`, trusted by the child only via
    `NODE_EXTRA_CA_CERTS`.
  - `session.ts` — `RelayCore`/`Session`: the downstream(→worker) / upstream(←worker) event bus,
    `initialize`-first (enqueued at session-create so a fast client prompt can't race ahead of it),
    worker-stream supersede, delivery acks. Async generators replace the Python `threading.Condition`.
  - `mitm.ts` — an http/tls CONNECT proxy that TLS-terminates the MITM host, **serves** the worker
    `/v1/code/sessions*` endpoints (register, bridge, worker SSE, events, events/delivery, heartbeat,
    PUT worker), and in the default `--rc-inference=anthropic` mode **passes** `/v1/messages` + OAuth
    and everything else (query string intact) through to the real upstream. The later
    `--rc-inference=bedrock` branch translates inference to Bedrock and locally synthesizes the
    remaining Anthropic-origin control/API surface; other hosts blind-tunnel.
  - `relay.ts` — `HostRcRelay` bridges one RC session to the broker (the v2 replacement for Phase-0's
    localhost ClientServer): an OUTBOUND pump (worker upstream → sealed content frames: assistant,
    result, `tool_use`/`assistant_sub` for sub-agents, `permission_request`; sequence allocation; host
    `#log` only when non-durable; 409 disposed-channel retry) and an INBOUND pump (client `user` → echo
    + inject; Workflow `catch_up` → host replay; durable subscription → sealed broker replay;
    `permission` → control_response), each re-subscribing across channel absence, close, or replacement.
  - `launch.ts` + `run.ts` — `remote-claw [claude args] --rc-app <broker>` runs the **real** claude
    behind the MITM (`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`, `NO_PROXY` cleared), auto-creating the
    machine identity; lazy — nothing reaches the broker until `/remote-control` registers a session.

  **Proven end-to-end** by `apps/web/test/e2e/rc-spine.integration.test.ts`: a fake worker speaks the
  **exact captured `--remote-control` worker protocol** through the real MITM, and the browser viewer
  drives a turn, bus discovery, history replay (catch_up), **sub-agents** (`Task` + nested replies),
  **tool-permission grants**, and **multi-client** — all through the real broker on the real Workflow
  runtime. The real binary's leg is the in-repo Phase-0 capture + the gated `real-rc.prove.test.ts`
  (needs a claude.ai login + a PTY). The native **`stream-json` SDK transport** (`HostRelay` +
  `ClaudeStreamSession`, PR16–18, Bedrock/Vertex via `{ bedrock: true }`) remains as the **documented
  cousin** for protocol cross-checks + a headless inference-agnostic path — NOT the RC backend (§14
  resolved MITM, not the SDK bridge).
- **P5 — Web client. ✅ BUILT 2026-06-09 (`apps/web/app`, PR14).** A mobile-first Next.js client:
  paste a **pass** (or open a link with it in the URL `#fragment`, stripped after load), discover the
  machine's live sessions on the bus (decrypted titles, timestamp-driven presence that greys as
  announces lapse), open one, render the transcript (history + live, deduped/reordered), and send
  prompts — all decrypted in-browser (WebCrypto), reusing the **same** transport the host uses
  (`@remote-claw/cli/broker`, browser-safe subpath — PR13). Same-origin to the two data-plane routes.
  Original plan: Paste/fragment secret, identity + spaces list (each space =
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
  a new identity for future legitimate host service, not revocation of copied old passes or retained
  old routes (§4.2a/§4.4). A viewer holds a **pass**, not
  `S`; onboarding a pass into a browser still exposes it to that device's XSS/extension/clipboard
  surface (and a stolen pass can read/steer retained old routes even after reset). `rc1_`/pass
  high-entropy tokens trip secret scanners if pasted into a repo.
- **Deployment-wide admission is external, not a baked-in browser token** (§4.5): Vercel
  Deployment Protection can gate the deployed origin and the headless host can use its protected
  bypass header. The repository itself has no human-login implementation, so an unprotected or
  self-hosted origin needs an operator-supplied perimeter. The broker's own gate is the
  per-identity `auth_token` (unguessable `identity_id` + required token = anti-scanning);
  it is admission, not authz/confidentiality (those stay with `auth_token`/content keys).
  Harden later with mTLS client identities.
- **At-least-once, no FIFO** from the broker ⇒ dedupe + reorder is mandatory.
- **The bus list is a last-64-frame projection, not a complete offline registry** (§6B/§6C).
  Connected sessions keep it current, while retained old announcements can seed offline rows on a
  cold viewer.
- **Presence is timestamp-driven.** Shipped A0 admits announcements by
  incarnation/generation ordering, then displays connected for 45 s, reconnecting for 30 s, and
  disconnected thereafter. It does not reject by age or future skew, so a future-dated host clock can
  keep a row connected longer than intended. The assumption's **blast radius is the presence display
  only**—message **confidentiality/integrity** are clock-free
  (`K_session`/`control_key` AEAD) and replay defense is `msg_id`-based. Selected A1 requires the
  certified two-sided `FRESH_WINDOW = 60 s` / `SKEW = 5 s` admission predicate described in §4.3.
  A0 checks encrypted `expiry` only for `interrupt`, `set_model`, `set_mode`, and `end`;
  a stale direct verb is rejected—availability, never a breach. `catch_up` stamps but ignores expiry,
  and `permission` omits it, leaving the documented late-replay/late-answer boundaries (§6A/§8). A
  badly skewed clock degrades to a wrong dot/row or direct-verb expiry rejection, **never** a
  message breach. A `409` instead means the separately typed transient channel-disposal/replacement
  publish race; clock skew and semantic/direct-verb rejection do not produce it. (A
  zero-clock-trust challenge-handshake variant is recorded in §14A if ever needed.)
- **`getHookByToken→getRun→getReadable` is a verified-by-types but undocumented-as-a-
  pattern composition**, and the run-roll **hook re-bind** has a brief `HookNotFound`
  window → client retry. Both are P3 spike items (§11); a stale resolve is at worst
  "reconnect + `catch_up`," never a wrong attach.
- **Bus run never auto-frees its token** (verified §13: no idle-timeout, no max run
  duration): a bus run, once started, lives **indefinitely** (idle = free compute, but
  storage-retained is billed), so the token stays held even with no connected sessions. This
  is benign—a cold client shows any announcements in its retained tail slice as offline rows, or an empty list
  if none remain—and the token is freed only by explicit completion/cancellation/failure. The
  internal close/re-`start()` primitive is not a shipped cap controller. If we want idle buses to
  self-clean, race the hook against a durable `sleep` (§6B). One-bus-per-identity is
  SDK-enforced (a duplicate `createHook` on a held token throws `HookConflictError`,
  docs-confirmed §13): the losing workflow terminates, while its caller never receives or catches
  that error and instead polls the deterministic token until it can resume-tail the winner. The
  create race is not an HTTP `409`.
- **Workflow per-run caps** (25k events / 10k steps / 2 GB; replay degrades past
  ~2k events): every Workflow-profile publish in either direction creates hook/step events. Current code does not
  roll before the cap, so production availability at that boundary is an open release blocker. Keeping
  high-volume turn frames on separate per-session runs isolates the identity-bus budget but does not
  make session traffic event-free. Implement and prove the pre-cap handoff, and quantify Events versus
  Data Written per active identity before scaling.
- **Metadata leak:** in A0 the broker sees the cleartext **routing header** (`identity_id`,
  `session_id`, `dir`, `record_kind`, `seq`); A1 instead exposes `identity_id`,
  `collaborationServerId`, `logicalChatId`, and the derived opaque route token. A1 admission remains
  self-verifying—the broker can recompute and bind the token without a credential lookup—but its frame,
  idempotency, cursor, and manifest state is durable. It also sees frame **sizes/timing** and the
  `session_announce` **broadcast cadence**. Everything *inside* a frame — titles/cwd/
  status/last_activity/identity_label as well as message bodies — is AEAD-encrypted
  (`K_meta`/`K_session`/`control_key`), so the broker reads none of it. Not fully
  metadata-private (it still learns which `session_id`s exist + activity timing); salt
  `session_id`s + pad/normalize sizes later if that matters.
- **Counter/nonce safety:** resolved by per-message HKDF subkeys (§4.3); do **not**
  regress to a shared counter nonce with stateless/multi-device senders.
- **Vercel Queues / WDK surface** still moving (Queues beta); Workflows GA is
  stable — pin SDK versions, isolate behind a thin transport interface. The §6B caps,
  retention, stream-payload/event-storage behavior, and the API primitives are now **web-verified against the
  live docs** (§13, 2026-06-08) — incl. `HookConflictError` on duplicate tokens; only the
  *integration* (our cross-process token→stream wiring) remains a P3 smoke-test, and SDK
  versions can still drift — re-confirm at build (§11 P3).
- **Relay flooding / DoS.** The broadcast model removes the old `identify?`
  request-triggered fan-out (no client discovery request frame exists), but any caller holding a valid
  `auth_token` can still `POST /api/relay` junk. Mitigate with a broker-side per-`identity_id`
  rate-limit on `/api/relay` and per-session debounce of redundant on-change
  `session_announce`s (sessions are independent processes, so there is no cross-session
  coalescer — each only debounces its own). (P7; named explicitly so it isn't lost in
  generic "rate-limiting".)
- **Bus event budget / cap.** Each `session_announce` broadcast is a bus event — **one per
  session per `ANNOUNCE_INTERVAL`** (sessions are independent processes with no per-host
  aggregator — §1), **sent even when no client is watching** (push model). So the bus event
  rate scales with **total live sessions** under an identity:
  `Σ sessions × 86400 / ANNOUNCE_INTERVAL`. At the 20 s default that is ~4,320 announcement
  frames/day **per session**. The Workflow run journals roughly four events per delivered frame
  (§6B), so those announcements consume
  about 17,280 events/day and reach the 25k-events/run cap in ~1.45 d for a single session,
  proportionally faster with more (e.g. 5 sessions → ~7 h). So the bus **needs** a proved pre-cap
  handoff (explicit close and re-`start()` under the same token—§6B), which is not yet shipped;
  keep all high-volume turn frames on separate per-session runs so they do not consume the bus's
  budget, and a longer `ANNOUNCE_INTERVAL` (≤ 60 s) linearly delays the unsupported cap cliff at the cost of a larger
  presence fuzz. Those session frames still create hook/step events on their own runs. Quantify Events
  versus Data Written per active identity in P3.

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
    before the current end"; "read only the last 10 chunks") — the tail-relative read is a
    **native, client-chosen offset** and later chunks still stream; caveat: exact pagination
    over a live stream via negatives isn't supported (fine for "recent") —
    /docs/foundations/streaming · /docs/api-reference/workflow-api/get-run · /docs/ai/resumable-streams.
  - **One-bus-per-identity is SDK-enforced:** "hook tokens must be unique across all running
    workflows"; a duplicate `createHook` on a held token throws **`HookConflictError`**
    (`@workflow/errors`, `HookConflictError.is(e)`, `e.token`) — /docs/errors/hook-conflict.
    Hooks are **`AsyncIterable`** (`for await … of hook` per `resumeHook`) — the bus loop.
  - **Platform stream bytes bypass the event log** ("flows directly without being stored in the event
    log"; max stream storage Unlimited; **chunk ≤10 MB**, ≤1,000 chunks/s/stream). In this shipped
    relay, however, every frame first arrives through `resumeHook` and a journaled `emit` step, so both
    directions still consume run events even though the copied stream bytes are not event payloads.
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
  stream payload bytes bypass event-log storage, while the shipped hook/emit lifecycle still consumes
  events (workflow-sdk.dev/docs/foundations/streaming);
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
  transcript order; they send `client_msg_id`, the wrapper assigns `seq`, emits
  `accepted{client_msg_id, seq}`, then echoes/records the user frame before enqueueing
  it for Claude. The acceptance frame proves relay receipt/order, not native application.
  (§6)
- **Replay protection ≠ AEAD.** The broker can replay a valid old ciphertext →
  shipped A0's in-memory `msg_id` seen-set drops duplicates during one incarnation, while its sampled
  durable floor only skips older broker indices after restart and is not semantic exactly-once.
  Selected A1 instead persists the authenticated source digest, decision, `seq`, accepted result, and
  ingress cursor; exact replay re-emits that result without a second side effect, and
  same-ID/different-digest input is quarantined.
  (§6)
- **Control frames are encrypted** under a derived `control_key` and carry authenticated `msg_id`, so
  the broker cannot forge `catch_up` or `permission`. Shipped A0's direct verbs also enforce encrypted
  `expiry`; `catch_up` stamps but ignores it, and `permission` currently omits it. (§4.2,§8)
- **Cloud-history contradiction removed, then extended by the durable backend.** The Workflow profile
  persists opaque chunks in its current run's resumable stream and has no application message table;
  the wrapper also serves catch-up from host `#log`. The later SQLite/libSQL profile persists indexed
  sealed frame rows with recovery cursors and replays them while host `#log` stays empty. Neither gets
  worker backfill or exposes plaintext `GET /api/messages`. (§3.2,§6,§8)
- **Overstated "verified replay" corrected — then disproven.** Only string-presence
  was confirmed in the binary, never a usable replay; `--rc-trace` capture then showed
  the worker performs **no** history backfill at all. Design relies on the relay path—the current
  Workflow run's persistent stream plus host `#log`, or sealed broker replay for durable
  SQLite/libSQL—NOT a worker backfill or Anthropic's cursor API (we're off their relay and never call
  it). (§6,§11,§14,§17)
- **AAD/envelope canonicalized** (binds v, identity_id, session_id, dir, record_kind,
  seq, msg_id, key_epoch via one serialization). (§4.3,§8)
- **Meta-frame key.** A0 meta frames (`accepted`/`session_announce`/`permission_resolved`) are AEAD
  under a single **`K_meta`** (the earlier per-field `K_identity_meta`/`K_session_meta` were collapsed
  into it); selected A1 adds `action_result` on the same plane. (§4.2,§6A,§8)
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

### RESOLVED decision for current `--rc-app`: MITM (not the RC-API bridge)
Both reviewers raised that an RC-API-client bridge could avoid the MITM, and the
**P0.5 spike confirmed it works** (`phase0/spikes/rc_api_bridge.py`; tracked results in
`docs/phase0-findings.md` §4b: inject + cursor-history catch-up + live client SSE all
PASS as a pure client). **But the bridge routes the remote channel through
Anthropic's RC relay, which is exactly what we will NOT do.** Decision (user,
2026-06-07): **all remote-control traffic goes through OUR MITM**; Anthropic's RC relay is
never in the loop. In the default mode, the MITM intercepts only RC endpoints and passes every other
`api.anthropic.com` request—model inference, OAuth, telemetry, and unclassified routes—through to
Anthropic; non-Anthropic hosts are blind-tunnelled. Bedrock mode translates inference and synthesizes
the remaining Anthropic-origin control/API surface locally.

So the wrapper runs the **real interactive `claude` TUI** and, when the user
enables remote control, makes it RC-eligible **pointed at our local MITM** (Phase
0 method: `HTTPS_PROXY` → our proxy intercepts `/v1/code/sessions*`; our relay is
the RC backend — verified end-to-end in Phase 0, the MANGO test). The wrapper is
the RC backend, so it sees and logs **every** frame; it then E2E-encrypts to
Vercel. The bridge is recorded as a **rejected alternative** (keeps the protocol
shapes it validated; we serve the same shapes ourselves).

**Selected future direction (2026-07-26; not implemented).** The
[client-driven host runtime](client-driven-host-runtime.md) supersedes the earlier Anthropic-canonical
proposal whose evidence is retained in the
[Native Claude Remote investigation](native-rc-passthrough-scoping.md). A distinct experimental Claude
mode will keep inner Claude on a private synthetic RC/API façade while remote-claw separately owns a
real outward Anthropic worker/session so official clients can participate. The inner process never
connects to Anthropic. One person keeps using the real Claude TUI and one private remote-claw RC
connection is Claude's remote collaborator. A remote-claw server may multiplex many collaborators,
including another remote-claw server, behind that one connection. Provider IDs and sequences are
outward positions. Each server owns only its direct-collaborator proposal order, forwarding decisions,
correlation, and delivery evidence; Claude remains the final arbiter of local/remote interleaving and
what actually applies. Returned native observations travel outward in the reverse direction but never
become new inward proposals. The private façade must preserve the pinned Claude Code behavior seen
against the normal service, while the current MITM-only `--rc-app` behavior above remains unchanged
until that phase lands.

Consequence for **current `--rc-app`** history (supersedes earlier "events-cursor" **and**
"worker-backfill" wording): because that mode is **off Anthropic's relay**, history does **not** come from
Anthropic's `/events?cursor=` API (the wrapper never calls it) — and `--rc-trace`
capture shows it does **not** come from a worker backfill either (no `historical` frames
on the wire; `POST …/bridge` returns only a `worker_jwt`; a `--resume`d worker is
streamed no prior history). The **sole** in-session history source is the wrapper's
own relay path: the wrapper's in-memory `#log` on a non-durable backend, or the durable broker's
persisted sealed frame log. Claude's local `.jsonl` is the durable native on-host record but is **not**
re-streamed over RC, and neither broker path reconstructs Claude context. No Anthropic cloud history,
no worker backfill.

## 14A. Design-review log (multi-agent panels)

Beyond §14's plan review, individual decisions are settled with small design panels
(N independent proposals → synthesis → adversarial verification) and folded back here.

- **Per-machine identity + viewer passes + trust modes; symmetric rotation cut (2026-06-08).**
  Reversed the earlier "one user identity binding all sessions across hosts" model: **each
  machine now owns its own secret `S` → its own `identity_id` → its own bus**; `identity_id`
  is a **machine's public routing id**, not a user identity spanning hosts. Blast radius of a
  steal/reset is exactly **one machine**; to watch another machine you onboard *its* credential.
  Introduced the **pass** (§4.2a) — a viewer credential carrying the operational keys
  {address/content/command/presence} but **not** `S`/`PRK`, one read+steer tier (no view/control
  split), uninvertible to `S` by HKDF one-wayness; reset moves future service but does not revoke
  copied old passes; honest symmetric inbound-authority residual. Selected A1 later adds a separate
  Ed25519 server-output signature, without rotating those route/KDF keys. Introduced the **three trust modes** behind one `SecurityProvider`
  seam (§2A): **Open** (trust-server, no crypto, loud banner), **Sealed** (today's E2E), **Managed**
  (future relay-delivered wrapped keys) — identical wire/relay, only `seal`/`open` differ; every
  unconditional confidentiality claim is now Sealed/Managed-relative. **Rotation/forward-secrecy
  was cut** (the master re-derives its keys — that is what makes paste-to-reconnect work); the
  destructive action is "**reset the machine**," and `key_epoch` is a fixed AAD constant, not a
  rotatable epoch. (The crypto core — HKDF labels, 3-level content key flow, per-message AEAD,
  canonical AAD, the §4.4 pick-two theorem, the blind credential-registry-free relay — is unchanged.) The earlier
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
  **no stored pointer**. **Final: a per-identity value-addressed bus, no application registry**
  (§6B); incomplete last-64-frame listing is the trade; an application index is optional for complete offline listing
  (§6C).
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
  trusted. **Implementation status:** this paragraph records the selected design, not shipped A0:
  the current viewer uses the 45 s + 30 s display ladder without age/SKEW admission rejection.
  The certified two-sided predicate remains a selected A1 requirement (§4.3).
- **Design B assessor pass + the independent-session model (2026-06-08).** codex
  (gpt-5.5) + the review workflow re-ran against Design B. Verdict: **sound** under the
  bounded-clock assumption (codex: "minor-issues"); no forge/replay path can keep a dead
  session online past the timestamp expiry. Precision fixes folded in: (1) the exact
  false-online bound is **`FRESH_WINDOW + SKEW`**, not "one window" (the acceptance
  predicate allows `sent_at ≤ now + SKEW`); (2) **both** `FRESH_WINDOW` and `SKEW` must be
  ≥ max skew (the past edge guards a slow clock from false-grey, the future edge guards a
  fast clock from false-reject), with concrete defaults `20 s / 60 s / 5 s`; (3) the
  "clock-free message plane" claim is scoped honestly—encrypted `expiry` on A0's four direct verbs
  bounds a withheld-then-released-late action, while `catch_up` ignores its stamped expiry and
  `permission` omits it; (4) the cold-start last-64-frame read is sized to span ≥ one
  `ANNOUNCE_INTERVAL`, with a ≤ `ANNOUNCE_INTERVAL` fallback if an older announce was displaced from
  the requested tail slice; (5) §2 now lists
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
  → one `runId`, read back `[{n:1},{n:2},{n:3}]`, `tailIndex:2`). (2) **tail-relative read** —
  `getReadable({startIndex:-2})` returned exactly the last two. (3) **one-bus-per-identity** —
  a second `createHook` on the held token threw **`HookConflictError`** ("Hook token … is
  already in use by another workflow"), proving SDK uniqueness. In the broker handshake that error
  terminates only the losing workflow; its caller does not catch it and independently polls the
  deterministic token until it resolves and resume-tails the winner.
	  (4) **completion → dispose → token frees** — after a `__close` the run completes, the token
	  stops resolving (`getHookByToken` → `HookNotFound`), and a subscribe renders empty — the
	  explicit-close/teardown primitive. This did not test a production cap controller. So the bus
	  primitive is no longer just docs-confirmed but **observed working**;
  the only remaining build-out is wiring it into the real broker (P3 proper) with
  per-identity `auth_token` auth, chunking, and the per-session streams.
- **Implementation landed — the encrypted spine works end-to-end (2026-06-09, PR9–PR12).** The
  spike's wiring is now the real system, built as four reviewed PRs and **proven against the real
  Workflow runtime** (in-process via `@workflow/vitest`, the same engine Vercel runs):
  - **clawsec** (PR9) — the §8 wire codec (`encodeFrame`/`decodeFrame`, strict at the trust
    boundary; `identity_id` rendered as the one canonical hex form) and the client-derivable channel
    tokens (`busToken`/`sessionToken`).
  - **`apps/web`** (PR10) — the real broker: the two data-plane routes (`POST /api/relay`, `GET /api/stream`
    over SSE), the per-identity-bus / per-session relay workflow (one run owns a channel token's
    hook, re-emits frames onto its durable out-stream), the `Bearer auth_token` admission gate
    (recompute `identity_id`, route by it), resume-or-`start()` with §6B backoff, and the §6A
    bus-only-`session_announce` guard. That original Workflow relay profile has no application
    registry or semantic message table, although Workflow persistently backs the opaque stream for
    each capped run. The later SQLite/libSQL backend and recovery cursor routes add an explicit sealed
    frame log without a registry or plaintext store.
  - **CLI BrokerClient** (PR11) — the host+viewer transport: seal on the way out / open on the way
    in (via the `SecurityProvider`), the two data-plane endpoints, a robust SSE parser, and the viewer-side
    shipped-A0 `FrameOrderer` (dedup by `msg_id`/`(msg_id,part)`, reorder content by `seq`, deliver
    control/meta immediately). The host inbound command pump does not use the orderer.
  - **End-to-end harness** (PR12) — the real transport ↔ the real broker ↔ a viewer, only `claude`
    faked: a sealed `session_announce` is discovered on the bus; a `user` prompt (`K_session`) round-
    trips to the host, which runs the fake model and emits `accepted` + echo + `assistant` + `result`;
    the viewer reorders and decrypts them; an `interrupt` rides `control_key`. The broker holds no key
    and sees only ciphertext + the cleartext routing header, exactly as designed.
  - **Web client** (PR13–PR14) — the broker module was exposed as a browser-safe subpath
    (`@remote-claw/cli/broker`), and `apps/web/app` is a mobile-first Next.js viewer that reuses it:
    paste a pass → discover sessions on the bus → open one → transcript + send, all decrypted
    in-browser. So the **P5** UI is built (`next build` green, the `/` page prerenders).
  - **Proven with a REAL claude** (PR15) — a gated test (`RC_PROVE_REAL_CLAUDE=1`) drives the actual
    logged-in `claude` (2.1.169) through the full stack: the browser Viewer asks "capital of France?",
    it travels **encrypted** to a host that runs `claude -p`, and "Paris." comes back encrypted and
    renders in the viewer. The broker only ever saw ciphertext. (Network-gated, so CI stays
    deterministic — skipped by default.)
  - **A real, multi-turn host** (PR16–PR18) — `HostRelay` + `ClaudeStreamSession` drive a *live*
    `claude` over its stream-json SDK transport (no MITM/proxy needed) and relay it through the
    broker. Proven multi-turn (PR17): a browser viewer teaches claude "42" in turn 1 and reads it back
    in turn 2, both through the encrypted broker — the "42" only appears if both prompts reached the
    same live process via the relay, so a real **stateful session** is driven end to end. And it is
    **inference-agnostic** (PR18): `{ bedrock: true, env: {…} }` points the relayed session at Amazon
    **Bedrock** (or Vertex) — claude routes inference via the AWS SDK while remote-claw relays the
    session, never touching the inference creds.
  So the encrypted spine is **complete and proven with a real, multi-turn claude on any inference
  backend**. The only thing NOT built is the **optional** HTTPS-MITM of claude's *native*
  `--remote-control` (driving the interactive TUI the user has open locally, vs a headless stream-json
  session) — a different UX, Phase-0-verified, not a missing capability. Build/deploy note: `apps/web`
  uses `next build --webpack` + `extensionAlias` to bundle clawsec's raw-TS source (Turbopack can't
  resolve its `.js`-specifier imports in `node_modules`).

## 15. Use cases / scenario matrix (also the v2 test plan)

Each maps to the frames (§6A), channels, endpoints (§8), and state. **[V]** = an
aspect already empirically verified (Phase 0 MANGO / the P0.5 spikes C1–C5 +
rc_api_bridge); others are specs to build/test.

(Discovery + presence = the per-identity **bus** (§6B); the two data-plane endpoints plus shared
durability/sequence cursor `/api/seq` and host-only inbound cursor `/api/frame-count` = §8; offline
*listing* across cold starts is deferred, §6C.)

Unless a scenario names both branches, concrete A0 words such as `resumeHook`, run, hook, out-stream,
SSE, persistent run stream, and absolute `startIndex` describe the live-default Workflow profile.
SQLite/libSQL uses the same derived bus/session tokens and HTTP data plane, but maps publish to a
frame insert and subscribe to indexed sealed-log polling/replay; host `#log` stays empty.

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
   the local MITM (our relay = RC backend), then **joins the identity bus**
   (`bus:${identity_id}`, resume-or-`start()`), starts **broadcasting** `session_announce`
   for the session + opens its stream (`sess:${identity_id}:${session_id}`). There is **no
   backfill** — the worker does not re-emit the pre-RC turns (grounded §17), so the relay's
   log (and therefore the viewer) covers the conversation **from RC-enable forward**; the
   prior local turns remain in claude's `.jsonl` only. No completeness gate is needed
   because the log is complete from the moment it starts. **[V]** C1 (C2 disproven)
5. **Launch with RC on.** `remote-claw --remote-control` → fresh session, relay is the
   backend from the start, empty history, joins the bus + broadcasts. **[V]** (Phase 0)

**Client onboarding & discovery (the bus)**

6. **Client first connection.** Onboard the machine's **pass** (paste/scan or `#fragment`) →
   load its keys → `GET /api/stream?identity=identity_id` (subscribe the bus) → reads the
   last 64 retained frames → folds available `session_announce`s and renders each as connected,
   reconnecting, or disconnected; it is empty only when no announcement remains available. After a
   successful connection, wrap the pass under the non-extractable IndexedDB `CryptoKey`
   and store only its ciphertext in tab-scoped `sessionStorage`. The URL fragment itself
   is never sent to the server.
7. **One MACHINE, 5 independent sessions.** On one machine (one secret), 5
   separate `remote-claw` processes each broadcast their **own**
   `session_announce`; the client subscribes that machine's single bus and renders all 5 as
   separate spaces, each with **independent** presence derived from its own announce age.
   Tests the per-session/no-aggregator model (§1) — no batching, one pass on the client. (To
   watch several **machines** from one viewer you hold several passes, one active at a time.)
8. **List an identity's spaces.** = the wrappers' broadcast `session_announce`s in that
   identity bus's client-requested last-64-frame slice; decrypt titles/cwd → gchat-style list. A space is a chat;
   its row may be connected, reconnecting, or disconnected (§4.3).

**Shipped A0 history sync**

9. **Open a session cold (full sync).** On Workflow, the client sends `catch_up{since=0}` on the
   session channel and the wrapper replays host `#log` with original `seq`/`msg_id`. On
   SQLite/libSQL, subscription from frame index 0 replays the sealed broker log and host `#log` stays
   empty. The client's orderer deduplicates either path, then tails live.
10. **Mounted viewer reconnect.** While the transcript generator remains mounted, its in-memory
    `FrameOrderer` survives ordinary transport re-subscription. In full mode the viewer re-reads the
    selected stream from `0` and the orderer suppresses duplicates. After a non-durable incarnation
    change it resets the orderer, resumes the stream from its in-memory `streamCursor`, and requests
    host `catch_up{since=0}`; a durable incarnation change re-enters full mode. A UI revive starts a
    new generator and requests history from `0`, while retaining the already-rendered React messages
    for `msg_id` reconciliation. Only explicit gap repair asks for `gap.nextSeq`; there is no
    persisted browser cursor. A cold tab follows scenario 22.

**Messaging (the core loop)**

11. **Send from client → underlying claude.** Client encrypts a `user` frame
    (`client_msg_id`) → `POST /api/relay` (`resumeHook sess:…`) → wrapper hook → dedup
    by `msg_id` → decrypt → allocate `seq` → emit `accepted{client_msg_id, seq}` → echo
    and record the user frame → inject into claude via MITM downstream; claude replies →
    `assistant`/`result` on the session out-stream → client renders. `accepted` is not
    native-application evidence. **[V]** C3
12. **The client-driven exchange also appears in the local TUI.** The real TUI renders
    the remote prompt and its reply in the same native session. Ordinary prompts typed
    directly at that TUI are not currently projected to clients. **[V]** C4
13. **Two clients, one session (fan-out).** Phone + laptop both tail the session
    out-stream (each resolves the same `sess:` token → same run → multi-reader); a
    message from either shows on both + the TUI. **Connected at different times:** a
    late-joining laptop independently subscribes the bus → reads the available bus replay → gets
    the *same* live list from the wrappers' broadcast announces, opens the session +
    Workflow `catch_up{since=0}` or SQLite/libSQL subscription-from-zero → available projected
    history, then both tail live in lockstep (ordering by
    wrapper-assigned `seq`, dedup by `msg_id`). One client closing its SSE doesn't affect
    the other (no per-client server state). (multi-client)

**Switch machine & naming**

14. **Switch machine (replace, not accumulate).** Onboard a different machine's pass. In order:
    (1) **close the old machine's SSE**, (2) **forget** the prior pass—remove its wrapped
    `sessionStorage` blob, best-effort delete the IndexedDB device key, and drop the
    in-memory viewer/transcript/order state (§1A E; a retained pass is a live credential,
    §4.2a/§4.4), (3) **then** load keys for `identity_id₂`, save its newly wrapped
    tab-scoped credential, and subscribe the **new** machine's bus → its
    connected sessions' announces render its spaces. The client holds **one pass at a
    time** (§7). There is no persistent transcript or alias cache to retain across the switch.
15. **Rename identity/space.** Rename is not shipped in A0. The client renders the defaults
    from `session_announce` (identity = hostname, space = Claude's title) and sends no
    rename frame. Local aliases and persistent/shared rename are deferred (§6C).

**Control & permissions**

16. **Tool permission (`can_use_tool`).** Worker emits a `control_request` → session
    out-stream → client Allow/Deny → encrypted `permission` control frame → wrapper →
    `control_response` to claude. (plumbed; RC auto-runs today)
17. **Remote control verbs.** Client sends `interrupt` (ESC) / `set_mode` / `set_model`
    control frames (session channel) → wrapper → claude. Slash commands such as `/compact` and
    `/clear` use the ordinary `user` content path, so Claude receives, acknowledges, echoes, and
    replays them like prompts; the reserved `command` control kind is not emitted.

**Resilience**

18. **Network blip mid-turn.** Client SSE drops → reconnect
    `GET /api/stream?identity=id&session=sid` (resolve token → run → resume by `startIndex`);
    at-least-once → dedup by `msg_id`; no missed/dup frames.
19. **Wrapper/CLI restart.** **Current A0:** reboot/crash → relaunch
    `remote-claw --continue` + `/remote-control`. `claude --continue` reloads the prior
    conversation into its **own local TUI**, but the RC wire does **not** re-stream it
    (grounded §17). The process-local wrapper starts with an empty binding and normally exposes a new
    synthetic RC `session_id`; Workflow also starts with an empty host `#log`, while SQLite/libSQL
    may retain the old route's sealed projection but cannot make the new process reclaim it. The new
    announce creates a separate row while an
    already-open viewer keeps the old row disconnected. A cold reload reads the last-64-frame bus slice, so
    it may show both the old disconnected row and the new connected row; this is incomplete transport
    replay, not an offline registry. Under an honest host clock, replaying the old timestamp does not
    make that row connected again, but A0 has no future-skew admission bound. **[V]** C5 (re-scoped: the **local TUI** recovers;
    RC does not backfill)

    **Selected A1 target:** reopen the persisted `(collaborationServerId, logicalChatId)` scope,
    acquire a new durable coordinator epoch, and resume the stored Claude conversation UUID. Try the
    known private `cse_*` first. Advance the native process through its fenced forward-incarnation transition;
    if Claude creates a replacement `cse_*`, install it through a separate fenced transport-attachment
    transition. Bind the resulting worker epoch to the current native/coordinator epochs. Reconcile
    persisted RC state and proven native transcript evidence without expecting worker backfill, then
    broadcast the same server/chat scope on the canonical derived tokens
    `bus:a1:${scopeAddress}` and `sess:a1:${chatAddress}` (§4.3). The existing
    `(identity_id, collaborationServerId, logicalChatId)` viewer row un-greys and continues;
    uncertain pre-crash delivery stays quarantined rather than being resent.
20. **Host offline → back.** Wrapper exits (never outlives the CLI) → **stops
    broadcasting** → a mounted client moves its rows through connected (<45 s), reconnecting
    (30 s), and disconnected, then retains them. A cold open shows any old announcements in its
    last-64-frame tail slice as reconnecting/disconnected rows and otherwise shows none; complete
    offline listing remains deferred (§6C). On Workflow the bus run persists without an idle timeout
    (§6B/§13); on SQLite/libSQL the bus channel database persists sealed frames. Either way,
    other sessions may keep broadcasting. Bus existence alone does not mean connected.
    A send to the gone session is rejected **client-side** (greyed → send disabled). If that UI guard
    is bypassed, `POST /api/relay` does not reject an absent native attachment: Workflow may start a
    new run and SQLite/libSQL may insert into the old channel log, either leaving a frame without a
    live native consumer. If the same relay incarnation
    returns to the same token it may consume the frame later; an A0 relaunch under a new synthetic ID
    leaves the old frame orphaned. The client must not automatically resend an ambiguously accepted
    mutation. If the same live
    controller reconnects, its next accepted current announce un-greys the row; Workflow `catch_up` or durable
    subscription replay fills only the projection the relay path retained. A process relaunch follows
    scenario 19: A0 creates a separate row, while A1
    reacquires the stable `(collaborationServerId, logicalChatId)` scope and un-greys the existing
    `(identity_id, collaborationServerId, logicalChatId)` viewer row after recovery.
21. **Workflow bus reaches its event-cap boundary.** Current A0 has no production pre-cap controller. The tested
    `__close` primitive can end the old stream and free the token, but neither wrapper nor broker counts
    events or invokes it. A release proof must add publisher fencing, explicit close/re-`start()`, client
    EOF/re-tail, and no-loss cursor behavior; until then, availability at this boundary is unsupported.
    Selected A1 uses its durable per-route generation manifest instead.
22. **Client returns after being away (cold tab).** A client that closed comes back:
    a reload in the same tab decrypts the wrapped credential from `sessionStorage` with the
    non-extractable IndexedDB key, while a new tab must onboard again. It subscribes to the bus,
    renders generation-accepted announcements from the last-64-frame slice with their derived connection
    states, and opens a chat by requesting history from the beginning:
    Workflow uses `catch_up{since=0}` while SQLite/libSQL resumes the retained frame log from its
    start. The client has no persistent transcript cache; only a mounted viewer's transcript/order
    state survives in memory. It can recover projection frames retained by the selected relay path,
    but Claude's native transcript is not an RC backfill source. An empty/offline channel means
    *offline*, not *gone* (§6B), so the client retries rather than treating absence as deletion.
23. **Two wrappers, one machine, one drops.** Two `remote-claw` processes on one machine
    (one secret) both
    broadcast on `bus:${identity_id}` (each its own session's announces). A client sees
    both sets of spaces. One process exits → only *its* announces age out → client greys
    *those* locally; the other process's sessions + bus channel stay live because the survivor keeps
    broadcasting (§6B).

**Adversarial / threat-model coverage** (the broker is hostile per §2 — drop/withhold/
reorder/**replay**, no keys)

24. **Broker replays a stale announce.** Session announces at `T` (`sent_at=T`); the client
    initially shows it connected. After 45 s it becomes reconnecting and, after the 30 s grace,
    disconnected. An exact same-generation replay to that mounted client is rejected by
    `shouldAcceptAnnounce` ordering, not by timestamp age. A cold client with no accepted state may
    accept the old frame and seed a disconnected row. A delayed higher-sequence frame keeps its
    original `sent_at`, so under an honest host clock it cannot look connected after
    `sent_at + 45 s`; A0 has no future-skew bound. Selected A1 adds the certified two-sided freshness
    rejection (§4.3).
25. **Two wrappers race the initial Workflow bus create.** Both sessions of a cold identity enable RC
    at once → both `resumeHook`→`HookNotFound`→`start()`. The 1:1 token lets one win; the
    other workflow terminates with `HookConflictError`. That workflow's caller never receives or
    catches the error; it keeps polling the deterministic token with bounded backoff, resolves the
    winning run, and resume-tails it (§6B). This create race is not an HTTP `409`. Both wrappers end
    up broadcasting on the one bus; no announce is lost.
26. **Clean session end (vs crash).** The wrapper or local native process exiting stops that
    session's announces; a mounted viewer shows connected for at most the remaining 45 s threshold,
    reconnecting for 30 s, then retains a disconnected row—same as a crash, since presence is
    broadcast-driven (no special "left" frame needed). In the current relay an
    authenticated viewer `end` does **not** stop the native session or announcements: it emits no
    `end_session` and only clears open relay permission gates.
27. **Mutation-control reorder / ambiguous timeout.** The broker reorders or withholds mutation verbs.
    Order-dependent ones are **serialized client-side** (send the next only after the prior's
    effect shows on the out-stream — §6A), so e.g. `interrupt` can't be inverted with a later
    `set_mode`. Shipped A0 rejects a late first delivery of those direct verbs, but it emits no durable
    result: an exact-ID retry is silently dropped and a fresh ID may repeat an already-applied action.
    The client therefore reconciles the native effect, issues a fresh intent only after proving the old
    one did not apply, or surfaces an ambiguous outcome. A0 does not enforce `expiry` for `permission`
    or `catch_up`; an open native permission gate is the only additional stale-answer guard, while a
    fresh read-only `catch_up` merely risks redundant projection replay. Current permission frames
    omit `expiry`; a withheld answer may act only while the corresponding native gate remains open.
    Selected A1 makes exact retry safe by returning the stored action-specific result.

Also covered by the same mechanisms (not numbered): **machine reset** (after stopping the old relays,
new `S` → new `identity_id` = a new identity for that machine with a fresh, empty set of spaces;
legitimate future service abandons the old identity, but copied old credentials remain live on
retained old routes; other machines are untouched — §4.4), and a **broker
(Vercel) outage**. The local TUI and Claude's native transcript can keep working while remote control
is unavailable, but that does not prove the missing native interval can be reconstructed into the
viewer projection: the relay may fail closed after a publish error, and Claude does not backfill RC.
On recovery, clients re-subscribe and receive only frames retained by host `#log`, the durable broker
log, or a still-mounted client's memory; any unobserved interval remains an explicit reconciliation
gap.

## 16. Message sequences (per use case)

Actors: **C**=web/generic client · **V**=broker ·
**W**=wrapper/relay (host side: MITM + relay client) · **T**=real claude TUI ·
**A**=Anthropic API (**non-RC passthrough**, including inference/OAuth). These sequences depict the default
`--rc-inference=anthropic` mode; Bedrock mode replaces that inference leg and locally answers the
Anthropic-origin control surface. All C↔V↔W payloads are
ciphertext (`{…}` = decrypted view); every C/W→V call carries
`Bearer auth_token` (§4.5; Vercel Deployment Protection may additionally gate the deployed
origin). Frame kinds per §6A. `→` one
message; steps are ordered. The concrete steps below show the live-default **Workflow profile**:
`POST /api/relay` maps to `resumeHook`, while `GET /api/stream` maps to
`getHookByToken→getRun→getReadable` over SSE. In the shipped SQLite/libSQL profile those same
data-plane calls map to an idempotent frame insert and indexed log subscription; the host additionally
uses `/api/seq` and `/api/frame-count` when starting a durable incarnation.

Channels are addressed by **derived tokens** (§6B): the identity **bus**
`bus:${identity_id}` and per-session `sess:${identity_id}:${session_id}`.
No `/api/identity`, `/api/sessions`, or `/api/heartbeat`.
In the shipped A0 sequences below, `session_id` is the private synthetic RC `cse_*`. In the selected
A1 target, the discovery token is
`bus:a1:${scopeAddress}`, the chat token is `sess:a1:${chatAddress}` (both canonical tuple hashes from
§4.3), the canonical chat is `(collaborationServerId, logicalChatId)`, and the viewer
announce/row key—and any future browser-cache key—is
`(identity_id, collaborationServerId, logicalChatId)`. The inner `cse_*` is a separately persisted
transport binding and may change without changing this channel.

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

**4. Enable `/remote-control` mid-session — shipped A0** *(C1 verified; C2 disproven — no backfill)*
1. user types `/remote-control` in T
2. T→W `POST /v1/code/sessions {title, config{cwd,model}}` *(MITM-intercepted)* → W `200 {session{id:rcSid}}`
3. T→W `POST …/{rcSid}/bridge` → W `200 {worker_jwt, api_base_url}`
4. T→W `GET …/{rcSid}/worker/events/stream` (SSE); W→T `control_request{initialize}`
5. **No backfill** — the stream carries only **new** events from here (grounded §17: the worker does **not** re-emit pre-RC turns). W's in-memory log starts effectively empty and covers the conversation **from RC-enable forward**; the prior local turns stay in claude's `.jsonl`.
6. W **joins the bus immediately**: `resumeHook("bus:"+identity_id, …)` (resume-or-**start** the bus run; after a start, its caller polls `getHookByToken` with bounded backoff on absence; a duplicate start's `HookConflictError` terminates only that losing workflow and is never caught by the caller); opens the session stream `sess:${identity_id}:${rcSid}`; **broadcasts** `session_announce{…, sent_at}` (every `ANNOUNCE_INTERVAL` + on change). **No completeness gate** is needed — the log is complete from the moment it starts, so a client racing in with `catch_up{since=0}` gets the whole session-so-far. The selected A1 path instead binds `rcSid` beneath a stable `(collaborationServerId, logicalChatId)` scope, publishes discovery on `bus:a1:${scopeAddress}`, and uses `sess:a1:${chatAddress}` for that chat.

**5. Launch with RC ON** (`remote-claw --remote-control`) — as #4 steps 2–4 + the join-bus/broadcast of step 6, **no backfill** (empty history).

**6. Client first connection**
1. user onboards the machine's **pass**; C loads `{identity_id/auth_token, content_root, control_key, K_meta}` from it (no derivation, no `rc1_`)
2. C→V `GET /api/stream?identity=identity_id` → V `getHookByToken("bus:"+identity_id)`→`getRun`→`getReadable({startIndex:-64})` → SSE *(HookNotFound ⇒ `200` empty: nothing connected)*
3. the requested last-64-frame slice normally includes each connected W's latest
   `session_announce{sid, title, cwd, identity_label, status, last_activity, sent_at}` (AEAD `K_meta`);
   C folds valid frames by incarnation/generation, decrypts them, and derives connected (<45 s),
   reconnecting (30 s), or disconnected. Old frames can seed offline rows; A0 does not reject them
   by age. C sends no discovery request frame to W; wrappers' periodic broadcasts keep live rows current.

**7. One MACHINE, 5 independent sessions**
1. one machine's secret → one `(identity_id, auth_token, …)`; 5 separate `remote-claw` processes on that machine each broadcast their **own** `session_announce` on the one bus
2. C subscribes that single bus (as #6) → last-64-frame slice normally includes all 5 sessions' latest announces
3. C renders all 5 as separate spaces, each with **independent** presence state derived from its own
   announce age—per-session, no aggregator (§1). To watch several **machines** from one viewer, hold
   several passes (one active at a time)

**8. List an identity's spaces** = generation-accepted `session_announce`s in that identity bus's
client-requested last-64-frame slice; C decrypts titles and renders each row with its derived connection state.
This is a gchat-style list, not a complete offline registry.

**9. Open a session cold — full history sync**
1. Workflow: C encrypts `catch_up{since:0, msg_id, expiry}` (control key) → C→V
   `POST /api/relay` → `resumeHook("sess:"+identity_id+":"+sid,…)`.
2. Workflow: V→W via the session hook; W decrypts `catch_up` and replays host `#log` from 0 with
   original `{seq,msg_id}`.
3. SQLite/libSQL alternative: C subscribes from frame index 0; V reads the retained sealed log
   directly, W keeps `#log` empty, and a redundant `catch_up` is ignored.
4. V→C stream → C deduplicates, decrypts, renders history, then tails live.

**10. Mounted viewer reconnect**

1. ordinary transport re-subscribe while the generator remains mounted → C retains its in-memory
   `FrameOrderer`; in full mode it re-reads from `0` and suppresses duplicate frames
2. non-durable incarnation change → C resets the orderer, resumes from in-memory `streamCursor`, and
   requests host `catch_up{since=0}`; durable incarnation change returns to full mode
3. UI revive → C retains the rendered React messages but starts a new generator and requests history
   from `0`; `msg_id` reconciliation absorbs replay
4. only explicit gap repair requests `gap.nextSeq`; a cold tab has no cursor and follows #22 from the
   beginning

**11. Send from client → underlying claude** *(verified C3 — the core loop)*

1. C: encrypt `user{content}` **as a content frame under `K_session`** → C→V `POST /api/relay {kind:user, client_msg_id, msg_id}` → `resumeHook("sess:…",…)`
2. V `hook.resume(sess token, frame)`
3. W: hook fires → shipped A0 **dedups by `msg_id`** before open/decrypt; a duplicate is silently
   dropped, while a new frame decrypts and allocates `seq`
4. W→V session out-stream `{kind:accepted, client_msg_id, seq}` → V→C SSE → C clears "pending"; this proves relay receipt/order only
5. W→V echoes and records the user frame, then W→T injects it on the worker SSE *(MITM downstream)*
6. T→A `POST /v1/messages` *(inference, passthrough)*
7. T→W `POST …/worker/events [{assistant},{result}]`
8. W: log+encrypt → W→V session out-stream `{assistant, seq}` then `{result, seq}`
9. V→C SSE → C decrypts + renders

Selected A1 changes step 3: it authenticates and reassembles first, then consults the durable
full-scope source-ID/digest result record. Only a complete exact logical-frame replay qualifies; one
matching multipart chunk does not. A terminal replay enqueues the stored `accepted` in a newly
identified delivery envelope and stops, while a same-ID/different-message collision quarantines the
source.

**12. Client-driven exchange also appears in the local TUI** *(verified C4)*

1. W→T remote prompt from #11; T renders it, calls inference, and renders the reply in the same native session
2. Ordinary prompts typed directly at T are not currently projected to C

**13. Two clients, one session (fan-out)**
1. C₁,C₂ each: C→V `GET /api/stream?identity=id&session=sid` (two readers on the session out-stream, via token→run)
2. any out frame → V fans to both; an `in` frame from either → session hook → W→T → out-stream → both + T

**14. Switch machine (replace, not accumulate)**
1. user onboards machine 2's pass → C **closes the old SSE** → **forgets** the prior pass (remove wrapped `sessionStorage` blob, best-effort delete the IndexedDB device key, and drop in-memory viewer/transcript/order state, §1A E) → loads keys for `identity_id₂` → saves its newly wrapped tab credential → subscribes the **new** bus (as #6) → its connected sessions' announces render its spaces. One pass on the client at a time (§7); no persistent transcript or alias cache is shipped.

**15. Rename identity/space** *(not shipped in A0)*
1. C renders the default from `session_announce`; it has no rename action or local alias store
2. **no** frame is sent. Local aliases and cross-device/persistent rename are deferred (§6C).

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

**19. Wrapper/CLI restart** *(C5 re-scoped: local TUI recovers; RC does not backfill)*

**Current A0**

1. both die → operator relaunches `remote-claw --continue` *(passthrough; `claude --continue` reloads the conversation into its **own local TUI**)* → W spawns **T** through the MITM
2. user `/remote-control` → bridge→stream (as #4) → **no backfill**: the worker streams only **new** events, and the process-local wrapper exposes a new synthetic RC `session_id` with an empty log/binding
3. W joins the bus and broadcasts that new id; an already-open C retains the old row as disconnected
   and adds a separate new row. A cold reload may also show both while the old announce remains in the
   last-64-frame bus slice.

**Selected A1 target**

1. W reopens the durable coordinator journal, reacquires the stable
   `(collaborationServerId, logicalChatId)` scope, and resumes the stored Claude conversation UUID with
   input closed
2. W advances the native process through a fenced forward-incarnation transition and tries the known private `cse_*` first; a reusable one starts a new worker epoch, while a replacement `cse_*` uses a separate fenced attachment transition under the same native binding and server/chat scope
3. W reconciles persisted RC state plus proven native transcript evidence; the worker contributes no history backfill, and ambiguous pre-crash delivery is not retried
4. W announces on `bus:a1:${scopeAddress}` and tails `sess:a1:${chatAddress}`; C addresses its row by
   `(identity_id, collaborationServerId, logicalChatId)`, un-greys it, and continues the same logical
   chat rather than receiving a second row; any future browser cache uses that complete tuple

**20. Host offline → back**
1. W/CLI exit → W **stops broadcasting**; the last announce ages past A0's 45 s connected threshold
2. C (tailing the bus) shows **reconnecting** for 30 s and then retains a **disconnected** row. A
   fresh open accepts any old announce in the last-64-frame slice as an offline row, or renders empty
   if none remains (the bus run persists—there is no idle-timeout).
3. send is blocked **client-side** (greyed → disabled); if bypassed, publish may create/reuse a Workflow run and buffer a frame without a native consumer. The same relay incarnation may consume it on return; an A0 relaunch under a new synthetic ID can orphan it. Do not automatically resend an ambiguously accepted mutation.
4. if the same live controller returns, its next accepted current announce un-greys the row and
   `catch_up` fills the gap; a process relaunch follows #19 (new row in A0, same recovered logical row in A1)

**21. Bus reaches its event-cap boundary**
1. current A0 does not count events or invoke the tested `__close` primitive before 25k
2. clean publisher fencing, close/re-`start()`, EOF/re-tail, and no-loss cursor behavior remain a release proof, not shipped behavior
3. selected A1 instead follows its durable route generation manifest

**22. Client returns cold (was away)**
1. same-tab reload: C decrypts the wrapped `sessionStorage` credential with its non-extractable IndexedDB key; new tab: user onboards again → C→V `GET /api/stream?identity=id` (subscribe bus) → last-64-frame `session_announce` slice
2. C folds them by incarnation/generation and renders connected/reconnecting/disconnected rows
   *(no per-client server state was kept)*
3. open a chat → with no persistent transcript cache, Workflow uses `catch_up{since=0}`, while
   SQLite/libSQL resumes the retained frame log from its start → caught up to the projection available
   on that relay path

**23. Two wrappers, one identity, one drops**
1. W₁,W₂ (same secret) both **broadcast** on `bus:${id}` (each its own sessions' announces); C lists both sets
2. W₁ sleeps → its announces age through connected→reconnecting→disconnected → C greys **only
   W₁'s** sessions; W₂'s sessions + the bus run stay live (W₂ keeps broadcasting, re-waking the run — §6B)
3. W₁ returns → rejoins → broadcasts again → C un-greys W₁'s sessions on the next fresh announce

### 16.1 Primitives used (per scenario)

Compact map of the building blocks each scenario exercises. Vocabulary: `HKDF`
(derive) · `GCM` (AES-256-GCM seal/open) · `AAD` · `sha256` · `CSPRNG` ·
`checksum` · broker data plane: `/api/relay`(Workflow `resumeHook` or SQLite insert)
`/api/stream`(Workflow SSE via `getHookByToken`→`getRun`→`getReadable`, or SQLite log poll) ·
durability/sequence cursor: `/api/seq` · host-only inbound cursor: `/api/frame-count` ·
`bearer`(`auth_token`, self-verifying)
`deployment-protection`(optional Vercel edge gate) · shipped-A0 bus:
`bus:${id}` `sess:${id}:${sid}`; selected-A1 routes:
`bus:a1:${scopeAddress}` `ctl:a1:${serverControlAddress}` `sess:a1:${chatAddress}`, each derived from
the full machine/server/route-or-chat scope ·
`session_announce`(periodic broadcast, `sent_at`) `a0-conn-state`(connected if age <45 s,
then reconnecting 30 s, then disconnected/retained) `a1-fresh`(certified two-sided
`FRESH_WINDOW`/`SKEW` admission) `grey-local` ·
workflow: `hook` `wf-stream`(durable resumable) · host/MITM: `args-passthrough`
`--rc-*` `intercept`(/v1/code/sessions*) `passthrough`(/v1/messages) `bridge`(worker_jwt)
`worker-SSE` `/worker/events` `initialize` `log`(live, no backfill) `dedup`(msg_id)
`seq-alloc` `/remote-control`.

| # | Scenario | Primitives |
| --- | --- | --- |
| 1 | Fresh identity bootstrap (`--rc-identity`) | `CSPRNG(S)`, `HKDF`→{identity_id,auth_token,content_root,control_key,K_meta}, `checksum`, print `rc1_…` *(local only; no broker call)* |
| 2 | Wrapper launches TUI, RC off | `args-passthrough`, MITM `passthrough`, CA trust *(no broker traffic; not on bus)* |
| 3 | Work locally, RC off | `passthrough`, claude on-disk transcript (no /v1/code; broker sees nothing) |
| 4 | Enable `/remote-control` | `intercept`, `bridge`, `worker-SSE`, `initialize`, `log`(live, no backfill), `GCM`, **join-bus**(`resumeHook bus:${id}`), broadcast `session_announce`, `bearer` |
| 5 | Launch with RC on (`--remote-control`) | `intercept`, `bridge`, `worker-SSE`, `initialize`, `log`, join-bus + broadcast |
| 6 | Client first connection | `HKDF`, optional `deployment-protection`, `bearer`, `/api/stream`(`getHookByToken bus:${id}`, `startIndex=-64` tail slice), generation-folded `session_announce`, `a0-conn-state`, `GCM-open(name)`, wrapped credential in tab-scoped `sessionStorage` + non-extractable IndexedDB key |
| 7 | One MACHINE, 5 independent sessions | 1× `HKDF`, `bearer`, **1× bus subscribe**, 5× per-session `session_announce`, independent `a0-conn-state`, `GCM-open`, no aggregator (§1) |
| 8 | List an identity's spaces | last-64-frame `session_announce` bus slice, generation fold, `a0-conn-state`, `GCM-open(title/cwd)`, opportunistic—not complete—offline rows |
| 9 | Cold full history sync | Workflow: `GCM(control_key)`, `catch_up`, session hook, host `#log`, `wf-stream/SSE`; SQLite/libSQL: subscription from frame 0, sealed broker-log replay, empty host `#log`; both: `seq`/dedup |
| 10 | Mounted viewer reconnect | full mode re-reads from 0 with in-memory `FrameOrderer` dedup; non-durable incarnation resumes `streamCursor` + host `catch_up{since=0}`; UI revive/cold viewer requests from 0; explicit gap repair alone requests `gap.nextSeq`; no persistent browser transcript cache |
| 11 | Client → claude → back | `GCM(content)`, `resumeHook sess:`, `dedup(msg_id)`, `log`, `seq-alloc`, `intercept`-inject, `passthrough`, `accepted`, `wf-stream/SSE`, `AAD` |
| 12 | Client-driven exchange appears in TUI | `intercept`-inject, `passthrough`, native TUI render; ordinary TUI prompts are not projected to clients |
| 13 | Two clients (fan-out) | `wf-stream` multi-reader (session), `SSE`, `seq`/`dedup` |
| 14 | Switch machine (replace) | forget prior pass, load machine 2's keys, optional `deployment-protection`, `bearer`, **new** bus subscribe → broadcast `session_announce`s (one pass on client) |
| 15 | Rename identity/space | not shipped in A0; defaults from `session_announce`; local aliases and shared rename deferred (§6C) |
| 16 | Tool permission | `control_request/response`, `GCM(control_key)`, session `hook`, `worker-SSE` |
| 17 | Remote control verbs | control frames (`control_key`), session `hook`, RC verbs (`interrupt`/`set_permission_mode`/`set_model`) |
| 18 | Network blip resume | `/api/stream?identity=&session=`; Workflow token→run/`wf-stream startIndex`, SQLite/libSQL indexed subscription cursor; `seq` reorder, `dedup` |
| 19 | Wrapper/CLI restart recovery | **A0:** new synthetic RC id/log; open or cold viewers may retain/replay the old disconnected row and add the new connected row while both announcements remain available. **A1 target:** persisted `(collaborationServerId, logicalChatId)` scope, resume UUID + known `cse_*` first, fenced replacement `cse_*` if needed, same full `(identity_id, collaborationServerId, logicalChatId)` broker channel/viewer row, no worker backfill |
| 20 | Host offline → back | stop-broadcast, `a0-conn-state`→disconnected row retained; cold replay may seed offline row; bypassed send may land in a Workflow run or SQLite channel log with no native consumer; exact-incarnation return versus A0-orphan handling |
| 21 | Workflow bus reaches event cap | shipped gap: explicit-close primitive exists, but pre-cap fencing, close/re-`start()`, EOF/re-tail, and no-loss proof do not |
| 22 | Client returns cold | same-tab wrapped credential restore or new-tab re-onboard, bus subscribe from `-64`; retained announcements may render connected or offline rows; no persistent transcript cache; Workflow current-run replay plus `catch_up{since=0}`, or SQLite retained-log replay; relay-retained projection only—no native backfill |
| 23 | Two wrappers, one drops | both broadcast on the bus; survivor keeps the logical bus channel active; dropped wrapper's rows alone traverse `a0-conn-state` to disconnected |
| 24 | Broker replays stale announce | A0 exact current-generation mounted replay rejected by generation order (legacy equal timestamps may replace without refreshing time); cold replay may seed disconnected row; honest-clock connected bound is `sent_at+45 s`, with no future-skew admission bound. A1 adds `a1-fresh` rejection |
| 25 | Two wrappers race Workflow bus create | `resumeHook`→`HookNotFound`→`start()`; 1:1 token; losing workflow terminates with `HookConflictError` while its caller polls the winning token and resume-tails it; no caller catch, no `409`, no announce lost |
| 26 | Clean session end (vs crash) | local/wrapper exit → stop-broadcast → `a0-conn-state` to retained disconnected row; viewer `end` only clears open relay gates |
| 27 | Control reorder / ambiguous timeout | client-serialized order-dependent controls; A0 direct-verb `expiry` check + incarnation-local `dedup(msg_id)`, then native-effect reconciliation or visible ambiguity—never blind fresh-ID resend; A1 exact replay returns stored result |

## 17. Appendix — Claude's Remote Control protocol (reverse-engineered)

> **What this is.** The Anthropic-side protocol that `claude --remote-control` speaks, which the
> remote-claw wrapper MITMs to become the RC backend (§3.1, §14). Empirically captured on **Claude
> Code v2.1.168** (Phase 0 — [`docs/phase0-findings.md`](phase0-findings.md), [`docs/remote-control-research.md`](remote-control-research.md));
> **undocumented and version-sensitive** — re-verify on any claude upgrade. Inference
> (`/v1/messages`) and OAuth are **not** part of this. The wrapper passes them through in the default
> Anthropic inference mode; Bedrock mode translates inference and synthesizes the required
> Anthropic-origin control/API responses locally.

### 17.1 Two transports — and which one we intercept

Claude Code has two distinct RC transports:

- **Interactive RC = a plain HTTPS sessions API** on `api.anthropic.com` under `/v1/code/sessions*`.
  This is what `claude --remote-control` (and the `/remote-control` slash command) actually use,
  and **what remote-claw intercepts.** It shares the host with inference, so interception is a TLS
  **MITM of `api.anthropic.com`**: serve `/v1/code/sessions*` ourselves and, in the default Anthropic
  inference mode, pass `/v1/messages` + the OAuth/token endpoints through to the real upstream.
  Bedrock mode terminates/translates those remaining inner calls instead.
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
| `GET  /v1/code/sessions/{id}/worker/events/stream` | **SSE downstream** (relay→host): `event: client_event`, `data:{event_type, source:"client", payload}`; the v2.1.168 reference capture begins with `control_request{subtype:"initialize"}`, and our synthetic relay guarantees it first |
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

In the v2.1.168 reference capture, a turn verified end-to-end is:
`control_request(initialize)` → `control_response` → `user`
(`source:"client"`) → `assistant` → `result`. Streaming deltas arrive as raw **Anthropic
Messages-API** events (`message_start` → `content_block_delta`×N → `message_stop`), wrapped in a
`stream_event`.

The initialize-first ordering is a reference-capture observation and a current synthetic-relay
invariant, not a proven universal Anthropic guarantee. A separate manual local capture did not show an
initialize before a sequence-1 user event. The future outward Claude connector must therefore tolerate either shape and
reconfirm it in a sanitized gated proof.

### 17.4 Permissions — RC auto-executes (no approve gate)

Verified against both our relay and Anthropic's real relay: in Remote Control, tools
**auto-execute with no `can_use_tool` prompt**, even under `--permission-mode default`. The real
flow for a tool turn is `user → assistant(tool_use) → user(tool_result) → assistant`.
`--permission-mode` sets the posture; the `control_request`/`control_response` plumbing exists but
RC does not currently gate on it.

### 17.5 How remote-claw maps onto it (§3.1, §6A, §14)

The wrapper runs the **real** `claude --remote-control` behind a TLS MITM of `api.anthropic.com`:
it **serves** the worker `/v1/code/sessions*` endpoints itself (becoming the RC backend) and
in the default Anthropic mode **passes** `/v1/messages` + OAuth through, so inference and auth keep
working. Bedrock mode translates inference and locally synthesizes the other required
Anthropic-origin responses.

Current registration lifecycle is host-scoped rather than always a direct per-session bridge call:
`launch.ts` opens one `LegacyRcConversationRegistrar` lease per intercepted `Session`, while OpenCode
opens one `starting` lease, confirms one exact canonical native session ID, and proves parent
permission setup unless the operator explicitly skips it. Tmux also opens one `starting` lease, builds
one private per-launch tmux server/socket plus owner-only settings and launcher files, and requires
both a positive pane probe and a SessionStart marker from those exact settings before publication.
In all three paths, `ready` starts `startBridgeSession` with that lease's own abort controller.
Tmux may construct its native capture, injection, and permission pumps after native readiness but
before publication; no broker client or announcement exists then, so no remote mutation can reach the
pane before `ready`. Starting a bridge does not wait for its initial announcement as a readiness
barrier, but its `served` promise remains pending until every admitted initial or refresh announcement
settles. Each current launcher bounds teardown: MITM shares one deadline across its cleanup stages;
tmux gives pumps plus lease/relay settlement one deadline and gives pane termination only the time
remaining, deleting its private runtime only after termination is proved; OpenCode shares one
driver-local deadline across tracked child permission setup, its confirmed-session abort request, and
lease/relay settlement after stopping local pumps.

The wrapper maps worker events onto its own E2E-encrypted frame types (§6A):

- the SSE `initialize` and client `user` events → inbound (`dir:in`) frames delivered to claude;
- the host's `assistant` / `result` / `system`·`status` outputs → outbound (`dir:out`) content
  frames broadcast to subscribers;
- catch-up comes from the wrapper's in-memory `#log` on a non-durable backend, or directly from the
  broker frame log on a durable backend. It does **not** come from a worker backfill or the
  cursor-paginated `GET …/events` API—the worker re-emits no history, and current `--rc-app` is off
  Anthropic's relay.

Phase 0 verified this two-surface sync end-to-end on v2.1.168 (the **MANGO** own-relay test, and
the **KIWI**/**PLUM** bidirectional TUI↔client tests).

> **Pinned to v2.1.168.** Every shape here is reverse-engineered from a single binary and can change
> on any claude upgrade — the original `--sdk-url` premise was already patched out once (§17.1). Keep
> `phase0/` (the capture tooling + `mitm/capture-proxy.py`) to re-verify, and have the wrapper **fail
> loudly** on an unrecognized RC-API shape rather than guessing (§12).

## 18. Appendix — Happy's Claude/Codex relay (not official Codex Remote)

**Happy** (`happy.engineering`, open-source `slopus/happy`) is the closest existing system to
remote-claw: a mobile + web client that drives **Claude Code / Codex** running on your machine
through an **E2E-encrypted relay**, with realtime + voice. It sits at the *opposite corner* of the
same design space — **account-based with a device registry** where remote-claw is
**credential-registry-free and per-machine-secret** — so it is the clearest mirror for what
remote-claw gives up (per-viewer revocation, §4.4) and what it gains (paste-and-go, no accounts).

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
  hacks the server, they can't read your data") but it is **server-stateful** — there is an account, a
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

This table compares Happy with remote-claw's Vercel Workflow and durable SQLite/libSQL profiles.
Both broker profiles retain sealed data—the Workflow profile in a capped provider-managed run stream,
and SQLite/libSQL in an explicitly durable frame log—but neither keeps an account, device, credential,
or revocation registry.

remote-claw and Happy answer the same problem with inverted primitives:

| dimension | **remote-claw** | **Happy** |
|---|---|---|
| Root of trust | one symmetric `S` **per machine** (a ~52-char paste) | phone-held asymmetric master + content keypair |
| Per-device keys | the **pass** (§4.2a) — a derived, non-master per-viewer credential (read+steer one machine, **not** `S`) | per-machine DEK, wrapped to the account key |
| Broker state | Workflow: capped sealed run stream; SQLite/libSQL: durable sealed frame log; neither has an account/device/credential registry | account + device list + encrypted-DEK store |
| Durable history | optional sealed broker projection; native `.jsonl` remains separate on-host evidence | **server stores** encrypted history (timestamped, replayable) |
| Onboarding | **paste-and-go** (any device, no account) | scan a QR → pair a device → account |
| Steal one key | scoped to **one machine**: a stolen pass reads/steers that machine but is **not** `S`; a stolen `S` is full compromise of **that machine only** (others untouched) | scoped: one DEK reads **that machine's** content only |
| Revoke a leak | **no per-pass revoke** — stop old relays and reset to move future service; copied passes remain valid on retained old routes (§4.4) | **"remove machine from account"** revokes that DEK server-side |
| Forward secrecy | none | future-only after a device removal |

The summary: **Happy spends an account/device registry + a pairing step to buy per-device,
*revocable* access and a stable account identity; remote-claw spends per-viewer revocability to buy
registry-free admission and a one-string, account-less, paste-and-go cold start.**
(remote-claw already
gets *scoped compromise* for free — one secret per machine bounds a steal to one machine; what Happy
buys on top is **per-device revocation**.) Neither is strictly
better — they are the two ends of the §4.4 impossibility
(`{ registry-free admission · stable id · revoke-a-leak }`, pick two), applied per machine. Happy
picks *stable id + revoke* (and pays with the registry); remote-claw picks *registry-free admission*
(and pays with per-viewer revocation). Changing the ciphertext-retention backend does not alter that
admission tradeoff.

### 18.4 If remote-claw ever needs per-viewer revocation

Per-machine identity already buys **scoped compromise** (one steal = one machine), so the
Happy-shaped migration is **not** about scope — it is about **per-viewer revocation** (cutting one
pass without resetting the machine). The migration target maps onto the **server-registered split**
named in §4.4 (`S_server` + `S_paste` = an account half + a paste half), which delivers
revocable, per-viewer access at the cost of an account/registry, a broker store, and weakened
zero-knowledge — i.e. moving toward Happy's corner. It is a deliberate, deferred decision, **not** a
v1 default. Until a hard need appears (revoke one shared pass while keeping the machine), the
paste-and-go, per-machine model stands, with either the capped Workflow run-stream profile or a
durable sealed-log broker profile.

**Sources:** Happy docs — `https://happy.engineering/docs/security/`,
`https://happy.engineering/docs/how-it-works/`; repo `https://github.com/slopus/happy`.
