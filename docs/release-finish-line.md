# remote-claw Claude 1.0 finish line

**Status:** this is the sole active release finish line for remote-claw. The broader
client-driven host runtime, OpenCode, Codex, tmux durability, nested collaboration, and provider
façades are parked future-platform work. They do not block Claude 1.0.

## Product outcome

Ship one installable, supportable path that lets a person use an owned browser to drive the real
Claude Code TUI on their machine through a zero-knowledge broker:

```text
real browser ⇄ ciphertext-only broker ⇄ installed host wrapper/MITM ⇄ real Claude Code TUI
```

The core path already works as a developer beta. Claude 1.0 is done only when that path fails safely
under ambiguous delivery and relay failure, presents its evidence honestly, installs without the
repository's TypeScript toolchain, and passes one deployed real-topology proof.

## Current evidence, without roadmap inflation

| Surface | Current truth |
| --- | --- |
| Core product | Real Claude MITM, E2E crypto, broker, browser viewer, turns, permissions, attachments, and multi-client behavior are implemented and tested. |
| Browser publish | A failed POST can mean “stored, response lost,” but the current Retry mints a new source ID and can create a second command. |
| Host intake | One live relay deduplicates broker replay by `msgId` in its process-long `#seen` set. A new launch gets a random new `cse_*`; it does not resume the old relay. |
| Native delivery | Worker SSE reconnect creates a fresh `sent` set. If Claude received a mutation but its delivery acknowledgement was lost, reconnect can emit it again. |
| Native output | The retained Linux arm64 Claude 2.1.237 proof establishes `payload.uuid` coverage and one observed batch-level byte-identical retry, but `/worker/events` still always appends and reports `duplicate:false`. The two relay pumps can allocate `N` and `N+1` concurrently, allowing `N+1` to persist while `N` fails. |
| Relay failure | A fatal publisher currently stops only the bridge; the MITM and Claude can continue while output is no longer relayed. |
| Distribution | `@remote-claw/cli` is private `0.0.0`, exports TypeScript source, and has no `bin` or build/package script. |
| End-to-end proof | Real-browser tests use scripted sessions; RC-spine uses a fake worker; the real-Claude proof uses the Viewer library. No installed-artifact smoke covers a real browser, real Claude PTY, and deployed broker together. |

The release work closes only these product gaps. Dormant platform foundations do not substitute for
them.

## Scope boundary

Claude 1.0 includes only the existing Claude Remote Control MITM lane, browser viewer, identity/pass
flow, and one durable sealed-log broker profile. SQLite/libSQL is the production profile; the capped
Vercel Workflow backend remains experimental unless safe rollover is implemented and proven.

Manual pass onboarding is sufficient for 1.0. One-time QR/OTK handoff may ship only if its mandatory
edge rate limit is verified by the release gate; otherwise that route and UI are disabled.

OpenCode, Codex, tmux, alternate provider connectors, nested collaboration servers, and the A1
signer/certificate/runtime graph are out of scope. Existing compatibility code may stay, but cannot
expand the stable surface or weaken its gates. The stable entrypoint must not initialize the dormant
A1 runtime owner, and experimental drivers must not look like supported alternatives.

Claude 1.0 keeps the existing single-user pass trust model: every pass holder is a trusted controller
for every session under that machine identity and can construct valid input- or output-shaped sealed
frames. Per-viewer roles, individual pass revocation, and host-only output signatures require a
separate product decision.

The supported synchronization boundary is browser-originated mutations plus native RC events that
remote-claw observes. Local-TUI prompt text may be absent and the viewer must say so. Lossless local
transcript mirroring is not a 1.0 requirement.

## Fail-stop incarnation boundary

One live relay owns one random `cse_*`. Native process death, wrapper death, or fatal bridge/publisher
failure ends that remote session. Claude may continue as a local TUI after a bridge failure, but the
old remote session becomes non-writable and receives no more native events. A later launch gets a new
session identity and never replays an old command into it.

