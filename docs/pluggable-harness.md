# Pluggable harness drivers — the `Session` seam

`remote-claw` bridges a coding agent (today: the real `claude --remote-control`) to an
E2E-encrypted broker, so a phone or laptop can watch and drive that agent. This document records the
legacy **per-conversation compatibility port** shared by the current harness paths
(claude-behind-MITM, a plain `claude` in tmux, and OpenCode).

> **Scope:** each `Session` is one Claude-shaped compatibility chat, but the abstraction proposed in
> this document was only partially realized. `run.ts` dispatches directly to three launch functions;
> MITM can lazily create several `Session`s and has no `Driver` wrapper; OpenCode has its own driver
> class; tmux exports a `Driver` façade but dispatch calls `runTmuxDriver` directly. `DriverFactory` is
> exported but unused. The selected
> [client-driven host runtime](client-driven-host-runtime.md) now provides a neutral host-wide
> native-engine contract above it. A0.1 routes Claude MITM through one process-local registrar and one
> lease per intercepted conversation; A0.2 now routes both OpenCode and tmux through the same
> registration seam. `Session` remains a legacy RC port during migration; it does not
> become the neutral schema. In particular, Codex is one
> persistent multi-project app-server host, not another one-`Session` `DriverName`.

**Identity scope.** A compatibility `Session.id` is a synthetic `cse_*` broker channel address, and
the A0 registrar's `rcb_*` is only a process-local lease. Neither is the stable logical-chat ID
targeted by A1, and neither may stand in for an engine's semantic conversation ID. The future durable
coordinator must key the canonical chat by `(collaborationServerId, logicalChatId)` and map that pair
separately to native and outward bindings. Machine-facing route, row, alias, and cache addresses add
`identity_id` to that pair. A proven transport replacement may rotate its runtime/channel incarnation
without changing either canonical chat coordinate. This document does not claim that recovery exists
today.

The common relay port is **`Session`** (`packages/cli/src/host/rc/session.ts`). Each current harness
path produces one or more `Session`s, fills them with Claude-shaped output, and consumes the input the
relay delivers. `HostRcRelay` and the web frame projection remain shared; harness launch/lifecycle is
not unified behind the exported `Driver` interface. Claude MITM, OpenCode, and tmux lifecycle are now
mediated by the neutral process-local registrar.

---

## 1. Why `Session` is the seam (grounded in the code)

`HostRcRelay` (`relay.ts`) has four required transport/session inputs and never learns how the agent
runs. Optional tracer, capability, harness, and attachment-directory fields configure the projection;
they do not expose harness mechanics:

```ts
new HostRcRelay({
  client,       // BrokerClient — the E2E broker transport
  identityId,   // Uint8Array (this machine's 16-byte identity id, = identity.identityId)
  sessionId,    // string (= session.id, the cse_… channel address)
  session,      // Session — the in-memory event bus for ONE RC session
});
```

`relay.serve(signal)` then runs two coupled pumps that are the relay's whole job:

- **OUTBOUND** — `for await (ev of session.followUpstream(...))` → `mapUpstreamItems(ev)` → seal →
  `POST` to the broker session channel.
- **INBOUND** — tail the broker session channel → for each client frame call back **into the
  session**: a `user` frame → `session.pushUserInput(text)`; a `permission` frame →
  `session.pushControlResponse(...)`; `interrupt` / `set_model` / `set_mode` →
  `session.pushControlRequest(...)`. An `end` frame emits no session event; it only clears the relay's
  open permission gates.

So the relay is *already* a pure function of `(Session, BrokerClient)`. The MITM
(`mitm.ts`) is the **reference harness path** (three modes ship today: `mitm` / `tmux` / `opencode`): it serves
claude's RC HTTP/SSE endpoints from a
`RelayCore`, turning claude's `POST /worker/events` into `session.pushUpstream(payload)` and claude's
`GET /worker/events/stream` into a `session.followDownstream(...)` SSE loop. The non-MITM paths
replace *that HTTP wiring* with another capture/inject mechanism and reuse the relay verbatim. In the
shipped code they are separate launch paths, not instances of one dispatcher interface.

The decisive fact for non-MITM drivers: **claude's transcript JSONL
(`~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`) `message.content` blocks are byte-identical to
what `mapUpstreamItems` destructures** (`text` / `thinking` / `tool_use` / `tool_result`, same field
names). A tmux driver tails that file and `pushUpstream`s it nearly verbatim — the only reshape is
`parentToolUseID` → `parent_tool_use_id` for sub-agent nesting.

```
local path
  person
    ⇅
  native TUI
    ⇅
  native harness

remote path
  same native harness
    ⇅
  chosen adapter
    ├─ capture output
    ├─ inject input
    ├─ report status
    └─ bridge permissions
    ⇅
  Session
    ⇅
  HostRcRelay
    ⇅
  broker + web viewer
```

