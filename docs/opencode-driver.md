# OpenCode driver

> **Status:** implemented behind `--rc-driver=opencode`. The current driver registers its compatibility
> session through the process-local host seam and fails closed until one exact canonical native session
> ID is confirmed and, unless explicitly skipped, parent-session permission setup is proved. It is not
> yet the isolated,
> coordinator-owned OpenCode runtime selected in
> [client-driven-host-runtime.md](client-driven-host-runtime.md).

**Identity scope.** The current driver has two distinct IDs: OpenCode owns the native `ses_*`, while
`RelayCore` creates a synthetic `cse_*` for the remote-claw broker channel and viewer row. Neither is
an implemented durable remote-claw logical-chat ID. A wrapper restart may reattach and backfill the
same `ses_*` into a fresh compatibility channel, but it does not yet preserve one canonical
remote-claw chat across that restart. A1 targets a persisted
`(collaborationServerId, logicalChatId)`-to-native binding; that pair identifies the canonical chat
within one machine. Its machine-facing viewer row, chat route, alias, channel, and cache keys use the
full `(identity_id, collaborationServerId, logicalChatId)` triple; the discovery bus is the distinct
null-chat `(identity_id, collaborationServerId, scope_bus)` route and cursor. Typed **New chat** uses a
third null-chat `(identity_id, collaborationServerId, server_control)` route; it enters the same common
server-wide command/result adjudicator as official-client, automation, and nested-server starts before
an OpenCode `ses_*` exists. A2 then proves OpenCode-specific adoption, native adjudication, and
recovery.

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
cardinality. The private endpoint/runtime owner must therefore admit binding-scoped mutations only
from the current adapter lease and the allowed TUI, admit server-scoped creation only through its
separate one-time creation front door, reject concurrent old/new wrapper writes, and prevent
unclassified clients. OpenCode is the final arbiter of accepted native paths. If a transparent local
proxy is needed for supervision or isolation, the native TUI must behave exactly as it does against
the server directly; its requests do not detour through the remote-claw coordinator. The OpenCode
process will be network-fenced so it cannot reach a real provider directly. Its control server remains
the native engine-control surface; provider façades are a separate model/API brokerage surface.

The two collaborator paths are intentionally different:

- every remote source—web, official-client, automation, or nested remote-claw—first becomes one
  common command and crosses the same signed remote-claw adjudicator; and
- the supervised native TUI is a separate native collaborator whose allowed requests go through its
  own transparent front door, not through that remote command order.

remote-claw decides which remote proposal may reach its single adapter lease. OpenCode then decides
the applied native order between that adapter and the person at the TUI. Native history and status,
not the remote proposal order, are authoritative for what actually mutated.

Because OpenCode HTTP has no persistent writer identity, the actual listener is private. The runtime
owner exposes four closed front-door audiences: the supervised TUI process, the current binding
adapter lease, server-scoped creation, and an internal read-only observer. Their complete generated
allowlist is default-deny by method/path/query/header/body/Upgrade and audience. The binding and TUI
paths retain exact target-session scope; a valid adapter credential
aimed at another `ses_*`, child, or permission is rejected. Raw listener access, a second TUI,
unclassified third clients, and stale/concurrent adapter leases cannot mutate. Replacing either lease
first contains its old process/endpoint and already-forwarded requests. Direct-server versus
TUI-front-door differential parity is a release gate; the TUI path never detours through the
collaboration coordinator.

The runtime owner signs both the measured runtime-isolation attestation and each installed native
capability snapshot. The isolation attestation binds the exact four front-door process identities,
raw-listener socket identity, installed attach-before-run policy, descendant/tool denial, provider
façade rule, and network/mount namespaces. The capability attestation binds the exact callable route
manifest and each family entry's common payload schema, native request schema, translator
schema/implementation/build digest, injectivity proof, and positive read-back schema. A signature is
not enough by itself: the last-hop front door revalidates the current process/socket identities,
lease, snapshot bytes, translation, and one-time dispatch record immediately before it may write to
the private listener.

Stock OpenCode 1.17.5 is not yet an A2 real-TUI tuple. Its TUI needs a broad exact set of
config/provider/session/global-event reads, its legacy SSE surface has no proved snapshot
linearization point, and the current spike retains neither the full generated front-door manifest nor
an exact-process non-inheritable TUI channel. A2 stays non-writable until a separate retained release
fixture proves those seams; the narrow marker/message-ID fixture is not that proof.

## 2. Launch and attachment

The dispatcher calls `runOpencodeDriver` for `--rc-driver=opencode`. Relevant options are:

