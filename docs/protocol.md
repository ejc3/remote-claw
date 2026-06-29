# Protocol & Runtime (grounded)

This document describes the **as-built** remote-claw protocol — the wire format, the channels, and the
runtime discipline that carries a live `claude --remote-control` session to one or more browser viewers
through a zero-knowledge broker. Every claim cites the source that implements it (path + symbol), so it
stays honest as the code changes. Where a behaviour is a deliberate boundary rather than a guarantee, it
is called out in [§12 Convergence & failure modes](#12-convergence--failure-modes).

Companion docs: [v2 Architecture](v2-architecture.md) for the design rationale (§-numbers below refer to
its sections), and [Phase 0 Findings](phase0-findings.md) for the reverse-engineered RC worker protocol.

---

## 1. Topology

Three parties, one of which (the broker) is untrusted and sees only ciphertext.

- **Host / wrapper** — `runRcLaunch` (`packages/cli/src/host/rc/launch.ts`) runs the real `claude`
  behind a MITM proxy (`MitmProxy`, `mitm.ts`) pointed at by `HTTPS_PROXY`. The instant a session hits
  `/remote-control`, its worker traffic lands on `RelayCore`/`Session` (`session.ts`) instead of
  Anthropic. One `HostRcRelay` (`relay.ts`) per RC session bridges that session to the broker.
- **Broker** — the pluggable backend (Vercel Workflows, per-session SQLite/libSQL, or local)
  behind `POST /api/relay` and `GET /api/stream`. It is a dumb, append-only, **at-least-once, non-FIFO**
  pipe (§12). It never holds a key; it routes by a cleartext header and stores ciphertext.
- **Viewer** — the browser client (`apps/web/app/lib/viewer.ts` + `page.tsx`). It reuses the **same**
  `BrokerClient` / `FrameOrderer` / `SecurityProvider` as the host, so there is exactly one protocol
  implementation, not two that can drift (`viewer.ts` header comment).

**Driver modes share one relay.** The diagram above is the MITM (`--rc-app`) path, but it is not the only
driver. Every harness produces a `Session`; `bridgeSession` (the one place that turns a `Session` into a
live broker bridge — `HostRcRelay` + `announce` + `serve`) is the single seam. **The broker, the relay
(`HostRcRelay`), and the viewer are identical across drivers** — so everything in this document (frames,
the two pumps, `seq`/ordering, `catch_up`, presence, permissions, the attachment lifecycle in §10a) is the
same regardless of driver. Only **how the `Session` reaches `claude`** differs:

| Driver | Inject (downstream → claude) | Capture (claude → upstream) | Permissions | Provider |
|---|---|---|---|---|
| **MITM** (`--rc-app`, `launch.ts`) | intercept claude's RC endpoints → worker downstream | worker upstream POSTs (`followUpstream`) | structured `can_use_tool` gates (§10) | Anthropic API only |
| **tmux** (`--rc-driver=tmux`, `tmux/driver.ts`) | `set-buffer`/`paste-buffer` + `send-keys` into the pane (`runInjectPump`) | tail the local transcript `.jsonl` → `pushUpstream` (`TranscriptTailer`) | **default:** structured `can_use_tool` gates via an injected **PreToolUse hook** (§10); folder-trust pre-seeded so a fresh cwd's pane doesn't hang. **Opt-out** `--rc-tmux-skip-permissions` → `--dangerously-skip-permissions` auto-approve | any, incl. Bedrock/Vertex |
| **opencode** (`--rc-driver=opencode`, `opencode/driver.ts`) | POST the prompt to the opencode session → `followDownstream` (+`ack`) | opencode **SSE** event stream → `pushUpstream` | **default:** structured `can_use_tool` gates mirrored via the **session permission API** (PATCH an ask-all rule) ↔ SSE `permission.asked` (§10). **Opt-out** `--rc-oc-skip-permissions` → skip the ask-PATCH; opencode keeps its **own** session permission config (auto-runs unless that config already asks) | any (opencode's own provider config) |

Because the relay owns the attachment write+inject and presence, attachments and the connection-state
ladder work in **both** modes unchanged — the tmux driver never even sees an `attachment` frame
(`TMUX_CAPABILITIES.attachments = true`); the relay writes the file and injects the `@"path"` reference,
which the pane's `claude` attaches natively just as the MITM-driven worker does.

```
 claude --remote-control
        │  (HTTPS_PROXY → CONNECT → leaf cert)
        ▼
   MitmProxy ── serves /v1/code/sessions* ──► RelayCore / Session
        │                                          ▲   │
   (/v1/messages, OAuth pass straight through)     │   │ downstream (SSE): user input, control_*
                                                    │   ▼
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
host→client), `seq` (the transcript order, or `null`), `msgId` (dedup key), and `part`/`parts` (chunking).

Each `recordKind` is sealed under exactly one **plane** (AEAD key), decided by `planeForKind`
(`packages/cli/src/broker/protocol.ts`):

- **content** (`K_session`, carries `seq`) — the transcript: `user`, `assistant`, `assistant_sub`,
  `assistant_thinking[_sub]`, `result`, `tool_use`, `tool_result`, `task`, `permission_request`,
  `permission_resolved`, plus `system`/`status`/`rate_limit`/`can_use_tool` (`CONTENT_KINDS`).
- **control** (`control_key`, `dir:"in"`) — client→host verbs: `catch_up`, `permission`, `interrupt`,
  `set_mode`, `set_model`, `command`, `end` (`CONTROL_KINDS`).
- **meta** (`K_meta`, `seq:null`, never logged) — `accepted` (acks) and `session_announce` (presence)
  (`META_KINDS`).

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

## 4. The transcript timeline (`seq`)

`seq` is the total order of the transcript and is allocated in **exactly one place**: `HostRcRelay`'s
`this.#seq++` (`relay.ts`). Clients never assign order (§6). Both relay pumps (§6) share that single
counter; because JS is single-threaded, `this.#seq++` is atomic between them, so every content frame —
whether an outbound assistant line or the inbound echo of a prompt — gets a unique, gap-free-by-
construction `seq`.

A `seq` is allocated **before** the POST so the frame's `msgId` is deterministic (`${kind}-${seq}`) and a
retry re-posts the *same* frame, which the viewer dedups (`relay.ts` `#post` / `POST_RETRIES`). The cost
of allocating before the durable write is analysed in [§12](#12-convergence--failure-modes).

---

## 5. Delivery discipline: `FrameOrderer`

Every subscriber (viewer **and** the host's inbound pump) runs frames through a `FrameOrderer`
(`packages/cli/src/broker/order.ts`) before acting on them. It turns the at-least-once, non-FIFO stream
into an exactly-once, in-order transcript:

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

`#seen` (inbound dedup) is intentionally **unbounded**: `#tailInbound` re-reads from frame index 0 on
every reconnect, so an evicted-then-re-read `user` `msgId` would re-inject a duplicate prompt into claude
(`relay.ts` `#seen` comment). It grows only with distinct human-paced client frames and is freed when the
session ends.

The outbound `#post` retries a transient 409 (the run cap-rolled mid-publish) with bounded exponential
backoff, because the `seq` is already allocated and a dropped post would strand every viewer on a
permanent gap (`relay.ts` `#post` / `POST_RETRIES = 6`).

---

## 7. The Session bus (worker side)

`Session` (`session.ts`) is the authoritative state and event bus between the worker and the relay,
a faithful async port of Phase 0's `core.py`:

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
and `followDownstream` exits the moment `gen !== this.#workerGen`, so **exactly one** follower delivers
downstream events and a reconnect race can't double-deliver a turn (`session.ts` header + `followDownstream`).
`#acked` records `event_id`s the worker confirmed, so a reconnecting stream doesn't re-deliver them.

`worker_status` is updated by the MITM's `PUT …/worker`, which only mutates and `wake()`s the session
**on an actual change** (`mitm.ts`), so a phase flip propagates promptly to the presence pump without a
busy-loop of identical announces.

---

## 8. catch_up / replay and reconnect

A late or reloaded viewer posts a `catch_up` control frame with `{ since }`; `#pumpInbound` calls
`#replay(since)`, which re-POSTs every logged content frame with `e.seq >= since` (`relay.ts`). Replay
re-uses each frame's original `seq` + `msgId`, so the viewer's orderer **dedups** the overlap with the
live stream and reorders the union by `seq` — the late viewer reconstructs the exact transcript, once
(`order.ts`; proven by the CATCH_UP cases in `full-spine.integration.test.ts` and
`rc-spine.integration.test.ts`).

Both the viewer's `transcript()` and the host's `#tailInbound` **re-subscribe from frame index 0** on any
stream error, relying on the orderer / `#seen` to make the re-read idempotent (`viewer.ts` / `relay.ts`).
This is correct but **O(channel length) per reconnect** — see [§12](#12-convergence--failure-modes).

---

## 9. Presence: `session_announce`

Presence rides the meta-plane `session_announce` on the identity bus — idempotent, `seq:null`, never
logged, so re-announcing is cheap (`relay.ts` `#sendAnnounce`). The host folds live state onto **every**
(re-)announce:

- `title`, `cwd`, and a static `git` snapshot (branch / dirty / ahead-behind, `gitinfo.ts`, #49).
- `status` (raw `worker_status`), `phase` (`phaseFor`: `running`/`busy` → `thinking`, else `idle`, #48),
  and `needs` (`status === "requires_action" || #openPerms.size > 0`, `#presence`).
- `mode` — the worker's effective permission mode, present whenever it's known (`session.permissionMode
  !== null`: seeded from session config, or updated by an upstream `system/init`). A **viewer-requested**
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
- `sent_at` — the freshness clock the viewer reads for liveness.

Cadence (`relay.ts` `#maybeAnnounce`): re-announce **immediately** when the presence key
(`status|needs`) changes, else at the `ANNOUNCE_KEEPALIVE_MS = 20_000` idle floor (driven by
`followUpstream`'s null tick). Each announce gets a unique `msgId` from `#annCount++` so no two reuse one
id.

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
console keeps only the **freshest** announce per session (`max sent_at`, `page.tsx` Console), so an
out-of-order older announce is ignored — presence converges to the latest `sent_at`.

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
   worker, logs a `permission_resolved` content frame (so a reload/`catch_up` renders the request as
   answered, not re-prompting, #56/#57), and re-announces so `needs` clears.

The viewer's `PermissionRow` renders `effective = confirmed ?? decision`: the host-logged resolution
(`confirmed`, folded from the transcript's `permission_resolved` frames) **wins** over the local optimistic
`decision`, so a granted permission survives a reload (`page.tsx`).

---

## 10a. Attachment lifecycle (#44)

An image the viewer sends rides our **own** `attachment` frame, never the worker protocol — claude reads
the file natively, so no unverified write is needed. The full round trip (`viewer.sendAttachment` →
`relay.ts` `#handleAttachment`):

1. **Viewer** seals an `attachment` frame (`dir:"in"`, plane = content's key) carrying `{name, mime, data
   (base64), caption}` and POSTs it. The broker never sees the bytes. The viewer rejects a payload over
   `MAX_ATTACHMENT_BYTES` (3 MB) up front — the sealed body is ~1.34× that, and Vercel rejects a request
   body over ~4.5 MB at the edge as a bare `"Load failed"` (§12). The composer **downscales** every image
   to JPEG first, so a normal photo lands far under the cap.
2. **Host** `#handleAttachment` decrypts, then **drops cleanly** (no `seq`, no side effect) if the data is
   not well-formed base64, is over `MAX_ATTACHMENT_B64` (16 MB), or decodes empty.
3. It writes the bytes to `~/.claude/uploads/<sessionId>/<unique>.<ext>` (the extension matched to the
   actual mime). This is the **same tree the real Anthropic app uses**, so claude reads it with **no
   permission prompt** (an arbitrary temp path *did* prompt — #122). The unique prefix stops a later
   upload overwriting a file an earlier still-queued prompt will read.
4. It **echoes a `user` content frame** `📎 <name>\n<caption>` (`dir:"out"`, with a real `seq`) — and only
   **then** `pushUserInput('@"<abs-path>" <caption | "What do you see in this image?">')`. The echo is
   published **before** the inject (and a failed echo is **fatal** → teardown) so a torn-down relay can
   never have driven claude to read an image that reached no transcript.

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
(`failedSendRef`) — closing the window where a one-tap Retry would duplicate an already-accepted send.

**Stream recovery.** The viewer no longer bumps `reviveKey` after a send (the old #121 post-send bump,
which added latency on the common non-suspended path, was removed): the transport stall-watchdog (#125)
auto-reattaches a stalled stream for *all* streams, and `reviveKey` is now bumped only on
`visibilitychange` (a backgrounded tab returning) — the iOS-suspension recovery without the per-send cost.

---

## 11. Control verbs and freshness

`interrupt` / `set_model` / `set_mode` / `end` ride the control plane (`dir:"in"`) and are handled by
`#driveControlVerb` (`relay.ts`). Two defences against an **untrusted broker** replaying or forging a
control action:

- **Authenticity is the AEAD open** — a verb is acted on only if its frame opens cleanly; a forged or
  tampered frame fails `openFrame` and is dropped (even a body-less `interrupt`/`end` proves authenticity
  by opening). An earlier version that swallowed the error and fired anyway was a forge hole both
  assessors flagged (`relay.ts` `#driveControlVerb` comment).
- **Freshness / expiry** — the viewer stamps `expiry = now + FRESH_WINDOW_MS` on every control + catch_up
  frame (`viewer.ts` `#control` / `requestHistory`); a frame the broker withholds and replays past its
  `expiry` is dropped as stale (`relay.ts`).

**What claude's REPL bridge actually accepts.** The worker side (claude's `[bridge:repl]` handler,
function `LW5`, verified against the 2.1.x binary) switches on `control_request.subtype` and handles
exactly: `initialize`, `set_model`, `set_max_thinking_tokens`, `set_permission_mode`, `rename_session`,
`set_color`, `file_suggestions`, `read_file`, `get_context_usage`, `get_usage`, `mcp_status`,
`mcp_authenticate` / `mcp_oauth_callback_url` / `mcp_reconnect`, and `interrupt`. Anything else hits the
`default` arm and comes back as an **error** control_response: `REPL bridge does not handle
control_request subtype: <x>`. (An *outbound-only* session — RC not enabled locally — additionally
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

A true remote teardown would need a per-session abort hook in the relay (today `serve()` shares one
`AbortController` across all of a launch's sessions) — noted as future work, not wired.

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

1. **Single `seq` allocator + orderer** — one counter (§4) plus the per-subscriber `FrameOrderer` (§5)
   means every device that reads the same channel reconstructs the *same* gap-free transcript, regardless
   of arrival order or duplication. The orderer keeps **exactly one** frame per `parts=1` seq slot (a
   re-read buffered-behind-a-gap frame whose bounded dedup key evicted is dropped at the slot), so a
   reconnect can't double-render. Proven for multi-client + catch_up by `full-spine`/`rc-spine`, and the
   eviction case by `order.test.ts`.
2. **Idempotent replay** — `catch_up` re-posts original `seq`+`msgId`; the orderer dedups (§8).
3. **Freshest-wins presence** — the viewer keeps `max(sent_at)` (§9), so reordered announces converge.
4. **`needs` cannot stick** — a gate is added before publish, cleared by a delete-gated answer (§10), by
   the worker's `control_cancel_request` (the grounded cancel signal, below), or by the interrupt/end
   verbs (backstop). All paths re-announce, so `needs` reflects the live gate set.
5. **Single downstream follower via `gen`** — a worker reconnect cannot double-deliver a turn (§7).
6. **A burned seq ends the session, not the timeline** — `serve()` couples the two pumps and a
   seq-allocating post failure latches `#fatal`; the relay tears down rather than retrying past the hole
   (below). Verified by `relay.test.ts`.

> The adversarial review additionally **probed and refuted** permanent non-convergence from lost wakeups
> / the `Gate` primitive (the `HEARTBEAT_MS` re-check is the backstop, §7), `FrameOrderer` stalls or
> dropped frames, and multi-device divergence of the transcript or resolved-permission state (one
> channel + one seq order + confirmed-wins fold, §10).

### Boundaries (NOT guaranteed — documented on purpose)

1. **A `seq` allocated but never durably posted leaves a durable gap — but not a *live, stuck* session.**
   `seq` is taken before the POST (§4). If `#post` exhausts `POST_RETRIES` (sustained broker 409/5xx) or
   the host is `SIGKILL`ed between `this.#seq++` and the durable write, that seq is never posted. The fix
   (`#fatal` + coupled `serve()`, §6/relay.ts) ensures a burned seq **tears the relay down** instead of
   `#pumpInbound` retrying and allocating seqs *past* the hole — so there is no longer a *live* session
   limping behind a mid-stream gap with a "connected" dot (the worst adversarial-review finding). What
   remains: the durable channel may still hold that one mid-stream gap, so a viewer that reads the dead
   channel stalls there — but presence has gone stale, so it reads **disconnected**, which is truthful
   (the session ended around that point). Fully gap-free durability (a skip/tombstone marker, or assigning
   `seq` only post-ack) is future work tied to broker windowing; a global publish-lock that makes
   the prefix gap-free was prototyped but destabilized the in-process workflow test runtime, so the
   lighter teardown was taken.
2. **Reconnect re-reads the whole channel (O(N)).** Both the viewer and the host re-subscribe from index
   0 (§8); the orderer/`#seen` make it correct but the bandwidth/CPU per reconnect grows with session
   length. No resume cursor is used.
3. **Unbounded growth.** The inbound `#seen` (§6) and the per-identity **bus** channel (one
   `session_announce` per 20 s keepalive, never trimmed) grow with session lifetime. Bus growth is the
   broker's to window (§6); the 20 s cadence bounds the rate. `#openPerms` and the relay `#log` also
   grow with the session but are human-paced / freed at end.
4. **Presence is liveness, not delivery.** A `disconnected` reading means *no fresh announce*, which can
   be a dead host or just a stalled bus subscription; the viewer can't distinguish them, and a transcript
   frame can still arrive on the session channel while presence reads `disconnected` (different channels).
   Advisory, not a transactional "the session ended" signal.
5. **Presence reflects worker honesty.** `phase`/`needs` mirror the worker's `PUT …/worker`
   (`worker_status` + `requires_action_details`) — there is no host-side timeout. If the worker finishes
   a turn but never PUTs `idle`, `phase` shows *thinking* until the next status change. Captured live
   claude always PUTs the final `idle`, so this is a worker-fidelity bound, not a host bug.
6. **`git` is a launch-time snapshot** (`launch.ts`) — a mid-session branch switch isn't reflected until
   a new session.

### Capture-grounded protocol surfaces (observed via `--rc-trace`)

These worker↔client shapes were **captured from a real `claude --remote-control` (2.1.x)** through the
tracing MITM (`--rc-trace`, #46). They are documented here as ground truth; the ones not yet surfaced in
the UI are scoped features, **not** unknowns.

- **`control_cancel_request`** (worker→relay, `POST …/worker/events`) — payload
  `{type:"control_cancel_request", request_id, session_id, uuid}`. The worker cancels a pending gate
  (e.g. on interrupt); the relay clears that `request_id` from `#openPerms` so `needs` drops (§10,
  implemented).
- **`worker_status`** (worker→relay, `PUT …/worker`) — body `{worker_epoch, worker_status,
  requires_action_details}`. `worker_status ∈ {running, idle, requires_action}`; `requires_action_details`
  is `{tool_name, display_tool_name, action_description, tool_use_id}` or `null`. Drives `phase`/`needs`
  (§9, implemented).
- **#41 `/compact`** — rides the **`user`** path: an SSE `user` event with
  `payload.message.content == "/compact"` (`client_platform:"ios"`); the worker replies with a normal
  `assistant` turn (the compacted-summary prose) + `result`. Already relayed; "handle properly" is a UI
  affordance (badge the compaction turn), not new protocol.
- **#42 AskUserQuestion** — surfaced two ways that co-occur: a `can_use_tool` control_request with
  `tool_name:"AskUserQuestion"` (whose `tool_input` holds the questions/options), **and**
  `worker_status:"requires_action"` with `requires_action_details.tool_name == "AskUserQuestion"`. The
  answer is a **`control_response`** with `response.response = {behavior:"allow", toolUseID,
  updatedInput:{answers:{"<question>":"<choice>", …}}}`; the worker then posts a `user`/`tool_result`
  summarising the answers. So #42 reuses the §10 permission spine — the viewer renders the options and
  returns `updatedInput.answers` instead of a bare allow/deny.
- **#44 composer attachments** — the captured RC shape is a `user` event whose payload carries
  `file_attachments:[{file_name, file_uuid, is_image}]` (`client_platform:"ios"`): the bytes are uploaded
  out-of-band and referenced by `file_uuid`, **not** inlined. We can't reproduce that upload
  zero-knowledge (the broker would have to hold the bytes), so the **implemented** path rides our own
  E2E `attachment` control frame instead: the host writes the (decrypted) bytes to disk under a
  sanitized, unique, mime-correct name and drives claude to `Read` the file (image Read = real vision),
  echoing a `user` content frame so every device sees a 📎 chip. No unverified worker-protocol write —
  only our frame transport + the standard Read tool + a normal prompt (relay `#handleAttachment`).
- **#36 deep-history backfill — GROUNDED AWAY.** The v2-architecture §6 design had the *worker* re-emit
  prior turns as `historical:true` frames on RC (re)connect, gated by a completeness check. The real
  protocol does **not** do this, confirmed three ways via `--rc-trace`: `POST .../bridge` returns only a
  `worker_jwt` (no transcript); the SSE `…/worker/events/stream` opens once and carries only **new**
  inputs (the worker *pushes* its own output via `POST …/worker/events`); and a `--resume`d worker
  bridging into an existing conversation is streamed **no** prior history (`historical` appears in zero
  captures). So there is nothing to backfill from the worker and nothing to gate on. History is instead
  guaranteed by the **relay**: every content frame is appended to `#log`, and a mid-session
  (re)connecting viewer replays the COMPLETE prior transcript from that log via `catch_up` (§8) — proven
  by the `#36` mid-session-reconnect tests in `relay.test.ts`. Residual gaps the worker genuinely can't
  fix (out of scope, documented honestly): a relay/wrapper restart loses the in-memory `#log` (but the
  wrapper and `claude` share a process lifecycle, so a restart is a *new* session id, not a resumable
  one), and a `--resume`d session's pre-resume history lives only in claude's local transcript file, not
  on the RC wire — surfacing it would mean the host parsing that private on-disk format, not a backfill.

So #41/#42/#44 are **grounded, scoped features** (the `user` path for #41, the §10 permission path for
#42, the host-write + Read path for #44), and #36 is **resolved by grounding**: the relay's `#log` +
`catch_up` already deliver complete mid-session history, and the worker-backfill it specified does not
exist in the protocol.
