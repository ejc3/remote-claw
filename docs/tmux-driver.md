# Maintained lower-fidelity tmux compatibility driver

`--rc-driver=tmux` runs a plain `claude` in a private tmux session, captures its local transcript, and
injects remote text through the pane. It uses the same encrypted broker and viewer as the default
Claude Remote Control adapter, but it does not use remote-claw's MITM or CA.

This is a maintained compatibility surface for cases where a structured native adapter is unavailable—
for example, with directly configured Bedrock or Vertex inference. Its product contract is deliberately
lower fidelity: the person at the pane and remote injectors share one editor keystream. The accepted M4
tuple is Linux arm64 with exact Claude 2.1.237. The driver checks that platform and version before
identity, broker, or pane startup and rejects every other platform/version. Other provider
configurations remain unverified rather than inheriting M4's Bedrock result.

The driver forwards user-supplied Claude arguments, but M4 does not advertise provider-native Remote
Control or official-client coexistence. The structured `claude-native` adapter owns that Claude product
claim. Historical M0 provider/API evidence remains architecture evidence only.

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
fixed input helper, merged Claude settings, SessionStart event file, ephemeral `turn-active` sentinel,
SessionEnd retirement marker, and per-attempt injection outcome files. Files are created with
restrictive modes and are never placed in the broker protocol. The driver creates no permission
request/decision files.

The launcher starts a fresh private tmux server and session. Unless the user already supplied
`--session-id`, `--resume`, or `--continue`, remote-claw passes a fresh UUID with
`claude --session-id <uuid>`, making the initial transcript selection deterministic. User-owned resume
and picker arguments remain authoritative.

A live pane is not enough to publish a session. The driver injects a SessionStart hook into a private
settings file and waits for a valid marker containing the exact native session ID and transcript path.
It uses Claude's resolved permission mode when the current SessionStart hook reports one. Otherwise it
accepts only a timestamped matching-session record written after the current transcript attach. Every
attached backfill is ignored—even if its timestamps are newer than wrapper spawn—because another
same-user process may have written it before this attach. Rotation clears the prior session's announced
mode before considering new evidence. Claude 2.1.237 creates
a fresh transcript lazily, so absent current evidence publishes an explicit `unknown` posture instead of
delaying the session or guessing. Startup also runs the fixed helper's Linux `flock` probe; failure
blocks publication. Only after the pane, marker, and lock probe are ready may `ReadyBridge.start()`
create the broker bridge and publish presence. The private attach command is printed immediately after
the pane starts, before this barrier, so a native folder-trust prompt can be completed locally.
remote-claw never pre-trusts the cwd.

The startup hook is always required. `--rc-session-hook` and `--rc-no-session-hook` control only
whether capture continues reading later hook events to follow `/clear` or `/branch` transcript
rotations. Hook-disabling Claude modes such as `--bare`, `--safe-mode`, or truthy
`CLAUDE_CODE_SIMPLE`/`CLAUDE_CODE_SAFE_MODE` fail startup before publication.

User `--settings` are parsed and merged into the private settings document; existing settings and
hooks are preserved. In addition to readiness, the document carries the minimal turn-serialization
hooks described below. Every `UserPromptSubmit` helper failure is normalized to Claude's blocking
status 2. Invalid or unmergeable settings fail closed. The merged document and hook commands do not
appear in tmux argv.

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

Interactive Claude transcripts have no ordinary RC `result` event. At a top-level
`system/turn_duration` record, the driver emits an empty synthetic result so the viewer separates turns
only after Claude's full model loop and continuations finish.

### Local prompt attribution

After remote text is submitted, the driver records a bounded text token. The matching top-level native
user record is suppressed as the browser prompt's echo. An unmatched top-level user record is marked
`local_prompt:true` and shown in the viewer.

This is post-hoc display attribution, not command identity. A simultaneous identical local and remote
prompt can be misclassified. The transcript UUID remains useful for capture deduplication, but the
current driver has no durable source journal across restart.

## 4. Injection