- `--rc-oc-url` or `OPENCODE_URL`: server origin, default `http://127.0.0.1:4096`;
- `--rc-oc-session` or `RC_OC_SESSION`: exact `ses_*` to attach;
- `--rc-oc-model` or `RC_OC_MODEL`: `providerID/modelID` for turns;
- `OPENCODE_SERVER_PASSWORD`: optional HTTP Basic password, with an empty username; and
- `--rc-oc-skip-permissions` or `RC_OC_SKIP_PERMISSIONS`: do not add remote-claw's catch-all
  permission rule.

Registration always requires a successful, schema-valid `GET /session`. Every returned ID must be a
unique canonical `ses_*`; a malformed response, authentication failure, or server error is fatal. A
configured `--rc-oc-session` must be canonical and must exist exactly in that discovery snapshot. With
no configured ID, a non-empty list is ambiguous and fails with an instruction to select an exact
session; only a valid empty list permits one `POST /session`, whose returned ID must also be canonical.
The selected or created ID is then confirmed by an exact `GET /session/{id}` before registration can
become visible. Recent-activity ordering is never identity evidence.

This A0.2 empty-list check is not yet serialized with direct-TUI creation. A person can create a
session after the list response but before the driver's `POST /session`, leaving two native sessions;
the driver still confirms only the ID returned by its own create and never guesses between them.
The selected A2 workspace transition barrier below closes that race.

The selected runtime never infers identity from “most recent.” An existing logical-chat binding
reattaches only its exact stored `ses_*`; if that session is absent or has the wrong lineage, the
binding quarantines and never auto-creates a replacement. First import requires the user or trusted
onboarding flow to select one exact discovered session and records that adoption in the identity
transition log before it becomes writable. Automatic bootstrap requires explicit first-bootstrap
intent, no pre-existing logical binding, and a positive empty snapshot. An explicit user **New chat**
operation may create while other sessions exist, but it is a distinct typed operation and never a
fallback from failed discovery or ambiguous import. A session created directly by the native TUI is
imported through the same exact-selection transition, not silently adopted.

The selected runtime serializes direct-TUI create/import/switch/clear/fork/archive/unarchive and server-control creation
through one runtime-owned workspace transition barrier. First-bootstrap rechecks the empty discovery
snapshot while holding that barrier immediately before the one creation dispatch and atomically marks
the bootstrap claim. A TUI-created session that wins the race makes bootstrap inapplicable; it cannot
produce two “first” sessions. Explicit **New chat** uses the same short dispatch serialization without
an empty-workspace precondition. Any TUI operation that can change top-level session identity, active
selection, or discovery availability but lacks a classified transition kind is rejected at the TUI
front door.

`POST /session` returns a new native `ses_*` and exposes no proved idempotency seam, so the target treats
it as non-idempotent. The retained OpenCode `1.17.5` fixture proves that its exact
`metadata.remoteClawCreationId` marker is preserved in the response and `GET /session`; it does not
prove arbitrary metadata behavior. For either automatic empty-server bootstrap or explicit **New
chat**, the target writes ahead a unique creation-attempt ID plus typed creation intent. The supported
tuple must first prove that the exact two-field metadata shape is preserved. Lost-response
reconciliation may use only the complete discovery snapshot for the one current successor attachment,
workspace, and observer epoch. Crossing a native incarnation additionally requires the original
pre-dispatch snapshot to pin a runtime-owner-signed open/read store coordinate and a typed continuity
handoff proving definitive predecessor stop/fencing, exclusive successor open of the same store, and
no intervening reset or fork. Otherwise lineage is unproved and no binding is installed. The
successor snapshot must be linearly proved and exhaustive at its proved boundary; a
gap, stale pointer, or omitted candidate cannot reconcile or bind. It enumerates every session with
the expected marker before filtering by intent and retains each candidate's full native metadata
ref/digest, including extra or malformed fields. Zero matches stays uncertain while the proof window
remains open. Exactly one binds that exact `ses_*` only when its full evidence and canonical two-field
metadata ref/digest recompute and its
`remoteClawCreationIntentDigest` equals the reservation's expected `nativeCreationIntentDigest`.
A same-marker wrong/missing/malformed intent or noncanonical/extra metadata candidate, and multiple
marker matches, quarantine.
It never accepts a marker-only match, blindly retries, adopts “most recent,” or matches a title.
Typed-intent preservation and marker durability across server restart remain pinned proof gates.

The current startup order is:

1. Create the relay `Session`, enqueue its `initialize` request, and invoke the optional test hook.
2. Open a process-local registration lease in `starting` with `nativeRef:null` and no claimed native
   capabilities. No broker bridge or announcement exists yet.
3. Run strict discovery, select or create under the rules above, and confirm the exact canonical native
   session ID.
4. Unless permission mirroring was explicitly skipped, require a valid permission read, install the
   catch-all ask rule only when absent, and require a valid read-back containing that exact rule.
