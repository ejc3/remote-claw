# OpenCode driver

> **Status:** implemented behind `--rc-driver=opencode`. The current driver attaches remote-claw's
> existing broker/viewer bridge to an `opencode serve` session. It is not yet the isolated,
> coordinator-owned OpenCode runtime selected in
> [client-driven-host-runtime.md](client-driven-host-runtime.md).

**Identity scope.** The current driver has two distinct IDs: OpenCode owns the native `ses_*`, while
`RelayCore` creates a synthetic `cse_*` for the remote-claw broker channel and viewer row. Neither is
an implemented durable remote-claw logical-chat ID. A wrapper restart may reattach and backfill the
same `ses_*` into a fresh compatibility channel, but it does not yet preserve one canonical
remote-claw chat across that restart. A1 targets a persisted logical-chat-to-native binding and uses
the logical-chat ID for the broker row/channel; A2 then proves OpenCode-specific adoption and recovery.

## 1. What exists today

The OpenCode server is designed to be shared by a native OpenCode TUI and API clients, while its model
provider connection remains separate. The repository has not yet retained a real-TUI-plus-driver
coexistence fixture:

```text
local control
  person
    ⇅
  real OpenCode TUI
    ⇅
  OpenCode server

remote control
  OpenCode server
    ⇅ HTTP + SSE
  OpencodeDriver
    ⇅
  Session
    ⇅
  HostRcRelay
    ⇅
  encrypted broker + web

model path
  OpenCode server
    ↓
  configured provider
```

The driver controls OpenCode through its own server API. It does not use the Claude MITM and does not
spawn Claude. Today, however, the OpenCode server itself can still contact whichever provider its
configuration selects. That provider path is outside the current driver. The driver also does not
currently enforce that exactly one native TUI is attached or prove which unmatched native client
originated a user message.

The selected host-runtime design changes the top half:

```text
local control
  person
    ↓
  real OpenCode TUI
    ↓
  private OpenCode server

remote control
  many collaborators
    ↓
  remote-claw server
    ↓
  one bridge
    ↓
  same private server

model path
  private OpenCode server
    ↓
  private provider façade
    ↓
  connector
```

The selected runtime keeps one real OpenCode TUI path and one epoch-fenced remote-claw adapter lease
on the same native session. OpenCode's API is a server-wide SSE observer plus independent HTTP
requests; it exposes no persistent writer identity whose connection count could enforce that
cardinality. The private endpoint/runtime owner must therefore admit HTTP mutations from only the
current adapter lease and the allowed TUI, reject concurrent old/new wrapper writes, and prevent
unclassified clients. OpenCode is the final arbiter of both accepted paths. If a transparent local
proxy is needed for supervision or isolation, the native TUI must behave exactly as it does against
the server directly; its requests do not detour through the remote-claw coordinator. The OpenCode
process will be network-fenced so it cannot reach a real provider directly. Its control server remains
the native engine-control surface; provider façades are a separate model/API brokerage surface.

## 2. Launch and attachment

The dispatcher calls `runOpencodeDriver` for `--rc-driver=opencode`. Relevant options are:

- `--rc-oc-url` or `OPENCODE_URL`: server origin, default `http://127.0.0.1:4096`;
- `--rc-oc-session` or `RC_OC_SESSION`: exact `ses_*` to attach;
- `--rc-oc-model` or `RC_OC_MODEL`: `providerID/modelID` for turns;
- `OPENCODE_SERVER_PASSWORD`: optional HTTP Basic password, with an empty username; and
- `--rc-oc-skip-permissions` or `RC_OC_SKIP_PERMISSIONS`: do not add remote-claw's catch-all
  permission rule.

When no session ID is supplied, the driver tries to use the most recently updated session from
`GET /session`; a positive empty list creates one with `POST /session`. The current implementation also
catches any list/auth/server failure, treats it as an empty list, and creates a session. That is an
identity hazard: a transient discovery failure can mint a new `ses_*` beside an existing chat.

