# The tmux driver (Track B) — drive a plain `claude` over the broker, no MITM

`remote-claw` bridges a coding agent to an E2E-encrypted broker so a phone or laptop can watch and
drive it. The **default** driver (`mitm`) runs the real `claude --remote-control` behind a local MITM
and intercepts claude's RC endpoints. Native Remote Control is disabled when Claude itself is
configured directly for Bedrock / Vertex / Foundry (the MITM path separately has a synthesized
`--rc-inference=bedrock` mode). The **tmux driver** runs a *plain* `claude` in a detached tmux pane and
adds no remote-claw proxy or CA; user-supplied proxy/CA variables are preserved. Claude therefore
talks to whichever provider it is configured for, while remote-claw bridges the session by **tailing
claude's local transcript JSONL** (capture) and **typing into the pane via `send-keys`** (inject).

> **Scope:** this document describes the shipped compatibility driver. In the selected
> [client-driven host runtime](client-driven-host-runtime.md), tmux remains a lower-fidelity control
> adapter but composes with the wrapped engine's private provider façade and network fence. A shared
> coordinator-ordered chat also makes the raw pane read-only; a directly writable/provider-connected
> pane is a separate compatibility/debug mode, not the release target.

**Identity scope.** The shipped driver mints a synthetic remote-claw `Session.id` (`cse_*`) for its
broker channel and separately controls a tmux pane plus a Claude transcript/session ID. None is an
implemented durable remote-claw logical-chat ID, and a wrapper restart does not currently preserve
their binding. A1 uses a persisted logical-chat ID for the broker row/channel only when pane,
child-process, and native transcript evidence prove reattachment to the same semantic conversation;
pane name or PID reuse is not enough.

The decisive fact (verified against real transcripts, claude 2.1.63–2.1.177): the
`message.content` blocks in `~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl` are **byte-identical**
to what the relay's `mapUpstreamItems` already destructures. So the tmux driver produces the canonical
`Session`, and **the relay, the broker router/backends, and the web viewer are completely unchanged.**

---

## 1. Where it plugs in — the `Session` seam

`HostRcRelay` (`relay.ts`) is a pure function of `(Session, BrokerClient)`: it never learns how the
agent runs. `relay.serve(signal)` runs two pumps — OUTBOUND (`session.followUpstream` → seal → POST)
and INBOUND (broker frames → `session.pushUserInput` / `pushControlResponse` / `pushControlRequest`).
The MITM harness path fills the `Session` from Claude's RC HTTP/SSE. The tmux driver fills the
**same** `Session` from a different source:

```
            ┌────────────────────── tmux DRIVER ───────────────────────┐
 plain      │ CAPTURE: tail <sessionId>.jsonl → transcriptToPayload()   │──▶ session.pushUpstream()
 `claude`   │ INJECT:  session.followDownstream() → set-buffer+paste+↵  │◀── session (downstream queue)
 in a tmux  │ STATUS:  append-debounce → session.workerStatus + wake()  │
 pane       │ PERMS:   PreToolUse hook → viewer gate (opt-out: skip)    │
            └──────────────────────────┬───────────────────────────────┘
                                        │  Session  (THE SEAM — unchanged)
            ┌───────────────────────────▼──────────────── UNCHANGED ───┐
            │ HostRcRelay.serve()  →  BrokerClient  →  broker router    │
            │                       ◀─ web viewer (apps/web)            │
            └──────────────────────────────────────────────────────────┘
```

The driver mirrors `launch.ts`'s `Session` registration and shared broker bridge, minus the MITM:

```ts
const core = new RelayCore();
const s = core.create({ title: ctx.title });
s.pushInitialize();              // guarantees `initialize` is the first downstream event
ctx.onSession?.(s);              // test parity with launch.ts
const relays = new Set<Promise<void>>();
const served = bridgeSession({
  session: s,
  capabilities: tmuxCapabilities(mirror),
  harness: TMUX_HARNESS,
  newClient: ctx.newClient,
  identityId: ctx.identity.identityId,
  title: ctx.title,
  cwd: ctx.cwd,
  git: ctx.git,
  signal: ac.signal,
  relays,
  tracer,
});
// … spawn tmux, run CAPTURE + INJECT + STATUS pumps against `s` …
// finally: ac.abort(); s.close(); await served; tmux.killSession();
```

`bridgeSession` starts the presence announcement and `relay.serve(...)` immediately; the
announcement is not a startup/readiness barrier. Its returned `served` promise nevertheless waits
for the admitted initial announcement to settle. The driver awaits that promise only within its
bounded teardown window, so an indefinitely stalled broker still cannot hang exit.

