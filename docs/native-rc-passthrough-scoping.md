# Native Claude Remote coexistence — smallest viable experiment

**Status:** selected structured-fidelity milestone; **not implemented**. The bounded M0 tmux experiment
in [Product goal and release gates](release-finish-line.md) passed on 2026-08-24, establishing a cheaper
lower-fidelity multi-surface baseline through the Anthropic Remote API. This design now owns only the
structured fidelity and official-app UI acceptance that M0 did not prove.

The product goal is one normal Anthropic-hosted `claude --remote-control` session that remains usable
from the local TUI and official Claude client while remote-claw browsers observe the same history and
can submit text. Current `--rc-app` does not provide that: it replaces Anthropic's RC endpoints with
remote-claw's encrypted broker, so Anthropic and the official client never see the session.
`--rc-trace` preserves the native Anthropic session and official-client control, but it is a passive
inspector.

The next step is deliberately smaller than the previously proposed private-inner/outward-worker
coordinator. Leave Claude connected to Anthropic normally and add one host-side app client that mirrors
the native session into remote-claw.

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
2. loads bounded ascending history with `AnthropicRcClient.history`;
3. follows live updates with `AnthropicRcClient.streamEvents`;
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
| `--rc-driver=tmux` plus Claude's `--remote-control` | One bounded lower-fidelity run preserved the provider session while a local pane, Anthropic API client, and two browsers exchanged text | Structured event semantics, independent peer ordering, supported-version matrix, and official Claude app UI acceptance |
| `AnthropicRcClient` | Typed session listing, bounded history, client-side SSE, and one-user-event POST | A production sidecar/projector, session selection, reconnect reconciliation, and viewer wiring |
| OAuth source | Secure Linux read-only access to Claude's existing credential file; native Claude owns refresh | A supported cross-platform credential source |

The client preserves unknown SSE records rather than inventing semantics, bounds response and event
sizes, sanitizes errors, and marks a write as outcome-unknown when it may have crossed the network
without a canonical acknowledgement. Those properties and M0 establish a seam and lower-fidelity
topology, not the structured path or official-app outcome claimed by this milestone.

## 3. Safety boundary

The experiment must keep these invariants:

- OAuth credentials stay on the host. They never enter broker frames, browser state, argv, diagnostics,
  or model-visible tool environments.
- Native Claude continues to own credential refresh. The bridge rereads the secure credential source
  and does not write or rotate Claude's credential file.
- Each browser submission receives one caller-generated UUID and timestamp. They are never regenerated
  for the same logical send.
- A known rejection may be shown as rejected. A timeout, network loss, malformed acknowledgement, or
  other potentially completed write is **outcome unknown** and is not automatically retried.
- History/SSE dedup uses provider event identity and sequence, never text or timing.
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

Session identity must be explicit before the bridge publishes or writes. The implementation may obtain
the exact `cse_*` from a transparent launch observation or from a bounded list-and-confirm flow, but it
must not choose a session by title or transcript text.

The first implementation should keep recovery simple:

1. read ascending history and publish unseen canonical events;
2. open one client SSE stream;
3. on EOF or a read failure, reopen history from the last accepted provider coordinate and reconcile;
4. deduplicate exact provider event IDs;
5. stop the writable path if ordering, identity, or cursor continuity cannot be established; and
6. never use an uncertain read cursor as evidence that an uncertain write did not happen.

Remote-claw's projected sequence is a viewer ordering coordinate, not a claim that Anthropic or Claude
executed an event. Provider acknowledgement, provider history observation, and browser projection stay
distinct facts.

## 5. Acceptance test

The experiment is successful only when one ordinary Anthropic RC session demonstrates all of the
following in one bounded run:

- the local TUI stays interactive;
- the official Claude client can observe and submit;
- two remote-claw browsers show the same ordered history;
- each remote-claw browser can submit labeled text;
- each submitted label appears exactly once in Anthropic history and both remote-claw views;
- local-TUI and official-client submissions appear in both remote-claw views without being re-executed;
- reload/reconnect catches up without gaps or duplicate projections;
- disconnecting any one surface leaves the others alive; and
- credentials and plaintext do not appear in broker storage or logs.

Use a deterministic fake transport for parsing, ordering, reconnect, duplicate, and ambiguous-write
boundaries. Use one real logged-in Claude/official-client/browser smoke for the coexistence outcome.
Bind a deployed smoke to the expected immutable SHA and intended durable backend. Do not build a receipt
chain, scan provider fleets, attest host tools, or expand the first smoke into permissions and controls.

## 6. Decision after the experiment

If this direct app-client path satisfies the acceptance test, it becomes the basis for the coexistence
product and the current `--rc-app` replacement mode can remain a separate private-relay option.

Escalate to a larger outward-worker/coordinator architecture only if a demonstrated product requirement
cannot be met through the normal Anthropic session. Examples might include a required action absent from
the app-client API or a proven ordering/recovery ambiguity that cannot fail closed acceptably. If that
happens, record the concrete failure and design only the minimum additional state needed to resolve it.

## 7. Open questions for the bounded experiment

1. What is the least ambiguous way to bind the sidecar to the newly launched `cse_*` without title or
   text matching?
2. What stable history overlap/cursor rule is sufficient after client-SSE EOF?
3. Does a caller UUID reliably appear in canonical history for acknowledged and duplicate user-event
   posts?
4. How does the native product represent simultaneous local, official-client, and app-client text while
   Claude is busy?
5. Which non-user SSE records must be projected for a truthful text-only transcript?
6. What user-facing state best communicates an outcome-unknown send without encouraging a duplicate?

The historical protocol endpoint map and original direct-client observation remain in
[Phase 0 Findings](phase0-findings.md) §4b. The full multi-agent goal and later adapter milestones are
in [Product goal and release gates](release-finish-line.md).
