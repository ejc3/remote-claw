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
> not proof of what a particular device rendered. One paired host contains many independent logical
> chats and native sessions; this document's per-`cse_*` RC state repeats independently for every
> wrapped Claude session and must not become a host-wide current-session slot. This document's full RC
> log remains relevant to the current synthetic server, not a universal semantic authority. A1.0
> through A1.3 have landed: canonical contracts, the secure SQLite kernel and protected-artifact
> store, schema-v3 server/project/chat/binding/edge/coordinator records, and now schema-v4 runtime-owner
> state plus its repository, semantic validator, authenticated daemon/RPC, lease/takeover, and wrapped
> key custody. Migration 4 has 141 statements and digest
> `zx52EtAFNY9hEZneG3RW14zRCYR18gg7ysnltHbOkT0`; the full v4 manifest has 231 rows: 30 tables,
> 57 indexes, and 144 triggers. Wrapped `--rc-app` drivers connect/autostart the owner best-effort, but
> its only successful production owner operation is authenticated health with
> `ownerOperationsWritable:false` and `nativeRegistrationEnabled:false`; its dispatch registry is
> empty. It persists the owner service lease and can host durable runtime-owner records, while A0
> drivers remain unchanged: no durable owner registration, A1 binding activation, private Claude RC
> row, or new A1 mutation or broker capability is advertised. A1.4 is next.

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
- Active shared canonical primitive and locked A0 consumer:
  `packages/clawsec/src/{canonical,aad}.ts`.
