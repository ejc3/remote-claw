# Experimental tmux compatibility driver

`--rc-driver=tmux` runs a plain `claude` in a private tmux session, captures its local transcript, and
injects remote text through the pane. It uses the same encrypted broker and viewer as the default
Claude Remote Control adapter, but it does not use remote-claw's MITM or CA.

This is an experimental but intended compatibility surface. It is useful when a structured native
adapter is unavailable—for example, with a directly configured Bedrock or Vertex provider. Its
product contract is deliberately lower fidelity: the person at the pane and remote injectors share one
editor keystream. Because the driver launches plain Claude and forwards Claude's own
`--remote-control`, provider collaboration can coexist without a new adapter. A bounded Claude 2.1.237
run on 2026-08-24 exercised the local pane, Anthropic Remote API, and two remote-claw browsers on one
session and survived broker loss. That is version-specific architecture evidence, not an official-app
UI test, supported-version promise, or upgrade from this driver's experimental status.

## 1. Topology

```text
plain claude in private tmux
       ⇅ transcript JSONL / pane input
Tmux driver ⇄ Session ⇄ HostRcRelay ⇄ encrypted broker/viewer
       ↓
Claude's configured provider, with no remote-claw proxy added
```

The driver preserves proxy and CA variables the user supplied. It scrubs inherited Claude parent
session IDs and remote-claw host secrets so a child launched from another Claude session is not turned
into a stub or pinned to its parent.

## 2. Private startup and readiness

Each launch creates a private `0700` runtime directory containing a tmux socket, executable launcher,
merged Claude settings, a SessionStart event file, and—when permission mirroring is enabled—permission
request/decision files and a helper. Files are created with restrictive modes and are never placed in
the broker protocol.

The launcher starts a fresh private tmux server and session. Unless the user already supplied
`--session-id`, `--resume`, or `--continue`, remote-claw passes a fresh UUID with
`claude --session-id <uuid>`, making the initial transcript selection deterministic. User-owned resume
and picker arguments remain authoritative.

A live pane is not enough to publish a session. The driver injects a SessionStart hook into a private
settings file and waits for a valid marker containing the exact native session ID and transcript path.
Only after both the pane and that marker are valid may `ReadyBridge.start()` create the broker bridge
and publish presence.

The startup hook is always required. `--rc-session-hook` and `--rc-no-session-hook` control only
whether capture continues reading later hook events to follow `/clear` or `/branch` transcript
rotations. Hook-disabling Claude modes such as `--bare`, `--safe-mode`, or truthy
`CLAUDE_CODE_SIMPLE`/`CLAUDE_CODE_SAFE_MODE` fail startup before publication.

User `--settings` are parsed and merged into the private settings document; existing settings and
hooks are preserved. Invalid or unmergeable settings fail closed. The merged document and hook
commands do not appear in tmux argv.

## 3. Capture

Claude transcripts live under `~/.claude/projects/<project>/<session>.jsonl`. The driver uses the
SessionStart marker or exact known UUID to select the main file and then tails it by byte offset.
`TranscriptTailer` preserves partial lines and split UTF-8, detects truncation or file replacement, and
never relies on `fs.watch`.

`transcriptToPayload` accepts only assistant, user, and system records. It passes Claude's
`message.content` blocks through unchanged, retains stable UUIDs, renames
`parentToolUseID` to `parent_tool_use_id`, and preserves the small system-task field set the relay
understands. Bookkeeping records the viewer cannot render are dropped.

Sub-agent output can live in sibling `subagents/agent-*.jsonl` files. The driver tails those only after
their metadata sidecar identifies the spawning tool-use ID, then tags their messages so the viewer
nests them under the parent Task. When main and sub-agent files produce a batch together, timestamps
provide their display merge order. An unreadable sidecar means that sub-agent output is not surfaced.

Interactive Claude transcripts have no ordinary RC `result` event. At a terminal top-level assistant
record, the driver emits an empty synthetic result so the viewer can separate turns.

### Local prompt attribution

After remote text is submitted, the driver records a bounded text token. The matching top-level native
user record is suppressed as the browser prompt's echo. An unmatched top-level user record is marked
`local_prompt:true` and shown in the viewer.

This is post-hoc display attribution, not command identity. A simultaneous identical local and remote
prompt can be misclassified. The transcript UUID remains useful for capture deduplication, but the
current driver has no durable source journal across restart.

## 4. Injection

The downstream pump is serialized. For a remote prompt it:

1. sends the prompt bytes on stdin to `tmux load-buffer`;
2. performs a bracketed `paste-buffer`, without submitting;
3. waits a length-bounded settle interval; and
4. sends Enter separately.

Prompt bytes do not appear in a shell command or process arguments. Separating paste from Enter keeps
a safely retryable Enter from deliberately repasting the prompt.

Current mappings are:

| Session event | Pane action |
| --- | --- |
| `user` | load, bracket-paste, Enter |
| `interrupt` | Escape |
| `set_model` | inject `/model <value>` |
| `set_permission_mode` | safe no-op |
| `end` | safe no-op; viewer end is disabled before this path |
| permission response | persist the hook decision file |

A session event is acknowledged after its tmux or decision-file operation reports success.

