# The tmux driver (Track B) — drive a plain `claude` over the broker, no MITM

`remote-claw` bridges a coding agent to an E2E-encrypted broker so a phone or laptop can watch and
drive it. The **default** driver (`mitm`) runs the real `claude --remote-control` behind a local MITM
and intercepts claude's RC endpoints. That path is **Anthropic-API-only** — native Remote Control is
disabled under Bedrock / Vertex / Foundry. The **tmux driver** removes that limit: it runs a *plain*
`claude` in a detached tmux pane (no `HTTPS_PROXY`, no `NODE_EXTRA_CA_CERTS`), so claude talks to
whatever provider it is configured for, and we bridge the session by **tailing claude's local
transcript JSONL** (capture) and **typing into the pane via `send-keys`** (inject).

The decisive fact (verified against real transcripts, claude 2.1.63–2.1.177): the
`message.content` blocks in `~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl` are **byte-identical**
to what the relay's `mapUpstreamItems` already destructures. So the tmux driver produces the canonical
`Session`, and **the relay, the broker router/backends, and the web viewer are completely unchanged.**

---

## 1. Where it plugs in — the `Session` seam

`HostRcRelay` (`relay.ts`) is a pure function of `(Session, BrokerClient)`: it never learns how the
agent runs. `relay.serve(signal)` runs two pumps — OUTBOUND (`session.followUpstream` → seal → POST)
and INBOUND (broker frames → `session.pushUserInput` / `pushControlResponse` / `pushControlRequest`).
The MITM is just *one driver* that fills the `Session` from claude's RC HTTP/SSE. The tmux driver
fills the **same** `Session` from a different source:

```
            ┌──────────────── tmux DRIVER (new) ───────────────────────┐
 plain      │ CAPTURE: tail <sessionId>.jsonl → transcriptToPayload()   │──▶ session.pushUpstream()
 `claude`   │ INJECT:  session.followDownstream() → set-buffer+paste+↵  │◀── session (downstream queue)
 in a tmux  │ STATUS:  append-debounce → session.workerStatus + wake()  │
 pane       │ PERMS:   v1 auto-approve (--dangerously-skip-permissions) │
            └──────────────────────────┬───────────────────────────────┘
                                        │  Session  (THE SEAM — unchanged)
            ┌───────────────────────────▼──────────────── UNCHANGED ───┐
            │ HostRcRelay.serve()  →  BrokerClient  →  broker router    │
            │                       ◀─ web viewer (apps/web)            │
            └──────────────────────────────────────────────────────────┘
```

The driver mirrors `launch.ts`'s `onSession` lifecycle exactly, minus the MITM:

```ts
const core = new RelayCore();
const s = core.create({ title: ctx.title });
s.pushInitialize();              // guarantees `initialize` is the first downstream event
ctx.onSession?.(s);              // test parity with launch.ts
const relay = new HostRcRelay({
  client: ctx.newClient(), identityId: ctx.identity.identityId, sessionId: s.id, session: s,
});
void relay.announce(ctx.title, ctx.cwd, ctx.git).catch(() => {});
const served = relay.serve(ac.signal).catch(() => {});   // owns ALL broker I/O + prepare()
// … spawn tmux, run CAPTURE + INJECT + STATUS pumps against `s` …
// finally: ac.abort(); core.closeAll(); await served; tmux.killSession();
```

---

## 2. Mechanics

### 2.1 Spawn (no MITM, provider-agnostic)

```
tmux new-session -d -s rc-<sessionId> -x 200 -y 50 \
  -e <each non-scrubbed env var> \
  'claude --dangerously-skip-permissions <forwarded claudeArgs…>'
```

- **No `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS`** — the whole point. claude reaches its own provider
  directly, so Bedrock/Vertex work.
- **Same env scrub as `launch.ts`/`trace-run.ts`** (the stub gotcha): strip `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_SESSION_ID`, `REMOTE_CLAW_SECRET_FILE`, `VERCEL_AUTOMATION_BYPASS_SECRET` from the
  child env. If `CLAUDE_CODE_CHILD_SESSION` leaks in, the spawned claude is a *stub* bridged to the
  launcher and never starts a real session — and here there's no MITM to even notice.