5. Publish the proved compatibility capabilities and conservative native evidence, then move the lease
   to `ready`. That transition starts `startBridgeSession` and its initial announcement.
6. Start capture and injection pumps only after `ready`.

The A0.2 native evidence is deliberately limited:
`{mutationAdmission:"mixed", history:"partial", deliveryEvidence:"structured_receipt",
liveReattach:false}`. The native TUI and the adapter can both mutate OpenCode, history is not a durable
complete snapshot, HTTP supplies structured transport receipts rather than semantic application
proof, and restart-safe reattachment is not implemented. The lease keeps `nativeRef:null` because the
current driver cannot prove a durable runtime/session incarnation reference; it does not substitute
the server URL, synthetic `cse_*`, or native `ses_*`.

A parent cancellation that is already set when `run` starts returns before creating a relay session or
inspecting, selecting, creating, or aborting any OpenCode session. Cancellation during registration
aborts list/create/exact-GET and parent permission setup, closes the `starting` lease, and exits without
an announcement, pumps, or an abort against an unconfirmed native session. Discovery, exact-target,
create-response, confirmation, permission-read, permission-PATCH, and permission-read-back failures
follow the same no-ghost path and return a nonzero status.

Fail-closed visibility cannot undo native work that already happened. If `POST /session` created a
session before its response was lost or later confirmation/setup failed, that native session may
remain without a broker conversation; the driver neither blindly retries nor deletes it. Likewise, a
permission append can land before cancellation, response loss, or failed read-back and then persist.
A later registration detects the exact installed catch-all and skips another append. A2's write-ahead
creation marker, reconciliation, and fenced transition barrier are required to recover these cases
without guessing.

On normal driver teardown, the driver first aborts its local capture/injection pumps and closes the
relay session. It then best-effort aborts the attached OpenCode run, closes the registration lease,
and joins every tracked child permission-setup task. Those operations share one bounded two-second
deadline, so an unresponsive native server, child setup, or broker cannot hold exit for consecutive
timeout windows. Teardown aborts the run signal first; each child task receives that signal and checks
it after its initial read and before PATCH, so even an injected client that ignores abort cannot begin
a late PATCH after its read resolves. A native request already accepted before cancellation cannot be
undone. The driver does not stop the external `opencode serve` process. A future runtime owner must
distinguish “close this bridge” from “stop this supervised native runtime.” A broker/relay failure alone
does not enter this teardown path. Wrapper or parent-signal teardown does; its best-effort abort can
cancel the active turn and disrupt a person using the native TUI even though the server, session, and
TUI attachment remain. That does not satisfy the target detach behavior.

An authenticated viewer `end` does not take that teardown path: `HostRcRelay` consumes it locally,
clears open relay permission gates, and sends no `end_session` or native OpenCode abort.

## 3. HTTP and SSE surface

`client.ts` uses Node's global `fetch`; there is no `@opencode-ai/sdk` dependency.

| Operation | Current route and behavior |
| --- | --- |
| Create session | `POST /session` with optional `{title}` → one validated canonical native `ses_*`; no A2 creation marker yet |
| List sessions | `GET /session`; registration validates the complete ID vector and ignores recency for identity |
| Confirm session | `GET /session/{id}` must return that exact ID and a completely valid permission vector |
| Read history | `GET /session/{id}/message`, chronological messages with parts |
| Send prompt | The compatibility client sends `POST /session/{id}/prompt_async` with `{model, parts}` and no caller `messageID`; pinned `1.17.5` separately accepts caller `messageID`; neither request is the selected A2 request, and an empty `204` is transport receipt, not proof of native application |
| Interrupt | `POST /session/{id}/abort` |
| Compact | `POST /session/{id}/summarize` with `{providerID, modelID, auto:false}` |
| Read permission rules | `GET /session/{id}`, using its `permission` field |
| Add permission rules | `PATCH /session/{id}` with `{permission: rules}` |
| Answer a permission | Retained OpenCode 1.17.5 route `POST /permission/{requestID}/reply` with `{reply}` set to `once`, `always`, or `reject`; the driver sends only `once`/`reject` and requires a JSON literal `true` response |
| Follow events | `GET /event`, one server-wide SSE stream |

The driver does not implement OpenCode question APIs. A question capability must remain disabled until
the exact native request and answer lifecycle is implemented and recovery-tested.

The retained model-free proof schema-pins the global pending-permission list and the nondeprecated
permission reply request above. The current client uses the reply route but not the pending list.
Unretained OpenAPI/manual inspection of `1.17.5` reports `GET /session/status`, additional
session-scoped pending-permission routes, and a v2 `/api/event` stream whose sampled frames carried
`evt_*` IDs and increasing `seq` values. The retained proof uses legacy `/event`; it does not establish
the other route behavior, sequence monotonicity, or reset scope. `/api/event` advertises no replay
cursor, so its sequence alone would not be durable recovery even after a retained probe.

