# Durable Log Design for remote-claw

This design treats the adapter-local RC store as the durable private remote-control
protocol server of record, not as the owner of the semantic native conversation
or canonical logical-chat identity. The remote-claw server remains authoritative for
stable logical-chat identity and collaborator proposal order. The broker/Turso frame log is still the
durable viewer transport, but it is not enough to reconstruct Claude remote-control server
state: the wrapper must durably store RC event ids, RC sequence numbers,
worker epochs, downstream delivery state, and compaction boundaries before it
can safely accept resume/re-bridge after restart.

The older transcript-first direction in `PLAN.md` is superseded for this
purpose. Historical investigations reported that local Claude JSONL exposed
`/compact` summaries but fresh `claude --remote-control` sessions did not write
a complete local transcript and `--remote-control --resume <U>` did not replay
prior history to a fresh accepting server. Those behaviors remain gates below,
not tracked guarantees. The design therefore makes the durable MITM log the
primary source of truth for private RC protocol state rather than relying on
local transcript completeness or replay.

> **Scope update (2026-07-26):** this document remains the detailed storage plan for the current
> synthetic Claude RC server. [Client-driven Host Runtime](client-driven-host-runtime.md) narrows the
> future coordinator journal to its direct remote collaborators' proposal order, forwarding decisions,
> correlation, delivery, and recovery evidence. Direct TUI input stays on the native path.
> Native Claude/Codex/OpenCode state owns conversation context, final local/remote interleaving, and
> completed execution; the provider transport owns the representation it accepted and can read back,
> not proof of what a particular device rendered. This document's full RC log remains relevant to the
> current synthetic server, not a universal semantic authority.

## Source Map

- Local investigation notes used while drafting this design are **not tracked in
  this repository and are unavailable as reproducible evidence**:
  `codex-findings.md` (initial harness/transcript behavior),
  `bridge-findings.md` (bridge and controller input),
  `lifecycle-findings.md` (resume/re-bridge),
  `compact-findings.md` (compact behavior), `qa-findings.md` (event order and
  idempotency), `edges-findings.md` (worker/lifecycle edges), and
  `parallel-findings.md` (passthrough and history behavior). Claims below must
  be checked against tracked code, tests, and sanitized captures rather than
  treating these unavailable note names as repository sources.
- Current code: `packages/cli/src/host/rc/{mitm,session,relay,launch}.ts`,
  `packages/cli/src/host/rc/drivers/{bridge,legacy-registrar}.ts`,
  `packages/cli/src/host/native/adapter.ts`,
  `packages/cli/src/host/rc/anthropic/*.ts`,
  `packages/cli/src/broker/{client,protocol,order}.ts`, and
  `apps/web/lib/broker/{backend,local,vercel,sqlite-multi,turso-cloud-locator}.ts`.
- The A1/A2 branch names and table snapshots later in this document record the
  historical review basis. The durable broker backends have since landed;
  re-check current migrations/code before implementing a dependent host schema.

## Protocol Baseline and Historical Claims

The tracked endpoint and event-envelope baseline is summarized in
`docs/phase0-findings.md` §4b and `docs/v2-architecture.md` §17. The lifecycle,
collision, compact, and replay statements explicitly labeled as historical
claims below came from the unavailable local investigation notes listed in the
Source Map. They are design inputs to re-verify through the gates in this
document, not reproducible repository facts or current implementation
guarantees.

**Historical investigation claim — bridge formation.** A bridge trace
reportedly showed `POST /v1/code/sessions`, then `/bridge`, then
`/worker/events/stream` and worker heartbeat before an empty trigger poll could
matter. Remote-claw relay should not rely on trigger polling to discover or
revive sessions until that ordering is re-verified. The narrower tracked
endpoint surface is summarized in `docs/phase0-findings.md` §4b.

**Historical investigation claim — identity aliases.** The wire and transcript
identity was `cse_<suffix>`, while a live worker registry also used
`session_<suffix>` with the same suffix; resume/re-bridge reportedly kept the
same `cse_`. Current `mitm.ts` works in `cse_` terms for
`/v1/code/sessions/{sid}/...`. Durable storage should keep `cse_session_id` as
the canonical key **inside this private RC transport store only**. It is not the
remote-claw logical chat ID or Claude's native transcript/resume identity. Any
`session_alias` derivation must wait for a tracked fixture or gated
re-verification.

