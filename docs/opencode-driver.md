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

The current path has two independent connections:

```text
configured model provider
          ▲
          │ OpenCode provider traffic
          │
OpenCode server (`opencode serve`)
  ├── sessions and native message history
  ├── GET /event server-wide SSE
  └── session HTTP commands
          ▲
          │ loopback HTTP/SSE
          │
OpencodeDriver
  ├── client.ts       dependency-free fetch/SSE client
  ├── translate.ts    OpenCode parts → relay content blocks
  └── driver.ts       capture, inject, permissions, status
          │
          ▼
Session → HostRcRelay → encrypted remote-claw broker → web viewer
```

The driver controls OpenCode through its own server API. It does not use the Claude MITM and does not
spawn Claude. Today, however, the OpenCode server itself can still contact whichever provider its
configuration selects. That provider path is outside the current driver.

The selected host-runtime design changes the top half:

```text
OpenCode process
  ├── control: private OpenCode HTTP/SSE server
  └── inference: private provider-shaped façade(s)
                         │
                         ▼
                 isolated inference connector
```

The OpenCode process will be network-fenced so it cannot reach a real provider directly. Its control
server remains the native engine-control surface; provider façades are a separate model/API brokerage
surface. Both sit behind the remote-claw host boundary.

## 2. Launch and attachment

The dispatcher calls `runOpencodeDriver` for `--rc-driver=opencode`. Relevant options are:

- `--rc-oc-url` or `OPENCODE_URL`: server origin, default `http://127.0.0.1:4096`;
- `--rc-oc-session` or `RC_OC_SESSION`: exact `ses_*` to attach;
- `--rc-oc-model` or `RC_OC_MODEL`: `providerID/modelID` for turns;
- `OPENCODE_SERVER_PASSWORD`: optional HTTP Basic password, with an empty username; and
- `--rc-oc-skip-permissions` or `RC_OC_SKIP_PERMISSIONS`: do not add remote-claw's catch-all
  permission rule.

When no session ID is supplied, the driver uses the most recently updated session from
`GET /session`; if the server has no sessions, it creates one with `POST /session`.

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
“stop this supervised native runtime.”

An authenticated viewer `end` does not take that teardown path: `HostRcRelay` consumes it locally,
clears open relay permission gates, and sends no `end_session` or native OpenCode abort.

## 3. HTTP and SSE surface

`client.ts` uses Node's global `fetch`; there is no `@opencode-ai/sdk` dependency.

| Operation | Current route and behavior |
| --- | --- |
| Create session | `POST /session` → native session ID |
| List sessions | `GET /session`, most recently updated first |
| Read history | `GET /session/{id}/message`, chronological messages with parts |
| Send prompt | `POST /session/{id}/prompt_async` with `{model, parts}`; success is an empty `204` |
| Interrupt | `POST /session/{id}/abort` |
| Compact | `POST /session/{id}/summarize` with `{providerID, modelID, auto:false}` |
| Read permission rules | `GET /session/{id}`, using its `permission` field |
| Add permission rules | `PATCH /session/{id}` with `{permission: rules}` |
| Answer a permission | `POST /session/{id}/permissions/{permissionId}` accepts `once`, `always`, or `reject`; the driver sends only `once`/`reject` |
| Follow events | `GET /event`, one server-wide SSE stream |

The driver does not implement OpenCode question APIs. A question capability must remain disabled until
the exact native request and answer lifecycle is implemented and recovery-tested.

The SSE client filters session events by the ID found in the event or nested message/part shapes.
Server-level connected/heartbeat events are global. Predicate subscriptions also receive every
`session.created` event so the driver can discover child sessions, but the driver follows a child only
when its `parentID` belongs to an already followed session.

The SSE generator handles one connection. The driver owns reconnect with capped exponential backoff.

## 4. Capture workflow

For each SSE connection, capture subscribes first. After the first event proves the subscription is
live, it reads native history and then processes live events. Re-running history after reconnect is
deduplicated by OpenCode message ID within the driver's bounded 4,096-ID recent window. This avoids
the obvious snapshot-then-subscribe gap, but it is not a durable event cursor: OpenCode SSE supplies
no replay token. A history larger than that window can re-emit evicted messages after reconnect; the
current driver does not promise cross-reconnect exactly-once projection for an unbounded chat.

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
through another OpenCode client appears in the remote-claw viewer. A followed child session's internal
user prompt is always suppressed because its Task anchor already carries that input.

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
stream. Any such replay is not safe enough for the authoritative host: if `prompt_async` reached
OpenCode and only its response was lost, retry can execute the prompt twice. The new coordinator must
write-ahead `started`, treat that result as `outcome_unknown`, and quarantine later native mutations
unless OpenCode supplies positive proof that the first attempt did not start.

