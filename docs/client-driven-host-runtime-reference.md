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

The state-mutating end has exactly one native harness. One person uses its real TUI while one
remote-claw bridge occupies the product's supported remote/server collaborator connection. A
remote-claw server may have many collaborators behind that bridge, including another remote-claw
server represented as one collaborator. Read the nesting from the mutating inside outward:

```text
native harness
├─ real native TUI
│  └─ person
└─ remote-claw bridge
   └─ one remote collaborator
      └─ server A
         ├─ collaborator
         ├─ collaborator
         └─ nested server B
            └─ ...
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

The native TUI and the remote-claw bridge are peers only at the innermost native boundary. Local TUI
input follows the product's normal path directly to the native harness. The bridge does not intercept
that Submit action; it observes the resulting native event and carries it outward. The native harness
therefore owns the final interleaving and acceptance of local and remote work.

Each remote-claw server is a collaboration multiplexer. It orders and deduplicates requests from its
direct collaborators, then represents that whole set through one inward edge. If another remote-claw
server joins as a collaborator, its entire subtree occupies one such binding. No outer layer creates
another Claude Code, Codex, or OpenCode runtime.

The protocol boundary must be behavior-transparent to the native app. remote-claw adds a collaborator
and provider-isolation boundary, not a replacement product experience.

### 1.1 Drop-in native-app substitution contract

The operator must be able to change only the native client's endpoint, or launch Claude Code inside the
wrapper, and keep the normal product workflow:

```text
Codex direct
  pinned TUI
      ⇅
  pinned real app-server

Codex through remote-claw
  same pinned TUI
      ⇅
  remote-claw endpoint
      ⇅
  same real private app-server

Claude direct
  pinned Claude Code
      ⇅
  normal Anthropic services

Claude through remote-claw
  same pinned Claude Code
      ⇅
  complete private façades
      ⇅
  isolated connectors

OpenCode direct
  pinned TUI
      ⇅
  pinned real server

OpenCode through remote-claw
  same pinned TUI
      ⇅
  remote-claw endpoint
      ⇅
  same real private server
```

The Codex client-facing endpoint is a full-duplex app-server compatibility boundary. For ordinary
app-server traffic, it forwards the native JSON-RPC messages and connection state to one real private
Codex app-server without translating them into remote-claw's normalized command schema.
Authentication, TLS, observation, and routing may wrap that stream, but the local TUI leg never enters
the collaboration coordinator. remote-claw's own collaborator uses a separate initialized app-server
connection to the same thread. Cross-connection coherence is a go/no-go proof: each side must observe
the other's native thread status, history, turns, gates, and completion while client-request ID
domains, subscriptions, server-request routing, backpressure, and errors behave exactly as the pinned
app-server defines them. The design does not assume that every notification is broadcast or every
server request is connection-local.

Pinned `0.146.0` uses more than one native attachment rule. Ordinary top-level `thread/start`
subscribes its requester, while a separate core child-agent creation/resume notification path
best-effort attaches every initialized connection. Multi-chat Codex support is unavailable until the
differential suite proves the exact top-level, child-thread, explicit resume/unsubscribe, broadcast,
and TUI-routing behavior for the trusted direct TUI connections plus exactly one remote-claw bridge.
The front door must preserve those native rules rather than impose selected-thread isolation.

Codex Remote host management is the one deliberate exception to blind forwarding. In the pinned
source, the sole `MessageProcessor` serves `remoteControl/enable`, `remoteControl/disable`,
`remoteControl/status/read`, `remoteControl/pairing/start`, `remoteControl/pairing/status`,
`remoteControl/client/list`, and `remoteControl/client/revoke` through
`RemoteControlRequestProcessor` and its in-process `RemoteControlHandle`. The surrounding app-server
runtime starts that handle, resolves persisted enablement, watches its status, and emits
`remoteControl/status/changed`. The target injects one `RemoteControlService` at the app-server
runtime level and shares it with the sole processor's management path and the surrounding
startup/status loop. Its implementation talks over authenticated local IPC to the outward Remote
gateway, so the native app-server continues to originate the exact protocol responses and
notifications while holding no OpenAI credential or socket. This is an upstream/native seam, not a
second processor. This service is only the management plane. Each physical app-server connection
currently owns its own initialized `ConnectionSessionState` plus connection-scoped request correlation
and lifecycle, including identity, capabilities, notification preferences, and attestation. The target
does not copy every official stream into that native topology. It retains those streams in the outward
gateway. Stream-local initialization, resume, unsubscribe, close, and reconnect update only the
gateway's per-stream state. A subscription reconciler maps the union of current host/collaborator demand
to zero or one fenced transition on exactly one initialized native bridge; admitted semantic native
mutations map to one bridge request. Request IDs, source-owned handles, notification filters, and
disconnect cleanup remain distinct in the gateway. If differential tests prove native behavior depends on the original client profile or
resource lifetime, an admitted bridge request may carry only the smallest versioned compatibility or
source-lease context; that context creates no native connection, subscription, writer, or authority. A
pinned version without management injection, exact native subscription/routing parity, and exact mapping/cleanup keeps
multi-chat official Remote control unsupported.

If the pinned real app-server cannot keep the TUI and bridge coherent, shared writable Codex mode is
unsupported for that version. The next action is to prove or improve the native app-server seam,
including an upstream contribution when appropriate—not to build a second Codex server,
`MessageProcessor`, or thread store. The outward Remote gateway necessarily retains provider stream
and correlation state, but it is not another native Codex implementation and owns no authoritative
native thread/rollout store, `MessageProcessor`, model runtime, or execution authority.

The Claude boundary cannot pass unknown traffic through to Anthropic because the inner process is
network-isolated. For each supported, pinned Claude Code version, the wrapper must therefore implement
every Anthropic API and Remote Control operation that binary uses, including status codes, streamed
event order, half-close and reconnect behavior, credential/account answers, error paths, and timing
constraints that affect client state. The private RC service gives remote-claw one remote-collaborator
connection while the normal local TUI path remains inside Claude. Unknown mutations, routes, or client
versions fail closed as unsupported; they never tunnel to Anthropic or degrade into a similar-looking
but behaviorally different path.

“Same result” is semantic equivalence, not merely matching transcript text. It includes the same
handshake and capability negotiation; native session/thread identity and lifecycle; requests,
responses, server requests, and notifications; draft/Submit behavior; idle/busy queueing and steering;
interrupts; permissions and questions; attachments; model, mode, and configuration changes; error and
overload behavior; disconnect/reconnect; and native rendering. Given the same provider responses and
the same input race, it also requires the same native transcript, tool actions, subprocesses, and
filesystem effects. Tests may alpha-rename fresh opaque IDs only after proving the same allocation
count, equality and alias relationships, scope, and continuity across history, reconnect, and fork. A
surprise new native, provider, thread, or session ID is a compatibility failure. Timestamps may be
normalized only where their value has no semantic effect. A deliberately different model/provider may
change model content, but remote-claw itself may not introduce another semantic difference.

Compatibility is versioned evidence, not a best-effort promise:

1. Pin the native client and native server/harness versions as one compatibility tuple. For an
   official-client workflow, also pin the official client build, provider host/worker protocol or
   schema version, and capture epoch.
2. For Codex, generate and retain that version's app-server schemas and trace every bidirectional
   method, notification, and server request used by the native TUI.
3. For Claude, retain sanitized direct and brokered captures for every endpoint and state transition
   exercised by the pinned binary.
4. Prefer a transparent byte/message path on the native-client leg; observation must not reorder,
   synthesize, swallow, or delay native protocol events.
5. Advertise support only after differential conformance, race, backpressure, and reconnect suites
   pass. A new native or official-client version remains unsupported until the same gates pass. When
   the target device's rendered state cannot be observed, rendering parity remains unproved rather than
   being inferred from provider receipt.

The same contract applies to official mobile, web, desktop, and editor clients for every outward
workflow remote-claw advertises. If a client can distinguish the remote-claw route in a
behavior-changing way, that is a compatibility failure or an explicitly unavailable capability, not
an accepted alternate workflow.

## 2. Authority by fact, with several sources of evidence

There is no useful single “source of truth” for every kind of fact. Authority is divided by job:

| Fact | Owner |
|---|---|
| Native conversation, final local/remote interleaving, accepted input, context, tools, subprocesses, and side effects | Innermost native harness and its durable native store |
| Order and forwarding decision among one server's direct collaborators | That remote-claw server |
| Which provider representation was accepted and can be read back | OpenAI or Anthropic transport |
| What an official app actually rendered | That official client device; not generally observable here |
| Which sealed frames the broker accepted and can replay | remote-claw broker |
| Which frames were decrypted and rendered | remote-claw viewer |

Each remote-claw server keeps a small control journal for its own collaboration boundary, not a
competing assistant transcript. It stores:

- stable command IDs and origins;
- the order in which its direct-collaborator proposals were received and decided, including forwarded,
  queued, and rejected proposals;
- forwarding, queue, and rejection decisions;
- inward-edge and outward delivery state;
- inward-target recovery cursors, plus native conversation IDs only at the terminal server;
- exact correlation mappings;
- uncertain outcomes and explicit recovery gaps.

At the terminal edge, the native client remains the first recovery source for conversation history
and execution state. An outer server recovers from its exact inward server/chat edge instead. The
coordinator may cache normalized messages for projection, but it must not rebuild a native conversation
by replaying prompts, tool calls, or approvals.

This split is the core rule:

> A remote-claw server decides what it will offer inward. The innermost native harness decides what is
> applied. Native state is the first semantic evidence of what happened; anything it cannot positively
> establish remains uncertain or becomes an explicit gap. A server may hold or reject a proposal only
> through behavior that its source binding can represent faithfully.

## 3. Nesting and identity

The user-visible hierarchy remains:

```text
host
└── project
    └── logical chat
```

Each server-scoped logical chat has many direct collaborators and one inward edge. That edge may target
another server-scoped chat; only the final innermost edge targets a native binding:

```text
(server, logical chat)
├─ direct collaborators
├─ proposal + delivery journal
└─ one inward edge
   └─ one target
      ├─ another server/chat, or
      └─ terminal native binding
         ├─ native session/thread
         ├─ one real native TUI
         └─ one remote-claw bridge
```

IDs from one layer never become IDs for another:

- a Claude `cse_*`, Codex thread ID, OpenCode `ses_*`, tmux pane, and remote-claw chat ID are distinct;
- one Codex host registration contains many projects and threads;
- one Claude outward Remote session normally represents one logical chat;
- replacing or resuming a native process updates its binding without silently merging another chat.

The durable identity layers are:

| ID | Meaning | Restart rule |
| --- | --- | --- |
| `(collaborationServerId, logicalChatId)` | Canonical chat and visible row within one remote-claw server | Stable across that server's coordinator, connector, and proven native-edge restarts; never aliased to another server's chat ID |
| `nativeBindingId` | Durable relationship between the innermost server chat and its current native conversation | Exists only at the terminal inward edge; stable while the same semantic native conversation is resumed |
| Native conversation ID | Claude transcript/resume UUID, Codex thread ID, or OpenCode session ID | Native evidence; never a remote-claw routing ID |
| Native runtime/incarnation | One provably identified process, app server, or server generation | Advances on a cold native replacement; a live reattach may retain it |
| Private collaborator attachment | Inner Claude `cse_*`, remote-claw app-server/SSE connection, or tmux attachment | Reused first when the native protocol permits; otherwise replaceable beneath the binding; distinct from the person's native-TUI connection |
| Collaborator binding/incarnation | Anthropic Remote session, ChatGPT host/chat, web transport, automation, or nested remote-claw edge | Independent of native restart; reconnect or provider-forced replacement does not change `logicalChatId` |
| Inward collaboration edge | One server and its whole collaborator subtree represented as one collaborator to the next layer inward | Reconnect preserves the represented server identity, origin lineage, and deduplication domain |
| Source event namespace | Proven uniqueness domain for one outside source's event IDs | May span connector incarnations; changes only after positive evidence that the provider reset or replaced the ID domain |

`logicalChatId` is allocated durably within its `collaborationServerId` before that server accepts its
first collaborator mutation. A terminal server may adopt a proven native conversation whose local
history predates remote-claw; adoption does not replay or relabel that history. The ID is never derived
from a title, working directory, message text, `cse_*`, Codex/OpenCode ID, pane, broker channel, or
provider ID. `command_seq` orders proposals at one remote-claw server; it is not the native harness's
final applied order. Normalized `chat_seq` follows correlated native observations where those exist.
Neither resets when a transport changes. At a terminal edge, exactly one native binding/incarnation is
current; an outer chat instead has one current inward server/chat edge. Superseded records remain
immutable because delivery attempts name the exact target reference they might have reached.

An infrastructure restart never creates another visible chat on that server. At the terminal edge, a
proven resume of the same semantic native conversation keeps both `logicalChatId` and
`nativeBindingId`, even if the runtime or private transport ID changes; an outer server instead
reconnects the exact mapped server/chat edge. An explicit new/clear creates a new logical chat; a fork
creates a new logical chat with parent/fork lineage. If terminal recovery cannot prove the expected
native identity, remote-claw quarantines the old chat instead of matching by title or text. Only an
explicit recovery decision may either install a successor binding with a visible gap under that chat
or create a new logical chat.

## 4. Host-wide native-client adapters

The current exported `Driver` interface is a partial, one-session, Claude-RC-shaped seam; the CLI
dispatcher still branches directly among MITM, OpenCode, and tmux launch paths, and MITM itself can
create several sessions. That interface cannot be the host-wide contract because Codex needs one host
runtime that discovers and serves many threads.

The host-level lifecycle vocabulary introduced in A0.1 is the base for the target A1 boundary below.
This excerpt intentionally includes the A1-only `NativeMutationFence` fields; it is not a claim that
all fields shown have landed:

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
  // Receipt grade only. "structured_receipt" does not imply native acceptance.
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
  collaborationServerId: string;
  logicalChatId: string;
  nativeBindingId: string;
  inwardEdgeId: string;
  inwardConnectionEpoch: number;
  topologyGeneration: number;
  coordinatorEpoch: number;
  attemptId: string;
  nativeRef: NativeConversationRef;
  attachmentLeaseId: string;
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

The existing `mutationAdmission` capability name describes how much evidence the adapter has for
remote-claw-origin delivery. It does not mean remote-claw admits direct TUI actions or outranks the
native harness.

The lifecycle interfaces through `NativeEngineAdapter` have landed. The current
`NativeMutationFence` contains only `bindingId`, `coordinatorEpoch`, `attemptId`, and `nativeRef`; its
server/chat/edge/generation/attachment fields shown above are A1 target fields. The landed A0 contract
is deliberately lifecycle-only. Its process-local `bindingId` is an `rcb_*` lease
key, not the canonical chat ID. A1 adds durable records above it:

```ts
interface LogicalChatRecord {
  logicalChatId: string;
  collaborationServerId: string;
  projectId: string;
  state: "recovering" | "ready" | "quarantined" | "closed";
  nextCommandSeq: number;
  topologyGeneration: number;
  currentInwardEdgeId: string | null;
  currentNativeBindingId: string | null;
  parentChatId: string | null;
}

