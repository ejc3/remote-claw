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
remote-claw collaborator ← many server collaborators architecture. A0.1 of that migration routes
Claude MITM sessions through the neutral, host-scoped lifecycle before their existing `Session` port
is bridged to the broker. The OpenCode half of A0.2 now uses the same lifecycle and fails closed before
`ready`; the tmux half now does too, after a live pane and mandatory Claude `SessionStart` marker prove
its native setup.

**Identity scope.** In this as-built protocol, `Session.id` is a synthetic `cse_*` identifier used as
the broker channel address and session-list key. It is not a Claude transcript ID, Codex thread ID,
OpenCode `ses_*`, tmux pane identity, or durable remote-claw logical-chat ID. The A0 `rcb_*`
registration lease is also process-local. A1.2 now persists a separate
`(collaborationServerId, logicalChatId)` scope; that pair is the canonical chat within one machine.
The A1.6 dormant broker route and A1.7a host ingress ledger use the full
`(identity_id, collaborationServerId, logicalChatId)` triple. A private synthetic `cse_*` may then
rotate beneath it during a proven native transport/runtime replacement. That mapping and recovery
behavior, and any A1 viewer row, alias, or cache, are not implemented here.

**Host multiplicity.** Current A0 already gives each in-process `Session` its own registrar lease,
relay instance, inbound dedup set, projection log, broker chat channel, permission map, and teardown
controller; one MITM registrar can serve several intercepted sessions. That is process-local
isolation, not the selected live durable host inventory. A1.2, A1.6, A1.7a, A1.7b1, and A1.8a0 can now persist dormant
host/chat, broker-route, evidence-preserving ingress, rejected command/preparation, and rejected terminal-result inventory, but later slices must make one paired host discover and recover
many independently wrapped Claude, Codex, and OpenCode conversations across equal or different
directories. Each keeps its own native identity/history, local TUI, collaborators, actor lane,
delivery gates, and recovery outcome. Global journal counters remain audit positions; native
serialization and quarantine are per logical chat, and restart of one lane cannot create a new row or
block another. The exact target contract is
[Client-driven Host Runtime § One paired host, many independent sessions](client-driven-host-runtime.md#one-paired-host-many-independent-sessions).

---

## 1. Topology

Three parties, one of which (the broker) is untrusted and sees only ciphertext.

- **Host / wrapper** — `runRcLaunch` (`packages/cli/src/host/rc/launch.ts`) runs the real `claude`
  with its native TUI behind a MITM proxy (`MitmProxy`, `mitm.ts`) pointed at by `HTTPS_PROXY`. The
  instant a session hits `/remote-control`, its worker traffic lands on `RelayCore`/`Session`
  (`session.ts`) instead of Anthropic. One host-scoped `LegacyRcConversationRegistrar` allocates a
  distinct process-local lease per intercepted session. Once setup publishes validated capabilities
  and marks that lease `ready`, one `HostRcRelay` (`relay.ts`) bridges the session to the broker.
- **Broker** — the pluggable backend (Vercel Workflows, per-channel SQLite/libSQL, or local)
  behind the `POST /api/relay` and `GET /api/stream` data plane. `GET /api/seq` and
  `GET /api/frame-count` expose no message body: `/api/seq` supplies effective durability to both
  viewer and host plus the host's outbound sequence high-water, while host-only `/api/frame-count`
  supplies the durable inbound fence. It is a dumb, append-only, **at-least-once, non-FIFO** pipe
  (§12). It never holds a key; it routes by a cleartext header and stores ciphertext.
- **Viewer** — the browser client (`apps/web/app/lib/viewer.ts` + `page.tsx`). It reuses the host's
  `BrokerClient` and `SecurityProvider`, plus the shared `FrameOrderer`, so the wire and security
  primitives do not have separate implementations that can drift (`viewer.ts` header comment).

**Dormant A1.6 transport.** A separate selected SQLite/libSQL provider now exists behind
`/api/a1/*` (`apps/web/app/api/a1/**/route.ts`, `lib/broker/a1-sqlite.ts`) with the browser-safe
contracts in `packages/clawsec/src/a1-broker.ts` and client in
`packages/cli/src/broker/a1-client.ts`. It does not implement the A0 `BrokerBackend` interface and is
not used by `HostRcRelay`, any driver, runtime-owner RPC, or the viewer. Ordinary production therefore
makes zero A1 requests; the current topology and UI still use only the A0 endpoints above. The exact
A1.6 HTTP/storage contract is recorded in [§3a](#3a-dormant-a16-broker-transport).

**Dormant A1.7a ingress.** Host schema v8 and its repository/route actor now retain authenticated
ingress evidence through complete multipart results in `awaiting_order`; [§3b](#3b-dormant-a17a-evidence-preserving-ingress)
records that direct-only contract. The actor is absent from package barrels and every production run
path. A1.7a itself neither changes the A0 topology above nor adds command ordering, signed results,
server-scope signing, native effects/outboxes, dispatch, or viewer projection.

**Dormant A1.7b0 server signer.** Host schema v9 now adds only the server-scoped signing prerequisite:
an initial self-anchor, wrapped Ed25519 custody, fenced bootstrap/current leases, and durable
reserve/bind/sign/accept/reconcile state. [§3c](#3c-dormant-a17b0-server-signer-prerequisite) records
that direct-only contract. It does not consume `awaiting_order`, publish a host frame, or add a common
command/result, broker write, outbox/effect, native dispatch, viewer projection, or production path.

**Dormant A1.7b1 command adjudication.** Host schema v10 now consumes an eligible A1.7a
`awaiting_order` source into the shared ready journal, deterministically creates and orders a common
command, freezes the current rejected-only decision, and binds/signs a replaceable version-one result
preparation under the A1.7b0 current server lease. [§3d](#3d-dormant-a17b1-command-adjudication)
records that direct-only contract. Its terminal boundary is a signed-but-unaccepted preparation. It
does not create the final result, signer acceptance, terminal ingress result, source delivery/outbox,
native attempt/effect, viewer projection, broker write, driver operation, or production path.

**Dormant A1.8a0 rejected-result finalization.** Host schema v11 now consumes only that exact signed
rejected preparation and atomically retains the immutable common result, dense signer acceptance,
terminal adjudication overlay, exact semantic-result artifact, and one causal plaintext
`pending_seal` delivery intent. [§3e](#3e-dormant-a18a0-rejected-result-finalization) records that
direct-only contract. The base schema-v8 ingress row remains immutable evidence, and finalization
does not depend on later route health. The intent cannot be claimed, sealed, encrypted, signed,
published, or sent in A1.8a0; there is no cursor movement, admitted/effect arm, broker call, viewer
projection, driver operation, production path, or capability advertisement.

**A1.8a1 native-binding authority status.** A1.8a1-E0 implements the six E-side canonical ID
contracts and four deterministic attestation/snapshot ID derivations. E1a now implements the four
strict, 64 KiB ref-free parent-envelope codecs, closed role/schema/bound/scope registry, exact locked
byte/digest vectors, and bounded raw-artifact digest helper. E1b1 now implements strict
role-correlated native/front-door executable-content manifest codecs and one direct-only Linux
stable-FD collector. Its retained real OpenCode 1.17.5 Linux arm64 proof closes only the native role;
generic collection has front-door temporary-file coverage, but no retained or provenance-bound
actual front-door observation exists. E1b1 proves no pathname, process, front door, currentness, complete
parent, authority, or wire operation. E1b2 now implements the exact full-u64 `M → P → F → A` leaf
codecs, a bounded raw-five-view DAG/parent verifier, and synchronous direct-only independent no-follow
root/target collection. The collector returns four leaves; the verifier consumes their raw views plus
separately built E1a parent bytes. Its non-skipping local-direct/hosted-CI-demoted proof exercises a real
mount namespace and bind-mount policy. E1b2 remains historical-only and proves no currentness,
process, authority, stateful acceptance, production wiring, capability, or wire operation. E1b3's
front-door/listener contract and executable gate are frozen but unimplemented: one default-closed ESM
build, complete raw OpenAPI surface, cycle-free declarations/closures, sealed item-wise measurement,
and a raw-seven-view listener-parent verifier. E1b4 isolation and E1b5 capability/full-parent closure
remain planned. E1c then owns stateful
accepted evidence and must never change either native-transport authority pointer. A1.8a1-I later
installs one accepted capability snapshot plus one credentialless authenticated callable-port ingress
lease as an indivisible pair. It stores no URL, socket, bearer, provider credential, or readable
secret; loss of the live authenticated channel withdraws writability and requires a new ingress
generation. It creates no admitted command, attempt, dispatch, effect, native call, packet, production
operation, or advertised capability. E1c's workspace lifecycle, immutable legacy-signer quarantine,
unsigned-snapshot/accepted-inert staging, and caller-retained request/immutable-receipt reconciliation
rules are frozen, but no stateful schema or migration number exists. The complete split is recorded in the
[current authority design](client-driven-host-runtime-reference.md#41-a18a1-native-binding-authority-freeze-planned-dormant).

**Driver modes share one relay.** The diagram above is the MITM (`--rc-app`) path, but it is not the
only driver. Every current harness produces a `Session`. Claude MITM, OpenCode, and tmux register that
port through `LegacyRcConversationRegistrar`, which calls `startBridgeSession` only at `ready`.
**The broker, the relay
(`HostRcRelay`), and the viewer are shared across drivers.** Frames, the two pumps,
`seq`/ordering, `catch_up`, and presence therefore use one compatibility path, while the native
capability behind a frame can differ. Permission and attachment support are only as strong as the
selected harness. Both A0.2 paths wait for native setup evidence and publish conservative capability
vectors. Only how the `Session` reaches the native harness differs:

| Driver | Native surface used by the local person | Inject (downstream → native client) | Capture (native client → upstream) | Permissions | Provider |
|---|---|---|---|---|---|
| **MITM** (`--rc-app`, `launch.ts`) | Real Claude Code TUI in the wrapped process; local prompt text is not currently projected to viewers | Intercept Claude's RC endpoints → worker downstream | Worker upstream POSTs (`followUpstream`) | Structured `can_use_tool` gates (§10) | Default: Anthropic API; `--rc-inference=bedrock`: Bedrock inference + locally synthesized control plane |
| **tmux** (`--rc-driver=tmux`, `tmux/driver.ts`) | Real Claude Code TUI in a private-socket attachable pane; unmatched local prompts are projected post-hoc as `local_prompt` | Prompt bytes over stdin to `load-buffer`, then `paste-buffer` + `send-keys` (`runInjectPump`) | Tail the local transcript `.jsonl` → `pushUpstream` (`TranscriptTailer`) | **Default:** structured `can_use_tool` gates via an injected **PreToolUse hook** (§10), published only after settings/trust and the mandatory startup marker succeed. **Opt-out** `--rc-tmux-skip-permissions` → `--dangerously-skip-permissions` auto-approve | Any, including Bedrock/Vertex |
| **opencode** (`--rc-driver=opencode`, `opencode/driver.ts`) | A native OpenCode TUI may share the server; the driver does not enforce one attachment, and unmatched local prompts are projected post-hoc as `local_prompt` | POST the prompt to the OpenCode session → `followDownstream` (+`ack`) | OpenCode **SSE** event stream → `pushUpstream` | **Default required setup:** strict parent policy read; append the ask-all rule only when absent; strict read-back before `ready`; then mirror SSE `permission.asked` (§10). **Opt-out** `--rc-oc-skip-permissions` leaves OpenCode's own permission config and advertises permissions off | Any OpenCode provider configuration |

Tmux's readiness hook is not optional: Claude must execute one `SessionStart` marker from the exact
private merged-settings file before the registrar can enter `ready`. `--rc-no-session-hook` /
`RC_SESSION_HOOK=0` disables only continued marker-based transcript discovery and rotation following.
Hook-disabling modes and unmergeable settings fail startup without a broker-visible row. The driver
advertises viewer `status:false` and native
`{mutationAdmission:"post_hoc", history:"partial", deliveryEvidence:"best_effort",
liveReattach:false}`. Its transcript debounce remains heuristic evidence, not a native status promise.

Current OpenCode permission answers use retained
`POST /permission/{requestID}/reply` with `{reply}` and require successful JSON to be literal `true`.
That is transport acknowledgement only: the global route does not prove selected-session ownership, a
win over a native-TUI answer, or terminal `permission.replied` state. Child policy preparation remains
asynchronous and can lose the first-tool race, but each task receives run cancellation, is tracked and
PATCH-fenced after cancellation, and joins the shared bounded teardown. Native `session.error`
warnings may carry best-effort human-readable text to the E2E viewer; local diagnostics retain only
the session plus numeric status and boolean retryability, never provider-controlled name, message, or
response bodies. Successful malformed endpoint JSON also becomes a stable body-free client error.

**Selected migration contract, not current `Session` behavior.** Every remote proposal—from the web, an official client, automation, or a nested server—must enter one common ordering and decision path before any Claude, Codex, or OpenCode adapter can act. That path stores and signs one final admitted, queued, or rejected result. It records a globally unique journal/command position, but forwards through an independent per-logical-chat actor so unrelated sessions do not wait for one another. Only a signed admission may create one pinned executor attempt; a queued or rejected result creates none. A new message and a steer of a running turn are distinct commands, and neither timing nor native busy state may convert one into the other. The person's direct native-TUI input remains separate from this remote decision path. The native harness observes both paths and remains the authority for their final order and for what actually changed.

Each native adapter must then prove the exact last mile it uses. It translates the admitted common command into one version-pinned native request, sends it through the current fenced front door, and correlates native read-back before reporting the command as applied. A changed translation, unproved route, stale owner, missing observation, or ambiguous response fails closed; a transport ACK alone is never native acceptance. The current `Session` relay does not provide these guarantees.

Nested remote-claw uses the same rule at every server. Before a nested send, the source server jointly finalizes its signed common result and signed lineage; neither half may become visible alone. It accepts semantic completion only from a complete downstream receipt that ties the exact source event, command, chosen target, and target server's signed result together. Edges are installed outward from an already rooted path, commands and observations have opposite directions, and an observation is never turned back into a command. Recursion therefore adds collaborators and server boundaries without feedback loops; the only native app is at the innermost end.

Current A0.2 registration already fails closed on malformed/failed discovery, never adopts “most
recent,” requires an explicit exact target when discovery is non-empty, confirms the selected session
with an exact GET, and withholds its broker bridge until setup reaches `ready`. It keeps
`nativeRef:null`, advertises native `{mutationAdmission:"mixed", history:"partial",
deliveryEvidence:"structured_receipt", liveReattach:false}`, and exposes only proved viewer
capabilities: parent structured permissions after verified setup (or false on opt-out), status false,
interrupt true, other controls false, and attachments false.

The selected OpenCode runtime extends that process-local compatibility attachment with one
epoch-fenced adapter lease enforced by the private HTTP endpoint; SSE plus independent HTTP calls
expose no persistent writer identity, so connection counting cannot provide the fence. It actively
drains SSE before snapshot and reattaches/imports only an exact durable binding. Automatic creation
requires explicit first-bootstrap intent, no existing binding, and a positive empty snapshot; explicit
**New chat** is a separate operation that may create while sessions exist. Both creation paths use a
write-ahead metadata marker. A `prompt_async` 204 or control response is transport evidence only.
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
receives that Claude-specific text, not a native file part, so its current conservative capability
vector advertises `attachments:false`. OpenCode attachments remain unavailable until a retained native
file-part fixture proves their request, observation, and recovery behavior.

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

The diagram shows one current session lane. The registrar/relay/channel portion repeats independently
for every intercepted session; selected A1 replaces its synthetic session-list identity with a
durable host inventory and stable per-chat mapping rather than collapsing those lanes.

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
**broker frame index**, not a transcript `seq`: a negative value selects a tail-relative starting
point (the bus asks for the last 64 retained frames with `-64`, `viewer.ts announces()`); it does not
mean the Workflow backend evicts older chunks. The session tail uses `0` and relies on the orderer,
not the index, for correctness (`viewer.ts transcript()` comment). An `event: error` SSE record throws a terminal
`BrokerError` rather than stopping silently (`sseData`, `client.ts`).

The broker is **at-least-once and not FIFO** (`order.ts` header). Everything below is built to make that
substrate deliver a consistent transcript anyway.

---

## 3a. Dormant A1.6 broker transport

A1.6 implements a second, closed transport contract; it does not strengthen or silently select the
A0 endpoints in §3. Every request is bearer-authenticated and must carry the literal
`x-broker-backend: sqlite`. Omission is `backend_selector_required`; another selector is
`a1_backend_unsupported`. The broker derives the 16-byte machine identity from the bearer, requires
the request's `identity_id` to be its 32-character lowercase hexadecimal form, recomputes the canonical
scope-bus/server-control/chat token and `rcr_*` ID, and rejects a route/auth transplant before storage
lookup (`apps/web/lib/broker/a1-http.ts`). Query-string selection and default fallback do not exist.

`GET /api/a1/capabilities` returns exactly this strict vector
(`packages/clawsec/src/a1-broker.ts`):

```json
{
  "schemaVersion": 1,
  "protocol": "remote-claw-broker-a1",
  "durableCiphertext": true,
  "routeWideDeliveryAttemptUniqueness": true,
  "brokerRecomputesTransportDigest": true,
  "exactRetryReturnsOriginalCursor": true,
  "generationManifests": true,
  "immutableCollisionTombstones": true
}
```

Its canonical digest is `pxq9w0eeR1rKMUyVw5p5Sgl6VU1jdEHAPYlrS93Cbdo`. Open, relay, and subscribe
also require that value in `x-remote-claw-a1-capabilities-digest`. Every A1 JSON response—including an
error—sets `Cache-Control: no-store` and echoes that digest header. The selected Vercel deployment
requires a complete Turso fleet configuration; local/self-hosted conformance may use the file locator
only when no partial Turso configuration is present. Workflow, local, and A0 SQLite providers cannot
advertise this vector.

The operations are:

| Operation | Exact role |
| --- | --- |
| `GET /api/a1/capabilities` | Authenticate, require the explicit SQLite selector, and return the exact vector above. This is the only operation that does not require the digest to have already been pinned. |
| `POST /api/a1/route/open` | Accept strict JSON `{v, identity_id, collaboration_server_id, route_kind, logical_chat_id, route_token, expected_route_store_instance_id}`. The expected store is nullable for an unpinned open; a pinned/recovery open supplies its exact `rbsi_*`. Return `created`/`existing`, the derived route ID, immutable random store ID, capability digest, genesis descriptor, current open-generation descriptor, and sampled `observed_next_frame_index`. |
| `POST /api/a1/relay` | Accept one canonical A1-v2 frame as the raw JSON body plus `x-remote-claw-a1-route-kind`, `x-remote-claw-a1-route-token`, and `x-remote-claw-a1-route-store-instance-id`. Recompute the route and normalized transport-frame digest. Return `inserted`/`exact_retry`, immutable cursor and digest, or a typed 409 collision containing the original cursor/digest, latched first-conflicting digest, and current conflicting digest. |
| `POST /api/a1/subscribe` | Accept the same strict route tuple, non-null expected store, `{version:1, channel_generation, next_frame_index}` position, and `max_frames`. Return one generation descriptor and sampled tail, contiguous canonical frames with cursor/attempt/part/digest, next position, and `at_live_tail`. A page never crosses a generation. |

The provider reserves the store ID in an A1-only catalog before provisioning the route database. The
catalog state is `provisioning`, `current`, or `lost`; a known current store that disappears is latched
`lost` and returns `route_not_found` rather than creating a replacement under the same route. Catalog
recovery may reinstall only an intact physical route with the same store ID. The catalog permits at
most 4,096 retained routes per bearer identity, and the A0 retention index cannot enumerate A1 routes
(`apps/web/lib/broker/a1-sqlite.ts`).

Transport uniqueness is route-wide on `(deliveryAttemptId, part)`, not `msgId` and not generation. A
first insert atomically receives `(channelGeneration, frameIndex)`. The same normalized frame returns
that original cursor even after rollover; different normalized bytes persist the first collision and
return 409 without consuming a cursor. At 4,096 unique frames the publish transaction seals the open
generation with its count, successor, and canonical manifest digest, creates the unique successor, and
inserts the frame at index zero. An internal `seal` hook exists only for backend conformance and empty-
generation tests; there is no public seal endpoint. A drained sealed page, including an empty one,
advances to `(g+1, 0)`; a drained open page stays at its sampled live tail. A1.6 retains every route's
ciphertext bodies, attempt/part originals, collision tombstones, and manifests indefinitely under
ordinary operation. The existing explicitly dev/CI-gated locator `dropScope()` remains destructive
whole-scope cleanup; it is not an A1 retention, checkpoint, revocation, or production recovery rule.
A1.6 has no checkpoint, compaction, or broker-side route-revocation collection rule.

The enforced bounds are 4,450,000 UTF-8 bytes per raw relay body; decoded ciphertext strictly less
than 3,300,000 bytes; at most 32 parts; 8,192 bytes per open/subscribe control body; 4,096 unique frames
per generation; and at most 64 frames and 8,000,000 bytes in the transmitted snake-case HTTP subscribe
response. The CLI independently caps its raw response read at that same byte count; the pure
camelCase semantic DTO is frame/count bounded and does not claim a second wire-size calculation. Bodies are consumed
incrementally rather than through an unbounded `Request.text()`. Safe-integer counter exhaustion fails
with 507. Ordinary errors have exact `{v:1,error:<literal>}` bodies; the closed status set covers
invalid request/selector (400), unauthorized (401), route auth (403), missing route (404), coordinate,
store, capability, generation, and transport collisions (409), oversized frame (413), unsupported
media type (415), invalid read position (416), unsupported backend (501), counter exhaustion (507),
and redacted broker failure (500).

`A1BrokerClient.negotiate()` is the only way to obtain a route-opening client. It uses
`redirect:"error"`, sends the bearer/selector/digest without putting secrets on argv or in returned
records, validates every response header and exact record, re-parses canonical frames, and checks
route/store/cursor/generation/digest continuity. It never automatically retries an ambiguous fetch;
that becomes `A1BrokerOutcomeUnknownError` for caller-owned exact reconciliation
(`packages/cli/src/broker/a1-client.ts`).

Host schema v7 migration `007-a1-broker-routes` has 22 ordered statements, digest
`uShlOvT_fWScwCLQD1g6-GAd1YyKR2QIlGjC0SPQWbw`, and an exact 326-object manifest: 39 tables, 85
indexes, and 202 triggers. It stores only the protected exact-capability pin, immutable route receipt, and open
generation-zero record. Installation requires a current coordinator lease and an `installing` server,
and accepts only a confirmed receipt whose genesis and current generation are both pristine open zero
with sampled next index zero. The host-only installer accepts an already negotiated client, opens
remotely, and then atomically installs those local rows. It retries the identical remote open once
only after an outcome-unknown response. An unknown local commit is resolved by close/reopen plus exact
repository reconciliation; a proved-absent local commit is reported as non-retry-safe because the
remote route may already exist. A1.6 itself attaches no durable ingress cursor/actor,
checkpoint/signature, native effect/outbox, inference, or projection to the route. A1.7a adds the
dormant host-side ingress ledger below; no ordinary CLI command, runtime-owner operation, driver, or
viewer invokes it.

---

## 3b. Dormant A1.7a evidence-preserving ingress

A1.7a advances the host database to schema v8 with migration `008-a1-durable-ingress`. Its 171
statements are locked to digest `6Vf2H56rDvW2PGMrU83upUDz1r9gHP11tdq_w7T1K5E`; the complete
492-object manifest contains 57 tables, 99 indexes, and 336 triggers. Migration preserves every schema-v7 broker route and generation as an
immutable installation receipt. It backfills each route—and auto-seeds each route installed later—with
a route runtime head, an observed generation-zero row, independent fetch and semantic cursors, and an
unclaimed revisioned actor.

The two cursors have different meanings:

- The **fetch cursor** is the next broker position to request. It advances only in the same transaction
  that retains the exact read-page observation, its per-frame claims, and every newly supplied raw
  frame artifact.
- The **semantic cursor** is the next position whose semantic outcome is unresolved. It advances only
  one proven advanceable position or exact sealed-generation boundary at a time and never jumps a
  missing or blocked position. Fetch may run ahead only within the selected 1,024-frame / 64 MiB
  unresolved lookahead.

For every first-seen physical position, the repository retains the received-frame bytes, digest,
length, broker claims, route coordinate, and parsed-header evidence before the position can be
classified. Same-position replay is exact only when the stored length and broker delivery-attempt,
part, and transport-digest claims also match; changed bytes retain position-equivocation evidence,
while changed outer claims retain an `outer_page_invalid` gap. Generation observations admit monotone open tails and one exact
open-to-sealed transition with its immutable manifest; a changed manifest is retained separately.
Page and frame evidence remain bound to the exact route and immutable `rbsi_*` store instance.

The dormant actor claims one route under the current coordinator lease/epoch and advances its stored
revision for each mutation. A successor coordinator may replace a crash-retained claim; a stale,
released, superseded, or expired fence cannot mutate or recover the route. The actor reads at most one
bounded route head, one due assembling result, or one exact reconciliation result on its hot path; the
full route-history read remains diagnostic only.

After route/header validation, chat routes accept only inbound `user` and server-control routes only
inbound `new_chat`. Unsupported or malformed frames become retained invalid positions; an otherwise
valid outbound frame without a known A1.8 host-output ledger becomes `unknown_outbound` and opens a
gap rather than being trusted. AEAD-open plaintext is retained as a protected evidence artifact.
Multipart assembly is bounded to 32 parts, four delivery candidates per semantic result, 48 MiB of
reassembled plaintext, and a fixed five-minute deadline. It retains transport attempts, candidate
counters, immutable part vectors, and every authenticated observation.

The semantic identity is route-scoped `(brokerRouteId, sourceEventNamespaceId, msgId)`, independent
of transport `deliveryAttemptId`. Exact duplicate parts and complete exact replays do not create a
second semantic result. Changed transport bytes, changed stable headers, or changed semantic content
retain collision evidence and tombstones. An incomplete candidate expires durably as
`quarantined_incomplete`; later parts remain `late_after_tombstone` and cannot resurrect it. Invalid
complete payloads, storage quota, page/position/manifest equivocation, transport collision, semantic
collision, and unknown outbound evidence each have explicit gap semantics. A current coordinator may
append one exact recovery decision and resolve the gap without rewriting the original evidence.

When one candidate supplies every exact part, the repository freezes its accepted delivery attempt,
canonical message digest, source payload schema, and source-event fingerprint and changes the result
from `assembling` to `awaiting_order`. That is the terminal success state for A1.7a. Migration 8 and A1.7a add no
common-command, command-result/signature, server-scope signer, result-delivery, checkpoint, outbox,
effect, dispatch, viewer, or native table. A1.7b0 supplies the server-signer prerequisite and A1.7b1
now orders an eligible source and signs a rejected result preparation. A1.8a0 atomically finalizes
only that rejected common/source result into an inert delivery intent; A1.8a1-E1c/I first supplies the
dormant native-binding authority pair after E1b5's full-parent gate, and A1.8a2/A1.8b still own any admitted effect
and sealed publication before a live capability exists.
Ordinary CLI launches, every current driver, runtime-owner RPC,
`HostRcRelay`, and the viewer make zero calls into this actor, so the as-built live protocol remains
the A0 relay in the following sections.

---

## 3c. Dormant A1.7b0 server-signer prerequisite

A1.7b0 advances the host database through migration `009-server-scope-signer` to schema v9 without changing any live wire path. Its only new
durable capability is the server-signer ledger: `server_identity_keys`, `server_identity_private_key_envelopes`,
`server_scope_certificates`, `server_scope_certificate_statuses`,
`server_bootstrap_signing_leases`, `server_signing_leases`, `server_signature_reservations`, and
`server_signed_record_acceptances`. Migration 9 also replaces the existing broker-route admission
trigger so the dormant route installer can attach a route to either an `installing` server or an
exact signer-activated `current` server; the same current-coordinator and capability-pin proof remains
mandatory, and this compatibility change adds no route table or production call path. The v8 statement-count, migration-digest, and 492-object manifest
pins in §3b remain unchanged. Migration 9 has 81 statements, digest
`fYrN5atmwIj-tlT_tTXmrg9kNF52ah-zWmgf7vVFQWE`, and a 571-object manifest: 65 tables, 123 indexes,
and 383 triggers.

The first server identity is installed only through a one-shot, current-coordinator-fenced bootstrap
lease. That lease pins the machine/server, proposed identity key and generation, proposed scope
certificate, protected signing handle, coordinator lease ID and epoch, and fencing token; its only
signing purpose is `scope_certificate`. It creates and verifies the initial self-signature, installs
the immutable certificate/key/status tuple, and opens the normal current signing lease. A bootstrap
or current signing lease under stale, released, superseded, or mismatched coordinator authority cannot
sign or accept a record. Initial
self-anchor is not continuity rotation, and a different key/certificate intent requires new explicit
operator intent rather than silently reusing the old identity.

Coordinator takeover while that bootstrap is not closed is an explicit immutable fail-stop.
Reconciliation returns `writable:false` with `nonWritableReason:"stale_bootstrap_fence"`; v9 cannot
re-fence or replace the bootstrap, and its signing lease cannot be used for another reservation. A
later explicit-repair milestone is required. Once installation has closed the bootstrap, coordinator
takeover instead supersedes the normal current signing lease. After no `reserved`, `bound`, or
signed-but-unaccepted predecessor reservation remains, the successor may acquire a fresh current lease
at exactly the next fencing token.

A1.7b0's callable repository path exercises reserve/bind/sign/accept/reconcile only for that
`initial_pair` scope certificate and can acquire the installed current lease under a successor
coordinator fence. Generic current-lease signing, explicit repair, rotation, revocation, and historical
reattestation remain frozen record/schema states for later tranches.

The owned-file custody backend exposes signing, self-test, and close capabilities, never raw PKCS#8.
It wraps the Ed25519 private key with AES-256-GCM under a distinct server-key HKDF domain. Its canonical
AAD binds the machine identity, collaboration server, protected handle, identity key ID, generation,
algorithm, literal `owned-file` backend, public key, and PKCS#8 digest. Changing any coordinate, the
ciphertext/tag, or the root secret makes unwrap fail; the plaintext and derived wrap key are wiped from
temporary buffers after use.

The frozen normal-signing state machine requires the exact current signing lease and a durable server-wide
signer sequence. A
reservation first burns that sequence, then binds the closed purpose, its exact canonical payload
schema/reference/digest, and target artifact. Only those bound bytes may be signed. The signed
transition retains the Ed25519 signature and signed-record digest before returning the result; an
acceptance row is immutable and tied back to that exact reservation. Acceptance allocates the next
dense per-server `acceptedAtJournalSeq`; this is the signer-acceptance journal coordinate, not an
expansion of schema-v3 `control_journal_entries`. Exact replay returns the retained state, changed
replay collides, stale authority fails, an unbound reservation may be aborted without reusing its
sequence in the frozen state contract, and request-bound reconciliation distinguishes a committed
operation from a proved-absent one after an unknown local outcome. A1.7b0 exposes no generic abort
operation.

The dormant orchestrator stores the bootstrap-intent artifact with `prepare` and the canonical
certificate artifact with `bind` in the same synchronous SQLite transactions. If any prepare, bind,
signed-store, finalization, or successor-lease `COMMIT` becomes unknown, it closes the poisoned
handle, securely reopens, and reconciles the exact retained phase before continuing or retrying a
proved-absent phase. A normal process restart reconstructs reserved, bound, signed, or closed state
from the durable graph and custody-self-tests the retained envelope before doing more work; it never
generates a replacement key once bootstrap evidence exists. Successor signing-lease acquisition is
likewise admitted only after the retained envelope verifies under the current custody root.

This is custody and authority infrastructure, not command adjudication. No A1.7b0 operation consumes
an A1.7a `awaiting_order` row or creates a common command, admitted/queued/rejected decision, command
result, generic host output, broker publish, result-delivery row, checkpoint, outbox/effect, native
attempt/dispatch, inference record, viewer projection, or native table. The signer is absent from
ordinary CLI launch paths, all real drivers, runtime-owner RPC, `HostRcRelay`, and the viewer. Full
A1.7b1 now uses the installed current lease only through the dormant command-result path below.

---

## 3d. Dormant A1.7b1 command adjudication

A1.7b1 advances the host through migration `010-common-command-adjudication` to schema v10 without
changing the A0 wire or production runtime. Migration 10 contains 50 ordered statements, is locked to
digest `rdJC_2C5IyjfsTuXhxjFSzT0bvDYtlpT8o0xDvu4IEk`, and produces an exact 619-object manifest: 70
tables, 137 indexes, and 412 triggers. It adds only these five tables:

- `command_ready_entries`
- `a1_ingress_adjudications`
- `collaboration_commands`
- `collaboration_command_compound_signing_groups`
- `collaboration_command_result_preparations`

It adds no `collaboration_command_results`, command-result signer-acceptance row, generic host-output, result-delivery,
outbox, effect, native-attempt, dispatch, projection, or native table. The only new v9 signer purpose
reachable in schema v10 is `collaboration_command_result` under an exact current signing lease; the
bootstrap scope-certificate path and all earlier migration pins remain unchanged.

Ready materialization is A1-ingress-only. The repository requires a current coordinator and a
signer-activated current server, a current route with zero active gaps, and that route's earliest unadjudicated complete
`awaiting_order` result. It atomically stores the command, ready row, and ingress sidecar and consumes
the server's exact next `nextJournalOffset`. Secure reopen validates the union of
`control_journal_entries` and `command_ready_entries` as one unique, contiguous sequence from zero to
that offset; the ready journal is not a second independent counter. A server may retain at most 256
unresolved commands.

For an A1 source, the stable source identity and command are:

```text
sourceCommandIdentityDigest =
  SHA256(str("remote-claw/command-source/a1/v1") || bytes(identity_id) ||
         str(collaborationServerId) || str(scopeKind) || optionalStr(logicalChatId) ||
         str(sourceEventNamespaceId) || str(sourceEventId))

commandId =
  "rcm_" || base64url(SHA256(str("remote-claw/collaboration-command/v1") ||
         str(collaborationServerId) || str("a1_ingress") ||
         bytes(base64urlDecode(sourceCommandIdentityDigest))))
```

The pure `@remote-claw/clawsec` contract has exact canonical payload codecs, including scalar
`user_text` up to 48 MiB. A1.7b1 persistence intentionally does not copy that potentially large
plaintext out of A1.7a's retained segmented evidence. For both currently recognized A1 ingress
families (`user_text` and `new_chat`), it stores a small
`remote-claw/command-payload/unsupported-recognized/v1` envelope containing the normalized family,
source payload schema, canonical message digest, and source-event fingerprint. That envelope is not
truncation: those fields commit the complete A1.7a source evidence. Because this tranche has no target
capability or effect arm, its only callable policy outcome is `rejected`.

Decisions are server-global: the repository may decide only the minimum
`(readyAtJournalSeq, commandId)` among ready commands and compare-and-swaps the exact next dense
`nextCommandSeq`. It rechecks that the retained source route is still current and gap-free. The
command keeps its creation coordinator lease/epoch and `createdAtMs`; a successor current coordinator
may supply the separately retained decision lease/epoch and monotone `decidedAtMs`. A decision never
rewrites creation provenance.

The rejected decision freezes the canonical decision evidence and command-record digest, allocates
one version-one result, and reserves a compound group and result preparation. Their identifiers are:

```text
commandResultId =
  "ccr_" || base64url(SHA256(str("remote-claw/collaboration-command-result-id/v1") ||
         str(collaborationServerId) || str(commandId) || uint(1)))

compoundSigningGroupId =
  "csg_" || base64url(SHA256(str("remote-claw/collaboration-command-signing-group/v1") ||
         str(collaborationServerId) || str(commandId) || str(commandResultId) ||
         uint(preparationGeneration)))

commandResultPreparationId =
  "crp_" || base64url(SHA256(str("remote-claw/collaboration-command-result-preparation/v1") ||
         str(collaborationServerId) || str(commandId) || str(commandResultId) || uint(1) ||
         uint(preparationGeneration)))
```

The decision transaction advances both the command sequence and signer sequence, stores the exact
result payload artifact, and reserves generation one. The dormant signing orchestrator binds the v9
reservation to artifact type `collaboration_command_result_preparation` and the exact `crp_*`, signs
through wrapped custody, and stores/verifies the signature before returning. Exact replay is
byte-identical. An unknown commit closes the poisoned database, securely reopens it, and reconciles
the exact durable phase before continuing; a proved-absent signing store reuses the already produced
signature and does not sign again.

Only `reserved` or `bound` preparations can abort. Abort burns their signer sequence and atomically
marks the reservation, preparation, and group aborted. Reprepare allocates the next signer sequence,
increments `preparationGeneration`, points `supersedesPreparationRef` at the exact aborted predecessor,
and derives new `csg_*`/`crp_*` IDs. It retains the same frozen command ID, `commandSeq`, rejected
disposition, command-record digest, `ccr_*`, and original decision time; the replacement preparation
uses a later monotone preparation time and may repeat for later generations.

The maximum reachable successful state in A1.7b1 is command `decision_reserved`, ingress sidecar
`deciding`, preparation `signed`, compound group `result_signed`, and signer reservation `signed`.
Schema triggers and semantic reopen reject command `decided`, ingress `terminal`, group `finalized`,
and any acceptance or final-result graph in schema v10. A1.8a0 now supplies one atomic rejected-only
transaction for the final common result, signer acceptance, logical ingress terminalization, and
inert delivery intent. A1.8a1-E1c/I must first retain and atomically install the exact dormant native
authority pair; A1.8a2 must then create an admitted decision's pinned native attempt,
front-door dispatch, and one-use effect gate, while A1.8b must seal/publish. A signed preparation or
plaintext `pending_seal` intent alone never authorizes delivery or mutation.

The command repository is attached to the secure host-state database, but no ordinary CLI, driver,
runtime-owner RPC, relay, or viewer operation invokes it. The signing orchestrator remains outside the
production import graph. All live traffic therefore continues to use the A0 relay below.

---

## 3e. Dormant A1.8a0 rejected-result finalization

A1.8a0 advances the host through migration `011-a1-rejected-result-finalization` to schema v11
without changing any live wire or production runtime. Its 38 ordered statements are locked to digest
`SkkuAFJed-7GT9XyXXPCub7VFauqNY6eu0u4IQJEInc`; the exact 647-object manifest contains 73 tables,
147 indexes, and 427 triggers. It adds exactly these three tables:

- `collaboration_command_results`
- `a1_ingress_terminal_results`
- `a1_ingress_result_deliveries`

The dormant repository accepts only a signed schema-v10 `rejected` result preparation with
`requiredFinalizationArtifactKind:"none"`. One SQLite transaction inserts the immutable common
command result, the next dense `server_signed_record_acceptances` row, a logical terminal result, and
one causal result-delivery row; moves the command from `decision_reserved` to `decided`; moves its
A1 adjudication sidecar from `deciding` to `terminal`; and stores the exact compact semantic payload
as a protected artifact. The existing preparation, group, and reservation deliberately remain
`signed`/`result_signed`/`signed`; their exact accepted result and terminal graph are the durable
consumption witness. Partial graphs are invalid, and unknown `COMMIT` closes the poisoned handle,
securely reopens it, reconciles the complete request-bound graph, and retries only after proving the
transaction absent.

For a chat `user`, the protected semantic payload uses schema
`remote-claw/a1-action-result/v1` and exact compact JSON key order:

```text
{"v":1,"result_id":"rrs_*","source_msg_id":"...","source_record_kind":"user","decision":"rejected","command_seq":N}
```

For server-control `new_chat`, it uses schema
`remote-claw/a1-chat-creation-result/v1`:

```text
{"v":1,"result_id":"rrs_*","source_msg_id":"...","decision":"rejected","target_logical_chat_id":null,"command_seq":N}
```

In both cases `ingressResultId` equals the existing `stableSemanticResultId`. The artifact digest is
SHA-256 of the exact payload bytes. The separately stored semantic digest is:

```text
SHA256(str("remote-claw/a1/stored-semantic-result/v1") ||
       str(semanticResultPayloadSchemaId) || bytes(exactCompactUtf8Payload))
```

The terminal trigger is the unique `rio_*` observation for the accepted delivery attempt with
`disposition:"new_part"` at the lexicographically greatest `(channelGeneration, frameIndex)` among
exactly one observation for every part `0..N-1`. No channel cursor advances. The initial delivery ID
is deterministic:

```text
"rrd_" || base64url(SHA256(str("remote-claw/a1/result-delivery/v1") ||
                           str(stableSemanticResultId) ||
                           str(triggerIngressObservationId)))
```

Its `rda_*` delivery-attempt ID is a once-allocated random 128-bit value. The row fixes
`targetKind:"a1_broker"`, `targetRef:brokerRouteId`, semantic payload refs/digests, and
`state:"pending_seal"`. That state is an inert plaintext semantic intent, not an encrypted broker
frame or a dispatchable outbox: schema v11 defines no claim, ciphertext/output part, output
signature, seal, publication, retry, or broker operation.

Finalization does not require the source route to remain current or gap-free after the rejection was
signed. The immutable schema-v8 `authenticated_ingress_results` evidence remains `awaiting_order` or
may later become `quarantined_collision`; neither a post-sign collision nor exact
`discard_and_close_source` recovery erases or deadlocks the signed rejection. A narrow takeover rule
lets the exact current live successor coordinator accept a command-result signature made under the
now-superseded predecessor lease only when it was stored no later than supersession, that predecessor
was valid at signing time, no intervening signing lease exists, and the same current identity key,
generation, scope certificate, and custody record remain intact. The predecessor's lease stays the
signature's maximum fence, `historicalReattestationId` stays null, and the common result, terminal
row, acceptance, and `pending_seal` row must land together. Any later successor signing lease must
be durably acquired strictly after the predecessor acceptance, even across a same-millisecond
wall-clock tie. This does not authorize generic
superseded-lease acceptance, key rotation, retired certificates, or historical reattestation.

The pure result contracts live in `packages/clawsec/src/a1-result.ts`. In addition to the
schema-v11 rejected payloads, that browser-safe module freezes the exact `accepted` projection and
admitted `chat_creation_result` bytes for later A1.8a use. Those codecs create no durable result,
projection, capability, attempt, effect gate, or dispatch authority. Schema/repository/reopen
closure live in `packages/cli/src/host/state/{migration-v11,command-result-finalization,command-adjudication-repository,command-adjudication-validator}.ts`;
and the crash-reconciling composition is the dormant
`packages/cli/src/host/server-signer/command-result-orchestrator.ts`. None is invoked by an ordinary
CLI, driver, runtime-owner RPC, relay, viewer, or broker route. A1.8a1-E1c/I first supplies the dormant
native-binding authority foundation; A1.8a2 still owns the admitted attempt/front-door-dispatch/effect
arm, and A1.8b owns sealing and publication. A1.7b1 plus A1.8a0
therefore still advertise no capability.

A1.8a1-E0/E1a/E1b1/E1b2 live in
`packages/cli/src/host/state/{ids,native-binding-authority,native-binding-authority-evidence,native-binding-authority-executable-evidence,native-binding-authority-workspace-evidence}.ts`,
their tests, the host-state barrel, and direct-only
`packages/cli/src/host/native/{linux-executable-collector,linux-workspace-collector}.ts`. E0 exports the six E-side ID contracts
and four deterministic builders. E1a exports four strict parent parsers/writers/decoders, a ref-free
commitment registry, and a bounded raw digest helper. E1b1 exports both executable-manifest codecs
and directly collects stable content only when called. E1b2 exports the four workspace leaf codecs and
raw-five-view verifier, while its Linux collector runs only when called; no driver, runtime-owner
operation, relay, viewer, or broker path calls either collector. The retained native proof/probe/verifier live under
`spikes/opencode-native/` and retain no raw executable or chunk bytes.

---

## 3f. A1.8a1 native-binding authority (E0/E1a/E1b1/E1b2 implemented; E1b3 design frozen; E1b3–E1b5/E1c/I implementation planned)

A1.8a1-E0, E1a, E1b1, and E1b2 introduce no protocol packet or live operation. E0 freezes the six E-side ID
namespaces/parsers and four deterministic derivations. E1a freezes the four canonical parent DTOs and
their strict canonical bytes. Each parent commitment is exactly
`role + artifactSchemaId + decoded artifactDigest + byteLength` in its fixed role order and excludes
all `rcph_*`. The future recipe likewise commits to each parent by schema, digest, and byte length,
not ref; refs are future repository-local graph locators only. E1b1 freezes 1 MiB source chunks, a
256 MiB source ceiling, 64 KiB canonical manifest artifacts, strict role/schema correlation, and a
two-pass same-descriptor collector. That proves only stable native executable content. The remaining
boundaries are:

1. **A1.8a1-E1b1 (implemented):** strict native/front-door executable-manifest codecs plus a
   direct-only stable-FD Linux collector and retained real native OpenCode 1.17.5 vector. The
   generic collector is tested for the front-door role, but no actual front-door observation or
   provenance is retained; no pathname, process, front door, currentness, complete parent, or
   authority is proved.
2. **A1.8a1-E1b2 (implemented; proof gate passed):** strict runtime-scoped mount-namespace →
   canonical-directory → filesystem-identity → allowed-root-ancestry codecs close the exact digest
   DAG. The raw-byte verifier snapshots, reparses, canonically re-encodes, and hashes four leaf views
   plus separately supplied E1a workspace-parent bytes. The direct-only Linux collector synchronously
   resolves allowed root and target as independent no-follow chains from one root, rejects a mount
   crossing below the allowed root, and returns only the four historical leaf artifacts. The
   non-skipping gate uses direct unprivileged `unshare -Ur -m` on capable hosts; hosted CI performs
   only fixed privileged namespace/mount setup, then asserts capability-free non-root execution before
   package code while exercising the same real namespace and bind-mount behavior.
   Exact DTOs/formulas and the executable gate are in the
   [technical reference](client-driven-host-runtime-reference.md#41-a18a1-native-binding-authority-freeze-planned-dormant).
3. **A1.8a1-E1b3 (design frozen; implementation planned):** E1b3a adds only four pure leaf codecs and
   the deterministic dormant Node-ESM front-door build. E1b3b collects that exact bundle, retains the
   complete pinned OpenCode 1.17.5 `/doc` body, compares the four sealed role registries item-for-item,
   and verifies `N,X,B,S,R,D` plus separately supplied E1a listener-parent bytes. The bundle contains
   only output-independent declarations and symbol IDs; binary-, closure-, registry-, measured-, and parent-
   dependent identities are post-build sidecars. The only positive routes are binding `user_text`
   `POST /session/{sessionID}/prompt_async` and five observer routes; retained `S` must prove the
   selected status route or E1b3b blocks. TUI/server-creation are deny-only,
   every other OpenAPI operation has an explicit closed disposition, and no wire listener or operation
   is installed.
4. **A1.8a1-E1b4:** close process, socket, policy, peer, namespace, and isolation-parent evidence.
5. **A1.8a1-E1b5:** close the remaining capability child codecs and reproduce all four E1a parents.
6. **A1.8a1-E1c:** retain and cryptographically close the exact workspace, listener-registration,
   runtime-isolation, operation-family, binding-capability-snapshot, and snapshot-attestation graph.
   Neither existing `NativeTransportLeaseRecord` pointer changes: first-install evidence leaves
   null/null, while replacement evidence leaves the predecessor pair intact. A valid accepted
   signature is evidence, not ingress authority. A changed workspace requires withdrawal and a new
   lineage; pre-E1c E-purpose signer rows are exhaustively quarantined and never adopted;
   `capability_prepared` retains only the unsigned snapshot artifact plus its reservation; and
   `accepted_inert` co-lands normalized snapshot, attestation, and acceptance. Caller-retained
   requests are ref-free, while their caller-retained `nbao_*`, repository-owned artifact links, and
   dense transition receipts prove exact historical reconciliation; no second operation token exists.
7. **A1.8a1-I:** after E1c, install or replace the accepted snapshot and a credentialless authenticated
   callable-port ingress lease in one SQLite transaction. The only valid pointer states are
   null/null or one exact current pair. Parent close, detach, transport replacement, takeover, or
   loss of the process-memory port must withdraw the pair before another becomes writable.

The ingress handle reuses the in-process callable port already named by the current A1.4 native-
conversation lease on the authenticated runtime-owner RPC channel. The live registry entry binds its
connection, server, binding, runtime/incarnation, attachment, owner/coordinator fences, and port
generation; the durable lease/snapshot graph jointly binds the logical chat, conversation, workspace,
capability generation, family digest, and channel evidence. It contains no endpoint or credential
that can be replayed elsewhere. Secure reopen validates the durable pair; it cannot prove the volatile port is
live, so restart readiness additionally requires the exact registry entry and otherwise fails closed.
Authority withdrawal only compare-and-swaps the exact durable pair; it never unregisters this shared
physical handle. The A1.4 parent owner alone unregisters it when closing or replacing the exact parent
lease, after withdrawing any current pair, so a late predecessor cleanup cannot disable a successor.
Unknown commit closes/reopens and reconciles one caller-retained operation identity; changed retained
bytes collide. A proved-absent I prepare/install retries only while that same A1.4 lease/port remains
live. A landed preparation is successor-aborted and burns its retained generations; an absent
preparation burns none, so a new operation may reuse the still-next derived ingress generation after
the parent lineage is recovered. Withdrawal is DB-only: an absent `nbaw_*` may exact-retry under the
current successor fence or be replaced by a fresh successor-fenced cleanup even when no port is live.

E1c must progress through listener, isolation, and capability reservations in dependency order and
must never pretend a payload exists before the preceding signed-record digest. Its exact
`capability_prepared`/`accepted_inert` row staging is frozen as described above. The eventual schema must
bar key rotation/revocation while one of those phases is nonterminal, and an installed pair must be
withdrawn before its signing key rotates. This prevents a stored signature from becoming permanently
unacceptably bound to a retired key.

These planned stages do not relax schema-v10/v11 rejected-only rules and do not create or consume an
admitted result, `nat_*` attempt, front-door dispatch, effect gate, dispatch authorization,
`pending_seal` delivery, native call, broker frame, projection, or cursor. A1.8a2 and A1.8b remain the
first planned consumers. Current A0 wire behavior is unchanged.

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
  event to zero or more content frames (`mapUpstreamItems`), allocates a `seq`, seals, and POSTs it.
  On a non-durable backend `#emit` also appends the frame to host `#log` for `catch_up`; on a durable
  backend the broker frame log is history and host `#log` stays empty.
- **INBOUND** `#pumpInbound` — tails the session channel for `dir:"in"` client frames, dedups by `msgId`
  in `#seen`, and drives the worker: a `user` prompt is `accepted`-acked, echoed as a `user` content
  frame, and injected (`Session.pushUserInput`); a `catch_up` replays host `#log` only on a non-durable
  backend and is ignored when durable broker subscription supplies history; a `permission` answers a
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

Two authenticated cursor routes expose these facts without a transcript body. `GET /api/seq` reports
the effective backend's `durable` flag and highest transcript `seq`: the host uses the high-water to
resume outbound allocation, and the viewer uses `durable` to choose full broker replay versus its
non-durable incarnation-recovery path. Host-only `GET /api/frame-count` reports the publish-order
frame count, which becomes that durable relay incarnation's fixed inbound `startIndex`. Neither is an
alternate message or discovery API.

---

## 9. Presence: `session_announce`

Presence rides the meta-plane `session_announce` on the identity bus — idempotent and `seq:null`. It is
never appended to the host's process-local `#log`, so re-announcing is cheap
(`relay.ts` `#sendAnnounce`); a durable broker profile may still retain the sealed bus frame. The host
folds live state onto **every** (re-)announce:

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
sub-`window` interaction. `FRESH_WINDOW_MS` (60 s) is the **separate direct-control expiry-stamping
window** (§11), **not** the disconnect threshold — decoupled so widening disconnect cannot widen
direct-control acceptance. `catch_up` is stamped with the same value but the current host does not
enforce it, so it is not a replay bound for that branch. The
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
   worker, emits an unordered, replayable `permission_resolved` meta frame (so a reload renders the request
   as answered, not re-prompting, #56/#57), and re-announces so `needs` clears.

The viewer's `PermissionRow` renders `effective = confirmed ?? decision`: the replayed resolution
(`confirmed`, folded from the transcript's `permission_resolved` frames) **wins** over the local
optimistic `decision`, so a granted permission survives a reload (`page.tsx`). A durable broker replays
that sealed frame from its log; on a non-durable profile the host retains it in `#log` and re-emits it for
`catch_up`.

Here `permission_resolved` confirms only that this relay selected and queued a response. It is not a
native Claude terminal result: the TUI may have answered first, Claude may cancel the request, or tool
execution may settle it differently. Current interrupt/end paths can also clear relay gates before
native terminal evidence. The selected runtime persists remote choice, worker delivery, and native
cancel/tool/gate outcome separately, and closes every outward copy from the proved native terminal
record rather than treating local deletion as adjudication.

For tmux, the downstream response is ACKed only after the private decision file is written. A write
failure throws, leaves that response unacknowledged, and tears down the inject pump. The helper may
remain blocked and the relay may already have projected its own resolution, so this is fail-closed
transport behavior rather than proof of Claude's terminal permission outcome.

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
5. **Presence reflects only the driver's evidence.** On Claude MITM, `phase`/`needs` mirror the
   worker's `PUT …/worker` (`worker_status` + `requires_action_details`) and there is no host-side
   timeout. If the worker finishes a turn but never PUTs `idle`, `phase` shows *thinking* until the
   next status change. Tmux has no equivalent signal: it uses transcript timing internally and
   advertises `capabilities.status:false`, so consumers must not treat that projection as native
   busy/idle truth.
6. **`git` is a launch-time snapshot** (`launch.ts`) — a mid-session branch switch isn't reflected until
   the native process is relaunched. Current A0 also creates a new broker-visible session; A1 may retain
   the logical chat while refreshing this launch snapshot for the new native incarnation.
7. **There is no durable host-wide session inventory in A0.** Process-local registrar leases keep live
   sessions separate, but a wrapper/coordinator restart cannot enumerate all prior Claude, Codex, and
   OpenCode bindings and independently reattach them. The selected A1 host inventory and per-chat
   recovery lanes must land before restart multiplicity can be advertised.
8. **Tmux cleanup preserves uncertainty but does not recover it.** Each launch has a private `0700`
   runtime, private socket, and private settings/hook files. Teardown removes them only after a proved
   kill or proved absence. An unknown tmux outcome retains the runtime and emits the exact
   `tmux -S <socket> attach -t <session>` command; a new wrapper still cannot adopt that pane because
   the A0.2 registrar/binding is process-local and `liveReattach:false`.
9. **A1.6 transport through A1.8a0 rejected-result finalization is still not a live collaboration path.**
   The selected provider/client, schema-v7 route installer, schema-v8 evidence-preserving ingress
   repository/actor, schema-v9 server signer, schema-v10 command adjudicator, and schema-v11 rejected
   finalizer are implemented and tested, but ordinary CLI
   launches, drivers, runtime-owner RPC, `HostRcRelay`, and the viewer do not invoke them. A dormant
   `pending_seal` intent is neither a sealed/published result nor delivery, authorization, effect, or
   viewer projection. A1.8a1-E0 supplies identity vocabulary, E1a supplies ref-free parent
   envelopes, E1b1 supplies direct-only executable-content manifests/collector without path,
   process, front-door, currentness, complete-parent, or authority proof, and E1b2 supplies
   historical-only workspace codecs/verifier/collector without currentness, process, authority, or
   production proof. E1b3's design is frozen but its implementation gate, E1b4–E1b5 closure, E1c
   stateful evidence, I install, A1.8a2 admitted
   arming, A1.8b sealing/publishing, and later milestones must
   land before A1 can replace the A0 relay described above.

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