HTTP failures are body-free: client errors retain only a stable endpoint name and status, never native
response text. Successful malformed JSON from create, list, exact session/policy, history, or
permission-reply endpoints is caught and converted to the same body-free endpoint error. A provider or
server response body therefore cannot enter a caller's diagnostic through JSON parse text.

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

For `session.error`, the viewer still receives a best-effort human-readable warning in its
E2E-encrypted result frame. Local diagnostics do not log that provider-controlled message or response
body. They record only the affected session plus numeric status and boolean retryability when those
structural fields are present; the provider-controlled error name is omitted too.

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

That table is current behavior, not the A2 admission contract. In A2, every
web/official-client/automation/nested input first crosses the common machine/server scope,
source/digest/order, command, and signed-result adjudicator. OpenCode has no adapter-specific shortcut.
A native attempt or creation reservation is legal only when it composite-foreign-keys this exact
immutable admitted-result tuple:

```text
collaborationServerId
commandId
admittingCommandResultId
canonicalCommandRecordDigest
admittingCommandResultSignedRecordDigest
```

The result must be a fully signed `CollaborationCommandResultRecord` with
`disposition:"admitted"`. Its decision-evidence digest, selected native executor evidence, and
runtime-owner-signed capability-snapshot attestation must also equal the command and target binding or
server attachment. An unsigned, signature-reserved, queued, rejected, different-command,
different-result, or transplanted-executor record cannot create an effect gate, native attempt, or
dispatch authorization.

A chat mutation pins the current immutable OpenCode binding/incarnation/leases and capability family.
A server-control `new_chat` resolves its project selector and pins either the terminal OpenCode server
capability or a nested-server management capability before allocating the target logical chat. A
missing, stale, downgraded, family-incomplete, unsigned, or content-substituted snapshot rejects before
projection or native work. The signed binding snapshot also pins the common payload schema, exact
request and read-back schemas, translator schema/implementation/build digest and injectivity proof,
and exact slash-command table.

Semantic normalization happens before the common decision and is committed even when the result is a
rejection:

- an explicit new submit is `user_text`; a source-native steer is the distinct `steer_text` family,
  and busy state or timing never converts one into the other;
- blank generic input becomes `blank_submit`;
- exact `/compact`, `/clear`, `/model`, and `/context` become `compact`, `clear`, `set_model`, and
  `session_command`, respectively, with no prefix or argument parsing; and
- every other nonblank generic submit remains `user_text`.

That reserved normalization table is not the advertised-writable command set. The viewer advertises a
table item only when its normalized family also has a current writable family-capability entry.

The only first-A2 vectors eligible to become writable after their release proof passes are
server-scoped `{new_chat}` and binding-scoped `{user_text}`. Therefore steer, blank submit, the four
reserved slash families, interrupt,
permission/question answers, attachments, and every other unproved family receive a stored signed
rejection with no user projection, native attempt, or raw-slash fallback. Exact replay only redelivers
that result; changed bytes collide.

An admitted binding-scoped action creates one command-wide effect gate and one exact native delivery
attempt. The attempt pins the admitted-result tuple, selected executor and capability attestation,
`ses_*` target, exact request and translation records, runtime/front-door leases, generated caller
`msg_*`, and expected part fingerprint. The translator receives only the immutable common payload and
the persisted generated coordinates; it cannot read adapter defaults, environment, current model, or
later chat state. The runtime front door recomputes those records and performs a final one-time
dispatch compare-and-swap immediately before the socket write.

### Selected A2 native requests

For admitted `user_text`, the selected request is exactly:

```text
method: POST
path: /session/{nativeConversationId}/prompt_async
query: empty
headers, in semantic order:
  content-type: application/json
  x-opencode-directory: {exact canonical directory}
body:
  {"messageID":"<nativeActionId>","parts":[{"type":"text","text":"<text>"}]}
```

The runtime owner allocates and persists `nativeActionId` as `msg_` plus unpadded base64url of 16
random bytes before translation. The body keys and one-part array have exactly the order shown.
The quoted placeholders denote the generated string contents after the selected strict JSON encoder.
`model`, `noReply`, agent/system fields, extra or reordered parts, extra keys, query aliases, and
alternate directory headers are forbidden. The front-door credential is outside the
semantics-relevant header vector. The canonical directory is the exact pinned absolute POSIX path
under the selected narrow safe-byte grammar; it is not trimmed, percent-encoded, or base64-encoded.

JSON strings use the selected strict encoder: quote and backslash are escaped, U+0000–U+001F use
lowercase `\u00xx`, and other Unicode scalar values are emitted as UTF-8 without normalization or
optional escapes. Lone surrogates and invalid UTF-8 reject before request construction. A generic map
serializer cannot choose another equivalent spelling.