- Print `tmux attach -t rc-<sessionId>` so the local user can share the live pane.
- `tmuxctl.ts` shells out with `execFile("tmux", argv)` (the `gitinfo.ts` pattern) — **no shell, argv
  array, no injection surface, no new dependency.**

### 2.2 Capture — tail the transcript JSONL → `pushUpstream`

claude writes a full transcript to `~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`, where the
slug is **cwd with every `/` and `.` replaced by `-`** (verified against the real projects dir, e.g.
`/home/ubuntu/remote-claw` → `-home-ubuntu-remote-claw`). The file is created lazily on the first
turn; `findNewestTranscript(dir, spawnedAt)` polls for the newest `*.jsonl` whose mtime is at/after
spawn.

`tailTranscript` is an append-only **byte-offset reader**: track the read offset, `read()` to EOF on
each tick, split on `\n`, **buffer the trailing partial line** across reads, emit each complete line,
and reset to offset 0 if the file shrinks (truncation/rotation). `fs.watch` drives it with a `pollMs`
fallback (default 120ms).

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

> **Sub-agent nesting caveat (grounded).** In the *local transcript*, `parentToolUseID` rides
> `progress` lines (dropped), **not** assistant/user lines — sub-agent output is marked with
> `isSidechain`/`parentUuid` instead. So the `parentToolUseID → parent_tool_use_id` rename is a
> *defensive* pass-through that rarely fires today: in v1, Task sub-agent output relays **flat**
> (un-nested), which is correct but not nested under the Task. Resolving `isSidechain` → the spawning
> Task's `tool_use_id` is deferred to B2.

### 2.3 Inject — downstream `user`/verbs → the pane

Drain the relay's downstream queue (claim the worker-stream generation so the newest claimer wins),
**serialized strictly** so a burst can't race the paste:

```ts
const gen = s.claimWorkerStream();
for await (const ev of s.followDownstream(gen, () => signal.aborted)) {
  if (ev === null) continue;                     // heartbeat tick
  if (ev.eventType === "user") {
    const text = ev.payload.message.content;      // pushUserInput sets content: STRING
    await tmux.setBuffer(text);                   // tmux set-buffer -b rcin -- <text>  (argv-safe)
    await tmux.pasteBuffer();                     // tmux paste-buffer -d -p -b rcin -t <pane>  (bracketed)
    await sleep(40);                              // settle, so Enter isn't swallowed by the paste
    await tmux.sendEnter();                       // tmux send-keys -t <pane> Enter   (what submits)
  } else if (ev.eventType === "control_request") {
    if (ev.payload.request.subtype === "interrupt") await tmux.sendKeys("Escape");
    // set_model / set_permission_mode / end_session: best-effort / ignored in v1 (no faithful TUI analogue)
  }
  // control_response / initialize: ignored (auto-approve raises no gate; initialize has no pane analogue)
}
```

`set-buffer` + **bracketed** `paste-buffer` (`-p`) handles multiline / backticks / special chars
without a premature submit; the **separate** `send-keys Enter` is what actually submits. (This was
validated against real claude in the design sessions.)

### 2.4 Status — a quiet-timer debounce

There are no `result` lines in interactive mode, so presence is inferred from transcript activity:
- A new transcript line ⇒ `s.workerStatus = "running"` + `s.wake()`.
- ~1s after the last append, if no `tool_use` is open and the last block was text (turn finished) ⇒
  `s.workerStatus = "idle"` + `s.wake()`.

`phaseFor` (relay.ts) maps `running → thinking`, everything else → `idle`, so these are exactly the
values the announce presence already understands — the viewer's thinking/idle indicator just works.

### 2.5 Permissions — v1 auto-approve

