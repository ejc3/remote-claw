# Native Claude Remote investigation: evidence for the brokered connector

**Status:** retained protocol and security research plus an implemented app-side
`AnthropicRcClient` foundation. The transparent passthrough design is rejected. There is no
`--rc-native-passthrough` flag or launch path.

> **Roadmap authority:** [Claude 1.0](release-finish-line.md) is the sole active release finish line.
> The outward Anthropic connector and generalized client-driven host described below are parked optional
> platform research. They are neither selected implementation work nor a Claude 1.0 release gate.

If that optional work is resumed, the parked
[client-driven host design](client-driven-host-runtime.md) would use a Claude topology with two
independent sides:

- the real inner Claude Code process sees only remote-claw's private synthetic RC/API façades and
  synthetic or no credentials;
- one person keeps using that process's real native TUI while one remote-claw private RC connection
  participates as the single remote collaborator; and
- remote-claw separately owns an inference connector and the real outward Anthropic Remote
  worker/app connector.

The inner process never registers, bridges, or authenticates with Anthropic. Native Claude owns its
conversation, final local/remote interleaving, and execution state. A small coordinator journal owns
only remote-collaborator proposal order, forwarding, correlation, and delivery evidence; Anthropic
session history proves only that the provider-side representation is available, not that any
particular official device rendered it.

## 1. Decision and boundary

The earlier proposal was to forward an inner Claude process's real RC worker traffic to Anthropic,
observe that traffic, and let remote-claw act as a peer app client. That topology is rejected because it
would:

- give the inner process a real provider session and provider-facing worker role;
- delegate remote session identity, delivery order, and reconnect semantics to Anthropic rather than
  remote-claw, even though native Claude would still decide what actually applies;
- couple recovery to a native worker and credential lifecycle remote-claw does not own; and
- leave no clean journal boundary before official-client input reaches execution.

The reusable protocol finding is narrower: remote-claw can implement both sides itself. It can continue
serving the private synthetic worker protocol inward while a separate connector speaks the observed
worker and app protocols outward.

The connector must keep the two Anthropic roles separate:

- `worker_jwt` authenticates the host/worker side of one real `cse_*`;
- the user's OAuth credential authenticates app/client and pre-bridge operations;
- neither credential enters the inner process, coordinator records, broker frames, argv, or logs; and
- exactly one remote-claw connector owns the outward worker epoch and stream.

Official Claude apps connect directly to Anthropic as usual. They do not connect to the inner Claude
process and remote-claw does not proxy their device sockets. Their commands arrive through
remote-claw's sole outward worker connection, are journaled and optionally forwarded, and only then
cross the private inner façade as input from remote-claw's one collaborator connection. Native Claude
remains the final arbiter.

## 2. Current code baseline

Three existing pieces have different purposes:

| Piece | Current behavior | Possible role in the parked design |
|---|---|---|
| `--rc-app` / `runRcLaunch` | Intercepts `/v1/code/sessions/**` and serves a synthetic RC backend; default Anthropic inference tunnels other traffic onward, while Bedrock mode serves/synthesizes it locally | Reuse the synthetic RC half, then terminate the remaining inner API surface locally |
| `--rc-trace` / `runRcTrace` | Transparently forwards real Anthropic traffic and records redacted diagnostics | Research and compatibility capture only; never the runtime topology |
| `AnthropicRcClient` | Implements app-side list, history, SSE, and provider-native user-event POST with a bounded credential source | Reuse inside the outward connector after replacing its final credential lifecycle |

The current stable `--rc-app` baseline is narrower and fail-stop: before identity creation it resolves
the requested Claude launcher (`RC_CLAUDE_BIN` or `claude` on `PATH`) and requires its resolved target to be the exact
root:root regular mode-`0755` Claude Code
2.1.237/Linux arm64 executable,
331,864,296 bytes with SHA-256
`a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177`, and holds that exact inode
through `/proc` from the compatibility probe until child exit so an atomic path replacement cannot
substitute it. The trusted installed proof separately refuses `RC_CLAUDE_BIN` and requests
`/usr/bin/claude`. Stable launch skips the dormant runtime owner; atomically
admits only current-epoch UUIDv4 events from the retained eight native types, terminally closing the
session on any invalid/colliding batch; returns `410` for every route under a closed `cse_*`; fences
every downstream mutation immediately before its first SSE write; and uses one cross-pump head-of-line
publisher that also orders native control side effects and whose first failure closes only that
session. Each durable-cursor request has a 70-second wall, each initial stream-header wait has a
20-second wall, an established SSE stream fails after 40 seconds without an actual byte, and the
server marks a healthy planned rotation with exact standalone `: rotate` 240 seconds after the response
body starts. That marker
is circuit-neutral while raw/unmarked EOF counts as failure. The entire logical post has a 65-second wall
covering chunks, sealing, fetch, backoff, and authoritative `409` retries, without replay after an
ambiguous timeout. The third consecutive inbound failure closes the `cse_*`. Only a clean absent-channel
completion or a newly admitted authenticated frame resets the count; misroutes, replays, authentication
failures, and other non-admissions do not, and owner-requested abort is exempt. These
facts prove bounded host delivery and projection behavior, not opaque application inside Claude.