The selected runtime never infers identity from “most recent.” An existing logical-chat binding
reattaches only its exact stored `ses_*`; if that session is absent or has the wrong lineage, the
binding quarantines and never auto-creates a replacement. First import requires the user or trusted
onboarding flow to select one exact discovered session and records that adoption in the identity
transition log before it becomes writable. Automatic bootstrap requires explicit first-bootstrap
intent, no pre-existing logical binding, and a positive empty snapshot. An explicit user **New chat**
operation may create while other sessions exist, but it is a distinct typed operation and never a
fallback from failed discovery or ambiguous import. A session created directly by the native TUI is
imported through the same exact-selection transition, not silently adopted.

`POST /session` returns a new native `ses_*` and exposes no proved idempotency seam, so the target treats
it as non-idempotent. The retained OpenCode `1.17.5` fixture proves that its exact
`metadata.remoteClawCreationId` marker is preserved in the response and `GET /session`; it does not
prove arbitrary metadata behavior. For either automatic empty-server bootstrap or explicit **New
chat**, the target writes ahead a unique creation-attempt ID plus typed creation intent. The supported
tuple must first prove that exact metadata shape is preserved, then reconcile a lost response only by
the exact marker: zero matches stays uncertain while the proof window remains open, one match binds
that exact `ses_*`, and multiple matches quarantine. It never blindly retries, adopts “most recent,”
or matches a title. Typed-intent preservation and marker durability across server restart remain
pinned proof gates.

The current startup order is:

1. Create the relay `Session`, enqueue its `initialize` request, and invoke the optional test hook.
2. Start `bridgeSession`, including the broker announcement and serve loop.
3. Attach to or create the native OpenCode session.
4. Best-effort enable permission mirroring.
5. Start capture and injection pumps.

This means the current bridge can announce optimistic capabilities before native attachment and
permission setup finish. The future registrar must publish only validated, post-setup capabilities
before it accepts mutations.

The `bridgeSession` result is not a readiness barrier, but its `served` promise remains pending until
the admitted initial announcement settles. A parent cancellation that is already set when `run`
starts returns before creating a relay session or inspecting, selecting, creating, or aborting any
OpenCode session. Cancellation during automatic attachment is passed to the list/create HTTP requests;
the initial permission-mirroring read/write uses the same signal. Until attachment and that setup
finish, cancellation exits through startup cleanup without starting pumps or aborting an unconfirmed
native session.

On normal driver teardown, the driver first aborts its local capture/injection pumps and closes the
relay session. It then best-effort aborts the attached OpenCode run. That native abort request and the
final broker settlement share one bounded two-second deadline, so an unresponsive native server and
an unresponsive broker cannot hold exit for consecutive timeout windows. The driver does not stop the
external `opencode serve` process. A future runtime owner must distinguish “close this bridge” from
“stop this supervised native runtime.” A broker/relay failure alone does not enter this teardown path.
Wrapper or parent-signal teardown does; its best-effort abort can cancel the active turn and disrupt a
person using the native TUI even though the server, session, and TUI attachment remain. That does not
satisfy the target detach behavior.

An authenticated viewer `end` does not take that teardown path: `HostRcRelay` consumes it locally,
clears open relay permission gates, and sends no `end_session` or native OpenCode abort.

## 3. HTTP and SSE surface

`client.ts` uses Node's global `fetch`; there is no `@opencode-ai/sdk` dependency.

| Operation | Current route and behavior |
| --- | --- |
| Create session | `POST /session` → native session ID |
| List sessions | `GET /session`, most recently updated first |
| Read history | `GET /session/{id}/message`, chronological messages with parts |
| Send prompt | `POST /session/{id}/prompt_async` with `{model, parts}`; pinned `1.17.5` also accepts caller `messageID`; an empty `204` is transport receipt, not proof of native application |
| Interrupt | `POST /session/{id}/abort` |
| Compact | `POST /session/{id}/summarize` with `{providerID, modelID, auto:false}` |
| Read permission rules | `GET /session/{id}`, using its `permission` field |
| Add permission rules | `PATCH /session/{id}` with `{permission: rules}` |
| Answer a permission | `POST /session/{id}/permissions/{permissionId}` accepts `once`, `always`, or `reject`; the driver sends only `once`/`reject` |
| Follow events | `GET /event`, one server-wide SSE stream |

The driver does not implement OpenCode question APIs. A question capability must remain disabled until
the exact native request and answer lifecycle is implemented and recovery-tested.