The viewer discloses that the ended session's most recent delivery and output tail may be incomplete.
Claude 1.0 deliberately makes no transparent restart, old-`cse_*` takeover, complete unpublished-tail
recovery, or cross-process conversation-recovery promise. Those availability features would require a
durable host coordinator; they are not silently added to this release.

## Supported mutation boundary

The stable browser emits one mutation family: non-empty, non-slash-prefixed text. Permission and
question answers are disabled for Claude 1.0 because the current retained native-output proof
establishes control event types but deliberately retains no question/tool subtype. A later release may
enable an answer family only after a supported compatibility proof advertises that exact family.

Attachments, slash-prefixed text, interrupt, model changes, permission-mode changes, and end-session
are disabled in the stable UI. Compatibility code may remain internal, but it is not a shipped stable
capability.

## Minimum command safety contract

This release uses the fail-stop ownership boundary instead of a new command journal or broker-side
dispatch CAS:

1. A browser mutation has one random source `msgId` and immutable semantic content. After an ambiguous
   publish failure, the stable UI does not automatically Retry or mint a replacement ID. An explicitly
   cached transport retry, if retained at all, must repost the exact encoded frame bytes.
2. SQLite/libSQL treats an exact encoded-frame replay under `(generation, msgId, part)` as the existing
   row and rejects different encoded bytes under that identity as a collision. It does not silently
   report changed bytes as success.
3. One `HostRcRelay` owns the session. Its incarnation-long `#seen` set is populated before the first
   awaited native side effect, so broker reconnect cannot re-handle a source ID. No replacement relay
   may adopt the old `cse_*`.
4. `Session` keeps a session-wide `emissionStarted` fence for every mutating downstream event. It marks
   the event before its first worker SSE write and never emits that event on a later worker stream,
   even if the delivery acknowledgement was lost. The non-mutating initialize handshake may retain its
   separately proved reconnect behavior.
5. Permission/question answers are absent or disabled in the Claude 1.0 stable surface. Compatibility
   code may remain internal but cannot emit a stable native mutation.
6. The existing `accepted` compatibility frame means only **Received by host**. The browser may show
   local **Sending** followed by **Received by host**, but never “delivered,” “applied,” or “executed.” A
   worker receipt is diagnostic only. On session loss, the browser says **Delivery unknown**.
7. Existing `permission_resolved` compatibility frames are not presented as a stable native answer or
   as native “Allowed” or “Denied.”

For one source identity, remote-claw therefore attempts at most one mutating RC emission. It does not
claim exactly-once native execution. Durable per-command status rows and broker-before-dispatch
round-trips would become necessary only if same-session host takeover or automatic ambiguous retry is
reintroduced.

## Native output contract

