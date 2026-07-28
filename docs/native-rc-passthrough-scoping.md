# Native Claude Remote investigation: evidence for the brokered connector

**Status:** retained protocol and security research plus an implemented app-side
`AnthropicRcClient` foundation. The transparent passthrough design is rejected. There is no
`--rc-native-passthrough` flag or launch path.

The selected implementation is [Client-driven Host Runtime](client-driven-host-runtime.md). Its Claude
topology has two independent sides:

- the real inner Claude Code process sees only remote-claw's private synthetic RC/API façades and
  synthetic or no credentials;
- remote-claw separately owns an inference connector and the real outward Anthropic Remote
  worker/app connector.

The inner process never registers, bridges, or authenticates with Anthropic. Native Claude owns its
conversation and execution state. A small coordinator journal owns only command admission, order,
correlation, and delivery evidence; Anthropic session history proves only that the provider-side
representation is available, not that any particular official device rendered it.

## 1. Decision and boundary

The earlier proposal was to forward an inner Claude process's real RC worker traffic to Anthropic,
observe that traffic, and let remote-claw act as a peer app client. That topology is rejected because it
would:

- give the inner process a real provider session and provider-facing worker role;
- make Anthropic's accepted sequence the practical execution authority;
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
remote-claw's sole outward worker connection, are journaled and admitted, and only then cross the
private inner façade.

## 2. Current code baseline

Three existing pieces have different purposes:

| Piece | Current behavior | Role in selected design |
|---|---|---|
| `--rc-app` / `runRcLaunch` | Intercepts `/v1/code/sessions/**` and serves a synthetic RC backend; default Anthropic inference tunnels other traffic onward, while Bedrock mode serves/synthesizes it locally | Reuse the synthetic RC half, then terminate the remaining inner API surface locally |
| `--rc-trace` / `runRcTrace` | Transparently forwards real Anthropic traffic and records redacted diagnostics | Research and compatibility capture only; never the runtime topology |
| `AnthropicRcClient` | Implements app-side list, history, SSE, and provider-native user-event POST with a bounded credential source | Reuse inside the outward connector after replacing its final credential lifecycle |

Relevant implementation is in:

- `packages/cli/src/host/rc/{launch,trace-run,mitm,session,relay}.ts`;
- `packages/cli/src/host/rc/anthropic/{client,transport,credentials}.ts`; and
- the secret-safe tracing tests in `packages/cli/src/host/rc/mitm-trace.test.ts` and
  `packages/cli/src/trace.test.ts`.

The current `ClaudeOAuthFileCredentialSource` assumes a separate native Claude owns OAuth refresh and
remote-claw only rereads a securely validated Linux file. That assumption does not hold when the inner
Claude has no real credential. The selected runtime needs a connector-owned credential service, or an
isolated official credential agent outside the inner runtime, for login, refresh, rotation, revocation,
and OS-specific secure storage.

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

## 4. Selected outward-connector requirements

The real outward Claude connector is a remote-claw component, not a mode of inner Claude. It must:

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
- correlate one host command across local proposal, inner echo/execution, outward submission, provider
  observation, and provider-side read-back;
- stop ACK/cursor advancement when the coordinator control journal is unavailable;
- fail closed on unknown mutation shapes; and
- never expose a real provider credential or route to the inner Claude process or its tools.

The coordinator records command state separately from each delivery:

```text
command:           proposed → queued/admitted/rejected
provider ingress:  received → durable → transport_acked/cursor_advanced
inner delivery:    not_started → started → accepted → observed/rejected
                                  └──────────────────→ outcome_unknown
Anthropic projection:
                   not_started → started → accepted → observed/rejected
                                         └──────────→ outcome_unknown
native turn:       running → completed/failed/interrupted/outcome_unknown
```

Anthropic receipt cannot fabricate host admission, and host admission cannot fabricate provider
replication. A timeout after a provider write begins is `outcome_unknown` until history/SSE
reconciliation supplies positive evidence that resolves the result.

### 4.1 Official-origin input

1. Anthropic delivers an official-client event to the sole outward worker connector.
2. The connector records the credential-stripped envelope, provider coordinate, capability/epoch
   pins, and source-namespace classification evidence, then checks canonical source/correlation
   records across prior connector incarnations.