For admitted terminal `new_chat`, the selected request is exactly `POST /session`, empty query, the
same two-header vector, and this compact body:

```json
{"metadata":{"remoteClawCreationId":"<nativeCreationMarker>","remoteClawCreationIntentDigest":"<nativeCreationIntentDigest>"}}
```

The runtime owner allocates the marker once and derives the intent digest from the exact admitted
result, common command and decision, signed server capability, translator, target mapping, workspace,
and typed creation intent. No title, model, provider, parent, native session ID, directory alias, or
extra metadata is allowed. The target logical chat exists in `recovering` state before dispatch, but
no native `ses_*` is invented until OpenCode returns one. The discovery record retains the exact
complete native metadata JSON under `remote-claw/opencode-full-native-metadata-evidence/v1` with its
digest, including extra or malformed fields. Only an exact two-field object also carries a non-null
canonical ref/digest under `remote-claw/opencode-native-creation-metadata/v1`; noncanonical/extra
objects retain null canonical fields instead of a lossy projection. A lost-response reconciliation
record pins both the expected marker and expected intent digest; the full same-marker vector is
retained before the exact-intent comparison.

When the project selector instead chooses nested management, the outer server creates no OpenCode
binding, reservation, or front-door call. It creates one nested creation attempt/effect gate and waits
for the inner server's signed result/readiness before installing the chat edge. Terminal OpenCode
creation/bootstrap has no successor or continuation. After a crash, only the exact original
reservation may resume, and only while it remains `reserved`, its dispatch remains `not_started`, and
its original authorization remains unconsumed. Explicit pre-send abandonment atomically quarantines
that reservation, invalidates the old authorization, and, for bootstrap, makes the claim inapplicable;
it creates no replacement. A nested-management transport alone may install a continuation before
send, after the original authorization is atomically revoked under the signed
positive-never-started contract; the continuation receives a fresh authorization and must pass its own
final compare-and-swap. Once either kind of one-time authorization is consumed, its dispatch is
`started`, or its outcome is uncertain, neither a retry nor a successor may ever send, regardless of
any later apparent no-effect proof.

If an awaited injection fails, the current pump withholds the relay-session acknowledgement, logs the
failure, and keeps draining. The event remains eligible for replay only if that same `Session` later
gets a new downstream claimant; an ordinary OpenCode SSE reconnect does not reclaim the downstream
stream. Any such replay is not safe enough for durable remote delivery: if `prompt_async` reached
OpenCode and only its response was lost, retry can execute the prompt twice. The current failure path
also removes the text-origin suppression token; an eventual native user record can then be mislabeled
`local_prompt` even though remote-claw sent it. The new coordinator must write-ahead `started`, retain
the unresolved source/correlation record, treat that result as `outcome_unknown`, and quarantine later
remote-claw-origin deliveries. Terminal native prompt delivery has no revocation attestation,
continuation, or successor. A crash with no committed abandonment record may resume only the same
immutable attempt while its dispatch is still `not_started`, its command gate is still
`never_started`, and its original authorization and signed executor remain current. Explicit
operator cancellation or a configured shutdown policy deliberately committed before that CAS is
different: one atomic runtime-owner transaction writes the typed pre-send abandonment record, moves
the attempt, dispatch, and command gate to `quarantined`, and revokes the old protected dispatch
authorization.
A disconnect, process death, signal, ordinary restart, or missing record never implies this
abandonment. It sends no
`prompt_async`, creates no replacement, and cannot later be treated as crash-stranded work. A crash
around this transaction exposes either the complete quarantine or none of it, and exact replay
returns the same record. Selected A2 sets the terminal `user_text` family's
`positiveNeverStartedSchemaId` to null; only a nested transport has the separately signed
positive-never-started continuation described above. Once terminal dispatch is `started` or its
authorization is consumed, it never sends again, and OpenCode cannot retroactively prove that state
away. This does not pretend to fence or stop direct native-TUI actions.

Even a received `204` advances only transport receipt. Pinned OpenCode `1.17.5` accepts a valid
caller-supplied native `msg_*`; the current client omits it. The target writes a unique `msg_*` ahead of
delivery, sends it once, and correlates history/SSE by that exact ID. The retained
[OpenCode native proof](opencode-native-proof.md) shows that
with `noReply:true`, one server incarnation, and no requested provider reply, reusing the same ID is
not idempotent: the second POST adds another part to the same native message. That proof request is not
the selected A2 request because A2 forbids `noReply`; the compatibility driver is also not A2 because
it supplies `model` and omits the caller ID. The missing positive release fixture must exercise the
exact body and headers above through the private provider façade, with the real common admission,
runtime front door, and direct TUI present.

