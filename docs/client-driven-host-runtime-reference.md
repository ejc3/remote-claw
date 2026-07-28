# Client-driven host runtime: technical reference

> This is the exhaustive implementation reference for the
> [client-driven host runtime](client-driven-host-runtime.md). Start with the shorter architecture
> page unless you need record shapes, adapter contracts, recovery algorithms, or crash-boundary proof
> requirements.

**Status:** selected next architecture; implementation in progress.

**Current external behavior remains compatible:** today `--rc-app` hosts an in-memory `RelayCore`
that lazily creates one Claude-shaped `Session` per intercepted Claude RC session. A host-scoped
process-local registrar now gives each intercepted session a distinct `rcb_*` lease, waits for
validated capabilities and `ready`, and only then starts its broker bridge. The separate OpenCode and
tmux launch paths still create and bridge their wrapper `Session` directly. No current path persists a
logical-chat/native binding across an ordinary wrapper restart; the current synthetic Claude
`Session.id` is also used as the broker/web session key, so an ordinary restart can appear as another
row. Codex is not implemented. The selected A1 design below removes that ID alias and keeps the
remote-claw logical chat stable across proven native recovery.
[Protocol & Runtime](protocol.md) remains the as-built reference.

## 1. Decision

remote-claw is one host daemon beside the coding clients, normally inside the same small VM. Its
nesting is:

```text
host / VM
└── remote-claw host daemon
    ├── session coordinator
    │   └── logical chats, ordering, delivery state, and recovery journal
    ├── local client faces
    │   ├── wrapped Claude terminal
    │   ├── Codex client endpoint
    │   ├── OpenCode client endpoint
    │   └── tmux editor/diagnostic view
    ├── native engine runtimes
    │   ├── Claude control wrapper ── inner Claude Code
    │   │   └── private Anthropic-shaped API façade
    │   ├── Codex app-server wrapper ── private Codex app-server
    │   │   └── private OpenAI-shaped API façade
    │   ├── OpenCode server adapter ── private OpenCode server
    │   │   └── private provider-shaped API façade(s)
    │   └── tmux control fallback ── supported inner engine in a pane
    ├── model/inference connectors
    │   └── configured Anthropic, OpenAI, Bedrock, or other model service
    └── outward connectors
        ├── Anthropic Remote connector ── Anthropic ── official Claude clients
        ├── ChatGPT Remote connector ── OpenAI ── official ChatGPT clients
        └── web connector ── E2E-encrypted broker ── remote-claw web clients
```

There are two independent jobs on the native side:

1. **Control the engine.** Claude uses its private RC protocol, Codex uses an app-server boundary,
   OpenCode uses its HTTP/SSE server, and tmux is a lower-fidelity fallback.
2. **Broker the engine's model/API traffic.** Every provider-shaped request from an inner process
   terminates at a private local façade. A separate remote-claw inference connector may call a
   configured Anthropic, OpenAI, Bedrock, or other model service, but the inner process never owns
   those credentials or sockets. Unknown inner routes fail closed; they are never blindly tunneled.

For OpenCode, the server API solves the first job only. Shared-chat mode must also configure every
model provider endpoint through a private façade and enforce a network fence. Tmux likewise composes
with the selected engine's provider façade; it is a control fallback, not an escape from isolation.
The first tmux implementation remains Claude-specific until another engine's capture/recovery rules
are proven.

The wrapper-owned local terminal/app, official Anthropic Remote clients, official ChatGPT Remote
connection clients, and remote-claw web are the supported outside surfaces. No arbitrary application
protocol is implied.

Local official-style clients are supported through the wrapper boundary, not by exposing the private
inner runtime. A local Codex client connects to the client-facing app-server proxy; an OpenCode client
connects to the controlled server proxy. Claude is harder because its terminal UI and engine are the
same process: the wrapper must intercept a local submission before it reaches PTY/native execution, or
make that raw TUI read-only and supply a wrapper-owned editor. All three routes then enter the same
coordinator command path as web and official remote input.

The session coordinator is the one shared decision point. It is not another coding agent, model
gateway, provider server, or replacement model context.

## 2. One source of decisions, several sources of evidence

There is no useful single “source of truth” for every kind of fact. Authority is divided by job:

| Fact | Owner |
|---|---|
| Native conversation, context, tools, subprocesses, and side effects | Native runtime and its durable native store |
| Which submitted command is first, admitted, queued, rejected, or uncertain | Local session coordinator |
| Which provider representation was accepted and can be read back | OpenAI or Anthropic transport |
| What an official app actually rendered | That official client device; not generally observable here |
| Which sealed frames the broker accepted and can replay | remote-claw broker |
| Which frames were decrypted and rendered | remote-claw viewer |

The coordinator keeps a small control journal, not a competing assistant transcript. It stores:

- stable command IDs and origins;
- the definitive order in which commands were admitted or queued;
- admission and queue decisions;
- native and outward delivery state;
- native conversation IDs and recovery cursors;
- exact correlation mappings;
- uncertain outcomes and explicit recovery gaps.

The native client remains the first recovery source for conversation history and execution state.
The coordinator may cache normalized messages for projection, but it must not rebuild a native
conversation by replaying prompts, tool calls, or approvals.

This split is the core rule:

> The coordinator decides what may happen next. Native state is the first semantic evidence of what
> happened; anything it cannot positively establish remains uncertain or becomes an explicit gap.

## 3. Nesting and identity

The user-visible hierarchy remains:

```text
host
└── project
    └── logical chat
```

Each logical chat has one current native conversation and any number of outside views:

```text
logical chat
├── native conversation
│   ├── product: Claude Code | Codex | OpenCode
│   ├── access: wrapped API | app-server | server | tmux
│   └── native session/thread ID
├── ordering and delivery journal
└── outside bindings
    ├── wrapper-owned local terminal/app
    ├── Anthropic Remote session, when enabled
    ├── ChatGPT Remote connection host/thread, when enabled
    └── remote-claw web session
```

IDs from one layer never become IDs for another:

- a Claude `cse_*`, Codex thread ID, OpenCode `ses_*`, tmux pane, and remote-claw chat ID are distinct;
- one Codex host registration contains many projects and threads;
- one Claude outward Remote session normally represents one logical chat;
- replacing or resuming a native process updates its binding without silently merging another chat.

The durable identity layers are:

| ID | Meaning | Restart rule |
| --- | --- | --- |
| `logicalChatId` | Canonical remote-claw chat and visible web row | Stable across coordinator, wrapper, native-process, inner-transport, and outward-connector restart |
| `nativeBindingId` | Durable relationship between one logical chat and its current native conversation | Stable while the same semantic native conversation is resumed; explicit replacement retains immutable prior binding history |
| Native conversation ID | Claude transcript/resume UUID, Codex thread ID, or OpenCode session ID | Native evidence; never a remote-claw routing ID |
| Native runtime/incarnation | One provably identified process, app server, or server generation | Advances on a cold native replacement; a live reattach may retain it |
| Native transport attachment | Inner Claude `cse_*`, app-server connection, SSE connection, or tmux attachment | Reused first when the native protocol permits; otherwise replaceable beneath the binding |
| Outside binding/incarnation | Anthropic Remote session, ChatGPT host/chat, or web transport mapping and connection epoch | Independent of native restart; reconnect or provider-forced replacement does not change `logicalChatId` |
| Source event namespace | Proven uniqueness domain for one outside source's event IDs | May span connector incarnations; changes only after positive evidence that the provider reset or replaced the ID domain |

`logicalChatId` is allocated durably before the first native or outward mutation. It is never derived
from a title, working directory, message text, `cse_*`, Codex/OpenCode ID, pane, broker channel, or
provider ID. `command_seq` and normalized `chat_seq` are scoped to it and do not reset when any
transport changes. Exactly one native binding/incarnation is writable at a time; superseded records
remain immutable because delivery attempts name the exact native reference they might have reached.

An infrastructure restart never creates another visible chat. A proven resume of the same semantic
native conversation keeps both `logicalChatId` and `nativeBindingId`, even if the runtime or private
transport ID changes. An explicit new/clear creates a new logical chat; a fork creates a new logical
chat with parent/fork lineage. If recovery cannot prove the expected native identity, remote-claw
quarantines the old chat instead of matching by title or text. Only an explicit recovery decision may
either install a successor binding with a visible gap under that chat or create a new logical chat.

## 4. Host-wide native-client adapters

The current exported `Driver` interface is a partial, one-session, Claude-RC-shaped seam; the CLI
dispatcher still branches directly among MITM, OpenCode, and tmux launch paths, and MITM itself can
create several sessions. That interface cannot be the host-wide contract because Codex needs one host
runtime that discovers and serves many threads.

