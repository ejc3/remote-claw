# Experimental OpenCode compatibility driver

`--rc-driver=opencode` bridges one `opencode serve` session into the existing encrypted
remote-claw broker. It is implemented and tested as an experimental adapter. OpenCode is an intended
product surface; this implementation is not yet the durable, coexistence-tested release version.

OpenCode owns the native `ses_*` conversation. remote-claw creates a separate synthetic `cse_*` for
the broker channel and viewer row. Reattaching the same `ses_*` after a wrapper restart can backfill
native history into a new `cse_*`; it does not preserve one durable remote-claw chat identity or a
restart-safe writable binding.

## 1. Topology and options

```text
OpenCode TUI ─┐
              ├─ opencode serve ⇄ OpencodeDriver ⇄ Session ⇄ encrypted broker/viewer
model provider┘
```

The driver uses OpenCode's HTTP and SSE API directly. It does not start the Claude MITM and does not
spawn or manage `opencode serve`. The server continues to own its native UI, model-provider access,
sessions, and history.

Relevant options are:

- `--rc-oc-url` or `OPENCODE_URL` — server origin; default `http://127.0.0.1:4096`.
- `--rc-oc-session` or `RC_OC_SESSION` — exact existing canonical `ses_*` to attach.
- `--rc-oc-model` or `RC_OC_MODEL` — `providerID/modelID` used for remote turns.
- `OPENCODE_SERVER_PASSWORD` — optional HTTP Basic password with an empty username.
- `--rc-oc-skip-permissions` or `RC_OC_SKIP_PERMISSIONS` — leave native permission rules unchanged.

The default model is
`amazon-bedrock/global.anthropic.claude-sonnet-4-6`. The OpenCode server process must have whatever
provider credentials that model needs; remote-claw does not acquire or pass them through the browser.

## 2. Fail-closed attachment

The driver creates its synthetic `Session` privately and constructs `ReadyBridge` in `starting`. No
broker client or presence announcement exists until native setup succeeds.

Session selection is strict:

1. `GET /session` must return an array of unique canonical `ses_*` IDs.
2. A configured `--rc-oc-session` must appear exactly in that snapshot.
3. Without a configured ID, any non-empty snapshot is ambiguous and startup fails. Only a valid empty
   snapshot permits one `POST /session`.
4. `GET /session/{id}` must then return the exact selected ID and either no permission field or a fully
   valid permission-rule vector.
5. With permission mirroring enabled, the parent session's catch-all ask rule must be present on a
   complete read-back before `ReadyBridge.start()` may run.

The driver never selects “most recent.” A malformed response is not treated as an empty list. A lost
create response can leave an unannounced native session; the driver does not guess which session it
was or blindly delete another one.

After setup, the driver calls `ReadyBridge.start()` once with the final conservative viewer
capabilities. Only that call creates `HostRcRelay`, starts the broker bridge, and publishes presence.

## 3. Native HTTP and SSE surface

`packages/cli/src/host/rc/opencode/client.ts` is a small dependency-free client built on Node's
`fetch`:

| Operation | Route |
| --- | --- |
| List sessions | `GET /session` |
| Create one session | `POST /session` with optional `{title}` |
| Confirm/read policy | `GET /session/{id}` |
| Read history | `GET /session/{id}/message` |
| Send a turn | `POST /session/{id}/prompt_async` with `{model, parts}`; success is an empty `204` |
| Interrupt | `POST /session/{id}/abort` |
| Compact | `POST /session/{id}/summarize` with `{providerID, modelID, auto:false}` |
| Update policy | `PATCH /session/{id}` with `{permission: rules}` |
| Answer permission | `POST /permission/{requestID}/reply` with `once` or `reject` |
| Follow events | `GET /event` server-wide SSE |

HTTP errors expose only a stable operation and status. Native response bodies and provider messages do
not enter local diagnostics. The visible E2E `session.error` result may contain a human-readable
provider error for the viewer; the local trace records only narrow structural fields such as numeric
status and retryability.

The SSE client filters by the session ID carried in event, message, or part shapes. Global connection
and heartbeat events pass through. `session.created` events are also observed so the driver can follow
children whose `parentID` belongs to an already-followed session.

## 4. Capture and translation

On each SSE connection, the driver waits for the first live event, then reads native history before
processing subsequent live events. Reconnects use capped exponential backoff and repeat history
backfill.

This subscribe-first sequence narrows a snapshot race, but it is not a durable transaction: the SSE
has no replay cursor, process loss can discard buffered bytes, and recent-ID dedup is bounded to 4,096
entries. A history replay larger than that window can re-emit an evicted message.

OpenCode sends whole part replacements, not token deltas. The driver buffers parts by message ID and
emits a message once it is complete. A mid-turn history attach seeds an incomplete assistant into the
buffer and waits for its live completion instead of freezing a partial response as delivered.

`packages/cli/src/host/rc/opencode/translate.ts` maps only the understood subset:

| OpenCode part | Canonical relay block |
| --- | --- |
| text | `text` |
| reasoning | `thinking` |
| pending/running tool | `tool_use` |
| completed/failed tool | `tool_use`, followed by user-role `tool_result` |
| subtask | `Task` `tool_use` anchor |
| housekeeping or unknown part | dropped |

