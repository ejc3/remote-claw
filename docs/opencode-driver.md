# OpenCode driver

> **Status:** design (proposed). Lands behind `--rc-driver=opencode`. The default driver stays
> `mitm` (drive the real `claude --remote-control`). This doc is the durable record of the design
> decision; the implementation lives under `packages/cli/src/host/rc/opencode/`.

## Why this exists

`remote-claw` bridges a coding agent's session to our E2E-encrypted broker so a phone/laptop can
read and steer it. Today the only agent we can drive is the **real `claude`**, captured by a MITM
proxy on its Remote-Control endpoints (`--rc-app`, `--rc-trace`). That couples us to one vendor and
one transport.

The **driver seam** decouples "where the session frames come from" from "how they reach a viewer".
A driver produces a `Session` and feeds it canonical content-block frames; everything below the
seam — `HostRcRelay`, the broker router, and the `apps/web` viewer — stays byte-for-byte unchanged.

The OpenCode driver proves the seam against a *completely different* agent:
[OpenCode](https://github.com/sst/opencode) runs a headless HTTP+SSE server (`opencode serve`) and
can run on **AWS Bedrock**. This is also the provider-agnostic proof: native claude RC is *disabled*
on Bedrock, but **OpenCode-on-Bedrock works**, so remote-claw can drive a session that the official
Claude app fundamentally cannot.

## The seam (what a driver must satisfy)

The clean integration point is `packages/cli/src/host/rc/session.ts` (`Session` + `RelayCore`).
`HostRcRelay` (`relay.ts`) only ever touches a `Session` and a `BrokerClient`. It calls exactly:

- `session.pushUpstream(payload)` — feed it a worker event (assistant/user/system/result). The relay
  runs `mapUpstreamItems` over it and seals content frames to the viewer.
- `session.followDownstream(session.claimWorkerStream(), stop)` — drain client to agent events
  (`user` prompts, `control_request`/`control_response`).
- `session.pushControlResponse(requestId, behavior, extra)` — answer a permission gate.
- `session.workerStatus` / `session.wake()` — presence (idle/thinking) + heartbeat.

So a **driver** is anything that:

1. **CAPTURE** — translates its agent's native output into claude's canonical content-block envelope
   and calls `session.pushUpstream(payload)`.
2. **INJECT** — drains `session.followDownstream(...)`, sends each downstream `user` event's text to
   its agent, and maps the minimal control verbs (`interrupt`, `set_model`, `end`).
3. **PERMISSIONS** — turns the agent's permission asks into the relay's existing
   `can_use_tool` -> `permission_request` -> `pushControlResponse` round-trip.
4. **STATUS** — keeps `session.workerStatus` current and calls `session.wake()`.

The canonical envelope (what `mapUpstreamItems` already understands, so it must not change):

```jsonc
{
  "type": "assistant" | "user" | "system" | "result",
  "message": { "content": [
    { "type": "text",        "text": "…" },
    { "type": "thinking",    "thinking": "…" },
    { "type": "tool_use",    "name": "Bash", "input": { } , "id": "toolu_…" },
    { "type": "tool_result", "tool_use_id": "toolu_…", "content": "…|[blocks]", "is_error": false }
  ] },
  "uuid": "…",
  "parent_tool_use_id": "…"
}
```

`mapUpstreamItems` keys entirely off `type` + the content-block `type` discriminators. As long as the
driver emits this shape, the relay produces the same `assistant` / `assistant_thinking` / `tool_use` /
`tool_result` / `task` / `permission_request` content frames it does for real claude — and the viewer
renders them identically. **That equivalence is the whole point of the seam.**

## OpenCode in one paragraph

`opencode serve --port 4096 --hostname 127.0.0.1` starts a headless server (Effect `HttpApi`, not
Express). Sessions: `POST /session` -> `ses_…`. Drive a turn: `POST /session/{id}/prompt_async`
(body carries `{providerID, modelID}` + the prompt parts; returns immediately, runs in a background
fiber). Interrupt: `POST /session/{id}/abort`. Live output: a **single server-wide** SSE stream at
`GET /event` (content-type `text/event-stream`), each frame `data: {id, type, properties}`.
Permissions: `GET /permission` + `POST /permission/{requestID}/reply {reply: once|always|reject}`.
Questions (AskUserQuestion equivalent): `GET /question` + `POST /question/{requestID}/reply {answers}`.
Optional HTTP Basic auth via `OPENCODE_SERVER_PASSWORD` (off when unset). The published
`@opencode-ai/sdk` (v1.17.5) wraps all of this; the **v2** SDK subpath matches the Effect HttpApi
exactly and adds dedicated `client.question` and `client.permission` classes — that's the one to use.

## Architecture

```
                 OpenCode server (opencode serve, Bedrock provider)
                  |  GET /event (SSE, server-wide)        ^ POST /session/{id}/prompt_async
                  |  GET/POST /permission, /question      | POST /session/{id}/abort
                  v                                       | POST /permission/{id}/reply
        +-------------------------------------------------------+
        |  OpencodeDriver  (src/host/rc/opencode/driver.ts)     |
        |   client.ts  - typed HTTP+SSE wrapper (v2 SDK)        |
        |   translate.ts - Part[] <-> claude content blocks     |
        |                                                       |
        |   CAPTURE:  SSE part -> session.pushUpstream(envelope)|
        |   INJECT:   followDownstream -> prompt_async / abort   |
        |   PERMS:    permission/question event -> permission_request frame
        |             <- pushControlResponse -> POST .../reply    |
        |   STATUS:   session.status -> workerStatus + wake()     |
        +-------------------------------------------------------+
                  | Session (UNCHANGED)        ^ followDownstream / pushControlResponse
                  v pushUpstream               |
        +-------------------------------------------------------+
        |  HostRcRelay (relay.ts) - UNCHANGED                   |
        |  BrokerClient (client.ts) - UNCHANGED                 |
        +-------------------------------------------------------+
                  |  E2E-sealed frames (same record_kinds)
                  v
        apps/web viewer - UNCHANGED
```

`launch.ts`/`run.ts` select the driver with `--rc-driver={mitm|tmux|opencode}` (default `mitm`).
The OpenCode driver path does **not** stand up the MITM at all — it talks straight to the OpenCode
server — but it constructs the *same* `HostRcRelay({client, identityId, sessionId, session})` and
calls `relay.announce(...)` + `relay.serve(signal)` exactly as the MITM path does in `launch.ts`.

## CAPTURE — OpenCode parts to claude content blocks

OpenCode's SSE stream carries the whole session log incrementally. The load-bearing events:

| OpenCode SSE `type`        | Meaning                                  | Driver action |
| -------------------------- | ---------------------------------------- | ------------- |
| `server.connected`         | stream up                                | start-of-stream marker |
| `server.heartbeat` (~10s)  | keepalive                                | refresh `workerStatus`, `wake()` |
| `message.updated`          | a message's info changed (role/finish)   | track role + finish; on assistant finish emit `result` boundary |
| `message.part.updated`     | a **whole part** (re-sent, not a delta)  | translate -> `pushUpstream` (reassemble by part id) |
| `message.part.removed`     | a part was dropped                       | suppress its prior frame |
| `session.status` / `idle`  | run state                                | `workerStatus = thinking/idle`; `idle` = turn end |
| `permission.asked`         | tool permission gate                     | -> `permission_request` (see PERMISSIONS) |
| `permission.replied`       | gate resolved (e.g. by another client)   | clear local gate state |
| `session.error`            | run failed                               | emit a `result`/error text so the viewer isn't stuck "working" |

**Part to content-block mapping** (`translate.ts`, `partToBlocks`). OpenCode's canonical `Part` union
lives in `@opencode-ai/core` `v1/session.ts`; the mapping mirrors the inverse of OpenCode's own
`message-v2.ts:toModelMessagesEffect` (which converts the same parts *to* Anthropic blocks via the AI
SDK), so it is faithful by construction:

- `TextPart {text}` -> `{ type: "text", text }` (assistant role).
- `ReasoningPart {text}` -> `{ type: "thinking", thinking: text }`.
- `ToolPart` `state.status` `pending|running` -> `{ type: "tool_use", name: part.tool, input:
  state.input, id: part.callID }`.
- `ToolPart` `completed` -> the `tool_use` (once per `callID`) **and** a user-role `{ type:
  "tool_result", tool_use_id: callID, content: state.output, is_error: false }`.
- `ToolPart` `error` -> `tool_use` + `tool_result` with `is_error: true`.
- `StepStartPart` / `StepFinishPart` -> turn boundaries only; `step-finish` drives the `result` envelope.
- `CompactionPart` -> a synthetic `system` event (`subtype: "compact"`).
- `SubtaskPart` -> a `tool_use` named `Task` (see GAPS: subagents).

**Reassembly by part id (no token deltas).** OpenCode re-sends each *whole part* on every
`message.part.updated` (not a per-token delta). claude's RC worker channel ALSO delivers complete
messages, never token deltas (deltas ride the inference SSE we don't relay), so this is a *match*, not
a regression. The driver keeps a `Map<partID, {seq, uuid, lastText}>`: first appearance allocates a
stable `uuid` and `pushUpstream`s; later updates reuse the same `uuid`/`parent_tool_use_id` and emit
only when the rendered content is final (coalesce on message-complete / `session.idle`). One assistant
bubble per message, no relay/viewer change. `message.part.delta` is deliberately ignored — the viewer
has no streaming-token UI, and per-delta frames would spam the durable transcript log.

`message.part.updated.properties` carries the `sessionID`; the driver filters the server-wide stream
here (see GAPS: no per-session SSE).

## INJECT — downstream `user` events to OpenCode

```ts
const gen = session.claimWorkerStream();
for await (const ev of session.followDownstream(gen, () => stop.aborted)) {
  if (ev === null) continue;                       // heartbeat tick
  if (ev.eventType === "user") {
    const text = userText(ev.payload);
    await client.promptAsync(sessionId, {
      model: { providerID: "amazon-bedrock", modelID: SMALL_MODEL },
      parts: [{ type: "text", text }],
    });
  } else if (ev.eventType === "control_request") {
    const sub = (ev.payload.request as any)?.subtype;
    if (sub === "interrupt") await client.abort(sessionId);
    else if (sub === "set_model") { /* remember for next prompt_async */ }
    else if (sub === "end_session") { /* mark done; stop the stream */ }
  }
}
```

Slash commands ride the `user` path like the claude protocol. `/compact` is routed to its native
equivalent (`POST /session/{id}/summarize`) **and is implemented + live-verified** — without it the
literal string `/compact` would be fed to the model. Every other slash command currently passes through
as a prompt (full `/command` routing via `POST /session/{id}/command` is follow-up). A blank prompt
(empty OR whitespace-only) is a no-op, not a burned model turn.
`SMALL_MODEL` defaults to the cheap Bedrock model (`us.amazon.nova-micro-v1:0`) so debugging + e2e
loops stay cheap (configurable via `--rc-oc-model` / `RC_OC_MODEL`). Permission answers are NOT
handled here — they arrive via the relay calling `session.pushControlResponse`, observed by the
PERMISSIONS path.

## PERMISSIONS — OpenCode gate to relay round-trip to OpenCode reply

OpenCode blocks the tool on a `Deferred` until an HTTP reply comes back, and publishes
`permission.asked` (`{id, sessionID, permission, patterns, metadata, tool?{messageID, callID}}`). The
driver turns it into the **exact** `can_use_tool` shape the relay already handles:

```ts
session.pushUpstream({
  type: "control_request",
  request_id: ev.id,
  request: {
    subtype: "can_use_tool",
    tool_name: ev.tool ?? "tool",
    input: ev.metadata ?? null,      // relay reads `input` (real-claude shape)
    tool_use_id: ev.callID ?? "",
  },
});
```

`mapUpstreamItems` emits a `permission_request` content frame; the viewer renders Allow/Deny (or a
QuestionCard for AskUserQuestion). The viewer's answer rides back as a `permission` inbound frame; the
relay's `#tailInbound` calls **`session.pushControlResponse(requestId, behavior, extra)`** unchanged.
The driver observes that control response (it lands on the downstream channel of the Session it owns)
and maps it out:

| relay behavior              | OpenCode reply (`POST /permission/{id}/reply`) |
| --------------------------- | ---------------------------------------------- |
| `allow` (one-off)           | `{reply: "once"}` |
| `allow` + "always" intent   | `{reply: "always"}` |
| `deny`                      | `{reply: "reject"}` |
| `deny` + correction message | `{reply: "reject", message}` |

**AskUserQuestion** maps to OpenCode's `question` API: a gate becomes a `can_use_tool` with
`tool_name: "AskUserQuestion"` and `input.questions` (so the viewer's existing `QuestionCard`
renders); the answer (`updatedInput.answers`) is translated to `POST /question/{id}/reply {answers}`
(chosen labels in question order). **The relay's permission machinery is reused verbatim** — the
driver only translates the request in and the decision out.

## STATUS — presence

- `session.status` "running" / a live assistant `message.part.updated` -> `workerStatus = "running"`
  (relay reads `thinking`).
- `session.idle` -> `"idle"` and emit the turn-end `result` boundary.
- a pending gate -> the relay's own `#openPerms` drives `needs`; nothing extra.

`session.wake()` is called on every SSE frame so `followUpstream`'s heartbeat re-evaluates presence
promptly.

## client_unchanged_proof

The viewer (`apps/web/app/page.tsx` + `lib/transcript.ts`) is a **pure function of the sealed content
frames' `record_kind` + JSON body**; it never knows what produced them. `Bubble` switches on
`message.kind` in {`result`, `user`, `assistant`, `assistant_sub`, `assistant_thinking`,
`assistant_thinking_sub`, `tool_use`, `tool_result`, `task`, `permission_request`,
`permission_resolved`} — produced **only** by `relay.ts:mapUpstreamItems` + `#pumpInbound`.
`lib/transcript.ts` parses fixed body shapes (`parseToolUse {name,input,sub}`, `parseToolResult
{tool_use_id,is_error,output,sub}`, `parsePermission`+`parseQuestions`, `parseTask`,
`parsePermissionResolved`).

The OpenCode driver emits the canonical envelope, so `mapUpstreamItems` produces the **same kinds with
the same body JSON** as for real claude (the driver maps `callID`->`tool_use_id`, `part.tool`->`name`,
`state.output`->`content`, `ev.metadata`->`input` *before* `pushUpstream`). Therefore: (1) no new
`record_kind` crosses the broker; (2) no new content-body field; (3) the broker router
(`broker/protocol.ts`) is untouched. Mechanical proof: a parity test runs identical viewer assertions
against frames from the OpenCode driver and the existing fake-RC worker and asserts identical
`(kind, parsed-body)`. CI gate:

```bash
git diff --name-only origin/main..HEAD -- \
  packages/cli/src/host/rc/relay.ts \
  packages/cli/src/host/rc/session.ts \
  packages/cli/src/broker/ \
  apps/web/   # MUST be empty
```

## Gaps & how the design handles them

1. **No per-session SSE.** `GET /event` is server-wide; the driver subscribes once and filters
   client-side by `properties.sessionID`. One driver = one session.
2. **No token deltas (whole-part re-send).** Matches claude's complete-message-only RC channel.
   Reassemble by `partID`, coalesce to one final frame per message. `message.part.delta` ignored.
3. **Subagents = child sessions via `parentID` — IMPLEMENTED (#102).** OpenCode spawns a sub-agent as a
   child `ses_…` (a `SubtaskPart` on the parent message + a child `Session` whose `parentID` is the
   parent), not inline `parent_tool_use_id` blocks. The driver renders the `subtask` part as a `Task`
   `tool_use` anchor whose `id` is the **subtask part's own `prt_…` id** (no synthetic callID needed),
   FOLLOWS the child on the same server-wide SSE (added to the follow-set on its `session.created`), and
   tags the child's messages with `parent_tool_use_id = <the subtask part id>`. The relay nests them
   `*_sub` and the viewer renders them under the Task row — no relay/viewer change.

   - **The discovery hook:** a child's `session.created` carries the *child's own* (not-yet-followed) id,
     so the client delivers `session.created` to the follow predicate regardless of the follow-set
     (gating it by the set it would update is circular). Every other event stays gated.
   - **The child's internal user prompt** (the Task input) is suppressed — it's already shown via the
     anchor's `prompt`, so it is not re-surfaced as a top-level `local_prompt`. Suppression keys on "is a
     followed non-main child" (not on whether we tagged it), so an untagged child can't leak its prompt.
   - **Presence isolation:** only the MAIN session's `session.status`/`idle`/`error` drive the bridge's
     `workerStatus`; a child going idle never flips presence while the parent is mid-turn.
   - **Lifecycle / bounds:** a child is unfollowed on its `session.idle` (after its buffers flush), so the
     follow-set stays bounded by *in-flight* children, not lifetime children. Only LIVE `subtask` anchors
     are enqueued for correlation (backfill is excluded — a stale historical anchor would otherwise mis-nest
     the next same-agent child). The correlation queue is keyed by **(parent session, agent)**, so two
     parents spawning the same agent never cross-tag. A reconnect re-backfills in-flight children too (SSE
     has no replay), so child output isn't lost across a transient drop.
   - **v1 correlation limit (display-only):** the `subtask` part carries no child session id (opencode
     links the child only via `parentID`), so a child is paired to its Task by (parent, agent, FIFO order).
     Only CONCURRENT same-agent subtasks **from the same parent** can mis-nest in the viewer; never a
     dropped message (an unmatched child just stays top-level). Also: attaching to a session whose Tasks
     ALREADY finished renders the Task anchors from history but does not re-fetch the past child output
     (no children-discovery on attach yet — `GET /session/{id}/children`). Revisit both if opencode exposes
     a part→child id link.
4. **File upload.** v1 keeps relay.ts unchanged: the relay's existing attachment-on-disk + "use Read"
   flow runs and OpenCode's `read` tool reads the path. A later version sends a native `FilePart`.
5. **Permission "always" + permission modes.** No exact analog; v1 maps `auto`->`always`,
   `plan`->`reject` ("planning only"), `default`->pass through. Approximate.
6. **Auth.** v1 runs unsecured on loopback (same trust boundary as the MITM); Basic auth
   (`OPENCODE_SERVER_PASSWORD`) documented for non-loopback.
7. **Bedrock credentials + the AWS Marketplace model-subscription gate.** OpenCode's Bedrock client needs
   static env creds (no IMDS chain in 1.17.5); fetch+export temp creds from IMDS (expire ~hourly) — e.g.
   `eval "$(aws configure export-credentials --format env)"`. The dev box's `dev-server-role` has
   `bedrock:InvokeModel`, but live inference on Anthropic models is blocked on the **AWS Marketplace
   model subscription**: both OpenCode's AI-SDK streaming invoke AND the plain CLI `bedrock-runtime
   converse` return `AccessDeniedException: Model access is denied … not authorized to perform the
   required AWS Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe)`
   (live-probed 2026-06-28 on `us.anthropic.claude-sonnet-4-5`). A brief earlier "PINEAPPLE" via Converse
   was the **auto-subscribe grace window** — [AWS docs](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html):
   *"During this setup period (up to 15 minutes), your API calls may succeed temporarily while the
   subscription is being finalized. If any prerequisites are missing, the subscription attempt fails and
   subsequent API calls will return `AccessDeniedException`."* So Converse and streaming gate **identically**.
   The fix is an account-level step the role can't self-serve (it's also denied `bedrock:GetFoundationModelAvailability`
   / `ListFoundationModelAgreementOffers` / `aws-marketplace:*`): either (a) an admin enables **Model
   access → Anthropic** once in the Bedrock console (us-east-1) — after which all roles invoke without
   Marketplace perms — or (b) grant the role `aws-marketplace:Subscribe`+`ViewSubscriptions` (these can't
   be ARN-scoped) so first-use auto-subscribes, plus the one-time Anthropic FTU use-case form. Amazon Nova
   is separately `AccessDenied` (the invoke grant is Anthropic-scoped). **The native MITM driver
   (`--rc-inference=bedrock`) is unaffected** — AWS docs state the FTU form *and* the Marketplace
   subscription **"do not apply to Anthropic models accessed through the `bedrock-mantle` endpoint"**,
   which is exactly the endpoint #133 translates to. That is why `--rc-inference=bedrock` runs today while
   OpenCode-on-Bedrock waits on the account subscription.

## v1 plan

1. **`client.ts`** — typed wrapper over the OpenCode v2 SDK: `createSession`, `promptAsync`, `abort`,
   `events()` (SSE filtered by sessionID), `replyPermission`, `replyQuestion`, `children`; inject
   `x-opencode-directory`; optional Basic auth.
2. **`translate.ts`** — pure + unit-tested: `partToBlocks`, `permissionToControlRequest`,
   `controlResponseToReply`, `userText`; golden fixtures from a live `opencode serve`.
3. **`driver.ts`** — `OpencodeDriver` implementing the seam; `start(session, signal)` mirrors
   `launch.ts` (constructs `HostRcRelay`, `announce` + `serve`); the OpenCode path skips the MITM.
4. **Wiring** — `--rc-driver={mitm|tmux|opencode}` (default `mitm`) + `--rc-oc-url` / `--rc-oc-model`
   (default `us.amazon.nova-micro-v1:0`) + `RC_OC_*` envs.
5. **client_unchanged gate** — the empty-diff grep in CI + a parity test.
6. **e2e against Bedrock** — point `opencode serve` at a Bedrock Anthropic model
   (`RC_OPENCODE_E2E_MODEL=amazon-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0`, `AWS_REGION`
   + IMDS-exported static creds), start the driver against a local broker, drive a prompt from a headless
   viewer, assert the `assistant` frame arrives unchanged. The driver's request reaches Bedrock (the
   `amazon-bedrock` provider + correct model id are proven against the live server), but a live SUCCESS
   additionally needs the account's **AWS Marketplace subscription** for the Anthropic model (see Gap #7).
   The e2e **skips (not fails)** when the server is unreachable OR the model returns an account-gate error
   (turnGate → ctx.skip), so CI stays green until the subscription lands — then the same suite proves a
   real Bedrock turn end-to-end with zero api.anthropic.com.
7. **Per-PR gate** (CLAUDE.md): `pnpm exec biome check .` + `pnpm exec tsc --noEmit` +
   `pnpm exec vitest run`, `/code-review` + codex, CI green.