The host-level boundary introduced in A0.1 is:

```ts
type EngineProduct = "claude-code" | "codex" | "opencode";
type EngineAccess = "native-rc" | "app-server" | "server" | "tmux";

type NativeEngineDescriptor =
  | { product: "claude-code"; access: "native-rc" | "tmux" }
  | { product: "codex"; access: "app-server" }
  | { product: "opencode"; access: "server" };

interface NativeConversationRef {
  descriptor: NativeEngineDescriptor;
  // One engine daemon, server, process tree, or supervised runtime.
  runtimeId: string;
  // The stable semantic native session/thread, not a synthetic RC/provider transport ID.
  conversationId: string;
  // Monotonic native binding incarnation, not coordinator order.
  incarnation: number;
}

interface NativeProjectRef {
  projectId: string;
  cwd: string | null;
}

interface NativeConversationCapabilities {
  version: 1;
  mutationAdmission: "structured" | "mixed" | "post_hoc";
  history: "none" | "partial" | "complete";
  deliveryEvidence: "structured_receipt" | "native_observation" | "best_effort";
  liveReattach: boolean;
}

type NativeConversationPhase = "starting" | "ready" | "recovering" | "draining" | "closed";

interface NativeConversationBinding<TPort = unknown, TMetadata = unknown> {
  // null for discovery/new binding; persisted value for an explicit resume/adoption.
  bindingId: string | null;
  // Stable for retries of this registration attempt.
  registrationAttemptId: string;
  descriptor: NativeEngineDescriptor;
  project: NativeProjectRef | null;
  nativeRef: NativeConversationRef | null;
  phase: "starting" | "recovering";
  // null until adapter setup has established the truthful post-setup capabilities.
  capabilities: NativeConversationCapabilities | null;
  port: TPort;
  metadata: TMetadata;
}

interface NativeConversationLease<TMetadata = unknown> {
  readonly bindingId: string;
  readonly coordinatorEpoch: number;
  bindNative(ref: NativeConversationRef): Promise<void>;
  update(
    metadata: TMetadata,
    capabilities: NativeConversationCapabilities,
  ): Promise<void>;
  setPhase(phase: NativeConversationPhase): Promise<void>;
  close(reason: string): Promise<void>;
}

interface NativeMutationFence {
  bindingId: string;
  coordinatorEpoch: number;
  attemptId: string;
  nativeRef: NativeConversationRef;
}

interface NativeConversationRegistrar<TPort = unknown, TMetadata = unknown> {
  open(
    binding: NativeConversationBinding<TPort, TMetadata>,
  ): Promise<NativeConversationLease<TMetadata>>;
}

interface NativeEngineAdapter<TPort = unknown, TMetadata = unknown> {
  readonly descriptor: NativeEngineDescriptor;
  run(
    registrar: NativeConversationRegistrar<TPort, TMetadata>,
    signal: AbortSignal,
  ): Promise<void>;
}
```

That A0 contract is deliberately lifecycle-only. Its process-local `bindingId` is an `rcb_*` lease
key, not the canonical chat ID. A1 adds durable records above it:

```ts
interface LogicalChatRecord {
  logicalChatId: string;
  projectId: string;
  state: "recovering" | "ready" | "quarantined" | "closed";
  nextCommandSeq: number;
  currentNativeBindingId: string | null;
  parentChatId: string | null;
}

interface NativeBindingRecord {
  nativeBindingId: string;
  logicalChatId: string;
  descriptor: NativeEngineDescriptor;
  projectId: string;
  semanticConversationId: string | null;
  currentIncarnation: number | null;
  state: "starting" | "current" | "superseded" | "closed";
}

interface NativeTransportAttachment {
  attachmentId: string;
  nativeBindingId: string;
  kind: "claude-inner-rc" | "app-server" | "server" | "tmux";
  transportId: string;
  generation: number;
  state: "current" | "superseded" | "closed";
}

interface NativeTransportLease {
  attachmentLeaseId: string;
  attachmentId: string;
  nativeIncarnation: number;
  coordinatorEpoch: number;
  transportEpoch: number;
  state: "current" | "superseded" | "closed";
}

interface OutsideBindingRecord {
  outsideBindingId: string;
  logicalChatId: string;
  kind: "anthropic-remote" | "chatgpt-remote" | "web" | "local";
  currentIncarnationId: string | null;
  state: "current" | "closed";
}

interface SourceEventNamespaceRecord {
  sourceEventNamespaceId: string;
  outsideBindingId: string;
  sourceNativeNamespaceId: string;
  originTransitionId: string | null;
  state: "current" | "superseded" | "closed";
}

interface OutsideBindingIncarnation {
  outsideIncarnationId: string;
  outsideBindingId: string;
  providerOrChannelId: string;
  sourceEventNamespaceId: string;
  currentCapabilitySnapshotId: string | null;
  currentCapabilityVerificationId: string | null;
  connectionEpoch: number;
  state: "current" | "superseded" | "closed";
}

interface OutsideProtocolCapabilities {
  ingressFamilies: readonly string[];
  projectionFamilies: readonly string[];
  controlFamilies: readonly string[];
  acknowledgement: "none" | "transport-receipt" | "durable-receipt";
  cursor: "none" | "connection-scoped" | "namespace-scoped";
  idempotency: "none" | "stable-key" | "read-back";
  readBackFamilies: readonly string[];
}

interface OutsideBindingCapabilitySnapshot {
  capabilitySnapshotId: string;
  outsideIncarnationId: string;
  schemaVersion: 1;
  capabilityDocument: OutsideProtocolCapabilities;
  evidenceRef: string;
  verifiedAtMs: number;
}

interface OutsideBindingCapabilityVerification {
  capabilityVerificationId: string;
  outsideIncarnationId: string;
  capabilitySnapshotId: string;
  coordinatorEpoch: number;
  connectionEpoch: number;
  evidenceRef: string;
  verifiedAtMs: number;
  result: "accepted" | "rejected";
}

interface SourceEventNamespaceTransitionRecord {
  namespaceTransitionId: string;
  outsideBindingId: string;
  priorSourceEventNamespaceId: string;
  nextSourceEventNamespaceId: string;
  priorOutsideIncarnationId: string;
  nextOutsideIncarnationId: string;
  schemaVersion: 1;
  classifierSchemaId: string;
  coordinateSchemaId: string;
  priorBoundaryCoordinate: string;
  nextBoundaryCoordinate: string;
  capabilitySnapshotId: string;
  capabilityVerificationId: string;
  coordinatorEpoch: number;
  evidenceRef: string;
  result: "proven-reset";
}

interface SourceEventObservationRecord {
  sourceEventObservationId: string;
  logicalChatId: string;
  outsideBindingId: string;
  observedOutsideIncarnationId: string;
  sourceEventNamespaceId: string | null;
  sourceEventId: string;
  sourceReplayIdentity: string | null;
  coordinateSchemaId: string;
  sourceCoordinate: string;
  namespaceTransitionId: string | null;
  classificationEvidenceRef: string | null;
  sourceCapabilitySnapshotId: string;
  sourceCapabilityVerificationId: string;
  coordinatorEpoch: number;
  connectionEpoch: number;
  fingerprintSchemaId: string;
  fingerprintDigestAlgorithm: string;
  eventFingerprint: string;
  fingerprintCapabilitySnapshotId: string;
  disposition: "pending" | "new" | "duplicate" | "collision" | "ambiguous";
  canonicalSourceEventId: string | null;
  commandId: string | null;
  recoveryGapId: string | null;
}

interface CanonicalSourceEventRecord {
  canonicalSourceEventId: string;
  logicalChatId: string;
  outsideBindingId: string;
  sourceEventNamespaceId: string;
  sourceEventId: string;
  firstObservationId: string;
  sourceReplayIdentity: string | null;
  fingerprintSchemaId: string;
  fingerprintDigestAlgorithm: string;
  eventFingerprint: string;
  fingerprintCapabilitySnapshotId: string;
  commandId: string;
}
```

The journal also retains every native incarnation, transport attachment and lease, outside-binding
incarnation, source-event namespace/transition/observation and canonical deduplication record,
immutable capability snapshot and verification, cursor, correlation tombstone, and containment result.
An attachment belongs to the durable native binding, not to one process incarnation: a new lease ties
the same attachment to the current native incarnation and coordinator epoch. For Claude,
`transportEpoch` is the private RC worker epoch. A1 registration resolves a `nativeBindingId` through
its durable `logicalChatId`; it never assumes the two IDs are equal.