Plain claude surfaces permission prompts as **TUI text**, not structured `can_use_tool` events, so
there is no remote way to answer them. v1 runs `--dangerously-skip-permissions` and declares
`capabilities.structuredPermissions = false`. This matches the trusted single-user remote-box posture
(the owner already runs claude this way). Permission *mirroring* (B2) will add
`--permission-prompt-tool <mcp>` and route the call through the relay's **existing**
`permission_request` ⇄ `permission` round-trip — no relay change.

### 2.6 Attachments — free

Attachments are **relay-owned**: `relay.#handleAttachment` decrypts the viewer's bytes, writes the
file, and injects a normal `user` prompt with a `Read` directive. The driver never sees an
`attachment` frame — only the resulting downstream `user` event — so attachments work for any driver
that supports `user` injection. No tmux code needed; `capabilities.attachments = true`.

---

## 3. Files

### New
- `packages/cli/src/host/rc/tmux/tmuxctl.ts` — `TmuxCtl` over `execFile("tmux", …)` with an injectable
  `TmuxExec`: `newSession`, `hasSession`, `setBuffer`, `pasteBuffer`, `sendEnter`, `sendKeys`,
  `killSession`. No new dependency.
- `packages/cli/src/host/rc/tmux/transcript.ts` — `projectSlug` / `projectDir` /
  `findNewestTranscript` / `tailTranscript` (byte-offset, partial-line buffering, truncation reset) /
  `transcriptToPayload` (the one reshape).
- `packages/cli/src/host/rc/tmux/inject.ts` — `runInjectPump` (serialized drain of
  `followDownstream`), `injectUserText` (set-buffer → paste → settle → Enter), `downstreamUserText`,
  interrupt→Escape mapping.
- `packages/cli/src/host/rc/tmux/status.ts` — `StatusTracker` (append-debounce, open-tool suppression,
  injectable clock/timer).
- `packages/cli/src/host/rc/tmux/driver.ts` — `runTmuxDriver(ctx)` / `tmuxDriver(ctx)`: the lifecycle
  + three pumps + teardown. `capabilities = { structuredPermissions:false, status:true,
  controlVerbs:false, attachments:true }`.
- `packages/cli/src/host/rc/driver.ts` — the shared contract (`Driver`, `DriverContext`,
  `DriverCapabilities`, `DriverName`, `DriverFactory`, `UpstreamPayload`, `ContentBlock`). Pure types.

### Modified
- `packages/cli/src/args.ts` — add `"rc-driver": "value"` to `RC_FLAGS`.
- `packages/cli/src/run.ts` — allow `--rc-driver` past the stray-flag guard; in `runRcLaunchPath`
  read/validate the driver (`--rc-driver` → `RC_DRIVER` → `"mitm"`), build a `DriverContext`, dispatch.
  **The `mitm` branch is the existing `runRcLaunch` call, unchanged.**
- `packages/cli/src/host/rc/index.ts` — re-export the contract types + `runTmuxDriver` (and the
  transcript helpers for tests).

### Explicitly UNCHANGED (and why each is safe)
- `host/rc/session.ts` — the seam. The driver only *uses* its public methods.
- `host/rc/relay.ts` — pure function of `(Session, BrokerClient)`; every driver emits the same
  `UpstreamPayload`, so `mapUpstreamItems` needs no driver awareness. `relay.test.ts` feeds a mock
  Session — exactly what the driver produces.
- `host/rc/launch.ts` — `runRcLaunch` keeps its exact signature; it IS the mitm driver. `launch.test.ts`
  is green by construction.
