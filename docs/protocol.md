# Protocol and runtime

This document describes the code that runs today. The broker protocol is intentionally small: an
authenticated client publishes and subscribes to end-to-end encrypted frames on an identity bus or a
session channel. The host translates one native coding-agent session into that frame stream; the web
viewer translates it back into a transcript and controls.

The full Claude Code, Codex, OpenCode, and tmux product goal and release status live in
[release-finish-line.md](release-finish-line.md). One important limitation belongs here too:
the default `--rc-driver=mitm` path intercepts Claude's Remote Control endpoints and
serves them locally, so that Claude session does **not** register with Anthropic Remote Control and the
official Claude app cannot attach. `--rc-trace` does the opposite—it passes Remote Control through to
Anthropic but does not bridge the session to remote-claw. The Linux/exact-2.1.237
`--rc-driver=claude-native` path now keeps ordinary Anthropic Remote Control active while projecting
provider-ordered text to remote-claw, including an explicit exact-session restart attachment. Literal
official Claude web UI acceptance and the Graduate commit's separate exact-SHA deployed-broker
gate passed.

## 1. Topology

```text
native agent / Claude worker
           ⇅
driver → in-memory Session → HostRcRelay
                              ⇅ sealed HTTP/SSE
                        untrusted broker
                              ⇅ sealed HTTP/SSE
                     browser ViewerClient
```

The default `mitm` driver runs the real `claude` behind a local TLS proxy. In the ordinary Anthropic
profile it intercepts `/v1/code/sessions/**` and `/v1/code/triggers` while `/v1/messages`, OAuth,
telemetry, and unrelated traffic tunnel to Anthropic. With `--rc-inference=bedrock`, remote-claw
translates inference to Bedrock and synthesizes the required Anthropic control plane, so no request
reaches Anthropic. The `claude-native` launch form instead uses the proxy transparently to observe one
exact successful bridge, then uses Anthropic history/SSE/text POST as an app client. Its attach-only
form accepts an explicit exact native session ID and starts no interactive Claude session or proxy;
the pinned-version probe still runs. The experimental
OpenCode adapter and tmux fallback reach the same `Session` seam through their own native surfaces.
See
[pluggable-harness.md](pluggable-harness.md).

The broker is a ciphertext router. Its active API is:

| Route | Purpose |
| --- | --- |
| `POST /api/relay` | Publish one encrypted wire frame. Add `?session=<id>` for a session channel; omit it for the identity bus. |
| `GET /api/stream` | Subscribe to a channel as SSE. `startIndex` resumes from a publish-order offset. |
| `GET /api/seq` | Report whether the selected backend is durable and its highest transcript `seq`. |
| `GET /api/frame-count` | Report the durable publish-order length used to fence old inbound commands after a host restart. |

`x-broker-backend` or `?backend=` selects `vercel`, `local`, or `sqlite` when that backend is allowed by
the deployment. `sqlite` is the durable production profile and may use local libSQL files or Turso.
`local` is process memory. The Workflow backend is retained as a compatibility backend but does not
provide the paired durable recovery cursors.

## 2. Identity, keys, and admission

A 32-byte root secret derives one machine identity with HKDF-SHA256:

```text
auth_token   — bearer admission token
identity_id  — first 16 bytes of SHA256(auth_token); public routing identity
content_root — derives one K_session per session id
control_key  — protects browser-to-host controls
K_meta       — protects presence and acknowledgements
```

The root secret is not sent to the broker. A viewer pass (`rcp1_…`) contains the four operational key
values, not the root secret; it can read and steer that machine but cannot recover the root secret. A
pass is therefore a bearer credential and must be protected as such. One-time QR handoff is documented
in [ephemeral-handoff.md](ephemeral-handoff.md).

Every broker request uses `Authorization: Bearer <hex(auth_token)>`. The broker recomputes
`identity_id` from the bearer instead of trusting a caller-supplied identity. That gate controls
addressability, not confidentiality: payload integrity and secrecy come from AES-256-GCM between the
host and viewer.

The shipped host and viewer use the sealed provider. An explicit `open` provider also exists for local
development; it places plaintext in the frame's `ct` field and therefore trusts the broker completely.
It is never an implicit fallback.

## 3. Wire frames and channels

The JSON wire envelope is defined by `packages/clawsec/src/wire.ts`:

```text
v, identity_id, session_id, dir, record_kind, seq, msg_id,
client_msg_id?, key_epoch, salt, nonce, ct, part, parts
```

`identity_id` is lowercase hex. `salt`, `nonce`, and `ct` are canonical unpadded base64url. The decoder
strictly bounds and validates every routing field, byte length, integer, direction, and chunk
coordinate before a frame reaches crypto. Extra JSON fields are ignored; every required field must be
an own data property.

All clear header fields, including `client_msg_id` and chunk coordinates, are encoded in fixed order as
AES-GCM additional authenticated data. A broker can read those routing fields but cannot alter one,
move ciphertext between sessions, or swap chunk indices without authentication failing.

There are two channel kinds:

- The identity **bus** carries only `session_announce` and `session_terminal`.
- A **session channel** carries transcript content, browser commands, acknowledgements, and permission
  state for one `session_id`.

The relay route enforces that split from authenticated identity plus the AAD-bound header. It also
requires the URL's `?session=` to match the frame's `session_id`, rejects the internal close sentinel,
and caps decoded ciphertext below the deployment edge's request-body ceiling.

### Record planes

`packages/cli/src/broker/protocol.ts` is the executable taxonomy:

| Plane | Key | Current record kinds |
| --- | --- | --- |
| Content | per-session `K_session` | `user`, `assistant`, `assistant_sub`, thinking variants, `result`, `system`, `status`, `rate_limit`, `can_use_tool`, `tool_use`, `tool_result`, `task`, `permission_request` |
| Control | `control_key` | `catch_up`, `permission`, `interrupt`, `set_mode`, `set_model`, `command`, `end`, `attachment` |
| Meta | `K_meta` | `accepted`, `session_announce`, `session_terminal`, `permission_resolved` |

Unknown kinds fail instead of being assigned a guessed key. Content carries a numeric transcript
`seq`; control and meta generally use `seq:null`. Direction is `out` for host publications and `in`
for browser actions.

Large messages are split into independently authenticated parts with one `msg_id` and `seq`. `part`
is zero-based and `parts` is the total count. The receiver opens every part and the complete group
before using the reassembled plaintext.

## 4. The Claude Remote Control adapter

### 4.1 Private facade

In the default `--rc-driver=mitm` mode, `packages/cli/src/host/rc/mitm.ts` implements the worker-facing subset of Claude's
Remote Control service:

- `POST /v1/code/sessions` creates a fresh `cse_*`, mints a session-scoped worker bearer, and queues
  `initialize` before making the session discoverable.
- `POST /v1/code/sessions/{id}/bridge` returns the local API base, worker epoch, and bearer.
- `GET|PUT .../{id}/worker` reads status or accepts the observed authenticated, epoch-bound status,
  registration-metadata, and connection-metadata update shapes.
- `POST .../{id}/worker/events` admits an upstream native event batch.
- `POST .../{id}/worker/events/delivery` records worker delivery acknowledgements.
- `GET .../{id}/worker/events/stream` streams downstream events to Claude over SSE.

Every worker route requires the session-scoped bearer. A closed known session returns `410` before
route-specific parsing; malformed or contradictory worker mutations close that session.

The stable native-event intake is intentionally closed to the eight observed types:
`assistant`, `control_cancel_request`, `control_request`, `control_response`, `rate_limit_event`,
`result`, `system`, and `user`. It also requires the current worker epoch and an RFC 4122 UUIDv4 in
each payload. An exact UUID-and-bytes replay returns the original event coordinate with
`duplicate:true`; the same UUID with changed normalized bytes is a collision and closes the session.
Generic compatibility drivers use `Session.pushUpstream` and do not claim this native identity rule.

Only the newest Claude worker SSE stream may deliver downstream events. Once the proxy attempts to
write a mutating event other than the locally minted `initialize`, it never offers that event to a
later worker stream, even if the socket or delivery acknowledgement is lost. This prevents automatic
duplicate turns but is only an at-most-once transport attempt—not evidence that Claude applied the
event.

`--rc-trace` uses the same interception machinery as a transparent inspector. It forwards RC to
Anthropic and records redacted protocol shapes; it creates no broker bridge.

### 4.2 Provider-native text companion