A source observation's envelope, coordinate, capability/epoch pins, classification evidence, and
fingerprint fields are immutable. Its `pending` disposition and nullable result links advance exactly
once by compare-and-swap, backed by append-only `ingress.changed` facts, to one terminal
classification. A `CanonicalSourceEventRecord` is immutable and unique on the exact ingress key; it
exists only for a proven-new event created with `command.proposed`. Duplicate observations link that
record, while collision/ambiguous observations link only a recovery gap.

An outside capability snapshot is owned by one outside-binding incarnation and records the proven
ingress command/control families, projection shapes, acknowledgement/cursor behavior, idempotency and
read-back guarantees, and the evidence/version that established them. The connector must durably
install or revalidate that snapshot before the incarnation becomes writable. A protocol or connector
change creates a new immutable snapshot even when the provider namespace stays the same; commands and
outbox items retain the snapshot ID used for their decision so later capability changes cannot rewrite
history.

Each startup or reconnect writes a separate immutable capability-verification record tied to the
current coordinator and connection epochs. Writability requires an `accepted` verification whose
incarnation, snapshot, coordinator epoch, and connection epoch all match the current binding lease. If
revalidation finds different capabilities, the connector creates the replacement snapshot and its
verification, then atomically advances both current pointers. A failed verification leaves the
incarnation non-writable and preserves the previous records for recovery and audit.

`sourceEventNamespaceId` is durable independently of an outside-binding incarnation or connection
epoch. Reconnect, credential rotation, capability revalidation, and connector replacement preserve it
whenever source event IDs remain in the same proven uniqueness domain. Several successive
`OutsideBindingIncarnation` records may therefore reference one namespace. A connector allocates a new
namespace only with a versioned, capability-pinned `SourceEventNamespaceTransitionRecord` that proves
IDs reset or may be reused. Its classifier and coordinate schemas define how source-protocol
cursor/sequence values on both sides of the boundary are compared; strings are never compared
generically. Every ingress observation durably retains its exact source coordinate, selected namespace,
classification evidence, and transition link before command allocation. If continuity versus reset or
an event's side of the boundary cannot be proved, the binding stays non-writable and records a recovery
gap rather than guessing.

An engine registers conversations with the host. Registration is two-phase because some adapters
must announce before the native ID is known:

1. `open(...)` creates a host conversation lease without pretending a broker ID is a native ID.
2. `bindNative(...)` records the real Claude, Codex, OpenCode, or tmux conversation identity.
3. `update(...)` commits validated post-setup metadata/capabilities without changing identity and
   projects that snapshot outward. A failed advisory announcement is a delivery gap, not permission to
   roll local native truth back.
4. `setPhase(...)` exposes startup, recovery, readiness, and draining without conflating presence
   with writability.
5. `close(...)` idempotently closes the bridge lease. It does not kill the native runtime unless an
   explicit runtime-owner policy says to do so.

The A0 `bindingId` is the registrar's process-local lease key. For a new discovery the adapter passes
`null` and the registrar allocates it. In A1 the coordinator supplies the persisted
`nativeBindingId` and independently resolves its `logicalChatId`; for resume the registrar validates
the chat, product, project, and prior native identity before adoption. The adapter generates
`registrationAttemptId` before the first `open` call and reuses it for that attempt. A0 retains it only
within the current host process. A1 persists it before `open`; retrying after a lost reply then returns
the same binding as an idempotent no-op, with a newly acquired lease fenced to the current coordinator
epoch when the prior epoch has ended. A1 also adds the epoch-fenced compare-and-swap. The registrar
enforces uniqueness for an active native reference.
In A0, `bindNative` accepts only the first reference or an exact replay; every different reference
fails closed. A1 may add a separate forward-incarnation recovery transition for the same product,
project, runtime lineage, and semantic native conversation. That operation must carry containment/
recovery evidence, record the old incarnation as superseded, and only then make the replacement
writable. If the old incarnation has a `started`/unknown mutation, an epoch or admission fence is not
enough: positive terminal/cancellation evidence or definitive process stop, freeze, or kill must first
prevent that attempt from executing late.

A fresh adapter never invents native identity. `runtimeId` identifies the supervised native
service or process tree; `conversationId` identifies its semantic native chat; native `incarnation`
distinguishes replacements. Synthetic inner RC IDs, panes, app-server connections, provider session
IDs, broker channels, cursors, and fork/turn/item IDs remain transport attachments, adapter metadata,
or outward bindings—not aliases for `conversationId`, `nativeBindingId`, or `logicalChatId`.
`coordinatorEpoch` fences stale local writers after restart. Conflicting or
concurrent registrations for one `bindingId` fail; a validated resume/reacquire of that binding is
allowed. A late `bindNative` must match the registered descriptor and either establish the first
reference or replay the existing one; it never repoints a logical chat. Native replacement uses the
separate proof-carrying A1 recovery transition described above.

`runtimeId` is derived from a warden-issued launch nonce plus a non-reusable native start identity:
Claude process start identity, Codex app-server instance epoch, OpenCode server instance epoch, or
tmux pane plus child-process start identity. A PID, URL, or pane name alone is not sufficient.
Before `bindNative`, each adapter classifies transport reconnect versus new chat versus child/fork
lineage. A synthetic Claude RC `cse_*` maps to the real transcript/resume identity; OpenCode child
sessions remain nested evidence; Codex create/fork results create distinct thread identities; and
tmux clear/branch/compact transitions are classified rather than treated as mere file rotation.

The neutral adapter package does not import the current Claude `Session`. A0.1 added
`host/native/adapter.ts` and a legacy RC registrar that specializes the generic port to `Session`.
Claude MITM creates one registrar per wrapper process and one lease per intercepted conversation; on
`ready`, the registrar invokes `startBridgeSession`. The older `bridgeSession` entrypoint remains a
served-promise compatibility wrapper for OpenCode and tmux. This preserves the current data plane
while making Claude MITM's host cardinality explicit.

The adapter creates and owns `port`; the registrar consumes it for the bridge and returns a lease.
`open`, late `bindNative`, update, and close can fail asynchronously. On a validation, binding, or
lifecycle failure, the adapter closes the lease and applies the runtime-owner policy; it does not
pretend registration succeeded. The current A0 Claude path logs the registration failure and closes
that failed `Session`, while A1 adds the persistent recovery gap and keep-alive/resume policy. After a
validated live `update`, an advisory projection failure is reported and retried by later presence
publication, but it does not restore stale metadata or capabilities. A0 implements only this lifecycle
and current metadata. The capability/evidence fields prevent that behavior-preserving bridge from
claiming future guarantees.
The legacy RC registrar does not start `startBridgeSession` or announce the conversation until it has
validated capabilities supplied at `open` or `update` and the adapter has moved the lease to `ready`.
The current Claude launch begins with null capabilities and supplies them through `update`. `Session`
buffers any earlier upstream events. This prevents broker input from reaching a half-configured native
adapter.

An open lease starts in the binding's explicit `starting` or `recovering` phase. Moving to `ready`
requires validated capabilities. A proven native identity is preferred but not fabricated: an A0
legacy bridge may be ready with `nativeRef: null`, `liveReattach: false`, and no durable native
delivery claim. Such a lease preserves current behavior but cannot use A1's fenced mutation or
reattachment guarantees until a real native reference is bound. A0 withholds the broker bridge before
`ready`; moving to `draining` immediately aborts its relay pumps, but does not yet settle or persist
in-flight outcomes. In A1, the coordinator queues or rejects pre-ready mutation, and graceful stop
fences new writes, settles or marks in-flight work, persists cursors and gaps, detaches outside
connectors, and only then applies the explicit keep-alive or terminate policy. That runtime ownership
must ensure that closing one Codex thread lease never closes the shared host-scoped app-server.

Native process ownership is separate from a conversation lease. A small host runtime owner—an OS
service, daemon, or per-engine warden—keeps eligible native processes and private protocol endpoints
alive across coordinator reconnection, saves their locators/start identities, and grants one
epoch-fenced mutation lease. If an adapter cannot reattach safely, it advertises cold native resume or
successor-chat recovery instead. Today's cleanup differs by path: Claude wrapper teardown ends its
child, tmux kills its pane, and OpenCode leaves the external server alive but best-effort aborts the
attached session's active run. None provides the selected persistent-runtime contract yet; live
reattachment remains proof-gated.

