# Experimental OpenCode compatibility driver

> **Status:** the A0 compatibility driver is implemented behind `--rc-driver=opencode`. It registers
> through the process-local host seam and stays hidden until one exact native session is confirmed and,
> unless explicitly skipped, parent permission setup is read back. This A0 behavior remains as built.
> The durable A1/OpenCode design is optional parked multi-engine work, not the next tranche or a blocker
> for the active [Claude 1.0 finish line](release-finish-line.md). Remote `new_chat`, a generic HTTP/TUI
> front door, shared-runtime generalization, and every other mutation family remain unimplemented
> optional scope. Retained native fixtures and dormant capability/evidence codecs are audit inputs, not
> runtime authority. This implemented flag is experimental/internal, not a supported stable driver;
> parser support, tests, and live evidence do not promote it into the Claude 1.0 release surface.

**Identity scope.** The current driver has two distinct IDs: OpenCode owns the native `ses_*`, while
`RelayCore` creates a synthetic `cse_*` for the remote-claw broker channel and viewer row. Neither is
an implemented durable remote-claw logical-chat ID. A wrapper restart may reattach and backfill the
same `ses_*` into a fresh compatibility channel, but it does not yet preserve one canonical
remote-claw chat across that restart. The optional A1 design targets a persisted
`(collaborationServerId, logicalChatId)`-to-native binding; that pair identifies the canonical chat
within one machine. Its machine-facing viewer row, chat route, alias, channel, and cache keys use the
full `(identity_id, collaborationServerId, logicalChatId)` triple; the discovery bus is the distinct
null-chat `(identity_id, collaborationServerId, scope_bus)` route and cursor. Every optional A1 remote
command targets one already-selected `ses_*`; onboarding must either prove an exact existing session or
durably reconcile one write-ahead local creation before advertisement. It exposes neither remote server
control nor remote session creation.

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

The parked optional A1 path is deliberately narrower than a general native proxy:

```text
browser → encrypted broker → common A1 ingress/adjudication
        → signed admitted result → command-keyed execution row
        → typed user_text port → private OpenCode listener ← mediated real TUI

OpenCode → selected local provider facade → connector
                                           local/credentialless in alpha
                                           credentialed/external only at a future gate

strict native observation → host-output ledger → seal/outbox → broker → browser
```

Only a nonempty scalar text whose first Unicode code point is not U+002F (`/`) can reach A1 execution.
The runtime-owned adapter accepts one typed `dispatchUserText` value and owns the method, path,
headers, strict encoder, target session, and held connection. The command actor cannot supply a URL,
method, header map, JSON object, or raw socket. A separate strict observer performs exact read-back.

The signed admitted result is the cross-boundary authorization. It pins the stable
server/chat/binding/session/workspace target and adapter contract. A current binding activation is a
revocable local handle used only at start; it is not a signed capability snapshot, an evidence tree,
or admission authority. Normal build/version pins and executable integration tests would establish a
future gate's provenance. Live process, socket, namespace, workspace, and lease checks would establish
currentness.

If resumed, an alpha must use the production process topology: a deterministic local connector, no provider credential
or external provider route, a mediated real TUI, and the hostile-child filesystem/IPC/network fence.
Any later credentialed gate must preserve the same command, request, read-back, output-ledger, onboarding,
TUI, and isolation semantics while adding a persistent selected workspace, exhaustive recovery, a
credential-holding external connector, normal health withdrawal, and production advertisement. Stock
OpenCode 1.17.5 and the retained native proof do not establish either outcome by themselves.

In that optional design, the mediated TUI remains a native collaborator and does not enter the remote collaboration order. A1
proves only this one owned TUI/private-listener topology. Generic front-door parity, arbitrary native
routes, shared daemons, remote session creation, and additional mutation families remain further
optional scope.

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
The optional owner must avoid this A0 race by either attaching an exact existing session or reconciling
one write-ahead local creation while it controls the private listener. TUI mediation and advertisement
start only after the exact binding is durable.