The ID enables positive read-back, never blind retry. Selected A2 requires one complete, linearly
proved `OpenCodeConversationHistorySnapshotRecord` for the same runtime, incarnation, binding,
session, workspace, and observer epoch. It must contain exactly one joined user message whose
`nativeMessageId` equals the stored `msg_*` and exactly one index-zero text part whose typed canonical
payload reproduces the admitted text and expected fingerprint. Its retained native-order evidence
must use the snapshot's proved sequence watermark, barrier observation, or atomic-store boundary.
Legacy SSE alone, an ID-only match, a text-only match, a `204`, an incomplete snapshot, or an
unlinearized history read cannot mark the attempt applied. Missing, extra, reordered, changed,
cross-session, or cross-incarnation evidence moves a possibly started attempt to `outcome_unknown`,
quarantines later remote writes, and never triggers another `prompt_async`.

OpenCode's native IDs/order override remote-claw's proposed order. The current text multiset used for
echo suppression is not native read-back evidence.

Future interrupt, summarize, permission, and question capabilities must follow the same native-outcome rule, but
outcome and source are different facts. Native status, history, or a terminal gate event can establish
what happened. Unless the pinned native surface also carries a durable action ID or another
unambiguous causal link, a TUI-versus-remote race cannot establish which client caused an abort or
compaction. The current client also ignores any abort/summarize response body, so its semantics are not
yet evidence. The projection records the native outcome with source `unknown` and leaves the
remote-claw proposal `outcome_unknown`; it must not infer causality from timing, an HTTP 2xx, or an
unproven boolean body.

In the **current compatibility driver**, `/compact` is dispatched without awaiting the long-running summarize request so an interrupt can
overtake the HTTP response wait. A dispatch error emits an OpenCode warning result and restores idle.
That behavior is not selected A2 writability. A future compact capability must journal the
remote-claw-origin compaction as its own proposal and apply the same delivery-uncertainty rule. A
compaction invoked directly through the native TUI remains a native observation rather than a
coordinator-admitted mutation.

## 6. Permissions

OpenCode normally decides tools from session permission rules. With mirroring enabled, the driver:

1. Reads and validates the complete parent-session rule vector.
2. If the exact `{permission:"*", pattern:"*", action:"ask"}` rule already exists, skips the
   non-idempotent native append.
3. Otherwise prepares that catch-all first, followed by the existing non-catch-all rules, preserving
   OpenCode's last-match-wins behavior.
4. Patches the session and reads the complete policy back.
5. Requires the read-back to contain the exact catch-all before registration becomes `ready`.
6. Repeats the same operation best-effort for newly discovered child sessions, using the run
   cancellation signal and a tracked task.

If the parent read, patch, or read-back fails, the driver publishes no conversation and starts no
pump. `--rc-oc-skip-permissions` performs no additional permission-setup read/PATCH/read-back and
advertises `structuredPermissions:false`; the exact session-confirmation GET still validates any
returned policy field, but the driver leaves that native policy untouched. A newly discovered child
can still execute its first tool before the asynchronous child setup lands, so successful parent setup
does not prove structured permission gating for child tools. The task is nevertheless lifecycle-safe:
it is retained, cancellation-fenced before PATCH, and joined under the same bounded teardown deadline,
so it cannot issue a new policy append after the driver has torn down.

The live OpenCode `PATCH` behavior is append-only: rules concatenate and an empty/null patch does not
clear them. The driver therefore cannot safely restore a borrowed session's original rules on
teardown. Once its catch-all ask rule is installed, it persists until the user clears the native
session policy. The future structured runtime should use an owned session/server or prove a reversible
permission-policy seam before advertising clean detach.

`permission.asked` becomes the relay's existing `permission_request`. Only an explicit viewer allow
maps to OpenCode `once`; a deny or malformed behavior with a valid request ID maps to `reject`. An
absent/invalid request ID is a no-op that the legacy downstream pump still acknowledges. There is no
implemented “always” choice, question flow, or durable recovery of an answer whose HTTP
acknowledgement was lost. The client safely parses the nondeprecated reply endpoint's successful JSON
and requires the literal value `true`; malformed JSON, `false`, or any other value fails closed instead
of being treated as an acknowledgement.

The current driver ignores `permission.replied`. If the native TUI answers first, the remote-claw
viewer gate can remain open and a later viewer answer can reach OpenCode as a stale response. Current
code therefore does not arbitrate TUI/viewer answer races. A literal `true` is a stronger transport ACK,
but the reply route contains no session ID and does not by itself prove that the request belonged to
the bridged session, that remote-claw won against the TUI, or that OpenCode reached a terminal gate
state. The retained proof schema-pins global `GET /permission` and the
`/permission/{requestID}/reply` request shape without creating or answering a gate. A session-scoped
list and the `permission.replied` event come only from current unretained OpenAPI/type inspection.
Those are promising native recovery seams, but their list/reply/event behavior and terminal semantics
must be runtime-proved before use.

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