The supported browser mutation surface is ordinary non-empty, non-slash text plus authenticated
attachments. The viewer and host relay reject empty or slash-leading text, and the injection boundary
independently acknowledges slash-leading text without touching the pane. Slash commands remain local.

The downstream pump uses a fixed private helper. For a remote prompt it:

1. has Node stream the prompt bytes to a private named tmux buffer, without mutating the pane;
2. invokes the fixed helper, which takes the shared Linux `flock`;
3. while holding that lock, exclusively creates the private `turn-active` gate or reports busy;
4. while still holding the lock, performs bracketed paste, a length-bounded settle, and Enter; and
5. writes an authoritative per-attempt outcome before releasing the lock.

Claude's merged synchronous `UserPromptSubmit` hook takes the same helper lock and closes
`turn-active` before Claude starts either a local or remote model turn. Every helper failure on that
hook path blocks Claude with status 2. After touching the gate, the helper holds the lock for 10 ms so
later integer-millisecond completion/cancellation timestamps are strictly newer than the fractional file
mtime used by the generation check. Exact 2.1.237 writes main-transcript `system/turn_duration` only
after the full model loop and continuations finish. The injector atomically renames the sentinel and
removes it only when its mtime generation is strictly older than that completion; a delayed or
backfilled turn A therefore cannot release a newer turn B. The two exact latched-interrupt records use
the same generation-safe release. Exact current-launch command-hook or structured sibling-hook rejection
warnings can race our concurrent helper, so they retire only the remote projection and leave the gate
closed and pane usable rather than guessing a generation. Old backfill, generic warnings, and ordinary
user records do neither. `SessionEnd`
uses the shared helper lock to close the gate and write the retirement marker. If the helper fails, its
shell fallback requires the
retirement marker first and then attempts a best-effort gate close. Capture may observe later local
rotation, but the remote projection stays retired while the pane remains usable. `Stop`, `StopFailure`,
and asynchronous `Notification` hooks never release the gate because each can race later work.

This guarantees that remote pane mutation cannot cross an active model turn or the native permission
or question modal reached within that turn. It does not install a global Enter binding or parse the
TUI, and it does not isolate the idle local editor, partial drafts, slash/config UIs, generic idle
modals, or independent peer ordering. Those idle surfaces share one keystream and must not be
manipulated locally while remote viewers may submit. The gate carries no prompt, tool request,
answer, or policy data; it is a local turn sentinel, not a permission mirror.

Prompt bytes do not appear in a shell command or process arguments. Separating paste from Enter keeps
a safely retryable Enter from deliberately repasting the prompt.

Current mappings are:

| Session event | Pane action |
| --- | --- |
| ordinary non-empty, non-slash `user` | load a private buffer; under the helper lock claim, bracket-paste, settle, Enter |
| empty or slash-leading `user` | safe no-op; rejected earlier by the viewer and relay too |
| `interrupt` | safe no-op; disabled in the viewer and relay |
| `set_model` | safe no-op; disabled in the viewer and relay |
| `set_permission_mode` | safe no-op; disabled in the viewer and relay |
| `end` | safe no-op; disabled in the viewer and relay |
| permission response | safe no-op; permissions are local-only |

A supported user event is acknowledged after its corresponding tmux operation reports success.
Unsupported control, text, and permission-response events are acknowledged as explicit no-ops so a
stale or direct client cannot replay them or turn them into pane keystrokes.

That receipt is not proof of native application. tmux can apply a paste or Enter and then lose the
completion response. `load-buffer` may repeat because replacing the same named buffer is idempotent. A
pane mutation repeats only when tmux authoritatively reports that it was not applied. An unknown paste
or Enter outcome is attempted exactly once, remains unacknowledged, and closes the remote
Session/projection without crashing the native driver. The healthy local pane remains alive under its
existing owner for manual recovery. This prevents blind duplicate mutation; it still does not claim
native exactly-once behavior or prove that Claude accepted an acknowledged pane command.