Unretained OpenAPI/manual inspection of `1.17.5` reports `GET /session/status`, additional
pending-permission list routes, a nondeprecated permission reply route, and a v2 `/api/event` stream
whose sampled frames carried `evt_*` IDs and increasing `seq` values. The retained model-free proof
pins only the global pending-permission list and reply request schema, and uses legacy `/event`; it does
not establish the other route behavior, sequence monotonicity, or reset scope. The current client uses
none of those candidate stronger surfaces. `/api/event` advertises no replay cursor, so its sequence
alone would not be durable recovery even after a retained probe.

The SSE client filters session events by the ID found in the event or nested message/part shapes.
Server-level connected/heartbeat events are global. Predicate subscriptions also receive every
`session.created` event so the driver can discover child sessions, but the driver follows a child only
when its `parentID` belongs to an already followed session.

The SSE generator handles one connection. The driver owns reconnect with capped exponential backoff.

## 4. Capture workflow

For each SSE connection, capture subscribes first. After the first event proves the subscription is
live, it pauses generator consumption while it reads native history and then processes queued live
bytes. That narrows the obvious snapshot-then-subscribe gap but is not the selected runtime's actively
drained durable overlap: OpenCode SSE supplies no replay token, process loss can discard the queued
tail, and transport buffering is not a committed boundary. Re-running history after reconnect is
deduplicated by OpenCode message ID within the driver's bounded 4,096-ID recent window. A history
larger than that window can re-emit evicted messages after reconnect; the current driver does not
promise cross-reconnect exactly-once projection for an unbounded chat.

After reconnect the current driver unconditionally marks the worker `running` instead of reading
native session status. An idle attached session can therefore appear to be thinking indefinitely
until a later `session.status` or `session.idle` event. The target remains unknown/non-writable until a
native status snapshot and the buffered event tail are merged.

| OpenCode event | Current action |
| --- | --- |
| `message.part.updated` | Replace the whole part in a per-message buffer |
| `message.part.removed` | Remove that part from the buffer |
| completed assistant `message.updated` | Flush the complete message once |
| `session.status` | Update main-session running/idle presence |
| `session.idle` | Flush that session's buffers; mark only the main session idle |
| `session.error` | Flush partials, emit a visible warning result, and idle the main session |
| `permission.asked` | Emit a `can_use_tool` control request |
| `session.created` | Discover a live child session and try to associate it with a Task anchor |
| `server.connected` / `server.heartbeat` | Refresh presence |

OpenCode re-sends whole parts rather than token deltas. The driver buffers parts and emits only a
completed message, preventing one relay message per update.

The current translation is deliberately narrow:

- visible text → `text`;
- reasoning text → `thinking`;
- a pending/running tool → `tool_use`;
- a completed/failed tool → `tool_use` followed by a user-role `tool_result`;
- a subtask part → a `Task` `tool_use` anchor; and
- step, snapshot, patch, agent, retry, compaction, file, and unknown parts → dropped.

A complete assistant message produces at most two relay payloads: the assistant blocks, then any tool
results. Stable OpenCode message and call IDs become relay message/tool IDs.

For main-session user messages, the driver suppresses the echo of a prompt it injected. Main-session
text that does not match an injected prompt is surfaced as `local_prompt: true`, so a prompt typed
through the native OpenCode TUI appears in the remote-claw viewer. The current code does not enforce
one-client cardinality, so the same marker can also mean another attached client. A followed child
session's internal user prompt is always suppressed because its Task anchor already carries that
input.

That current local path is post-hoc: OpenCode receives the TUI request before remote-claw observes its
resulting user message. The selected runtime preserves that direct native path and gives remote-claw
one peer adapter lease. remote-claw orders the web/official/nested collaborators behind its own lease;
OpenCode determines their final interleaving with the TUI. A client-facing proxy, if present, must be
behavior-transparent and does not replace the OpenCode TUI.

Child sessions are followed while live. The parent subtask part does not carry the child session ID,
so correlation uses `(parent session, agent, FIFO)`. Concurrent same-agent children can therefore be
mis-nested. Children are unfollowed on `session.idle`; a child `session.error` does not currently
remove it from the follow set. Historical finished-child discovery is not complete.

## 5. Injection and control workflow