**Historical investigation claim — local transcript completeness.** Fresh
remote-control turns reportedly wrote only incomplete title/stub rows locally,
while normal non-RC Claude wrote full local JSONL in real time. The tracked RC
wire evidence independently establishes that the worker does not backfill
history ([Protocol & Runtime §12](protocol.md#12-convergence-failure-modes)), so local JSONL must not
be assumed to be the remote-claw server log; its exact compact role still needs the Phase B4 gate.

**Historical investigation claim — resume/re-bridge.** When
`claude --remote-control --resume <U>` reconnects to a server that accepts the
same `cse_` but has no history, Claude does not replay its prior conversation.
The bridge body is `{}`, there is no `POST /v1/code/sessions`, and no historical
payload is sent to the worker server. The wrapper must already have the
history if gated re-verification confirms this behavior. The narrower tracked
fact is that worker bridge/SSE does not provide history
([Protocol & Runtime §12](protocol.md#12-convergence-failure-modes)).

**Unverified client reconnect claim.** Historical traces suggested
`lastSequenceNum`, `from_sequence_num`, or `Last-Event-ID` on client-side
`/events/stream`, not worker bridge recovery. None is a verified production
contract. The implemented client therefore sends none of them; caller-driven
history pagination is the only current primitive, and the outward-connector reconnect gate in
[Client-driven Host Runtime proof gates](client-driven-host-runtime.md#proof-gates) must establish any
cursor.

The tracked client POST shape returns `duplicate`, `event_id`, and
`sequence_num` (`docs/phase0-findings.md` §4b). A historical replay experiment
reported that reposting the exact same body returned `duplicate:true` with the
original identity. The durable server API should therefore use an idempotent
upsert keyed by `(cse_session_id, event_id)`, but the exact duplicate replay
behavior remains a gate rather than a repository-proven service guarantee.

Downstream user input and upstream user echo are the same logical event when
they share an event id. The viewer transcript must merge those records instead
of rendering the downstream user message and the worker echo as two user turns.
Delivery acknowledgements are separate durable state, not transcript messages.
This is a projector invariant for the selected host-runtime Claude correlation gate.

**Historical investigation claim — interrupt.** Pressing escape during a
turn produced one empty successful result event after the user event, with no
assistant content and no `control_cancel`. The log must accept result-only turn
boundaries regardless; the exact interrupt shape needs the interrupt gate.

**Historical investigation claim — worker epoch.** Plain SSE reconnect did not
bump `worker_epoch`; bridge/re-bridge did. With two workers on one `cse_`, the
newer epoch was accepted and stale epoch writes were rejected in the local
investigation. The durable log should keep only accepted writes as canonical
while recording rejected stale attempts as diagnostics if desired; Phase B3
must re-verify the fence.

**Historical investigation claim — close/archive.** `/exit` behaved like
ordinary downstream input followed by archive/close side effects; the bridge
REPL did not support an explicit `end_session` control. Closed sessions could
later resume/re-bridge on the same `cse_`, bump epoch, and continue. The design
treats archive as metadata rather than hard delete, subject to the Phase B5
gate.

The current viewer-facing behavior is narrower and matches that protocol limit: authenticated viewer
`end` is consumed by `HostRcRelay`, clears open relay permission gates, and emits no `end_session` or
native-session termination. Claude MITM host teardown instead aborts each registrar lease's own relay
controller; ordinary lease close does not own or close the native `Session`.

**Historical investigation claim — compact.** Local and remote compact
experiments showed no server-side reset event; the server saw an empty
successful result, while the compact summary appeared only in local JSONL as
an `isCompactSummary:true` row. The wrapper must synthesize its own compact/reset
record if viewers should truncate to the summary, after Phase B4 re-verifies
the behavior.

Transparent passthrough/tap was investigated but is no longer the selected topology.
**Historical investigation claim — parallel tap.** A parallel trace reportedly
showed a mode where Claude remained bridged to real Anthropic while remote-claw
observed/relayed a sealed copy. In that mode viewer prompts **must** use the real
client `POST /v1/code/sessions/{id}/events` path; a downstream tee is
observation-only and must never inject or mirror viewer input. Anthropic client
history/SSE is a reconciliation and repair source, not the primary relay-mode
durability plan or the future logical-chat authority; exact cursor semantics
still require a gated proof. The original `parallel-findings.md` note is
unavailable; the tracked client API evidence is in
`docs/phase0-findings.md` §4b.

## Design Position

Use two durable logs with different trust and replay roles:

1. RC server event log: **cleartext, host-owned, kept LOCAL on the host** (SQLite/libSQL under the CLI
   config dir). Nothing on the host needs encryption — it is the user's own machine, with no
   zero-knowledge requirement — and this log is **never sent to the broker**. It is the authoritative
   server state for `mitm.ts` and `session.ts`. It stores canonical RC event ids, RC sequence numbers,
   raw event bodies, downstream delivery state, worker epoch, close/archive metadata, and compact
   boundaries. This log is required even when no viewer is connected.

2. Broker frame log: sealed viewer transport, already started by A1 Turso
   `frames`. It stores encrypted `WireFrame` JSON and cleartext routing columns
   such as token, generation, message id, part, and broker sequence. It serves
   remote-claw viewers and catch-up. It should not be treated as the RC server
   state because the broker should not need plaintext RC payloads and because
   broker frames do not capture worker delivery acknowledgements or exact
   `/worker/events` duplicate response semantics.

The RC event log projects into the broker frame log. Projection is idempotent:
an accepted RC event can create zero or more rendered viewer parts, each with a
deterministic broker message id derived from the RC event id and part index.
The raw RC order remains `(sequence_num, part_index)`; broker `seq` remains a
dense viewer-order cursor because the viewer-side `FrameOrderer` treats `seq` as
the viewer stream order and chunk parts as fragments of one same-kind message.

For the future host runtime, this RC-specific schema remains an adapter-local private-Claude transport
store alongside the narrow coordinator control journal; it does not become the semantic transcript.
The journal's `command_seq` is the definitive decision order for proposals that remote-claw server
received from its direct collaborators, including forwarded, queued, and rejected decisions. Only the
forwarded subset is offered inward in that order; `command_seq` neither orders direct native-TUI
actions nor replaces the native harness's final applied interleaving. Rebuildable projection
`chat_seq`, Claude `sequence_num`, Codex thread/turn/item IDs, and broker `seq` are mappings/cursors in
their separate domains. An adapter or provider incarnation may be replaced without changing
`logical_chat_id`.

The durable identity join is:

```text
logical_chat_id                     remote-claw's canonical user chat
└── native_binding_id               binding to the proven semantic Claude conversation
    ├── native incarnation history  exact Claude process generations
    └── rc_attachment_id            one private RC transport generation
        └── cse_session_id           canonical only within the RC event/worker tables below
            └── worker_epoch         lease to one native incarnation + coordinator epoch
```

Claude's proven transcript/resume UUID belongs to the native binding's
`conversationId`; it must never be inferred from or replaced by `cse_session_id`.
On recovery the coordinator first reuses a known, complete `cse_session_id` and
starts a new worker epoch tied to the current native incarnation and coordinator
epoch. The attachment belongs to the native binding, not to one process
incarnation, so a cold native resume can reuse the same `cse_session_id`. A new
`cse_session_id` is allowed under the same `logical_chat_id` only through a
durable, proof-carrying RC-attachment replacement: preserve and supersede the
old attachment, bind the replacement to the exact logical chat/native binding,
and record the recovery evidence plus any explicit history gap. A gap records
missing evidence; it does not by itself prove that the old attachment can no
longer accept writes. Merely seeing an unknown `cse_*`, losing process memory,
or reconnecting a client is not replacement proof and never creates a new
logical chat.

## Data Model

The A1 Turso frame table inspected on `feat-turso-broker-catchup` is:

```sql
CREATE TABLE IF NOT EXISTS channels (
  token       TEXT PRIMARY KEY,
  gen         INTEGER NOT NULL DEFAULT 0,
  closed      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS frames (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL,
  gen         INTEGER NOT NULL,
  seq         INTEGER,
  msg_id      TEXT,
  part        INTEGER,
  frame       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (token, gen, msg_id, part)
);

CREATE INDEX IF NOT EXISTS frames_token_gen_id ON frames (token, gen, id);
```

Keep this table as the sealed viewer transport. Add host-owned RC tables in a **LOCAL** SQLite/libSQL
database under the CLI config directory, in **cleartext** — nothing on the host needs encryption, and
the broker never holds RC plaintext (only sealed frames cross to the cloud). The interface should hide
the storage choice from `mitm.ts` and `session.ts`. (Decided: do NOT put RC payloads in the broker
Turso — there is no host-encryption hedge to make, because the RC log simply stays local.)

No A1 `frames` schema change is required for the first durable server pass.
The RC event store extends the system by adding companion server-state tables,
then records the broker projection in `rc_event_parts.broker_msg_id`,
`broker_part`, and `broker_seq`. A later optimization may add nullable
`rc_session_id`/`rc_event_id` columns to `frames`, but it is not required for
correctness because `UNIQUE(token, gen, msg_id, part)` already gives idempotent
viewer-frame insertion.

```sql
CREATE TABLE rc_sessions (
  cse_session_id      TEXT PRIMARY KEY,
  session_alias       TEXT NOT NULL UNIQUE,
  local_session_uuid  TEXT, -- observed copy; native binding owns this identity
  broker_session_id   TEXT, -- legacy/denormalized only; not A1 identity authority
  title               TEXT,
  cwd                 TEXT,
  model               TEXT,
  created_at_ms       INTEGER NOT NULL,
  updated_at_ms       INTEGER NOT NULL,
  archived_at_ms      INTEGER,
  closed_at_ms        INTEGER,
  compact_generation  INTEGER NOT NULL DEFAULT 0,
  current_worker_epoch INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'open',
  metadata_json       TEXT NOT NULL DEFAULT '{}'
);

-- Coordinator-owned identity mapping. The logical-chat and native-binding
-- records live in the narrow control journal described by
-- client-driven-host-runtime.md; these ids are not aliases for cse_session_id.
CREATE TABLE rc_transport_attachments (
  rc_attachment_id       TEXT PRIMARY KEY,
  logical_chat_id        TEXT NOT NULL,
  native_binding_id      TEXT NOT NULL,
  rc_generation          INTEGER NOT NULL,
  cse_session_id         TEXT NOT NULL UNIQUE,
  replaces_attachment_id TEXT,
  status                 TEXT NOT NULL, -- active, superseded, closed
  recovery_evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms          INTEGER NOT NULL,
  superseded_at_ms       INTEGER,
  UNIQUE (native_binding_id, rc_generation),
  UNIQUE (rc_attachment_id, cse_session_id),
  FOREIGN KEY (cse_session_id) REFERENCES rc_sessions(cse_session_id),
  FOREIGN KEY (replaces_attachment_id)
    REFERENCES rc_transport_attachments(rc_attachment_id)
);

CREATE UNIQUE INDEX rc_transport_attachments_one_active
  ON rc_transport_attachments (native_binding_id)
  WHERE status = 'active';

CREATE TABLE rc_worker_epochs (
  cse_session_id      TEXT NOT NULL,
  worker_epoch        INTEGER NOT NULL,
  rc_attachment_id    TEXT NOT NULL,
  native_incarnation  INTEGER NOT NULL,
  coordinator_epoch   INTEGER NOT NULL,
  bridge_started_at_ms INTEGER NOT NULL,
  last_heartbeat_at_ms INTEGER,
  worker_jwt_id       TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  metadata_json       TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (cse_session_id, worker_epoch),
  FOREIGN KEY (rc_attachment_id, cse_session_id)
    REFERENCES rc_transport_attachments(rc_attachment_id, cse_session_id)
);

CREATE UNIQUE INDEX rc_worker_epochs_one_active
  ON rc_worker_epochs (cse_session_id)
  WHERE status = 'active';

CREATE TABLE rc_events (
  cse_session_id      TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  sequence_num        INTEGER NOT NULL,
  direction           TEXT NOT NULL, -- downstream, upstream, local
  origin              TEXT NOT NULL, -- controller, worker, wrapper, transcript
  event_type          TEXT NOT NULL,
  worker_epoch        INTEGER,
  compact_generation  INTEGER NOT NULL DEFAULT 0,
  duplicate_of        TEXT,
  body_json           TEXT NOT NULL,
  payload_hash        TEXT NOT NULL, -- hash of the canonical body used to validate exact replay
  created_at_ms       INTEGER NOT NULL,
  accepted_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (cse_session_id, event_id),
  UNIQUE (cse_session_id, sequence_num),
  FOREIGN KEY (cse_session_id) REFERENCES rc_sessions(cse_session_id)
);

CREATE INDEX rc_events_session_seq
  ON rc_events (cse_session_id, sequence_num);

CREATE TABLE rc_event_parts (
  cse_session_id      TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  part_index          INTEGER NOT NULL,
  render_kind         TEXT NOT NULL,
  render_json         TEXT NOT NULL,
  broker_msg_id       TEXT,
  broker_part         INTEGER,
  broker_seq          INTEGER,
  projected_at_ms     INTEGER,
  PRIMARY KEY (cse_session_id, event_id, part_index),
  FOREIGN KEY (cse_session_id, event_id)
    REFERENCES rc_events(cse_session_id, event_id)
);

CREATE UNIQUE INDEX rc_event_parts_broker_identity
  ON rc_event_parts (broker_msg_id, broker_part)
  WHERE broker_msg_id IS NOT NULL;

CREATE TABLE rc_downstream_delivery (
  cse_session_id      TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  worker_epoch        INTEGER NOT NULL,
  state               TEXT NOT NULL, -- pending, sent, received, processed
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  first_sent_at_ms    INTEGER,
  last_sent_at_ms     INTEGER,
  ack_received_at_ms  INTEGER,
  ack_processed_at_ms INTEGER,
  ack_body_json       TEXT,
  PRIMARY KEY (cse_session_id, event_id, worker_epoch),
  FOREIGN KEY (cse_session_id, event_id)
    REFERENCES rc_events(cse_session_id, event_id)
);

CREATE TABLE rc_compactions (
  cse_session_id      TEXT NOT NULL,
  compact_event_id    TEXT NOT NULL,
  compact_generation  INTEGER NOT NULL,
  boundary_sequence_num INTEGER NOT NULL,
  summary_text        TEXT NOT NULL,
  transcript_path     TEXT,
  transcript_offset   INTEGER,
  created_at_ms       INTEGER NOT NULL,
  PRIMARY KEY (cse_session_id, compact_event_id),
  UNIQUE (cse_session_id, compact_generation)
);
```

The key API on top of this schema should be an `RcEventStore`:

```ts
interface RcEventStore {
  createSession(input: CreateSessionInput): Promise<RcSession>;
  getSession(cseSessionId: string): Promise<RcSession | undefined>;
  adoptSession(input: AdoptSessionInput): Promise<RcSession>;
  beginBridge(input: BeginBridgeInput): Promise<WorkerEpoch>;
  heartbeat(cseSessionId: string, workerEpoch: number): Promise<void>;
  appendDownstream(input: AppendDownstreamInput): Promise<AcceptedEvent>;
  appendUpstream(input: AppendUpstreamInput): Promise<AppendResult>;
  ackDownstream(input: AckInput): Promise<void>;
  listWorkerPending(cseSessionId: string, workerEpoch: number): AsyncIterable<AcceptedEvent>;
  listEventsAfter(cseSessionId: string, sequenceNum: number): AsyncIterable<AcceptedEvent>;
  appendCompaction(input: CompactInput): Promise<AcceptedEvent>;
  markArchived(cseSessionId: string, input: ArchiveInput): Promise<void>;
  maxSequence(cseSessionId: string): Promise<number>;
}
```

`appendUpstream` is the central idempotency primitive. It must run in one
transaction:

1. Resolve the exact worker lease and verify that its `(rc_attachment_id, cse_session_id)` pair
   matches an active attachment, its native incarnation is current for that binding, and its
   coordinator epoch is current. A numerically current `worker_epoch` on a superseded attachment is
   rejected.
2. Extract the Claude-minted `event_id` and compute a canonical payload hash.
3. If `(cse_session_id, event_id)` already exists with the same hash or a separately validated
   downstream/upstream echo tuple, return the original `sequence_num` and `duplicate:true`. Reject a
   same-ID/different-payload conflict; an event ID alone is not proof of exact replay.
4. Otherwise allocate `sequence_num = max(sequence_num) + 1`, insert the raw
   event and rendered parts, and return `duplicate:false`.

`appendDownstream` should use a controller-generated UUID event id. If an
upstream echo arrives later with the same event id, `appendUpstream` must merge
or confirm the existing event rather than allocate a second sequence. That is
the durable version of the Q&A finding that downstream user and upstream echo
are one logical event.

Viewer needs are intentionally narrower than server needs. A viewer needs
sealed ordered transcript frames, cursor catch-up, permission/control updates,
input acceptance/rejection, and reset/summary frames after wrapper-synthesized
compaction. A viewer does not need raw worker request bodies, worker JWTs, or
delivery ack internals. Those remain in the RC event store so the wrapper can
serve Claude faithfully after restart.

## Mapping to Existing Files

`packages/cli/src/host/rc/mitm.ts` should remain the HTTP boundary, but it
should delegate all state mutation to `RcEventStore` through `RelayCore`.
Concrete changes:

- In `MitmProxy.#intercept`, `POST /v1/code/sessions` should call
  `core.create(data)` and receive a durable `Session`. `core.create` must use
  `RcEventStore.createSession`, not only an in-memory `Map`.
- In `MitmProxy.#intercept`, `/bridge` should call `Session.beginBridge()`.
  That method increments or records the durable `worker_epoch`, binds it to the
  current native incarnation and coordinator epoch, atomically supersedes the
  prior active worker lease, returns a worker JWT scoped to
  `(cse_session_id, worker_epoch)`, and fences older workers.
- In `MitmProxy.#intercept`, `POST /worker/events` must call
  `Session.pushUpstream(payload, workerEpoch)` and return the durable result:
  `{event_id, sequence_num: String(sequenceNum), duplicate}` for each item.
  The current implementation always returns `duplicate:false`; that must
  change.
- In `MitmProxy.#intercept`, worker event stream handling should source pending
  downstream events from `Session.followDownstream(workerEpoch)`, which in turn
  reads durable `pending/sent` rows, not only process memory.
- Add explicit handling for the tracked
  `POST /v1/code/sessions/{id}/archive` lifecycle path only after its exact
  request/response shape is captured in a tracked fixture. It should call
  `Session.archive()` / `RcEventStore.markArchived` and return a successful
  Anthropic-compatible response. Archive must not delete history.

`packages/cli/src/host/rc/session.ts` should change from owning the source of
truth to wrapping durable state:

- Replace in-memory-only `#downstream`, `#upstream`, `#acked`, `#dsSeq`,
  `#usSeq`, and `#workerGen` as authoritative state. Small in-memory queues are
  acceptable as notification caches, but durable storage must be committed
  before SSE emission or HTTP success.
- `pushUserInput` should call `RcEventStore.appendDownstream`, enqueue delivery
  for the current worker epoch, and notify both the worker SSE stream and the
  viewer projector.
- `pushInitialize` should persist an initialize/control event if remote-claw
  requires one for worker startup. It should not be an unlogged side effect.
- `pushUpstream` should call `appendUpstream` and return exactly the stored
  `event_id`, `sequence_num`, and `duplicate` values.
- `ack` should update `rc_downstream_delivery` state. `processed` means do not
  redeliver to the same epoch; `received` without `processed` may be redelivered
  on reconnect depending on observed worker behavior.
- `claimWorkerStream` should validate or issue `worker_epoch`. Reclaiming the
  same epoch for SSE reconnect is allowed; a new bridge gets a new epoch and
  stale writes fail with 409 `epoch_conflict`.

`packages/cli/src/host/rc/relay.ts` should become a projection/transport layer:

- Keep `HostRcRelay` as the component that maps accepted RC events to broker
  `WireFrame`s.
- Preserve the current A0.1 lifecycle boundary: Claude MITM sessions enter through
  `LegacyRcConversationRegistrar`, which starts `startBridgeSession` only at `ready`; OpenCode and
  tmux still use the `bridgeSession` compatibility helper directly. Each registrar lease owns its
  relay abort signal, and the bridge's `served` promise tracks the admitted initial and lifecycle
  refresh posts through settlement; launchers may still bound how long teardown waits for that
  promise.
- Keep the existing branch-A2 idea that durable broker backends do not rely on
  `HostRcRelay.#log` for catch-up. In durable mode, `#log` is not the source of
  truth.
- Add an `RcEventProjector` helper, or equivalent private methods in
  `HostRcRelay`, that converts `rc_event_parts` into broker frames with
  deterministic `msgId`s. Store the produced `broker_seq` back into
  `rc_event_parts`.
- Do not overload broker `seq` with RC `sequence_num` unless every rendered RC
  event maps to exactly one same-kind frame. In the current code, one assistant
  event can map into multiple viewer records. Use dense broker `seq` for viewer
  ordering and keep raw RC order as `(sequence_num, part_index)`.
- Existing `#pumpInbound` should call the durable `Session.pushUserInput` path
  for viewer prompts, not append only to in-memory session state.

`packages/cli/src/broker/client.ts` and
`apps/web/lib/broker/backend.ts` should keep the A2a/A2b branch contracts:

- `BrokerClient.durable` tells `HostRcRelay` whether viewer catch-up is backed
  by a durable broker.
- `BrokerBackend.maxSeq(token)` and `/api/seq` provide broker sequence
  continuity after wrapper restart. This is broker frame sequence continuity,
  not RC server sequence continuity.
- Add a separate `RcEventStore.maxSequence(cse_session_id)` for the server
  sequence counter used by `/worker/events` responses.

`packages/cli/src/broker/order.ts` can remain the viewer-side ordering layer.
It should not be asked to infer RC semantics. It deduplicates by broker
`msgId`/part and orders by broker `seq`; the RC event store handles Claude
event-id idempotency.

## Server Response Fidelity

`POST /v1/code/sessions`:

- Allocate globally unique `cse_session_id`; avoid deterministic local ids that
  can diverge from real Anthropic behavior.
- Persist `rc_sessions` before returning.
- Return the same shape current relay mode returns, plus any fields observed in
  traces that clients require. Do not include invented history.

`POST /v1/code/sessions/{cse}/bridge`:

- Resolve the presented `cse_` through `rc_transport_attachments` and verify that
  its logical chat, native binding, and attachment status match the
  coordinator's current lease. The `cse_` alone grants no authority to select or
  create a logical chat.
- If the durable session exists, start a new bridge epoch tied to the exact
  current native incarnation and coordinator epoch, atomically supersede any
  prior active worker lease for that attachment, then return
  `api_base_url`, `expires_in`, `worker_epoch`, and `worker_jwt`.
- If the session does not exist but the wrapper intentionally supports
  adopting unknown `cse_` ids, insert an `adopted_missing_history` session and
  make that status visible in diagnostics. The recommended production behavior
  is to fail unknown resume unless the operator explicitly enables adoption,
  because Claude will not replay the missing history.
- Do not expect `lastSequenceNum` in this request.

`GET /worker/events/stream`:

- Authenticate the worker JWT and extract `(cse_session_id, worker_epoch)`.
- Before opening or continuing the stream, resolve that epoch through its exact
  attachment pair and require the attachment, native incarnation, and
  coordinator epoch all to remain current. Stop the stream when any check
  becomes stale.
- Send durable pending downstream events in sequence order.
- On reconnect for the same epoch, resend events not marked `processed`.
- Keep heartbeat behavior compatible with current Claude worker expectations.

`POST /worker/events`:

- Authenticate the worker and enforce the complete active lease across the
  attachment, native incarnation, and coordinator epoch, not only the numeric
  epoch for that `cse_session_id`.
- For each item, call the idempotent append transaction.
- Return exactly the durable values:

```json
{
  "results": [
    {
      "event_id": "uuid-from-claude",
      "sequence_num": "42",
      "duplicate": false
    }
  ]
}
```

- On exact replay, return the same `event_id` and `sequence_num` with
  `duplicate:true`.
- On stale worker epoch, reject before insert with 409 `epoch_conflict`.

`POST /worker/events/delivery`:

- Persist `received` and `processed` state by event id and epoch.
- Treat `processed` as private-RC replay bookkeeping only, not native Claude acceptance, application,
  source attribution, or terminal outcome; those require separately correlated native evidence.
- Apply the same complete active-lease validation before accepting an
  acknowledgement.
- Treat unknown acks as non-fatal but log them; they may come from stale worker
  cleanup or already-compacted local state.

`/worker/heartbeat` and worker registry endpoints:

- Validate the complete active lease, then update
  `rc_worker_epochs.last_heartbeat_at_ms` and return current epoch metadata.
- Do not allocate sequence numbers for heartbeat.

Archive/close:

- Persist archive/close metadata and optionally a wrapper-owned local event.
- Do not close the log to future resume. A later bridge for the same `cse_`
  bumps epoch and continues with `max(sequence_num)+1`.

## Lifecycle Behavior

New remote-control session:

1. `POST /v1/code/sessions` creates `rc_sessions`.
2. Bridge starts epoch 1.
3. Any initialize/control downstream event is appended before being sent.
4. Viewer frames are projected after durable append.

Resume/re-bridge for known `cse_`:

1. Load the canonical `logical_chat_id`, its current native binding/incarnation,
   and that binding's active RC attachment.
2. Reuse its known `cse_session_id`; do not mint a replacement merely because
   the coordinator or wrapper process restarted.
3. `/bridge` looks up `rc_sessions` and starts epoch
   `current_worker_epoch + 1`, recording the current native incarnation and
   coordinator epoch on that worker lease.
4. It does not wait for Claude to replay history.
5. `maxSequence(cse)` seeds the next RC server sequence.
6. Pending downstream deliveries are computed from durable ack state and the
   coordinator reconciles their exact native-delivery attempts before any
   redelivery.

Proven RC attachment replacement for the same logical chat:

1. Stop admission and reconcile or quarantine every delivery attempt tied to
   the exact old attachment/worker lease and the native incarnation recorded on
   that lease.
2. Establish why the known `cse_` cannot be reused. The transition requires
   positive replacement/containment evidence that the old attachment cannot
   remain writable; a missing row, timeout, empty process memory, or operator
   acknowledgement is insufficient. Commit a recovery gap for any missing
   history, but do not treat that gap as containment.
3. In one durable transition, mark the old `rc_transport_attachments` row
   and its active worker lease `superseded`, allocate a new
   `rc_attachment_id`/`rc_generation` and `cse_session_id`, and map it to the
   same `logical_chat_id` and native binding.
4. Start the new RC session at its own transport sequence and a worker epoch
   tied to the exact current native incarnation and coordinator epoch.
   Preserve the old RC log for deduplication/audit and continue logical
   `command_seq`/projection correlation across the attachment boundary.
5. Never replay an old transcript row or previously attempted command into the
   replacement merely to reconstruct context.

Resume/re-bridge for unknown `cse_`:

- Recommended default: reject with a clear diagnostic because accepting creates
  a session with no past history and Claude will not fill it in.
- Debug option: adopt as `adopted_missing_history`, start at sequence 1 or the
  first accepted sequence, mark viewer history incomplete, and require an
  explicit operator-supplied logical-chat/native-binding target. Debug adoption
  never derives or creates that authority from the unknown `cse_`.

Viewer catch-up after wrapper restart:

- If A1/A2 Turso broker frames exist, viewers subscribe from the broker by
  cursor and receive sealed frames from `frames`.
- If broker frames are missing but the RC event log exists, the projector can
  rebuild deterministic broker frames from `rc_event_parts` and then serve
  viewers. Reprojection must be idempotent through `broker_msg_id` and part.
- `HostRcRelay.#log` is only an in-memory optimization for non-durable broker
  backends.

Claude client catch-up:

- If gated verification confirms them, a native-compatible `/events/stream`
  endpoint may map supported cursor forms such as `lastSequenceNum` or
  `from_sequence_num` to `rc_events.sequence_num`.
- This is separate from worker `/bridge` recovery and from broker viewer `seq`.

Compaction:

- RC wire alone cannot communicate log reset.
- Add a transcript watcher for sessions that have a local JSONL path. On
  `isCompactSummary:true`, insert a wrapper-owned `compact_summary` event and
  an `rc_compactions` row with `boundary_sequence_num = maxSequence(cse)`.
- Viewer projection emits a reset/summary frame. Viewers should hide prior
  rendered turns for normal display but raw RC logs remain append-only for audit
  and idempotency.
- If no transcript watcher is available, record the empty result from
  `/compact` as an ordinary upstream result and leave the visible history
  untruncated, with a diagnostic that summary text was unavailable.

Q&A turn:

- Downstream viewer prompt appends one durable event id.
- Worker receives it over SSE and posts an upstream echo or result using stable
  event ids.
- If the worker reposts the same event, the server returns `duplicate:true`
  and the original sequence number.
- Assistant answer rows are persisted by Claude-minted event id before
  projection. Projection uses deterministic parts, so duplicate upstream POSTs
  cannot duplicate viewer output.

Interrupt mid-turn:

- Persist the user event.
- Persist the empty success result if Claude posts one.
- Mark the turn boundary complete without requiring assistant text.

Worker reconnect and two-worker race:

- SSE reconnect for the same epoch keeps the epoch and redelivers only
  unprocessed downstream events.
- New bridge increments epoch.
- Writes from stale epochs fail and do not allocate sequence numbers.

That redelivery rule is specific to the proposed synthetic RC transport and is safe only after a
worker-idempotency/exact-ACK proof. The future coordinator cannot infer “safe to resend” merely from
missing `processed`: if the worker may have acted before losing its ACK, native delivery is
`outcome_unknown` and later commands remain quarantined.

Downstream input idempotency:

- Controller/viewer generated event ids must be stable across retries.
- `appendDownstream` upserts by `(cse_session_id, event_id)`.
- Delivery rows are per epoch, so the same logical input can be delivered to a
  new worker epoch if not already completed.

Close/archive:

- `/exit` is ordinary input plus archive metadata.
- Archive does not delete raw log or broker frames.
- Resume after close reopens or continues the session with a new epoch.

## Brokered Native Provider Mode

Add this only on top of the coordinator control journal in
[Client-driven Host Runtime](client-driven-host-runtime.md). This is not
passthrough: inner Claude stays on remote-claw's private synthetic RC/API
façade and never receives a real Anthropic credential, session, bridge, or
network route. A separate remote-claw-owned connector acts as the real outward
worker/app:

- The existing `mitm.ts` relay path remains the inner RC server. It reports native observations while
  the coordinator records only its direct remote collaborators' proposal order, forwarding decisions,
  correlation, and delivery evidence. The outward connector separately
  performs real Anthropic registration, bridge, worker SSE, delivery, worker
  event, status, heartbeat, history, and app-side operations.
- Viewer prompts are durable local proposals before any inward delivery or
  outward app-side `POST /v1/code/sessions/{id}/events`. The resulting provider
  delivery is correlated to the existing command and never injected twice.
- Official-client events arrive at the remote-claw-owned worker connector,
  enter the journal/actor, and only then cross the private inner RC façade.
- Provider ingress deduplicates by the coordinator's durable logical-chat, outside-binding,
  source-event-namespace, and event-ID identity, not by connector incarnation. Reconnect or provider
  replacement must consult canonical source-event, observation, and correlation history across prior
  incarnations before allocating a command. A reset namespace requires a versioned,
  capability-pinned transition classifier plus boundary coordinates, and each observation retains its
  comparable provider coordinate and classification evidence. Proven overlap resolves to its prior
  command; only a proven post-boundary reuse becomes new, while ambiguity fails closed. The RC-local
  `(cse_session_id, event_id)` key remains only a private Claude transport key.
- The control journal persists each received server proposal, its decision, and its `command_seq`; the projector maps that to `chat_seq` and provider event
  identity/sequence, inner event identity, delivery, history/SSE, and reconnect
  mappings. No single field is assumed to span every surface before proof.
- Provider history/SSE can repair a provider-representation/read-back gap, but it cannot overwrite
  native execution evidence or cause recovered commands to execute.
- Inner inference/OAuth/API requests terminate locally and selected inference is re-originated by a
  separately isolated inference connector, not the outward Remote worker/app connector.
  Network-policy tests must prove the inner process cannot reach Anthropic directly or obtain real
  OAuth/worker credentials.

## Historical Phased Implementation Plan

The A1/A2 branch statuses and file paths below are a preserved planning snapshot, not current
instructions: those branches were integrated and the broker layout has since moved to
`apps/web/lib/broker/{sqlite-multi,turso-cloud-locator,vercel}.ts` plus shared interfaces. The unbuilt B
phases are likewise superseded by the shared/Claude phases in
[Client-driven Host Runtime delivery plan](client-driven-host-runtime.md#delivery-plan). Keep this
section for provenance and
test intent; re-read current code before implementing any item.

Phase A1 - Durable broker frames:

- Status: done on the Turso backend branch; land or rebase before dependent
  phases.
- Branch basis: `feat-turso-broker-catchup` / `origin/feat-turso-backend`.
- Files: `apps/web/lib/broker/turso.ts`,
  `apps/web/lib/broker/turso-connection.ts`,
  `apps/web/lib/broker/index.ts`,
  `apps/web/test/broker/turso-backend.test.ts`.
- Goal: durable sealed viewer frames with idempotent
  `UNIQUE(token, gen, msg_id, part)`.
- Tests: Turso publish/subscribe, duplicate `msg_id`/part insert, generation
  close/reopen, cursor catch-up from stored `id`.
- Gate: tests prove publish idempotency, subscribe from cursor, generation
  close/reopen behavior, and no plaintext transcript requirement in broker.

Phase A2a - Retire host memory as viewer catch-up source:

- Status: landing after A1.
- Branch basis: `feat-turso-broker-catchup`.
- Files: `packages/cli/src/broker/client.ts`,
  `packages/cli/src/host/rc/relay.ts`.
- Goal: `BrokerClient.durable` lets `HostRcRelay` avoid using `#log` for
  catch-up when the broker is durable.
- Tests: durable backend reconnect with empty process memory, non-durable
  backend still using `#log`, catch-up request served from broker frames.
- Gate: restart host while broker survives; viewer can catch up from broker
  frames without the old process memory.

Phase A2b - Broker sequence continuity:

- Status: revived and landing after A2a.
- Branch basis: `feat-turso-seq-continuity`.
- Files: `apps/web/lib/broker/backend.ts`,
  `apps/web/lib/broker/turso.ts`,
  `apps/web/app/api/seq/route.ts`,
  `packages/cli/src/broker/client.ts`,
  `packages/cli/src/host/rc/relay.ts`.
- Goal: initialize broker frame `seq` from `maxSeq(token)` after restart.
- Tests: `/api/seq` auth and backend selection, Turso `MAX(seq)`, host restart
  emits next broker seq as max+1.
- Gate: no duplicate or regressed broker frame sequence after wrapper restart.

Phase A2c - Broker retention:

- Files: `apps/web/lib/broker/turso.ts`,
  `apps/web/lib/broker/turso-connection.ts`, deployment cron or maintenance
  route if needed.
- Goal: expire old sealed frames by policy without breaking active generation
  catch-up.
- Tests: retention sweep with active and closed channels, subscribe around a
  pruned boundary, no deletion of current generation required for live viewers.
- Gate: expired frames disappear only past retention boundary; active sessions
  remain subscribable.

Phase B1 - Host RC event store:

- Files: new `packages/cli/src/host/rc/event-store.ts`, new storage adapter
  such as `packages/cli/src/host/rc/event-store-sqlite.ts`,
  `packages/cli/src/host/rc/session.ts`,
  `packages/cli/src/host/rc/mitm.ts`,
  `packages/cli/src/host/rc/launch.ts`.
- Goal: create durable `rc_sessions`, `rc_transport_attachments`, `rc_events`,
  `rc_worker_epochs`, and `rc_downstream_delivery`; make
  `POST /worker/events` idempotent and preserve the coordinator's
  logical-chat/native-binding/RC-attachment mapping.
- Tests: append/replay duplicate, stale epoch reject, restart and reuse the
  known `cse_`, unknown `cse_` policy, sequence max+1 after restart, and a
  proof-carrying replacement `cse_` that remains under the same logical chat.
- Gate: duplicate upstream POST returns `duplicate:true` with original
  sequence; restart plus `--remote-control --resume <U>` continues from stored
  history with no replay required. Recovery must try the known `cse_` first;
  replacement without recorded containment proof fails closed and cannot mint
  another logical chat.

Phase B2 - Durable downstream delivery and epoch fencing:

- Files: `session.ts`, `mitm.ts`, event-store adapter tests.
- Goal: pending downstream events survive restart; worker epoch rejects stale
  writers; delivery acks are durable.
- Tests: same-epoch SSE reconnect, processed ack suppression, unprocessed
  redelivery, two-worker epoch race.
- Gate: same-epoch SSE reconnect redelivers only unprocessed events; two-worker
  race accepts new epoch and rejects stale epoch with no sequence allocation.

Phase B3 - RC event to broker projection:

- Files: `packages/cli/src/host/rc/relay.ts`, optional new
  `packages/cli/src/host/rc/event-projector.ts`,
  `packages/cli/src/broker/protocol.ts` if new frame metadata is needed.
- Goal: deterministic projection from `rc_events`/`rc_event_parts` into sealed
  `WireFrame`s.
- Tests: downstream/echo merge renders once, assistant duplicate no-op,
  multi-part assistant projection stable, reprojection after broker loss.
- Gate: replaying projection after restart is idempotent; downstream user plus
  upstream echo render once; assistant duplicate POST does not duplicate output.

Phase B4 - Compact watcher and reset projection:

- Files: new `packages/cli/src/host/rc/transcript-watcher.ts`,
  `session.ts`, `relay.ts`.
- Goal: detect local JSONL `isCompactSummary:true`, insert durable
  compaction row, emit viewer reset/summary frame.
- Tests: local compact summary detection, remote compact result-only fallback,
  viewer hides pre-boundary display while raw events remain queryable.
- Gate: local and remote `/compact` tests show visible viewer history resets
  to summary while raw durable log remains append-only.

Phase B5 - Archive/close fidelity:

- Files: `mitm.ts`, `session.ts`, event-store adapter.
- Goal: persist archive/close and allow later re-bridge to continue.
- Tests: `/exit` input plus archive, resume closed session, append after reopen,
  no deletion of prior events.
- Gate: `/exit` archives, later resume same `cse_` bumps epoch and appends at
  `max(sequence_num)+1`.

## Tests Required

- Unit test `RcEventStore.appendUpstream`: new insert, exact replay duplicate,
  stale epoch rejection, sequence monotonicity.
- Unit test `RcEventStore.appendDownstream`: retry idempotency, echo merge by
  same event id, per-epoch delivery rows.
- Integration test `mitm.ts` worker POST shape: returns real
  `{event_id, sequence_num, duplicate}` values.
- Integration test resume: start session, append Q&A, restart wrapper, bridge
  same known `cse_`, verify no replacement attachment is allocated, no replay
  is needed, and next event sequence is max+1.
- Integration test proven replacement: prove the old attachment contained,
  explicitly gap any missing history, allocate a replacement `cse_`, and verify
  both attachments map to the same `logical_chat_id`/native binding while only
  the replacement is active.
- Integration test unproven replacement: timeout, missing process memory, or an
  unknown `cse_` cannot silently replace the active attachment, create a
  logical chat, or cause an old command to execute again.
- Integration test interrupt: user event plus empty result renders a completed
  turn without assistant text.
- Integration test two workers: epoch N accepted, epoch N-1 rejected.
- Integration test attachment replacement fencing: after the attachment and its
  active worker lease are superseded, every stream, event, acknowledgement, and
  heartbeat operation using the old `cse_*`/epoch is rejected even if that
  epoch remains the old session's numeric maximum.
- Projection test: raw RC event with multiple render parts maps to stable broker
  frames; reprojection is no-op under `UNIQUE(token, gen, msg_id, part)`.
- Compact test: JSONL summary row creates compact marker and viewer reset.
- Broker tests from A1/A2: Turso publish idempotency, subscribe by cursor,
  `maxSeq` continuity, retention.

## PR Gate

A durability PR is not complete unless it demonstrates these properties:

- The wrapper can be killed and restarted without losing the ability to answer
  duplicate `/worker/events` POSTs with the original sequence numbers.
- `claude --remote-control --resume <U>` against the restarted wrapper does not
  depend on Claude replaying prior history.
- Recovery reuses the known `cse_` before considering replacement. A replacement
  is accepted only after its containment proof and any recovery gap are
  durable, preserves the same canonical logical chat and native binding, binds
  its worker epoch to the exact current native incarnation/coordinator epoch,
  and does not replay prior commands.
- No code path treats `cse_session_id` as `logical_chat_id` or as Claude's
  native transcript/resume `conversationId`.
- Viewer catch-up works without `HostRcRelay.#log`.
- Stale worker epochs cannot write canonical events.
- A worker epoch on a superseded attachment, native incarnation, or coordinator
  epoch cannot stream, write, acknowledge, or heartbeat.
- `/compact` does not claim RC wire support for reset; any reset is explicitly
  wrapper-synthesized from local transcript evidence.
- Outward-provider connector tests use only sessions created for the test and
  never human live sessions.

## Open Decisions

- Storage placement: **DECIDED — local SQLite/libSQL in the CLI**, cleartext. Nothing on the host needs
  encryption, and the RC event log is never sent to the broker, so there is no host-encryption question.
  The broker holds only sealed frames; RC plaintext stays on the host.
- Unknown resume policy: production should reject unknown `cse_` resumes by
  default; debug adoption is useful but must mark history incomplete and name
  an existing logical-chat/native-binding target explicitly. An unknown `cse_`
  is never sufficient evidence to allocate or select a logical chat.
- Broker sequence mapping: recommended design keeps dense broker `seq` separate
  from RC `sequence_num`. A simpler one-seq design is possible only if the
  projector guarantees one same-kind broker frame per RC event.
- Compact source: tracked relay protocol describes an assistant compact-summary turn plus `result`
  ([Protocol & Runtime §12](protocol.md#12-convergence-failure-modes)), while the unavailable
  historical native-RC investigation reportedly saw only an empty result on the
  wire and summary text in local JSONL. Treat this as version/mode dependent
  until Phase B4 reconciles it; do not require local transcript watching or
  expose compact as result-only based on either observation alone.
- Retention: raw RC logs are needed for idempotency and audit longer than
  viewer frames. Define separate retention for raw events, compacted visible
  history, and sealed broker frames.
- Outward connector credentials: brokered native mode needs a separately
  secured OAuth source and explicit test-session guardrails. Remote-claw owns
  the real worker/app credentials; the isolated inner Claude receives only
  synthetic/local auth and never refreshes or reads the real provider secret.
  Rotation and revocation behavior remain a release gate.
- Native client stream endpoint: decide whether relay mode should expose its
  own `/events/stream` endpoint for native-compatible clients, or keep
  `/events/stream` support limited to reads served/reconciled by the outward
  connector and remote-claw viewers on the E2E broker.