The epoch is enforced, not informational. Acquiring it is an atomic compare-and-swap in the journal.
Every journal transition, native mutation, inference/outward write, ingress ACK, and outbox claim is
conditional on the current epoch; the runtime owner and connectors reject stale epochs. This prevents
an old coordinator and its replacement from both delivering. Every future mutating engine-port call
carries `NativeMutationFence`; its write-ahead `attemptId`, exact native reference, and current epoch
are validated immediately before the native side effect. A private transport operation also resolves
its exact attachment lease and rejects it if the attachment, native incarnation, coordinator epoch, or
transport epoch is no longer current.

## 5. Normalized command path

The first command family is intentionally small:

```text
submit_text
├── command ID
├── logical chat ID
├── source surface
├── outside binding + source event namespace, for structured outside ingress
├── source-native event/message ID, when present
├── source capability snapshot + verification IDs, for structured outside ingress
├── text
├── received time
└── expected active turn, when present
```

The initial source surfaces are:

- `web`;
- `local`;
- `anthropic`; and
- `openai`.

The wrapper-owned editor is a `kind: "local"` outside binding. Like web and provider connectors, it
persists a client command ID in its durable device/editor namespace before retrying submission; raw
PTY keystrokes are not structured outside ingress.

The exact ingress deduplication key is
`(logical_chat_id, outside_binding_id, source_event_namespace_id, source_event_id)`.
`outside_incarnation_id`, capability verification, and connection epoch remain immutable
provenance on the observation, but none resets semantic deduplication. Mutable structured sources must
generate and persist their event ID before first send. An adapter-assigned ID is safe only when the
source receives and retains it before retry. If that acknowledgement is lost, an indistinguishable
repeat remains `outcome_unknown`; it becomes a new proposal only after explicit user confirmation of
new intent, never automatically and never by text matching.

Before allocating any proposal, the coordinator searches canonical source-event records, observations,
and correlation mappings for the same logical chat and outside binding across every superseded
connector incarnation. A source-stable object/replay identity or historical mapping that proves the
event is old links the new observation to the prior command and append-only outcome records without
allocating `command_seq` or executing native work. A same raw event ID in a proven distinct namespace
may be new only when its stored source coordinate is classified on the new side of the pinned
namespace-transition boundary. The new incarnation ID alone is never that proof. Historical overlap
delivered through a new connector retains its originating namespace identity. If an ID collision or
replay cannot be classified, the coordinator records a recovery gap, quarantines that ingress, and
does not semantically ACK it as a new command.

Fingerprint comparisons use the canonical event's stored schema, digest algorithm, and capability
snapshot—not the reconnecting connector's current defaults. The connector recomputes the incoming
event under that historical schema and stores the comparison. If the schema implementation is no
longer available, the event is ambiguous and fails closed. If the same canonical identity produces a
different digest under the same schema, it is a collision/protocol violation; it never overwrites the
old record or becomes a new command.

Provider/native echo correlation is a separate persisted ID mapping consulted before source-event
allocation; a returning echo points to the existing command and never creates another execution.

Every mutation path for a shared logical chat must cross the coordinator before native execution.
Engine HTTP/app-server endpoints stay private, and a wrapper-owned local UI submits through the same
command path. It may render the native TUI, but its submit boundary must be structurally intercepted;
screen scraping alone is not enough. A direct inner PTY/TUI or server connection is read-only or
excluded from the shared chat. A writable raw tmux pane is therefore a separate compatibility/debug
chat with official/web competing writers disabled; it may report post-hoc observations but cannot
claim the shared coordinator's definitive execution order.

Interrupts, approvals, questions, attachments, model changes, and mode changes become separate typed
command families only after the chosen inner and outside adapters can represent them faithfully.
Unknown mutation shapes fail closed.

## 6. Control journal and rebuildable projection

The authoritative control journal appends only facts needed to decide or safely recover mutation:

- `binding.changed`: an inner or outside binding attached, recovered, detached, or was superseded;
- `command.proposed`: an authenticated command arrived;
- `command.decided`: it was admitted, queued, or rejected;
- `ingress.changed`: the source event was received and its transport ACK/cursor state changed;
- `delivery.changed`: one named target leg is `not_started`, `started`, `accepted`, `observed`,
  `rejected`, or `outcome_unknown`;
- `outbox.changed`: a stable projection item was enqueued, claimed, accepted, or became uncertain;
- `recovery.gap`: evidence is missing and the missing range or action is explicit.

Every control record carries a stable record ID, logical chat ID, journal offset, commit time,
correlation, and source provenance. The exact payload of a queued or uncertain command remains durable
until its delivery is resolved. A retention policy may later redact or expire the payload, but it must
retain the canonical source-event identity→command record; the observation's namespace transition,
source coordinate, classification evidence, and schema-versioned credential-stripped fingerprint;
the attempt identity; and append-only ingress, decision, and outcome records. Those records stay
queryable across every successor connector incarnation while that outside binding can replay old
history. The canonical source record has no mutable “latest outcome” field: its stable `commandId`
joins to append-only journal outcomes, while ambiguous/collision observations instead link a
`recoveryGapId` and allocate no command.

Time passing never proves that an old native attempt cannot still execute, so retention expiry alone
cannot lift quarantine or close `outcome_unknown`. Only recorded reconciliation with positive
terminal/cancellation evidence, or definitive process stop, freeze, or kill of the old incarnation,
can do that. An operator may authorize that containment or a successor choice; an operator
acknowledgement by itself cannot make a still-runnable attempt safe.

A structured outside-origin `command.proposed` record has immutable
`source_capability_snapshot_id` and `source_capability_verification_id` fields. Every outside
`outbox.changed` item likewise has immutable `target_capability_snapshot_id` and
`target_capability_verification_id` fields. Admission and recovery validate those pinned records;
they never reinterpret an existing command or projection item through an incarnation's later
`currentCapabilitySnapshotId`.

Namespace-transition installation is an epoch-fenced compare-and-swap that atomically installs its
boundary/classifier evidence and advances the namespace pointer before the connector becomes writable.
For each ingress, one serialized actor turn revalidates that transition, current capability
verification, and coordinator epoch. One durable transaction then records the observation's
classification and does exactly one of these:

- proven new: insert the unique canonical source-event row and `command.proposed` together;
- proven replay: link the observation to the existing canonical row/command without a proposal; or
- collision/ambiguous: link the observation to a `recovery.gap` without a proposal.

A crash before commit leaves none of those semantic results; a crash after commit resumes the recorded
one. No semantic ACK or cursor advances until that transaction commits. A proposal left without
`command.decided` is resumed deterministically after restart; uniqueness constraints and one
transaction allocate its single decision and `command_seq`. A durable causal outbox item is likewise
enqueued atomically with the command or native-observation mapping it projects. It retains the exact
credential-stripped publish payload and stable target message/attempt ID until resolved. These are
transport obligations, not a second semantic transcript.

Native/provider observations, normalized viewer messages, and observed turn state live in a separate,
disposable read model. It is rebuilt idempotently from native history plus provider/broker read APIs
where available; missing evidence produces a gap instead of invented content. The first slice
normalizes text only. Credential-free native payloads may be retained in a bounded
diagnostic/projection cache for later translation, but they are not recovery authority and are never
replayed into the native client. The current Claude-shaped `UpstreamPayload` is not promoted into the
neutral schema.

Ordering fields have one job each:

- `journal_offset` totally orders all control records;
- `command_seq` orders admitted/queued commands for one logical chat and is the definitive
  multi-writer execution order;
- `chat_seq` orders the rebuildable viewer projection of commands and observed native output; the
  control store persists only stable source-ID → `chat_seq`/message-ID mappings, not assistant content,
  so a rebuild reproduces the same identities and interleaving; and
- native IDs, provider sequences, and broker `seq` remain source/projection mappings, never command
  order.

## 7. Delivery state

Receipt, admission, native delivery, and each outside delivery leg are different:

```text
command
  received
    ├── rejected
    ├── queued
    └── admitted

native delivery
  not_started → started → accepted → observed
                └──────→ outcome_unknown

delivery to target binding X
  not_started → started → accepted → observed
                └──────→ outcome_unknown
```

Native delivery attempts are keyed by command, native binding/incarnation, and native attempt ID.
Outward delivery attempts are keyed separately by projection item, target binding/incarnation, and
outward attempt ID. Source ingress ACK/cursor state is separate: acknowledging an Anthropic worker
event, for example, proves only that the host durably received it; it says nothing about native
execution or an outward projection. Official-device rendering advances no state unless that exact
device supplies a proven render receipt.