`/compact` is dispatched without awaiting the long-running summarize request so an interrupt can
overtake the HTTP response wait. A dispatch error emits an OpenCode warning result and restores idle.
The authoritative coordinator must still journal compaction as its own mutation and apply the same
uncertainty rule.

## 6. Permissions

OpenCode normally decides tools from session permission rules. With mirroring enabled, the driver:

1. Reads the existing rules.
2. Removes only an exact prior remote-claw catch-all ask rule from the payload it prepares.
3. Prepends `{permission:"*", pattern:"*", action:"ask"}`.
4. Appends the existing rules, preserving OpenCode's last-match-wins behavior.
5. Patches the session, and repeats best-effort for newly discovered child sessions.

If the read fails, the driver does not patch because a blind write could drop a deny rule. If the patch
fails, the session continues without reliable remote gating. The current capability announcement does
not reflect that failure.

The live OpenCode `PATCH` behavior is append-only: rules concatenate and an empty/null patch does not
clear them. The driver therefore cannot safely restore a borrowed session's original rules on
teardown. Once its catch-all ask rule is installed, it persists until the user clears the native
session policy. The future structured runtime should use an owned session/server or prove a reversible
permission-policy seam before advertising clean detach.

`permission.asked` becomes the relay's existing `permission_request`. Only an explicit viewer allow
maps to OpenCode `once`; a deny or malformed behavior with a valid request ID maps to `reject`. An
absent/invalid request ID is a no-op that the legacy downstream pump still acknowledges. There is no
implemented “always” choice, question flow, or durable recovery of an answer whose HTTP
acknowledgement was lost.

The future coordinator must journal permission answers before delivery. On ambiguous delivery it must
not send a contradictory second answer; it records `outcome_unknown` and waits for positive native
terminal/cancellation evidence, or definitively stops/freezes the old process before proceeding.

## 7. Capability truth

The current constructor advertises:

| Capability | Advertisement | Actual state |
| --- | --- | --- |
| Structured permissions | Mirrors the requested flag | Can be false in practice if post-announce setup fails |
| Status | `true` | Backed by main-session status/idle events |
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
- a command journal or definitive multi-writer order;
- native delivery attempt IDs;
- permission/question gates across restart;
- a durable SSE cursor;
- complete historical child-session lineage; or
- provider/network isolation.

Text matching for injected-echo suppression is also ambiguous: an identical prompt sent concurrently
through another OpenCode client can be misattributed.

In the selected host runtime, authority is divided cleanly:

| Fact | Authority |
| --- | --- |
| Which mutation is admitted next | remote-claw coordinator journal |
| Whether a native OpenCode action actually happened | OpenCode native history/status and positive receipts |
| OpenCode conversation content after wrapper loss | OpenCode native store, with explicit gaps where evidence is absent |
| Viewer/official-client representation | rebuildable remote-claw projection |
| Model/provider access | isolated inference connector, never the OpenCode process directly |

Recovery must reattach the exact `runtimeId`/session/incarnation, subscribe before history backfill,
reconcile journaled attempts against native evidence, and leave ambiguous attempts quarantined. It may
start a successor session only with an explicit gap and explicit handling of commands that were
admitted for the old session. Reattaching a proven same semantic session is the future condition for
retaining a logical-chat ID; a missing, reused, or unproven `ses_*` cannot silently repoint that chat.

## 9. Tests

The checked-in unit tests cover HTTP/SSE parsing, translation, coalescing, deduplication, attach
mid-turn, reconnect/backfill, injected-echo rollback, compact routing, visible errors, permissions, and
child-session nesting/isolation.

The live suite is:

```bash
OPENCODE_URL=http://127.0.0.1:4096 \
pnpm --filter @remote-claw/cli exec vitest run src/host/rc/opencode/driver.e2e.test.ts
```

It skips when no OpenCode server is reachable. Provider-backed turn cases also require the configured
model credentials in the `opencode serve` process. The live cases cover ordered turns, tool
translation, local and injected prompts, history/restart, interrupt, visible errors, native compact,
permission round-trip, and two-session isolation.