The stable browser/host surface is selected only by exact harness
`{agent:"claude-code",mode:"rc"}` plus exact capabilities
`{structuredPermissions:false,status:true,controls:{interrupt:false,setModel:false,setMode:false,end:false},attachments:false}`.
Both sides admit only non-empty, non-slash text; permission/questions stay local, attachments and every
control are rejected/suppressed, and the stable relay refuses a non-durable broker. After live presence
begins, session close publishes canonical `session_terminal` on
`bus:presence-v2:<identity_id>` outside transcript HOL. Local and SQLite brokers make that session
fence absorbing; Workflow does so only within its current run/generation (and the stable Claude profile
rejects Workflow). The viewer permanently removes the old row, refuses later writes/announces, and
discloses that the final delivery/output tail may be incomplete. Ordinary announce 5xx remains
advisory; the fixed coordinate-free HTTP 410 JSON response carrying
`code:"channel_storage_lost"` from the identity bus proves permanent storage loss and synchronously
closes the Session. A bare 410 or that code on any other status is an ordinary broker error.

Relevant implementation is in:

- `packages/cli/src/host/rc/{launch,trace-run,mitm,session,relay}.ts`;
- `packages/cli/src/host/rc/anthropic/{client,transport,credentials}.ts`; and
- the secret-safe tracing tests in `packages/cli/src/host/rc/mitm-trace.test.ts` and
  `packages/cli/src/trace.test.ts`.

The current `ClaudeOAuthFileCredentialSource` assumes a separate native Claude owns OAuth refresh and
remote-claw only rereads a securely validated Linux file. That assumption would not hold if an optional
inner-Claude topology removed its real credential. Such a runtime would need a connector-owned
credential service, or an isolated official credential agent outside the inner runtime, for login,
refresh, rotation, revocation, and OS-specific secure storage.

The current synthetic private-RC path also has narrower delivery semantics than the parked design:

- `POST .../worker/events/delivery` adds the named downstream event to the in-memory ACK set. The
  Claude MITM separately marks every mutation immediately before its first SSE write attempt and never
  offers it to a later worker generation; only the genuine initialize handshake is reconnectable.
  Neither mechanism proves that Claude accepted the input into its native conversation, preserved the
  proposed source, or applied it in that order.
- The web `accepted` frame and user echo are published in one head-of-line unit before private-RC
  injection. It means that the current host assigned a projection sequence and published its receipt,
  not that Claude accepted the prompt.
- On an internal compatibility surface, a viewer permission choice is recorded as
  `permission_resolved` and removed from the relay's open set before its `control_response` is delivered
  to Claude. A direct TUI answer or native cancellation may already have won, so that record is the
  server's choice, not a native terminal result. Stable Claude 1.0 does not expose that answer path.
- The current MITM projection drops ordinary native-TUI user text, and the worker stream provides no
  history backfill. The current path therefore cannot reconstruct or prove the complete native
  local/remote order after restart.

These distinctions are current code truth. Any resumed connector work would have to add correlation and
native adjudication rather than rename any of those transport receipts as native acceptance.

## 3. Observed protocol facts

The observed Claude Remote protocol is HTTP/JSON plus SSE:

| Role | Operations | Credential |
|---|---|---|
| Host before bridge | Create/read session and request bridge | User OAuth bearer |
| Worker after bridge | Metadata/status, heartbeat, event POST, delivery ACK, worker SSE | Returned `worker_jwt` |
| App/client | List/read sessions, history, client SSE, client event POST | User OAuth bearer |

The endpoint map and captures are recorded in [Phase 0 Findings](phase0-findings.md) §4b and
[v2 Architecture](v2-architecture.md) §17. Manual testing on 2026-07-26 against Claude Code 2.1.218
also exercised registration, bridge, worker SSE, app list/history/post, and client-SSE reconnect.
Credential-adjacent raw captures were scanned and deleted, so that run is supporting evidence rather
than a reproducible fixture or release gate.

