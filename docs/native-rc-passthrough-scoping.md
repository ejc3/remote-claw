# Native Claude Remote coexistence — smallest viable experiment

**Status:** structured text slice implemented on Linux for exact Claude Code 2.1.237; M1 incomplete.
The 2026-08-30 bounded run proved the local TUI, an authenticated Anthropic RC API client, and two
simultaneous remote-claw browsers on one native session. Literal official Claude app UI validation and
the Graduate restart/broker-loss/log/install/deployment gates remain open.

The product goal is one normal Anthropic-hosted `claude --remote-control` session that remains usable
from the local TUI and official Claude client while remote-claw browsers observe the same history and
can submit text. The default `--rc-app … --rc-driver=mitm` path does not provide that: it replaces
Anthropic's RC endpoints with remote-claw's encrypted broker, so Anthropic and the official client never
see the session.
`--rc-trace` preserves the native Anthropic session and official-client control, but it is a passive
inspector.

The implemented path is deliberately smaller than the previously proposed private-inner/outward-worker
coordinator. Claude stays connected to Anthropic normally while one host-side app client mirrors the
native session into remote-claw.

## 1. Selected topology

```text
local TUI ───────────────┐
official Claude client ──┼── Anthropic Remote Control session
                         │              ▲
                         │              │ history / SSE / user-event POST
                         └──── host-side AnthropicRcClient
                                        │
                                        │ encrypted remote-claw frames
                                        ▼
                              zero-knowledge broker
                                        │
                              remote-claw browsers
```

The experiment has no synthetic inner RC backend, outward worker, private worker epoch, inference
façade, or generalized collaboration coordinator. Anthropic remains the native session's sync service
and sees the plaintext required by its normal product. The remote-claw broker still sees only
clawsec-sealed frames and routing metadata.

One host-side bridge:

1. identifies the exact `cse_*` created by the normal local Claude process;
2. opens and validates live updates with `AnthropicRcClient.streamEvents`;
3. loads bounded ascending history with `AnthropicRcClient.history` while that stream remains open;
4. projects supported transcript events into the existing encrypted remote-claw session;
5. accepts text from remote-claw viewers; and
6. submits each admitted text event once with `AnthropicRcClient.postEvent`.

The bridge starts in `starting`. It may publish neither presence nor a writable browser session until
the exact native ID, history/SSE capture, credential source, capability snapshot, and mutation path are
ready. Readiness is one atomic lifecycle transition; cancellation or setup failure prevents a late
publish. This is a small helper contract, not a durable coordinator or a class-name commitment.

The bridge does not pretend to be Anthropic's worker. Native Claude and Anthropic remain responsible
for official ordering, rendering, busy-state behavior, and local/official-client coexistence.

## 2. Current code truth

| Piece | What exists now | What is missing |
| --- | --- | --- |
| `--rc-app` / `runRcLaunch` | A synthetic RC backend bridged to the encrypted broker; durable, text-only, fail-stop supported path | Anthropic registration and official-client coexistence |
| `--rc-trace` / `runRcTrace` | Transparent pass-through to Anthropic with redacted protocol tracing | Projection to the broker and remote mutation |
| `--rc-app … --rc-driver=claude-native --remote-control` | Exact successful-bridge binding, live-SSE-before-history reconciliation, provider-ordered text projection/injection, fail-stop writes, and a truthful all-controls-off viewer tuple | Literal official-app UI validation plus Graduate restart/broker-loss/log/install/deployment evidence |
| `--rc-driver=tmux` plus Claude's `--remote-control` | One bounded lower-fidelity run preserved the provider session while a local pane, Anthropic API client, and two browsers exchanged text | Structured event semantics, independent peer ordering, supported-version matrix, and official Claude app UI acceptance |
| `AnthropicRcClient` | Typed session listing, bounded history with `next_cursor`/`resume_cursor`, client-side SSE readiness, and one-user-event POST | Cross-platform credential sources and any later control semantics |
| OAuth source | Secure Linux read-only access to Claude's existing credential file; native Claude owns refresh | A supported cross-platform credential source |

The client preserves unknown SSE records rather than inventing semantics, bounds response and event
sizes, sanitizes errors, and marks a write as outcome-unknown when it may have crossed the network
without a canonical acknowledgement. The companion uses those properties for the structured text
path; they still do not prove the literal official-app outcome or Graduate recovery claims.

## 3. Safety boundary

The experiment must keep these invariants:

- OAuth credentials stay on the host. They never enter broker frames, browser state, argv, diagnostics,
  or model-visible tool environments.
- Native Claude continues to own credential refresh. The bridge rereads the secure credential source
  and does not write or rotate Claude's credential file.
- Each browser submission receives one caller-generated UUID and timestamp. They are never regenerated
  for the same logical send.
- A rejected or potentially completed write fences the remote projection. It is never automatically
  retried or converted into a second command; outcome-unknown remains distinct from rejection.
- History/SSE event dedup uses provider event identity and sequence. The one narrow logical-prompt
  exception correlates opposite-source client/worker replicas by the provider's user UUID and normalized
  text, never timing; attachment-bearing replicas remain non-projectable.
- Unknown event/control/attachment shapes are retained for diagnosis or ignored for projection; they
  are not guessed into supported actions.
