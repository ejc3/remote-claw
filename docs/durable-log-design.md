# Durable Log Design for remote-claw

This design treats remote-claw relay mode as the durable remote-control
server of record. The broker/Turso frame log is still the durable viewer
transport, but it is not enough to reconstruct Claude remote-control server
state: the wrapper must durably store RC event ids, RC sequence numbers,
worker epochs, downstream delivery state, and compaction boundaries before it
can safely accept resume/re-bridge after restart.

The older transcript-first direction in `PLAN.md` is superseded for this
purpose. Local Claude JSONL is useful evidence and is required to observe
`/compact` summaries, but fresh `claude --remote-control` sessions do not write
a complete local transcript and `--remote-control --resume <U>` does not replay
prior history to a fresh accepting server. The durable MITM log is therefore the
primary source of truth for remote-claw relay mode.

## Source Map

- `codex-findings.md`: initial RC harness work, local transcript behavior,
  clean exits, normal transcript syncing, session-id behavior.
- `bridge-findings.md`: bridge formation, trigger-poll refutation,
  cse/session aliasing, controller input path.
- `lifecycle-findings.md`: resume/re-bridge behavior, no replay, role of
  `lastSequenceNum`, current in-memory wrapper limits.
- `compact-findings.md`: `/compact` wire behavior and local JSONL summary rows.
- `qa-findings.md`: full Q&A event order, deterministic event ids,
  duplicate/idempotent upstream behavior.
- `edges-findings.md`: interrupt, worker reconnect/epoch, two workers,
  downstream idempotency, close/archive behavior.
- `parallel-findings.md`: optional passthrough/tap mode, viewer input risks,
  Anthropic history re-fetch behavior.
- Current code on `main`: `packages/cli/src/host/rc/{mitm,session,relay,launch}.ts`,
  `packages/cli/src/broker/{client,protocol,order}.ts`,
  `apps/web/lib/broker/{backend,local,vercel}.ts`.
- Branch evidence inspected with `git show`: `feat-turso-broker-catchup`
  for A1 Turso frames and `feat-turso-seq-continuity` for A2 durable
  broker catch-up/sequence continuity.

## Established Protocol Facts

Bridge formation is caused by the remote-control startup flow, not by a
non-empty trigger poll. The bridge trace shows `POST /v1/code/sessions`, then
`/bridge`, then `/worker/events/stream` and worker heartbeat before the empty
trigger poll can matter. The trigger-poll hypothesis is refuted by
`bridge-findings.md`; remote-claw relay should not rely on trigger polling to
discover or revive sessions. Evidence: `bridge-findings.md`.

Session identity has two visible aliases. The wire and transcript identity is
`cse_<suffix>`, while the live worker registry also uses `session_<suffix>`.
The suffix is the same, and resume/re-bridge keeps the same `cse_` for the
conversation. Current `mitm.ts` already works in `cse_` terms for
`/v1/code/sessions` and `/v1/code/sessions/{sid}/...`; durable storage should
store the canonical `cse_session_id` and derive `session_alias` only when
serving worker registry or archive endpoints. Evidence:
`bridge-findings.md`, `lifecycle-findings.md`, `codex-findings.md`.

Fresh `claude --remote-control` is not transcript-durable locally. The early
RC findings show only incomplete title/stub rows locally for fresh
remote-control turns, while normal non-RC Claude writes a full local JSONL
transcript in real time. That normal transcript can help detect compaction, but
it cannot be the remote-claw server log. Evidence: `codex-findings.md`,
`compact-findings.md`.

Resume/re-bridge is the critical lifecycle constraint. When
`claude --remote-control --resume <U>` reconnects to a server that accepts the
same `cse_` but has no history, Claude does not replay its prior conversation.
The bridge body is `{}`, there is no `POST /v1/code/sessions`, and no historical
payload is sent to the worker server. The wrapper must already have the
history, or that history is lost from the remote-control server perspective.
Evidence: `lifecycle-findings.md`.