The optional remote path never infers identity from “most recent” and never accepts `new_chat`.
Onboarding must either attach an explicitly selected exact `ses_*` with matching workspace identity, or
write ahead one local creation intent, send at most once, and reconcile a lost response from exact
native state before binding. Ambiguous creation never authorizes retry or advertisement. If the bound
session is later absent, changed, or unproved, the binding is not writable and never silently repoints.

Remote **New chat**, generalized import/create/switch, and cross-incarnation session creation remain
separate optional work. The retained creation-marker fixture is protocol evidence only; a durable
creation path would still need exact intent, send-once, and reconciliation state.

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
A later registration detects the exact installed catch-all and skips another append. The optional
design cannot reuse this A0 create path: it needs a write-ahead creation identity and exact
reconciliation, and ambiguity prevents advertisement.

On normal driver teardown, the driver first aborts its local capture/injection pumps and closes the
relay session. It then best-effort aborts the attached OpenCode run, closes the registration lease,
and joins every tracked child permission-setup task. Those operations share one bounded two-second
deadline, so an unresponsive native server, child setup, or broker cannot hold exit for consecutive
timeout windows. Teardown aborts the run signal first; each child task receives that signal and checks
it after its initial read and before PATCH, so even an injected client that ignores abort cannot begin
a late PATCH after its read resolves. A native request already accepted before cancellation cannot be
undone. The driver does not stop the external `opencode serve` process. A future A1 runtime owner would have to
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
| Create session | `POST /session` with optional `{title}` → one validated canonical native `ses_*`; compatibility-only, not optional A1 authority |
| List sessions | `GET /session`; registration validates the complete ID vector and ignores recency for identity |
| Confirm session | `GET /session/{id}` must return that exact ID and a completely valid permission vector |
| Read history | `GET /session/{id}/message`, chronological messages with parts |
| Send prompt | The compatibility client sends `POST /session/{id}/prompt_async` with `{model, parts}` and no caller `messageID`; pinned `1.17.5` separately accepts caller `messageID`; this is not the optional A1 request, and an empty `204` is transport receipt, not proof of native application |
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
bytes. That narrows the obvious snapshot-then-subscribe gap but is not the optional design's actively
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
resulting user message. A1 preserves the TUI as a native collaborator but mediates its access to the
owned private listener for containment; it does not put the TUI into the remote collaboration order.
remote-claw orders remote collaborators behind its typed adapter, while OpenCode determines the final
interleaving with the TUI. The optional design must prove this narrow topology; generic front-door
parity remains later optional work.

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

That table is A0 behavior, not A1 authority. A failed A0 `prompt_async` withholds the relay-session
acknowledgement and can become eligible for replay even when OpenCode applied the first request. Its
text-only echo suppression can then misattribute the native message. That is one reason the
compatibility pump is not promoted into A1.

### Optional A1 `user_text` contract

The implemented schema-v6 terminal-root certificate remains the authority that makes the terminal chat
and edge current. An optional OpenCode activation must supplement that root and recheck its current,
unexpired owner/coordinator/binding/attachment graph; it cannot bypass or replace it. Current schema
v10/v11 can finalize only rejected results, and v11's `pending_seal` row is an unclaimable plaintext
intent. Admitted execution and output publication described below do not exist today.

Every optional A1 proposal first crosses the common authenticated source, ordering, command, decision, and
result path. OpenCode has no adapter-specific admission shortcut. The only writable family is
binding-scoped `user_text`:

- empty text is non-writable; nonempty whitespace-only text is not silently reclassified as empty;
- any text whose first Unicode code point is U+002F (`/`) is non-writable, regardless of the
  remaining bytes; there is no slash-command allowlist and no raw-text fallback;
- steer, interrupt, permissions, questions, attachments, session creation, and every non-text family
  are non-writable; and
- classification does not depend on native busy state, timing, or model state.

Unsupported input receives one stored signed rejection and creates no execution row or native call.
Exact replay redelivers that result; changed bytes collide. Whitespace is not trimmed before the
leading-slash check: U+002F is leading only when it is the first code point in the submitted text.

