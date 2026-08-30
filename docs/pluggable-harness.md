# Pluggable harness drivers

remote-claw has one current adapter seam: every harness produces an in-memory `Session`, and
`HostRcRelay` bridges that session to the same encrypted broker and viewer. This keeps native-agent
details out of the wire protocol.

Four drivers exist:

- `mitm` — the default Claude Code Remote Control adapter;
- `claude-native` — the Linux/exact-2.1.237 structured text companion for ordinary Anthropic Remote
  Control;
- `tmux` — an experimental plain-Claude compatibility adapter; and
- `opencode` — an experimental `opencode serve` compatibility adapter.

The private MITM remains the supported Claude beta. The native companion has passed its structured
API-path, local Graduate, literal official web UI coexistence, and separate exact-SHA
deployed-broker gates; M1 is complete.
OpenCode and tmux are intended product surfaces with narrower experimental guarantees, not discarded
side projects. Codex follows after the existing app-server seam is turned into product code. Every
current `Session` binding remains process-local.

This adapter choice is independent of inference routing. Anthropic, OpenAI, or Bedrock selects where
model work runs; it does not select browser identity, broker transport, readiness, or native
capabilities. Accountless means no Anthropic account and still requires the chosen provider and
remote-claw credentials.

## 1. The seam

```text
                  harness-specific side
Claude RC ─┐
Provider RC├─ capture/inject adapter ─ Session ─ HostRcRelay ─ BrokerClient
tmux pane ─┤
OpenCode  ─┘
```

`packages/cli/src/host/rc/driver.ts` defines the shared types. A driver owns:

- native startup and readiness;
- capture from its harness into canonical upstream payloads;
- injection of downstream session events into its harness;
- honest worker status and capability reporting; and
- native teardown.

The shared relay owns:

- E2E frame sealing and opening;
- broker publish, subscribe, cursors, retry, and fail-stop behavior;
- transcript publication and sequence allocation, using provider order for native-companion prompts;
- browser-command deduplication;
- permission projection and resolution ordering;
- attachment admission; and
- presence and terminal publication.

This division is concrete in `packages/cli/src/host/rc/drivers/bridge.ts`: `startBridgeSession` receives
one `Session`, capability vector, harness descriptor, broker client factory, and lifecycle signal. It
creates one `HostRcRelay` and owns no native protocol logic.

## 2. `Driver` and context

The dispatcher accepts
`DriverName = "mitm" | "claude-native" | "tmux" | "opencode"`. A driver implements:

```ts
interface Driver {
  readonly capabilities: DriverCapabilities;
  run(signal: AbortSignal): Promise<number>;
}
```

`DriverContext` carries only invocation-scoped inputs: forwarded harness arguments, optional binary,
derived identity, broker origin/backend, title, cwd and git snapshot, a broker-client factory, tracer,
test callback, and a small driver-specific `extra` object. Secrets remain in the host process and are
not added to harness argv.

The driver capability vector is deliberately per feature:

```text
structuredPermissions
status
controls.interrupt
controls.setModel
controls.setMode
controls.end
attachments
```

The viewer disables unsupported controls, and `HostRcRelay` enforces the same vector again on inbound
frames. A driver cannot gain a mutation surface merely because an older viewer sends it.

The harness descriptor is separate from capabilities:

| Driver | Descriptor |
| --- | --- |
| `mitm` | `{agent:"claude-code", mode:"rc"}` |
| `claude-native` | `{agent:"claude-code", mode:"native-rc"}` |
| `tmux` | `{agent:"claude-code", mode:"tmux"}` |
| `opencode` | `{agent:"opencode", mode:"opencode"}` |

It labels the session in the viewer; it does not grant authority.

## 3. Canonical `Session` contract

A driver creates a `Session` through `RelayCore`, calls `pushInitialize()` once, and connects two
directions.

### Capture

Harness output becomes an `UpstreamPayload` passed to `Session.pushUpstream`:

```ts
interface UpstreamPayload {
  type: "assistant" | "user" | "system" | "result" | "control_request" | string;
  uuid?: string;
  message?: { role?: string; content?: ContentBlock[] | string };
  parent_tool_use_id?: string | null;
  local_prompt?: boolean;
}
```

The actual type in `driver.ts` contains the complete optional field set. `HostRcRelay` is the final
mapping authority: off-shape or unsupported events produce no viewer item. Drivers must therefore
translate into the existing Claude-style content blocks instead of teaching the broker about a new
agent protocol.