`lastSequenceNum` is a client stream cursor, not a worker bridge recovery
mechanism. The lifecycle trace places it on `/events/stream` style client
catch-up, not on `/bridge` or `/worker/events`. It cannot be used to make a
fresh wrapper ask Claude to replay worker history. Evidence:
`lifecycle-findings.md`.

Client catch-up is cursor-based stream replay. The observed compatible shape is
`/events/stream` with `from_sequence_num` or `lastSequenceNum`/`Last-Event-ID`
style cursoring; it replays server history after a known cursor. This is the
reason `rc_events.sequence_num` is the raw catch-up cursor. Evidence:
`lifecycle-findings.md`, `parallel-findings.md`.

Q&A upstream persistence is deterministic. Claude mints stable UUID event ids
before POSTing worker events. The server returns those ids with monotonic
`sequence_num` values. Reposting the exact same body returns `duplicate:true`
and the original sequence numbers. This means the durable server API must be
an idempotent upsert keyed by `(cse_session_id, event_id)`. Evidence:
`qa-findings.md`.

Downstream user input and upstream user echo are the same logical event when
they share an event id. The viewer transcript must merge those records instead
of rendering the downstream user message and the worker echo as two user turns.
Delivery acknowledgements are separate durable state, not transcript messages.
Evidence: `qa-findings.md`, `edges-findings.md`.

Interrupt mid-turn is not a special assistant event. Pressing escape during a
turn produced one empty successful result event after the user event, with no
assistant content and no `control_cancel`. The log must accept result-only turn
boundaries and must not wait for assistant content before closing a turn.
Evidence: `edges-findings.md`.

Worker epoch is the concurrency fence. Plain SSE reconnect does not bump
`worker_epoch`; bridge/re-bridge does. With two workers on one `cse_`, the
newer epoch is accepted and stale epoch writes must be rejected, as shown by
the edge tests. The durable log should keep only accepted writes as canonical,
while recording rejected stale attempts as diagnostics if desired. Evidence:
`edges-findings.md`.

Session close is soft. `/exit` behaves like ordinary downstream input followed
by archive/close side effects; the bridge REPL did not support an explicit
`end_session` control. Closed sessions can later resume/re-bridge on the same
`cse_`, bump epoch, and continue. Archive is therefore metadata, not a hard
delete. Evidence: `edges-findings.md`.

`/compact` does not announce a reset on the RC wire. Local and remote compact
experiments show no server-side reset event; the server sees an empty
successful result, while the compact summary appears only in local JSONL as an
`isCompactSummary:true` row. The wrapper must synthesize its own compact/reset
record if viewers should truncate to the summary. Evidence:
`compact-findings.md`.

Passthrough/tap is possible but optional. The parallel trace shows a mode where
Claude remains bridged to real Anthropic and remote-claw observes/relays a
sealed copy. Viewer prompts are safest through the real client `POST /events`
path in that mode; downstream tee injection can desync official history if the
payload is malformed. Anthropic `/events/stream?from_sequence_num=N` can be a
read-only redundancy source, not the primary durability plan. Evidence:
`parallel-findings.md`.

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
dense viewer-order cursor because existing `FrameOrderer` treats `seq` as the
viewer stream order and chunk parts as fragments of one same-kind message.

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
  local_session_uuid  TEXT,
  broker_session_id   TEXT,
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

CREATE TABLE rc_worker_epochs (
  cse_session_id      TEXT NOT NULL,
  worker_epoch        INTEGER NOT NULL,
  bridge_started_at_ms INTEGER NOT NULL,
  last_heartbeat_at_ms INTEGER,
  worker_jwt_id       TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  metadata_json       TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (cse_session_id, worker_epoch),
  FOREIGN KEY (cse_session_id) REFERENCES rc_sessions(cse_session_id)
);

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
  beginBridge(cseSessionId: string): Promise<WorkerEpoch>;
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