An admitted command requires a fully signed `CollaborationCommandResultRecord` with
`disposition:"admitted"` and this immutable authorization tuple:

```text
collaborationServerId
commandId
admittingCommandResultId
canonicalCommandRecordDigest
admittingCommandResultSignedRecordDigest
```

One finalization transaction verifies the signature and atomically stores the admitted result, signer
acceptance, OpenCode sidecar, and prepared execution row. The signed result pins the stable server/chat/binding/session/workspace target and the fixed adapter
contract. It does not pin a runtime incarnation or depend on a local capability/evidence snapshot.
Unsigned, queued, rejected, different-command, different-result, or transplanted records cannot create
execution.

Admission inserts exactly one execution row whose primary key is `commandId`; that row is the attempt,
effect gate, and dispatch state. While `prepared`, it pins the admitted-result tuple, exact `ses_*`,
workspace, adapter-contract digest, generated caller `msg_*`, canonical request bytes and digest, and
expected read-back fingerprint. Its activation is null. Immediately before the first possible native
byte, one transaction rechecks the durable target and current live handles, stores one compatible
binding activation, and changes `prepared → started`. Unknown commit outcome sends nothing and
quarantines. Once `started`, no restart, replay, takeover, or apparently absent read-back authorizes a
second send.

Legacy `nat_*` native-delivery-attempt IDs and `NativeDeliveryAttemptRecord` designs remain dormant
historical schema/test material. They are not active A1 identity or authority and are not layered beside
the command-keyed execution row.

The typed port accepts only:

```text
OpenCodeUserTextV1 {
  activationId
  commandId
  nativeConversationId
  nativeActionId
  canonicalDirectory
  text
}
```

### Optional exact A1 `user_text` native request

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

The runtime owner allocates and persists a unique `nativeActionId` as `msg_` plus unpadded base64url of
16 random bytes before request construction. The body keys and one-part array have exactly the order shown.
The quoted placeholders denote the generated string contents after the selected strict JSON encoder.
`model`, `noReply`, agent/system fields, extra or reordered parts, extra keys, query aliases, and
alternate directory headers are forbidden. Any typed-port channel credential is outside the
semantics-relevant header vector. The canonical directory is the exact pinned absolute POSIX workspace
path from the binding; it is not trimmed, percent-encoded, or base64-encoded.

JSON strings use the selected strict encoder: quote and backslash are escaped, U+0000–U+001F use
lowercase `\u00xx`, and other Unicode scalar values are emitted as UTF-8 without normalization or
optional escapes. Lone surrogates and invalid UTF-8 reject before request construction. A generic map
serializer cannot choose another equivalent spelling.

Even a received `204` advances only transport receipt. Pinned OpenCode `1.17.5` accepts a valid
caller-supplied native `msg_*`; the current client omits it. The target writes a unique `msg_*` ahead of
delivery, sends it once, and correlates history/SSE by that exact ID. The retained
[OpenCode native proof](opencode-native-proof.md) shows that
with `noReply:true`, one server incarnation, and no requested provider reply, reusing the same ID is
not idempotent: the second POST adds another part to the same native message. That proof request is not
the optional A1 request because that design forbids `noReply`; the compatibility driver also differs because
it supplies `model` and omits the caller ID.

The OpenCode prompt and provider request are separate irreversible effects. Before the provider facade
permits the connector's first possible inference byte, the optional host must write ahead the exact
provider-request identity and digest and consume a one-use start fence. A lost or ambiguous connector
response never authorizes another provider request. A deterministic local connector must exercise the
same boundary; it is not a shortcut around it.

The caller ID enables positive read-back, never blind retry. Before dispatch, the strict observer
establishes the selected session's SSE stream. After the transport receipt it waits for the selected
terminal barrier, then performs two strict reads: the exact session read must pin the `ses_*`, canonical
directory, and expected OpenCode version; the unfiltered top-level history vector for that session must
be wholly valid, retain native vector order, and contain
exactly one user message with the stored `msg_*` and exactly one index-zero text part whose bytes and
fingerprint reproduce the admitted text. The current compatibility client's permissive filtering is
not this observer. A `204`, SSE timing alone, text-only or ID-only matching, absence from one read, or a
partial/malformed read is not proof. Missing, extra, changed, or cross-session evidence after start
becomes `outcome_unknown`, quarantines later remote writes, and never triggers another `prompt_async`.

