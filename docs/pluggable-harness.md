# Pluggable harness drivers

remote-claw has one current adapter seam: every harness produces an in-memory `Session`, and
`HostRcRelay` bridges that session to the same encrypted broker and viewer. This keeps native-agent
details out of the wire protocol.

Five drivers exist:

- `mitm` — the default Claude Code Remote Control adapter;
- `claude-native` — the Linux/exact-2.1.237 structured text companion for ordinary Anthropic Remote
  Control;
- `tmux` — the maintained lower-fidelity plain-Claude compatibility adapter;
- `opencode` — the pinned OpenCode 1.17.5/Linux arm64 text/interrupt/status companion; and
- `codex` — the pinned Codex 0.151.0/Linux arm64 app-server text/status companion.

The private MITM remains the supported Claude beta. The native companion has passed its structured
API-path, local Graduate, literal official web UI coexistence, and separate exact-SHA
deployed-broker gates; M1 is complete.
OpenCode M2 also passed its real-TUI, two-browser, interrupt, reload, and fresh-projection restart
acceptance for the exact pinned tuple, whose proved OpenCode server environment was
`AWS_REGION=us-west-1` plus explicit temporary SigV4 credential values. Other regions or credential
modes require their own gate. A later follow-on now advertises read-only MAIN-session running/idle
status; its implementation and separate real-TUI/two-browser status acceptance are complete. Tmux M4
is complete for exact Claude 2.1.237/Linux arm64 with Bedrock Sonnet 4.6: packed install, local pane,
two browsers, reload, browser input held behind an active model turn and its focused native permission
modal, native/local permission ownership after browser departure, and broker-loss isolation. Its idle
editor and slash/config UI remain a shared keystream that must not be manipulated concurrently with
browser injection. It makes no independent-peer-ordering or provider-native/official-client coexistence
claim. Codex M3a passed its
real-TUI, two-browser, text, status, and native-only approval/question acceptance. M3b then passed on
an exact official Remote thread for Codex 0.151.0/Linux arm64 using the literal managed Unix socket and
legacy full-turn hydration. One provider marker appeared once in two browsers; one browser prompt and
acknowledgement appeared once in official Remote, the TUI, and both browsers, with a host receipt in the
sending browser. A browser-B turn completed while an ephemeral provider transport stayed disabled;
daemon, TUI, companion, and browsers stayed live before provider transport restored to connected. This
is provider-transport isolation, not per-device unsubscribe, and it does not graduate richer controls,
restart/backfill, or broker-loss. Every current `Session` binding remains process-local.

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
OpenCode  ─┤
Codex     ─┘
```

`packages/cli/src/host/rc/driver.ts` defines the shared types. A driver owns:

- native attachment/readiness, plus startup only where that adapter contract grants it;
- capture from its harness into canonical upstream payloads;
- injection of downstream session events into its harness;
- honest worker status and capability reporting; and
- the lifecycle actions its adapter contract actually owns.

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
`DriverName = "mitm" | "claude-native" | "tmux" | "opencode" | "codex"`. A driver implements:

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
permissionPosture? = local | bypassed | unknown
status
controls.interrupt
controls.setModel
controls.setMode
controls.end
attachments
```

The viewer disables unsupported controls, and `HostRcRelay` enforces the same vector again on inbound
frames. A driver cannot gain a mutation surface merely because an older viewer sends it. When
structured browser permissions are false, the optional permission posture distinguishes known
native/local ownership, explicit bypass, and an explicitly unresolved native mode. Absence is legacy
and is never interpreted as local enforcement.

The harness descriptor is separate from capabilities:

| Driver | Descriptor |
| --- | --- |
| `mitm` | `{agent:"claude-code", mode:"rc"}` |
| `claude-native` | `{agent:"claude-code", mode:"native-rc"}` |
| `tmux` | `{agent:"claude-code", mode:"tmux"}` |
| `opencode` | `{agent:"opencode", mode:"opencode"}` |
| `codex` | `{agent:"codex", mode:"app-server"}` |

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
published the browser prompt. Claude-native, OpenCode, and Codex are deliberate exceptions: native
history/events own canonical prompt order, so TUI and browser prompts publish only at native
coordinates. Claude-native reconciles the browser coordinate at the provider sequence. OpenCode
reconciles only an exact caller part marker plus the complete immutable native user text. Codex
reconciles the completed native item against the exact `clientUserMessageId` and text.