The evidence supports these constraints:

1. `worker_jwt` is a session-scoped worker credential, not app authority.
2. A second worker stream could supersede or race the active worker, so the final connector owns only
   one worker stream and fences its epoch.
3. App-side user-event POST is proven enough for a foundation, but control, attachment, lifecycle, and
   reconnect semantics still need sanitized fixtures and gated proofs.
4. Worker SSE does not provide a trusted full-history backfill. Client history/SSE are repair evidence,
   not the logical-chat source of truth.
5. The observed envelope distinguishes `source: "client" | "worker"`, but reliable controller
   attribution and a hard exclusive lease have not been observed.
6. Multiple app-side SSE connections are technically possible. That does not by itself prove ordering,
   deduplication, or busy-turn behavior across multiple writers.
7. The manual captures do not prove the stable join among a submitted UUID, provider acknowledgement,
   private worker delivery/echo, transcript row, inner `/v1/messages` request, and resulting native
   turn. That join would block a future writable outward-connector release; it is not a Claude 1.0
   blocker or an implementation detail to infer from matching text.

## 4. Parked outward-connector requirements

If this optional path is resumed, the real outward Claude connector would be a remote-claw component,
not a mode of inner Claude, and would have to:

- create or explicitly adopt the real outward `cse_*`;
- request bridge credentials and own worker epoch renewal/rebridge;
- maintain worker status, heartbeat, delivery acknowledgement, event POST, and worker SSE;
- maintain app-side history/SSE and user-event submission with a separately authorized OAuth role;
- commit credential-stripped ingress before delivery ACK or cursor advancement;
- commit local output before outward worker/app publication;
- preserve provider event, sequence, delivery, cursor, and epoch mappings without treating them as
  remote-claw primary keys;
- classify provider ingress under a durable source-event namespace independent of connector
  incarnation, retaining versioned reset-boundary coordinates, observations, canonical event records,
  and correlation evidence across reconnect;
- correlate one remote proposal or direct native observation across inner echo/execution, outward
  submission, provider observation, and provider-side read-back;
- keep private-RC transport delivery, native acceptance, native observation, and provider projection as
  separate states;
- stop ACK/cursor advancement when the coordinator control journal is unavailable;
- fail closed on unknown mutation shapes; and
- never expose a real provider credential or route to the inner Claude process or its tools.

The coordinator records command state separately from each delivery:

```text
server proposal:      received → queued/forwarded/rejected
provider ingress:     received → durable → transport_acked/cursor_advanced
private RC transport: not_started → started → worker_acked
                                    └───────────────→ outcome_unknown
native acceptance:   not_observed → accepted/rejected
                                  └──────────────→ outcome_unknown
Anthropic projection:
                      not_started → started → accepted → observed/rejected
                                            └──────────→ outcome_unknown
native turn/effects:  not_observed → running → completed/failed/interrupted/outcome_unknown
```

Anthropic receipt cannot fabricate host forwarding, and host forwarding cannot fabricate native
acceptance or provider replication. A private worker delivery ACK also cannot fabricate native
acceptance. A timeout after a provider or private-RC write begins is `outcome_unknown` until exact
native/provider reconciliation supplies positive evidence that resolves the result.

### 4.1 Official-origin input

1. Anthropic delivers an official-client event to the sole outward worker connector.
2. The connector records the credential-stripped envelope, provider coordinate, capability/epoch
   pins, and source-namespace classification evidence, then checks canonical source/correlation
   records across prior connector incarnations.
3. The per-chat actor creates a proposal only for a proven-new event. A replay links its prior command;
   collision or ambiguous boundary evidence records a recovery gap and creates no command.
4. Only a proposal this server chose to forward crosses the private inner RC façade. Native Claude
   then decides whether and when it applies.
5. Provider ingress transport ACK/cursor advances only after the protocol's required durable decision. It
   proves host receipt, not inner execution.
6. Server forwarding and native-delivery status project to remote-claw web. The real native TUI
   renders native session state directly. The existing Anthropic user item is not posted back to
   itself; a forwarded user representation may project to enabled non-source provider bindings.
7. Later native assistant/tool/result observations project through causal outboxes to every enabled
   binding, including the originating Anthropic binding.

### 4.2 Native-TUI and remote-claw-origin input

1. The person submits through Claude's real TUI and Claude applies its native local-input semantics.
2. The private RC/transcript observer records that native action when exposed, correlates it against
   existing remote proposals, and projects it outward. It never reflects it inward as a new command.