Assistant output belongs to this command only when its `assistant.parentID` equals the exact stored user
`msg_*`. A concurrent TUI turn can interleave adjacent user and assistant messages, so timing, text,
position, and nearest-neighbor matching are not causal evidence. Missing, changed, or multiply claimed
`parentID` leaves the output unowned/ambiguous.

Successful observation produces the signed admitted command outcome and exact native output
projection. Every `accepted`, `assistant`, `action_result`, and `session_announce` output is signed and
sealed before publication. A durable host-output ledger stores its semantic identity, route,
plaintext-artifact digest, exact encoded-frame artifact/digest/length, and outbox state. Outbound ingress recognizes host-produced
frames only by that exact ledger record; an unknown or changed outbound frame quarantines instead of
being mistaken for foreign input. Source acknowledgement waits for durable broker acceptance, or exact
replay of the already accepted frame. The viewer rebuilds only from the signed result, native
observation, output ledger, and sealed outbox.

The observation finalizer must be one transaction: it consumes the exact observation and either moves
the execution to completed while inserting every corresponding output intent, or moves it to
`outcome_unknown`, quarantines the binding, and inserts the signed unknown-result intent. A terminal
execution without its output intent, or an output intent for a nonterminal execution, is forbidden.

### Optional proof gates and deferred scope

These gates are preserved for a future explicit multi-engine product decision. They are not an active
sequence and do not block Claude 1.0.

A parked alpha entrypoint candidate is:

```text
remote-claw --rc-app <origin> --rc-driver=opencode \
  --rc-a1-local-alpha --rc-oc-workspace <absolute-path>
```

`--rc-a1-local-alpha`, `--rc-oc-workspace`, and the local `--rc-a1-pass` onboarding action are parked
interface candidates, not current parser claims or roadmap commitments. The current flags in section 2
still select only A0.

**A parked safe local-provider alpha** would be user-runnable and exercise `rcp2.` onboarding and
discovery, the real browser and zero-knowledge A1 broker, persistent secure host repositories, signed
admission, command-keyed execution, the mediated TUI/private listener, real OpenCode, a deterministic
credentialless local connector, strict read-back, the durable output ledger, sealing/publication, and
viewer. It requires a disposable selected workspace, the production containment topology, no real
provider credential or external provider route, and only an explicit alpha advertisement while live
health is green. Ambiguity fails closed rather than guessing or resending.

**A parked credentialed production gate** must preserve those exact topology, onboarding, command, request,
read-back, result, ledger, isolation, and viewer semantics. It adds an explicitly selected persistent
workspace, exhaustive durable recovery and replay, owner/runtime/OpenCode/facade/connector takeover, a
credential-holding external connector outside the OpenCode/tool boundary, normal health withdrawal,
and optional OpenCode `user_text` advertisement.

Further optional scope includes remote `new_chat` and generalized `POST /session` control, generic HTTP
or TUI front doors, shared OpenCode daemons,
slash commands, steer, interrupt, permissions/questions, attachments, and broader adapter/capability
generalization. Retained creation markers, generated route manifests, and local evidence codecs may
inform that later design but authorize nothing. Native-attempt IDs remain historical/dormant; any
resumed design must choose its identity model rather than inherit them as authority.

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
session policy. Any optional permission capability must use an owned session/server or prove a
reversible permission-policy seam before advertising remote control or clean detach.

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

Remote permission answers are outside this optional `user_text` design and reject before execution. Any
later permission capability must journal an answer before delivery, prove its terminal native outcome
without sending a contradictory second answer, and resolve TUI-versus-remote races. The current A0
permission behavior is not evidence for that later capability.

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