Current rendered blocks are:

- `text` and `thinking`;
- `tool_use {id,name,input}`;
- `tool_result {tool_use_id,content,is_error}`; and
- system task lifecycle data used to nest sub-agent work.

An assistant payload can produce several transcript frames. A user-role native payload normally
produces only tool results. A compatibility driver may set `local_prompt:true` to surface text observed
from a native local client; ordinary user echoes are otherwise dropped because the relay already
published the browser prompt. The native companion is the deliberate exception: provider history/SSE
owns the canonical prompt order, so every admitted provider user event is marked `local_prompt`, and a
matching browser `client_msg_id` reconciles the optimistic row only at that provider sequence.

### Injection

A driver claims a downstream stream generation and drains
`Session.followDownstream(generation, stopPredicate)`. It handles:

- `user` by sending the text through its native input path;
- `control_request` according to its advertised controls; and
- `control_response` when it exposes structured permission gates.

Only the newest stream claimant remains live. Tmux and OpenCode acknowledge a session event after
their transport action succeeds so a stream reclaim does not immediately replay it. Those
acknowledgements are transport receipts, not proof that the native engine durably applied or ordered
the action.

The native companion sends non-empty, non-slash text through one serialized provider writer with a
stable UUID. It waits for the canonical provider history/SSE event before publishing the ordered user
row. Any rejected or outcome-unknown POST permanently fences the projection and is not retried.