That receipt is not proof of native application. tmux can apply a paste, Enter, or Escape and then lose
the completion response. `load-buffer` may repeat because replacing the same named buffer is
idempotent. A pane mutation repeats only when tmux authoritatively reports that it was not applied. An
unknown paste, Enter, or Escape outcome is attempted exactly once, remains unacknowledged, and closes
the remote Session/projection without crashing the native driver. The healthy local pane remains alive
under its existing owner for manual recovery. This prevents blind duplicate mutation; it still does not
claim native exactly-once behavior or prove that Claude accepted an acknowledged pane command.

There is also no exclusive editor lease. Serializing remote sends prevents two remote-claw pastes from
interleaving with each other, but it cannot stop a person from holding a partial draft while the driver
pastes and presses Enter. Claude may receive merged text. Tmux therefore cannot claim independent peer
ordering or native exactly-once application. It can still satisfy its narrower product outcome: keep
the pane recoverable, connect multiple browsers, and report delivery and attribution limits truthfully.

## 5. Permission mirroring

Permission mirroring is on by default. The private settings include a blocking Claude `PreToolUse`
hook. The helper appends one request to a private NDJSON file and waits for a corresponding decision
file. The driver turns that request into the relay's ordinary `permission_request`; a viewer answer is
written atomically before the downstream event is acknowledged.

The driver also prepares Claude's cwd trust before spawn so the startup trust dialog cannot block
before the hook runs. Trust-update failure prevents publication.

`--rc-tmux-skip-permissions` or `RC_TMUX_SKIP_PERMISSIONS` opts out. In that mode no permission hook is
installed, the child receives `--dangerously-skip-permissions`, and the advertised structured
permission capability is false. Supplying `--dangerously-skip-permissions` while mirroring is on is a
configuration error.

The hook is remote-answer-only and does not prove a clean first-winner race between the local TUI and
viewer. A blocked hook or lost decision can still require local recovery.

## 6. Status and capabilities

Transcript activity drives an internal heuristic: a new line reads as running, and a quiet timer reads
as idle when no tool is open. New user turns and a hard-idle fallback clear orphaned open-tool state.
Because this is timing inference rather than native truth, the driver advertises `status:false`.

With default permission mirroring, the viewer capabilities are:

| Capability | Value |
| --- | --- |
| Structured permissions | true |
| Status | false |
| Interrupt | true |
| Set model | true |
| Set mode | false |
| End | false |
| Attachments | true |

Attachments remain relay-owned. After authentication the shared relay writes the image and injects an
ordinary `@"<path>"` prompt, so the tmux driver sees only a `user` event. Images pasted locally into
the pane are not captured as remote-claw attachments.

## 7. Rotation, teardown, and recovery

The fresh UUID pins the first transcript. Claude `/compact` normally stays in that conversation;
`/clear` and `/branch` can rotate to a new file. With ongoing SessionStart following enabled, the
driver flushes the old tail and follows the exact new marker. With it disabled, capture falls back to
the known-ID/file-discovery behavior and can miss an ambiguous rotation.

Following a new transcript keeps the current compatibility bridge alive for capture continuity. It
does not create durable branch lineage or a restart-safe native binding.

The wrapper ends when the parent signal fires, a pump crashes, or the pane is confirmed gone. Teardown
closes `ReadyBridge`, the compatibility `Session`, and pumps under a bounded deadline, then asks the
private tmux server to kill the session. Runtime files are deleted only after termination or absence
is proved.

If kill/probe outcome is unknown, the driver retains the private runtime and prints the exact
`tmux -S <socket> attach -t <session>` recovery command rather than deleting the control socket for a
possibly live pane. This preserves manual access; a new wrapper cannot automatically adopt that pane.

## 8. Files and tests

The implementation is in `packages/cli/src/host/rc/tmux/`:

- `driver.ts` — readiness, capture lifecycle, registration, and teardown;
- `tmuxctl.ts` — private-server commands and stdin buffer loading;
- `transcript.ts` — discovery, byte tailing, translation, sub-agents, and local prompts;
- `inject.ts` — serialized prompt/control delivery and acknowledgement;
- `sessionhook.ts` — settings merge and SessionStart markers;
- `permhook.ts` — permission request/decision bridge;
- `trust.ts` — cwd trust preparation; and
- `status.ts` — heuristic activity tracking.

Tests beside those files use injected tmux, filesystem, clock, and broker seams. They cover argument
parsing, private argv/environment, readiness-before-publication, transcript rotation and partial reads,
sub-agent nesting, prompt-byte handling, control mappings, permission decisions, capability truth, and
conservative teardown. They require no real tmux or Claude.

The 2026-08-24 M0 experiment was intentionally bounded and its temporary harness was removed after the
architecture decision. Before tmux is advertised as a supported coexistence surface, M4 must add the
smallest maintained opt-in real acceptance for local pane + provider client + two browsers + broker-loss
isolation; unit tests cannot replace that cross-process outcome.

A manual run looks like:

```bash
remote-claw --rc-app "$RC_APP" --rc-driver=tmux --model sonnet
```

The command prints the exact private attach command after startup. If the broker is protected by
Vercel, the host may use `VERCEL_AUTOMATION_BYPASS_SECRET`; that value is scrubbed from the child.