The optional A1 actor must deterministically reject attachments before an execution row or file write. Exact replay
redelivers that rejection; changed bytes collide. Native OpenCode attachment translation and read-back
remain optional and require their own retained proof before advertisement.

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
- command-keyed A1 execution or exact native application evidence;
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

In the optional host-runtime design, authority is divided cleanly:

| Fact | Authority |
| --- | --- |
| Which remote-claw collaborator proposal is forwarded next | remote-claw coordinator journal |
| Final interleaving of the native TUI and remote-claw connection | OpenCode server/session |
| Whether the A1 user text actually applied | Strict exact-session plus complete message-history observation; generic HTTP receipts and SSE timing are insufficient |
| OpenCode conversation content after wrapper loss | OpenCode native store, with explicit gaps where evidence is absent |
| What the local person sees | The native OpenCode TUI rendering the native session directly |
| Viewer/official-client representation | signed result plus durable host-output ledger and rebuildable sealed projection |
| Model/provider access | isolated inference connector, never the OpenCode process directly |

The optional OpenCode design uses the common binding-scoped command order, signed result, and collision rules before the
typed adapter. The signed admitted result authorizes creation of exactly one command-keyed execution
row; it does not prove native application. Only the strict session-plus-history observation can do
that. Direct TUI work remains native work, not an invented remote proposal.

An optional alpha must prove focused crash points by failing stopped: uncertainty quarantines and never resends.
Any later credentialed gate adds exhaustive recovery of that same execution row, native observation,
host-output ledger, and sealed outbox across owner/runtime/OpenCode/facade/connector/broker restart. A
missing, reused, or unproved `ses_*` cannot silently repoint the logical chat. A stale activation cannot
start new work, and revocation never pretends to undo a native byte already sent.

Dormant `nat_*` IDs and old native-attempt/effect-gate tables document earlier decomposition only. The
optional A1 recovery identity is `commandId`; transport-level broker delivery-attempt IDs remain a
separate ciphertext-delivery concern.

## 9. Tests

The checked-in unit tests cover HTTP/SSE parsing, translation, coalescing, deduplication, attach
mid-turn, reconnect/backfill, injected-echo rollback, compact routing, visible errors, permissions, and
child-session nesting/isolation.

If resumed, the optional alpha gate must be runnable by a user and retain one complete
browser-to-viewer turn through real `rcp2.` onboarding/discovery, the A1 broker and host repositories, a
current schema-v6 terminal root, a signed admitted result, one command-keyed execution row, the exact
request bytes, the mediated real TUI/private listener, real OpenCode 1.17.5, a credentialless local
connector, strict session-plus-history read-back, the atomic observation-to-terminal/output-intent
transition, durable host-output ledger, sealing/outbox publication, and viewer rendering. It must cover
exact-existing-session attachment and write-ahead local-creation reconciliation, provider-request
write-ahead with no resend, and concurrent TUI turns whose assistant output is accepted only by exact
`parentID`. Negative cases reject empty text, every U+002F-leading string (including unknown slash
strings), changed replay, unsupported families, plaintext broker storage, raw-listener/owner/facade
access from a hostile child, external egress, and ambient connector credentials.

The optional credentialed gate reruns that exact topology through the ordinary daemon, persistent
selected workspace, and real connector, then faults every admission/native-start/provider-start/
read-back/finalization/ledger/seal/publish boundary plus every
owner/runtime/OpenCode/facade/connector/broker transition. It proves one execution
row per command, at most one native send, exact redelivery after accepted publication,
`outcome_unknown` quarantine after ambiguity, stale-activation withdrawal, provider credentials and
external sockets outside the OpenCode/tool boundary, and advertisement only while health is current.

`new_chat`, creation-marker recovery, generic front-door parity, broader native routes, TUI
generalization, and all other mutation families remain further optional tests.

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
pinned nor retained, does not use the common A1 actor, and proves no optional durable capability. Any
resumed alpha gate must add the retained narrow mediated-TUI fixture; generic front-door and
broader-route fixtures remain later optional scope.