`accepted` requires positive adapter-specific evidence: for example, a structured native receipt or a
provider ACK whose contract is known. It never means merely “bytes were written.” `observed` is scoped
to a named observer such as native history or provider history; it does not imply that a device
rendered the event. Tmux paste/Enter has no structural acceptance, and a lost OpenCode `prompt_async`
response has no safe native identity, so those paths may move from `started` directly to
`outcome_unknown`.

The web `accepted` frame currently means only that the host assigned a sequence and published its ACK;
it is sent before the content echo attempt and before native injection. It does not prove that the echo
landed or that the native client accepted or executed the prompt. The new path must expose these states
separately.

If a network request may have reached a native client but its response was lost, the result is
`outcome_unknown`. It is never retried automatically unless that adapter has positive,
protocol-specific proof that the native client could not have accepted the first attempt. Absence from
an incomplete or eventually consistent history is not such proof.

Before the first native byte or possible side effect, the coordinator durably records
`delivery.started` with a stable attempt ID, exact binding/incarnation, and current coordinator epoch.
A crash before the actual write may therefore conservatively produce uncertainty; a crash after the
write can never recover as `not_started` and duplicate execution. The same write-ahead rule applies
to an outward publish. An ambiguous outward write reuses its stable provider/broker idempotency
identity and is retried only when that protocol proves replay is idempotent or proves the first write
absent. A deterministic remote-claw broker frame `msgId` can satisfy that gate; an unproven provider
write cannot.

An unresolved native `outcome_unknown` quarantines that logical chat: later native commands remain
queued while the old attempt or incarnation might still execute. Delivery resumes only after the
attempt has positive terminal/cancellation evidence, or the old process is definitively stopped,
frozen, or killed and a successor-chat gap is committed. Fencing future coordinator writes does not
contain a request that already crossed the native boundary.

## 8. Restart and recovery

When the coordinator restarts:

1. Stop admitting new input.
2. Reopen the small control journal and acquire a new coordinator epoch.
3. Load the exact `logicalChatId` → native binding → semantic conversation → runtime/incarnation →
   transport-attachment chain. Do not discover a replacement by title, path, or message similarity.
4. Finish any undecided durable proposals exactly once under the new epoch.
5. Reacquire the epoch-fenced lease from the native runtime owner.
6. Recover in this order:
   - positively reattach the surviving native process and its existing transport;
   - cold-resume the same semantic native conversation and ask the private transport service to accept
     its persisted transport ID, advancing the native incarnation only when a replacement process or
     service was actually started;
   - if that native client instead creates a replacement transport, prove the same semantic
     conversation and supersede only the transport attachment; do not advance the native incarnation
     unless the underlying process or service also changed;
   - if identity cannot be proved, quarantine the logical chat and require an explicit successor or
     new-chat decision.
7. Subscribe to native changes before taking a history snapshot when that native API supports and
   requires that order.
8. Read the native history, status, pending gates, and cursors that adapter can actually expose.
   Approval and question responses follow the same write-ahead and uncertainty rules as text
   commands. Deny an orphaned gate only with positive proof that no earlier response crossed the
   boundary. If a response may have crossed but its acknowledgement was lost, record
   `outcome_unknown`/`recovery.gap`; require positive terminal/cancellation evidence or definitively
   stop, freeze, or kill the old process before permitting another answer.
9. Rebuild normalized viewer messages only from stable native IDs/evidence the adapter has proven.
10. Reconcile commands:
   - if the native client proves the command happened, mark it observed and never resend it;
   - if delivery provably never started, send it in coordinator order;
   - if delivery started but cannot be proven, mark it `outcome_unknown` and do not resend
     automatically.
11. Reconnect outside protocols, revalidate each current incarnation's durable capability snapshot,
    and resume durable projection outboxes from their stable IDs.
12. Announce and route the same `logicalChatId`. A rotated inner/private transport must not allocate a
    second web row, broker channel, Anthropic session, ChatGPT chat, or command sequence.
13. Reopen input only when the next native command cannot overtake an uncertain older attempt. Merely
    displaying a gap does not make delivery safe.

The broker stream is the encrypted physical inbox for web commands, but it is not their semantic
admission/order authority. Current durable-relay preparation, when reusing a session channel, samples
the broker's latest frame count and begins after it. Current drivers do not persist that
logical-chat/session binding, and the sampled fence can skip a prompt that landed before it but was
never processed. The new path must persist a stable encrypted-ingress cursor, replay after the last
committed cursor, and deduplicate by command/source ID. The cursor is a contiguous high-water mark,
or an explicit cursor plus holes: it advances only after every earlier complete frame/multipart group
is durably proposed or rejected. The broker may HTTP-accept ciphertext first; remote-claw must not
send its semantic `accepted`/admission response, source delivery ACK, or cursor advance until the
corresponding local control record is durable. A provider-origin event is losslessly recoverable only
after that provider's redelivery/reconnect behavior passes its proof gate; history repair may
reconstruct a projection but never execute an old history row as a new command.

Structured shared mode therefore requires one of two durable ingress contracts: either the broker
retains the complete encrypted frame until semantic acknowledgement, or the source retains the stable
event ID and exact payload until acknowledgement and retries it after reconnect. A local/web source
that may discard an unacknowledged payload cannot advertise recoverable shared-chat delivery.

If the native client cannot recover the conversation, remote-claw may install a successor binding
under the existing logical chat only after an explicit recovery decision and gap, or may create an
explicit new logical chat with predecessor lineage. Delivery attempts are bound to their original
native conversation/incarnation: `not_started` commands admitted for the old conversation require
explicit abandonment or user reauthorization before delivery to a successor. It never manufactures
native state by replaying historical actions.

## 9. Native adapter recovery

### 9.1 Claude Code wrapper

The inner Claude process sees a local Anthropic-compatible service:

```text
inner Claude Code
    │  Anthropic-shaped requests, synthetic credentials
    ▼
remote-claw Claude wrapper
    ├── local Remote Control service
    ├── local inference/API service
    └── native transcript/session observer
```

The private wrapper answers every Anthropic-bound inner request. A separately isolated outward
inference connector owns any real model credentials/provider sockets and re-originates only calls
selected by policy; an unknown route fails closed. The inner process cannot read or reach that
connector. This inference path is separate from the outward Anthropic Remote connector that makes a
logical chat visible to official clients.

Cold start is:

1. Start the private RC and Anthropic-shaped API endpoints, then enforce the child network fence.
2. Create the synthetic account/config state, scrub inherited Claude session variables, and spawn
   inner Claude with a TTY.
3. Observe and bind the real transcript/resume identity behind any synthetic RC `cse_*`.
4. Start both RC-event and transcript observation, then mark the binding `ready`.
5. Deliver coordinator commands through the private RC client→worker stream. The inner TUI is
   non-writable, or a wrapper-owned editor intercepts submission before PTY input.

Synthetic RC worker events are the live source; stable transcript rows repair gaps and deduplicate by
native IDs. Where the inner RC protocol has an ACK, remote-claw commits the observation/mapping before
advancing it. A transcript row never becomes a new command merely because its live RC event was lost.

Recovery uses Claude's native transcript and resume support where complete. The persisted recovery
set includes the `logicalChatId`, `nativeBindingId`, Claude transcript/resume UUID, transcript locator
and cursor, every private RC `cse_*` attachment and worker epoch, RC event/delivery cursors, exact
runtime start identity, and independent outward bindings.

The wrapper follows a reuse-first Claude algorithm:

1. If the exact child process survives and a version-pinned live-reattach primitive is proven, reattach
   it without changing the native incarnation.
2. Otherwise contain the old process and launch Claude with an explicit, wrapper-owned
   `--resume <claude-uuid>`. Continue scrubbing ambient inherited
   `CLAUDE_CODE_CHILD_SESSION`/`CLAUDE_CODE_SESSION_ID`; deliberate recovery comes from the verified
   binding, not the parent shell.
3. Start the durable private RC server with the prior `cse_*` registered. If resumed Claude asks to
   bridge that ID, accept it, advance the worker epoch, bind that epoch to the new native incarnation
   and coordinator epoch, and continue its RC sequence/delivery state.
4. If the same proven Claude UUID instead creates a new `cse_*`, record a proof-carrying transport
   replacement under the same native binding and logical chat. Fence the old worker first, then bind
   the replacement's first worker epoch to the current native incarnation. The new `cse_*` is a
   transport generation, not a new chat or web row.
5. If Claude resumes a different/unprovable UUID, fail closed in `recovering`/`quarantined`; never
   repoint the binding implicitly.

