# Pluggable harness drivers — the `Session` seam

`remote-claw` bridges a coding agent (today: the real `claude --remote-control`) to an
E2E-encrypted broker, so a phone or laptop can watch and drive that agent. This document records
the **one clean integration seam** that lets us swap the *agent harness* (claude-behind-MITM, a
plain `claude` in tmux, OpenCode, …) **without touching the relay, the broker, or the web viewer**.

The seam is the **`Session`** (`packages/cli/src/host/rc/session.ts`). A *driver* is the only new
concept: an adapter that produces a `Session`, fills it with the agent's output in claude's
canonical content-block shape, and feeds the agent the user input the relay delivers into that
`Session`. Everything downstream of the `Session` is invariant.

---

## 1. Why `Session` is the seam (grounded in the code)

`HostRcRelay` (`relay.ts`) is constructed with exactly four things and never learns how the agent
runs:

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
  `session.pushControlResponse(...)`; a control verb (`interrupt`/`set_model`/`set_mode`/`end`) →
  `session.pushControlRequest(...)`.

So the relay is *already* a pure function of `(Session, BrokerClient)`. The MITM
(`mitm.ts`) is simply the **only current driver**: it serves claude's RC HTTP/SSE endpoints from a
`RelayCore`, turning claude's `POST /worker/events` into `session.pushUpstream(payload)` and claude's
`GET /worker/events/stream` into a `session.followDownstream(...)` SSE loop. A second driver replaces
*that HTTP wiring* with a different capture/inject mechanism — and reuses the relay verbatim.

The decisive fact for non-MITM drivers: **claude's transcript JSONL
(`~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`) `message.content` blocks are byte-identical to
what `mapUpstreamItems` destructures** (`text` / `thinking` / `tool_use` / `tool_result`, same field
names). A tmux driver tails that file and `pushUpstream`s it nearly verbatim — the only reshape is
`parentToolUseID` → `parent_tool_use_id` for sub-agent nesting.

```
            ┌──────────────── DRIVER (new, swappable) ─────────────────┐
 harness ──▶│ CAPTURE: native output → canonical payload                │──▶ session.pushUpstream()
 (claude /  │ INJECT:  session.followDownstream() → native input        │◀── session (downstream queue)
  tmux /    │ STATUS:  session.workerStatus = … ; session.wake()        │
  opencode) │ PERMS:   pushUpstream(can_use_tool) ↔ followDownstream(control_response)
            └──────────────────────────┬───────────────────────────────┘
                                        │  Session  (THE SEAM — unchanged)
            ┌───────────────────────────▼──────────────── UNCHANGED ───┐
            │ HostRcRelay.serve()  →  BrokerClient  →  broker router    │
            │                       ◀─ web viewer (apps/web)            │
            └──────────────────────────────────────────────────────────┘
```

---

## 2. The `Driver` interface

A driver is a thin object with one job: run two pumps against a `Session` until a signal aborts.
The relay (its own `serve()`) runs concurrently and owns all broker I/O; the driver owns all
*harness* I/O. They communicate only through the `Session`.

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