There is no exclusive idle-editor lease. A person can hold or change a partial draft, use a slash or
configuration UI, or otherwise manipulate the idle pane while the driver injects; Claude may receive
merged text or the keys may affect the wrong idle UI. Operators therefore must not manipulate those
surfaces while remote viewers may submit. Tmux cannot claim generic idle-modal isolation,
independent peer ordering, or native exactly-once application. It can still satisfy its narrower
product outcome: keep the pane recoverable, connect multiple browsers, protect active turns, and report
delivery and attribution limits truthfully.

## 5. Native/local permissions

Claude's local tmux pane is the sole owner of permission prompts, questions, and folder trust. The
driver advertises `structuredPermissions:false`, injects no `PreToolUse` permission hook, reads or
writes no request/decision content, never mutates `.claude.json`, and does not add
`--dangerously-skip-permissions`. If the user explicitly passes Claude's native
`--dangerously-skip-permissions` or `--permission-mode bypassPermissions`, it is forwarded unchanged as
the user's choice.

The optional capability field `permissionPosture` distinguishes `local`, `bypassed`, and `unknown`.
A direct actual-bypass argument wins. Otherwise publication uses Claude's resolved SessionStart mode
when supplied or a timestamped matching-session record written after the current transcript attach.
No startup, resume, or rotation backfill can establish posture. Rotation clears the current announce's
mode and republishes without one, so posture immediately becomes `unknown`. That lets Claude apply argv, settings,
and managed-policy precedence without letting stale history describe the current process. A flag
that merely allows the user to select bypass is not itself an active bypass. Missing, stale, or
unreadable evidence publishes `unknown`; it is neither a claim of local enforcement nor a bypass claim.

The current viewer labels permissions local only for the exact maintained tmux tuple with known local
evidence. For explicit `unknown`, it shows **Confirming permission mode in the local Claude tmux
pane.** and keeps ordinary browser text and attachments enabled. The existing transcript pump
projects later timestamped matching-session permission evidence through presence's `mode`; the viewer
then becomes `local` or `bypassed` and follows later local mode changes. This is
metadata observation, not a settings parser or permission hook: no request or decision content is
transported and the browser still cannot answer a gate. Explicit bypass and a legacy announcement with
no posture show **Permissions off**. Older viewers that do not understand the new local or unknown
posture remain pessimistic and do not acquire a permission-control surface.

This boundary prevents a departed browser from leaving a tool blocked in a remote-only hook. Closing
all browsers or losing the broker cannot remove the local pane's ability to answer a later native
permission prompt.

## 6. Status and capabilities

Transcript activity drives an internal heuristic: a new line reads as running, and a quiet timer reads
as idle when no tool is open. New user turns and a hard-idle fallback clear orphaned open-tool state.
Because this is timing inference rather than native truth, the driver advertises `status:false`.

The viewer capabilities are:

| Capability | Value |
| --- | --- |
| Structured permissions | false; the browser cannot answer them |
| Permission posture | `local`, `bypassed`, or `unknown`; exact native evidence updates presence mode after publication |
| Status | false |
| Interrupt | false |
| Set model | false |
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

Before `SessionEnd`, following a new transcript can keep capture continuity. Once `SessionEnd` is
observed, its marker retires the remote projection even if the pane survives or a later SessionStart
appears. A fresh wrapper/projection is required for remote mutation. This does not create durable
branch lineage or a restart-safe native binding.

The wrapper ends when the parent signal fires, a pump crashes, or the pane is confirmed gone. Teardown
closes `ReadyBridge`, the compatibility `Session`, and pumps under a bounded deadline, then asks the
private tmux server to kill the session. Runtime files are deleted only after termination or absence
is proved.

If kill/probe outcome is unknown, the driver retains the private runtime and prints the exact
`tmux -S <socket> attach -t <session>` recovery command rather than deleting the control socket for a
possibly live pane. This preserves manual access; a new wrapper cannot automatically adopt that pane.

## 8. Files and tests

The implementation is in `packages/cli/src/host/rc/tmux/`:

- `driver.ts` — readiness, fixed helper, shared-lock lifecycle, capture, registration, and teardown;
- `tmuxctl.ts` — private-server commands and stdin buffer loading;
- `transcript.ts` — discovery, byte tailing, translation, sub-agents, and local prompts;
- `inject.ts` — buffer-first helper-mediated prompt delivery and no-op acknowledgement of unsupported
  input;
- `sessionhook.ts` — settings merge, SessionStart markers, and shared-lock prompt/end hooks;
- `status.ts` — heuristic activity tracking.

Tests beside those files use injected tmux, filesystem, clock, and broker seams. They cover argument
parsing, private argv/environment, readiness-before-publication, transcript rotation and partial reads,
sub-agent nesting, prompt-byte handling, helper/flock probing and atomic active-turn admission,
blocking-status normalization, SessionEnd retirement and fallback, Stop-family non-release,
slash/control rejection,
permission-posture compatibility, native/local permission ownership, capability truth, and conservative
teardown. They require no real tmux or Claude.

For the tmux tuple, "ordinary text" excludes pane-active terminal bytes. The viewer and relay reject
C0/C1 controls other than TAB and LF in text and attachment captions; `inject.ts` independently checks
every downstream user prompt before `load-buffer`, including attachment-generated prompts. This
three-layer rejection prevents an authenticated or stale direct client from embedding ESC plus a
bracketed-paste terminator and turning a text message into raw pane keys.

The 2026-08-24 M0 experiment was intentionally bounded and its temporary harness was removed after the
architecture decision. M4 completed on 2026-08-31 with the retained opt-in
`tests/web/app-e2e/tmux-live.spec.ts`. It ran a packed-installed CLI, exact Claude 2.1.237 on Linux arm64,
Bedrock `global.anthropic.claude-sonnet-4-6` in `us-west-1`, a real private tmux pane, a durable local
SQLite broker, and two independent Chromium contexts. Browser-A and browser-B turns appeared once in
both viewers; reload reconstructed the transcript. The fresh session first showed that permission mode
was being confirmed without disabling browser text; native transcript evidence then resolved the
viewer posture. A safe local Bash turn next focused Claude's native permission UI while browser B
submitted another prompt. The modal remained focused and unmodified,
proving the browser paste and Enter stayed queued. Both browsers departed; local approval completed the
Bash turn, and the queued browser turn then completed without either browser present. The test then
closed its broker proxy and every accepted socket—the direct transport-loss fact—and another local turn
completed in the retained pane. It deliberately does not wait for a particular retry-log string.

The same outcome test inspects the private launch artifacts to require the turn-gate hooks and no
remote-claw `PreToolUse` hook, permission decision files, or automatic
`--dangerously-skip-permissions`; deterministic tests own the absence of trust mutation. Its expensive
cross-process value is limited to the real focused-modal/queued-turn boundary, browser departure,
native permission ownership, and broker-loss isolation. Deterministic tests own hook composition,
atomic claim behavior, three-layer slash/control rejection, permission-posture compatibility, argv,
capability, and teardown rules. This run did not exercise provider-native or official-client
collaboration, and M4 explicitly declines both claims.

The maintained acceptance command requires explicit paths and fails instead of skipping when they are
absent:

```bash
CLAUDE_CODE_USE_BEDROCK=1 \
AWS_REGION=us-west-1 AWS_DEFAULT_REGION=us-west-1 \
RC_TMUX_LIVE_MODEL=global.anthropic.claude-sonnet-4-6 \
RC_TMUX_LIVE_CLI=/path/to/packed-installed/remote-claw \
RC_TMUX_LIVE_CLAUDE=/path/to/claude-2.1.237 \
RC_TMUX_LIVE_CWD=/path/to/a/pre-trusted/project \
pnpm --dir tests/web test:tmux-live
```

A manual run looks like:

```bash
remote-claw --rc-app "$RC_APP" --rc-driver=tmux --model sonnet
```

The command prints the exact private attach command after startup. If the broker is protected by
Vercel, the host may use `VERCEL_AUTOMATION_BYPASS_SECRET`; `RC_APP` must pin the exact same HTTPS
origin, and the resolved bypass is passed only to the broker client. The value is scrubbed from the
child.