1. Verify the `worker_epoch` is current for the `cse_session_id`.
2. Extract the Claude-minted `event_id` from the payload.
3. If `(cse_session_id, event_id)` already exists, return the original
   `sequence_num` and `duplicate:true`.
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
  That method increments or records the durable `worker_epoch`, returns a
  worker JWT scoped to `(cse_session_id, worker_epoch)`, and fences older
  workers.
- In `MitmProxy.#intercept`, `POST /worker/events` must call
  `Session.pushUpstream(payload, workerEpoch)` and return the durable result:
  `{event_id, sequence_num: String(sequenceNum), duplicate}` for each item.
  The current implementation always returns `duplicate:false`; that must
  change.
- In `MitmProxy.#intercept`, worker event stream handling should source pending
  downstream events from `Session.followDownstream(workerEpoch)`, which in turn
  reads durable `pending/sent` rows, not only process memory.
- Add explicit handling for `/v1/sessions/{session_...}/archive` or the exact
  archive path observed in `edges-findings.md`. It should call
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

- If the durable session exists, start a new bridge epoch and return
  `api_base_url`, `expires_in`, `worker_epoch`, and `worker_jwt`.
- If the session does not exist but the wrapper intentionally supports
  adopting unknown `cse_` ids, insert an `adopted_missing_history` session and
  make that status visible in diagnostics. The recommended production behavior
  is to fail unknown resume unless the operator explicitly enables adoption,
  because Claude will not replay the missing history.
- Do not expect `lastSequenceNum` in this request.

`GET /worker/events/stream`:

- Authenticate the worker JWT and extract `(cse_session_id, worker_epoch)`.
- Send durable pending downstream events in sequence order.
- On reconnect for the same epoch, resend events not marked `processed`.
- Keep heartbeat behavior compatible with current Claude worker expectations.

`POST /worker/events`:

- Authenticate the worker and enforce current epoch.
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
- Treat unknown acks as non-fatal but log them; they may come from stale worker
  cleanup or already-compacted local state.

`/worker/heartbeat` and worker registry endpoints:

- Update `rc_worker_epochs.last_heartbeat_at_ms` and return current epoch
  metadata.
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

1. `/bridge` looks up `rc_sessions`.
2. It starts epoch `current_worker_epoch + 1`.
3. It does not wait for Claude to replay history.
4. `maxSequence(cse)` seeds the next RC server sequence.
5. Pending downstream deliveries are computed from durable ack state.

Resume/re-bridge for unknown `cse_`:

- Recommended default: reject with a clear diagnostic because accepting creates
  a session with no past history and Claude will not fill it in.
- Debug option: adopt as `adopted_missing_history`, start at sequence 1 or the
  first accepted sequence, and mark viewer history incomplete.

Viewer catch-up after wrapper restart:

- If A1/A2 Turso broker frames exist, viewers subscribe from the broker by
  cursor and receive sealed frames from `frames`.
- If broker frames are missing but the RC event log exists, the projector can
  rebuild deterministic broker frames from `rc_event_parts` and then serve
  viewers. Reprojection must be idempotent through `broker_msg_id` and part.
- `HostRcRelay.#log` is only an in-memory optimization for non-durable broker
  backends.

Claude client catch-up:

- Any native-compatible `/events/stream` endpoint should use
  `lastSequenceNum` / `from_sequence_num` against `rc_events.sequence_num`.
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

Downstream input idempotency:

- Controller/viewer generated event ids must be stable across retries.
- `appendDownstream` upserts by `(cse_session_id, event_id)`.
- Delivery rows are per epoch, so the same logical input can be delivered to a
  new worker epoch if not already completed.

Close/archive:

- `/exit` is ordinary input plus archive metadata.
- Archive does not delete raw log or broker frames.
- Resume after close reopens or continues the session with a new epoch.

## Optional Passthrough/Tap Mode

Add this only after relay durability is correct. In passthrough/tap mode,
remote-claw is not the server of record; Anthropic remains the server and
remote-claw observes:

- `mitm.ts` should run a `tapSink` path that forwards requests/responses to
  real Anthropic, records sealed copies for remote-claw viewers, and never uses
  host credentials against human sessions.
- Viewer prompts should go through the real client `POST /events` path, not a
  downstream tee, unless a strict validator can prove the tee body is exactly
  Anthropic-compatible.
- `/events/stream?from_sequence_num=N` and `Last-Event-ID` can re-fetch
  official history for test sessions. It is a redundancy and observation tool,
  not a substitute for relay-mode durable logging.
- The raw RC event store in observe mode should be marked `observed`, because
  remote-claw cannot authoritatively answer duplicate POSTs or fence workers
  when Anthropic owns the bridge.

## Phased Implementation Plan

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
- Goal: create durable `rc_sessions`, `rc_events`, `rc_worker_epochs`, and
  `rc_downstream_delivery`; make `POST /worker/events` idempotent.
- Tests: append/replay duplicate, stale epoch reject, restart and resume same
  `cse_`, unknown `cse_` policy, sequence max+1 after restart.
- Gate: duplicate upstream POST returns `duplicate:true` with original
  sequence; restart plus `--remote-control --resume <U>` continues from stored
  history with no replay required.

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

Phase C - Optional passthrough/tap:

- Files: CLI flags in launch/run entrypoints, `mitm.ts` tap mode,
  optional Anthropic history client, projection path.
- Goal: observe test sessions while Claude remains bridged to real Anthropic.
- Tests: read-only created test session, real-client `POST /events` viewer
  prompt, `/events/stream?from_sequence_num=N` re-fetch, malformed tee disabled.
- Gate: read-only tap against created test sessions, real-client viewer prompt
  path works, downstream tee is disabled by default.

## Tests Required

- Unit test `RcEventStore.appendUpstream`: new insert, exact replay duplicate,
  stale epoch rejection, sequence monotonicity.
- Unit test `RcEventStore.appendDownstream`: retry idempotency, echo merge by
  same event id, per-epoch delivery rows.
- Integration test `mitm.ts` worker POST shape: returns real
  `{event_id, sequence_num, duplicate}` values.
- Integration test resume: start session, append Q&A, restart wrapper, bridge
  same `cse_`, verify no replay is needed and next event sequence is max+1.
- Integration test interrupt: user event plus empty result renders a completed
  turn without assistant text.
- Integration test two workers: epoch N accepted, epoch N-1 rejected.
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
- Viewer catch-up works without `HostRcRelay.#log`.
- Stale worker epochs cannot write canonical events.
- `/compact` does not claim RC wire support for reset; any reset is explicitly
  wrapper-synthesized from local transcript evidence.
- Passthrough/tap tests use only sessions created for the test and never human
  live sessions.

## Open Decisions

- Storage placement: **DECIDED — local SQLite/libSQL in the CLI**, cleartext. Nothing on the host needs
  encryption, and the RC event log is never sent to the broker, so there is no host-encryption question.
  The broker holds only sealed frames; RC plaintext stays on the host.
- Unknown resume policy: production should reject unknown `cse_` resumes by
  default; debug adoption is useful but must mark history incomplete.
- Broker sequence mapping: recommended design keeps dense broker `seq` separate
  from RC `sequence_num`. A simpler one-seq design is possible only if the
  projector guarantees one same-kind broker frame per RC event.
- Compact source: local transcript watching is the only observed source for
  compact summary text. Decide whether relay mode should require a transcript
  path for full compact UX or expose compact as "result-only" when unavailable.
- Retention: raw RC logs are needed for idempotency and audit longer than
  viewer frames. Define separate retention for raw events, compacted visible
  history, and sealed broker frames.
- Observe mode auth: passthrough/tap must have explicit test-session guardrails
  before it can use host Anthropic credentials.
- Native client stream endpoint: decide whether relay mode should expose its
  own `/events/stream` endpoint for native-compatible clients, or keep
  `/events/stream` support limited to observe-mode reads from Anthropic and
  remote-claw viewers on the E2E broker.