---

## 2. Mechanics

### 2.1 Spawn (no MITM, provider-agnostic)

```
tmux new-session -d -s rc-<sessionId> -x 200 -y 50 \
  -e <each non-scrubbed env var> \
  'env -u <scrubbed vars> claude --settings <merged PreToolUse hook> --session-id <uuid> <forwarded claudeArgs…>'
```

- **Permissions are MIRRORED by default (B2).** The spawn does NOT pass
  `--dangerously-skip-permissions`; instead it merges a blocking **PreToolUse hook** into `--settings`
  so every tool waits for a viewer allow/deny (§2.5). The opt-out `--rc-tmux-skip-permissions`
  (or `RC_TMUX_SKIP_PERMISSIONS` truthy) drops the hook and restores
  `claude --dangerously-skip-permissions` (hands-off auto-approve).
- **No remote-claw `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` injection.** The driver preserves proxy/CA
  variables the user already supplied, but removes stale values inherited only from a pre-existing
  tmux server. Claude reaches its configured provider directly, so Bedrock/Vertex work.
- **Same env scrub as `launch.ts`/`trace-run.ts`** (the stub gotcha): strip `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_SESSION_ID`, `REMOTE_CLAW_SECRET_FILE`, `VERCEL_AUTOMATION_BYPASS_SECRET` from the
  child env (always, via `env -u`, so a stale tmux-server value can't leak). If
  `CLAUDE_CODE_CHILD_SESSION` leaks in, the spawned claude is a *stub* bridged to the launcher and never
  starts a real session — and here there's no MITM to even notice. `CLAUDE_CONFIG_DIR` is also kept
  coherent (passed through when the wrapper sets it, else `env -u`'d) so the pane reads the **same**
  `.claude.json` the driver pre-seeds folder-trust into (§2.5).
- Print `tmux attach -t rc-<sessionId>` so the local user can share the live pane.
- `tmuxctl.ts` invokes the tmux control binary with `execFile("tmux", argv)` (the `gitinfo.ts`
  pattern). Prompt text remains an argv element to `set-buffer`, so it is inert data. The pane's
  startup command is one shell-parsed tmux argument built with `shellQuoteCommand`.

### 2.2 Capture — tail the transcript JSONL → `pushUpstream`

Claude writes a full transcript under
`~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`, where the ordinary slug is **cwd with every `/`
and `.` replaced by `-`**. The file is created lazily on the first turn. By default the injected
SessionStart hook reports the exact transcript path and follows rotations. A fresh driver-owned
session is also pinned with a v4 UUID and can be found by exact ID; only a user-owned picker session
whose ID is unknown falls back to `findNewestTranscript` after the hook grace period (§7.1).

`TranscriptTailer.poll()` is an append-only **byte-offset reader**: it opens and stats the same file
handle, reads to EOF, splits on newline bytes, buffers a trailing partial line and split multibyte
sequence across reads, and resets to offset 0 if the file shrinks or its inode identity changes.
The capture loop calls it on the explicit `pollMs` cadence (default 120 ms); there is no `fs.watch`
path.

Each complete line goes through the **one reshape**, `transcriptToPayload(line)`:

```ts
const o = JSON.parse(line);
if (o.type !== "assistant" && o.type !== "user" && o.type !== "system") return null; // drop the rest
const payload = { type: o.type };
if (o.message) payload.message = o.message;          // content blocks pass through UNCHANGED
if (o.uuid) payload.uuid = o.uuid;                   // stable id → stable dedup/order across reconnects
if (o.parentToolUseID) payload.parent_tool_use_id = o.parentToolUseID; // the ONLY rename
// system lifecycle fields pass through for task_* surfacing:
for (const k of ["subtype","task_id","description","tool_use_id"]) if (k in o) payload[k] = o[k];
return payload;
```

Then `s.pushUpstream(payload)` — and the relay's outbound pump does the rest, unchanged.
`mapUpstreamItems` already understands every block: `text`, `thinking`, `tool_use {id,name,input}`,
`tool_result {tool_use_id,content,is_error}`.

> **Why drop everything but assistant/user/system?** Real transcripts carry many bookkeeping types
> (`progress`, `pr-link`, `bridge-session`, `ai-title`, `mode`, `permission-mode`, `attachment`,
> `file-history-snapshot`, `queue-operation`, `agent-name`). The relay renders none of them, so the
> driver drops them at the source rather than handing the relay frames it would silently discard.

> **Sub-agents (Agent/Task) — captured + NESTED (grounded, live-verified on claude 2.1.177).** A
> sub-agent's transcript is written to a SEPARATE file `<dir>/<id>/subagents/agent-<agentId>.jsonl` (+ a
> `.meta.json` sidecar), NOT the main transcript. The driver **tails those files**; each line reshapes
> through the same `transcriptToPayload`, and the driver overlays `parent_tool_use_id` = the spawning
> Agent's `tool_use_id` (read from the sidecar's `toolUseId` via `readAgentTaskId`). The relay tags those
> `*_sub` and the viewer indents them under the Agent — exactly how native Remote Control relays
> sub-agent frames, so sub-agent work does NOT flood the main transcript. A file is tailed only once its
> `.meta.json` link is readable, so every surfaced sub-agent line is guaranteed to nest (never flat).
> Because the main transcript and each sub-agent file are SEPARATE append streams, a drain that picks up
> both at once (the backfill/attach read of a whole history, or a sub-agent that finishes inside one
> poll) **interleaves them by each line's `timestamp`** (`mergeBatchByTimestamp`) before emitting — else
> the parent Agent's completion (in the main file) would be sequenced before the sub-agent output it
> nests, and the viewer (which renders by sequence) would show the sub-agent work *after* the parent's
> answer. Steady-state (sub output trickles in across polls while the parent blocks on the Task) never
> co-batches a completion with its sub lines, so it stays on the zero-overhead fast path.
> The sidecar `toolUseId` matches the Agent tool_use in the main transcript (verified live). NOTE a
> version difference: claude 2.1.63 instead streamed sub-agent messages as `agent_progress` `progress`
> lines in the MAIN transcript; 2.1.177 (current) uses the separate `subagents/` files + `.meta.json`,
> which is what the driver targets. The plain `parentToolUseID` on a top-level assistant/user line is
> still renamed defensively.