Each current harness can coexist with a person using a native surface: the real Claude TUI in MITM
mode, the attached Claude pane in tmux mode, or a native OpenCode TUI sharing the server. That direct
local input does not pass through `Session` before native execution today. Tmux and OpenCode can mark
the resulting unmatched user record `local_prompt:true` after the fact; the MITM path does not add that
marker, so the relay drops its ordinary user echo. The selected host runtime keeps that direct TUI path
and makes remote-claw the one remote collaborator for structured Claude, Codex, and OpenCode adapters.
Its server may multiplex many remote users behind that one adapter connection; the native harness
remains the final arbiter. Tmux does not expose two native collaborators: the person and injector share
one editor keystream and require an exclusive/quiescent input boundary to avoid merged drafts.

---

## 2. The partially used `Driver` interface

`driver.ts` exports a thin `Driver` contract for two pumps against one `Session`. Tmux and OpenCode
implement it, but the current dispatcher calls their run helpers directly rather than instantiating
them through `DriverFactory`; MITM has no `Driver` implementation. The useful shared contract is
therefore the `Session`/capability/payload shape below, not a polymorphic dispatcher.

```ts
// packages/cli/src/host/rc/driver.ts

import type { Identity } from "@remote-claw/clawsec";
import type { BrokerClient } from "../../broker/client.js";
import type { Tracer } from "../../trace.js";
import type { GitInfo } from "./gitinfo.js";
import type { Session } from "./session.js";

/** The driver names the wrapper can dispatch on (`--rc-driver=<name>`, default "mitm"). */
export type DriverName = "mitm" | "tmux" | "opencode";

/**
 * Everything a driver needs to bridge a harness to the broker. Mirrors the launch surface
 * (RcLaunchOptions in launch.ts) so the MITM driver maps onto it 1:1; non-MITM drivers ignore the
 * MITM-only fields and add their own under `extra`.
 */
export interface DriverContext {
  /** Args forwarded verbatim to the harness binary. */
  harnessArgs: string[];
  /** Optional harness binary override used by child-spawning paths such as tmux. */
  harnessBin?: string;
  /** This machine's identity (its bus + session keys). identity.identityId feeds HostRcRelay. */
  identity: Identity;
  /** The broker origin (`--rc-app` / RC_APP); its /api is the relay broker. */
  brokerUrl: string;
  /** Which broker backend to target (`--rc-backend` / RC_BACKEND); omitted ⇒ broker default. */
  backend?: string;
  /** Session title for the announce (default "remote-claw"). */
  title: string;
  /** The session's working dir, snapshotted for the announce's cwd + git chip. */
  cwd: string;
  /** Static git snapshot for the viewer's git chip; null outside a repo. */
  git: GitInfo | null;
  /** Builds a fresh BrokerClient (already wired with provider + Vercel bypass + backend), one per
   *  session — exactly as launch.ts does, so each relay owns its own transport. */
  newClient: () => BrokerClient;
  /** Driver-own diagnostics tracer (target "rc.<name>"; defaults to no-op). */
  tracer?: Tracer;
  /** Notified the instant a Session registers (test parity with launch.ts's onSession). */
  onSession?: (s: Session) => void;
  /** Driver-specific knobs (e.g. { certsDir, spawnClaude } for mitm; { dangerouslySkipPermissions }
   *  for tmux). */
  extra?: Record<string, unknown>;
}

/** A driver declares which broker-side features it can faithfully service. The relay broadcasts this on
 *  every session_announce, and the VIEWER disables + labels the controls a driver can't honor — so a
 *  permission-mode / model "✓" never lies (#149). */
export interface DriverCapabilities {
  /** Can surface + round-trip structured can_use_tool gates (else auto-approve/ignore). When false the
   *  session runs WITHOUT per-tool gating and the viewer shows a "permissions off" posture. */
  structuredPermissions: boolean;
  /** Reports real workerStatus transitions (else presence is best-effort heuristic). */
  status: boolean;
  /** Per-verb control support — coarse "controlVerbs: boolean" couldn't say "interrupt works but
   *  set_mode doesn't". `end` is false on EVERY driver (claude's REPL bridge has no remote end). */
  controls: { interrupt: boolean; setModel: boolean; setMode: boolean; end: boolean };
  /** Receives viewer attachments. NOTE: attachments are relay-owned end-to-end (§5); a driver never
   *  sees the attachment frame — only the resulting `user` prompt downstream. Tracks `user`
   *  injection support; listed for documentation. */
  attachments: boolean;
}

/**
 * A pluggable harness adapter. A driver MUST:
 *   1. Create a Session via RelayCore.create({ title }) and call session.pushInitialize() once
 *      (idempotent; guarantees `initialize` is the first downstream event).
 *   2. CAPTURE: translate harness output into a canonical UpstreamPayload (§3) and call
 *      session.pushUpstream(payload). relay.mapUpstreamItems consumes it unchanged.
 *   3. INJECT: drain session.followDownstream(session.claimWorkerStream(), () => signal.aborted);
 *      for each eventType === "user" send its text to the harness; map control_request verbs.
 *   4. STATUS: set session.workerStatus + call session.wake() so the relay's presence tracks it.
 *   5. PERMISSIONS (capability-gated): raise a gate by pushUpstream-ing a can_use_tool
 *      control_request; apply an answer by observing the matching control_response in
 *      followDownstream. The relay's existing permission_request ⇄ permission round-trip does the
 *      broker side — no relay change.
 * The current harness paths open a process-local registrar lease in `starting`, publish validated
 * metadata/capabilities, and enter `ready`; that transition creates the broker client and starts the
 * shared relay. Each driver must finish its own readiness checks first. The registrar owns the bridge
 * lifecycle but not the native Session, and this process-local seam is not durable reattachment.
 */
export interface Driver {
  readonly capabilities: DriverCapabilities;
  /** Run until `signal` aborts (or the harness exits). Resolves with the harness exit code. */
  run(signal: AbortSignal): Promise<number>;
}

/** Exported factory type; the current dispatcher does not call it. */
export type DriverFactory = (ctx: DriverContext) => Driver;
```