1. The retained Linux arm64 Claude 2.1.237 proof establishes the observed compatibility boundary. In
   one current-version coverage run, all 30 first-arrival events across `assistant`,
   `control_cancel_request`, `control_request`, `control_response`, `rate_limit_event`, `result`,
   `system`, and `user` carried distinct RFC 4122 UUIDv4 `payload.uuid` values. In a separate
   lost-response run, the probe fully buffered an upstream HTTP 200 for a four-event
   `system`/`assistant`/`assistant`/`result` batch, reset the matching local response with no headers or
   writable bytes started, and observed an exact retry in the same trace-wrapper run and RC session
   path. The retained witnesses independently match request length/SHA-256, ordered types, aliased UUID
   coordinates, payload hashes, and a present worker-epoch alias. The sanitized artifacts, exact probe,
   pinned runtime-source/binary/package hashes, and offline verifier live in the
   [`spikes/claude-native-output` package](https://github.com/ejc3/remote-claw/tree/main/spikes/claude-native-output).
   Any supported Claude-version or platform change must rerun this gate. This is one request-level
   observation; the four included event types are incidental, and the proof does not establish
   deterministic or per-type retry, Claude process identity, a specific question/permission subtype,
   or server-side application/dedup.
2. Within one live incarnation, exact identity plus exact payload bytes returns the original event ID
   and sequence on retry. Changed bytes under one identity are rejected as a collision. An event without
   the proved coordinate fails the compatibility probe rather than receiving a synthetic identity.
3. One head-of-line publisher owns projection sequence allocation and broker publication across both
   relay pumps. It does not allocate or publish `N+1` until `N` is durably accepted. Failure latches the
   session closed before a queued publisher can proceed.
4. Native `/worker/events` is observation intake, not a native mutation. It may be acknowledged after
   validated in-memory dedup rather than waiting on the broker, provided publisher failure ends the
   remote session and the viewer always discloses the possibly incomplete tail. Complete acknowledged
   output recovery across wrapper death would require a durable outbox and is not a 1.0 promise.

## Security and compatibility invariants

- Broker storage and application logs contain no prompt, response, tool, permission, or attachment
  plaintext; no content keys, pass/master secret, or provider credentials; and the broker cannot
  decrypt protected content. The broker necessarily receives its bearer admission capability, so a raw
  request capture is not claimed to contain no secret at all.
- The CLI is compiled and installable, secrets remain off argv and logs, and the release enforces one
  proved Claude version/platform tuple behind a fail-closed protocol probe. Unsupported behavior
  requires an explicit experimental opt-in.
- Production deployment prerequisites and broker integration tests fail rather than silently skip in
  the release workflow.

## One required release suite, two proof legs

Both legs are required; neither substitutes for the other.

### 1. Deterministic fail-stop matrix

Use the production MITM, relay, session, viewer-state code, real SQLite/libSQL broker, and faithful fake
worker. Prove:

- an ambiguous browser POST never creates an automatic new-ID retry;
- broker stream reconnect handles one source `msgId` once;
- worker SSE disconnect after the first user/control write but before its acknowledgement never emits
  that mutation again;
- permission/question answer controls are absent or disabled;
- exact native-event retry returns one event/projection and a UUID collision fails closed;
- a stalled or failed projection `N` prevents `N+1` from reaching the broker across both pumps;
- fatal publication closes the remote session, stops further intake/emission, and leaves the local TUI
  only under the disclosed fail-stop boundary;
- a successor session has a fresh `cse_*` and receives no old command; and
- every unsupported stable control is absent or disabled.

### 2. Installed real-topology smoke

Use the compiled installed CLI, a pinned/probed real Claude binary under a PTY, the actual browser UI,
and a deployed SQLite/libSQL production broker. Cover onboarding, discovery, a text turn, streamed
output, browser/broker reconnect, truthful local-input and incomplete-tail disclosure, and broker
storage/log inspection for protected-content absence, and prove permission/question answer controls
are disabled.

## Implementation order

These are internal merge boundaries, not separate product tranches. Each implementation boundary must
close one runnable causal path; there is no additional design-only “freeze” change:

1. Retain and gate the Linux arm64 Claude 2.1.237 lost-HTTP-200 UUID proof. This evidence boundary is
   complete; further native retry research is out of scope unless implementation finds a concrete
   contradiction.
2. Build one host/native fail-stop vertical: the stable MITM entrypoint skips dormant A1 runtime-owner
   initialization and enforces the supported Claude tuple; strict `/worker/events` intake atomically
   reserves UUID plus exact bytes; exact retry reuses its result and collision fails closed; a
   session-wide fence prevents mutating SSE redelivery; one head-of-line queue owns projection
   sequencing/publication across both pumps; and any fatal publisher failure closes that `cse_*` before
   later intake or publication. One deterministic fake-worker matrix proves the whole path, including a
   fresh successor receiving no old mutation.
3. Close the browser/broker stable-surface vertical: SQLite exact replay versus collision, no automatic
   new-ID retry after ambiguous publish, disabled permission/question answers, truthful status/tail
   wording, and absent or disabled unsupported controls.
4. Build and install the stable CLI without repository tooling, then pass both release-suite legs, the
   repository's full checks, independent review, and CI.

Then release Claude 1.0 and stop. Any multi-engine platform work requires a new explicit product
decision; it is not an automatic “next tranche.”