### 2.3 Inject — downstream `user`/verbs → the pane

Drain the relay's downstream queue (claim the worker-stream generation so the newest claimer wins),
**serialized strictly** so a burst can't race the paste:

```ts
const gen = s.claimWorkerStream();
for await (const ev of s.followDownstream(gen, () => signal.aborted)) {
  if (ev === null) continue;                     // heartbeat tick
  if (ev.eventType === "user") {
    const text = ev.payload.message.content;      // pushUserInput sets content: STRING
    const pasted = await retryUntil(
      () => loadAndPaste(tmux, pane, text, buffer), // set-buffer + bracketed paste as one retry phase
      signal,
      sleep,
      reportPasteFailure,
    );
    if (!pasted) continue;
    const submitted = await retryUntil(
      () => submitPrompt(tmux, pane, text, sleep),  // length-scaled settle + Enter; never re-pastes
      signal,
      sleep,
      reportSubmitFailure,
    );
    if (submitted) {
      s.ack(ev.eventId);
      recordInjected(text);                         // suppress this prompt's transcript echo
    }
  } else if (ev.eventType === "control_request") {
    // interrupt retries Escape; set_model uses the same two-phase path for `/model <id>`.
    // initialize, set_permission_mode, and a directly queued end have no pane action but are ACKed.
  } else if (ev.eventType === "control_response") {
    // With permission mirroring on, persist the hook decision, then ACK.
  }
}
```

`set-buffer` + **bracketed** `paste-buffer` (`-p`) handles multiline / backticks / special chars
without a premature submit; the **separate** `send-keys Enter` is what actually submits.
`settleMs(text)` scales from a 40 ms base with prompt length and caps at 1 s. The paste phase and
submit phase retry independently until success or abort, so an Enter failure never double-pastes.
Prompt/key events are ACKed only after their tmux action succeeds; unsupported/no-op controls are
ACKed immediately. A permission response is ACKed after its decision callback returns. The current
callback logs and swallows a decision-file write failure, so that path is not a durable delivery
receipt even though it prevents a reclaimed stream from replaying the response.

An authenticated viewer `end` does not enqueue `end_session`, kill the pane, or close this bridge.
`HostRcRelay` consumes it locally and only clears open relay permission gates; the pane remains under
the driver's normal local/host teardown policy.

### 2.4 Status — a quiet-timer debounce

There are no native `result` lines in interactive mode, so presence is inferred from transcript
activity:

- A new transcript line ⇒ `s.workerStatus = "running"` + `s.wake()`.
- ~1s after the last append, if no `tool_use` is open ⇒ `s.workerStatus = "idle"` + `s.wake()`.
- An orphaned open tool is cleared by a new top-level user turn or a 120 s hard-idle fallback.