### Injection

A driver claims a downstream stream generation and drains
`Session.followDownstream(generation, stopPredicate)`. It handles:

- `user` by sending the text through its native input path;
- `control_request` according to its advertised controls; and
- `control_response` when it exposes structured permission gates.

Only the newest stream claimant remains live. Tmux accepts ordinary non-empty, non-slash text and
attachments. Node loads a private buffer, then a fixed helper holds a startup-probed Linux `flock`
across gate claim, bracketed pane paste, bounded settle, and Enter; it acknowledges only an
authoritative applied outcome. Claude's synchronous `UserPromptSubmit` hook drains its payload and uses
the same helper, lock, and gate. Helper failures become blocking status `2`. Exact 2.1.237's
main-transcript `system/turn_duration` conditionally releases only a strictly older gate generation
after the full model loop and continuations finish. Exact latched-interrupt records use the same
generation-safe release. Exact current-launch hook-rejection warnings instead retire only the
projection, leaving the gate closed and pane usable, because concurrent-hook ordering is ambiguous; old
backfill and generic warnings do neither. Normal `SessionEnd` uses the same lock, closes the gate, then
writes the retirement marker and retires the projection while leaving the pane usable. Its fallback
requires the retirement marker first, then best-effort closes the gate. `Stop`, `StopFailure`, and
asynchronous notifications cannot release a newer turn's
gate. No global Enter binding or TUI parser is installed. Every raw browser control is false; stale/direct
controls and slash-leading text are acknowledged without pane keys. OpenCode text acknowledges only
after one native transport attempt and exact marker-plus-text capture; interrupt acknowledges only
after native `/abort` returns literal `true`. These process-local acknowledgements suppress downstream
replay but are not durable exactly-once claims.

The Claude-native companion sends non-empty, non-slash text through one serialized provider writer with
a stable UUID. It waits for the canonical provider history/SSE event before publishing the ordered user
row. Any rejected or outcome-unknown POST permanently fences the projection and is not retried.

The Codex companion waits for native idle, starts one turn with the broker event ID as
`clientUserMessageId`, and acknowledges only after the matching completed native user item appears.
The immutable projection coordinate is `(turnId,itemId)`, because Codex item IDs are only turn-scoped.
An exact replay deduplicates; changed projected bytes at the same pair fence the projection.
The companion client exposes no app-server request-response method, so native approvals and questions
cannot be answered or errored by remote-claw.