The launch form, `--rc-driver=claude-native --remote-control`, runs ordinary Claude through that
transparent proxy and binds only after the spawned child completes a successful canonical
`POST /v1/code/sessions/{cse_*}/bridge`. It inspects no bridge body or worker bearer and rejects a
second different binding. The restart form,
`--rc-driver=claude-native --rc-native-session <cse_...>`, requires the exact canonical ID explicitly,
accepts no forwarded Claude arguments, performs no discovery, and starts no interactive Claude session
or proxy; the pinned-version probe still runs.
Both give the remote-claw projection a fresh random `cse_*` distinct from the native session ID; the
restart form never revives or consumes commands from the retired projection.

One reconciler owns provider order. It opens and validates one client SSE stream before paging bounded
ascending history, follows `next_cursor` or `resume_cursor` under cursor/page/event caps, sorts by
arbitrary-precision provider sequence, and then drains the already-open stream. Reconnect pauses new
writes, opens the replacement stream first, reconciles history, and resumes only after continuity is
restored. Exact provider repeats are no-ops; a changed event identity, reused sequence, or unseen event
behind the committed high-water mark closes the projection. Opposite-source client/worker replicas with
the same provider user UUID and normalized text are one logical prompt whichever source arrives first;
optional worker identity enrichment is validated but need not be byte-identical. Attachment-bearing
user replicas remain non-projectable even if a later worker echo rewrites their text.

Top-level text user events, worker assistant text, and worker text results are projected. Nested/nontext
user records and unknown controls stay native; invalid pinned identity fields fail closed. Browser text
uses one UUID and timestamp through broker admission and provider POST. A seq-less
`{native_pending:true}` acceptance means only that the host admitted the command. Provider history/SSE
then publishes the canonical accepted coordinate and user row in provider order. One serialized writer
issues no automatic retry; a rejected or outcome-unknown POST fences the projection before any
successor. Accepted provider events and browser mutations share a fixed lifetime ceiling; exhausting it
fails only the projection instead of growing companion state without bound. Projection or broker
failure closes only that remote-claw projection. In launch form the transparent proxy and healthy
Claude child remain running; in attach-only form the companion exits nonzero while the independently
owned native session remains live.

## 5. `Session` and the relay

`packages/cli/src/host/rc/session.ts` is one in-memory event bus:

- Downstream events are `initialize`, remote `user` input, control requests, and permission responses.
- Upstream events are native or translated `assistant`, `user` tool results, `system`, `result`, and
  control events.

The session owns its synthetic `cse_*`, worker bearer, worker status, downstream/upstream sequence
counters, acknowledgement set, stream generation, and terminal state. Closing it is absorbing for the
local adapter.

`HostRcRelay` runs two pumps and one shared publication queue:

1. The outbound pump maps upstream events into viewer content, allocates the next transcript `seq`,
   seals the item, and publishes it.
2. The inbound pump authenticates browser frames, deduplicates by `msg_id`, and turns them into session
   input or controls.

For a browser `user` frame on the private facade, one queued unit publishes `accepted`, publishes the
canonical `user` echo, and only then calls `Session.pushUserInput`. Native-companion text instead
publishes only a seq-less pending admission before delivery; provider history/SSE later owns the
canonical accepted coordinate and user row. A failed required publication prevents the native side
effect. Permission resolution uses the private-facade ordering: publish `permission_resolved`, then
deliver the worker response. Both pumps share the queue so a later native action cannot overtake an
earlier frame whose publication fails.

The first required publication failure latches the cause, closes only that session, and rejects queued
successors before they publish or mutate the worker. One logical publish—including sealing, chunks,
HTTP attempts, retry backoff, and an authoritative `409` retry—has a 65-second wall. An expired or
ambiguous outcome is terminal; the relay does not guess that the server rejected it and resend later.

## 6. Ordering, deduplication, and replay

`HostRcRelay` alone allocates transcript `seq`. Browser clients never assign it. The viewer authenticates
frames before passing them to `FrameOrderer` (`packages/cli/src/broker/order.ts`):

- `msg_id` or `msg_id:part` provides bounded recent deduplication.
- `seq:null` state can be delivered immediately after deduplication.
- content is buffered until the next consecutive `seq` is complete;
- all chunks for one sequence slot must share one `msg_id` and declared part count; and
- content below the delivered cursor is always dropped, even after its recent dedup key expires.

A missing sequence therefore appears as a disclosed gap instead of letting later content render in a
different order on different devices.