The injection pump serially drains `Session.followDownstream(...)`.

| Relay input | Current OpenCode action |
| --- | --- |
| blank user text | No-op, then acknowledge |
| ordinary user text | Record echo-suppression token, await `prompt_async`, then acknowledge |
| `/compact` | Dispatch native `summarize` without blocking the pump |
| `initialize` | No-op, then acknowledge |
| `interrupt` | Await native `abort`, then acknowledge |
| `set_model` | Accept only an explicit `providerID/modelID` string for the next prompt |
| directly queued `set_permission_mode`, `end`, unknown control | Safe no-op, then acknowledge; viewer `end` never reaches this pump |
| permission response | For a valid request ID, map explicit allow to `once` and other behavior to `reject`; an invalid ID is a no-op |

If an awaited injection fails, the current pump withholds the relay-session acknowledgement, logs the
failure, and keeps draining. The event remains eligible for replay only if that same `Session` later
gets a new downstream claimant; an ordinary OpenCode SSE reconnect does not reclaim the downstream
stream. Any such replay is not safe enough for durable remote delivery: if `prompt_async` reached
OpenCode and only its response was lost, retry can execute the prompt twice. The current failure path
also removes the text-origin suppression token; an eventual native user record can then be mislabeled
`local_prompt` even though remote-claw sent it. The new coordinator must write-ahead `started`, retain
the unresolved source/correlation record, treat that result as `outcome_unknown`, and quarantine later
remote-claw-origin deliveries unless OpenCode supplies positive proof that the first attempt did not
start. This does not pretend to fence or stop direct native-TUI actions.

Even a received `204` advances only transport receipt. Pinned OpenCode `1.17.5` accepts a valid
caller-supplied native `msg_*`; the current client omits it. The target writes a unique `msg_*` ahead of
delivery, sends it once, and correlates history/SSE by that exact ID. The retained
[OpenCode native proof](opencode-native-proof.md) shows that
with `noReply:true`, one server incarnation, and no provider/model reply, reusing the same ID is not
idempotent: the second POST adds another part to the same native message. Model-bearing, concurrent,
TUI, and restart variants remain unproved.
The ID therefore enables positive read-back, never blind retry; absence remains inconclusive until a
proved terminal boundary. OpenCode's native IDs/order override remote-claw's proposed order. The
current text multiset used for echo suppression is not that proof.

Interrupt, summarize, permission, and future question actions follow the same native-outcome rule, but
outcome and source are different facts. Native status, history, or a terminal gate event can establish
what happened. Unless the pinned native surface also carries a durable action ID or another
unambiguous causal link, a TUI-versus-remote race cannot establish which client caused an abort or
compaction. The current client also ignores any abort/summarize response body, so its semantics are not
yet evidence. The projection records the native outcome with source `unknown` and leaves the
remote-claw proposal `outcome_unknown`; it must not infer causality from timing, an HTTP 2xx, or an
unproven boolean body.

`/compact` is dispatched without awaiting the long-running summarize request so an interrupt can
overtake the HTTP response wait. A dispatch error emits an OpenCode warning result and restores idle.
The server coordinator must still journal a remote-claw-origin compaction as its own proposal and
apply the same delivery-uncertainty rule. A compaction invoked directly through the native TUI remains
a native observation rather than a coordinator-admitted mutation.

## 6. Permissions

OpenCode normally decides tools from session permission rules. With mirroring enabled, the driver:

1. Reads the existing rules.
2. Removes only an exact prior remote-claw catch-all ask rule from the payload it prepares.
3. Prepends `{permission:"*", pattern:"*", action:"ask"}`.
4. Appends the existing rules, preserving OpenCode's last-match-wins behavior.
5. Patches the session, and repeats best-effort for newly discovered child sessions.

If the read fails, the driver does not patch because a blind write could drop a deny rule. If the patch
fails, the session continues without reliable remote gating. The current capability announcement does
not reflect that failure. A newly discovered child can also execute its first tool before the
fire-and-forget child PATCH lands, so a successful parent setup still does not validate structured
permissions for child tools.