### Historical MITM-adapter proposal — not implemented

`runRcLaunch` (launch.ts) is exported and **directly unit-tested** (`launch.test.ts` constructs it
with `{ claudeArgs, identity, brokerUrl, certsDir, spawnClaude, … }` and asserts the child env, the
teardown, and a full broker round-trip). The proposal was to wrap it in `mitmDriver`, but no
`drivers/mitm-driver.ts` exists and current `run.ts` calls `runRcLaunchPath` directly. This retained
sketch explains the intended adapter shape; it is not an implementation inventory:

```ts
// proposed only — this file/function does not exist
export function mitmDriver(ctx: DriverContext): Driver {
  return {
    capabilities: MITM_CAPABILITIES, // { structuredPermissions, status, attachments: true, controls: { interrupt:true, setModel:true, setMode:true, end:false } }
    run: (signal) =>
      runRcLaunch({
        claudeArgs: ctx.harnessArgs,
        identity: ctx.identity,
        brokerUrl: ctx.brokerUrl,
        certsDir: String(ctx.extra?.certsDir),
        title: ctx.title,
        cwd: ctx.cwd,
        ...(ctx.backend !== undefined ? { backend: ctx.backend } : {}),
        ...(ctx.onSession ? { onSession: ctx.onSession } : {}),
        spawnClaude: ctx.extra?.spawnClaude as SpawnClaudeEnv,
        // runRcLaunch derives its own git via gitInfo(cwd); signal threads through an AbortController.
      }),
  };
}
```

Had it been implemented, this would have kept `launch.test.ts`'s surface unchanged. It remains
historical: current MITM uses `LegacyRcConversationRegistrar`, which calls `startBridgeSession` at
`ready`. OpenCode now uses that registrar too, after strict native session selection and
parent-permission setup unless explicitly opted out. Tmux uses it after proving its private pane and
required startup hook:

```ts
// process-local compatibility registration (tmux shown):
const core = new RelayCore();
const session = core.create({ title: ctx.title });
session.pushInitialize();
ctx.onSession?.(session);

const lease = await registrar.open({
  phase: "starting",
  port: session,
  nativeRef: null,
  capabilities: null,
  // descriptor, attempt identity, and metadata omitted
});

// Prepare private tmux runtime/settings, spawn, require a live pane and the
// SessionStart marker, and construct the native pumps.
await lease.update(metadataWithProvedCapabilities, TMUX_NATIVE_CAPABILITIES);
await lease.setPhase("ready"); // only now starts HostRcRelay and announces
```

For all three migrated paths, the registrar validates generic and viewer-facing capabilities and
calls `startBridgeSession` only at `ready`. OpenCode first confirms one exact native session and
requires parent permission read/install/read-back unless opted out. Tmux first creates private
runtime/settings state, confirms a live pane, and requires Claude's `SessionStart` marker from the
exact merged settings source. Its optional session-hook flag controls continued exact
transcript/rotation following after startup, not the mandatory first marker. These leases isolate
live bridges inside one process; none is a persisted A1 inventory or restart attachment.

---

## 3. The canonical content-block contract (every compatibility path must emit this)

`mapUpstreamItems(ev)` (relay.ts) is the spec. A driver normalizes its harness output to the
following shape and calls `session.pushUpstream(payload)`. **If the shape drifts, the relay silently
drops the frame** — there is no driver-specific adaptation in the relay, by design. Strong typing on
the driver is the only defense.