Inbound host dedup is different. It is unbounded for one relay lifetime because re-reading a valid
old browser command after evicting its ID could execute the command twice. The host verifies exact
identity, session, direction, and AEAD before putting a `msg_id` into that set, so a forged or misrouted
frame cannot poison the genuine coordinate.

History depends on the effective broker backend:

- On a non-durable backend, the host keeps an in-memory content log. A viewer sends `catch_up` with a
  `since` sequence, and the host republishes original `seq`/`msg_id` values.
- On a durable backend, the broker log is history. Viewers subscribe from the beginning and the host
  keeps no replay log; `catch_up` is authenticated but ignored.

Before a durable relay becomes discoverable, it reads both recovery cursors. `/api/seq` resumes the
outbound transcript counter at `maxSeq + 1`; `/api/frame-count` sets the new relay incarnation's
inbound subscription floor. If either cannot be established after bounded retries, startup fails
closed.

That floor prevents already stored commands from automatically re-executing after a restart, but it
is not a durable command inbox. A command published before the sample and not executed before a host
crash can be skipped. The current host also has no persistent source-ID-to-result map.

## 7. Presence and terminality

Presence uses `session_announce` on the identity bus. It contains the session title, cwd, launch-time
git snapshot, worker status, derived phase, open-permission state, permission mode, driver capability
vector, harness descriptor, process incarnation, per-incarnation announce sequence, and send time.

The host publishes immediately when meaningful presence changes and otherwise every 20 seconds. The
viewer accepts only newer incarnation/announce coordinates and derives local connection state from a
45-second freshness window followed by a 30-second reconnecting window. Host time is bounded by local
receipt time so a far-future timestamp cannot manufacture long-lived presence.

`session_terminal` is a canonical, authenticated, absorbing marker for one session. Once accepted by
the durable broker and viewer, a delayed `session_announce` cannot resurrect that session. A terminal
marker proves lifecycle end, not that the final transcript tail is complete.

Presence is advisory liveness. A stalled bus can show a disconnected session while content still
arrives on its separate session stream, and a driver may have less precise native status than another.
The capability vector tells the viewer when status must not be presented as authoritative.

## 8. Driver capability boundary

Capabilities are advertised by each driver and enforced again in the host, so an old or custom viewer
cannot bypass a disabled button:

| Driver | Structured permissions | Status | Interrupt | Set model | Set mode | End | Attachments |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Stable Claude RC (`mitm`) | no | yes | no | no | no | no | no |
| Claude native companion | no | no | no | no | no | no | no |
| Experimental tmux, default mirroring | yes | no | yes | yes | no | no | yes |
| Experimental OpenCode, default mirroring | yes | no | yes | no | no | no | no |

The stable Claude surface accepts only non-empty, non-slash text. Its internal compatibility plumbing
can translate more RC features, but those mutations are not advertised or accepted on the supported
boundary.

## 9. Permissions

A worker `can_use_tool` request becomes `permission_request`. The relay records the request ID before
publishing it. A matching viewer answer publishes `permission_resolved` before the worker response;
only explicit `allow` grants, while malformed behavior denies. Worker cancellation, interrupt, or
teardown clears abandoned gates so presence cannot remain stuck on `needs`.

## 10. Attachments

The experimental attachment path carries image bytes inside an E2E `attachment` message, split into
bounded chunks. After complete authentication, the host validates and writes unique files under the
Claude uploads directory, publishes one transcript echo, then injects a normal prompt referencing the
files. The broker never receives plaintext bytes. This path is disabled for drivers whose capability
is false.

## 11. Compatibility control verbs

The viewer stamps `interrupt`, `set_model`, `set_mode`, and `end` with an expiry. The relay drops those
actions when stale and maps supported controls to driver events:

- `interrupt` → Claude `interrupt`, tmux Escape, or OpenCode abort;
- `set_model` → Claude `set_model` or tmux `/model`; and
- `set_mode` → Claude `set_permission_mode` only where advertised.

Claude Code 2.1.x's REPL bridge currently recognizes this complete `control_request.subtype` set:

```text
initialize
set_model
set_max_thinking_tokens
set_permission_mode
rename_session
set_color
file_suggestions
read_file
get_context_usage
get_usage
mcp_status
mcp_authenticate
mcp_oauth_callback_url
mcp_reconnect
interrupt
```