`phaseFor` (relay.ts) maps `running → thinking`, everything else → `idle`, so these are exactly the
values the announce presence already understands — the viewer's thinking/idle indicator just works.
This is a heuristic, not ground-truth turn state. Current code nevertheless announces `status:true`,
which overstates the interface's “real transitions” meaning; the host-runtime capability pass must
advertise heuristic status separately or set it false.

Separately, a top-level assistant line with a terminal `stop_reason` makes the driver emit one
synthetic empty `result` frame after the assistant content, giving the viewer a turn separator.

### 2.5 Permissions — mirrored to the viewer (B2, DEFAULT ON)

Plain claude surfaces permission prompts as **TUI text**, not structured `can_use_tool` events. Rather
than skip them, the driver injects a blocking **PreToolUse hook** (a tiny Node helper, written to disk
and merged into `--settings` alongside any user settings + the SessionStart hook). On each tool the
helper appends the request to a per-session requests sentinel (`permReqPath`, NDJSON) and **blocks**,
polling a decisions dir (`permDecDir/<toolUseId>.json`). The driver's **perm pump** tails the sentinel,
raises a `can_use_tool` gate through the relay's **existing** `permission_request` ⇄ `permission`
round-trip (no relay change), and on the viewer's answer writes the decision file the helper is waiting
on. The decision is **fail-closed**: anything but an explicit `allow` is treated as deny. With mirroring
on, `capabilities.structuredPermissions = true`.

One current setup edge breaks that claim: the relay announces before the combined settings are parsed.
If the user's `--settings` cannot be parsed/merged, the driver disables the hook and falls back to
`--dangerously-skip-permissions`, but the already-published capability remains true. The
host-runtime registration phase must publish/update the actual post-setup value before remote
controls are enabled.