The Claude MITM has a stronger pre-write replay fence described in
[protocol.md](protocol.md#4-the-claude-remote-control-adapter), but it likewise does not claim native
application.

### Status

A driver updates `session.workerStatus` and calls `session.wake()` when it has a meaningful status
change. It advertises `status:true` only when that projection is trustworthy. Tmux and OpenCode retain
useful internal observations but advertise `false` because their initial or inferred status can be
wrong.

## 4. Readiness and lifecycle

Every adapter uses the same small process-local lifecycle:

1. Construct `ReadyBridge` in `starting`; this creates no broker client or presence.
2. Perform native setup and validate the exact identity, capture path, and permission prerequisites the
   adapter claims.
3. Call `start()` once with the final immutable harness metadata and viewer capabilities. This is the
   only transition to `ready`, and only it starts `HostRcRelay` and publishes presence.
4. On cancellation or failure, `close()` first aborts and closes the compatibility `Session`, then the
   adapter joins bridge and native teardown under its bounded policy.

The helper prevents cancelled setup from racing a late ready announcement. It does **not** persist a
binding, enumerate native sessions after process restart, refresh capabilities in place, provide a
durable coordinator epoch, or reattach an old bridge. The Claude-native driver can create a new
projection only when the operator explicitly supplies the exact still-live native session ID.

## 5. Current adapters

| Property | Claude `mitm` | Claude `claude-native` | Experimental `tmux` | Experimental `opencode` |
| --- | --- | --- | --- | --- |
| Native connection | Claude RC HTTP/SSE through local MITM | transparent bridge observer or explicit-ID attach, plus Anthropic history/SSE client | private tmux pane + transcript files | OpenCode HTTP + server-wide SSE |
| Native session choice | Claude creates a fresh `cse_*` in the local RC service | exact `cse_*` from the spawned child's successful bridge request or explicit `--rc-native-session` | fresh UUID unless user supplied resume/session flags | exact configured `ses_*`, or create only after valid empty discovery |
| Capture | authenticated RC event batches | subscribe-before-history provider reconciliation | tail main and sub-agent JSONL | history plus coalesced SSE parts |
| Remote text | Claude downstream SSE | serialized provider event POST | bracketed pane paste + Enter | `prompt_async` |
| Local prompts in viewer | not generally surfaced | provider user events in provider order | post-hoc text-ledger match | post-hoc text-ledger match |
| Permission behavior | stable surface disabled | native/local; never projected or answered | PreToolUse mirror by default | catch-all `ask` rule by default |
| Status advertised | yes | no | no | no |
| Restart reattachment | no | explicit exact-ID attach creates a fresh projection; it never adopts the prior projection | no | native history can be backfilled into a new synthetic bridge, but the bridge identity is not retained |

The exact advertised viewer capabilities are:

| Driver | Permissions | Interrupt | Model | Mode | End | Attachments |
| --- | --- | --- | --- | --- | --- | --- |
| Stable `mitm` | no | no | no | no | no | no |
| `claude-native` | no | no | no | no | no | no |
| `tmux`, mirroring on | yes | yes | yes | no | no | yes |
| `opencode`, mirroring on | yes | yes | no | no | no | no |

See [tmux-driver.md](tmux-driver.md) and [opencode-driver.md](opencode-driver.md) for adapter-specific
limitations.

## 6. Dispatch and flags

`packages/cli/src/run.ts` resolves `--rc-driver`, then `RC_DRIVER`, then `mitm`. An unknown value exits
with a usage error. Every driver requires `--rc-app` or `RC_APP`. Without a broker origin, launch forms
warn and run plain Claude; an explicit `--rc-native-session` attach fails with usage status instead of
silently starting a new native session.

Common flags:

```text
--rc-app <origin>
--rc-backend <vercel|local|sqlite>
--rc-driver <mitm|claude-native|tmux|opencode>
```

Claude-native attach-only option:

```text
--rc-native-session <cse_...>
```

This form is valid only with `--rc-driver=claude-native`, accepts no forwarded Claude arguments, and
starts no interactive Claude session or proxy. The exact Claude compatibility subprocess and ordinary
identity/broker setup still apply.

Tmux options:

```text
--rc-session-hook | --rc-no-session-hook
--rc-tmux-skip-permissions
```

OpenCode options:

```text
--rc-oc-url <origin>
--rc-oc-model <providerID/modelID>
--rc-oc-session <ses_*>
--rc-oc-skip-permissions
```

Driver-specific flags supplied to a different driver are reported as ignored, except that
`--rc-native-session` is rejected on every other driver and `claude-native` rejects `--rc-inference`,
`--rc-bedrock-*`, and `--rc-accountless` because it preserves Anthropic Remote Control. Non-reserved
arguments are forwarded to Claude by the MITM, Claude-native launch, and tmux launch paths. The
Claude-native attach-only form rejects them; OpenCode attaches to an existing server and uses only its
explicit `--rc-oc-*` options.

## 7. Safety rules for a driver change

A driver change must preserve these current boundaries:

1. Do not announce before native readiness and the advertised permission setup are established.
2. Do not infer a native identity from “most recent” when an exact ID is available or selection is
   ambiguous.
3. Authenticate and deduplicate broker input in the shared relay; do not add a driver-specific wire
   backdoor.
4. Serialize irreversible input. Never treat an ambiguous transport failure as proof that a native
   action did not happen.
5. Advertise only controls the adapter can faithfully service, and make unsupported actions safe
   no-ops at the host boundary.
6. Bound reconnect, in-memory dedup/buffering, and teardown work where the implementation can do so
   without risking duplicate native actions.
7. Keep provider, OAuth, broker, and identity credentials out of argv, logs, child-only environments,
   and browser plaintext.
8. Do not call the process-local readiness object durable or restart-safe. Explicit Claude-native
   attachment creates a fresh bridge; it does not make the object or retired projection durable.

The appropriate proof is an executable adapter test for the behavior being changed plus the ordinary
repository gate. It is not a second command ledger, schema, signer, or receipt protocol alongside the
active relay.

## 8. Code and test map

- `packages/cli/src/host/rc/driver.ts` — driver types, capabilities, descriptors, canonical payloads.
- `packages/cli/src/host/rc/session.ts` — shared in-memory event bus.
- `packages/cli/src/host/rc/drivers/bridge.ts` — one shared `Session` → broker bridge.
- `packages/cli/src/host/rc/drivers/ready-bridge.ts` — process-local readiness lifecycle.
- `packages/cli/src/host/rc/launch.ts` — Claude MITM launch path.
- `packages/cli/src/host/rc/anthropic/client.ts` — fixed-origin provider history/SSE/write client.
- `packages/cli/src/host/rc/anthropic/driver.ts` — exact-binding native companion and reconciliation.
- `packages/cli/src/host/rc/tmux/**` — tmux adapter and focused tests.
- `packages/cli/src/host/rc/opencode/**` — OpenCode adapter and focused tests.
- `packages/cli/src/run.ts` and `packages/cli/src/args.ts` — dispatch and flags.

The relay and browser tests remain driver-independent. Adapter tests use injected native clients,
filesystem/tmux seams, clocks, and broker clients; the opt-in OpenCode e2e suite can exercise a live
local `opencode serve`.