Native RC worker streams do not backfill history. Reusing the old `cse_*` therefore depends on the
wrapper's durable RC store, and a replacement `cse_*` may require transcript-backed projection repair
plus an explicit gap. Neither case replays old prompts into Claude. A cold `--resume` advances the
runtime/native incarnation while retaining the same semantic Claude UUID, binding, logical chat,
`command_seq`, and `chat_seq`. Native incarnation and private transport generation advance
independently: reusing a `cse_*` creates a new worker lease, not a replacement attachment. In-flight
work and pending controls become uncertain if neither the surviving process nor stable transcript/RC
evidence proves their result.

The independently bound outward Anthropic session normally survives an inner `cse_*` or native
incarnation change; it is never used as the native conversation ID. If Anthropic itself forces a new
outward session, the connector supersedes only that outside-binding incarnation and retains the
logical chat and correlation tombstones.

### 9.2 Codex wrapper

The preferred inner shape has three distinct seams:

```text
coordinator ── client-facing app-server proxy ── private Codex app-server
                                                 │
                                                 └── model/API calls
                                                     ▼
                                           private OpenAI-shaped façade

coordinator ── outward ChatGPT Remote connector ── OpenAI ── official clients
```

The outer app-server boundary lets remote-claw observe and order requests before private Codex acts.
The private app-server calls the local model/API façade rather than OpenAI directly. The model or
inference backend behind that façade is independent of the outward ChatGPT Remote connection.

Cold start brings up the model/API façade and network fence first, starts one host-scoped private
app-server, completes initialization, subscribes to notifications, discovers projects/threads and
their stored rollout state, creates one thread-scoped port/binding per chat, and only then marks those
bindings ready. Deltas are live evidence; final thread/rollout items repair and deduplicate them by
stable IDs. An app-server restart fences and rebinds every affected thread as one runtime-incarnation
change. Each proven Codex thread retains its own `logicalChatId`/native binding, and the outward
paired host plus project/chat mappings remain unchanged; restarting the shared app server must not
duplicate official projects or chats.

Thread create/resume/fork/archive are separate typed mutations, not `submit_text`. New thread
creation is two-phase: reserve the logical binding, invoke the private app-server once under a
write-ahead attempt, then bind the returned thread ID. An ambiguous create remains uncertain; it does
not invent or blindly retry another thread.

The first Codex proof must determine the smallest clean seam in the pinned open-source project:

- configure the private app-server with a local model provider;
- proxy or patch any remaining OpenAI/ChatGPT calls that cannot use a base URL;
- preserve one outward paired host with many projects/threads;
- translate every ID-bearing app-server request, response, notification, and server request;
- keep Remote transport credentials, cursors, chunks, ACK state, and host enrollment outside the
  inner process.

Codex native thread/rollout state is the recovery source, but it is not assumed complete for every
command/tool interaction until proven. All bidirectional app-server methods and server requests fail
closed unless classified. Closing one thread-scoped port cannot close the shared app-server runtime.

### 9.3 OpenCode server

OpenCode is the cleanest first control adapter:

- `GET /session` discovers sessions;
- `GET /session/{id}/message` returns chronological history;
- `GET /event` supplies live SSE events;
- `POST /session/{id}/prompt_async` submits text;
- abort and permission endpoints provide structured controls.

In shared mode the adapter owns or access-controls the server's mutable endpoints; its TUI and other
clients cannot POST around the coordinator. A peer-attached server that remains independently
writable advertises `mixed` or `post_hoc`, not structured admission. Separately, every configured
OpenCode model provider is pointed at a private remote-claw façade and direct provider egress is
blocked.

Startup subscribes to server-wide SSE first, records the live boundary, snapshots sessions/history,
registers top-level sessions, classifies child/subagent sessions as nested evidence, merges the
buffered tail by stable IDs, and then marks bindings ready. Recovery repeats the same overlap. A
proven same `ses_*` under the expected server lineage retains `logicalChatId`; a missing/reused
`ses_*` under another server epoch fails adoption rather than matching history text.

One limitation is load-bearing: `prompt_async` returns HTTP 204 without a native command/message ID.
A received 204 is HTTP acceptance, but it still supplies no command/message correlation ID. A lost
response may mean “not received” or “accepted and still running.” Text matching is not enough to
retry safely. History can resolve it only with exclusive writing plus a persisted pre-delivery
cursor/order proof; otherwise delivery remains `outcome_unknown` until OpenCode gains an idempotency
seam.

Shutdown distinguishes ownership. Detaching from an externally owned server does not abort its
active turn; an adapter-owned runtime follows its explicit keep/terminate policy. Permission rules
installed by remote-claw are restored where safe, and pending gates are resolved or recorded as
orphaned before detach.

### 9.4 tmux compatibility mode

The first tmux mode wraps Claude Code: it injects text/keys and reads Claude transcript JSONL. It can
recover completed native messages and subagent transcripts, but it cannot prove every paste, Enter,
permission, or in-flight action.

Shared mode makes the pane human-read-only and accepts input through a wrapper-owned editor. A
writable attached pane is explicitly `post_hoc` and cannot claim coordinator-first ordering.
Startup or reattach scrubs inherited Claude session variables, validates the intended pane and child
process, installs durable transcript/permission hooks, binds the exact Claude session/transcript, and
starts tailing before input is accepted. Paste and Enter are separate best-effort delivery steps; a
pre-delivery transcript cursor plus exclusive writing may provide evidence, but identical text does
not.

A persistent process owner may reattach a surviving pane using saved pane/process identity,
Claude session ID, transcript path, inode, and offset. If it cannot prove whether an injected command
started, that command becomes `outcome_unknown`.

`/compact` remains the same chat only when its native identity proves that; `/clear` starts a new
chat, and `/branch` creates fork lineage. Hook scratch paths, request/decision cursors, and orphaned
permission gates are recovery state. Graceful stop explicitly chooses keep-pane or kill-pane after
draining; closing the chat lease alone does neither.

Tmux remains a compatibility path. It must not advertise the same delivery or recovery guarantees as
structured Claude, Codex, or OpenCode adapters.

## 10. Outside adapters

Outside adapters translate between their native protocol and the normalized coordinator. They never
deliver directly to the inner client.

An outside binding is logically independent of the inner engine product. The design allows one
logical chat to appear in remote-claw web and either or both official Remote surfaces once each
connector proves that mapping; it does not assume a provider accepts a non-native engine shape before
that proof. Each outside view receives only the command/content families that both sides can represent
faithfully; unsupported mutations fail closed rather than being guessed.

Every outside binding has the same lifecycle:

1. Bind a durable `outsideBindingId`, reference its independently durable provider/broker/local
   `sourceEventNamespaceId`, install an evidence-backed durable capability snapshot, and acquire a
   separate fenced connection epoch. Reconnect must revalidate the capability snapshot before
   restoring writability. Native restart never rotates the binding or event namespace.
2. Ingest a mutation with a stable source ID and a commit callback; no semantic ACK or cursor advance
   occurs until that callback durably records its new/replay/collision/ambiguous classification and
   any resulting proposal.
3. Consume a durable causal projection outbox ordered by `command_seq`/`chat_seq`.
4. Before first publish, persist the stable target event/item ID, idempotency identity, and
   `(target binding, target item) → source command/native message/chat_seq` mapping.
5. Classify each publish as positively accepted, definitively rejected, or `outcome_unknown`.
6. Reconcile with a subscribe-first/snapshot overlap when supported, persisting provider cursor,
   epoch, and correlation mappings. Read-back of user, assistant, tool, and result items updates the
   existing outbox item; it never allocates another command or `chat_seq`.
7. Close or supersede the connection without changing the durable binding, logical chat, or native
   conversation.

If a provider forces a new session/chat or connector incarnation, retain `logicalChatId` and
`outsideBindingId`. Preserve `sourceEventNamespaceId` when the provider ID domain is continuous; if
positive evidence proves a reset/reuse domain, allocate a new namespace while retaining every prior
canonical source record, observation, and correlation mapping. Before advancing the recovered cursor
or allocating a command, classify subscribe-first/snapshot overlap against records across all prior
incarnations using the pinned transition classifier and each item's stored source coordinate. A
proven replay links to its prior outcome, a proven post-boundary item uses the new namespace, and an
ambiguous item fails closed. Repair the new provider representation only through the durable outbox
with proven idempotency or read-back; provider history is never replayed into native execution.
There is at most one active Anthropic Remote binding per logical chat, and a Codex app-server restart
does not re-enroll the one paired ChatGPT host or duplicate its projects/chats.

Native execution may precede provider replication, but the causal outbox never publishes
assistant/tool/result output ahead of that command's provider-native user representation. A fast
unmatched provider echo waits for its persisted mapping or fails closed; it never becomes a new
command by text matching.