The constructor begins with the conservative pre-registration vector: permissions, status, and
attachments false, with only the implemented interrupt control true. After successful registration,
the initial announcement contains:

| Capability | Advertisement | Actual state |
| --- | --- | --- |
| Structured permissions | `true` only after required parent read/install/read-back; `false` with explicit opt-out | Parent catch-all presence is proved before `ready`; child first-tool races and the still-unproved session ownership/TUI race/`permission.replied` terminal semantics prevent a stronger native-adjudication claim, even though reply JSON must now be literal `true` |
| Status | `false` | Later main-session events are useful observations, but initial/reconnect state is fabricated without `GET /session/status` and can remain wrong |
| Interrupt | `true` | Backed by `abort` |
| Set model | `false` | Internal handler accepts only `providerID/modelID`; viewer aliases are incompatible |
| Set mode | `false` | No native mapping |
| End | `false` | No native mapping |
| Attachments | `false` | The relay's Claude-style local-file prompt is not proved native OpenCode file-part fidelity |

OpenCode attachment proposals remain unsupported and non-writable until a retained fixture proves
exact native file-part fidelity. Any future admitted attachment must first be the exact common
`remote-claw/command-payload/attachment/v1` manifest with its ordered item-vector and decoded-content
digest chain; OpenCode's native JSON/file-part request is only a later proved translation. Before that
proof, the common A1 actor may authenticate and parse the proposal, but the adapter-capability decision deterministically rejects it as unsupported and
stores an `action_result`; it emits no `accepted`, projection sequence/intent, file write, or native
attempt. Its rejected command uses the common `unsupported_recognized` payload, not an admitted
attachment payload. Exact replay only redelivers that rejection, while changed bytes collide. Only
after the proof gate may OpenCode use the exact common-schema admitted-attachment
accepted/result/replay path. A feature is writable only after its setup and proof gate succeed.

The current compatibility relay does not enforce capability bits as an admission boundary. A stale or
custom sender can still submit an attachment frame, causing the relay to write the image and inject its
Claude-style `@"<path>"` prompt into OpenCode. `attachments:false` prevents the normal viewer from
offering that unsupported path; it does not turn the legacy relay into the future fail-closed command
actor.

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

OpenCode uses the same common adjudication as Claude and Codex before the adapter: full
machine/server/chat-or-server-control/source scope, stable semantic IDs, delivery-attempt binding,
multipart digest checks, one server-wide proposal order across web/official/automation/nested sources,
durable signed command results, and fail-closed collision/ambiguity.
An admitted result authorizes exactly one write-ahead OpenCode attempt; it does not mark that attempt
applied. Only correlated OpenCode history/events/status may do that. Direct TUI work bypasses
remote-claw proposal order, is observed afterward in OpenCode's native order, and is never invented as
a remote proposal. This rule does not make unsupported kinds writable: attachment parsing/ingress
support ends in a deterministic unsupported `action_result` until the adapter proves OpenCode-native
file-part semantics and their read-back.

Recovery must reattach the exact `runtimeId`/session/incarnation, subscribe before history backfill,
reconcile journaled attempts against native evidence, and leave ambiguous attempts quarantined. It may
start a different native session only as a separate, explicitly authorized recovery operation with an
explicit gap and explicit handling of proposals that were forwarded toward the old session. That is
never a successor delivery for an existing native attempt or creation reservation. Reattaching a
proven same semantic session is the future condition for retaining a logical-chat ID; a missing,
reused, or unproven `ses_*` cannot silently repoint that chat.

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
create responses, and marker-plus-intent metadata durability across a real server restart. They retain
all same-marker candidates from a current, complete, linearly proved and exhaustive successor
discovery snapshot. Each candidate retains a recomputable full native metadata ref/digest; canonical
two-field ref/digest fields are present only for the exact two-field shape. Tests bind exactly one only
after both evidence pairs and the expected intent digest verify, and quarantine wrong/missing/malformed
intent, noncanonical/extra metadata, and multiple matches; zero remains uncertain, while a gap, stale
pointer, omitted candidate, or marker-only match never binds. Recovery tests actively drain
subscribe-before-snapshot overlap under slow history, high event
rate, stream drop, overflow, and pre-merge crash. Direct-TUI/remote input races resolve by native
IDs/order. Caller-supplied native message-ID correlation proves `prompt_async` `204` versus native
application, retained origin after an ambiguous POST, and non-idempotent same-ID retry behavior.
Cross-incarnation creation tests additionally pin the original signed store-open evidence before
dispatch and require an exact predecessor-stop/fence plus exclusive-successor-open continuity
handoff. A cloned store, copied embedded identity, live predecessor handle, parallel writer,
reset/fork, or missing handoff stays `lineage_unproved` and cannot bind.

