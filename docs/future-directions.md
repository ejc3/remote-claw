# Future Directions & Design Findings

Forward-looking notes for remote-claw, captured 2026-06-11. Three findings that bear on where the
project goes next, and how they connect:

> **Status update (2026-08-23):** this is historical exploration, not the active roadmap. The sole
> product finish line is [Claude 1.0](release-finish-line.md). The
> [Client-driven Host Runtime](client-driven-host-runtime.md) preserves an optional multi-engine
> architecture, but it is parked and cannot add a Claude 1.0 prerequisite. Candidate language later
> in this document is retained only as design history.

1. **How the popular remote-Claude clients actually work** (Happy / Happier) and what they cost you in
   Claude Code **TUI fidelity**.
2. **A durable shared-log ("SQLite") model** — a design direction that would dissolve much of the
   relay's hand-rolled durability machinery.
3. **A hard platform constraint** — native Remote Control is **Anthropic-API-only**; it is disabled
   under Bedrock / Vertex / Foundry.

These are not independent. Native Remote Control (which remote-claw rides) is simultaneously (a) the
*only* path that keeps the real TUI losslessly, (b) a live proof that the durable-log model works
(Anthropic's own backend is a sequence-numbered append log), and (c) unavailable to third-party-provider
users. Together they frame the central roadmap question: **stay native-RC-only, or branch toward a
provider-agnostic transport?**

---

## 1. The remote-Claude landscape — mechanisms & TUI fidelity

There are three fundamentally different ways to drive Claude Code from elsewhere, and they are *not*
interchangeable for someone who wants to lose **zero** of the Claude Code terminal experience.

- **(A) Headless reconstruction.** Drive `claude` via the Agent SDK (`@anthropic-ai/claude-agent-sdk`,
  `query()`) or `--output-format stream-json` — no TUI runs; the app **redraws its own UI** from the
  message stream. Clean to capture; structurally loses TUI-only features.
- **(B) Real-TUI streaming.** Run the actual interactive `claude` TUI in a PTY (tmux/zellij + xterm.js)
  and stream the **literal terminal**. Pixel-faithful, provider-agnostic — but rarely pointed at
  `claude` itself.
- **(C) Native Remote Control.** Run `claude --remote-control`; Anthropic's hosted backend mirrors the
  real TUI's **event stream** (`worker/events`) to a client. Highest-fidelity feed; Anthropic-API-only
  (see §3).

### How Happy / Happier sit (source-grounded)

The popular apps are **Happy** (`github.com/slopus/happy`, npm `happy` — formerly `happy-coder`) and its
fork **Happier** (`github.com/happier-dev/happier`, npm `@happier-dev/cli`), which adds many agent
backends (Codex, Gemini, OpenCode). For *Claude specifically* their behaviour is nuanced — and easy to
mis-state:

- **They run the real `claude` TUI — but locally.** Happier's default `local` mode spawns real `claude`
  with `stdio:['inherit','inherit','inherit']` (`apps/cli/src/backends/claude/claudeLocal.ts`), so the
  genuine TUI runs **in your own terminal**; `happier attach <session-id>` reattaches you to it
  ("switch into local mode when you want to use Claude Code's native terminal UI directly"). An opt-in
  `unified terminal` mode runs the real interactive TUI inside **tmux/zellij** (it explicitly strips
  `--print`/stream-json — `buildClaudeUnifiedTerminalSpawn.ts`).
- **The phone/web view is always a reconstruction.** App-driven turns use the **headless Agent SDK**
  (`--output-format stream-json --verbose --print`, `@anthropic-ai/claude-agent-sdk ^0.2.123`);
  local-mode turns are mirrored by **tailing the transcript JSONL**. Either way the app redraws its own
  "canonical timeline," not the TUI.
- **Their one real-terminal-to-phone feature runs a shell, not `claude`.** The "embedded terminal"
  streams a genuine `node-pty` PTY to xterm.js (web) / a WebView (mobile), but it spawns your `$SHELL`
  for "session-adjacent work" (logs, git, scripts) — *not* the interactive `claude` TUI.
- **They never use native `--remote-control`.** Confirmed by source inspection — the only
  `--remote-control*` token in the repo is a CLI flag-arity passthrough entry, not an invocation.

So "Happier lets you use the real Claude Code TUI" is **true locally, false on the phone**.

### The honest taxonomy

| Path | Real `claude` TUI runs? | What the phone/remote screen shows |
| --- | --- | --- |
| Happier `local` / `attach` | ✅ in **your** terminal | reconstruction (JSONL tail) |
| Happier `remote` (Agent SDK) | ❌ headless | reconstruction (SDK stream) — loses the most |
| Happier embedded terminal | n/a (your **shell**) | literal PTY pixels — but **not `claude`** |
| Native RC (remote-claw) | ✅ `--remote-control` | client-rendered from the **worker-events** feed — richest stream |
| Literal `claude`-TUI → PTY → phone | ✅ | **nobody ships this** (would be pixel-perfect) |

### Per-feature fidelity (headless reconstruction vs native-RC feed)

| Feature | Happy/Happier remote (headless SDK) | Native RC / remote-claw |
| --- | --- | --- |
| Slash commands (`/context`, `/model`, `/resume`…) | **largely lost** (only a few emulated client-side) | preserved (ride the user-input path) |
| AskUserQuestion | semantics via a custom widget | native question UI, mirrored |
| Permissions (allow/deny) | `canUseTool` callback, custom UI | native gate relayed |
| Thinking / extended thinking | **flattened** to markdown italics | distinct thinking frames |
| Plan mode | partial (no Shift+Tab exploration) | mostly preserved (Shift+Tab stays local) |
| Todos / diffs / sub-agents | preserved (custom views) | preserved (relayed) |
| Exact rendering | **lost** (reconstruction) | preserved (it *is* the TUI's stream) |

**Caveat (being fair to native RC):** even native RC is not pixel-mirroring — the remote client still
renders its own UI from the worker-events feed. The difference is *feed fidelity*: worker-events carry
TUI-level semantics (the `can_use_tool` AskUserQuestion shape, thinking, sub-agent lifecycle) that the
Agent-SDK stream does not. The only *pixel-literal* remote TUI would be path (B) pointed at `claude`.

### The deepest difference — shared live control vs kill-and-fork

The tables above are about *rendering*; this is about *control*, and it is the sharpest distinction.
**Native RC lets one persistent TUI remain live while the keyboard and a phone/custom client take turns
driving the same session** — proven this session: three locally-sent messages, then a remote client joined
and sent another, all into the *same running TUI*, nothing killed or forked. Multiple client connections
can coexist; this sequential proof does not establish simultaneous busy-turn writes or their arbitration.

**Happier's `local` mode structurally cannot do this** (source-traced on `happier-dev/happier@dev`).
Because it is bolted onto a TUI it does not control (`stdio:['inherit',…]`, `claudeLocal.ts`), a phone
prompt cannot be injected — so the instant the phone sends a message, Happier **kills the local
`claude`** (SIGINT→SIGTERM→SIGKILL, `claudeLocal.ts`) and **switches the session to headless `remote`
mode**, replaying the prompt through the Agent SDK. The trigger is literally *any* inbound message
(`claudeLocalLauncher.ts:195`: *"switch to remote mode when message received"* → `doSwitch()` →
`abort()` → `loop.ts:125` `case 'switch': mode = 'remote'`). And because re-entering local mode uses
`--resume`, *"which forks to a new Claude session ID and transcript file"* (`claudeLocalLauncher.ts:252`,
`session.clearSessionId()`), the underlying claude session id is **not stable** across a local↔remote
toggle.

| | Co-drive one live TUI (local + phone)? | On a phone prompt, the local TUI… | claude session id |
| --- | --- | --- | --- |
| **Happier `local`** | ❌ no | **killed**, session goes headless | **forks** (new id per switch) |
| **Native RC (remote-claw)** | ✅ yes, same session | untouched, keeps running | stable |

The root cause is architectural: in `local` mode Happier can only *read* the terminal (tail JSONL) and
*signal* it (kill), not *share* it. But this is **mode-specific** — Happier has four Claude modes, and
its opt-in `unified terminal` mode reaches shared control by a different route (next). The honest
summary: **native RC shares one live session by default; Happier shares only in an opt-in tmux mode, via
fragile keystroke injection.**

### Happier's four modes — and where tmux mode is heading

`loop.ts` only models `local | remote`, but the `remote` arm dispatches (`claudeRemoteDispatch.ts`) to
three runners, so there are really **four** ways Happier drives Claude:

| Mode | Real `claude` TUI? | Co-drive one live session (local + phone)? | Phone sees | Write path | claude session id | Bedrock-OK? |
| --- | --- | --- | --- | --- | --- | --- |
| **`local`** (default) | ✅ your terminal | ❌ phone msg **kills + forks** → headless | JSONL reconstruction | n/a (kills → headless) | **forks** per switch | ✅ |
| **`remote` / `agentSdk`** (SDK default) | ❌ headless | ❌ phone-only | SDK-stream reconstruction | SDK input stream | resumes same | ✅ |
| **`remote` / `legacy`** (fallback) | ❌ headless | ❌ phone-only | stream-json reconstruction | stream-json stdin | resumes same | ✅ |
| **`unified terminal`** (opt-in) | ✅ in tmux/zellij | **✅ yes** (inject, no teardown) | JSONL reconstruction | **tmux `send-keys`** | **stable** | ✅ |
| *Native RC (remote-claw)* | ✅ `--remote-control` | ✅ yes (default) | worker-events feed (richest) | RC control channel | stable | ❌ Anthropic-API-only |

- **`remote` (headless SDK)** — the Bedrock workhorse. Default is the official Agent SDK `query()`; on an
  auth-error / early-exit it falls back to a vendored `claude --output-format stream-json` client.
  Permissions ride `canUseTool`; AskUserQuestion is answered structurally (`{answers}` keyed by question
  text) plus a synthesized free-form escape hatch. It **resumes the same** claude session. Tradeoff: ✅
  provider-agnostic, clean, robust; ❌ **no real TUI at all** (loses slash commands, flattens thinking),
  and **phone-only** (your local terminal shows Happier's own Ink status UI, not interactive claude).
- **`unified terminal` (tmux/zellij)** — the standout. Runs the **real interactive TUI** (strips
  `--print`) in tmux (preferred) or zellij, and **injects phone prompts as keystrokes** (`send-keys -l`
  then `C-m`), deferring while you're mid-typing. Critically it **does not kill/fork** — it injects into
  the live TUI, so you and the phone drive the *same running session* (abort = send `Esc`, "keep host
  alive"), and the session id is **stable**. Tradeoff: ✅ real TUI **+ shared control across turns +
  provider-agnostic** — the only Happier mode with native-RC-like shared control; ❌ **opt-in** + needs
  tmux/zellij, the write path is **fragile keystroke injection** (timing/mid-typing/bracketed-paste, no
  structured ack), and the **phone still reconstructs from JSONL** (the pane is `tmux attach`-style
  local, not streamed as pixels), so the phone keeps the same TUI-only fidelity losses as every other
  mode.

**Is `unified terminal` the future, or a throwaway experiment?** It reads as a **deliberate future
direction — but very new and not yet the default** (confidence: moderate-to-high). The strongest signal
is product framing: Happier's June UI now relabels the SDK path as **"Classic runtime (Agent SDK
fallback)"** ("use the Agent SDK path when unified terminal runtime is off or unavailable") — the
marketing treats the SDK reconstruction as the *fallback* and the real-TUI tmux mode as the *preferred*
path, even though the boolean still defaults to the SDK (the fingerprint of a mode mid-graduation).
Backing it: the entire `unifiedTerminal/` subsystem (~15 files) + the tmux/zellij host adapters were
**created June 6–8 2026** — days old, intensely active, landing on the default `dev` branch with tests.

Honest caveats, though: the default flag is **still OFF** (`claudeUnifiedTerminalEnabled: false`, gate
`fail_closed`) and no commit has flipped it; there is **no explicit "this becomes default" roadmap
statement** anywhere public (the verdict is inferred from code + UI strings); the older
`claude-feature-matrix.md` still names the Agent SDK as the intended *single* runtime, so the docs lag —
and possibly contradict — the June pivot; it is **~1 week old** (new subsystems can stall or get
reworked); and it is a **Happier-fork-specific bet** — upstream `slopus/happy` has *zero*
unified-terminal code. So: the real-TUI-via-tmux-injection direction is a live, serious bet by the
leading fork — evidence that **the direction is real, not that it's settled.**

This matters here because that tmux-inject pattern is the **provider-agnostic, shared-control,
real-TUI-ish** path §4 reaches for — the one I'd otherwise have called "nobody ships." Someone is now
building it; the open gap they leave is exactly the two things native RC does better: a **non-fragile
control channel** (vs send-keys) and a **richer remote feed** (worker-events vs JSONL reconstruction, or
streaming the pane itself). “Shared control” here means two writers to one terminal editor, not two
native collaborator identities; a person's partial draft and an injected prompt can merge.

---

## 2. The durable shared-log ("SQLite") model

> **Historical alternative, not the selected design.** In this section, “source of truth” means the
> order of encrypted relay/viewer frames in the rejected cloud-log model. It does not mean native
> conversation or execution authority, and it does not replace the selected local coordinator's
> command journal.

**Reframe.** The then-current design treated the wrapper's RAM as the viewer-frame
ordering/history source: the wrapper alone allocated `seq`, held the `#log`, echoed/acked viewer
messages, and replayed on `catch_up`. The Workflow provider nevertheless persisted opaque chunks in
each run's resumable stream; what was missing was an explicit indexed frame-log contract, recovery
cursors, and safe cap rollover—not all at-rest ciphertext.
Almost every durability boundary in the gap audit (§12 of `protocol.md`) exists *because* the wrapper is
a single, in-memory ordering authority.

The alternative: a **durable, ordered, append-only log is the source of truth; the wrapper and every
viewer are peers that tail it and append to it.** A store's `INTEGER PRIMARY KEY AUTOINCREMENT` *is* the
total order. Everyone polls/subscribes `WHERE id > cursor`, syncs into memory, and reduces the log.

### What it dissolves

| Today's machinery / audit finding | Under a shared log |
| --- | --- |
| Wrapper-allocated `seq` + two-pump discipline | gone — the rowid is the order |
| Seq-gap-burned-on-crash (§12 boundary #1) | gone — a failed insert just has no rowid; no hole |
| `accepted{client_msg_id, seq}` echo/ack handshake | gone — a viewer `INSERT` is durable + ordered at once |
| `catch_up` replay (wrapper must be online) | `SELECT … WHERE id > cursor` — wrapper needn't be up |
| O(N) reconnect from index 0 | resume from last rowid (indexed) |
| Unbounded `#seen` dedup set | `msg_id UNIQUE` + `INSERT OR IGNORE` |
| #36 cross-restart history (the documented residual) | wrapper boots → `SELECT MAX(id)` → resumes with full history |
| Multi-writer (viewers answering prompts) | native — viewers just append rows |

### The cost (the real blocker)

This re-opens the design then called v2 **Decision #1 (store-free)**. That label was imprecise:
Workflow already persisted each run's opaque stream. Zero-knowledge survives *only if* every row payload is
E2E-sealed and the store orders/indexes on **cleartext routing columns** while `ciphertext BLOB` stays
opaque — doable, the store never decrypts. **But** you then hold a durable encrypted transcript at rest,
so a key leak decrypts *everything*. The real delta from Workflow is explicit indefinite/indexed
retention and restart recovery instead of provider-backed per-run retention ending at an unsupported
cap cliff; “no at-rest ciphertext to re-key” was never a shipped Workflow property. It is not a
description of selected A1: current durable backends retain sealed broker frames, including chat and
server-control history from genesis. The historical v2 choice described here was the left column of
its comparison table; the durable-log direction chose the right column.

### The primitive that fits

A **Cloudflare Durable Object** is almost exactly this — a single-threaded actor with embedded SQLite +
WebSocket fan-out (one DO per session = a built-in serialization point, durable ordered storage, and
live tailing without the hook/resume/SSE machinery). On Vercel-native (to keep the original platform
bet), the closest is a **per-identity libSQL/Turso DB** + a thin tail endpoint. Either slots in behind
the existing `BrokerBackend` port as a *durable-log adapter* — except this one is the source of truth,
not a relay.

```sql
frames(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- the total order (replaces seq)
  session_id TEXT, dir TEXT, record_kind TEXT,   -- cleartext routing, queryable
  msg_id     TEXT UNIQUE,                         -- dedup as a constraint
  key_epoch  INT,
  ciphertext BLOB,                                -- E2E-sealed; the store never reads it
  created_at INT
)
```

**It is not exotic — Anthropic already does it.** A live `--rc-trace` this session showed Anthropic's RC
backend persisting the full transcript (user + assistant + result events) as a **monotonic,
sequence-numbered append log** (observed counting up — `1→41` in this short run, higher in longer
captures), replayed to a late-joining client. The durable-log model is what the platform's own control
plane already proves works; remote-claw bypasses it to keep native execution and collaboration order
host-authoritative, not to claim that Workflow stores no ciphertext.

**Recommendation:** a scoped spike — a durable-log `BrokerBackend` adapter (DO or libSQL), run the
existing contract + `rc-spine` tests against it, and measure what relay code actually *deletes* —
before committing the architecture, which hinges on the explicit retention/recovery trade above.

---

## 3. Hard constraint — Anthropic-hosted native Remote Control is Anthropic-API-only

**Finding (verified two ways, high confidence): Remote Control is totally disabled under Bedrock,
Vertex, and Foundry.**

- **Documented.** Claude Code's Remote Control docs (`code.claude.com/docs/en/remote-control`) state the
  eligibility check fails when `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or
  `CLAUDE_CODE_USE_FOUNDRY` is set — *"Remote Control requires claude.ai authentication and does not work
  with third-party providers."* The CLI bundle carries the gating (provider-env branches + a "Remote
  Control auth state" check).
- **Empirical.** `claude --remote-control` with `CLAUDE_CODE_USE_BEDROCK=1`, behind the trace MITM:
  **zero** `POST /v1/code/sessions`, **no** `/v1/code/*` traffic at all, and the TUI shows **no
  `/rc active`** indicator (vs an Anthropic-API session, which does). The flag is a **silent no-op** —
  accepted, but RC never activates.

**Why.** RC's control plane is **claude.ai-account-scoped** (a full-scope OAuth token) and lives only on
Anthropic's first-party infra (`/v1/code/*` on `api.anthropic.com`). Inference routing
(Bedrock/Vertex/Foundry) is a *separate* axis, and those providers have **no first-party session
service** to register/poll against — there is nowhere for RC to bridge.

**Implication for remote-claw.** Anthropic-hosted RC cannot function with Bedrock/Vertex/Foundry.
Current own-relay `--rc-app` is a distinct path: its local MITM supplies the RC backend, and
`--rc-inference=bedrock` synthesizes the first-party control plane while routing inference to Bedrock
(`packages/cli/src/host/rc/launch.ts:176-207`). That mode works without Anthropic RC, including
accountless operation, but the official Claude app cannot attach because no real Anthropic session
exists. In the parked host-runtime design, official Claude participation would therefore require the
separate outward Anthropic connector; the provider-isolated inner runtime can still use another
inference backend.

---

## 4. Synthesis — the roadmap question

The three findings converge on one decision:

- Anthropic-hosted native RC gives **full TUI fidelity** and **multi-client shared control across turns
  without killing the TUI** (simultaneous busy-turn collisions remain unproven; Happier matches the
  persistent-TUI part only in its opt-in `unified terminal` tmux mode, via fragile `send-keys` injection —
  §1; its default `local` mode kills-and-forks)—but is **Anthropic-API-only** and depends on Anthropic's
  hosted control plane. Remote-claw's current local RC backend preserves the TUI without that hosted
  control plane, at the cost of official-app compatibility.
- A Bedrock/Vertex/Foundry-compatible remote experience **cannot ride Anthropic-hosted RC**. Bedrock
  users can use remote-claw's synthetic own-relay Bedrock mode. Provider-agnostic alternatives for
  Vertex/Foundry are the other §1 mechanisms: the **SDK-headless** path (but it loses TUI fidelity like
  Happy/Happier's default), the **tmux-inject** path (keeps the real TUI + shared editor access, but has
  fragile writes, possible local/remote draft merging, and a JSONL-reconstructed phone view—the bet
  Happier is actively making), or **PTY-streaming
  the real `claude` TUI** to the phone (tmux + xterm—pixel-literal, the one path nobody currently ships
  for `claude`).
- The **durable-log model** (§2) is orthogonal to fidelity but central to durability/scale, and is
  validated by Anthropic's own backend (§3's persisted `sequence_num` log).

**Candidate directions, in rough priority:**

1. **Keep native RC as the high-fidelity, Anthropic-API path** for official-app compatibility, while
   keeping own-relay Bedrock mode as the zero-Anthropic alternative; document the boundary plainly.
2. **Spike a PTY-stream transport** (`claude` in tmux → xterm to the viewer) as the *provider-agnostic,
   pixel-literal* option — the only way to serve Bedrock users without losing the TUI. Happier is already
   building the *inject* half (phone prompt → tmux `send-keys` into the real `claude` pane, §1); the
   unshipped half is **streaming that pane's pixels to the phone** (Happier reconstructs from JSONL
   instead) plus a **non-fragile control channel** (vs send-keys). That delta is the genuine
   differentiator — Happy/Happier stream a *shell* to the phone, never `claude` itself.
3. **Spike the durable-log `BrokerBackend` adapter** (§2) to retire the seq/restart/reconnect machinery,
   gated on the explicit retention/recovery trade.
4. **Add outbound viewer-gating** (the missing broker-efficiency mechanism — see `v2-architecture.md`
   §6D worked example). Today the host posts the transcript **unconditionally**: `#pumpUpstream` emits
   every frame whether or not anyone is watching, because the broker API gives the host **no
   authenticated viewer-presence back-channel**. Consequence: an idle fleet (many sessions, no viewers)
   pays full relay price and each Vercel channel grinds toward its event cap, where the current system
   has an unsupported cliff—there is **no automatic roll**. The fix is a **sealed presence beat** (a
   viewer→host "watching" signal on the bus) so the host can gate outbound on ≥1 viewer, dropping an idle
   session to the ~20 s announce keepalive floor. It must preserve zero-knowledge: the beat remains
   sealed rather than becoming a plaintext broker presence record, although a durable broker may retain
   it as opaque frame data. It must also stay advisory (a missed beat must fail safe — keep relaying,
   never silently drop). Orthogonal to the transport choice; the **Turso** backend sidesteps the *cost*
   of the gap (no per-run cap, no rolling) but not the gap itself (it still accrues at-rest ciphertext
   until retention reclaims the channel).

The original candidates above are retained as design history. They do not determine what ships. The
active scope and executable stop condition are in the
[Claude 1.0 finish line](release-finish-line.md); the
[client-driven host runtime](client-driven-host-runtime.md) is an optional parked expansion.