### 10.1 Wrapper-owned local UI

The local UI has a durable binding/source ID and submits only through the coordinator. Its canonical
chat view consumes normalized `chat_seq` projection items and folds optimistic input into explicit
proposed, queued/admitted, and per-leg delivery states by command ID, so the committed copy does not
render twice. A device-local render receipt proves only that local view.

The UI may also expose a raw native TUI as a separate read-only diagnostic view. Raw native rendering
is not the coordinator projection, and writable native input is not allowed in a structured shared
chat.

### 10.2 remote-claw web

```text
web user frame → command proposal → coordinator → native adapter
native observation → normalized message → sealed web frame
```

The existing broker remains a zero-knowledge ciphertext transport. Current frame kinds remain as a
compatibility view while the coordinator gains explicit receipt/admission/delivery states.

### 10.3 Anthropic Remote

remote-claw owns a real outward Claude worker/session:

```text
official Claude client
    ▼
Anthropic Remote
    ▼
remote-claw outward worker
    ▼
coordinator
    ▼
chosen native adapter
```

Official input is durably deduplicated and decided before its worker transport ACK advances; that ACK
proves host receipt only, not native delivery. Output is translated into provider-native worker
events. An admitted command originating outside this Anthropic binding—local UI, web, or ChatGPT—is
published once through the app-side API so provider history can read back its official user
representation. An Anthropic-origin user item is not posted back to its own source binding; native
assistant/tool/result output still projects to that source through its causal outbox. Actual device
rendering is not presumed. Returning user/output echoes update their persisted correlation/outbox item
and never become another command or viewer message.

The existing `AnthropicRcClient` covers app-side list/history/SSE/text submission. Worker registration,
bridge credentials, heartbeat, delivery ACK, worker SSE, connector-owned login/refresh/rotation/
revocation, archive, reconnect, and uploads are still missing. The existing transport can reread a
credential rotated by another owner and retry once after 401; it is not the required credential owner.

Recovery first reconnects the existing outward Anthropic session. If that session is unusable,
remote-claw may create a replacement within provider/policy limits, record it as a new outside-binding
incarnation under the same `logicalChatId`, and rebuild only the official projection through the
durable causal outbox. It does not replay that provider history into the inner engine, does not reset
the coordinator order, and does not create another remote-claw chat.

### 10.4 ChatGPT Remote connection

remote-claw must preserve one paired outward ChatGPT Remote host presenting Codex-backed
projects/chats:

```text
Remote
└── host: fcvm (example)
    ├── project A
    │   ├── chat 1
    │   └── chat 2
    └── project B
        └── chat 3
```

Official documentation establishes the product shape—ChatGPT desktop pairs a host, and an SSH Remote
connection starts a remote Codex app server—but it does not publish the paired host/relay wire
protocol. Codex `--remote` is separately documented as a terminal UI transport to an app-server; it is
not proof of the ChatGPT pairing protocol.

The outward adapter must therefore preserve the product shape shown above while a pinned proof
extracts the cleanest host/daemon boundary, enrollment, reconnect, and request/notification mapping.
The host-side engine leg appears app-server-shaped, but remote-claw must not assume that the private
Codex app-server protocol is itself the off-box paired transport. Once proven, official Remote
commands become coordinator commands and normalized native observations are projected back into the
host/projects/chats representation that the official client expects.

The private Codex app-server is never exposed directly. Approval/question responses from several
official/local clients must first pass through one coordinator decision so only one answer reaches
private Codex.

Restarting private Codex or the local coordinator preserves the outward paired-host enrollment.
If OpenAI forces a new outward connection/chat namespace, remote-claw supersedes that outside
incarnation under the existing host/project/`logicalChatId` mapping and repairs its projection through
the durable outbox; it never duplicates native execution to make the official view catch up.

## 11. Core workflows

### 11.1 Host start and stop

Cold start proceeds from the inside out:

1. Open the control journal, acquire one coordinator epoch, and fence stale owners.
2. Start the runtime owner, private provider-shaped façades, inference connectors, and network policy
   before any inner process.
3. Start or adopt each native runtime in `starting`/`recovering`, establish observation before
   snapshot where required, classify native identities, and rebuild only proven projections.
4. Reconcile undecided commands, in-flight attempts, ingress cursors, gates, and causal outboxes.
5. Reconnect outward Remote/web bindings under the new epoch.
6. Mark each native binding `ready` and admit input only when its next ordered command is safe.

Graceful stop reverses the ownership boundary: stop admission and fence writes, drain or mark every
in-flight leg, commit cursors/gaps, detach outward connectors, then either leave the warden-owned
native runtime alive or terminate it according to explicit policy. A crash skips those steps, so
restart uses §8 rather than assuming shutdown completed.

### 11.2 Local or web text

1. Authenticate and deduplicate the submitted command.
2. Commit its order/admission result and any newly enabled projection outbox item atomically.
3. If rejected, project status only; it never crosses a native or provider mutation path.
4. If queued, leave it in `command_seq` order; do not publish a provider-native user event until it is
   promoted to admitted.
5. If admitted, write ahead and start native delivery without waiting for official-view replication.
6. Record the native delivery result. Each native observation mapping atomically enqueues its ordered
   copies to enabled outside bindings.
7. Correlate every returned provider/native echo to the existing command or projection item.

An outward Remote-provider outage delays only that official view; it does not become the decision
maker. A model-inference backend outage is different: the native turn may be unable to finish, though
the coordinator's admission/order remains intact.
Each outward binding has a causal outbox: a command's official user representation must be accepted
before assistant/tool/result projections caused by that command can overtake it. An outage queues that
entire official projection without blocking native execution.

### 11.3 Official-client text

1. The provider receives the official client's command.
2. The provider's host/worker transport delivers it to remote-claw.
3. Run the cross-incarnation source-record/correlation guard and atomically commit the provider
   observation plus one terminal classification. The proven-new branch inserts its canonical source
   identity and `command.proposed`; replay links the prior canonical record; collision/ambiguous links a
   recovery gap and creates no command.
4. Admit, queue, or reject only a proven-new proposal.
5. ACK provider ingress at the point proven safe for that protocol, after the required durable
   decision for new input or durable prior-command link for a replay. This ACK means host receipt only
   and need not wait for native execution; collision/ambiguous input advances no semantic ACK or cursor.
6. Deliver only an admitted command to the native client; queued input waits and rejected input never
   executes.
7. Project command status to the local UI and remote-claw web. For an admitted command, publish its
   user representation to enabled non-source provider bindings; the existing source-provider user
   item is never reposted to itself.
8. Project later native assistant/tool/result observations to every enabled binding, including the
   originating official binding, through each binding's causal outbox.

An official UI may display its locally submitted command before remote-claw admits it. If the
provider protocol cannot show queue/rejection state, the remote-claw UI remains the complete status
view.

### 11.4 Two writers

- The first committed admissible command gets the next `command_seq`.
- One native turn runs at a time per logical chat unless the native API proves a different safe
  primitive.
- A second text command queues by default.
- Steering is a distinct explicit command, not inferred from arrival timing.
- Provider/native echoes do not execute again.

## 12. Security boundary

These are release requirements for the selected runtime, not claims about current `--rc-app`,
OpenCode, or tmux isolation:

- Inner Claude, Codex, and OpenCode process trees have no real remote-provider credentials.
- Inner provider-shaped traffic terminates locally; remote-claw opens separately isolated inference
  and official-Remote TLS connections.
- The inner process identity cannot read outward connector state or sockets.
- Network policy prevents direct provider fallback.
- OpenCode's configured model endpoints also terminate locally. Tmux inherits the wrapped engine's
  isolation; any weaker mode declares it honestly.
- Provider credentials never enter argv, logs, normalized payloads, broker frames, or inner
  environments. User content may itself contain secrets, so it remains E2E-encrypted on broker frames.
- Credential-stripped native payloads may be stored locally for correlation; the cloud broker still
  sees ciphertext and routing metadata only.

## 13. Delivery plan

Each item lands as a separate reviewed PR.

### A0 — Host-wide registration seam

#### A0.1 — Neutral seam and Claude MITM migration

**Status: implemented.** The seam and registrar are process-local compatibility infrastructure; they
do not claim A1 persistence, restart adoption, or native delivery fencing.

- Add a native engine adapter package that is independent of Claude `Session`.
- Add two-phase conversation registration.
- Add a legacy RC registrar that maps today's `Session` into `startBridgeSession` while retaining
  `bridgeSession` as the direct-driver compatibility entrypoint.