- The remote-claw broker remains zero-knowledge. Anthropic is not zero-knowledge: it receives native
  session metadata, prompts, assistant/tool output, results, and any other content the normal Claude
  product sends.
- Disconnecting one browser, the official client, or the bridge must not terminate the local Claude
  process or the other surfaces.

For the first vertical, remote-claw submits non-empty, non-slash text only. Permissions, questions,
interrupt, model/mode changes, attachments, archive, and other control verbs remain unsupported until
their native app-client semantics are captured and tested.

## 4. Session selection and reconciliation

Session identity is explicit before the bridge publishes or writes. The transparent proxy binds only
after the spawned child completes a successful canonical
<code>POST /v1/code/sessions/{cse_*}/bridge</code>. It does not inspect the body/JWT and never chooses a
session by newest timestamp, title, or transcript text. A second different successful bridge closes
only the projection.

The current implementation keeps in-process recovery simple:

1. open one client SSE stream before reading history, closing the snapshot gap;
2. page bounded ascending history using the provider's opaque <code>next_cursor</code> or
   <code>resume_cursor</code> and publish unseen canonical events;
3. drain the already-open live stream; on EOF or a read failure, open a new stream before reconciling
   history again;
4. deduplicate exact provider event IDs and narrowly collapse opposite-source user replicas by provider
   UUID plus normalized text;
5. stop the writable path if ordering, identity, or cursor continuity cannot be established; and
6. never use an uncertain read cursor as evidence that an uncertain write did not happen.

An SSE reconnect inside one running companion retains that companion's projection and reconciles from
provider history. Companion process restart is a Graduate contract, not current behavior: a later
process must create a fresh random remote-claw projection ID for the same exact native
<code>cse_*</code>, backfill its history as observation once, and attempt to leave the prior projection
terminal after a clean stop. If terminal publication cannot complete, or after an unclean stop, the
prior projection ages stale. The new process must consume no retired-projection command or repeat any
prior browser mutation. Stable same-row identity across companion processes remains deferred.

Fresh projection identity is required by the current lifecycle, not a cosmetic row choice: terminal is
absorbing for a broker session ID, and reusing an old ID could create an unannounced command consumer
known to an old viewer. Provider coordinates deduplicate history/SSE observation only; every new
projection owns a fresh sequence/message-ID space, and only commands admitted on that projection may
call <code>postEvent</code>. A provider acknowledgement ID may differ from the submitted caller UUID, so
uncertain-write correlation must be demonstrated against native history; otherwise the result remains
unknown and is not resent.

Remote-claw's projected sequence is a viewer ordering coordinate, not a claim that Anthropic or Claude
executed an event. Provider acknowledgement, provider history observation, and browser projection stay
distinct facts.

## 5. Acceptance test and current evidence

The 2026-08-30 local production-build run passed the local TUI, two simultaneous browsers, browser A/B
text, and authenticated provider-client API text on one exact native session. Each label was answered
and rendered once in both browsers. A literal official Claude web/mobile UI was not authenticated in
the isolated test browser, so that required claim remains open. Fresh-projection companion restart and
the other Graduate items were not part of this first run.

The experiment is successful only when one ordinary Anthropic RC session demonstrates all of the
following in one bounded run:

- the local TUI stays interactive;
- the official Claude client can observe and submit;
- two remote-claw browsers show the same ordered history;
- each remote-claw browser can submit labeled text;
- each submitted label appears exactly once in Anthropic history and both remote-claw views;
- local-TUI and official-client submissions appear in both remote-claw views without being re-executed;
- reload/reconnect catches up without gaps or duplicate projections;
- restarting only the companion creates one fresh projection of the same native session, backfills once,
  consumes no command from the retired projection, and repeats no native mutation;
- disconnecting any one surface leaves the others alive; and
- credentials and plaintext do not appear in broker storage or logs.

Use a deterministic fake transport for parsing, ordering, reconnect, duplicate, and ambiguous-write
boundaries. Use one real logged-in Claude/official-client/browser smoke for the coexistence outcome.
Bind a deployed smoke to the expected immutable SHA and intended durable backend. Do not build a receipt
chain, scan provider fleets, attest host tools, or expand the first smoke into permissions and controls.

## 6. Decision after the experiment

The direct app-client path is the basis for the coexistence product; the current `--rc-app` replacement
mode remains a separate private-relay option. Do not promote M1 to complete until the remaining
acceptance items in §5 pass.

Escalate to a larger outward-worker/coordinator architecture only if a demonstrated product requirement
cannot be met through the normal Anthropic session. Examples might include a required action absent from
the app-client API or a proven ordering/recovery ambiguity that cannot fail closed acceptably. If that
happens, record the concrete failure and design only the minimum additional state needed to resolve it.

## 7. Remaining questions

1. Can a literal logged-in official Claude web/mobile client complete the same four-surface run?
2. What is the smallest attach or persistent-owner design that can create a fresh projection for the
   same still-live native <code>cse_*</code> after companion restart without guessing a session?
3. Which additional native action, if any, should graduate after text? No control is added until its
   provider semantics and failure boundary are captured.

The historical protocol endpoint map and original direct-client observation remain in
[Phase 0 Findings](phase0-findings.md) §4b. The full multi-agent goal and later adapter milestones are
in [Product goal and release gates](release-finish-line.md).