/** A driver declares which broker-side features it can faithfully service. */
export interface DriverCapabilities {
  /** Can surface + round-trip structured can_use_tool gates (else auto-approve/ignore). */
  structuredPermissions: boolean;
  /** Reports real workerStatus transitions (else presence is best-effort heuristic). */
  status: boolean;
  /** Honors control verbs interrupt/set_model/set_mode/end (else best-effort/ignored). */
  controlVerbs: boolean;
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
 * It wires HostRcRelay(session), calls relay.announce(...) then relay.serve(signal) (which owns all
 * broker I/O AND the durable-cursor prepare()), runs its pumps concurrently, and tears the harness +
 * relay down on exit.
 */
export interface Driver {
  readonly capabilities: DriverCapabilities;
  /** Run until `signal` aborts (or the harness exits). Resolves with the harness exit code. */
  run(signal: AbortSignal): Promise<number>;
}

/** Factory the dispatcher calls once per wrapper launch. */
export type DriverFactory = (ctx: DriverContext) => Driver;
```

### The MITM driver is a one-line adapter over the existing launch path

`runRcLaunch` (launch.ts) is exported and **directly unit-tested** (`launch.test.ts` constructs it
with `{ claudeArgs, identity, brokerUrl, certsDir, spawnClaude, … }` and asserts the child env, the
teardown, and a full broker round-trip). We therefore **do not rewrite its body**. The MITM driver
is a wrapper that maps `DriverContext` onto `RcLaunchOptions` and calls it:

```ts
// packages/cli/src/host/rc/drivers/mitm-driver.ts  (new, ~25 lines)
export function mitmDriver(ctx: DriverContext): Driver {
  return {
    capabilities: { structuredPermissions: true, status: true, controlVerbs: true, attachments: true },
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

This keeps `launch.test.ts` green by construction (its surface is unchanged) and makes the seam a
*pure addition*. A non-MITM driver implements `run()` directly, mirroring `runRcLaunch`'s
`onSession` lifecycle:

```ts
// shape every non-MITM driver follows (tmux shown):
const core = new RelayCore();
const session = core.create({ title: ctx.title });
session.pushInitialize();
ctx.onSession?.(session);

const relay = new HostRcRelay({
  client: ctx.newClient(),
  identityId: ctx.identity.identityId,
  sessionId: session.id,
  session,
  ...(ctx.tracer ? { tracer: ctx.tracer } : {}),
});
await relay.announce(ctx.title, ctx.cwd, ctx.git);
const relayDone = relay.serve(signal).catch(() => {});

// CAPTURE + INJECT + STATUS pumps run concurrently against `session` (see §4), then on exit:
//   ac.abort(); await relayDone; core.closeAll(); <harness teardown>
```

---

## 3. The canonical content-block contract (every driver MUST emit this)

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

  /** For "assistant" / "user": the message envelope holding the content blocks. */
  message?: {
    role?: "assistant" | "user" | string;
    content: ContentBlock[];
  };

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
- A `user` event's **text is deliberately dropped** by the relay (only `tool_result` blocks are
  relayed) — because the inbound pump already echoes every viewer prompt. A driver should still
  pushUpstream user/tool_result events as-is; do not try to "fix" this by re-adding the text.

---

## 4. Downstream injection (what the driver consumes)

The relay pushes client input **into** the session; the driver pulls it **out** and drives the
harness. The driver claims a worker-stream generation token and drains downstream — exactly the
discipline `mitm.ts#streamWorker` uses, so a reconnect supersedes cleanly:

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
      else if (sub === "end_session") endHarness();
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

---

## 5. Permissions and attachments are relay-owned — keep drivers transparent

- **Permissions.** The broker side (a `permission_request` content frame out, a `permission` frame
  in, the `permission_resolved` log frame, AskUserQuestion's `questions` echo, the `q.map` fix) is
  **entirely in the relay**. A driver participates only at the harness boundary: to *raise* a gate it
  `pushUpstream`s a `can_use_tool` control_request; to *apply* an answer it observes the
  `control_response` in `followDownstream`. A driver that can't surface structured gates declares
  `capabilities.structuredPermissions = false` and either auto-approves (tmux v1:
  `--dangerously-skip-permissions`) or runs single-user trusted.
- **Attachments.** `relay.#handleAttachment` decrypts the viewer's bytes, writes them under
  `attachmentsDir`, and **injects a normal `user` prompt** (`@"<path>" …` / a Read directive). The
  driver never sees an `attachment` frame — only the resulting downstream `user` event. So
  attachments "just work" for any driver that supports `user` injection; no driver code is needed.

This is the central invariant: **the relay handles the broker-facing protocol; the driver handles
the harness-facing protocol; they meet only at the `Session`.**

---

## 6. `--rc-driver` wiring

A new value flag selects the driver; default `mitm` preserves today's behavior exactly.

- **`args.ts`** — add `"rc-driver": "value"` to `RC_FLAGS`.
- **`run.ts`** — in `runRcLaunchPath`, read the driver name (`--rc-driver`, else `RC_DRIVER`, else
  `"mitm"`), validate it against `{mitm, tmux, opencode}`, build the `DriverContext`, and dispatch:
  - `mitm` (and any default) → today's path (`runRcLaunch`), **unchanged**.
  - `tmux` → `runTmuxDriver(ctx)`.
  - `opencode` → `runOpenCodeDriver(ctx)`.
  Each returns the same exit-code contract. The MITM path stays the literal call we have now, so the
  default route is byte-for-byte the current behavior.

Validation note: `mitm`/`opencode` use the MITM-or-network path that needs `--rc-app`; `tmux` is
provider-agnostic and needs no MITM, but still needs `--rc-app` for the broker. Keep the existing
"`--rc-…` needs `--rc-app`" guard; just add an "unknown `--rc-driver=<x>`" error (exit 2) listing the
valid names.

```
remote-claw --rc-app https://app.example --rc-driver=tmux -- --model opus
            └ broker origin ─────────────┘ └ driver ────┘    └ forwarded to claude ┘
```

---

## 7. File-by-file change list

### New
- `packages/cli/src/host/rc/driver.ts` — the `Driver` / `DriverContext` / `DriverCapabilities` /
  `UpstreamPayload` / `ContentBlock` types + `DriverName`. Pure contract, no runtime behavior.
- `packages/cli/src/host/rc/drivers/mitm-driver.ts` — `mitmDriver(ctx)`: a thin adapter mapping
  `DriverContext` → `RcLaunchOptions` → `runRcLaunch`. Declares full capabilities.
- `packages/cli/src/host/rc/tmux/{driver,tmuxctl,transcript,inject}.ts` + a `runTmuxDriver(ctx)`
  entry — Track B (the tmux track in `docs/future-directions.md`). Spawns plain `claude` in tmux
  (no MITM, no HTTPS_PROXY), tails the transcript JSONL → `pushUpstream`, injects via send-keys,
  debounced status.
- `packages/cli/src/host/rc/opencode/{driver,launch}.ts` — Track C stub (deferred).

### Modified
- `packages/cli/src/args.ts` — add `"rc-driver": "value"` to `RC_FLAGS`.
- `packages/cli/src/run.ts` — read/validate `--rc-driver`, build `DriverContext`, dispatch to the
  selected driver. The `mitm` branch calls the existing `runRcLaunch` unchanged.
- `packages/cli/src/host/rc/index.ts` — re-export the new `driver.ts` types (so external/test code
  and the drivers import from one place).

### Explicitly UNCHANGED (and why each is safe)
- `packages/cli/src/host/rc/session.ts` — **the seam itself.** Drivers only *use* its public methods
  (`create`, `pushInitialize`, `pushUpstream`, `claimWorkerStream`, `followDownstream`,
  `pushUserInput`/`pushControlResponse`/`pushControlRequest`, `workerStatus`, `wake`, `close`). No new
  capability is required.
- `packages/cli/src/host/rc/relay.ts` — consumes a `Session` and a `BrokerClient` only. Because every
  driver emits the **same** `UpstreamPayload` and the broker side is identical, `HostRcRelay` and
  `mapUpstreamItems` need no driver awareness. Its tests (`relay.test.ts`) feed a mock `Session`,
  which is exactly what a driver produces.
- `packages/cli/src/host/rc/launch.ts` — `runRcLaunch` keeps its exact signature; it *becomes* the
  MITM driver's `run()` body via the `mitmDriver` adapter. `launch.test.ts` (which calls
  `runRcLaunch` directly and asserts env-scrub/teardown/round-trip) stays green by construction.
- `packages/cli/src/host/rc/mitm.ts` — only the MITM driver uses it; other drivers don't import it.
- `packages/cli/src/host/rc/certs.ts`, `gitinfo.ts` — MITM/announce helpers, unaffected.
- `packages/cli/src/broker/client.ts` — the transport contract is fixed; drivers go *through* the
  relay, never around it.
- `apps/web/lib/broker/**` (router, backends: vercel/local/sqlite), and **all of the web
  viewer** — they consume sealed frames keyed by `(identity, session)`. Since the frame stream is a
  pure function of the canonical `UpstreamPayload` (which every driver matches), nothing downstream
  can tell which driver produced the session.
- `packages/cli/src/security/provider.ts`, `packages/cli/src/trace.ts` — orthogonal (sealing,
  diagnostics).

---

## 8. Risks and mitigations

1. **Canonical-shape drift.** A driver emitting a slightly-off block (`tool_use` without `name`, a
   `null` content entry, a renamed field) is *silently dropped* by `mapUpstreamItems`. Mitigation:
   the `UpstreamPayload`/`ContentBlock` types live in `driver.ts` and every driver constructs through
   them; contract tests tail a **real** claude 2.1.x transcript and assert the emitted frames match
   the MITM path's frames for the same conversation.
2. **`runRcLaunch` refactor regressing the MITM path.** Mitigation: do **not** rewrite
   `runRcLaunch`; wrap it. `launch.test.ts` is the guard and its surface is untouched.
3. **Injection ordering / send-keys races (tmux).** `followDownstream` is one stream of
   user + control verbs; a paste+Enter has a ~40ms settle, so a burst of verbs can race. Mitigation:
   per-driver serialization of the inject loop (process one downstream event fully before the next);
   map only `interrupt` (→ ESC) and `end` (→ kill) in v1, others best-effort.
4. **Permission fidelity on non-structured drivers.** tmux v1 auto-approves
   (`--dangerously-skip-permissions`), so no `can_use_tool` ever surfaces; a viewer "deny" can't be
   honored. Mitigation: declare `structuredPermissions: false`, document the single-user-trusted
   posture, defer mirroring (via `--permission-prompt-tool`) to a later phase.
5. **Status accuracy.** Without ground truth (the MITM reads claude's `PUT /worker` status), tmux
   infers `running`/`idle` from a transcript-append debounce, which lags a long "think". Mitigation:
   `capabilities.status = true` only where ground truth exists; document the heuristic; refine later
   with end-of-turn `result` frames or hooks.
6. **Durable-restart cursors.** The relay's `serve()` calls `prepare()` to sample broker cursors
   before pumping; a driver must call `relay.serve(signal)` (not hand-roll the pumps) so this
   fail-closed path is preserved on durable backends.
7. **One driver per launch.** The design is single-driver-per-wrapper-process (RelayCore is
   per-launch). Running two harnesses = two wrapper processes. Documented, not a goal.

---

## 9. Summary

The `Session` is the seam. A `Driver` is the only new abstraction: it produces a `Session`,
**captures** harness output into the canonical content-block envelope (`pushUpstream`), **injects**
the relay's downstream user/control events into the harness (`followDownstream`), reports **status**
(`workerStatus` + `wake`), and lets the relay own **permissions + attachments** end-to-end. With
`--rc-driver={mitm|tmux|opencode}` (default `mitm`), the relay, the broker router/backends, and the
web viewer remain **completely unchanged** — because they are already pure functions of
`(Session, BrokerClient)` and the canonical frame shape.