- Route Claude MITM registration through one host-scoped registrar without changing native command
  flow, and prove that one registrar can serve several intercepted conversations.
- Accept only first-bind/exact-replay native identity; defer proof-carrying replacement to A1.
- Leave `nativeRef` null when the current adapter cannot prove a durable semantic native identity;
  never substitute a broker `cse_*`, pane name, or server URL.
- Enforce registration-attempt idempotency in process; do not claim durable retry or epoch fencing
  before A1.
- Delay the broker bridge/announcement until the lease is ready with validated metadata and
  capabilities.

#### A0.2 — OpenCode and tmux migration

**Status: next.**

- Route OpenCode and tmux registration through the same host-wide seam without changing their native
  command flow.
- Publish actual post-setup capabilities/readiness, correcting current optimistic OpenCode/tmux
  permission, status, and attachment announcements.
- Publish no ghost conversation when native attach/spawn fails.

### A1 — Runtime ownership, control journal, and command actor

- Add durable `logical_chat`, `native_binding`, native-incarnation, private-transport-attachment and
  attachment-lease, outside-binding, outside-capability-snapshot, outside-capability-verification, and
  connection-epoch records, plus source-event namespace/transition/observation, canonical source-event,
  and cross-incarnation correlation records. Never alias `logicalChatId` to the A0 `rcb_*`, Claude
  `cse_*`, Codex/OpenCode ID, broker channel, or provider ID.
- Route web presence, broker channel/key derivation, and normalized command/chat sequences by the
  stable `logicalChatId`; a transport replacement must update one visible row rather than create
  another.
- Add an epoch-fenced runtime owner/warden and persist native locators without changing native
  semantic authority.
- Add the explicit forward-incarnation transition with required terminal/cancellation or process
  containment evidence; never overload A0 `bindNative` for replacement.
- Add `starting`/`recovering`/`ready`/`draining` lifecycle gates and explicit detach-versus-terminate
  shutdown.
- Persist text command receipt, order, decision, native/outside delivery, binding, and recovery gap.
- Make receipt, admission, delivery, and observation distinct.
- Write ahead every native/outward attempt, atomically enqueue causal outbox items, and quarantine a
  chat behind unresolved native delivery.
- Persist/replay the encrypted-ingress cursor instead of treating a sampled `frameCount` as the next
  command boundary; advance only a contiguous committed high-water mark.
- Gate: crash every transaction/delivery boundary without silent loss or automatic duplicate execution.

### A2 — OpenCode vertical slice

- Persist a stable binding from `logicalChatId` to the native OpenCode `ses_*`; do not use `ses_*` as
  the remote-claw chat or broker ID.
- Feed history/live events into normalized text observations.
- Route web text through the command actor.
- Make every mutable local OpenCode surface pass through the actor or mark it outside the shared chat.
- Route all OpenCode model-provider traffic through private local façades and prove the network fence.
- Reconcile the persisted coordinator journal with OpenCode history and rebuild its projection.
- Treat ambiguous HTTP 204 delivery as `outcome_unknown` rather than retrying.

### B — Claude Code wrapped client

- Keep the current synthetic RC seam as a migration adapter.
- Terminate all inner Anthropic-origin calls.
- Separate the private inference connector from the outward Anthropic Remote connector.
- Add native transcript/resume recovery that first restores the known Claude UUID plus private
  `cse_*`, then treats a proven replacement `cse_*` only as a transport generation under the same
  `logicalChatId`.
- Persist the private RC event/worker/delivery state needed to accept a known-`cse_*` re-bridge without
  expecting worker history backfill.
- Add real outward Anthropic worker/session support.
- Add controls, permissions, questions, and uploads one proven family at a time.

### C — Codex wrapped client

- Prove the private app-server and local OpenAI service seam.
- Add a host-scoped Codex adapter that discovers many threads.
- Keep the private inference gateway distinct from the client-facing app-server proxy and outward
  ChatGPT Remote connector.
- Add the outward ChatGPT Remote host connector while preserving one paired host.
- Add exact Remote reconnect/ACK/cursor recovery or a proven fresh-stream repair boundary.

### D — tmux recovery and unified product

- Add persistent pane ownership and honest recovery state.
- Compose tmux with the wrapped engine's provider façade; keep the shared pane non-writable.
- Expose host → project → chat discovery across native clients.
- Show native, official-provider, and web delivery state separately.

## 14. Proof gates

The following remain unproven until a test says otherwise:

- durable separation of `logicalChatId`, native binding/conversation/incarnation, private transport,
  broker channel, and outward provider IDs;
- stable `logicalChatId`, `command_seq`, `chat_seq`, and one visible row across a known-transport
  re-bridge or a proven replacement private transport;
- exact native history completeness and stable IDs for every adapter;
- non-reusable runtime/incarnation identity and correct new-chat/reconnect/fork classification;
- subscribe/snapshot ordering without a lost-event gap;
- provider source-event namespace continuity, cross-incarnation replay classification, and
  collision-safe canonical records before command allocation;
- command-to-native correlation and idempotent retry;
- structural interception of local Claude/Codex/OpenCode submissions before native execution;
- complete provider-route termination and process-tree network isolation for every inner engine;
- busy turn, steer, interrupt, approval, and question semantics;
- live process reattachment versus lossy native resume;
- Claude worker renewal, reconnect cursors, archive, upload, and official rendering;
- Codex project grouping, ChatGPT host enrollment/transport extraction, upstream attestation,
  sequence/chunk/ACK recovery, and full app-server compatibility;
- OpenCode prompt-delivery ambiguity and child-session recovery;
- tmux transcript completeness, rotation, paste/Enter uncertainty, and orphaned permissions;
- provider-credential non-disclosure for wrapped Claude, Codex, and OpenCode;
- local wrapper projection reconciliation and any claimed device-local render receipt.

The restart matrix must include:

- known Claude UUID + known `cse_*`: restart, `--resume` the UUID, accept `/bridge` for the old
  `cse_*`, bump worker epoch, bind it to the new native incarnation/coordinator epoch, and continue the
  private RC/server sequence while preserving one logical chat;
- known Claude UUID + replacement `cse_*`: prove and fence the transition, retain the logical
  chat/web channel/outward Anthropic binding, and project no duplicate row or turn;
- wrong UUID, project, product, or reused runtime identity: reject adoption without title/text
  matching;
- a stale worker/coordinator/presence frame after replacement: reject it without rolling identity,
  delivery, or liveness backward;
- broker/web recovery: resume the committed ingress cursor and outbound sequence on the stable logical
  channel so a crash-boundary command is neither skipped nor executed twice;
- Anthropic and ChatGPT connector restart: preserve the logical chat and paired-host/project mappings,
  revalidate the current durable capability snapshot, and rotate only connection credentials/epoch
  unless the provider forces a separately recorded outside-binding incarnation;
- provider ingress replay before and after connector restart, credential rotation, and forced
  outside-binding incarnation: preserve a continuous event namespace and allocate exactly one command;
  deliver old history after a proven namespace reset and still link it to the old command; accept the
  same raw ID as a second command only for an item whose coordinate is proven post-boundary; fail
  closed when a canonical ID's body changes; and quarantine ambiguous history overlap before cursor
  advance;
- the same source event raced through old/new connector incarnations: retain one canonical command;
  an old replay raced against a distinct, proven post-boundary reuse of its raw ID: link the old command
  and allocate exactly one new command;
- crashes before and after namespace-transition install, cross-incarnation classification, canonical
  source insertion, and `command.proposed`: resume one recorded branch, and advance neither semantic
  ACK nor cursor for collision/ambiguous input;
- crash points before/after binding commit, native `delivery.started`, native observation, projection,
  outward publish, and provider ingress ACK, with quarantine for every unprovable delivery.

Capabilities are advertised only after their proof gate passes.

## 15. Evidence baseline

This design is grounded in:

- the current `Session`, `HostRcRelay`, Claude MITM, OpenCode, and tmux implementations;
- the current OpenCode history/SSE attach and reconnect behavior;
- the captured Claude worker/app protocol in [Phase 0 Findings](phase0-findings.md);
- the implemented Anthropic app-side client;
- the official [ChatGPT Remote connections](https://learn.chatgpt.com/docs/remote-connections) and
  [Codex app-server](https://learn.chatgpt.com/docs/app-server) documentation.

No pinned Codex source snapshot or ChatGPT paired-transport fixture is currently tracked in this
repository. Phase C must record the exact upstream commit/version and sanitized schema evidence before
turning its hypotheses into compatibility claims.

The architecture deliberately keeps provider-specific unknowns as proof gates rather than hiding
them behind a generic “client” claim.