Child sessions are followed while live. Their assistant output is tagged with the parent Task anchor
so the viewer nests it. The parent subtask part does not contain the child session ID, so correlation
uses parent session, agent, and FIFO order. Concurrent same-agent child sessions can therefore be
mis-nested for display. Finished children are removed from the live follow set; complete historical
child discovery is not implemented.

Main-session user messages are matched against a bounded multiset of text the driver injected. A match
is the remote prompt echo and is suppressed because the relay already rendered it. An unmatched user
message is marked `local_prompt:true` and shown in the viewer. Concurrent identical text from the TUI
and browser can be misattributed; that changes display attribution, not what OpenCode executes.

## 5. Injection and controls

The injection pump serially drains `Session.followDownstream`:

| Session event | OpenCode action |
| --- | --- |
| blank `user` text | no-op, then acknowledge |
| ordinary `user` text | `prompt_async`, then acknowledge the session event |
| exact `/compact` | dispatch `summarize` without blocking later interrupt handling |
| `initialize` | no-op, then acknowledge |
| `interrupt` | await native `abort`, then acknowledge |
| internal `set_model` | accept only `providerID/modelID` for later prompts |
| `set_permission_mode`, `end`, unknown control | safe no-op, then acknowledge |
| permission response | send one native permission reply, then acknowledge |

The viewer advertises model switching as false because its ordinary model aliases do not match the
OpenCode `providerID/modelID` contract. The internal handler remains defensive for old/custom clients.

A failed `prompt_async` rolls back its echo-suppression token and withholds the session acknowledgement.
The empty `204` is a transport receipt, not proof that OpenCode applied the turn. If OpenCode accepted
the request and its response was lost, a later retry can duplicate work. The current compatibility
driver does not provide durable exactly-once input or safe ambiguous-outcome recovery.

`/compact` is dispatched in the background because awaiting the whole summarize operation would block
an interrupt behind it. A dispatch failure becomes a visible result and returns the displayed status to
idle.

## 6. Permissions

Permission mirroring is on by default. Before readiness, the driver:

1. reads the complete parent policy;
2. skips mutation if the exact `{permission:"*", pattern:"*", action:"ask"}` rule already exists;
3. otherwise places that catch-all before existing rules so later specific rules still win;
4. patches the session; and
5. requires a complete read-back containing the catch-all.

A parent read, patch, or read-back failure prevents announcement. Newly discovered children receive
the same setup best-effort, but OpenCode can execute a child's first tool before that asynchronous
setup lands. Parent readiness does not prove child gating.

OpenCode's observed policy PATCH behavior is append-only: empty or null updates do not clear the old
rules. The driver therefore does not attempt a misleading restore on teardown. A catch-all it added can
persist on a borrowed session until the user changes the native policy. The skip-permissions flag avoids
that mutation and advertises structured permissions false.

`permission.asked` becomes the shared relay's `permission_request`. Only explicit allow maps to native
`once`; deny or malformed behavior maps to `reject`. The native reply must return JSON literal `true`.
The driver does not use `permission.replied` to arbitrate a race with the native TUI, so a viewer gate
can remain open after a local answer and a later remote answer can be stale.

## 7. Advertised capabilities

| Capability | Value | Reason |
| --- | --- | --- |
| Structured permissions | true after parent setup; false with opt-out | parent catch-all is read back, but child and local-answer races remain |
| Status | false | no proven initial status snapshot; later SSE status is useful but incomplete |
| Interrupt | true | native abort route |
| Set model | false | viewer alias format is incompatible |
| Set mode | false | no faithful mapping |
| End | false | no native session-end mapping |
| Attachments | false | Claude-style local-file injection is not native OpenCode file-part fidelity |

The relay rejects attachments before reassembly or file writes when this vector is active.

## 8. Teardown and recovery limits

Parent cancellation closes `ReadyBridge` and the synthetic `Session`, stops capture and injection,
best-effort aborts the attached OpenCode run, and joins tracked child-policy tasks. These share one
two-second deadline. The driver does not stop the external server.

A fatal broker relay failure closes only the compatibility projection and its injection pump. The
driver keeps the attached native turn and external OpenCode server alive until parent cancellation or a
native pump failure. Viewer `end` does not trigger teardown and is disabled.

Current recovery does not preserve a durable bridge/native binding, input journal, permission gates,
SSE cursor, complete child lineage, or provider isolation. A native crash can also leave an incomplete
assistant message without a future completion event; the driver will not invent a terminal message.

The small retained protocol fixture in [opencode-native-proof.md](opencode-native-proof.md) documents
caller-supplied message-ID behavior for OpenCode 1.17.5. It is research evidence, not a release gate or
runtime authority.

## 9. Tests

Tests beside `packages/cli/src/host/rc/opencode/**` cover strict HTTP/SSE parsing, attachment selection,
translation, message coalescing, bounded dedup, history backfill, reconnect, local-prompt attribution,
controls, permissions, visible errors, and child nesting.

The optional live suite is:

```bash
OPENCODE_URL=http://127.0.0.1:4096 \
pnpm --filter @remote-claw/cli run test:opencode-live
```

The script sets the required `RC_OPENCODE_E2E_RUN=1` opt-in. Ordinary CLI tests never probe port 4096,
even if an OpenCode server happens to be running. The live suite fails if the explicit target is
unavailable. It proves the model-free caller-ID/ambiguous-retry observation and one real
`OpencodeDriver` text turn. It does not prove coexistence with the real OpenCode TUI.