The live OpenCode `PATCH` behavior is append-only: rules concatenate and an empty/null patch does not
clear them. The driver therefore cannot safely restore a borrowed session's original rules on
teardown. Once its catch-all ask rule is installed, it persists until the user clears the native
session policy. The future structured runtime should use an owned session/server or prove a reversible
permission-policy seam before advertising clean detach.

`permission.asked` becomes the relay's existing `permission_request`. Only an explicit viewer allow
maps to OpenCode `once`; a deny or malformed behavior with a valid request ID maps to `reject`. An
absent/invalid request ID is a no-op that the legacy downstream pump still acknowledges. There is no
implemented “always” choice, question flow, or durable recovery of an answer whose HTTP
acknowledgement was lost. The native endpoint returns a boolean body, but the current client ignores
it and treats any 2xx as success; a false or stale TUI-won reply can therefore be acknowledged by the
legacy pump without proof OpenCode applied it.

The current driver ignores `permission.replied`. If the native TUI answers first, the remote-claw
viewer gate can remain open and a later viewer answer can reach OpenCode as a stale response. Current
code therefore does not arbitrate TUI/viewer answer races. The retained proof schema-pins global
`GET /permission` and the nondeprecated `/permission/{requestID}/reply` request shape without creating
or answering a gate. A session-scoped list and the `permission.replied` event come only from current
unretained OpenAPI/type inspection. Those are promising native recovery seams, but their
list/reply/event behavior and terminal semantics must be runtime-proved before use.

The future coordinator must journal permission answers before delivery. On ambiguous delivery it must
not send a contradictory second answer; it records `outcome_unknown` and waits for positive native
terminal/cancellation evidence, or definitively stops/freezes the old process before proceeding.
It chooses one response among remote-claw's many remote collaborators and forwards that through the
single current adapter lease. OpenCode remains the arbiter between that response and a direct native
TUI answer. If the supported tuple proves `permission.replied` terminal, remote-claw may use that
event; otherwise it requires another proved terminal native gate record. Only that record closes every
outward copy and makes a later remote response stale. Until terminal semantics, observation, and
restart recovery are implemented, structured permission adjudication remains unsupported in the
selected runtime.

## 7. Capability truth

The current constructor advertises:

| Capability | Advertisement | Actual state |
| --- | --- | --- |
| Structured permissions | Mirrors the requested flag | Can be false after setup failure; child first-tool PATCH races and ignored reply booleans/`permission.replied` also prevent native adjudication |
| Status | `true` | Later main-session events are real, but initial/reconnect state is fabricated `running` without `GET /session/status` and can remain wrong |
| Interrupt | `true` | Backed by `abort` |
| Set model | `false` | Internal handler accepts only `providerID/modelID`; viewer aliases are incompatible |
| Set mode | `false` | No native mapping |
| End | `false` | No native mapping |
| Attachments | `true` | Relay-owned path; end-to-end OpenCode fidelity is not yet proven |

The first host-runtime slice must stop announcing optimistic structured-permission and attachment
support. A feature is writable only after its setup and proof gate succeed.

## 8. Recovery and authority

Today, OpenCode owns native message history and the driver reconstructs viewer output from
`GET /session/{id}/message`. A wrapper restart can attach to the same explicit session and backfill
completed main-session messages into a fresh synthetic `cse_*` broker channel. The native `ses_*`,
that channel, and the future logical-chat ID remain separate. It does not yet preserve:

- a durable remote-claw logical-chat ↔ OpenCode-session binding;
- a durable remote-collaborator proposal journal or correlated native applied order;
- native delivery attempt IDs;
- permission/question gates across restart;
- a durable SSE cursor;
- complete historical child-session lineage; or
- provider/network isolation.

Text matching for injected-echo suppression is also ambiguous: an identical prompt sent concurrently
through another OpenCode client can be misattributed.

A native server crash can leave a durable assistant message without `time.completed` while the
in-memory runner and future completion event are gone. The current backfill buffers that message
indefinitely and the fabricated running status may never clear. Recovery must combine exact server
incarnation, native status, and history to classify it as active, interrupted, or an explicit gap; it
must never silently flush a partial as complete or wait forever for an event from a dead incarnation.

In the selected host runtime, authority is divided cleanly:

| Fact | Authority |
| --- | --- |
| Which remote-claw collaborator proposal is forwarded next | remote-claw coordinator journal |
| Final interleaving of the native TUI and remote-claw connection | OpenCode server/session |
| Whether a native OpenCode action actually happened | OpenCode native history/status and action-specific correlated native records; generic HTTP receipts are insufficient |
| OpenCode conversation content after wrapper loss | OpenCode native store, with explicit gaps where evidence is absent |
| What the local person sees | The native OpenCode TUI rendering the native session directly |
| Viewer/official-client representation | rebuildable remote-claw projection |
| Model/provider access | isolated inference connector, never the OpenCode process directly |

Recovery must reattach the exact `runtimeId`/session/incarnation, subscribe before history backfill,
reconcile journaled attempts against native evidence, and leave ambiguous attempts quarantined. It may
start a successor session only with an explicit gap and explicit handling of proposals that were
forwarded toward the old session. Reattaching a proven same semantic session is the future condition for
retaining a logical-chat ID; a missing, reused, or unproven `ses_*` cannot silently repoint that chat.

The private endpoint also fences adapter epochs, but checking the epoch when an HTTP request arrives
cannot retract work already forwarded to OpenCode. Takeover first rejects new old-lease requests, keeps
the replacement non-writable, and accounts for every old admitted request: wait for correlated terminal
native evidence, or mark it `outcome_unknown`, quarantine the binding, and contain the old execution
path. Only after that barrier may the new lease write. A stale wrapper then cannot start new work after
takeover; the design does not falsely claim that revocation undoes an already accepted native action.
Outside collaborator disconnects only update coordinator state; they do not abort the native run, tear
down the shared SSE observer, or detach the TUI.

## 9. Tests

The checked-in unit tests cover HTTP/SSE parsing, translation, coalescing, deduplication, attach
mid-turn, reconnect/backfill, injected-echo rollback, compact routing, visible errors, permissions, and
child-session nesting/isolation.

Selected-runtime release tests must additionally prove one epoch-fenced adapter lease against two
concurrent wrappers, including takeover while an old request is paused before native forwarding and
after OpenCode may have accepted it. Creation tests cover discovery failure, positive-empty automatic
bootstrap, explicit **New chat** while sessions already exist, exact first-import selection, lost
create responses, multiple marker matches, and metadata-marker durability across a real server
restart. Recovery tests actively drain subscribe-before-snapshot overlap under slow history, high event
rate, stream drop, overflow, and pre-merge crash. Direct-TUI/remote input races resolve by native
IDs/order. Caller-supplied native message-ID correlation proves `prompt_async` `204` versus native
application, retained origin after an ambiguous POST, and non-idempotent same-ID retry behavior.

Interrupt/compact tests pin response-body semantics and separately prove native outcome and causal
attribution under direct-TUI-versus-remote races and lost responses; when the pinned surface has no
causal seam, source must remain `unknown`. Permission tests cover child creation/first-tool policy
races, parsed reply booleans, and TUI/remote races closed by a native terminal gate event.
Detach/crash tests keep a direct-TUI turn alive, distinguish explicit interrupt from collaborator
disconnect, exercise owned versus external server termination, and prove that a
persistent/non-reversible permission policy cannot be advertised as clean detach. A real server
kill/restart fixture classifies an orphaned incomplete message and status without waiting for a dead
incarnation. The event suite compares legacy `/event` with v2 `/api/event` and pins event-ID/sequence
scope and reset behavior before choosing the stronger surface.

The live suite is:

```bash
OPENCODE_URL=http://127.0.0.1:4096 \
pnpm --filter @remote-claw/cli exec vitest run src/host/rc/opencode/driver.e2e.test.ts
```

It skips when no OpenCode server is reachable. Provider-backed turn cases also require the configured
model credentials in the `opencode serve` process. The live cases cover ordered turns, tool
translation, local and injected prompts, history/restart, interrupt, visible errors, native compact,
permission round-trip, and two-session isolation. The “local prompt” case uses a second
`OpencodeClient.promptAsync` call as a stand-in; it does not spawn the real TUI. The suite is neither
pinned nor retained. A supported tuple needs a PTY fixture with the real pinned TUI and adapter on one
`ses_*`, both directions, simultaneous submit/busy behavior, permission first-winner, adapter/front-door
restart, hard server restart, and native visible-state comparison.