3. The per-chat actor creates a proposal only for a proven-new event. A replay links its prior command;
   collision or ambiguous boundary evidence records a recovery gap and creates no command.
4. Only an admitted command crosses the private inner RC façade.
5. Provider ingress transport ACK/cursor advances only after the protocol's required durable decision. It
   proves host receipt, not inner execution.
6. The command status projects to the local UI and remote-claw web. Its existing Anthropic user item
   is not posted back to itself; an admitted user representation may project to enabled non-source
   provider bindings.
7. Later native assistant/tool/result observations project through causal outboxes to every enabled
   binding, including the originating Anthropic binding.

### 4.2 Local or remote-claw-origin input

1. The host commits a stable command, admission result, and causal projection outbox item.
2. If admitted, it delivers the command inward without waiting for Anthropic; queued/rejected commands
   do not cross the inner mutation path.
3. It publishes the Anthropic representation independently when admitted and records that binding's
   outward delivery state. Other enabled outward bindings receive their own ordered projections.
4. The private inner echo and every returning provider echo correlate to the existing command rather than
   becoming new executions.
5. The local UI and remote-claw web project the complete order/delivery status. Each provider copy
   includes only facts its protocol can represent.

In the client-driven structured mode, the inner PTY is display-only and a wrapper-owned local UI uses
the coordinator command path, so the actor can commit and admit writes before private delivery. A
separate raw-PTY debugging mode cannot join or mutate the shared logical chat.

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

## 6. Required proof sequence

These are proof gates, not CLI phases:

1. **Fake protocol connector.** Exercise registration, bridge, worker/app streams, ACKs, reconnect,
   expiry, and ambiguous writes against deterministic services.
2. **Provider isolation.** Start a real inner Claude with only private RC/API façades. Socket tracing
   proves it and its descendants cannot contact Anthropic or read real provider credentials.
3. **Single explicit real session.** A remote-claw-owned worker connector creates a test `cse_*`; one
   official client prompt reaches a fake or isolated inner engine only after journal commit.
4. **Brokered inference.** A real inner turn completes through the terminating local inference/API
   façade. Only the separately isolated remote-claw inference and outward Remote connectors open
   provider sockets; the inner process opens none.
5. **Multi-writer correlation.** Local structured input, remote-claw viewer input, and at least two
   official/custom clients race while idle and busy with one deterministic host admission stream and
   no duplicate execution.
6. **Source-namespace recovery.** Across connector restart and forced provider-session replacement,
   old history retains its old namespace/command, only a coordinate proven beyond a versioned reset
   boundary may reuse a raw ID as new, and ambiguous/colliding ingress advances no ACK or cursor.
7. **Controls and attachments.** Add one proven verb family at a time; advertise unsupported
   capabilities as absent.
8. **Crash and lifecycle matrix.** Cover journal/actor, connector, inner process, link, host restart,
   OAuth rotation/revocation, worker JWT expiry/rebridge, epoch changes, archive, and history repair.

No real inner/provider-writable release occurs before gates 1–4. Passing the prompt matrix permits an
explicitly experimental release, not a general-availability claim.

## 7. Open questions

1. Which registration metadata makes a remote-claw-owned worker/session indistinguishable enough for
   official Claude clients?
2. What exact response represents host queueing or rejection after Anthropic has received an official
   event?
3. What is the stable correlation among a submitted UUID, POST result, worker delivery/echo, client
   history, and client SSE?
4. What are the reliable reconnect cursor and bounded-history-overlap rules?
5. How do worker JWT renewal, bridge replay, `worker_epoch`, archive, and successor-session lineage
   behave?
6. Which app-side shapes implement interrupt, model/mode, permission, and AskUserQuestion responses?
7. What is the upload API and its retention/privacy behavior?
8. Can the inner Claude `/v1/messages` request be correlated to the structured local command delivered
   through private RC without parsing ambiguous transcript output?
9. Which secure credential agent and OS stores should own login/refresh without sharing credentials
   inward?
10. What compatibility policy is acceptable for an undocumented, version-sensitive protocol?

The actionable delivery order is in the
[Client-driven Host Runtime delivery plan](client-driven-host-runtime.md#delivery-plan).