3. A web or other remote-claw collaborator submission enters through its authenticated source binding.
   The server orders/deduplicates it. It may queue or reject only when that binding can render the
   outcome faithfully; otherwise a writable binding preserves the typed native intent and forwards it
   promptly.
4. A forwarded proposal uses the one private RC collaborator connection. Claude arbitrates it against
   direct TUI input; positive native evidence, not the forwarding decision, establishes acceptance.
5. Each provider copy includes only facts its protocol can represent. Returning native/provider echoes
   correlate to existing proposals or native observations and never become new executions.

The optional target experience is Claude's normal keyboard-plus-Remote collaboration, with remote-claw
occupying the one remote role and multiplexing its server-side collaborators behind it. Draft editing,
cursor movement, rendering, busy/steer behavior, permissions, questions, controls, and reconnect remain
native. A second unclassified native writer cannot join until its semantics and source identity are
proven.

### 4.3 Native acceptance and permission adjudication

The private RC delivery ACK is only replay bookkeeping. The adapter advances a remote proposal to
native `accepted` only from a version-pinned, stable correlation that joins the proposal's write-ahead
attempt to Claude's own conversation evidence. The required correlation includes the submitted event
UUID, any worker delivery/echo, the transcript user row and native session UUID, the inner
provider-shaped request, and the resulting turn where those surfaces expose identifiers. Missing or
conflicting links remain `outcome_unknown`; text equality, timing, an RC delivery ACK, or later
assistant output alone is not sufficient. A reconnect must never redeliver an ACK-lost event merely
because the private transport cannot prove that Claude applied it.

Permissions and questions have three separate facts:

1. remote-claw chooses at most one response among its own remote collaborators;
2. that response may or may not cross the private RC boundary; and
3. Claude decides whether the remote response or a direct native-TUI action wins.

The server's chosen response is journaled before delivery, but every outward gate remains pending until
Claude emits a version-pinned terminal cancellation, answer, tool result, or equivalent native record.
A TUI-won or cancelled gate makes a later remote response stale. A lost response acknowledgement
becomes `outcome_unknown`; remote-claw does not send a contradictory second answer. Interrupt or
outside-client disconnect must not close a gate merely because remote-claw expects Claude to cancel it.
The gate closes only from native terminal evidence or after the old native process is positively
contained.

### 4.4 Detach, takeover, and process lifetime

Outside-client membership is independent of the private Claude attachment and native process. Closing
an official app stream, web connection, or other remote-claw collaborator removes only that outside
binding. It does not stop the inner Claude process, detach the real TUI, cancel an accepted local turn,
close the private RC service, or cancel the separately supervised inference connector.

A replacement private RC or coordinator epoch is not writable merely because it has a newer number.
Before takeover, every request admitted under the old epoch must be positively terminal, recorded as
`outcome_unknown` with the chat quarantined, or contained by stopping/fencing the old path so it cannot
still reach Claude. Only an explicit runtime-owner policy may terminate the inner process. Graceful
shutdown first fences new remote proposals, settles or records in-flight prompts, controls, gates, and
inference attempts, and then chooses keep-alive or terminate.

## 5. Privacy and security

The remote-claw broker can remain zero-knowledge because its frames stay clawsec-sealed. Anthropic
necessarily receives the provider-native copy that official Claude clients need: session metadata,
prompts, assistant/tool events, results, controls/status, and normal inference traffic selected for
Anthropic.

This is not transparent inner passthrough. The security boundary is:

- remote-claw's outward connector sees provider plaintext and holds provider credentials;
- the inner Claude process sees private façade traffic and synthetic credentials only;
- the host-local coordinator sees command plaintext and credential-stripped correlation evidence;
- the remote-claw cloud broker sees ciphertext plus routing metadata; and
- outward provider history makes a faithful provider-native representation available to official
  Anthropic clients; actual device rendering is not observable here.

The inner process tree cannot connect directly to provider endpoints or inherit a general proxy route
that bypasses the private façade. Ordinary tool egress is a separate policy and may remain available
for work such as package downloads or Git access, but it carries no provider credentials and cannot
be used as an unclassified provider fallback.

Attachments require a deliberate product choice. Official parity needs Anthropic's upload path and
therefore sends those bytes to Anthropic. Until that path is understood and tested, advertise
attachments as unsupported for the shared official-client replica rather than inventing a local-only
success.

Tracing must retain the current fail-closed redaction and file-safety posture. Every real-service proof
uses a session created specifically for the test, scans all retained artifacts for tokens, and commits
only sanitized fixtures/results.

## 6. Proof sequence required only if this work resumes