- A1 host-state and runtime-owner code:
  `packages/cli/src/host/state/{ids,path,validation,records,runtime,digests,protected,dispatch,backend,secure-filesystem,migrations,artifacts,repository,runtime-repository,sqlite}.ts` and
  `packages/cli/src/host/runtime-owner/**`. A1.2 implements the generic v3
  server/project/chat/binding/edge/coordinator operations described below. A1.3 implements the v4
  runtime-owner tables/repository and live health-only owner daemon. It does not yet implement private
  Claude RC rows or connect native drivers to durable registration.
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
history ([Protocol & Runtime §12](protocol.md#12-convergence--failure-modes)), so local JSONL must not
be assumed to be the remote-claw server log; its exact compact role still needs the Phase B4 gate.

**Historical investigation claim — resume/re-bridge.** When
`claude --remote-control --resume <U>` reconnects to a server that accepts the
same `cse_` but has no history, Claude does not replay its prior conversation.
The bridge body is `{}`, there is no `POST /v1/code/sessions`, and no historical
payload is sent to the worker server. The wrapper must already have the
history if gated re-verification confirms this behavior. The narrower tracked
fact is that worker bridge/SSE does not provide history
([Protocol & Runtime §12](protocol.md#12-convergence--failure-modes)).

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

1. RC server event log: **cleartext, host-owned, kept LOCAL on the host**. In the selected future
   runtime, invariant-bearing rows use the identity-namespaced `host-state-v1.db`; transport-only raw
   bodies may use a separate adapter-private database under that same identity's XDG state directory.
   Nothing on the host needs encryption — it is the user's own machine, with no zero-knowledge
   requirement — and this log is **never sent to the broker**. It is the authoritative server state
   for `mitm.ts` and `session.ts`. It stores canonical RC event ids, RC sequence numbers, raw event
   bodies, downstream delivery state, worker epoch, close/archive metadata, and compact boundaries.
   This log is required even when no viewer is connected.

2. Broker frame log: sealed viewer transport, prototyped by the historical A0-compatible Turso
   `frames` table and migrated for selected A1 as described below. It stores encrypted frame JSON and
   cleartext transport routing/cursor columns. It serves remote-claw viewers and catch-up. It should
   not be treated as the RC server state because the broker should not need plaintext RC payloads and
   because broker frames do not capture worker delivery acknowledgements or exact `/worker/events`
   duplicate response semantics.

The RC event log projects into the broker frame log. Projection is idempotent:
an accepted RC event can create zero or more rendered viewer parts, each with a
deterministic broker message id derived from the RC event id and part index.
The raw RC order remains `(sequence_num, part_index)`; broker `seq` remains a
dense viewer-order cursor because the viewer-side `FrameOrderer` treats `seq` as
the viewer stream order and chunk parts as fragments of one same-kind message.

For the future host runtime, this RC-specific schema remains an adapter-owned private-Claude transport
schema and does not become the semantic transcript. Tables participating in the logical-chat,
native-binding, attachment, delivery-attempt, dispatch, or effect-gate invariants live in the same
owner-only `host-state-v1.db` transaction boundary as the narrow coordinator control journal. A
separate adapter-local store is permitted only for raw transport material whose loss or update cannot
cross one of those atomic invariants; it retains immutable refs and digests back to the host-state row.
The physical database, secure open/migration path, and high-level transaction kernel landed in A1.1;
A1.3 now opens it from the runtime-owner daemon. A1.2 adds the generic durable graph and the journal entries for project bootstrap,
non-first terminal reservation, terminal selector replacement, and coordinator acquisition/release.
It also provides exact-retry/read-side reconciliation and full restart inventory, but production does
not yet invoke those A1.2 operations. Command proposal/decision entries, ingress queues, and actors remain A1.7;
A1.2's server-control/chat actor scope is durable addressing only.

The journal's `command_seq` is the definitive decision order for proposals that remote-claw server
received from its direct collaborators, including forwarded, queued, and rejected decisions. It is a
globally unique audit position, not a host-wide execution queue: each logical chat offers only its own
forwarded subsequence inward, and an uncertain delivery in one chat does not block another.
`command_seq` neither orders direct native-TUI actions nor replaces the native harness's final applied
interleaving. Rebuildable projection
`chat_seq`, Claude `sequence_num`, Codex thread/turn/item IDs, and broker `seq` are mappings/cursors in
their separate domains. An adapter or provider incarnation may be replaced without changing the
`(collaboration_server_id, logical_chat_id)` scope.

Every join shown below is one session lane. One paired host may hold many such joins concurrently,
including multiple Claude sessions in the same or different directories and sibling Codex/OpenCode
bindings in their adapter stores. RC event, worker-epoch, delivery, projection, compaction, and
recovery queries always begin from the exact logical-chat/native-binding/attachment tuple or its
unique `cse_session_id`; they never select a host-wide “latest” session. Closing, superseding, or
quarantining one attachment cannot change another lane or close a shared native daemon.

The durable identity join for one Claude session is:

```text
(collaboration_server_id, logical_chat_id)  remote-claw's canonical user chat
└── native_binding_id                        binding to the proven semantic Claude conversation
    ├── native incarnation history           exact Claude process generations
    └── rc_attachment_id                     one private RC transport generation
        └── cse_session_id                    canonical only within the RC event/worker tables below
            └── worker_epoch                  lease to one native incarnation + coordinator epoch
```

Claude's proven transcript/resume UUID belongs to the native binding's
`conversationId`; it must never be inferred from or replaced by `cse_session_id`.
On recovery the coordinator first reuses a known, complete `cse_session_id` and
starts a new worker epoch tied to the current native incarnation and coordinator
epoch. The attachment belongs to the native binding, not to one process
incarnation, so a cold native resume can reuse the same `cse_session_id`. A new
`cse_session_id` is allowed under the same `(collaboration_server_id, logical_chat_id)` scope only
through a
durable, proof-carrying RC-attachment replacement: preserve and supersede the
old attachment, bind the replacement to the exact logical chat/native binding,
and record the recovery evidence plus any explicit history gap. A gap records
missing evidence; it does not by itself prove that the old attachment can no
longer accept writes. Merely seeing an unknown `cse_*`, losing process memory,
or reconnecting a client is not replacement proof and never creates a new
logical chat.

## Data Model

The historical Turso frame table inspected on `feat-turso-broker-catchup` was:

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

That table is retained evidence for the shipped A0-compatible durable backend. Its
`UNIQUE(token, gen, msg_id, part)` rule is not the selected client-driven A1 replay contract. A1
requires a broker migration whose transport row is unique route-wide on
`(token, delivery_attempt_id, part)`, stores its assigned `(generation, frame_index)`, and stores the
normalized transport-frame digest. An exact retry before or after rollover returns that original
cursor only when the complete normalized frame digest matches; unequal bytes fail closed as a
transport collision. Separate sealed-generation manifest rows define frame counts, next-generation
links, and empty generations. Stable semantic results remain host-owned and key on the full
server/chat/source namespace plus `msg_id`; they are not collapsed into the broker transport key. The
no-rollover Workflow backend remains A0-only and cannot claim this A1 contract.

The physical cursor/manifest key is one immutable authenticated broker route, not a parsed chat:
`scope_bus` has one null-chat discovery route, `server_control` has a distinct null-chat management
ingress/result route, and each `chat` route has its exact chat. A position is unique on
`(broker_route_id, generation, frame_index)`.
Same-position/same raw digest is idempotent; different bytes retain equivocation evidence and quarantine
the route before parse/open. The first sealed manifest tuple is immutable; changed count/state/successor
or an index outside its sealed count records manifest equivocation. Chat, server, machine, and
bus↔control↔chat route transplants are invalid on the externally selected route and never dispatch by the
embedded header.

Chat and server-control ciphertext bodies are retained from genesis. Only discovery-only scope-bus
bodies in a sealed generation covered by a fresh host-signed successor checkpoint may be compacted
after all supported recovery leases pass. Selected A1 retains every route-wide
attempt/part→original-cursor/digest tombstone and generation manifest indefinitely. Ordinary retention
expiry, local chat closure, and machine reset are insufficient:
copied bearer/key material may remain valid, and A1 has neither an in-place key epoch nor a
broker-enforced permanent route-revocation protocol. A future bounded-retention version must add and
prove that protocol before it may collect these records.

The implemented A1.1–A1.3 kernel supplies the secure transaction/storage boundary for the owner-only
**LOCAL**
`$XDG_STATE_HOME/remote-claw/identities/<machineIdentityId>/host-state-v1.db` SQLite database,
falling back under `~/.local/state` when `XDG_STATE_HOME` is absent or relative. The fallback home
must be absolute; a relative or empty value is rejected rather than resolved under the working
directory. It is Linux-only, requires an exact stable Node.js `X.Y.Z` version in
`^22.13.0 || >=23.5.0`, and opens `node:sqlite` through a held `/proc/self/fd` descriptor. A1.3's
independently supervised daemon now opens this database on wrapped `--rc-app` driver paths; owner
unavailability preserves the A0 path without claiming A1.
Local-filesystem policy v1 allows ext, XFS, Btrfs, F2FS, and ZFS only. It requires exact `0700`
application/identities/identity directories, a non-group/world-writable owner state home, and owned
regular one-link `0600` database/WAL/SHM files; rollback journals, non-WAL databases, and all other
filesystem types fail closed.

Current schema v4 uses SQLite `application_id=0x52434c57`, `user_version=4`, exact per-version schema
manifests, and an append-only `CanonicalWriter` SHA-256 migration chain. The locked v1/v2 digests are
`Pk8Yrc3jVK9xoHKDcBdeyejFYUSbyjnp-SH0VMA_Hec` and
`yx23Bca9rSZttCEInDAEOrzLVhq-KWcZLE1i27tqNiY`; migration 3 is
`003-durable-host-records`, contains 81 ordered statements, and is locked to
`cMLS59JfiV7fRoK68n1kZz3DN9Vo4yu7VZAX_HxHpq4`. Migration 4 is
`004-runtime-owner-durability`, contains 141 ordered statements, and is locked to
`zx52EtAFNY9hEZneG3RW14zRCYR18gg7ysnltHbOkT0`. Every predecessor is checked before migrating. The v1 exact six-object `sqlite_schema` manifest has three tables, one explicit unique index, and
two triggers; v2 adds four triggers for a total of ten objects and six triggers. V3 adds ten tables:
`collaboration_servers`, `host_state_profiles`, `projects`,
`project_target_selector_mappings`, `logical_chats`, `native_bindings`,
`native_registration_intents`, `inward_collaboration_edges`, `coordinator_leases`, and
`control_journal_entries`. The complete v3 manifest is exactly 91 objects: 13 tables, 24 indexes, and
54 triggers. V4 adds 17 tables for runtime-owner state and its service journal, runtime roots and
incarnations, append-only owner assignments, containment, wrapped identity keys and signature
reservations/acceptances, project-scoped local conversations/transitions, binding incarnations,
transport attachments/leases, and lifecycle gates. The complete v4 manifest is exactly 231 objects:
30 tables, 57 indexes, and 144 triggers. Every row,
including any `sqlite_*` name, must match the corresponding version manifest. Before migration 1, a
new database must retain `application_id=0` and literally zero `sqlite_schema` rows. Every connection
reads back `foreign_keys=ON`, `trusted_schema=OFF`, `journal_mode=WAL`,
`synchronous=FULL`, `busy_timeout=5000`, `temp_store=MEMORY`, and `recursive_triggers=ON`; the initial
existing-state validator also requires `query_only=ON`. Every connection behavior-probes that
double-quoted string literals are disabled. It validates the logical WAL state in one read-only
transaction snapshot before opening a writable SQLite connection. A future version present only in
crash WAL is rejected without rewriting the main database or WAL. SHM remains guarded but is transient
and may change during validation; a safe SHM-only remnant beside an existing database can be
reconstructed, while sidecars without a database are refused.

The semantic validator accepts the dormant A1.2 subset plus the A1.3 runtime-owner graph. An existing database is
checked in one coherent read-only snapshot before writable open; a newly migrated database is checked
before its handle returns. State is empty or has one linked default profile and `installing` server; projects are
current; each project's one persisted v3 selector chain is contiguous, terminal-native, and ends in exactly one current generation;
and every logical chat records its exact `project_target_selector_mapping_id`. Chats remain
recovering at topology generation one and projection sequence zero. Each points to one unresolved
starting binding, exactly one registration intent, and one random `rcie_*` native-harness edge that is
still installing with every certificate/live-connection/capability pointer null. Nested mappings and
remote-server edges are rejected until N1 supplies a migration and proof. Evidence refs/digests are
opaque in A1.2; A1.4 must resolve and verify them before live setup.

V4 additionally validates one machine-scoped runtime-owner state row, contiguous retained service
epochs and owner journal, exact process-start-bound lease acquisition/renewal/release, derived
`rcrt_*` runtime roots, incarnation and append-only assignment lineage, positive
replacement/termination containment, one current wrapped Ed25519 key per current runtime, globally
non-colliding `rcph_*` protected handles, purpose/sequence-bound signature reservations and
acceptances, project-scoped local conversation transitions, and mutually fenced binding incarnation,
attachment lease, and lifecycle-gate joins. A local transition can be recorded while the coordinator
is unavailable only after its `projectId` already exists; first-project and explicit-project
allocation remain coordinator-owned. Implemented rotation retains the retired key ciphertext as audit
state, so its logical destruction is not physical erasure. Schema v4 represents revocation too, but
A1.3 exposes no separate revocation operation; a later implementation must retain revoked ciphertext
under the same rule.

The v4 journal is a one-to-one semantic ledger, not a count-only audit. Every journaled fact claims one
exact journal row with matching kind, subject, semantic IDs, owner fence, timestamp, and lifecycle
order, and no journal row may remain unclaimed. Lease-scoped effects occur at or after acquisition and
before the heartbeat deadline; an explicitly released lease further caps them at `releasedAtMs`.
`service_lease_released` occurs exactly at that time and is the final journal effect for the lease,
although an ordinary effect may share the same millisecond at an earlier offset. Conversation recovery
requires an earlier-introduced source, exactly one creator per conversation, an acyclic same-runtime-
incarnation parent graph, exact fork source/parent equality, no invented parent on non-fork creation,
and current state consistent with replayed clear/archive/unarchive transitions. Binding recovery
requires one exact attachment/lease/gate graph per prepared binding incarnation and the ordered paired
journal facts under one owner fence and timestamp. Runtime effects bind the assignment active at their
journal position and its exact incarnation; assignment activation precedes containment, and
replacement/termination carries the predecessor assignment fence. Key rotation atomically binds the
predecessor's destruction, successor creation, journal time, and active assignment. After service
takeover, every runtime/key/signature/transition/containment mutation conflicts without poisoning until
that runtime receives its explicit successor assignment; the predecessor lease stays stale.

The A1.2 repository atomically bootstraps the first project plus mapping/chat/binding/intent/edge,
allows explicit later projects only after that bootstrap, reserves later chats against an exact
mapping fence, and replaces a terminal selector by generation compare-and-swap without retargeting
old chats. It inventories projects, mapping histories/current mappings, chats, bindings, full terminal
reservation graphs, and coordinator acquisitions for restart. Coordinator acquisition, release,
project bootstrap, non-first terminal reservation, and mapping replacement each allocate an exact
immutable journal entry; renewal changes only the heartbeat deadline. Expiry takeover advances the
server pointer/epoch without rewriting the predecessor lease. Release may clear that pointer only
after the exact lease and epoch it still names have been released. Exact retries and read-side
reconciliation classify persistence outcomes, returning explicit indeterminate state where later lease
changes prevent exact proof; they are not A1.4's live registration/callable-port
workflow. A1.3's production lease controller handles an unknown owner-lease commit by closing the
poisoned handle, reopening the same identity database, and reconciling the exact operation before any
retry; this does not make an arbitrary unknown ordinary SQLite commit safe to replay blindly. The landed actor
scope is only durable addressing; A1.7 owns queues, proposal decisions, and serialization.

A1.3's daemon listens on one machine-scoped Linux abstract Unix socket. Both peers derive one HKDF key
from the machine secret and prove possession over a fresh 32-byte challenge, with separate server and
client domain tags in the HMAC proof inputs. The
server admits at most 64 total live connections; each unauthenticated connection is capped at 1,024
inbound bytes and one exact authentication frame, and pre-authentication pipelining closes it.
Canonical length-prefixed JSON is limited to 1 MiB, 32 in-flight requests, and 4,096 request IDs per
connection; replayed IDs, malformed or unknown messages, authentication failure, and listener loss
close or poison the relevant boundary. A silent handshake timeout closes the connection; an
authenticated request timeout returns the fixed `TIMEOUT` error for that request and leaves the
connection usable. The detached daemon receives only the absolute secret-file
path and machine ID and starts with an allowlisted environment and Node loader arguments. Its cwd is
pinned to the trusted CLI entry directory so project-controlled cwd/`tsconfig` state cannot influence
the retained tsx loader. Its current
production wire surface includes health and dispatch, but its dispatch registry is empty; authenticated
health is therefore the only successful operation and returns `ownerOperationsWritable:false` and
`nativeRegistrationEnabled:false`. Losing only the owner's wrapper RPC connection detaches that
collaborator and does not release the daemon's service lease. Existing A0 driver teardown remains
separate and unchanged.

FULL WAL `COMMIT` is migration durability. Post-commit validation uses a coherent snapshot, then a
non-blocking `wal_checkpoint(PASSIVE)` and guardian fsync; a reader may defer frame copying and a
competing checkpoint may return exactly `busy=1`, `log=-1`, `checkpointed=-1` without turning the
committed migration into failure. Every other inconsistent result fails closed. Typed committed and
unknown migration outcomes both permit retrying open. Ordinary writes perform no mandatory checkpoint
or extra fsync: a post-commit
guardian failure reports committed state, while an unknown ordinary `COMMIT` is not retry-safe; both
poison the handle. Migration and ordinary writers revalidate guardians immediately after acquiring
`BEGIN IMMEDIATE` and before migration SQL or the public callback.

The synchronous public transaction surface exposes high-level operations only—never raw SQL—and
proves generic protected-artifact multiwrite rollback. Database-level asynchronous artifact methods
reject synchronously inside the callback; atomic work must use its transaction-bound operations.
Immutable artifacts are
scope/schema/reference/digest verified with stored-length validation, capped at 16 MiB, and assigned
a random `rcph_*` with at most eight collision attempts. Persistence failures are distinct from an
unverified-artifact result and poison the live database handle. The public database opener exposes
only machine identity plus optional path environment, never entropy or clock injection.

Forbidden async/thenable transaction results roll back and poison before late continuation can reuse
the handle. Close releases descriptor guardians only after SQLite is closed; an incomplete close
retains them and is retry-close-safe. If a failed open cannot close every SQLite connection, the
kernel retains the connections and guardians in fail-stop quarantine, rejects every later open of that
canonical database path until process restart, leaves other database paths independent, and marks that
open failure not retry-safe.

A1.2 has added the generic host-state tables and repository; B.2 adds private Claude RC event
tables/projection state. The database is in
**cleartext** — nothing on the host needs encryption, and the broker never holds RC plaintext (only
sealed frames cross to the cloud). The interface keeps the storage choice hidden from `mitm.ts` and
`session.ts`. Large raw adapter-only payloads may move to a separate local store only under the
no-cross-store-invariant rule above. (Decided: do NOT put RC payloads in the broker Turso — there is
no host-encryption hedge to make, because the RC log simply stays local.)

The RC event store records each semantic projection/result separately from its broker delivery attempt,
part, and cursor. The A0 historical table can remain for A0 channels, but it cannot be relabeled A1 or
used to claim A1 idempotency without the migration above.

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
CREATE TABLE logical_chats (
  logical_chat_record_id   TEXT PRIMARY KEY,
  collaboration_server_id TEXT NOT NULL,
  logical_chat_id          TEXT NOT NULL,
  UNIQUE (collaboration_server_id, logical_chat_id),
  UNIQUE (
    logical_chat_record_id,
    collaboration_server_id,
    logical_chat_id
  )
);

CREATE TABLE rc_transport_attachments (
  rc_attachment_id       TEXT PRIMARY KEY,
  logical_chat_record_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  logical_chat_id        TEXT NOT NULL,
  native_binding_id      TEXT NOT NULL,
  rc_generation          INTEGER NOT NULL,
  cse_session_id         TEXT NOT NULL UNIQUE,
  replaces_attachment_id TEXT,
  status                 TEXT NOT NULL, -- active, superseded, closed
  recovery_evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms          INTEGER NOT NULL,
  superseded_at_ms       INTEGER,
  UNIQUE (logical_chat_record_id, rc_generation),
  UNIQUE (collaboration_server_id, logical_chat_id, rc_generation),
  UNIQUE (native_binding_id, rc_generation),
  UNIQUE (rc_attachment_id, cse_session_id),
  FOREIGN KEY (
    logical_chat_record_id,
    collaboration_server_id,
    logical_chat_id
  ) REFERENCES logical_chats (
    logical_chat_record_id,
    collaboration_server_id,
    logical_chat_id
  ),
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
- Preserve the current registration lifecycle boundary: Claude MITM, OpenCode, and tmux sessions
  enter through `LegacyRcConversationRegistrar`, which starts `startBridgeSession` only at `ready`.
  OpenCode reaches `ready` only after confirming one exact canonical native session ID and, unless
  explicitly opted out, completing required parent permission setup. Tmux reaches `ready` only after
  its private server/socket and owner-only launch artifacts exist, a positive pane probe and required
  SessionStart marker prove native startup, and its post-setup capabilities are known. Native tmux
  pumps may exist before publication, but no broker client, announcement, or remote mutation is
  possible before `ready`.
  Each registrar lease owns its relay abort signal, and the bridge's `served` promise tracks the
  admitted initial and lifecycle refresh posts through settlement; launchers may still bound how long
  teardown waits for that promise.
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

Every lifecycle below is scoped to one exact logical-chat/native-binding/RC-attachment lane. A host
restart enumerates all current lanes and may recover them concurrently with bounded work; one failed
or ambiguous lane remains non-writable without delaying another lane's local TUI, bridge, event
sequence, or projection.

New remote-control session:

1. `POST /v1/code/sessions` creates `rc_sessions`.
2. Bridge starts epoch 1.
3. Any initialize/control downstream event is appended before being sent.
4. Viewer frames are projected after durable append.

Resume/re-bridge for known `cse_`:

1. Load the canonical `(collaboration_server_id, logical_chat_id)` scope, its current native
   binding/incarnation, and that binding's active RC attachment.
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
   same `(collaboration_server_id, logical_chat_id)` scope and native binding.
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
  rebuild semantic projections from `rc_event_parts` and enqueue a fresh broker delivery attempt for
  each missing projection. A0 reprojection uses its historical `broker_msg_id`/part key. Selected A1
  preserves the stable semantic result ID separately, writes ahead one fresh `delivery_attempt_id`,
  and makes retries of that same outbox row reuse its route-wide attempt/part key and original cursor,
  including after rollover.
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
- Provider ingress deduplicates by the coordinator's durable
  `(collaboration_server_id, logical_chat_id)` scope, outside-binding, source-event-namespace, and
  event-ID identity, not by connector incarnation. Reconnect or provider replacement must consult
  canonical source-event, observation, and correlation history across prior incarnations before
  allocating a command. A reset namespace requires a versioned,
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

Historical branch phase called “A1” - A0-compatible durable broker frames:

- Status: historical branch evidence only; its name predates the selected client-driven A1 protocol.
- Branch basis: `feat-turso-broker-catchup` / `origin/feat-turso-backend`.
- Files: `apps/web/lib/broker/turso.ts`,
  `apps/web/lib/broker/turso-connection.ts`,
  `apps/web/lib/broker/index.ts`,
  `apps/web/test/broker/turso-backend.test.ts`.
- Goal at the time: durable sealed A0-compatible viewer frames with idempotent
  `UNIQUE(token, gen, msg_id, part)`. Selected A1 instead requires the generation-aware
  delivery-attempt/digest/cursor-manifest migration described above.
- Tests: Turso publish/subscribe, duplicate `msg_id`/part insert, generation
  close/reopen, cursor catch-up from stored `id`.
- Gate: tests prove publish idempotency, subscribe from cursor, generation
  close/reopen behavior, and no plaintext transcript requirement in broker.

Phase A2a - Retire host memory as viewer catch-up source:

- Status: historical integrated/superseded snapshot, not an active selected-A1 phase.
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

- Status: historical integrated/superseded snapshot, not an active selected-A1 phase.
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

- Status: historical planning snapshot; selected retention ownership is assigned below.
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

- Status: unbuilt historical Claude-only slice; selected implementation ownership is B.2.
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
  proof-carrying replacement `cse_` that remains under the same server/chat scope.
- Gate: duplicate upstream POST returns `duplicate:true` with original
  sequence; restart plus `--remote-control --resume <U>` continues from stored
  history with no replay required. Recovery must try the known `cse_` first;
  replacement without recorded containment proof fails closed and cannot mint
  another logical chat.

Phase B2 - Durable downstream delivery and epoch fencing:

- Status: unbuilt historical Claude-only slice; selected implementation ownership is B.2/B.3.
- Files: `session.ts`, `mitm.ts`, event-store adapter tests.
- Goal: pending downstream events survive restart; worker epoch rejects stale
  writers; delivery acks are durable.
- Tests: same-epoch SSE reconnect, processed ack suppression, unprocessed
  redelivery, two-worker epoch race.
- Gate: same-epoch SSE reconnect redelivers only unprocessed events; two-worker
  race accepts new epoch and rejects stale epoch with no sequence allocation.

Phase B3 - RC event to broker projection:

- Status: unbuilt historical Claude-only slice; generic outbox/projection ownership is A1.8/A1.10 and
  private-Claude event projection ownership is B.2.
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

- Status: unbuilt historical Claude-only slice; selected family-proof ownership is B.5.
- Files: new `packages/cli/src/host/rc/transcript-watcher.ts`,
  `session.ts`, `relay.ts`.
- Goal: detect local JSONL `isCompactSummary:true`, insert durable
  compaction row, emit viewer reset/summary frame.
- Tests: local compact summary detection, remote compact result-only fallback,
  viewer hides pre-boundary display while raw events remain queryable.
- Gate: local and remote `/compact` tests show visible viewer history resets
  to summary while raw durable log remains append-only.

Phase B5 - Archive/close fidelity:

- Status: unbuilt historical Claude-only slice; selected family-proof ownership is B.5.
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
  both attachments map to the same `(collaboration_server_id, logical_chat_id)` scope/native binding
  while only the replacement is active.
- Integration test host multiplicity: run at least three Claude sessions under one paired host, with
  two distinct working directories and two sessions sharing one directory. Reuse the same RC event
  IDs and viewer `msg_id`s in different sessions, interleave traffic, leave one turn busy, and make a
  second session's worker response ambiguous. Require distinct logical chats, bindings,
  `cse_session_id`s, worker epochs, sequences, delivery rows, broker routes, projections, and local TUI
  histories; the third session must continue without waiting for or reading either sibling.
- Integration test multiplicity recovery: restart the host with all three native sessions still
  available, make one exact reattachment succeed, one cold-resume the same native conversation, and
  one fail identity proof. Require the first two to retain their existing visible rows and histories,
  quarantine only the failed row without minting a replacement chat, and keep all healthy local TUIs
  and remote lanes usable.
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
- Projection test: raw RC event with multiple render parts maps to stable semantic projections. In A0,
  reprojection is a no-op under `UNIQUE(token, gen, msg_id, part)`. In selected A1, one semantic result
  is retained separately from its delivery rows; an exact outbox retry reuses one route-wide
  `(token, delivery_attempt_id, part)` insertion and original cursor across rollover, while a later
  result delivery uses a fresh attempt ID.
- Compact test: JSONL summary row creates compact marker and viewer reset.
- Broker tests from A1/A2: Turso publish idempotency, subscribe by cursor,
  `maxSeq` continuity, retention.

## Combined Claude Durability Release Gate

The numbered B PR slices in [Client-driven Host Runtime](client-driven-host-runtime-reference.md#13-delivery-plan)
land independently and pass the relevant subset of these checks while keeping dependent capabilities
disabled. The combined Claude durability capability is not complete until the integrated B release
demonstrates every property below:

- The wrapper can be killed and restarted without losing the ability to answer
  duplicate `/worker/events` POSTs with the original sequence numbers.
- `claude --remote-control --resume <U>` against the restarted wrapper does not
  depend on Claude replaying prior history.
- Recovery reuses the known `cse_` before considering replacement. A replacement
  is accepted only after its containment proof and any recovery gap are
  durable, preserves the same canonical `(collaboration_server_id, logical_chat_id)` scope and native
  binding, binds its worker epoch to the exact current native incarnation/coordinator epoch, and does
  not replay prior commands.
- One paired host can recover several independent Claude lanes at once. Busy, uncertain, quarantined,
  replaced, or stopped state in one lane cannot change another lane's RC sequence, worker epoch,
  binding, broker route, visible row, local TUI, or writability.
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

## Assigned Decisions and Proof-Owned Questions

- **A1.1–A1.3 / B.2 — storage placement: DECIDED; kernel, host repository, and runtime-owner repository/daemon implemented.** Use the owner-only local
  `$XDG_STATE_HOME/remote-claw/identities/<machineIdentityId>/host-state-v1.db` SQLite
  transaction boundary in the CLI, with the absolute-home `~/.local/state` fallback above, for every RC row that
  participates in a control-state invariant, in cleartext. A1.0 resolves the path; A1.1 implements
  secure open/protected artifacts; A1.2 adds schema v3, generic host records, and semantic snapshot
  validation; A1.3 adds schema v4 and opens it from the health-only runtime-owner daemon. A separate local adapter store may hold only raw transport payloads with immutable host-state
  refs/digests and no cross-store atomic invariant. Nothing on the host needs encryption, and the RC
  event log is never sent to the broker, so there is no host-encryption question. The broker holds
  only sealed frames; RC plaintext stays on the host.
- **B.2 — unknown resume policy: DECIDED.** Production rejects unknown `cse_` resumes by default.
  Explicit debug adoption may be retained, but it must mark history incomplete and name
  an existing logical-chat/native-binding target explicitly. An unknown `cse_`
  is never sufficient evidence to allocate or select a logical chat.
- **A1.10 / B.2 — broker sequence mapping: DECIDED.** Keep dense broker `seq` separate from private Claude
  RC `sequence_num`; the projector retains their explicit mapping and never substitutes one for the
  other.
- **B.5 — compact source: PROOF-OWNED.** Tracked relay protocol describes an assistant compact-summary turn plus `result`
  ([Protocol & Runtime §12](protocol.md#12-convergence--failure-modes)), while the unavailable
  historical native-RC investigation reportedly saw only an empty result on the
  wire and summary text in local JSONL. Treat this as version/mode dependent
  until B.5 retains the selected fixture; do not require local transcript watching or
  expose compact as result-only based on either observation alone.
- **A1.6 / A1.8 / B.2 — retention: ASSIGNED.** A1.6 owns sealed broker-frame retention, A1.8 owns generic outbox retention,
  B.2 owns private raw RC events, delivery rows, and compacted visible-history retention. Raw RC logs
  remain longer than viewer frames because idempotency and audit depend on them. Each slice must
  choose and test its concrete policy before enabling destructive collection.
- **B.4/B.5 and C.4/C.5 — outward connector credentials: ASSIGNED.** Brokered native mode needs a separately
  secured OAuth source and explicit test-session guardrails. Remote-claw owns
  the real worker/app credentials; the isolated inner Claude receives only
  synthetic/local auth and never refreshes or reads the real provider secret.
  B.4/C.4 implement isolated credential storage and leases; B.5/C.5 own rotation, revocation, and live
  official-client release proof.
- **B.4 — native client stream endpoint: DECIDED.** The A0 relay does not add a general
  native-compatible `/events/stream`. B.4 owns any provider-client-facing history/SSE surface needed
  by the outward Anthropic connector and its reconciliation path; remote-claw viewers continue to use
  the E2E broker, while the private Claude worker keeps its distinct worker stream.