interface NativeBindingRecord {
  nativeBindingId: string;
  collaborationServerId: string;
  logicalChatId: string;
  descriptor: NativeEngineDescriptor;
  projectId: string;
  semanticConversationId: string | null;
  currentIncarnation: number | null;
  state: "starting" | "current" | "superseded" | "closed";
}

interface LocalNativeConversationRecord {
  localNativeConversationId: string;
  descriptor: NativeEngineDescriptor;
  projectId: string;
  runtimeId: string;
  nativeIncarnation: number;
  semanticConversationId: string | null;
  parentLocalNativeConversationId: string | null;
  state: "unbound" | "open" | "closed";
}

interface LocalNativeConversationTransitionRecord {
  localTransitionId: string;
  runtimeId: string;
  nativeIncarnation: number;
  localTransitionSeq: number;
  kind: "discover" | "new" | "clear" | "fork" | "switch" | "archive" | "unarchive";
  sourceLocalNativeConversationId: string | null;
  targetLocalNativeConversationId: string;
  observedSemanticConversationId: string | null;
  nativeEvidenceRef: string;
}

interface LocalNativeConversationMappingRecord {
  localNativeConversationId: string;
  collaborationServerId: string;
  logicalChatId: string;
  nativeBindingId: string;
  importedThroughLocalTransitionSeq: number;
  classification: "existing" | "new" | "clear" | "fork" | "switch" | "adopted";
  evidenceRef: string;
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

interface InferenceConnectorLease {
  inferenceLeaseId: string;
  runtimeId: string;
  nativeIncarnation: number;
  connectorGeneration: number;
  state: "current" | "superseded" | "closed";
}

interface InferenceAttemptRecord {
  inferenceAttemptId: string;
  inferenceLeaseId: string;
  runtimeId: string;
  nativeIncarnation: number;
  localNativeConversationId: string | null;
  connectorGeneration: number;
  nativeRequestId: string;
  requestDigest: string;
  upstreamIdempotencyKey: string | null;
  upstreamRequestId: string | null;
  upstreamRecoveryEvidenceRef: string | null;
  nativeResponseStreamId: string;
  upstreamState: "prepared" | "started" | "accepted" | "streaming" | "completed" | "failed" | "outcome_unknown";
  nativeDeliveryState: "not_started" | "started" | "streaming" | "completed" | "failed" | "outcome_unknown";
  deliveredThroughSequence: number;
}

interface InferenceConversationCorrelationRecord {
  inferenceAttemptId: string;
  localNativeConversationId: string;
  nativeEvidenceRef: string;
}

interface InferenceResponseChunkRecord {
  inferenceAttemptId: string;
  sequence: number;
  upstreamSequence: string | null;
  chunkDigest: string;
  encryptedPayloadRef: string;
  nativeDeliveryState: "not_started" | "started" | "delivered" | "outcome_unknown";
}

interface OutsideBindingRecord {
  outsideBindingId: string;
  collaborationServerId: string;
  logicalChatId: string;
  kind: "anthropic-remote" | "chatgpt-remote" | "web" | "automation" | "nested-remote-claw";
  representedServerId: string | null;
  representedLogicalChatId: string | null;
  representedInwardEdgeId: string | null;
  currentIncarnationId: string | null;
  state: "current" | "closed";
}

interface ChatGptRemoteHostRecord {
  chatGptRemoteHostId: string;
  collaborationServerId: string;
  installationId: string;
  providerServerId: string | null;
  providerEnvironmentId: string | null;
  displayName: string;
  currentConnectorLeaseId: string | null;
  currentTransportStateVersion: number | null;
  state: "unpaired" | "paired" | "closed";
}

interface ChatGptRemoteHostConnectorLease {
  connectorLeaseId: string;
  chatGptRemoteHostId: string;
  connectorGeneration: number;
  coordinatorEpoch: number;
  transportEpoch: number;
  state: "current" | "superseded" | "closed";
}

interface ChatGptRemoteHostTransportStateRecord {
  chatGptRemoteHostId: string;
  connectorLeaseId: string;
  connectorGeneration: number;
  coordinatorEpoch: number;
  transportEpoch: number;
  stateVersion: number;
  encryptedCredentialEnvelopeRef: string | null;
  enrollmentStateRef: string | null;
  pairingStateRef: string | null;
  reconnectCursorRef: string | null;
  chunkAckStateRef: string | null;
  officialStreamStateRef: string | null;
}

interface ChatGptRemoteChatMappingRecord {
  outsideBindingId: string;
  chatGptRemoteHostId: string;
  providerProjectId: string;
  providerChatId: string;
}

interface InwardCollaborationEdgeRecord {
  inwardEdgeId: string;
  representedServerId: string;
  representedLogicalChatId: string;
  targetKind: "native-harness" | "remote-claw-server";
  targetServerId: string | null;
  targetLogicalChatId: string | null;
  targetNativeBindingId: string | null;
  rootPathCertificateId: string;
  currentConnectionEpoch: number;
  state: "installing" | "installed" | "current" | "superseded" | "closed";
}

interface TopologyPathHop {
  collaborationServerId: string;
  logicalChatId: string;
  inwardEdgeId: string;
  topologyGeneration: number;
}

interface NativeRootCertificate {
  rootPathCertificateId: string;
  kind: "native-root";
  terminalNativeBindingId: string;
  terminalServerId: string;
  terminalLogicalChatId: string;
  terminalTopologyGeneration: number;
  runtimeOwnerIdentityKeyId: string;
  signature: string;
  expiresAtMs: number;
}

interface ServerRootedTopologyCertificate {
  rootPathCertificateId: string;
  kind: "server-path";
  terminalNativeBindingId: string;
  targetServerId: string;
  targetLogicalChatId: string;
  targetTopologyGeneration: number;
  path: readonly TopologyPathHop[];
  issuerServerIdentityKeyId: string;
  signature: string;
  expiresAtMs: number;
}

type RootedTopologyCertificate = NativeRootCertificate | ServerRootedTopologyCertificate;

interface InwardEdgeInstallReservation {
  reservationId: string;
  sourceServerId: string;
  sourceLogicalChatId: string;
  expectedSourceTopologyGeneration: number;
  targetServerId: string;
  targetLogicalChatId: string;
  expectedTargetTopologyGeneration: number;
  rootPathCertificateId: string;
  sourcePreparedReceipt: string;
  targetPreparedReceipt: string | null;
  sourceCommitIntentReceipt: string | null;
  targetCommitIntentReceipt: string | null;
  sourceInstalledReceipt: string | null;
  targetInstalledReceipt: string | null;
  state:
    | "source_prepared"
    | "both_prepared"
    | "commit_intent"
    | "source_installed"
    | "target_installed"
    | "both_installed"
    | "finalized"
    | "aborted"
    | "expired";
}

interface ServerIdentityKeyRecord {
  collaborationServerId: string;
  identityKeyId: string;
  algorithm: string;
  publicKey: string;
  trustEvidenceRef: string;
  validFromMs: number;
  supersedesIdentityKeyId: string | null;
  rotationSignature: string | null;
  state: "current" | "retired" | "revoked";
}

type EventOrigin =
  | {
      kind: "collaborator";
      originServerId: string;
      originLogicalChatId: string;
      originOutsideBindingId: string;
      originSourceEventNamespaceId: string;
      originSourceEventId: string;
    }
  | {
      kind: "native";
      originNativeBindingId: string;
      originNativeObservationId: string;
    };

interface EventLineageHop {
  hopIndex: number;
  collaborationServerId: string;
  logicalChatId: string;
  inwardEdgeId: string;
  direction: "inward-proposal" | "outward-observation";
  canonicalEnvelopeSchemaId: string;
  canonicalEnvelopeDigest: string;
  priorChainDigest: string;
  signerIdentityKeyId: string;
  attestation: string;
}

interface EventLineageRecord {
  lineageId: string;
  origin: EventOrigin;
  direction: "inward-proposal" | "outward-observation";
  hops: readonly EventLineageHop[];
}

interface EventCausalityRecord {
  causalityId: string;
  collaborationServerId: string;
  logicalChatId: string;
  lineageId: string;
  causeServerId: string;
  causeLogicalChatId: string;
  causeKind: "command" | "native-observation";
  causeId: string;
  relation: "submit" | "steer" | "permission" | "question" | "control";
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
  collaborationServerId: string;
  logicalChatId: string;
  lineageId: string;
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
  collaborationServerId: string;
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

`NativeTransportAttachment` and `NativeTransportLease` describe remote-claw's one collaboration
attachment to the native harness, not the person's TUI connection or the inference connector. The
client-facing endpoint and `InferenceConnectorLease` are supervised by the native runtime owner so a
collaboration-coordinator restart does not tear down local work.

For Codex, each managed top-level chat-thread binding has its own logical attachment and lease, but all
of those attachments reference the same daemon-wide physical app-server connection through one shared
`transportId`. Closing such a binding closes its subscription/lease, not that shared connection. A
child thread stays nested evidence under its classified parent until a retained lineage fixture proves
another user-visible mapping.

`LocalNativeConversationRecord` and its transition log belong to that runtime owner, not to a
collaboration server. The owner may allocate a local record before the native semantic ID is known,
then bind exact native evidence later. This lets a direct TUI create, clear, fork, switch, archive, or
use a conversation while every collaboration coordinator is unavailable. A local record grants no
remote authority and cannot allocate or repoint a `logicalChatId`; only the coordinator's later
`LocalNativeConversationMappingRecord` does that.

Inference delivery has its own write-ahead boundary. Before an isolated connector can send a
provider request, the runtime owner durably creates an `InferenceAttemptRecord` with upstream state
`prepared` and native delivery `not_started`. The inference lease and attempt are scoped to the exact
runtime/incarnation rather than a `nativeBindingId`, `logicalChatId`, or coordinator epoch. The
attempt pins the exact native request, connector lease, request digest, response-stream identity, and
any upstream idempotency key. It names the local native-conversation record when that correlation is
already known; otherwise a later immutable `InferenceConversationCorrelationRecord` may link it only
after native evidence proves the relationship. This correlation never replays or moves the attempt.

Upstream state moves to `started` before the first possible provider byte. Each response chunk is
encrypted in the local durable chunk outbox with its upstream coordinate and digest before its
separate native delivery state advances; the attempt retains both the provider request/read-back
evidence and the contiguous native-delivery cursor. A connector or façade crash therefore recovers the
same attempt and cannot create a second native response stream. It resumes an upstream or native
stream only when the pinned protocol positively supports that cursor. An ambiguous upstream request
or partial stream is retried only when a stable idempotency key or read-back proves replay safe;
otherwise upstream or native delivery becomes `outcome_unknown`, the façade closes with the pinned
native client's normal transport error, and only an explicit native-client retry can create a new
attempt. It never silently starts or splices a second model answer.

The coordinator journal and separately supervised native-runtime registry together retain every native
incarnation, local native-conversation transition and mapping, transport attachment and lease,
inference attempt and correlation, collaborator-binding incarnation, ChatGPT Remote host, connector
lease, and transport-state version, inward collaboration edge, event lineage, source-event
namespace/transition/observation and canonical deduplication record, immutable capability snapshot
and verification, cursor, correlation tombstone, and containment result. An attachment belongs to
the durable native binding, not to one process incarnation: a new lease ties the same attachment to
the current native incarnation and coordinator epoch. For Claude, `transportEpoch` is the private RC
worker epoch. A1 registration resolves a `nativeBindingId` through its durable `logicalChatId`; it
never assumes the two IDs are equal.

Every server-local record that belongs to a logical chat either carries both `collaborationServerId`
and `logicalChatId` or has an immutable foreign key to a record that carries that pair. A globally
unique record ID never replaces the server/chat scope. Runtime-local conversation and inference
records intentionally have no server/chat scope until a mapping is committed; that absence prevents an
offline local action from being guessed into the wrong chat. Cross-server lineage is different: every
hop retains its own `(collaborationServerId, logicalChatId, inwardEdgeId, direction)` coordinates, so
a single event never acquires one false global chat scope.

Current inward collaboration edges form a rooted acyclic tree whose root target is the native harness.
A `(server, logical chat)` pair has at most one current inward edge but may have many direct
collaborator bindings. Each edge explicitly maps the represented server's chat to a binding in the
next server inward or to the innermost native binding; chat IDs are never reused as cross-server
aliases. Exactly one current inward edge may target a given terminal `nativeBindingId`; this is the one
remote-claw collaborator visible at the native boundary.

Edges are installed from the native root outward, never by linking two unrooted chats. The runtime
owner bootstraps the terminal edge with a short-lived signed `NativeRootCertificate` only after the
exact native binding is current; one local transaction compare-and-swaps the terminal server/chat
generation and installs that binding, certificate, and edge together. Only a server target that already
has such a current path may issue a signed `ServerRootedTopologyCertificate`. It commits the target's
complete server/chat/edge path and every topology generation.

For a server-to-server edge, the source verifies that it is absent from the certified path and has no
current inward edge, then writes its signed prepare receipt against its expected generation. The target
does the same for its collaborator slot and certified generation. Both sides next exchange signed
commit-intent receipts. Each side may then install the reserved edge only as `installed`, which is
durable but non-writable, and exchange signed installed receipts naming both commit intents and both
expected topology generations. A reservation reaches `both_installed` only after each side has
verified both installed receipts.

Writability is a separate live handshake. Each side presents both installed receipts, the reservation
ID, current topology generations, and a fresh connection epoch; only then may its local edge become
`current`. Every inward send revalidates that live peer lease, and every receiver rejects a mutation
unless its own matching edge is also current. A split finalization can therefore leave one side
installed or locally current, but it cannot deliver a mutation through a non-current peer. Connection
loss immediately removes writability even though the installed reservation remains recoverable.
Finalization and recovery are idempotent compare-and-swaps: they either reconnect the same installed
edge and complete the live handshake, or expire it without making a partial reservation writable. Any
topology change invalidates the certificate, reservation, installed receipts, and live handshake.

Reparenting first stops new writes on the old edge and reconciles every `started` or
`outcome_unknown` delivery with positive completion/cancellation evidence or containment of the old
target. Only then may it close the old edge, advance the source generation, and make the source
unrooted. Consequently two simultaneous reciprocal binds cannot both commit: neither unrooted target
can issue a root certificate, while a rooted source already has a current inward edge.

An inward proposal appends the current server/chat/edge/direction hop to its lineage; an outward native
observation uses a separately typed outward lineage and may link every proposal, steer, permission,
question, or control command that caused it. Each hop signs a versioned canonical serialization of the
immutable origin, complete event-envelope digest, direction, prior-chain digest, and new hop. Thus an
intact chain cannot be transplanted onto changed text or control fields.

The edge handshake binds each `collaborationServerId` to a server identity public key through
operator-approved enrollment or a previously trusted signed certificate. A rotation is accepted only
when the old current key signs the new key, or after explicit re-pairing; retired public keys remain
available to verify old records, while revocation blocks new hops without rewriting history. The
receiver resolves each hop's key from that authenticated registry, verifies the complete chain, and
appends its own attestation. The outward result intentionally returns over the same physical edges in
reverse. A server rejects a proposal that already traversed that server or inward edge, rejects an
observation that already traversed that outward edge, and never converts an outward observation or
correlated echo into an inward proposal. A malicious server can lie about a new event it originates,
but it cannot change the payload or remove, reorder, or change an already-attested inner hop without
breaking the verifiable chain.

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
writable. If the old incarnation has a `started`/unknown mutation, an epoch or future-write fence is not
enough: positive terminal/cancellation evidence or definitive process stop, freeze, or kill must first
prevent that attempt from executing late.

A fresh adapter never invents native identity. `runtimeId` identifies the supervised native
service or process tree; `conversationId` identifies its semantic native chat; native `incarnation`
distinguishes replacements. Synthetic inner RC IDs, panes, app-server connections, provider session
IDs, broker channels, cursors, and fork/turn/item IDs remain transport attachments, adapter metadata,
or outward bindings—not aliases for `conversationId`, `nativeBindingId`, or `logicalChatId`.
`coordinatorEpoch` fences stale remote-collaboration writers after restart. Conflicting or
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
in-flight outcomes. In A1, the coordinator queues or rejects pre-ready remote proposals, and graceful stop
fences new writes, settles or marks in-flight work, persists cursors and gaps, detaches outside
connectors, and only then applies the explicit keep-alive or terminate policy. That runtime ownership
must ensure that closing one Codex thread lease never closes the shared host-scoped app-server.

Native process ownership is separate from a conversation lease. A small host runtime owner—an OS
service, daemon, or per-engine warden—keeps eligible native processes and private protocol endpoints
alive across coordinator reconnection, saves their locators/start identities, and grants one
epoch-fenced remote-collaboration mutation lease. If an adapter cannot reattach safely, it advertises cold native resume or
successor-chat recovery instead. Today's cleanup differs by path: Claude wrapper teardown ends its
child, tmux kills its pane, and OpenCode leaves the external server alive but best-effort aborts the
attached session's active run. None provides the selected persistent-runtime contract yet; live
reattachment remains proof-gated.

The coordinator epoch is enforced, not informational. Acquiring it is an atomic compare-and-swap in the
server journal. Every server journal transition, remote-claw-origin delivery before native acceptance,
outward collaboration write, ingress ACK, and outbox claim is conditional on that epoch; the runtime
owner and connectors reject stale epochs. This prevents an old coordinator and its replacement from
both delivering. Direct native-TUI mutations remain on the native product path and are not
coordinator-epoch fenced.

Inference has a separate runtime/warden lease. Provider-shaped calls already accepted by the native
harness name the current native runtime and inference-connector generations, not the collaboration
coordinator epoch. A coordinator restart therefore cannot cancel or block an accepted local-TUI turn,
and it does not retroactively control a remote proposal after the native harness accepted it. A total
loss of the local façade or inference connector can still make new model-backed work unavailable; that
is a native-runtime availability failure, not a collaboration admission decision.

Every future remote-claw-origin mutating engine-port call carries `NativeMutationFence`; its
write-ahead `attemptId`, server/chat scope, durable `nativeBindingId`, inward edge and connection epoch,
topology generation, exact native reference, coordinator epoch, and attachment lease are validated
immediately before the native side effect. This is never the process-local A0 `rcb_*` registration
lease. A private collaboration-transport operation resolves the named attachment lease and rejects it
if the attachment, native incarnation, coordinator epoch, transport epoch, edge generation, or
topology generation is no longer current.

## 5. Normalized command path

The first command family is intentionally small:

```text
submit_text
├── command ID
├── collaboration server ID
├── logical chat ID
├── event lineage ID
├── source surface
├── outside binding
├── source event namespace
├── source event/message ID
├── capability snapshot
├── capability verification
├── text
├── received time
└── expected active turn
```

The outside binding, namespace, source ID, and capability pins are required for structured outside
ingress and nullable only where the source contract explicitly has no such field. The expected active
turn is likewise optional.

The initial remote collaborator source surfaces are:

- `web`;
- `anthropic`;
- `openai`;
- `automation`; and
- `nested_remote_claw`.

The direct native TUI is not an outside binding and does not create a remote-claw proposal before
execution. It is a peer of the one innermost remote-claw connection at the native harness. When native
history or a live stream exposes the local action, remote-claw records it as a native observation and
correlates it with the applied native order; it never fabricates a prior coordinator decision.

The exact ingress deduplication key is
`(collaboration_server_id, logical_chat_id, outside_binding_id, source_event_namespace_id, source_event_id)`.
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
allocation; a returning echo points to the existing proposal or native observation and never creates
another execution.

Every mutation originating behind a remote-claw server must cross that server's coordinator before it
is offered inward. The server gives its direct proposals a stable order and uses one fenced inward edge
for forwarding. It may queue or reject only through semantics that the source binding can display
faithfully. Direct native-TUI input is intentionally outside that pre-execution path: the innermost
harness receives it through the product's normal local connection. The native harness is the final
arbiter of both sources and its observed order supersedes any proposed server order for the canonical
applied conversation.

The initial supported tuple is one real native TUI path and one remote-claw collaborator attachment at
the innermost Claude Code, Codex, or OpenCode session. Claude may realize that attachment as a session
connection, Codex as one daemon-wide bridge, and OpenCode as an endpoint-enforced adapter lease over
HTTP/SSE. A nested remote-claw server does not open another native attachment; it occupies one
collaborator binding on the next server outward. Additional native
TUI connections are allowed only when the pinned product's multiplicity, source identity, routing, and
concurrency semantics pass the same differential gate. Tmux retains the same local-plus-remote shape
with weaker post-acceptance correlation.

Interrupts, approvals, questions, attachments, model changes, and mode changes become separate typed
command families only after the chosen inner and outside adapters can represent them faithfully.
Unknown mutation shapes fail closed.

## 6. Control journal and rebuildable projection

Each server's authoritative control journal appends only facts needed to decide or safely recover its
own remote-collaborator mutations:

- `binding.changed`: an inner or outside binding attached, recovered, detached, or was superseded;
- `command.proposed`: an authenticated command arrived;
- `command.decided`: this server chose to forward, queue, or reject it;
- `ingress.changed`: the source event was received and its transport ACK/cursor state changed;
- `delivery.changed`: one named target leg is `not_started`, `started`, `accepted`, `observed`,
  `rejected`, or `outcome_unknown`;
- `outbox.changed`: a stable projection item was enqueued, claimed, accepted, or became uncertain;
- `recovery.gap`: evidence is missing and the missing range or action is explicit.

Every control record carries a stable record ID, `(collaborationServerId, logicalChatId)` scope or an
immutable foreign key to that pair, journal offset, commit time, correlation, and source provenance.
The exact payload of a queued or uncertain command remains durable until its delivery is resolved. A
retention policy may later redact or expire the payload, but it must
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
`target_capability_verification_id` fields. Forwarding and recovery validate those pinned records;
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
- `command_seq` orders the proposals this server received and decided, including queued and rejected
  proposals. Only the forwarded subset is offered inward, in that server order; `command_seq` is not
  the native execution order;
- `chat_seq` orders the rebuildable viewer projection according to correlated native observations
  where available, with explicit provisional or gap state where native order is unknown; the
  control store persists only stable source-ID → `chat_seq`/message-ID mappings, not assistant content,
  so a rebuild reproduces the same identities and interleaving; and
- native IDs, provider sequences, and broker `seq` remain source/projection mappings, never command
  order.

## 7. Delivery state

Receipt, this server's forwarding decision, native delivery, and each outside delivery leg are
different:

```text
proposal
  received
    ├── rejected
    ├── queued
    └── forwarded

native attempt
  not_started
      │
      ▼
    started
    ├── accepted
    │   └── observed
    └── outcome_unknown

target attempt
  same states
```

`forwarded` means only that this remote-claw server chose to offer the proposal over its inward edge.
It does not mean the next server or native harness accepted it. At the innermost edge, only positive
native evidence can advance native delivery to `accepted`; the harness may interleave a direct-TUI
action, queue or reinterpret a control according to native semantics, reject the request, or stop
before applying it.

Native delivery attempts are keyed by command, native binding/incarnation, and native attempt ID.
Outward delivery attempts are keyed separately by projection item, target binding/incarnation, and
outward attempt ID. Source ingress ACK/cursor state is separate: acknowledging an Anthropic worker
event, for example, proves only that the host durably received it; it says nothing about native
execution or an outward projection. Official-device rendering advances no state unless that exact
device supplies a proven render receipt.

`accepted` requires positive adapter-specific evidence: for example, a structured native receipt or a
provider ACK whose contract is known. It never means merely “bytes were written.” `observed` is scoped
to a named observer such as native history or provider history; it does not imply that a device
rendered the event. Tmux paste/Enter has no structural acceptance. The current OpenCode path omits the
available caller-supplied native `msg_*`, so a lost `prompt_async` response has no safe identity there;
those paths may move from `started` directly to `outcome_unknown`.

The web `accepted` frame currently means only that the host assigned a sequence and published its ACK;
it is sent before the content echo attempt and before native injection. It does not prove that the echo
landed or that the native client accepted or executed the prompt. The new path must expose these states
separately.

If a network request may have reached a native client but its response was lost, the result is
`outcome_unknown`. It is never retried automatically unless that adapter has positive,
protocol-specific proof that the native client could not have accepted the first attempt. Absence from
an incomplete or eventually consistent history is not such proof.

Before the first remote-claw-origin inward byte or possible native side effect, the coordinator durably records
`delivery.started` with a stable attempt ID, exact binding/incarnation, and current coordinator epoch.
A crash before the actual write may therefore conservatively produce uncertainty; a crash after the
write can never recover as `not_started` and duplicate execution. The same write-ahead rule applies
to an outward publish. An ambiguous outward write reuses its stable provider/broker idempotency
identity and is retried only when that protocol proves replay is idempotent or proves the first write
absent. A deterministic remote-claw broker frame `msgId` can satisfy that gate; an unproven provider
write cannot.

An unresolved native `outcome_unknown` quarantines that server chat's inward edge: later remote
proposals remain
queued while the old attempt or incarnation might still execute. Delivery resumes only after the
attempt has positive terminal/cancellation evidence, or the old process is definitively stopped,
frozen, or killed and a successor-chat gap is committed. Fencing future coordinator writes does not
contain a request that already crossed the native boundary. This quarantine does not claim to stop the
person's direct native-TUI path.

## 8. Restart and recovery

When the coordinator restarts:

1. Stop forwarding new remote proposals inward.
2. Reopen the small control journal and acquire a new coordinator epoch.
3. Import the runtime owner's local native-conversation transition log from the last committed cursor.
   Commit every exact mapping/classification and the new cursor together; leave ambiguity unbound.
4. Load the exact `(collaborationServerId, logicalChatId)` → inward edge. That edge targets either
   another mapped server/chat or the innermost native binding → semantic conversation →
   runtime/incarnation → transport-attachment chain. Do not discover a replacement by title, path, or
   message similarity.
5. Finish each undecided durable server forwarding decision once under the new epoch.
6. Reacquire the epoch-fenced lease from the inward target: the next remote-claw server edge or the
   native runtime owner.
7. Recover the exact target by kind:
   - if the target is another remote-claw server, reconnect that exact server/chat mapping, preserve its
     lineage namespace, and do not start or discover a native harness at this layer;
   - if the target is native, first positively reattach the surviving native process and its existing
     transport;
   - if native reattachment fails, do not start a cold replacement while the old process might still
     mutate. First obtain positive exit/cancellation evidence or have the runtime owner stop, freeze, or
     kill it and durably record that containment; only then cold-resume the same semantic native
     conversation and ask the private transport service to accept its persisted transport ID, advancing
     the native incarnation only when a replacement process or service was actually started;
   - if that native client instead creates a replacement transport, prove the same semantic
     conversation and supersede only the transport attachment; do not advance the native incarnation
     unless the underlying process or service also changed;
   - if the required target identity cannot be proved, quarantine the logical chat and require an
     explicit successor or new-chat decision.
8. Subscribe to inward observations before taking a snapshot when that edge protocol requires that
   order.
9. At the terminal edge, read the native history, status, pending gates, and cursors that adapter can
   actually expose.
   Approval and question responses follow the same write-ahead and uncertainty rules as text
   commands. Deny an orphaned gate only with positive proof that no earlier response crossed the
   boundary. If a response may have crossed but its acknowledgement was lost, record
   `outcome_unknown`/`recovery.gap`; require positive terminal/cancellation evidence or definitively
   stop, freeze, or kill the old process before permitting another answer.
10. Rebuild normalized viewer messages only from stable inward/native IDs and evidence the adapter has
   proven.
11. Reconcile proposals:
    - if the inward target, ultimately backed by native evidence, proves the proposal happened, mark it
      observed and never resend it;
    - if delivery provably never started, offer it inward in this server's proposal order;
    - if delivery started but cannot be proven, mark it `outcome_unknown` and do not resend
      automatically.
12. Reconnect collaborator protocols, revalidate each current incarnation's durable capability
    snapshot, and resume durable projection outboxes from their stable IDs.
13. Announce and route the same server-scoped `logicalChatId`. A rotated nested or native transport
    must not allocate a second web row, broker channel, provider session/chat, represented subtree, or
    command sequence.
14. Reopen forwarding only when the next inward proposal cannot overtake an uncertain older attempt.
    Merely displaying a gap does not make delivery safe.

The broker stream is the encrypted physical inbox for web commands, but it is not their semantic
forwarding/order authority. Current durable-relay preparation, when reusing a session channel, samples
the broker's latest frame count and begins after it. Current drivers do not persist that
logical-chat/session binding, and the sampled fence can skip a prompt that landed before it but was
never processed. The new path must persist a stable encrypted-ingress cursor, replay after the last
committed cursor, and deduplicate by command/source ID. The cursor is a contiguous high-water mark,
or an explicit cursor plus holes: it advances only after every earlier complete frame/multipart group
is durably proposed or rejected. The broker may HTTP-accept ciphertext first; remote-claw must not
send its semantic durable-receipt/forwarding response, source delivery ACK, or cursor advance until the
corresponding local control record is durable. A provider-origin event is losslessly recoverable only
after that provider's redelivery/reconnect behavior passes its proof gate; history repair may
reconstruct a projection but never execute an old history row as a new command.

Structured remote collaboration therefore requires one of two durable ingress contracts: either the broker
retains the complete encrypted frame until semantic acknowledgement, or the source retains the stable
event ID and exact payload until acknowledgement and retries it after reconnect. A web, provider, or
nested-server source that may discard an unacknowledged payload cannot advertise recoverable
collaborator delivery.

If the native client cannot recover the conversation, remote-claw may install a successor binding
under the existing logical chat only after an explicit recovery decision and gap, or may create an
explicit new logical chat with predecessor lineage. Delivery attempts are bound to their original
native conversation/incarnation: `not_started` proposals forwarded toward the old conversation require
explicit abandonment or user reauthorization before delivery to a successor. It never manufactures
native state by replaying historical actions.

The runtime owner observes native conversation changes even while every collaboration coordinator is
offline and writes a monotonic local transition log before depending on that transition for recovery.
It allocates only runtime-local conversation IDs and inference attempts; it does not allocate a
server-scoped chat or grant a remote writer. New local model work therefore remains recoverable through
the runtime-scoped inference lease even when no `nativeBindingId` can yet be resolved.

Before reopening remote writes, the recovered coordinator consumes every unimported local transition
from its last committed cursor and classifies it using exact native IDs, lineage, and history. One
server-journal transaction commits the transition classification, all new or reused
`LocalNativeConversationMappingRecord`s, and the advanced import cursor:

- same-conversation continuation maps to the existing binding and chat;
- new or clear allocates a new `logicalChatId` and `nativeBindingId`;
- fork allocates a new chat and binding with parent lineage;
- archive or unarchive changes the exactly mapped chat's state;
- switch selects an existing exact mapping without repointing another binding; and
- an unknown or ambiguous conversation remains locally usable but unbound until explicit adoption.

Inference attempts remain attached to their immutable runtime/local records and are never replayed,
rewritten, or moved during this import. The coordinator never silently repoints the old binding, and
queued proposals for the old chat are not delivered to the new conversation without explicit
abandonment or user reauthorization. Only after the import and native reconciliation commit may a
newly mapped chat acquire a writable inward edge.

## 9. Native adapter recovery

### 9.1 Claude Code wrapper

The inner Claude process keeps its real TUI and sees remote-claw as one private Remote collaborator:

```text
person
  ⇅
real Claude Code TUI
  ⇅
Claude session
  ⇅ private RC
remote-claw bridge

provider-shaped request
  ↓ synthetic credentials
local inference/API service
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
5. Keep the real TUI attached and connect one remote-claw private RC client as the remote collaborator.
   Offer a remote proposal through the private client→worker stream only after its server forwarding
   decision and write-ahead delivery record. Claude decides how that request interleaves with direct
   TUI input and reports the resulting native order through RC/transcript evidence.

The target proof compares this wrapped arrangement with normal Claude Code local-plus-Remote use.
Draft editing, native rendering, busy/steer behavior, controls, permissions, questions, and reconnect
must remain behaviorally equivalent. remote-claw does not intercept the local Submit action or replace
the Claude editor.

Synthetic RC worker events are the live source; stable transcript rows repair gaps and deduplicate by
native IDs. Where the inner RC protocol has an ACK, remote-claw commits the observation/mapping before
advancing it. A transcript row never becomes a new command merely because its live RC event was lost.

Private-RC delivery ACK and native acceptance are separate states. The current
`/worker/events/delivery` path only suppresses downstream stream replay; Claude may ACK before
application, or apply a command and lose the ACK before reconnect. The target records proposed,
forwarded, worker-delivered, native-accepted, native-observed, and terminal separately. It upgrades a
delivery only by a pinned join among the submitted private-RC UUID, worker echo/delivery identity,
transcript UUID/row, provider request/response, and resulting native turn. No such complete retained
join fixture exists yet, so neither a structured worker receipt nor matching text proves native
acceptance, order, or remote-versus-TUI source.

Permission and question choice follow the same split. remote-claw may select one outside answer, but
must not publish a native resolution merely because it deleted its relay gate or enqueued a
`control_response`. A TUI answer, native cancellation, or tool completion may already have won. The
projection keeps remote choice, private-RC delivery, and native terminal result distinct; it closes
all outward gate copies only from a pinned native cancel/tool/gate terminal record. Interrupt and end
cannot eagerly convert every open gate into a native denial.

Recovery uses Claude's native transcript and resume support where complete. The persisted recovery
set includes the `logicalChatId`, `nativeBindingId`, Claude transcript/resume UUID, transcript locator
and cursor, every private RC `cse_*` attachment and worker epoch, RC event/delivery cursors, exact
runtime start identity, and independent outward bindings.

The wrapper follows a reuse-first Claude algorithm:

1. If the exact child process survives and a version-pinned live-reattach primitive is proven, reattach
   it without changing the native incarnation.
2. Otherwise contain the old process and launch Claude with an explicit, wrapper-controlled
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
the server's `command_seq` and correlated `chat_seq`. Native incarnation and private transport
generation advance independently: reusing a `cse_*` creates a new worker lease, not a replacement
attachment. In-flight
work and pending controls become uncertain if neither the surviving process nor stable transcript/RC
evidence proves their result.

Outside collaborator or connector loss does not own the child process lifetime. It must not stop the
inner Claude process, private RC service, local inference path, real TUI, or an active native turn.
Private-RC takeover first rejects new old-epoch work and holds the replacement non-writable until every
old admitted delivery, pending gate, and inference attempt is terminal or is recorded
`outcome_unknown` with the binding quarantined and the old path contained. Explicit runtime shutdown
then chooses keep/recover versus terminate; disconnect is not implicit termination.

Before this tuple can claim parity, the repository retains sanitized exact-version fixtures with
client/binary/schema hashes for worker ACK-before-application, application-with-lost-ACK and reconnect,
the full RC/transcript/provider turn join, TUI/remote prompt races, permission/question first-winner,
controls, resume/re-bridge, and detach/takeover. Current prose derived from ad-hoc captures and
environment-gated real-Claude tests is evidence to design the fixture, not a retained release proof.

The independently bound outward Anthropic session normally survives an inner `cse_*` or native
incarnation change; it is never used as the native conversation ID. If Anthropic itself forces a new
outward session, the connector supersedes only that outside-binding incarnation and retains the
logical chat and correlation tombstones.

### 9.2 Codex wrapper

The Codex shape keeps the real Codex TUI and gives remote-claw one peer collaborator connection to the
same real app-server:

```text
local control
  person
    ⇅
  real Codex TUI
    ⇅
  remote-claw endpoint
    ⇅
  private app-server/thread

remote control
  remote-claw server
    ⇅
  Codex bridge
    ⇅
  same app-server/thread

model path
  private app-server
    ↓
  local OpenAI façade
    ↓
  inference connector
```

The initial Codex tuple has one directly used real TUI connection and one initialized daemon-wide
remote-claw bridge connection in the private app-server. Additional trusted direct TUI connections may
be supported only after their native multiplicity and routing pass the pinned differential suite. Each
remote-claw chat owns a binding and subscription for one managed top-level chat thread on the shared
physical bridge; it does not create another connection. A core-created child thread remains nested
native evidence under its parent until a retained lineage fixture proves that it has a distinct
user-visible mapping; an attach-all notification alone never creates a logical chat. A native TUI uses Codex's documented `--remote` app-server transport
against the remote-claw endpoint. The TUI-facing proxy preserves the app-server protocol rather than
rerouting TUI mutations through the coordinator. The private app-server is the arbiter: it orders and accepts
requests from the TUI and remote-claw connection. Cross-connection notification and subscription
coherence must be proved as required by §1.1. Pinned `0.146.0` subscribes only the requester for
ordinary top-level creation but uses a different attach-all attempt for core child-agent thread
notifications. The target preserves the native behavior for trusted direct TUI connections and the
one bridge, including resume, unsubscribe, connection-local versus broadcast events, server requests,
and TUI routing. Until that exact multi-thread behavior passes the differential suite, shared writable
multi-chat mode is unsupported for that version. remote-claw does not substitute a second app-server,
`MessageProcessor`, thread store, projection authority, or model runtime. The front door must be
observationally equivalent to a direct TUI→app-server connection for every supported method,
notification, and server request. Ordinary traffic stays transparent. Native Remote host-management
methods remain served by the sole real `MessageProcessor` through the injected
`RemoteControlService`; the app-server runtime uses that same service for startup state and status
notifications. That service covers management only. Every official stream ends at the gateway; the
gateway retains its initialized state, subscription, and lifecycle. It maps admitted semantic native
mutations onto the one bridge and reconciles stream-local lifecycle changes against the bridge's
aggregate subscription rather than forwarding them one-for-one.
If client-profile or source-owned-resource behavior cannot be preserved by request-ID/handle mapping
and explicit cleanup, only the smallest non-authoritative compatibility or source-lease context may
accompany an admitted bridge request. A version without those proven mappings and seams does not
advertise official multi-chat control. The private app-server calls the local model/API façade rather
than OpenAI directly; that inference backend remains independent of the outward ChatGPT Remote
connection.

The front door preserves the pinned version's initialization handshake, one-connection request-ID
domain, generated JSON schema, advertised WebSocket/Unix transport behavior, authentication boundary,
overload/backpressure errors, and reconnect semantics. Each TUI and bridge connection initializes
independently. remote-claw observes a copy of the native stream; it does not acknowledge, reorder, or
synthesize an ordinary TUI message. The app-server's injected `RemoteControlService` is versioned
native behavior, not a front-door emulation: management responses leave through the sole processor's
normal response path, while status notifications leave through the surrounding app-server runtime's
normal broadcast path. Outward official streams do not enter that processor as native connections.
Their initialization, request IDs, capabilities, subscriptions, backpressure, reconnect, and
lifecycle remain in the gateway. Of the gateway and official-stream legs, only the bridge's single
initialized native connection enters the processor; trusted direct TUI connections enter it through
their normal native path.

The pinned [Codex multi-client proof](codex-app-server-multiclient-proof.md) establishes the basic seam
for `codex-cli 0.146.0` / open-source commit
`e363b08c9175ac1cbe5893615dd2cb9ddf95043b`. In the raw-client fixture, client A created one native
thread, late client B materialized it with a model-free command before B could resume, B then resumed
that exact ID, each issued another different model-free command, and both observed deeply equal
selected, correlated native projections for those later commands, including native IDs, event order,
and output bytes.

The retained real-TUI fixture, whose probe SHA-256 is
`014f8bbfcc17ebf25e40598be9117d4fbbc78d83eefbbeeaad189c77bc8e5ae8`, starts one real app-server,
connects one raw client, and attaches a real
`codex resume <same-id> --remote <transparent-recorder> --no-alt-screen` TUI to the exact same native
thread. One model-free shell command in each direction yielded deeply equal selected five-event
projections at the raw client and TUI recorder, including the same native IDs and output bytes; both
markers rendered in the TUI pane. The isolated fixture used synthetic authentication without reading
ambient authentication, had loopback only and no default route, and closed 25 connection attempts that
reached the local deny proxy; their targets and protocols were not retained. It observed no
`turn/start` or model prompt, required native TUI unsubscribe and exit status `0`, deleted the thread
with failed readback, and completed process, tmux, proxy, temporary-root, and synthetic-auth cleanup
before emitting its checked evidence. The TUI source itself uses the same
`RemoteAppServerClient`; this is one Codex implementation. These facts prove the selected model-free
coexistence path, not complete TUI parity.

The retained multi-chat attachment fixture, whose probe SHA-256 is
`aaaa9c633a857c62b6527bb6d5bce3d5bb749b41eb727d02b72f0fa7c53ab5c3`, starts one real app-server
and three independently initialized raw connections. Two direct-client stand-ins each create a
different persistent top-level thread. Before the host joins, only the requester receives its
thread's selected five-event shell-command projection; both other connections return
`notSubscribed` and retain empty correlated projections. The one host observer then resumes both
exact native IDs and receives deeply equal projections with the owning client for a later command on
each thread, while each non-owner remains `notSubscribed`. The isolated, model-free fixture deletes
both threads and completes socket, process, and temporary-root cleanup. It proves this ordinary
top-level path only, not real-TUI multiplicity or the attach-all core child-agent path.

That proof also pins limitations. A late connection cannot resume the checked persistent untouched
empty thread in this build because no rollout exists, but its `thread/shellCommand` can still mutate the
global live thread between native pre-write and post-write subscription checks that both report
`notSubscribed`. The subscribed creator receives the selected five-event command projection while the
late writer's selected exact old turn/item projection remains empty even after same-ID resume and two
later completed turns. For this pinned `thread/shellCommand` path, the write can be accepted between
two `notSubscribed` observations while those selected correlated events remain absent from the writer;
this does not claim absence from unselected methods or resume history.
remote-claw must prove that its bridge is subscribed before the coordinator forwards any method whose
required observation path depends on that subscription, and keep pre-rollout recovery non-writable at
the coordinator; it must never inject a fake event
to force materialization. The native thread-created path's best-effort listener attachment is neither
an admission nor security boundary. Server-initiated requests are sent to the subscribed connection set with one global request ID
and the first response or error consumes it without a connection check; payload validation may occur
only after that callback is removed. This can preserve native TUI-versus-bridge first-arrival behavior
only when the private socket admits exactly those trusted participants; simultaneous, invalid, late,
stale, and replayed approval/question responses remain release tests. Experimental external-clock
requests fail unless exactly one connection is subscribed, so that feature is unsupported for this
pinned shared mode. The instrumented proof uses loopback WebSocket, but every supported production
tuple must use the documented Unix socket because WebSocket remains experimental.

A separate manual `0.146.0` race observation found that when one connection already had an active
model turn, another connection's `turn/start` returned a fresh response turn ID while the native event
stream applied that input within the already-active turn under the original native turn ID. The
conservative design rule is therefore that a `turn/start` response is only a request receipt, not
canonical proof that a second native turn exists. The bridge uses `turn/steer` only for explicit steer
intent, preserves a true start request as such, and in either case adopts applied turn identity and
order only from native events/history. The race result remains a Phase C gate until a retained,
repeatable test establishes it for the supported tuple.

Cold start brings up the model/API façade and network fence first, starts one host-scoped private
app-server with its outward provider socket disabled, its injected management service wired to the
local gateway, its gateway mapping/cleanup path ready, and its pinned native subscription/routing path
unchanged.
It then completes one daemon-wide remote-claw bridge initialization, discovers projects/threads and
their stored rollout state, classifies top-level versus child lineage, creates one logical binding and
subscription per managed top-level chat thread on that shared physical connection, and only then marks
those bindings ready. Child IDs remain nested evidence under the classified parent unless a retained
fixture proves a distinct user-visible mapping.
Gateway unavailability leaves ordinary local Codex usable but makes native
Remote management and official collaboration explicitly unavailable. Deltas are live evidence; final
thread/rollout items repair and deduplicate them by stable IDs. An app-server restart fences and
rebinds every affected managed top-level chat thread as one runtime-incarnation change. Each such
thread retains its own `logicalChatId`/native binding, while classified child IDs remain nested under
their parent, and the outward paired host plus project/chat mappings remain unchanged; restarting the
shared app server must not duplicate official projects or chats.

Thread create/resume/fork/archive are separate typed mutations, not `submit_text`. New thread
creation is two-phase: reserve the logical binding, invoke the private app-server once under a
write-ahead attempt, then bind the returned thread ID. An ambiguous create remains uncertain; it does
not invent or blindly retry another thread.

The checked-in raw-client, real-TUI, and multi-chat probes establish the basic one-thread coexistence
seam and ordinary top-level two-thread observer shape over the experimental loopback WebSocket
transport. Their selected model-free commands prove exact native IDs, selected correlated native event
order, command-output bytes, and the stated subscription fences for those commands only. Phase C must
validate all of these release gates against each supported tuple:

- production Unix transport and front-door parity, including the pinned initialization, reconnect,
  overload/backpressure, and crash behavior;
- exact shared native identities, payloads, and order across the full request, notification,
  server-request, model-turn, tool, approval, question, steer, and interrupt families—not only the
  selected shell-command notification projection;
- concurrent TUI/bridge races, multi-client response arbitration, reconnect replay, and external-clock
  behavior;
- thread-wide and connection-local notifications and server requests routed exactly as the pinned
  implementation defines;
- the private app-server using a local model/API façade while the inner process has no provider
  credentials or direct provider egress;
- the sole processor delegating every `remoteControl/*` management method through the injected
  service, and the surrounding app-server runtime using that same service for startup/status
  behavior, with direct-path parity;
- exact native top-level behavior beyond the selected shell-command fixture, core child-thread
  attachment, real-TUI multiplicity, resume/unsubscribe, broadcast, server-request, and TUI routing
  across trusted direct TUI connections and exactly one host-wide bridge;
- exact gateway retention of each outward official stream's complete state, including provider
  enrollment/envelopes, sequence, chunks and ACKs, initialization, capabilities, request-ID domain,
  notification preferences, subscriptions, server-request correlation, backpressure, reconnect, and
  lifecycle, with a bridge-wide collision-safe request-ID allocator/map, source-owned-handle
  namespacing, response/error routing, reconnect tombstones, and explicit per-stream cleanup through
  exactly one native bridge;
- aggregate subscription reconciliation across overlapping official streams and other remote-claw
  collaborators, including first join, non-final leave, last aggregate leaver, reconnect, and cleanup,
  with each stream lifecycle mutation producing zero or one fenced native transition rather than a
  blind one-for-one forward;
- any proved per-request compatibility or source-lease context carrying only the original-client
  inputs that native behavior requires, without opening another native connection or granting authority;
- the outward gateway providing durable official pairing and identity, with a live official client,
  while Remote credentials, cursors, chunks, ACK state, and enrollment stay outside the inner process;
- top-level/child lineage classification that never allocates a new logical or provider-visible chat
  from an attach-all child notification alone;
- one daemon-wide bridge preserving its managed top-level chat bindings and subscriptions across
  multiple projects and threads; and
- the exact generated app-server schema retained and hashed for the supported tuple.

If any of those gates fail, that pinned Codex version remains unsupported until the native app-server
seam is proved or improved, including by contributing the missing capability upstream when
appropriate. remote-claw does not silently approximate it or switch implementations.

Codex native thread/rollout state is the recovery source, but it is not assumed complete for every
command/tool interaction until proven. All bidirectional app-server methods and server requests fail
closed unless classified. Closing one managed top-level chat binding cannot close the shared physical
bridge connection or app-server runtime.

### 9.3 OpenCode server

OpenCode is the cleanest first control adapter:

- `GET /session` discovers sessions;
- `GET /session/{id}/message` returns chronological history;
- `GET /event` supplies live SSE events;
- `POST /session/{id}/prompt_async` submits text;
- abort and permission endpoints provide structured controls.

In shared mode exactly one directly used OpenCode TUI path and one epoch-fenced remote-claw adapter
lease share the same private server/session. OpenCode exposes a server-wide SSE observer plus
independent HTTP mutations, not a persistent writer connection whose count can enforce this rule. The
private endpoint/runtime owner therefore authenticates the TUI separately, admits remote mutations
only from the current adapter epoch, rejects concurrent old/new wrapper writes, and excludes
unclassified native clients until their concurrency and source attribution are proven. The TUI uses
normal HTTP/SSE semantics; its mutable requests do not detour through the coordinator. remote-claw
orders only the proposals behind its adapter lease, then OpenCode arbitrates those against direct TUI
work and emits the applied native order through history/SSE. An outside-collaborator disconnect cannot
abort the native run, close the shared observer, or detach the TUI. Any client-facing proxy must behave
like a direct OpenCode server connection. Separately, every configured OpenCode model provider is
pointed at a private remote-claw façade and direct provider egress is blocked.

Startup establishes server-wide SSE first and immediately drains it into a bounded, durable overlap
buffer while it snapshots sessions/history. It registers top-level sessions, classifies
child/subagent sessions as nested evidence, commits the snapshot plus buffered tail by stable IDs, and
then marks bindings ready. A paused stream behind the history GET is not a proved overlap. Buffer
overflow, stream loss, snapshot failure, or a crash before the merge commit leaves the binding
non-writable with an explicit recovery gap. Recovery repeats the same overlap. A proven same `ses_*`
under the expected server lineage retains `logicalChatId`; a missing/reused `ses_*` under another
server epoch fails adoption rather than matching history text.

Unretained `1.17.5` OpenAPI/manual inspection reports both legacy `/event` and v2 `/api/event`; sampled
v2 frames carried `evt_*` IDs and increasing sequence values but advertised no replay cursor. The
retained model-free proof uses only legacy `/event` and establishes none of the v2 sequence behavior.
The compatibility tuple therefore compares both, proves sequence scope/reset across reconnect and
native restart, and selects the strongest proven surface. Readiness also requires a pinned native
`GET /session/status` snapshot merged with the buffered tail; the adapter never fabricates `running`
on connect. A native restart that leaves an incomplete durable assistant message with no surviving
runner is classified from incarnation, status, and history as active, interrupted, or an explicit
gap—never silently completed or left waiting forever.

Discovery failure never authorizes session creation, and “most recent” never establishes identity. An
existing logical chat attaches only its exact stored `ses_*`; an absent or wrong-lineage native session
quarantines that binding rather than authorizing a replacement. First import requires an explicit exact
selection and persists its identity transition before writes; a session created directly by the native
TUI follows that import path. Automatic bootstrap requires explicit first-bootstrap intent, no
pre-existing logical binding, and a positive empty session snapshot. Explicit **New chat** may create
while sessions exist, but is a separate typed user operation rather than a discovery fallback. Each
creation uses a two-phase native reservation and write-ahead `POST /session` attempt. The retained
`1.17.5` fixture proves only that its exact `metadata.remoteClawCreationId` marker is returned and
listable; `POST /session` exposes no proved idempotency seam and is treated as non-idempotent. The
supported tuple must additionally prove the exact typed-intent metadata shape before relying on it. A
positive response binds its exact `ses_*`; after a lost response, zero marker matches stays uncertain
while the proof window remains open, one binds that exact ID, and multiple matches quarantine. The
runtime does not retry or use a title/history match. Typed-intent preservation and marker durability
across native server restart are release proofs.

One limitation is load-bearing: `prompt_async` returns HTTP 204 without a response-assigned native
command/message ID, but pinned `1.17.5` accepts a caller-supplied native `msg_*`. The adapter persists a
unique valid ID before delivery and sends it once. Exact history/SSE read-back of that ID is positive
correlation. The retained [OpenCode native proof](opencode-native-proof.md) uses `noReply:true`, one server incarnation, and no
provider/model reply; in that narrow mode the same-ID second POST appends another part. Model-bearing,
concurrent, TUI, and restart variants remain unproved, so a lost response is never blindly retried and
absence remains inconclusive until a proved terminal boundary. Text matching is not evidence. For
text, compact, interrupt, permission, and future question actions, coordinator admission is only
permission to try; native
history/events/status and stable native IDs establish whether, where, and in what order OpenCode
applied the action.

Native outcome does not automatically prove source. Permission has a request/gate identity that may
provide a causal seam once pinned. Abort and summarize do not yet have a proved caller action ID in
their durable outcome, and the current client ignores their response bodies. If the TUI races the
adapter, timing plus HTTP success or an unproven boolean cannot identify which client caused the
observed native transition. The projection records that transition with source `unknown`, leaves the
unmatched remote proposal `outcome_unknown`, and supports source attribution only after the
compatibility tuple proves an unambiguous native seam and response semantics.

Permissions use the same adjudication rule. remote-claw selects at most one answer among its outside
collaborators and sends it through the current adapter lease. A direct TUI may answer independently.
The retained proof schema-pins the global pending list and nondeprecated reply request shape, but it
does not create or answer a gate; current type/OpenAPI inspection reports `permission.replied` without
proving its terminal semantics. A supported tuple may use that event only after a runtime probe proves
it terminal, otherwise another proved native gate record wins. A 2xx boolean reply response is not
enough until its true/false contract is parsed and correlated; false, stale, lost, or mismatched replies
remain rejected or `outcome_unknown`, and every outward gate copy closes from the proved native
terminal record. Additional pending-list routes must likewise be schema-pinned and runtime-probed
rather than reimplemented from guesses.
Parent-session policy setup does not validate child sessions: the current post-creation PATCH can lose
a race to a child's first tool. Shared structured permissions therefore require an atomically inherited
owned-session policy or must advertise child tools ungated and unsupported.

Shutdown distinguishes ownership. Detaching one outside collaborator or an externally owned adapter
does not abort its active turn, close the server-wide observer, or detach the TUI. Adapter replacement
first rejects new work from the old epoch, then holds the new lease non-writable until every old
admitted HTTP request has correlated terminal evidence or is marked `outcome_unknown` with the binding
quarantined and the old execution path contained. Arrival-time epoch checking alone cannot retract a
request already forwarded to OpenCode. An adapter-owned runtime follows its explicit keep/terminate
policy. Permission rules installed by remote-claw are restored only through a proved reversible seam,
and pending gates are resolved or recorded as orphaned before detach.

### 9.4 tmux compatibility mode

The first tmux mode wraps Claude Code: it injects text/keys and reads Claude transcript JSONL. It can
recover completed native messages and subagent transcripts, but it cannot prove every paste, Enter,
permission, or in-flight action.

The shipped compatibility mode allows one person to use the real TUI while remote-claw injects into
that same pane. This is one shared editor/keystream, not two native collaborator connections: a local
partial draft can combine with remote paste, and remote Enter can submit mixed or entirely local text.
Claude remains the arbiter only of the resulting submitted buffer; it cannot recover source commands
that tmux merged. Simultaneous keyboard-plus-remote fidelity is therefore unsupported unless remote
injection acquires a proved quiescent/exclusive editor lease or the native transcript provides an
unambiguous command boundary.

Direct pane submissions are observed only after Claude records them, so this mode has lower-confidence
post-acceptance attribution rather than a pre-execution source identity. Startup or reattach scrubs
inherited Claude session variables, validates the intended pane and child process, installs durable
transcript/permission hooks, binds the exact Claude session/transcript, and starts tailing before
remote input is accepted. Paste and Enter are separate possible side effects. A tmux command error can
arrive after the server applied paste or Enter, so automatic retry is unsafe. Before the first send,
the target writes ahead the source/attempt, transcript cursor, pane/process identity, and intended
payload. Tmux success is only control receipt; native application and source require a correlated
Claude transcript UUID/row. Identical text does not prove either fact.

A persistent process owner may reattach a surviving pane using saved pane/process identity,
Claude session ID, transcript path, inode, and offset. If it cannot prove whether an injected command
started, that command becomes `outcome_unknown`.

The current PreToolUse helper is a remote viewer gate, not a native TUI-versus-remote first-winner
surface. A person at the pane has no equivalent local answer path through that helper. If decision-file
persistence fails, the helper may remain blocked even though the injection pump currently ACKs the
answer. Structured permission parity remains unsupported until a durable local decision seam and
native terminal observation exist; failed answer persistence is never acknowledged as success.

`/compact` remains the same chat only when its native identity proves that; `/clear` starts a new
chat, and `/branch` creates fork lineage. Hook scratch paths, request/decision cursors, and orphaned
permission gates are recovery state. Graceful stop explicitly chooses keep-pane or kill-pane after
draining; closing the chat lease alone does neither.

Tmux remains a compatibility path. It must not advertise the same delivery or recovery guarantees as
structured Claude, Codex, or OpenCode adapters.

## 10. Outside adapters

Remote outside adapters translate between their provider/broker protocol and the normalized
coordinator. They never bypass the server's one inward collaborator edge. Section 10.1 records the
native TUI separately because it belongs to the native harness rather than the outside-binding model.

An outside binding is logically independent of the inner engine product. The design allows one
logical chat to appear in remote-claw web and either or both official Remote surfaces once each
connector proves that mapping; it does not assume a provider accepts a non-native engine shape before
that proof. Each outside view receives only the command/content families that both sides can represent
faithfully; unsupported mutations fail closed rather than being guessed.

Every remote outside binding has the same lifecycle:

1. Bind a durable `outsideBindingId`, reference its independently durable provider/broker
   `sourceEventNamespaceId`, install an evidence-backed durable capability snapshot, and acquire a
   separate fenced connection epoch. Reconnect must revalidate the capability snapshot before
   restoring writability. Native restart never rotates the binding or event namespace.
2. Ingest a mutation with a stable source ID and a commit callback; no semantic ACK or cursor advance
   occurs until that callback durably records its new/replay/collision/ambiguous classification and
   any resulting proposal.
3. Consume a durable causal projection outbox ordered by provisional server `command_seq` and
   native-correlated `chat_seq`.
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

ChatGPT pairing is host-scoped rather than chat-scoped. One durable `ChatGptRemoteHostRecord` owns the
installation/provider host identity and one fenced connector lease for the whole collaboration host.
Each chat-scoped `OutsideBindingRecord` has a `ChatGptRemoteChatMappingRecord` that references that host
plus its provider project/chat IDs. Versioned `ChatGptRemoteHostTransportStateRecord`s durably reference
the encrypted credential envelope, enrollment and pairing state, reconnect cursor, chunk/ACK state,
and official-stream state; they never place credentials inline. Only the current fenced host lease may
append a transport-state version and transactionally advance the host's current-version pointer, and
the new record must carry that lease's exact connector generation, coordinator epoch, and transport
epoch. A stale lease cannot advance any of those references. A coordinator restart reacquires the
admission epoch without re-pairing; a private app-server restart changes neither the host record nor
any per-chat mapping.

Internal identity preservation does not by itself prove official-client continuity. A generally
available connector must prove that the provider either re-adopts the same visible session/history row
in place or exposes an official successor/archive transition that the official client renders
faithfully. If a forced replacement creates an unexplained duplicate row, loses history, or changes
control behavior, continuity for that provider version remains unsupported and the user sees an
explicit recovery state rather than a false claim that the official experience survived unchanged.

Native execution may precede provider replication, but the causal outbox never publishes
assistant/tool/result output ahead of that command's provider-native user representation. A fast
unmatched provider echo waits for its persisted mapping or fails closed; it never becomes a new
command by text matching.

<a id="101-wrapper-owned-local-ui"></a>

### 10.1 Native TUI attachment

The initial tuple uses one real native TUI attached to the selected Claude Code, Codex, or OpenCode
session. Its actions go directly through the product's native client/server path, not through the
remote-claw coordinator. The native harness arbitrates them against the one remote-claw collaborator
connection. Draft editing and rendering stay native.

The bridge observes native user actions, responses, tool activity, permissions, and controls when the
product protocol or durable store exposes them, then correlates and projects those facts outward.
remote-claw does not claim a pre-execution local source decision or a device-local render receipt.
Additional native TUI clients are excluded until the pinned product's multiplicity, routing,
multi-client semantics, and source attribution are proven.

### 10.2 remote-claw web

```text
web input
  ↓
command proposal
  ↓
coordinator
  ↓
one inward edge

native observation
  ↓
normalized message
  ↓
sealed web frame
```

The existing broker remains a zero-knowledge ciphertext transport. Current frame kinds remain as a
compatibility view while the coordinator gains explicit receipt/forwarding/native-delivery states.

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
events. A native-observed TUI action or a proposal forwarded from web, ChatGPT, automation, or a nested
server may be published once through the app-side API so provider history can read back its official
user representation. An Anthropic-origin user item is not posted back to its own source binding;
native assistant/tool/result output still projects to that source through its causal outbox. Actual
device rendering is not presumed. Returning user/output echoes update their persisted
correlation/outbox item and never become another proposal or viewer message.

The existing `AnthropicRcClient` covers app-side list/history/SSE/text submission. Worker registration,
bridge credentials, heartbeat, delivery ACK, worker SSE, connector-owned login/refresh/rotation/
revocation, archive, reconnect, and uploads are still missing. The existing transport can reread a
credential rotated by another owner and retry once after 401; it is not the required credential owner.

Recovery first reconnects the existing outward Anthropic session. If that session is unusable,
remote-claw may create a replacement within provider/policy limits, record it as a new outside-binding
incarnation under the same `logicalChatId`, and rebuild only the official projection through the
durable causal outbox. This preserves internal identity but may not be advertised as official-session
continuity until the provider's in-place adoption or official successor behavior passes the client
parity gate. It does not replay provider history into the inner engine, reset the server's proposal
order, or create another remote-claw chat.

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

Official documentation and the pinned
[Codex multi-client/source proof](codex-app-server-multiclient-proof.md) establish the normal native
shape for `0.146.0`.
`codex remote-control start` starts the managed app-server daemon with Remote Control enabled, while a
plain compatible TUI probes and joins its default Unix socket. In the daemon, the local socket
acceptor and official Remote Control acceptor feed the same `TransportEvent` channel, connection map,
`MessageProcessor`, and thread store. Each official client stream becomes another initialized
`ConnectionId`.

```text
one real app-server
├─ local TUI connection
└─ official Remote streams
      ⇅ OpenAI Remote
   official clients
```

That direct sibling topology is the fidelity oracle, not the selected remote-claw topology. Enabling
it unchanged would let official clients mutate the native thread outside the remote-claw coordinator
and would give the inner daemon an OpenAI socket. Both violate this design.

The selected topology moves provider-facing transport/enrollment outside, keeps official stream state
there, and adds a management-only service while preserving the sole processor's native routing:

```text
private real app-server
├─ trusted direct TUI connections
└─ one native remote-claw bridge
       └─ managed top-level chat bindings
       ⇅
   coordinator
       ⇅
   outward RC gateway
       └─ official-stream state
       ⇅ OpenAI Remote
   official clients
```

The inner daemon starts only its private local transport; its built-in outward Remote Control
connection is disabled. One `RemoteControlService` is injected at the app-server runtime level: the
sole real `MessageProcessor` uses it for native `remoteControl/*` management requests, and the
surrounding startup/status loop uses it for persisted enablement and status notifications. The
service delegates over authenticated local IPC to the outward gateway. The gateway's current
`ChatGptRemoteHostConnectorLease` owns the OpenAI socket, credentials, installation/host identity,
pairing state, reconnect cursors, and official client streams. It alone may advance the durable,
host-scoped transport-state version that references the encrypted credentials, enrollment, pairing,
cursor, stream, and chunk/ACK state. A local TUI may therefore use native pairing, status, and
client-management methods without giving the inner daemon a provider socket. This injected service is
the management plane only; it does not preserve the connection-scoped state of official data streams.

The gateway is necessarily protocol-aware. It may reuse or extract the pinned
`app-server-transport` network, enrollment, envelope, chunk, and ACK semantics, but the
`TransportEvent` seam alone does not collapse several official streams into one native connection.
The gateway terminates provider enrollment, envelopes, sequence, chunks, ACK, reconnect, initialize
state, request-ID domains, capabilities, notification preferences, per-stream subscriptions,
server-request correlation, backpressure, and lifecycle. After coordinator admission it remaps one
semantic native mutation or server-request response onto the sole native bridge. Stream-local
initialize, resume, unsubscribe, close, and reconnect do not blindly become one native request each.
The gateway updates only that stream, computes the union of current host/collaborator demand for the
managed top-level chat, and emits zero or one fenced native resume/unsubscribe transition. Closing A
cannot unsubscribe the bridge while B or another remote-claw collaborator still requires that chat;
only loss of the last aggregate demand may release it. A bridge-wide allocator maps concurrently
reused official request IDs into that one connection's ID domain and retains response/error tombstones
across reconnect. The gateway also namespaces source-owned process/watch handles and performs exact
cleanup when an official stream closes. The private app-server retains its pinned
subscription and routing behavior for all trusted direct TUI connections plus the one bridge; the
gateway does not alter it. If pinned behavior still depends on the originating client's profile or
resource lifetime, the admitted request may carry only a versioned compatibility profile or
source-lease key; neither creates a native connection or independent writer. The gateway never
instantiates another native `MessageProcessor`, thread store, model runtime, or daemon and never
decides native thread truth.

Each official stream is an outside collaborator binding under the one host record. Every semantic
client→native message capable of changing native or host state crosses the coordinator, including a
request or notification and a JSON-RPC response or error that can resolve an approval, question, or
other server request. The gateway sends only the admitted mutation or response through the bridge.
Stream-local lifecycle/subscription state is a gateway mutation; after admission it may cause zero or
one aggregate native subscription transition as above. Only method families proved read-only may use
a query path that bypasses mutation admission, and they still retain exact per-stream correlation and
authorization; an unclassified message fails closed. Native notifications and server requests fan
outward through durable, per-stream causal outboxes and correlation state.

This gateway is the one required official-transport adapter, not a fallback implementation of Codex.
The pinned source proves the reusable transport pieces and direct native topology, but it does not
prove coordinator-routed stream mapping through one collaborator, management injection, full native
multi-thread routing parity, source-owned-handle cleanup, or any narrow compatibility/lease context. Live official
clients must pass the differential parity suite before that topology is supported. The direct daemon
path and remote-claw path must show the same host, projects, chats, Remote management results, request
routing, history, streaming, gates, reconnect, and errors.

The private Codex app-server is never exposed off-box. The pinned daemon broadcasts some
server-initiated requests to its subscribed connection set; the first response or error consumes the
global request ID without checking its connection, and result validation may occur afterward. The
target preserves the visible TUI-versus-bridge race: remote-claw admits at most one of its ordered
remote answers onto the bridge, the real app-server arbitrates its arrival against a direct TUI answer,
and native gate outcome plus the global request tombstone classify later answers as stale. The private
socket physically admits only trusted direct-TUI sockets and one daemon-wide bridge socket because
a response is not cryptographically bound to the connection that received the request in this pinned
build. Logically, the sole processor also sees exactly those native TUI connections and the one
remote-claw bridge connection, with the pinned app-server deciding their thread subscriptions.
Official streams remain outside collaborators; the gateway correlates and fans the bridge copy
outward, while the coordinator admits at most one response back through the bridge. Differential tests
must prove the exact native connection set and routing for each thread origin and lifecycle.

Restarting private Codex or the local coordinator preserves the outward paired-host enrollment.
If OpenAI forces a new outward connection/chat namespace, remote-claw supersedes that outside
incarnation under the existing host/project/`logicalChatId` mapping and repairs its projection through
the durable outbox; it never duplicates native execution to make the official view catch up.

### 10.5 Nested remote-claw collaborator

One remote-claw server may bind another server's chat as a single collaborator. The outer server keeps
its own stable chat ID and direct-collaborator journal; the inward server gives that entire subtree one
binding and source namespace. The edge maps those distinct identities explicitly.

Every inward proposal carries immutable origin and traversed-edge lineage. Every native observation
travels outward on a separately typed path and may return over those same physical edges in reverse.
A server drops a proposal that already traversed it or an inward edge, drops an observation that
already traversed the same outward edge, and never promotes an outward observation or echo into an
inward proposal. These rules make recursive composition possible without suppressing replies or
creating feedback loops.

## 11. Core workflows

### 11.1 Host start and stop

Cold start proceeds from the inside out:

1. Start the independently supervised runtime owner and reopen its local native-runtime registry,
   including the local conversation-transition and inference logs.
2. Start the private provider-shaped façades, inference connector, native-client endpoint, local
   Remote-management endpoint, official-stream mapping/cleanup path, native subscription/routing
   observation, and network policy before any inner process. The outward provider connection remains
   non-writable until its host connector lease and coordinator epoch are current.
3. Start or adopt each native runtime, restore the real local TUI path, and establish native
   observation. This local path does not require a collaboration coordinator.
4. Attempt to open the collaboration control journal, acquire one coordinator epoch, and fence stale
   remote writers. If that fails, keep the local TUI, façade, inference, and native state available,
   but advertise remote collaboration as unavailable and accept no remote-claw mutation.
5. After the coordinator is available, import the local native-transition log atomically with its
   exact chat/binding mappings and cursor, rebuild only proven projections, and reconcile undecided
   remote commands, in-flight attempts, ingress cursors, gates, and causal outboxes.
6. Reacquire the ChatGPT host connector lease, load its exact current host transport-state version,
   and reconnect outward Remote/web/nested-server collaborator bindings under the new epoch without
   re-pairing the host. Only that newly current fenced lease may append the next state version.
7. Mark each inward target ready—another exact server/chat edge, or the terminal native binding—and
   open this server's inward edge only when its next remote proposal is safe to offer.

Graceful stop reverses the ownership boundary: stop forwarding and fence inward writes, drain or mark
every in-flight leg, commit cursors/gaps, detach collaborator connectors, then either leave the
warden-owned native runtime and TUI relationship alive or terminate it according to explicit policy.
A crash skips those steps, so restart uses §8 rather than assuming shutdown completed.

<a id="112-local-or-web-text"></a>

### 11.2 Native-TUI and web text

**Native TUI**

1. The person submits through the product's normal TUI/native-server path.
2. The native harness decides whether and when the action applies, including its interleaving with the
   one remote-claw collaborator.
3. The bridge observes the native user action and stable native order when the protocol/store exposes
   them.
4. Correlation first checks whether the observation is an echo of an existing remote proposal. If not,
   record it as a direct native observation; never create an inward proposal for it.
5. Enqueue its ordered outward projections for remote collaborators without reflecting it inward.

**Web**

1. Authenticate the web source, assign its stable source ID, and deduplicate it.
2. Commit this server's proposal order and forward/queue/reject decision atomically.
3. If rejected, project status only. If queued, leave it in this server's `command_seq`.
4. Before forwarding, write ahead one fenced inward attempt. A nested edge repeats the same process at
   the next server; the innermost edge offers the proposal to the native harness.
5. Record native acceptance only from positive native evidence. Correlate every native/provider echo
   to the existing proposal rather than executing again.
6. Each native observation mapping atomically enqueues its native-ordered copies to enabled
   collaborator bindings.

An outward Remote-provider outage delays only that official view; it does not become the decision
maker. A model-inference backend outage is different: the native turn may be unable to finish, though
the server's source/forwarding journal remains intact. Each outward binding has a causal outbox: a
proposal's official user representation must be accepted before assistant/tool/result projections
caused by its native result can overtake it. An outage queues that entire official projection without
blocking native execution.

### 11.3 Official-client text

1. The provider receives the official client's command.
2. The provider's host/worker transport delivers it to remote-claw.
3. Run the cross-incarnation source-record/correlation guard and atomically commit the provider
   observation plus one terminal classification. The proven-new branch inserts its canonical source
   identity and `command.proposed`; replay links the prior canonical record; collision/ambiguous links a
   recovery gap and creates no command.
4. Preserve the official command's native intent (`start`, `steer`, `interrupt`, permission answer,
   question answer, or another typed control). For a binding advertised writable, forward it
   immediately whenever the native protocol normally would. Queue or reject it only when the official
   protocol can render that exact state faithfully; otherwise withdraw writability or return the
   protocol's native busy/error result before accepting the item.
5. ACK provider ingress at the point proven safe for that protocol, after the required durable
   decision for new input or durable prior-command link for a replay. This ACK means host receipt only
   and need not wait for native execution; collision/ambiguous input advances no semantic ACK or cursor.
6. Offer only a forwarded proposal over the one inward collaborator edge. Never downgrade a steer into
   a later turn or hide a server-side queue behind an already displayed official user item. The native
   harness remains free to apply its normal accept, queue, busy, or reject semantics.
7. Project server forwarding and native-delivery status to remote-claw web. The native TUI continues
   to render native session state directly. For a forwarded proposal, publish its user representation
   to enabled non-source provider bindings; the existing source-provider user item is never reposted
   to itself.
8. Project later native assistant/tool/result observations to every enabled binding, including the
   originating official binding, through each binding's causal outbox.

A JSON-RPC response or error from an official client that can resolve a native server request follows
the same ingress, deduplication, decision, and write-ahead path as a mutating request. The outward
gateway never forwards such a response directly to the bridge merely because it is syntactically a
response rather than a request.

An official UI may display its locally submitted command before remote-claw sees it. That transport
may be advertised writable only if remote-claw can preserve the provider's normal visible outcome from
that point. A remote-claw-only status is useful diagnostics but is never a substitute for official
client parity; if the provider cannot represent a necessary queue/rejection state, that policy is not
supported on the official binding.

<a id="114-two-writers"></a>

### 11.4 Concurrent writers

- Web, official-client, automation, and nested-server proposals compete for this server's next
  `command_seq`.
- The native harness separately arbitrates its one direct TUI participant against its one remote-claw
  collaborator; native order is the applied order.
- One native turn runs at a time per logical chat unless the native API proves a different safe
  primitive.
- Each proposal retains its typed start/steer/control intent. It is offered promptly when that is what
  the native single-collaborator protocol would do; steering is never inferred from arrival timing or
  silently converted into a queued next turn.
- Server-side queueing is only for contention among direct collaborators that the one inward channel
  cannot represent immediately, and only connectors able to render that queued state may accept such a
  proposal. The native TUI's own busy/steer behavior remains whatever the native product specifies.
- Provider, nested-server, and native echoes do not execute again.

## 12. Security boundary

These are release requirements for the selected runtime, not claims about current `--rc-app`,
OpenCode, or tmux isolation:

- Inner Claude, Codex, and OpenCode process trees have no real remote-provider credentials.
- Inner provider-shaped traffic terminates locally; remote-claw opens separately isolated inference
  and official-Remote TLS connections.
- The inner process identity cannot read outward connector state or sockets.
- Network policy prevents direct provider fallback.
- Each direct collaborator and inward collaboration edge has separate authentication, capability
  verification, source namespace, connection epoch, and authenticated server identity. Every receiver
  verifies the prior signed hop chain and appends its own hop. A nested server can lie about an event it
  originates, but removing or changing an already-attested inner hop is detectable.
- Current inward edges form an acyclic tree installed only from a rooted target through a
  generation-fenced two-party reservation. Direction-typed lineage is checked before processing; an
  outward observation cannot be accepted as an inward proposal.
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

### A1 — Runtime ownership, control journal, and remote-proposal actor

- Add durable `logical_chat`, `native_binding`, native-incarnation, runtime-local
  native-conversation/transition/mapping, private-transport-attachment and attachment-lease,
  runtime-scoped inference-attempt/chunk-outbox/correlation, outside-binding,
  ChatGPT-Remote-host/connector-lease/transport-state/chat-mapping, outside-capability-snapshot,
  outside-capability-verification, and connection-epoch records, plus inward-collaboration-edge,
  rooted-topology-certificate/reservation, signed event-lineage, server-identity-key, source-event
  namespace/transition/observation, canonical source-event, and cross-incarnation correlation records.
  Never alias one server's `logicalChatId` to another server's chat, the A0 `rcb_*`, Claude `cse_*`,
  Codex/OpenCode ID, broker channel, or provider ID.
- Route web presence, broker channel/key derivation, and normalized command/chat sequences by the
  stable `logicalChatId`; a transport replacement must update one visible row rather than create
  another.
- Add an epoch-fenced runtime owner/warden and local native-transition registry that keep the native
  client endpoint, provider façade, inference connector, and real TUI usable across coordinator
  unavailability without changing native semantic authority. Import exact transitions into
  server-scoped bindings atomically; leave ambiguity locally usable but remotely unbound.
- Add the explicit forward-incarnation transition with required terminal/cancellation or process
  containment evidence; never overload A0 `bindNative` for replacement.
- Add `starting`/`recovering`/`ready`/`draining` lifecycle gates and explicit detach-versus-terminate
  shutdown.
- Persist text command receipt, order, decision, native/outside delivery, binding, and recovery gap.
- Make receipt, server forwarding, inward delivery, native acceptance, and observation distinct.
- Bootstrap the terminal native root atomically, then enforce one inward edge per `(server, chat)` with
  rooted path certificates, two-party generation-fenced reservations, non-writable installed receipts,
  a separate mutual live-writability handshake, split-commit recovery, and containment before
  reparenting.
- Bind versioned event-envelope digests and every server/chat/edge/direction hop into an authenticated
  lineage chain; implement server-key enrollment, rotation, historical verification, and revocation,
  plus the no-reflection rule before nested bindings become writable.
- Write ahead every native/outward attempt, atomically enqueue causal outbox items, and quarantine a
  chat behind unresolved native delivery.
- Write ahead every runtime-scoped inference request and encrypted response chunk separately from
  native delivery; recover one response stream without requiring a coordinator/chat binding and forbid
  silent retry after ambiguous upstream receipt.
- Persist/replay the encrypted-ingress cursor instead of treating a sampled `frameCount` as the next
  command boundary; advance only a contiguous committed high-water mark.
- Gate: crash every transaction/delivery boundary without silent loss or automatic duplicate execution.

### A2 — OpenCode vertical slice

- Persist a stable binding from `logicalChatId` to the native OpenCode `ses_*`; do not use `ses_*` as
  the remote-claw chat or broker ID.
- Keep one real OpenCode TUI path and one epoch-fenced remote-claw adapter lease on the same `ses_*`;
  enforce the lease at the private HTTP endpoint because SSE/HTTP exposes no persistent writer
  identity, reject concurrent old/new wrappers, preserve direct OpenCode semantics, and let OpenCode
  arbitrate their interleaving.
- Make takeover a barrier: reject new old-epoch arrivals, keep the replacement non-writable, and settle
  or quarantine every request already admitted under the old lease before activating the new one.
- Fail closed on session discovery errors and never adopt “most recent.” Reattach an existing binding
  or quarantine it if its exact native session/lineage is absent. Record exact first import, including a
  native-TUI-created session, as an identity transition. Permit automatic creation only with explicit
  first-bootstrap intent, no existing binding, and a positive empty snapshot; permit explicit **New
  chat** as a separately typed operation even when sessions exist. Use a two-phase
  reservation/write-ahead attempt with a unique namespaced metadata marker and typed intent; reconcile
  zero, one, or multiple exact marker matches without retry, and prove marker durability across server
  restart.
- Feed history/live events into normalized text observations.
- Establish and actively drain SSE into a bounded durable buffer before history snapshot; make
  overflow, stream loss, snapshot failure, and pre-merge crash explicit non-writable recovery gaps.
- Compare legacy `/event` with v2 `/api/event`, pin event-ID/sequence scope and reset behavior, merge a
  native status snapshot before readiness, and classify orphaned incomplete messages across a real
  server kill/restart.
- Route web text through the command actor with a write-ahead caller-supplied native `msg_*`, treat
  `204` as transport receipt only, advance native acceptance/order solely from exact correlated
  OpenCode evidence, and never retry the non-idempotent same ID blindly.
- Record abort/compact native outcomes separately from source attribution; if the pinned API exposes no
  durable causal seam for a TUI/adapter race, preserve source and the remote proposal as unknown.
- Treat direct TUI actions as native observations, never as server-forwarded proposals or echoes to
  execute again.
- Parse and correlate permission reply results, runtime-prove whether `permission.replied` is terminal,
  and resolve TUI/remote races only from a proved native gate record. Prove inherited child policy
  before advertising structured permissions, otherwise mark child tools unsupported.
- Route all OpenCode model-provider traffic through private local façades and prove the network fence.
- Reconcile the persisted coordinator journal with OpenCode history and rebuild its projection.
- Treat ambiguous HTTP 204 delivery as `outcome_unknown` rather than retrying.

### B — Claude Code wrapped client

- Keep the current synthetic RC seam as a migration adapter.
- Keep one real Claude Code TUI and one remote-claw private RC collaborator on the same session, and
  prove behavior matches normal Claude Code keyboard-plus-Remote use.
- Retain sanitized version-, binary-, schema-, and probe-hashed native fixtures for worker ACK,
  reconnect, RC/transcript/provider correlation, TUI races, permissions/questions, controls,
  resume/re-bridge, and detach/takeover; do not promote ad-hoc captures or env-gated live tests into a
  compatibility claim.
- Terminate all inner Anthropic-origin calls.
- Separate the private inference connector from the outward Anthropic Remote connector.
- Add native transcript/resume recovery that first restores the known Claude UUID plus private
  `cse_*`, then treats a proven replacement `cse_*` only as a transport generation under the same
  `logicalChatId`.
- Persist the private RC event/worker/delivery state needed to accept a known-`cse_*` re-bridge without
  expecting worker history backfill.
- Keep worker delivery receipt distinct from native acceptance and observation. Prove the stable join
  among private-RC command UUID, worker echo/ACK, transcript row/UUID, provider exchange, and resulting
  native turn before claiming order or source; quarantine lost-ACK ambiguity rather than replaying.
- Keep remote permission/question choice, private-RC answer delivery, and native terminal gate outcome
  distinct. Close outward gates only from proved native cancel/tool/gate evidence and race every TUI,
  remote, interrupt, and disconnect ordering.
- Make private-RC takeover a barrier over old admitted deliveries, gates, and inference attempts.
  Outside collaborator/connector loss leaves the child, TUI, private RC, local inference, and native
  turn alive; explicit runtime shutdown separately selects keep/recover or terminate.
- Add real outward Anthropic worker/session support.
- Add controls, permissions, questions, and uploads one proven family at a time.

### C — Codex wrapped client

- Retain the pinned `0.146.0` source, checked two-raw-client probe, checked
  real-TUI-plus-raw-client fixture, and checked three-connection/two-top-level-thread fixture as the
  initial one-daemon baseline. Repeat all three fixtures for every supported compatibility tuple and
  keep their exact probe, binary, and generated-schema hashes.
- Start one managed private app-server daemon with its local Unix socket enabled and built-in outward
  Remote Control socket disabled; route every model/API call to the isolated local OpenAI façade and
  inject one outward-gateway-backed `RemoteControlService` at the app-server runtime level for both
  the sole `MessageProcessor` management path and the surrounding startup/status loop. Treat that
  service as management only.
- Begin with one real Codex TUI connection and one daemon-wide remote-claw bridge connection whose
  logical bindings/subscriptions cover the host's managed top-level chat threads. Classify
  `thread_source` and parent lineage before binding; keep child IDs as nested native evidence unless a
  retained fixture proves they are separate user-visible chats. Add more trusted
  direct TUI connections only after their pinned native multiplicity and routing pass the same suite.
  Preserve and prove the app-server's own top-level, child-thread, resume, unsubscribe, broadcast,
  server-request, and TUI-routing behavior for every trusted direct TUI plus that bridge. Prove the
  local front door is behaviorally equivalent to a direct app-server connection and Codex remains the
  final request arbiter. Do not forward a bridge write until that bridge proves its native
  subscription; specifically keep late-join or restart recovery before the first rollout non-writable
  at the coordinator.
- Add a host-scoped Codex adapter that discovers many threads.
- Keep the private inference gateway distinct from the client-facing app-server front door and outward
  ChatGPT Remote transport.
- Add the durable host-scoped ChatGPT Remote enrollment, fenced connector lease, versioned
  credential/pairing/cursor/chunk-ACK/stream state references, and per-chat project/chat mappings that
  survive private app-server and coordinator restart without re-pairing.
- Reuse or extract the pinned `app-server-transport` network/enrollment components as an isolated,
  protocol-aware outward gateway. Preserve one paired host, terminate each official stream's
  complete provider and app-server-facing stream state outside the daemon, and route every semantic
  native mutation, notification, response, or error through the coordinator and exactly one native
  bridge. Keep initialization/lifecycle/subscriptions per stream, reconcile the union of current
  host/collaborator demand into zero or one fenced native subscription transition, and prove
  overlapping subscriptions, first join, non-final leave, last aggregate leaver, reconnect, and
  cleanup. Use a bridge-wide collision-safe request-ID allocator/map, namespace source-owned handles,
  retain response/error tombstones, filter notifications, and perform explicit per-stream cleanup
  outside. Add only compatibility-profile or source-lease metadata that
  differential proof requires on an admitted bridge request; it cannot create a native connection,
  subscription, or authority. Do not instantiate a second app-server `MessageProcessor` or thread
  store, and do not claim that `TransportEvent` reuse alone supplies this mapping.
- Prove the injected native `remoteControl/*` management and status-notification families against the
  direct daemon, and retain the exact generated schema plus request/response/notification evidence.
- Prove global server-request ID/first-response-or-error consumption, stale response suppression,
  active-turn `turn/start` correlation, and explicit unsupported handling for external-clock mode.
- Add exact Remote reconnect/ACK/cursor recovery or a proven fresh-stream repair boundary.

### D — tmux recovery and unified product

- Add persistent pane ownership and honest recovery state.
- Compose tmux with the wrapped engine's provider façade. Treat person and injector as writers to one
  editor keystream, not native peer collaborators; require a proved quiescent/exclusive injection
  boundary or advertise simultaneous keyboard-plus-remote fidelity as unsupported.
- Write ahead source, attempt, pane/process identity, transcript cursor, and intended payload before
  paste. Treat any post-dispatch paste/Enter error as ambiguous, never blindly retry it, and upgrade
  tmux receipt to native acceptance only through a stable Claude transcript UUID/row.
- Add a durable local permission-answer seam and native terminal gate observation, or keep structured
  local/remote first-winner unsupported. A failed decision-file write cannot be ACKed as success.
- Add keep-pane detach/handoff for hook state, decision records, transcript cursors, and orphan gates;
  outside disconnect must not kill the pane or active turn.
- Map `/clear` to a new logical chat and `/branch` to explicit fork lineage; file rotation alone cannot
  preserve the old synthetic session identity.
- Expose host → project → chat discovery across native clients.
- Show native, official-provider, and web delivery state separately.

## 14. Proof gates

The following remain unproven until a test says otherwise:

- durable separation of server-scoped `logicalChatId`, native binding/conversation/incarnation, inward
  collaboration edge, nested-server chat mapping, private transport, broker channel, and outward
  provider IDs;
- runtime-local conversation/inference identity while the coordinator is absent, plus exact atomic
  import into a server-scoped chat without replay, reassignment, or old-chat proposal leakage;
- stable `logicalChatId`, `command_seq`, `chat_seq`, and one visible row across a known-transport
  re-bridge or a proven replacement private transport;
- exact native history completeness and stable IDs for every adapter;
- non-reusable runtime/incarnation identity and correct new-chat/reconnect/fork classification;
- subscribe/snapshot ordering without a lost-event gap;
- provider source-event namespace continuity, cross-incarnation replay classification, and
  collision-safe canonical records before command allocation;
- command-to-native correlation and idempotent retry;
- one direct native TUI and one remote-claw collaborator coexisting on each Claude/Codex/OpenCode
  session, with the native harness as final acceptance and mutation arbiter; for Codex, pinned source
  shows that the TUI uses the same remote app-server client, the checked raw-client probe proves the
  basic seam, and the retained real-TUI-plus-peer fixture proves the selected model-free
  shell-command path, while the retained three-connection fixture proves the selected top-level
  two-thread/one-observer path; real-TUI multiplicity, child threads, every other method family, and
  complete parity remain gated; OpenCode's current “local prompt” live case uses a second API client,
  not its real TUI, so a pinned real-TUI-plus-adapter PTY fixture remains open;
- behavioral equivalence between each native app using the remote-claw-controlled local service and
  using its normal native server, including notifications, busy/steer, controls, permissions, questions,
  and reconnect;
- multiple direct collaborators collapsed into one inward collaborator, plus recursively nested
  remote-claw servers, without cycles, reflection, or duplicate native execution;
- installed-but-non-writable nested edges and the mutual live handshake at every split finalization;
- complete provider-route termination and process-tree network isolation for every inner engine;
- busy turn, steer, interrupt, approval, and question semantics;
- live process reattachment versus lossy native resume;
- Claude worker renewal, reconnect cursors, archive, upload, and official rendering;
- exclusive Codex bridge takeover while the app-server survives, including native `ConnectionClosed`
  handling and subscription cleanup for the old socket before replacement initialization, stale
  write/response rejection, thread rebinding, and exactly one live bridge `ConnectionId`;
- Codex project grouping, one durable host-scoped ChatGPT enrollment/connector lease and versioned
  credential/pairing/cursor/chunk-ACK/stream state, injected `RemoteControlService`, protocol-aware
  outward stream mapping through exactly one native collaborator, native multi-thread
  subscription/routing parity, request-ID/source-handle remapping and cleanup, proved narrow
  compatibility/source-lease metadata, upstream attestation,
  coordinator-routed official-stream parity for state-changing requests/notifications/responses/errors,
  sequence/chunk/ACK recovery, global server-request response/error races, pre-rollout late-join and recovery,
  active-turn `turn/start` correlation, and full app-server compatibility;
- OpenCode epoch-fenced single-adapter enforcement over stateless HTTP, exact session
  discovery/create ambiguity, actively drained SSE overlap and overflow/drop recovery, native
  adjudication of prompt/compact/interrupt actions, terminal permission reply correlation and
  TUI/remote races, atomically inherited child permission policy, and child-session recovery;
- tmux transcript completeness; response-loss after applied paste/Enter; local partial-draft collision;
  write-ahead origin versus transcript-UUID acceptance; permission local/remote ordering and
  decision-write failure; keep-pane detach/handoff; `/clear` new identity; `/branch` lineage; rotation;
  and orphaned permissions;
- provider-credential non-disclosure for wrapped Claude, Codex, and OpenCode;
- correlation of direct-TUI native observations without treating them as pre-forwarded remote proposals,
  reflecting them inward, or claiming an unobservable device-local render receipt.

Native-client fidelity is a differential release gate, not a prose aspiration:

1. Pin the exact native client and native server/harness versions. Official-client tests also pin the
   official client build, provider host/worker schema or captured protocol epoch, and device platform.
2. Run each scenario once with the native app connected by its normal direct path and once through the
   remote-claw-controlled local service. Capture the direct provider response stream and replay it
   through the test façade where possible so both paths receive the same inference. Run a separate live
   smoke test against the configured provider and compare protocol/state invariants rather than
   pretending nondeterministic natural-language bytes should match.
3. Record every client request, server response/request, notification, reconnect cursor, native
   conversation record, and observable TUI state. Timestamps may be normalized only when semantically
   irrelevant. Opaque IDs may be alpha-renamed only through a bijection that preserves allocation count,
   equality/alias relationships, scope, parentage, and continuity; an unexpected new ID fails.
4. Compare initialization, capability negotiation, discovery/resume, local Submit, remote Submit,
   idle/busy queueing, steering, interrupt, approvals, questions, attachments, model/mode changes,
   overload/errors, disconnect, and reconnect. For Codex, also compare native Remote enable/disable,
   status, pairing, client management, and status notifications through the injected service.
5. Create and use a conversation on the direct path, disconnect the client, then point that same client
   through remote-claw at the same private native state and require the same visible identity, complete
   ordered history, pending gates, and lifecycle state. Repeat in reverse where supported. For Claude,
   exercise the analogous verified resume UUID and private-RC reattachment.
6. Treat every unexplained behavioral difference as a compatibility failure. A narrower supported
   surface must fail closed and advertise the missing capability rather than silently behave differently.
7. Race the real TUI against the one remote-claw collaborator and assert that the projection follows the
   native harness's observed order, even when it differs from this server's proposal order.
8. Run official mobile/web/desktop/editor workflows once against the normal provider host/worker and
   once through remote-claw. Compare discovery and row identity, complete history, live streaming,
   typing/steering, permissions/questions, controls, notifications, disconnect, and reconnect. Include
   official-client responses and errors that resolve native server requests, plus host pairing and
   status-management flows. Use black-box client automation or recorded UI state where available; do
   not infer an unobserved device render from provider receipt.
9. Crash and restart the native-client-facing boundary independently: the Codex/OpenCode front door
   while the private server/thread survives, and the Claude private API/RC façade while Claude survives.
   Classify in-flight requests, preserve the same conversation/history/subscriptions as native reconnect
   permits, and create no silent new thread, UUID, or visible chat. A coordinator-only restart must not
   drop the separately supervised local client endpoint.
10. Repeat with two nested remote-claw servers and assert one native execution, exactly one outward
   return traversal per edge, no same-direction reflection, no observation-to-proposal promotion, and
   stable origin lineage through disconnect/reconnect. Delete/reorder a hop, substitute a payload under
   an intact chain, rotate a server key, and revoke it; require tamper rejection, old-record
   verification, and rejection of new hops under the revoked key.
11. Race reciprocal nested-edge installation and mutate the target topology during installation.
    Crash each side after prepare, commit-intent, installed receipt, and local-current selection.
    Require at most one rooted installed edge, generation-certificate rejection for the stale attempt,
    and no delivery until both installed receipts and the mutual current-generation live handshake
    succeed.
12. Cold-start with the collaboration journal/coordinator unavailable. Create and use a new local
    conversation through the direct TUI while the native endpoint, provider façade, and runtime-scoped
    inference connector remain usable and every remote-claw mutation is rejected as unavailable. Then
    recover the coordinator, atomically import the local transition log, map the correct logical chat
    and lineage, and prove that neither an inference attempt nor an old-chat queued proposal is moved
    to the new conversation.
13. Crash the inference connector before send, after possible upstream receipt, during streaming, and
    after completion. Require one write-ahead attempt and one native response stream; retry only with
    proven upstream idempotency/read-back, otherwise surface the pinned native error/retry behavior.

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
  load the exact current host transport-state version, reacquire the host-scoped connector lease
  without re-pairing, let only that fenced lease append the next state version, revalidate the current
  durable capability snapshot, and rotate only connection credentials/epoch unless the provider
  forces a separately recorded outside-binding incarnation;
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
- a direct TUI action while every remote-claw server is disconnected: recover it from native evidence,
  project it outward once after reconnect, and never turn it into an inward proposal; here
  “disconnected” means collaboration coordinators/edges are unavailable while the separately supervised
  local API façade and inference connector remain alive—total façade loss preserves state for recovery
  but cannot promise new model-backed work during the outage;
- direct-TUI new/clear, fork, archive/unarchive, and thread-switch while collaboration is offline:
  require the runtime-local transition record before the native transition is relied on, then import
  from the committed cursor and atomically retain or create the correct server-scoped logical chat,
  binding, and lineage; never silently repoint the old binding, reassign an inference attempt, or let
  an old-chat queued proposal target the new conversation;
- Codex/OpenCode client-front-door restart with the private server and thread still alive: reconnect the
  same native client to the same thread, reconcile any in-flight request under native protocol rules,
  and preserve history, subscriptions, gates, and identity;
- Codex bridge crash while the private app-server and direct TUI connections remain alive: require the
  old bridge socket to produce native `ConnectionClosed` handling and subscription cleanup before a
  replacement initializes—external containment counts only when it provably causes that close—then
  prove that stale old writes and responses/errors cannot mutate state or consume a global
  server-request ID, rebind every managed top-level chat binding and any child subscription required
  by pinned routing under a new fenced bridge incarnation, and preserve the native cardinality of
  trusted direct TUI connections plus exactly one bridge `ConnectionId`;
- Claude private API/RC façade loss with the Claude process still alive: restore the exact attachment
  when proved or perform controlled resume of the same UUID, never silently minting another conversation;
- collaboration-coordinator-only restart: the supervised native client endpoint, native harness, local
  API façade, and inference lease remain available, while only new remote-claw proposals wait for the
  coordinator epoch to recover;
- nested-server edge loss and reconnect at each depth: preserve distinct server/chat IDs and origin
  lineage, replace only the failed live edge incarnation, keep the installed edge non-writable until
  both installed receipts and current generations are mutually verified on the fresh connection, and
  execute no projection or replay inward;
- concurrent reciprocal nested binds and a target topology change during bind: accept only a
  generation-current rooted path, leave partial reservations non-writable, and commit no cycle;
- inference-connector crash/restart at every write-ahead and streaming boundary: preserve one attempt
  and one native response stream, with no invisible retry after an ambiguous provider request;
- crash points before/after binding commit, native `delivery.started`, native observation, projection,
  outward publish, and provider ingress ACK, with quarantine for every unprovable delivery.

Capabilities are advertised only after their proof gate passes.

## 15. Evidence baseline

This design is grounded in:

- the current `Session`, `HostRcRelay`, Claude MITM, OpenCode, and tmux implementations;
- the current OpenCode history/SSE attach and reconnect behavior;
- the captured Claude worker/app protocol in [Phase 0 Findings](phase0-findings.md);
- the implemented Anthropic app-side client;
- the official [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)
  keyboard-plus-Remote behavior;
- the official [ChatGPT Remote connections](https://learn.chatgpt.com/docs/remote-connections) and
  [Codex app-server](https://learn.chatgpt.com/docs/app-server) documentation; and
- the pinned [Codex app-server multi-client proof](codex-app-server-multiclient-proof.md) for
  `codex-cli 0.146.0` / source commit `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`.

No ChatGPT paired-transport fixture is currently tracked in this repository. The checked Codex
raw-client probe proves the basic two-client app-server seam for selected model-free commands, and the
checked real-TUI-plus-peer fixture proves that a real `codex resume --remote` TUI and a raw client can
issue and observe deeply equal selected model-free shell-command projections in both directions on one
native thread. The checked three-raw-connection fixture additionally proves that two distinct
top-level creators own the native subscriptions while non-owners remain `notSubscribed` and lack the
selected correlated detailed events until one host observer explicitly resumes both and then observes
both selected command paths. All use the experimental loopback WebSocket transport. Phase C
must still prove the production Unix front door, all other method families and model turns,
races/reconnect/backpressure and crash behavior, real-TUI multiplicity, core child-thread
routing/identity and outward presentation,
server requests and external-clock behavior, provider isolation, the management-only injected service,
official-stream request/handle mapping and cleanup through exactly one bridge, any proved narrow
compatibility/source-lease context, the outward gateway, official pairing and a live official client,
and exact schema retention before advertising the complete compatibility tuple.

The architecture deliberately keeps provider-specific unknowns as proof gates rather than hiding
them behind a generic “client” claim.