The Claude MITM has a stronger pre-write replay fence described in
[protocol.md](protocol.md#41-private-facade), but it likewise does not claim native
application.

### Status

A driver updates `session.workerStatus` and calls `session.wake()` when it has a meaningful status
change. It advertises `status:true` only when that projection is a supported viewer contract. Tmux
retains only inferred status and advertises false. OpenCode advertises true for read-only MAIN status:
native `busy`/`retry` maps to running, while an ordinary idle lifecycle transition requires exact
history/status reproof. Child events never drive MAIN. SSE loss pauses admission while retaining the
last verified viewer state; reconnect reproof converges it, and a MAIN error instead re-reads exact
status without reopening admission. Codex status notifications are also a supported viewer surface and
advertise true.

## 4. Readiness and lifecycle

Every adapter uses the same small process-local lifecycle:

1. Construct `ReadyBridge` in `starting`; this creates no broker client or presence.
2. Perform native setup and validate the exact identity, capture path, and permission prerequisites the
   adapter claims.
3. Call `start()` once with the final immutable harness metadata and viewer capabilities. This is the
   only transition to `ready`, and only it starts `HostRcRelay` and publishes presence.
4. On cancellation or failure, `close()` fences and closes the local compatibility `Session`, then the
   adapter joins bridge and native teardown under its bounded policy. For OpenCode, native teardown
   never calls `/abort`; only an admitted authenticated browser interrupt does. Codex teardown closes
   only the companion socket and projection, never app-server, TUI, or thread.

The helper prevents cancelled setup from racing a late ready announcement. It does **not** persist a
binding, enumerate native sessions after process restart, refresh capabilities in place, provide a
durable coordinator epoch, or reattach an old bridge. Claude-native and OpenCode create a new
projection only when the operator supplies the exact still-live native session ID. Codex requires an
exact supplied UUIDv7; `thread/resume` may load that stored thread, and the caller must keep a TUI
attached for the projection lifetime.

## 5. Current adapters

| Property | Claude `mitm` | Claude `claude-native` | Maintained lower-fidelity `tmux` | Pinned OpenCode current | Pinned Codex M3a/M3b |
| --- | --- | --- | --- | --- | --- |
| Native connection | Claude RC HTTP/SSE through local MITM | transparent bridge observer or explicit-ID attach, plus Anthropic history/SSE client | private tmux pane + transcript files | OpenCode HTTP + server-wide SSE | explicit-port loopback app-server WebSocket, or literal `unix://` to Codex's same-user managed socket |
| Native session choice | Claude creates a fresh `cse_*` in the local RC service | exact `cse_*` from the spawned child's successful bridge request or explicit `--rc-native-session` | fresh UUID unless user supplied resume/session flags | required exact existing root `ses_*`; never list, discover, or create that root; follow announced children | required exact existing UUIDv7; resume/join only, never discover, select, create, delete, or stop |
| Capture | authenticated RC event batches | subscribe-before-history provider reconciliation | tail main and sub-agent JSONL | history plus coalesced SSE parts | resume subscription, `historyMode`-selected bounded text history, then buffered/live notifications |
| Remote text | Claude downstream SSE | serialized provider event POST | non-empty non-slash private-buffer text; helper/flock gates pane paste + Enter against active native turns | `prompt_async` | serialized `turn/start`, correlated to completed native user item |
| Local prompts in viewer | not generally surfaced | provider user events in provider order | post-hoc text-ledger match | every TUI/browser user at its native ordered ID; browser attribution requires exact marker + text | every completed TUI/browser text item at immutable `(turnId,itemId)` |
| Permission behavior | stable surface disabled | native/local; never projected or answered | native/local owner; posture is `local`, `bypassed`, or initially `unknown`; no browser answer | native/local by default; positive mirroring opt-in is experimental | approvals/questions solely owned by attached local TUI; companion cannot respond |
| Status advertised | yes | no | no | yes | yes |
| Restart reattachment | no | explicit exact-ID attach creates a fresh projection; it never adopts the prior projection | no; SessionEnd/rotation retires the writable projection but preserves the local pane | explicit same-session attach creates a fresh projection, reconciles bounded history, and consumes no old commands | a new explicit exact-thread invocation creates a fresh projection; restart acceptance is not yet claimed |

The exact advertised viewer capabilities are:

| Driver | Permissions | Status | Interrupt | Model | Mode | End | Attachments |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Stable `mitm` | no | yes | no | no | no | no | no |
| `claude-native` | no | no | no | no | no | no | no |
| `tmux` | no; posture says native/local, bypassed, or initially unknown | no | no | no | no | no | yes |
| Pinned `opencode`, default native/local permissions | no | yes | yes | no | no | no | no |
| `opencode`, experimental permission opt-in | yes | yes | yes | no | no | no | no |
| Pinned `codex` | no | yes | no | no | no | no | no |

See [tmux-driver.md](tmux-driver.md) and [opencode-driver.md](opencode-driver.md) for adapter-specific
limitations.

## 6. Dispatch and flags

`packages/cli/src/run.ts` resolves `--rc-driver`, then `RC_DRIVER`, then `mitm`. An unknown value exits
with a usage error. Every driver requires `--rc-app` or `RC_APP` to relay. Without a broker origin,
ordinary Claude launch forms warn and run plain Claude. An explicit `--rc-native-session` attach or any
OpenCode or Codex driver/configuration intent instead fails with usage status so an attachment can
never degrade into a new plain-Claude process.

Common flags:

```text
--rc-app <origin>
--rc-backend <vercel|local|sqlite>
--rc-driver <mitm|claude-native|tmux|opencode|codex>
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
```

Tmux permissions and questions remain native/local unless the caller's resolved Claude policy
explicitly bypasses them; the adapter has no remote permission switch. A direct actual-bypass argument
wins. Otherwise only the current SessionStart mode when present or a timestamped matching-session record
written after the current transcript attach supplies a known posture. Every attached backfill is ignored
and rotation clears the current announce's mode and republishes without one, restoring `unknown`.
Fresh Claude 2.1.237 can publish explicit
`unknown` before its lazy transcript exists; ordinary browser text and attachments remain enabled while
the viewer says the mode is being confirmed. The transcript pump then projects later timestamped
permission-mode evidence through presence `mode`, so the viewer resolves to `local` or `bypassed` and
follows later local mode changes. No settings parser, permission hook, request, or decision content is
added. The fixed helper and synchronous hooks share a startup-probed Linux `flock`; prompt-hook failure
is normalized to blocking status `2`, and SessionEnd retires only the projection. No global Enter
binding or TUI parser is installed. This protects an active model turn and the native permission/question
modal reached within it. It does not isolate the idle local editor or idle slash/config UI: do not
manipulate those surfaces while remote viewers may submit, and do not infer independent peer
ordering. Interrupt, model, mode, and end remain local-only. Pane-bound text and attachment captions
reject C0/C1 terminal controls other than TAB/LF in the viewer and relay, with a final check before tmux.

OpenCode options:

```text
--rc-oc-url <origin>
--rc-oc-model <providerID/modelID>
--rc-oc-session <ses_*>
--rc-oc-mirror-permissions
```

Codex options:

```text
--rc-codex-url <unix://|loopback-ws-origin>
--rc-codex-thread <uuidv7>
```

`RC_CODEX_URL` and `RC_CODEX_THREAD` are the environment equivalents; the URL defaults to
`ws://127.0.0.1:4500`, while the exact thread remains required.

Driver-specific flags supplied to a different driver are reported as ignored, except that
`--rc-native-session` is rejected on every other driver and `claude-native` rejects `--rc-inference`,
`--rc-bedrock-*`, and `--rc-accountless` because it preserves Anthropic Remote Control. Non-reserved
arguments are forwarded to Claude by the MITM, Claude-native launch, and tmux launch paths. The
Claude-native attach-only form rejects them. OpenCode and Codex attach to existing native servers,
reject forwarded arguments, and use only their explicit driver options. Any OpenCode or Codex
driver/configuration intent without `--rc-app` fails instead of silently launching plain Claude. Codex
accepts either an explicit-port `ws://127.0.0.1` or `ws://[::1]` origin with no credentials, path,
query, or fragment, or the exact literal `unix://`. That token resolves only to
`$CODEX_HOME/app-server-control/app-server-control.sock`, falling back to the current user's
`~/.codex`; arbitrary Unix paths are rejected. The exact thread ID remains required.

After resume, `historyMode:"paginated"` selects bounded ascending `thread/items/list` and
`historyMode:"legacy"` selects bounded ascending `thread/turns/list` with `itemsView:"full"`. Both
filter unsupported item families before the 10,000 projected user/assistant text-item cap. The exact
official-Remote M3b acceptance exercised the literal managed socket and this legacy full-turn reader.

## 7. Safety rules for a driver change

A driver change must preserve these current boundaries:

1. Do not announce before native readiness and the advertised permission setup are established.
2. Do not infer a native identity from “most recent” when an exact ID is available or selection is
   ambiguous.
3. Authenticate and deduplicate broker input in the shared relay; do not add a driver-specific wire
   backdoor.
4. Serialize irreversible input to the degree the native seam supports, and state any shared-input
   limitation explicitly. Never treat an ambiguous transport failure as proof that a native action did
   not happen.
5. Advertise only controls the adapter can faithfully service, and make unsupported actions safe
   no-ops at the host boundary.
6. Bound reconnect, in-memory dedup/buffering, and teardown work where the implementation can do so
   without risking duplicate native actions.
7. Keep provider, OAuth, broker, and identity credentials out of argv, logs, child-only environments,
   and browser plaintext.
8. Do not call the process-local readiness object durable or restart-safe. Explicit Claude-native,
   OpenCode, or Codex attachment creates a fresh bridge; it does not make the object or retired
   projection durable.

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
- `packages/cli/src/host/rc/codex/**` — app-server client, Codex adapter, and focused tests.
- `packages/cli/src/run.ts` and `packages/cli/src/args.ts` — dispatch and flags.

The relay and browser tests remain driver-independent. Adapter tests use injected native clients,
filesystem/tmux seams, clocks, and broker clients. The opt-in OpenCode e2e suite can exercise a live
local `opencode serve`; the M3a acceptance uses a real app-server/TUI and two browser contexts.
