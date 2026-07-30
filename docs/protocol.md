# Protocol & Runtime (grounded)

This document describes the **as-built** remote-claw protocol — the wire format, the channels, and the
runtime discipline that lets a person use a host-side native TUI while one or more browser viewers
watch and drive the same native session through a zero-knowledge broker. Every claim cites the source
that implements it (path + symbol), so it stays honest as the code changes. Where a behaviour is a
deliberate boundary rather than a guarantee, it is called out in
[§12 Convergence & failure modes](#12-convergence-failure-modes).

Companion docs: [v2 Architecture](v2-architecture.md) for the design rationale (§-numbers below refer to
its sections), [Phase 0 Findings](phase0-findings.md) for the reverse-engineered RC worker protocol, and
[Client-driven Host Runtime](client-driven-host-runtime.md) for the selected native-harness ← one
remote-claw collaborator ← many server collaborators architecture. A0.1 of that migration is now present: Claude MITM
sessions register through the neutral, host-scoped lifecycle before their existing `Session` port is
bridged to the broker. OpenCode and tmux still use the flat compatibility path directly.

**Identity scope.** In this as-built protocol, `Session.id` is a synthetic `cse_*` identifier used as
the broker channel address and session-list key. It is not a Claude transcript ID, Codex thread ID,
OpenCode `ses_*`, tmux pane identity, or durable remote-claw logical-chat ID. The A0 `rcb_*`
registration lease is also process-local. A1 targets a separately persisted
`(collaborationServerId, logicalChatId)` scope; that pair is the canonical chat within one machine.
The machine-facing viewer row, route, alias, wire channel, and cache keys use the full
`(identity_id, collaborationServerId, logicalChatId)` triple. A private synthetic `cse_*` may then
rotate beneath it during a proven native transport/runtime replacement. That mapping and recovery
behavior are not implemented here.

---

## 1. Topology

Three parties, one of which (the broker) is untrusted and sees only ciphertext.

- **Host / wrapper** — `runRcLaunch` (`packages/cli/src/host/rc/launch.ts`) runs the real `claude`
  with its native TUI behind a MITM proxy (`MitmProxy`, `mitm.ts`) pointed at by `HTTPS_PROXY`. The
  instant a session hits `/remote-control`, its worker traffic lands on `RelayCore`/`Session`
  (`session.ts`) instead of Anthropic. One host-scoped `LegacyRcConversationRegistrar` allocates a
  distinct process-local lease per intercepted session. Once setup publishes validated capabilities
  and marks that lease `ready`, one `HostRcRelay` (`relay.ts`) bridges the session to the broker.
- **Broker** — the pluggable backend (Vercel Workflows, per-session SQLite/libSQL, or local)
  behind `POST /api/relay` and `GET /api/stream`. It is a dumb, append-only, **at-least-once, non-FIFO**
  pipe (§12). It never holds a key; it routes by a cleartext header and stores ciphertext.
- **Viewer** — the browser client (`apps/web/app/lib/viewer.ts` + `page.tsx`). It reuses the host's
  `BrokerClient` and `SecurityProvider`, plus the shared `FrameOrderer`, so the wire and security
  primitives do not have separate implementations that can drift (`viewer.ts` header comment).

**Driver modes share one relay.** The diagram above is the MITM (`--rc-app`) path, but it is not the
only driver. Every current harness produces a `Session`. Claude MITM registers that port through
`LegacyRcConversationRegistrar`, which calls `startBridgeSession` only at `ready`; OpenCode and tmux
still call the `bridgeSession` served-promise compatibility entrypoint directly. Both entrypoints
construct the same `HostRcRelay` and start the same announce/serve path. **The broker, the relay
(`HostRcRelay`), and the viewer are shared across drivers.** Frames, the two pumps,
`seq`/ordering, `catch_up`, and presence therefore use one compatibility path, while the native
capability behind a frame can differ. Permission and attachment support are only as strong as the
selected harness; current OpenCode/tmux announcements can overstate post-setup support (see
[Pluggable Harness](pluggable-harness.md) §8). Only how the `Session` reaches the native harness
differs:

| Driver | Native surface used by the local person | Inject (downstream → native client) | Capture (native client → upstream) | Permissions | Provider |
|---|---|---|---|---|---|
| **MITM** (`--rc-app`, `launch.ts`) | Real Claude Code TUI in the wrapped process; local prompt text is not currently projected to viewers | Intercept Claude's RC endpoints → worker downstream | Worker upstream POSTs (`followUpstream`) | Structured `can_use_tool` gates (§10) | Default: Anthropic API; `--rc-inference=bedrock`: Bedrock inference + locally synthesized control plane |
| **tmux** (`--rc-driver=tmux`, `tmux/driver.ts`) | Real Claude Code TUI in the attachable pane; unmatched local prompts are projected post-hoc as `local_prompt` | `set-buffer`/`paste-buffer` + `send-keys` into the pane (`runInjectPump`) | Tail the local transcript `.jsonl` → `pushUpstream` (`TranscriptTailer`) | **Default attempt:** structured `can_use_tool` gates via an injected **PreToolUse hook** (§10); an unparseable user settings file disables the hook after the current optimistic announcement. **Opt-out** `--rc-tmux-skip-permissions` → `--dangerously-skip-permissions` auto-approve | Any, including Bedrock/Vertex |
| **opencode** (`--rc-driver=opencode`, `opencode/driver.ts`) | A native OpenCode TUI may share the server; the driver does not enforce one attachment, and unmatched local prompts are projected post-hoc as `local_prompt` | POST the prompt to the OpenCode session → `followDownstream` (+`ack`) | OpenCode **SSE** event stream → `pushUpstream` | **Default attempt:** PATCH an ask-all rule and mirror SSE `permission.asked` (§10); setup is best-effort and currently may fail after `structuredPermissions:true` was announced. **Opt-out** `--rc-oc-skip-permissions` leaves OpenCode's own permission config | Any OpenCode provider configuration |

**Selected migration contract, not current `Session` behavior.** Every remote proposal—from the web, an official client, automation, or a nested server—must enter one common ordering and decision path before any Claude, Codex, or OpenCode adapter can act. That path stores and signs one final admitted, queued, or rejected result. Only a signed admission may create one pinned executor attempt; a queued or rejected result creates none. A new message and a steer of a running turn are distinct commands, and neither timing nor native busy state may convert one into the other. The person's direct native-TUI input remains separate from this remote decision path. The native harness observes both paths and remains the authority for their final order and for what actually changed.

Each native adapter must then prove the exact last mile it uses. It translates the admitted common command into one version-pinned native request, sends it through the current fenced front door, and correlates native read-back before reporting the command as applied. A changed translation, unproved route, stale owner, missing observation, or ambiguous response fails closed; a transport ACK alone is never native acceptance. The current `Session` relay does not provide these guarantees.

Nested remote-claw uses the same rule at every server. Before a nested send, the source server jointly finalizes its signed common result and signed lineage; neither half may become visible alone. It accepts semantic completion only from a complete downstream receipt that ties the exact source event, command, chosen target, and target server's signed result together. Edges are installed outward from an already rooted path, commands and observations have opposite directions, and an observation is never turned back into a command. Recursion therefore adds collaborators and server boundaries without feedback loops; the only native app is at the innermost end.

The selected OpenCode runtime replaces that unconstrained current attachment with one epoch-fenced
adapter lease enforced by the private HTTP endpoint; SSE plus independent HTTP calls expose no
persistent writer identity, so connection counting cannot provide the fence. It actively drains SSE
before snapshot, fails closed on discovery, never adopts “most recent,” and reattaches/imports only an
exact selected session. Automatic creation requires explicit first-bootstrap intent, no existing
binding, and a positive empty snapshot; explicit **New chat** is a separate operation that may create
while sessions exist. Both creation paths use a write-ahead metadata marker. A `prompt_async` 204 or
control response is transport evidence only.
OpenCode history/events/status and terminal gate state decide native acceptance and order, including
TUI-versus-remote races. They do not prove which client caused an abort or compaction unless the pinned
surface supplies a durable causal link; otherwise source remains unknown. Lease replacement also waits
for or quarantines requests admitted under the old epoch before the new adapter becomes writable.
Outside disconnect never aborts the shared native run. The retained
[OpenCode native proof](opencode-native-proof.md) covers only the exact creation marker and
`noReply:true` caller-message-ID behavior, not those shared-runtime guarantees; the selected candidate
request does not inherit `noReply:true`. The only first-A2 families eligible after their release proof
passes are exactly server-scoped `{new_chat}` and binding-scoped `{user_text}`. OpenCode uses the
common signed decision,
then deterministically builds the one allowed native request with no fields, queries, headers, or
message parts beyond the pinned shape. It sends only through the current front door and confirms the
matching message, content, and order from a complete, linearized history snapshot plus the matching
live event only when that snapshot method requires one.
Compact, interrupt, steer, blank submit, permission/question answers, attachments, clear/fork, and
every other unproved family receive a stored ordered rejection before projection or native work.
Stock OpenCode `1.17.5` is not yet a writable A2 tuple because the retained proof does not establish
the real-TUI exact-process front door, complete callable front-door manifest, spawned-tool/raw-listener
fence, or lossless observer snapshot linearization.

Codex has no as-built driver. The selected host-runtime design adds one real Codex TUI client and one
remote-claw collaborator connection on the same private app-server/thread. Any client-facing proxy
must behave like a direct app-server connection; that remains target behavior, not a protocol claim
here. The target Codex endpoint accepts the native TUI's documented `--remote` connection and preserves
the pinned app-server initialization, requests, responses, notifications, server requests,
backpressure, and reconnect behavior. The current Claude-shaped `Session` relay is not on that TUI leg
and cannot stand in for app-server compatibility. There is no alternate synthetic Codex-server path:
if the pinned real app-server cannot keep the TUI and bridge coherent, shared writable Codex mode is
unsupported for that version.

Pinned `codex-cli 0.146.0` source and
[runtime evidence](codex-app-server-multiclient-proof.md) establish the basic one-daemon seam. Source
shows that the TUI is an app-server client and normal official Remote streams enter the same daemon as
ordinary connection IDs; the checked runtime probe shows two independently initialized raw clients
mutating one materialized thread through that daemon. A second checked fixture attaches one real
`codex resume <same-id> --remote <transparent-recorder> --no-alt-screen` TUI and one raw client to the
same app-server/thread and proves deeply equal selected five-event model-free shell-command projections
in both directions, with both markers rendered in the TUI. This closes the retained real-TUI fixture
gate only for that narrow path. A third checked fixture uses three raw connections and two distinct
top-level threads: each requester remains the only subscriber until one host observer explicitly
resumes both exact IDs, after which the host and owning client receive equal selected projections while
the non-owner remains `notSubscribed`. All three fixtures use experimental loopback WebSocket.
Production Unix front-door parity, the complete method/model/server-request surface, races and
recovery, real-TUI multi-chat, core child-thread routing, schema retention, and all outward
official-client work remain open.

The pinned source also shows behavior that the one-thread fixtures cannot exercise: ordinary
top-level `thread/start` subscribes its requester, while a separate core child-agent notification path
best-effort attaches every initialized connection. The selected target must preserve and
differentially prove the native subscription, broadcast, and TUI-routing rules for trusted direct TUI
connections plus exactly one daemon-wide bridge. The retained three-connection fixture closes the
ordinary top-level shell-command case only; child threads, real-TUI multiplicity, server requests, and
the full method surface remain gated. The target must not invent selected-thread isolation.

The selected target does not enable official streams directly because that would bypass the future
coordinator and give the inner daemon an OpenAI socket. It needs a protocol-aware outward gateway plus
an app-server-runtime-level injected Remote-control service shared by the sole native
`MessageProcessor` management path and the surrounding startup/status loop. That service covers
management only. Official streams terminate in the gateway and never become native connections,
subscribers, or writers. The gateway retains their complete state, including provider
enrollment/envelopes, sequence, chunks and ACKs, initialization, capabilities, request-ID domains,
notification preferences, per-stream subscriptions, server-request correlation, backpressure,
reconnect state, and lifecycle. Stream-local initialize, resume, unsubscribe, close, and reconnect
update gateway state; a reconciler maps the union of current host/collaborator demand to zero or one
fenced subscription transition on exactly one authenticated daemon-wide native bridge. Admitted
semantic native mutations map to one request on that bridge, which has logical bindings for managed top-level chat threads. A child-thread
notification remains nested evidence under its parent until a retained lineage fixture proves another
outward mapping. The gateway must also map source-owned handles and cleanup. Where pinned behavior
depends on the source client's profile or resource lifetime, an admitted bridge request may carry only
the smallest non-authoritative compatibility or source-lease context proved necessary. remote-claw
does not start a second app-server or thread store. None of this is implemented by the current relay.

Because the relay owns the attachment write+inject, attachments work across the two Claude paths
unchanged—the tmux driver never even sees an `attachment` frame
(`TMUX_CAPABILITIES.attachments = true`); the relay writes the file and injects the `@"path"` reference,
which the pane's Claude attaches natively just as the MITM-driven worker does. OpenCode currently
receives that Claude-specific text, not a native file part; its attachment support is unproven despite
the current optimistic capability bit.

```
 person
   ⇅
 claude --remote-control (native TUI)
        │  (HTTPS_PROXY → CONNECT → leaf cert)
        ▼
   MitmProxy ── serves /v1/code/sessions* ──► RelayCore / Session
        │                                          ▲   │
   default anthropic: non-RC API passes through     │   │ downstream (SSE): user input, control_*
   bedrock: translate inference; synthesize control │   ▼
                                   host registrar (one lease/session)
                                                   │ ready
                                                   ▼
                                        HostRcRelay (2 pumps)
                                          │  seal + POST /api/relay      ▲ GET /api/stream (SSE)
                                          ▼                              │
                                   ┌─────────── BROKER (ciphertext only) ───────────┐
                                   │  identity BUS channel   │   per-session channel │
                                   └───────────────────────────────────────────────┘
                                          ▲                              │
                                          │ announces()                  ▼ transcript()
                                              Viewer (phone / laptop)
```

---

## 2. Frames and planes

The unit on the wire is a **frame**: a `FrameHeader` (cleartext routing) plus an AEAD-sealed body. The
header fields the runtime relies on are `recordKind`, `sessionId`, `dir` (`"in"` client→host / `"out"`
host→client), `seq` (the relayed viewer-projection order, or `null`), `msgId` (dedup key), and
`part`/`parts` (chunking).

Each `recordKind` is sealed under exactly one **plane** (AEAD key), decided by `planeForKind`
(`packages/cli/src/broker/protocol.ts`):

- **content** (`K_session`, carries `seq`) — the viewer transcript projection: `user`, `assistant`, `assistant_sub`,
  `assistant_thinking[_sub]`, `result`, `tool_use`, `tool_result`, `task`, `permission_request`,
  plus `system`/`status`/`rate_limit`/`can_use_tool` (`CONTENT_KINDS`).
- **control** (`control_key`, `dir:"in"`) — client→host kinds: `catch_up`, `permission`, `interrupt`,
  `set_mode`, `set_model`, `end`, `attachment`, and the reserved but currently unused `command`
  (`CONTROL_KINDS`; slash commands use `user` content).
- **meta** (`K_meta`, `seq:null`, unordered) — `accepted` (acks), `session_announce` (presence), and
  replayable `permission_resolved` state (`META_KINDS`). Accepted/announce are not put in the host
  replay log; `permission_resolved` deliberately is.

`planeForKind` **throws** on an unknown kind rather than guessing (`protocol.ts`) — a wrong mapping would
fail the AEAD open loudly, never silently mis-decrypt. The body is sealed/opened by the
`SecurityProvider`; the broker can neither read nor forge it.

A **large** message is split into `≤ DEFAULT_MAX_CHUNK_BYTES` (3 MB) pieces by `postMessage`
(`broker/client.ts`); each piece is an independent AEAD frame sharing the message's `msgId` with its
`(part, parts)` bound into the AAD. `openMessage` reassembles them, rejecting a missing, duplicate,
out-of-range, or cross-message part before it can corrupt the buffer (`openMessage`, `client.ts`).

---

## 3. Channels and transport

Two channel kinds, both append-only logs on the broker:

- The **identity bus** — one per identity, carries `session_announce` only. `#publish` routes a
  `session_announce` to the bus (no `?session=`) and everything else to its session channel
  (`broker/client.ts` `#publish`, keyed on `recordKind === "session_announce"`).
- The **per-session channel** — `?session=<sessionId>`, carries the transcript (out) and client frames
  (in).

`streamFrames` subscribes via SSE and yields each decoded frame (`client.ts`). `startIndex` is a
**broker frame index**, not a transcript `seq`: a negative value reads the recent window (the bus uses
`-64`, `viewer.ts announces()`); the session tail uses `0` and relies on the orderer, not the index, for
correctness (`viewer.ts transcript()` comment). An `event: error` SSE record throws a terminal
`BrokerError` rather than stopping silently (`sseData`, `client.ts`).

The broker is **at-least-once and not FIFO** (`order.ts` header). Everything below is built to make that
substrate deliver a consistent transcript anyway.

---

## 4. The relayed transcript timeline (`seq`)

`seq` is the total order of the relayed viewer projection, not a complete order of everything the
native TUI executes. It is allocated by **exactly one object**: `HostRcRelay` owns the single `#seq`
counter and advances it at its outbound-item, inbound-user, and inbound-attachment emission paths
(`relay.ts`). Browser clients never assign order (§6). Both relay pumps (§6) share that single counter;
because JS is single-threaded, `this.#seq++` is atomic between them, so every emitted content frame —
whether an outbound assistant line or the inbound echo of a remote prompt — gets a unique, monotone
`seq`. A burned pre-publish sequence can still leave the dead durable projection gapped (§12).

Current local-TUI ingress does not share a durable native-applied order with remote ingress. Tmux and
OpenCode mark an unmatched native user message `local_prompt:true` and project it only after the native
client has received it. The MITM path receives ordinary native user events without that driver marker;
`mapUpstreamItems` intentionally drops ordinary user echoes, so a prompt typed in the Claude TUI can
execute while its user text is absent from the viewer projection.

A `seq` is allocated **before** the POST so the frame's `msgId` is deterministic (`${kind}-${seq}`) and a
retry re-posts the *same* frame, which the viewer dedups (`relay.ts` `#post` / `POST_RETRIES`). The cost
of allocating before the durable write is analysed in [§12](#12-convergence-failure-modes).

---

## 5. Delivery discipline: viewer `FrameOrderer`, host command dedup

Every viewer transcript subscriber runs frames through a `FrameOrderer`
(`packages/cli/src/broker/order.ts`) before rendering them. It turns the at-least-once, non-FIFO stream
into an exactly-once, in-order transcript projection:

- **Dedup** by `msgId` (or `msgId:part` for a chunk) in a bounded FIFO window (`DEFAULT_SEEN_CAP = 8192`,
  `#markSeen`). A duplicate returns nothing.
- **Unordered planes pass through** — a `seq === null` frame (control/meta) delivers as soon as it is
  deduped (`accept`).
- **Content reorders by `seq`** — a frame with `seq < #nextSeq` was already delivered and is dropped; a
  higher `seq` is **buffered** until the gap fills, then consecutive complete slots drain in order
  (`accept` drain loop). A gap holds delivery (live retry or a `catch_up` replay fills it).
- **A chunked message is one slot** — all its parts share the `seq`; the slot releases only when all
  `parts` have arrived, sorted by `part` (`accept`). A part replayed after its `msgId:part` key evicted
  the window is rejected by the per-slot `slot.some(f => f.part === frame.part)` guard, so an evicted
  replay can't fake completeness (`order.ts` comment).

Why content survives a bounded dedup window even though meta does not need to: for content, the monotone
`#nextSeq` cursor is the real dedup (anything `< nextSeq` is dropped regardless of the window); the
bounded window only de-dups the `seq === null` meta frames, which are idempotent to re-render as nothing
(`order.ts` header). This is the crux of why reconnect-from-index-0 is safe (§8).

The host's inbound pump does **not** use `FrameOrderer`: it consumes the broker stream directly and
deduplicates client commands by `msgId` in its per-session `#seen` set before acting. That set is
unbounded for the relay lifetime so a non-durable re-read from index 0 cannot re-inject an evicted
command; chunked attachments are acted on only after complete reassembly and then mark the same
message ID seen (`relay.ts` `#tailInbound`).

---

## 6. The two relay pumps

`HostRcRelay.serve()` runs two pumps concurrently for the session's life (`relay.ts`):

- **OUTBOUND** `#pumpUpstream` — tails the worker's upstream via `Session.followUpstream`, maps each
  event to zero or more content frames (`mapUpstreamItems`), allocates a `seq`, **logs** it (for
  `catch_up`), seals, and POSTs (`#emit` = `#post` + `#log.push`).
- **INBOUND** `#pumpInbound` — tails the session channel for `dir:"in"` client frames, dedups by `msgId`
  in `#seen`, and drives the worker: a `user` prompt is `accepted`-acked, echoed as a `user` content
  frame, and injected (`Session.pushUserInput`); a `catch_up` replays the log; a `permission` answers a
  gate; a control verb (`interrupt`/`set_model`/`set_mode`/`end`) is forwarded.

The person at the native TUI is a third as-built input path outside these two relay pumps. In MITM
mode Claude consumes that input itself; in tmux and OpenCode mode the native client/server consumes it
and the driver may recognize the resulting user record later as `local_prompt`. The selected design
keeps that direct path and makes remote-claw one native collaborator for the structured Claude,
Codex, and OpenCode adapters, with the native harness as final arbiter. Tmux is the exception: person
and injector share one editor keystream, so it cannot claim peer-collaborator semantics without a
proved exclusive input boundary. Current code lacks the durable source correlation and native-order
journal needed to model either relationship safely across restart.

`#seen` (inbound dedup) is intentionally **unbounded** for one relay incarnation. A non-durable
`#tailInbound` re-reads from frame index 0; a durable relay re-reads from its sampled incarnation
floor. In either case, evicting an already handled `user` `msgId` could re-inject a duplicate prompt
after reconnect. It grows only with distinct human-paced client frames and is freed when the session
ends.

The outbound `#post` retries a transient 409 (the channel disposed or was replaced mid-publish) with
bounded exponential backoff, because the `seq` is already allocated and a dropped post would strand
every viewer on a permanent gap (`relay.ts` `#post` / `POST_RETRIES = 6`). The Vercel backend emits
that 409 only when Workflow 4.4.0 classifies the resume race as `HookNotFoundError`. Payload
serialization, event-store, queue, and other `resumeHook` failures remain 500-class failures and the
host does not retry them.

---

## 7. The Session bus (worker side)

`Session` (`session.ts`) owns the synthetic in-memory RC state and event bus between the worker-facing
adapter and the relay, a faithful async port of Phase 0's `core.py`. For OpenCode and tmux it is a
compatibility projection, not authority for the native engine's conversation or execution:

- **downstream** (`#downstream`) — events the relay pushes to the worker over SSE: `user` input, the
  always-first `initialize` control_request (`pushInitialize`, idempotent), control verbs, and permission
  `control_response`s.
- **upstream** (`#upstream`) — events the worker POSTs back (assistant/result/system…), fanned out to
  every viewer via `followUpstream`.

A `Gate` (a re-arming promise) is the async stand-in for `threading.Condition.notify_all()`: producers
call `#gate.wake()`; followers `await #gate.wait(HEARTBEAT_MS)` and re-check their stop predicate
(`session.ts`). `followUpstream` yields `null` every `HEARTBEAT_MS = 10_000` as an idle tick — which the
relay uses to drive the presence keepalive (§9).

A reconnecting worker stream is handled by a **generation token**: `claimWorkerStream` bumps `#workerGen`,
and `followDownstream` exits the moment `gen !== this.#workerGen`, so only the newest follower remains
active (`session.ts` header + `followDownstream`). This fences concurrent followers; it does **not**
prove at-most-once delivery across reconnect. Each follower has a fresh in-memory `sent` set, while
`#acked` suppresses only event IDs the worker already confirmed. If a worker acted but its ACK was
lost, a reconnect can redeliver; the future coordinator treats that boundary as uncertain unless
worker idempotency is separately proven.

For Claude MITM, `/worker/events/delivery` currently advances only this replay bookkeeping. It is a
structured worker receipt, not proof that Claude applied, ordered, or durably recorded the command.
The target keeps worker delivery, native acceptance, transcript observation, and terminal outcome
separate and requires a pinned RC/transcript/provider correlation before upgrading the state.

`worker_status` is updated by the MITM's `PUT …/worker`, which only mutates and `wake()`s the session
**on an actual change** (`mitm.ts`), so a phase flip propagates promptly to the presence pump without a
busy-loop of identical announces.

---

## 8. catch_up / replay and reconnect

A late or reloaded viewer posts a `catch_up` control frame with `{ since }`. On a non-durable broker,
`#pumpInbound` calls `#replay(since)`, which re-POSTs every host-memory content frame with
`e.seq >= since`. Replay reuses each frame's original `seq` + `msgId`, so the viewer's orderer dedups
the overlap and reorders the union by `seq`. On a durable broker, the host leaves `#log` empty and
ignores `catch_up`; the broker's own subscription from index 0 supplies persisted history. Both paths
are covered in `relay.test.ts`; the non-durable end-to-end path is also covered by the CATCH_UP cases in
`full-spine.integration.test.ts` and `rc-spine.integration.test.ts`.

Reconnect cursors depend on the effective backend. A non-durable host `#tailInbound` re-subscribes from
frame index 0 and relies on `#seen`. A durable host first samples `frameCount`, uses that as the
incarnation's inbound floor, and re-reads only from that floor so an empty post-restart `#seen` cannot
re-execute earlier inbound actions. The viewer maintains its own stream/orderer recovery logic
(`viewer.ts`; `relay.ts`). The sampled durable floor prevents duplicate old execution, but it is not a
command inbox: a command published before the sample and not executed before a crash can be skipped.
See [§12](#12-convergence-failure-modes).

---

## 9. Presence: `session_announce`

Presence rides the meta-plane `session_announce` on the identity bus — idempotent, `seq:null`, never
logged, so re-announcing is cheap (`relay.ts` `#sendAnnounce`). The host folds live state onto **every**
(re-)announce:

- `title`, `cwd`, and `git` metadata (branch / dirty / ahead-behind, `gitinfo.ts`, #49).
  `startBridgeSession` exposes a whole-snapshot refresh used by the registrar after setup; the current
  Claude launch supplies the same launch-time values at `ready`, and no current driver refreshes git
  after a branch change. A failed advisory refresh reports the delivery failure but retains the latest
  validated local snapshot, which a later presence update re-announces.
- `status` (raw `worker_status`), `phase` (`phaseFor`: `running`/`busy` → `thinking`, else `idle`, #48),
  and `needs` (`status === "requires_action" || #openPerms.size > 0`, `#presence`).
- `mode` — the worker's effective permission mode, present whenever it's known
  (`session.permissionMode !== null`: seeded from session config, or updated by an upstream `system/init`). A **viewer-requested**
  `set_mode`, though, is reflected as a confirmed mode **only when the driver can honor it**
  (`capabilities.controls.setMode`); for a driver that can't (tmux/opencode) the relay still forwards the
  `set_permission_mode` verb but does **not** write/announce the mode — announcing one would be a "✓" the
  worker never entered (#149). In practice tmux/opencode carry no upstream mode either, so their announce
  omits `mode` entirely.
- `capabilities` — the driver's `DriverCapabilities` (`structuredPermissions`, `status`, `attachments`,
  and per-verb `controls.{interrupt,setModel,setMode,end}`). The viewer **disables + labels** the
  controls a driver can't service and shows a "permissions off" posture when `structuredPermissions`
  is false — so a permission-mode / model control never silently no-ops (#149). Absent on a legacy host
  → the viewer assumes full capability (a pre-capability host is always the MITM driver).
- `harness` — the driver's `HarnessDescriptor`
  (`{ agent: "claude-code" | "opencode"; mode: "rc" | "tmux" | "opencode" }`). The viewer labels each session-list row from it — **Claude Code · RC** /
  **Claude Code · TX** / **opencode** — so the three harnesses don't look identical (#164). Absent on a
  legacy host → treated as the MITM harness (native-RC Claude Code, the only pre-#164 driver).
- `incarnation` and `incarnation_started_at` — the opaque relay-process identity and its wall-clock
  start. A later start orders the normal restart case and fences delayed publishes from the retired
  process. This is **not** a durable coordinator epoch: a clock-regressed start fails stable, while
  equal starts use the opaque `incarnation` id as a deterministic total-order tie-break. That prevents
  state flips but does not prove which same-millisecond process actually started later; A1 must persist
  an epoch to remove that ambiguity.
- `announce_seq` — a strict per-relay generation allocated before the publish await. It orders
  same-incarnation announces even when two share one wall-clock millisecond or their HTTP requests
  reach the broker in reverse order.
- `sent_at` — the wall-clock freshness value the viewer reads for liveness. It remains the ordering
  fallback for legacy hosts that omit the fields above.

Cadence (`relay.ts` `#maybeAnnounce`): re-announce **immediately** when the presence key
(`status|needs|mode`) changes, else at the `ANNOUNCE_KEEPALIVE_MS = 20_000` idle floor (driven by
`followUpstream`'s null tick). The same `#annCount++` value supplies `announce_seq` and a unique
`msgId`, so no two same-incarnation announces reuse either.

The viewer derives a connection state from announce freshness (`viewer.ts` `connState`): **connected**
while `age < CONNECTED_WINDOW_MS` (45 s). Once stale it shows **reconnecting** for a full
`RECONNECTING_WINDOW_MS` (30 s) before **disconnected** — the ladder always passes through reconnecting,
never connected→disconnected. The disconnect countdown is anchored per session at `reconnectingSince`
(`nextReconnectAnchor`, `page.tsx` Console): set **once** when the announce first reads stale, held until
connected again, and **not** re-reset while it stays stale. After a backgrounded tab returns — iOS Safari
suspends the bus SSE while hidden, so the announce goes stale only because we were away — that anchor is
the **return instant**, and the page bumps `announceRevive` to re-subscribe the bus; the returning tab
therefore shows *reconnecting* for a full window while the re-subscribe pulls a fresh announce, never an
instant *disconnected* (#123). Because the anchor is not re-reset by focus, a genuinely-dead host still
reaches *disconnected* and stays there even on a phone, where unlocking/app-switching back is the normal
sub-`window` interaction. `FRESH_WINDOW_MS` (60 s) is the **separate** control-verb / `catch_up` replay
bound (§11), **not** the disconnect threshold — decoupled so widening disconnect can't widen replay. The
viewer and console use the same `shouldAcceptAnnounce` fold. Within a current incarnation, greater
`announce_seq` wins. Across current incarnations, greater `incarnation_started_at` wins, so a delayed
old-process request cannot flip presence back or falsely reset the transcript. Clock-regressed starts
cannot be ordered without a durable epoch and are rejected. Equal starts use lexical opaque-incarnation
order: stable against late frames, but not evidence of the chronological winner. Legacy frames preserve
the previous `sent_at` behavior (including equal-timestamp replacement when both sides are legacy).
Filtering occurs inside `Viewer.announces` **before** incarnation listeners run, then the React map
applies the same pure comparator as a second idempotent fold.

---

## 10. Permission gate lifecycle

A worker `can_use_tool` control_request is surfaced as a `permission_request` content frame
(`mapUpstreamItems`). The gate is tracked so it converges across the request→answer round trip:

1. `#pumpUpstream` adds the `request_id` to `#openPerms` **before** the publish await, with rollback if
   the publish throws (`relay.ts`, codex HIGH #1). Adding first means a *fast* viewer grant — which can
   run `#pumpInbound`'s delete during `#emit`'s await — always finds the id to clear; otherwise `needs`
   would stick true forever.
2. The viewer answers with a `permission` control frame (`viewer.grantPermission`).
3. `#pumpInbound` acts **only if** `#openPerms.delete(request_id) === true` (`relay.ts`, codex HIGH #2):
   a duplicate/stale/unknown answer (two devices both granting; a re-read after reconnect) is a no-op —
   no second `pushControlResponse`, no duplicate `permission_resolved`. On the real delete it answers the
   worker, logs an unordered `permission_resolved` meta frame (so a reload/`catch_up` renders the request as
   answered, not re-prompting, #56/#57), and re-announces so `needs` clears.

The viewer's `PermissionRow` renders `effective = confirmed ?? decision`: the host-logged resolution
(`confirmed`, folded from the transcript's `permission_resolved` frames) **wins** over the local optimistic
`decision`, so a granted permission survives a reload (`page.tsx`).

Here `permission_resolved` confirms only that this relay selected and queued a response. It is not a
native Claude terminal result: the TUI may have answered first, Claude may cancel the request, or tool
execution may settle it differently. Current interrupt/end paths can also clear relay gates before
native terminal evidence. The selected runtime persists remote choice, worker delivery, and native
cancel/tool/gate outcome separately, and closes every outward copy from the proved native terminal
record rather than treating local deletion as adjudication.

---

## 10a. Attachment lifecycle (#44)

One composer send can carry several images in remote-claw's own `attachment` message, never the worker
protocol. The full round trip (`viewer.sendAttachment` → relay `#handleAttachmentPayload`) is:

1. **Viewer** seals `{images:[{name,mime,data}], caption}` (`dir:"in"`, plane = `control_key`). The
   broker never sees plaintext. `BrokerClient.postMessage` splits a large sealed message into
   Vercel-safe chunks; the whole plaintext payload is capped at
   `MAX_ATTACHMENT_TOTAL_BYTES` (48 MiB), and each image is downscaled/re-encoded before send.
2. **Host** buffers only attachment chunks, with bounded part/group counts, and acts only after the
   whole AEAD-verified message reassembles. Each malformed, empty, or over-`MAX_ATTACHMENT_B64`
   (16 MiB base64 text) image is skipped; if none remain, no `seq` or side effect occurs.
3. It writes valid images to `~/.claude/uploads/<sessionId>/<unique>.<ext>` with a sanitized,
   mime-matched name. This is the same tree the real Anthropic app uses, so Claude can read it without
   the permission prompt an arbitrary temp path caused.
4. It publishes one grouped `user` echo (`📎 a.jpg, 📎 b.jpg\n<caption>`) and only then injects one
   Claude prompt (`@"<path-a>" @"<path-b>" <caption-or-default>`). A failed echo is fatal, so a relay
   never deliberately drives Claude to read files whose projection was not published.

**Optimistic local echo (#113, shipped).** A send renders an **instant pending bubble**
(`optimisticMessage`, `msgId: pending-<clientMsgId>`) and clears the composer, so the image/text is never
in *neither* place during the round-trip (the old gap — visible on a **suspended iOS stream** as "my image
vanished then came back" — is closed). The send threads a `clientMsgId` end-to-end; the host's `accepted`
ack `{client_msg_id, seq}` reconciles the pending bubble (`reconcileAccepted`): re-key `pending-<id>` →
`user-<seq>` so the real `dir:"out"` echo dedups by `msgId` (`appendUniqueMessage`) — exactly one bubble,
either arrival order, idempotent against a re-delivered ack (#127).

**Send failure restores the draft (#150).** If the publish POST rejects (usually: it never landed), rather
than strand the content in a dead "failed to send" bubble (which also lost the staged images, their
previews already revoked), the viewer **drops the optimistic bubble and restores the draft to the
composer** (text + re-staged images with fresh object URLs, `restageImages`) and shows a "Couldn't send …"
banner with **Retry**. The restore is skipped only if a *new* draft was typed during the in-flight send
(don't clobber it) — in that rare case the failed bubble is kept so the text isn't lost. A `fetch`
rejection can also be a **false failure** (the POST published but the response was lost); the host then
still emits the `accepted` ack, so the accepted-handler clears the banner for that `clientMsgId`
(`failedSendRef`) when that ACK arrives first. This narrows but does not close the ambiguity: the
current Retry calls `send()` and mints a new `clientMsgId`, so a tap before a delayed ACK can duplicate
an already-published command. The future coordinator must reuse an idempotent source ID or require
explicit duplicate-risk confirmation; current Retry has no at-most-once guarantee.

**Stream recovery.** The viewer no longer bumps `reviveKey` after a send (the old #121 post-send bump,
which added latency on the common non-suspended path, was removed): the transport stall-watchdog (#125)
auto-reattaches a stalled stream for *all* streams, and `reviveKey` is now bumped only on
`visibilitychange` (a backgrounded tab returning) — the iOS-suspension recovery without the per-send cost.

---

## 11. Control verbs and freshness

`interrupt` / `set_model` / `set_mode` / `end` ride the control plane (`dir:"in"`) and are handled by
`#driveControlVerb` (`relay.ts`). Two defences protect those verbs against an **untrusted broker**
replaying or forging a control action:

- **Authenticity is the AEAD open** — a verb is acted on only if its frame opens cleanly; a forged or
  tampered frame fails `openFrame` and is dropped (even a body-less `interrupt`/`end` proves authenticity
  by opening). An earlier version that swallowed the error and fired anyway was a forge hole both
  assessors flagged (`relay.ts` `#driveControlVerb` comment).
- **Freshness / expiry** — the viewer's direct-verb helper stamps
  `expiry = now + FRESH_WINDOW_MS`, and `#driveControlVerb` drops an `interrupt`, `set_model`,
  `set_mode`, or `end` replayed after it. `requestHistory` also stamps `catch_up`, but the current
  `catch_up` branch reads only `since` and does not enforce that expiry. Current `permission` frames
  carry no expiry, and their branch performs no expiry check; deletion of the corresponding open gate
  is their only late/replay guard. An old authenticated `catch_up` can therefore trigger redundant
  non-durable replay after a host restart, while a withheld permission answer can act if its gate is
  still open. Stable `seq`/`msgId` keeps catch-up transcript rendering idempotent, but replay
  amplification and late permission remain boundaries.

**What claude's REPL bridge actually accepts.** The worker side (claude's `[bridge:repl]` handler,
function `LW5`, verified against the 2.1.x binary) switches on `control_request.subtype` and handles
exactly: `initialize`, `set_model`, `set_max_thinking_tokens`, `set_permission_mode`, `rename_session`,
`set_color`, `file_suggestions`, `read_file`, `get_context_usage`, `get_usage`, `mcp_status`,
`mcp_authenticate` / `mcp_oauth_callback_url` / `mcp_reconnect`, and `interrupt`. Anything else hits the
`default` arm and comes back as an **error** control_response:
`REPL bridge does not handle control_request subtype: <x>`. (An *outbound-only* session — RC not enabled locally — additionally
rejects everything except `initialize` with `This session is outbound-only…`.) So the relay drives only
the three verbs claude handles: `interrupt`, `set_model`, `set_permission_mode`.

**There is no remote session-end.** `end_session` is **not** in that switch, so the viewer's `end` verb
drives no worker `control_request` — it only clears any open permission gate locally (the `needs`
backstop, §12); claude is ended at its own terminal (`/quit`, Ctrl-C). This is not a remote-claw gap: the
**real** RC server also emits `end_session` (with `reason:"archived"`) and claude rejects it identically
— captured live via `--rc-trace`:

```
← control_request {"request":{"reason":"archived","subtype":"end_session"}, …}
→ control_response {"subtype":"error","error":"REPL bridge does not handle control_request subtype: end_session"}
```

Claude MITM now has a per-session relay controller: each registrar lease owns the `AbortController`
passed to its bridge, so draining or closing that lease stops only its relay. The viewer's authenticated
`end` verb is not wired back to that lease, however; it still only clears the relay's open permission
gates. Viewer-driven teardown would require connecting that admitted verb to the owning lease.

Slash commands (`/compact`, `/clear`, …) deliberately ride the **`user`** path, not a control verb, so
claude processes them as input and they are acked + echoed + replayable like any prompt (`viewer.ts`
`command`).

---

## 12. Convergence & failure modes

The system is **eventually consistent** for the transcript and for presence under the broker's
at-least-once, non-FIFO substrate, *provided the host process lives*. The invariants that buy that, and
the boundaries where they stop holding, are listed here explicitly so they are not mistaken for
guarantees.

### Invariants that give eventual consistency

1. **Single `seq` allocator + orderer** — one counter (§4) plus each viewer's `FrameOrderer` (§5)
   means every device that reads the same channel reconstructs the *same* relayed projection through
   the last contiguous sequence, regardless of arrival order or duplication. A burned sequence stalls
   every viewer at the same gap; this does not make the projection complete or permanently gap-free.
   The orderer keeps **exactly one** frame per `parts=1` seq slot (a re-read
   buffered-behind-a-gap frame whose bounded dedup key evicted is dropped at the slot), so a reconnect
   can't double-render. Proven for multi-client + catch_up by `full-spine`/`rc-spine`, and the eviction
   case by `order.test.ts`.
2. **Idempotent replay** — `catch_up` re-posts original `seq`+`msgId`; the orderer dedups (§8).
3. **Ordered presence fold** — the viewer uses incarnation start + per-incarnation `announce_seq`,
   falling back to `sent_at` for legacy/ambiguous frames (§9), so reordered current-host announces
   converge and a retired incarnation cannot flip state back after a normal forward restart.
4. **`needs` cannot stick** — a gate is added before publish, cleared by a delete-gated answer (§10), by
   the worker's `control_cancel_request` (the grounded cancel signal, below), or by the interrupt/end
   verbs (backstop). All paths re-announce, so `needs` reflects the live gate set.
5. **Single live downstream follower via `gen`** — a reconnect supersedes the older follower, but a
   lost worker ACK can still cause sequential redelivery (§7).
6. **A burned seq ends the session, not the timeline** — `serve()` couples the two pumps and a
   seq-allocating post failure latches `#fatal`; the relay tears down rather than retrying past the hole
   (below). Verified by `relay.test.ts`.

> The adversarial review additionally **probed and refuted** permanent non-convergence from lost wakeups
> / the `Gate` primitive (the `HEARTBEAT_MS` re-check is the backstop, §7), `FrameOrderer` stalls or
> dropped frames, and multi-device divergence of the transcript or resolved-permission state (one
> channel + one seq order + confirmed-wins fold, §10).

### Boundaries (NOT guaranteed — documented on purpose)

1. **A `seq` allocated but never durably posted leaves a durable gap — but not a *live, stuck* session.**
   `seq` is taken before the POST (§4). If `#post` exhausts `POST_RETRIES` on sustained broker 409s,
   encounters any non-409 failure such as a 5xx, or the host is `SIGKILL`ed between
   `this.#seq++` and the durable write, that seq is never posted. The fix
   (`#fatal` + coupled `serve()`, §6/relay.ts) ensures a burned seq **tears the relay down** instead of
   `#pumpInbound` retrying and allocating seqs *past* the hole — so there is no longer a *live* session
   limping behind a mid-stream gap with a "connected" dot (the worst adversarial-review finding). What
   remains: the durable channel may still hold that one mid-stream gap, so a viewer that reads the dead
   channel stalls there — but presence has gone stale, so it reads **disconnected**, which is truthful
   (the session ended around that point). Fully gap-free durability (a skip/tombstone marker, or assigning
   `seq` only post-ack) is future work tied to broker windowing; a global publish-lock that makes
   the prefix gap-free was prototyped but destabilized the in-process workflow test runtime, so the
   lighter teardown was taken.
2. **Reconnect cursor behavior is backend- and incarnation-specific.** A durable viewer normally
   re-reads from index 0 and deduplicates/reorders; a non-durable incarnation change tails from its
   stream cursor and asks the host for `catch_up`. A non-durable host re-reads inbound from 0; a
   durable host samples `frameCount` as its new-incarnation floor. That sample prevents automatic
   re-execution of already-stored pre-floor indices but can skip a command published before the sample
   and never processed (§8). It is not a durable source-ID result map: re-appending or replaying the
   same valid source frame above the floor meets a fresh `#seen`, and a lost pre-restart `accepted`
   result cannot be recovered. Durable viewer re-reads remain O(N).
3. **Unbounded growth.** The inbound `#seen` (§6) and the per-identity **bus** channel (one
   `session_announce` per 20 s keepalive, never trimmed) grow with session lifetime. Bus growth is the
   broker's to window (§6); the 20 s cadence bounds the rate. `#openPerms` is human-paced. The relay
   `#log` grows only with a non-durable backend; it stays empty when the broker supplies durable
   history.
4. **Presence is liveness, not delivery.** A `disconnected` reading means *no fresh announce*, which can
   be a dead host or just a stalled bus subscription; the viewer can't distinguish them, and a transcript
   frame can still arrive on the session channel while presence reads `disconnected` (different channels).
   Advisory, not a transactional "the session ended" signal.
5. **Presence reflects worker honesty.** `phase`/`needs` mirror the worker's `PUT …/worker`
   (`worker_status` + `requires_action_details`) — there is no host-side timeout. If the worker finishes
   a turn but never PUTs `idle`, `phase` shows *thinking* until the next status change. Captured live
   claude always PUTs the final `idle`, so this is a worker-fidelity bound, not a host bug.
6. **`git` is a launch-time snapshot** (`launch.ts`) — a mid-session branch switch isn't reflected until
   the native process is relaunched. Current A0 also creates a new broker-visible session; A1 may retain
   the logical chat while refreshing this launch snapshot for the new native incarnation.

### Capture-grounded protocol surfaces (observed via `--rc-trace`)

These worker↔client shapes were captured from a real `claude --remote-control` (2.1.x) through the
tracing MITM (`--rc-trace`, #46). They are useful current observations, but the repository does not yet
retain sanitized exact-version traces with binary/schema/probe hashes. They are therefore not a
compatibility release proof; every target family remains gated until that fixture exists.

- **`control_cancel_request`** (worker→relay, `POST …/worker/events`) — payload
  `{type:"control_cancel_request", request_id, session_id, uuid}`. The worker cancels a pending gate
  (e.g. on interrupt); the relay clears that `request_id` from `#openPerms` so `needs` drops (§10,
  implemented).
- **`worker_status`** (worker→relay, `PUT …/worker`) — body
  `{worker_epoch, worker_status, requires_action_details}`. `worker_status ∈ {running, idle, requires_action}`; `requires_action_details`
  is `{tool_name, display_tool_name, action_description, tool_use_id}` or `null`. Drives `phase`/`needs`
  (§9, implemented).
- **#41 `/compact`** — rides the **`user`** path: an SSE `user` event with
  `payload.message.content == "/compact"` (`client_platform:"ios"`); the worker replies with a normal
  `assistant` turn (the compacted-summary prose) + `result`. Already relayed; "handle properly" is a UI
  affordance (badge the compaction turn), not new protocol.
- **#42 AskUserQuestion** — surfaced two ways that co-occur: a `can_use_tool` control_request with
  `tool_name:"AskUserQuestion"` (whose `tool_input` holds the questions/options), **and**
  `worker_status:"requires_action"` with `requires_action_details.tool_name == "AskUserQuestion"`. The
  answer is a **`control_response`** with
  `response.response = {behavior:"allow", toolUseID, updatedInput:{answers:{"<question>":"<choice>", …}}}`; the worker then posts a `user`/`tool_result`
  summarising the answers. So #42 reuses the §10 permission spine — the viewer renders the options and
  returns `updatedInput.answers` instead of a bare allow/deny. An answer value is an **arbitrary string**
  (single-select) or **string array** (multiSelect) — claude's tool runs `call({questions, answers})` with
  **no membership check**, so it need not be one of the listed option labels. The viewer therefore always
  offers a per-question **freeform "type your own answer"** input alongside the options (mirroring real
  Claude Code); a freeform single-select answer replaces the option pick, a freeform multiSelect answer is
  appended to the picked labels. "Skip / answer in chat" is the deny path (claude then re-asks in plain text).
- **#44 composer attachments** — the captured RC shape is a `user` event whose payload carries
  `file_attachments:[{file_name, file_uuid, is_image}]` (`client_platform:"ios"`): the bytes are uploaded
  out-of-band and referenced by `file_uuid`, **not** inlined. We can't reproduce that upload
  zero-knowledge (the broker would have to hold the bytes), so the **implemented** path rides our own
  E2E `attachment` control frame instead: the host writes the (decrypted) bytes to disk under a
  sanitized, unique, mime-correct name and drives claude to `Read` the file (image Read = real vision),
  echoing a `user` content frame that makes a 📎 projection available to every subscribed viewer.
  Each device still owns actual rendering. No unverified worker-protocol write — only our frame
  transport + the standard Read tool + a normal prompt (relay `#handleAttachmentPayload`).
- **#36 deep-history backfill — GROUNDED AWAY.** The v2-architecture §6 design had the *worker* re-emit
  prior turns as `historical:true` frames on RC (re)connect, gated by a completeness check. The real
  protocol does **not** do this, confirmed three ways via `--rc-trace`: `POST .../bridge` returns only a
  `worker_jwt` (no transcript); the SSE `…/worker/events/stream` opens once and carries only **new**
  inputs (the worker *pushes* its own output via `POST …/worker/events`); and a `--resume`d worker
  bridging into an existing conversation is streamed **no** prior history (`historical` appears in zero
  captures). So there is nothing to backfill from the worker and nothing to gate on. History is instead
  supplied by the **relay path**: a non-durable host appends every content frame to `#log` and replays it
  on `catch_up`; a durable broker persists the frames and replays them directly while the host keeps
  `#log` empty (§8). Both give a mid-session viewer the prior projected transcript, as proven by the
  durable/non-durable reconnect cases in `relay.test.ts`. Residual gaps the worker genuinely cannot fix:
  a non-durable relay restart loses `#log`; a durable frame log preserves the viewer projection but does
  not reconstruct the native Claude context or the in-memory `Session`; and a `--resume`d session's
  pre-resume history lives only in Claude's local transcript file, not on the RC wire. Surfacing that
  native history requires a separate, proven transcript/resume adapter rather than worker backfill.

So #41/#42/#44 are **grounded, scoped features** (the `user` path for #41, the §10 permission path for
#42, the host-write + Read path for #44), and #36 is **resolved for projected mid-session history by
grounding**: host `#log` + `catch_up` on a non-durable backend, or broker replay on a durable backend,
deliver the available projected history. The worker backfill it specified does not exist.