Front-door tests compare the pinned TUI directly against OpenCode and through its TUI front door, then
reject raw private-listener access, including from an OpenCode-spawned tool, an unclassified third client, a second TUI, a stale/concurrent
wrapper, and a valid adapter credential aimed at the wrong `ses_*`, child, or permission. They crash
around the last-hop dispatch CAS/socket write and require the attempt, dispatch, and command gate to
start in one commit with no partial state or second forward. A separate explicit
pre-send cancellation vector requires one atomic abandonment record and one transition of the
attempt, front-door dispatch, and command gate to `quarantined`, with null dispatch-start time,
receipt, started-attempt ID, and native read-back and with the exact same abandonment
schema/ref/digest triple on all three rows. It proves zero native call, a revoked old protected
authorization, no
replacement/continuation/successor, all-or-nothing crash recovery on both sides of the transaction,
byte-identical exact replay, and collision on a changed reason, sequence, coordinate, or digest. The
crash-stranded no-record case still resumes only the original immutable attempt. Tests race
abandonment against dispatch in both orders and reject any downgrade from a started/receipted/read-back
attempt, started dispatch, started gate, stale executor, or changed protected reference/digest. A process exit
without the record never implies cancellation; a later distinct authenticated source event may still
use the otherwise-current binding. A nested continuation rejects the local abandonment record.
Capability tests race
signed-snapshot withdrawal, same-ID content substitution, translator
schema/implementation/build/injectivity-proof drift, upgrade, and revocation at decision, claim,
restart, and replay. Slash tests require pre-decision typed normalization followed by deterministic
stored rejection for `/compact`, `/clear`, `/model`, `/context`, blank input, and every other unproved
reserved command in selected A2, zero generic user projection or native call, raw-as-user bypass
rejection, stored result redelivery on exact replay, and collision on changed bytes. Start/steer tests
prove that explicit new submit remains `user_text`, explicit steer remains unsupported `steer_text`,
and busy state or timing changes neither classification.

One retained A2 vertical slice must enter through the real common A1 ingress actor, not call the
OpenCode adapter directly. It sends one semantic prompt, crashes at the decision/outbox/native-attempt
boundaries, rolls the broker generation, and replays the complete exact A1 input through a fresh
broker delivery while native recovery keeps the one original `NativeDeliveryAttemptRecord`. A crash
before `delivery.started` eventually permits exactly one `prompt_async`. Once
`delivery.started` is durable, including a crash before the HTTP write, the fixture permits at most one
send. The pre-start recovery resumes the same stored attempt and original authorization, never a
successor or continuation. In the explicit-cancellation branch, the fixture commits the pre-send
abandonment transaction instead and requires all three rows to remain terminally quarantined with no
send or later resume. After start, recovery must either read back one native user message under
the caller `msg_*` with the exact
expected part count and per-part fingerprints, or record `outcome_unknown` and quarantine the binding.
The fresh A1 replay only redelivers the stored coordinator result and never adds a native send. Reusing
the native message ID must not be the recovery mechanism: an extra or changed native part is a native
collision/gap, not evidence of one accepted attempt.

That retained slice must also capture the selected request byte-for-byte: `POST` to the exact
`/session/{ses_*}/prompt_async` path, empty query, only the selected content-type and canonical
directory semantic headers, and strict compact
`{"messageID":...,"parts":[{"type":"text","text":...}]}` with no `model` or `noReply`. It must prove
the exact signed admitted-result tuple and executor evidence authorize the one attempt, the signed
capability snapshot selects the measured translator, the private provider façade supplies the normal
configured model path, and a complete linearly proved history snapshot supplies the exact native
application and order. A companion creation vector must retain the exact `POST /session` metadata
body, mandatory full native metadata ref/digest for every same-marker candidate, nullable
classification-gated canonical two-field ref/digest, the full reconciliation vector, and expected
intent digest. It must prove marker/intent survival across response, discovery, and native restart;
current, complete, linearly proved and exhaustive snapshot enforcement; and fail-closed wrong or
malformed intent, noncanonical/extra metadata, zero-match, and multiple-match behavior.

Future-capability interrupt/compact tests pin response-body semantics and separately prove native
outcome and causal attribution under direct-TUI-versus-remote races and lost responses before either
family is added to an A2 vector; when the pinned surface has no causal seam, source must remain
`unknown`. Permission tests cover child creation/first-tool policy races, cancellation-fenced child
setup, literal-true reply acknowledgement, and TUI/remote races closed by a native terminal gate event.
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