```ts
/** What session.pushUpstream(payload) accepts. Byte-identical to claude's worker /worker/events
 *  POST bodies AND to a transcript JSONL line's top-level object. */
export interface UpstreamPayload {
  /** Event type. The relay routes on this exactly:
   *   "assistant" → text / thinking / tool_use blocks
   *   "user"      → tool_result blocks (the agent posts tool OUTPUT as a user-role message)
   *   "system"    → task_* lifecycle (sub-agent visibility); other system subtypes are dropped
   *   "result"    → end-of-turn result string
   *   "control_request" with request.subtype === "can_use_tool" → a permission gate
   *   "control_cancel_request" → clears an open gate (request_id) */
  type: "assistant" | "user" | "system" | "result"
      | "control_request" | "control_cancel_request" | string;

  /** Event uuid (unique within the session). If absent, the session mints one; supply the
   *  harness's own uuid where available so dedup/ordering is stable across reconnects. */
  uuid?: string;

  /** Sub-agent nesting: an assistant/user event produced UNDER a parent Task tool_use carries the
   *  spawning Task's tool_use_id. The viewer nests these under the Task. (Reshape from claude's
   *  JSONL `parentToolUseID` is the tmux driver's only required rename.) */
  parent_tool_use_id?: string | null;

  /** For "assistant" / "user": the message envelope. Content is normally blocks, but a
   *  driver-marked local prompt may use a plain string. */
  message?: {
    role?: "assistant" | "user" | string;
    content: ContentBlock[] | string;
  };

  /** A non-MITM driver sets this only for a prompt observed from its local/native UI rather than
   *  injected from the relay. The relay then surfaces that user text instead of dropping it. */
  local_prompt?: boolean;

  /** For "result": the turn's result (string preferred; non-string is JSON-stringified by relay). */
  result?: string | Record<string, unknown>;

  /** For "control_request": the permission gate. relay reads request_id at top level OR in request. */
  request_id?: string;
  request?: {
    subtype?: string;          // "can_use_tool" to render a permission_request
    tool_name?: string;        // e.g. "Bash", "AskUserQuestion"
    input?: unknown;           // real claude carries tool input here…
    tool_input?: unknown;      // …older/fake protocol used this; relay reads either
    tool_use_id?: string;      // rides the answer back as toolUseID (#42)
  };

  /** For "system": task lifecycle (only subtypes starting "task_" are surfaced). */
  subtype?: string;
  task_id?: string;
  description?: string;
  tool_use_id?: string;

  /** Forward-compat: any other fields are preserved (the relay ignores what it doesn't read). */
  [key: string]: unknown;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface TextBlock {
  type: "text";
  text: string;               // non-empty; empty text blocks are dropped
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;           // non-empty after trim; rendered muted/collapsible
}

export interface ToolUseBlock {
  type: "tool_use";
  name: string;               // tool name (a "Task" tool_use spawns a sub-agent)
  input: unknown;             // tool input (any JSON-serializable)
  id?: string;                // tool_use id; matched by a later tool_result.tool_use_id
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;        // matches the ToolUseBlock.id it answers
  content: string | ContentBlock[]; // Bash stdout (string) or structured blocks (text + [image])
  is_error?: boolean;         // true if the tool call failed
}
```

**Field-level rules the relay enforces (so drivers must honor):**

- `text` blocks with empty `text`, and `thinking` blocks empty after `.trim()`, are **dropped**.
  Don't rely on them to carry structure.
- A `tool_result`'s `content` is flattened to display text and **capped at 4000 chars**
  (`TOOL_RESULT_CAP`); non-text blocks (images) surface as a `[type]` marker — the host holds the
  image, `SendUserFile` is the worker→viewer image path.
- `system` events are surfaced **only** when `subtype` starts with `task_`; everything else
  (including the high-frequency `thinking_tokens` counter) is intentionally dropped.
- A `user` event's text is normally dropped because the inbound pump already echoes every viewer
  prompt; `tool_result` blocks still relay. The deliberate exception is a non-MITM driver's
  `local_prompt:true` event: OpenCode and tmux use an injected-text ledger to mark unmatched native
  user records that were not injected by this driver, and the relay surfaces that string text once.
  For tmux that identifies pane input; for OpenCode it may also be another client or backfilled history.
- The MITM path does not mark native-TUI prompts `local_prompt`, so their ordinary user echo is
  dropped even though Claude may execute the action and later output still flows upstream.

---

## 4. Downstream injection (what the driver consumes)