**AskUserQuestion answers (#42).** A `can_use_tool` gate whose `tool_name` is `AskUserQuestion` is
answered with *choices*, not a bare allow/deny: the relay echoes the stashed `questions` and builds
`control_response.updatedInput = {questions, answers}`. The perm pump records which open gates are
AskUserQuestion (so a crafted `answers` payload can never replace a *Bash* gate's input — both the driver
and the helper gate `updatedInput` to `tool_name === "AskUserQuestion"`, and only on an `allow`), and on
the answer writes that `updatedInput` into the decision file. The helper re-emits it as the PreToolUse
hook's `hookSpecificOutput.updatedInput`, which **replaces** the tool input — so claude proceeds with the
viewer's answers instead of drawing its in-pane picker, matching the MITM driver.

**Folder trust (mirror on).** Dropping `--dangerously-skip-permissions` also drops the flag's bypass of
claude's startup *"Do you trust the files in this folder?"* gate — which the PreToolUse hook does NOT
cover (it's a startup gate, not a tool) and no one is at the detached pane to answer → a hung pane on a
fresh cwd. So before spawn the driver pre-seeds `projects["<abs realpath cwd>"].hasTrustDialogAccepted
= true` in `<CLAUDE_CONFIG_DIR or ~>/.claude.json` (`ensureCwdTrusted`, exactly what claude records on
"trust"): idempotent, preserving (deep-merge), fail-safe (bails rather than clobber an
unreadable/malformed config), atomic. The pane's `CLAUDE_CONFIG_DIR` is kept coherent with the writer
(§2.1) so both read the same file. Skipped when the user forwarded their own
`--dangerously-skip-permissions` (no gate to seed).

**Opt-out.** `--rc-tmux-skip-permissions` (or `RC_TMUX_SKIP_PERMISSIONS` truthy) drops the hook and
restores `claude --dangerously-skip-permissions` — hands-off auto-approve, which also bypasses the trust
gate (so no seeding is needed) — and declares `capabilities.structuredPermissions = false`. This is the
old v1 trusted single-user posture, now opt-in.

### 2.6 Attachments — viewer→pane is free; local-paste is NOT captured

The **viewer→pane** direction is relay-owned and works for free:
`relay.#handleAttachmentPayload` decrypts the viewer's bytes, writes each valid image, and injects a
normal `user` prompt containing `@"<path>"` references. The driver never sees an `attachment` frame —
only the resulting downstream `user` event — so Claude in tmux handles it without tmux-specific
attachment code; `capabilities.attachments = true`.

**Caveat (the other direction — confirmed against real transcripts):** an image the human pastes
**locally** into the tmux pane is written as a top-level `type:"attachment"` line whose content is an
`{type:"image"}` block, and `transcriptToPayload` keeps only `assistant`/`user`/`system` — so a
locally-pasted image is **silently dropped** from the remote view. `capabilities.attachments = true`
covers the inbound (viewer) path, not the local-paste outbound path. Surfacing local attachments
(write the bytes locally + relay a marker) is follow-up work, tracked in §7.

---

## 3. Files

### New
- `packages/cli/src/host/rc/tmux/tmuxctl.ts` — `TmuxCtl` over `execFile("tmux", …)` with an injectable
  `TmuxExec`: `version`, `newSession`, `hasSession`, `sessionGone`, `setBuffer`, `pasteBuffer`,
  `sendKeys`, `killSession`. No new dependency.
- `packages/cli/src/host/rc/tmux/transcript.ts` — `projectSlug` / `projectDir` /
  `findTranscriptById` / `findNewestTranscript` / `TranscriptTailer` (polling byte-offset reader,
  partial-byte/line buffering, truncation and inode-rotation reset) / `transcriptToPayload` (the one
  reshape) / local-prompt and sub-agent helpers.
- `packages/cli/src/host/rc/tmux/inject.ts` — `runInjectPump` (serialized drain of
  `followDownstream`, phase-aware retries, post-success ACK), `injectUserText` (set-buffer → paste →
  length-scaled settle → Enter), `downstreamUserText`, interrupt→Escape and set-model mappings.
- `packages/cli/src/host/rc/tmux/status.ts` — `StatusTracker` (append-debounce, open-tool suppression,
  injectable clock/timer).
- `packages/cli/src/host/rc/tmux/driver.ts` — `runTmuxDriver(ctx)` / `tmuxDriver(ctx)`: the lifecycle
  + the pumps (capture / inject / status / **perm**) + teardown.
  `capabilities = tmuxCapabilities(mirror)` = `{ structuredPermissions: mirror, status:true,
  controls:{ interrupt:true, setModel:true, setMode:false, end:false }, attachments:true }` — `mirror`
  defaults true, so structured permissions are on unless `--rc-tmux-skip-permissions`. interrupt (ESC)
  and set_model (`/model <id>` inject) are honored; set_mode/end have no pane analogue, so the viewer
  disables those controls (#149).
- `packages/cli/src/host/rc/tmux/permhook.ts` — the injected PreToolUse helper source
  (`PRE_TOOL_USE_HELPER_SOURCE`) + the request/decision plumbing for permission mirroring (§2.5).
- `packages/cli/src/host/rc/tmux/trust.ts` — `ensureCwdTrusted` (pre-seed claude's per-folder trust bit;
  idempotent / preserving / fail-safe / atomic), so a mirror-on pane doesn't hang on the startup trust
  gate (§2.5).
- `packages/cli/src/host/rc/driver.ts` — the shared contract (`Driver`, `DriverContext`,
  `DriverCapabilities`, `DriverName`, `DriverFactory`, `UpstreamPayload`, `ContentBlock`). Pure types.

### Modified
- `packages/cli/src/args.ts` — add `"rc-driver": "value"` to `RC_FLAGS`.
- `packages/cli/src/run.ts` — allow `--rc-driver` past the stray-flag guard; the top-level RC branch
  reads/validates `--rc-driver` → `RC_DRIVER` → `"mitm"` and dispatches directly to
  `runRcLaunchPath`, `runTmuxDriverPath`, or `runOpencodeDriverPath`. The tmux path builds its
  `DriverContext`; **the `mitm` branch still calls the existing `runRcLaunch` path.**
- `packages/cli/src/host/rc/index.ts` — re-export the contract types + `runTmuxDriver` (and the
  transcript helpers for tests).

### Explicitly UNCHANGED (and why each is safe)
- `host/rc/session.ts` — the seam. The driver only *uses* its public methods.
- `host/rc/relay.ts` — pure function of `(Session, BrokerClient)`; every driver emits the same
  `UpstreamPayload`, so `mapUpstreamItems` needs no driver awareness. `relay.test.ts` feeds a mock
  Session — exactly what the driver produces.
- `host/rc/launch.ts` — `runRcLaunch` keeps its exact signature and remains the standalone MITM
  harness path. `launch.test.ts` is green by construction.
- `host/rc/mitm.ts`, `certs.ts` — MITM-only; the tmux driver never imports them.
- `broker/client.ts`, and all of `apps/web` (router + vercel/local/sqlite backends + the web
  viewer) — they consume sealed frames keyed by `(identity, session)`; the frame stream is a pure
  function of the canonical `UpstreamPayload`, so nothing downstream can tell which driver produced
  the session.

---

## 4. `--rc-driver` wiring

```
remote-claw --rc-app https://app.example --rc-driver=tmux -- --model opus
            └ broker origin ─────────────┘ └ driver ────┘    └ forwarded to claude ┘
```

- `args.ts`: `"rc-driver": "value"` (so `--rc-driver=tmux` and `--rc-driver tmux` both parse).
- `run.ts`: the top-level RC branch resolves
  `(rc["rc-driver"] || RC_DRIVER || "mitm").toLowerCase()` and validates
  `{mitm, tmux, opencode}` (unknown ⇒ warn with the expected values, exit 2). `mitm` calls
  `runRcLaunchPath`; `tmux` calls `runTmuxDriverPath`, which resolves identity/backend/client/git,
  builds a `DriverContext`, and calls `runTmuxDriver(ctx, signal)`.
- Keep the existing "`--rc-*` needs `--rc-app` (or RC_APP)" guard — every driver needs the broker.
  tmux just needs no MITM/certs, so the `DriverContext` carries no `certsDir`.

---

## 5. Tests

All side effects (tmux, fs, clock, timers, broker) are injected, so the unit suite runs with **no
real tmux and no real claude** — the same discipline as `relay.test.ts` (mock Session) and
`gitinfo.test.ts` (canned output).

- `transcript.test.ts` — `projectSlug` (`/` and `.` → `-`); `transcriptToPayload` happy/tool_use/
  tool_result against **real captured lines**, then assert `mapUpstreamItems` yields the right items
  (the load-bearing byte-compat test); drop-types → null; `parentToolUseID` rename; bad input → null;
  `TranscriptTailer.poll()` append/partial/truncation/same-name-inode rotation; pinned-ID and
  fresh-inode discovery; timestamp merge; local-prompt extraction.
- `inject.test.ts` — `injectUserText` preserves set-buffer → paste → length-scaled settle → Enter;
  `runInjectPump` tests prompt/interrupt/set-model/permission handling, post-success ACKs,
  paste-versus-Enter retry phases, no silent retry give-up, and `settleMs` scaling/cap.
- `status.test.ts` — running on append; idle after debounce; open `tool_use` suppresses idle;
  re-arm = one transition; `phaseFor("running")==="thinking"`.
- `tmuxctl.test.ts` — argv shapes for every command via an injected `TmuxExec`; `hasSession` code→bool;
  argv-safety of `set-buffer -- <text>`; `killSession` swallows "no session".
- `driver.test.ts` — MockBroker-backed wiring (like `launch.test.ts`): `onSession` fires a fresh
  `cse_`, announce posts, an appended assistant line round-trips a sealed `assistant` frame to a
  viewer, a viewer `user` frame drives the fake `TmuxCtl` (paste+Enter), the child env is scrubbed and
  preserves user proxy/CA variables while scrubbing inherited session/host secrets, local prompts are
  surfaced without double-echoing injected prompts, and abort runs `killSession`.
- `args.test.ts` / `run.test.ts` — flag parsing, unknown-driver exit 2, `mitm` dispatches the existing
  path, `tmux` without `--rc-app` still warns and runs plain claude.

Per-PR gate: `pnpm exec biome check . && pnpm exec tsc --noEmit && pnpm exec vitest run`, then
`/code-review` + codex, then CI green.

---

## 6. Manual verification (real claude 2.1.x, trusted box)

Prereqs: `tmux -V`; logged-in `claude` (2.1.x); a reachable `--rc-app`; if the broker is behind
Vercel SSO, export `VERCEL_AUTOMATION_BYPASS_SECRET` (host injects it, scrubbed from the child).
Belt-and-suspenders: `unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID`.

1. `RC_LOG=debug RC_LOG_FILE=/tmp/tmux-driver.log node packages/cli/dist/bin.js --rc-app "$RC_APP"
   --rc-driver=tmux -- --model sonnet` → prints `tmux attach -t rc-cse_<hex>` and stays up. (No pty
   needed: the TUI is inside tmux.)
2. Verify real, non-stub, no-MITM: `tmux attach -t rc-cse_<hex>` shows the live TUI; a fresh
   `~/.claude/projects/<slug>/*.jsonl` exists after the first turn. With proxy/CA variables unset in
   the launch shell, none appears in the child; an intentionally supplied user proxy/CA is preserved.
3. From a viewer keyed to this identity:
   - "Reply with the single word PINEAPPLE." → pane pastes+submits, viewer shows the assistant frame.
   - "Run `ls`…" → viewer shows a `can_use_tool` gate; allow it → tool_use + tool_result
     (with `--rc-tmux-skip-permissions`, it's auto-approved with no gate).
   - Presence flips thinking → idle ~1s after the turn.
   - Long turn + viewer interrupt → pane gets Escape and stops.
   - Multiline/backtick prompt pastes intact, no premature submit.
4. Send an image from the viewer → relay writes it and injects an `@"<path>"` prompt; the pane shows
   Claude attaching it (no tmux-specific attachment code).
5. Ctrl-C the wrapper → relay flushes, `tmux has-session -t rc-cse_<hex>` is non-zero (killed).

Negatives: `--rc-driver=bogus` ⇒ exit 2 + valid list; `--rc-driver=tmux` without `--rc-app` ⇒ warns,
runs plain claude; `tmux` absent ⇒ clear "could not start remote control: tmux not found" (exit 1).

---

## 7. Risks (summary)

1. **Sub-agents (Agent/Task) — captured + nested** by tailing the `subagents/agent-*.jsonl` files and
   reading each `.meta.json` for the spawning Agent's `tool_use_id` (§2.2): sub-agent output is relayed
   `parent_tool_use_id`-tagged so the viewer indents it under the Agent, matching native RC (no longer
   dropped, and not flooding the main transcript). Live-verified on claude 2.1.177. Residual: a sub-agent
   whose `.meta.json` never becomes readable would not be surfaced (none observed).
   - **Locally-pasted images are dropped** (§2.6): a `type:"attachment"` line carrying an `image` block
     is not relayed. Follow-up: surface local attachments via a written-file marker.
2. **Silent shape drift** — `mapUpstreamItems` drops off-shape frames; guarded by real-line contract
   tests.
3. **Status is heuristic** (append timing, not claude's `worker_status`); debounced. An orphaned
   `tool_use` (interrupt / crash / sub-agent nesting) is recovered by clearing open tools on a new-turn
   boundary **and** a hard idle fallback, so the viewer can't hang on "thinking" forever.
4. **Permissions are mirrored by default** (B2, §2.5): an injected PreToolUse hook raises a
   `can_use_tool` gate per tool (`structuredPermissions:true`), fail-closed, with claude's folder-trust
   bit pre-seeded so the pane doesn't hang. `--rc-tmux-skip-permissions` restores the old auto-approve
   (`--dangerously-skip-permissions`, `structuredPermissions:false`, single-user-trusted).
5. **send-keys timing** — strictly serialized inject; the paste phase (set-buffer+paste-buffer) and the
   submit (Enter) retry **separately** so a transient post-paste failure never double-pastes; retries
   until the prompt lands or the pane dies. `interrupt` (→ ESC) and `set_model` (→ `/model <id>` inject)
   are mapped; `set_mode`/`end` have no faithful pane analogue, so the viewer disables those controls (#149).
6. **Transcript discovery/rotation** — discovery excludes pre-spawn inodes and gates on creation time;
   the tailer keys on `dev:ino:birthtime` (rotation-safe even under inode reuse) and opens-then-fstats
   (no stat/open race). Two residual limits remain (see below).
7. **Recovery is transcript-backed, but the binding is not durable.** Capture reads the selected
   native transcript from offset zero, so an attach can project the available Claude JSONL history
   into a fresh synthetic `cse_*` relay channel. A wrapper restart still has no durable
   remote-claw-logical-chat ↔ pane/process/transcript binding, and broker-side history remains subject
   to the configured backend's durability. `/clear` or an unproven replacement must not reuse a future
   logical-chat ID; `/branch` requires distinct fork lineage, while `/compact` preserves identity only
   when native evidence proves it.
8. **tmux dependency** — clear error if absent; unit tests need no tmux.
9. **One driver per wrapper process** (RelayCore is per-launch); pane-liveness ends the bridge when
   claude exits / the pane closes.

### 7.1 Session-id pin (deterministic first attach) + hook-based rotation

The driver mints a fresh **v4 UUID** and spawns `claude --session-id <uuid>` (NO `--resume`), so the
transcript path — `<uuid>.jsonl` — is known up front. Discovery looks up **our exact id**
(`findTranscriptById`, which scans across project dirs so it's robust even when claude hashes a very long
cwd into a suffixed dir name), and falls back to the newest-fresh heuristic only for a user-owned
picker (`--continue`/bare `--resume`) whose ID is unknown. This makes the **first attach deterministic**
and means a **concurrent sibling Claude in the same cwd can no longer be mis-attached** — we wait for
our id, never guess. (We still scrub the inherited `CLAUDE_CODE_SESSION_ID` so the parent's id can't
leak; we pass our own fresh one.)

Live-verified behaviour of `--session-id` (claude 2.1.x; full matrix in
`rc-traces/c-session-id-pin-findings.md`): a non-UUID/ULID is rejected ("must be a valid UUID"); reusing
an existing id without `--resume` **errors** ("already in use") — no silent resume, so a collision is
safe but pinned ids are single-use; `/compact` stays **in place**; **`/clear` and `/branch` ROTATE** to a
new `<uuid>.jsonl` (the old file goes quiet with no in-file marker), so the pin governs the FIRST session
only.

When the **user** drives the session (`--resume`/`--session-id`/`--continue`, long/short/`=value`), we
don't pin; if they gave an explicit id we still track THAT transcript by id (a `--resume <id>` *appends*
to `<id>.jsonl`, which the newest-file heuristic would miss), and only a picker (`--continue`/bare
`--resume`) falls back to newest-file. `findTranscriptById` checks the O(1) direct path every poll and
only does the cross-project scan on the slow cadence. It accepts a path only when `stat()` resolves it
to a regular file (so directories/FIFOs are excluded; a symlink to a regular file currently resolves).

### 7.1.1 SessionStart hook (`--rc-session-hook`) — exact discovery + rotation-follow

**On by default** (disable with `--rc-no-session-hook` or `RC_SESSION_HOOK=0`). The driver injects a
Claude Code **SessionStart hook** via an **inline `--settings`** (no file written to the user's project), MERGED with any
`--settings` the user already passed (their settings + other hooks preserved; our SessionStart hook
appended). The hook appends each payload — which carries the **exact, already-resolved `transcript_path`
+ `session_id` + `source`** — as one NDJSON line to a per-session sentinel file the driver tails.

Live-verified (claude 2.1.x): inline `--settings` ingests the hook and it FIRES (even under `-p`),
delivering the absolute transcript path. So with the hook on, discovery reads the sentinel — **exact, no
scan, no long-cwd-hash problem** — and when a later hook event reports a different transcript path
(for example `/clear` or `/branch`), the driver flushes the old file and switches the tailer. This is
an **unambiguous** rotation signal, unlike newest-in-cwd; `/compact` stays in the same transcript. If
the hook never fires (e.g. `--bare`
disables hooks — verified: the sentinel stays empty but the pinned `<uuid>.jsonl` is still written), the
driver **falls back** to the `--session-id` pin discovery above. Tracked in issue #101.

**Merging with the user's `--settings` (edge cases).** The merged `--settings` is inserted **before** any
`--` separator in the user's args (a token after `--` is a literal positional, which would silently drop
the hook and pollute the prompt). If the user's own `--settings` can't be parsed into an object (missing
file / invalid JSON / non-object), the driver **passes the user's args through unchanged and skips the
hook** (falling back to the pin) rather than masking claude's own settings error. Note: when the user
passes a `--settings` **file**, the merge inlines the resolved JSON into the spawned argv (visible to
`ps`); on a shared box with secrets in that file, prefer `--rc-no-session-hook`.

### 7.2 Local-prompt visibility (implemented)

The tmux driver uses the same **`local_prompt` ledger** as OpenCode. After a remote prompt is
successfully submitted, `runInjectPump` records its text; when capture later sees the matching
top-level transcript `user` line, it consumes the ledger entry and suppresses that duplicate because
the relay already echoed the remote prompt. An unmatched top-level, non-tool-result, nonblank user
line was typed locally, so the driver tags it `local_prompt:true` and the relay renders it in the web
transcript. Nested sub-agent user lines are never promoted to top-level local prompts. The correlation
is text-based, so a simultaneous identical local and remote prompt can still be misattributed for
display; it does not change what Claude executes.

---

## 8. Summary

The tmux driver is the **provider-agnostic** sibling of the MITM driver: same `Session` seam, same
canonical `UpstreamPayload`, same relay/broker/viewer — but it captures by **tailing claude's
transcript JSONL** and injects by **typing into a tmux pane**, so it works on Bedrock/Vertex where
native Remote Control is disabled. Because the transcript's content blocks are byte-identical to the
relay's input and the relay is a pure function of `(Session, BrokerClient)`, the driver is a **pure
addition** — nothing downstream changes.