These would be proof gates for the optional outward connector, not CLI phases or Claude 1.0 gates:

1. **Retained pinned evidence.** Record the exact Claude Code version and binary hash, protocol epoch,
   sanitized request/response/SSE fixtures, and the probe that produced them. The existing 2026-07-26
   manual run was intentionally deleted and is supporting research only; prose and mocked shapes are
   not a reproducible release gate.
2. **Fake protocol connector.** Exercise registration, bridge, worker/app streams, ACKs, reconnect,
   expiry, and ambiguous writes against deterministic services. Include worker ACK before native
   application, native application followed by a lost worker ACK, reconnect redelivery, and a write
   whose response is lost after it may have crossed the boundary.
3. **Provider isolation.** Start a real inner Claude with only private RC/API façades. Socket tracing
   proves it and its descendants cannot contact Anthropic or read real provider credentials.
4. **Native-client substitution parity.** Pin Claude Code, capture its normal direct API/RC behavior,
   and compare the same binary behind the private façades for initialization, local editing/Submit,
   streaming, busy/steer, permissions, questions, controls, errors, and reconnect. Replay the same
   provider responses where possible; every unexplained state-machine difference fails.
5. **Single explicit real session.** A remote-claw-owned worker connector creates a test `cse_*`; one
   official client prompt reaches a fake or isolated inner engine only after journal commit.
6. **Brokered inference.** A real inner turn completes through the terminating local inference/API
   façade. Only the separately isolated remote-claw inference and outward Remote connectors open
   provider sockets; the inner process opens none.
7. **Multi-writer correlation.** One real native TUI and one remote-claw private RC collaborator race
   on the same Claude session while idle and busy. Behind remote-claw, viewer input and at least two
   official/custom clients have one deterministic server proposal stream. Claude's observed native
   order wins, and no echo or projection executes again. The fixture must prove the stable
   proposal/worker/transcript/inference/turn join without text matching.
8. **Permission and question first-winner.** Race a native-TUI answer, remote answer, native
   cancellation, interrupt, response loss, and reconnect in every relevant order. Claude's terminal
   gate state wins; the losing response is stale, no contradictory answer is sent, and an unresolved
   gate remains visible or explicitly orphaned rather than being closed by a server-side guess.
9. **Source-namespace recovery.** Across connector restart and forced provider-session replacement,
   old history retains its old namespace/command, only a coordinate proven beyond a versioned reset
   boundary may reuse a raw ID as new, and ambiguous/colliding ingress advances no ACK or cursor.
10. **Controls and attachments.** Add one proven verb family at a time; advertise unsupported
   capabilities as absent.
11. **Crash and lifecycle matrix.** Cover journal/actor, connector, inner process, link, host restart,
    OAuth rotation/revocation, worker JWT expiry/rebridge, epoch changes, archive, and history repair.
    Prove that outside disconnect and coordinator restart leave a direct-TUI turn and private inference
    alive; that old in-flight work is terminal, quarantined, or contained before a replacement epoch
    writes; and that keep-alive versus terminate is an explicit runtime-owner decision.

If this work resumes, no real inner/provider-writable outward-connector release may occur before gates
1–7. Passing the prompt matrix would permit an explicitly experimental connector release, not a
general-availability claim.

## 7. Open questions

1. Which registration metadata makes a remote-claw-owned worker/session indistinguishable enough for
   official Claude clients?
2. What exact response represents host queueing or rejection after Anthropic has received an official
   event? If none is faithfully visible in the official client, that binding cannot accept a hidden
   queue/reject policy.
3. What is the stable correlation among a submitted UUID, POST result, worker delivery/echo, transcript
   row, inner `/v1/messages` request, native turn, client history, and client SSE? This would block any
   future writable outward-connector release rather than being a deferred follow-up.
4. What are the reliable reconnect cursor and bounded-history-overlap rules?
5. How do worker JWT renewal, bridge replay, `worker_epoch`, archive, and successor-session lineage
   behave?
6. Which app-side shapes implement interrupt, model/mode, permission, and AskUserQuestion responses?
7. What is the upload API and its retention/privacy behavior?
8. Which version-pinned native record resolves a private-RC delivery ACK into accepted/rejected
   application without parsing ambiguous transcript text?
9. Which secure credential agent and OS stores should own login/refresh without sharing credentials
   inward?
10. What compatibility policy is acceptable for an undocumented, version-sensitive protocol?

The active delivery order is the [Claude 1.0 finish line](release-finish-line.md). This document retains
the optional connector's proof inventory only; the generalized runtime remains parked in the
[client-driven host design](client-driven-host-runtime.md).