The relay pushes client input **into** the session; the driver pulls it **out** and drives the
harness. The driver claims a worker-stream generation token and drains downstream — exactly the
discipline `mitm.ts#streamWorker` uses, so a reconnect supersedes cleanly. The relay never emits an
`end_session` control request; an authenticated viewer `end` is consumed inside the relay to clear
open permission gates:

```ts
const gen = session.claimWorkerStream();          // newest claimer wins → single deliverer
for await (const ev of session.followDownstream(gen, () => signal.aborted)) {
  if (ev === null) continue;                       // heartbeat tick
  switch (ev.eventType) {
    case "user": {
      // ev.payload.message.content is the prompt text → send to the harness (send-keys / stdin).
      const content = (ev.payload.message as { content?: unknown })?.content;
      sendToHarness(typeof content === "string" ? content : String(content));
      break;
    }
    case "control_request": {
      const sub = (ev.payload.request as { subtype?: string })?.subtype;
      if (sub === "interrupt") interruptHarness();        // ESC / SIGINT
      else if (sub === "set_model") setModel(ev.payload); // best-effort
      else if (sub === "set_permission_mode") setMode(ev.payload);
      break;
    }
    case "control_response":
      // A permission grant the relay produced (pushControlResponse). The MITM driver forwards it
      // over the worker SSE; a structured-permission driver routes it to the harness's permission
      // mechanism. Drivers that auto-approve ignore it.
      break;
  }
}
```

Note: `initialize` is a `control_request` queued first by `pushInitialize()`; a driver typically
ignores it (it has no harness analogue) but must let it pass through the stream.
Non-MITM drivers acknowledge each event with `session.ack(ev.eventId)` after adapter dispatch or
deliberate compatibility handling returns, including handled no-ops such as `initialize`. This is
replay bookkeeping, not proof that the native harness accepted, ordered, or applied the action:
OpenCode text is ACKed after a transport-only 204 and `/compact` before summarize settles. Without that
ACK, a later `claimWorkerStream()` replays the event. The current OpenCode pump keeps draining after a
failed event, so replay requires a new claimant; an ordinary OpenCode SSE reconnect does not create
one.

Native-TUI input is not downstream injection in the current harness contract. The native client
accepts it directly; OpenCode/tmux may project it post-hoc and MITM omits its user text from the viewer.
Consequently `Session` cannot establish the final native order across TUI and viewer writes. The
selected design retains the TUI as one native participant and represents remote-claw as the other.
The future control journal orders remote-claw's server-side collaborators, then records the native
harness's observed interleaving as the applied order.

The selected neutral host contract does not let a driver decide whether remote work is admissible.
Every web, official-client, automation, or nested proposal first enters the same server-wide command
order and receives one signed final result. Only a signed admission may create one adapter attempt;
queued and rejected results create none. A new submission and a steer of a running turn remain
different commands even when the harness is busy. The person's direct TUI action bypasses this remote
decision path, and the native harness—not `Session`—decides the final local/remote order and what was
actually applied.

For OpenCode, the selected path does not promote this compatibility pump's `/compact`, interrupt, or
permission behavior. Its first writable A2 vectors are exactly server-scoped `{new_chat}` and
binding-scoped `{user_text}`. After common admission, the adapter must build the one exact native
request, use only the current fenced front door, and match the native message and order through
a complete, ordered history snapshot plus the matching live event only when that snapshot method
requires one. A 204, an ACK, missing read-back, or a different request shape is not success. Compact,
interrupt, steer, blank submit, permission, and every other unproved family is stored as rejected
before native work. Stock `1.17.5` remains unsupported for writable A2 until the real-TUI front door,
complete route manifest, raw-listener/tool fence, and observer linearization are proved.

---

## 5. Permissions and attachments are relay-owned — keep drivers transparent