- `host/rc/mitm.ts`, `certs.ts` — MITM-only; the tmux driver never imports them.
- `broker/client.ts`, and all of `apps/web` (router + vercel/temporal/local/sqlite backends + the web
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
- `run.ts`: in `runRcLaunchPath`, `const driver = (rc["rc-driver"] || process.env.RC_DRIVER ||
  "mitm").trim()`; validate against `{mitm, tmux, opencode}` (unknown ⇒ warn
  `unknown --rc-driver=<x> (valid: mitm, tmux, opencode)`, exit 2). `mitm` calls the existing
  `runRcLaunch` unchanged; `tmux` builds a `DriverContext` (sharing the already-resolved identity /
  brokerUrl / backend / `newClient` with the Vercel bypass) and calls `runTmuxDriver(ctx)`.
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
  `tailTranscript` whole/partial/truncation/abort; `findNewestTranscript` mtime selection.
- `inject.test.ts` — `injectUserText` records exactly `[setBuffer, pasteBuffer, sleep(40), sendEnter]`;
  `runInjectPump` against a real Session drains a prompt (paste+Enter) and an interrupt (Escape) in
  order; ignores `control_response`/`initialize`.
- `status.test.ts` — running on append; idle after debounce; open `tool_use` suppresses idle;
  re-arm = one transition; `phaseFor("running")==="thinking"`.
- `tmuxctl.test.ts` — argv shapes for every command via an injected `TmuxExec`; `hasSession` code→bool;
  argv-safety of `set-buffer -- <text>`; `killSession` swallows "no session".
- `driver.test.ts` — MockBroker-backed wiring (like `launch.test.ts`): `onSession` fires a fresh
  `cse_`, announce posts, an appended assistant line round-trips a sealed `assistant` frame to a
  viewer, a viewer `user` frame drives the fake `TmuxCtl` (paste+Enter), the child env is scrubbed and
  carries **no** proxy vars, and abort runs `killSession`.
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
   `~/.claude/projects/<slug>/*.jsonl` exists with mtime after launch; `grep HTTPS_PROXY
   /tmp/tmux-driver.log` is empty.
3. From a viewer keyed to this identity:
   - "Reply with the single word PINEAPPLE." → pane pastes+submits, viewer shows the assistant frame.
   - "Run `ls`…" → viewer shows tool_use + tool_result (auto-approved).
   - Presence flips thinking → idle ~1s after the turn.
   - Long turn + viewer interrupt → pane gets Escape and stops.
   - Multiline/backtick prompt pastes intact, no premature submit.
4. Send an image from the viewer → relay writes it and injects a `Read` prompt; pane shows claude
   reading it (no driver code).
5. Ctrl-C the wrapper → relay flushes, `tmux has-session -t rc-cse_<hex>` is non-zero (killed).

Negatives: `--rc-driver=bogus` ⇒ exit 2 + valid list; `--rc-driver=tmux` without `--rc-app` ⇒ warns,
runs plain claude; `tmux` absent ⇒ clear "could not start remote control: tmux not found" (exit 1).

---

## 7. Risks (summary)

1. **Sub-agent nesting** relays flat in v1 (local transcript marks sub-agents with `isSidechain`, not
   `parentToolUseID`); resolve in B2. *Biggest fidelity gap vs MITM.*
2. **Silent shape drift** — `mapUpstreamItems` drops off-shape frames; guarded by real-line contract
   tests.
3. **Status is heuristic** (append timing, not claude's `worker_status`); debounced; refine with
   `turn_duration` system lines later.
4. **Auto-approve permissions** (`structuredPermissions:false`); single-user-trusted; mirroring is B2.
5. **send-keys timing** — strictly serialized inject; only `interrupt` mapped in v1.
6. **Transcript discovery/rotation** — mtime-gated discovery + truncation-reset tail; resume hardening
   is B2.
7. **No history backfill** unless the backend is durable (inherited relay boundary, #36).
8. **tmux dependency** — clear error if absent; unit tests need no tmux.
9. **One driver per wrapper process** (RelayCore is per-launch).

---

## 8. Summary

The tmux driver is the **provider-agnostic** sibling of the MITM driver: same `Session` seam, same
canonical `UpstreamPayload`, same relay/broker/viewer — but it captures by **tailing claude's
transcript JSONL** and injects by **typing into a tmux pane**, so it works on Bedrock/Vertex where
native Remote Control is disabled. Because the transcript's content blocks are byte-identical to the
relay's input and the relay is a pure function of `(Session, BrokerClient)`, the driver is a **pure
addition** — nothing downstream changes."