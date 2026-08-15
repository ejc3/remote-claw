# Client-driven host runtime: technical reference

> This is the exhaustive implementation reference for the
> [client-driven host runtime](client-driven-host-runtime.md). Start with the shorter architecture
> page unless you need record shapes, adapter contracts, recovery algorithms, or crash-boundary proof
> requirements.

**Status:** selected architecture; A1.0 through dormant A1.8a0 are
implemented. The ordinary production CLI supplies no registration adapter and invokes no A1 broker,
ingress-actor, command-adjudication, server-signer, or result-finalization operation, so every real driver and the viewer
remain on their A0 paths. A1.7a stops at durable `awaiting_order`; schema v9 supplies server-scoped
key custody/signing authority; and schema v10 now provides A1-ingress-only ready materialization,
global common-command order, a rejected decision, and replaceable signed result preparations.
A1.8a0's schema v11 now atomically closes only that signed rejected arm into a common result, signer
acceptance, logical ingress terminal overlay, exact semantic artifact, and one inert plaintext
`pending_seal` intent. It adds no admitted/effect arm, cursor movement, claim/seal/publish, broker
call, projection, production wiring, or capability advertisement. Full A1.8a and A1.8b remain planned.

**Current external behavior remains compatible:** today `--rc-app` hosts an in-memory `RelayCore`
that lazily creates one Claude-shaped `Session` per intercepted Claude RC session. A host-scoped
process-local registrar now gives each intercepted Claude session a distinct `rcb_*` lease, waits for
validated capabilities and `ready`, and only then starts its broker bridge. OpenCode and tmux also
register one wrapper `Session` through that lifecycle after strict setup. Tmux gives each wrapper
invocation a private server/socket, so many independent invocations can coexist without sharing tmux
state. This is still process-local compatibility infrastructure: no current path persists a
logical-chat/native binding across an ordinary wrapper restart, and the current synthetic
compatibility `Session.id` is also used as the broker/web session key, so a restart can appear as
another row. Codex is not implemented. The selected A1 design below removes that ID alias and keeps
the remote-claw logical chat stable across proven native recovery.
[Protocol & Runtime](protocol.md) remains the as-built reference.

**A1.0 through dormant A1.8a0 have landed:** the shared canonical field writer and the
`packages/cli/src/host/state` ID, path, record, runtime, digest, protected-handle, dispatch, and
backend-capability contracts are implemented and tested. A1.1 adds the secure local SQLite kernel,
migration registry, synchronous high-level transaction boundary, and immutable protected-artifact
store described below. A1.2 adds schema v3 and its high-level repository for the default server/profile,
projects and selector generations, recovering logical chats, starting bindings and registration
intents, installing terminal inward edges, coordinator leases, and the bootstrap/control journal. It
also validates an existing supported v3 graph in a coherent read-only snapshot before writable open,
and validates a newly migrated graph before returning its handle. A1.3 adds schema v4 and its
runtime-owner repository, an independently supervised Linux daemon, authenticated local RPC,
service-lease takeover and unknown-commit reconciliation, wrapped Ed25519 key custody, and durable
runtime/incarnation, assignment, containment, local-conversation, binding-incarnation, attachment,
lease, gate, and signing state. Migration 4 has 141 ordered statements and digest
`zx52EtAFNY9hEZneG3RW14zRCYR18gg7ysnltHbOkT0`; the complete v4 manifest has 231 rows: 30 tables,
57 indexes, and 144 triggers. A1.4 advances the database to schema v5. Migration 5
(`005-durable-native-registration`) has 38 ordered statements and digest
`l32ozsKKBm5ueLOk-_IeiasPgp_deE-tZHEbaZ6urOE`; the complete v5 manifest has 269 rows: 33 tables,
67 indexes, and 169 triggers. It adds canonical evidence verification, sequenced native-conversation
process leases, publications, and operations; exact replay and read-only unknown-commit
reconciliation; current-fenced close/reattach; and bounded duplex callable ports over the authenticated
owner RPC.

A1.5 adds pure Web-Platform A1 v2 address/token and broker-route derivation, chat and directional
server-control KDFs, strict kind/header/route validation, per-part AEAD, exact JSON frame codecs,
host-signature preimages, a transport-frame digest, and stable attempt/part/message digests. Its strict certificate
layer covers runtime-owner-signed native roots, server-scope certificate rotation, four onboarding-key
commitments and signed attestation, while `ViewerOnboardingBundleV2` supplies canonical `rcp2`
format/parse/checksum and cold-anchor or trusted-suffix verification without opening a broker route.
Schema v6 migration `006-terminal-native-root` has 36 ordered statements and digest
`li87zqB0yxSfRtN-p_xT5Yk2xAvX8Iy5a1xDXNTYYZo`; the complete manifest has 304 objects: 36 tables,
78 indexes, and 190 triggers. It adds an immutable per-runtime-owner-key legacy-signature activation
fence, two-stage terminal-root activation/renewal operations, retained native-root certificates, and
complete semantic validation. The repository reserves and persists the exact canonical payload under
current owner/coordinator and ready-registration authority. The service signs that payload, then
performs the ephemeral callable-port proof immediately before synchronous finalization. Only the
transaction-local terminal-root finalizer may store and accept an operation-attached v6 signature; it
samples the acceptance/commit timestamp, rechecks authority, verifies the Ed25519 signature, and
atomically commits the certificate/chat/edge transition. Public runtime-owner store, accept, and abort
operations reject those reservations, while legacy unattached v5 signature history remains inert and
compatible. The repository reconciles unknown commits and renews only from the latest retained root.
A1.4 recover, drain, close, and reattach now demote a rooted chat and edge while retaining certificate
history; registration must return to ready before a fresh-fenced renewal. The proof is neither stored
nor replayed by snapshot validation. Certificate expiry by itself does not mutate the persisted
chat/edge projection, so later effective route/dispatch admission must recheck expiry and the current
live attachment/process lease.

A1.6 adds the pure selected-backend capability, route/store, generation, manifest, publish,
collision, and one-generation/64-frame read-page contracts. The 8,000,000-byte ceiling applies to
the transmitted snake-case HTTP subscribe response and the client's raw response read, not to a
second camelCase semantic-DTO encoding in the pure module. Its capability vector is exact—not feature probing—and
commits to durable ciphertext, route-wide delivery-attempt uniqueness, broker-recomputed normalized
transport digests, original-cursor exact retries, generation manifests, and immutable collision
tombstones. The separate bearer-authenticated `/api/a1/*` surface accepts only the literal
`x-broker-backend: sqlite`, derives the machine identity from the bearer, recomputes the selected
scope-bus/server-control/chat token and `rcr_*` route ID, and pins the same capability digest on every
successful or error response. The SQLite/libSQL implementation uses an A1-only locator-backed catalog
and immutable random `rbsi_*` physical-store identity; it provisions open generation zero, preserves
route-wide attempt/part originals and first collisions across automatic 4,096-frame generation
rollover, and reads at most one generation and 64 frames in an encoded-size-bounded page. Exact retries
return their first cursor; changed normalized bytes retain collision evidence and consume no cursor.
Missing known stores latch `lost` and cannot be recreated silently. A0 backends and A0 retention do
not advertise, enumerate, or collect this state.

The browser-safe A1 client makes capability negotiation a prerequisite to route open, sends bounded
canonical frames only, validates route/store/capability/cursor/generation/digest invariants on every
response, and turns ambiguous fetch failure into an outcome-unknown error rather than an automatic
retry. Schema v7 migration `007-a1-broker-routes` has 22 ordered statements, digest
`uShlOvT_fWScwCLQD1g6-GAd1YyKR2QIlGjC0SPQWbw`, and a complete 326-object manifest: 39 tables, 85
indexes, and 202 triggers. It adds immutable backend-capability pins, broker routes, and broker-channel
generation records. Its coordinator-fenced repository accepts only a confirmed empty open generation-zero
receipt, atomically installs the exact protected capability artifact/pin/route/genesis tuple, rejects
changed replay, and reconciles an unknown local commit without requiring current authority for the
already-recorded historical tuple. A host-only split-commit installer accepts an already negotiated
client, opens the remote route before that local install, retries that exact open once only after an
outcome-unknown response, and resolves an unknown local commit only by close/reopen plus exact
reconciliation. If the local commit is proved absent, it returns a non-retry-safe error because the
remote route may already exist. These are dormant
transport receipts: no ordinary CLI path or runtime-owner operation invokes them, and they create no
ingress cursor, actor, command, native effect, checkpoint, server-scope signature, or viewer state.

A1.7a adds schema v8 migration `008-a1-durable-ingress`, the exact ingress record parsers, a
coordinator- and revision-fenced repository, and a dormant route actor. Every existing v7 route is
backfilled, and every subsequently installed route is auto-seeded, with its runtime head, observed
generation, independent fetch and semantic cursors, and unclaimed actor row. Every page that advances
fetch or changes retained generation evidence keeps exact page evidence plus a per-frame evidence
vector; an unchanged empty open live-tail poll creates no redundant artifact. Each first-seen physical position retains
its raw frame artifact before parsing or AEAD open. The repository then classifies immutable
positions, retains opened plaintext evidence and multipart attempts/candidates/parts/observations,
tracks exact retry separately from transport and semantic collision, expires incomplete candidates
into tombstones, retains late observations, latches bounded gaps, and advances a semantic cursor only
through the contiguous advanceable prefix. Explicit current-fenced recovery resolves auditable gaps.
A complete chat `user` or server-control `new_chat` proposal freezes its accepted candidate, canonical
message digest, and source-event fingerprint in `awaiting_order`; A1.7a allocates no common command,
command sequence, signed result, projection, outbox, dispatch, or native effect. The actor is
intentionally absent from package barrels and production run paths.

A1.7b0 adds schema v9 migration `009-server-scope-signer` as a direct-only server-signer prerequisite. It installs an initial self-anchored
server identity and scope certificate through a one-shot, `scope_certificate`-only bootstrap lease;
wraps the Ed25519 private key with AES-256-GCM under a distinct server custody domain; opens a normal
signing lease under the exact current coordinator lease ID/epoch and fencing token; and durably
reserves signer sequences, binds canonical payloads, signs, accepts, and reconciles exact prior work.
If coordinator authority changes before that bootstrap closes, reconciliation retains the exact
bootstrap as an immutable fail-stop with `writable:false` and
`nonWritableReason:"stale_bootstrap_fence"`; schema v9 cannot re-fence or replace it, and it cannot
allocate another reservation. Explicit repair is a later milestone. Once the initial certificate is
installed, coordinator takeover instead supersedes the normal current signing lease; after no
`reserved`, `bound`, or signed-but-unaccepted predecessor reservation remains, a successor may acquire
a fresh lease at the exact next fencing token.
The custody interface never returns PKCS#8. Its AAD binds the machine, collaboration server, protected
handle, identity key/generation, algorithm/backend, public key, and PKCS#8 digest so ciphertext cannot
be transplanted to another coordinate. This slice does not consume `awaiting_order` or create a
common command, command decision/result, generic host output, broker publish, result delivery,
checkpoint, outbox/effect, native attempt/dispatch, inference, projection, or production operation.
The v8 digest/count/manifest pins remain unchanged. Migration 9 has 81 statements, digest
`fYrN5atmwIj-tlT_tTXmrg9kNF52ah-zWmgf7vVFQWE`, and a 571-object manifest: 65 tables, 123 indexes,
and 383 triggers.

A1.7b1 adds schema v10 migration `010-common-command-adjudication` and direct-only pure-contract,
repository, semantic-validation, and signing-orchestration modules. Migration 10 has 50 ordered
statements, digest `rdJC_2C5IyjfsTuXhxjFSzT0bvDYtlpT8o0xDvu4IEk`, and an exact 619-object
manifest: 70 tables, 137 indexes, and 412 triggers. It adds only `command_ready_entries`,
`a1_ingress_adjudications`, `collaboration_commands`,
`collaboration_command_compound_signing_groups`, and
`collaboration_command_result_preparations`. The current source is only eligible A1 ingress; the
current policy is rejected-only. Ready entries and schema-v3 control entries consume one gap-free
`nextJournalOffset`; decisions globally choose `(readyAtJournalSeq, commandId)` and consume the dense
`nextCommandSeq`. Creation and decision keep distinct coordinator fences. The pure payload contract
allows scalar `user_text` through 48 MiB, while this rejected-only persistence path stores a small
`unsupported_recognized` envelope over the retained A1 source schema/digest/fingerprint instead of
copying plaintext. It derives one version-one result plus generation-specific signing group and
preparation, binds/signs through the current server lease, and can abort/reprepare reserved or bound
generations without changing the frozen command, order, decision, or result ID.

A1.7b1 deliberately ends with the current result preparation signed but unaccepted. The command
remains `decision_reserved`, the A1 sidecar remains `deciding`, and the group remains
`result_signed`. There is no final common result, signer acceptance, ingress terminal state, source
result/delivery outbox, attempt/effect, projection, or production operation in schema v10. A1.8a0
adds the rejected final-result/acceptance/terminal/intent writes atomically below; full A1.8a still
owns the admitted native attempt/front-door dispatch/effect arm. Neither slice advertises a partial
capability.

A1.8a0 adds schema v11 migration `011-a1-rejected-result-finalization` and direct-only result
contracts, repository finalization, secure-reopen validation, and crash-reconciling orchestration.
Migration 11 has 38 ordered statements, digest
`SkkuAFJed-7GT9XyXXPCub7VFauqNY6eu0u4IQJEInc`, and an exact 647-object manifest: 73 tables, 147
indexes, and 427 triggers. It adds only `collaboration_command_results`,
`a1_ingress_terminal_results`, and `a1_ingress_result_deliveries`. One fenced transaction consumes an
exact signed `rejected` preparation with `requiredFinalizationArtifactKind:"none"`, inserts its
immutable common result and next dense signer acceptance, moves command/sidecar to
`decided`/`terminal`, stores the exact compact action/chat semantic artifact, and inserts one causal
plaintext `pending_seal` intent. The v8 ingress row remains immutable in `awaiting_order` or later
`quarantined_collision`, no cursor advances, and v10 preparation/group/reservation remain
`signed`/`result_signed`/`signed`. Finalization does not require the route to stay current or gap-free
after signing. A narrow exact-current-successor rule can accept a valid pre-supersession predecessor
signature while the same current key/generation/certificate/custody chain remains intact; generic
superseded authority, rotation, retired certificates, and historical reattestation remain closed.
Any later successor signing lease must be durably acquired strictly after the predecessor acceptance,
including when the wall-clock values would otherwise share one millisecond.
`pending_seal` has no ciphertext, output part/signature, claim/seal/publish, broker operation,
effect/attempt, projection, native dispatch, or production path. Full A1.8a owns admitted atomic
arming, and A1.8b owns sealing/publishing.

The canonical writer is already used by shipped A0 AAD with its locked bytes unchanged. Production
now connects to or best-effort starts the owner only for wrapped `--rc-app` MITM, OpenCode, and tmux
driver paths after identity load. `startProductionRuntimeOwnerDaemon` installs A1.4 registration and
A1.5 `native.root.activate` only when a trusted `registrationAdapter` is supplied. The ordinary CLI supplies none, so its operation
registry remains empty, its authenticated RPC surface remains health-only, and health reports
`ownerOperationsWritable:false` and `nativeRegistrationEnabled:false`. A0 driver behavior remains unchanged, and no real driver performs
durable owner registration, A1 binding activation, or terminal-root activation; no A1 remote mutation,
inference, or broker capability is enabled. Owner unavailability silently preserves the exact A0 path.
Plain wrapper launches, help, `--rc-trace`, and the local `--rc-identity` action never start it. On
wrapper exit, remote-claw closes only that owner's RPC collaborator; the independently supervised
daemon and its service lease survive. This owner-lifetime rule does not replace any A0 driver's
existing native teardown behavior. The schema-v6 root operation remains available only through the
same explicit trusted-adapter seam. A1.6 broker calls are confined to the host-only installation
service and tests: ordinary launches, drivers, and the viewer make zero `/api/a1/*` calls, and there is
no runtime-owner broker or ingress operation and no real-driver integration. Schema-v8 ingress,
schema-v9 server signing, schema-v10 command adjudication, and schema-v11 rejected finalization are
reachable only through direct host-state/custody/repository modules and tests. Full A1.8a admitted
arming is the next state slice; A1.7b1 plus A1.8a0 still advertise nothing.
Malformed wire and runtime values fail closed at their trust or canonical boundary instead of being
accepted and failing later or being silently coerced.

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
- one paired remote-claw host contains many independent Claude, Codex, and OpenCode sessions across many projects and directories;
- a shared Codex or OpenCode daemon may contain many native conversations, while each conversation still has its own logical chat, binding, TUI relationship, collaborators, and recovery lane;
- one Claude outward Remote session normally represents one logical chat;
- replacing or resuming a native process updates its binding without silently merging another chat.

### 3.1 One host, many isolated session lanes

`CollaborationServerRecord` identifies the paired host service. It is a container for discovery and management, not a singleton conversation. Under one current server record, any number of `LogicalChatRecord`s may be ready at the same time, and each terminal logical chat resolves through exactly one current `NativeBindingRecord` to its own semantic native conversation. Every wrapper invocation registers or reattaches only the native runtime/conversation named by its durable intent. Claude may use one supervised process per conversation; separate Codex/OpenCode wrappers may own separate daemons, and a pinned Codex or OpenCode daemon may also share its proved native conversations. Runtime sharing never makes their histories, local TUI connections, collaborators, delivery attempts, gates, cursors, or recovery state interchangeable.

The complete isolation key for chat work is `(collaborationServerId, logicalChatId)`. Native work adds `nativeBindingId`, runtime/incarnation, semantic conversation ID, and attachment lease. Working directory, title, product, and project are attributes and routing evidence, not uniqueness keys: two sessions in the same directory remain independent, and two sessions in different directories cannot be merged merely because a provider or native ID resembles another.

The coordinator may allocate globally monotonic journal offsets and command sequence numbers so every durable record has a unique audit position. Those counters are not a host-wide execution lock. Admission, uncertainty quarantine, native-effect gates, causal outboxes, and recovery barriers run in a per-chat actor lane; a stalled or ambiguous attempt blocks only later writes to that same chat. Server-control operations such as `new_chat` use their separately scoped management actor and may take a short project/workspace transition lock where the native server requires it, but they do not serialize turns already running in unrelated chats.

That execution model remains the integrated target. A1.7a implements dormant route-local actor claims
and evidence-preserving ingress queues for `server_control` and chat routes. A1.7b1 now materializes
and globally sequences rejected common commands through signed preparation; A1.8a0 atomically closes
that rejected arm into an inert final-result/delivery-intent graph. Admitted decisions, native-facing
per-lane serialization/effects, and sealed publication remain full A1.8a/A1.8b work.

Shared-daemon resources have their own narrow locks. For example, one Codex bridge may reconcile subscriptions for several threads and one OpenCode server may serialize a workspace identity transition. Such a lock protects only the named daemon resource or workspace transition; it cannot repoint a binding, consume another chat's effect gate, close another chat's TUI path, or turn one session failure into host-wide quarantine.

Host recovery enumerates every current logical chat and native binding, then reattaches or quarantines each lane independently. A recovered lane must prove the exact native conversation and runtime lineage before it becomes writable. Failure to recover chat A leaves chat A visible and non-writable without creating a replacement row; it does not stop healthy local TUIs or runtime-scoped inference for chats B–N. While no coordinator lease is current, remote mutations report unavailable; each healthy remote lane becomes writable independently after its own lease, binding, and attachment proof and does not wait for chat A. Reconnecting or replacing a nested collaborator on one chat follows the same rule and does not alter another chat's edge.

The durable identity layers are:

| ID | Meaning | Restart rule |
| --- | --- | --- |
| `(collaborationServerId, projectId)` | Stable project grouping and public selector scope within one paired host | Allocated durably through an exact project intent; never reconstructed from cwd, title, provider IDs, or a native conversation |
| `(collaborationServerId, logicalChatId)` | Canonical chat within one remote-claw server | Stable across that server's coordinator, connector, and proven native-edge restarts; never aliased to another server's chat ID |
| `(identity_id, collaborationServerId, routeKind: "scope_bus", logicalChatId: null)` | One machine/server discovery-bus route and cursor | Stable across reconnects; never aliases a chat route |
| `(identity_id, collaborationServerId, routeKind: "server_control", logicalChatId: null)` | One authenticated machine/server management-ingress route for typed **New chat** | Stable source/dedup scope; never carries chat mutations or discovery announcements |
| `(identity_id, collaborationServerId, routeKind: "chat", logicalChatId)` | Machine-facing viewer row, chat route, alias, channel, and cache scope | Preserves the canonical server/chat pair while preventing an equal chat ID on another machine or server from colliding |
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
provider ID. `command_seq` gives proposals at one remote-claw server unique durable positions; each
chat actor offers only its own forwarded subsequence inward, so the global counter is not a
cross-chat scheduler or the native harness's final applied order. Normalized `chat_seq` follows
correlated native observations where those exist.
`viewerProjectionSeq` is a separate dense per-logical-chat receipt/provisional-display order allocated
from that chat's `nextViewerProjectionSeq`; it is never the server-wide `command_seq`, never
`chat_seq`, and does not claim native application. A direct TUI action may therefore receive an earlier
final `chat_seq` even when a remote proposal already has a projection receipt. Neither sequence resets
when a transport changes. At a terminal edge,
exactly one native binding/incarnation is
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

The host-level lifecycle vocabulary introduced in A0.1, now also used by both A0.2 compatibility
drivers, is the base for the target A1 boundary below. The process-local registrar and lease are used
by the compatibility paths. `NativeEngineAdapter`, the A0 `NativeMutationFence`, and the separately
landed `A1NativeMutationFence` are declaration-only contracts: no current driver consumes them.

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
  // In A1 this must reference a current ProjectRecord in the same collaboration server.
  projectId: string;
  // Routing/evidence only; never the durable project identity.
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
  // null is accepted only by the landed A0 process-local compatibility seam. A1 must resolve a
  // current ProjectRecord before it writes a registration intent, logical chat, or native binding.
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

interface A1NativeMutationFence {
  collaborationServerId: string;
  logicalChatId: string;
  nativeBindingId: string;
  inwardEdgeId: string;
  topologyGeneration: number;
  coordinatorLeaseId: string;
  coordinatorEpoch: number;
  attemptId: string;
  nativeRef: NativeConversationRef;
  attachmentLeaseId: string;
  capabilitySnapshotId: string;
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

The lifecycle declarations through `NativeEngineAdapter` have landed, but only the process-local
registrar/lease seam is wired today. The unwired A0 `NativeMutationFence` contains only `bindingId`,
`coordinatorEpoch`, `attemptId`, and `nativeRef`. A1.0 defines and validates the separate
`A1NativeMutationFence` above, including the server/chat/terminal-edge/topology/coordinator and native
attachment coordinates, but no current driver accepts or enforces it. The landed A0 contract is
deliberately lifecycle-only. Its process-local `bindingId` is an `rcb_*` lease key, not the canonical
chat ID. A1 adds durable records above it:

A1.0 validators accept only plain records whose exact selected string keys are ordinary own data
properties: missing, extra, inherited, symbol, and accessor properties fail closed. General A1 safe
IDs are 1–128 ASCII bytes matching
`[A-Za-z0-9._:-]+`; digests and one-use dispatch authorizations are canonical unpadded base64url of
exactly 32 bytes; `machineIdentityId` is exactly 32 lowercase hexadecimal characters. Other generic
contract strings are 1–1,024 UTF-16 code units, must contain only Unicode scalar values, and must not
contain `U+0000`, so a row
accepted here cannot later collide through UTF-8 replacement. Numeric fields reject negative zero as
well as negative, fractional, unsafe, and nonnumeric values. Runtime validation registries and
structural parser results are frozen. A1.0's parsers establish byte and row-shape contracts. A1.2's
schema and repository add the selected server/project/chat foreign keys, uniqueness,
append-only/monotonic triggers, exact-retry and compare-and-swap operations, and full-graph semantic
validation for the narrow v3 states described below. A1.3's schema v4 and runtime-owner repository add
their own runtime, owner, custody, attachment, gate, and signing invariants. A1.4's schema v5 and
registration repository add evidence-resolving process-lease, publication, operation-sequence,
lifecycle, predecessor, transport-reattach, and no-extra-row closure. A1.5's schema v6 and
terminal-root repository add signer-activation floors, immutable prepare/commit and certificate
lineage, signature verification, atomic chat/edge activation, exact demotion, and full-chain closure. Later slices may widen those
states only with their own retained evidence and migrations.

The selected A1 canonical ID namespaces are:

| Kind | Encoding | Allocation |
| --- | --- | --- |
| Collaboration server | `rcs_` + canonical base64url of 16 bytes | Random |
| Project | `rcpj_` + canonical base64url of 16 bytes | Random |
| Logical chat | `rcl_` + canonical base64url of 16 bytes | Random |
| Inward collaboration edge | `rcie_` + canonical base64url of 16 bytes | Random |
| Native binding | `rcnb_` + canonical base64url of 16 bytes | Random |
| Native runtime | `rcrt_` + canonical base64url SHA-256 | A1.3 derives it from the founding warden launch nonce, start-identity schema, and start-identity digest; the exact formula and vector are below |
| Coordinator lease | `rccl_` + canonical base64url of 16 bytes | Random |
| Registration attempt | `rcra_` + canonical base64url of 16 bytes | Random |
| Native conversation lease | `rcncl_` + canonical base64url of 16 bytes | Random |
| Protected handle | `rcph_` + canonical base64url of 16 bytes | Random |
| Project-target selector mapping | `ptm_` + canonical base64url SHA-256 | Derived from the exact mapping tuple |
| Native delivery attempt | `nat_` + canonical base64url SHA-256 | Derived from command, binding, and native incarnation |

The `nat_` identifier is the host-owned native-effect attempt below. It is not the fresh broker
transport `deliveryAttemptId`, whose retry and rollover domain is separate.

A1.5's terminal root uses a retry-stable A1 safe ID rather than a 16-byte canonical-ID namespace:

```text
nrpc_ + base64url(SHA-256(
  str("remote-claw/native-root-certificate-id/v1") ||
  str(machineIdentityId) || str(collaborationServerId) ||
  str(logicalChatId) || str(activationOperationId)
))
```

Including the machine/server/chat scope prevents the same caller operation ID from aliasing another
terminal reservation. For machine `00000000000000000000000000000000`, an `rcs_*` whose decoded body
is 16 bytes of `0x01`, an `rcl_*` whose decoded body is 16 bytes of `0x02`, and operation
`activate-native-root-1`, the locked result is
`nrpc_jOgfeDb_xNOrDU3-qegUUgQKOkbJoUbvTv9zZDC2mUY`. Snapshot validation recomputes this ID for every
retained activation operation and certificate.

The dormant A1.2 `ensureDefaultCollaborationServer` operation atomically creates one random default
`rcs_*`, stores it in `HostStateProfileRecord`, and reuses it on exact reopen. It is never derived from
`machineIdentityId`, a project, or a native session. Additional named server profiles require a later
explicit selection surface; until that lands, an invocation either reopens the stored default or
fails. Losing that profile/server record is a new-server and re-pair event, not permission to infer the
old server from broker or native traffic.

Every durable A1 logical chat and native binding belongs to one current `ProjectRecord`. The project
ID is a random grouping identity, not a hash or alias of a working directory, provider project, native
conversation, title, or workspace selector. On the first bootstrap of a server with no project, the
host requires one exact terminal target plus a typed `workspaceSelectorId`; one storage transaction
allocates a random project, stores its allocation intent, installs generation one of the corresponding
`ProjectTargetSelectorMappingRecord`, and creates the first recovering logical chat, starting native
binding, `NativeRegistrationIntentRecord`, and exact installing `InwardCollaborationEdgeRecord`. The
chat's `currentInwardEdgeId` points to that edge; it has `targetKind:"native-harness"`, names the new
binding, and has null root-certificate/live-lease/capability pointers. That installing edge is the
non-writable terminal-root reservation—there is not a second unsigned `NativeRootCertificate` row.
After runtime-owner activation, a native-harness edge may become `current` with its root certificate
while `currentConnectionEpoch` stays zero and both connection pointers stay null. Those three fields
belong only to an N1 remote-server edge; terminal liveness and capability fencing come from the native
binding's exact attachment lease and capability snapshot.
A1.2 implements that dormant compound repository operation; A1.4 implements the first trusted
registration workflow allowed to consume it, although the ordinary CLI installs no adapter that calls
that workflow for a real driver. An exact retry of the same allocation intent returns the same graph; changed
target or selector bytes collide. Once any project exists, an invocation without an explicit current
`(projectId, workspaceSelectorId)` fails closed. An explicit **New project** management intent uses the
same atomic allocation rule, but only after first bootstrap has installed the server's first project.
It never guesses from cwd or chooses the only or most recent project.
`projectAllocationIntentId` is the caller-supplied `registrationAttemptId` reserved and persisted by
that same transaction for `first_bootstrap`, and the admitted management `commandId` for
`explicit_new_project`; neither is minted after an uncertain allocation response.

The unique index is `(collaborationServerId, projectAllocationIntentId)`. Its canonical digest is:

```text
SHA256(
  str("remote-claw/project-allocation-intent/v1") ||
  str(projectAllocationIntentId) ||
  str(collaborationServerId) ||
  str(projectId) ||
  str(allocationKind) ||
  str(initialWorkspaceSelectorId) ||
  bytes(base64urlDecode(initialTargetDigest))
)
```

The transaction recomputes that digest and the initial selector mapping ID/target digest on every
retry. An exact match returns the existing project; any changed field is an intent collision and
creates no second project or mapping.

The nullable `NativeConversationBinding.project` field is retained solely for the landed A0 seam:
`project:null` means “unresolved process-local compatibility metadata.” It cannot be copied into a
`NativeRegistrationIntentRecord`, `LogicalChatRecord`, or `NativeBindingRecord`, cannot select an
existing project after restart, and cannot be promoted by matching cwd or native IDs. A0-to-A1
adoption must first install or select the exact durable project and target-selector mapping.

A1 host control state uses one owner-only, symlink-safe local database at
`$XDG_STATE_HOME/remote-claw/identities/<machineIdentityId>/host-state-v1.db`, falling back to
`~/.local/state/remote-claw/identities/<machineIdentityId>/host-state-v1.db` when
`XDG_STATE_HOME` is absent or relative. The fallback home must itself be absolute; a relative or empty
home fails closed instead of resolving under the working directory. A1.0 implements the pure,
identity-validated path resolver. A1.1 implements and tests the secure storage kernel on Linux with
Node.js `^22.13.0 || >=23.5.0` and `node:sqlite`; by itself that slice did not spawn a daemon or open a
production handle. Runtime version admission requires an exact stable `X.Y.Z` string in that range and
rejects prerelease or build-like suffixes. A1.3 now places the kernel behind the independently
supervised runtime-owner service and holds the first live production handle. The
coordinator receives high-level epoch-fenced RPC operations, never a SQLite handle or raw SQL access.

The A1.1 open contract is intentionally stronger than a pathname and mode check. It is Linux-only and
anchors traversal and the SQLite open to held descriptors through `/proc/self/fd`. From the selected
state home downward, mutable parent directories must be owned by the current UID and must not be
symlinks; the state home must not be group- or world-writable. The `remote-claw`, `identities`, and
machine-identity directories are exactly `0700`. The database and its reserved SQLite WAL/SHM
sidecars are owned regular `0600` files with link count one on the identity directory's filesystem.
Creation uses no-follow/exclusive semantics; open and migration compare descriptor and pathname
device/inode facts before and after the operation and reject symlink, hardlink, or replacement races.
Both migration and ordinary transaction paths revalidate every guardian immediately after
`BEGIN IMMEDIATE` acquires the writer lock and before running migration SQL or a public callback, so a
path swap during the lock wait cannot reach mutable work.
The selected mode is WAL only: any `host-state-v1.db-journal` file or existing non-WAL database is
refused before an application transaction rather than silently recovered through rollback-journal
mode.

Local-filesystem policy v1 allows only Linux filesystem magic values for ext, XFS, Btrfs, F2FS, and
ZFS. tmpfs, NFS, CIFS/SMB, 9p, FUSE, overlay, and every unknown filesystem fail closed. A new local
filesystem must be added through a versioned policy change with retained locking/durability proof;
the kernel never guesses from a pathname or mount label.

Every connection establishes and reads back `PRAGMA foreign_keys=ON`, `trusted_schema=OFF`,
`journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000`, `temp_store=MEMORY`, and
`recursive_triggers=ON` before accessing application tables; the initial validation connection also
requires `query_only=ON`. Every connection also disables double-quoted string literals and proves the
setting behaviorally: a single-quoted control query must return the selected token, while
`SELECT "remote_claw_dqs_probe"` must fail with `ERR_SQLITE_ERROR` and `errcode=1`.
After descriptor/header preflight, an existing database is opened through that read-only, WAL-aware
connection and its application ID, logical `user_version`, exact schema, metadata, migration history,
and integrity are validated in one coherent SQLite transaction snapshot. No writable SQLite
connection opens unless that validation succeeds. A future version committed only in a crash-surviving
WAL is therefore rejected without rewriting the main database or WAL. SHM is transient SQLite
coordination state and may be created or changed by this read-only validation, but its path, ownership,
mode, link count, and inode remain guarded. A safe SHM-only remnant beside an existing database may be
reconstructed with a new WAL; a WAL or SHM without a database is refused.

`synchronous=FULL` WAL `COMMIT` is each migration's durability boundary. After a migration commits,
the kernel validates a coherent snapshot, attempts a non-blocking `wal_checkpoint(PASSIVE)`, and
fsyncs the guarded database/WAL/SHM inodes and directories. An active reader may leave frames for a
later checkpoint, while a competing checkpoint may return SQLite's exact checkpoint-lock sentinel
`busy=1`, `log=-1`, `checkpointed=-1`; neither is a rollback or migration failure. Every other
inconsistent result fails closed. A post-commit validation/checkpoint/fsync
failure raises `HostStateMigrationCommittedError` with `committed=true` and `retryOpenSafe=true`. A
failed `COMMIT` whose rollback cannot prove the outcome raises
`HostStateMigrationOutcomeUnknownError` with `outcome="unknown"` and `retryOpenSafe=true`. Retrying the
database open is therefore explicit and safe in either case because exact validation makes migration
completion idempotent. Neither outcome authorizes blindly replaying an ordinary command.

Ordinary high-level writes rely on WAL plus `synchronous=FULL` at `COMMIT`, perform no mandatory
checkpoint or extra fsync, and then recheck every filesystem guardian. A guardian failure after commit
raises `HostStateCommittedStateError` with `committed=true` and poisons the handle. A failed ordinary
`COMMIT` with unknown outcome raises `HostStateCommitOutcomeUnknownError` with `outcome="unknown"` and
`retrySafe=false`, and also poisons the handle. `ProtectedArtifactPersistenceError` remains distinct
from an unverified-artifact response and poisons the live handle. The public database opener accepts
only the machine identity and optional path environment; it exposes no entropy or clock injection.

Close disables further transactions before closing SQLite and releases descriptor guardians only
after SQLite reports the connection closed. If SQLite remains live, `HostStateCloseIncompleteError`
reports `guardiansRetained=true` and `retryCloseSafe=true`; the caller may retry close, but may not use
the handle. If cleanup after a failed open cannot close every SQLite connection, the kernel retains the
connections and filesystem guardians in a fail-stop quarantine until process restart and raises
`HostStateOpenCleanupError` with `guardiansRetained=true` and `retryOpenSafe=false`. The quarantine is
keyed by canonical database path: every later open of that path fails until process restart, while a
different database path remains independent. The kernel never drops guardians while SQLite may still
own the canonical database or sidecars.

Current schema v11 uses SQLite
`application_id=0x52434c57` (ASCII `RCLW`) and `user_version=11`. Its append-only migration history is a SHA-256
chain over the previous digest, version, migration ID, statement count, and exact ordered SQL text,
encoded with the shared `CanonicalWriter` under
`remote-claw/host-state/migration-chain/v1`. Migration 1 (`001-initial-host-state`) is locked to
`Pk8Yrc3jVK9xoHKDcBdeyejFYUSbyjnp-SH0VMA_Hec`; migration 2
(`002-protected-artifact-immutability`) is locked to
`yx23Bca9rSZttCEInDAEOrzLVhq-KWcZLE1i27tqNiY`; migration 3 is
`003-durable-host-records`, contains 81 ordered statements, and is locked to
`cMLS59JfiV7fRoK68n1kZz3DN9Vo4yu7VZAX_HxHpq4`; migration 4
(`004-runtime-owner-durability`) contains 141 ordered statements and is locked to
`zx52EtAFNY9hEZneG3RW14zRCYR18gg7ysnltHbOkT0`; migration 5
(`005-durable-native-registration`) contains 38 ordered statements and is locked to
`l32ozsKKBm5ueLOk-_IeiasPgp_deE-tZHEbaZ6urOE`; migration 6 (`006-terminal-native-root`) contains 36
ordered statements and is locked to `li87zqB0yxSfRtN-p_xT5Yk2xAvX8Iy5a1xDXNTYYZo`; migration 7
(`007-a1-broker-routes`) contains 22 ordered statements and is locked to
`uShlOvT_fWScwCLQD1g6-GAd1YyKR2QIlGjC0SPQWbw`. Migration 8
(`008-a1-durable-ingress`) contains 171 ordered statements and is locked to
`6Vf2H56rDvW2PGMrU83upUDz1r9gHP11tdq_w7T1K5E`; its 492-object manifest contains 57 tables, 99
indexes, and 336 triggers. Migration 9 (`009-server-scope-signer`) advances the dormant
server-signer schema with 81 statements, digest
`fYrN5atmwIj-tlT_tTXmrg9kNF52ah-zWmgf7vVFQWE`, and a 571-object manifest containing 65 tables, 123
indexes, and 383 triggers. Open verifies the application ID, `user_version`,
stored machine identity, exact schema manifest for that historical version, every migration-history
row, and migration digest before applying the next compiled migration. Partial, mismatched,
extra-object, corrupt, or future state is refused; migration 10
(`010-common-command-adjudication`) has 50 ordered statements, digest
`rdJC_2C5IyjfsTuXhxjFSzT0bvDYtlpT8o0xDvu4IEk`, and a 619-object manifest containing 70 tables,
137 indexes, and 412 triggers. Migration 11 (`011-a1-rejected-result-finalization`) has 38 ordered
statements, digest `SkkuAFJed-7GT9XyXXPCub7VFauqNY6eu0u4IQJEInc`, and a 647-object manifest
containing 73 tables, 147 indexes, and 427 triggers. A valid v1 through v10 database migrates to v11. Every
`sqlite_schema` row is matched exactly, including names beginning with `sqlite_`; no hidden extra is
ignored. A newly created database must have `application_id=0` and literally zero `sqlite_schema`
rows before migration 1 begins; any preexisting application object fails closed. Schema v1 has three
tables, the explicit unique migration-ID index, and migration-history
no-update/no-delete triggers in an exact six-object manifest. Schema v2 adds migration-history
no-replace and protected-artifact no-update/no-delete/no-replace triggers, producing an exact
ten-object manifest of three tables, one index, and six triggers. Schema v3 adds the ten A1.2 tables
`collaboration_servers`, `host_state_profiles`, `projects`,
`project_target_selector_mappings`, `logical_chats`, `native_bindings`,
`native_registration_intents`, `inward_collaboration_edges`, `coordinator_leases`, and
`control_journal_entries`. The complete v3 `sqlite_schema` manifest is exactly 91 objects: 13 tables,
24 indexes, and 54 triggers. Schema v4 adds `runtime_owner_state`,
`runtime_owner_service_leases`, `runtime_owner_journal_entries`, `native_runtimes`,
`native_runtime_incarnations`, `runtime_owner_assignments`, `native_runtime_containments`,
`runtime_owner_identity_keys`, `runtime_owner_private_keys`,
`runtime_owner_signature_reservations`, `runtime_owner_signed_record_acceptances`,
`local_native_conversations`, `local_native_conversation_transitions`,
`native_binding_incarnations`, `native_transport_attachments`, `native_transport_leases`, and
`binding_lifecycle_gates`. The complete v4 manifest is exactly 231 objects: 30 tables, 57 indexes,
and 144 triggers. Schema v5 adds `native_conversation_leases`,
`native_registration_publications`, and `native_registration_operations`. The complete v5 manifest is
exactly 269 objects: 33 tables, 67 indexes, and 169 triggers.
Schema v6 adds `native_root_signature_activation_fences`, `native_root_activation_operations`, and
`native_root_certificates`. The complete v6 manifest is exactly 304 objects: 36 tables, 78 indexes,
and 190 triggers.
Schema v7 adds `broker_backend_capability_pins`, `broker_routes`, and
`broker_channel_generations`. The complete v7 manifest is exactly 326 objects: 39 tables, 85 indexes,
and 202 triggers.
Schema v8 adds only the dormant ingress ledger: route runtime/generation heads, physical-fetch and
semantic-prefix cursors, retained read-page/per-frame evidence, authenticated positions and
equivocations, gaps and recoveries, transport collisions, multipart semantic
results/attempts/candidates/parts/observations, and revisioned route actors. It adds no command,
signature, result-delivery, checkpoint, outbox, effect, dispatch, viewer, or native table.
Schema v9 adds `server_identity_keys`, `server_identity_private_key_envelopes`,
`server_scope_certificates`, `server_scope_certificate_statuses`,
`server_bootstrap_signing_leases`, `server_signing_leases`, `server_signature_reservations`, and
`server_signed_record_acceptances`. It supplies only the dormant initial self-anchor, wrapped custody,
fenced signing authority, and reserve/bind/sign/accept/reconcile state described below; it adds no
common command/result, generic host output, broker publish, result delivery, checkpoint,
outbox/effect, native attempt/dispatch, inference, projection, production operation, or native table.
Migration 9 also replaces the existing broker-route admission trigger so a route may be installed for
either an `installing` server or an exact signer-activated `current` server under the same
current-coordinator and capability-pin proof; this is compatibility for the existing dormant route
repository, not a new route or live wire capability.
Schema v10 adds exactly `command_ready_entries`, `a1_ingress_adjudications`,
`collaboration_commands`, `collaboration_command_compound_signing_groups`, and
`collaboration_command_result_preparations`. It permits only the dormant A1-ingress ready,
rejected-decision, and signed-preparation graph described below. It has no final common-result,
command-result acceptance row, source-result/delivery, outbox, effect, attempt, dispatch, inference,
viewer, production-operation, or native table.
Schema v11 adds exactly `collaboration_command_results`, `a1_ingress_terminal_results`, and
`a1_ingress_result_deliveries`. It permits only the rejected/no-finalization-artifact terminal graph:
one immutable common result, one exact dense signer acceptance, one logical A1 terminal overlay, and
one causal plaintext delivery intent fixed at `pending_seal`. It adds no admitted result, ciphertext,
output part/signature, claim/seal/publish, broker operation, cursor movement, effect/attempt,
projection, production operation, or native table.

The supported graph is deliberately narrower than the full record unions. A database is either
unbootstrapped or contains exactly one linked `default` profile whose server is `installing` in
schemas v3–v8 and may be `installing` or signer-activated `current` in schemas v9–v11.
Projects are `current`. Each project's one persisted v3 selector has a contiguous terminal-native
mapping chain starting at generation one, with only its tail `current` and prior rows `superseded`; a replacement is an exact
generation/ID/target-digest compare-and-swap. Every persisted chat is `recovering`, has topology
generation one and projection sequence zero, and names the exact mapping generation used to create
it. It points to one unresolved `starting` binding with exactly one registration intent and one random
`rcie_*` native-harness edge in `installing`; certificate, remote connection, live-lease, capability,
semantic-conversation, and binding-incarnation pointers remain null. Explicit projects may exist
without a chat after the first bootstrap. Nested selector targets and `remote-claw-server` edges are
valid future record shapes but fail v3 semantic validation; N1 must add its own migration and proof
before either may persist. The current v11 semantic validator preserves all of those A1.2 restrictions and
additionally validates the runtime-owner state, service-lease/journal history, derived runtime roots,
incarnation/assignment/containment lineage, wrapped-key and signing state, project-scoped local
conversation transitions, and binding-incarnation/attachment/lease/gate joins described below. It
also closes every A1.4 registration lease, publication, and operation as an exact reachable graph:
contiguous operation sequences, per-kind canonical schema/digest/fence/time facts, authority
lifetimes, lifecycle-gate projection, A1.2 evidence/publication equality, predecessor and transport
journals, and no unclaimed extra row. It additionally closes every schema-v8 route head, page/frame
observation, immutable artifact, position, multipart/result vector, gap/recovery, cursor, and actor
claim to its exact installed route and coordinator authority. It also closes every schema-v9 server
key/envelope, certificate/status, bootstrap/current lease, reservation, and acceptance to the exact
machine/server/key generation, signer sequence, payload, and coordinator fence; corruption fails
before writable reopen. For schema v10 it additionally recomputes every A1 source/payload/command/
decision/result/group/preparation identity and digest, merges control and ready rows into the exact
gap-free `nextJournalOffset`, validates dense server command and signer sequences, verifies retained
result signatures, follows the single current generation plus its exact aborted predecessors, and
rejects terminal/final/effect or orphan state before writable reopen.
For schema v11 it additionally closes every immutable command result, signer acceptance, terminal
overlay, completion observation, protected semantic-result artifact, and `pending_seal` intent into
one exact rejected graph. It recomputes compact payload bytes, artifact and stored-semantic digests,
the `rrd_*` identity, accepted-candidate greatest-cursor trigger, and every command/result/source
join; validates dense acceptance order and normal-current or narrow predecessor-lease takeover
authority; and rejects partial, admitted, encrypted, publishable, effect-bearing, cursor-moving, or
orphan state before writable reopen. Later source collision/quarantine or route closure does not
invalidate an already-signed rejection or its terminal graph.

For schema v6, an unrooted A1.4 ready graph may prepare competing initial root operations under its
current owner/coordinator fences and exact current runtime, binding incarnation, attachment lease,
process lease, publication, and lifecycle gate. Preparation creates one immutable protected payload,
reserves and binds one runtime-owner Ed25519 signer sequence at or above that key's immutable
activation floor, and records an exact replay digest; it does not make the edge writable. The public
runtime-owner `storeSignedRecord`, `acceptSignedRecord`, and `abortSignature` paths cannot mutate an
operation-attached `native_root` reservation, including after reopen. The service creates the
signature before its fresh reverse proof. With no await after that proof and final fence check, the
transaction-local terminal-root finalizer alone stores and accepts the signature, sampling its
acceptance/commit timestamp then. It rechecks the current graph and fences, verifies the Ed25519
signature, inserts the immutable certificate as the sole atomic finalizer, marks the operation
committed, and changes the logical chat to ready and terminal edge to current with that root ID. V5
unattached signature rows remain inert compatible history. The first certificate commit selects the
one activation head; other prepared siblings remain non-writable evidence. A renewal must name the
latest historical certificate; one committed successor wins when prepared siblings race. The validator
verifies every payload, digest, signature, reservation, acceptance, authority lifetime, activation
chain, and current or exactly-demoted chat/edge projection, while tolerating losing prepared siblings
as retained evidence. It has no live callable-port proof and does not reinterpret wall-clock expiry as
a persisted lifecycle transition; those are operation-time admission checks.

Every v4 journaled effect is claimed by exactly one matching durable fact, and every journal entry is
claimed: kind and subject, semantic IDs, owner lease/epoch, effect timestamp, and the required
lifecycle order must agree. A lease-scoped effect is at or after acquisition and before the heartbeat
deadline; after explicit release it is also no later than `releasedAtMs`. The release entry itself is
at exactly `releasedAtMs` and is the last journal effect for that lease. An ordinary effect may share
that millisecond only when its journal offset precedes the release. Runtime-scoped effects also bind
the exact assignment active at that journal position and its native incarnation. Assignment activation
precedes containment, and replacement or termination uses the predecessor incarnation's assignment
fence rather than a later owner's unproved authority.

Local-conversation validation replays each runtime's contiguous transition order. A source must have
been introduced earlier, each conversation has exactly one creating transition, a fork's target parent
is its exact source, and non-fork creation cannot invent parent lineage. Parent chains stay within one
runtime incarnation and are acyclic; replayed clear/archive/unarchive changes must agree with current
conversation state. Each prepared binding incarnation likewise owns one exact
attachment/lease/lifecycle-gate graph, with its paired preparation and lease-acquisition journal facts
sharing the same owner fence and timestamp in the required order.

A1.4 opens one generation-fenced `NativeConversationLease` under the exact current runtime-owner and
coordinator leases and one exact A1.2 registration attempt. Bind selects the prepared
binding-incarnation, attachment lease, and local semantic conversation; publish installs one
generation-ordered binding-scoped metadata/capability snapshot; and ready atomically makes the runtime
incarnation and native binding current, moves the binding lifecycle gate and process lease to ready,
and deliberately leaves the logical chat recovering and terminal edge installing. Every operation has
one kind-specific canonical schema and digest, exact fence tuple and commit time, and a contiguous
per-lease sequence. Exact retry is distinguished from a changed collision before any write, and
ordinary conflicts do not poison the handle.

Mutation, including replay, requires current unexpired owner and coordinator authority. Read-only
`reconcileOperation` instead recomputes the complete request digest and checks the corresponding
lease/publication/lifecycle fact without claiming that an expired caller is current. A stale open lease
therefore remains valid crash evidence but is not writable or proof of an in-memory callable port.
After takeover, reattach atomically appends the fresh-fenced close proof for a stale-open predecessor
and creates the same binding lineage's new process lease and protected port. An orderly closed
predecessor instead reuses its exact retained close proof. A changed authority tuple also requires a
new transport lease on the same binding incarnation/attachment, with ordered predecessor-detach and
successor-acquire runtime journal facts. If the predecessor published
capabilities, their retained canonical binding-scoped artifact must say `liveReattach:true`; a bound
pre-publication predecessor may recover without inventing that capability.

The A1.2 repository exposes only high-level synchronous operations. It ensures/reads the default
server; acquires, renews, releases, and reconciles coordinator leases; atomically creates the first
project/chat/binding/intent/edge graph; allocates a later explicit project only after that first
bootstrap; replaces a terminal selector mapping by compare-and-swap; reserves additional terminal
chats against an exact mapping fence; and inventories projects, mapping generations/current mapping,
logical chats, bindings, full terminal reservations, and lease acquisition state. Exact retries return
the original rows for the idempotent creation/replacement operations, while a reused intent/candidate
with changed bytes is a conflict; lease renewal is replayable only under its current fence, and
release uses read-side reconciliation after response loss. Mapping
replacement does not retarget old chats: each `LogicalChatRecord.projectTargetSelectorMappingId`
continues to name the generation it used, while later reservations may select the new current tail.

Every committed project bootstrap, non-first terminal reservation, mapping replacement, coordinator
acquisition, and coordinator release has exactly one immutable journal entry at the server's next
contiguous offset; semantic validation rejects missing, extra, reordered, mistimed, or wrongly fenced
entries. Heartbeat renewal updates only the deadline. An expiry takeover allocates a higher epoch and
changes the server's current pointer without rewriting the predecessor row; that pointer plus epoch is
the authority. Explicit release records release time/journal evidence and may clear the server pointer
only when it still names that exact current lease and epoch. Read-side
reconciliation reads durable evidence for an acquisition, renewal, release, project allocation,
mapping replacement, or terminal reservation after a lost response; it reports an explicit
superseded/indeterminate result when later lease state prevents exact proof. This remains A1.2
persistence reconciliation only. A1.4 now owns evidence-resolving registration, callable-port setup,
and attachment lifecycle, with its own request-bound `reconcileOperation` for an unknown commit; an
unknown ordinary SQLite commit is never declared safe to replay blindly.

`HostStateActorScope` supplies durable addresses for the separate `server_control` lane and each
`(collaborationServerId, logicalChatId)` chat lane. A1.2 itself persists no command queue and runs no
actor. A1.7a now uses those addresses for dormant route-local ingress actors through
`awaiting_order`; common command admission/order and native-facing per-chat serialization remain
A1.7b.

The public kernel transaction callback is synchronous, forbids nesting and promise returns, and
exposes only high-level operations. Its transaction object cannot escape the callback; raw SQL and the
`DatabaseSync` handle remain private. Database-level asynchronous artifact operations reject
synchronously when called inside this callback; atomic work must use the transaction-bound operations,
so ignoring a returned Promise cannot let the outer transaction commit. A Promise/thenable callback
result or a failure while safely inspecting one rolls back and poisons the handle; authority is
poisoned before a forbidden async continuation or hostile Promise-species/thenability path can reuse
it. A1.1 proves commit and generic multiwrite rollback with protected artifacts. The
native-attempt/front-door-dispatch/effect-gate all-or-nothing rollback is an A1.8 proof after those
tables and operations exist.

Control-journal and runtime-transition tables remain logically separate, but native delivery attempt,
front-door dispatch, and effect-gate creation share this one transaction boundary. Adapter-private
transport state such as Claude RC event bodies may use a separate adapter-local store only when no
selected atomic invariant crosses into it. Private keys, callable ports, provider credentials, and
dispatch authorizations are referenced through protected handle APIs; they are not ordinary
`LocalArtifactRecord` payloads.

`registrationAttemptId` is durable replay identity. Its canonical intent digest covers the
descriptor, project, expected native identity, initial phase, and versioned metadata/capability
digests, but excludes the process-local `port` object. An exact retry returns the same
`nativeBindingId`; changed intent bytes under the same attempt ID collide. Reacquiring a process-local
port under a later coordinator epoch creates a new `NativeConversationLeaseRecord` for that same
intent and binding, not another binding.

The exact registration intent digest is:

```text
SHA256(
  str(canonicalIntentSchemaId) ||
  str(registrationAttemptId) ||
  str(collaborationServerId) ||
  str(nativeBindingId) ||
  str(descriptorRef) ||
  bytes(base64urlDecode(descriptorDigest)) ||
  str(projectRef) ||
  bytes(base64urlDecode(projectDigest)) ||
  optionalBytes(expectedNativeRefDigest == null ? null : base64urlDecode(expectedNativeRefDigest)) ||
  str(initialPhase) ||
  str(metadataSchemaId) ||
  str(metadataRef) ||
  bytes(base64urlDecode(metadataDigest)) ||
  optionalStr(capabilitiesRef) ||
  optionalBytes(capabilitiesDigest == null ? null : base64urlDecode(capabilitiesDigest))
)
```

`capabilitiesRef` and `capabilitiesDigest` are either both null or both present. `createdAtMs`, the
process-local port, and `canonicalIntentDigest` itself are excluded. A1.0 computes and verifies these
bytes. A1.2's dormant first/additional terminal reservation operations persist the intent with the
recovering chat, starting binding, and installing `rcie_*` edge, and implement exact-retry lookup and
collision enforcement. Its refs and digests are opaque durable evidence coordinates: A1.2 neither
resolves them nor owns a callable port. A1.4 verifies and resolves those coordinates synchronously
through five canonical schemas: `remote-claw/native-engine-descriptor/v1`,
`remote-claw/durable-project-selection/v1`, `remote-claw/native-conversation-ref/v1`,
`remote-claw/native-conversation-capabilities/v1`, and
`remote-claw/native-registration-metadata-evidence/v1`. Descriptor, project-selection, intent
metadata, and intent capability evidence are server-scoped; native-conversation-ref evidence is
runtime-scoped; published metadata and capabilities are binding-scoped. Metadata must equal the A1.2
intent's canonical semantics, and capabilities must equal them when the intent declared a capability
artifact.

A1.0 also freezes the protected-handle boundary. A protected reference is exactly
`{protectedHandleId: rcph_…, kind}`. The five kinds are `artifact`, `signing_key`,
`provider_credential`, `callable_port`, and `dispatch_authorization`; the five operation scopes are
`host_profile`, `collaboration_server`, `runtime`, `native_binding`, and `native_attempt`. Their IDs
are respectively the literal `default`, `rcs_*`, `rcrt_*`, `rcnb_*`, and `nat_*`; a kind and an ID
from another scope cannot be combined. The
32-byte one-use dispatch authorization is a separate secret, never an `rcph_*` ID. Only these
operation-specific capabilities exist:

- put an immutable artifact and read it back only with its schema and expected digest;
- sign one reserved digest without returning the signing key;
- invoke one callable port with the exact binding, runtime, coordinator lease/epoch, operation
  ref/digest, and optional connector-scoped provider credential;
- arm, consume, or revoke one attempt-bound dispatch authorization.

The byte-bearing protected fields use the nominal `ProtectedByteSnapshot` value rather than a
`Readonly<Uint8Array>` alias. Its factory accepts only a genuine `Uint8Array`, including Node
`Buffer` and fixed or growable `SharedArrayBuffer` views, and immediately copies the visible bytes
into fixed `ArrayBuffer` storage. The retained storage is never exposed: `copyBytes()` returns a new
fixed copy on every call. Mutating or growing the source, or mutating any returned copy, therefore
cannot change the protected-operation value. This freezes the boundary's byte-ownership rule. A1.1
now stores immutable artifacts up to 16 MiB, recomputes their SHA-256 digest before insert and after
read, binds each read to the exact scope, schema, reference, and expected digest, validates the stored
length against the stored bytes, and returns a fresh snapshot. It allocates a random 16-byte `rcph_*`
handle and fails after at most eight collisions instead of looping. Later slices own key, credential,
port, and authorization custody.

For dispatch, `scopeKind` is exactly `native_attempt` and `scopeId` is the sole `nat_*` attempt ID;
there is no duplicate attempt field that could disagree. The arm request also supplies the exact
current caller fence, ingress-lease ID, target-path digest, request digest, and translation digest. In
the same owner transaction that creates the durable dispatch row, the protected owner generates the
authorization and returns only its opaque `rcph_*` reference plus the resulting canonical dispatch
digest. The stable authorization identity is the attempt scope, ingress lease, target, request,
translation, reference, and dispatch digest; it deliberately excludes the coordinator fence. Consume
and revoke present that same stable identity plus their caller's current fence, which the owner
validates independently. A replacement coordinator can therefore claim the exact still-not-started
authorization without pretending to hold its predecessor's lease. The raw 32-byte authorization
remains protected. Only a successful consume returns it to the in-process native adapter, as part of
the final owner transaction that marks the attempt, dispatch, and gate started.
This makes an exact pre-start retry reconstructible from durable state without adding a generic
protected-value lookup; after consume, recovery is evidence-only.

There is deliberately no generic resolve/get/read/list/export operation. A1.0 supplies the type
surface, immutable byte-snapshot value, and strict protected-reference parser; A1.1 implements only
the scoped `putArtifact` and `readVerifiedArtifact` operations. A1.3 implements wrapped signing-key
custody, and A1.4 implements callable-port custody as a bounded reverse channel; provider credentials
and one-use dispatch authorization remain later dispatch work.

The A1.0 validator manifest covers the server/profile/project/coordinator lease and fence,
registration intent/conversation lease/local artifact, logical chat/native binding/project-selector
mapping, runtime-owner/runtime/binding-incarnation/transport/edge, backend capability, prepared
mutation/receipt/reconciliation, and native attempt/dispatch/effect-gate shapes shown here. A caller
must run the corresponding canonical digest or derived-ID verifier where the row has one. The
manifest alone is not a claim that every shape has a database row or writable service. A1.2 persists
its narrow server/profile/project/mapping/chat/binding/registration-intent/inward-edge/coordinator
lease/journal subset; A1.3–A1.6 add the runtime-owner, registration, terminal-root, and broker-route
rows called out in their milestone sections; A1.7a adds only the schema-v8 ingress subset through
`awaiting_order`; A1.7b0 adds only the schema-v9 server key/envelope, certificate/status,
bootstrap/current signing-lease, reservation, and acceptance subset; and A1.7b1 adds the schema-v10
ready/A1-sidecar/common-command/compound-group/result-preparation subset. A1.8a0 adds the schema-v11
immutable common-result/logical-terminal/`pending_seal` subset for rejected A1 ingress. The combined interfaces below continue through later target states. Schema v10 permits
`deciding`, a common command/result ID, and signed preparation refs only in its rejected
signed-but-unaccepted graph. Schema v11 permits only its exact `decided`/`terminal` rejected graph,
dense signer acceptance, and inert plaintext delivery intent. Checkpoint, claim/seal/publish,
encrypted output, effect, dispatch, projection, and native execution remain later claims.
The exact landed A1.7a record union and bounds live in `packages/cli/src/host/state/ingress.ts`; the
schema-v9 signer records live in `packages/cli/src/host/state/server-signing.ts`; schema-v10 records
live in `packages/cli/src/host/state/command-adjudication.ts`; and schema-v11 result records live in
`packages/cli/src/host/state/command-result-finalization.ts`.

```ts
interface CollaborationServerRecord {
  collaborationServerId: string; // stable random rcs_<base64url-128-bit>
  machineIdentityId: string; // 32 lowercase hex characters, decoded to 16 bytes on wire
  currentKeyGeneration: number; // equals the current certificate's keyGeneration
  // All zero/null while installing; all present before state becomes current.
  currentIdentityKeyId: string | null;
  currentScopeCertificateId: string | null;
  // Zero/null before the first coordinator lease. Acquiring a replacement increments the epoch.
  currentCoordinatorEpoch: number;
  currentCoordinatorLeaseId: string | null;
  // Allocated transactionally for every control-journal entry; never inferred from row count.
  nextJournalOffset: number;
  nextServerSignatureSeq: number;
  nextCommandSeq: number;
  createdAtMs: number;
  state: "installing" | "current" | "repairing" | "closed";
}

interface HostStateProfileRecord {
  stateProfileId: "default";
  machineIdentityId: string;
  defaultCollaborationServerId: string;
  createdAtMs: number;
}

interface ProjectRecord {
  projectId: string; // stable random rcpj_<base64url-128-bit>
  collaborationServerId: string;
  projectAllocationIntentId: string; // unique within the server; exact retry returns this row
  projectAllocationIntentSchemaId: "remote-claw/project-allocation-intent/v1";
  projectAllocationIntentDigest: string;
  allocationKind: "first_bootstrap" | "explicit_new_project";
  initialWorkspaceSelectorId: string;
  initialTargetDigest: string;
  initialProjectTargetSelectorMappingId: string; // exact derived ptm_<base64url-SHA-256>
  createdAtMs: number;
  state: "current" | "closed";
}

interface CoordinatorLeaseRecord {
  coordinatorLeaseId: string;
  collaborationServerId: string;
  coordinatorEpoch: number;
  ownerInstanceId: string;
  acquiredAtMs: number;
  heartbeatDeadlineMs: number;
  releasedAtMs: number | null;
  state: "current" | "expired" | "released" | "superseded";
}

interface CoordinatorLeaseFence {
  collaborationServerId: string;
  coordinatorLeaseId: string;
  coordinatorEpoch: number;
}

interface NativeRegistrationIntentRecord {
  registrationAttemptId: string;
  collaborationServerId: string;
  nativeBindingId: string;
  canonicalIntentSchemaId: "remote-claw/native-registration-intent/v1";
  descriptorRef: string;
  descriptorDigest: string;
  projectRef: string;
  projectDigest: string;
  expectedNativeRefDigest: string | null;
  initialPhase: "starting" | "recovering";
  metadataSchemaId: string;
  metadataRef: string;
  metadataDigest: string;
  capabilitiesRef: string | null;
  capabilitiesDigest: string | null;
  canonicalIntentDigest: string;
  createdAtMs: number;
}

interface NativeConversationLeaseRecord {
  nativeConversationLeaseId: string;
  collaborationServerId: string;
  nativeBindingId: string;
  registrationAttemptId: string;
  coordinatorLeaseId: string;
  coordinatorEpoch: number;
  protectedPortHandleId: string;
  acquiredAtMs: number;
  closedAtMs: number | null;
  state: "starting" | "recovering" | "ready" | "draining" | "closed";
}

interface LocalArtifactRecord {
  artifactId: string;
  artifactKind: string;
  canonicalSchemaId: string;
  digestAlgorithm: "SHA-256";
  artifactDigest: string;
  byteLength: number;
  protectedStorageHandleId: string;
  createdAtMs: number;
}

interface ServerScopeCertificateRecord {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/server-scope-certificate/v1";
  scopeCertificateId: string;
  collaborationServerId: string;
  machineIdentityId: string;
  subjectIdentityKeyId: string;
  subjectKeyAlgorithm: "Ed25519";
  subjectPublicKey: string; // canonical base64url raw public-key bytes
  keyGeneration: number;
  issuedAtMs: number;
  supersedesScopeCertificateId: string | null;
  signerIdentityKeyId: string;
  signerSequence: number;
  supersededSignerMaxSequence: number | null;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface ServerScopeCertificateStatusRecord {
  scopeCertificateId: string;
  collaborationServerId: string;
  state: "current" | "retired" | "revoked";
  acceptSignaturesThroughSequence: number | null;
  changedAtMs: number;
  changeEvidenceRef: string;
  changeEvidenceDigest: string;
}

interface ViewerOnboardingKeyAttestationV1 {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/viewer-onboarding-keys/v1";
  collaborationServerId: string;
  machineIdentityId: string;
  scopeCertificateId: string;
  keyGeneration: number;
  signerIdentityKeyId: string;
  signerSequence: number;
  authTokenCommitment: string;
  contentRootCommitment: string;
  controlKeyCommitment: string;
  metaKeyCommitment: string;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface ViewerOnboardingBundleV2 {
  version: 2;
  machineIdentityId: string; // 32 lowercase hex chars
  collaborationServerId: string;
  authToken: string; // canonical unpadded base64url of exactly 32 bytes
  contentRoot: string; // canonical unpadded base64url of exactly 32 bytes
  controlKey: string; // canonical unpadded base64url of exactly 32 bytes
  metaKey: string; // canonical unpadded base64url of exactly 32 bytes
  serverIdentityKey: {
    identityKeyId: string;
    algorithm: "Ed25519";
    publicKey: string; // unpadded base64url of the 32 raw public-key bytes
  };
  // Oldest trust anchor first, current certificate last.
  scopeCertificateChain: ServerScopeCertificateRecord[];
  keyAttestation: ViewerOnboardingKeyAttestationV1;
}

interface BrokerScopeCertificateUpdateRecord {
  certificateUpdateId: string;
  collaborationServerId: string;
  scopeCertificateId: string;
  supersedesScopeCertificateId: string;
  keyGeneration: number;
  certificateRef: string;
  certificateDigest: string;
}

interface BrokerHistoricalReattestationRecord {
  collaborationServerId: string;
  historicalRecordDigest: string;
  reattesterScopeCertificateId: string;
  reattesterKeyGeneration: number;
  historicalReattestationId: string;
  reattestationRef: string;
  reattestationDigest: string;
}

interface LogicalChatRecord {
  logicalChatId: string; // stable random rcl_<base64url-128-bit>
  collaborationServerId: string;
  projectId: string;
  projectTargetSelectorMappingId: string; // exact ptm_* generation selected at reservation
  state: "recovering" | "ready" | "quarantined" | "closed";
  topologyGeneration: number; // zero iff currentInwardEdgeId is null; positive iff it is present
  currentInwardEdgeId: string | null;
  currentNativeBindingId: string | null;
  parentChatId: string | null;
  nextViewerProjectionSeq: number;
}

interface BrokerChannelCursorV1 {
  version: 1;
  channelGeneration: number;
  frameIndex: number;
}

type BrokerRouteKind = "scope_bus" | "server_control" | "chat";

interface BrokerBackendCapabilityPinRecord {
  brokerBackendCapabilityPinId: string; // deterministic rbcp_*
  machineIdentityId: string;
  brokerOrigin: string; // canonical HTTP(S) origin
  brokerBackendSelector: "sqlite";
  canonicalPayloadSchemaId: "remote-claw/broker-backend-capabilities/v1";
  canonicalPayloadRef: string; // protected artifact in host_profile/default
  canonicalPayloadDigest: string;
  observedAtMs: number;
}

interface BrokerRouteRecord {
  brokerRouteId: string;
  machineIdentityId: string;
  collaborationServerId: string;
  routeKind: BrokerRouteKind;
  logicalChatId: string | null; // null exactly for scope_bus/server_control; required exactly for chat
  routeToken: string;
  brokerOrigin: string;
  brokerBackendSelector: "sqlite";
  brokerRouteStoreInstanceId: string; // immutable random rbsi_*
  genesisGeneration: 0;
  brokerBackendCapabilitiesRef: string;
  brokerBackendCapabilitiesDigest: string;
  coordinatorLeaseId: string;
  coordinatorEpoch: number;
  createdAtMs: number;
  state: "current" | "quarantined" | "closed";
}

interface BrokerChannelGenerationRecord {
  brokerRouteId: string;
  channelGeneration: number;
  frameCount: number | null;
  nextGeneration: number | null;
  state: "open" | "sealed";
  manifestDigest: string | null;
}

interface BrokerChannelManifestEquivocationRecord {
  manifestEquivocationId: string;
  brokerRouteId: string;
  channelGeneration: number;
  acceptedManifestDigest: string;
  conflictingManifestDigest: string | null;
  conflictingObservationDigest: string;
  conflictingFrameCount: number | null;
  conflictingNextGeneration: number | null;
  conflictingState: "open" | "sealed";
  evidenceRef: string;
  observedAtMs: number;
}

interface BrokerScopeBusCheckpointRecord {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/a1/scope-bus-checkpoint/v1";
  scopeBusCheckpointId: string;
  brokerRouteId: string;
  throughSealedGeneration: number;
  successorGeneration: number;
  sealedFrameCount: number;
  throughCursor: BrokerChannelCursorV1 | null;
  throughManifestDigest: string;
  issuedAtMs: number;
  signerSequence: number;
  serverKeyGeneration: number;
  signerIdentityKeyId: string;
  signerScopeCertificateId: string;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface AppliedScopeBusCheckpointRecord {
  brokerRouteId: string;
  scopeBusCheckpointId: string;
  effectiveStartGeneration: number;
  appliedAtMs: number;
}

interface AuthenticatedIngressResultRecord {
  ingressResultId: string;
  stableSemanticResultId: string;
  brokerRouteId: string;
  collaborationServerId: string;
  routeKind: "server_control" | "chat";
  logicalChatId: string | null;
  targetLogicalChatId: string | null;
  projectTargetSelectorMappingId: string | null;
  projectTargetSelectorMappingGeneration: number | null;
  sourceEventNamespaceId: string;
  msgId: string;
  recordKind: string;
  clientMsgId: string | null;
  expectedParts: number;
  sourcePayloadSchemaId: string | null;
  canonicalMessageDigestAlgorithm: "SHA-256";
  canonicalMessageDigest: string | null;
  sourceEventFingerprintSchemaId: "remote-claw/a1/source-event-fingerprint/v1" | null;
  sourceEventFingerprint: string | null;
  state: "assembling" | "awaiting_order" | "deciding" | "terminal";
  disposition:
    | "admitted"
    | "queued"
    | "rejected"
    | "quarantined_incomplete"
    | "quarantined_collision"
    | null;
  commandId: string | null;
  commandResultId: string | null;
  commandSeq: number | null;
  viewerProjectionSeq: number | null;
  readyAtJournalSeq: number | null;
  storedSemanticResultSchemaId: string | null;
  storedSemanticResultRef: string | null; // exact retained accepted/action-result/chat-creation-result payload bytes
  storedSemanticResultDigest: string | null;
  firstIngressCursor: BrokerChannelCursorV1;
  lastObservedIngressCursor: BrokerChannelCursorV1;
  terminalIngressCursor: BrokerChannelCursorV1 | null;
  assemblyDeadlineAtMs: number;
  collisionLatchedAtMs: number | null;
  terminalAtMs: number | null;
}

interface CollaborationCommandRecord {
  commandId: string;
  collaborationServerId: string;
  scopeKind: "server_control" | "chat";
  logicalChatId: string | null;
  targetLogicalChatId: string | null;
  sourceKind: "a1_ingress" | "official_client" | "automation" | "nested_server";
  sourceRef: string;
  sourceEventNamespaceId: string;
  sourceEventId: string;
  sourceCommandIdentityDigest: string;
  canonicalSourceEventDigest: string | null;
  mutationFamily: NativeMutationFamily;
  canonicalCommandPayloadSchemaId: string;
  canonicalCommandPayloadRef: string;
  canonicalCommandPayloadDigest: string;
  preDecisionNormalizationEvidenceSchemaId:
    | "remote-claw/opencode-pre-decision-normalization/v1"
    | null;
  preDecisionNormalizationEvidenceRef: string | null;
  preDecisionNormalizationEvidenceDigest: string | null;
  readyAtJournalSeq: number;
  commandSeq: number | null;
  disposition: "admitted" | "queued" | "rejected" | null;
  admittedTargetKind:
    | "native_server"
    | "native_binding"
    | "nested_management"
    | "nested_chat_edge"
    | null;
  targetCapabilitySnapshotId: string | null;
  targetCapabilityFamilyDigest: string | null;
  currentCommandResultId: string | null;
  decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1" | null;
  decisionEvidenceRef: string | null;
  decisionEvidenceDigest: string | null;
  canonicalCommandRecordDigest: string | null;
  state: "awaiting_order" | "decision_reserved" | "decided";
}

interface CollaborationCommandDecisionEvidence {
  schemaVersion: 1;
  decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  commandId: string;
  collaborationServerId: string;
  scopeKind: "server_control" | "chat";
  projectTargetSelectorMappingId: string | null;
  projectTargetSelectorMappingGeneration: number | null;
  projectTargetDigest: string | null;
  selectedTargetKind:
    | "native_server"
    | "native_binding"
    | "nested_management"
    | "nested_chat_edge"
    | null;
  selectedExecutorEvidenceSchemaId:
    | "remote-claw/executor-evidence/native-server/v1"
    | "remote-claw/executor-evidence/native-binding/v1"
    | "remote-claw/executor-evidence/nested-management/v1"
    | "remote-claw/executor-evidence/nested-chat-edge/v1"
    | null;
  selectedExecutorEvidenceRef: string | null;
  selectedExecutorEvidenceDigest: string | null;
  targetCapabilitySnapshotId: string | null;
  targetCapabilityFamilyDigest: string | null;
  decisionPolicyId: "remote-claw/common-adjudication-policy/v1";
}

interface OpenCodePreDecisionNormalizationEvidence {
  schemaVersion: 1;
  preDecisionNormalizationEvidenceSchemaId: "remote-claw/opencode-pre-decision-normalization/v1";
  commandId: string;
  sourceKind: "a1_ingress" | "official_client" | "automation" | "nested_server";
  sourceRef: string;
  sourcePayloadSchemaId: string;
  sourcePayloadDigest: string;
  sourceEventFingerprint: string;
  collaborationServerId: string;
  logicalChatId: string;
  nativeBindingId: string;
  runtimeId: string;
  nativeIncarnation: number;
  capabilitySnapshotId: string;
  capabilitySnapshotAttestationDigest: string;
  slashCommandNormalizationSchemaId: string;
  slashCommandNormalizationImplementationDigest: string;
  slashCommandTableDigest: string;
  classification: "submit_text" | "reserved_family" | "blank_rejected";
  normalizedMutationFamily: NativeMutationFamily;
  canonicalCommandPayloadSchemaId: string;
  canonicalCommandPayloadDigest: string;
}

interface NativeSlashCommandNormalizationItem {
  exactUtf8Text: string;
  normalizedMutationFamily: NativeMutationFamily;
}

type CollaborationCommandExecutorEvidence =
  | {
      schemaVersion: 1;
      selectedExecutorEvidenceSchemaId: "remote-claw/executor-evidence/native-server/v1";
      runtimeId: string;
      nativeIncarnation: number;
      nativeServerAttachmentLeaseId: string;
      serverFrontDoorLeaseId: string;
      nativeWorkspaceTransitionBarrierId: string;
      serverCapabilitySnapshotId: string;
      capabilitySnapshotAttestationDigest: string;
      projectTargetSelectorMappingId: string;
      projectTargetSelectorMappingGeneration: number;
      projectTargetDigest: string;
    }
  | {
      schemaVersion: 1;
      selectedExecutorEvidenceSchemaId: "remote-claw/executor-evidence/native-binding/v1";
      nativeBindingId: string;
      runtimeId: string;
      nativeIncarnation: number;
      attachmentLeaseId: string;
      nativeClientIngressLeaseId: string;
      capabilitySnapshotId: string;
      capabilitySnapshotAttestationDigest: string;
    }
  | {
      schemaVersion: 1;
      selectedExecutorEvidenceSchemaId: "remote-claw/executor-evidence/nested-management/v1";
      nestedServerManagementBindingId: string;
      nestedServerManagementLeaseId: string;
      leaseGeneration: number;
      sourceCoordinatorEpoch: number;
      targetCoordinatorEpoch: number;
      transportEpoch: number;
      mutualChannelBindingDigest: string;
      nestedServerManagementCapabilitySnapshotId: string;
      nestedServerManagementCapabilitySnapshotDigest: string;
    }
  | {
      schemaVersion: 1;
      selectedExecutorEvidenceSchemaId: "remote-claw/executor-evidence/nested-chat-edge/v1";
      inwardEdgeId: string;
      sourceTopologyGeneration: number;
      targetTopologyGeneration: number;
      currentConnectionEpoch: number;
      inwardLiveLeaseId: string;
      transportChannelBindingDigest: string;
      nestedChatEdgeCapabilitySnapshotId: string;
      nestedChatEdgeCapabilitySnapshotDigest: string;
      targetServerId: string;
      targetLogicalChatId: string;
      targetOutsideBindingId: string;
    };

interface CollaborationCommandCompoundSigningGroupRecord {
  compoundSigningGroupId: string;
  collaborationServerId: string;
  commandId: string;
  commandResultId: string;
  preparationGeneration: number;
  signingLeaseId: string;
  resultPreparationRef: string;
  requiredFinalizationArtifactKind:
    | "none"
    | "nested_management_lineage_hop"
    | "nested_chat_event_lineage_hop";
  secondaryPreparationRef: string | null;
  state:
    | "reserved"
    | "result_signed"
    | "both_signed"
    | "finalized"
    | "aborted";
}

interface CollaborationCommandResultPreparationRecord {
  commandResultId: string;
  collaborationServerId: string;
  commandId: string;
  canonicalCommandRecordDigest: string;
  resultVersion: 1;
  preparationGeneration: number;
  supersedesPreparationRef: string | null;
  canonicalPayloadRef: string;
  canonicalPayloadDigest: string;
  signerSequence: number;
  signatureReservationRef: string;
  compoundSigningGroupId: string;
  requiredFinalizationArtifactKind:
    | "none"
    | "nested_management_lineage_hop"
    | "nested_chat_event_lineage_hop";
  currentFinalizationArtifactPreparationRef: string | null;
  state: "reserved" | "bound" | "signed" | "aborted";
}

interface CollaborationCommandResultRecord {
  commandResultId: string;
  collaborationServerId: string;
  commandId: string;
  canonicalCommandRecordDigest: string;
  resultVersion: 1;
  supersedesCommandResultId: null;
  sourceKind: "a1_ingress" | "official_client" | "automation" | "nested_server";
  sourceRef: string;
  scopeKind: "server_control" | "chat";
  logicalChatId: string | null;
  targetLogicalChatId: string | null;
  commandSeq: number;
  disposition: "admitted" | "queued" | "rejected";
  canonicalPayloadSchemaId: "remote-claw/collaboration-command-result/v1";
  canonicalPayloadRef: string;
  canonicalPayloadDigest: string;
  signerSequence: number;
  serverKeyGeneration: number;
  signerIdentityKeyId: string;
  signerScopeCertificateId: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
  signedRecordDigest: string;
  createdAtMs: number;
}

interface CollaborationCommandResultDeliveryRecord {
  commandResultDeliveryId: string;
  commandResultId: string;
  targetKind: "a1_broker" | "official_client" | "automation" | "nested_server";
  targetBindingId: string;
  stableTargetResultId: string;
  targetPayloadRef: string;
  targetPayloadDigest: string;
  state: "ready" | "accepted" | "outcome_unknown";
}

interface CollaborationCommandResultDeliveryAttemptRecord {
  commandResultDeliveryAttemptId: string;
  commandResultDeliveryId: string;
  deliveryAttemptId: string;
  state: "pending" | "started" | "accepted" | "outcome_unknown";
  receiptRef: string | null;
}

interface IngressDeliveryCandidateRecord {
  ingressCandidateId: string;
  ingressResultId: string;
  deliveryAttemptId: string;
  expectedParts: number;
  receivedParts: number;
  firstIngressCursor: BrokerChannelCursorV1;
  lastObservedIngressCursor: BrokerChannelCursorV1;
  state: "assembling" | "complete" | "expired" | "collision";
}

interface IngressTransportAttemptRecord {
  brokerRouteId: string;
  machineIdentityId: string;
  collaborationServerId: string;
  routeKind: "server_control" | "chat";
  logicalChatId: string | null;
  sourceEventNamespaceId: string;
  deliveryAttemptId: string;
  ingressResultId: string;
  stableLogicalHeaderDigest: string;
  expectedParts: number;
}

interface AuthenticatedIngressPartRecord {
  ingressCandidateId: string;
  part: number;
  parts: number;
  authenticatedPartDigest: string;
  encryptedPartRef: string | null; // null only after retained digest-vector compaction
  firstIngressCursor: BrokerChannelCursorV1;
}

interface AuthenticatedChannelPositionRecord {
  channelPositionObservationId: string;
  brokerRouteId: string;
  cursor: BrokerChannelCursorV1;
  parsedMachineIdentityId: string | null;
  parsedCollaborationServerId: string | null;
  parsedLogicalChatId: string | null;
  dir: "in" | "out" | null;
  recordKind: string | null;
  msgId: string | null;
  deliveryAttemptId: string | null;
  part: number | null;
  parts: number | null;
  receivedFrameDigest: string;
  normalizedTransportFrameDigest: string | null;
  validationFailureCode: string | null;
  classification:
    | "inbound_ingress"
    | "known_host_output"
    | "unknown_outbound"
    | "invalid";
  ingressObservationId: string | null;
  hostOutputDeliveryId: string | null;
  cursorDisposition: "blocked" | "advanceable";
  recoveryDecisionId: string | null;
  recoveryGapId: string | null;
}

interface ChannelPositionEquivocationRecord {
  positionEquivocationId: string;
  channelPositionObservationId: string;
  acceptedReceivedFrameDigest: string;
  conflictingReceivedFrameDigest: string;
  conflictingFrameEvidenceRef: string;
  observedAtMs: number;
}

interface BrokerTransportKeyCollisionRecord {
  transportKeyCollisionId: string;
  brokerRouteId: string;
  deliveryAttemptId: string;
  part: number;
  originalCursor: BrokerChannelCursorV1;
  originalNormalizedFrameDigest: string;
  conflictingNormalizedFrameDigest: string;
  conflictingFrameEvidenceRef: string;
  observedAtMs: number;
}

interface HostOutputPartRecord {
  hostOutputDeliveryId: string;
  brokerRouteId: string;
  machineIdentityId: string;
  collaborationServerId: string;
  logicalChatId: string | null;
  msgId: string;
  deliveryAttemptId: string;
  part: number;
  parts: number;
  serverKeyGeneration: number;
  hostSignerIdentityKeyId: string;
  hostScopeCertificateId: string;
  hostSignatureSequence: number;
  hostSignature: string;
  hostSignedRecordDigest: string;
  transportFrameDigest: string;
  sealedFrameRef: string | null;
  state: "pending" | "published" | "observed";
}

interface HostOutputDeliveryRecord {
  hostOutputDeliveryId: string;
  sourceOutboxIntentRef: string;
  brokerRouteId: string;
  machineIdentityId: string;
  collaborationServerId: string;
  logicalChatId: string | null;
  recordKind: string;
  seq: number | null;
  msgId: string;
  deliveryAttemptId: string;
  clientMsgId: string | null;
  keyEpoch: 0;
  parts: number;
  serverKeyGeneration: number;
  hostSignerIdentityKeyId: string;
  hostScopeCertificateId: string;
  stableLogicalHeaderDigest: string;
  completePartVectorDigest: string | null;
  state: "preparing" | "ready" | "publishing" | "published" | "observed" | "quarantined";
}

interface AuthenticatedIngressObservationRecord {
  ingressObservationId: string;
  channelPositionObservationId: string;
  brokerRouteId: string;
  machineIdentityId: string;
  collaborationServerId: string;
  routeKind: "server_control" | "chat";
  logicalChatId: string | null;
  ingressResultId: string;
  ingressCandidateId: string;
  ingressCursor: BrokerChannelCursorV1;
  part: number;
  parts: number;
  authenticatedPartDigest: string;
  disposition:
    | "new_part"
    | "exact_duplicate_part"
    | "exact_transport_retry"
    | "completed_exact_replay"
    | "collision"
    | "late_after_tombstone";
  cursorDisposition: "blocked" | "advanceable";
  recoveryDecisionId: string | null;
}

interface ChannelPositionRecoveryRecord {
  recoveryDecisionId: string;
  brokerRouteId: string;
  channelPositionObservationId: string | null;
  manifestEquivocationId: string | null;
  transportKeyCollisionId: string | null;
  reason:
    | "semantic_collision"
    | "transport_collision"
    | "position_equivocation"
    | "manifest_equivocation"
    | "unknown_outbound"
    | "invalid_frame";
  decision: "discard_and_close_source" | "proved_safe_discard";
  evidenceRef: string;
  coordinatorEpoch: number;
  decidedAtMs: number;
}

interface IngressResultDeliveryRecord {
  resultDeliveryId: string;
  ingressResultId: string;
  triggerIngressObservationId: string;
  deliveryAttemptId: string;
  stableSemanticResultId: string;
  semanticResultPayloadSchemaId: string;
  semanticResultPayloadDigest: string;
  encryptedResultPayloadRef: string;
  encryptedResultPayloadDigest: string;
  state: "pending" | "published" | "superseded";
}

interface EncryptedChannelCursorRecord {
  brokerRouteId: string;
  contiguousThroughCursor: BrokerChannelCursorV1 | null;
}

interface NativeBindingRecord {
  nativeBindingId: string;
  collaborationServerId: string;
  logicalChatId: string;
  descriptor: NativeEngineDescriptor;
  projectId: string;
  // Both null while starting; both present before current.
  semanticConversationId: string | null;
  currentBindingIncarnationId: string | null;
  state: "starting" | "current" | "superseded" | "closed";
}

// Exact durable binding → runtime/incarnation/conversation join.
interface NativeBindingIncarnationRecord {
  nativeBindingIncarnationId: string;
  collaborationServerId: string;
  logicalChatId: string;
  nativeBindingId: string;
  runtimeId: string;
  nativeIncarnation: number;
  semanticConversationId: string;
  createdAtMs: number;
  closedAtMs: number | null;
  state: "current" | "superseded" | "closed";
}

interface OpenCodeBindingWorkspaceRecord {
  nativeBindingId: string;
  collaborationServerId: string;
  logicalChatId: string;
  projectTargetSelectorMappingId: string;
  projectTargetSelectorMappingGeneration: number;
  nativeWorkspaceBindingId: string;
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
  nativeEvidenceSchemaId: string;
  nativeEvidenceRef: string;
  nativeEvidenceDigest: string;
  observedAtMs: number;
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

interface NativeWorkspaceBindingRecord {
  nativeWorkspaceBindingId: string;
  runtimeId: string;
  nativeIncarnation: number;
  projectId: string;
  nativeWorkspaceId: string | null;
  directoryNormalizationSchemaId: string;
  canonicalDirectoryRef: string;
  canonicalDirectoryPathDigest: string;
  filesystemIdentitySchemaId: string;
  filesystemIdentityDigest: string;
  allowedRootDigest: string;
  mountNamespaceDigest: string;
  workspaceGeneration: number;
  evidenceRef: string;
  nativeWorkspaceBindingDigest: string;
  state: "current" | "superseded" | "closed";
}

interface ProjectTargetSelectorMappingRecord {
  projectTargetSelectorMappingId: string;
  collaborationServerId: string;
  projectId: string;
  workspaceSelectorId: string;
  target:
    | {
        kind: "terminal_native";
        descriptor: NativeEngineDescriptor;
        terminalProjectRef: string;
        nativeWorkspaceBindingId: string | null;
      }
    | {
        kind: "nested_server";
        nestedServerManagementBindingId: string;
        targetServerId: string;
        targetProjectId: string;
        targetWorkspaceSelectorId: string;
      };
  targetDigest: string;
  mappingGeneration: number;
  evidenceRef: string;
  state: "current" | "superseded" | "closed";
}

interface OpenCodeDiscoverySessionItem {
  sessionId: string;
  parentSessionId: string | null;
  nativeWorkspaceBindingId: string;
  createdAtMs: number;
  updatedAtMs: number;
  metadataDigest: string;
  statusDigest: string;
}

interface OpenCodeDiscoveryCreationMarkerItem {
  schemaVersion: 1;
  canonicalCreationMetadataSchemaId: "remote-claw/opencode-native-creation-metadata/v1";
  fullNativeMetadataSchemaId: "remote-claw/opencode-full-native-metadata-evidence/v1";
  remoteClawCreationId: string;
  remoteClawCreationIntentDigest: string | null;
  sessionId: string;
  creationMetadataClassification: "canonical_two_field" | "noncanonical_or_extra";
  canonicalCreationMetadataRef: string | null;
  canonicalCreationMetadataDigest: string | null;
  fullNativeMetadataRef: string;
  fullNativeMetadataDigest: string;
}

interface OpenCodeNativeStoreCoordinateRecord {
  schemaVersion: 1;
  nativeStoreCoordinateSchemaId: "remote-claw/opencode-native-store-coordinate/v1";
  runtimeId: string;
  nativeIncarnation: number;
  nativeServerAttachmentLeaseId: string;
  nativeWorkspaceBindingId: string;
  nativeStoreBackendSchemaId: string;
  canonicalNativeStoreRootRef: string;
  canonicalNativeStoreRootPathDigest: string;
  nativeStoreFilesystemIdentityRef: string;
  nativeStoreFilesystemIdentityDigest: string;
  nativeStoreDatabaseIdentityRef: string;
  nativeStoreDatabaseIdentityDigest: string;
  stableNativeStoreIdentityDigest: string;
  nativeStoreAttachmentAttestationSchemaId:
    "remote-claw/opencode-native-store-attachment-attestation/v1";
  nativeStoreAttachmentAttestationRef: string;
  nativeStoreAttachmentAttestationDigest: string;
  canonicalNativeStoreCoordinateDigest: string;
}

interface OpenCodeNativeStoreAttachmentAttestationRecord {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/opencode-native-store-attachment-attestation/v1";
  nativeStoreAttachmentAttestationId: string;
  assertion: "incarnation_opened_and_read_exact_store";
  runtimeId: string;
  nativeIncarnation: number;
  nativeServerAttachmentLeaseId: string;
  nativeWorkspaceBindingId: string;
  nativeStoreCoordinateSchemaId: "remote-claw/opencode-native-store-coordinate/v1";
  nativeStoreCoordinateDigest: string;
  stableNativeStoreIdentityDigest: string;
  openedStoreHandleIdentityDigest: string;
  storeReadWitnessSchemaId: "remote-claw/opencode-native-store-read-witness/v1";
  storeReadWitnessRef: string;
  storeReadWitnessDigest: string;
  continuityRegistrySchemaId: "remote-claw/native-store-continuity-registry/v1";
  continuityRegistryId: string;
  currentWriterGeneration: number;
  currentWriterRegistrationDigest: string;
  runtimeOwnerTrustAttestationDigest: string;
  runtimeOwnerIdentityKeyId: string;
  runtimeOwnerKeyGeneration: number;
  signerSequence: number;
  issuedAtMs: number;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
  signedRecordDigest: string;
}

interface NativeObserverStreamEpochRecord {
  observerStreamEpochId: string;
  nativeRuntimeObserverLeaseId: string;
  observerGeneration: number;
  eventStreamEpoch: number;
  nativeWorkspaceBindingId: string;
  nextObservationSeq: number;
  openedAtMs: number;
  state: "open" | "closed" | "gap";
  recoveryGapId: string | null;
}

interface NativeObserverObservationRecord {
  observerStreamEpochId: string;
  observationSeq: number;
  nativeEventId: string | null;
  rawEventDigest: string;
  rawEventRef: string;
  classification: "parsed" | "unknown" | "invalid";
  parsedEventSchemaId: string | null;
  parsedEventDigest: string | null;
  validationFailureCode: string | null;
  recoveryGapId: string | null;
  receivedAtMs: number;
}

interface NativeFilteredObserverObservationRecord {
  filteredObservationId: string;
  collaborationServerId: string | null;
  nativeRuntimeObserverLeaseId: string;
  observerGeneration: number;
  observerStreamEpochId: string;
  observationSeq: number;
  rawEventDigest: string;
  filteringPolicyRef: string;
  filteringPolicyDigest: string;
  nativeWorkspaceBindingId: string;
  resolvedNativeConversationId: string | null;
  resolvedChildConversationId: string | null;
  resolvedNativeBindingId: string | null;
  resolvedLogicalChatId: string | null;
  resolvedNativeActionId: string | null;
  disposition: "projectable" | "internal_only" | "rejected_global" | "gap";
  decisionEvidenceRef: string;
  decisionEvidenceDigest: string;
  canonicalFilteredObservationDigest: string;
  recoveryGapId: string | null;
}

interface NativeObserverOverlapBufferRecord {
  overlapBufferId: string;
  observerStreamEpochId: string;
  startObservationSeq: number;
  endObservationSeqExclusive: number | null;
  maxEvents: number;
  maxBytes: number;
  retainedBytes: number;
  state: "collecting" | "sealed" | "gap";
  recoveryGapId: string | null;
  gapEvidenceRef: string | null;
}

interface NativeObserverStatusSnapshotRecord {
  nativeStatusSnapshotId: string;
  nativeRuntimeObserverLeaseId: string;
  observerStreamEpochId: string;
  nativeWorkspaceBindingId: string;
  canonicalStatusRef: string;
  statusSnapshotDigest: string;
  capturedThroughObservationSeq: number | null;
}

interface OpenCodeDiscoverySnapshotRecord {
  discoverySnapshotId: string;
  runtimeId: string;
  nativeIncarnation: number;
  nativeWorkspaceBindingId: string;
  nativeStoreCoordinateSchemaId: "remote-claw/opencode-native-store-coordinate/v1";
  nativeStoreCoordinateRef: string;
  nativeStoreCoordinateDigest: string;
  stableNativeStoreIdentityDigest: string;
  nativeStoreAttachmentAttestationSchemaId:
    "remote-claw/opencode-native-store-attachment-attestation/v1";
  nativeStoreAttachmentAttestationRef: string;
  nativeStoreAttachmentAttestationDigest: string;
  nativeRuntimeObserverLeaseId: string;
  observerGeneration: number;
  eventStreamEpoch: number;
  provedReadOperationVectorDigest: string;
  linearizationProofKind: "sequence_watermark" | "barrier_event" | "atomic_store_snapshot";
  linearizationProofRef: string;
  linearizationProofDigest: string;
  postSnapshotBarrierObservationSeq: number | null;
  overlapBufferId: string;
  overlapStartObservationSeq: number;
  overlapEndObservationSeqExclusive: number;
  nativeStatusSnapshotId: string;
  statusSnapshotDigest: string;
  orderedSessionVectorRef: string;
  orderedSessionVectorDigest: string;
  orderedCreationMarkerVectorRef: string;
  orderedCreationMarkerVectorDigest: string;
  canonicalSnapshotDigest: string;
  capturedAtMs: number;
  completeness: "complete" | "gap";
  state: "current" | "superseded";
}

interface OpenCodeHistoryMessageItem {
  nativeConversationId: string;
  nativeMessageId: string;
  messageIndex: number;
  role: "user" | "assistant";
  nativeTimestampDigest: string;
  metadataDigest: string;
}

interface OpenCodeHistoryPartItem {
  nativeConversationId: string;
  nativeMessageId: string;
  nativePartId: string;
  messageIndex: number;
  partIndex: number;
  partType: string;
  canonicalPartPayloadSchemaId: string;
  canonicalPartPayloadRef: string;
  canonicalPartPayloadDigest: string;
}

interface OpenCodeConversationHistorySnapshotRecord {
  nativeHistorySnapshotId: string;
  runtimeId: string;
  nativeIncarnation: number;
  nativeBindingId: string;
  nativeConversationId: string;
  nativeWorkspaceBindingId: string;
  nativeRuntimeObserverLeaseId: string;
  observerGeneration: number;
  observerStreamEpochId: string;
  overlapBufferId: string;
  overlapStartObservationSeq: number;
  overlapEndObservationSeqExclusive: number;
  nativeStatusSnapshotId: string;
  statusSnapshotDigest: string;
  linearizationProofKind: "sequence_watermark" | "barrier_event" | "atomic_store_snapshot";
  linearizationProofRef: string;
  linearizationProofDigest: string;
  linearizedThroughObservationSeq: number | null;
  postSnapshotBarrierObservationSeq: number | null;
  orderedMessageVectorRef: string;
  orderedMessageVectorDigest: string;
  orderedPartVectorRef: string;
  orderedPartVectorDigest: string;
  canonicalSnapshotDigest: string;
  capturedAtMs: number;
  completeness: "complete" | "gap";
}

interface NativeRuntimeObserverLease {
  nativeRuntimeObserverLeaseId: string;
  runtimeId: string;
  nativeIncarnation: number;
  nativeServerAttachmentLeaseId: string;
  observerGeneration: number;
  currentObserverStreamEpochId: string | null;
  serverCapabilitySnapshotId: string;
  capabilitySnapshotAttestationRef: string;
  capabilitySnapshotAttestationDigest: string;
  nativeWorkspaceBindingId: string;
  endpointRef: string;
  credentialHandle: string;
  peerBindingEvidenceRef: string;
  listenerRouteManifestDigest: string;
  runtimeIsolationAttestationRef: string;
  runtimeIsolationAttestationDigest: string;
  provedReadOperationVectorDigest: string;
  filteringSchemaId: string;
  filteringPolicyRef: string;
  filteringPolicyDigest: string;
  state: "current" | "superseded" | "closed";
}

interface NativeObserverFilteringPolicy {
  schemaVersion: 1;
  filteringSchemaId: string;
  nativeWorkspaceBindingId: string;
  topLevelSessionBindingVectorRef: string;
  topLevelSessionBindingVectorDigest: string;
  childLineageClassifierSchemaId: string;
  childLineagePolicyRef: string;
  childLineagePolicyDigest: string;
  actionCorrelationSchemaId: string;
  actionCorrelationPolicyRef: string;
  actionCorrelationPolicyDigest: string;
  globalEventRejectionPolicyRef: string;
  globalEventRejectionPolicyDigest: string;
}

interface NativeObserverTopLevelSessionBindingItem {
  nativeConversationId: string;
  nativeBindingId: string;
  collaborationServerId: string;
  logicalChatId: string;
  nativeWorkspaceBindingId: string;
}

interface NativeTransportAttachmentRecord {
  attachmentId: string;
  nativeBindingId: string;
  kind: "claude-inner-rc" | "app-server" | "server" | "tmux";
  transportId: string;
  generation: number;
  currentAttachmentLeaseId: string | null;
  resourceOwnership: "dedicated_runtime" | "shared_runtime";
  createdAtMs: number;
  closedAtMs: number | null;
  state: "current" | "superseded" | "closed";
}

interface NativeTransportLeaseRecord {
  attachmentLeaseId: string;
  attachmentId: string;
  nativeBindingIncarnationId: string;
  runtimeId: string;
  nativeIncarnation: number;
  runtimeOwnerServiceLeaseId: string;
  runtimeOwnerServiceEpoch: number;
  coordinatorLeaseId: string;
  coordinatorEpoch: number;
  transportEpoch: number;
  currentCapabilitySnapshotId: string | null;
  currentNativeClientIngressLeaseId: string | null;
  acquiredAtMs: number;
  releasedAtMs: number | null;
  state: "current" | "superseded" | "closed";
}

interface NativeBindingRuntimeGateRecord {
  collaborationServerId: string;
  logicalChatId: string;
  nativeBindingId: string;
  runtimeId: string;
  nativeIncarnation: number;
  nativeBindingIncarnationId: string;
  attachmentId: string;
  currentAttachmentLeaseId: string | null;
  phase: "starting" | "recovering" | "ready" | "draining" | "closed";
  disconnectPolicy: "detach" | "terminate_when_idle";
  gateGeneration: number;
  updatedAtMs: number;
}

type NativeMutationFamily =
  | "user_text"
  | "steer_text"
  | "blank_submit"
  | "attachment"
  | "new_chat"
  | "clear"
  | "interrupt"
  | "compact"
  | "permission_answer"
  | "question_answer"
  | "set_model"
  | "set_mode"
  | "end"
  | "fork"
  | "archive"
  | "unarchive"
  | "revert"
  | "unrevert"
  | "shell"
  | "session_command"
  | "message_mutation"
  | "part_mutation"
  | "share"
  | "rename"
  | "delete";

type NativeServerMutationFamily = "new_chat";
type NativeBindingMutationFamily = Exclude<NativeMutationFamily, NativeServerMutationFamily>;
type CanonicalAttachmentMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif";

interface CanonicalAttachmentItemRecord {
  schemaVersion: 1;
  canonicalItemSchemaId: "remote-claw/command-payload/attachment-item/v1";
  itemIndex: number;
  clientFileName: string;
  mediaType: CanonicalAttachmentMediaType;
  contentLength: number;
  contentRef: string;
  contentDigest: string;
  canonicalItemDigest: string;
}

interface CanonicalAttachmentCommandPayloadRecord {
  schemaVersion: 1;
  canonicalCommandPayloadSchemaId: "remote-claw/command-payload/attachment/v1";
  caption: string | null;
  itemVectorRef: string;
  itemVectorDigest: string;
  itemCount: number;
  canonicalCommandPayloadDigest: string;
}

type NativeWorkspaceTransitionKind =
  | "create"
  | "import"
  | "switch"
  | "clear"
  | "fork"
  | "archive"
  | "unarchive"
  | "first_bootstrap";
type NativeWorkspaceTransitionClassification =
  | NativeWorkspaceTransitionKind
  | "from_creation_intent";

interface NativeMutationFamilyCapability {
  mutationFamily: NativeMutationFamily;
  capabilityFamilyDigest: string;
  capabilityScope: "server" | "binding";
  canonicalCommandPayloadSchemaId: string;
  nativeRequestTranslatorSchemaId: string;
  nativeRequestTranslatorImplementationDigest: string;
  nativeRequestTranslatorBuildManifestDigest: string;
  nativeRequestTranslatorDigest: string;
  translationInjectivityProofRef: string;
  translationInjectivityProofDigest: string;
  manifestEntryDigest: string;
  nativeOperationCoordinateDigest: string;
  nativeMethod: string;
  nativeRouteSchemaId: string;
  canonicalQuerySchemaId: string;
  canonicalHeaderSchemaId: string;
  canonicalBodySchemaId: string;
  targetScope: "runtime" | "server" | "session" | "child" | "permission" | "question";
  canonicalRequestSchemaId: string;
  transportReceiptSemantics: "none" | "receipt_only" | "terminal";
  nativeActionIdRequirement: "required" | "optional" | "unavailable";
  positiveReadBackSchemaId: string;
  positiveNeverStartedSchemaId: string | null;
  sourceCausality: "proved" | "native_outcome_only" | "unproved";
  proofTupleDigest: string;
  evidenceDigest: string;
  evidenceRef: string;
}

interface NativeOperationClassification {
  operationCoordinateDigest: string;
  operationEntryDigest: string;
  manifestEntryDigest: string;
  nativeMethod: string;
  nativeRouteSchemaId: string;
  canonicalQuerySchemaId: string;
  canonicalHeaderSchemaId: string;
  canonicalBodySchemaId: string;
  targetScope: "runtime" | "server" | "session" | "child" | "permission" | "question";
  classification:
    | "proved_read"
    | "tui_only"
    | "collaborator_family"
    | "runtime_management"
    | "rejected";
  mutationFamily: NativeMutationFamily | null;
  familyCapabilityDigest: string | null;
  tuiPolicy: "pass" | "virtualize" | "reject" | "not_applicable";
  workspaceTransitionKind: NativeWorkspaceTransitionClassification | null;
}

interface NativeListenerRouteManifestEntry {
  manifestEntryDigest: string;
  frontDoorKind: "tui" | "binding_adapter" | "server_creation" | "observer";
  frontDoorListenerIdentityDigest: string;
  authorizationHandlerIdentityDigest: string;
  source: "openapi" | "raw" | "upgrade" | "fallback";
  transport: "http" | "websocket" | "stream";
  nativeMethod: string;
  canonicalPathTemplate: string;
  routeParserSchemaId: string;
  pathNormalizationSchemaId: string;
  queryParserSchemaId: string;
  headerParserSchemaId: string;
  bodyParserSchemaId: string;
  handlerIdentityDigest: string;
  registrationOrder: number;
  matchPriority: number;
  fallbackOnly: boolean;
}

interface NativeListenerRouteManifestRecord {
  nativeListenerRouteManifestDigest: string;
  descriptor: NativeEngineDescriptor;
  engineVersion: string;
  nativeBinaryDigest: string;
  frontDoorBinaryDigest: string;
  frontDoorBuildManifestRef: string;
  frontDoorBuildManifestDigest: string;
  surfaceSchemaKind: "openapi" | "json_rpc" | "intercept_manifest";
  generatedSurfaceSchemaDigest: string;
  buildRouteRegistryDigest: string;
  routeResolutionSchemaId: string;
  runtimeRegistrationAttestationRef: string;
  runtimeRegistrationAttestationDigest: string;
  orderedEntryDigests: readonly string[];
}

interface NativeListenerRuntimeRegistrationAttestation {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/native-listener-registration-attestation/v1";
  runtimeId: string;
  nativeIncarnation: number;
  descriptor: NativeEngineDescriptor;
  engineVersion: string;
  nativeBinaryDigest: string;
  frontDoorBinaryDigest: string;
  frontDoorBuildManifestDigest: string;
  surfaceSchemaKind: "openapi" | "json_rpc" | "intercept_manifest";
  generatedSurfaceSchemaDigest: string;
  buildRouteRegistryDigest: string;
  routeResolutionSchemaId: string;
  orderedEntryVectorDigest: string;
  measuredDispatchTableDigest: string;
  runtimeOwnerIdentityKeyId: string;
  runtimeOwnerKeyGeneration: number;
  signerSequence: number;
  issuedAtMs: number;
  canonicalPayloadDigest: string;
  signature: string;
}

type NativeRuntimeIsolationRole =
  | "tui_front_door"
  | "binding_adapter_front_door"
  | "server_creation_front_door"
  | "observer_front_door";

interface NativeRuntimeIsolationRoleManifestItem {
  schemaVersion: 1;
  canonicalItemSchemaId: "remote-claw/native-runtime-isolation-role-manifest-item/v1";
  role: NativeRuntimeIsolationRole;
  manifestPosition: number;
  manifestEntryDigest: string;
  operationEntryDigest: string;
  handlerIdentityDigest: string;
  canonicalItemDigest: string;
}

interface NativeRuntimeIsolationAuthorizationHandlerItem {
  schemaVersion: 1;
  canonicalItemSchemaId: "remote-claw/native-runtime-isolation-authorization-handler-item/v1";
  role: NativeRuntimeIsolationRole;
  manifestPosition: number;
  operationEntryDigest: string;
  authorizationHandlerDigest: string;
  authorizationPolicyDigest: string;
  canonicalItemDigest: string;
}

interface NativeRuntimeIsolationPeerItem {
  role: NativeRuntimeIsolationRole;
  tgid: number;
  pidfdIdentityDigest: string;
  processStartTimeTicks: number;
  cgroupIdentityDigest: string;
  executableImageDigest: string;
  frontDoorBinaryDigest: string;
  frontDoorBuildManifestDigest: string;
  runtimeRegistrationAttestationDigest: string;
  roleManifestEntryVectorRef: string;
  roleManifestEntryVectorDigest: string;
  authorizationHandlerVectorRef: string;
  authorizationHandlerVectorDigest: string;
}

interface NativeRuntimeIsolationProviderPeer {
  schemaVersion: 1;
  canonicalPeerSchemaId: "remote-claw/native-runtime-isolation-provider-peer/v1";
  runtimeId: string;
  nativeIncarnation: number;
  tgid: number;
  pidfdIdentityDigest: string;
  processStartTimeTicks: number;
  cgroupIdentityDigest: string;
  executableImageDigest: string;
  providerFacadeSocketIdentityDigest: string;
  providerFacadePolicyMapEntryDigest: string;
  descendantDenialPolicyDigest: string;
  canonicalPeerDigest: string;
}

interface NativeRuntimeIsolationAttestation {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/native-runtime-isolation-attestation/v1";
  runtimeIsolationAttestationId: string;
  runtimeId: string;
  nativeIncarnation: number;
  descriptor: NativeEngineDescriptor;
  rawListenerSocketIdentityDigest: string;
  rawListenerSocketInode: number;
  rawListenerSocketEvidenceRef: string;
  allowedRawListenerPeerVectorRef: string;
  allowedRawListenerPeerVectorDigest: string;
  processIdentityPolicySchemaId: "remote-claw/exact-process-socket-policy/v1";
  attachBeforeRunProgramDigest: string;
  installedPolicyMapDigest: string;
  descendantDenialPolicyDigest: string;
  processIdentityPolicyEvidenceRef: string;
  toolNamespacePolicyDigest: string;
  toolNamespacePolicyEvidenceRef: string;
  providerFacadeSocketIdentityDigest: string;
  providerFacadeAllowedProcessRef: string;
  providerFacadeAllowedProcessDigest: string;
  providerFacadeExactProcessPolicyDigest: string;
  providerFacadePolicyEvidenceRef: string;
  networkNamespaceDigest: string;
  mountNamespaceDigest: string;
  runtimeOwnerIdentityKeyId: string;
  runtimeOwnerKeyGeneration: number;
  signerSequence: number;
  issuedAtMs: number;
  canonicalPayloadDigest: string;
  signature: string;
  signedRecordDigest: string;
}

interface NativeCapabilitySnapshotAttestation {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/native-capability-snapshot-attestation/v1";
  capabilitySnapshotAttestationId: string;
  snapshotKind: "server" | "binding" | "tui_policy";
  snapshotId: string;
  canonicalSnapshotSchemaId:
    | "remote-claw/native-server-capability-snapshot/v1"
    | "remote-claw/native-binding-capability-snapshot/v1"
    | "remote-claw/native-tui-policy-snapshot/v1";
  canonicalSnapshotDigest: string;
  runtimeId: string;
  nativeIncarnation: number;
  runtimeOwnerIdentityKeyId: string;
  runtimeOwnerKeyGeneration: number;
  signerSequence: number;
  issuedAtMs: number;
  canonicalPayloadDigest: string;
  signature: string;
  signedRecordDigest: string;
}

interface NativeBindingCapabilitySnapshot {
  capabilitySnapshotId: string;
  schemaVersion: 1;
  canonicalSnapshotSchemaId: "remote-claw/native-binding-capability-snapshot/v1";
  nativeBindingId: string;
  runtimeId: string;
  nativeIncarnation: number;
  attachmentLeaseId: string;
  capabilityGeneration: number;
  descriptor: NativeEngineDescriptor;
  engineVersion: string;
  nativeSurfaceSchemaId: string;
  nativeSurfaceSchemaDigest: string;
  nativeListenerRouteManifestRef: string;
  nativeListenerRouteManifestDigest: string;
  runtimeIsolationAttestationRef: string;
  runtimeIsolationAttestationDigest: string;
  operationClassificationVectorRef: string;
  operationClassificationVectorDigest: string;
  familyCapabilities: readonly NativeMutationFamilyCapability[];
  familyCapabilityVectorDigest: string;
  slashCommandNormalizationSchemaId: string;
  slashCommandNormalizationImplementationDigest: string;
  slashCommandTableRef: string;
  slashCommandTableDigest: string;
  proofTupleDigest: string;
  evidenceRef: string;
  evidenceDigest: string;
  runtimeOwnerAttestationRef: string;
  runtimeOwnerAttestationDigest: string;
  canonicalSnapshotDigest: string;
  verifiedAtMs: number;
  state: "current" | "superseded" | "revoked";
}

interface NativeServerAttachmentLease {
  nativeServerAttachmentLeaseId: string;
  runtimeId: string;
  nativeIncarnation: number;
  descriptor: NativeEngineDescriptor;
  transportId: string;
  currentServerCapabilitySnapshotId: string | null;
  currentTuiPolicySnapshotId: string | null;
  currentTuiProcessIngressLeaseId: string | null;
  currentServerFrontDoorLeaseId: string | null;
  currentWorkspaceTransitionBarrierId: string | null;
  currentDiscoverySnapshotId: string | null;
  currentRuntimeObserverLeaseId: string | null;
  state: "current" | "superseded" | "closed";
}

interface NativeServerCapabilitySnapshot {
  serverCapabilitySnapshotId: string;
  schemaVersion: 1;
  canonicalSnapshotSchemaId: "remote-claw/native-server-capability-snapshot/v1";
  runtimeId: string;
  nativeIncarnation: number;
  nativeServerAttachmentLeaseId: string;
  capabilityGeneration: number;
  descriptor: NativeEngineDescriptor;
  engineVersion: string;
  nativeSurfaceSchemaId: string;
  nativeSurfaceSchemaDigest: string;
  nativeListenerRouteManifestRef: string;
  nativeListenerRouteManifestDigest: string;
  runtimeIsolationAttestationRef: string;
  runtimeIsolationAttestationDigest: string;
  operationClassificationVectorRef: string;
  operationClassificationVectorDigest: string;
  familyCapabilities: readonly NativeMutationFamilyCapability[];
  familyCapabilityVectorDigest: string;
  proofTupleDigest: string;
  evidenceRef: string;
  evidenceDigest: string;
  runtimeOwnerAttestationRef: string;
  runtimeOwnerAttestationDigest: string;
  canonicalSnapshotDigest: string;
  verifiedAtMs: number;
  state: "current" | "superseded" | "revoked";
}

interface NativeClientIngressLease {
  nativeClientIngressLeaseId: string;
  runtimeId: string;
  nativeIncarnation: number;
  sourceKind: "remote-claw-adapter";
  nativeBindingId: string;
  nativeConversationId: string;
  nativeWorkspaceBindingId: string;
  canonicalDirectoryPathDigest: string;
  nativeWorkspaceBindingDigest: string;
  endpointRef: string;
  credentialHandle: string;
  peerBindingEvidenceRef: string;
  attachmentLeaseId: string;
  allowedMutationFamilies: readonly NativeBindingMutationFamily[];
  state: "current" | "superseded" | "closed";
}

interface NativeTuiProcessIngressLease {
  nativeTuiProcessIngressLeaseId: string;
  runtimeId: string;
  nativeIncarnation: number;
  descriptor: NativeEngineDescriptor;
  nativeServerAttachmentLeaseId: string;
  nativeWorkspaceBindingId: string;
  canonicalDirectoryPathDigest: string;
  nativeWorkspaceBindingDigest: string;
  endpointRef: string;
  credentialHandle: string;
  peerBindingEvidenceRef: string;
  tuiPolicySnapshotId: string;
  currentTuiSessionIngressBindingId: string | null;
  state: "current" | "superseded" | "closed";
}

interface NativeTuiSessionIngressBinding {
  nativeTuiSessionIngressBindingId: string;
  nativeTuiProcessIngressLeaseId: string;
  localNativeConversationId: string;
  nativeConversationId: string;
  nativeWorkspaceBindingId: string;
  importedThroughLocalTransitionSeq: number;
  state: "current" | "superseded" | "closed";
}

interface NativeTuiPolicySnapshot {
  tuiPolicySnapshotId: string;
  schemaVersion: 1;
  canonicalSnapshotSchemaId: "remote-claw/native-tui-policy-snapshot/v1";
  runtimeId: string;
  nativeIncarnation: number;
  nativeServerAttachmentLeaseId: string;
  policyGeneration: number;
  descriptor: NativeEngineDescriptor;
  engineVersion: string;
  nativeSurfaceSchemaId: string;
  nativeSurfaceSchemaDigest: string;
  nativeListenerRouteManifestRef: string;
  nativeListenerRouteManifestDigest: string;
  runtimeIsolationAttestationRef: string;
  runtimeIsolationAttestationDigest: string;
  operationClassificationVectorRef: string;
  operationClassificationVectorDigest: string;
  virtualizationSchemaId: "none";
  virtualizationVectorRef: null;
  virtualizationVectorDigest: null;
  virtualizationPolicyDigest: string;
  unsupportedResponseSchemaId: string;
  unsupportedResponseVectorRef: string;
  unsupportedResponseVectorDigest: string;
  tuiReadPolicyVectorRef: string;
  tuiReadPolicyVectorDigest: string;
  proofTupleDigest: string;
  evidenceRef: string;
  evidenceDigest: string;
  runtimeOwnerAttestationRef: string;
  runtimeOwnerAttestationDigest: string;
  canonicalSnapshotDigest: string;
  verifiedAtMs: number;
  state: "current" | "superseded" | "revoked";
}

interface NativeTuiUnsupportedResponseItem {
  operationEntryDigest: string;
  statusCode: number;
  canonicalHeaderSchemaId: string;
  canonicalHeaderRef: string;
  canonicalHeaderDigest: string;
  canonicalBodySchemaId: string;
  canonicalBodyRef: string;
  canonicalBodyDigest: string;
}

interface NativeTuiReadPolicyItem {
  operationEntryDigest: string;
  canonicalQueryScopeSchemaId: string;
  responseParserSchemaId: string;
  responseSchemaId: string;
  redactionSchemaId: string;
  dataSource: "sealed_synthetic_view" | "proved_native_state";
  nativeWorkspaceBindingId: string;
  evidenceRef: string;
  evidenceDigest: string;
}

interface NativeServerFrontDoorLease {
  nativeServerFrontDoorLeaseId: string;
  runtimeId: string;
  nativeIncarnation: number;
  descriptor: NativeEngineDescriptor;
  nativeWorkspaceBindingId: string;
  canonicalDirectoryPathDigest: string;
  nativeWorkspaceBindingDigest: string;
  endpointRef: string;
  credentialHandle: string;
  peerBindingEvidenceRef: string;
  nativeServerAttachmentLeaseId: string;
  allowedMutationFamilies: readonly NativeServerMutationFamily[];
  state: "current" | "superseded" | "closed";
}

interface NativeDeliveryAttemptRecord {
  nativeDeliveryAttemptId: string;
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  decisionEvidenceDigest: string;
  collaborationServerId: string;
  logicalChatId: string;
  nativeBindingId: string;
  descriptor: NativeEngineDescriptor;
  runtimeId: string;
  nativeIncarnation: number;
  nativeConversationId: string;
  attachmentLeaseId: string;
  nativeClientIngressLeaseId: string;
  capabilitySnapshotId: string;
  capabilitySnapshotAttestationDigest: string;
  capabilityFamilyDigest: string;
  mutationFamily: NativeBindingMutationFamily;
  canonicalCommandPayloadSchemaId: string;
  canonicalCommandPayloadDigest: string;
  nativeRequestTranslatorDigest: string;
  nativeActionId: string | null;
  nativeMethod: string;
  nativeRouteSchemaId: string;
  canonicalRequestSchemaId: string;
  canonicalRequestRef: string;
  canonicalRequestDigest: string;
  nativeRequestTranslationSchemaId: "remote-claw/native-request-translation/v1";
  nativeRequestTranslationRef: string;
  nativeRequestTranslationDigest: string;
  nativeTargetPathDigest: string;
  positiveReadBackSchemaId: string;
  expectedNativePartCount: number | null;
  expectedNativePartFingerprintSchemaId: string | null;
  expectedNativePartFingerprintVectorRef: string | null;
  expectedNativePartFingerprintVectorDigest: string | null;
  state:
    | "prepared"
    | "claimed"
    | "started"
    | "transport_receipt"
    | "native_observed"
    | "completed"
    | "rejected"
    | "quarantined"
    | "outcome_unknown";
  claimedByCoordinatorEpoch: number | null;
  transportReceiptRef: string | null;
  nativeReadBackEvidenceRef: string | null;
  nativeReadBackEvidenceDigest: string | null;
  outcomeEvidenceSchemaId: string | null;
  outcomeEvidenceRef: string | null;
  outcomeEvidenceDigest: string | null;
}

interface OpenCodeNativeReadBackPartItem {
  nativeConversationId: string;
  nativeActionId: string;
  nativePartId: string;
  nativePartIndex: number;
  role: "user";
  partType: "text";
  canonicalTextRef: string;
  canonicalTextDigest: string;
  expectedPartFingerprintDigest: string;
  historySnapshotDigest: string;
  filteredSseObservationRef: string | null;
  filteredSseObservationDigest: string | null;
  nativeOrderCoordinateDigest: string;
  observedPartFingerprintDigest: string;
}

interface OpenCodeNativeOrderEvidence {
  schemaVersion: 1;
  canonicalOrderEvidenceSchemaId: "remote-claw/opencode-native-order-evidence/v1";
  nativeHistorySnapshotId: string;
  historySnapshotDigest: string;
  nativeMessageId: string;
  messageIndex: number;
  nativePartId: string;
  partIndex: number;
  linearizationProofKind: "sequence_watermark" | "barrier_event" | "atomic_store_snapshot";
  linearizationProofDigest: string;
  linearizedThroughObservationSeq: number | null;
  filteredSseObservationDigest: string | null;
  nativeOrderEvidenceDigest: string;
}

interface OpenCodeNativeReadBackEvidenceRecord {
  schemaVersion: 1;
  nativeReadBackSchemaId: "remote-claw/opencode-user-text-read-back/v1";
  nativeReadBackEvidenceId: string;
  nativeDeliveryAttemptId: string;
  runtimeId: string;
  nativeIncarnation: number;
  nativeBindingId: string;
  nativeConversationId: string;
  nativeWorkspaceBindingId: string;
  nativeRuntimeObserverLeaseId: string;
  observerGeneration: number;
  nativeActionId: string;
  nativeHistorySnapshotId: string;
  historySnapshotRef: string;
  historySnapshotDigest: string;
  observerStreamEpochId: string;
  throughObservationSeq: number | null;
  sameMessageHistoryPartVectorDigest: string;
  sameMessageHistoryPartCount: number;
  observedPartVectorRef: string;
  observedPartVectorDigest: string;
  observedPartCount: number;
  expectedPartFingerprintVectorDigest: string;
  nativeOrderEvidenceRef: string | null;
  nativeOrderEvidenceDigest: string | null;
  canonicalEvidenceDigest: string;
  outcome: "exactly_one_applied" | "mismatch" | "ambiguous";
}

interface NativeCommandEffectGateRecord {
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  decisionEvidenceDigest: string;
  collaborationServerId: string;
  logicalChatId: string;
  state: "never_started" | "started" | "completed" | "quarantined" | "outcome_unknown";
  startedAttemptId: string | null;
  outcomeEvidenceSchemaId: string | null;
  outcomeEvidenceRef: string | null;
  outcomeEvidenceDigest: string | null;
}

interface NativeFrontDoorDispatchRecord {
  nativeDeliveryAttemptId: string;
  nativeClientIngressLeaseId: string;
  nativeTargetPathDigest: string;
  canonicalRequestDigest: string;
  nativeRequestTranslationDigest: string;
  dispatchAuthorizationRef: {
    protectedHandleId: string;
    kind: "dispatch_authorization";
  };
  canonicalDispatchDigest: string;
  dispatchState: "not_started" | "started" | "completed" | "quarantined" | "outcome_unknown";
  dispatchStartedAtMs: number | null;
  nativeReceiptRef: string | null;
  outcomeEvidenceSchemaId: string | null;
  outcomeEvidenceRef: string | null;
  outcomeEvidenceDigest: string | null;
}

interface NativeBindingPreSendAbandonmentRecord {
  schemaVersion: 1;
  canonicalEvidenceSchemaId: "remote-claw/native-binding-pre-send-abandonment/v1";
  nativePreSendAbandonmentId: string;
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  decisionEvidenceDigest: string;
  collaborationServerId: string;
  logicalChatId: string;
  nativeBindingId: string;
  runtimeId: string;
  nativeIncarnation: number;
  nativeDeliveryAttemptId: string;
  canonicalDispatchDigest: string;
  dispatchAuthorizationRefDigest: string;
  attemptStateBefore: "prepared" | "claimed";
  dispatchStateBefore: "not_started";
  gateStateBefore: "never_started";
  abandonmentReason: "explicit_operator_cancel" | "explicit_runtime_shutdown";
  abandonedAtJournalSeq: number;
  assertion: "attempt_dispatch_and_gate_quarantined_before_native_start";
  canonicalEvidenceDigest: string;
}

interface NativeConversationCreationReservationRecord {
  nativeCreationReservationId: string;
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  decisionEvidenceDigest: string;
  collaborationServerId: string;
  targetLogicalChatId: string;
  provisionalNativeBindingId: string;
  descriptor: NativeEngineDescriptor;
  projectId: string;
  workspaceSelectorId: string;
  projectTargetSelectorMappingId: string;
  projectTargetSelectorMappingGeneration: number;
  projectTargetDigest: string;
  nativeWorkspaceBindingId: string;
  canonicalDirectoryPathDigest: string;
  nativeWorkspaceBindingDigest: string;
  runtimeId: string;
  nativeIncarnation: number;
  nativeServerAttachmentLeaseId: string;
  serverFrontDoorLeaseId: string;
  serverCapabilitySnapshotId: string;
  serverCapabilitySnapshotAttestationDigest: string;
  newChatCapabilityDigest: string;
  positiveReadBackSchemaId: "remote-claw/opencode-new-chat-marker-reconciliation/v1";
  canonicalCommandPayloadSchemaId: "remote-claw/command-payload/new-chat/v1";
  canonicalCommandPayloadDigest: string;
  nativeRequestTranslatorDigest: string;
  creationIntent: "first_bootstrap" | "new_chat";
  nativeCreationMarker: string;
  nativeCreationIntentDigest: string;
  discoverySnapshotId: string;
  discoverySnapshotDigest: string;
  nativeMethod: string;
  nativeRouteSchemaId: string;
  canonicalRequestSchemaId: string;
  canonicalRequestRef: string;
  canonicalRequestDigest: string;
  nativeRequestTranslationSchemaId: "remote-claw/native-request-translation/v1";
  nativeRequestTranslationRef: string;
  nativeRequestTranslationDigest: string;
  nativeTargetPathDigest: string;
  nextReconciliationSeq: number;
  currentReconciliationId: string | null;
  state:
    | "reserved"
    | "started"
    | "transport_receipt"
    | "native_observed"
    | "bound"
    | "outcome_unknown"
    | "quarantined";
  observedNativeConversationId: string | null;
  outcomeEvidenceRef: string | null;
}

interface NativeConversationCreationEffectGateRecord {
  nativeCreationReservationId: string;
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  decisionEvidenceDigest: string;
  collaborationServerId: string;
  targetLogicalChatId: string;
  state: "never_started" | "started" | "completed" | "outcome_unknown";
  startedReservationId: string | null;
  outcomeEvidenceRef: string | null;
}

interface NativeCreationFrontDoorDispatchRecord {
  nativeCreationReservationId: string;
  serverFrontDoorLeaseId: string;
  canonicalRequestDigest: string;
  nativeRequestTranslationDigest: string;
  nativeTargetPathDigest: string;
  dispatchAuthorizationRef: {
    protectedHandleId: string;
    kind: "dispatch_authorization";
  };
  dispatchState: "not_started" | "started" | "completed" | "outcome_unknown";
  dispatchStartedAtMs: number | null;
  nativeReceiptRef: string | null;
  canonicalDispatchDigest: string;
}

interface NativeRequestTranslationRecord {
  schemaVersion: 1;
  nativeRequestTranslationSchemaId: "remote-claw/native-request-translation/v1";
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceDigest: string;
  capabilitySnapshotAttestationDigest: string;
  canonicalCommandPayloadSchemaId: string;
  canonicalCommandPayloadDigest: string;
  nativeRequestTranslatorDigest: string;
  generatedCoordinateSchemaId: string;
  generatedCoordinateRef: string;
  generatedCoordinateDigest: string;
  canonicalRequestSchemaId: string;
  canonicalRequestDigest: string;
  nativeTargetPathDigest: string;
}

type OpenCodeGeneratedRequestCoordinates =
  | {
      schemaVersion: 1;
      generatedCoordinateSchemaId: "remote-claw/opencode-user-text-generated-coordinates/v1";
      nativeBindingId: string;
      nativeConversationId: string;
      nativeWorkspaceBindingId: string;
      canonicalDirectory: string;
      canonicalDirectoryPathDigest: string;
      nativeWorkspaceBindingDigest: string;
      nativeActionId: string;
    }
  | {
      schemaVersion: 1;
      generatedCoordinateSchemaId: "remote-claw/opencode-new-chat-generated-coordinates/v1";
      runtimeId: string;
      nativeIncarnation: number;
      nativeWorkspaceBindingId: string;
      canonicalDirectory: string;
      canonicalDirectoryPathDigest: string;
      nativeWorkspaceBindingDigest: string;
      nativeCreationMarker: string;
      nativeCreationIntentDigest: string;
    };

interface NativeCreationMarkerMatchItem {
  schemaVersion: 1;
  canonicalCreationMetadataSchemaId: "remote-claw/opencode-native-creation-metadata/v1";
  fullNativeMetadataSchemaId: "remote-claw/opencode-full-native-metadata-evidence/v1";
  nativeCreationMarker: string;
  nativeCreationIntentDigest: string | null;
  nativeConversationId: string;
  creationMetadataClassification: "canonical_two_field" | "noncanonical_or_extra";
  canonicalCreationMetadataRef: string | null;
  canonicalCreationMetadataDigest: string | null;
  fullNativeMetadataRef: string;
  fullNativeMetadataDigest: string;
}

interface OpenCodeNativeStoreLineageEvidenceRecord {
  schemaVersion: 1;
  nativeStoreLineageEvidenceSchemaId: "remote-claw/opencode-native-store-lineage-evidence/v1";
  nativeStoreLineageEvidenceId: string;
  nativeCreationReservationId: string;
  proofKind: "exclusive_continuity_handoff";
  originalRuntimeId: string;
  originalNativeIncarnation: number;
  originalDiscoverySnapshotId: string;
  originalDiscoverySnapshotDigest: string;
  originalNativeStoreCoordinateSchemaId: "remote-claw/opencode-native-store-coordinate/v1";
  originalNativeStoreCoordinateRef: string;
  originalNativeStoreCoordinateDigest: string;
  successorRuntimeId: string;
  successorNativeIncarnation: number;
  successorDiscoverySnapshotId: string;
  successorDiscoverySnapshotDigest: string;
  successorNativeStoreCoordinateSchemaId: "remote-claw/opencode-native-store-coordinate/v1";
  successorNativeStoreCoordinateRef: string;
  successorNativeStoreCoordinateDigest: string;
  stableNativeStoreIdentityDigest: string;
  nativeStoreContinuityProofSchemaId:
    "remote-claw/opencode-native-store-continuity-handoff/v1";
  nativeStoreContinuityProofRef: string;
  nativeStoreContinuityProofDigest: string;
  canonicalNativeStoreLineageEvidenceDigest: string;
}

interface OpenCodeNativeStorePredecessorStopFenceEvidenceRecord {
  schemaVersion: 1;
  canonicalPayloadSchemaId:
    "remote-claw/opencode-native-store-predecessor-stop-fence/v1";
  predecessorStopFenceEvidenceId: string;
  assertion: "predecessor_stopped_handle_closed_and_store_fenced";
  originalRuntimeId: string;
  originalNativeIncarnation: number;
  originalNativeServerAttachmentLeaseId: string;
  originalNativeStoreCoordinateDigest: string;
  originalNativeStoreAttachmentAttestationDigest: string;
  stableNativeStoreIdentityDigest: string;
  stoppedProcessStartIdentityDigest: string;
  closedStoreHandleIdentityDigest: string;
  continuityRegistrySchemaId: "remote-claw/native-store-continuity-registry/v1";
  continuityRegistryId: string;
  originalCurrentWriterGeneration: number;
  originalCurrentWriterRegistrationDigest: string;
  predecessorFenceGeneration: number;
  continuityRegistryTransitionDigest: string;
  definitiveStopEvidenceSchemaId: "remote-claw/host-definitive-process-stop/v1";
  definitiveStopEvidenceRef: string;
  definitiveStopEvidenceDigest: string;
  runtimeOwnerIdentityKeyId: string;
  runtimeOwnerKeyGeneration: number;
  signerSequence: number;
  fencedAtMs: number;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
  signedRecordDigest: string;
}

interface OpenCodeNativeStoreSuccessorExclusiveOpenEvidenceRecord {
  schemaVersion: 1;
  canonicalPayloadSchemaId:
    "remote-claw/opencode-native-store-successor-exclusive-open/v1";
  successorExclusiveOpenEvidenceId: string;
  assertion: "successor_exclusively_opened_fenced_store_without_reset_or_fork";
  successorRuntimeId: string;
  successorNativeIncarnation: number;
  successorNativeServerAttachmentLeaseId: string;
  successorNativeStoreCoordinateDigest: string;
  successorNativeStoreAttachmentAttestationDigest: string;
  stableNativeStoreIdentityDigest: string;
  openedStoreHandleIdentityDigest: string;
  continuityRegistrySchemaId: "remote-claw/native-store-continuity-registry/v1";
  continuityRegistryId: string;
  predecessorStopFenceEvidenceDigest: string;
  predecessorFenceGeneration: number;
  successorExclusiveOpenGeneration: number;
  continuityRegistryTransitionDigest: string;
  conflictingWriterScanSchemaId: "remote-claw/native-store-conflicting-writer-scan/v1";
  conflictingWriterScanRef: string;
  conflictingWriterScanDigest: string;
  runtimeOwnerIdentityKeyId: string;
  runtimeOwnerKeyGeneration: number;
  signerSequence: number;
  openedAtMs: number;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
  signedRecordDigest: string;
}

interface OpenCodeNativeStoreContinuityHandoffProofRecord {
  schemaVersion: 1;
  nativeStoreContinuityProofSchemaId:
    "remote-claw/opencode-native-store-continuity-handoff/v1";
  nativeStoreContinuityProofId: string;
  proofKind: "exclusive_warden_handoff";
  continuityAssertion: "same_store_no_reset_no_fork";
  nativeCreationReservationId: string;
  originalRuntimeId: string;
  originalNativeIncarnation: number;
  originalNativeStoreCoordinateDigest: string;
  originalNativeStoreAttachmentAttestationDigest: string;
  successorRuntimeId: string;
  successorNativeIncarnation: number;
  successorNativeStoreCoordinateDigest: string;
  successorNativeStoreAttachmentAttestationDigest: string;
  stableNativeStoreIdentityDigest: string;
  continuityRegistrySchemaId: "remote-claw/native-store-continuity-registry/v1";
  continuityRegistryId: string;
  predecessorStopFenceEvidenceSchemaId:
    "remote-claw/opencode-native-store-predecessor-stop-fence/v1";
  predecessorStopFenceEvidenceRef: string;
  predecessorStopFenceEvidenceDigest: string;
  successorExclusiveOpenEvidenceSchemaId:
    "remote-claw/opencode-native-store-successor-exclusive-open/v1";
  successorExclusiveOpenEvidenceRef: string;
  successorExclusiveOpenEvidenceDigest: string;
  predecessorFenceGeneration: number;
  successorExclusiveOpenGeneration: number;
  predecessorRegistryTransitionDigest: string;
  successorRegistryTransitionDigest: string;
  canonicalNativeStoreContinuityProofDigest: string;
}

interface NativeConversationCreationReconciliationRecord {
  schemaVersion: 1;
  positiveReadBackSchemaId: "remote-claw/opencode-new-chat-marker-reconciliation/v1";
  nativeCreationReconciliationId: string;
  nativeCreationReservationId: string;
  expectedNativeCreationMarker: string;
  expectedNativeCreationIntentDigest: string;
  reconciliationSeq: number;
  originalRuntimeId: string;
  originalNativeIncarnation: number;
  originalDiscoverySnapshotId: string;
  originalDiscoverySnapshotDigest: string;
  originalDispatchDigest: string;
  successorRuntimeId: string;
  successorNativeIncarnation: number;
  successorObserverLeaseId: string;
  successorDiscoverySnapshotId: string;
  successorDiscoverySnapshotDigest: string;
  nativeStoreLineageStatus:
    | "same_incarnation_not_required"
    | "cross_incarnation_proved"
    | "cross_incarnation_unproved";
  nativeStoreLineageEvidenceSchemaId:
    | "remote-claw/opencode-native-store-lineage-evidence/v1"
    | null;
  nativeStoreLineageEvidenceRef: string | null;
  nativeStoreLineageEvidenceDigest: string | null;
  markerMatchVectorRef: string;
  markerMatchVectorDigest: string;
  markerMatchCount: number;
  decision:
    | "zero_uncertain"
    | "bind_one"
    | "metadata_mismatch"
    | "quarantine_many"
    | "lineage_unproved";
  observedNativeConversationId: string | null;
  canonicalReconciliationDigest: string;
}

interface NativeWorkspaceTransitionBarrierRecord {
  nativeWorkspaceTransitionBarrierId: string;
  nativeServerAttachmentLeaseId: string;
  nativeWorkspaceBindingId: string;
  barrierGeneration: number;
  nextTransitionSeq: number;
  activeTransitionId: string | null;
  firstBootstrapState: "available" | "claimed" | "consumed" | "inapplicable";
  state: "current" | "superseded" | "closed";
}

interface NativeWorkspaceTransitionRecord {
  nativeWorkspaceTransitionId: string;
  nativeWorkspaceTransitionBarrierId: string;
  transitionSeq: number;
  source: "direct_tui" | "server_control";
  transitionKind: NativeWorkspaceTransitionKind;
  commandId: string | null;
  admittingCommandResultId: string | null;
  admittingCommandResultSignedRecordDigest: string | null;
  canonicalCommandRecordDigest: string | null;
  decisionEvidenceDigest: string | null;
  nativeCreationReservationId: string | null;
  operationEntryDigest: string;
  canonicalRequestRef: string;
  canonicalRequestDigest: string;
  observedNativeConversationId: string | null;
  state: "reserved" | "started" | "completed" | "rejected" | "outcome_unknown" | "quarantined";
  outcomeEvidenceRef: string | null;
}

interface NestedServerManagementBindingRecord {
  nestedServerManagementBindingId: string;
  collaborationServerId: string;
  targetServerId: string;
  targetServerScopeCertificateId: string;
  targetOutsideBindingId: string;
  targetSourceEventNamespaceId: string;
  currentLeaseId: string | null;
  currentCapabilitySnapshotId: string | null;
  state: "current" | "closed";
}

interface NestedManagementLiveHandshakeAttestation {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/nested-management-live-handshake/v1";
  handshakeId: string;
  side: "source" | "target";
  nestedServerManagementBindingId: string;
  leaseGeneration: number;
  sourceServerId: string;
  targetServerId: string;
  targetOutsideBindingId: string;
  sourceCoordinatorEpoch: number;
  targetCoordinatorEpoch: number;
  transportEpoch: number;
  sourceNonce: string;
  targetNonce: string;
  sourceScopeCertificateId: string;
  targetScopeCertificateId: string;
  transportBindingSchemaId: "remote-claw/nested-management-tls13-exporter-binding/v1";
  exporterContextDigest: string;
  mutualChannelBindingDigest: string;
  issuedAtMs: number;
  signerSequence: number;
  serverKeyGeneration: number;
  signerIdentityKeyId: string;
  signerScopeCertificateId: string;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface NestedServerManagementLeaseRecord {
  nestedServerManagementLeaseId: string;
  nestedServerManagementBindingId: string;
  leaseGeneration: number;
  sourceCoordinatorEpoch: number;
  targetCoordinatorEpoch: number;
  transportEpoch: number;
  handshakeId: string;
  sourceHandshakeAttestationRef: string;
  sourceHandshakeAttestationDigest: string;
  targetHandshakeAttestationRef: string;
  targetHandshakeAttestationDigest: string;
  mutualChannelBindingDigest: string;
  state: "current" | "superseded" | "closed";
}

interface NestedManagementTargetLeasePointerRecord {
  targetServerId: string;
  targetOutsideBindingId: string;
  sourceServerId: string;
  nestedServerManagementBindingId: string;
  currentLeaseId: string | null;
  state: "current" | "closed";
}

interface NestedServerManagementCapabilitySnapshot {
  nestedServerManagementCapabilitySnapshotId: string;
  schemaVersion: 1;
  canonicalSnapshotSchemaId: "remote-claw/nested-management-capability-snapshot/v1";
  nestedServerManagementBindingId: string;
  nestedServerManagementLeaseId: string;
  capabilityGeneration: number;
  newChatRequestSchemaId: "remote-claw/nested-management-new-chat-request/v1";
  newChatReceiptProofSchemaId: "remote-claw/nested-target-command-receipt-proof/v1";
  newChatCapabilityDigest: string;
  proofRef: string;
  proofDigest: string;
  canonicalSnapshotDigest: string;
  verifiedAtMs: number;
  state: "current" | "superseded" | "revoked";
}

interface NestedReadinessPolicySnapshot {
  nestedReadinessPolicySnapshotId: string;
  schemaVersion: 1;
  canonicalPolicySchemaId: "remote-claw/nested-readiness-policy/v1";
  collaborationServerId: string;
  policyGeneration: number;
  maxWaitMs: number;
  canonicalPolicyDigest: string;
  state: "current" | "superseded";
}

interface NestedManagementLineageHop {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/nested-management-lineage-hop/v1";
  hopIndex: number;
  originServerId: string;
  originCommandId: string;
  originTargetLogicalChatId: string;
  sourceServerId: string;
  sourceCommandId: string;
  sourceCommandResultId: string;
  sourceCommandResultDigest: string;
  sourceTargetLogicalChatId: string;
  targetServerId: string;
  nestedServerManagementBindingId: string;
  projectTargetSelectorMappingId: string;
  projectTargetSelectorMappingGeneration: number;
  targetProjectId: string;
  targetWorkspaceSelectorId: string;
  creationIntent: "first_bootstrap" | "new_chat";
  semanticCreationBaseDigest: string;
  sourceEventNamespaceId: string;
  sourceEventId: string;
  priorLineageDigest: string | null;
  signerSequence: number;
  serverKeyGeneration: number;
  signerIdentityKeyId: string;
  signerScopeCertificateId: string;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface NestedManagementLineageHopPreparationRecord {
  nestedManagementLineageHopPreparationId: string;
  compoundSigningGroupId: string;
  compoundPreparationGeneration: number;
  signingLeaseId: string;
  commandResultId: string;
  canonicalCommandRecordDigest: string;
  hopIndex: number;
  preparationGeneration: number;
  supersedesPreparationRef: string | null;
  canonicalPayloadRef: string | null;
  canonicalPayloadDigest: string | null;
  signerSequence: number;
  signatureReservationRef: string;
  signedRecordDigest: string | null;
  state: "reserved" | "bound" | "signed" | "aborted";
}

interface NestedChatEventLineageHopPreparationRecord {
  nestedChatEventLineageHopPreparationId: string;
  compoundSigningGroupId: string;
  compoundPreparationGeneration: number;
  signingLeaseId: string;
  commandId: string;
  canonicalCommandRecordDigest: string;
  inwardEdgeId: string;
  hopIndex: number;
  preparationGeneration: number;
  supersedesPreparationRef: string | null;
  canonicalPayloadRef: string | null;
  canonicalPayloadDigest: string | null;
  signerSequence: number;
  signatureReservationRef: string;
  signedRecordDigest: string | null;
  state: "reserved" | "bound" | "signed" | "aborted";
}

interface NestedManagementTransportAttestation {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/nested-management-transport-attestation/v1";
  nestedChatCreationAttemptId: string;
  transportAttemptId: string;
  nestedServerManagementBindingId: string;
  nestedServerManagementLeaseId: string;
  sourceCoordinatorEpoch: number;
  targetCoordinatorEpoch: number;
  transportEpoch: number;
  mutualChannelBindingDigest: string;
  semanticRequestDigest: string;
  issuedAtMs: number;
  signerSequence: number;
  serverKeyGeneration: number;
  signerIdentityKeyId: string;
  signerScopeCertificateId: string;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface NestedDispatchAuthorizationRecord {
  nestedDispatchAuthorizationId: string;
  authorizationKind: "nested_management" | "nested_chat";
  collaborationServerId: string;
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceDigest: string;
  semanticAttemptId: string;
  physicalAttemptId: string;
  transportAttemptId: string;
  routingBindingId: string;
  targetServerId: string;
  targetLogicalChatId: string | null;
  targetOutsideBindingId: string;
  sourceTopologyGeneration: number | null;
  priorLeaseId: string;
  priorCapabilitySnapshotId: string;
  priorCapabilitySnapshotDigest: string;
  capabilityEntryDigest: string;
  semanticRequestSchemaId: string;
  semanticRequestDigest: string;
  dispatchAuthorizationRef: ProtectedHandleRef<"dispatch_authorization">;
  canonicalDispatchDigest: string;
  stateVersion: number;
  state: "armed" | "consumed" | "revoked";
  revokedAtJournalSeq: number | null;
}

interface NestedPositiveNeverStartedAttestation {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/nested-positive-never-started-attestation/v1";
  positiveNeverStartedEvidenceId: string;
  authorizationKind: "nested_management" | "nested_chat";
  collaborationServerId: string;
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceDigest: string;
  semanticAttemptId: string;
  physicalAttemptId: string;
  transportAttemptId: string;
  routingBindingId: string;
  targetServerId: string;
  targetLogicalChatId: string | null;
  targetOutsideBindingId: string;
  sourceTopologyGeneration: number | null;
  priorLeaseId: string;
  priorCapabilitySnapshotId: string;
  priorCapabilitySnapshotDigest: string;
  capabilityEntryDigest: string;
  semanticRequestSchemaId: string;
  semanticRequestDigest: string;
  nestedDispatchAuthorizationId: string;
  dispatchAuthorizationRef: ProtectedHandleRef<"dispatch_authorization">;
  canonicalDispatchDigest: string;
  revokedAuthorizationStateVersion: number;
  revokedAtJournalSeq: number;
  assertion: "authorization_revoked_unconsumed_before_start";
  issuedAtMs: number;
  signerSequence: number;
  serverKeyGeneration: number;
  signerIdentityKeyId: string;
  signerScopeCertificateId: string;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface NestedManagementCapabilityContinuation {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/nested-management-capability-continuation/v1";
  nestedChatCreationAttemptId: string;
  nestedServerManagementBindingId: string;
  targetServerId: string;
  priorManagementLeaseId: string;
  priorManagementCapabilitySnapshotId: string;
  priorManagementCapabilitySnapshotDigest: string;
  currentManagementLeaseId: string;
  currentManagementCapabilitySnapshotId: string;
  currentManagementCapabilitySnapshotDigest: string;
  newChatCapabilityDigest: string;
  targetReceiptProofSchemaId: "remote-claw/nested-target-command-receipt-proof/v1";
  semanticRequestDigest: string;
  priorTransportAttemptId: string;
  nextTransportAttemptId: string;
  positiveNeverStartedEvidenceSchemaId:
    "remote-claw/nested-positive-never-started-attestation/v1";
  positivePriorNeverStartedEvidenceDigest: string;
  signerSequence: number;
  serverKeyGeneration: number;
  signerIdentityKeyId: string;
  signerScopeCertificateId: string;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface NestedChatCreationAttemptRecord {
  nestedChatCreationAttemptId: string;
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  decisionEvidenceDigest: string;
  collaborationServerId: string;
  targetLogicalChatId: string;
  projectTargetSelectorMappingId: string;
  projectTargetSelectorMappingGeneration: number;
  nestedServerManagementBindingId: string;
  nestedServerManagementLeaseId: string;
  nestedServerManagementCapabilitySnapshotId: string;
  nestedServerManagementCapabilitySnapshotDigest: string;
  newChatCapabilityDigest: string;
  targetServerId: string;
  targetProjectId: string;
  targetWorkspaceSelectorId: string;
  sourceEventNamespaceId: string;
  sourceEventId: string;
  lineageVectorRef: string;
  lineageVectorDigest: string;
  semanticCreationBaseSchemaId: "remote-claw/nested-management-creation-base/v1";
  semanticCreationBaseRef: string;
  semanticCreationBaseDigest: string;
  canonicalRequestSchemaId: "remote-claw/nested-management-new-chat-request/v1";
  canonicalRequestRef: string;
  canonicalRequestDigest: string;
  targetReceiptProofSchemaId: "remote-claw/nested-target-command-receipt-proof/v1";
  dispatchState: "not_started" | "started" | "completed" | "outcome_unknown";
  targetCommandId: string | null;
  targetCommandResultId: string | null;
  targetReceiptProofRef: string | null;
  targetReceiptProofDigest: string | null;
  targetDecision: "admitted" | "rejected" | null;
  targetCommandSeq: number | null;
  targetReadyAttestationRef: string | null;
  targetReadyAttestationDigest: string | null;
  readinessPolicySnapshotId: string;
  readinessPolicySnapshotDigest: string;
  attemptCreatedAtMs: number;
  readinessDeadlineAtMs: number;
  failureCode: string | null;
  state:
    | "prepared"
    | "started"
    | "target_observed"
    | "completed"
    | "failed"
    | "outcome_unknown";
  observedTargetLogicalChatId: string | null;
  outcomeEvidenceRef: string | null;
}

interface NestedCreationStatusRecord {
  nestedCreationStatusId: string;
  nestedChatCreationAttemptId: string;
  outerCommandId: string;
  outerTargetLogicalChatId: string;
  statusVersion: number;
  supersedesNestedCreationStatusId: string | null;
  status: "ready" | "failed" | "outcome_unknown";
  failureCode: string | null;
  evidenceRef: string;
  evidenceDigest: string;
  canonicalPayloadSchemaId: "remote-claw/nested-creation-status/v1";
  canonicalPayloadRef: string;
  canonicalPayloadDigest: string;
  projectionOutboxRef: string;
}

interface NestedManagementDeliveryAttemptRecord {
  nestedManagementDeliveryAttemptId: string;
  nestedChatCreationAttemptId: string;
  transportAttemptId: string;
  nestedServerManagementLeaseId: string;
  currentManagementCapabilitySnapshotId: string;
  currentManagementCapabilitySnapshotDigest: string;
  capabilityContinuationRef: string | null;
  capabilityContinuationDigest: string | null;
  nestedDispatchAuthorizationId: string;
  dispatchAuthorizationRef: ProtectedHandleRef<"dispatch_authorization">;
  canonicalDispatchDigest: string;
  transportAttestationRef: string;
  transportAttestationDigest: string;
  state: "prepared" | "started" | "completed" | "outcome_unknown" | "never_started";
  positiveNeverStartedEvidenceSchemaId:
    | "remote-claw/nested-positive-never-started-attestation/v1"
    | null;
  positiveNeverStartedEvidenceRef: string | null;
  positiveNeverStartedEvidenceDigest: string | null;
  outcomeEvidenceRef: string | null;
}

interface NestedTargetReadyAttestation {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/nested-target-ready-attestation/v1";
  targetServerId: string;
  targetLogicalChatId: string;
  targetCommandResultId: string;
  targetCommandResultSignedRecordDigest: string;
  targetCommandId: string;
  targetCommandSeq: number;
  targetTopologyGeneration: number;
  attestationGeneration: number;
  supersedesAttestationDigest: string | null;
  rootPathCertificateId: string;
  rootPathCertificateDigest: string;
  readyJournalSeq: number;
  issuedAtMs: number;
  signerSequence: number;
  serverKeyGeneration: number;
  signerIdentityKeyId: string;
  signerScopeCertificateId: string;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface NestedChatCreationEffectGateRecord {
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  decisionEvidenceDigest: string;
  collaborationServerId: string;
  targetLogicalChatId: string;
  state: "never_started" | "started" | "completed" | "outcome_unknown";
  startedAttemptId: string | null;
  positiveNeverStartedEvidenceSchemaId:
    | "remote-claw/nested-positive-never-started-attestation/v1"
    | null;
  positiveNeverStartedEvidenceRef: string | null;
  positiveNeverStartedEvidenceDigest: string | null;
  outcomeEvidenceRef: string | null;
}

interface RuntimeOwnerStateRecord {
  machineIdentityId: string;
  currentRuntimeOwnerServiceEpoch: number;
  currentRuntimeOwnerServiceLeaseId: string | null;
  nextJournalOffset: number;
  createdAtMs: number;
}

interface RuntimeOwnerServiceLeaseRecord {
  runtimeOwnerServiceLeaseId: string;
  machineIdentityId: string;
  runtimeOwnerServiceEpoch: number;
  ownerInstanceId: string;
  ownerProcessStartIdentitySchemaId: string;
  ownerProcessStartIdentityRef: string;
  ownerProcessStartIdentityDigest: string;
  acquiredAtMs: number;
  heartbeatDeadlineMs: number;
  releasedAtMs: number | null;
  state: "current" | "expired" | "released" | "superseded";
}

interface RuntimeOwnerServiceFence {
  runtimeOwnerServiceLeaseId: string;
  runtimeOwnerServiceEpoch: number;
  ownerInstanceId: string;
  ownerProcessStartIdentitySchemaId: string;
  ownerProcessStartIdentityRef: string;
  ownerProcessStartIdentityDigest: string;
}

interface RuntimeOwnerJournalEntry {
  journalOffset: number;
  entryKind:
    | "service_lease_acquired"
    | "service_lease_released"
    | "runtime_registered"
    | "runtime_reassigned"
    | "runtime_replaced"
    | "runtime_terminated"
    | "runtime_key_rotated"
    | "local_conversation_transitioned"
    | "binding_incarnation_prepared"
    | "attachment_lease_acquired"
    | "attachment_detached";
  subjectKind:
    | "service_lease"
    | "native_runtime"
    | "runtime_owner_identity_key"
    | "local_native_transition"
    | "native_binding_incarnation"
    | "native_transport_lease";
  subjectId: string;
  operationId: string;
  operationSchemaId: string;
  operationDigest: string;
  runtimeOwnerServiceLeaseId: string;
  runtimeOwnerServiceEpoch: number;
  committedAtMs: number;
}

interface NativeRuntimeRecord {
  runtimeId: string;
  descriptor: NativeEngineDescriptor;
  wardenLaunchNonce: string;
  initialStartIdentitySchemaId: string;
  initialStartIdentityRef: string;
  initialStartIdentityDigest: string;
  currentNativeIncarnation: number | null;
  currentRuntimeOwnerAssignmentId: string | null;
  createdAtMs: number;
  closedAtMs: number | null;
  state: "current" | "closed";
}

interface NativeRuntimeIncarnationRecord {
  runtimeId: string;
  nativeIncarnation: number;
  descriptor: NativeEngineDescriptor;
  runtimeOwnerServiceLeaseId: string;
  runtimeOwnerServiceEpoch: number;
  startIdentitySchemaId: string;
  startIdentityRef: string;
  startIdentityDigest: string;
  startedAtMs: number;
  closedAtMs: number | null;
  state: "starting" | "current" | "draining" | "closed";
}

interface RuntimeOwnerAssignmentRecord {
  runtimeOwnerAssignmentId: string;
  runtimeId: string;
  nativeIncarnation: number;
  assignmentGeneration: number;
  runtimeOwnerServiceLeaseId: string;
  runtimeOwnerServiceEpoch: number;
  assignedAtMs: number;
  supersedesRuntimeOwnerAssignmentId: string | null;
  reason: "creation" | "takeover";
  assignmentEvidenceSchemaId: string;
  assignmentEvidenceRef: string;
  assignmentEvidenceDigest: string;
}

interface NativeRuntimeContainmentRecord {
  nativeRuntimeContainmentId: string;
  runtimeId: string;
  predecessorNativeIncarnation: number;
  successorNativeIncarnation: number | null;
  kind: "replacement" | "termination";
  evidenceSchemaId: string;
  evidenceRef: string;
  evidenceDigest: string;
  runtimeOwnerServiceLeaseId: string;
  runtimeOwnerServiceEpoch: number;
  containedAtMs: number;
}

interface InferenceRuntimeBindingRecord {
  inferenceRuntimeBindingId: string;
  runtimeId: string;
  nativeIncarnation: number;
  facadeProtocolSchemaId: string;
  nativeRequestNamespaceId: string;
  nativeRequestIdExtractionSchemaId: string;
  nativeRequestIdUniquenessProofRef: string;
  nativeRequestIdUniquenessProofDigest: string;
  canonicalProviderRequestSchemaId: string;
  currentInferenceLeaseId: string | null;
  state: "current" | "superseded" | "closed";
}

interface InferenceConnectorLease {
  inferenceLeaseId: string;
  runtimeId: string;
  nativeIncarnation: number;
  connectorGeneration: number;
  facadeProtocolSchemaId: string;
  nativeRequestNamespaceId: string;
  nativeRequestIdExtractionSchemaId: string;
  nativeRequestIdUniquenessProofDigest: string;
  canonicalProviderRequestSchemaId: string;
  state: "current" | "superseded" | "closed";
}

interface InferenceAttemptRecord {
  inferenceAttemptId: string;
  runtimeId: string;
  nativeIncarnation: number;
  localNativeConversationId: string | null;
  nativeRequestNamespaceId: string;
  nativeRequestId: string;
  nativeRequestIdExtractionSchemaId: string;
  nativeRequestIdEvidenceRef: string;
  nativeRequestIdEvidenceDigest: string;
  requestFingerprintSchemaId: string;
  canonicalProviderRequestSchemaId: string;
  encryptedCanonicalProviderRequestRef: string;
  encryptedCanonicalProviderRequestEnvelopeDigest: string;
  requestDigest: string;
  upstreamIdempotencyKey: string | null;
  upstreamRequestId: string | null;
  upstreamRecoveryEvidenceRef: string | null;
  nativeResponseStreamId: string;
  currentTransportAttemptId: string | null;
  nextTransportAttemptSeq: number;
  upstreamState: "prepared" | "started" | "accepted" | "streaming" | "completed" | "failed" | "outcome_unknown";
  nativeDeliveryState: "not_started" | "started" | "streaming" | "completed" | "failed" | "outcome_unknown";
  deliveredThroughSequence: number;
}

interface InferenceConnectorTransportAttemptRecord {
  inferenceConnectorTransportAttemptId: string;
  inferenceAttemptId: string;
  transportAttemptSeq: number;
  inferenceLeaseId: string;
  connectorGeneration: number;
  mode: "initial_send" | "resume_existing";
  upstreamRequestId: string | null;
  upstreamCursorRef: string | null;
  recoveryEvidenceRef: string | null;
  state: "prepared" | "started" | "streaming" | "completed" | "never_started" | "outcome_unknown";
  positiveNeverStartedEvidenceRef: string | null;
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
  scopeKind: "server_control" | "chat";
  logicalChatId: string | null;
  kind: "anthropic-remote" | "chatgpt-remote" | "web" | "automation" | "nested-remote-claw";
  representedServerId: string | null;
  representedLogicalChatId: string | null;
  representedInwardEdgeId: string | null;
  currentIncarnationId: string | null;
  state: "current" | "closed";
}

// The provider-specific records below describe the end-state B/C extensions. A1 defines only their
// provider-neutral outside-binding, source-event, capability, and actor seams; it does not migrate,
// enroll, or make Anthropic/ChatGPT connectors writable.
interface ProviderServerControlBindingRecord {
  providerServerControlBindingId: string;
  collaborationServerId: string;
  providerKind: "anthropic-remote" | "chatgpt-remote";
  anthropicRemoteHostId: string | null;
  chatGptRemoteHostId: string | null;
  providerProjectId: string;
  outsideBindingId: string;
  sourceEventNamespaceId: string;
  currentOutsideIncarnationId: string | null;
  state: "current" | "closed";
}

interface AnthropicRemoteHostRecord {
  anthropicRemoteHostId: string;
  collaborationServerId: string;
  installationId: string;
  providerHostId: string | null;
  displayName: string;
  currentConnectorLeaseId: string | null;
  state: "unpaired" | "paired" | "closed";
}

interface ProviderChatCreationMappingRecord {
  providerServerControlBindingId: string;
  canonicalSourceEventId: string;
  commandId: string;
  commandResultId: string;
  targetLogicalChatId: string;
  providerChatId: string | null;
  providerResultRef: string;
  providerResultDigest: string;
  state: "allocated" | "provider_observed" | "closed";
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
  inwardEdgeId: string; // stable random rcie_<base64url-128-bit>
  representedServerId: string;
  representedLogicalChatId: string;
  targetKind: "native-harness" | "remote-claw-server";
  targetServerId: string | null;
  targetLogicalChatId: string | null;
  targetNativeBindingId: string | null;
  // Null exactly while the non-writable edge reservation is installing.
  rootPathCertificateId: string | null;
  // Always zero/null for native-harness edges. These are N1 remote-server connection fields.
  currentConnectionEpoch: number;
  currentLiveLeaseId: string | null;
  currentCapabilitySnapshotId: string | null;
  state: "installing" | "installed" | "current" | "superseded" | "closed";
}

interface NestedChatEdgeCapabilitySnapshot {
  nestedChatEdgeCapabilitySnapshotId: string;
  schemaVersion: 1;
  canonicalSnapshotSchemaId: "remote-claw/nested-chat-edge-capability-snapshot/v1";
  inwardEdgeId: string;
  inwardLiveLeaseId: string;
  sourceTopologyGeneration: number;
  targetTopologyGeneration: number;
  targetOutsideBindingId: string;
  targetSourceEventNamespaceId: string;
  capabilityGeneration: number;
  familyCapabilitiesRef: string;
  familyCapabilityVectorDigest: string;
  proofRef: string;
  proofDigest: string;
  canonicalSnapshotDigest: string;
  verifiedAtMs: number;
  state: "current" | "superseded" | "revoked";
}

interface NestedChatEdgeFamilyCapability {
  mutationFamily: NativeBindingMutationFamily;
  canonicalCommandPayloadSchemaId: string;
  targetRequestSchemaId: string;
  targetReceiptProofSchemaId: "remote-claw/nested-target-command-receipt-proof/v1";
  acknowledgement: "durable_receipt";
  capabilityFamilyDigest: string;
}

interface NestedAttachmentPayloadTransferItemRecord {
  itemIndex: number;
  canonicalItemSchemaId: "remote-claw/command-payload/attachment-item/v1";
  canonicalAttachmentItemBytesRef: string;
  canonicalAttachmentItemDigest: string;
  decodedContentBytesRef: string;
  contentLength: number;
  contentDigest: string;
}

interface NestedCommandPayloadTransferBundleRecord {
  schemaVersion: 1;
  canonicalPayloadTransferSchemaId: "remote-claw/nested-command-payload-transfer/v1";
  mutationFamily: NativeBindingMutationFamily;
  canonicalCommandPayloadSchemaId: string;
  canonicalCommandPayloadBytesRef: string;
  canonicalCommandPayloadDigest: string;
  attachmentTransferItemCount: number;
  attachmentTransferItemsRef: string | null;
  canonicalPayloadTransferDigest: string;
}

interface NestedChatDeliveryAttemptRecord {
  nestedChatDeliveryAttemptId: string;
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  decisionEvidenceDigest: string;
  collaborationServerId: string;
  logicalChatId: string;
  inwardEdgeId: string;
  sourceTopologyGeneration: number;
  nestedChatEdgeCapabilitySnapshotId: string;
  nestedChatEdgeCapabilitySnapshotDigest: string;
  capabilityFamilyDigest: string;
  mutationFamily: NativeBindingMutationFamily;
  targetServerId: string;
  targetLogicalChatId: string;
  targetOutsideBindingId: string;
  targetSourceEventNamespaceId: string;
  targetSourceEventId: string;
  targetRequestSchemaId: string;
  targetReceiptProofSchemaId: "remote-claw/nested-target-command-receipt-proof/v1";
  canonicalCommandPayloadSchemaId: string;
  canonicalCommandPayloadRef: string;
  canonicalCommandPayloadDigest: string;
  canonicalPayloadTransferSchemaId: "remote-claw/nested-command-payload-transfer/v1";
  canonicalPayloadTransferRef: string;
  canonicalPayloadTransferDigest: string;
  canonicalEnvelopeCoreSchemaId: "remote-claw/nested-chat-envelope-core/v1";
  canonicalEnvelopeCoreRef: string;
  canonicalEnvelopeCoreDigest: string;
  canonicalEnvelopeSchemaId: string;
  canonicalEnvelopeRef: string;
  canonicalEnvelopeDigest: string;
  eventLineageRef: string;
  eventLineageDigest: string;
  currentTargetResultId: string | null;
  outcomeEvidenceRef: string | null;
}

interface NestedChatTargetResultRecord {
  nestedChatDeliveryAttemptId: string;
  targetReceiptProofSchemaId: "remote-claw/nested-target-command-receipt-proof/v1";
  targetResultVersion: 1;
  targetCommandId: string;
  targetCommandSeq: number;
  targetCommandResultId: string;
  supersedesTargetCommandResultId: null;
  targetReceiptProofRef: string;
  targetReceiptProofDigest: string;
  targetDecision: "admitted" | "queued" | "rejected";
}

interface NestedTargetCommandReceiptProofBundle {
  schemaVersion: 1;
  targetReceiptProofSchemaId: "remote-claw/nested-target-command-receipt-proof/v1";
  targetServerId: string;
  targetOutsideBindingId: string;
  targetSourceEventNamespaceId: string;
  targetSourceEventId: string;
  targetRequestSchemaId: string;
  targetRequestDigest: string;
  targetCommandId: string;
  targetCommandSeq: number;
  targetCommandResultId: string;
  targetDecision: "admitted" | "queued" | "rejected";
  targetCanonicalSourceEventRef: string;
  targetCanonicalSourceEventDigest: string;
  targetCommandPayloadRef: string;
  targetCommandPayloadDigest: string;
  targetCommandRecordRef: string;
  targetCommandRecordDigest: string;
  targetDecisionEvidenceRef: string;
  targetDecisionEvidenceDigest: string;
  targetExecutorEvidenceRef: string | null;
  targetExecutorEvidenceDigest: string | null;
  targetCommandResultSchemaId: "remote-claw/collaboration-command-result/v1";
  targetCommandResultRef: string;
  targetCommandResultSignedRecordDigest: string;
  canonicalReceiptProofDigest: string;
}

interface NestedChatDeliveryTransportAttemptRecord {
  nestedChatDeliveryTransportAttemptId: string;
  nestedChatDeliveryAttemptId: string;
  transportAttemptId: string;
  inwardLiveLeaseId: string;
  currentEdgeCapabilitySnapshotId: string;
  currentEdgeCapabilitySnapshotDigest: string;
  capabilityContinuationRef: string | null;
  capabilityContinuationDigest: string | null;
  mutualChannelBindingDigest: string;
  nestedDispatchAuthorizationId: string;
  dispatchAuthorizationRef: ProtectedHandleRef<"dispatch_authorization">;
  canonicalDispatchDigest: string;
  state: "prepared" | "started" | "completed" | "never_started" | "outcome_unknown";
  positiveNeverStartedEvidenceSchemaId:
    | "remote-claw/nested-positive-never-started-attestation/v1"
    | null;
  positiveNeverStartedEvidenceRef: string | null;
  positiveNeverStartedEvidenceDigest: string | null;
  outcomeEvidenceRef: string | null;
}

interface NestedChatEdgeCapabilityContinuation {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/nested-chat-edge-capability-continuation/v1";
  nestedChatDeliveryAttemptId: string;
  priorEdgeCapabilitySnapshotId: string;
  priorEdgeCapabilitySnapshotDigest: string;
  currentEdgeCapabilitySnapshotId: string;
  currentEdgeCapabilitySnapshotDigest: string;
  inwardEdgeId: string;
  sourceTopologyGeneration: number;
  targetServerId: string;
  targetLogicalChatId: string;
  targetOutsideBindingId: string;
  capabilityFamilyDigest: string;
  priorTransportAttemptId: string;
  nextTransportAttemptId: string;
  positiveNeverStartedEvidenceSchemaId:
    "remote-claw/nested-positive-never-started-attestation/v1";
  positivePriorNeverStartedEvidenceDigest: string;
  signerSequence: number;
  serverKeyGeneration: number;
  signerIdentityKeyId: string;
  signerScopeCertificateId: string;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface NestedChatDeliveryEffectGateRecord {
  commandId: string;
  admittingCommandResultId: string;
  admittingCommandResultSignedRecordDigest: string;
  canonicalCommandRecordDigest: string;
  decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  decisionEvidenceDigest: string;
  collaborationServerId: string;
  logicalChatId: string;
  state: "never_started" | "started" | "completed" | "outcome_unknown";
  startedAttemptId: string | null;
  positiveNeverStartedEvidenceSchemaId:
    | "remote-claw/nested-positive-never-started-attestation/v1"
    | null;
  positiveNeverStartedEvidenceRef: string | null;
  positiveNeverStartedEvidenceDigest: string | null;
  outcomeEvidenceRef: string | null;
}

interface TopologyPathHop {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/topology-path-hop/v1";
  hopIndex: number;
  collaborationServerId: string;
  logicalChatId: string;
  inwardEdgeId: string;
  topologyGeneration: number;
  predecessorCertificateOrHopDigest: string;
  rootAnchorExpiresAtMs: number;
  signerIdentityKeyId: string;
  signerKeyGeneration: number;
  signerScopeCertificateId: string;
  signerSequence: number;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface NativeRootCertificate {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/native-root-certificate/v1";
  rootPathCertificateId: string;
  kind: "native-root";
  terminalNativeBindingId: string;
  terminalServerId: string;
  terminalLogicalChatId: string;
  terminalTopologyGeneration: number;
  nativeBindingEvidenceDigest: string;
  runtimeOwnerIdentityKeyId: string;
  runtimeOwnerKeyGeneration: number;
  signerSequence: number;
  issuedAtMs: number;
  expiresAtMs: number;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface RuntimeOwnerIdentityKeyRecord {
  runtimeId: string;
  runtimeOwnerIdentityKeyId: string;
  keyGeneration: number;
  algorithm: "Ed25519";
  publicKey: string;
  signingKeyRef: ProtectedHandleRef<"signing_key"> | null;
  nextSignerSequence: number;
  localTrustEvidenceRef: string;
  localTrustEvidenceDigest: string;
  state: "current" | "retired" | "revoked";
}

interface RuntimeOwnerPrivateKeyEnvelopeRecord {
  signingKeyRef: ProtectedHandleRef<"signing_key">;
  runtimeId: string;
  runtimeOwnerIdentityKeyId: string;
  keyGeneration: number;
  wrappingSchemaId: "remote-claw/runtime-owner-key-wrap/aes-256-gcm/v1";
  wrapNonce: ProtectedByteSnapshot; // 12 bytes
  wrappedPkcs8: ProtectedByteSnapshot; // 1..1024 bytes
  authTag: ProtectedByteSnapshot; // 16 bytes
  pkcs8Digest: string; // canonical SHA-256
  createdAtMs: number;
  destroyedAtMs: number | null;
  state: "current" | "destroyed";
}

interface RuntimeOwnerSignatureReservationRecord {
  runtimeId: string;
  runtimeOwnerIdentityKeyId: string;
  runtimeOwnerKeyGeneration: number;
  signerSequence: number;
  purpose:
    | "native_root"
    | "listener_registration_attestation"
    | "runtime_isolation_attestation"
    | "native_capability_snapshot"
    | "native_tui_policy_snapshot"
    | "opencode_native_store_attachment_attestation"
    | "opencode_native_store_predecessor_stop_fence"
    | "opencode_native_store_successor_exclusive_open";
  canonicalPayloadSchemaId:
    | "remote-claw/native-root-certificate/v1"
    | "remote-claw/native-listener-registration-attestation/v1"
    | "remote-claw/native-runtime-isolation-attestation/v1"
    | "remote-claw/native-capability-snapshot-attestation/v1"
    | "remote-claw/native-tui-policy-snapshot-attestation/v1"
    | "remote-claw/opencode-native-store-attachment-attestation/v1"
    | "remote-claw/opencode-native-store-predecessor-stop-fence/v1"
    | "remote-claw/opencode-native-store-successor-exclusive-open/v1"
    | null;
  canonicalPayloadRef: string | null;
  canonicalPayloadDigest: string | null;
  signedRecordDigest: string | null;
  signature: string | null;
  signedArtifactId: string | null;
  state: "reserved" | "bound" | "signed" | "aborted";
}

interface RuntimeOwnerSignedRecordAcceptanceRecord {
  runtimeId: string;
  runtimeOwnerIdentityKeyId: string;
  runtimeOwnerKeyGeneration: number;
  signerSequence: number;
  signedRecordDigest: string;
  acceptedAtMs: number;
}

interface ServerRootedTopologyCertificate {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/server-rooted-topology-certificate/v1";
  rootPathCertificateId: string;
  kind: "server-path";
  targetServerId: string;
  targetLogicalChatId: string;
  targetTopologyGeneration: number;
  rootAnchorCertificateDigest: string;
  rootAnchorExpiresAtMs: number;
  path: readonly TopologyPathHop[];
  issuerServerIdentityKeyId: string;
  issuerServerKeyGeneration: number;
  issuerScopeCertificateId: string;
  signerSequence: number;
  issuedAtMs: number;
  expiresAtMs: number;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

type RootedTopologyCertificate = NativeRootCertificate | ServerRootedTopologyCertificate;

interface InwardEdgeInstallReservation {
  reservationId: string;
  sourceServerId: string;
  sourceLogicalChatId: string;
  sourceInwardEdgeId: string;
  expectedSourceTopologyGeneration: number;
  targetServerId: string;
  targetLogicalChatId: string;
  targetCollaboratorBindingId: string;
  expectedTargetTopologyGeneration: number;
  rootPathCertificateId: string;
  sourcePreparedReceiptId: string;
  targetPreparedReceiptId: string | null;
  sourceCommitIntentReceiptId: string | null;
  targetCommitIntentReceiptId: string | null;
  sourceInstalledReceiptId: string | null;
  targetInstalledReceiptId: string | null;
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

interface InwardEdgeInstallReceiptRecord {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/inward-edge-install-receipt/v1";
  receiptId: string;
  reservationId: string;
  stage: "prepared" | "commit_intent" | "installed";
  side: "source" | "target";
  sourceServerId: string;
  sourceLogicalChatId: string;
  sourceInwardEdgeId: string;
  expectedSourceTopologyGeneration: number;
  targetServerId: string;
  targetLogicalChatId: string;
  targetCollaboratorBindingId: string;
  expectedTargetTopologyGeneration: number;
  rootPathCertificateId: string;
  priorReceiptChainDigest: string;
  issuedAtMs: number;
  signerServerId: string;
  signerIdentityKeyId: string;
  signerKeyGeneration: number;
  signerScopeCertificateId: string;
  signerSequence: number;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface InwardEdgeLiveHandshakeAttestation {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/inward-edge-live-handshake/v1";
  handshakeId: string;
  side: "source" | "target";
  reservationId: string;
  sourceServerId: string;
  sourceLogicalChatId: string;
  sourceInwardEdgeId: string;
  sourceTopologyGeneration: number;
  sourceConnectionEpoch: number;
  sourceNonce: string;
  targetServerId: string;
  targetLogicalChatId: string;
  targetCollaboratorBindingId: string;
  targetTopologyGeneration: number;
  targetConnectionEpoch: number;
  targetNonce: string;
  rootPathCertificateDigest: string;
  sourceInstalledReceiptDigest: string;
  targetInstalledReceiptDigest: string;
  transportBindingSchemaId: "remote-claw/tls13-exporter-binding/v1";
  transportChannelBinding: string;
  issuedAtMs: number;
  signerIdentityKeyId: string;
  signerKeyGeneration: number;
  signerScopeCertificateId: string;
  signerSequence: number;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
}

interface InwardEdgeLiveLeaseRecord {
  inwardLiveLeaseId: string;
  handshakeId: string;
  sourceAttestationDigest: string;
  targetAttestationDigest: string;
  sourceConnectionEpoch: number;
  targetConnectionEpoch: number;
  transportChannelBinding: string;
  state: "current" | "superseded" | "closed";
}

interface ServerSignerBootstrapIntentV1 {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/server-signer-bootstrap-intent/v1";
  machineIdentityId: string;
  collaborationServerId: string;
  bootstrapSigningLeaseId: string;
  purpose: "initial_pair";
  expectedPriorScopeCertificateId: null;
  proposedIdentityKeyId: string;
  proposedKeyGeneration: 1;
  proposedKeyAlgorithm: "Ed25519";
  proposedPublicKey: string;
  proposedScopeCertificateId: string;
  signingKeyRef: string;
  preparedAtMs: number;
}

interface ServerIdentityKeyRecord {
  collaborationServerId: string;
  identityKeyId: string;
  keyGeneration: number;
  algorithm: "Ed25519";
  publicKey: string; // unpadded base64url of the 32 raw public-key bytes
  signingKeyRef: string;
  introducedByScopeCertificateId: string | null;
  trustEvidenceRef: string;
  trustEvidenceDigest: string;
  validFromMs: number;
  state: "proposed" | "current" | "retired" | "revoked";
}

interface ServerIdentityPrivateKeyEnvelopeRecord {
  signingKeyRef: string;
  collaborationServerId: string;
  identityKeyId: string;
  keyGeneration: number;
  custodyBackend: "owned-file";
  wrappingSchemaId: "remote-claw/server-identity-key-wrap/aes-256-gcm/v1";
  wrapNonce: ProtectedByteSnapshot; // 12 bytes
  wrappedPkcs8: ProtectedByteSnapshot; // 1..1,024 bytes
  authTag: ProtectedByteSnapshot; // 16 bytes
  pkcs8Digest: string;
  createdAtMs: number;
  destroyedAtMs: number | null;
  state: "current" | "destroyed";
}

interface ServerSigningLeaseRecord {
  signingLeaseId: string;
  collaborationServerId: string;
  identityKeyId: string;
  keyGeneration: number;
  scopeCertificateId: string;
  coordinatorLeaseId: string;
  coordinatorEpoch: number;
  fencingToken: number;
  acquiredAtMs: number;
  drainingAtMs: number | null;
  supersededAtMs: number | null;
  closedAtMs: number | null;
  state: "current" | "draining" | "superseded" | "closed";
}

interface ServerBootstrapSigningLeaseRecord {
  bootstrapSigningLeaseId: string;
  collaborationServerId: string;
  purpose: "initial_pair" | "explicit_repair";
  operatorIntentEvidenceRef: string;
  operatorIntentEvidenceDigest: string;
  expectedPriorScopeCertificateId: string | null;
  proposedIdentityKeyId: string;
  proposedKeyGeneration: number;
  proposedScopeCertificateId: string;
  signingKeyRef: string;
  coordinatorLeaseId: string;
  coordinatorEpoch: number;
  fencingToken: number;
  preparedAtMs: number;
  signedAtMs: number | null;
  installedAtMs: number | null;
  closedAtMs: number | null;
  state: "prepared" | "signed" | "installed" | "closed";
}

interface ServerSignatureReservationRecord {
  collaborationServerId: string;
  signerSequence: number;
  signingLeaseId: string;
  signingLeaseKind: "current" | "bootstrap";
  purpose:
    | "scope_certificate"
    | "onboarding_keys"
    | "host_output"
    | "scope_bus_checkpoint"
    | "topology_path_hop"
    | "server_rooted_topology"
    | "edge_install_receipt"
    | "edge_live_handshake"
    | "event_lineage_hop"
    | "collaboration_command_result"
    | "nested_management_lineage_hop"
    | "nested_management_live_handshake"
    | "nested_management_transport_attestation"
    | "nested_management_capability_continuation"
    | "nested_positive_never_started_attestation"
    | "nested_target_ready_attestation"
    | "nested_chat_edge_capability_continuation"
    | "historical_reattestation";
  canonicalPayloadSchemaId: string | null;
  canonicalPayloadRef: string | null;
  canonicalPayloadDigest: string | null;
  signedRecordDigest: string | null;
  signature: string | null;
  signedArtifactType: string | null;
  signedArtifactId: string | null;
  reservedAtMs: number;
  boundAtMs: number | null;
  signedAtMs: number | null;
  abortedAtMs: number | null;
  state: "reserved" | "bound" | "signed" | "aborted";
}

interface ServerSignedRecordAcceptanceRecord {
  collaborationServerId: string;
  acceptedAtJournalSeq: number;
  signedRecordDigest: string;
  signerIdentityKeyId: string;
  signerKeyGeneration: number;
  signerScopeCertificateId: string;
  signerSequence: number;
  acceptedAtMs: number;
  historicalReattestationId: string | null;
}

interface HistoricalRecordReattestationRecord {
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/historical-record-reattestation/v1";
  historicalReattestationId: string;
  supersedesHistoricalReattestationId: string | null;
  collaborationServerId: string;
  historicalRecordDigest: string;
  historicalSignerIdentityKeyId: string;
  historicalSignerScopeCertificateId: string;
  issuedAtMs: number;
  signerIdentityKeyId: string;
  signerKeyGeneration: number;
  signerScopeCertificateId: string;
  signerSequence: number;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  signature: string;
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
  schemaVersion: 1;
  canonicalPayloadSchemaId: "remote-claw/event-lineage-hop/v1";
  lineageId: string;
  hopIndex: number;
  collaborationServerId: string;
  logicalChatId: string;
  inwardEdgeId: string;
  direction: "inward-proposal" | "outward-observation";
  canonicalEnvelopeSchemaId: string;
  canonicalEnvelopeDigest: string;
  priorChainDigest: string;
  signerIdentityKeyId: string;
  signerKeyGeneration: number;
  signerScopeCertificateId: string;
  signerSequence: number;
  signatureAlgorithm: "Ed25519";
  canonicalPayloadDigestAlgorithm: "SHA-256";
  canonicalPayloadDigest: string;
  chainDigest: string;
  signature: string;
  signedRecordDigest: string;
}

interface EventLineageRecord {
  lineageId: string;
  origin: EventOrigin;
  originDigest: string;
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

interface OutsideIngressFamilyCapability {
  capabilityEntryDigest: string;
  scopeKind: "server_control" | "chat";
  sourceOperationKind: string;
  sourcePayloadSchemaId: string;
  sourcePayloadDigestAlgorithm: "SHA-256";
  sourceParserSchemaId: string;
  sourceParserImplementationDigest: string;
  sourceEventIdExtractionSchemaId: string;
  sourceEventIdExtractionImplementationDigest: string;
  sourceCoordinateSchemaId: string;
  sourceCoordinateImplementationDigest: string;
  sourceFingerprintSchemaId: string;
  sourceFingerprintImplementationDigest: string;
  sourceFingerprintDigestAlgorithm: "SHA-256";
  namespaceBoundaryClassifierSchemaId: string;
  namespaceBoundaryClassifierImplementationDigest: string;
  fingerprintCapabilityRelation: "same_verified_snapshot";
  normalizationSchemaId: string;
  normalizationImplementationDigest: string;
  normalizedMutationFamily: NativeMutationFamily;
  canonicalCommandPayloadSchemaId: string;
  acknowledgement: "none" | "transport_receipt" | "durable_receipt";
  cursor: "none" | "connection_scoped" | "namespace_scoped";
  replayIdentity: "stable_key" | "namespace_key" | "read_back";
  evidenceRef: string;
  evidenceDigest: string;
}

interface OutsideProtocolCapabilities {
  schemaVersion: 1;
  providerKind: "anthropic_remote" | "chatgpt_remote" | "automation" | "nested_remote_claw";
  providerProtocolVersion: string;
  providerProtocolSchemaId: string;
  connectorBinaryDigest: string;
  ingressCapabilityVectorRef: string;
  ingressCapabilityVectorDigest: string;
  projectionCapabilitySchemaId: string;
  projectionCapabilityVectorRef: string;
  projectionCapabilityVectorDigest: string;
  controlCapabilitySchemaId: string;
  controlCapabilityVectorRef: string;
  controlCapabilityVectorDigest: string;
  canonicalCapabilityDocumentDigest: string;
}

interface OutsideBindingCapabilitySnapshot {
  capabilitySnapshotId: string;
  outsideIncarnationId: string;
  schemaVersion: 1;
  capabilityDocumentRef: string;
  capabilityDocumentDigest: string;
  evidenceRef: string;
  evidenceDigest: string;
  canonicalSnapshotDigest: string;
  verifiedAtMs: number;
}

interface OutsideBindingCapabilityVerification {
  capabilityVerificationId: string;
  outsideIncarnationId: string;
  capabilitySnapshotId: string;
  capabilitySnapshotDigest: string;
  coordinatorEpoch: number;
  connectionEpoch: number;
  verifierSchemaId: "remote-claw/outside-capability-verification/v1";
  evidenceRef: string;
  evidenceDigest: string;
  canonicalVerificationDigest: string;
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
  scopeKind: "server_control" | "chat";
  logicalChatId: string | null;
  sourceScopeId: string;
  lineageKind: "chat" | "server_control_source" | "server_control_management";
  lineageRef: string;
  lineageDigest: string;
  outsideBindingId: string;
  observedOutsideIncarnationId: string;
  sourceEventNamespaceId: string | null;
  sourceEventId: string;
  sourceReplayIdentity: string | null;
  sourcePayloadSchemaId: string;
  sourcePayloadRef: string;
  sourcePayloadDigestAlgorithm: "SHA-256";
  sourcePayloadDigest: string;
  coordinateSchemaId: string;
  sourceCoordinate: string;
  namespaceTransitionId: string | null;
  classificationEvidenceRef: string | null;
  classificationEvidenceDigest: string | null;
  sourceCapabilitySnapshotId: string;
  sourceCapabilitySnapshotDigest: string;
  sourceCapabilityVerificationId: string;
  sourceCapabilityVerificationDigest: string;
  ingressCapabilityEntryDigest: string;
  normalizationSchemaId: string;
  normalizationImplementationDigest: string;
  coordinatorEpoch: number;
  connectionEpoch: number;
  fingerprintSchemaId: string;
  fingerprintDigestAlgorithm: "SHA-256";
  eventFingerprint: string;
  fingerprintCapabilitySnapshotId: string;
  sourceObservationEvidenceDigest: string;
  disposition: "pending" | "new" | "duplicate" | "collision" | "ambiguous";
  canonicalSourceEventId: string | null;
  commandId: string | null;
  recoveryGapId: string | null;
}

interface CanonicalSourceEventRecord {
  canonicalSourceEventId: string;
  collaborationServerId: string;
  scopeKind: "server_control" | "chat";
  logicalChatId: string | null;
  sourceScopeId: string;
  lineageKind: "chat" | "server_control_source" | "server_control_management";
  lineageRef: string;
  lineageDigest: string;
  outsideBindingId: string;
  observedOutsideIncarnationId: string;
  sourceEventNamespaceId: string;
  sourceEventId: string;
  firstObservationId: string;
  firstObservationEvidenceDigest: string;
  sourceReplayIdentity: string | null;
  sourcePayloadSchemaId: string;
  sourcePayloadRef: string;
  sourcePayloadDigestAlgorithm: "SHA-256";
  sourcePayloadDigest: string;
  sourceCapabilitySnapshotId: string;
  sourceCapabilitySnapshotDigest: string;
  sourceCapabilityVerificationId: string;
  sourceCapabilityVerificationDigest: string;
  ingressCapabilityEntryDigest: string;
  normalizationSchemaId: string;
  normalizationImplementationDigest: string;
  coordinatorEpoch: number;
  connectionEpoch: number;
  fingerprintSchemaId: string;
  fingerprintDigestAlgorithm: "SHA-256";
  eventFingerprint: string;
  fingerprintCapabilitySnapshotId: string;
  canonicalSourceEventDigest: string;
  commandId: string;
}
```

Schema v7 implements the capability-pin, route, and generation records above. Schema v8 implements
the A1.7a route-runtime/generation observations, manifest and position equivocations, separate fetch
and semantic cursors, retained page/frame/position evidence, multipart ingress, tombstones, gaps, and
recoveries described here. Schema v9 implements only A1.7b0's server key/envelope,
certificate/status, bootstrap/current signing lease, signature reservation, and signed-record
acceptance subset needed for the dormant initial self-anchor and signer. Schema v10 implements only
A1.7b1's ready entry, A1 ingress sidecar, common command, compound group, and replaceable signed
result-preparation subset. It consumes an eligible ingress source and allocates a rejected decision,
but schema v10 cannot create the final common result, signer acceptance, terminal sidecar/source
overlay, or result-delivery intent. Schema v11 A1.8a0 adds exactly those rejected-only rows in one
transaction while retaining the base ingress evidence and an unclaimable `pending_seal` state. It
still cannot create an admitted/effect/native/projection record, ciphertext/output signature, or
broker publish. Those remain full A1.8a, A1.8b, and A1.10 work.

`ServerScopeCertificateStatusRecord.scopeCertificateId` is a foreign key to the immutable certificate,
and its `collaborationServerId` must equal that certificate's server ID. A status row cannot move a
certificate between server scopes. A `subjectIdentityKeyId` is globally unique within one server's
complete certificate history and is introduced by exactly one certificate; explicit re-pairing must
use a fresh key ID and fresh key bytes. Signer lookup therefore resolves through
`ServerIdentityKeyRecord.introducedByScopeCertificateId`, and retiring or revoking that certificate
also retires or revokes that key for new signatures. Reusing the key under another certificate or
generation is a hard chain error.

`revoked` is receiver-local operator policy, not a status learned from the onboarding bundle, shared
keys, or broker metadata. Every statement below that a viewer or nested peer rejects a revoked signer
means that receiver has an authenticated local revocation/trust-reset decision for that certificate.
A current key cannot securely announce its own compromise, and selected A1 defines no global
revocation feed. Compromise of the current key therefore requires an out-of-band operator trust reset
and re-pair; a broker-delivered “revoked” claim is ignored. A future distributed revocation protocol
needs its own signed record, ordering, cutoff, delivery, and compromised-current-key recovery design.

The server identity private key never enters a viewer pass, broker request, coordinator row, argv,
environment, log, artifact DTO, or public API. A1.7b0 implements only the literal `owned-file`
`ServerIdentityPrivateKeyEnvelopeRecord`: `signingKeyRef` identifies the protected handle, while
AES-256-GCM ciphertext, nonce, tag, and the PKCS#8 digest are the durable values. Its distinct HKDF
domain and canonical AAD bind the machine identity, collaboration server, protected handle, key ID,
key generation, `Ed25519` algorithm, `owned-file` backend, public key, and PKCS#8 digest. The
process-lifetime custody capability generates, signs, self-tests, and closes without exporting raw
private-key bytes. A changed binding coordinate, envelope, tag, or root secret fails closed.

A1.7b0 freezes these custody domains and deterministic key identity:

```text
SERVER_KEY_WRAP_SCHEMA_ID = "remote-claw/server-identity-key-wrap/aes-256-gcm/v1"
SERVER_SCOPE_CERTIFICATE_SCHEMA_ID = "remote-claw/server-scope-certificate/v1"
SERVER_SCOPE_CERTIFICATE_SIGNED_DOMAIN = "remote-claw/server-scope-certificate-signed/v1"
SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID = "remote-claw/server-signer-bootstrap-intent/v1"
SERVER_IDENTITY_KEY_ID_DOMAIN = "remote-claw/server-identity-key-id/v1"
SERVER_KEY_WRAP_KDF_DOMAIN = "remote-claw/server-key-wrap-kdf/v1"
SERVER_KEY_SELF_TEST_DOMAIN = "remote-claw/server-key-self-test/v1"

identityKeyId = "sik_" + base64url(SHA-256(
  str(SERVER_IDENTITY_KEY_ID_DOMAIN) ||
  bytes(machineIdentityId) || str(collaborationServerId) ||
  uint(keyGeneration) || bytes(base64urlDecode(publicKey))
))

wrapKey = HKDF-SHA256(
  ikm = rootSecret,
  salt = empty,
  info = utf8(SERVER_KEY_WRAP_KDF_DOMAIN),
  length = 32
)

canonicalWrapAad =
  str(SERVER_KEY_WRAP_SCHEMA_ID) || bytes(machineIdentityId) ||
  str(collaborationServerId) || str(identityKeyId) || uint(keyGeneration) ||
  str("Ed25519") || str(signingKeyRef) || str("owned-file") ||
  bytes(base64urlDecode(publicKey)) || bytes(base64urlDecode(pkcs8Digest))

bootstrapIntentDigest = base64url(SHA-256(
  str(SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID) || uint(1) ||
  bytes(machineIdentityId) || str(collaborationServerId) ||
  str(bootstrapSigningLeaseId) || str("initial_pair") || optionalStr(null) ||
  str(proposedIdentityKeyId) || uint(1) || str("Ed25519") ||
  bytes(base64urlDecode(proposedPublicKey)) || str(proposedScopeCertificateId) ||
  str(signingKeyRef) || uint(preparedAtMs)
))

initialScopeCertificateSignedRecordDigest = base64url(SHA-256(
  str(SERVER_SCOPE_CERTIFICATE_SIGNED_DOMAIN) ||
  bytes(base64urlDecode(canonicalPayloadDigest)) ||
  str(signerIdentityKeyId) || uint(keyGeneration) || uint(signerSequence) ||
  bytes(base64urlDecode(signature))
))
```

The custody root-secret input is exactly 32 bytes. The AES-GCM nonce is 12 bytes, tag is 16 bytes,
and wrapped PKCS#8 is bounded to 1–1,024 bytes.
`pkcs8Digest` is canonical unpadded-base64url SHA-256. Canonical wrap AAD includes the wrap schema,
machine identity, collaboration server, protected handle, identity key ID, generation, literal
`Ed25519` algorithm, literal `owned-file` backend, public key bytes, and PKCS#8 digest bytes. The
generation API takes the machine identity and protected handle explicitly; neither may be filled in
after encryption.

For machine `00112233445566778899aabbccddeeff`, server
`rcs_EREiIjMzRERVVVZmZnd3dw`, generation `1`, and public key
`AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`, the locked identity is
`sik_QFJ2gR1wTxfCt-XCPasn8zCp0kcAarYOfFcTOy3J7cc`. The bootstrap-intent fixture using lease
`sbs_initial`, proposed key `sik_vector`, certificate `ssc_vector`, handle
`rcph_ABEiM0RVZneImaq7zN3u_w`, and `preparedAtMs:123456789` locks digest
`T_gSdGZj6UBOkgglxF0kPl7fvrOdRJEMSondnytkmXU`.

The strict v9 purpose registry freezes the wider purpose-to-schema namespace for later signers, but
the A1.7b0 callable bootstrap accepts only
`scope_certificate → remote-claw/server-scope-certificate/v1`. Merely parsing or persisting another
purpose name does not make its producer or delivery path available.

Outside the bootstrap exception below, the frozen signing-service contract signs only for the unique
current `ServerSigningLeaseRecord`, after atomically checking its server, key generation, scope
certificate, coordinator lease ID/epoch, and monotonically fenced token. Every successful server signature atomically
uses a durable `ServerSignatureReservationRecord`. The service first reserves and increments the next
server-wide `signerSequence`, then the caller constructs the canonical payload containing that sequence.
The service accepts only the closed purpose union above, parses that purpose's exact canonical schema,
and itself checks the payload server/key/certificate/sequence against the current lease before it
compare-and-swaps the reservation from `reserved` to `bound` with the exact immutable canonical
payload bytes/ref, schema ID, SHA-256 `canonicalPayloadDigest`, and target artifact identity. A
signed-record digest cannot exist yet because it contains the signature. The service signs only those
validated canonical bytes, then atomically changes `bound → signed` while persisting the canonical
64-byte signature and purpose-specific `signedRecordDigest` before releasing either the signature or
artifact. Every result or secondary preparation must match that reservation's bound payload digest.
A bound crash
can therefore resume only those exact bytes; a signed crash replays the stored signature. It never
reconstructs randomized ciphertext, reseals a host frame, or asks a retired key to sign again. It is
custody and stale-owner fencing, not a security boundary from the current coordinator; that
coordinator remains trusted for server policy. The broader target permits a crash to resume the exact
bound intent or mark an unbound reservation `aborted`; either way the sequence is burned and never
reused. A1.7b0 exposes reconciliation, not a generic abort operation. This reserve/bind/sign order is required for host frames because the sequence
is already inside AEAD AAD before ciphertext and its signature payload exist.

Acceptance appends `ServerSignedRecordAcceptanceRecord` at the next dense per-server
`acceptedAtJournalSeq` and also samples `acceptedAtMs`. That row is the signer-acceptance journal; it
does not allocate or widen A1.2's schema-v3 `control_journal_entries` sequence.

Initial self-signing and explicit re-pair are the only exception to requiring an already current
certificate, and they use a separate one-shot `ServerBootstrapSigningLeaseRecord`, not a normal
signing lease. An operator-confirmed transaction first places the server in `installing` or
`repairing`, creates the protected proposed key handle, pins the proposed server/key/generation/
self-signed-certificate coordinates and prior certificate expectation, and opens one fenced bootstrap
lease whose only allowed purpose is `scope_certificate`. It uses the same durable server-wide sequence
reservation and exact payload/signature persistence. The signed-store transaction verifies that exact
self-signature, persists the reservation's signature and signed-record digest, inserts the immutable
certificate, and marks the bootstrap lease signed. A separate finalization transaction re-verifies
that stored certificate, activates the key/status and acceptance, advances the current pointers, opens
the normal current signing lease, and marks the bootstrap lease installed/closed. A crash resumes only
that exact intent; a different key/certificate requires a new operator action. The bootstrap lease
cannot sign host output, onboarding attestation, topology, or any other record and cannot exist while
the server is normally writable. Re-pair uses a fresh key ID/key bytes and is an out-of-band trust
reset, never a continuity rotation.

Coordinator takeover does not repair a non-closed bootstrap. The exact bootstrap lease, key envelope,
and sole reservation remain immutable, reconciliation returns `writable:false` with
`nonWritableReason:"stale_bootstrap_fence"`, and v9 permits neither re-fencing/replacement nor a
second reservation. A later explicit-repair milestone must resolve that fail-stop. After a bootstrap
has installed its certificate and current signing lease, coordinator takeover instead supersedes the
normal lease. Once no `reserved`, `bound`, or signed-but-unaccepted predecessor reservation remains,
the successor may acquire a fresh current lease whose fencing token is exactly the predecessor token
plus one.

A1.7b0's callable repository/service path proves only the `initial_pair` self-anchor's
reserve/bind/sign/accept/reconcile flow and acquisition of the installed current lease. Generic
current-lease signing, `explicit_repair`, retirement/revocation, continuity rotation, and historical
reattestation remain frozen target contracts; schema v9's ability to represent them is not a claim
that their transition services or delivery paths have landed.

Continuity rotation changes the old lease to `draining`, rejects new ordinary signing work, and settles
or burns every reservation. It then reserves the final old-key sequence and uses the still-accessible old key
to sign and durably persist the successor certificate; that certificate has
`supersededSignerMaxSequence === signerSequence`. It durably publishes the public certificate-update
record while the old pointer remains current. One transaction then advances the current
certificate/key pointer, records the old status cutoff, supersedes the old lease, and opens the new
lease. Only after that commit may the old private key become inaccessible and be retired or destroyed.
A crash before the successor is durable resumes the draining old lease; a crash after durability
replays the pointer transaction; a crash after the swap can only use the new lease. If the exact
current private key cannot be recovered after restart, the server is non-writable and requires
explicit re-pairing; it must not mint a new key under the old key ID or silently replace the current
certificate.

The signing service's durable sequence ledger and `nextServerSignatureSeq` advance in one transaction.
Startup compares the counter with the greatest sequence across every durable reservation state
(`reserved`, `bound`, `signed`, and `aborted`), every accepted signed record, and every installed
certificate cutoff, then resumes only at exactly `max + 1`; a lower/stale counter, missing burned
reservation, or missing ledger entry leaves signing non-writable. No crash, key rotation, or
coordinator replacement may reuse a server-wide sequence.

`BrokerRouteRecord` is the physical ordering scope. Its ID is
`rcr_${base64url(SHA256(str("remote-claw/a1/broker-route/v1") || bytes(identity_id) ||
str(collaborationServerId) || str(routeKind) || optionalStr(logicalChatId)))}`. A `scope_bus` row has a
null chat and exact canonical bus token; a `server_control` row has a null chat and distinct canonical
management token; a `chat` row has a non-null chat and its exact canonical session token. The complete
coordinate and `routeToken` are immutable and independently unique. Thus
announcements for several chats share one scope-bus cursor sequence, while each chat stream has its own
sequence and server-management ingress has a third sequence.

The A1.6 broker creates every physical route atomically with its open generation zero, then the
host-only installer commits the matching protected capability pin, `BrokerRouteRecord`, and
`BrokerChannelGenerationRecord` together under the current coordinator fence;
`genesisGeneration` is always exactly `0`. The accepted open receipt must report both genesis and
current generation as pristine open zero with observed next frame index zero. A null local cursor means
“before `(0,0)`,” never “start at the broker's current generation.” A mutating chat or server-control subscriber must
either retain its contiguous cursor or replay the complete immutable manifest chain from generation
zero. If the broker begins at generation `N > 0`, omits genesis, or cannot prove every successor from
genesis to the requested position, the route is quarantined and non-writable.

The planned discovery bus has one deliberately narrower cold-start exception. A viewer that will use it only
for fresh, host-signed `session_announce` liveness may begin from a recent
`BrokerScopeBusCheckpointRecord` after verifying its current certified host signature and complete
coordinate. It may not use that checkpoint to infer historical membership, acknowledge a semantic
mutation, or seed a chat cursor. Any chat opened from an announcement still starts its own chat route
at genesis or at a previously retained chat cursor.

A future checkpoint is separate signed broker metadata, never a frame at a cursor. It is not part of
A1.6. When A1.10 adds it, the broker
atomically seals the current bus generation, fixes its manifest/frame count, and opens the unique
successor. Only after the host observes and verifies that sealed manifest does it allocate a server
signature and publish this checkpoint under the exact route/generation/digest key. If
`sealedFrameCount > 0`, `throughCursor` is exactly
`(throughSealedGeneration, sealedFrameCount - 1)`; if it is zero, `throughCursor` is null. The
checkpoint payload is:

```text
str(canonicalPayloadSchemaId)
uint(schemaVersion)
str(scopeBusCheckpointId)
str(brokerRouteId)
uint(throughSealedGeneration)
uint(successorGeneration)
uint(sealedFrameCount)
optionalCursor(throughCursor)
bytes(base64urlDecode(throughManifestDigest))
uint(issuedAtMs)
uint(signerSequence)
uint(serverKeyGeneration)
str(signerIdentityKeyId)
str(signatureAlgorithm)
str(canonicalPayloadDigestAlgorithm)
```

`successorGeneration` is exactly `throughSealedGeneration + 1`. `optionalCursor(null)` is `0x00`; a value is `0x01 || uint(version) || uint(generation) ||
uint(frameIndex)`. The signature/digest rules are the common server-signature rules below. The
subscribe API may return this metadata plus frames beginning in the successor generation. A cold
viewer accepts it only for the exact scope-bus route, while the signing certificate is current, and
within the configured discovery freshness window; it still renders only later individually fresh
signed announcements. Open-generation claims, wrong empty/non-empty cursor shape, stale checkpoints,
changed manifests, competing checkpoints for one sealed tip, and missing successors quarantine the
bus. Checkpoints never appear on a chat route.

Future checkpoint acceptance compare-and-swaps one `AppliedScopeBusCheckpointRecord` and persists
`effectiveStartGeneration = successorGeneration` before consuming a later frame. That record, not a
nullable frame cursor, survives restart and distinguishes “trusted through an empty generation” from
“before genesis.” Exact checkpoint replay is idempotent; another checkpoint or start generation for the
same applied boundary is equivocation.

`ChannelPositionRecoveryRecord` always names the quarantined route. Exactly one target field is
non-null: `manifestEquivocationId` for `manifest_equivocation`,
`transportKeyCollisionId` for `transport_collision`, and `channelPositionObservationId` for every
other reason. A transport-key collision preserves the original good cursor/bytes and stores the
conflicting normalized digest/evidence in its own row; recovery never points at the original position
as though those accepted bytes were bad. Recovery never rewrites the accepted position bytes/digest or
generation manifest; it only records an audited safe-discard/closure decision and may release the
route's contiguous cursor when no other gap remains.

`AuthenticatedIngressResultRecord` has a unique key on
`(brokerRouteId, sourceEventNamespaceId, msgId)`. `brokerRouteId` is always non-null, avoiding
nullable-SQL uniqueness, and immutably resolves the server/route/chat tuple. `logicalChatId`
is non-null for `chat` and null for `server_control`.
Its `stableSemanticResultId` is not random:
`rrs_${base64url(SHA256(str("remote-claw/a1/semantic-result/v1") || bytes(identity_id) ||
str(collaborationServerId) || str(routeKind) || optionalStr(logicalChatId) ||
str(sourceEventNamespaceId) || str(msgId)))}`.
That full scoped input is immutable and unique. The row ID, every result-frame `msgId`, and the
payload's `result_id` must be exactly that value; a different scoped input cannot reuse it, and a
same-scope digest/ID collision quarantines the route rather than selecting either result.
For a complete A1 proposal,
`sourceCommandIdentityDigest = SHA256(str("remote-claw/command-source/a1/v1") ||
bytes(identity_id) || str(collaborationServerId) || str(routeKind) ||
optionalStr(logicalChatId) || str(sourceEventNamespaceId) || str(msgId))`.
The common command ID is
`rcm_${base64url(SHA256(str("remote-claw/collaboration-command/v1") ||
str(collaborationServerId) || str(sourceKind) ||
bytes(base64urlDecode(sourceCommandIdentityDigest))))}`. Every complete semantic proposal, including a rejected
server-control creation, therefore has a stable command before any target chat exists. A normal chat
command, effect gate, native attempt, and foreign keys retain the same server/chat scope. An admitted
server-control command additionally and immutably names its once-allocated `targetLogicalChatId`; only
its creation reservation/effect crosses into that target. Equal source IDs on another route or server
cannot alias either gate.

**A1.7b1 implementation boundary.** The formulas above are live pure contracts, but schema v10 calls
them only for `sourceKind:"a1_ingress"` and only after A1.7a has retained a complete eligible route
head. It atomically writes the command, its A1 sidecar, and a ready entry at the exact shared server
journal offset. Control-journal and ready-journal entries together must be unique and contiguous to
`nextJournalOffset`. It refuses a 257th unresolved command. The current global sequencer selects only
the minimum `(readyAtJournalSeq, commandId)`, allocates the next dense `commandSeq`, and freezes only
`rejected`; all admitted/queued, outside-source, target-capability, and effect arms described later in
this section remain target contracts. Creation lease/epoch/time remain immutable when a successor
current coordinator supplies the separate decision lease/epoch/time.
For the shared-key A1 web channel, `sourceEventNamespaceId` is immutable for the route's entire
lifetime and equals
`wns_${base64url(SHA256(str("remote-claw/a1/web-source-namespace/v1") || bytes(identity_id) ||
str(collaborationServerId) || str(routeKind) || optionalStr(logicalChatId)))}`. It is derived from the authenticated route, not
the current connection, and never resets on reconnect, client replacement, coordinator restart, broker
generation rollover, local chat closure, or machine reset. Selected A1 defines no namespace transition
for an existing route; a reset creates a distinct new identity/routes without reclassifying or
collecting the old one. Thus a withheld unseen ciphertext always re-enters the same namespace.
Official and nested connectors keep their own separately authenticated source namespaces and
transition rules.

Official-client, automation, and nested-server events normalize into the same
`CollaborationCommandRecord`, never an adapter-specific side path. Their source digest is
`SHA256(str("remote-claw/command-source/outside/v1") || str(collaborationServerId) ||
str(scopeKind) || optionalStr(logicalChatId) || str(outsideBindingId) ||
str(sourceEventNamespaceId) || str(sourceEventId) ||
bytes(base64urlDecode(canonicalSourceEventDigest)))`; their command ID uses the common formula above
with their exact `sourceKind`. `canonicalSourceEventDigest` is null exactly for `a1_ingress` and
non-null/equal to the immutable `CanonicalSourceEventRecord` for every official-client, automation, or
nested-server source. `OutsideBindingRecord`, `SourceEventObservationRecord`, and
`CanonicalSourceEventRecord` permit null chat only with `scopeKind:"server_control"` and a typed
`new_chat`; ordinary starts/steers require a chat. Provider event replay/collision is resolved before
the command row, and an official or nested creation result maps its stored outer target back to the
exact provider/source event.

The selected common payloads have one byte-level encoding independent of source:

```text
user_text =
  str("remote-claw/command-payload/user-text/v1") || uint(1) || str(text)

new_chat =
  str("remote-claw/command-payload/new-chat/v1") || uint(1) ||
  str(creationIntent) || str(projectId) || str(workspaceSelectorId)

attachment =
  str("remote-claw/command-payload/attachment/v1") || uint(1) ||
  optionalStr(caption) || uint(itemCount) ||
  bytes(base64urlDecode(itemVectorDigest))

unsupported_recognized =
  str("remote-claw/command-payload/unsupported-recognized/v1") || uint(1) ||
  str(normalizedMutationFamily) || str(sourcePayloadSchemaId) ||
  bytes(base64urlDecode(sourcePayloadDigest)) ||
  bytes(base64urlDecode(sourceEventFingerprint))
```

The corresponding `canonicalCommandPayloadSchemaId` is the leading domain string, the payload ref
retains exactly those bytes plus the typed ref-bearing record needed to resolve any subordinate
content, and `canonicalCommandPayloadDigest` is SHA-256 of the listed bytes. `creationIntent`
is exactly `first_bootstrap` or `new_chat`; project/workspace selectors use the A1 safe-ID grammar.
Text is valid UTF-8 encoded from Unicode scalar values exactly as supplied, with no normalization,
newline rewrite, slash parsing, or source-specific wrapper. Web, official, automation, and nested
adapters must produce byte-identical common payloads for the same typed input.

The pure version-one `user_text` codec accepts at most 48 MiB of UTF-8 bytes. A1.7b1's rejected-only
repository does not duplicate that retained plaintext. For both currently recognized A1.7a source
kinds it persists the small `unsupported_recognized` form containing the normalized family, exact
source payload schema, canonical message digest, and source-event fingerprint. Those values bind the
complete segmented A1.7a evidence; this is not a truncated text payload. A future admitted path must
materialize the exact canonical `user_text` or `new_chat` payload before it may claim the associated
capability.

The attachment arm is exact rather than an adapter-shaped JSON pass-through. Its item ref retains
`CanonicalAttachmentItemRecord` values in contiguous `itemIndex` order starting at zero. Each
`contentRef` retains the exact decoded file bytes, `contentLength` equals their byte length,
`contentDigest` is SHA-256 of those bytes, and:

```text
canonicalItemDigest =
  SHA256(str(canonicalItemSchemaId) || uint(schemaVersion) || uint(itemIndex) ||
         str(clientFileName) || str(mediaType) || uint(contentLength) ||
         bytes(base64urlDecode(contentDigest)))

itemVectorDigest =
  SHA256(str("remote-claw/command-payload/attachment-item-vector/v1") ||
         uint(itemCount) ||
         for item in itemIndex order:
           bytes(base64urlDecode(item.canonicalItemDigest)))
```

Selected version one requires 1 through 24 items, one of the four literal media types in
`CanonicalAttachmentMediaType`, at most 12 MiB of decoded bytes per item, at most 36 MiB in total, a
1-to-255-byte UTF-8 scalar filename containing no NUL, control, `/`, or `\\`, and either a null caption
or a scalar caption of at most 16 KiB UTF-8. An absent source caption maps to null; an explicitly
present empty caption maps to the non-null empty string. Those remain distinct canonical inputs, and
every source adapter must preserve that distinction. It preserves filename, caption, item order, media type, and bytes exactly; it
does not apply filesystem sanitization or native path generation. Those are later deterministic
translator outputs. A source base64 spelling is accepted only if strict canonical decoding succeeds,
then disappears: the common payload commits the decoded bytes. The payload's count/vector digest and
every item/content ref must recompute before ordering.

Every admitted `attachment` command, regardless of A1, official, automation, or nested source, must
have `mutationFamily:"attachment"`,
`canonicalCommandPayloadSchemaId:"remote-claw/command-payload/attachment/v1"`, and the exact payload
and item/content chain above. Conversely, that schema is invalid for every other family. A target
capability may admit attachments only when its family entry names that same common schema and a
translator/read-back proof for every item. For a nested target, the distinct
`NestedChatEdgeFamilyCapability.canonicalCommandPayloadSchemaId` names this common schema;
`targetRequestSchemaId` names the outer nested wire request and cannot stand in for it. An unsupported
target still orders the source operation as `attachment` but uses `unsupported_recognized` for the
rejected command payload; it never receives an `accepted` attachment result. Every nested attachment
source must also transmit the portable common-payload transfer bundle defined in §10.5. A source-local
payload, item, or content ref is not transferable: the bundle carries the exact common payload bytes,
canonical item-record bytes, and decoded content bytes so the target can materialize new local refs
and independently recompute the complete chain.

Any other family needs
its own versioned common schema before it can be writable. A recognized but unsupported family uses
the `unsupported_recognized` envelope, whose `canonicalCommandPayloadSchemaId` is its leading domain; it commits the
normalized family plus the source parser's exact schema, payload digest, and canonical source-event
fingerprint. It therefore receives a signable ordered rejection without being reinterpreted as
`user_text`. An unknown/unparseable source operation has no normalized family and fails before common
command allocation under that source protocol's authenticated error rules.
For an outside source, `sourcePayloadSchemaId`/`sourcePayloadDigest` and
`sourceEventFingerprint` are exactly the immutable `CanonicalSourceEventRecord` fields. For A1,
`sourcePayloadSchemaId` is the selected exact proposal schema,
`sourcePayloadDigest` is SHA-256 of its retained complete canonical plaintext, and
`sourceEventFingerprint` is:

```text
SHA256(str("remote-claw/a1/source-event-fingerprint/v1") || str(brokerRouteId) ||
       str(sourceEventNamespaceId) || str(msgId) ||
       bytes(base64urlDecode(canonicalMessageDigest)))
```

The completed ingress row retains that exact schema in `sourcePayloadSchemaId`;
`sourcePayloadDigest` is exactly its non-null `canonicalMessageDigest`. Both that digest and the
fingerprint use canonical SHA-256 with unpadded base64url 32-byte values. For a semantically complete
row, the schema, message digest, fingerprint schema, and fingerprint are all non-null before
`awaiting_order`; for an assembling or incomplete row they are all null, and a collision never changes
the first complete tuple. `OpenCodePreDecisionNormalizationEvidence` repeats those exact schema,
digest, and fingerprint values. A stored unsupported result can therefore be reconstructed after
restart without a `recordKind` default or a newer adapter parser.
`user_text` means an explicit new submit only. A source-native steer operation normalizes to the
distinct recognized `steer_text` family and uses the signed `unsupported_recognized` envelope until a
target-specific steer capability and common payload schema land. Busy state, arrival timing, or a
currently running turn never converts submit into steer or steer into submit.

For an OpenCode-targeted generic text operation, normalization is an immutable pre-decision step. The
slash table ref retains `NativeSlashCommandNormalizationItem` values ordered by unsigned exact UTF-8
text bytes; empty, duplicate, prefix/wildcard, reordered, or non-scalar entries are invalid. Its digest
is:

```text
SHA256(str("remote-claw/opencode-slash-command-table/v1") ||
       str(slashCommandNormalizationSchemaId) || uint(count) ||
       for item in order:
         str(item.exactUtf8Text) || str(item.normalizedMutationFamily))
```

Initial A2 maps exact `/compact → compact`, `/clear → clear`, `/model → set_model`, and
`/context → session_command`; it defines no prefix or argument parser. Blank input maps to the distinct recognized
`blank_submit` family. Every nonblank nonmatching generic submit remains `user_text`; an explicit
source steer remains `steer_text` and never enters this submit rule.

The `OpenCodePreDecisionNormalizationEvidence` canonical bytes are:

```text
str(preDecisionNormalizationEvidenceSchemaId) || uint(schemaVersion) || str(commandId) ||
str(sourceKind) || str(sourceRef) || str(sourcePayloadSchemaId) ||
bytes(base64urlDecode(sourcePayloadDigest)) ||
bytes(base64urlDecode(sourceEventFingerprint)) || str(collaborationServerId) ||
str(logicalChatId) || str(nativeBindingId) || str(runtimeId) || uint(nativeIncarnation) ||
str(capabilitySnapshotId) || bytes(base64urlDecode(capabilitySnapshotAttestationDigest)) ||
str(slashCommandNormalizationSchemaId) ||
bytes(base64urlDecode(slashCommandNormalizationImplementationDigest)) ||
bytes(base64urlDecode(slashCommandTableDigest)) || str(classification) ||
str(normalizedMutationFamily) || str(canonicalCommandPayloadSchemaId) ||
bytes(base64urlDecode(canonicalCommandPayloadDigest))
```

Its digest is SHA-256 of those bytes and the command record commits it even when the decision rejects
and has no admitted target capability. The ref, source payload/event, current binding/runtime,
runtime-owner-signed snapshot, parser implementation, table, classification, and normalized output
must all recompute. `/compact` cannot be admitted as literal `user_text`; a snapshot/table race rejects
that command under its recorded evidence and never re-normalizes it after restart. For non-OpenCode
explicit typed input this evidence is null; using null for generic text aimed at an OpenCode binding is
invalid before ordering.

Lineage is also scope-closed. Chat events use `lineageKind:"chat"` and a retained
`EventLineageRecord`. Official-client or automation creation uses
`lineageKind:"server_control_source"`; its ref/digest binds the exact server-control outside binding,
current source capability verification, authenticated provider host/project coordinate, namespace,
and event ID. Nested creation uses `server_control_management` and the signed management-lineage
vector. A null-chat event with chat lineage, a provider event with fabricated management lineage, or a
missing/unresolvable lineage ref is ambiguous and creates no command.

An official start is anchored before a provider chat exists by one
`ProviderServerControlBindingRecord` for the paired provider host/project. Its
`outsideBindingId` resolves to that server's null-chat
`OutsideBindingRecord(scopeKind:"server_control")`; the namespace survives connector reconnect and is
never derived from a later provider chat ID. The admitted common result's signed-result finalization atomically creates one
`ProviderChatCreationMappingRecord` from the canonical start event to the allocated remote-claw chat.
When the provider later assigns or reports its chat ID, a compare-and-swap fills that field and creates
the ordinary chat-scoped outside binding/mapping. Anthropic Remote and ChatGPT Remote use the same
shape; neither fabricates a chat-scoped binding to adjudicate the start.
For `anthropic-remote`, exactly `anthropicRemoteHostId` is non-null and foreign-keys a paired
`AnthropicRemoteHostRecord`; for `chatgpt-remote`, exactly `chatGptRemoteHostId` is non-null and
foreign-keys a paired `ChatGptRemoteHostRecord`. A free provider host string or cross-provider host ID
cannot authorize creation.

Both A1 results and canonical outside events foreign-key one common command. The record owns the typed
family/payload digest, ready journal position, server-wide `commandSeq`, disposition, target, and
pinned inward capability entry. The server sequencer considers only these rows, across all source
kinds, and orders ready rows by `(readyAtJournalSeq, commandId)`. It allocates a unique, gap-free
`commandSeq` from `CollaborationServerRecord.nextCommandSeq` in the same transaction that fixes the
disposition. An exact replay links the prior command and receives no second sequence; a collision or
ambiguous outside event receives no command at all.

The command's scope and capability fields are a closed union:

- A chat command has non-null `logicalChatId`, equal non-null `targetLogicalChatId`, and may admit only
  `native_binding` for its terminal native harness or `nested_chat_edge` for an already installed
  inward chat edge.
- A server-control command has null `logicalChatId`, family `new_chat`, and null target until the
  deciding transaction admits it and allocates the non-null target; it may admit only
  `native_server` or `nested_management`. Its decision is terminal `admitted` or `rejected`; selected
  server-control has no queued creation state.
- `native_binding` pins one current `NativeBindingCapabilitySnapshot` family entry;
  `native_server` pins one current `NativeServerCapabilitySnapshot` `new_chat` entry; and
  `nested_management` pins one current `NestedServerManagementCapabilitySnapshot` `new_chat` entry.
  `nested_chat_edge` pins one current `NestedChatEdgeCapabilitySnapshot` family entry plus its exact
  installed edge, topology generation, and live lease.
- A decided admitted command has exactly one target kind and both capability fields non-null. A queued
  or rejected command has all three null. Every frozen decision has a non-null decision-evidence
  schema/ref/digest. An awaiting-order command has null sequence, disposition, target capability,
  decision evidence, and canonical record digest.

The exact decision-evidence payload is:

```text
str(decisionEvidenceSchemaId) || uint(schemaVersion) ||
str(commandId) || str(collaborationServerId) || str(scopeKind) ||
optionalStr(projectTargetSelectorMappingId) ||
optionalUint(projectTargetSelectorMappingGeneration) ||
optionalDigest(projectTargetDigest) || optionalStr(selectedTargetKind) ||
optionalStr(selectedExecutorEvidenceSchemaId) ||
optionalDigest(selectedExecutorEvidenceDigest) ||
optionalStr(targetCapabilitySnapshotId) || optionalDigest(targetCapabilityFamilyDigest) ||
str(decisionPolicyId)
```

`decisionPolicyId` is the literal shown in the schema. Version one means: order only through the common
server sequencer; require a current exact source capability and target executor/capability; fail closed
on unknown, ambiguous, stale, or unsupported input; and create no effect before a signed admitted
result. Changing those rules requires a new decision-evidence schema, so there is no opaque policy
digest an implementation can reinterpret.

`selectedExecutorEvidenceRef` retains exactly one tagged executor-union payload. Its digest is SHA-256
of the corresponding bytes:

```text
native_server =
  str(selectedExecutorEvidenceSchemaId) || uint(schemaVersion) ||
  str(runtimeId) || uint(nativeIncarnation) || str(nativeServerAttachmentLeaseId) ||
  str(serverFrontDoorLeaseId) || str(nativeWorkspaceTransitionBarrierId) ||
  str(serverCapabilitySnapshotId) ||
  bytes(base64urlDecode(capabilitySnapshotAttestationDigest)) ||
  str(projectTargetSelectorMappingId) ||
  uint(projectTargetSelectorMappingGeneration) || bytes(base64urlDecode(projectTargetDigest))

native_binding =
  str(selectedExecutorEvidenceSchemaId) || uint(schemaVersion) ||
  str(nativeBindingId) || str(runtimeId) || uint(nativeIncarnation) ||
  str(attachmentLeaseId) || str(nativeClientIngressLeaseId) || str(capabilitySnapshotId) ||
  bytes(base64urlDecode(capabilitySnapshotAttestationDigest))

nested_management =
  str(selectedExecutorEvidenceSchemaId) || uint(schemaVersion) ||
  str(nestedServerManagementBindingId) || str(nestedServerManagementLeaseId) ||
  uint(leaseGeneration) || uint(sourceCoordinatorEpoch) || uint(targetCoordinatorEpoch) ||
  uint(transportEpoch) ||
  bytes(base64urlDecode(mutualChannelBindingDigest)) ||
  str(nestedServerManagementCapabilitySnapshotId) ||
  bytes(base64urlDecode(nestedServerManagementCapabilitySnapshotDigest))

nested_chat_edge =
  str(selectedExecutorEvidenceSchemaId) || uint(schemaVersion) ||
  str(inwardEdgeId) || uint(sourceTopologyGeneration) || uint(targetTopologyGeneration) ||
  uint(currentConnectionEpoch) || str(inwardLiveLeaseId) ||
  bytes(base64urlDecode(transportChannelBindingDigest)) ||
  str(nestedChatEdgeCapabilitySnapshotId) ||
  bytes(base64urlDecode(nestedChatEdgeCapabilitySnapshotDigest)) || str(targetServerId) ||
  str(targetLogicalChatId) || str(targetOutsideBindingId)
```

The schema tag and `selectedTargetKind` must select the same arm. Every decoded digest is canonical
unpadded base64url SHA-256. Each field composite-foreign-keys the named current lease, pointer,
incarnation, target, and snapshot; refs are parsed and recomputed rather than trusted as locators.
`native_server` additionally requires its mapping ID, generation, server/project/selector from the
`new_chat` payload, and `projectTargetDigest` to equal one current
`ProjectTargetSelectorMappingRecord`. Its target arm must be `terminal_native`.
`nested_management` requires the corresponding current mapping whose target arm is `nested_server`.
The three project-mapping fields are all null or all non-null; a partial tuple is invalid. The chat
arms always have all three null. An admitted server-control decision has one all-non-null tuple that
resolves its exact current mapping. A rejected server-control decision may keep all three null when no
unique valid mapping resolved, or all three non-null only when they resolve the exact valid lookup
that led to rejection. The selected capability ID/family digest in the decision must equal the
snapshot/family reached through that executor evidence.

`decisionEvidenceDigest` is SHA-256 of the decision-evidence bytes. Every admission has one non-null
target, executor evidence, and capability. A queued or rejected decision has all three selected target,
executor, and capability fields null, but retains the fixed policy and any valid mapping lookup
coordinates that led to rejection. Mapping replacement, a terminal↔nested arm change, a different
OpenCode binding/session/workspace/lease, a different edge/server, or a readiness/capability fence
therefore changes the signed command record. Finalization and the last effect boundary revalidate the
same semantic executor arm and target. Terminal-native evidence is immutable and cannot be replaced.
For a nested arm, the only transport-specific lease/snapshot replacement is the exact signed
positive-never-started capability continuation defined for that arm; it preserves the original
binding/edge, target, command, payload, family/request semantics, and receipt schema. Any other live
arm or field substitution is invalid.

Once the decision fields are frozen, `canonicalCommandRecordDigest` is SHA-256 of:

```text
str("remote-claw/collaboration-command-record/v1")
str(commandId)
str(collaborationServerId)
str(scopeKind)
optionalStr(logicalChatId)
optionalStr(targetLogicalChatId)
str(sourceKind)
str(sourceRef)
str(sourceEventNamespaceId)
str(sourceEventId)
bytes(base64urlDecode(sourceCommandIdentityDigest))
optionalDigest(canonicalSourceEventDigest)
str(mutationFamily)
str(canonicalCommandPayloadSchemaId)
bytes(base64urlDecode(canonicalCommandPayloadDigest))
optionalStr(preDecisionNormalizationEvidenceSchemaId)
optionalDigest(preDecisionNormalizationEvidenceDigest)
uint(readyAtJournalSeq)
uint(commandSeq)
str(disposition)
optionalStr(admittedTargetKind)
optionalStr(targetCapabilitySnapshotId)
optionalDigest(targetCapabilityFamilyDigest)
str(decisionEvidenceSchemaId)
bytes(base64urlDecode(decisionEvidenceDigest))
```

The command payload ref and decision-evidence ref must resolve to bytes that recompute their paired
digests. This record digest therefore commits the exact typed proposal, ordered decision, selected
executor, and pinned capability; the source-derived command ID alone intentionally does not.

Every ordered decision reserves one append-only result, but protected-key signing is not performed
inside the database transaction. The decision transaction allocates `commandSeq`, freezes
disposition/target/capability/evidence, creates a `CollaborationCommandResultPreparationRecord` with
the fields needed for the exact canonical payload and one reserved
`ServerSignatureReservationRecord`, creates a
`CollaborationCommandCompoundSigningGroupRecord`, and changes the command
to `decision_reserved`. It creates no source ACK, result delivery, projection-as-accepted, or inward
effect yet. `requiredFinalizationArtifactKind` is derived, never caller-selected:
an admitted `nested_management` target requires `nested_management_lineage_hop`; an admitted
`nested_chat_edge` target requires `nested_chat_event_lineage_hop`; every terminal-native, queued, or
rejected decision requires `none`. The generic finalizer accepts only derived `none` with a null
artifact-preparation ref. Each joint nested finalizer requires the exact derived kind plus one current,
signed preparation whose command/result/decision digest matches. For either nested kind, the decision
transaction also pre-reserves the secondary signer sequence under the same current signing lease and
stores the secondary preparation in the compound group. The ordinary chat-hop payload may bind
immediately; the management-hop payload remains unbound until the signed common-result digest exists.
Signing order is fixed for both nested kinds: the result reservation signs first and the group
compare-and-swaps `reserved → result_signed`; only then may the current secondary reservation sign and
the group compare-and-swap `result_signed → both_signed`. A joint finalizer accepts only
`both_signed`, parses both current preparation refs, and independently verifies both exact reservation
signatures and signed-record digests before `both_signed → finalized`. It never infers readiness from
one enum label or one signature. A non-nested group goes directly from its verified result signature to
finalization.
The group ID is deterministic from
`(collaborationServerId,commandId,commandResultId,preparationGeneration)`, and exactly one current
group may exist for that tuple. Kind `none` holds if and only if `secondaryPreparationRef` is null;
either nested kind requires a non-null ref to the one matching-kind current secondary whose
`compoundPreparationGeneration` equals the group's generation. A parallel same-generation group,
wrong-kind ref, or missing/extra secondary is invalid.
Both secondary preparation types carry the group's `compoundSigningGroupId`; their
`compoundPreparationGeneration` equals the group's and result preparation's
`preparationGeneration`, and their `signingLeaseId` equals the group plus the result reservation's
lease. Their refs are unique to that group; composite foreign keys prohibit a stale or cross-group secondary. A
replacement secondary advances its own preparation generation but remains under the same held group
and lease after result signing.
A signing-key rotation cannot retire that lease while any compound group is nonterminal. Before the
result signature is durable, aborting either reservation aborts the whole group and a higher paired
`preparationGeneration` reserves both sequences again for the byte-identical frozen decision. After
the result signature is durable, an aborted secondary preparation may be CAS-replaced inside that same
rotation-blocking group by a higher secondary preparation generation and a new sequence from the held
lease; the result signature is reused. The group points only to the current secondary preparation, and
finalization never mixes preparations from two groups. The result ID is
`ccr_${base64url(SHA256(str("remote-claw/collaboration-command-result-id/v1") ||
str(collaborationServerId) || str(commandId) || uint(1)))}`. Selected result version is exactly `1`
and `supersedesCommandResultId` is null. Every admitted, queued, or rejected decision is terminal for
that proposal across A1, official, automation, and nested sources. A queued proposal is never mutated
into admitted behind an acknowledged signature; forwarding later requires a fresh authenticated source
event and common command.

A1.7b1 also freezes the exact generation-specific IDs:

```text
compoundSigningGroupId =
  "csg_" || base64url(SHA256(
    str("remote-claw/collaboration-command-signing-group/v1") ||
    str(collaborationServerId) || str(commandId) || str(commandResultId) ||
    uint(preparationGeneration)))

commandResultPreparationId =
  "crp_" || base64url(SHA256(
    str("remote-claw/collaboration-command-result-preparation/v1") ||
    str(collaborationServerId) || str(commandId) || str(commandResultId) || uint(1) ||
    uint(preparationGeneration)))
```

Its rejected-only group always has `requiredFinalizationArtifactKind:"none"` and no secondary
preparation. Generation one shares the decision time. Only a `reserved` or `bound` generation may
abort; its reservation/preparation/group abort atomically and burns the signer sequence. Reprepare
uses a new signer sequence, increments `preparationGeneration`, names the exact predecessor through
`supersedesPreparationRef`, and retains the frozen command ID, command sequence, disposition,
canonical command-record digest, result ID, and original decision time. Replacement reservation,
group, and preparation use their later shared preparation time. Repeated recovery can advance through
arbitrary safe-integer generations; schema/repository tests explicitly cover generations one through
three.

A1.7b1 binds the result reservation to artifact type
`collaboration_command_result_preparation` and the exact current `crp_*`, signs and verifies the
canonical payload, and stops at preparation `signed`, group `result_signed`, reservation `signed`,
command `decision_reserved`, and A1 sidecar `deciding`. The broader finalization paragraphs in this
section are target behavior. Schema v10 rejects group `finalized`, command `decided`, sidecar
`terminal`, signer acceptance, and any final result/outbox/effect graph. Schema v11 A1.8a0 now
atomically adds only the rejected final result, dense signer acceptance, logical ingress terminal
overlay, exact semantic-result artifact, and inert `pending_seal` intent. Full A1.8a must still add
every admitted attempt/front-door-dispatch/effect arm, and A1.8b must seal/publish delivery. A1.7b1
plus A1.8a0 still advertise nothing.

**A1.8a0 implementation boundary.** The selected rejected chat `user` semantic payload is exact
compact UTF-8 under `remote-claw/a1-action-result/v1`:

```text
{"v":1,"result_id":"rrs_*","source_msg_id":"...","source_record_kind":"user","decision":"rejected","command_seq":N}
```

The selected rejected server-control `new_chat` payload is exact compact UTF-8 under
`remote-claw/a1-chat-creation-result/v1`:

```text
{"v":1,"result_id":"rrs_*","source_msg_id":"...","decision":"rejected","target_logical_chat_id":null,"command_seq":N}
```

For both, `ingressResultId === stableSemanticResultId`, the protected artifact digest is SHA-256 of
the exact payload bytes, and:

```text
storedSemanticResultDigest = SHA256(
  str("remote-claw/a1/stored-semantic-result/v1") ||
  str(semanticResultPayloadSchemaId) || bytes(exactCompactUtf8Payload))
```

The completion anchor is the unique accepted-attempt `rio_*` observation with
`disposition:"new_part"` at the lexicographically greatest `(channelGeneration, frameIndex)`, after
proving exactly one such observation for every part `0..N-1`. The deterministic delivery ID is:

```text
resultDeliveryId = "rrd_" || base64url(SHA256(
  str("remote-claw/a1/result-delivery/v1") ||
  str(stableSemanticResultId) || str(triggerIngressObservationId)))
```

The repository allocates the random 128-bit `rda_*` attempt once inside the transaction and recovers
it from the retained graph after an unknown commit. The delivery fixes `targetKind:"a1_broker"`,
`targetRef:brokerRouteId`, and `state:"pending_seal"`; the common result's `createdAtMs` remains the
preparation's `preparedAtMs`, while the terminal/finalization time is sampled under the current
coordinator fence. Neither caller supplies the source, trigger, payload, delivery ID, or attempt ID.
Exact replay returns the whole retained graph; any partial graph is persistence corruption.

The transaction does not re-check route current/gap-free state. A later collision may change only
the immutable-evidence row's lifecycle to `quarantined_collision`, and exact source closure may close
the route, without erasing or deadlocking the signed rejection. A future sealer must re-check route
health and may suppress delivery under the exact source-close recovery; A1.8a0 itself cannot claim or
seal the row.

The canonical result payload is exactly:

```text
str(canonicalPayloadSchemaId)
str(commandResultId)
str(collaborationServerId)
str(commandId)
bytes(base64urlDecode(canonicalCommandRecordDigest))
uint(resultVersion)
optionalStr(supersedesCommandResultId)
str(sourceKind)
str(sourceRef)
str(scopeKind)
optionalStr(logicalChatId)
optionalStr(targetLogicalChatId)
uint(commandSeq)
str(disposition)
uint(createdAtMs)
uint(signerSequence)
uint(serverKeyGeneration)
str(signerIdentityKeyId)
str(signerScopeCertificateId)
str(signatureAlgorithm)
```

`canonicalPayloadDigest` is SHA-256 of those bytes. The current certified server key signs those exact
bytes through the common sequence-reservation ledger; `signedRecordDigest` is SHA-256 of
`str("remote-claw/collaboration-command-result-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || str(signerIdentityKeyId) ||
uint(serverKeyGeneration) || uint(signerSequence) || bytes(base64urlDecode(signature))`.
The signing service resumes only that bound preparation after a crash and persists the signature in
its reservation before returning it. For `requiredFinalizationArtifactKind:"none"` only, the generic
final database transaction rechecks that the command's frozen decision fields and preparation digest
are unchanged, inserts the immutable `CollaborationCommandResultRecord`, compare-and-swaps its
current-result pointer, creates the exact source delivery/outbox and terminal-native effect arm when
admitted, and changes the command to `decided`. For either nested kind, only its `both_signed` joint
finalizer may atomically insert the result, signed secondary/lineage, source outbox, semantic attempt,
and effect gate; no generic or partial insert is valid. A crashed or aborted reservation burns
its sequence; restart either completes the exact bound payload or appends a higher
`preparationGeneration` for the same undelivered result version, naming the aborted preparation and
using a new signer sequence, without changing the already frozen decision. Only one preparation
generation may finalize. Capability/current-target fences are revalidated again
before any later effect, not silently rewritten during result signing.
`AuthenticatedIngressResultRecord.commandResultId` foreign-keys this neutral result for A1. Every
canonical source event remains immutable and resolves the sole result through its stable `commandId`
and `CollaborationCommandRecord.currentCommandResultId`; official, automation, and nested protocols
only project that result into their own exact shape and do not create another decision.

Each target projection has one stable
`CollaborationCommandResultDeliveryRecord` per `(commandResultId,targetKind,targetBindingId)`.
For A1, `stableTargetResultId` is the ingress row's fixed
`stableSemanticResultId`. Selected A1 has no result-update wire kind, so an A1 `queued` decision is
terminal for that proposal; later forwarding requires a new explicit proposal and command rather than
changing accepted bytes behind the old result. Every other selected target uses
`ctr_${base64url(SHA256(str("remote-claw/collaboration-result-target/v1") ||
str(commandResultId) || str(targetKind) || str(targetBindingId)))}`. Thus the original A1 row,
result-frame `msgId`, and payload `result_id` remain the same `rrs_*`.
`AuthenticatedIngressResultRecord.commandResultId` names that sole result. The delivery row retains the exact
protocol payload/ref/digest before send. Each physical envelope gets a child
`CollaborationCommandResultDeliveryAttemptRecord`, unique on
`(commandResultDeliveryId,deliveryAttemptId)`. Retries of one started child reuse its stored attempt
ID; a later source replay may append another child envelope only when that target protocol requires
it, still carrying the same stable result ID and byte-identical parent payload. Nested peers accept a creation or chat result
only after verifying this host-signed common result and its exact target mapping.

A native delivery, terminal creation, or nested creation attempt may exist only for an admitted
command and must repeat that command's exact server/chat target, capability snapshot, family digest,
and canonical payload digest. The database enforces those composite foreign keys; an adapter cannot
manufacture an attempt from its own route lookup. Queued and rejected rows have no effect gate,
projection-as-accepted, native attempt, or nested attempt. Thus web, official clients, automation,
nested servers, and the local collaboration bridge compete through one enforceable adjudicator before
OpenCode. The person's direct OpenCode TUI is the intentional exception: it reaches the native harness
through its separately fenced TUI seam and enters remote-claw only afterward as a native observation,
because the native harness—not the coordinator—is the final applied-state arbiter.

The `server_control` route accepts exactly one inbound semantic kind, typed `new_chat`, encrypted under
the server-control scope key. It does not accept ordinary user text, attachments, chat controls, or a
caller-supplied `logicalChatId`; the scope bus remains outbound-only. The complete authenticated
server-control proposal first enters the same multipart/digest/collision actor under the null-chat
route. The server sequencer first gives every complete proposal its stable command ID/sequence. If the
same deciding transaction resolves the current project-target selector mapping, it then pins the
capability required by that closed target arm: `native_server` for a terminal runtime or
`nested_management` for another server. Only if the mapping and selected capability are current,
unambiguous, and admit `new_chat` does it allocate one random `targetLogicalChatId`, freeze it on the
command and result preparation, and create that chat in `recovering`. Only signed-result finalization
creates and arms the selected executor. Mapping lookup/current-generation comparison and capability selection are
one ordered decision: missing, ambiguous, stale, or unsupported input produces an ordered rejected
result, not a pre-order drop. The target actor does not decide the proposal a second time. If policy
rejects it, no target chat is allocated. The random ID is never taken from the caller.

The mapping decides the next inward step. The decision-reservation transaction freezes that arm but
creates no executor record. On signed-result finalization, `terminal_native` makes only the innermost
terminal server create a starting `NativeBindingRecord`; OpenCode additionally creates its
`OpenCodeBindingWorkspaceRecord` and native creation reservation. For `nested_server`, the outer server
creates no native binding. Finalization creates one `NestedChatCreationAttemptRecord` and command-wide
effect gate pinned to the selector's current server-scoped
`NestedServerManagementBindingRecord`, current mutually bound lease, exact `new_chat` capability
snapshot, mapping generation, target server/project/selector, source namespace/event, and signed
management lineage. This management binding is deliberately not a chat-scoped inward edge: the target
chat does not exist yet.

Management writability uses its own exact two-sided live handshake. Each peer contributes one fresh
canonical unpadded-base64url 32-byte nonce and its current coordinator epoch over the actual mutually
authenticated TLS 1.3 connection. The source allocates the monotonically increasing
`leaseGeneration` and `transportEpoch`. The exporter context digest is SHA-256 of:

```text
str("remote-claw/nested-management-exporter-context/v1") ||
str(nestedServerManagementBindingId) || uint(leaseGeneration) ||
str(sourceServerId) || str(targetServerId) || str(targetOutsideBindingId) ||
uint(sourceCoordinatorEpoch) || uint(targetCoordinatorEpoch) || uint(transportEpoch) ||
bytes(base64urlDecode(sourceNonce)) || bytes(base64urlDecode(targetNonce)) ||
str(sourceScopeCertificateId) || str(targetScopeCertificateId)
```

Both sides call the TLS 1.3 exporter on that one live connection with label
`EXPORTER-remote-claw-nested-management-v1`, the 32 decoded context-digest bytes as context, and
output length 32. `mutualChannelBindingDigest` is SHA-256 of
`str(transportBindingSchemaId) || bytes(base64urlDecode(exporterContextDigest)) ||
bytes(exporterOutput)`. Both peers require TLS 1.3, the mutually authenticated peer certificates named
by the two scope-certificate chains, the exact exporter label/context/output above, and the nonce/epoch
frames on that same connection. Either peer recomputes the context and channel-binding digest directly
from that live connection; no separately serialized transport-evidence object participates in the
signed contract.

The handshake ID is
`nmh_${base64url(SHA256(str("remote-claw/nested-management-handshake-id/v1") ||
str(nestedServerManagementBindingId) || uint(leaseGeneration) ||
uint(sourceCoordinatorEpoch) || uint(targetCoordinatorEpoch) || uint(transportEpoch) ||
bytes(base64urlDecode(sourceNonce)) || bytes(base64urlDecode(targetNonce))))}`. Source and target each
sign one `NestedManagementLiveHandshakeAttestation` over:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) || str(handshakeId) || str(side) ||
str(nestedServerManagementBindingId) || uint(leaseGeneration) || str(sourceServerId) ||
str(targetServerId) || str(targetOutsideBindingId) || uint(sourceCoordinatorEpoch) ||
uint(targetCoordinatorEpoch) || uint(transportEpoch) ||
bytes(base64urlDecode(sourceNonce)) || bytes(base64urlDecode(targetNonce)) ||
str(sourceScopeCertificateId) || str(targetScopeCertificateId) ||
str(transportBindingSchemaId) || bytes(base64urlDecode(exporterContextDigest)) ||
bytes(base64urlDecode(mutualChannelBindingDigest)) ||
uint(issuedAtMs) ||
uint(signerSequence) || uint(serverKeyGeneration) || str(signerIdentityKeyId) ||
str(signerScopeCertificateId) || str(signatureAlgorithm) ||
str(canonicalPayloadDigestAlgorithm)
```

The side-specific current certified server key signs those bytes through
`purpose:"nested_management_live_handshake"`; its signer scope certificate must equal the named
source or target certificate for that side. `sourceScopeCertificateId` must be the source server's
current accepted scope certificate; `targetScopeCertificateId` must equal the management binding's
`targetServerScopeCertificateId` and the target outside binding's current accepted server scope.
Each signed-attestation digest is SHA-256 of
`str("remote-claw/nested-management-live-handshake-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || bytes(base64urlDecode(signature))`. Apart from
`side`, issuance/signature fields, the two parsed transcripts must be byte-identical.

The lease ID is
`nml_${base64url(SHA256(str("remote-claw/nested-management-live-lease/v1") ||
str(nestedServerManagementBindingId) || uint(leaseGeneration) || str(handshakeId) ||
bytes(base64urlDecode(sourceHandshakeAttestationDigest)) ||
bytes(base64urlDecode(targetHandshakeAttestationDigest))))}`. Only after both signatures, certificate
chains, reservations, signed-record acceptance rows, and the still-live exporter
verify does each side store the same lease row. The source compare-and-swaps
`NestedServerManagementBindingRecord.currentLeaseId`; the target compare-and-swaps the matching
`NestedManagementTargetLeasePointerRecord.currentLeaseId`. Writability requires both pointers to name
that exact current lease and every lease/transcript coordinate to match. A split install is
non-writable. Connection loss, certificate/epoch change, or pointer replacement immediately closes
the lease. Reconnect repeats the whole handshake with a higher generation/epoch; public transcript
replay, caller-selected nonces/epochs, or one-sided attestation cannot recreate writability.

The selected management capability is byte-exact. `newChatRequestSchemaId` is
`remote-claw/nested-management-new-chat-request/v1`, `newChatReceiptProofSchemaId` is
`remote-claw/nested-target-command-receipt-proof/v1`, and:

```text
newChatCapabilityDigest =
  SHA256(str("remote-claw/nested-management-new-chat-capability/v1") ||
         str(newChatRequestSchemaId) || str(newChatReceiptProofSchemaId) ||
         bytes(base64urlDecode(proofDigest)))
```

The capability snapshot digest is:

```text
SHA256(str(canonicalSnapshotSchemaId) || uint(schemaVersion) ||
       str(nestedServerManagementCapabilitySnapshotId) ||
       str(nestedServerManagementBindingId) || str(nestedServerManagementLeaseId) ||
       uint(capabilityGeneration) || str(newChatRequestSchemaId) ||
       str(newChatReceiptProofSchemaId) ||
       bytes(base64urlDecode(newChatCapabilityDigest)) ||
       bytes(base64urlDecode(proofDigest)) || uint(verifiedAtMs))
```

Its proof ref must resolve exact interoperability bytes for those request and receipt schemas.
Installation compare-and-swaps the management binding's capability pointer while its named lease is
current; state is excluded from the digest. The decision executor evidence, command capability digest,
and creation attempt repeat the snapshot ID, snapshot digest, and `new_chat` capability digest.
Same-ID content changes, a request/receipt schema substitution, a stale lease/generation, or a
superseded/revoked snapshot rejects before result finalization and again before send.

Each outer server also has exactly one current `NestedReadinessPolicySnapshot`. Its policy digest is:

```text
SHA256(str(canonicalPolicySchemaId) || uint(schemaVersion) ||
       str(nestedReadinessPolicySnapshotId) || str(collaborationServerId) ||
       uint(policyGeneration) || uint(maxWaitMs))
```

`maxWaitMs` is an integer from 1 through 120000 in version one. Finalization pins the current policy ID
and digest, sets the immutable `attemptCreatedAtMs`, and computes
`readinessDeadlineAtMs = attemptCreatedAtMs + maxWaitMs` with checked unsigned arithmetic. Policy
replacement affects only later attempts. Expiry stops waiting and records uncertainty; it is not
evidence that the target did not execute and never authorizes a second downstream `new_chat`.

The nested arm requires a staged secondary signature. Its common-result preparation sets
`requiredFinalizationArtifactKind:"nested_management_lineage_hop"`. After the exact common-result
signature is durable in its bound reservation—but before a result row, source ACK, output, attempt, or
effect gate exists—the coordinator builds the semantic creation base using that result ID and
`signedRecordDigest`, appends the next management hop, binds the decision transaction's pre-reserved
secondary signer sequence to that exact payload, and signs the
`NestedManagementLineageHopPreparationRecord`. It then builds the completed wire envelope. One
joint compare-and-swap finalization inserts the immutable common result, prepared hop/vector, semantic
base and wire envelope, source result outbox, nested creation attempt, and effect gate, and marks the
command decided. A nested executor can never use the ordinary result-only finalizer.

If a crash occurs after result signing, recovery reuses that exact result signature while the compound
group and signing lease remain live. A secondary reservation that aborts after that point is replaced
by a higher hop `preparationGeneration` within the same group, naming the prior preparation and using a
new sequence from the held lease. An abort before result signing replaces the entire group and both
preparations at a higher paired generation.
Only one hop preparation may become the result preparation's
`currentFinalizationArtifactPreparationRef`, and only one joint finalizer may win. A stale/racing
finalizer, changed source result/digest, changed base/lineage bytes, or missing secondary signature
creates no partial result, ACK, output, attempt, or effect.

The management lineage is a retained vector of at most 16 `NestedManagementLineageHop` values. Each
hop is signed by its source server over the prior lineage digest, origin/current command, signed common
result and allocated target, source/target server IDs, stable management binding, mapping generation, target
project/selector, intent, semantic creation-base digest, source namespace/event, and signer metadata.
Hop zero starts at the origin server. Every later `sourceServerId` equals the preceding
`targetServerId`; each proposed `targetServerId` and management binding is new in the visited path, and
the origin/command/allocated-outer-target coordinates remain consistent across hops. At hop zero,
`sourceCommandId === originCommandId` and
`sourceTargetLogicalChatId === originTargetLogicalChatId`. Its source result is the immutable signed
common result for that exact origin server/command/target. At every later hop, the source command,
source result, result digest, and source target chat must equal the verified
`CollaborationCommandRecord`/`CollaborationCommandResultRecord` allocated by the preceding hop's target
server for the preceding management source event. Composite foreign keys bind
`(sourceServerId,sourceCommandId,sourceCommandResultId,sourceTargetLogicalChatId)` to that result and
bind its source event to the preceding hop's exact namespace/event and signed-record digest. A server
cannot replace those coordinates with another local command before extending the lineage. Invalid schema,
index, adjacency, signature, certificate, namespace/event derivation, or changed signed field is an
authentication/transport failure: the receiver records evidence but creates no canonical source event,
command, or semantic ACK. Once the complete lineage is authenticated, proposing an already visited
target or a seventeenth hop is a semantic cycle/depth rejection. The target creates the common command
and ordered rejected result but allocates no target chat or effect gate. The vector digest is
SHA-256 of `str("remote-claw/nested-management-lineage-vector/v1") || uint(count)` followed by each
canonical signed-record digest in hop order.

The lineage does not sign an envelope that already contains itself. The exact semantic creation base
payload is:

```text
str("remote-claw/nested-management-creation-base/v1") || uint(1) ||
str(sourceServerId) || str(sourceCommandId) || str(sourceCommandResultId) ||
bytes(base64urlDecode(sourceCommandResultDigest)) || str(sourceTargetLogicalChatId) ||
str(targetServerId) || str(nestedServerManagementBindingId) ||
str(projectTargetSelectorMappingId) || uint(projectTargetSelectorMappingGeneration) ||
str(targetProjectId) || str(targetWorkspaceSelectorId) || str(creationIntent) ||
str(sourceEventNamespaceId) || str(sourceEventId)
```

`semanticCreationBaseRef` retains those exact bytes and
`semanticCreationBaseDigest` is their SHA-256. Every new hop signs that base digest. After the complete
hop vector is signed, `canonicalRequestRef` retains this wire envelope:

```text
str(canonicalRequestSchemaId) || uint(1) ||
bytes(exactSemanticCreationBasePayload) || uint(lineage.length) ||
for hop in lineage:
  bytes(exactCanonicalHopPayload) || bytes(base64urlDecode(hop.signature))
```

`canonicalRequestDigest` is SHA-256 of those bytes. The target parses the retained/request bytes,
recomputes the base, every hop signed-record digest, the lineage-vector digest, and the full wire
digest, and requires all attempt fields to match. Neither a different base under the same lineage nor a
different lineage around the same base is accepted. The transport attestation's
`semanticRequestDigest` equals this full `canonicalRequestDigest`.

One hop's canonical payload is:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) || uint(hopIndex) ||
str(originServerId) || str(originCommandId) || str(originTargetLogicalChatId) ||
str(sourceServerId) || str(sourceCommandId) || str(sourceCommandResultId) ||
bytes(base64urlDecode(sourceCommandResultDigest)) || str(sourceTargetLogicalChatId) ||
str(targetServerId) || str(nestedServerManagementBindingId) ||
str(projectTargetSelectorMappingId) || uint(projectTargetSelectorMappingGeneration) ||
str(targetProjectId) || str(targetWorkspaceSelectorId) || str(creationIntent) ||
bytes(base64urlDecode(semanticCreationBaseDigest)) || str(sourceEventNamespaceId) ||
str(sourceEventId) || optionalDigest(priorLineageDigest) || uint(signerSequence) ||
uint(serverKeyGeneration) || str(signerIdentityKeyId) || str(signerScopeCertificateId) ||
str(signatureAlgorithm) || str(canonicalPayloadDigestAlgorithm)
```

The canonical payload digest and Ed25519 signature use the named certified source-server key. The
hop's signed-record digest is SHA-256 of
`str("remote-claw/nested-management-lineage-hop-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || bytes(base64urlDecode(signature))`.
`hopIndex` starts at zero, increments contiguously, and `priorLineageDigest` is null only at zero;
otherwise it equals the prior hop's signed-record digest.

The management binding's `targetOutsideBindingId` resolves on the target to one
`OutsideBindingRecord(kind:"nested-remote-claw",scopeKind:"server_control",logicalChatId:null)`.
Its stable namespace is
`nmn_${base64url(SHA256(str("remote-claw/nested-management-source-namespace/v1") ||
str(targetServerId) || str(targetOutsideBindingId) || str(collaborationServerId) ||
str(nestedServerManagementBindingId)))}` and must equal `targetSourceEventNamespaceId`. The source
event ID is
`nme_${base64url(SHA256(str("remote-claw/nested-management-source-event/v1") ||
str(sourceServerId) || str(sourceCommandId) || str(sourceTargetLogicalChatId) ||
str(projectTargetSelectorMappingId) || uint(projectTargetSelectorMappingGeneration)))}`.
Reconnect never changes either value.

Lease and TLS/channel-binding evidence are intentionally not part of that stable semantic lineage. One
immutable `NestedManagementDeliveryAttemptRecord` and its
`NestedManagementTransportAttestation` bind a physical attempt and the same semantic request digest to
the current management lease, coordinator/transport epochs, and live channel immediately before send.
They are verified as transport authorization but excluded from target source-event fingerprinting.
The semantic creation attempt has many such child rows, unique by both child ID and
`transportAttemptId`. The initial child repeats the exact management lease and capability snapshot
ID/digest frozen in the signed executor evidence and has both continuation fields null. A later child
requires both continuation fields non-null and a valid signed
`NestedManagementCapabilityContinuation`; one-null/one-non-null is invalid. A reconnect may append
that fresh child for the exact semantic event only after positive evidence marks every prior child
`never_started`. Any child that remains `started` or `outcome_unknown` fences all future sends under
either old or new transport. No transport row, snapshot, continuation, or attestation is overwritten.

Positive-never-started is a signed, typed fact, not a timeout, disconnect, missing receipt, or mutable
status label. Every management or chat transport child is created in the same transaction as one
`NestedDispatchAuthorizationRecord(state:"armed",stateVersion:1)` and one protected
`dispatch_authorization`. The durable records contain only that authorization's typed `rcph_*`
reference and a canonical dispatch digest; the raw 32-byte value remains inside the protected owner.
The authorization record's ID is
`nda_${base64url(SHA256(str("remote-claw/nested-dispatch-authorization/v1") ||
str(authorizationKind) || str(semanticAttemptId) || str(physicalAttemptId) ||
str(transportAttemptId)))}`. Its canonical dispatch digest is:

```text
SHA256(
  str("remote-claw/nested-dispatch/v1") ||
  str(nestedDispatchAuthorizationId) || str(authorizationKind) ||
  str(collaborationServerId) || str(commandId) || str(admittingCommandResultId) ||
  bytes(base64urlDecode(admittingCommandResultSignedRecordDigest)) ||
  bytes(base64urlDecode(canonicalCommandRecordDigest)) ||
  bytes(base64urlDecode(decisionEvidenceDigest)) ||
  str(semanticAttemptId) || str(physicalAttemptId) || str(transportAttemptId) ||
  str(routingBindingId) || str(targetServerId) || optionalStr(targetLogicalChatId) ||
  str(targetOutsideBindingId) || optionalUint(sourceTopologyGeneration) ||
  str(priorLeaseId) || str(priorCapabilitySnapshotId) ||
  bytes(base64urlDecode(priorCapabilitySnapshotDigest)) ||
  bytes(base64urlDecode(capabilityEntryDigest)) || str(semanticRequestSchemaId) ||
  bytes(base64urlDecode(semanticRequestDigest)) ||
  str(dispatchAuthorizationRef.protectedHandleId) ||
  str(dispatchAuthorizationRef.kind)
)
```

`stateVersion` is exactly `1` with `state:"armed"` and null `revokedAtJournalSeq`, then exactly `2`
with either `state:"consumed"` and null journal sequence or `state:"revoked"` and one non-null
coordinator journal sequence. No other transition or version is valid. A revocation's evidence ID is
deterministic:
`pns_${base64url(SHA256(str("remote-claw/nested-positive-never-started-evidence-id/v1") ||
str(nestedDispatchAuthorizationId) || uint(revokedAtJournalSeq)))}`. It is unique on both that ID and
`nestedDispatchAuthorizationId`, so the one authorization cannot acquire two attestations.

The immutable authorization coordinates composite-foreign-key the exact admitted command/result,
semantic and physical child, route/target, prior lease and capability snapshot, capability entry, and
semantic request. `nested_management` maps `semanticAttemptId` to
`nestedChatCreationAttemptId`, `physicalAttemptId` to `nestedManagementDeliveryAttemptId`,
`routingBindingId` to `nestedServerManagementBindingId`, `priorLeaseId` to the management lease,
`capabilityEntryDigest` to `newChatCapabilityDigest`, and `semanticRequestSchemaId`/digest to the
canonical management request; its target logical chat and topology generation are null.
`nested_chat` maps those fields to `nestedChatDeliveryAttemptId`,
`nestedChatDeliveryTransportAttemptId`, `inwardEdgeId`, `inwardLiveLeaseId`, the family digest, and
the canonical wire-envelope schema/digest; its target logical chat and source topology generation are
non-null and exact.

The transport writer has no socket-send path without consuming that one armed authorization. Its final
pre-write transaction validates the exact typed protected reference and canonical dispatch digest,
compare-and-swaps authorization `armed@1 → consumed@2`, child
`prepared → started`, and gate `(never_started,null) → (started,physicalAttemptId)` together; only
after commit does the protected owner return the raw authorization directly to the in-process
transport writer, which may attempt the first transport byte. The raw value is never written to a
durable row, journal, continuation, attestation, log, environment, or wire record. Therefore a
consumed authorization, a started child/gate, an uncertain outcome, or a missing row can never produce
positive-never-started evidence.

Before that send CAS only, an abandonment transaction may compare-and-swap the exact authorization
`armed@1 → revoked@2`, set its non-null `revokedAtJournalSeq`, and change the child
`prepared → never_started` while requiring the command-wide gate to remain
`(never_started,null)`. It does not move a gate back from `started`. The current source server may then
sign one `NestedPositiveNeverStartedAttestation` over that immutable revocation:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) ||
str(positiveNeverStartedEvidenceId) || str(authorizationKind) ||
str(collaborationServerId) || str(commandId) || str(admittingCommandResultId) ||
bytes(base64urlDecode(admittingCommandResultSignedRecordDigest)) ||
bytes(base64urlDecode(canonicalCommandRecordDigest)) ||
bytes(base64urlDecode(decisionEvidenceDigest)) ||
str(semanticAttemptId) || str(physicalAttemptId) || str(transportAttemptId) ||
str(routingBindingId) || str(targetServerId) || optionalStr(targetLogicalChatId) ||
str(targetOutsideBindingId) || optionalUint(sourceTopologyGeneration) ||
str(priorLeaseId) || str(priorCapabilitySnapshotId) ||
bytes(base64urlDecode(priorCapabilitySnapshotDigest)) ||
bytes(base64urlDecode(capabilityEntryDigest)) || str(semanticRequestSchemaId) ||
bytes(base64urlDecode(semanticRequestDigest)) || str(nestedDispatchAuthorizationId) ||
str(dispatchAuthorizationRef.protectedHandleId) || str(dispatchAuthorizationRef.kind) ||
bytes(base64urlDecode(canonicalDispatchDigest)) ||
uint(revokedAuthorizationStateVersion) || uint(revokedAtJournalSeq) || str(assertion) ||
uint(issuedAtMs) || uint(signerSequence) || uint(serverKeyGeneration) ||
str(signerIdentityKeyId) || str(signerScopeCertificateId) || str(signatureAlgorithm) ||
str(canonicalPayloadDigestAlgorithm)
```

`revokedAuthorizationStateVersion` is exactly `2` and `assertion` is the literal in the schema. The
signing service accepts only `purpose:"nested_positive_never_started_attestation"` and the current
source-server signing lease. The evidence digest is SHA-256 of
`str("remote-claw/nested-positive-never-started-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || bytes(base64urlDecode(signature))`. Verification
parses every field, recomputes the authorization and request/capability joins, and accepts the signer
under the current/retired-key and historical-reattestation rules in §4. Both the prior child and
command-wide gate retain the exact evidence schema/ref/digest tuple. The three fields are either all
null until continuation installation or all non-null afterward; a partial tuple is invalid.

Continuation installation is one fail-closed CAS after both this attestation and the continuation
signature are durable. It requires the predecessor authorization still `revoked@2`, predecessor child
still `never_started`, evidence schema/ref/digest exact, gate still `(never_started,null)`, and the named
successor lease/snapshot current. It then inserts exactly one successor child and a fresh
`armed@1` authorization, records the continuation and evidence schema/ref/digest, and leaves the gate
`(never_started,null)`. A racing old send sees a revoked authorization; a racing successor send cannot
start before this install commits. Crash before the install leaves no armed successor, and exact replay
of the install returns the same child. There is no valid `started → never_started` downgrade.

The continuation permits only transport/capability-generation replacement, never semantic
readjudication. It names the prior/current management leases and capability snapshot IDs/digests, the
same binding/target, exact `newChatCapabilityDigest`, receipt-proof schema, semantic request digest,
prior/next transport attempt IDs, and positive prior-never-started evidence. Both snapshots must parse,
recompute, bind their named lease, select the same request/receipt schemas and capability digest, and
be valid for the same management binding/target. The current snapshot and lease must be current; the
prior child and evidence must be immutable and exact. The continuation's canonical payload is:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) ||
str(nestedChatCreationAttemptId) || str(nestedServerManagementBindingId) ||
str(targetServerId) || str(priorManagementLeaseId) ||
str(priorManagementCapabilitySnapshotId) ||
bytes(base64urlDecode(priorManagementCapabilitySnapshotDigest)) ||
str(currentManagementLeaseId) || str(currentManagementCapabilitySnapshotId) ||
bytes(base64urlDecode(currentManagementCapabilitySnapshotDigest)) ||
bytes(base64urlDecode(newChatCapabilityDigest)) || str(targetReceiptProofSchemaId) ||
bytes(base64urlDecode(semanticRequestDigest)) || str(priorTransportAttemptId) ||
str(nextTransportAttemptId) || str(positiveNeverStartedEvidenceSchemaId) ||
bytes(base64urlDecode(positivePriorNeverStartedEvidenceDigest)) ||
uint(signerSequence) || uint(serverKeyGeneration) || str(signerIdentityKeyId) ||
str(signerScopeCertificateId) || str(signatureAlgorithm) ||
str(canonicalPayloadDigestAlgorithm)
```

The current certified source-server key signs those bytes through
`purpose:"nested_management_capability_continuation"`.
`capabilityContinuationDigest` is SHA-256 of
`str("remote-claw/nested-management-capability-continuation-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || bytes(base64urlDecode(signature))`.
After that exact signature is retained, one transaction compares the prior child, positive evidence,
old lease/snapshot pointers, revoked authorization, and still-never-started command-wide gate; retains
the paired `positiveNeverStartedEvidenceSchemaId`/ref/digest; and inserts the successor child,
continuation ref/digest, and fresh one-time authorization against the new current lease/snapshot. The gate remains
`(never_started,null)` until the successor's final send CAS changes it to
`(started,nextChildId)`. There is no state in which old and new children may both send.

The transport attestation canonical payload is:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) ||
str(nestedChatCreationAttemptId) || str(transportAttemptId) ||
str(nestedServerManagementBindingId) || str(nestedServerManagementLeaseId) ||
uint(sourceCoordinatorEpoch) || uint(targetCoordinatorEpoch) || uint(transportEpoch) ||
bytes(base64urlDecode(mutualChannelBindingDigest)) ||
bytes(base64urlDecode(semanticRequestDigest)) || uint(issuedAtMs) ||
uint(signerSequence) || uint(serverKeyGeneration) || str(signerIdentityKeyId) ||
str(signerScopeCertificateId) || str(signatureAlgorithm) ||
str(canonicalPayloadDigestAlgorithm)
```

The named source-server key signs those bytes. `transportAttestationDigest` is SHA-256 of
`str("remote-claw/nested-management-transport-attestation-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || bytes(base64urlDecode(signature))`. The management
lease's channel digest comes from the same mutually attested TLS 1.3 exporter construction used for
the exact management live-handshake contract above. The receiver recomputes and requires exact
binding/lease generation, source and target coordinator epochs, transport epoch, handshake
attestation digests, channel digest, both current pointers, and live connection equality immediately
before accepting the semantic envelope.

The management last hop atomically marks the unique gate/attempt started before sending one typed
nested `new_chat`. It also requires the child's current snapshot ID/digest, continuation when present,
and capability digest to match the retained semantic attempt before sending. That same CAS consumes
the child's exact typed `dispatchAuthorizationRef` by changing its matching
`NestedDispatchAuthorizationRecord` from `armed@1` to `consumed@2` and matching the child's
`canonicalDispatchDigest`; a missing, revoked, reused, or cross-child reference/digest reaches no
transport write. Only the successful protected consume returns the raw value to the in-process writer.
The target normalizes
that authenticated management event into its ordinary
server-control `CollaborationCommandRecord`; its stable source namespace/event identity is derived
from the management binding and survives reconnect. It may recurse again through the same adjudicator.
For `NestedChatCreationEffectGateRecord`, `startedAttemptId` names the exact physical
`nestedManagementDeliveryAttemptId`, not the stable semantic creation-attempt ID.

Every nested semantic ACK is the closed
`NestedTargetCommandReceiptProofBundle`, not a result locator. Its digest is:

```text
SHA256(str(targetReceiptProofSchemaId) || uint(schemaVersion) ||
       str(targetServerId) || str(targetOutsideBindingId) ||
       str(targetSourceEventNamespaceId) || str(targetSourceEventId) ||
       str(targetRequestSchemaId) || bytes(base64urlDecode(targetRequestDigest)) ||
       str(targetCommandId) || uint(targetCommandSeq) || str(targetCommandResultId) ||
       str(targetDecision) || bytes(base64urlDecode(targetCanonicalSourceEventDigest)) ||
       bytes(base64urlDecode(targetCommandPayloadDigest)) ||
       bytes(base64urlDecode(targetCommandRecordDigest)) ||
       bytes(base64urlDecode(targetDecisionEvidenceDigest)) ||
       optionalDigest(targetExecutorEvidenceDigest) || str(targetCommandResultSchemaId) ||
       bytes(base64urlDecode(targetCommandResultSignedRecordDigest)))
```

Every ref retains and parses the complete canonical component bytes. The source recomputes the target
canonical source event from the exact received request and target binding/namespace/event; parses the
typed command payload; recomputes the target decision and executor evidence; recomputes the complete
command-record digest; and then verifies that the version-one/null-predecessor common result repeats
that command digest and is accepted under the current/retired-key and historical-reattestation rules
of §4 for the certified target-server signer sequence. The bundle's target
request schema/digest must equal the selected nested attempt, its result schema is exactly
`remote-claw/collaboration-command-result/v1`, and admitted versus non-admitted executor-evidence
nullability must obey the common adjudication union. Thus a signed result for another source event,
command payload, decision, capability, or executor cannot complete this attempt even if its key is
valid.

The management source does not precompute the target-local command or result ID: those depend on the
target's verified canonical source-event record. Both remain null until the first complete receipt
proof verifies and one compare-and-swap stores its command/result IDs, sequence, decision, proof
ref/digest, and any allocated `observedTargetLogicalChatId`. Exact byte replay is idempotent. A second
different proof or result, version other than one, non-null predecessor, changed component bytes, or
fork quarantines the creation attempt. Because server-control creation is terminal admitted/rejected,
a queued target result or receipt is invalid and quarantines; it never becomes admission later.
An admitted receipt proves only that the target ordered and allocated the chat, which may still be
`recovering`. The outer server waits for a signed target-ready observation plus a valid rooted terminal-path
certificate, and then runs the existing two-party `InwardEdgeInstallReservation`
prepare/commit/install protocol and mutual live handshake. Only after both installed receipts and the
current live lease verify does it select the normal chat-scoped `InwardCollaborationEdgeRecord` and
mark the outer chat ready. Before then there is no usable chat-scoped edge. A target rejection,
readiness gap, invalid root path, or ambiguity never sends again. Arbitrary nesting therefore applies
the same creation rule at every server while the native app appears only once, at the innermost
terminal.

The ready observation is one retained `NestedTargetReadyAttestation`, not an inference from a result
or announcement timestamp. Its target server/chat/result/command/sequence must equal the verified
target common result, its target chat must be durably `ready` at `readyJournalSeq`, and its current
topology generation/root certificate must verify to the terminal native root. The result ID **and**
`targetCommandResultSignedRecordDigest` must equal the complete receipt proof, so readiness cannot be
transplanted onto a fork with the same logical coordinates. Its canonical payload is:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) ||
str(targetServerId) || str(targetLogicalChatId) || str(targetCommandResultId) ||
bytes(base64urlDecode(targetCommandResultSignedRecordDigest)) || str(targetCommandId) ||
uint(targetCommandSeq) || uint(targetTopologyGeneration) || uint(attestationGeneration) ||
optionalDigest(supersedesAttestationDigest) || str(rootPathCertificateId) ||
bytes(base64urlDecode(rootPathCertificateDigest)) || uint(readyJournalSeq) ||
uint(issuedAtMs) || uint(signerSequence) || uint(serverKeyGeneration) ||
str(signerIdentityKeyId) || str(signerScopeCertificateId) || str(signatureAlgorithm) ||
str(canonicalPayloadDigestAlgorithm)
```

The target's current certified key signs those bytes; the attestation digest is SHA-256 of
`str("remote-claw/nested-target-ready-attestation-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || bytes(base64urlDecode(signature))`.
It is unique on
`(targetServerId,targetLogicalChatId,targetTopologyGeneration,attestationGeneration)`.
Generation zero has null `supersedesAttestationDigest`; each renewal increments by one, names the
prior attestation digest, and may carry a renewed unexpired root certificate without changing
topology. A fork or different bytes at one generation is equivocation. The outer attempt stores the
latest complete current chain's exact ref/digest before edge installation.

The attempt also has a bounded, policy-pinned readiness deadline used only to stop waiting, never to
prove non-execution. A verified target rejection or positive terminal failure marks the attempt and
effect gate completed and the attempt `failed`, records a stable `failureCode`, and atomically moves the outer chat from `recovering` to
`quarantined`. An invalid root/readiness attestation does the same with retained evidence. A lost or
ambiguous result, elapsed deadline, or disconnected target changes the attempt/effect gate to
`outcome_unknown` and also quarantines the outer chat. Recovery may later install the edge only from
positive evidence for that same attempt; it never sends again or rewrites the immutable outer
admission result. A separate status result/projection reports readiness failure or uncertainty.

That projection is a `NestedCreationStatusRecord`, unique on
`(nestedChatCreationAttemptId,statusVersion)`, with ID
`ncs_${base64url(SHA256(str("remote-claw/nested-creation-status/v1") ||
str(nestedChatCreationAttemptId) || uint(statusVersion)))}`. Its retained compact payload contains
these exact canonical bytes:
`str(canonicalPayloadSchemaId) || str(nestedCreationStatusId) ||
str(nestedChatCreationAttemptId) || uint(statusVersion) ||
optionalStr(supersedesNestedCreationStatusId) || str(outerCommandId) ||
str(outerTargetLogicalChatId) || str(status) || optionalStr(failureCode) ||
bytes(base64urlDecode(evidenceDigest))`. Version one has null predecessor; each later version names the
current status ID and increments by one. The canonical payload digest and one causal projection outbox
are committed with the lifecycle transition. Exact recovery replays the same status to every enabled
source/outside binding; a later positive resolution appends the next version rather than changing the
admission result or earlier status bytes.
`outerCommandId` and `outerTargetLogicalChatId` are immutable fields on the status row and
composite-foreign-key the creation attempt's admitted result/target; they are never obtained from the
projection caller.

A retry before, during, or after the creation response resolves the same server-control result key and
therefore the same stored target chat, command, selected executor, terminal reservation or nested
attempt, and result; it cannot allocate a second chat, send a second native POST, or make a second
nested management send. The host-signed server-control result payload includes the stored target
chat ID so the requester can subscribe to its chat route. A changed proposal under the same source ID
is a collision. Physical server-control order decides allocation order only; all later mutations use
the target chat's own command/native-order actors.

The server-control plaintext is one non-chunked compact UTF-8 JSON object with keys in this order:

```ts
type A1NewChatProposalPayload = {
  v: 1;
  intent: "first_bootstrap" | "new_chat";
  project_id: string;
  workspace_selector_id: string;
};
```

All strings are non-empty A1 safe IDs of at most 128 ASCII bytes. There are no optional or extra
fields, directory/header aliases, native workspace/session IDs, target chat ID, title/history match,
provider coordinate, or caller creation marker. Header `logical_chat_id` and `seq` are null,
`client_msg_id` is present, `part=0`, and `parts=1`. The host resolves the public
`(project_id, workspace_selector_id)` through exactly one current
`ProjectTargetSelectorMappingRecord` inside the server sequencer's deciding transaction. That mapping
selects either a terminal native workspace or a nested server; zero, multiple, or stale mappings
produce an ordered rejection. The host, not the caller, creates a native marker only for the terminal
OpenCode arm.

The corresponding `chat_creation_result` is also non-chunked, has null `logical_chat_id`,
`seq=command_seq`, `client_msg_id` equal to the proposal's value, stable semantic-result `msg_id`, and
all outbound host-authentication fields non-null. Its exact plaintext is
`A1ChatCreationResultPayload` below. Any other header/nullability/part combination is an invalid
server-control position, not a generic chat proposal.

Every A1 frame also carries an authenticated `deliveryAttemptId`: a fresh random ID for one transport
attempt, shared by all of that attempt's parts. `msgId` remains the stable semantic source ID.
`IngressDeliveryCandidateRecord` is unique on `(ingressResultId, deliveryAttemptId)`, and
`AuthenticatedIngressPartRecord` is unique on `(ingressCandidateId, part)`. Both inherit the full
server/route/chat/source scope through immutable foreign keys; no candidate or part map is keyed by `msgId`
alone. `IngressTransportAttemptRecord` is unique on
`(brokerRouteId, deliveryAttemptId)`; the source namespace
is immutable bound data, not part of the lookup key. The row durably binds one delivery attempt to one
namespace, result, stable logical header, and part count. Reusing that attempt after rollover under
another namespace, `msgId`, header, or part count is therefore a host-side collision linked to the
original result and a blocked observation, not a new result.
`stableLogicalHeaderDigest` is unpadded-base64url SHA-256 of
`str("remote-claw/a1/attempt-header/v1") || bytes(stableLogicalHeader)` using the exact
[v2 Architecture §4.3](v2-architecture.md#43-session-message-key-flow-answers-do-we-need-a-sessionkey-flow)
writer.

Before opening an A1 route, the versioned broker client requires this complete backend contract:

```ts
interface BrokerBackendCapabilitiesV1 {
  schemaVersion: 1;
  protocol: "remote-claw-broker-a1";
  durableCiphertext: true;
  routeWideDeliveryAttemptUniqueness: true;
  brokerRecomputesTransportDigest: true;
  exactRetryReturnsOriginalCursor: true;
  generationManifests: true;
  immutableCollisionTombstones: true;
}
```

Its exact canonical digest is:

```text
SHA256(
  str("remote-claw/broker-backend-capabilities/v1") ||
  uint(1) ||
  str("remote-claw-broker-a1") ||
  uint(1) || uint(1) || uint(1) || uint(1) || uint(1) || uint(1)
)
```

The six trailing `uint(1)` fields appear in interface order. A1.6 implements the strict pure parser,
canonical bytes and digest, negotiation-first client, selected SQLite/libSQL provider, durable route
storage, and conformance proof. The selected digest is
`pxq9w0eeR1rKMUyVw5p5Sgl6VU1jdEHAPYlrS93Cbdo`.

The backend advertises it through authenticated `GET /api/a1/capabilities`, and the host pins the
returned canonical vector/digest in an immutable protected artifact and
`BrokerBackendCapabilityPinRecord` before installing the first local route receipt. An absent,
partial, unknown-version, or changed vector fails A1 route readiness. The declaration is not accepted
as proof by itself: the A1 broker conformance suite verifies every property against the configured
backend, including restart and rollover. An A0 client never requests this contract, and an A0 backend
must reject the A1 operation rather than imitate it with weaker `msgId` deduplication.

Selected A1 requires a durable ciphertext broker whose route-wide transport uniqueness key is
`(route token, deliveryAttemptId, part)`, not semantic `msgId` and not one generation. The first insert
first parses the exact clear frame schema, rejects duplicate or noncanonical fields, and recomputes the
normalized transport-frame bytes and digest itself; it never trusts a publisher-supplied digest. The
insert atomically stores its assigned `(channelGeneration, frameIndex)` and that recomputed digest. An
exact HTTP retry before or after rollover returns that original cursor only when the recomputed digest
matches; different bytes under the same key fail closed as a transport collision. A semantic retry
uses a fresh delivery ID with the same `msgId`. The no-rollover Workflow broker remains an A0 backend
and cannot advertise A1 recovery.

Implemented A1.6 retains every scope-bus, chat, and server-control-route ciphertext frame body indefinitely because a
newly paired viewer must verify and traverse each authenticated route from genesis; selected A1 has no
semantic-route checkpoint that can safely skip mutation/result history. It also retains indefinitely the route-wide
`(route token, deliveryAttemptId, part) → (channelGeneration, frameIndex, transportFrameDigest)`
tombstone and the generation manifest. Selected A1 has no safe collection transition: local chat
closure and machine reset do not revoke copied bearer/key material, and the broker has no permanent
route-revocation protocol. A future bounded-retention version must add and prove that protocol rather
than infer safety from time or local deletion. Checkpointing and scope-bus compaction are not A1.6
features. The existing explicitly dev/CI-gated locator `dropScope()` remains destructive whole-scope
test cleanup, not a production retention or revocation transition. A late exact retry returns the old
cursor; changed bytes still collide, and neither can insert a new position.

**A1.7a implementation boundary:** the paragraphs through classification step 3 below describe the
implemented dormant ingress slice. It retains each state-changing page and its exact frame-evidence
vector, then moves the physical fetch cursor only after the page and every supplied raw frame are
durable; an unchanged empty open live-tail poll is an evidence-preserving no-op. A separate semantic cursor moves only one proven advanceable position or sealed-generation
boundary at a time, so fetch may use the bounded lookahead while an earlier multipart candidate or
gap holds semantic progress. A1.7b1 now implements the direct-only route-head → shared-ready-journal
→ rejected-command/order → signed-result-preparation subset of steps 4 onward. A durable
`awaiting_order` row is still not itself a command, decision, final result, outbox item, or effect
authority, and production invokes neither the ingress actor nor the command repository.

The canonical message digest is computed only after every authenticated part in one candidate is
present, over the versioned canonical logical-frame header—excluding `deliveryAttemptId`, salt, nonce,
and individual part index—plus the complete reassembled plaintext. A single matching old part never
returns a parent result. After a terminal result, one fresh-attempt replay candidate must supply all
expected parts with the same coordinates and authenticated part digests; only then is it a
`completed_exact_replay`. A changed coordinate, part count, part digest, or final canonical message
digest latches a collision on the result and quarantines the source/chat. No later exact subset or
candidate may produce a success result while that collision latch remains unresolved.

`authenticatedPartDigest` and `canonicalMessageDigest` use the exact
`remote-claw/a1/stable-part/v1` and `remote-claw/a1/logical-message/v1` encodings in
[v2 Architecture §4.3](v2-architecture.md#43-session-message-key-flow-answers-do-we-need-a-sessionkey-flow).
The part digest is computed only after AEAD open and excludes `deliveryAttemptId`, salt, and nonce, so
an exact semantic retry under fresh transport encryption compares equal.

Assembly across all candidates for one semantic result is bounded by the same maximum part count,
candidate count, and total-byte cap as live frame decoding, plus one durable result deadline. A second
candidate may complete a first candidate's interrupted delivery only when every overlapping coordinate
matches and one candidate itself supplies the complete part set. An incomplete result remains
non-writable and holds the contiguous source cursor only until its deadline. If no candidate completes,
expiry atomically writes `quarantined_incomplete` and candidate/part/tombstone records. A chat route
does not emit an `action_result` in A1.7a; a server-control route likewise emits no
`chat_creation_result`. An incomplete or colliding row never receives a command sequence. Explicit
recovery may allow the contiguous cursor to advance without converting that tombstone into a command
or result. A1.6 retains ciphertext frame bodies from genesis on chat,
server-control, and discovery-only scope-bus routes. The later ingress ledger described here also
retains plaintext part bodies on chat and server-control routes. The full-scope semantic result key,
`expectedParts`, every `(part, authenticatedPartDigest)` coordinate, source payload schema, canonical
message digest, source-event fingerprint tuple, disposition, stable semantic result ID, accepted
transport candidate, transport-attempt binding, and the collision/incomplete tombstone needed to
reject replay remain indefinitely for that route. A1.7b1 retains its command/decision/preparation
artifacts and signatures; A1.8a0 now retains the final rejected action/chat payload bytes, common
result, signer acceptance, logical terminal overlay, and inert delivery intent. Full A1.8a/A1.8b must
separately add admitted effects and sealed/published delivery. Neither local chat/channel closure nor machine reset authorizes collection because copied
bearer/key material may remain valid. A late missing part links the tombstone as
`late_after_tombstone` and cannot resurrect or execute the message.
Candidate/count/byte overflow follows the same terminal quarantine path immediately.

One serializable transaction locks the unique result key and classifies each authenticated
observation:

1. A new part creates or extends the result's exact `deliveryAttemptId` candidate without allocating a
   command or viewer projection sequence.
2. An honest exact retry of an already stored delivery-attempt part returns its existing broker cursor
   and therefore resolves to the same deterministic channel/ingress observation. If the hostile broker
   replays those valid bytes at a fabricated new cursor anyway, the host creates an advanceable
   `exact_transport_retry` observation that changes no candidate, creates no result delivery, and never
   starts a second decision. Before classification, the transaction updates the result/candidate
   `firstIngressCursor` to the minimum and `lastObservedIngressCursor` to the maximum of every
   authenticated physical position. If the fabricated duplicate becomes the earliest position while
   the result is non-terminal, that position inherits the candidate's block rather than becoming
   advanceable. Genuinely missing parts may still extend and complete that candidate across a
   generation boundary.
3. Completion computes the full digest. A new message advances to `awaiting_order`; a
   same-ID/different message atomically latches a collision and quarantines the dormant route. It does
   not yet mutate the logical-chat lifecycle row.
4. Each route-local scheduler exposes only its earliest unblocked semantic result by
   `firstIngressCursor`; cursors from another chat or the server-control route are never compared. A
   later result on the same route may assemble and enter `awaiting_order`, but cannot become that
   route's head while an earlier position remains blocked. When a route head first becomes eligible,
   the journal assigns immutable `readyAtJournalSeq` and materializes the common command. One
   server-wide sequencer chooses the smallest `(readyAtJournalSeq, commandId)` among ready common
   commands from every source kind and atomically increments
   `CollaborationServerRecord.nextCommandSeq`. Thus `commandSeq` is unique and definitive within one
   collaboration server without pretending route-local cursors have a total order. A partial proposal
   on one route does not block another unless a separately recorded server-scope quarantine applies.
   The server-control actor receives the same command sequence before it either rejects creation or
   allocates an admitted target chat.
5. The decision-reservation transaction records the ordered server decision, freezes the selected
   target/capability and canonical command-record digest, allocates the exact result preparation and
   signing reservation, and leaves the ingress in `deciding`. Every complete authenticated semantic
   proposal, including a rejected unsupported one, receives a `commandId` and `commandSeq`; malformed,
   incomplete, and colliding input does not. It reserves `viewerProjectionSeq` only for an admitted kind
   that will actually be projected, by atomically consuming the destination
   `LogicalChatRecord.nextViewerProjectionSeq`. Another chat has its own dense sequence and lock. An
   unsupported OpenCode attachment, or any other capability rejection, keeps that sequence null. This
   transaction creates no source ACK, stored A1 result,
   result delivery, projection intent, native/nested attempt, or external effect.
6. After protected-key signing, the signed-result-finalization transaction rechecks the frozen command
   digest, inserts the immutable common result and exact A1 semantic result, advances the terminal
   cursor/state, and creates the causal proposal/result outboxes plus first
   `IngressResultDeliveryRecord`. For a supported admitted action it also creates the selected executor
   attempt/effect gate and any provisional projection intent; only then may a separate dispatcher try
   the effect. The reserved viewer sequence orders only the admission receipt/provisional caller
   display. The final transcript row and `chat_seq` are allocated only when correlated native
   observation establishes native order; rebuild may move/replace the provisional row without changing
   its stable result ID. A rejected `action_result.command_seq` still names the ordered proposal.
   Nothing acknowledges the source or reaches an executor before this finalization commits.
7. A semantic replay of a terminal record requires a fresh delivery attempt whose own complete part
   set matches. It creates no command, echo, projection sequence, or native attempt—only an observation
   plus the one result-delivery outbox row uniquely associated with that observation. Reposting all or
   part of an already known delivery attempt remains a broker retry at its old cursor—or a host-side
   `exact_transport_retry` if the broker fabricates a new position—and never re-emits the result.
8. A collision before or after an earlier terminal success cannot rewrite that result. It creates a
   blocked collision observation, latches the result, and quarantines the source namespace/chat. No
   result, mutation, or cursor progress is released through that position until an explicit,
   auditable `ChannelPositionRecoveryRecord` marks only that position safe to discard. Recovery
   never rewrites the old result or treats the colliding bytes as applied.

Every physical frame first resolves its externally authenticated `BrokerRouteRecord` and creates one
`AuthenticatedChannelPositionRecord`, unique on
`(brokerRouteId, channelGeneration, frameIndex)`. `channelPositionObservationId` is
`rcp_${base64url(SHA256(str("remote-claw/a1/channel-position/v1") || str(brokerRouteId) ||
uint(channelGeneration) || uint(frameIndex)))}`. An authenticated inbound frame on a `chat` or
`server_control` route then creates one `AuthenticatedIngressObservationRecord` whose
`ingressObservationId` is
`rio_${base64url(SHA256(str("remote-claw/a1/ingress-observation/v1") ||
str(channelPositionObservationId)))}`.

The position transaction compares raw bytes before parsing. If the position already exists with the
same `receivedFrameDigest`, this is exact physical redelivery and returns the stored classification and
cursor disposition without parsing, decrypting, or mutating again. Different bytes at that cursor
create a durable `ChannelPositionEquivocationRecord`, latch a route gap/quarantine, and make no semantic
or cursor progress. The accepted bytes/digest are never overwritten. This applies whether both byte
strings are valid frames or one is malformed, and survives restart.

For a new position, parsing occurs only after the route/cursor row exists. Before any KDF selection or
AEAD open, the exact frame identity and server must equal the authenticated route. A `chat` route also
requires its exact chat ID and rejects `session_announce`, `new_chat`, and
`chat_creation_result`; a `scope_bus` route accepts only an outbound
`session_announce`, whose non-null chat ID selects the announced chat only after identity/server
matching and must belong to the route's server. A `server_control` route requires null chat and accepts
only inbound `new_chat` under the server-control input key or outbound `chat_creation_result` under
the server-control output key. A frame transplanted from another machine, server,
chat, or route—including bus↔control↔chat—is an `invalid` position with
`validationFailureCode: "route_transplant"` on the selected route; it is never dispatched or decrypted
according to its own header. The scope bus accepts no inbound semantic proposals.

An outbound position becomes `known_host_output` and immediately advanceable only after both of these
checks succeed: its certified Ed25519 host signature verifies, and its complete header/digest matches
the unique durable `HostOutputPartRecord` written before publish. This includes ordinary native
projections, accepted/action results, fresh A1 catch-up delivery attempts, and discovery announcements.
Because collaborators possess the shared sealing keys, neither AEAD nor
`dir: "out"` proves host origin. A pass holder may propose authenticated inbound work, but cannot forge
a server projection or membership announcement. An unsigned, invalidly signed, unknown, or changed
outbound frame is blocked and quarantined, never rendered, ignored, or admitted as an inbound proposal.
Its explicit recovery follows the same audited-discard rule as a collision.

The host first inserts one immutable `HostOutputDeliveryRecord`, unique on
`(brokerRouteId, deliveryAttemptId)`, for the complete common v2 header and signer policy. Each
delivery has an immutable foreign key to the already durable semantic decision/native-observation
outbox intent that authorized it; signing cannot create an orphan output. The signing service binds
its reservation and stored signature to that parent/part artifact in the same transaction that makes
the signed part recoverable, before returning a signature or allowing publish. Thus a crash cannot
leave a valid server-signed frame that the host later classifies as `unknown_outbound`.
Each
`HostOutputPartRecord` has that parent as a foreign key and must match its route, machine/server/chat,
message, attempt, part count, server key generation, signer key, and scope certificate. The host
allocates each part's salt/nonce once, seals that part once, and persists the complete serialized
`A1EncryptedFrameV2` bytes in `sealedFrameRef` before publishing. It obtains the signature
only through the current fenced signing lease and stores the exact key generation, signer ID, signature,
scope certificate, signature sequence, host-signed-record digest, header, transport digest, and bytes.
`hostSignedRecordDigest` is SHA-256 of the exact versioned host-signature payload from
[v2 Architecture §4.3](v2-architecture.md#43-session-message-key-flow-answers-do-we-need-a-sessionkey-flow).
`HostOutputPartRecord` is unique on both
`(brokerRouteId, deliveryAttemptId, part)` and `(hostOutputDeliveryId, part)`; every header field,
`parts`, digest, sealed bytes, signer coordinate, and signature is immutable. A conflicting local
insert quarantines the route.

After exactly one immutable row exists for every index `0..parts-1`, compute
`completePartVectorDigest = SHA256(str("remote-claw/a1/host-output-part-vector/v1") ||
str(hostOutputDeliveryId) || uint(parts) || bytes(base64urlDecode(hostSignedRecordDigest[0])) ||
bytes(base64urlDecode(transportFrameDigest[0])) || ... ||
bytes(base64urlDecode(hostSignedRecordDigest[parts-1])) ||
bytes(base64urlDecode(transportFrameDigest[parts-1])))` in index order. Every digest is canonical
unpadded base64url of exactly 32 bytes. One compare-and-swap moves the parent from
`preparing` to `ready` and stores that digest. Missing, extra, duplicate, re-ordered, or
header-inconsistent siblings quarantine the parent and route. No part may publish before the parent is
`ready`; publish/recovery rechecks the exact parent and complete vector, then advances the parent and
parts together. This prevents a crash or conflicting sibling from exposing a mixed multipart output.

Every retry of that output row—including after a crash where publish may
have committed but its response was lost—reuses those bytes exactly; re-sealing or re-signing under the
same `deliveryAttemptId` is forbidden. The sealed bytes remain until the durable broker receipt and
matching channel-position observation are committed. Only then, and only while the broker's
route-wide cursor/digest tombstone remains live, may `sealedFrameRef` become null. Multipart native
output, catch-up, and result delivery follow the same rule.

The position row is created from the broker-authenticated route/cursor before frame parsing or AEAD
open. `receivedFrameDigest` is unpadded-base64url SHA-256 of the exact received frame bytes;
`normalizedTransportFrameDigest` exists only after the exact v2 object validates. Duplicate JSON
members, bad encodings/lengths, unknown kinds, wrong planes, and failed AEAD become immutable
`invalid` positions with a versioned failure code and no ingress/result link. In one transaction, the
coordinator records an explicit recovery gap, quarantines the channel, and marks that physical
position advanceable as a terminal no-mutation rejection. This avoids an unrepresentable cursor hole,
but later valid proposals may only assemble or buffer—not enter decision or native delivery—until
explicit recovery resolves the quarantine. No semantic acknowledgement is emitted for the invalid
frame.

The parsed header fields on an invalid position are nullable because duplicate, missing, or wrong-type
members have no canonical value; an implementation must not choose a first or last duplicate merely to
fill them. Every non-`invalid` classification requires all header fields and
`normalizedTransportFrameDigest` to be non-null and fully validated.

Resolving that gap requires a current-epoch `ChannelPositionRecoveryRecord` with the matching
`brokerRouteId`, `reason: "invalid_frame"`, and evidence for either safe discard or source closure. The transaction
links the recovery to the invalid position, resolves its gap, and clears channel quarantine only when
no unresolved gap/collision remains. Buffered valid proposals then re-enter the ordinary
first-ingress order; they never overtake the invalid position before that transition.

Schema v10 implements only the A1-ingress `deciding` sidecar for its frozen rejected decision and
current result-preparation pointer. Schema v11 A1.8a0 now implements the rejected-only terminal
overlay and initial plaintext `pending_seal` intent; the encrypted/sealed/published states below
remain A1.8b target behavior. `IngressResultDeliveryRecord` is unique on
`(ingressResultId, triggerIngressObservationId)`;
`resultDeliveryId` is
`rrd_${base64url(SHA256(str("remote-claw/a1/result-delivery/v1") || str(ingressResultId) ||
str(triggerIngressObservationId)))}`. Its random `deliveryAttemptId` is allocated once in the same
transaction. Redelivery of one committed broker cursor after a crash therefore finds the same
observation and outbox row rather than creating a fresh result delivery on every restart.
In A1.8a0 the `triggerIngressObservationId` is the accepted candidate's greatest route-ordered
`new_part` observation after exact part completeness, the target is the source `brokerRouteId`, and
the once-random `deliveryAttemptId` is retained. The row has no sealed frame, output signature,
claimant, publish attempt, or broker receipt, and no operation can drain it.

The target `EncryptedChannelCursorRecord` is represented in A1.7a by the separate fetch and semantic
cursor rows. The semantic row advances only across a contiguous prefix of channel-position
observations with `cursorDisposition: "advanceable"`. A future matched host output, terminal invalid-frame
rejection, terminal inbound success, complete exact replay, bounded incomplete expiry, and a late part
linked to an already terminal tombstone can become advanceable. A collision or unknown outbound
position is blocked even if it references an otherwise terminal result; only explicit recovery can
change that observation's cursor disposition. A crash in `assembling` resumes the bounded group or
expires it; a crash in
`awaiting_order` preserves its place; a crash in `deciding` resumes the journaled decision; a crash
after A1.8a0 terminalization reconciles the inert `pending_seal` graph, while later A1.8b will own
draining. Thus restart cannot convert pending into new,
lose a terminal result, overtake an earlier multipart proposal, or execute a duplicate.

`BrokerChannelCursorV1` is an exact physical coordinate within one `BrokerRouteRecord`, not an opaque
or globally meaningful string. For every scope-bus, server-control, or chat route, the A1 broker assigns
`frameIndex = 0, 1, ...` transactionally to newly inserted frames within `channelGeneration`; every
frame or multipart part occupies one index. The coordinator resolves a chat or server-control route's
authenticated web outside-binding/source namespace before semantic adjudication; official and nested
connectors retain their separate ingress domains. The scope bus has its own cursor/quarantine actor and
never enters semantic ingress. The durable broker's route-wide
`(route token, deliveryAttemptId, part)` row owns one immutable cursor. An exact transport retry returns
that cursor even after rollover; changed normalized frame bytes under the same key fail closed as a
transport collision and create no position. A semantic retry has a fresh delivery attempt and
therefore new positions.

At 4,096 unique frames A1.6 generation closure atomically seals `BrokerChannelGenerationRecord.frameCount`,
`nextGeneration = channelGeneration + 1`, and the canonical manifest digest before that next
generation accepts a frame; indices restart at zero there. The first accepted sealed
`(brokerRouteId, generation, frameCount, nextGeneration, state)` tuple is immutable. An exact duplicate
manifest is idempotent. A changed count/state/successor creates a durable
`BrokerChannelManifestEquivocationRecord`, latches a route gap/quarantine, and never rewrites ordering.
Likewise, a frame observed at `frameIndex >= frameCount` in a sealed generation is manifest
equivocation, not an append. A conflicting attempt to reopen the sealed generation has
`conflictingManifestDigest: null`; `conflictingObservationDigest` always hashes the exact received
manifest/transition evidence, so the conflict remains representable. Empty sealed generations have
`frameCount = 0` and remain in the manifest chain.
An open generation has null `frameCount`, `nextGeneration`, and `manifestDigest`; a sealed generation
has all three non-null, `nextGeneration === channelGeneration + 1`, and non-negative safe-integer
counts. The sealed digest is unpadded-base64url SHA-256 of these exact bytes:

```text
str("remote-claw/a1/broker-generation-manifest/v1")
str(brokerRouteId)
uint(channelGeneration)
uint(frameCount)
uint(nextGeneration)
str("sealed")
```

No open-state digest is accepted or compared as a sealed manifest.
Cursors order lexicographically by `(channelGeneration, frameIndex)`. Within a generation, the
successor of `(g, i)` is `(g, i+1)` while `i+1 < frameCount`; after the last frame, the sealed manifest
points to `(g+1, 0)` or across any explicitly recorded empty generations. An open generation has no
claimed successor beyond its current last inserted index. The same durable broker transaction that
seals generation `g` creates the unique `g+1` manifest row or proves it already exists, so concurrent
publishers cannot fork or renumber the chain. A crash after seal but before the coordinator consumes
the final old frame resumes by durable `(channelGeneration, frameIndex)` cursor and drains through the
stored `frameCount` before reading its successor. After every supported recovery lease has passed a
scope-bus generation, a later checkpoint/retention milestone may define compaction; A1.6 does not.
All route ciphertext remains retained from genesis. Selected A1 never deletes the
sealed-generation manifest, cursor/digest tombstone, or immutable ordering coordinates.

The A1.6 subscribe operation returns one bounded page from exactly one generation: the sampled
generation descriptor and open tail, at most 64 cursor/digest/canonical-frame entries, a next position,
and whether that next position is the live tail. A drained sealed generation—including an empty
one—advances to `(g+1, 0)`; a drained open generation remains at its sampled tail. It never returns a
checkpoint or crosses a generation inside one page. Dormant A1.7a now durably consumes those pages
and retains the page, frame, raw-position, cursor, and manifest observations described below.
The coordinator buffers out-of-order positions and never infers a missing successor from wall time,
frame count sampled at startup, or a newer generation alone. A partial multipart candidate blocks the
contiguous high-water mark at its earliest unresolved part; subsequent observations may be durably
classified or assembled but cannot be decided or offered inward ahead of it. Exact completion or
bounded terminal expiry can unblock that position. Collision does not: it remains a cursor hole until
explicit recovery records a safe discard. One local transaction then advances across the longest
advanceable prefix. For example, if part 0 of proposal A arrives, complete proposal B arrives, and then
the rest of A arrives or A expires, B waits in `awaiting_order` and never overtakes A. A broker can
still withhold data and cause availability loss, but cannot make a skipped cursor become a second
semantic command because full-scope source adjudication remains mandatory.

The semantic result and its transport delivery have separate identities. The initial signed-result
finalization atomically enqueues the first durable `IngressResultDeliveryRecord`; each later exact-replay
observation owns one distinct row and random `deliveryAttemptId`. Retries of that outbox item reuse the
stored delivery ID, while a later ingress observation gets another one. Its A1 frame uses the stable
semantic result ID as `msgId` and the fresh delivery ID for broker uniqueness.

The encrypted UTF-8 JSON result payload has one of three exact shapes; it is compact (no insignificant
whitespace), and keys are emitted in the shown order with no extra fields:

```ts
type A1ProjectionAcceptedPayload = {
  v: 1;
  result_id: string;
  client_msg_id: string;
  seq: number; // exactly viewerProjectionSeq
};

type A1ActionResultPayload = {
  v: 1;
  result_id: string;
  source_msg_id: string;
  source_record_kind: string;
  decision: "admitted" | "queued" | "rejected";
  command_seq: number | null;
};

type A1ChatCreationResultPayload = {
  v: 1;
  result_id: string;
  source_msg_id: string;
  decision: "admitted" | "rejected";
  target_logical_chat_id: string | null;
  command_seq: number;
};
```

Every variable string in these payloads is an A1 safe ID matching `[A-Za-z0-9._:-]+`; the other strings
are the fixed literals shown above. Quotes, backslashes, controls, non-ASCII, optional slash escaping,
and any alternative spelling are rejected rather than escaped or normalized, so the compact bytes are
unique. Payload `v` is exactly the token `1`. `seq` and non-null `command_seq` use the canonical non-negative safe-integer token
`0|[1-9][0-9]*`, at most `2^53−1`; signs, leading zeroes, fractions, and exponents are rejected.
Null `command_seq` is exactly the token `null`.

The third shape is used only as host-signed `record_kind: "chat_creation_result"` on the
`server_control` route. On `admitted`, `target_logical_chat_id` and `command_seq` are both non-null and
name the exact stored target/command; on `rejected`, the target is null while `command_seq` still names
the server-ordered decision. Its null spelling is the literal `null`, and a non-null chat ID obeys the
exact A1 `rcl_` encoding. The decision-reservation transaction allocates the target
`LogicalChatRecord(state: "recovering")`, its chat `BrokerRouteRecord` plus open genesis, the frozen
selected executor, and the common result preparation; it creates no output, attempt, or effect gate.
After the signature is retained, finalization inserts the common/A1 results and output intent plus
exactly one selected-executor arm. A terminal-native arm creates the starting native binding and native
creation reservation/effect gate; a nested-server arm creates no native binding and creates the nested
management attempt/effect gate. Only that finalization may announce the recovering row. The terminal arm becomes ready
only with its positive native bind; the nested arm becomes ready only after target-ready/root proof,
two-party edge installation, and a current live lease. Rejection or terminal uncertainty changes it
to `quarantined`. Exact result replay returns the byte-identical target and never allocates, announces,
posts, or sends inward again.

An admitted `user` or `attachment` proposal uses meta `record_kind: "accepted"` and the first shape.
Every queued/rejected proposal, and every admitted control other than `attachment`, uses meta
`record_kind: "action_result"` and the second. For an admitted attachment, semantic validation performs
no file write. Admission additionally requires the command's exact
`remote-claw/command-payload/attachment/v1` manifest, item-vector, and retained content bytes plus a
target family capability naming that same common schema; an adapter-shaped JSON blob or an
`unsupported_recognized` payload can never produce `accepted`. Its decision-reservation transaction
allocates one viewer-projection sequence and
freezes the decision. Only signed-result finalization creates the exact retained `accepted` payload,
one user attachment projection intent, and its write-ahead-fenced native attempt. A later dispatcher
writes the files and offers the prompt. Exact replay only redelivers the stored result: it does
not write another file, allocate another projection/sequence, or start another native attempt. Changed
attachment bytes under the same semantic ID are a collision. All three payload shapes are coordinator
admission/order results, not proof that the native harness applied a mutation.
`storedSemanticResultRef` names exactly one retained payload. Broker uniqueness can suppress a
transport retry of one envelope without suppressing the next observation's delivery, and clients fold
all such envelopes by stable `result_id`. Reposting the original deterministic A0 `accepted-*` message
ID is explicitly forbidden.

The paired schema ID and `storedSemanticResultDigest` are immutable and equal SHA-256 of
`str("remote-claw/a1/stored-semantic-result/v1") || str(storedSemanticResultSchemaId) ||
bytes(exactCompactUtf8Payload)`. Every `IngressResultDeliveryRecord` repeats that schema/digest;
its encrypted-payload digest covers the retained sealed bytes, and decrypting them under the selected
route/plane must reproduce the exact stored plaintext digest before publish or replay. A ref
substitution or changed result bytes under one `stableSemanticResultId` quarantines the route.

`NativeTransportAttachmentRecord` and `NativeTransportLeaseRecord` describe remote-claw's one collaboration
attachment to the native harness, not the person's TUI connection or the inference connector. The
client-facing endpoint and `InferenceConnectorLease` are supervised by the native runtime owner so a
collaboration-coordinator restart does not tear down local work.

Before a decision can admit a native mutation, the transaction must pin the current immutable
`NativeBindingCapabilitySnapshot` for the exact binding, native incarnation, attachment lease, engine
version, and exact `NativeMutationFamilyCapability`. That family entry fixes the native route,
canonical request, transport-receipt meaning, action-ID requirement, positive read-back,
positive-never-started, source-causality, and proof tuple for this one family; no text, compact, abort,
permission, creation, or future-control family inherits another family's evidence rules. The runtime owner—not the collaboration
coordinator—attests that local snapshot from retained proof for the installed tuple. Missing, stale,
superseded, downgraded, or family-incomplete snapshots deterministically reject before a user
projection or native attempt. Recovery after an adapter/server upgrade may finish an old attempt only
under its pinned historical snapshot; if that implementation is unavailable, it quarantines instead of
reinterpreting the request under new rules.

Capability generation is monotonic within one attachment lease. Installation atomically
compare-and-swaps `NativeTransportLeaseRecord.currentCapabilitySnapshotId`, marks the prior snapshot
superseded, and makes exactly one snapshot current; withdrawal may instead revoke it and clear the
pointer. The decision and the pre-send attempt claim both revalidate that pointer, lease, incarnation,
and coordinator fence. Once an attempt is `started`, recovery keeps its historical schema only to
observe/contain that attempt; it does not make the old capability writable for another command.

Each family appears at most once and is ordered by the closed `NativeMutationFamily` declaration above.
Its `capabilityFamilyDigest` is unpadded-base64url SHA-256 of:

```text
str("remote-claw/native-mutation-family-capability/v1")
str(mutationFamily)
str(capabilityScope)
str(canonicalCommandPayloadSchemaId)
str(nativeRequestTranslatorSchemaId)
bytes(base64urlDecode(nativeRequestTranslatorImplementationDigest))
bytes(base64urlDecode(nativeRequestTranslatorBuildManifestDigest))
bytes(base64urlDecode(nativeRequestTranslatorDigest))
bytes(base64urlDecode(translationInjectivityProofDigest))
bytes(base64urlDecode(manifestEntryDigest))
bytes(base64urlDecode(nativeOperationCoordinateDigest))
str(nativeMethod)
str(nativeRouteSchemaId)
str(canonicalQuerySchemaId)
str(canonicalHeaderSchemaId)
str(canonicalBodySchemaId)
str(targetScope)
str(canonicalRequestSchemaId)
str(transportReceiptSemantics)
str(nativeActionIdRequirement)
str(positiveReadBackSchemaId)
optionalStr(positiveNeverStartedSchemaId)
str(sourceCausality)
bytes(base64urlDecode(proofTupleDigest))
bytes(base64urlDecode(evidenceDigest))
```

`nativeRequestTranslatorDigest` is SHA-256 of
`str("remote-claw/native-request-translator/v1") || str(canonicalCommandPayloadSchemaId) ||
str(nativeRequestTranslatorSchemaId) ||
bytes(base64urlDecode(nativeRequestTranslatorImplementationDigest)) ||
bytes(base64urlDecode(nativeRequestTranslatorBuildManifestDigest)) ||
str(canonicalRequestSchemaId) || bytes(base64urlDecode(translationInjectivityProofDigest))`.
The retained injectivity proof establishes that distinct common payload bytes or allowed generated
coordinate bytes cannot yield one identical native request/path pair. A many-to-one translator,
unretained implementation/build, or source of native bytes outside that closed input is not writable.
The retained family evidence supplies `evidenceDigest`; refs are only local locators.
`familyCapabilityVectorDigest` is SHA-256 of
`str("remote-claw/native-mutation-family-vector/v1") || uint(count)`, followed by each
`bytes(base64urlDecode(capabilityFamilyDigest))` in that fixed enum order. Duplicate, unknown, or reordered families,
wrong digest lengths, and two entries that claim the same mutation route are invalid. The decision,
attempt, and last-hop dispatch all recompute and pin the identical family digest.

The snapshot-level proof tuple is SHA-256 of:

```text
str("remote-claw/native-capability-proof-tuple/v1") ||
str(descriptor.product) || str(descriptor.access) || str(engineVersion) ||
str(nativeSurfaceSchemaId) || bytes(base64urlDecode(nativeSurfaceSchemaDigest)) ||
bytes(base64urlDecode(nativeListenerRouteManifestDigest)) ||
bytes(base64urlDecode(runtimeIsolationAttestationDigest)) ||
bytes(base64urlDecode(operationClassificationVectorDigest)) ||
bytes(base64urlDecode(familyCapabilityVectorDigest)) ||
optionalStr(slashCommandNormalizationSchemaId) ||
optionalDigest(slashCommandNormalizationImplementationDigest) ||
optionalDigest(slashCommandTableDigest) || bytes(base64urlDecode(evidenceDigest))
```

The three slash fields are present only for a binding snapshot and absent for a server snapshot.
`proofTupleDigest` must recompute from the exact retained manifest, isolation, operation, family,
slash-table, and evidence refs. A native binary/surface change flows through those measured records and
changes this tuple.

The binding snapshot's `canonicalSnapshotDigest` is SHA-256 of:

```text
str(canonicalSnapshotSchemaId) || uint(schemaVersion) || str(capabilitySnapshotId) ||
str(nativeBindingId) || str(runtimeId) || uint(nativeIncarnation) ||
str(attachmentLeaseId) || uint(capabilityGeneration) ||
str(descriptor.product) || str(descriptor.access) || str(engineVersion) ||
str(nativeSurfaceSchemaId) || bytes(base64urlDecode(nativeSurfaceSchemaDigest)) ||
bytes(base64urlDecode(nativeListenerRouteManifestDigest)) ||
bytes(base64urlDecode(runtimeIsolationAttestationDigest)) ||
bytes(base64urlDecode(operationClassificationVectorDigest)) ||
bytes(base64urlDecode(familyCapabilityVectorDigest)) ||
str(slashCommandNormalizationSchemaId) ||
bytes(base64urlDecode(slashCommandNormalizationImplementationDigest)) ||
bytes(base64urlDecode(slashCommandTableDigest)) ||
bytes(base64urlDecode(proofTupleDigest)) || bytes(base64urlDecode(evidenceDigest)) ||
uint(verifiedAtMs)
```

The server snapshot uses:

```text
str(canonicalSnapshotSchemaId) || uint(schemaVersion) || str(serverCapabilitySnapshotId) ||
str(runtimeId) || uint(nativeIncarnation) || str(nativeServerAttachmentLeaseId) ||
uint(capabilityGeneration) || str(descriptor.product) || str(descriptor.access) ||
str(engineVersion) || str(nativeSurfaceSchemaId) ||
bytes(base64urlDecode(nativeSurfaceSchemaDigest)) ||
bytes(base64urlDecode(nativeListenerRouteManifestDigest)) ||
bytes(base64urlDecode(runtimeIsolationAttestationDigest)) ||
bytes(base64urlDecode(operationClassificationVectorDigest)) ||
bytes(base64urlDecode(familyCapabilityVectorDigest)) ||
bytes(base64urlDecode(proofTupleDigest)) || bytes(base64urlDecode(evidenceDigest)) ||
uint(verifiedAtMs)
```

Lifecycle `state` and attestation locator/signature fields are excluded. The runtime owner signs one
`NativeCapabilitySnapshotAttestation` whose payload is:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) ||
str(capabilitySnapshotAttestationId) || str(snapshotKind) || str(snapshotId) ||
str(canonicalSnapshotSchemaId) || bytes(base64urlDecode(canonicalSnapshotDigest)) ||
str(runtimeId) || uint(nativeIncarnation) || str(runtimeOwnerIdentityKeyId) ||
uint(runtimeOwnerKeyGeneration) || uint(signerSequence) || uint(issuedAtMs)
```

Its `canonicalPayloadDigest` is SHA-256 of those bytes and `signedRecordDigest` is SHA-256 of
`str("remote-claw/native-capability-snapshot-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || str(runtimeOwnerIdentityKeyId) ||
uint(runtimeOwnerKeyGeneration) || uint(signerSequence) || bytes(base64urlDecode(signature))`.
The purpose-specific reservation and runtime-owner acceptance row must match before the snapshot
pointer can become current. For a binding snapshot, `runtimeOwnerAttestationRef` must resolve exactly
one attestation with `snapshotKind:"binding"`, `snapshotId == capabilitySnapshotId`, the binding
snapshot schema/digest, and the same runtime/incarnation. For a server snapshot, the corresponding
values are `snapshotKind:"server"`, `snapshotId == serverCapabilitySnapshotId`, and the server
snapshot schema/digest. A TUI policy uses `snapshotKind:"tui_policy"`, its TUI policy snapshot
ID/schema/digest, and the same runtime/incarnation. In every case `runtimeOwnerAttestationDigest` must
equal the recomputed `signedRecordDigest`; the runtime-owner key generation and signer sequence must be
accepted under `native_capability_snapshot` for binding/server or `native_tui_policy_snapshot` for
TUI. Snapshot refs are parsed and every component digest is recomputed; same
ID with different content, a cross-kind/ref transplant, or a changed attestation is equivocation. A
decision's native executor evidence and its native attempt/reservation repeat this exact signed-record
digest. Superseded/revoked snapshots remain readable only for a previously started attempt and cannot
authorize a new one.

Scope is closed: `new_chat` appears only with `capabilityScope:"server"` in a
`NativeServerCapabilitySnapshot` and can reach only the creation reservation/server front door.
Every other family is `binding` and can appear only in a `NativeBindingCapabilitySnapshot` and
binding-scoped delivery attempt/front door. A lease or snapshot containing the other scope's family is
invalid; no adapter credential can turn a session route into creation or vice versa.

The operation/family join is reciprocal without a hash cycle. A classification is
`collaborator_family` if and only if its
mutation family and family-capability digest are both non-null, its method/route/query/header/body/target
scope exactly match that family entry, and the family points back to that exact operation-coordinate digest.
Exactly one collaborator operation may implement a family in one snapshot. Every other classification
keeps both fields null; `runtime_management` cannot become writable until a separate runtime-management
capability schema exists. `proved_read` requires retained proof and is never inferred from the HTTP
verb. `tuiPolicy:"pass"` is valid only for `proved_read`, `tui_only`, or a native operation explicitly
proved safe on the TUI seam; `virtualize` requires a pinned virtualization entry; `reject` forwards
nothing. Those three values are valid only when the manifest entry has `frontDoorKind:"tui"`.
Observer, binding-adapter, and server-creation entries require `not_applicable`; no policy value can
make one seam callable from another. Initial A2 permits no `virtualize` entry: the policy uses
`virtualizationSchemaId:"none"`,
null vector ref, and
`virtualizationPolicyDigest = SHA256(str("remote-claw/native-tui-virtualization-vector/v1") ||
uint(0))`. Exact credential-free provider/auth/config reads may be `tui_only`/`pass` only from the
sealed synthetic runtime view described in §9.3; their retained proof covers the exact response
schema and redaction. Provider/auth/config mutations are explicit `reject` with a pinned unsupported response.
The immutable unsupported-response vector contains one `NativeTuiUnsupportedResponseItem` per rejected
TUI operation, ordered by manifest position. Its digest is SHA-256 of
`str("remote-claw/native-tui-unsupported-response-vector/v1") || uint(count)` followed by
`bytes(base64urlDecode(operationEntryDigest)) || uint(statusCode) ||
str(canonicalHeaderSchemaId) || bytes(base64urlDecode(canonicalHeaderDigest)) ||
str(canonicalBodySchemaId) || bytes(base64urlDecode(canonicalBodyDigest))` for every item.
The refs retain the exact credential-free header/body bytes and must recompute those digests. The
TUI read-policy vector contains one `NativeTuiReadPolicyItem` for every passed TUI read, in manifest
order. Its digest is SHA-256 of
`str("remote-claw/native-tui-read-policy-vector/v1") || uint(count)` followed by
`bytes(base64urlDecode(operationEntryDigest)) || str(canonicalQueryScopeSchemaId) ||
str(responseParserSchemaId) || str(responseSchemaId) || str(redactionSchemaId) || str(dataSource) ||
str(nativeWorkspaceBindingId) || bytes(base64urlDecode(evidenceDigest))`. The retained evidence proves
the exact query/workspace scoping, parser, response schema, secret redaction, and either sealed
synthetic source or native state source. Prefix- or verb-wide policy is invalid.

The TUI-policy proof tuple commits to the virtualization, unsupported-response, and read-policy vector
digests. Startup compares every rejected operation to exactly one response item and every passed read
to exactly one read-policy item. A missing, extra, or generic catch-all entry invalidates the policy.
Future virtualization requires a separate entry
schema binding operation, connector action, response/events, custody/redaction, and write-ahead
recovery before this enum arm becomes valid. Any inconsistent combination invalidates the whole
snapshot.

The proof tuple is exactly SHA-256 of:

```text
str("remote-claw/native-tui-policy-proof-tuple/v1") ||
bytes(base64urlDecode(nativeListenerRouteManifestDigest)) ||
bytes(base64urlDecode(runtimeIsolationAttestationDigest)) ||
bytes(base64urlDecode(operationClassificationVectorDigest)) ||
str(virtualizationSchemaId) || optionalDigest(virtualizationVectorDigest) ||
bytes(base64urlDecode(virtualizationPolicyDigest)) ||
str(unsupportedResponseSchemaId) ||
bytes(base64urlDecode(unsupportedResponseVectorDigest)) ||
bytes(base64urlDecode(tuiReadPolicyVectorDigest)) ||
bytes(base64urlDecode(evidenceDigest))
```

For the version-one `none` arm, `virtualizationVectorDigest` is null, while the separately committed
empty-vector `virtualizationPolicyDigest` has the value above. The TUI snapshot's
`canonicalSnapshotDigest` is SHA-256 of:

```text
str(canonicalSnapshotSchemaId) || uint(schemaVersion) || str(tuiPolicySnapshotId) ||
str(runtimeId) || uint(nativeIncarnation) || str(nativeServerAttachmentLeaseId) ||
uint(policyGeneration) || str(descriptor.product) || str(descriptor.access) ||
str(engineVersion) || str(nativeSurfaceSchemaId) ||
bytes(base64urlDecode(nativeSurfaceSchemaDigest)) ||
bytes(base64urlDecode(nativeListenerRouteManifestDigest)) ||
bytes(base64urlDecode(runtimeIsolationAttestationDigest)) ||
bytes(base64urlDecode(operationClassificationVectorDigest)) ||
str(virtualizationSchemaId) || optionalDigest(virtualizationVectorDigest) ||
bytes(base64urlDecode(virtualizationPolicyDigest)) ||
str(unsupportedResponseSchemaId) ||
bytes(base64urlDecode(unsupportedResponseVectorDigest)) ||
bytes(base64urlDecode(tuiReadPolicyVectorDigest)) ||
bytes(base64urlDecode(proofTupleDigest)) || bytes(base64urlDecode(evidenceDigest)) ||
uint(verifiedAtMs)
```

Lifecycle state and attestation locator/signature fields are excluded. The runtime-owner attestation
must resolve to `snapshotKind:"tui_policy"`, this snapshot ID, schema, digest, runtime, and incarnation;
`runtimeOwnerAttestationDigest` must equal its recomputed signed-record digest. Its accepted signature
reservation has `purpose:"native_tui_policy_snapshot"`. The current process-ingress lease must name
that exact current policy snapshot and the same runtime, incarnation, server attachment, directory
path, and workspace-binding digest. A same-ID changed policy, missing ref, wrong kind or purpose,
attestation transplant, or stale process lease rejects before the TUI front door can pass a request.

The total native-operation table is independently canonical. Its cycle-free
`operationCoordinateDigest` is SHA-256 of
`str("remote-claw/native-operation-coordinate/v1") ||
bytes(base64urlDecode(manifestEntryDigest)) || str(nativeMethod) || str(nativeRouteSchemaId) ||
str(canonicalQuerySchemaId) || str(canonicalHeaderSchemaId) || str(canonicalBodySchemaId) ||
str(targetScope) || str(classification) || optionalStr(mutationFamily) || str(tuiPolicy) ||
optionalStr(workspaceTransitionKind)`.
`workspaceTransitionKind` is non-null exactly when the operation can change top-level workspace
identity, active selection, or discovery availability. A TUI `pass` operation has one concrete
transition kind; `first_bootstrap` is never a TUI kind. The server-creation `new_chat` operation uses
exactly `from_creation_intent`: its signed common payload/reservation maps `first_bootstrap` to
transition `first_bootstrap` and `new_chat` to transition `create`. Every other operation has null.
`NativeWorkspaceTransitionRecord` composite-foreign-keys its `operationEntryDigest` and actual
`transitionKind` through that closed rule. `source:"direct_tui"` requires all common result fields and
creation reservation null and a matching concrete TUI kind.
`source:"server_control"` requires the admitted-result/command/decision tuple and creation reservation
to match, plus the `from_creation_intent` operation. Missing/wrong kind, a fixed `create` substituted
for the discriminator, or an identity-changing route classified null rejects before the raw listener.
The manifest entry must exist exactly once in the pinned listener manifest, and every manifest entry
must have exactly one classification; this distinguishes an HTTP route from a raw/upgrade handler at
the same path. The `operationEntryDigest` is SHA-256 of
`str("remote-claw/native-operation-classification/v1") ||
bytes(base64urlDecode(operationCoordinateDigest)) ||
optionalDigest(familyCapabilityDigest)`. A family hashes only the
coordinate digest; the operation entry then hashes the completed family digest. Entries follow their
manifest positions, and the raw tuple `(manifestEntryDigest, method, route schema, query schema,
header schema, body schema, target scope)` is unique. Native fallback/API overlap is allowed only when
the manifest's measured transport, normalization, priority, registration-order, and fallback rules
select one deterministic entry; equal or ambiguous resolution is invalid. The vector digest is
SHA-256 of `str("remote-claw/native-operation-classification-vector/v1") || uint(count)` followed by
each `bytes(base64urlDecode(operationEntryDigest))` in that order. The pinned listener-route manifest
is the complete generated registry of routes callable through a remote-claw front door: the explicitly
exposed target-schema operations plus wrapper raw/catch-all/upgrade/fallback handlers. For OpenCode
the target schema is OpenAPI, but unexposed native routes need not be copied into the registry because
the private native listener has no other network path. Every manifest operation appears once, and
every table entry resolves to one manifest operation. Deletion, addition,
reclassification, or ambiguity changes the vector and holds startup non-writable.

Every digest in these formulas is canonical unpadded base64url decoding to exactly 32 bytes.
`optionalDigest(null)` is `0x00`; a present digest is
`0x01 || bytes(base64urlDecode(value))`. Padding, aliases, and wrong lengths fail snapshot validation.

Each listener manifest entry digest excludes its own digest field and is SHA-256 of
`str("remote-claw/native-listener-route-entry/v1") || str(frontDoorKind) ||
bytes(base64urlDecode(frontDoorListenerIdentityDigest)) ||
bytes(base64urlDecode(authorizationHandlerIdentityDigest)) || str(source) || str(transport) ||
str(nativeMethod) || str(canonicalPathTemplate) || str(routeParserSchemaId) ||
str(pathNormalizationSchemaId) || str(queryParserSchemaId) || str(headerParserSchemaId) ||
str(bodyParserSchemaId) || bytes(base64urlDecode(handlerIdentityDigest)) ||
uint(registrationOrder) || uint(matchPriority) || str(fallbackOnly ? "true" : "false")`. The manifest digest is
SHA-256 of:

```text
str("remote-claw/native-listener-route-manifest/v1")
str(descriptor.product)
str(descriptor.access)
str(engineVersion)
bytes(base64urlDecode(nativeBinaryDigest))
bytes(base64urlDecode(frontDoorBinaryDigest))
bytes(base64urlDecode(frontDoorBuildManifestDigest))
str(surfaceSchemaKind)
bytes(base64urlDecode(generatedSurfaceSchemaDigest))
bytes(base64urlDecode(buildRouteRegistryDigest))
str(routeResolutionSchemaId)
bytes(base64urlDecode(runtimeRegistrationAttestationDigest))
uint(orderedEntryDigests.length)
for digest in orderedEntryDigests:
  bytes(base64urlDecode(digest))
```

For selected A2, `routeResolutionSchemaId` is
`remote-claw/native-listener-route-resolution/v1`. After the pinned parsers canonicalize a request,
candidates must belong to the listener's exact `frontDoorKind` and identity and have the same
transport and exact method; method override is never applied. The authorization-handler identity is
part of every entry, so moving `/global/event`, `GET /session`, or `POST /session` between TUI,
observer, adapter, or creation audiences changes the manifest.
Non-fallback candidates precede fallback candidates, greater `matchPriority` precedes lower, and lower
`registrationOrder` precedes higher. A tie after those keys is invalid rather than broken by source
text or hash. An Upgrade request is considered only in the `websocket` transport set, so it cannot
fall through to an HTTP route. `orderedEntryDigests` is the resulting actual dispatch traversal order,
not lexical order.

The build registry is generated from the wrapper front-door registration DSL and compiled into the
front-door binary; startup instrumentation walks that same live registry and attests it contains
exactly the generated set—no hidden front-door route, catch-all, or upgrade and no missing handler. A
hand-maintained inventory or `/doc` scrape is insufficient. The private native destination is
reachable only from those generated handlers. Any exposed entry, parser, normalization rule,
authorization/target handler identity, pinned native binary/schema, registration, or ordering
difference changes the digest and prevents a capability snapshot from becoming current.

`frontDoorBuildManifestRef` retains the deterministic build's exact route-to-module/symbol/dependency
closure and recomputes `frontDoorBuildManifestDigest`; `frontDoorBinaryDigest` covers the executable
bundle that serves the sockets. For each entry:

```text
frontDoorListenerIdentityDigest =
  SHA256(str("remote-claw/front-door-listener-identity/v1") ||
         bytes(base64urlDecode(frontDoorBinaryDigest)) || str(frontDoorKind) ||
         bytes(canonicalListenerModuleSymbolAndDependencyClosure))

authorizationHandlerIdentityDigest =
  SHA256(str("remote-claw/front-door-authorization-handler/v1") ||
         bytes(base64urlDecode(frontDoorBinaryDigest)) || str(frontDoorKind) ||
         bytes(canonicalAuthorizationModuleSymbolAndDependencyClosure))

handlerIdentityDigest =
  SHA256(str("remote-claw/front-door-target-handler/v1") ||
         bytes(base64urlDecode(frontDoorBinaryDigest)) ||
         bytes(canonicalTargetHandlerModuleSymbolAndDependencyClosure))
```

The build manifest supplies those canonical bytes and the startup attestation binds both build and
binary digests. Labels, source paths, or function names without artifact/dependency bytes do not
qualify.

`orderedEntryVectorDigest` is SHA-256 of
`str("remote-claw/native-listener-entry-vector/v1") || uint(count)` followed by each canonical
32-byte-decoded `manifestEntryDigest` in the manifest order. `measuredDispatchTableDigest` is SHA-256
of `str("remote-claw/native-listener-measured-dispatch/v1") || uint(count)`, followed for each live
front-door registration—in actual dispatch traversal order—by the complete listener-entry preimage fields above,
including transport, parser/normalization/handler identity, registration order, priority, and fallback
flag. Startup retains that measured item vector, recomputes its entry digests, and requires exact
item-for-item and order equality with the build registry/manifest vector before signing; digest
comparison alone is not used to paper over a mismatch.

The runtime registration attestation is signed by the current runtime-owner key using its fenced
sequence ledger. Its cycle-free canonical payload is:

```text
str(canonicalPayloadSchemaId)
uint(schemaVersion)
str(runtimeId)
uint(nativeIncarnation)
str(descriptor.product)
str(descriptor.access)
str(engineVersion)
bytes(base64urlDecode(nativeBinaryDigest))
bytes(base64urlDecode(frontDoorBinaryDigest))
bytes(base64urlDecode(frontDoorBuildManifestDigest))
str(surfaceSchemaKind)
bytes(base64urlDecode(generatedSurfaceSchemaDigest))
bytes(base64urlDecode(buildRouteRegistryDigest))
str(routeResolutionSchemaId)
bytes(base64urlDecode(orderedEntryVectorDigest))
bytes(base64urlDecode(measuredDispatchTableDigest))
str(runtimeOwnerIdentityKeyId)
uint(runtimeOwnerKeyGeneration)
uint(signerSequence)
uint(issuedAtMs)
```

`canonicalPayloadDigest` and signature follow the common runtime-owner rules. The retained
`runtimeRegistrationAttestationRef` resolves to the complete immutable attestation.
`runtimeRegistrationAttestationDigest` is unpadded-base64url SHA-256 of
`str("remote-claw/native-listener-registration-signed-record/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || str(runtimeOwnerIdentityKeyId) ||
uint(runtimeOwnerKeyGeneration) || uint(signerSequence) || bytes(base64urlDecode(signature))`.
The signature verifies over the exact canonical payload under that named runtime-owner key, and the
ref, digest, signer reservation, and acceptance-ledger row must agree byte-for-byte. It does not include the
final manifest digest; the manifest includes this attestation digest, so there is no cycle. Startup
produces `measuredDispatchTableDigest` from the instrumented live front-door registry and requires it
to equal the build registry's expected ordered dispatch semantics before attesting.

The runtime-isolation attestation independently proves that only the four measured front doors can
reach the raw listener and that only the exact native OpenCode process can reach its provider façade.
`allowedRawListenerPeerVectorRef` retains exactly four `NativeRuntimeIsolationPeerItem` values in this
closed role order: TUI, binding adapter, server creation, observer. Each peer item hashes:

```text
str("remote-claw/native-runtime-isolation-peer/v1") || str(role) || uint(tgid) ||
bytes(base64urlDecode(pidfdIdentityDigest)) || uint(processStartTimeTicks) ||
bytes(base64urlDecode(cgroupIdentityDigest)) || bytes(base64urlDecode(executableImageDigest)) ||
bytes(base64urlDecode(frontDoorBinaryDigest)) ||
bytes(base64urlDecode(frontDoorBuildManifestDigest)) ||
bytes(base64urlDecode(runtimeRegistrationAttestationDigest)) ||
bytes(base64urlDecode(roleManifestEntryVectorDigest)) ||
bytes(base64urlDecode(authorizationHandlerVectorDigest))
```

Each peer's two refs are typed, exhaustive vectors rather than opaque evidence. The role-manifest ref
contains one `NativeRuntimeIsolationRoleManifestItem` for every manifest entry owned by that role,
ordered by `manifestPosition`; each item digest is SHA-256 of
`str(canonicalItemSchemaId) || uint(schemaVersion) || str(role) || uint(manifestPosition) ||
bytes(base64urlDecode(manifestEntryDigest)) || bytes(base64urlDecode(operationEntryDigest)) ||
bytes(base64urlDecode(handlerIdentityDigest))`. Its vector digest is SHA-256 of
`str("remote-claw/native-runtime-isolation-role-manifest-vector/v1") || str(role) || uint(count)`
followed by every decoded item digest. The authorization ref has the identical entry set and order.
Each `NativeRuntimeIsolationAuthorizationHandlerItem` digest is SHA-256 of
`str(canonicalItemSchemaId) || uint(schemaVersion) || str(role) || uint(manifestPosition) ||
bytes(base64urlDecode(operationEntryDigest)) ||
bytes(base64urlDecode(authorizationHandlerDigest)) ||
bytes(base64urlDecode(authorizationPolicyDigest))`; its vector uses
`remote-claw/native-runtime-isolation-authorization-handler-vector/v1`, the role, count, and decoded
item digests.

The two vectors must have exactly the same `(role,manifestPosition,operationEntryDigest)` keys. Every
manifest item must resolve to that position and handler in the current listener manifest and
registration attestation; every authorization item must resolve to the one installed audience- and
operation-specific authorization handler. Missing, duplicate, reordered, cross-role, additional, or
same-digest/different-ref content invalidates the peer and therefore the whole isolation attestation.

The vector digest is SHA-256 of
`str("remote-claw/native-runtime-isolation-peer-vector/v1") || uint(4)` followed by each decoded
item digest. A missing, duplicate, reordered, or additional peer invalidates the attestation. PID reuse
does not compare equal because pidfd identity and process start time are both committed.

`providerFacadeAllowedProcessRef` retains exactly one
`NativeRuntimeIsolationProviderPeer`. Its canonical peer digest is SHA-256 of:

```text
str(canonicalPeerSchemaId) || uint(schemaVersion) || str(runtimeId) ||
uint(nativeIncarnation) || uint(tgid) || bytes(base64urlDecode(pidfdIdentityDigest)) ||
uint(processStartTimeTicks) || bytes(base64urlDecode(cgroupIdentityDigest)) ||
bytes(base64urlDecode(executableImageDigest)) ||
bytes(base64urlDecode(providerFacadeSocketIdentityDigest)) ||
bytes(base64urlDecode(providerFacadePolicyMapEntryDigest)) ||
bytes(base64urlDecode(descendantDenialPolicyDigest))
```

The runtime/incarnation and façade socket digest must equal the enclosing attestation. The TGID,
pidfd/start identity, cgroup, executable, exact installed façade-policy map entry, and descendant
denial are all live-revalidated; no same-UID, child, or PID-reused process compares equal.
`providerFacadeAllowedProcessDigest` equals that recomputed peer digest, and
`providerFacadeExactProcessPolicyDigest` is SHA-256 of
`str("remote-claw/provider-facade-exact-process-policy/v1") ||
bytes(base64urlDecode(providerFacadeSocketIdentityDigest)) ||
bytes(base64urlDecode(providerFacadeAllowedProcessDigest)) ||
bytes(base64urlDecode(installedPolicyMapDigest)) ||
bytes(base64urlDecode(descendantDenialPolicyDigest))`. The policy ref must recompute that value and
name the same exact installed map entry; an opaque evidence digest cannot substitute for the typed
peer.

The isolation attestation's canonical payload is:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) ||
str(runtimeIsolationAttestationId) || str(runtimeId) || uint(nativeIncarnation) ||
str(descriptor.product) || str(descriptor.access) ||
bytes(base64urlDecode(rawListenerSocketIdentityDigest)) || uint(rawListenerSocketInode) ||
bytes(base64urlDecode(allowedRawListenerPeerVectorDigest)) ||
str(processIdentityPolicySchemaId) ||
bytes(base64urlDecode(attachBeforeRunProgramDigest)) ||
bytes(base64urlDecode(installedPolicyMapDigest)) ||
bytes(base64urlDecode(descendantDenialPolicyDigest)) ||
bytes(base64urlDecode(toolNamespacePolicyDigest)) ||
bytes(base64urlDecode(providerFacadeSocketIdentityDigest)) ||
bytes(base64urlDecode(providerFacadeAllowedProcessDigest)) ||
bytes(base64urlDecode(providerFacadeExactProcessPolicyDigest)) ||
bytes(base64urlDecode(networkNamespaceDigest)) ||
bytes(base64urlDecode(mountNamespaceDigest)) ||
str(runtimeOwnerIdentityKeyId) || uint(runtimeOwnerKeyGeneration) ||
uint(signerSequence) || uint(issuedAtMs)
```

`canonicalPayloadDigest` is SHA-256 of those bytes. The current runtime-owner key signs the exact
bound payload through a `purpose:"runtime_isolation_attestation"` reservation. `signedRecordDigest` is
SHA-256 of
`str("remote-claw/native-runtime-isolation-signed-record/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || str(runtimeOwnerIdentityKeyId) ||
uint(runtimeOwnerKeyGeneration) || uint(signerSequence) || bytes(base64urlDecode(signature))`.
The reservation and `RuntimeOwnerSignedRecordAcceptanceRecord` must agree before installation.

The socket, process-policy, tool-namespace, provider-peer, and provider-façade evidence refs retain the
measured installed socket identity/inode, program and policy-map bytes, exact process/pidfd/start-time
identities, `/proc`/LSM executable image, per-role manifest/authorization entry vectors,
descendant-denial result, namespace mounts/routes/fd table, and façade listener/rule.
Startup recomputes every paired digest from those refs and requires the installed kernel policy map to
equal the attested map item-for-item before any inner or front-door process runs. The raw listener
allows exactly the four attested TGIDs; the OpenCode server, TUI, and all tool descendants are absent
from that map. The provider-façade rule allows exactly the attested OpenCode server process and denies
every descendant and PID reuse.

Every current OpenCode server/binding capability, TUI policy, and observer lease must carry the same
attestation ref/digest and composite-foreign-key its runtime/incarnation. Their proof tuples include
that signed digest. A ref that parses to different bytes, changed listener inode, peer, pidfd/start
time, program/map, network/mount namespace, tool rule, or façade rule revokes those pointers and keeps
the tuple non-writable. The last-hop front doors revalidate the still-live exact process/socket
identities; a signature is not permission to keep using a dead or replaced TGID.
Each peer's binary/build/registration digests must equal the current listener manifest and its
role-specific entry/authorization vectors. An `exec` under the same TGID changes executable evidence
and revokes readiness before another request can reach the raw socket.

The measured front-door table is sealed for that native incarnation before readiness. The runtime
owner interposes every later wrapper route, middleware, plugin, config, upgrade, and fallback
registration; before a changed handler can serve, it atomically revokes current server/binding
capabilities, observer lease, and TUI policy, marks bindings non-writable, and advances or quarantines
the incarnation for a new measurement. A front door that can mutate dispatch without this
interposition is unsupported. A hidden native handler discovered later remains unreachable; exposing
it requires a generated manifest entry, total classification, proof, and new policy generation.

`NativeDeliveryAttemptRecord` is the concrete write-ahead boundary between common adjudication and an
engine adapter. There is exactly one immutable row per
`(commandId, nativeBindingId, nativeIncarnation)`, and its ID is exactly:

```text
nativeDeliveryAttemptId =
  "nat_" || base64url(SHA256(
    str("remote-claw/native-delivery-attempt-id/v1") ||
    str(commandId) || str(nativeBindingId) || uint(nativeIncarnation)))
```

The hash suffix is canonical unpadded base64url SHA-256. A second random or differently derived
attempt for that tuple is forbidden. The row pins the complete server/chat scope,
attachment lease, capability snapshot, typed mutation family, engine-native action ID such as
OpenCode's caller `msg_*`, exact native target-path digest, canonical request digest, expected native
part count, per-part fingerprint vector, and an immutable credential-stripped reference to the exact
target/body bytes. Recovery and the front door send those retained bytes; they never reconstruct a
request from a newer adapter. OpenCode `user_text` requires a non-null caller `msg_*`;
ID-only read-back is insufficient because the pinned server can append another part under the same ID.
Every non-null native action ID is unique on
`(nativeBindingId, nativeIncarnation, nativeActionId)`; a second command that tries to reuse one is a
collision before dispatch.
A delivery attempt and its command-wide gate each composite-foreign-key
`(collaborationServerId,commandId,admittingCommandResultId,canonicalCommandRecordDigest,
admittingCommandResultSignedRecordDigest)` to the one immutable
`CollaborationCommandResultRecord(disposition:"admitted")`. Their decision-evidence schema/digest must
equal the command record. A `decision_reserved`, unsigned, queued, rejected, different-command, or
different-result row cannot create either record. The gate's `startedAttemptId` must point to an
attempt carrying that identical whole authorization tuple. The same rule applies to native creation,
nested creation, and nested chat delivery attempts/effect gates; their executor-specific composite
foreign keys additionally equal the selected executor-evidence arm. Thus signed admission is necessary
but cannot be transplanted to another executor.
A compare-and-swap claims a `prepared` attempt for one current coordinator epoch by moving it to
`claimed`; claiming alone grants no permission to send. The final transaction described below
advances it to `started` before the first byte that might mutate the native engine.
A transport receipt advances only `transport_receipt`. Only exact native read-back under the pinned
fingerprint schema advances `native_observed`/`completed`. A proved negative result after `started`
can become `rejected`: it retains the non-null claiming coordinator epoch and complete outcome
evidence, never positive native read-back evidence, and may retain a transport receipt when one
preceded the negative result. After `started`, ambiguity becomes `outcome_unknown` and quarantines
later remote writes. Neither coordinator replacement nor stored-result replay may allocate or send a
second attempt.

A1.0 implements this derived-ID function and verifier. Stored-row uniqueness, immutable request
retention, state transitions, and one-time dispatch remain A1.8 work.

The command-wide `NativeCommandEffectGateRecord` prevents a native replacement from becoming a retry
loophole. The only final pre-write transaction locks the attempt, its unique dispatch row, and the
unique command gate together. It requires attempt `claimed` by the current coordinator epoch,
dispatch `not_started` with null start/receipt/outcome fields, gate
`(never_started,null)` with null outcome fields, no abandonment record, and the entire current
executor/translation/protected-authorization-reference join. In one commit it moves the attempt to `started`, the dispatch to
`started` with its one start time, and the gate to `(started,nativeDeliveryAttemptId)`. Only after that
commit may the first socket byte be written. No other path may start any of the three rows.

A prepared attempt stranded by a crash is different from an attempt explicitly abandoned by a
runtime-local operator request or deliberate shutdown policy:

- Crash recovery may resume only the same immutable attempt, retained request, and one-time dispatch
  authorization. It requires no committed `NativeBindingPreSendAbandonmentRecord`; attempt state
  `prepared` or `claimed`; dispatch state `not_started` with null `dispatchStartedAtMs`,
  `nativeReceiptRef`, and all three outcome-evidence fields; gate state `never_started` with null
  `startedAttemptId` and all three outcome-evidence fields; no transport receipt, native read-back, or
  outcome evidence on the attempt; and the exact signed
  runtime/incarnation/attachment/ingress/capability executor still current.
  Coordinator fencing may transfer ownership of that row, but it does not allocate a new attempt,
  request, action ID, protected reference, or authorization.
- Explicit pre-send abandonment is one runtime-owner journal transaction. It locks the attempt,
  dispatch, and command gate; rechecks all of the crash-recovery preconditions above; requires the
  attempt's unique dispatch row's exact current `canonicalDispatchDigest` and protected authorization
  reference; allocates one
  journal sequence; and inserts one `NativeBindingPreSendAbandonmentRecord`. In that same commit it
  moves the attempt, dispatch, and gate to `quarantined`; leaves `dispatchStartedAtMs`,
  `nativeReceiptRef`, `startedAttemptId`, transport receipt, and native read-back null; sets all three
  `outcomeEvidenceSchemaId` fields to
  `remote-claw/native-binding-pre-send-abandonment/v1`; sets all three `outcomeEvidenceRef` fields to
  the exact `nativePreSendAbandonmentId`; and sets all three `outcomeEvidenceDigest` fields to its
  `canonicalEvidenceDigest`. Before the transaction, each schema/ref/digest triple must be all null;
  afterward, each is that exact all-non-null triple. The dispatch row's protected reference remains
  immutable, while the protected owner revokes its one-use authorization; the front door also accepts
  only `not_started`.

`explicit_runtime_shutdown` means a deliberate, configured cancellation decision committed before
shutdown. A disconnect, process death, signal, ordinary graceful restart, or missing record never
implies abandonment; it leaves the crash-recovery branch above. The quarantine closes this command's
attempt/dispatch/gate, not the whole binding, so a distinct newly authenticated source event may later
be adjudicated normally while the binding remains otherwise current. `abandonmentReason` is the
trusted runtime's local classification of why it committed this transaction; it does not by itself
attest a human operator identity.

The dispatch CAS and abandonment transaction serialize on these same three rows. If dispatch wins,
the abandonment preconditions fail without changing any state; if abandonment wins, the front-door
state check fails before a socket write. A stale precheck cannot commit either transition.

The abandonment record is unique by both `nativePreSendAbandonmentId` and
`nativeDeliveryAttemptId`. Its ID and protected-authorization-reference digest are:

```text
nativePreSendAbandonmentId =
  "npa_" || base64url(SHA256(
    str("remote-claw/native-binding-pre-send-abandonment-id/v1") ||
    str(commandId) || str(nativeDeliveryAttemptId)))

dispatchAuthorizationRefDigest =
  SHA256(str("remote-claw/native-front-door-dispatch-authorization-ref/v1") ||
         str(nativeDeliveryAttemptId) || str(protectedHandleId) ||
         str("dispatch_authorization"))
```

The ID's hash suffix and the protected-reference digest are encoded as canonical unpadded base64url
SHA-256. Its
`canonicalEvidenceDigest` is unpadded-base64url SHA-256 of:

```text
str(canonicalEvidenceSchemaId) || uint(schemaVersion) ||
str(nativePreSendAbandonmentId) || str(commandId) ||
str(admittingCommandResultId) ||
bytes(base64urlDecode(admittingCommandResultSignedRecordDigest)) ||
bytes(base64urlDecode(canonicalCommandRecordDigest)) ||
str(decisionEvidenceSchemaId) || bytes(base64urlDecode(decisionEvidenceDigest)) ||
str(collaborationServerId) || str(logicalChatId) || str(nativeBindingId) ||
str(runtimeId) || uint(nativeIncarnation) || str(nativeDeliveryAttemptId) ||
bytes(base64urlDecode(canonicalDispatchDigest)) ||
bytes(base64urlDecode(dispatchAuthorizationRefDigest)) ||
str(attemptStateBefore) || str(dispatchStateBefore) || str(gateStateBefore) ||
str(abandonmentReason) || uint(abandonedAtJournalSeq) || str(assertion)
```

Verification resolves the retained attempt, dispatch, gate, admitted result, command, and decision;
recomputes every digest including the opaque protected dispatch reference; and requires every coordinate to
match the rows changed by that one journal commit. This local atomic fact is not a signed portable
positive-never-started attestation. Exact replay looks up the unique attempt/abandonment row before
allocating a journal sequence and returns the one existing record. A changed reason, coordinate, or
digest is a collision; substituting a different retained journal sequence is record equivocation. A
crash exposes either all three quarantined rows and the record or none of them. Quarantine is terminal
for that command: it cannot be reopened, and no replacement attempt, native-executor continuation, or
successor may be created. A new incarnation, attachment, ingress lease, or snapshot never replaces the
signed executor for that command.

Every terminal-native `NativeMutationFamilyCapability`, binding-scoped or server-scoped, has
`positiveNeverStartedSchemaId == null`; selected A2 OpenCode `user_text` is no exception. Only the
nested transport capability types use their separately signed positive-never-started attestation to
install a continuation.
Once any terminal native attempt reached `started`, no successor attempt may start even if later
evidence proves no effect; the old command closes without an effect and a fresh authenticated source
event/common command is required. Lost response/history or `outcome_unknown` remains quarantined.

`nativeTargetPathDigest` is unpadded-base64url SHA-256 of:

```text
str("remote-claw/native-target-path/v1")
str(descriptor.product)
str(descriptor.access)
str(runtimeId)
uint(nativeIncarnation)
str(nativeBindingId)
str(nativeConversationId)
str(nativeWorkspaceBindingId)
bytes(base64urlDecode(canonicalDirectoryPathDigest))
bytes(base64urlDecode(nativeWorkspaceBindingDigest))
str(attachmentLeaseId)
str(nativeClientIngressLeaseId)
str(nativeMethod)
str(nativeRouteSchemaId)
bytes(canonicalRouteParameterBytes)
optionalStr(nativeActionId)
```

`canonicalRouteParameterBytes` comes from the pinned route schema and exact retained request; for
OpenCode it includes the target `ses_*`, subresource kind/ID, parent/child coordinate where applicable,
the exact resolved workspace/directory binding, and no query/header alias normalization. OpenCode
`workspace`, `directory`, and `x-opencode-directory` spellings must resolve to one identical pinned
value; missing required scope or multiple/conflicting aliases reject before dispatch. The front door
recomputes this digest from the retained exact
method/path parameters before its dispatch CAS. A valid credential with a changed session, permission,
child, method, or native action ID collides before a socket write.

`canonicalRequestDigest` is unpadded-base64url SHA-256 of
`str("remote-claw/native-request/v1") || str(canonicalRequestSchemaId) ||
bytes(canonicalCredentialStrippedRequestBytes)`. The pinned schema emits, in order, the exact method,
canonical route parameters, content type, semantics-relevant headers as an ordered name/value vector,
and exact body bytes; hop-by-hop headers and the front-door credential are excluded. The immutable
`canonicalRequestRef` retains those canonical bytes. The dispatcher recomputes both request and target
digests from that reference before its one-time CAS; a mismatch is a collision, never a reconstructed
send.

The common-to-native translation is itself retained. The two selected OpenCode generated-coordinate
payloads are:

```text
user_text =
  str("remote-claw/opencode-user-text-generated-coordinates/v1") || uint(1) ||
  str(nativeBindingId) || str(nativeConversationId) || str(nativeWorkspaceBindingId) ||
  str(canonicalDirectory) || bytes(base64urlDecode(canonicalDirectoryPathDigest)) ||
  bytes(base64urlDecode(nativeWorkspaceBindingDigest)) ||
  str(nativeActionId)

new_chat =
  str("remote-claw/opencode-new-chat-generated-coordinates/v1") || uint(1) ||
  str(runtimeId) || uint(nativeIncarnation) || str(nativeWorkspaceBindingId) ||
  str(canonicalDirectory) || bytes(base64urlDecode(canonicalDirectoryPathDigest)) ||
  bytes(base64urlDecode(nativeWorkspaceBindingDigest)) ||
  str(nativeCreationMarker) ||
  bytes(base64urlDecode(nativeCreationIntentDigest))
```

`canonicalDirectory` is the exact safe path decoded from the retained
`NativeWorkspaceBindingRecord.canonicalDirectoryRef`, and
`canonicalDirectoryPathDigest = SHA256(str("remote-claw/canonical-directory-path/v1") ||
str(canonicalDirectory))`. The header carries those exact path bytes. The workspace record,
executor evidence, ingress/server front-door lease, generated coordinates, and target-path digest
also repeat `nativeWorkspaceBindingDigest`; all refs and both digests must join the one current
workspace record. A same path under a changed filesystem, mount, allowed root, or generation is
therefore a different binding even though its path digest is unchanged.
The generated-coordinate digest is SHA-256 of the selected bytes. For `descriptor.product:"opencode"`
only those two schema IDs are valid in selected A2; another family or coordinate schema is rejected.
The full translation record bytes are:

```text
str(nativeRequestTranslationSchemaId) || uint(schemaVersion) ||
str(commandId) || str(admittingCommandResultId) ||
bytes(base64urlDecode(admittingCommandResultSignedRecordDigest)) ||
bytes(base64urlDecode(canonicalCommandRecordDigest)) ||
bytes(base64urlDecode(decisionEvidenceDigest)) ||
bytes(base64urlDecode(capabilitySnapshotAttestationDigest)) ||
str(canonicalCommandPayloadSchemaId) ||
bytes(base64urlDecode(canonicalCommandPayloadDigest)) ||
bytes(base64urlDecode(nativeRequestTranslatorDigest)) ||
str(generatedCoordinateSchemaId) || bytes(base64urlDecode(generatedCoordinateDigest)) ||
str(canonicalRequestSchemaId) || bytes(base64urlDecode(canonicalRequestDigest)) ||
bytes(base64urlDecode(nativeTargetPathDigest))
```

`nativeRequestTranslationDigest` is SHA-256 of those bytes and its ref retains the parsed record.
The translator receives only the immutable common payload bytes and the exact generated-coordinate
bytes. It receives no adapter defaults, environment, current model, later capability, or reconstructed
chat state.

For selected OpenCode `user_text`, the output is exactly method `POST`, route
`/session/{nativeConversationId}/prompt_async`, empty query, and the canonical request schema
`remote-claw/opencode-prompt-async-request/v1`. Its semantics-relevant header vector contains exactly
`content-type: application/json` then
`x-opencode-directory: <the UTF-8 canonical directory bytes>`; the dispatch credential is excluded.
The compact UTF-8 JSON body has keys in exactly this order:
`{"messageID":"<nativeActionId>","parts":[{"type":"text","text":"<text>"}]}` using the strict canonical
JSON string encoder; the quoted placeholders denote the generated string contents after that encoder.
`text` is decoded directly from the common `user_text` payload. `model`, `noReply`,
agent/system fields, extra keys, extra/reordered parts, and every other header/query alias are
forbidden. The native session's brokered provider path chooses its normal configured model; the
collaboration adapter cannot override it.
Selected A2 accepts a workspace directory only when its canonical filesystem path is an absolute
POSIX path whose UTF-8 bytes match `^/[A-Za-z0-9._~/-]*$` after symlink/filesystem-identity resolution.
Empty components other than the leading slash, `.`/`..`, percent, backslash, space, colon, non-ASCII,
non-UTF-8 filesystem bytes, NUL, CR/LF, and every C0/DEL byte are unsupported rather than encoded into
a header. The `x-opencode-directory` value is that exact byte string with no trimming, percent/base64
alias, or alternate header. This intentionally narrow grammar makes header injection and cross-runtime
path encoding impossible; expanding it requires a new request schema and proof.

The strict JSON string encoder emits Unicode scalar input as UTF-8 between quotes. It escapes quote as
`\"`, backslash as `\\`, and every U+0000–U+001F scalar as six lowercase bytes `\u00xx`; slash,
U+007F, all other non-ASCII scalars, U+2028, and U+2029 are emitted literally. Lone surrogates,
overlong/invalid UTF-8, alternate escapes, and normalization are rejected. The literal object keys and
punctuation above are never reserialized by a generic map encoder.

The runtime owner allocates `nativeActionId` before translation as `msg_` plus unpadded base64url of
16 random bytes. It atomically persists the ID and unique
`(nativeBindingId,nativeIncarnation,nativeActionId)` index with the attempt preparation; no web,
official, automation, nested, or inner-model caller may provide it. A crash reuses only that stored ID.
Malformed IDs, RNG/allocation failure, duplicate/reused IDs, or an ID found already in native history
reject before request construction and never fall back to text matching.

For selected OpenCode `new_chat`, the output is exactly method `POST`, route `/session`, empty query,
the same two-header vector, and canonical request schema
`remote-claw/opencode-session-create-request/v1`. Its compact body is exactly:

```json
{"metadata":{"remoteClawCreationId":"<nativeCreationMarker>","remoteClawCreationIntentDigest":"<nativeCreationIntentDigest>"}}
```

The two nested keys have that order. The marker is generated once from the creation reservation; the common payload supplies and
commits `creationIntent`, `projectId`, and `workspaceSelectorId`. No title, session ID, directory
alias, model, provider, parent, or extra metadata key is allowed. The translator proof covers both
output shapes and the caller-ID/marker generation rules. The selected server-family
`positiveReadBackSchemaId` and the creation reservation both equal
`remote-claw/opencode-new-chat-marker-reconciliation/v1`; another marker/discovery interpretation
cannot bind the returned session.

Selected OpenCode `user_text` also fixes its native read-back oracle. The one expected part
fingerprint is:

```text
SHA256(str("remote-claw/opencode-expected-user-part/v1") ||
       str(nativeConversationId) || str(nativeActionId) || uint(0) ||
       str("user") || str("text") || str(text))
```

The expected vector digest is SHA-256 of
`str("remote-claw/opencode-expected-user-part-vector/v1") || uint(1) ||
bytes(base64urlDecode(expectedPartFingerprintDigest))`. The attempt stores that exact vector ref and
digest with count one before dispatch. The body text and action/session IDs must recompute it from the
translation record.

Each observed read-back part hashes:

```text
str("remote-claw/opencode-observed-user-part/v1") ||
str(nativeConversationId) || str(nativeActionId) || str(nativePartId) ||
uint(nativePartIndex) || str(role) || str(partType) ||
bytes(base64urlDecode(canonicalTextDigest)) ||
bytes(base64urlDecode(expectedPartFingerprintDigest)) ||
bytes(base64urlDecode(historySnapshotDigest)) ||
optionalDigest(filteredSseObservationDigest) ||
bytes(base64urlDecode(nativeOrderCoordinateDigest))
```

`observedPartFingerprintDigest` is SHA-256 of those bytes. The observed vector is ordered by exact
native part index, then native part ID, and hashes the count plus each decoded item digest under
`remote-claw/opencode-observed-user-part-vector/v1`; duplicates, reordering, or gaps are invalid. The
optional SSE ref resolves one `NativeFilteredObserverObservationRecord` for the same
runtime/incarnation/binding/session/action/part coordinate and recomputes its filtered digest. The
history snapshot ref resolves the complete
`OpenCodeConversationHistorySnapshotRecord`, whose part vector contains the same item.

The history/read-back join is typed rather than text-matched. For selected A2 text parts,
`OpenCodeHistoryPartItem.canonicalPartPayloadSchemaId` is exactly
`remote-claw/opencode-history-text-part/v1`, and the retained payload is:

```text
str(canonicalPartPayloadSchemaId) || uint(1) ||
str(nativeConversationId) || str(nativeMessageId) || str(nativePartId) ||
uint(messageIndex) || uint(partIndex) || str("text") || str(text)
```

Its SHA-256 is `canonicalPartPayloadDigest`. The joined history message must have the same
conversation and message index, `nativeMessageId == nativeActionId`, and `role:"user"`. The joined
history part must have the same conversation/message ID, message index, native part ID, and part
index as the read-back item. Parsing the exact retained part payload supplies `text`; the read-back
item's `canonicalTextRef` retains `str(text)` and
`canonicalTextDigest = SHA256(str("remote-claw/opencode-canonical-text/v1") || str(text))`.
`nativePartIndex == partIndex`, and the expected fingerprint is recomputed from that extracted text,
not accepted from the SSE event or a caller. A role, ID, index, schema, retained-payload, or extracted
text mismatch cannot join.

The raw history projection is exhaustive, not caller-selected. Starting from the complete history
snapshot's ordered message/part refs, the verifier selects the unique message with
`nativeConversationId` equal to the attempt and `nativeMessageId == nativeActionId`, then selects
**every** `OpenCodeHistoryPartItem` whose conversation/message ID names that message. It hashes
`str("remote-claw/opencode-same-message-history-part-vector/v1") || uint(count)` followed by every
selected decoded history-part item digest in `(messageIndex,partIndex,nativePartId)` order.
`sameMessageHistoryPartCount` and `sameMessageHistoryPartVectorDigest` must equal that complete
projection before any filtering by type, text, fingerprint, SSE presence, or index.

Only when that raw projection contains exactly one part, the joined message has role `user`, and the
sole part parses as the exact index-zero text schema above does the verifier construct the one typed
`OpenCodeNativeReadBackPartItem`; `observedPartVectorRef` then contains exactly that one item. Its
`expectedPartFingerprintDigest` equals the attempt's one expected-vector item. Its separately
domain-separated `observedPartFingerprintDigest` is recomputed from the observed typed fields and is
not compared byte-for-byte to the expected digest; positive adjudication instead requires equality of
the canonical session/action/index/role/type/text values from which the two domain-separated digests
are recomputed. For `mismatch` or `ambiguous`, the typed observed vector is canonically empty and the
stored `observedPartCount` is zero. For `exactly_one_applied`, both are exactly one. The
complete raw projection remains committed by the history snapshot plus the two same-message fields.
A second same-ID part, non-text sole part, duplicate/gapped index, omitted history item, or fabricated
typed item therefore cannot be hidden by presenting a one-item observed vector.

`OpenCodeNativeOrderEvidence.nativeOrderEvidenceDigest` is SHA-256 of:

```text
str(canonicalOrderEvidenceSchemaId) || uint(schemaVersion) ||
str(nativeHistorySnapshotId) || bytes(base64urlDecode(historySnapshotDigest)) ||
str(nativeMessageId) || uint(messageIndex) || str(nativePartId) || uint(partIndex) ||
str(linearizationProofKind) || bytes(base64urlDecode(linearizationProofDigest)) ||
optionalUint(linearizedThroughObservationSeq) ||
optionalDigest(filteredSseObservationDigest)
```

The order evidence ref retains those fields and `nativeOrderCoordinateDigest` equals this digest.
`linearizedThroughObservationSeq` equals the complete history snapshot's field, and the read-back
record's `throughObservationSeq` must equal both. For `sequence_watermark` it is the non-null observer
sequence named by the shared native watermark. For `barrier_event` it equals the non-null
`postSnapshotBarrierObservationSeq`; the filtered part observation is required, belongs to the same
stream epoch and overlap buffer, has sequence no greater than that barrier, and resolves the exact
joined IDs above. For `atomic_store_snapshot` it is null because the signed store transaction boundary,
not an SSE cursor, linearizes the retained history. Thus a complete sequence-watermark or atomic-store
history snapshot remains positive evidence after reconnect even when legacy SSE cannot replay. The
filtered SSE digest is null outside `barrier_event`; an arbitrary stale/live event cannot be appended
as support.

The
read-back evidence's `canonicalEvidenceDigest` is SHA-256 of:

```text
str(nativeReadBackSchemaId) || uint(schemaVersion) || str(nativeReadBackEvidenceId) ||
str(nativeDeliveryAttemptId) || str(runtimeId) || uint(nativeIncarnation) ||
str(nativeBindingId) || str(nativeConversationId) || str(nativeWorkspaceBindingId) ||
str(nativeRuntimeObserverLeaseId) || uint(observerGeneration) || str(nativeActionId) ||
str(nativeHistorySnapshotId) || bytes(base64urlDecode(historySnapshotDigest)) ||
str(observerStreamEpochId) ||
optionalUint(throughObservationSeq) ||
bytes(base64urlDecode(sameMessageHistoryPartVectorDigest)) || uint(sameMessageHistoryPartCount) ||
bytes(base64urlDecode(observedPartVectorDigest)) ||
uint(observedPartCount) || bytes(base64urlDecode(expectedPartFingerprintVectorDigest)) ||
optionalDigest(nativeOrderEvidenceDigest) || str(outcome)
```

For selected OpenCode `user_text`, the capability and attempt `positiveReadBackSchemaId` and the
evidence `nativeReadBackSchemaId` are all exactly
`remote-claw/opencode-user-text-read-back/v1`; the attempt's
`expectedNativePartFingerprintSchemaId` is exactly
`remote-claw/opencode-expected-user-part-vector/v1`, and the capability's
`positiveNeverStartedSchemaId` is null. The evidence's expected-vector digest must equal
the attempt's retained vector digest and the vector must parse under that exact schema. Only
`outcome:"exactly_one_applied"`, count one, index zero, role `user`, type `text`, exact extracted text,
exact caller `msg_*`, same runtime/incarnation/session, one complete history snapshot, the exact
linearization sequence rules above, and valid native order evidence may compare-and-swap the attempt
from `transport_receipt` or `started` to
`native_observed`, then `completed`. The evidence ref must parse and recompute its digest. Missing,
extra, reordered, changed, cross-session, cross-incarnation, incomplete/unlinearized history, SSE-only, or ambiguous
evidence records `outcome:"mismatch"` or `"ambiguous"` and moves a possibly started attempt/gate to
`outcome_unknown`, quarantining later remote writes;
it never triggers another `prompt_async`.

`exactly_one_applied` requires both order-evidence fields non-null. `mismatch` and `ambiguous` require
both null because their typed observed vector is empty; their complete history snapshot and raw
same-message projection retain the negative/ambiguous evidence without inventing one privileged part
coordinate.

The evidence's `historySnapshotRef` always resolves its one exact complete history snapshot. Its
runtime, incarnation, binding, session, and `observerStreamEpochId` equal the read-back record; its
workspace and observer lease/generation equal the record and the retained attempt's current
workspace/observer coordinates. For a positive result, the order evidence's history ID/digest and linearization fields
equal that same snapshot. For `barrier_event`, the order evidence's
`filteredSseObservationDigest` and the sole typed part item's filtered-observation digest must be the
same filtered observation in that snapshot's stream epoch and overlap buffer. Mixed snapshots,
leases, generations, or stream epochs are invalid even when their message and part IDs happen to
match.

The runtime-owned front door has a second, last-hop one-time boundary:
`NativeFrontDoorDispatchRecord` is unique by `nativeDeliveryAttemptId` and immutably binds the admitted
ingress lease, target path, request digest, and opaque reference to a one-use dispatch authorization.
The durable row never contains the authorization itself. The front door does not accept arbitrary
traffic from a current adapter credential: it presents that reference to the protected owner for the
exact attempt and revalidates the current admitted-result tuple, decision/executor evidence,
command/effect gate, pinned family/translator entry, capability/attachment/ingress leases, method,
route, path, request and translation digests, recomputes the translation from the retained common
payload plus generated coordinates, and runs the one three-row final pre-write transaction above:
attempt `claimed → started`, dispatch `not_started → started`, and gate
`(never_started,null) → (started,nativeDeliveryAttemptId)` atomically, while requiring no abandonment
record. A repeated valid request returns the stored dispatch classification and never forwards again;
a changed path or body is a collision. Crash after that transaction and before/after the write is
therefore `outcome_unknown` until exact native read-back resolves it, not permission to dispatch
twice.
Its immutable digest is SHA-256 of
`str("remote-claw/native-front-door-dispatch/v1") || str(nativeDeliveryAttemptId) ||
str(nativeClientIngressLeaseId) || bytes(base64urlDecode(nativeTargetPathDigest)) ||
bytes(base64urlDecode(canonicalRequestDigest)) ||
bytes(base64urlDecode(nativeRequestTranslationDigest)) ||
str(dispatchAuthorizationRef.protectedHandleId) || str(dispatchAuthorizationRef.kind)`.
A1.0 implements this digest and verifies it against the strict dispatch row; it does not create,
store, arm, consume, or send that row.
The runtime owner allocates an `rcph_*` dispatch-authorization reference and its protected 32 random
bytes in the same transaction as the dispatch row. The durable row stores only the reference; the raw
authorization is globally unique across binding and creation dispatches, never caller-chosen or
reassigned, and never exposed in argv, environment, files readable by the inner process, or logs.
After a crash, the coordinator reconstructs the same stable authorization identity from the
still-`not_started` row, attempt join, and reference, then supplies its own current caller fence; it
does not look up or copy out the raw value. The final owner transaction validates that current fence,
consumes the reference, marks all three native-effect rows started, and returns the raw authorization
only to the in-process adapter. A stale fence, reference/digest transplant, or collision fails before
that CAS.

For Codex, each managed top-level chat-thread binding has its own logical attachment and lease, but all
of those attachments reference the same daemon-wide physical app-server connection through one shared
`transportId`. Closing such a binding closes its subscription/lease, not that shared connection. A
child thread stays nested evidence under its classified parent until a retained lineage fixture proves
another user-visible mapping.

`LocalNativeConversationRecord` and its transition log belong to that runtime owner, not to a
collaboration server, but every such record names one already durable `projectId`. A1.3 freezes and
validates this repository model; its production activation is health-only and creates no local
conversation records. Once a later owner-dispatch milestone admits these operations, the owner may
allocate a local record before the native semantic ID is known, then bind exact native evidence later.
That future dispatch surface lets a direct TUI create, clear, fork, switch, archive, or use a
conversation while every collaboration coordinator is unavailable after that project exists. The
runtime owner cannot allocate the first project or invent one from a directory; first-project and later
explicit-project allocation remain coordinator-owned. A local record grants no remote authority and
cannot allocate or repoint a `logicalChatId`; only the coordinator's later
`LocalNativeConversationMappingRecord` does that.

A1.9 inference delivery has its own target write-ahead boundary. Before an isolated connector can send
a provider request, the runtime owner will durably create an `InferenceAttemptRecord` with upstream state
`prepared` and native delivery `not_started`. The inference lease and attempt are scoped to the exact
runtime/incarnation rather than a `nativeBindingId`, `logicalChatId`, or coordinator epoch. The
attempt pins the exact native request, request digest, response-stream identity, and any upstream
idempotency key. Each physical child pins its connector lease/generation; the stable attempt does not
change owner on lease replacement. It names the local native-conversation record when that correlation is
already known; otherwise a later immutable `InferenceConversationCorrelationRecord` may link it only
after native evidence proves the relationship. This correlation never replays or moves the attempt.

`InferenceRuntimeBindingRecord.nativeRequestNamespaceId` is
`irn_${base64url(SHA256(str("remote-claw/inference-native-request-namespace/v1") ||
str(runtimeId) || uint(nativeIncarnation) || str(facadeProtocolSchemaId)))}`. It is stable across
inference-connector lease replacement and is immutable for that native incarnation. Changing the
façade protocol, extraction schema, or request-ID uniqueness semantics requires fencing every old
attempt and advancing `nativeIncarnation`; it may not mint a new namespace around a still-live native
process. `InferenceAttemptRecord` is unique on
`(nativeRequestNamespaceId,nativeRequestId)` and also on `inferenceAttemptId`; its response stream ID
is immutable and unique.

`facadeProtocolSchemaId` pins a `nativeRequestIdExtractionSchemaId` that names the exact canonical
request field or composite coordinate. Its retained proof must establish both that the pinned native
client preserves the coordinate on transport retry and that it never reuses the coordinate for two
distinct semantic requests during the entire native incarnation. A monotonic client-process
generation plus request sequence qualifies when both fields are authenticated by the façade; a bare
request ID with only retry-stability proof does not. The exact extraction evidence ref/digest and
incarnation-wide uniqueness proof ref/digest are retained, and every connector lease must repeat the
same namespace, extraction schema, and uniqueness-proof digest. Connector- or façade-minted
per-connection IDs do not qualify. If the provider-shaped protocol/client tuple has no stable,
lifetime-unique coordinate, the façade may allocate a connection-local ID only for write-ahead
bookkeeping: after possible upstream start, loss becomes `outcome_unknown`, blocks later inference for
that runtime until contained, and a visually identical native retry is not silently treated as safe.
Writability across façade restart requires retained retry and non-reuse fixtures for the exact
extraction schema.

The request digest is SHA-256 of
`str("remote-claw/inference-native-request/v1") || str(requestFingerprintSchemaId) ||
str(canonicalProviderRequestSchemaId) || str(nativeRequestNamespaceId) || str(nativeRequestId) ||
bytes(canonicalCredentialStrippedProviderRequest)`. Before setting upstream state `prepared`, one
transaction looks up that composite key. Same ID and digest is exact native retry and returns/resumes
the same attempt and response stream; same ID with a different digest is a collision and sends no
upstream byte. The same transaction encrypts and retains those exact credential-stripped canonical
request bytes in `encryptedCanonicalProviderRequestRef`, bound to
`canonicalProviderRequestSchemaId`, `requestDigest`, and the encrypted-envelope digest. Recovery
verifies the envelope, decrypts the retained bytes, and recomputes the request digest before any first
send or resume; it never reconstructs a provider request from native history. A façade or connector
restart performs this lookup and verification before allocating anything.

Exactly one inference lease is current per runtime incarnation. Installation first fences the old
connector and classifies every started upstream/native delivery, then compare-and-swaps
`InferenceRuntimeBindingRecord.currentInferenceLeaseId`; a uniqueness constraint forbids two current
leases. A replacement lease is valid only when its runtime/incarnation, façade schema, request
namespace, extraction schema, canonical provider-request schema, and uniqueness-proof digest exactly
equal the inference binding. The provider-neutral `NativeRuntimeIncarnationRecord` contains only
runtime ownership and start-identity evidence; runtimes that do not host an inference façade need no
inference binding.
Changing any of those fields requires closing the old incarnation and completing its ambiguity audit
before a higher incarnation may start. Each physical send/resume uses a new immutable
`InferenceConnectorTransportAttemptRecord`, and `currentTransportAttemptId` advances by CAS. If every
prior child has positive `never_started` evidence, a new lease may create another `initial_send`
child. If upstream may have started, a replacement can use only `resume_existing` with the same
upstream request ID and a positively proved cursor/read-back; it cannot send the provider request
again. Missing recovery evidence leaves the parent and child `outcome_unknown`. A new connector
therefore recovers the existing attempt under its pinned upstream idempotency/read-back rules but
cannot create a second attempt or response stream for the same native request namespace/ID. A stale
connector or lease generation cannot send or deliver a chunk after the pointer changes.

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
worker epoch. A1 registration resolves a `nativeBindingId` through its durable
`(collaborationServerId, logicalChatId)` scope; it never assumes either chat coordinate is the native
ID.

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
exact durable native binding and its runtime-owner attachment lease are both current for the same
runtime/incarnation. The runtime owner's current `RuntimeOwnerIdentityKeyRecord`, not a server identity
key, signs that certificate. One local transaction revalidates those prerequisites, compare-and-swaps
the terminal server/chat generation, and installs the certificate and reserved native edge together.
Only a server target that already has such a current path may issue a signed
`ServerRootedTopologyCertificate`. It commits the target's complete server/chat/edge path and every
topology generation.

For a server-to-server edge, the source verifies that it is absent from the certified path and has no
current inward edge, then writes its signed prepare receipt against its expected generation. The target
does the same for its collaborator slot and certified generation. Both sides next exchange signed
commit-intent receipts. Each side may then install the reserved edge only as `installed`, which is
durable but non-writable, and exchange signed installed receipts naming both commit intents and both
expected topology generations. A reservation reaches `both_installed` only after each side has
verified both installed receipts.

Writability is a separate mutually authenticated live handshake. Both peers contribute fresh nonces
and connection epochs on the actual transport, then each current server key signs the same transcript:
the source server/chat/inward-edge and target server/chat/collaborator-slot coordinates, reservation and root-certificate digest, both topology generations,
both installed-receipt digests, both nonces/epochs, and the selected TLS 1.3 exporter binding.
Only after verifying both signatures does each side compare-and-swap the same
`InwardEdgeLiveLeaseRecord` and `currentLiveLeaseId`. Every inward send names that live lease and
transcript digest; every receiver revalidates it and rejects a mutation unless its own matching edge,
epoch, channel binding, and lease are current. Public receipt replay or a caller-chosen connection epoch
cannot recreate writability. A split finalization can therefore leave one side
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

The edge handshake binds each stable random `collaborationServerId` to the machine `identity_id` and a
server identity public key through a `ServerScopeCertificateRecord`. Operator-approved enrollment
carries a `ViewerOnboardingBundleV2` containing an oldest-to-newest certificate chain, the pinned
current public key, and the existing viewer credentials. The first item is the operator-approved,
self-signed trust anchor; every later item is signed by the immediately preceding subject key, and the
last item matches `serverIdentityKey`. An already paired viewer may receive only the suffix beginning
with its exact current trusted certificate. This is a transport/serialization contract: never log it
or persist the whole bundle as one plaintext artifact. After verification, the viewer may retain
extracted credentials in memory or in a future scoped credential store at least as strong as A0's
shipped design: a non-extractable AES-GCM key handle in IndexedDB wrapping tab-scoped ciphertext in
`sessionStorage`. Plaintext `localStorage` is not the existing baseline and is not an acceptable
silent fallback. The non-secret certificate chain and public keys may be stored in the scoped trust
registry. A cold client verifies the complete chain
before deriving the canonical A1 bus address. A nested peer receives the same chain through its
authenticated pairing flow.

Bundle verification is fail-closed and precedes every route hash, key derivation, subscription, or
publish:

1. Require bundle version 2, canonical string encodings, exact key lengths, one decoded 16-byte
   `machineIdentityId`, one decoded 16-byte `collaborationServerId`, and the fixed certificate
   algorithms/lengths.
2. Decode `authToken` and require
   `lowerHex(trunc16(SHA-256(authToken))) === machineIdentityId`.
3. Require every certificate's `machineIdentityId` and `collaborationServerId` to match the bundle
   exactly, require a non-empty chain of at most 32 items, and reject duplicate certificate IDs or
   duplicate subject-key declarations. A signer key reference may repeat only where the next chain item
   legitimately names the preceding subject.
4. For a cold pair, require the first certificate to be self-signed and explicitly accepted through
   the operator-approved pairing channel. For an existing pair, require the first certificate to equal
   the locally current trusted certificate byte-for-byte; never trust a caller-supplied status.
5. Walk the chain in order. Recompute every canonical digest and signature; require each next
   `signerIdentityKeyId` to equal the preceding subject key, `supersedesScopeCertificateId` to equal the
   preceding certificate ID, `keyGeneration` to equal the preceding generation plus one, and every
   successor subject public key to differ from every earlier subject key in the supplied chain rather
   than accepting reuse under a renamed key ID.
   Enforce one immutable key-ID-to-algorithm/public-key binding across local history and the whole chain.
   Signer sequences are canonical safe integers and strictly increase across the supplied signed
   certificates; gaps are allowed because other server records may have been signed between rotations.
6. Require `serverIdentityKey` to equal the final certificate's subject key ID, `Ed25519` algorithm,
   and raw 32-byte public key. Recompute and verify `keyAttestation` under that key, require its server,
   machine, certificate ID, key generation, and signer ID to equal the verified tip, and require all
   four domain-separated key commitments to match the decoded operational keys.
7. If an existing viewer receives exactly its one current certificate as the whole chain, the pure
   verifier can require that certificate to equal the caller-supplied trusted certificate and verify
   the bundle's tip key and attestation. The caller's A1.10 trust store must additionally require an
   exact locally current key-attestation replay before classifying it as an idempotent no-state-change
   retry; the pure verifier has no retained attestation or capability state to compare or mutate.
8. For a non-empty successor suffix, atomically compare-and-swap
   `(currentScopeCertificateId, currentKeyGeneration, currentIdentityKeyId)` to the final certificate's
   ID, `keyGeneration`, and subject key ID. `currentKeyGeneration` must equal the current certificate's
   `keyGeneration` before and after the transaction. One concurrent branch can win; a stale, rollback,
   skipped-generation, or forked chain fails closed.
9. In that same successor transaction, require the prior local status to be `current` and not revoked, change it
   to `retired`, install any newly learned intermediate certificates as `retired`, and install the tip
   as the sole `current` status for the server. A uniqueness constraint permits exactly one
   `(collaborationServerId, state: "current")`; no transition overwrites `revoked`. Initial cold
   enrollment installs every non-tip chain item as retired and the tip as current.
10. Insert every certificate and the key attestation into the signer-sequence acceptance index in that
    transaction. The attestation sequence is greater than the final certificate sequence. Exact repeats
    are idempotent; a duplicate, decreasing, or equal sequence with different signed content
    quarantines enrollment.

Any mismatch rejects the bundle as a splice/corruption error rather than waiting for broker admission
to fail. Current/retired/revoked state lives only in local
`ServerScopeCertificateStatusRecord`s and is not accepted from the onboarding DTO. A revoked key may
verify old history but cannot authorize a new chain item.

A1.5 implements the pure structural, canonical, commitment, chain, signature, exact-trusted-first,
tip-key, optional-pin, and transfer-checksum verification above. It returns a verified immutable
bundle and retains no certificate history, status, or credentials. Therefore an existing-pair suffix
must begin with the caller's exact trusted certificate, while both key-ID and public-key bindings from
older omitted history remain the caller trust store's responsibility. Step 7's locally current
attestation replay/no-op classification, steps 8–10's atomic status/current-pointer work, and credential
installation remain A1.10.

The certificate signature covers this exact immutable, length-prefixed canonical payload, in this
order:

```text
str(canonicalPayloadSchemaId)
uint(schemaVersion)
str(scopeCertificateId)
bytes(hexDecode(machineIdentityId))  // exactly 16 bytes from 32 lowercase hex chars
str(collaborationServerId)
str(subjectIdentityKeyId)
str(subjectKeyAlgorithm)
bytes(base64urlDecode(subjectPublicKey))   // exactly 32 raw Ed25519 bytes
uint(keyGeneration)
uint(issuedAtMs)
optionalStr(supersedesScopeCertificateId)
str(signerIdentityKeyId)
uint(signerSequence)
optionalUint(supersededSignerMaxSequence)
str(signatureAlgorithm)
str(canonicalPayloadDigestAlgorithm)
```

`canonicalPayloadDigest` must equal SHA-256 of those bytes, and `signature` signs those same bytes.
`canonicalPayloadDigest` is unpadded base64url of 32 digest bytes. A1 selects Ed25519 only:
`subjectPublicKey` is unpadded base64url of the 32 raw public-key bytes, and `signature` is unpadded
base64url of the 64 raw signature bytes. SPKI/PEM wrappers, padded base64, and algorithm aliases are
rejected. Neither the digest/signature value nor locally mutable certificate status is part of the
signed payload. The
onboarding bundle's
`serverIdentityKey` must exactly match the final certificate's subject key ID, algorithm, and public
key.
For initial enrollment or explicit re-pairing, the newly pinned subject key self-signs
(`signerIdentityKeyId === subjectIdentityKeyId`) and `supersededSignerMaxSequence` is null. For
continuity rotation, `subjectIdentityKeyId`
names the new subject key and `signerIdentityKeyId` names the old current key; the verifier resolves
that old key from its trusted registry before accepting the new certificate, and
`supersededSignerMaxSequence` must equal this certificate's `signerSequence`. The signed cutoff is the
maximum sequence under which any old-key record can later verify.

The four onboarding key commitments use
`SHA256(str("remote-claw/viewer-onboarding-key-commitment/v1") || str(label) || bytes(decodedKey))`,
with labels exactly `auth_token`, `content_root`, `control_key`, and `meta_key`. Each commitment is
canonical unpadded base64url. The attestation payload and signature bytes are:

```text
str(canonicalPayloadSchemaId)
uint(schemaVersion)
str(collaborationServerId)
bytes(hexDecode(machineIdentityId))
str(scopeCertificateId)
uint(keyGeneration)
str(signerIdentityKeyId)
uint(signerSequence)
bytes(base64urlDecode(authTokenCommitment))
bytes(base64urlDecode(contentRootCommitment))
bytes(base64urlDecode(controlKeyCommitment))
bytes(base64urlDecode(metaKeyCommitment))
str(signatureAlgorithm)
str(canonicalPayloadDigestAlgorithm)
```

`canonicalPayloadDigest` is SHA-256 of those bytes and `signature` is Ed25519 over those same bytes.
Substituting even one operational key therefore fails before a route or KDF is used.

The human transfer wire is separate from the typed DTO. `canonicalBundleBytes` is exactly:

```text
str("remote-claw/viewer-onboarding-bundle/v2")
uint(version=2)
bytes(hexDecode(machineIdentityId))
str(collaborationServerId)
bytes(base64urlDecode(authToken))
bytes(base64urlDecode(contentRoot))
bytes(base64urlDecode(controlKey))
bytes(base64urlDecode(metaKey))
str(serverIdentityKey.identityKeyId)
str(serverIdentityKey.algorithm)
bytes(base64urlDecode(serverIdentityKey.publicKey))
uint(scopeCertificateChain.length)
for certificate in scopeCertificateChain:
  bytes(certificateCanonicalPayloadBytes)
  bytes(base64urlDecode(certificate.canonicalPayloadDigest))
  bytes(base64urlDecode(certificate.signature))
bytes(keyAttestationCanonicalPayloadBytes)
bytes(base64urlDecode(keyAttestation.canonicalPayloadDigest))
bytes(base64urlDecode(keyAttestation.signature))
```

Every nested payload is the exact canonical payload defined above, wrapped once by `bytes`; digests are
32 bytes and signatures 64 bytes. The decoder consumes exactly the stated certificate count and then
the one attestation and rejects trailing bytes. The only accepted text spelling is
`rcp2.<base64url(canonicalBundleBytes)>.<base64url(checksum)>`, where
`checksum = SHA256(str("remote-claw/viewer-onboarding-wire-checksum/v2") ||
bytes(canonicalBundleBytes))`. Base64url is unpadded and canonical; decoded length, item count, field
length, and total size are capped before allocation. The checksum detects transfer corruption; only the
certificate chain and key attestation establish trust.

Already-paired viewers learn continuity rotations through a retained, public certificate-update
surface, not through a shared-key frame. After the successor certificate is durably signed and before
the pointer/lease swap, the host stores one immutable `BrokerScopeCertificateUpdateRecord` under the
machine/server scope. The broker sees only public certificate material and its digest. A viewer that
sees an unknown output signer pauses that route without rendering, fetches by expected
`supersedesScopeCertificateId`/generation, and walks every retained successor from its exact local
current certificate. Certificate-before-frame and frame-before-certificate both converge; an offline
viewer may walk several rotations. Missing, forked, revoked, or noncontiguous updates leave the route
non-writable and require operator re-pairing. A viewer still pinned to a subsequently compromised old
key cannot cryptographically choose between two old-key-signed successor forks: viewers that already
advanced reject the fork, while an offline pre-rotation viewer requires an out-of-band trust reset.
The design does not claim automatic fork recovery.

`certificateUpdateId` is
`scu_${base64url(SHA256(str("remote-claw/server-scope-certificate-update/v1") ||
str(collaborationServerId) || str(supersedesScopeCertificateId) || uint(keyGeneration)))}`.
The public store's unique lookup key is exactly
`(collaborationServerId, supersedesScopeCertificateId, keyGeneration)`, and
`keyGeneration` must equal the superseded certificate's generation plus one. It independently parses
the supplied certificate, recomputes its canonical digest, and requires every coordinate to match the
lookup key before storing it. Exact bytes are idempotent. A different successor certificate ID,
subject key, digest, or bytes at that key is retained as explicit certificate-update equivocation and
quarantines the server scope; keying only by the new certificate ID is forbidden because it would hide
a fork.

Historical reattestations use an analogous retained public lookup keyed by
`(collaborationServerId, historicalRecordDigest, reattesterKeyGeneration)`. A delayed old-key output pauses before render,
fetches the exact `BrokerHistoricalReattestationRecord`, verifies its digest and current certified
signature, and only then resumes ordinary frame verification. Frame-before-reattestation and
reattestation-before-frame converge on the same signed-record acceptance row; missing or conflicting
metadata remains quarantined.

The current signing service may create a reattestation only after its local acceptance table proves the
exact historical digest was accepted before the predecessor cutoff. It durably signs the immutable
reattestation, then publishes the public object and digest alongside certificate updates. The broker
key includes the reattester generation: exact bytes are idempotent, while a different reattestation or
digest in that generation is public-metadata equivocation and quarantines the server scope. On a later
rotation, the new current key may publish the deterministic successor for the same historical digest;
its `supersedesHistoricalReattestationId` names the prior generation's record. A late viewer fetches
the record signed by its verified current certificate, walking the contiguous public certificate and
reattestation updates as necessary, so K0 history remains verifiable after K0→K1→K2 without treating
K2's reattestation as a conflict. Certificate updates and reattestations are retained as long as any corresponding old
frame/certificate may be returned; ordinary chat closure, reset, or ciphertext-body compaction does
not collect them.

The ID is
`rhr_${base64url(SHA256(str("remote-claw/historical-record-reattestation-id/v1") ||
str(collaborationServerId) || bytes(base64urlDecode(historicalRecordDigest)) ||
str(signerScopeCertificateId)))}`. The first reattestation has a null `supersedes` field; every later
generation names the exact prior record. The broker lookup key is
`(collaborationServerId, historicalRecordDigest, signerKeyGeneration)`, and it recomputes both the ID
and signed-object digest rather than trusting publisher-supplied values.

Here `str`, `uint`, `bytes`, `optionalStr`, and `optionalUint` are exactly the A1 primitives in
[v2 Architecture §4.3](v2-architecture.md#43-session-message-key-flow-answers-do-we-need-a-sessionkey-flow);
the stored lowercase-hex machine identity and base64url public key are decoded before their byte
fields are serialized.

All rooted-topology and lineage signatures use the same fixed algorithms and canonical primitives.
`canonicalPayloadDigest` is unpadded-base64url SHA-256 of the listed payload, and the 64-byte canonical
Ed25519 `signature` signs those exact bytes. Digest/signature fields themselves are excluded. Unknown
fields, duplicate members, noncanonical strings/numbers, unsupported algorithms, and wrong digest/key/
signature lengths fail before trust or topology mutation.

The runtime owner has a separately protected local `RuntimeOwnerIdentityKeyRecord`. Initial pinning and
rotation are explicit local-owner operations bound by `localTrustEvidenceRef` and
`localTrustEvidenceDigest`; exactly one key is current, and revoked keys cannot sign a new native
root. Schema v4 stores only an AES-256-GCM-wrapped PKCS#8 envelope under
`remote-claw/runtime-owner-key-wrap/aes-256-gcm/v1`, with the wrap key derived from the machine root
secret. The public record holds an opaque `signing_key` handle; neither the root secret, wrap key, nor
private-key plaintext is exposed by the repository or RPC. Startup self-tests every current wrapped
key before the service becomes writable. Implemented rotation performs logical retained-state
destruction: the retired key's append-only ciphertext envelope remains for audit and must not be
described as physical erasure. Schema v4 also represents a `revoked` public-key state, but A1.3 exposes
no separate revocation repository operation; a later revocation operation must preserve the same
retained-ciphertext rule. A rotation atomically binds the predecessor's destruction time, the
successor key and envelope creation time, and the exact journal time and active runtime-owner
assignment.

It may sign a native root only after its local
registry proves the exact durable binding, runtime/incarnation, and attachment lease are all current
and mutually linked. A coordinator or server key cannot substitute for this runtime-owner gate. That
evidence digest is:

```text
SHA256(
  str("remote-claw/native-binding-evidence/v1") ||
  str(runtimeId) ||
  uint(nativeIncarnation) ||
  str(nativeBindingId) ||
  str(descriptor.product) ||
  str(descriptor.access) ||
  str(nativeConversationId) ||
  str(attachmentLeaseId)
)
```

Runtime-owner signatures use the same reserve/bind/sign crash discipline, but a separate
`RuntimeOwnerSignatureReservationRecord` and counter domain. Reserving atomically advances
`nextSignerSequence`; binding stores the exact purpose-selected canonical payload/ref and digest; signing
persists the canonical 64-byte signature and artifact ID before release. The acceptance index is
unique on both the signed digest and
`(runtimeId, runtimeOwnerIdentityKeyId, runtimeOwnerKeyGeneration, signerSequence)`. Exact replay is
idempotent, sequence reuse with different bytes is local signer equivocation, and a missing/stale
counter or bound record makes native-root renewal non-writable. A crash never reconstructs a different
binding-evidence digest under an already reserved sequence.

The terminal coordinator resolves and compares every field from its local runtime registry; an outer
server never invents or directly trusts a runtime-owner key. The exact native-root certificate payload
is:

```text
str(canonicalPayloadSchemaId)
uint(schemaVersion)
str(rootPathCertificateId)
str(kind)
str(terminalNativeBindingId)
str(terminalServerId)
str(terminalLogicalChatId)
uint(terminalTopologyGeneration)
bytes(base64urlDecode(nativeBindingEvidenceDigest))
str(runtimeOwnerIdentityKeyId)
uint(runtimeOwnerKeyGeneration)
uint(signerSequence)
uint(issuedAtMs)
uint(expiresAtMs)
str(signatureAlgorithm)
str(canonicalPayloadDigestAlgorithm)
```

Each `TopologyPathHop` extends either that native-root digest or the preceding hop digest. Its payload
is:

```text
str(canonicalPayloadSchemaId)
uint(schemaVersion)
uint(hopIndex)
str(collaborationServerId)
str(logicalChatId)
str(inwardEdgeId)
uint(topologyGeneration)
bytes(base64urlDecode(predecessorCertificateOrHopDigest))
uint(rootAnchorExpiresAtMs)
str(signerIdentityKeyId)
uint(signerKeyGeneration)
str(signerScopeCertificateId)
uint(signerSequence)
str(signatureAlgorithm)
str(canonicalPayloadDigestAlgorithm)
```

Hop zero has `predecessorCertificateOrHopDigest` equal to the verified native-root
`canonicalPayloadDigest`; every later hop names the preceding hop's `canonicalPayloadDigest`.
`hopIndex` is contiguous from zero, each signer is the current certified key for that hop's server at
issuance, and the server/chat/edge/generation matches its current installed inward edge. The exact
server-rooted container payload is:

```text
str(canonicalPayloadSchemaId)
uint(schemaVersion)
str(rootPathCertificateId)
str(kind)
str(targetServerId)
str(targetLogicalChatId)
uint(targetTopologyGeneration)
bytes(base64urlDecode(rootAnchorCertificateDigest))
uint(rootAnchorExpiresAtMs)
uint(path.length)
for hop in path:
  bytes(base64urlDecode(hop.canonicalPayloadDigest))
str(issuerServerIdentityKeyId)
uint(issuerServerKeyGeneration)
str(issuerScopeCertificateId)
uint(signerSequence)
uint(issuedAtMs)
uint(expiresAtMs)
str(signatureAlgorithm)
str(canonicalPayloadDigestAlgorithm)
```

`rootAnchorCertificateDigest` is an opaque commitment to the terminal server's locally verified
native-root certificate; outer servers never receive its native binding fields.
`rootAnchorExpiresAtMs` must equal that native root's signed expiry and every hop repeats it. `path` is non-empty,
the last hop's
server/chat/generation equals the target tuple, and the container issuer equals that last hop's server
key. The terminal server verifies the private native-root certificate locally and signs hop zero
against its opaque digest. Outer servers verify the terminal server's certified hop-zero signature and
every later signed server hop; they do not receive or independently verify native-binding fields and
therefore trust the terminal server's root-existence claim. A plain unsigned path array is never
accepted. The signed server path rejects repeated server/chat or edge coordinates, a
missing/reordered hop, a predecessor splice, and a target/container mismatch. Every
`collaborationServerId` and every inward-edge ID is unique across the path, regardless of chat; a
source rejects a candidate path containing its server ID anywhere. A compromised terminal
server can lie about its own root, but cannot remove or reorder an already signed outer hop.
`expiresAtMs - issuedAtMs` is positive and at most five
minutes, and `expiresAtMs <= rootAnchorExpiresAtMs`; issuance may be at most five seconds in the future. Current topology/edge generations and
certificate expiry are revalidated on every prepare, install, live handshake, and mutation, not only
when the certificate was first stored.

Renewal does not reinstall or reparent a healthy edge. Before expiry, the runtime owner signs a fresh
native root for the same exact binding/generation, and every server on the existing path reissues its
same-coordinate hop against the new predecessor/root commitment without changing topology generation.
Each side verifies the whole renewed chain, then atomically swaps its edge's
`rootPathCertificateId` and fresh live-handshake reference while the old certificate is still valid.
All descendant/container expiries must be no later than `rootAnchorExpiresAtMs`. A crash retries the
same signed renewal records and compare-and-swap; if renewal is incomplete at expiry, the edge becomes
non-writable rather than extending the old authority.

Every install receipt signs all immutable reservation coordinates. Its payload is:

```text
str(canonicalPayloadSchemaId)
uint(schemaVersion)
str(receiptId)
str(reservationId)
str(stage)
str(side)
str(sourceServerId)
str(sourceLogicalChatId)
str(sourceInwardEdgeId)
uint(expectedSourceTopologyGeneration)
str(targetServerId)
str(targetLogicalChatId)
str(targetCollaboratorBindingId)
uint(expectedTargetTopologyGeneration)
str(rootPathCertificateId)
bytes(base64urlDecode(priorReceiptChainDigest))
uint(issuedAtMs)
str(signerServerId)
str(signerIdentityKeyId)
uint(signerKeyGeneration)
str(signerScopeCertificateId)
uint(signerSequence)
str(signatureAlgorithm)
str(canonicalPayloadDigestAlgorithm)
```

Define
`receiptChain(label, digests...) = SHA256(str("remote-claw/inward-edge-receipt-chain/v1") ||
str(reservationId) || str(label) || uint(digests.length) ||
bytes(base64urlDecode(digest[0])) || ...)`.
The only accepted predecessors are, in order: source `prepared` uses `receiptChain("source-prepared")`;
target `prepared` uses `receiptChain("target-prepared", sourcePreparedDigest)`; source
`commit_intent` uses `receiptChain("source-commit", sourcePreparedDigest, targetPreparedDigest)`;
target `commit_intent` uses
`receiptChain("target-commit", sourcePreparedDigest, targetPreparedDigest, sourceCommitDigest)`;
source `installed` uses
`receiptChain("source-installed", sourceCommitDigest, targetCommitDigest)`; and target `installed`
uses `receiptChain("target-installed", sourceCommitDigest, targetCommitDigest,
sourceInstalledDigest)`. The named side must sign with that server's current certified key. A receipt
with another predecessor set, order, reservation, generation, or certificate is not a later phase.

Each side's live-handshake attestation signs this payload:

```text
str(canonicalPayloadSchemaId)
uint(schemaVersion)
str(handshakeId)
str(side)
str(reservationId)
str(sourceServerId)
str(sourceLogicalChatId)
str(sourceInwardEdgeId)
uint(sourceTopologyGeneration)
uint(sourceConnectionEpoch)
bytes(base64urlDecode(sourceNonce))
str(targetServerId)
str(targetLogicalChatId)
str(targetCollaboratorBindingId)
uint(targetTopologyGeneration)
uint(targetConnectionEpoch)
bytes(base64urlDecode(targetNonce))
bytes(base64urlDecode(rootPathCertificateDigest))
bytes(base64urlDecode(sourceInstalledReceiptDigest))
bytes(base64urlDecode(targetInstalledReceiptDigest))
str(transportBindingSchemaId)
bytes(base64urlDecode(transportChannelBinding))
uint(issuedAtMs)
str(signerIdentityKeyId)
uint(signerKeyGeneration)
str(signerScopeCertificateId)
uint(signerSequence)
str(signatureAlgorithm)
str(canonicalPayloadDigestAlgorithm)
```

Nonces are distinct canonical 32-byte random values. The initial and only supported binding schema is
`remote-claw/tls13-exporter-binding/v1`: over the exact TLS 1.3 connection, both peers call the RFC
8446 exporter with label `EXPORTER-remote-claw-inward-edge-v1`, length 32, and context equal to
`SHA256(str("remote-claw/inward-edge-exporter-context/v1") || str(reservationId) ||
str(sourceServerId) || str(sourceLogicalChatId) || str(sourceInwardEdgeId) || str(targetServerId) ||
str(targetLogicalChatId) || str(targetCollaboratorBindingId) || bytes(sourceNonce) ||
bytes(targetNonce))`. The 32 exporter bytes are `transportChannelBinding`; application Ed25519
attestations authenticate the declared server keys over that channel. No alternate TLS version,
exporter label/context, Noise/Unix shortcut, or fallback transport is accepted without a new binding
schema and retained interop/downgrade proof. Source and target attestations differ only in
`side` and signer coordinates. `inwardLiveLeaseId` is
`ril_${base64url(SHA256(str("remote-claw/inward-edge-live-lease/v1") ||
bytes(base64urlDecode(sourceAttestationDigest)) ||
bytes(base64urlDecode(targetAttestationDigest))))}`. Both peers install those exact
digests and epochs; a mutation carries that ID plus its lineage, and cannot be replayed on another
connection or after either lease is superseded.

The canonical origin bytes begin with `str("remote-claw/event-lineage-origin/v1")` and then either
`str("collaborator")` followed by the five collaborator-origin strings in DTO order, or
`str("native")` followed by native binding and observation IDs. `originDigest` is SHA-256 of those
bytes. Each lineage hop payload is:

```text
str(canonicalPayloadSchemaId)
uint(schemaVersion)
str(lineageId)
bytes(base64urlDecode(originDigest))
uint(hopIndex)
str(collaborationServerId)
str(logicalChatId)
str(inwardEdgeId)
str(direction)
str(canonicalEnvelopeSchemaId)
bytes(base64urlDecode(canonicalEnvelopeDigest))
bytes(base64urlDecode(priorChainDigest))
str(signerIdentityKeyId)
uint(signerKeyGeneration)
str(signerScopeCertificateId)
uint(signerSequence)
str(signatureAlgorithm)
str(canonicalPayloadDigestAlgorithm)
```

For hop zero, `priorChainDigest === originDigest`; later hops require the preceding `chainDigest`.
`canonicalPayloadDigest` and `chainDigest` both equal SHA-256 of the payload above. The record direction
equals every hop direction, indices are contiguous, and every hop key resolves to that exact server.
Changing origin, payload, direction, edge, order, or any predecessor breaks the chain.
The current certified server key signs the exact canonical payload. `signedRecordDigest` is SHA-256 of
`str("remote-claw/event-lineage-hop-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || str(signerIdentityKeyId) ||
uint(signerKeyGeneration) || uint(signerSequence) || bytes(base64urlDecode(signature))`.
The hop, its preparation, bound signature reservation, signed-record acceptance row, and any compound
joint finalizer must all carry that exact digest; a signature or hop transplanted from another
preparation fails before publication.

`ServerSignedRecordAcceptanceRecord` is unique on both the exact signed-record digest and
`(collaborationServerId, signerSequence)`. Same sequence/same key, certificate, generation, and digest
is idempotent; same sequence with any different value is signer equivocation and quarantines before
rendering, topology action, or forwarding. When a successor certificate arrives, its signed
`supersededSignerMaxSequence` becomes the retired predecessor status cutoff atomically. A higher
already-accepted predecessor sequence makes the rotation inconsistent and quarantines it.

A retired-key artifact is accepted after that transition only if its exact digest was already in the
local acceptance table before the status change and its sequence is at or below the signed cutoff.
Merely choosing an old sequence never backdates a newly observed record. A cold or late peer needs a
current-key `HistoricalRecordReattestationRecord`; its payload is:

```text
str(canonicalPayloadSchemaId)
uint(schemaVersion)
str(historicalReattestationId)
optionalStr(supersedesHistoricalReattestationId)
str(collaborationServerId)
bytes(base64urlDecode(historicalRecordDigest))
str(historicalSignerIdentityKeyId)
str(historicalSignerScopeCertificateId)
uint(issuedAtMs)
str(signerIdentityKeyId)
uint(signerKeyGeneration)
str(signerScopeCertificateId)
uint(signerSequence)
str(signatureAlgorithm)
str(canonicalPayloadDigestAlgorithm)
```

The reattesting key must be current when received. A revoked key never authorizes a newly observed
artifact without that current-key reattestation. These rules preserve already accepted history without
letting an old private key create new frames, hops, receipts, or topology claims after its cutoff.

A rotation is accepted only by the ordered-chain invariants and current-pointer/status
compare-and-swap above.
Explicit re-pairing is a separate operator-confirmed trust reset with a new self-signed anchor; it does
not masquerade as continuity. The random `collaborationServerId` remains stable. Retired public keys
remain available to verify old records, while revocation blocks new hops without rewriting history.
The receiver resolves each hop's key from that authenticated registry, verifies the complete chain,
and appends its own attestation. The outward result intentionally returns over the same physical edges
in reverse. For an authenticated stable proposal, a server records an ordered rejection when the
lineage already traversed that server or inward edge; malformed or unauthenticated transport gets no
semantic ACK. It rejects an observation that already traversed that outward edge, and never converts an outward
observation or correlated echo into an inward proposal. A malicious server can lie about a new event
it originates, but it cannot change the payload or remove, reorder, or change an already-attested
inner hop without breaking the verifiable chain.

A source observation's envelope, coordinate, capability/epoch pins, classification evidence, and
fingerprint fields are immutable. Its `pending` disposition and nullable result links advance exactly
once by compare-and-swap, backed by append-only `ingress.changed` facts, to one terminal
classification. A `CanonicalSourceEventRecord` is immutable and unique on the exact ingress key; it
exists only for a proven-new event created with `command.proposed`. Duplicate observations link that
record, while collision/ambiguous observations link only a recovery gap.

An outside capability snapshot is owned by one outside-binding incarnation. Every writable ingress
operation has one `OutsideIngressFamilyCapability`; there are no string-only family allowlists. Its
`capabilityEntryDigest` is SHA-256 of:

```text
str("remote-claw/outside-ingress-family-capability/v1") ||
str(scopeKind) || str(sourceOperationKind) || str(sourcePayloadSchemaId) ||
str(sourcePayloadDigestAlgorithm) || str(sourceParserSchemaId) ||
bytes(base64urlDecode(sourceParserImplementationDigest)) ||
str(sourceEventIdExtractionSchemaId) ||
bytes(base64urlDecode(sourceEventIdExtractionImplementationDigest)) ||
str(sourceCoordinateSchemaId) ||
bytes(base64urlDecode(sourceCoordinateImplementationDigest)) ||
str(sourceFingerprintSchemaId) ||
bytes(base64urlDecode(sourceFingerprintImplementationDigest)) ||
str(sourceFingerprintDigestAlgorithm) || str(namespaceBoundaryClassifierSchemaId) ||
bytes(base64urlDecode(namespaceBoundaryClassifierImplementationDigest)) ||
str(fingerprintCapabilityRelation) || str(normalizationSchemaId) ||
bytes(base64urlDecode(normalizationImplementationDigest)) ||
str(normalizedMutationFamily) || str(canonicalCommandPayloadSchemaId) ||
str(acknowledgement) || str(cursor) || str(replayIdentity) ||
bytes(base64urlDecode(evidenceDigest))
```

The retained evidence proves the exact source parser, ID extraction, coordinate, fingerprint,
namespace-boundary classification, normalization, replay, and ACK semantics. Both payload and
fingerprint algorithms are exactly SHA-256 over canonical bytes and every digest decodes from
unpadded base64url to 32 bytes. Entries are ordered by
`(scopeKind,sourceOperationKind,sourcePayloadSchemaId)` using unsigned UTF-8 byte order. Duplicate or
reordered keys, a parser/normalizer implementation substitution, or two source operations mapping
ambiguously to one normalized operation invalidates the document. The ingress vector digest is:

```text
SHA256(str("remote-claw/outside-ingress-family-vector/v1") || uint(count) ||
       for entry in order: bytes(base64urlDecode(entry.capabilityEntryDigest)))
```

`OutsideProtocolCapabilities.canonicalCapabilityDocumentDigest` is SHA-256 of:

```text
str("remote-claw/outside-protocol-capabilities/v1") || uint(schemaVersion) ||
str(providerKind) || str(providerProtocolVersion) || str(providerProtocolSchemaId) ||
bytes(base64urlDecode(connectorBinaryDigest)) ||
bytes(base64urlDecode(ingressCapabilityVectorDigest)) ||
str(projectionCapabilitySchemaId) ||
bytes(base64urlDecode(projectionCapabilityVectorDigest)) ||
str(controlCapabilitySchemaId) ||
bytes(base64urlDecode(controlCapabilityVectorDigest))
```

All three vector refs retain their exact canonical entries; the snapshot validator recomputes them
and the document digest. Projection/control schemas remain separately versioned, but cannot alter
ingress normalization. The immutable snapshot digest is:

```text
SHA256(str("remote-claw/outside-capability-snapshot/v1") || uint(schemaVersion) ||
       str(capabilitySnapshotId) || str(outsideIncarnationId) ||
       bytes(base64urlDecode(capabilityDocumentDigest)) ||
       bytes(base64urlDecode(evidenceDigest)) || uint(verifiedAtMs))
```

A protocol, connector binary, parser, normalizer, replay contract, or evidence change creates a new
snapshot even when the provider namespace stays the same. Commands and outbox items retain the
snapshot used for their decision, so a later change cannot rewrite history.

Each startup or reconnect writes a separate immutable verification whose digest is:

```text
SHA256(str(verifierSchemaId) || str(capabilityVerificationId) ||
       str(outsideIncarnationId) || str(capabilitySnapshotId) ||
       bytes(base64urlDecode(capabilitySnapshotDigest)) || uint(coordinatorEpoch) ||
       uint(connectionEpoch) || bytes(base64urlDecode(evidenceDigest)) ||
       uint(verifiedAtMs) || str(result))
```

Writability requires `result:"accepted"` and one atomic compare-and-swap that makes the incarnation's
snapshot and verification pointers current together. The verification's incarnation, snapshot
ID/digest, coordinator epoch, and connection epoch must equal the current binding lease. If
revalidation finds different capabilities, it creates a replacement snapshot and verification before
advancing either pointer. A failed verification leaves the incarnation non-writable and preserves the
previous records.

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

`runtimeId` uses the distinct `rcrt_*` namespace. A1.3 freezes it as:

```text
rcrt_${base64url(SHA256(str("remote-claw/native-runtime-id/v1") || bytes(base64urlDecode(wardenLaunchNonce)) || str(startIdentitySchemaId) || bytes(base64urlDecode(startIdentityDigest))))}
```

The launch nonce and digest are each exactly 32 bytes; the start schema is non-empty; all encodings
are canonical and unpadded. The locked vector uses nonce
`CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws`, schema
`remote-claw/codex-start-identity/v1`, and digest
`DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw`, producing
`rcrt_9eXZ6t2i1B6q6KnTszDoABv6BWYw0blCRXoNgPxF1WM`.

The founding inputs are a warden-issued launch nonce plus a non-reusable native start identity:
Claude process start identity, Codex app-server instance epoch, OpenCode server instance epoch, or
tmux pane plus child-process start identity. A PID, URL, or pane name alone is not sufficient. A
replacement advances `nativeIncarnation` under the same runtime root; it does not derive another
runtime ID from the successor process identity.
Before `bindNative`, each adapter classifies transport reconnect versus new chat versus child/fork
lineage. A synthetic Claude RC `cse_*` maps to the real transcript/resume identity; OpenCode child
sessions remain nested evidence; Codex create/fork results create distinct thread identities; and
tmux clear/branch/compact transitions are classified rather than treated as mere file rotation.

The neutral adapter package does not import the current Claude `Session`. A0.1 added
`host/native/adapter.ts` and a legacy RC registrar that specializes the generic port to `Session`.
Claude MITM creates one registrar per wrapper process and one lease per intercepted conversation; on
`ready`, the registrar invokes `startBridgeSession`. OpenCode now opens one lease in `starting`,
confirms one exact canonical native session ID, proves parent permission setup unless explicitly
opted out, publishes conservative capabilities, and moves to `ready` before the same bridge starts.
Tmux now opens the same kind of `starting` lease, creates its private runtime/server/socket and
owner-only launch artifacts, requires a positive pane probe plus a SessionStart marker from the exact
merged settings, publishes its conservative post-setup capabilities, and only then moves to `ready`.
The older `bridgeSession` entrypoint remains as a served-promise compatibility API, but no current
harness bypasses the registrar through it. This preserves the current data plane while making each
harness's no-ghost setup boundary explicit.

The adapter creates and owns `port`; the registrar consumes it for the bridge and returns a lease.
`open`, late `bindNative`, update, and close can fail asynchronously. On a validation, binding, or
lifecycle failure, the adapter closes the lease and applies the runtime-owner policy; it does not
pretend registration succeeded. The current A0 Claude path logs the registration failure and closes
that failed `Session`; OpenCode and tmux similarly close a failed starting lease and publish no
conversation, while A1 adds the persistent recovery gap and keep-alive/resume policy. After a validated
live `update`, an advisory projection failure is reported and retried by later presence publication,
but it does not restore stale metadata or capabilities. A0 implements only this lifecycle and current
metadata. The capability/evidence fields prevent that behavior-preserving bridge from claiming future
guarantees.
The legacy RC registrar does not start `startBridgeSession` or announce the conversation until it has
validated capabilities supplied at `open` or `update` and the adapter has moved the lease to `ready`.
The current Claude launch begins with null capabilities and supplies them through `update`. OpenCode
also begins conservatively, then updates only after confirming one exact canonical native session ID
and, unless opted out, parent permission read/install/read-back. Tmux likewise opens with null
capabilities and `nativeRef:null`, then updates only after its private launch boundary and required
native readiness evidence are proved. Its native capture, injection, and permission pumps may already
exist at that point, and `Session` can buffer earlier native observations, but the registrar has not
created a broker client or announcement; no remote mutation can reach the pane before `ready`.

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
epoch-fenced remote-collaboration mutation lease per current native binding. Its registry may contain
many concurrent Claude processes and many conversations inside shared Codex or OpenCode daemons. A
registration, teardown, takeover, or recovery operation names the exact runtime, conversation, and
binding; an unscoped “current session” slot is forbidden. If an adapter cannot reattach safely, it
advertises cold native resume or successor-chat recovery instead. Today's cleanup differs by path:
Claude wrapper teardown ends its child; tmux spends one bounded deadline settling pumps and its
lease/relay, then attempts to kill the pane with the remaining time and removes the private runtime
only when termination is proved; OpenCode leaves the external server alive but best-effort aborts the
attached session's active run. An uncertain tmux kill retains the private runtime and socket for
diagnosis or manual attachment, but the wrapper still has no durable reattachment policy. A1.3 now
supplies the persistent owner service and registry foundation; no A0 driver has yet registered its
native runtime through that service, so live reattachment remains proof-gated.

The runtime owner has its own host-wide `RuntimeOwnerServiceLeaseRecord` and monotonic service epoch,
distinct from every collaboration-server coordinator lease/epoch. Each
`NativeRuntimeIncarnationRecord` pins the exact service lease/epoch and process start-identity
schema/ref/digest that created or recovered it. A stale owner service therefore cannot mutate runtime
or protected state merely by presenting a current server coordinator epoch. A1.0 validates these
records. A1.2 may persist only a starting native binding with no current binding-incarnation pointer;
A1.3 implements service supervision, authenticated RPC, lease acquisition/takeover, protected custody,
and repository operations for creation or recovery of every runtime and binding incarnation. Owner
assignment is append-only; takeover appends a successor assignment rather than rewriting who created
the native incarnation. Replacing or terminating an incarnation requires a separate positive
containment record. In the dormant durable graph, closing a transport lease detaches only that exact
binding and does not terminate a shared runtime. No A0 driver uses this graph yet, so this rule does not
replace its current wrapper teardown.

Service takeover alone does not make the successor owner authoritative for an existing runtime. Until
it appends the exact next runtime-owner assignment, runtime mutation, key/signature work, local
conversation transitions, replacement, and termination under the successor lease conflict without
poisoning the service. Operations under the predecessor lease remain stale.

The production service uses one machine-scoped Linux abstract Unix socket, so there is no filesystem
socket path to replace or symlink-race. Client and server derive one HKDF key from the machine identity
secret and mutually authenticate a fresh 32-byte challenge with separately domain-tagged server and
client HMAC proof inputs. The server
admits at most 64 total live connections. Before authentication, each connection may send at most
1,024 bytes and exactly one authentication frame; pre-authentication request pipelining closes it.
Frames are canonical closed-shape JSON with a four-byte length prefix, a 1 MiB limit, at most 32
concurrent requests, and at most 4,096 request IDs per connection; duplicate request IDs, replay,
malformed authentication, unknown methods, oversized frames, and listener loss fail closed. A silent
handshake timeout closes the connection; an authenticated request timeout returns the fixed `TIMEOUT`
error for only that request and leaves the connection usable.
The RPC transport is now duplex. In addition to the existing 64-connection, 32-forward-request, and
4,096-forward-request-ID limits, each authenticated connection may register at most 64 callable ports,
serve at most 32 reverse invocations concurrently, and consume at most 4,096 reverse request IDs. A
port registry entry binds the exact connection, native binding, runtime/incarnation, attachment lease,
owner lease/epoch, coordinator lease/epoch, and port generation. Disconnect invalidates that
connection's ports; the durable repository proves only the protected handle and tuple, never process
liveness by itself.

The production RPC surface is health plus a closed operation registry. Supplying a trusted
`registrationAdapter` installs the complete A1.4 lifecycle—open, bind, publish, ready, recover, drain,
close, and reattach—plus A1.5 `native.root.activate`, and makes health report both flags true. The ordinary CLI supplies no adapter, so
only authenticated health succeeds and reports
`ownerOperationsWritable:false` and `nativeRegistrationEnabled:false`.

Wrapped `--rc-app` drivers connect first and may start one detached owner daemon if none answers. The
daemon receives only the absolute secret-file path and derived machine ID, not secret bytes. Its
environment and Node loader arguments are allowlisted, and its working directory is pinned to the
trusted CLI entry directory so a project-controlled cwd or `tsconfig` cannot influence the retained
tsx loader. It loads the secret itself, verifies the
derived identity, opens and migrates the current host-state schema (currently v9), acquires the exact process-start-identity-bound service lease,
self-tests current wrapped keys, binds RPC, and renews the lease. An unknown SQLite commit closes the
poisoned handle, reopens the same identity database, and reconciles the exact operation before any
retry. Lease loss, clock failure, key-custody failure, or listener loss poisons and stops the service;
another owner may take over only through the durable epoch plus explicit-release or expiry-deadline
rules.

The coordinator epoch is enforced, not informational. Acquiring it is an atomic compare-and-swap in the
server journal. Every server journal transition, remote-claw-origin delivery before native acceptance,
outward collaboration write, ingress ACK, and outbox claim is conditional on that epoch; the runtime
owner and connectors reject stale epochs. This prevents an old coordinator and its replacement from
both delivering. Direct native-TUI mutations remain on the native product path and are not
coordinator-epoch fenced.

Acquiring a coordinator lease is one compare-and-swap transaction: the service proves the current
lease absent, released, or expired; increments `currentCoordinatorEpoch`; creates the matching
`CoordinatorLeaseRecord`; updates `currentCoordinatorLeaseId`; and appends the next journal entry by
consuming `nextJournalOffset`. Heartbeats may extend only that exact current
`(coordinatorLeaseId, coordinatorEpoch)` pair. Expiry permits takeover but does not rewrite or delete
the old lease. Every mutating owner RPC supplies both values and fails before touching state when
either is stale.

Inference has a separate runtime/warden lease. Provider-shaped calls already accepted by the native
harness name the current native runtime and inference-connector generations, not the collaboration
coordinator epoch. A coordinator restart therefore cannot cancel or block an accepted local-TUI turn,
and it does not retroactively control a remote proposal after the native harness accepted it. A total
loss of the local façade or inference connector can still make new model-backed work unavailable; that
is a native-runtime availability failure, not a collaboration admission decision.

Every future remote-claw-origin mutating engine-port call carries `A1NativeMutationFence`; its
write-ahead `attemptId`, server/chat scope, durable `nativeBindingId`, proved terminal inward edge,
topology generation, exact native reference, coordinator lease/epoch, attachment lease, and native
capability snapshot are
validated immediately before the native side effect. This is never the process-local A0 `rcb_*`
registration lease. A private collaboration-transport operation resolves the named attachment lease
and rejects it if the attachment, native incarnation, coordinator lease/epoch, transport epoch,
terminal edge/root, capability snapshot, or topology generation is no longer current. N1 remote-server
connection epochs and live-lease IDs are not part of this terminal-native fence.

The adapter boundary accepts an immutable, already-translated request—not generic text to reinterpret
after admission—and separates first dispatch from evidence-only reconciliation:

```ts
interface PreparedNativeMutation {
  attemptId: string;
  dispatchAuthorizationHandle: string;
  canonicalDispatchDigest: string;
  fence: A1NativeMutationFence;
  canonicalRequestSchemaId: string;
  canonicalRequestRef: string;
  canonicalRequestDigest: string;
}

interface NativeDispatchReceiptExpectation {
  attemptId: string;
  canonicalDispatchDigest: string;
}

interface NativeDispatchReceipt {
  attemptId: string;
  canonicalDispatchDigest: string;
  dispatchState:
    | "started"
    | "transport_receipt"
    | "native_observed"
    | "completed"
    | "outcome_unknown";
  nativeReceiptRef: string | null;
  nativeReceiptDigest: string | null;
}

interface NativeReconciliationEvidence {
  attemptId: string;
  nativeEvidenceSchemaId: string;
  nativeEvidenceRef: string;
  nativeEvidenceDigest: string;
}

interface NativeFirstDispatchCapability {
  // Receives the raw authorization only after the final owner consume transaction succeeds.
  dispatch(prepared: PreparedNativeMutation): Promise<NativeDispatchReceipt>;
}

interface NativeReconciliationCapability {
  // Reads/attaches positive evidence only. This operation has no native send capability.
  reconcile(evidence: NativeReconciliationEvidence): Promise<NativeDispatchReceipt>;
}
```

The host-state/runtime-owner service atomically creates the selected signed result,
`NativeDeliveryAttemptRecord`, `NativeFrontDoorDispatchRecord`,
`NativeCommandEffectGateRecord`, and armed protected authorization. The durable dispatch stores its
opaque reference and canonical digest, never the raw secret. `dispatch` validates the exact request
ref/digest and current fence immediately before use; the final owner transaction consumes that one
authorization, moves all three rows to started, and only then returns the raw handle to the in-process
adapter. After any possible start, retry is forbidden; only `reconcile` may advance the attempt from
retained positive native evidence. Both adapter operations return the nonsecret attempt ID and
canonical dispatch digest; a reconciliation receipt never needs or exposes the consumed raw
authorization. Both first-dispatch and post-restart reconciliation verify a receipt against the same
strict, raw-free `NativeDispatchReceiptExpectation` reconstructed from the durable dispatch row.
The receipt evidence pair is also state-exact: `started` has both fields null;
`transport_receipt`, `native_observed`, and `completed` have both fields present; and
`outcome_unknown` may have both null when uncertainty arose before any receipt or both present when a
prior receipt is the last proved progress. A partial pair is always invalid.
Neither the coordinator nor an adapter may construct a replacement
request from current chat text after admission. The interfaces are deliberately separate: an evidence
reconciler has no `dispatch` method or native-send capability.

## 5. Normalized command path

The first selected families are intentionally small: chat-scoped `user_text` and server-control
`new_chat`. Both normalize into the common command shape:

```text
command
├── command ID
├── collaboration server ID
├── scope kind + optional source/target logical chat IDs
├── source kind + immutable source record
├── source event namespace + event ID + source-identity/source-record digests
├── typed mutation family
├── canonical typed payload reference + digest
├── ready journal position + globally unique command sequence (audit, not a cross-chat lock)
├── decision + admitted target kind
├── target capability snapshot + family digest
├── result version/current-result pointer
└── decision evidence + lifecycle state
```

The immutable source record, normally a `CanonicalSourceEventRecord`, carries the outside binding,
source-surface observation, event/management lineage, connector-incarnation provenance, and source
capability verification. Those facts are not copied into ad hoc text or timing fields on the common
command. The command carries only a typed canonical payload and pins a target capability after ordered
adjudication. Nullable chat/target fields follow the closed chat-versus-server-control rules in §4.

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

The exact outside-ingress scope ID is
`css_${base64url(SHA256(str("remote-claw/collaboration-source-scope/v1") ||
str(collaborationServerId) || str(scopeKind) || optionalStr(logicalChatId)))}`. `chat` requires a
non-null chat; `server_control` requires null. The deduplication key is the non-null tuple
`(sourceScopeId,outsideBindingId,sourceEventNamespaceId,sourceEventId)`, avoiding nullable-SQL
uniqueness. Both observation and canonical source-event rows retain/recompute that scope ID.
The observation's immutable `sourceObservationEvidenceDigest` is SHA-256 of:

```text
str("remote-claw/source-observation-evidence/v1") ||
str(sourceEventObservationId) || str(collaborationServerId) || str(scopeKind) ||
optionalStr(logicalChatId) || str(sourceScopeId) || str(lineageKind) ||
bytes(base64urlDecode(lineageDigest)) || str(outsideBindingId) ||
str(observedOutsideIncarnationId) || optionalStr(sourceEventNamespaceId) ||
str(sourceEventId) || optionalStr(sourceReplayIdentity) || str(sourcePayloadSchemaId) ||
str(sourcePayloadDigestAlgorithm) || bytes(base64urlDecode(sourcePayloadDigest)) ||
str(coordinateSchemaId) ||
str(sourceCoordinate) || optionalStr(namespaceTransitionId) ||
optionalDigest(classificationEvidenceDigest) || str(sourceCapabilitySnapshotId) ||
bytes(base64urlDecode(sourceCapabilitySnapshotDigest)) ||
str(sourceCapabilityVerificationId) ||
bytes(base64urlDecode(sourceCapabilityVerificationDigest)) ||
bytes(base64urlDecode(ingressCapabilityEntryDigest)) || str(normalizationSchemaId) ||
bytes(base64urlDecode(normalizationImplementationDigest)) || uint(coordinatorEpoch) ||
uint(connectionEpoch) || str(fingerprintSchemaId) || str(fingerprintDigestAlgorithm) ||
bytes(base64urlDecode(eventFingerprint)) || str(fingerprintCapabilitySnapshotId)
```

Refs are locators only; their retained bytes must recompute every paired digest. The observation's
coordinate, fingerprint, source-event ID extraction, namespace classifier, source payload schema, and
normalizer must equal one entry in its snapshot's verified ingress vector. Selected version one
requires `fingerprintCapabilitySnapshotId === sourceCapabilitySnapshotId`; cross-snapshot
compatibility requires a future schema and cannot be inferred. The snapshot ID/digest and verification
ID/digest must composite-foreign-key one currently accepted verification for the same outside
incarnation and epochs when a new event is classified. A later replay may use a successor incarnation
only through the stored historical entry and namespace rules.

For a proven-new observation, the canonical event ID is
`cev_${base64url(SHA256(str("remote-claw/canonical-source-event-id/v1") ||
str(sourceScopeId) || str(outsideBindingId) || str(sourceEventNamespaceId) ||
str(sourceEventId)))}`. Its `canonicalSourceEventDigest` is SHA-256 of:

```text
str("remote-claw/canonical-source-event/v1") || str(canonicalSourceEventId) ||
str(collaborationServerId) || str(scopeKind) || optionalStr(logicalChatId) ||
str(sourceScopeId) || str(lineageKind) || bytes(base64urlDecode(lineageDigest)) ||
str(outsideBindingId) || str(observedOutsideIncarnationId) ||
str(sourceEventNamespaceId) || str(sourceEventId) || str(firstObservationId) ||
bytes(base64urlDecode(firstObservationEvidenceDigest)) ||
optionalStr(sourceReplayIdentity) || str(sourcePayloadSchemaId) ||
str(sourcePayloadDigestAlgorithm) || bytes(base64urlDecode(sourcePayloadDigest)) ||
str(sourceCapabilitySnapshotId) ||
bytes(base64urlDecode(sourceCapabilitySnapshotDigest)) ||
str(sourceCapabilityVerificationId) ||
bytes(base64urlDecode(sourceCapabilityVerificationDigest)) ||
bytes(base64urlDecode(ingressCapabilityEntryDigest)) || str(normalizationSchemaId) ||
bytes(base64urlDecode(normalizationImplementationDigest)) || uint(coordinatorEpoch) ||
uint(connectionEpoch) || str(fingerprintSchemaId) || str(fingerprintDigestAlgorithm) ||
bytes(base64urlDecode(eventFingerprint)) || str(fingerprintCapabilitySnapshotId)
```

`firstObservationId` and its evidence digest must resolve to that exact new observation; substituting
another observation, accepted verification, epoch, parser, normalizer, or capability row changes the
event digest. `commandId` is inserted atomically with the event but excluded from this cycle-free
digest. `outside_incarnation_id`, capability verification, and connection epoch do not reset semantic
deduplication. Mutable structured sources must
generate and persist their event ID before first send. An adapter-assigned ID is safe only when the
source receives and retains it before retry. If that acknowledgement is lost, an indistinguishable
repeat remains `outcome_unknown`; it becomes a new proposal only after explicit user confirmation of
new intent, never automatically and never by text matching.

Before allocating any proposal, the coordinator searches canonical source-event records, observations,
and correlation mappings for the same source scope and outside binding across every superseded
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
Unknown mutation shapes fail closed. Semantic normalization happens before capability lookup, result
allocation, projection intent, or native attempt. A blank `user` proposal is rejected unless the
pinned engine tuple proves a real native blank-submit meaning. Reserved slash text is never left for an
engine adapter to reinterpret after generic user admission: for OpenCode, exact `/compact` is
normalized to typed `compact` first. If that family is unsupported, it receives the stored rejected
`action_result` path with no `accepted`, user projection, or native attempt; if supported, it receives
a typed action-result and one fenced compact attempt. Other slash text stays ordinary user text only
when the native product treats it as ordinary submitted content under the pinned compatibility
contract.

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

Every control record carries a stable record ID and exactly one closed scope: either
`(collaborationServerId,"server_control",null)` or
`(collaborationServerId,"chat",non-null logicalChatId)`, or an immutable foreign key to one of those
tuples. It also carries journal offset, commit time, correlation, and source provenance.
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
For each ingress, one serialized turn in that chat or server-control actor revalidates the transition,
current capability verification, and coordinator epoch. Actors for other chats proceed independently.
One durable transaction then records the observation's classification and does exactly one of these:

- proven new: insert the unique canonical source-event row and `command.proposed` together;
- proven replay: link the observation to the existing canonical row/command without a proposal; or
- collision/ambiguous: link the observation to a `recovery.gap` without a proposal.

A crash before commit leaves none of those semantic results; a crash after commit resumes the recorded
one. No semantic ACK or cursor advances until that transaction commits. A proposal left without
`command.decided` is resumed deterministically after restart; uniqueness constraints and one
transaction allocate its single decision and `command_seq`. A source result/ACK or admitted-user
projection outbox is enqueued only with signed-result finalization (or the joint nested finalizer),
never with `command.proposed` or decision reservation. A native-observation projection outbox is
enqueued atomically with the observation mapping it projects. Each outbox item retains the exact
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

- `journal_offset` totally orders all control records for audit and recovery, but does not serialize execution across chats;
- `command_seq` gives every proposal this server received and decided a unique durable position, including queued and rejected proposals. Within one closed chat scope, the forwarded subsequence is offered inward in that chat's order. Another chat does not wait for a missing, busy, or uncertain position; `command_seq` is neither a host-wide execution queue nor the native execution order;
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

When the coordinator restarts, it runs the following recovery lane independently for every durable logical chat, with bounded parallelism. A lane may become writable as soon as its own prerequisites pass; it does not wait for an unrelated failed lane:

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
    - if delivery provably never started, offer it inward in this server's proposal order. At a
      terminal-native edge this resumes only the same immutable attempt against its exact original
      executor; at a nested edge, transport replacement additionally requires the separately signed
      positive-never-started continuation;
    - if delivery started but cannot be proven, mark it `outcome_unknown` and do not resend
      automatically.
12. Reconnect collaborator protocols, revalidate each current incarnation's durable capability
    snapshot, and resume durable projection outboxes from their stable IDs.
13. Announce and route the same `(collaborationServerId, logicalChatId)` scope. A rotated nested or
    native transport must not allocate a second web row, broker channel, provider session/chat,
    represented subtree, or command sequence.
14. Reopen forwarding for this chat only when its next inward proposal cannot overtake an uncertain older attempt in the same chat. Merely displaying a gap does not make that lane safe; an uncertain attempt in another chat is not a reason to hold this one.

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
native conversation/incarnation. An existing terminal-native attempt never migrates to that successor:
if it cannot still run against its exact original executor, it must be explicitly abandoned before
send and closes without effect. Any user reauthorization creates a fresh authenticated source event,
common command, and attempt against the successor; it does not reopen or continue the old command.
Only the separately signed nested-transport positive-never-started contract may continue one old
command onto a replacement transport. Recovery never manufactures native state by replaying
historical actions.

The selected post-A1.3 owner-dispatch target observes native conversation changes even while every
collaboration coordinator is offline and writes a monotonic local transition log before depending on
that transition for recovery. Within an already durable project, it allocates only runtime-local
conversation IDs; it does not allocate the first project, a server-scoped chat, or a remote writer.
Once A1.9 enables runtime-scoped inference, new local model work remains recoverable through its
inference lease even when no `nativeBindingId` can yet be resolved. The current health-only production
path creates neither local-conversation nor inference-attempt records. If no durable project exists,
local native use may continue, but the future dispatch path cannot persist that conversation into this
registry until a coordinator allocates the project.

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
terminal queued proposals for the old chat are never delivered to the new conversation. Explicit
reauthorization creates a fresh authenticated source event and common command. Only after the import
and native reconciliation commit may a
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
`698d2202c9dcaa5f1d5789fe11c7f8d27e35f430109cedd0bc6aeac3a703bc73`, starts one real app-server,
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
`f1f6a14c69a1d8650cbc6519c129d7afc50e96c43e968d9866952615569065ba`, starts one real app-server
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
runtime owner therefore exposes three callable fenced seams—TUI process, binding adapter, and
server-scoped creation—plus one internal-only observer; the actual OpenCode listener is
unreachable outside its private namespace. The TUI front door is bound to one supervised TUI process
by a server-scoped `NativeTuiProcessIngressLease`, incarnation-specific credential, and OS
peer/namespace evidence. That process lease permits native create/switch/clear while coordinators are
offline; the runtime owner records each resulting `LocalNativeConversationTransitionRecord` and
atomically rotates the child `NativeTuiSessionIngressBinding` when the active `ses_*` changes. That
child binds the process lease, workspace, local transition cursor, and exact native session; it is
evidence about one target, not an attempt to freeze the TUI onto it. Policy installation is
generation-monotonic and compare-and-swaps the server attachment's current TUI policy pointer after
runtime-owner attestation; stale, unproved, or superseded policies make that front door non-writable.
Exactly one TUI process ingress lease is current per server attachment, and installation
compare-and-swaps `currentTuiProcessIngressLeaseId`; every session child references that current
process lease. Replacement closes the old endpoint/credential and proves already-forwarded mutations
terminal or contained before advancing the pointer, so a second TUI never overlaps.
The adapter front door
accepts only the credential handle and epoch on the current `NativeClientIngressLease` and
`NativeTransportLeaseRecord`, but is dispatch-only rather than a general HTTP proxy. Every mutating
adapter request names the protected authorization reference from the exact current
`NativeFrontDoorDispatchRecord`; it cannot read or supply the raw authorization itself. Immediately
before the socket write, the front door revalidates the
command/effect gate, immutable per-family capability entry, binding/incarnation/session, attachment and
ingress leases, method/path/body and target digests, then performs the same atomic final pre-write
transaction defined above: attempt `claimed → started`, dispatch `not_started → started`, and gate
`(never_started,null) → (started,nativeDeliveryAttemptId)`, while requiring no abandonment record.
That transaction asks the protected owner to consume the matching armed reference. Only a successful
consume returns the raw one-use authorization to the process-local native call; no general lookup can
return it. A current adapter credential without a current dispatch row cannot mutate anything.

Exactly one `NativeClientIngressLease` is current per binding transport lease. Installation fences and
closes the old endpoint/credential, settles or quarantines every old dispatch, and only then
compare-and-swaps `NativeTransportLeaseRecord.currentNativeClientIngressLeaseId`; a uniqueness constraint
forbids two current rows for one attachment lease. A stale credential remains rejected even if its
coordinator is still alive.

Exactly one `NativeServerFrontDoorLease` is current per server attachment/workspace. Installation
closes the old endpoint and credential, then proves every old creation dispatch terminal or
quarantined before compare-and-swapping `currentServerFrontDoorLeaseId`; a uniqueness constraint
forbids two current rows. If an old dispatch already passed `not_started → started`, replacement
cannot make another lease resend it and remains blocked until its outcome is reconciled or contained.
Every creation dispatch revalidates this pointer immediately before its final CAS, so a stale creation
credential cannot write after replacement.

Raw access to the private listener, a second TUI lease, an unclassified third
client, and concurrent old/new adapter writes are rejected. Credentials are random, rotated with their
lease, and stored only in protected runtime-owner custody; journal rows contain opaque handles. The TUI
still sees normal HTTP/SSE semantics, and its mutable requests do not detour through the coordinator.
The TUI authority is not a same-UID bearer token or loopback URL that a model tool can copy. After the
TUI executable has started, the wrapper sends a connected process-bound channel over a private
bootstrap socket with `SCM_RIGHTS`; the pinned TUI transport hook receives it, sets `FD_CLOEXEC`, and
never exposes its descriptor or authorization in argv, environment, cwd, or readable files. Thus the
wrapper-to-TUI exec cannot close the channel prematurely, while later tool execs cannot inherit it.
The front door also checks the exact peer PID/pidfd plus its expected process/cgroup and rejects
descendants, sibling processes, and a reopened connection. The raw private OpenCode listener has a
separate OS boundary: only the exact runtime-owner TUI, adapter, observer, and creation front-door
TGIDs may connect to its socket. The OpenCode server TGID, TUI TGID, model/tool descendants, and every
other same-UID process are denied by an attach-before-run cgroup-BPF/LSM policy keyed to pidfd/start
time and the listener socket inode. Tool processes enter their ordinary user-network namespace before
exec and that namespace has no route, mount, inherited descriptor, proxy, or DNS name for the raw
listener. Release proof launches a tool subprocess that tries the raw listener plus every
TUI/adapter/observer/creation endpoint and the provider-control/inference sockets. If
the pinned OpenCode build lacks the post-exec transport hook (as unmodified 1.17.5 currently does) and
the OS cannot enforce an equivalent exact-process boundary, real-TUI writability is unsupported for
that tuple rather than falling back to a reusable credential.
Differential parity against a direct network-fenced server is a release gate for ordinary TUI
operations. Provider/auth/config **mutations** are the deliberate initial-A2 exception: the
`NativeTuiPolicySnapshot` classifies each exact method/path/query/body operation rejected and returns
its pinned unsupported response. Read operations required by the real TUI are different. The runtime
gives OpenCode a sealed, read-only synthetic HOME/XDG provider/config/auth view containing only
credential-free descriptors for the local remote-claw façades, and the front-door policy may pass an
exact proved TUI read only when its retained response/redaction proof shows no secret or mutable
destination. The initial real-TUI trace and allowlist must include every startup and active-use read,
including dynamic-directory queries, `/global/event`, config/provider/auth descriptors, session
status, commands/agents/models/projects, integrations/MCP/LSP/resources/workspace state, and any
console/location endpoints the pinned build actually calls. A changed or unlisted read fails closed;
classifying an entire provider/config path prefix as safe is forbidden.

The synthetic files are mounted read-only and cannot be replaced through an alternate XDG/HOME,
symlink, or bind mount; the supervisor scrubs provider/proxy/config override variables on every start.
OpenCode and its tool children receive no real provider credential. Below all mutable app
configuration, process-tree network policy redirects the pinned provider façade destination to a
private runtime-owner socket and denies every other provider egress, including DNS, proxy, Unix-socket,
and inherited-fd bypasses. The separately isolated inference connector discards any inner
`Authorization` value and owns the real upstream credential. A tool may retain ordinary user-authorized
network access only in a different identity/namespace that cannot reach the raw native listener, TUI,
adapter, observer, creation, inference-connector, or provider-control sockets. It never installs provider credentials in
OpenCode or changes the fence. remote-claw
orders only the proposals behind its adapter lease, then OpenCode arbitrates those against direct TUI
work and emits the applied native order through history/SSE. An outside-collaborator disconnect cannot
abort the native run, close the shared observer, or detach the TUI. Any client-facing proxy must behave
like a direct OpenCode server connection. Separately, every configured OpenCode model provider is
pointed at a private remote-claw façade and direct provider egress is blocked.

Façade admission is exact-process, not same-UID or descendant authority. On Linux the runtime owner
pins the OpenCode server's pidfd/start-time identity in an attach-before-run cgroup-BPF connect policy;
only that exact TGID (including its threads) may connect to the façade socket, and forked tool TGIDs
are denied even while they share a UID/cgroup. PID reuse is rejected after pidfd exit. The façade
socket is in the owner's private network namespace, has no pathname visible in the tool mount
namespace, and accepts no bearer token from request headers. Equivalent non-Linux enforcement must
prove exact process identity and descendant denial; otherwise that tuple is unsupported. Release tests
attempt direct, proxy, DNS, inherited-fd, Unix-socket, and PID-reuse access from a spawned tool.

Authentication alone never authorizes an arbitrary OpenCode URL. For every **binding-adapter**
mutating method, the front
door resolves the path/body session ID, permission or child object, and any parent relationship through
the ingress lease's exact `nativeBindingId` and `nativeConversationId`. It rejects a valid adapter
credential aimed at another `ses_*`, child, permission, chat, or server scope before forwarding.
Replacing the direct-TUI lease is also a barrier: the runtime owner first closes the old endpoint,
revokes its credential, and proves the supervised old TUI/process plus every forwarded mutable request
stopped or reached a classified terminal outcome. A new TUI lease cannot become current while the old
path could still act.

The adapter allowlist is the exact method/path/body set in the pinned capability entry for the
admitted family. `NativeServerCapabilitySnapshot` and every binding snapshot pin the exact generated
OpenAPI version/digest, the complete callable front-door route manifest, and a retained total
operation-classification table. The real native listener remains unreachable, so an undocumented
native route is not callable merely because it exists in the binary. Startup recomputes the wrapper's
measured front-door registry and remains non-writable if it differs or any callable operation lacks a
classification. Totality covers every TUI, adapter, observer, and creation front-door path, not only
`/doc`: raw/catch-all handlers, path normalization, method override, upgrade/WebSocket paths, PTY
connect, TUI/UI fallback, and side-effectful or ticket-minting `GET` handlers are explicit entries.
Everything else is rejected before a socket to the native listener is opened. HTTP verb alone never
proves read-only. The table is complete for that exposed surface: every operation is
classified as TUI-only, dispatch-gated collaborator work, separately gated runtime management, or
rejected; an unknown route in a newer schema defaults to rejected. In particular,
`PATCH /session/{id}` permission-policy setup, session delete/rename/share, message or part mutation,
shell/revert, auth/credential/config/provider/integration/MCP changes, PTY/worktree/workspace changes,
TUI-control routes on the adapter seam, and every unclassified child mutation are denied by default.
The network fence and provider façade remain in force even on the TUI seam: native auth/config routes
follow that explicit virtualization/unsupported policy and cannot install real provider credentials,
redirect provider egress, or weaken the fence. Simple silent denial is not called transparent parity.

Adapter and creation credentials issue zero reads or SSE subscriptions. They cannot list sessions, read another history or
status, consume global permission/question lists, subscribe to raw server-wide SSE, or open a raw/
upgrade stream. Action-specific read-back is performed by the runtime owner under the separate fenced
`NativeRuntimeObserverLease`, then filtered through the pinned observer schema to the exact workspace,
binding/session, proved children, action ID, and expected fingerprint before it becomes attempt
evidence. The observer's server-wide credential is never exposed to either adapter front door and
cannot mutate. A new session/child is withheld from a chat projection until classification binds it;
unknown lineage creates a gap, not cross-chat output.

Exactly one observer lease is current per server attachment. Installation increments
`observerGeneration` and compare-and-swaps `currentRuntimeObserverLeaseId` after verifying the current
server capability snapshot, listener manifest, workspace, runtime-owner attestation, exact vector of
`proved_read` entries, and filter-policy digest. Its client can call only those exact entries; a
ticket-minting GET, upgrade, raw route, global config/provider/auth read, or unlisted SSE surface is
not proved-read and is denied. Replacement fences the old credential before changing the pointer.
Every observation records the observer generation and pre-filter source digest; filtering happens
before any chat projection, while the unprojected raw evidence remains protected runtime-owner state.
The lease's `capabilitySnapshotAttestationRef` must resolve the exact server snapshot's
`NativeCapabilitySnapshotAttestation`, and its recomputed `signedRecordDigest` must equal
`capabilitySnapshotAttestationDigest`; kind, snapshot ID/schema/digest, runtime, and incarnation all
match. It is not a second untyped runtime-owner locator.

`provedReadOperationVectorDigest` is SHA-256 of
`str("remote-claw/native-observer-proved-read-vector/v1") || uint(count)` followed by the canonical
32-byte-decoded `operationEntryDigest` values in operation-table order. Every value must be a unique
entry from the pinned classification vector whose manifest entry has `frontDoorKind:"observer"`,
`classification:"proved_read"`, and `tuiPolicy:"not_applicable"`; it cannot name a TUI read, upgrade,
ticket-minting read, or mutation. Conversely, the TUI read/reject vectors may name only
`frontDoorKind:"tui"` entries.
`filteringPolicyDigest` is SHA-256 of
`str("remote-claw/native-observer-filtering-policy/v1") || uint(schemaVersion) ||
str(filteringSchemaId) || str(nativeWorkspaceBindingId) ||
bytes(base64urlDecode(topLevelSessionBindingVectorDigest)) ||
str(childLineageClassifierSchemaId) || bytes(base64urlDecode(childLineagePolicyDigest)) ||
str(actionCorrelationSchemaId) || bytes(base64urlDecode(actionCorrelationPolicyDigest)) ||
bytes(base64urlDecode(globalEventRejectionPolicyDigest))`. Each component ref resolves to the exact
canonical bytes that produce its paired digest; historical replay is invalid if any ref is missing.
The top-level vector is ordered by
`(nativeConversationId,nativeBindingId,collaborationServerId,logicalChatId)` and hashes
`str("remote-claw/native-observer-top-level-binding-vector/v1") || uint(count)` followed by all five
string fields of each `NativeObserverTopLevelSessionBindingItem` in declaration order. That commits to
the exact workspace, current top-level session→binding/chat vector, child-lineage classifier/policy,
action-ID/fingerprint correlation policy, and global rejection rules. Any binding, lineage, or policy
change requires a new observer generation and discovery snapshot.

There is exactly one `NativeFilteredObserverObservationRecord` per
`(observerStreamEpochId,observationSeq)`, and its raw digest must equal that immutable raw observation.
Its ID is
`nfo_${base64url(SHA256(str("remote-claw/native-filtered-observation-id/v1") ||
str(nativeRuntimeObserverLeaseId) || str(observerStreamEpochId) || uint(observationSeq)))}`. Its
canonical digest is SHA-256 of
`str("remote-claw/native-filtered-observation/v1") || str(filteredObservationId) ||
optionalStr(collaborationServerId) || uint(observerGeneration) || bytes(base64urlDecode(rawEventDigest)) ||
bytes(base64urlDecode(filteringPolicyDigest)) || str(nativeWorkspaceBindingId) ||
optionalStr(resolvedNativeConversationId) || optionalStr(resolvedChildConversationId) ||
optionalStr(resolvedNativeBindingId) || optionalStr(resolvedLogicalChatId) ||
optionalStr(resolvedNativeActionId) || str(disposition) ||
bytes(base64urlDecode(decisionEvidenceDigest)) || optionalStr(recoveryGapId)`.
`projectable` requires non-null server, native conversation, binding, logical chat, and null gap, all
resolving through the retained top-level/child policy to this server/workspace. `internal_only` has
null logical chat and gap and may have null server for pre-import TUI state. `rejected_global` has
server and every resolved target null and null gap. `gap` has a non-null
recovery gap and cannot project. Filtering and this row commit happen before any projection outbox;
restart resumes the retained decision rather than rerunning a newer filter.

Every last-hop destination is the private socket/origin in the current lease, never a caller `Host`,
absolute-form URI, forwarded-host header, or redirect target. CONNECT, method override, proxy
smuggling, unclassified Upgrade/WebSocket, and automatic retries are disabled. Redirect following is
disabled for every adapter/runtime request; a 3xx is a transport receipt/error to classify, not a
second write or body exfiltration. A TUI-visible OAuth URL may be virtualized as data, but the front
door does not follow it.

The first A2 slice removes the legacy best-effort permission-policy PATCH and advertises structured
permissions as unsupported. A later setup mutation needs its own runtime-scoped capability,
write-ahead effect gate, one-time dispatch, and native policy read-back; it cannot borrow a
collaborator command or startup credential. Teardown likewise cannot abort, delete, rename, or share a
session unless an explicit typed command crosses the corresponding supported family gate.

The initial A2 writable vectors are exact: server-scoped `{new_chat}` and binding-scoped
`{user_text}`. Attachment, clear, set-model, set-mode, end-as-native-mutation, permission answer,
question answer, compact, interrupt, fork, revert/unrevert, shell, session command, message/part
mutation, share, rename, and delete are absent until each has its own retained causal and recovery
proof. Coordinator-only detach/close does not pretend to be a native `end` attempt. Direct TUI use of
native lifecycle methods remains allowed by its pinned TUI policy and becomes post-hoc local
transition/native observation, never a fabricated remote-claw proposal.

OpenCode workspace selection resolves before either front door authorizes a request. The initial
`directoryNormalizationSchemaId` rejects NUL, relative paths, `..`, conflicting case aliases, and
multiple selector values; resolves symlinks once inside the runtime's mount namespace; requires the
resolved object under the configured allowed root; and records platform-specific filesystem identity
without following another link at dispatch. `canonicalDirectoryPathDigest` commits only to the exact
header/path bytes as defined in the common-to-native translation rules above. The separate
`nativeWorkspaceBindingDigest` is:

```text
SHA256(
  str("remote-claw/native-workspace-binding/v1") ||
  str(nativeWorkspaceBindingId) ||
  str(runtimeId) ||
  uint(nativeIncarnation) ||
  str(projectId) ||
  optionalStr(nativeWorkspaceId) ||
  str(directoryNormalizationSchemaId) ||
  bytes(canonicalResolvedDirectoryBytes) ||
  str(filesystemIdentitySchemaId) ||
  bytes(base64urlDecode(filesystemIdentityDigest)) ||
  bytes(base64urlDecode(allowedRootDigest)) ||
  bytes(base64urlDecode(mountNamespaceDigest)) ||
  uint(workspaceGeneration)
)
```

The immutable `NativeWorkspaceBindingRecord` owns the exact path bytes, path digest, and full binding
digest. Its `canonicalDirectoryRef` must decode to `canonicalResolvedDirectoryBytes` and recompute
`canonicalDirectoryPathDigest`; every other field must recompute `nativeWorkspaceBindingDigest`. Every
`workspace`/`directory` query, `x-opencode-directory` header, route-derived selector, lease, snapshot,
request target, and read-back must resolve to its one current record; missing or conflicting aliases,
a replaced directory identity, symlink swap, mount change, wrong workspace, or stale generation
rejects before dispatch.

Every OpenCode discovery snapshot also pins the native store it actually read. The version-specific
`nativeStoreBackendSchemaId` names the measured OpenCode storage layout and the exact extraction rules
for three credential-free immutable refs: the canonical absolute store-root path bytes, a no-follow
filesystem identity for that root, and the database/store instance identity recorded by the native
format. Their digests are:

```text
canonicalNativeStoreRootPathDigest =
  SHA256(str("remote-claw/opencode-native-store-root-path/v1") ||
         bytes(exactCanonicalAbsoluteStoreRootUtf8))

nativeStoreFilesystemIdentityDigest =
  SHA256(str("remote-claw/opencode-native-store-filesystem-identity/v1") ||
         str(nativeStoreBackendSchemaId) ||
         bytes(canonicalNoFollowFilesystemIdentityEvidence))

nativeStoreDatabaseIdentityDigest =
  SHA256(str("remote-claw/opencode-native-store-database-identity/v1") ||
         str(nativeStoreBackendSchemaId) ||
         bytes(canonicalStableDatabaseIdentityEvidence))

stableNativeStoreIdentityDigest =
  SHA256(str("remote-claw/opencode-stable-native-store-identity/v1") ||
         str(nativeStoreBackendSchemaId) ||
         bytes(base64urlDecode(canonicalNativeStoreRootPathDigest)) ||
         bytes(base64urlDecode(nativeStoreFilesystemIdentityDigest)) ||
         bytes(base64urlDecode(nativeStoreDatabaseIdentityDigest)))
```

The database identity is a format-defined stable instance coordinate, not a digest of mutable session
contents, file timestamps, or the current row set. A path alone, process ID, runtime ID, directory
name, workspace ID, database filename, or post-restart content similarity does not qualify. If the
pinned OpenCode build/store backend exposes no stable database identity, cross-incarnation creation
reconciliation is unsupported and deterministically becomes `lineage_unproved`.

`OpenCodeNativeStoreCoordinateRecord.canonicalNativeStoreCoordinateDigest` is:

```text
SHA256(str(nativeStoreCoordinateSchemaId) || uint(schemaVersion) ||
       str(runtimeId) || uint(nativeIncarnation) ||
       str(nativeServerAttachmentLeaseId) || str(nativeWorkspaceBindingId) ||
       str(nativeStoreBackendSchemaId) ||
       bytes(base64urlDecode(canonicalNativeStoreRootPathDigest)) ||
       bytes(base64urlDecode(nativeStoreFilesystemIdentityDigest)) ||
       bytes(base64urlDecode(nativeStoreDatabaseIdentityDigest)) ||
       bytes(base64urlDecode(stableNativeStoreIdentityDigest)))
```

The attachment attestation is deliberately excluded from that coordinate digest, so its signature can
bind the digest without a cycle. `nativeStoreAttachmentAttestationId` is:

```text
nsa_${base64url(SHA256(
  str("remote-claw/opencode-native-store-attachment-attestation-id/v1") ||
  str(runtimeId) || uint(nativeIncarnation) ||
  str(nativeServerAttachmentLeaseId) || str(nativeWorkspaceBindingId) ||
  bytes(base64urlDecode(nativeStoreCoordinateDigest))
))}
```

The read witness digest is SHA-256 of
`str(storeReadWitnessSchemaId) || str(runtimeId) || uint(nativeIncarnation) ||
str(nativeServerAttachmentLeaseId) || bytes(base64urlDecode(nativeStoreCoordinateDigest)) ||
bytes(base64urlDecode(openedStoreHandleIdentityDigest)) ||
bytes(canonicalCredentialFreeStoreReadWitness)`. The witness must come from an actual read through the
still-open no-follow store handle whose identity recomputes the coordinate's filesystem and database
identity evidence; a path lookup, cached value, or child-process claim does not qualify.

The warden's protected continuity registry current-writer digest is:

```text
SHA256(str(continuityRegistrySchemaId) || str(continuityRegistryId) ||
       bytes(base64urlDecode(stableNativeStoreIdentityDigest)) ||
       str("current_writer") || str(runtimeId) || uint(nativeIncarnation) ||
       str(nativeServerAttachmentLeaseId) || uint(currentWriterGeneration))
```

The runtime-owner-signed attachment payload is:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) ||
str(nativeStoreAttachmentAttestationId) || str(assertion) ||
str(runtimeId) || uint(nativeIncarnation) ||
str(nativeServerAttachmentLeaseId) || str(nativeWorkspaceBindingId) ||
str(nativeStoreCoordinateSchemaId) ||
bytes(base64urlDecode(nativeStoreCoordinateDigest)) ||
bytes(base64urlDecode(stableNativeStoreIdentityDigest)) ||
bytes(base64urlDecode(openedStoreHandleIdentityDigest)) ||
str(storeReadWitnessSchemaId) || bytes(base64urlDecode(storeReadWitnessDigest)) ||
str(continuityRegistrySchemaId) || str(continuityRegistryId) ||
uint(currentWriterGeneration) ||
bytes(base64urlDecode(currentWriterRegistrationDigest)) ||
bytes(base64urlDecode(runtimeOwnerTrustAttestationDigest)) ||
str(runtimeOwnerIdentityKeyId) || uint(runtimeOwnerKeyGeneration) ||
uint(signerSequence) || uint(issuedAtMs) ||
str(signatureAlgorithm) || str(canonicalPayloadDigestAlgorithm)
```

`canonicalPayloadDigest` is SHA-256 of those bytes. The current runtime-owner key signs those exact
bytes, and `signedRecordDigest` is SHA-256 of
`str("remote-claw/opencode-native-store-attachment-attestation-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || str(runtimeOwnerIdentityKeyId) ||
uint(runtimeOwnerKeyGeneration) || uint(signerSequence) ||
bytes(base64urlDecode(signature))`. The signature reservation and acceptance row must use
`purpose:"opencode_native_store_attachment_attestation"`; the coordinate and snapshot
`nativeStoreAttachmentAttestationDigest` fields equal that recomputed `signedRecordDigest`.

Each coordinate component ref must decode under the backend schema and recompute its named digest.
The coordinate's runtime/incarnation, attachment, and workspace must match the observer lease that
produced the discovery snapshot. The attachment attestation must parse and verify, repeat the exact
coordinate/stable identity, use assertion `incarnation_opened_and_read_exact_store`, and name the
runtime-owner trust attestation in the server capability snapshot selected by that observer lease.
It must also repeat the protected registry's exact current-writer row for this
runtime/incarnation/attachment and recompute `currentWriterRegistrationDigest`. Its signer
reservation/acceptance must be current for that runtime/incarnation. Thus the attestation proves that
exact owner opened and read the exact coordinate while already registered as its sole writer; merely
storing an owner-attestation digest beside the coordinate is not proof. The coordinate ref retains
that exact immutable record. A complete snapshot requires a valid coordinate and attachment
attestation; neither can be reconstructed after the native incarnation has ended.

An `OpenCodeDiscoverySnapshotRecord` is valid only while that workspace binding and server incarnation
remain current. Its canonical digest is SHA-256 of these exact bytes:

```text
str("remote-claw/opencode-discovery-snapshot/v1")
str(discoverySnapshotId)
str(runtimeId)
uint(nativeIncarnation)
str(nativeWorkspaceBindingId)
str(nativeStoreCoordinateSchemaId)
bytes(base64urlDecode(nativeStoreCoordinateDigest))
bytes(base64urlDecode(stableNativeStoreIdentityDigest))
str(nativeStoreAttachmentAttestationSchemaId)
bytes(base64urlDecode(nativeStoreAttachmentAttestationDigest))
str(nativeRuntimeObserverLeaseId)
uint(observerGeneration)
uint(eventStreamEpoch)
bytes(base64urlDecode(provedReadOperationVectorDigest))
str(linearizationProofKind)
bytes(base64urlDecode(linearizationProofDigest))
optionalUint(postSnapshotBarrierObservationSeq)
str(overlapBufferId)
uint(overlapStartObservationSeq)
uint(overlapEndObservationSeqExclusive)
str(nativeStatusSnapshotId)
bytes(base64urlDecode(statusSnapshotDigest))
bytes(base64urlDecode(orderedSessionVectorDigest))
bytes(base64urlDecode(orderedCreationMarkerVectorDigest))
uint(capturedAtMs)
str(completeness)
```

The snapshot's `nativeStoreCoordinateRef` must parse as
`OpenCodeNativeStoreCoordinateRecord`; its schema, runtime/incarnation, workspace, coordinate digest,
stable identity, and attachment-attestation tuple must equal the snapshot fields exactly. Its
attachment must equal the attachment named by `nativeRuntimeObserverLeaseId`. The snapshot's
attachment-attestation ref must parse as the exact signed record named by the coordinate and recompute
`nativeStoreAttachmentAttestationDigest`. A mismatched or unavailable coordinate, signature, open/read
witness, or attachment attestation forces `completeness:"gap"` and cannot become the current snapshot
used for creation or reconciliation.

`orderedSessionVectorDigest` is SHA-256 of
`str("remote-claw/opencode-discovery-session-vector/v1") || uint(count)`, followed for each item by
`str(sessionId) || optionalStr(parentSessionId) || str(nativeWorkspaceBindingId) ||
uint(createdAtMs) || uint(updatedAtMs) || bytes(base64urlDecode(metadataDigest)) ||
bytes(base64urlDecode(statusDigest))`.
Items are ordered by exact native `sessionId`. `orderedCreationMarkerVectorDigest` is SHA-256 of
`str("remote-claw/opencode-discovery-marker-vector/v1") || uint(count)`, followed by
`uint(schemaVersion) || str(canonicalCreationMetadataSchemaId) ||
str(fullNativeMetadataSchemaId) || str(remoteClawCreationId) ||
optionalDigest(remoteClawCreationIntentDigest) || str(sessionId) ||
str(creationMetadataClassification) || optionalDigest(canonicalCreationMetadataDigest) ||
bytes(base64urlDecode(fullNativeMetadataDigest))`, ordered by
`(remoteClawCreationId, sessionId, fullNativeMetadataDigest)`.

The marker item is not a marker-only index. `fullNativeMetadataRef` retains the exact UTF-8 JSON slice
of the complete native `metadata` value from the proved discovery response, including every extra
member and value without reserialization. It must parse as one JSON object; duplicate member names,
invalid UTF-8/JSON, or an unretainable slice makes the discovery snapshot a gap. Its digest is:

```text
fullNativeMetadataDigest =
  SHA256(str(fullNativeMetadataSchemaId) || uint(schemaVersion) ||
         bytes(exactNativeMetadataUtf8))
```

Every discovery session's `metadataDigest` uses that same digest definition over its retained native
metadata slice. A marker item's `fullNativeMetadataDigest` must equal the corresponding session
item's `metadataDigest`. A marker item exists whenever the parsed object has exactly one valid string
`remoteClawCreationId` member; therefore an object with the expected marker but a missing, malformed,
wrong-type, or extra intent/member is still retained for reconciliation. If the object has a
`remoteClawCreationIntentDigest` string in canonical unpadded base64url that decodes to exactly 32
bytes, the item retains that exact string; otherwise the field is null.

`creationMetadataClassification` is `canonical_two_field` only when the full object has exactly the
two named string members, its intent is a canonical 32-byte digest, and no other member exists. In
that case, and only that case, both canonical ref/digest fields are non-null.
`canonicalCreationMetadataRef` then retains exactly this compact UTF-8 JSON, with the shown key order:

```json
{"remoteClawCreationId":"<remoteClawCreationId>","remoteClawCreationIntentDigest":"<remoteClawCreationIntentDigest>"}
```

The two substitutions use the same strict JSON string and digest encodings as the creation request.
The ref must parse to exactly those two fields, and:

```text
canonicalCreationMetadataDigest =
  SHA256(str(canonicalCreationMetadataSchemaId) || uint(schemaVersion) ||
         str(remoteClawCreationId) ||
         bytes(base64urlDecode(remoteClawCreationIntentDigest)) ||
         bytes(exactCompactUtf8CreationMetadata))
```

For `noncanonical_or_extra`, both canonical ref/digest fields are null; the full ref/digest remains
mandatory and is the evidence that makes the mismatch representable. A valid observed intent on an
extra-member object remains populated but does not make the canonical pair valid. The canonical
ref/digest can never be a two-field projection that discards full-metadata members.
`optionalDigest(null)` is `0x00`; a present digest is `0x01` followed by its decoded 32 bytes. Other
digest fields decode from canonical unpadded base64url to exactly 32 bytes before `bytes`. The two
retained vector refs contain those exact immutable items.

Duplicate native session IDs, duplicate exact
`(remoteClawCreationId,sessionId)` marker items, conflicting full-metadata bytes, or a stream gap force
`completeness: "gap"` and such a row cannot become current. The same marker on distinct native
session IDs is instead retained as multiple items so creation reconciliation can quarantine it.
Snapshot content and `completeness` are immutable; superseding changes only the lifecycle `state`,
which is excluded from `canonicalSnapshotDigest`. Installation compare-and-swaps the server
attachment's current discovery-snapshot pointer.
Creation pins both its snapshot ID and digest, requires byte equality with that current verified row,
and revalidates the workspace/incarnation, current observer lease/generation, stream epoch, and
proved-read vector immediately before dispatch. An empty snapshot from
workspace A can never authorize creation or binding in workspace B.

Conversation recovery/read-back uses a separate binding/session-scoped history snapshot, never the
server-wide discovery list. Each message item digest is SHA-256 of
`str("remote-claw/opencode-history-message/v1") || str(nativeConversationId) ||
str(nativeMessageId) || uint(messageIndex) || str(role) ||
bytes(base64urlDecode(nativeTimestampDigest)) || bytes(base64urlDecode(metadataDigest))`.
The message vector orders contiguous `messageIndex`, then exact message ID, and hashes count plus
decoded item digests under `remote-claw/opencode-history-message-vector/v1`.

Each part item digest is SHA-256 of
`str("remote-claw/opencode-history-part/v1") || str(nativeConversationId) ||
str(nativeMessageId) || str(nativePartId) || uint(messageIndex) || uint(partIndex) ||
str(partType) || str(canonicalPartPayloadSchemaId) ||
bytes(base64urlDecode(canonicalPartPayloadDigest))`. The part ref retains exact credential-free
canonical payload bytes and must parse under that schema. The part vector orders by
`(messageIndex,partIndex,nativePartId)` and hashes count plus decoded item digests under
`remote-claw/opencode-history-part-vector/v1`. Message/part IDs and both index domains are unique;
indices are contiguous within their scope. A part must reference the message at its message index.

`OpenCodeConversationHistorySnapshotRecord.canonicalSnapshotDigest` is SHA-256 of:

```text
str("remote-claw/opencode-conversation-history-snapshot/v1") ||
str(nativeHistorySnapshotId) || str(runtimeId) || uint(nativeIncarnation) ||
str(nativeBindingId) || str(nativeConversationId) || str(nativeWorkspaceBindingId) ||
str(nativeRuntimeObserverLeaseId) || uint(observerGeneration) ||
str(observerStreamEpochId) || str(overlapBufferId) ||
uint(overlapStartObservationSeq) || uint(overlapEndObservationSeqExclusive) ||
str(nativeStatusSnapshotId) || bytes(base64urlDecode(statusSnapshotDigest)) ||
str(linearizationProofKind) || bytes(base64urlDecode(linearizationProofDigest)) ||
optionalUint(linearizedThroughObservationSeq) ||
optionalUint(postSnapshotBarrierObservationSeq) ||
bytes(base64urlDecode(orderedMessageVectorDigest)) ||
bytes(base64urlDecode(orderedPartVectorDigest)) || uint(capturedAtMs) || str(completeness)
```

The snapshot transaction verifies its exact current observer lease/epoch, actively drained overlap,
status snapshot, history response, and retained linearization proof before setting
`completeness:"complete"`. The same watermark/barrier/atomic-store rules as discovery apply. A gap,
overflow, duplicate, bad index/lineage, cross-session item, or stale epoch produces only
`completeness:"gap"`. The immutable snapshot is the recovery authority for exact history and order;
it does not become another transcript or authorize replay. A complete sequence-watermark snapshot has
`linearizedThroughObservationSeq` equal to the non-null sequence certified by its shared watermark and
null `postSnapshotBarrierObservationSeq`. A complete barrier snapshot has both fields non-null and
equal. A complete atomic-store snapshot has both fields null. Any other combination, or a claimed
sequence not covered by the retained proof and current stream epoch, is a gap.

`ProjectTargetSelectorMappingRecord` is the only public-selector resolver. Its ID is
`ptm_${base64url(SHA256(str("remote-claw/project-target-selector/v1") ||
str(collaborationServerId) || str(projectId) || str(workspaceSelectorId) ||
uint(mappingGeneration) || bytes(base64urlDecode(targetDigest))))}`. `targetDigest` is the canonical
digest of exactly one closed union arm: terminal-native includes kind, descriptor, terminal project
ref, and optional workspace binding; nested-server includes kind, current server-scoped nested
management binding, target server/project, and target selector. Its `projectId` must foreign-key one
current `ProjectRecord` in the same server. A nested target whose `targetServerId` equals the mapping's
own `collaborationServerId` is an immediate cycle and fails in the A1.0 parser; longer cycles remain a
rooted-topology installation check. The first mapping is created atomically with that project
under the project's unique allocation intent; later mappings cannot allocate, infer, or resurrect a
project. Exactly one current row may exist for
`(collaborationServerId, projectId, workspaceSelectorId)`. Initial OpenCode A2 forbids one native
workspace binding from being current under two public selectors in the same project. Mapping
replacement is a generation-incrementing compare-and-swap. Each logical chat stores the exact
`projectTargetSelectorMappingId` it selected, so replacement supersedes the prior mapping for future
selection without silently retargeting existing chats. The target logical chat, creation command/
result, and either terminal binding reservation or nested-edge creation all foreign-key the resolved
mapping generation; a stale selector cannot move creation into a replacement directory or server.

The two exact `targetDigest` encodings are:

```text
terminal_native:
  SHA256(str("remote-claw/project-target/terminal-native/v1") ||
         str("terminal_native") || str(descriptor.product) || str(descriptor.access) ||
         str(terminalProjectRef) || optionalStr(nativeWorkspaceBindingId))

nested_server:
  SHA256(str("remote-claw/project-target/nested-server/v1") ||
         str("nested_server") || str(nestedServerManagementBindingId) ||
         str(targetServerId) || str(targetProjectId) || str(targetWorkspaceSelectorId))
```

The tagged arm is parsed before hashing; extra fields, null aliases, a terminal-only field in the
nested arm, or a nested-only field in the terminal arm reject. Every decoded digest is canonical
unpadded base64url SHA-256.

A1.0 implements the strict closed-union and immediate-self-cycle parser and recomputes both
`targetDigest` and the derived `ptm_*` mapping ID. A1.2 implements the same-project foreign key,
one-current-row uniqueness, contiguous-generation compare-and-swap, atomic first-project allocation,
replacement journal/reconciliation, and complete mapping inventory. Its v3 repository accepts only
terminal-native targets; nested-server mappings remain rejected until N1.

Initial A2 allows exactly one current workspace binding per OpenCode server attachment. Multi-workspace
support moves observer/discovery pointers to `(server attachment, workspace)` and is not implied by
this slice. `NativeObserverStreamEpochRecord` is unique on
`(nativeRuntimeObserverLeaseId, eventStreamEpoch)`; every SSE reconnect increments the epoch before
reading a byte and compare-and-swaps `NativeRuntimeObserverLease.currentObserverStreamEpochId`.
Exactly one epoch may be open. Replacement first stops and drains or marks a gap on the old transport,
closes its epoch, and only then installs the higher epoch; a stale tail is retained against the old
epoch and cannot project. Every discovery snapshot and filtered projection revalidates that current
pointer. Each raw event is appended before parsing under unique
`(observerStreamEpochId, observationSeq)`, where local sequence starts at zero and increments
contiguously; the immutable raw ref/digest survives parser failure.

The overlap buffer is unique to that stream epoch and has exact event/byte caps. Overflow, disconnect,
missing local sequence, duplicate native event ID with changed bytes, malformed/unknown event, or
stale-epoch tail is durably retained and atomically sets the stream/buffer to `gap` with a recovery-gap
link; no parser may drop or invent it. A sealed buffer names one contiguous half-open
`[startObservationSeq,endObservationSeqExclusive)` range. Equal bounds represent a proved quiet stream
only when the pinned native linearization proof independently establishes the boundary; an open,
apparently drained transport alone does not mean “no event.”

The status snapshot digest is SHA-256 of
`str("remote-claw/native-observer-status-snapshot/v1") || str(nativeStatusSnapshotId) ||
str(nativeRuntimeObserverLeaseId) || str(observerStreamEpochId) ||
str(nativeWorkspaceBindingId) || optionalUint(capturedThroughObservationSeq) ||
bytes(canonicalStatusBytes)`. Its exact canonical status ref is retained. The discovery transaction
verifies every buffered observation through the exclusive end, merges status/history plus that tail,
and installs the snapshot and current pointer together. Restart resumes those durable records or
starts a higher epoch; it never splices an old tail into a new snapshot.

`completeness:"complete"` additionally requires exactly one retained native linearization proof: a
native sequence watermark shared by snapshot and stream, a post-snapshot barrier event observed on the
same ordered stream, or an atomic native-store snapshot whose transaction boundary is proved to cover
all earlier mutations. `linearizationProofDigest` commits to the exact credential-free proof bytes.
For `barrier_event`, `postSnapshotBarrierObservationSeq` is non-null and lies inside the verified
buffer; for the other kinds it is null. A legacy SSE connection with no replay cursor, watermark,
barrier, or proved atomic-store boundary remains `completeness:"gap"` even when open and drained,
because a pre-snapshot event may still be delayed in transport. The retained 1.17.5 model-free fixture
does not prove such a boundary, so it cannot by itself enable writable A2.

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

The present `evidence-1.17.5.json` remains an honest narrow Phase-0 fixture: it retains `/doc` only as
length/hash plus selected facts and proves marker/caller-ID behavior, not A2. Enabling A2 requires a
separate checked-in sanitized release fixture with the complete generated front-door build manifest,
ordered route/classification vectors, runtime registration attestation, full real-TUI request trace,
synthetic-read/redaction policies, unsupported-response vectors, observer linearization/filter
evidence, creation metadata/restart evidence, and process/network-fence results. It must retain every
canonical byte used by the digests. The narrow proof is not broadened by prose or used as a substitute.

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
while the proof window remains open. Exactly one marker match binds that exact ID only when its
retained full native metadata evidence recomputes, its classification is `canonical_two_field`, and its
canonical two-field metadata recomputes, and its
`remoteClawCreationIntentDigest` equals the reservation's expected `nativeCreationIntentDigest`.
A same-marker wrong/missing/malformed intent or `noncanonical_or_extra` metadata match, and multiple
marker matches, quarantine.
The runtime does not retry or use a marker-only, title, or history match. Typed-intent preservation
and marker durability across native server restart are release proofs.

The empty-snapshot check cannot race the person's TUI. Exactly one current
`NativeWorkspaceTransitionBarrierRecord` exists for the current server attachment/workspace, and its
ID is held by `currentWorkspaceTransitionBarrierId`. Replacement is a generation-incrementing
compare-and-swap after the old active transition is terminal or quarantined. Every direct-TUI
create/import/switch/clear/fork/archive/unarchive and every server-control creation first allocates the next
`NativeWorkspaceTransitionRecord`, compare-and-swaps `activeTransitionId` from null, and records
`started` before the corresponding TUI or creation front door may write a byte. Completion or
contained failure clears that same ID; no other transition can pass while it is active. This barrier
belongs to the independently supervised runtime owner, so direct TUI use still works when the
collaboration coordinator is offline. A pinned TUI operation that can change top-level session
identity, active-session selection, or discovery availability but has no classified transition kind is
rejected at the TUI front door; it cannot bypass this barrier as a generic lifecycle request.

For `first_bootstrap`, the holder re-reads current discovery under that barrier immediately before
dispatch and requires zero top-level sessions, no current or uncertain creation, no prior logical
binding, and `firstBootstrapState:"available"`. The transaction that reserves and prepares the creation
dispatch also changes the state to `claimed`. Any TUI-created/imported session observed before that CAS changes it to
`inapplicable` and rejects bootstrap without a POST. There is no `claimed → available` transition and
no bootstrap successor. While the original reservation is still `reserved`, its dispatch remains
`not_started`, and its original authorization remains unconsumed, recovery may continue only that
exact stored reservation. Explicit pre-send abandonment atomically changes the reservation to
`quarantined` and `firstBootstrapState` from `claimed` to `inapplicable` while rechecking the
still-`not_started` dispatch and `never_started` effect gate; the original authorization then fails
the front door's reservation-state check and no replacement is created. The last pre-byte dispatch CAS
changes `claimed` to `consumed` for `first_bootstrap`. Once the POST may have started, `consumed` is
permanent for that attempt; it cannot return to `available` or authorize a successor. Explicit
`new_chat` uses the same short dispatch serialization but has no empty-workspace precondition, so later
direct and remote creates may coexist in their native observed order. Crash recovery resumes or
quarantines the one active transition before admitting another.

Creation is not an exception to common adjudication. The server-control actor authenticates, orders,
and decides typed `new_chat` exactly once. When its mapping selects this terminal OpenCode runtime, the
decision-reservation transaction allocates the target `logicalChatId` in `recovering` state and freezes
the terminal executor, but creates no native binding, attempt, or output. After the common result is
signed, finalization creates one `NativeBindingRecord(state: "starting")`, one
`NativeConversationCreationReservationRecord`, its command-wide creation effect gate, and the result
delivery. No native `ses_*` is invented. The target chat actor executes that already-decided command
and never readjudicates it. The
reservation pins the current runtime/server incarnation, private server attachment and creation-only
front-door lease, current `NativeServerCapabilitySnapshot` and immutable `new_chat` family entry,
exact discovery snapshot, typed intent,
unique metadata marker, and canonical POST path/body bytes.

The host generates `nativeCreationMarker` as `rcc_` plus canonical unpadded base64url of 16 random
bytes; callers cannot supply it. It is unique on `(runtimeId, nativeIncarnation,
nativeWorkspaceBindingId, nativeCreationMarker)` and is never reused. The intent digest is SHA-256 of
`str("remote-claw/opencode-native-creation-intent/v1") || str(commandId) ||
str(admittingCommandResultId) ||
bytes(base64urlDecode(admittingCommandResultSignedRecordDigest)) ||
bytes(base64urlDecode(canonicalCommandRecordDigest)) ||
bytes(base64urlDecode(decisionEvidenceDigest)) ||
bytes(base64urlDecode(serverCapabilitySnapshotAttestationDigest)) ||
str(canonicalCommandPayloadSchemaId) ||
bytes(base64urlDecode(canonicalCommandPayloadDigest)) ||
bytes(base64urlDecode(nativeRequestTranslatorDigest)) ||
str(collaborationServerId) || str(targetLogicalChatId) || str(projectId) ||
str(workspaceSelectorId) || str(projectTargetSelectorMappingId) ||
uint(projectTargetSelectorMappingGeneration) || bytes(base64urlDecode(projectTargetDigest)) ||
str(runtimeId) || uint(nativeIncarnation) || str(nativeWorkspaceBindingId) ||
bytes(base64urlDecode(canonicalDirectoryPathDigest)) ||
bytes(base64urlDecode(nativeWorkspaceBindingDigest)) || str(creationIntent) ||
str(nativeCreationMarker)`. The proposed OpenCode body is exact compact
JSON `{"metadata":{"remoteClawCreationId":"…","remoteClawCreationIntentDigest":"…"}}` with those keys
in order and no extras. It is not writable until a retained release fixture proves that exact metadata
survives response, SSE/list, and real server restart without changing native semantics. Invalid,
noncanonical, duplicated, caller-chosen, or mismatched marker/intent metadata rejects before
reservation.

The server front door is dispatch-only and accepts `POST /session` only with the one-time authorization
on the matching `NativeCreationFrontDoorDispatchRecord`. It revalidates the admitted-result and
decision/executor-evidence tuple, reservation/effect gate, mapping, capability/translator,
incarnation, attachment, marker, target path, request and translation digests, and recomputes the
request from the common payload plus generated coordinates immediately before its one socket write.
In the last transaction before that first possible byte, it atomically changes the
reservation `reserved → started`, changes the unique creation effect gate
`never_started → started` while naming that reservation, and consumes the authorization while changing
the dispatch `not_started → started`; for `first_bootstrap` it also changes the same barrier's
`firstBootstrapState` from `claimed` to `consumed`. If any compare-and-swap fails, no byte is written; once the
dispatch is started, the POST is treated as may-have-started even if the process dies before the write
is observed. A response binds only its exact returned `ses_*`. After a lost
response, a fresh subscribe/snapshot reconciliation enumerates zero, one, or multiple sessions carrying
the exact expected marker and verifies the retained full native metadata evidence for every candidate.
Zero leaves that started attempt `outcome_unknown` and authorizes no retry or successor; a later
current, complete, exhaustive snapshot may find the original session, but no later observation can
retroactively make the consumed authorization `never_started`. Exactly one candidate atomically fills
the starting binding and marks the logical chat ready only when its
`remoteClawCreationIntentDigest` equals the reservation's expected `nativeCreationIntentDigest` and
its classification is `canonical_two_field` and its canonical metadata ref/digest recompute. A
same-marker/different-intent or `noncanonical_or_extra` candidate, or multiple same-marker candidates,
quarantines. Neither exact
proposal replay, coordinator replacement, nor native replacement sends the POST again. A session
created directly by the TUI remains a native observation followed by explicit import; it is never
backfilled as though remote-claw had admitted its creation.

`NativeCreationFrontDoorDispatchRecord.canonicalDispatchDigest` is SHA-256 of
`str("remote-claw/native-creation-dispatch/v1") || str(nativeCreationReservationId) ||
str(serverFrontDoorLeaseId) || bytes(base64urlDecode(canonicalRequestDigest)) ||
bytes(base64urlDecode(nativeRequestTranslationDigest)) ||
bytes(base64urlDecode(nativeTargetPathDigest)) ||
str(dispatchAuthorizationRef.protectedHandleId) || str(dispatchAuthorizationRef.kind)`. The row stores
only that opaque protected reference; its random authorization remains in protected owner state. The
digest, reservation, and front-door request must all agree before the CAS. Lifecycle fields and
receipts are excluded from this immutable pre-send digest.

The pre-create discovery snapshot need be current only through the dispatch CAS. Its digest commits
the original store coordinate and signed open/read attachment attestation. The creation reservation
stores that exact discovery snapshot ID/digest before dispatch, and the final dispatch CAS revalidates
the same current snapshot; this is the immutable pre-dispatch store anchor and it cannot be supplied
for the first time during recovery. Lost-response recovery creates a
`NativeConversationCreationReconciliationRecord` rather than pretending that old snapshot stayed
current. It binds the original reservation/dispatch to one current successor observer and discovery
snapshot. The successor snapshot must be `completeness:"complete"`, current for that
attachment/workspace/observer epoch, and backed by its retained linearization proof; a gap, stale
pointer, or omitted item cannot create a reconciliation row or bind. Its marker vector is therefore an
exhaustive view at that proved boundary. Same-incarnation reconciliation is direct and uses the
explicit `same_incarnation_not_required` sentinel described below. A different runtime/incarnation
pair requires typed positive native-store lineage showing that the successor read the same stable
marker-and-intent-bearing store; otherwise the decision is deterministically `lineage_unproved`. The
retained marker-match vector contains every session with the expected marker as an
exact `(marker, optional intentDigest, ses_*, classification, optional canonical metadata digest,
full native metadata digest)` entry before intent or shape filtering. Zero marker matches remains
uncertain; one binds only when its intent digest equals the reservation, its classification is
`canonical_two_field`, and both evidence pairs recompute. A wrong/missing/malformed intent,
`noncanonical_or_extra` metadata, or multiple marker matches quarantine; unproved store lineage cannot
bind. No reconciliation state authorizes a second POST.

The retained marker-match vector contains `NativeCreationMarkerMatchItem` values ordered by
`(nativeCreationMarker,nativeConversationId,fullNativeMetadataDigest)`. Every item repeats both schema
IDs, marker, optional observed intent, classification, nullable canonical two-field ref/digest, and
mandatory full native metadata ref/digest from its discovery item. Its digest is SHA-256 of
`str("remote-claw/native-creation-marker-match-vector/v1") || uint(count)` followed by
`uint(schemaVersion) || str(canonicalCreationMetadataSchemaId) ||
str(fullNativeMetadataSchemaId) || str(nativeCreationMarker) ||
optionalDigest(nativeCreationIntentDigest) || str(nativeConversationId) ||
str(creationMetadataClassification) || optionalDigest(canonicalCreationMetadataDigest) ||
bytes(base64urlDecode(fullNativeMetadataDigest))` for each item. Every full metadata ref must parse and
recompute under the exact encoding above. The canonical ref/digest pair must be non-null and recompute
only for `canonical_two_field`; it must be all-null for `noncanonical_or_extra`.
`markerMatchCount` equals the retained vector length exactly.

Cross-incarnation store identity equality is necessary but not sufficient: a copied, reset, or forked
store can preserve every embedded identifier. The runtime warden therefore keeps one continuity
registry outside the native store, keyed by `stableNativeStoreIdentityDigest`, with exactly one
current writer and a monotonic generation. The predecessor-fence registry transition digest is:

```text
SHA256(str(continuityRegistrySchemaId) || str(continuityRegistryId) ||
       bytes(base64urlDecode(stableNativeStoreIdentityDigest)) ||
       str("current_writer_to_fenced") ||
       str(originalRuntimeId) || uint(originalNativeIncarnation) ||
       str(originalNativeServerAttachmentLeaseId) ||
       uint(originalCurrentWriterGeneration) ||
       bytes(base64urlDecode(originalCurrentWriterRegistrationDigest)) ||
       uint(predecessorFenceGeneration))
```

`originalCurrentWriterGeneration` and `originalCurrentWriterRegistrationDigest` must equal the
pre-dispatch attachment attestation pinned by the reservation's discovery snapshot, and
`predecessorFenceGeneration` must equal `originalCurrentWriterGeneration + 1`. Thus a registry first
invented during recovery cannot satisfy the predecessor CAS.

The predecessor evidence ID is
`nspf_${base64url(SHA256(str("remote-claw/opencode-native-store-predecessor-stop-fence-id/v1") ||
str(originalRuntimeId) || uint(originalNativeIncarnation) ||
bytes(base64urlDecode(originalNativeStoreCoordinateDigest)) ||
uint(predecessorFenceGeneration)))}`. Its definitive-stop evidence digest is SHA-256 of
`str(definitiveStopEvidenceSchemaId) ||
bytes(canonicalCredentialFreeDefinitiveProcessStopEvidence)`. That version-pinned evidence must prove
the exact process-start identity exited or was killed, its private listener namespace was contained,
and no open file description for the attested store handle remains in that predecessor. A timeout,
missing PID, reused PID, socket close, coordinator lease expiry, or process-name scan is not definitive.

The predecessor runtime-owner/warden signs this exact payload only after the registry CAS above and
definitive stop both succeed:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) ||
str(predecessorStopFenceEvidenceId) || str(assertion) ||
str(originalRuntimeId) || uint(originalNativeIncarnation) ||
str(originalNativeServerAttachmentLeaseId) ||
bytes(base64urlDecode(originalNativeStoreCoordinateDigest)) ||
bytes(base64urlDecode(originalNativeStoreAttachmentAttestationDigest)) ||
bytes(base64urlDecode(stableNativeStoreIdentityDigest)) ||
bytes(base64urlDecode(stoppedProcessStartIdentityDigest)) ||
bytes(base64urlDecode(closedStoreHandleIdentityDigest)) ||
str(continuityRegistrySchemaId) || str(continuityRegistryId) ||
uint(originalCurrentWriterGeneration) ||
bytes(base64urlDecode(originalCurrentWriterRegistrationDigest)) ||
uint(predecessorFenceGeneration) ||
bytes(base64urlDecode(continuityRegistryTransitionDigest)) ||
str(definitiveStopEvidenceSchemaId) ||
bytes(base64urlDecode(definitiveStopEvidenceDigest)) ||
str(runtimeOwnerIdentityKeyId) || uint(runtimeOwnerKeyGeneration) ||
uint(signerSequence) || uint(fencedAtMs) ||
str(signatureAlgorithm) || str(canonicalPayloadDigestAlgorithm)
```

`canonicalPayloadDigest` is SHA-256 of those bytes. `signedRecordDigest` is SHA-256 of
`str("remote-claw/opencode-native-store-predecessor-stop-fence-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || str(runtimeOwnerIdentityKeyId) ||
uint(runtimeOwnerKeyGeneration) || uint(signerSequence) ||
bytes(base64urlDecode(signature))`. The signature reservation/acceptance purpose is exactly
`opencode_native_store_predecessor_stop_fence`; every downstream
`predecessorStopFenceEvidenceDigest` equals that recomputed `signedRecordDigest`.

Only after that fence is retained may the successor open the store. Its registry transition is:

```text
SHA256(str(continuityRegistrySchemaId) || str(continuityRegistryId) ||
       bytes(base64urlDecode(stableNativeStoreIdentityDigest)) ||
       str("fenced_to_current_writer") ||
       bytes(base64urlDecode(predecessorStopFenceEvidenceDigest)) ||
       str(successorRuntimeId) || uint(successorNativeIncarnation) ||
       str(successorNativeServerAttachmentLeaseId) ||
       uint(predecessorFenceGeneration) || uint(successorExclusiveOpenGeneration))
```

`successorExclusiveOpenGeneration` must equal `predecessorFenceGeneration + 1`. The successor evidence
ID is
`nseo_${base64url(SHA256(str("remote-claw/opencode-native-store-successor-exclusive-open-id/v1") ||
str(successorRuntimeId) || uint(successorNativeIncarnation) ||
bytes(base64urlDecode(successorNativeStoreCoordinateDigest)) ||
bytes(base64urlDecode(predecessorStopFenceEvidenceDigest)) ||
uint(successorExclusiveOpenGeneration)))}`. `conflictingWriterScanDigest` is SHA-256 of
`str(conflictingWriterScanSchemaId) ||
bytes(canonicalCredentialFreeConflictingWriterScanEvidence)` resolved from the immutable
`conflictingWriterScanRef`. The scan runs under the warden's version-pinned host/namespace policy after
the predecessor fence and proves no other process or attachment holds a writer-capable handle to that
exact store object.

The successor runtime owner signs:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) ||
str(successorExclusiveOpenEvidenceId) || str(assertion) ||
str(successorRuntimeId) || uint(successorNativeIncarnation) ||
str(successorNativeServerAttachmentLeaseId) ||
bytes(base64urlDecode(successorNativeStoreCoordinateDigest)) ||
bytes(base64urlDecode(successorNativeStoreAttachmentAttestationDigest)) ||
bytes(base64urlDecode(stableNativeStoreIdentityDigest)) ||
bytes(base64urlDecode(openedStoreHandleIdentityDigest)) ||
str(continuityRegistrySchemaId) || str(continuityRegistryId) ||
bytes(base64urlDecode(predecessorStopFenceEvidenceDigest)) ||
uint(predecessorFenceGeneration) || uint(successorExclusiveOpenGeneration) ||
bytes(base64urlDecode(continuityRegistryTransitionDigest)) ||
str(conflictingWriterScanSchemaId) ||
bytes(base64urlDecode(conflictingWriterScanDigest)) ||
str(runtimeOwnerIdentityKeyId) || uint(runtimeOwnerKeyGeneration) ||
uint(signerSequence) || uint(openedAtMs) ||
str(signatureAlgorithm) || str(canonicalPayloadDigestAlgorithm)
```

Its payload digest is SHA-256 of those bytes, and its `signedRecordDigest` is SHA-256 of
`str("remote-claw/opencode-native-store-successor-exclusive-open-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || str(runtimeOwnerIdentityKeyId) ||
uint(runtimeOwnerKeyGeneration) || uint(signerSequence) ||
bytes(base64urlDecode(signature))`. Its signature reservation/acceptance purpose is exactly
`opencode_native_store_successor_exclusive_open`; every downstream
`successorExclusiveOpenEvidenceDigest` equals that recomputed `signedRecordDigest`.

The version-one continuity proof ID is:

```text
nsh_${base64url(SHA256(
  str("remote-claw/opencode-native-store-continuity-handoff-id/v1") ||
  str(nativeCreationReservationId) ||
  bytes(base64urlDecode(originalNativeStoreCoordinateDigest)) ||
  bytes(base64urlDecode(successorNativeStoreCoordinateDigest)) ||
  bytes(base64urlDecode(predecessorStopFenceEvidenceDigest)) ||
  bytes(base64urlDecode(successorExclusiveOpenEvidenceDigest))
))}
```

Its canonical digest is:

```text
SHA256(str(nativeStoreContinuityProofSchemaId) || uint(schemaVersion) ||
       str(nativeStoreContinuityProofId) || str(proofKind) ||
       str(continuityAssertion) || str(nativeCreationReservationId) ||
       str(originalRuntimeId) || uint(originalNativeIncarnation) ||
       bytes(base64urlDecode(originalNativeStoreCoordinateDigest)) ||
       bytes(base64urlDecode(originalNativeStoreAttachmentAttestationDigest)) ||
       str(successorRuntimeId) || uint(successorNativeIncarnation) ||
       bytes(base64urlDecode(successorNativeStoreCoordinateDigest)) ||
       bytes(base64urlDecode(successorNativeStoreAttachmentAttestationDigest)) ||
       bytes(base64urlDecode(stableNativeStoreIdentityDigest)) ||
       str(continuityRegistrySchemaId) || str(continuityRegistryId) ||
       str(predecessorStopFenceEvidenceSchemaId) ||
       bytes(base64urlDecode(predecessorStopFenceEvidenceDigest)) ||
       str(successorExclusiveOpenEvidenceSchemaId) ||
       bytes(base64urlDecode(successorExclusiveOpenEvidenceDigest)) ||
       uint(predecessorFenceGeneration) || uint(successorExclusiveOpenGeneration) ||
       bytes(base64urlDecode(predecessorRegistryTransitionDigest)) ||
       bytes(base64urlDecode(successorRegistryTransitionDigest)))
```

The proof ref must parse as exactly `OpenCodeNativeStoreContinuityHandoffProofRecord`; its
`canonicalNativeStoreContinuityProofDigest` and every downstream
`nativeStoreContinuityProofDigest` must equal the recomputed digest above. Both signed subrecords must
parse and verify under their named, accepted runtime-owner
keys; their runtime/incarnation, attachment, coordinate, store-attachment attestation, stable identity,
registry, generations, transition digests, and handle identities must match the original/successor
snapshots and each other. The predecessor's closed-handle identity and successor's opened-handle
identity must identify the same store object already committed by both coordinates. The registry CAS
must be linear: one current predecessor, then fenced, then exactly one successor at the next
generation, with no reset, generation reuse, skipped transition, parallel writer, clone adoption, or
fork branch. The predecessor attachment's current-writer generation/digest must equal the fence
record's CAS input; the successor attachment's current-writer generation must equal
`successorExclusiveOpenGeneration` and its current-writer digest must recompute from the successor CAS
output. The predecessor attachment attestation must precede its fence; the successor
attachment-attestation/open-read witness must be created only after that fence and must precede the
signed exclusive-open record. Signed timestamps are consistency checks, while the protected registry
CAS is the authoritative ordering boundary. `proofKind` is `exclusive_warden_handoff` and
`continuityAssertion` is exactly
`same_store_no_reset_no_fork`; an assertion without the two verified transitions and signed evidence
does not qualify.

For cross-incarnation proof, `nativeStoreLineageEvidenceId` is:

```text
nsl_${base64url(SHA256(
  str("remote-claw/opencode-native-store-lineage-evidence-id/v1") ||
  str(nativeCreationReservationId) ||
  str(originalDiscoverySnapshotId) ||
  str(successorDiscoverySnapshotId)
))}
```

The exact evidence digest is:

```text
canonicalNativeStoreLineageEvidenceDigest =
  SHA256(str(nativeStoreLineageEvidenceSchemaId) || uint(schemaVersion) ||
         str(nativeStoreLineageEvidenceId) || str(nativeCreationReservationId) ||
         str(proofKind) ||
         str(originalRuntimeId) || uint(originalNativeIncarnation) ||
         str(originalDiscoverySnapshotId) ||
         bytes(base64urlDecode(originalDiscoverySnapshotDigest)) ||
         str(originalNativeStoreCoordinateSchemaId) ||
         bytes(base64urlDecode(originalNativeStoreCoordinateDigest)) ||
         str(successorRuntimeId) || uint(successorNativeIncarnation) ||
         str(successorDiscoverySnapshotId) ||
         bytes(base64urlDecode(successorDiscoverySnapshotDigest)) ||
         str(successorNativeStoreCoordinateSchemaId) ||
         bytes(base64urlDecode(successorNativeStoreCoordinateDigest)) ||
         bytes(base64urlDecode(stableNativeStoreIdentityDigest)) ||
         str(nativeStoreContinuityProofSchemaId) ||
         bytes(base64urlDecode(nativeStoreContinuityProofDigest)))
```

The immutable evidence ref must parse as exactly
`OpenCodeNativeStoreLineageEvidenceRecord` and recompute that digest; the reconciliation's evidence
schema ID and digest must equal the record's schema ID and
`canonicalNativeStoreLineageEvidenceDigest`. Its proof kind is exactly
`exclusive_continuity_handoff`; the original and successor runtime/incarnation pairs must differ. The
original fields, snapshot ID/digest,
and coordinate ref/digest must equal the creation reservation and its pinned original discovery
snapshot. The successor fields, snapshot ID/digest, and coordinate ref/digest must equal the
reconciliation's current complete successor snapshot. Both coordinate refs must parse, recompute, and
carry the one
`stableNativeStoreIdentityDigest` repeated by the evidence. Their backend schema, canonical root,
filesystem identity, and database identity digests must all be equal; equality of only the derived
stable digest without those component checks is insufficient. The continuity proof ref/digest must
parse and verify under the exact handoff contract above and repeat both coordinate digests and the
stable identity. Marker and intent deliberately remain outside this store-lineage proof: the
reconciliation record, successor snapshot, and marker-match vector bind and verify them separately,
avoiding a circular or duplicated lineage coordinate.

`nativeStoreLineageStatus` has these exact representations:

- `same_incarnation_not_required` requires identical original and successor `(runtimeId,
  nativeIncarnation)` pairs, exact equality of their snapshot-pinned store coordinate schema/digest and
  stable store identity, and an all-null evidence schema/ref/digest triple. A same-incarnation store
  coordinate change is a recovery gap and cannot bind through this sentinel.
- `cross_incarnation_proved` requires different pairs and the all-non-null exact schema/ref/digest
  triple above, including the verified continuity handoff. Equal coordinate or embedded store identity
  without that handoff is not proved.
- `cross_incarnation_unproved` requires different pairs and an all-null evidence schema/ref/digest
  triple. A missing, malformed, stale, mismatched, or unsupported proof is retained only as diagnostic
  failure evidence outside the positive slot and normalizes to this status.

A mixed-null triple, evidence on the same-incarnation sentinel, or `proved` without a valid record
invalidates the reconciliation row rather than changing its decision.

Reconciliation runs under the reservation/effect-gate lock. Its sequence is allocated from
`nextReconciliationSeq`; the ID is
`ncr_${base64url(SHA256(str("remote-claw/native-creation-reconciliation/v1") ||
str(nativeCreationReservationId) || uint(reconciliationSeq) ||
str(successorDiscoverySnapshotId)))}`. The database is unique on both
`(nativeCreationReservationId,reconciliationSeq)` and
`(nativeCreationReservationId,successorDiscoverySnapshotId)`. `originalDispatchDigest` must equal the
dispatch row's canonical digest. `originalRuntimeId`, `originalNativeIncarnation`, and the original
snapshot ID/digest must equal the creation reservation's runtime/incarnation and pinned discovery
snapshot. `expectedNativeCreationMarker` and `expectedNativeCreationIntentDigest` must equal the
reservation and are immutable inputs to the reconciliation digest.

Decision precedence is exact. `cross_incarnation_unproved` requires `lineage_unproved` and a null
observed ID regardless of marker count or contents; neither of the other lineage statuses may choose
`lineage_unproved`. With `same_incarnation_not_required` or `cross_incarnation_proved`, a zero count
requires `zero_uncertain` and null observed ID; it is nonterminal and may be superseded by a later
sequence. Count one requires `bind_one` and the one exact native ID only if that item's marker and
intent digest both equal those expected values, its classification is `canonical_two_field`, and its
canonical and full metadata ref/digest pairs both recompute. A same-marker
wrong/missing/malformed intent or `noncanonical_or_extra` metadata item requires `metadata_mismatch`
and null observed ID; count greater than one requires `quarantine_many` and null observed ID regardless
of each item's classification.
The first validated `bind_one`, `metadata_mismatch`, `quarantine_many`, or `lineage_unproved`
compare-and-swaps the
reservation's current reconciliation and effect/binding terminal state atomically; later conflicting
rows are rejected rather than racing the winner.

The immutable reconciliation digest is:

```text
SHA256(str(positiveReadBackSchemaId) || uint(schemaVersion) ||
       str(nativeCreationReconciliationId) || str(nativeCreationReservationId) ||
       str(expectedNativeCreationMarker) ||
       bytes(base64urlDecode(expectedNativeCreationIntentDigest)) ||
       uint(reconciliationSeq) || str(originalRuntimeId) || uint(originalNativeIncarnation) ||
       str(originalDiscoverySnapshotId) ||
       bytes(base64urlDecode(originalDiscoverySnapshotDigest)) ||
       bytes(base64urlDecode(originalDispatchDigest)) ||
       str(successorRuntimeId) || uint(successorNativeIncarnation) ||
       str(successorObserverLeaseId) || str(successorDiscoverySnapshotId) ||
       bytes(base64urlDecode(successorDiscoverySnapshotDigest)) ||
       str(nativeStoreLineageStatus) ||
       optionalStr(nativeStoreLineageEvidenceSchemaId) ||
       optionalDigest(nativeStoreLineageEvidenceDigest) ||
       bytes(base64urlDecode(markerMatchVectorDigest)) || uint(markerMatchCount) ||
       str(decision) || optionalStr(observedNativeConversationId))
```

The original and successor discovery plus marker-vector ref/digest pairs must parse and recompute
before this row can change the reservation. The lineage ref/digest must do so exactly when status is
`cross_incarnation_proved`; the two null-sentinel statuses follow the rules above. Its positive
read-back schema equals the selected family and reservation; a schema/ref/digest substitution, same-ID
changed row, cross-reservation store proof, or cross-reservation marker proof is invalid.

The creation reservation and effect gate are each unique on `commandId`; the reservation is also
unique on `(collaborationServerId, targetLogicalChatId)`,
`(runtimeId, nativeIncarnation, nativeCreationMarker)`, and `provisionalNativeBindingId`. Its target
digest is:

```text
SHA256(
  str("remote-claw/native-creation-target/v1") ||
  str(descriptor.product) ||
  str(descriptor.access) ||
  str(runtimeId) ||
  uint(nativeIncarnation) ||
  str(nativeServerAttachmentLeaseId) ||
  str(serverFrontDoorLeaseId) ||
  str(projectId) ||
  str(nativeWorkspaceBindingId) ||
  bytes(base64urlDecode(canonicalDirectoryPathDigest)) ||
  bytes(base64urlDecode(nativeWorkspaceBindingDigest)) ||
  str(creationIntent) ||
  str(nativeCreationMarker) ||
  str(nativeMethod) ||
  str(nativeRouteSchemaId) ||
  bytes(canonicalRouteParameterBytes)
)
```

Its request digest uses the separate domain
`remote-claw/native-creation-request/v1`, the pinned `canonicalRequestSchemaId`, and the exact
credential-stripped request bytes. Neither digest contains a fake session ID. The dispatch CAS
revalidates the current server attachment/front-door lease, server capability pointer, exact
`new_chat` family digest, discovery snapshot, marker, and both digests. The bind transaction creates
the `LocalNativeConversationRecord`/mapping, fills the starting binding with the one observed `ses_*`,
marks the creation effect complete, and changes the logical chat to `ready` together; no partial bind
is writable.

One limitation is load-bearing: `prompt_async` returns HTTP 204 without a response-assigned native
command/message ID, but pinned `1.17.5` accepts a caller-supplied native `msg_*`. The adapter persists a
unique valid ID before delivery and sends it once. Exact history/SSE read-back of that ID is positive
correlation. The retained [OpenCode native proof](opencode-native-proof.md) uses `noReply:true`, one
server incarnation, and no provider/model reply; in that narrow mode the same-ID second POST appends
another part. It proves the caller-ID and duplicate-append facts only. It does **not** prove the
selected A2 translator, which omits `noReply` and `model`, nor the private provider façade, assistant
completion, direct-TUI concurrency, or restart path. OpenCode `{user_text}` therefore cannot be
advertised writable for A2 until one retained release fixture sends the exact selected request through
that full path and passes the read-back/restart matrix: same-incarnation adapter/coordinator restart
must retain positive read-back, while native-server restart must quarantine under the selected
version-one oracle. A lost response is never blindly retried and
absence remains inconclusive until a proved terminal boundary. Text matching is not evidence. For text
and every future compact, interrupt, permission, or question capability, coordinator admission is only
permission to try; native
history/events/status and stable native IDs establish whether, where, and in what order OpenCode
applied the action.

Before the common actor decides an OpenCode **chat/binding-scoped** proposal, it pins the current
`NativeBindingCapabilitySnapshot`. Server-control `new_chat` instead resolves its selector and pins
either the terminal `NativeServerCapabilitySnapshot` or nested-management capability before any
binding exists. The binding snapshot's immutable family entry pins support, route/method schema,
request schema, transport-receipt meaning, action-ID requirement, positive and negative read-back,
source-causality strength, and
versioned reserved-command normalization table are part of the decision and the one native attempt.
That table recognizes reserved input before generic text even when its family is unsupported; it is
not the advertised-writable set. The viewer deterministically advertises only table items whose
normalized family also has a current entry in the snapshot's `familyCapabilities`. Blank user text is rejected unless
the pinned tuple proves native blank-submit behavior. Exact `/compact`, `/clear`, `/model`, `/context`,
and any other advertised reserved command are normalized to their typed operation before generic
`user` admission; a missing mapping is a stored unsupported rejection. The adapter may not discover
after `accepted` that text was really a control. Snapshot replacement or proof downgrade cannot make a
previously unsupported attachment/control writable, and an attempt cannot be recovered under a newer
snapshot merely because its request looks similar.

For A2, `/compact`, `/clear`, `/model`, `/context`, and every unproved command remain in the reserved
normalization table but are absent from the advertised-writable set and deterministically rejected.
`/clear` cannot become writable until it executes the
typed `clear` family together with the `LocalNativeConversationTransitionRecord(kind: "clear")` and
coordinator logical-chat identity transaction; it must never fall through as literal model text.

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
it terminal, otherwise another proved native gate record wins. The A0.2 compatibility client now uses
retained `POST /permission/{requestID}/reply` with `{reply}` and requires successful JSON to be the
literal value `true`; malformed JSON, false, or any other value fails closed. That remains transport
acknowledgement, not native adjudication: the global route does not prove selected-session ownership,
which actor won a TUI/remote race, or terminal gate state. Lost or mismatched replies remain rejected or
`outcome_unknown`, and every outward gate copy closes from the proved native terminal record.
Additional pending-list routes must likewise be schema-pinned and runtime-probed rather than
reimplemented from guesses.

Parent-session policy setup does not validate child sessions: the current post-creation PATCH can lose
a race to a child's first tool. A0.2 now passes the run cancellation signal to each child setup, tracks
the task, fences PATCH after cancellation, and joins it under the shared bounded teardown; those
lifecycle guarantees do not close the first-tool race. Shared structured permissions therefore require
an atomically inherited owned-session policy or must advertise child tools ungated and unsupported. In
the first A2 slice, `permission_answer` is absent from the capability vector and receives the same
stored unsupported result as every other unavailable family; the dispatch-only adapter front door
cannot reach the reply or policy endpoints.

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
post-acceptance attribution rather than a pre-execution source identity. Current A0.2 startup opens a
process-local `starting` lease, scrubs inherited Claude session variables, creates an owner-only
per-launch runtime and private tmux socket, writes the merged settings and launcher outside tmux argv,
and streams prompt text to `load-buffer` over stdin. It rejects hook-disabling modes and unmergeable
settings rather than launching without its readiness proof. A positive pane probe plus the required
SessionStart marker must identify the expected native session before it publishes capabilities or
creates a broker client and announcement. Native capture, injection, and permission pumps may exist
before publication, but without that broker path no remote mutation can reach the pane. The current
registration deliberately keeps `nativeRef:null`; it is readiness, not a durable native binding.

Paste and Enter remain separate possible side effects. A tmux command error can arrive after the
server applied paste or Enter, so automatic retry is unsafe. Before the first send, the target writes
ahead the source/attempt, transcript cursor, pane/process identity, and intended payload. Tmux success
is only control receipt; native application and source require a correlated Claude transcript
UUID/row. Identical text does not prove either fact.

A persistent process owner may reattach a surviving pane using saved pane/process identity,
Claude session ID, transcript path, inode, and offset. If it cannot prove whether an injected command
started, that command becomes `outcome_unknown`.

The current PreToolUse helper is a remote viewer gate, not a native TUI-versus-remote first-winner
surface. A person at the pane has no equivalent local answer path through that helper. If decision-file
persistence fails, the helper may remain blocked; the current decision callback throws and the
injection pump withholds its relay ACK. Structured permission parity remains unsupported until a
durable local decision seam and native terminal observation exist.

`/compact` remains the same chat only when its native identity proves that; `/clear` starts a new
chat, and `/branch` creates fork lineage. Hook scratch paths, request/decision cursors, and orphaned
permission gates are recovery state. Current wrapper teardown settles pumps and its lease/relay under
one deadline, then tries to kill the pane with the remaining time. It removes the private runtime only
after termination is proved and otherwise retains the socket and owner-only artifacts, but it cannot
durably reattach after wrapper restart. The target graceful stop instead makes keep-pane versus
kill-pane an explicit persisted policy; closing a chat lease alone does neither.

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
After authenticating its stable source event, a server gives an inward proposal that already traversed
it or its inward edge an ordered rejected common result; the source can therefore finish its started
attempt. It drops only unauthenticated/malformed transport without semantic ACK. It drops an outward
observation that already traversed the same outward edge and never promotes an outward observation or
echo into an inward proposal. These rules make recursive composition possible without suppressing
replies or creating feedback loops.

Ordinary nested chat mutation uses the same common adjudication boundary, not a direct edge send.
`NestedChatEdgeCapabilitySnapshot.familyCapabilitiesRef` retains one
`NestedChatEdgeFamilyCapability` per supported family in `NativeMutationFamily` order. Each family
digest is SHA-256 of
`str("remote-claw/nested-chat-edge-family/v1") || str(mutationFamily) ||
str(canonicalCommandPayloadSchemaId) ||
str(targetRequestSchemaId) ||
str(targetReceiptProofSchemaId) ||
str(acknowledgement)`. The vector digest uses
`str("remote-claw/nested-chat-edge-family-vector/v1") || uint(count)` followed by each decoded family
digest. The snapshot digest is:

```text
SHA256(str(canonicalSnapshotSchemaId) || uint(schemaVersion) ||
       str(nestedChatEdgeCapabilitySnapshotId) || str(inwardEdgeId) ||
       str(inwardLiveLeaseId) || uint(sourceTopologyGeneration) ||
       uint(targetTopologyGeneration) || str(targetOutsideBindingId) ||
       str(targetSourceEventNamespaceId) || uint(capabilityGeneration) ||
       bytes(base64urlDecode(familyCapabilityVectorDigest)) ||
       bytes(base64urlDecode(proofDigest)) || uint(verifiedAtMs))
```

The family and proof refs must parse to the exact bytes behind their digests. Installation
compare-and-swaps `InwardCollaborationEdgeRecord.currentCapabilitySnapshotId`; state is excluded from
the immutable digest. The decision executor evidence and semantic delivery attempt repeat the
snapshot ID and digest, while the command repeats the selected family digest. The snapshot is valid
only for that installed edge, both topology generations, its named current live lease, target outside
binding/namespace, and current pointer. A same-ID content change, ref/digest substitution, or stale
lease/topology is equivocation and cannot reach joint finalization or send.

The family has two different schema commitments. `canonicalCommandPayloadSchemaId` is the
source-independent common payload accepted by the target for that mutation family;
`targetRequestSchemaId` is the nested wire envelope parsed at the target boundary. They must never be
substituted for one another. The admitted command and delivery attempt repeat the exact common payload
schema/ref/digest, and that schema must equal the selected family entry. The source-local refs are not
sent as authority. Instead, every nested chat attempt retains one portable
`NestedCommandPayloadTransferBundleRecord` whose exact bytes are:

```text
str(canonicalPayloadTransferSchemaId) || uint(schemaVersion) ||
str(mutationFamily) || str(canonicalCommandPayloadSchemaId) ||
bytes(exactCanonicalCommandPayloadBytes) ||
uint(attachmentTransferItemCount) ||
for item in itemIndex order:
  bytes(exactCanonicalAttachmentItemBytes) ||
  bytes(exactDecodedContentBytes)
```

`canonicalPayloadTransferSchemaId` is
`remote-claw/nested-command-payload-transfer/v1`, and
`canonicalPayloadTransferDigest` is SHA-256 of those exact bytes.
`canonicalCommandPayloadBytesRef` resolves the exact bytes already committed by the admitted
command's `canonicalCommandPayloadDigest`; the bundle's family, payload schema, and payload digest
must equal the command, attempt, and selected family. For every family other than `attachment`,
version one requires `attachmentTransferItemCount:0` and
`attachmentTransferItemsRef:null`. Any future common payload with subordinate blobs requires a new
transfer schema version rather than treating a local ref as portable.

For `attachment`, the count is the payload's nonzero `itemCount` and
`attachmentTransferItemsRef` resolves contiguous
`NestedAttachmentPayloadTransferItemRecord` values starting at zero. Each
`exactCanonicalAttachmentItemBytes` is exactly:

```text
str(canonicalItemSchemaId) || uint(1) || uint(itemIndex) ||
str(clientFileName) || str(mediaType) || uint(contentLength) ||
bytes(base64urlDecode(contentDigest))
```

Its SHA-256 must equal both the transfer item's `canonicalAttachmentItemDigest` and the corresponding
source `CanonicalAttachmentItemRecord.canonicalItemDigest`.
`exactDecodedContentBytes` must have exactly `contentLength` bytes and hash to `contentDigest`.
Recomputing the ordered item digests must reproduce the common payload's `itemVectorDigest`; the
payload count, transfer count, item indices, filenames, media types, lengths, and content digests must
all agree. The target validates all common attachment limits before it materializes target-local
payload/item/content refs. A missing byte, source-local ref, extra item, reordered item, noncanonical
item bytes, changed schema, or digest mismatch rejects before target source-event normalization.

For an admitted `nested_chat_edge` command, the decision transaction derives
`requiredFinalizationArtifactKind:"nested_chat_event_lineage_hop"`, builds the exact semantic envelope
core below, and pre-reserves one `NestedChatEventLineageHopPreparationRecord` under the same
compound signing group as the common result. The decision transaction only reserves its sequence; the
signer later binds the exact core payload. That hop's `canonicalEnvelopeSchemaId` and
`canonicalEnvelopeDigest` are the core schema/digest, not the later wire envelope. After both
signatures are durable, one joint finalizer rechecks and inserts the common result, signed hop and
completed `EventLineageRecord`, wire envelope, source outbox, exactly one
`NestedChatDeliveryEffectGateRecord`, and exactly one stable
`NestedChatDeliveryAttemptRecord`. No result ACK, attempt, or effect gate exists before that commit.
Crash, secondary-preparation replacement, signing-lease rotation blocking, and racing-finalizer rules
are the same compound-group rules as nested management.

The stable attempt is unique on both `commandId` and `(commandId,inwardEdgeId)`. Its ID is
`ncd_${base64url(SHA256(str("remote-claw/nested-chat-delivery/v1") ||
str(collaborationServerId) || str(logicalChatId) || str(commandId) || str(inwardEdgeId)))}`. The target
namespace is
`ncn_${base64url(SHA256(str("remote-claw/nested-chat-source-namespace/v1") ||
str(targetServerId) || str(targetOutsideBindingId) || str(collaborationServerId) ||
str(inwardEdgeId)))}` and the event ID is
`nce_${base64url(SHA256(str("remote-claw/nested-chat-source-event/v1") ||
str(collaborationServerId) || str(commandId) || str(inwardEdgeId)))}`. Neither changes on reconnect.

The cycle-free semantic envelope core is exactly:

```text
str(canonicalEnvelopeCoreSchemaId) || uint(1) ||
str(collaborationServerId) || str(logicalChatId) || str(commandId) || uint(commandSeq) ||
bytes(base64urlDecode(canonicalCommandRecordDigest)) ||
str(targetServerId) || str(targetLogicalChatId) || str(mutationFamily) ||
str(targetRequestSchemaId) || str(targetReceiptProofSchemaId) ||
str(canonicalCommandPayloadSchemaId) ||
bytes(base64urlDecode(canonicalCommandPayloadDigest)) ||
str(canonicalPayloadTransferSchemaId) ||
bytes(base64urlDecode(canonicalPayloadTransferDigest)) ||
str(targetSourceEventNamespaceId) || str(targetSourceEventId)
```

`canonicalEnvelopeCoreRef` retains those bytes and `canonicalEnvelopeCoreDigest` is their SHA-256.
The new final `EventLineageHop` signs that core digest. Once the hop is signed,
`eventLineageDigest` equals its verified `chainDigest`; an inward send requires the current edge as the
final contiguous `inward-proposal` hop, so it is never hopless. The retained wire envelope is then:

```text
str(canonicalEnvelopeSchemaId) || uint(1) ||
bytes(exactCanonicalEnvelopeCoreBytes) ||
bytes(exactCanonicalCommandPayloadTransferBytes) ||
bytes(base64urlDecode(eventLineageDigest))
```

The embedded transfer bytes must hash to the core's `canonicalPayloadTransferDigest`.
`canonicalEnvelopeDigest` is SHA-256 of the complete wire bytes. The signed lineage record is
transmitted with the envelope and the target recomputes the payload transfer, core digest, every
lineage hop, final chain digest, and wire digest before source normalization. For an attachment this
includes the complete canonical item records and decoded content bytes, not source-local refs. Thus
the hop never signs a digest that contains that hop.
The attempt's `canonicalEnvelopeSchemaId` is derived and must equal the selected family's
`targetRequestSchemaId`; the family has no second envelope-schema field. The attempt repeats that
request schema, `targetReceiptProofSchemaId`, selected common payload schema, and exact payload
transfer schema/ref/digest. The target rejects an
envelope-schema substitution before source normalization. Its durable receipt proof must parse under
that exact selected schema.
Every coordinate repeats the common command, selected edge capability, and installed edge through
composite foreign keys. The canonical origin/hop encodings in §4 are the only lineage encoding; no
parallel ad hoc vector exists. The target outside binding is chat-scoped to
the exact target chat and normalizes this event into its own `CanonicalSourceEventRecord` and
`CollaborationCommandRecord`. It never interprets a transport retry as another proposal.

Physical sends are immutable child `NestedChatDeliveryTransportAttemptRecord` rows. Immediately before
the first possible byte, the edge last hop revalidates the selected command/family, topology, current
edge, capability continuation, live lease/channel binding, target, and retained envelope, then
atomically consumes the exact armed `NestedDispatchAuthorizationRecord` and changes the child plus
command-wide effect gate to `started` under the common positive-never-started contract above. The
initial child repeats the semantic attempt's selected capability snapshot ID/digest and
has both continuation fields null. A later child requires both fields non-null and a valid capability
continuation; one-null/one-non-null is invalid. A continuation can move an otherwise identical
not-started semantic attempt to
a fresh live lease only when the topology/target/family digest are unchanged and every prior child has
positive `never_started` evidence. The retained
`NestedChatEdgeCapabilityContinuation` names the prior/current snapshots and transport attempts,
identical target/family/topology coordinates, and the exact positive-never-started evidence digest.
The source first allocates a fresh random `transportAttemptId`; its child row ID is
`nct_${base64url(SHA256(str("remote-claw/nested-chat-transport-attempt/v1") ||
str(nestedChatDeliveryAttemptId) || str(transportAttemptId)))}`. That ID allocation depends on neither
the continuation nor its signature, so the signed next-attempt reference is not circular. The exact
continuation payload is:

```text
str(canonicalPayloadSchemaId) || uint(schemaVersion) ||
str(nestedChatDeliveryAttemptId) || str(priorEdgeCapabilitySnapshotId) ||
bytes(base64urlDecode(priorEdgeCapabilitySnapshotDigest)) ||
str(currentEdgeCapabilitySnapshotId) ||
bytes(base64urlDecode(currentEdgeCapabilitySnapshotDigest)) || str(inwardEdgeId) ||
uint(sourceTopologyGeneration) || str(targetServerId) || str(targetLogicalChatId) ||
str(targetOutsideBindingId) || bytes(base64urlDecode(capabilityFamilyDigest)) ||
str(priorTransportAttemptId) || str(nextTransportAttemptId) ||
str(positiveNeverStartedEvidenceSchemaId) ||
bytes(base64urlDecode(positivePriorNeverStartedEvidenceDigest)) ||
uint(signerSequence) || uint(serverKeyGeneration) || str(signerIdentityKeyId) ||
str(signerScopeCertificateId) || str(signatureAlgorithm) ||
str(canonicalPayloadDigestAlgorithm)
```

The current certified source-server key signs those bytes. `capabilityContinuationDigest` is
SHA-256 of
`str("remote-claw/nested-chat-edge-capability-continuation-signed/v1") ||
bytes(base64urlDecode(canonicalPayloadDigest)) || bytes(base64urlDecode(signature))`.
The next child, its continuation ref/digest, and its one-time authorization are inserted in one
transaction after that exact signature is retained. Installing it and the next
child is one CAS against the edge's current capability pointer, predecessor's `revoked@2`
authorization and `never_started` state, exact signed positive-never-started evidence, and the same
still-`(never_started,null)` command-wide gate. It retains the paired evidence schema/ref/digest and installs
only the successor's fresh `armed@1` authorization; it never downgrades a started gate. The successor's
last-hop send CAS alone changes the gate to `(started,nextChildId)`. A changed target, family, topology,
snapshot bytes/digest, missing signature, noncurrent snapshot, authorization/gate mismatch, or evidence mismatch
rejects. The next transport child repeats the current snapshot ID/digest and the continuation's current values.
Any started or uncertain child
forbids another send.
For `NestedChatDeliveryEffectGateRecord`, `startedAttemptId` names the exact physical
`nestedChatDeliveryTransportAttemptId`, not the stable semantic delivery-attempt ID.

The target returns the same closed `NestedTargetCommandReceiptProofBundle` defined for management.
Its target request schema/digest must equal this attempt's exact wire envelope, and the bundle's
outside binding, namespace, event, mutation family, common payload, command record, decision/executor
evidence, and signed result must all recompute as one target adjudication chain. Its receipt-proof
schema must equal the selected family. The target's common payload ref is target-local, but its bytes,
schema, and digest must equal the verified portable transfer; for an attachment its newly materialized
item/content refs must reproduce every transferred item/content byte and the same vector digest. A
result for another envelope, capability, target chat, or
decision therefore cannot complete the attempt. Each verified proof is appended as one
`NestedChatTargetResultRecord`, unique on `nestedChatDeliveryAttemptId` and on the target
command-result ID, and retains the exact proof ref/digest. Its target common-result version is exactly
one and its predecessor is null. An exact replay returns the same proof and target command/result
bytes. A second different proof or result, any result version other than one, any non-null predecessor,
or changed component bytes quarantines the attempt; the acknowledged target decision never changes
behind that receipt. Forwarding a formerly queued proposal requires a fresh authenticated target
source event, a new target command/sequence, and another version-one result, not an update to this
attempt. Target
admission is still not native application: terminal OpenCode, Claude, or Codex state and observations
remain the final applied-state authority. Lost response, result fork, or unproved target outcome leaves
the source effect `outcome_unknown` and never sends again.

## 11. Core workflows

### 11.1 Host start and stop

Cold start proceeds from the inside out:

1. Start the independently supervised runtime owner and reopen its local native-runtime registry,
   including the local conversation-transition and inference logs.
2. Start the private provider-shaped façades, inference connector, native-client endpoint, local
   Remote-management endpoint, official-stream mapping/cleanup path, native subscription/routing
   observation, and network policy before any inner process. The outward provider connection remains
   non-writable until its host connector lease and coordinator epoch are current.
3. Enumerate and start or adopt every eligible native runtime and conversation, restore each real
   local TUI path, and establish native observation. Each runtime/conversation/binding has an
   independent lifecycle; one failed adoption remains isolated. These local paths do not require a
   collaboration coordinator.
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

- Web, official-client, automation, and nested-server proposals receive a globally unique
  `command_seq` for audit, but only proposals targeting the same logical chat compete for that chat's
  actor and inward delivery lane.
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

Milestones group related work; no milestone below is intended to land as one pull request. Each
numbered PR slice lands as a separate reviewed PR, may introduce dormant schema or read-only evidence,
and must leave every dependent capability disabled until its own proof gate passes. Detailed bullets
under a milestone constrain those slices; they do not silently enlarge one slice into the whole
milestone.

### A0 — Host-wide registration seam

#### A0.1 — Neutral seam and Claude MITM migration

**Status: implemented.** The seam and registrar are process-local compatibility infrastructure; they
do not claim A1 persistence, restart adoption, or native delivery fencing.

- Add a native engine adapter package that is independent of Claude `Session`.
- Add two-phase conversation registration.
- Add a legacy RC registrar that maps today's `Session` into `startBridgeSession` while retaining
  `bridgeSession` as the older served-promise compatibility API.
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

**Status: implemented as process-local compatibility infrastructure.**

OpenCode and tmux now share the A0 registrar lifecycle without claiming A1 durability, stable
logical-chat identity across wrapper restart, or native effect fencing.

- OpenCode now routes registration through the host-wide seam without changing its compatibility
  command flow. It opens a `starting` lease; requires a successful schema-valid session list; requires
  an explicitly configured canonical `ses_*` to exist exactly; and, with no configured ID, creates
  only after a valid empty list rather than adopting “most recent.” A non-empty ambiguous list
  requires an explicit target. An exact GET confirms the selected or created session.
- OpenCode treats permission policy as an append-only native surface. Unless the operator explicitly
  chooses `--rc-oc-skip-permissions`, parent permission read/install/read-back must succeed before
  structured permissions are advertised. The exact existing remote-claw catch-all skips another
  append; preparation of a de-duplicated PATCH payload is not claimed to make the native append
  idempotent. Parent readiness does not prove child gating: discovered-child setup remains asynchronous
  best effort, and the child's first tool can race it.
- OpenCode advertises conservative capabilities from proved setup only, then transitions the lease to
  `ready`; only after that may the broker bridge, initial announcement, capture pump, or injection pump
  start. It keeps `nativeRef:null` and publishes native
  `{mutationAdmission:"mixed", history:"partial", deliveryEvidence:"structured_receipt",
  liveReattach:false}`. Viewer capabilities are parent structured permissions only after verified
  setup (or false on opt-out), status false, interrupt true, every other control false, and attachments
  false. These transport receipts do not prove native application.
- Cancellation closes the OpenCode starting lease, aborts native setup, and uses the existing bounded
  teardown deadline. List/GET/create/permission errors, malformed discovery, target mismatch, or
  cancellation publish no ghost conversation. After `ready`, normal wrapper teardown still
  best-effort aborts the confirmed OpenCode session, closes the lease, and joins tracked child
  permission-setup tasks under one bounded deadline; it does not stop the external server. Each child
  task receives cancellation and checks it before PATCH, so even an abort-ignoring injected read cannot
  append policy after teardown, while the first native tool can still race the asynchronous setup.
- OpenCode permission replies use retained `POST /permission/{requestID}/reply` with `{reply}` and
  require successful JSON to be literal `true`. This is only a transport ACK: request/session ownership,
  native-TUI-versus-remote adjudication, and terminal `permission.replied` semantics remain unproved.
  Non-2xx responses and malformed successful JSON produce stable body-free endpoint errors. Native
  `session.error` diagnostics log only session plus numeric status and boolean retryability;
  provider-controlled names and messages remain out of local logs even though an E2E-encrypted viewer
  result may carry best-effort human-readable text.
- OpenCode's driver tests cover strict discovery and selection, exact confirmation, parent permission
  failure/read-back/already-installed behavior, cancellation setup boundaries, tracked child teardown,
  literal-true permission replies, body-free error handling, diagnostic redaction, no bridge or pumps
  before `ready`, truthful capabilities, and the shared teardown deadline.
- Tmux opens a `starting` lease with null published capabilities and `nativeRef:null`. It prepares an
  owner-only per-launch runtime, private tmux socket, merged settings, permission/readiness artifacts,
  and launcher; every tmux control verb after the version check addresses that socket. The child
  environment is supplied through process options, forwarded arguments remain in the private launcher,
  merged settings remain in the private settings file, and prompt text reaches `load-buffer` over
  stdin. Those values are absent from tmux argv and from the driver's redacted public error surface.
- Tmux fails closed before publication when settings or folder-trust preparation cannot safely carry
  the required hooks, when a forwarded mode disables hooks, when the pane cannot be started or proved
  present, when the mandatory SessionStart marker is absent or identifies the wrong session, or when
  cancellation wins. Native capture, injection, and permission pumps may exist after native readiness
  and before publication, but the registrar creates no broker client or announcement until `ready`;
  consequently no remote mutation can reach the pane during setup and every failed start publishes no
  ghost conversation.
- Tmux publishes viewer capabilities only from proved setup:
  `{structuredPermissions:mirror,status:false,controls:{interrupt:true,setModel:true,setMode:false,end:false},attachments:true}`.
  Its native evidence is
  `{mutationAdmission:"post_hoc",history:"partial",deliveryEvidence:"best_effort",liveReattach:false}`.
  Permission-decision persistence is atomic and owner-only; a failed write throws and withholds the
  relay ACK rather than claiming delivery.
- Pumps and registrar/relay closure share one teardown deadline, and pane termination receives only
  the remaining time. Private files are removed only when the pane is proved terminated or already
  gone; an unknown outcome retains the private runtime/socket. Distinct private servers and
  session-scoped buffers let many independent wrapper invocations coexist on one host, including in
  the same working directory, without implying the durable host inventory or restart recovery owned
  by A1 and D.
- Tmux driver tests cover readiness and cancellation races, no pre-ready broker client/announcement,
  no-ghost failures, exact capabilities, private file modes/socket selection, argv/environment/prompt
  isolation and redacted errors, permission persistence, tri-state liveness and teardown retention,
  transcript selection/rotation, and concurrent wrapper isolation.

### A1 — Runtime ownership, control journal, and remote-proposal actor

**Status: A1.0 through dormant A1.8a0 implemented; full A1.8a–A1.11 planned.** A1 is
provider-neutral. It owns generic collaboration-server, chat, native, runtime, source,
outside-binding, capability, decision, attempt, outbox, and inference records. It does not own
Anthropic or ChatGPT enrollment, provider cursor/ACK/envelope state, provider chat mapping, or
official-client compatibility; B and C add those records on the generic A1 seams.

**PR slices**

- **A1.0 — Contract freeze (implemented foundation):** close the selected record, canonical-ID, coordinator-lease,
  registration-intent, protected-handle, immutable-dispatch, reconciliation, and backend-capability
  gaps in docs and TypeScript validators. No persistence or writable capability lands here, and no
  active A0 path imports this layer.
- **A1.1 — Secure local state kernel (implemented; activated by A1.3):** Linux-only, descriptor-anchored,
  owner-only `host-state-v1.db`; schema-v2 migrations and digest chain; synchronous high-level
  transactions; verified protected artifacts; reopen and generic multiwrite rollback; secure
  directory/database/WAL/SHM creation and guardians; local-filesystem policy; read-only WAL-aware
  validation before writable open; coherent validation snapshots; FULL migration commits with
  non-blocking passive checkpoint and guardian fsync; typed reopen-safe migration outcomes;
  non-retry-safe unknown ordinary commits; distinct persistence failure/poisoning; fail-stop,
  guardian-retaining open/close cleanup; and application, machine, schema-manifest, migration,
  corruption, and future-version refusal. A1.3 now opens this kernel in the owner daemon. The native
  attempt/dispatch/effect-gate transaction and
  rollback proof remain A1.8.
- **A1.2 — Server/project/chat/binding/epoch state (implemented, dormant):** schema v3, default
  `rcs_*`/profile bootstrap, exact first-project compound bootstrap, explicit later projects,
  terminal-only selector-generation compare-and-swap, many recovering logical chats pinned to exact
  mapping generations, starting native bindings, registration intents, random `rcie_*` installing
  terminal-edge reservations, coordinator lease acquisition/renewal/release, contiguous immutable
  bootstrap/control journal, exact retry/collision and read-side reconciliation, complete restart
  inventory, coherent read-only full-graph validation of existing v3 databases before writable open,
  and validation of a newly migrated graph before the handle returns. The schema accepts only
  the narrow dormant states above and rejects nested targets/edges until N1. Actor scopes are durable
  addresses only; A1.7a now uses them for dormant ingress queues, A1.7b0 supplies the server signer,
  and A1.7b1 supplies rejected-only common command serialization through signed preparation. A1.4 verifies the evidence refs/digests when its
  trusted registration operation is invoked. The ordinary CLI still does not invoke these
  server/project/chat operations; A1.2 itself
  creates no current runtime or binding incarnation and exposes no live registration entry point.
- **A1.3 — Runtime owner service (implemented; production health only):** schema v4 and its complete
  semantic validator/repository; exact `rcrt_*` derivation; independently supervised Linux owner
  daemon; mutually authenticated, bounded local RPC; process-start-bound service lease, heartbeat,
  takeover, and exact unknown-commit reconciliation; wrapped Ed25519 custody and purpose/sequence
  signing discipline; multi-runtime/multi-conversation inventory; append-only owner assignments;
  positive replacement/termination containment; runtime and binding incarnations; transport
  attachments/leases; per-binding lifecycle gates; shared-daemon resource isolation; and detach versus
  terminate. Production wrapped `--rc-app` drivers connect/autostart best-effort and close only their
  owner RPC collaborator without changing A0 native teardown. Health reports
  `ownerOperationsWritable:false` and `nativeRegistrationEnabled:false`; no durable real-driver
  registration, A1 binding activation, terminal root, remote mutation, or broker capability is
  enabled by the ordinary CLI.
- **A1.4 — Durable registration orchestration (implemented closed trusted-adapter seam):** schema v5
  and its exact semantic validator; five canonical evidence schemas; synchronous evidence-resolving
  reservation consumption; generation-fenced process leases, generation-ordered publications, and
  contiguous kind-specific operation journals; bounded duplex callable ports; atomic
  bind/publish/ready/recover/drain/close; exact request-bound read reconciliation; and crash reattach
  under fresh owner/coordinator fences, including transport-lease rotation and retained predecessor
  proof. Ready makes the runtime incarnation, binding, gate, and process lease current while leaving
  the chat recovering and terminal edge installing. The production seam is installed only for an
  explicitly supplied trusted adapter; the ordinary CLI supplies none, so all real drivers remain A0.
- **A1.5 — Canonical A1 wire and signing (implemented dormant foundation):** pure browser-safe A1 v2
  scope/server-control/chat address and token derivation; broker-route IDs; chat and directional
  server-control KDFs; closed kind-to-plane and header/route rules; per-part AEAD; exact JSON frame,
  signature-preimage, and transport/attempt/part/message digest codecs; strict native-root,
  server-scope, onboarding-key-attestation, and `ViewerOnboardingBundleV2` certificate/transfer
  verification. Schema v6 adds the complete terminal-root activation ledger and semantic validator.
  Its two-stage repository and narrow `native.root.activate` trusted-adapter operation reserve and
  bind under the current protected runtime-owner key, sign, then demand a fresh reverse callable-port
  proof immediately before finalization. The transaction-local finalizer exclusively stores and accepts
  the signature and atomically activates the exact ready chat/edge; public runtime-owner signing
  mutators cannot touch the attached reservation. It reconciles unknown commits and renews only from
  the latest retained certificate. Recover, drain, close, and reattach demote the root
  without erasing history and require re-ready plus renewal. The ordinary CLI supplies no adapter, so
  no real driver invokes this operation. Its fresh callable-port proof is ephemeral and immediately
  precedes synchronous finalization; snapshot validation does not replay it. Expiry does not itself
  demote the stored chat/edge, so a future effective route/dispatch must recheck certificate time and
  live lease. The pure codecs themselves open no broker route.
- **A1.6 — A1 broker contract (implemented dormant foundation):** pure exact selected-capability,
  route/store, cursor/generation/manifest, publish/collision, and bounded read-page contracts; a
  separate bearer-bound SQLite/libSQL `/api/a1/*` surface with recomputed route authority and pinned
  capability digest; immutable `rbsi_*` physical-store identity; A1-only catalog provisioning and
  store-loss latch; retained route-wide delivery-attempt originals, first-collision tombstones, and
  sealed manifests; automatic 4,096-frame rollover; one-generation/64-frame bounded pagination; and a
  negotiation-first browser-safe client that never retries an outcome-unknown write automatically.
  Schema v7 adds protected backend-capability pins, broker routes, and empty/open genesis-generation
  records. Its current-coordinator-fenced repository and host-only split-commit installer accept only
  an exact confirmed pristine generation-zero open, provide exact replay, one exact remote-open retry
  after outcome-unknown, and close/reopen reconciliation of an unknown local commit, and leave the
  route dormant. A proved-absent local commit is non-retry-safe because remote open may have landed.
  Ordinary CLI launches, real drivers, runtime-owner
  RPC, and the viewer make zero A1 broker calls. There is no public generation-seal endpoint and no
  A1 cursor/actor, native effect, checkpoint, server-scope signing, inference, or projection here.
- **A1.7a — Evidence-preserving ingress (implemented dormant foundation):** schema v8 route heads,
  retained page/frame/raw/plaintext evidence, independent physical-fetch and semantic-prefix cursors,
  current-fenced revisioned actors, bounded multipart reconstruction, exact retry, collision and
  incomplete tombstones, audited gaps/recovery, and complete results frozen at durable
  `awaiting_order`. The module is absent from production barrels/run paths and creates no command,
  signature, result delivery, outbox, effect, dispatch, projection, or native record.
- **A1.7b0 — Server-signer prerequisite (implemented dormant foundation):** schema v9 initial
  self-anchor; AES-256-GCM-wrapped server Ed25519 custody with transplant-resistant AAD and no raw-key
  API; coordinator-fenced bootstrap/current signing leases; immutable signer-sequence reservations,
  exact purpose/schema/payload binding, signature persistence, dense per-server
  `acceptedAtJournalSeq` acceptance, and request-bound reconciliation. The signer-acceptance sequence
  is its own journal coordinate and does not widen schema-v3 `control_journal_entries`. A coordinator
  takeover during a non-closed bootstrap is an immutable `stale_bootstrap_fence` fail-stop, while
  takeover after installation supersedes the normal lease and permits a fresh next-token lease once no
  `reserved`, `bound`, or signed-but-unaccepted predecessor reservation remains. Direct-only
  modules/tests invoke this surface; it creates no command/result, generic host output, broker publish,
  result delivery, checkpoint, outbox/effect, native dispatch, inference, projection, production
  operation, or native table.
- **A1.7b1 — Rejected command adjudication and signed preparation (implemented dormant
  foundation):** schema v10 exact five-table ledger; shared ready/control-journal closure; eligible
  A1-ingress route-head materialization; deterministic source/command/result/group/preparation IDs;
  bounded `unsupported_recognized` persistence; global ready order and dense `commandSeq`;
  rejected-only decision; distinct creation/decision fences; current-lease reserve/bind/sign;
  abort/reprepare generations; unknown-commit reconciliation; and semantic reopen. It stops at a
  signed-but-unaccepted result preparation and exposes no final result, signer acceptance, terminal
  ingress/source result, delivery/outbox, effect/attempt/dispatch, projection, or production path.
- **A1.8a0 — Rejected-only atomic finalization (implemented dormant foundation):** schema v11 exact
  three-table ledger; pure compact action/chat result bytes and stored-result/delivery digests; one
  transaction for immutable common result, dense signer acceptance, `decided`/`terminal` overlay,
  exact semantic artifact, and one inert `pending_seal` intent; full rollback and unknown-commit
  reconciliation; post-sign collision/route-close independence; narrow valid predecessor-signature
  successor takeover; and semantic reopen. The base v8 ingress evidence and cursor remain unchanged,
  the v10 signed preparation graph remains retained, and no claim/seal/publish, broker call,
  effect/attempt, projection, native dispatch, production path, or capability lands.
- **A1.8a — Admitted atomic arm (planned next):** add an admitted command's exact pinned native
  attempt, front-door dispatch, and protected one-use effect gate in the same atomic boundary without
  widening the rejected-only finalizer or enabling a partial path.
- **A1.8b — Sealing, one-time dispatch, and recovery (planned):** seal and publish causal result
  delivery; protected one-use authorization consumption; epoch/fence checks; uncertainty quarantine;
  native read-back; and evidence-only reconciliation without replaying a possibly started effect.
- **A1.9 — Runtime-scoped inference recovery:** provider-request identity, encrypted exact request
  bytes and response chunks, connector leases, and no silent retry after ambiguous upstream receipt.
- **A1.10 — Viewer onboarding and projection:** trust-store installation and certificate
  status/revocation policy around A1.5's pure chain verifier, scoped discovery, result redelivery,
  broker catch-up, projection rebuild, and no duplicate optimistic row.
- **A1.11 — Recovery gauntlet:** kill/restart at every commit/send boundary, stale-coordinator
  takeover, broker rollover, projection rebuild, and proof that the local TUI remains usable while
  remote collaboration is unavailable.

The stateful path through dormant rejected-result closure—`A1.0 → A1.1 → A1.2 → A1.3 → A1.4 → A1.5 → A1.6 → A1.7a → A1.7b0 → A1.7b1 → A1.8a0`—is implemented behind closed trusted-adapter and host-only seams.
Full A1.8a waits for that complete path plus the A1.3/A1.4 executor foundations and must land atomically;
A1.8b waits for A1.8a; A1.9 waits for A1.3 and the protected-handle kernel; A1.10 waits for
A1.5–A1.8b; A1.11 is the integrated gate. An A1.8a0 `pending_seal` intent is a retained final
rejection, but it is neither sealed/published delivery nor dispatch authority.

- Add durable `project`, project-allocation/selector mapping, `logical_chat`, `native_binding`,
  native-incarnation, runtime-local
  native-conversation/transition/mapping, private-transport-attachment and attachment-lease,
  runtime-scoped inference-attempt/chunk-outbox/correlation, outside-binding,
  collaboration-server/scope-certificate, outside-capability-snapshot,
  outside-capability-verification, connection-epoch, source-event
  namespace/transition/observation, canonical source-event, and cross-incarnation correlation
  records.
  Never alias one server's `logicalChatId` to another server's chat, the A0 `rcb_*`, Claude `cse_*`,
  Codex/OpenCode ID, broker channel, or provider ID.
- In A1.2, allocate each terminal chat's exact installing
  `targetKind:"native-harness"` inward edge atomically with its native binding and point the recovering
  chat at it. That edge, with null root-certificate/live-lease/capability pointers, is the non-writable
  terminal-root reservation; no root certificate exists yet. A1.3 supplies the
  protected runtime-owner key and attachment-lease service; A1.4 makes the exact durable binding and
  matching runtime/incarnation attachment lease current. A1.5 then has that
  `RuntimeOwnerIdentityKeyRecord` sign and atomically activate or renew the terminal root under fresh
  owner/coordinator and callable-port liveness proof. A server identity key cannot
  substitute. The activated native edge keeps its remote-server connection epoch at zero and its live
  lease/capability pointers null; its attachment lease and native capability snapshot prove liveness.
  A1.8 may dispatch only through that current proved edge. N1 later adds remote-server targets,
  `InwardEdgeLiveLeaseRecord`, and multi-server path installation; it does not retroactively create the
  terminal edge required by A1/A2.
- Route canonical command/chat sequences and native/outward bindings by the complete
  `(collaborationServerId, logicalChatId)` chat scope. Machine-facing web presence, broker
  channel/key derivation, visible rows, aliases, and client caches use
  `(identity_id, collaborationServerId, logicalChatId)`. A transport replacement must update that one
  scoped row rather than create another.
- Treat one paired server as a collection of independent session lanes. Register and recover many
  simultaneous Claude processes and many Codex/OpenCode conversations, including sessions in equal or
  different directories, without an unscoped current-session pointer. Global journal/command
  allocation remains bookkeeping; admission, delivery quarantine, native gates, projection, and
  restart readiness are per chat, and teardown of one shared-daemon conversation never tears down its
  siblings.
- Add an epoch-fenced runtime owner/warden and already-project-scoped local native-transition registry that keep the native
  client endpoint, provider façade, inference connector, and real TUI usable across coordinator
  unavailability without changing native semantic authority. Import exact transitions into
  server-scoped bindings atomically; leave ambiguity locally usable but remotely unbound.
- Add the explicit forward-incarnation transition with required terminal/cancellation or process
  containment evidence; never overload A0 `bindNative` for replacement.
- Add `starting`/`recovering`/`ready`/`draining` lifecycle gates and explicit detach-versus-terminate
  shutdown.
- Persist text command receipt, order, decision, native/outside delivery, binding, and recovery gap.
- Make receipt, server forwarding, inward delivery, native acceptance, and observation distinct.
- Bind versioned source and result envelope digests to the exact collaboration-server/chat scope;
  keep edge-hop lineage and nested server-key exchange in N1.
- Write ahead every native/outward attempt, atomically enqueue causal outbox items, and quarantine a
  chat behind unresolved native delivery.
- Write ahead every runtime-scoped inference request and encrypted response chunk separately from
  native delivery; recover one response stream without requiring a coordinator/chat binding and forbid
  silent retry after ambiguous upstream receipt.
- Persist/replay the encrypted-ingress cursor instead of treating a sampled `frameCount` as the next
  command boundary; advance only a contiguous committed high-water mark.
- Gate: crash every transaction/delivery boundary without silent loss or automatic duplicate execution.

### A2 — OpenCode vertical slice

**Status: planned after A1.** A2 proves the common actor with a live web collaborator and the exact
OpenCode terminal adapter. For an official-client, automation, or nested-server source whose live
connector has not landed, A2 uses an authenticated collaborator stand-in at the common ingress
boundary. A stand-in must carry the source's typed authenticated identity and capability snapshot, but
it proves only normalization, ordering, decision, and executor isolation—not the absent connector's
transport, reconnect, rendering, or fidelity. B, C, the applicable automation connector, or N1 must
replace that stand-in before the corresponding live source is advertised.

**PR slices**

- **A2.1 — Retained OpenCode boundary proof:** exact real-TUI, role-manifest, front-door, observer,
  provider/process isolation, and generated-schema fixture.
- **A2.2 — Binding, observation, and creation:** stable `ses_*` binding, SSE-before-snapshot recovery,
  direct-TUI transition serialization, and two-phase `{new_chat}`.
- **A2.3 — Text adjudication:** exact `{user_text}` translation, effect gate, caller message ID,
  204-as-receipt-only handling, native read-back, cancellation, and crash recovery.
- **A2.4 — End-to-end release fixture:** private inference, restart, concurrent direct-TUI input,
  source stand-ins, stored rejections, and projection rebuild with only proved families enabled.

- Persist a stable binding from `(collaborationServerId, logicalChatId)` to the native OpenCode
  `ses_*`; do not use `ses_*` as either remote-claw chat coordinate or the broker ID.
- Keep one real OpenCode TUI path and one epoch-fenced remote-claw adapter lease on the same `ses_*`;
  put the actual server in a private namespace and expose the four total, attested runtime-owned
  audiences: exact-process TUI, dispatch-only binding adapter, creation-only server control, and
  internal observer. Permit only those exact front-door TGIDs to reach the raw listener; deny the
  OpenCode process and spawned tools. Stock `1.17.5` remains non-writable until a retained full
  front-door/real-TUI/observer/isolation fixture proves this boundary.
- Make takeover a barrier: reject new old-epoch arrivals, keep the replacement non-writable, and settle
  or quarantine every request already admitted under the old lease before activating the new one.
- Fail closed on session discovery errors and never adopt “most recent.” Reattach an existing binding
  or quarantine it if its exact native session/lineage is absent. Record exact first import, including a
  native-TUI-created session, as an identity transition. Permit automatic creation only with explicit
  first-bootstrap intent, no existing binding, and a positive empty snapshot; permit explicit **New
  chat** as a separately typed operation even when sessions exist. Use a two-phase
  reservation/write-ahead attempt with the exact two-field namespaced marker/typed-intent metadata;
  retain every same-marker candidate's full native metadata ref/digest and bind exactly one only when
  that evidence recomputes, its classification is canonical, its canonical two-field ref/digest
  recomputes, and its intent equals the expected digest. Lost-response reconciliation requires a
  current, complete, linearly proved and exhaustive successor discovery snapshot. Zero remains
  uncertain; wrong/missing/malformed intent, noncanonical/extra metadata, or multiple matches
  quarantine without retry. Prove both metadata fields across server restart. Retain one
  same-incarnation vector with the exact null lineage sentinel and one cross-incarnation vector whose
  original/successor signed open/read attestations and store coordinates recompute to the same stable
  store identity and whose predecessor-stop/fence plus successor-exclusive-open records form the exact
  no-reset/no-fork continuity handoff. Exercise a cloned store with copied embedded identity, missing
  predecessor containment, an open predecessor handle, parallel successor, reset/forked registry,
  reused/skipped generation, or mismatched handle identity and require `lineage_unproved`. Corrupt each
  runtime, incarnation, snapshot, coordinate, attachment-attestation, continuity-proof, stable
  identity, marker, intent, schema, and digest in turn before row construction and require normalization to
  `cross_incarnation_unproved`/`lineage_unproved` with no bind. Tampering with an already retained
  `cross_incarnation_proved` row instead invalidates that row and changes no state.
- Serialize direct-TUI create/import/switch/clear/fork/archive/unarchive with server-control creation
  through the runtime-owned workspace transition barrier. Reject an unclassified top-level
  identity/selection/discovery mutation rather than letting it race first-bootstrap.
- Feed history/live events into normalized text observations.
- Establish and actively drain SSE into a bounded durable buffer before history snapshot; make
  overflow, stream loss, snapshot failure, and pre-merge crash explicit non-writable recovery gaps.
- Compare legacy `/event` with v2 `/api/event`, pin event-ID/sequence scope and reset behavior, merge a
  native status snapshot before readiness, and classify orphaned incomplete messages across a real
  server kill/restart. A complete snapshot requires a proved native watermark, same-stream
  post-snapshot barrier, or atomic store boundary; drained legacy SSE alone is not sufficient.
- Route every live web proposal and every authenticated collaborator stand-in through the common
  command and signed-result adjudicator. The selected writable families are exactly server
  `{new_chat}` and binding `{user_text}`; compact, interrupt, permissions/questions, attachments,
  clear/fork, and every other unproved family receive a stored ordered rejection with no admitted
  user-content/native projection, attempt, or effect; the signed rejection `action_result` is still
  delivered. Replacing a stand-in with a live connector changes no common decision or executor path.
- Route admitted text through a write-ahead caller-supplied native `msg_*`, treat
  `204` as transport receipt only, advance native acceptance/order solely from exact correlated
  OpenCode evidence, and never retry the non-idempotent same ID blindly.
- Implement terminal pre-send cancellation as the one atomic
  `NativeBindingPreSendAbandonmentRecord` transaction over attempt, dispatch, and command gate.
  Distinguish it from a no-record crash that resumes the same immutable attempt; make every
  terminal-native `positiveNeverStartedSchemaId` null; and reject any terminal replacement,
  continuation, or successor.
- Pin a durable per-binding/incarnation capability snapshot in both the decision and native attempt.
  Normalize every OpenCode slash command to a typed family before that decision; reject
  blank input and unproved/unsupported commands with a stored `action_result`, never an adapter-side
  no-op or literal prompt after generic acceptance.
- Treat direct TUI actions as native observations, never as server-forwarded proposals or echoes to
  execute again.
- Route all OpenCode model-provider traffic through private local façades and prove the exact-process
  provider/raw-listener network fence. Retain an incarnation-wide non-reused native request coordinate,
  encrypted exact provider-request bytes, immutable response stream, and connector-lease recovery;
  ambiguous upstream start never becomes a second inference request.
- Reconcile the persisted coordinator journal with OpenCode history and rebuild its projection.
- Treat ambiguous HTTP 204 delivery as `outcome_unknown` rather than retrying.

### N1 — Nested remote-claw collaboration

**Status: planned after A1.** N1 is the live nested-server connector. A2's authenticated nested-source
stand-in is not N1 evidence and cannot advertise a nested edge, transport, or recovery capability.

**PR slices**

- **N1.1 — Server identity and rooted topology:** server-key enrollment/rotation/revocation, extension
  from an existing A1 terminal root, multi-server rooted path certificates, acyclic reservations, and
  one current nested inward edge.
- **N1.2 — Edge installation and lifecycle:** two-party generation-fenced installation, non-writable
  receipts, mutual live-writability, reconnect, split-commit recovery, containment, and reparenting.
- **N1.3 — Nested command and result delivery:** direction-typed lineage, management/chat commands,
  one-time send authorization, complete signed downstream receipts, positive-never-started
  continuation, causal observations, and no reflection or duplicate traversal.

- Extend A1's terminal inward-edge and root records with multi-server topology reservations, signed
  event-lineage, server-identity keys, nested-management attempts, nested-chat attempts,
  edge-capability snapshots, and downstream receipts without aliasing either server's logical chat.
- Starting from the already committed A1 terminal root, install a nested inward edge per
  `(server, chat)` with rooted path certificates, two-party generation-fenced reservations,
  non-writable installed receipts, a separate mutual live-writability handshake, split-commit
  recovery, and containment before reparenting.
- Bind every server/chat/edge/direction hop into an authenticated lineage chain; verify historical
  server keys, reject cycles and reflected observations before command allocation, and append exactly
  one new authenticated hop at each server.
- Require a complete downstream proof joining the source event, source command/result, selected target,
  target command/result, edge capability, and physical delivery attempt. A transport ACK or partial
  target receipt never completes the source command.
- Consume the one-time send authorization in the last pre-byte transaction. Permit transport
  replacement only from exact signed positive-never-started evidence; a started or uncertain
  predecessor can never be reset or replaced.
- Gate: crash every edge installation, finalization, and send boundary; reconnect and reparent without
  a second inward execution; reject reciprocal/cyclic binding and any observation converted back into
  a proposal.

### B — Claude Code wrapped client

**Status: planned after A1; the A0 synthetic RC seam remains a compatibility adapter.**

**PR slices**

- **B.1 — Retained native boundary fixtures:** version-, binary-, schema-, and probe-hashed Claude
  keyboard-plus-Remote, reconnect, gate, control, resume, and takeover evidence.
- **B.2 — Private façade and durable RC recovery:** terminate inner Anthropic routes, add the private
  RC event store, reuse the known UUID/`cse_*`, fence epochs, and recover exact delivery state.
- **B.3 — Native correlation and takeover:** join RC receipt, transcript/provider/native evidence,
  adjudicate permission/question races, and keep child/TUI/inference work alive across connector loss.
- **B.4 — Outward Anthropic Remote transport:** enrollment, worker/session state, cursor/ACK/reconnect,
  history repair, and isolated credentials.
- **B.5 — Family-by-family release:** prove controls, permissions, questions, uploads, reconnect, and
  official-client rendering before advertising each family.

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

**Status: planned after A1; the retained 0.146.0 evidence closes only its named narrow fixtures.**

**PR slices**

- **C.1 — Retained daemon/front-door fixtures:** pin Unix and experimental transports, real-TUI
  coexistence, subscriptions, server requests, child lineage, cleanup, and generated schemas.
- **C.2 — Private daemon and façades:** one managed app-server, local TUI-equivalent front door,
  isolated OpenAI façade, provider network fence, and one authenticated daemon-wide bridge.
- **C.3 — Native management and bindings:** host-scoped thread discovery, logical bindings, aggregate
  native subscriptions, and one injected management-only `RemoteControlService`.
- **C.4 — Outward ChatGPT Remote gateway:** provider-specific enrollment, host/project/chat mappings,
  per-stream transport state, collision-safe request/handle maps, tombstones, and cleanup.
- **C.5 — Official-client parity and recovery:** live pairing, multi-project/chat behavior,
  reconnect/ACK/cursor repair, backpressure, replacement fencing, and differential fidelity.

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

**Status: planned after A1; this does not change the current lower-fidelity tmux compatibility
status.**

**PR slices**

- **D.1 — Durable pane ownership:** pane/process/transcript identity, lifecycle, and honest recovery.
- **D.2 — Fenced injection and observation:** write-ahead paste/Enter attempts, ambiguity quarantine,
  transcript correlation, and explicit simultaneous-draft limits.
- **D.3 — Gates and handoff:** durable permission answers/terminal observation, keep-pane detach,
  decision/cursor/orphan transfer, and active-turn preservation.
- **D.4 — Chat transitions and presentation:** `/clear`/`/branch` identity plus the unified
  host/project/chat view and separate native/provider/web delivery states.

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

The following integrated/live behaviors remain unproven. A1.2's repository tests prove the
persistence-only default server, project/mapping bootstrap and replacement, many-chat inventory,
coordinator lease/journal reconciliation, and v3 semantic-validation subset described above. A1.3's
tests additionally prove schema v4, runtime-owner repository replay/collision/fencing and semantic
validation, key wrapping/self-test/signing, authenticated bounded RPC, service lease loss/takeover,
daemon/bootstrap failure cleanup and multi-runtime isolation. A1.4's tests prove schema v5 and its
269-object manifest; all five canonical evidence schemas; exact registration lease/publication/op
replay and collision; current-authority mutation and request-bound reconciliation; lifecycle closure;
bounded duplex port transport; stale-open crash takeover; same-binding close/reattach with a fresh
process lease and port plus conditional transport rotation; and predecessor runtime-journal truth.
The semantic validator additionally implements no-extra-row closure. Tests also prove that the closed
production seam is enabled only by an explicit trusted adapter. The
ordinary CLI supplies none, so these tests do not prove a live real-driver registration or A1 remote
mutation.

A1.5 tests prove the strict pure A1 v2 route/KDF/frame/digest, certificate, and onboarding contracts,
including noncanonical and signature-transplant rejection. Schema-v6 migration tests lock its 36
statements, digest, and 304-object manifest. Repository/SQLite tests cover activation and renewal,
exact replay and collision, stale owner/coordinator fences, expired-preparation refusal, transaction rollback, lost-COMMIT
reopen/reconciliation, full-chain semantic reopen, prepared renewal forks with exactly one committed
successor, and recover/re-ready/renew. Tests also prove that public runtime-owner store/accept/abort
cannot mutate a prepared v6 operation-attached `native_root` reservation. The same test reopens the
database and stores and accepts it through the terminal-root transaction finalizer, with the
acceptance/commit timestamp sampled there, while legacy unattached v5 history stays inert. Service tests cover the closed `native.root.activate` payload,
protected runtime-owner signing before a connection/binding/runtime/incarnation/attachment/port-generation
proof with a fresh nonce, immediate synchronous finalization after that proof, and historical replay
without a false live-port claim. This operation is installed only with the explicit trusted adapter;
no real driver invokes it.

A1.6 pure tests lock the exact selected capability vector and digest, route/store IDs, cursors,
generation and manifest invariants, exact publish/retry/collision receipts, and bounded read pages.
Web unit and route tests exercise bearer/selector/capability admission, strict duplicate-safe JSON,
route recomputation, raw/ciphertext/part/control bounds, A1-only catalog provisioning and quota,
immutable store identity, exact retry before and after rollover, first-collision latching without
cursor allocation, atomic automatic rollover, empty sealed-generation advance, one-generation and
encoded-byte pagination limits, counter exhaustion, catalog recovery, known-store loss, and A0
retention isolation. Client tests prove mandatory negotiation, canonical publish, strict response and
frame validation, collision typing, store/capability mismatch rejection, bounded reads, secret
scrubbing, and no automatic retry after outcome-unknown transport failure. Schema-v7 migration,
repository, SQLite, and installer tests lock the exact protected capability pin, route, pristine open
genesis, current coordinator fence, installing-server scope, exact replay/collision, stale-authority
refusal, historical unknown-commit reconciliation, semantic reopen, remote-open/local-install split,
and exact recovery after either half. This proves a dormant provider/route foundation only: no
ordinary CLI, driver, runtime-owner operation, or viewer uses it.

A1.7a pure, migration, repository, actor, and real-SQLite tests cover its frozen ingress bounds;
v7-route backfill and post-v8 route auto-seeding; exact route/artifact/page/frame closure; actor claim,
stale rejection, crash-retained takeover, bounded route-head/expiry/reconciliation reads, and
unknown-commit reopen; page staging and separate fetch/semantic cursor progress; one-part and
multipart completion through `awaiting_order`; exact retry; transport and semantic collision;
incomplete expiry and late tombstones; invalid payload, quota, and unresolved lookahead; explicit
gap recovery; and secure-reopen corruption refusal. They also assert the absence of A1.8 command,
signature, result-delivery, outbox, effect, dispatch, viewer, and native tables. No ordinary CLI,
driver, runtime-owner operation, or viewer starts this actor, so these proofs make no live A1
collaboration claim.

A1.7b0 parser, custody, migration, repository, service, and real-SQLite tests cover strict record and
lifecycle tuples; deterministic identity, bootstrap-intent/signed-certificate digest, and AAD vectors;
sign/verify without raw private-key export;
machine/server/handle/key/generation/algorithm/backend/public-key/PKCS8-digest transplant rejection;
initial `scope_certificate`-only bootstrap; current coordinator lease/epoch/fencing checks; monotone
burned signer sequences; exact initial-certificate reserve/bind/sign/accept replay and collision;
acquisition of the installed current lease without a generic current-lease signing API; the distinct dense
per-server `acceptedAtJournalSeq` acceptance coordinate; rollback, stale-authority refusal,
atomic intent/payload-artifact phase commits, request-bound unknown-commit reconciliation, process
restart from every durable phase without replacement-key generation, custody-qualified takeover,
and semantic reopen. Negative gates prohibit a common command/result,
generic host-output record, broker publish, result delivery, checkpoint, outbox/effect, native
attempt/dispatch, inference, viewer projection, native table, or production import. The v8 pins remain
unchanged. Migration 9 is pinned at 81 statements, digest
`fYrN5atmwIj-tlT_tTXmrg9kNF52ah-zWmgf7vVFQWE`, and a 571-object manifest: 65 tables, 123 indexes,
and 383 triggers.

A1.7b1 pure-contract, migration, repository, signing-orchestrator, and real-SQLite tests pin migration
10 to 50 statements, digest `rdJC_2C5IyjfsTuXhxjFSzT0bvDYtlpT8o0xDvu4IEk`, and the exact
619-object manifest: 70 tables, 137 indexes, and 412 triggers. They require exactly the five new
ready/sidecar/command/group/preparation tables; defensive pure parsing and canonical bytes; scalar
text through 48 MiB; small `unsupported_recognized` persistence; deterministic
`rcm_*`/`ccr_*`/`csg_*`/`crp_*`; the merged gap-free control/ready journal; current gap-free route
head selection; the 256-unresolved ceiling; global `(readyAtJournalSeq, commandId)` order; dense
command/signer sequences; rejected-only decisions; distinct creator/decider fences; exact
reserve/bind/sign; takeover and unknown-commit reconciliation; repeated abort/reprepare through a
third generation; signature verification; and semantic reopen/corruption refusal. Negative gates
prohibit command `decided`, ingress `terminal`, group `finalized`, final common result, signer
acceptance, source result/delivery, outbox/effect, attempt/dispatch, inference, viewer/native state,
and every production operation or runtime invocation of command adjudication/result signing. A1.8a
does not retroactively widen that schema-v10 proof.

A1.8a0 pure-result, migration, repository, finalization-orchestrator, validator, and real-SQLite tests
pin migration 11 to 38 statements, digest
`SkkuAFJed-7GT9XyXXPCub7VFauqNY6eu0u4IQJEInc`, and the exact 647-object manifest: 73 tables, 147
indexes, and 427 triggers. They require exactly the three common-result/terminal-overlay/
result-delivery tables; exact compact rejected action/chat payload bytes and schema IDs; the stored
semantic-result digest; stable `rrs_*` identity; deterministic `rrd_*`; retained random `rda_*`; and
the lexicographically greatest complete-candidate `new_part` observation. Real-SQLite tests cover
one-transaction closure and rollback, exact replay without reallocation, landed/absent unknown-commit
reconciliation, partial-graph corruption, post-sign collision and route closure, narrow max-fence
predecessor-signature acceptance under a live successor, dense acceptance, and semantic reopen.
Hostile mutation tests reject inconsistent payload/artifact/digest/trigger/source/fence joins,
intervening signing leases, admitted or encrypted rows, publication/history claims, and mutable
result surfaces. Negative import/runtime gates prove no ordinary CLI, driver, runtime-owner RPC,
relay, viewer, or broker path invokes finalization and that `pending_seal` has no claim, ciphertext,
output part/signature, seal/publish, effect/attempt, projection, native dispatch, or cursor movement.
Full A1.8a still needs the admitted attempt/front-door-dispatch/effect atomic arm; A1.8b still needs
sealing/publishing and one-time delivery before any capability can be advertised.

- one real trusted adapter must invoke the implemented A1.4 seam against A1.2's exact project,
  mapping, and terminal reservation without adding `project:null`, cwd/title inference, or
  only/most-recent fallback, then recover the proved native conversation without minting a second graph;
- durable separation of server-scoped `logicalChatId`, native binding/conversation/incarnation, inward
  collaboration edge, nested-server chat mapping, private transport, broker channel, and outward
  provider IDs;
- one paired host concurrently serving many independent Claude, Codex, and OpenCode conversations
  across equal and different directories, with one local TUI and one remote-claw collaborator per
  native session, per-chat mutation serialization, sibling-safe shared-daemon teardown, independent
  restart/reattach/quarantine, and no cross-chat IDs, history, commands, gates, projections, or side
  effects;
- runtime-local conversation/inference identity inside an already durable project while the coordinator is absent, plus exact atomic
  import into a server-scoped chat without replay, reassignment, or old-chat proposal leakage;
- one real trusted adapter must exercise the implemented terminal native-root operation after durable
  registration and renewal after lifecycle demotion; a server-key signature, stale authority or
  attachment, generic sign request, or earlier non-writable reservation must remain unable to activate it;
- stable `(collaborationServerId, logicalChatId)` scope, `command_seq`, `chat_seq`, and one visible row
  across a known-transport re-bridge or a proven replacement private transport;
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
- multiple direct collaborators collapsed into one inward collaborator by A1; authenticated A2
  stand-ins prove source-independent adjudication only;
- N1 live recursively nested remote-claw servers without cycles, reflection, or duplicate native
  execution, including installed-but-non-writable edges and the mutual live handshake at every split
  finalization;
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
  discovery/create ambiguity, complete four-audience front-door attestation, exact-process TUI and raw
  listener/tool isolation, workspace-transition serialization, and lossless SSE snapshot
  linearization; the selected A2 `{new_chat}`/`{user_text}` executor/recovery proofs remain open, while
  compact, interrupt, permissions/questions, and child-session mutation stay explicitly unsupported
  until their own causal and recovery proofs land;
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
10. In N1, repeat with two live nested remote-claw servers and assert one native execution, exactly one outward
   return traversal per edge, no same-direction reflection, no observation-to-proposal promotion, and
   stable origin lineage through disconnect/reconnect. Delete/reorder a hop, substitute a payload under
   an intact chain, rotate a server key, and revoke it; require tamper rejection, old-record
   verification, and rejection of new hops under the revoked key.
11. Race reciprocal nested-edge installation and mutate the target topology during installation.
    Crash each side after prepare, commit-intent, installed receipt, and local-current selection.
    Require at most one rooted installed edge, generation-certificate rejection for the stale attempt,
    and no delivery until both installed receipts and the mutual current-generation live handshake
    succeed.
12. With an already durable project, cold-start with the collaboration journal/coordinator unavailable.
    Create and use a new local conversation through the direct TUI while the native endpoint, provider façade, and runtime-scoped
    inference connector remain usable and every remote-claw mutation is rejected as unavailable. Then
    recover the coordinator, atomically import the local transition log, map the correct logical chat
    and lineage, and prove that neither an inference attempt nor an old-chat queued proposal is moved
    to the new conversation.
13. Crash the inference connector before send, after possible upstream receipt, during streaming, and
    after completion. Require one write-ahead attempt and one native response stream; retry only with
    proven upstream idempotency/read-back, otherwise surface the pinned native error/retry behavior.
14. Cold-onboard an A1 viewer from one `ViewerOnboardingBundleV2`; verify the scope certificate,
    derive canonical `scopeAddress`, `serverControlAddress`, and `chatAddress`, and require the broker
    to recompute all three from the clear routing tuple plus `auth_token`. Tamper with each tuple
    field, certificate, key, and opaque token;
    fuzz field-boundary collisions; rotate the server key while preserving `collaborationServerId`;
    and require rejection, historical verification, or explicit re-pairing as appropriate. Cover a
    cold multi-certificate chain, an existing viewer's suffix, stale/forked concurrent rotations,
    rollback, skipped generation, key-ID rebinding, revoked signer, and atomic current-certificate
    compare-and-swap. Publish byte-exact Node/browser/second-language vectors for the primitive
    encoder, route hashes, exact A1 JSON frame, AAD, all three chat-plane KDFs, both dedicated
    inbound/outbound server-control KDFs, message
    ciphertext/tag, transport-frame digest, stable part/message digest encodings, initial self-signed
    Ed25519 scope certificate, old-key-signed rotation chain, exact
    `accepted`/`action_result`/`chat_creation_result` payloads and key order, kind-to-plane mappings,
    every allowed/rejected direction/sequence/client-ID/header-nullability/chunk-shape combination,
    and broker
    generation/cursor encode-order-successor rules. Reject duplicate JSON members before object
    construction, including duplicate routing/AAD fields, and assert the invalid-position cursor/
    quarantine result. Include the four onboarding key commitments/attestation and transfer checksum,
    certified host-output signature preimage and signed-record digest, signer reservation/burn and
    sequence equivocation, cutoff/current/retired/revoked behavior, certificate update and historical
    reattestation publication/retrieval/fork cases, and signature transplant/omission/stale-key cases.
    For server control specifically, vector `serverControlAddress` and its `ctl:a1:` token; the
    null-chat inbound `new_chat` header with null sequence, required client ID, 0/1 chunk shape, null
    host-authentication fields, and dedicated input key; and the null-chat outbound
    `chat_creation_result` header with `seq=command_seq`, echoed client ID, stable result `msg_id`, 0/1
    chunk shape, non-null certified host-output fields, dedicated output key, and exact signature
    preimage/digest/verification. Require the wrong server-control key, direction, header correlation,
    signature, address, or token to fail closed.
15. Lose the first `accepted`/action-result delivery, then retry the complete exact input with the
    same semantic `msgId` and a fresh ingress-result `deliveryAttemptId`—not a fresh native
    attempt—before and after coordinator restart. Require
    one decision and command plus a newly deliverable envelope containing the same stable result.
    Split the side-effect expectations: admitted projected user/attachment gets one viewer projection
    and one native attempt; an admitted supported control gets one native attempt and no user
    projection; queued or rejected/unsupported gets neither. A later forwarding request must be a
    fresh authenticated source event, command, sequence, and version-one result. Repeat while the
    original is still `assembling` and
    `awaiting_order` and `deciding`. Redeliver the same committed broker cursor across a crash and
    require the same deterministic observation/result-delivery rows and stored output attempt ID.
    Compact part bodies, lose the result delivery, and require an exact replay to reproduce the
    retained stable result ID and payload without another command or projection sequence. In one
    broker generation, request the same projection through catch-up twice: each request gets a fresh
    persisted delivery attempt, exact retries of one outbox row reuse it, and the viewer folds one
    semantic projection.
16. Reuse the semantic ID with changed content and require a collision without cursor advance or
    mutation. For multipart input, replay one old part, all exact parts, and one changed sibling across
    restart and a sealed broker-generation rollover; overflow/expire an incomplete candidate; deliver
    a late missing part; place a complete proposal B between the first and final positions of proposal
    A; and require full-candidate matching, no premature success, no B decision/order allocation before
    A completes or expires, exact per-part cursor positions, and contiguous progress across the
    manifest chain. Retry one unchanged delivery attempt within a generation and require its original
    cursor; retry it after rollover and require that same original cursor with no new semantic result.
    Change normalized frame bytes under that route-wide attempt/part key and require a broker transport
    collision. Retry only one part of a formerly complete multipart attempt after rollover and require
    the same original position with no result delivery or candidate completion; only a fresh attempt's
    complete part set may replay the stored semantic result. Then make the hostile broker replay that
    valid part at a fabricated new cursor and require one `exact_transport_retry` with no result
    delivery or candidate change. Reveal an incomplete attempt first at cursor 10, then its duplicate
    at cursor 5 with complete proposal B at cursor 7; require the result's first cursor to move to 5,
    that duplicate to inherit the candidate block, and B never to decide before the multipart attempt
    completes or expires. Crash after a generation seals but before its last frame is consumed:
    recovery resumes the durable cursor, drains through the stored frame count, and only then consumes
    the successor.
    In the later A1.10 retention gate, compact an old checkpointed discovery scope-bus frame body after recovery leases pass, then retry
    that attempt/part unchanged and changed; the retained route-wide tombstone must return the original
    cursor or a collision, never insert a new position. Attempt the same compaction on chat and
    server-control routes and require rejection.
    Interleave announcements for two chats on one scope bus across generations; require one bus-route
    cursor/manifest sequence distinct from both chat routes. A malformed bus position quarantines only
    that route and requires explicit bus recovery while both chat routes remain writable. At one
    existing cursor, redeliver identical bytes, then equivocate with valid-A/valid-B and
    valid/malformed bytes across restart; only the identical copy is idempotent, while each changed copy
    records alternate digest evidence and a blocked route gap with no parse, mutation, or progress.
    Transplant valid frames across machines, servers, equal-ID cross-server chats, different chats,
    bus↔control↔chat routes, and null↔non-null chat coordinates; each fails route matching before
    KDF/open and records an invalid position on the
    selected route. Replay an exact sealed manifest, then change its count/state/successor or present an
    index outside its sealed count; retain the original manifest and record durable
    manifest-equivocation quarantine across restart.
    Create every route with generation-zero genesis. Reject a mutating chat subscription that begins at
    a later generation or misses a manifest successor. For discovery only, seal and sign non-empty and
    empty bus checkpoints, persist the applied checkpoint/effective successor across restart, and reject
    stale/open/forked metadata or any attempt to seed chat/semantic state from it.
    Reconnect/replace the web client and coordinator, then reveal unseen pre-boundary ciphertext;
    require the same deterministic web namespace. Reject an in-place namespace reset while the old A1
    keys/routes remain live. Attempt tombstone collection after ordinary retention, local chat closure,
    and machine reset; selected A1 must reject all three because it has no broker-enforced route
    revocation and copied bearer/key material can remain valid.
    Interleave a known host output and fresh catch-up output before an inbound proposal across crash
    and rollover; require certified host signatures, signer-sequence acceptance, and durable
    outbox/digest matches to advance those positions without source adjudication. Forge output with a
    copied pass, omit a signature, transplant a real signature across route/server, use an old signing
    lease after rotation, and conflict a local outbox part; require blocked quarantine before render or
    mutation. Inject an authenticated but unknown outbound frame and require the same.
    For multipart native output, catch-up, accepted, and action-result deliveries, crash after broker
    acceptance but before the publish response/local receipt; require retry of the exact persisted
    header/salt/nonce/ciphertext/tag bytes and original cursor, never re-sealing under the same attempt.
    Interleave duplicate/missing/wrong-type header JSON, unknown kind, wrong plane, and bad-tag frames
    before valid input; each invalid position records one terminal no-mutation gap and advances
    physically, while the valid proposal remains buffered and non-writable across restart until
    explicit invalid-frame recovery.
    A semantic collision remains a cursor hole until an explicit audited discard/close recovery.
    Compact large part bodies, replay a changed sibling and the full message after the retention
    boundary, and require the retained part-digest vector and full-lifetime result/tombstone to prevent
    a second command.
17. Under one constant `identity_id`, bind OpenCode server A/chat X to `ses_A` and server B/chat X to
    `ses_B`; reuse the same source-local semantic `msgId` but require distinct deterministic web source
    namespaces. Require independent adapter
    leases, ingress/result/native-attempt records, projection/cache/channel coordinates, native
    adjudication, and restart recovery, with no cross-server lookup or mutation despite equal machine
    identity, `logicalChatId`, and source ID. Transplant A's namespace/frame onto B and reject it before
    adjudication. Then run one prompt through the common
    A1 actor and real A2 adapter across decision/outbox/native-attempt crashes, broker rollover, and a
    fresh broker delivery of the exact replayed A1 input while retaining the one original
    `NativeDeliveryAttemptRecord`. A crash before `delivery.started` must eventually permit exactly
    one `prompt_async`; after `delivery.started`, permit at most one send and require either exact
    caller-`msg_*` read-back of one native user message with the expected part
    cardinality/fingerprints or `outcome_unknown` plus binding quarantine. Stored-result replay adds no
    native send; extra/mismatched native parts are a collision/gap. Before dispatch, exercise explicit
    operator cancellation and a deliberately configured shutdown cancellation: atomically retain one
    `NativeBindingPreSendAbandonmentRecord`, move the attempt/dispatch/gate to `quarantined` with the
    same exact evidence schema/ref/digest triple and all start/receipt/read-back fields null, revoke the
    old protected authorization, and emit no native send, replacement, terminal continuation, or
    successor. Race that transaction against dispatch in both orders; crash on both sides; replay it
    exactly; substitute every state, reason, executor, protected reference, coordinate, sequence, and
    digest; and require all-or-nothing state with
    no downgrade. Process death or restart without the record instead resumes only the original
    attempt. Require terminal `user_text` positive-never-started capability null, reject the local
    record as nested continuation evidence, and prove a distinct authenticated source event can still
    use the otherwise-current binding. Keep OpenCode attachment proposals
    non-writable until a retained native fixture proves exact file-part request and read-back semantics.
    Before that proof, parsing/ingress support must deterministically reject with a stored
    `action_result`, no `accepted`, projection sequence/intent, file write, or native attempt; exact
    replay only redelivers the rejection and changed bytes collide. After that gate, apply the common
    A1 attachment accepted/result/replay rules without bypassing the adapter's capability check.
    Pin the current per-family OpenCode capability snapshot in the decision and attempt; race its
    withdrawal/upgrade. Exercise separate TUI/adapter front doors, reject raw/third/second-TUI/stale-
    wrapper and wrong-session/child/permission writes, and crash around the one-time dispatch CAS.
    Require attempt, dispatch, and command gate to start in that one commit with no partial state.
    Normalize typed `/compact` before decision; reject blank, `/clear`, and other unproved reserved
    commands with stored results and no user projection/native call, including raw-as-user bypass,
    exact replay, and changed-byte collision.

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