- **Permissions.** The broker side (a `permission_request` content frame out, a `permission` frame
  in, the `permission_resolved` log frame, AskUserQuestion's `questions` echo, the `q.map` fix) is
  **entirely in the relay**. A driver participates only at the harness boundary: to *raise* a gate it
  `pushUpstream`s a `can_use_tool` control_request; to *apply* an answer it observes the
  `control_response` in `followDownstream`. All three paths are configured to mirror gates by default:
  MITM via Claude's native RC, **tmux** via an injected **PreToolUse hook**, and **OpenCode** via the
  session permission API (PATCH an ask-all rule ↔ SSE `permission.asked`). The opt-outs are not
  identical: `--rc-tmux-skip-permissions` restores hands-off auto-approve
  (`--dangerously-skip-permissions`), while `--rc-oc-skip-permissions` only skips the ask-PATCH and leaves
  OpenCode's own session permission config in place (auto-run unless that config already asks).
  OpenCode now treats parent permission read/PATCH/read-back failure as a registration failure, skips
  the native append when the exact catch-all already exists, and advertises
  `structuredPermissions:true` only after that setup verifies. The opt-out performs no additional
  permission setup or PATCH and advertises false; exact session confirmation still validates any
  returned policy field. Child-session setup is asynchronous and cannot prove a child's first tool was
  gated, but it now receives the run cancellation signal, is tracked, cannot PATCH after the teardown
  fence, and joins the shared bounded teardown. OpenCode answers a gate through retained
  `POST /permission/{requestID}/reply` with `{reply}` and requires successful JSON to be literal `true`.
  That is transport acknowledgement only: the global route does not prove selected-session ownership,
  a win over a native-TUI answer, or terminal `permission.replied` semantics. Tmux can disable its hook
  after an unparseable user settings file, after it has already announced
  `structuredPermissions:true`; that remains a known capability-advertisement bug.
- **Attachments.** `relay.#handleAttachmentPayload` decrypts the viewer's bytes, writes them under
  `attachmentsDir`, and **injects a normal `user` prompt** containing `@"<path>"` references. The
  driver never sees an `attachment` frame — only the resulting downstream `user` event. This is
  proven for Claude MITM/tmux. Native OpenCode file-part handling is not implemented, so OpenCode now
  advertises `attachments:false`. That bit disables the normal viewer surface; the compatibility relay
  does not enforce capabilities as an admission boundary, so a stale/custom sender can still force the
  unsupported Claude-style path until the future command actor rejects it before file/native work.

This is the central invariant: **the relay handles the broker-facing protocol; the driver handles
the harness-facing protocol; they meet only at the `Session`.**

---

## 6. `--rc-driver` wiring

The shipped value flag selects a launch path; default `mitm` preserves the original behavior.

- **`args.ts`** contains `"rc-driver": "value"` in `RC_FLAGS`.
- **`run.ts`** reads `--rc-driver`, then `RC_DRIVER`, then defaults to `"mitm"` and branches directly:
  - `mitm` → `runRcLaunchPath(...)` → `runRcLaunch(...)`;
  - `tmux` → `runTmuxDriverPath(...)` → `runTmuxDriver(ctx, ...)`;
  - `opencode` → `runOpencodeDriverPath(...)` → `runOpencodeDriver(ctx, ...)`.
  Only the non-MITM branches build the common `DriverContext`; none dispatches through
  `DriverFactory`.

All three still need `--rc-app` for the broker. The current guard warns when RC flags appear without
it, and an unknown `--rc-driver=<x>` returns exit 2 with the valid names.

```
remote-claw --rc-app https://app.example --rc-driver=tmux -- --model opus
            └ broker origin ─────────────┘ └ driver ────┘    └ forwarded to claude ┘
```

---

## 7. Current implementation inventory

### Present

- `packages/cli/src/host/rc/driver.ts` — the exported `Driver` / `DriverContext` /
  `DriverCapabilities` / `UpstreamPayload` / `ContentBlock` types + `DriverName`. It is a partial
  contract, not the dispatch mechanism.
- `packages/cli/src/host/rc/tmux/{driver,tmuxctl,transcript,inject}.ts` — `runTmuxDriver(ctx)` spawns
  plain `claude` on a private tmux server, tails transcript JSONL, and injects via an stdin-backed tmux
  paste buffer. Its process-local registrar lease stays `starting` until a live pane plus Claude's
  mandatory `SessionStart` marker prove the exact settings/native session; only then does it publish
  capabilities and enter `ready`. It also exports the currently unused `tmuxDriver(ctx)` façade.
- `packages/cli/src/host/rc/opencode/driver.ts` — `runOpencodeDriver(ctx)` bridges an `opencode serve`
  HTTP+SSE session by constructing the exported-interface implementation `OpencodeDriver`.
- `packages/cli/src/host/native/{adapter,index}.ts` — the neutral native-engine descriptors,
  registration request, conversation lease, lifecycle, capabilities, and adapter/registrar contracts.
  They do not import `Session`.
- `packages/cli/src/host/rc/drivers/legacy-registrar.ts` — the process-local A0 registrar. It assigns
  `rcb_*` bindings, enforces exact attempt replay and active identity uniqueness, validates readiness,
  owns each bridge lease, and does not own the native `Session`.
- `packages/cli/src/host/rc/drivers/bridge.ts` — `startBridgeSession` returns a lifecycle handle with a
  whole-announcement refresh; `bridgeSession` retains the older served-promise API.
- `packages/cli/src/host/rc/launch.ts` — the standalone MITM launch path and its host-scoped registrar.
  There is no `drivers/mitm-driver.ts` or `mitmDriver`.
- `packages/cli/src/host/rc/relay.ts` — the shared relay; its announcement metadata and capabilities
  can now be replaced as one post-setup snapshot without restarting the pumps. That validated local
  snapshot survives an advisory publish failure and is retried by later presence publication.

### Dispatcher

- `packages/cli/src/args.ts` declares `"rc-driver": "value"`.
- `packages/cli/src/run.ts` validates and directly dispatches each launch path; it builds
  `DriverContext` only for OpenCode and tmux.
- `packages/cli/src/host/rc/index.ts` re-exports the neutral lifecycle, legacy registrar, bridge
  lifecycle, driver types, and tmux façade.

### Compatibility surfaces left unchanged

- `packages/cli/src/host/rc/session.ts` — **the seam itself.** Drivers only *use* its public methods
  (`create`, `pushInitialize`, `pushUpstream`, `claimWorkerStream`, `followDownstream`,
  `pushUserInput`/`pushControlResponse`/`pushControlRequest`, `workerStatus`, `wake`, `close`). No new
  capability is required.
- `packages/cli/src/host/rc/mitm.ts` — only the MITM launch path uses it; other paths don't import it.
- `packages/cli/src/host/rc/certs.ts`, `gitinfo.ts` — MITM/announce helpers, unaffected.
- `packages/cli/src/broker/client.ts` — the transport contract is fixed; drivers go *through* the
  relay, never around it.
- `apps/web/lib/broker/**` (router, backends: vercel/local/sqlite), and **all of the web
  viewer** — they consume sealed frames keyed by `(identity, session)`. Since the frame stream is a
  pure function of the canonical `UpstreamPayload` (which every compatibility path matches), nothing
  downstream can tell which path produced the session.
- `packages/cli/src/security/provider.ts`, `packages/cli/src/trace.ts` — orthogonal (sealing,
  diagnostics).

---

## 8. Risks and mitigations

1. **Canonical-shape drift.** A driver emitting a slightly-off block (`tool_use` without `name`, a
   `null` content entry, a renamed field) is *silently dropped* by `mapUpstreamItems`. Mitigation:
   the `UpstreamPayload`/`ContentBlock` types live in `driver.ts`; current transcript tests use reduced
   captured JSONL fixtures and translation cases. A live transcript-versus-MITM parity test remains a
   proposed stronger gate.
2. **`runRcLaunch` changes regressing the MITM path.** Mitigation: keep its direct tests as the guard.
   The historical `mitmDriver` wrapper proposal was not implemented.
3. **Injection ambiguity / send-keys failures (tmux).** `runInjectPump` serializes the downstream
   stream, so a burst cannot interleave prompts. Prompt text reaches `tmux load-buffer` over stdin,
   never argv; bracketed paste and Enter are separate phases with a length-scaled settle. It ACKs
   prompt/key actions only after the tmux command succeeds, but tmux success is still not structural
   acceptance evidence from Claude, and a lost post-dispatch completion remains ambiguous. It maps
   `interrupt` (→ ESC) and `set_model` (→ `/model <id>` inject); `set_mode`/`end` have no faithful pane
   analogue (the viewer disables those controls, #149), so they safely no-op. A permission-decision
   write failure throws, leaves the response unacknowledged, and tears down the pump; it does not
   produce a false delivery receipt.
4. **Permission fidelity on non-MITM drivers.** Both non-MITM drivers attempt mirroring by default.
   **tmux** injects a **PreToolUse hook** that blocks each tool until the
   viewer answers (and pre-seeds claude's folder-trust bit so dropping `--dangerously-skip-permissions`
   doesn't hang a fresh cwd on the startup trust gate); **opencode** PATCHes an ask-all rule on the
   session and answers each SSE `permission.asked`. Opt out with `--rc-tmux-skip-permissions` (→
   `--dangerously-skip-permissions` auto-approve) or `--rc-oc-skip-permissions` (skip additional
   permission setup and PATCH; OpenCode keeps its own session permission config). OpenCode's parent
   setup now requires read/install/read-back before `ready`, but child setup remains asynchronous and
   first-tool-racy. Child tasks are run-cancelled, tracked, PATCH-fenced after cancellation, and joined
   under the shared teardown deadline. A literal-true reply response is only transport acknowledgement;
   selected-session ownership, native-TUI races, and terminal application remain unproved. Tmux now
   withholds its broker bridge until settings/trust setup, a live pane, and its mandatory startup
   `SessionStart` marker are proved. Hook-disabling modes and unmergeable settings fail closed.
5. **Status accuracy.** Without ground truth (the MITM reads claude's `PUT /worker` status), tmux
   infers `running`/`idle` from a transcript-append debounce, which lags a long "think". It advertises
   `status:false`; the internal heuristic is display/evidence only, not a promised native transition.
6. **Durable-restart cursors.** The relay's `serve()` calls `prepare()` to sample broker cursors
   before pumping; a driver must call `relay.serve(signal)` (not hand-roll the pumps). The sampled
   floor prevents replay of older inbound frames but can skip an unprocessed prompt that arrived
   before the sample; it is duplicate-prevention with a documented loss window, not fail-closed
   command recovery. It also does not make the synthetic `cse_*` channel a durable logical chat or
   recover its native/outward bindings.
7. **Launch cardinality.** Tmux and OpenCode launch one wrapper `Session`; one MITM launch can accept
   several intercepted Claude RC sessions. The dispatcher still selects one harness mode per wrapper
   process.
8. **Tmux teardown/restart.** The driver uses a private `0700` runtime and private tmux socket. Teardown
   deletes them only after a proved kill or proved absence; an unknown probe/kill retains them and logs
   the exact `tmux -S <socket> attach -t <session>` command. That preserves a possibly-live pane but
   does not make it recoverable by a new wrapper: its registrar and binding are process-local and
   `liveReattach:false`. Durable adoption is A1 work.

---

## 9. Summary

`Session` is the current shared relay port, not a complete host abstraction. Each harness path
**captures** output into the canonical content-block envelope (`pushUpstream`), **injects** downstream
user/control events (`followDownstream` or the native RC server), reports status where possible, and
lets the relay own broker-side permissions + attachments. `run.ts` directly selects
`--rc-driver={mitm|tmux|opencode}`; the exported `Driver`/`DriverFactory` pair does not unify that
dispatch. Above this compatibility port, the neutral host contract and process-local registrar now
mediate Claude MITM, OpenCode, and tmux sessions. The
capability-aware part is implemented: each path supplies `DriverCapabilities`, the relay rides them on
`session_announce`, and the viewer disables/labels declared unsupported controls. Claude MITM and
both A0.2 drivers wait for validated readiness before they start the bridge. OpenCode publishes
`status:false`, `attachments:false`, only interrupt control, and structured permissions only after
proved parent setup; §8 retains the child/reply limitations. Tmux publishes `status:false`,
records native `liveReattach:false` plus best-effort delivery evidence, and publishes structured
permissions only after its required hook/settings/trust readiness proof (or false after explicit
auto-approve opt-out).

A person can also use the harness's native TUI directly. That local path is outside the current
`Session` relay seam: tmux/OpenCode surface unmatched prompts post-hoc, while MITM drops ordinary
native user echoes. The selected runtime retains one logical remote-claw collaborator attachment per
structured session. Claude may realize that as a session-scoped physical connection. OpenCode instead
needs one epoch-fenced adapter lease enforced at its private HTTP endpoint because its server-wide SSE
plus independent HTTP requests expose no persistent writer connection identity. Replacing that lease
must also settle or quarantine requests already admitted under the old epoch; checking the epoch only
when a request arrives cannot retract a mutation forwarded to OpenCode. Codex uses one daemon-wide
native bridge with a separate logical binding per managed top-level chat thread; child-agent threads
stay nested native evidence until retained lineage proof establishes another user-visible mapping.
remote-claw can aggregate web, official-client, automation, or nested-server collaborators behind that
attachment; the native harness decides what is applied. For Claude, Codex, and OpenCode, any
native-client-facing façade or proxy sits below the future neutral host contract and must be
behaviorally indistinguishable from the pinned product's normal service. The current `Session` seam is
only a Claude-shaped compatibility projection; it is not that common adjudicator and cannot authorize
native work.
Native TUI traffic is never translated into the Claude-shaped `Session` schema on its way to the
native harness. Tmux cannot meet that structured drop-in contract and remains the explicit
lower-fidelity fallback.

A nested remote-claw server uses the same common decision path as any other collaborator. Before
sending inward, it jointly finalizes the signed result and signed lineage for that command. It calls
the nested operation complete only after a full downstream receipt ties the exact source event,
command, chosen target, and target server's signed result together. A partial ACK cannot release work.
Each edge carries commands inward and observations outward without converting one direction into the
other, so recursion cannot feed an echo back as a command. Nesting adds server boundaries only;
Claude, Codex, or OpenCode appears once, at the innermost end.

Stable host → project → logical-chat identity remains an A1 target above this seam. It must be
persisted separately from `Session.id`, the `rcb_*` lease, engine-native IDs, and provider/broker
connection IDs.

Alongside capabilities, each harness path supplies a `HarnessDescriptor` —
`{ agent: "claude-code" | "opencode"; mode: "rc" | "tmux" | "opencode" }` (the consts `MITM_HARNESS` /
`TMUX_HARNESS` / `OPENCODE_HARNESS`) — which the relay rides on every `session_announce` (#164).
The viewer labels each row in the session list from it (**Claude Code · RC** / **Claude Code · TX**
/ **opencode**) so the three harnesses don't look identical; a legacy host that omits it is treated
as the MITM harness (native-RC Claude Code, the only pre-#164 path).