Unknown subtypes return an error response. An outbound-only Claude session additionally accepts only
`initialize`. remote-claw's relay deliberately drives only `interrupt`, `set_model`, and
`set_permission_mode`, and only when the active driver advertises that capability. The stable Claude
capability vector currently advertises all three false.

Claude's REPL bridge has no working remote `end_session`; the official RC server's request is rejected
by Claude too. The current `end` action therefore only clears abandoned permission state and is
advertised false by every driver. Slash commands use ordinary `user` input, but the stable Claude
surface rejects slash-leading text.

`catch_up` is a separate replay request, not a native control verb. The viewer currently stamps it
with an expiry, but the host's replay branch does not enforce that expiry. Stable sequence and message
IDs keep the resulting transcript replay idempotent; a withheld request can still cause redundant
non-durable replay later.

## 12. Failure boundaries

The implementation intentionally fails closed at security and irreversible-action boundaries, but it
does not claim durable exactly-once collaboration:

1. A required broker publication may time out after the server accepted it. The session closes and the
   host does not automatically replay the uncertain action.
2. A burned transcript sequence can disclose a terminal gap. The shared queue prevents later content
   from publishing beyond a failed unit.
3. Durable broker replay preserves the remote-claw projection, not Claude's complete native context or
   every prompt typed locally.
4. The private-facade Claude worker does not backfill old native history: the bridge response contains a
   worker bearer, its downstream SSE carries new input, and the worker posts only new output. A resumed
   conversation's pre-resume transcript therefore cannot be recovered from the RC wire.
5. The process-local readiness bridge has no durable host-wide inventory and cannot recover all old
   driver bindings or resume an old writable bridge. Claude-native alone can attach a **new** projection
   when the operator supplies one exact still-live native `cse_*`; it does not discover or persist that
   ID.
6. Presence proves recent authenticated publication, not delivery, native application, or a complete
   final tail.
7. Session logs, inbound dedup, and the identity bus have no general compaction policy and can grow
   with a long-lived session.
8. Tmux and OpenCode can recognize local prompts only after native observation, with documented
   correlation limits. Stable MITM intentionally drops ordinary native user echoes to avoid duplicating
   remote prompts, so a local Claude TUI prompt may execute without appearing in the viewer. The native
   companion projects pinned top-level provider user events from both local-worker and app-client
   sources.
9. The default `--rc-driver=mitm` topology replaces Anthropic Remote Control. The native companion
   preserves that provider topology, and packed-install restart plus broker-loss isolation are locally
   proven. Literal official web UI coexistence and the Graduate commit's separate exact-SHA
   deployed-broker gate passed.

Broker-controlled HTTP rejection bodies/status text, SSE error data, malformed-frame parser details,
and invalid-success parse details are discarded before errors reach normal relay logs. Successful
publish and recovery-cursor bodies are shape-checked. The exact `410 + channel_storage_lost` pair
remains the only typed permanent channel-loss response.

These are product limits, not invitations to rebuild a second protocol stack. M1 is complete; add more
protocol machinery only for a concrete later capability failure.

## 13. Code and test map

The active protocol is concentrated in these paths:

- `packages/clawsec/src/{kdf,aad,aead,wire,chunk,pass}.ts` — identity, AEAD, wire, chunking, passes.
- `packages/cli/src/security/provider.ts` — sealed/open provider selection.
- `packages/cli/src/broker/{protocol,client,order}.ts` — taxonomy, HTTP/SSE client, viewer ordering.
- `packages/cli/src/host/rc/{session,relay,mitm,launch}.ts` — Claude adapter and host relay.
- `packages/cli/src/host/rc/anthropic/{client,driver,transport,credentials}.ts` — provider-native
  history/SSE/text transport, exact binding, and projection lifecycle.
- `packages/cli/src/host/rc/drivers/{bridge,ready-bridge}.ts` — process-local readiness and broker
  bridge lifecycle shared by current adapters.
- `apps/web/app/api/{relay,stream,seq,frame-count}/route.ts` — broker API.
- `apps/web/lib/broker/{backend,local,vercel,sqlite-multi}.ts` — broker implementations.
- `apps/web/app/lib/viewer.ts` — browser protocol client and recovery.

Unit and integration coverage sits beside those files, plus
`apps/web/test/e2e/rc-spine.integration.test.ts` and the browser suites in `tests/web`.
The retained native captures under `spikes/` are manual historical compatibility fixtures, not
runtime authority, ordinary CI inputs, or a separate release framework.
