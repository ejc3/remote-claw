# Client-driven host runtime

<!-- Keep each prose paragraph and list item on one source line. iOS Markdown previews render soft source wraps as visible line breaks. -->

**Status:** selected architecture; A1.0 through dormant A1.8a0 are implemented. A1.8a1-E0 implements the six E-side ID contracts and four deterministic derivations; E1a implements the four strict ref-free parent envelopes and closed child registry; E1b1 implements both executable-content manifest codecs, generic stable-descriptor collection, and the retained real OpenCode 1.17.5 Linux-arm64 native vector; and E1b2 implements the strict full-u64 workspace leaves, raw-five-view DAG/parent verifier, synchronous independent no-follow collector, and non-skipping direct-unprivileged/hosted-CI-demoted namespace proof. E1b1 and E1b2 remain historical-only and prove no process, currentness, authority, stateful acceptance, production operation, or capability. E1b3's front-door/listener contract is now frozen but unimplemented: it selects one deterministic default-closed ESM build, complete raw OpenAPI retention, cycle-free route declarations, exact module-level closures, sealed measured dispatch, a raw-seven-view listener-parent verifier, and a mandatory actual-fixture gate. E1b4 isolation and E1b5 capability/full-parent closure remain planned. E1c then owns stateful accepted evidence only after E1b5 under the [technical reference](client-driven-host-runtime-reference.md#41-a18a1-native-binding-authority-freeze-planned-dormant), without changing either transport pointer; I remains planned after E1c, A1.8a2 admitted arming after I, and A1.8b sealing/publishing after full A1.8a.

This page explains the design from the user's point of view. The [technical reference](client-driven-host-runtime-reference.md) contains the exact adapter contracts, durable records, recovery algorithms, and crash-boundary rules. [Protocol & Runtime](protocol.md) describes what the current code does today.

Unless a paragraph or status label says otherwise, the behavior below is the target rather than a claim about the current wrappers.

**Today:** the process-local A0.1 and A0.2 registration work has landed. In its default Anthropic-inference mode, Claude `--rc-app` intercepts Remote Control traffic while tunneling other Anthropic calls; its Bedrock mode terminates the Anthropic-shaped surface locally. OpenCode and tmux now fail closed through the same registration seam before their compatibility bridges become visible. Tmux uses one private per-launch server/socket and permits many independent wrapper invocations on one host, but the registration and synthetic broker chat remain process-local: an ordinary wrapper restart does not recover the same stable logical-chat/native binding. Codex and the outward official-client connectors are not implemented.

**A1.0 through A1.6 today:** the canonical field writer, host-state contracts, Linux-only secure SQLite kernel, migrations, synchronous high-level transactions, and verified protected artifacts have landed. A1.2 supplies schema v3 and the dormant server/project/chat/binding/coordinator repository. A1.3 supplies the schema-v4 runtime-owner repository and semantic validator, exact `rcrt_*` identity, independently supervised owner daemon, authenticated and resource-bounded local RPC, process-start-bound service leases and takeover, wrapped Ed25519 custody, and durable multi-runtime/multi-conversation ownership records. A1.4 advances the database to schema v5: migration 5 has 38 ordered statements, digest `l32ozsKKBm5ueLOk-_IeiasPgp_deE-tZHEbaZ6urOE`, and a complete 269-object manifest. It implements five canonical evidence schemas—`remote-claw/native-engine-descriptor/v1`, `remote-claw/durable-project-selection/v1`, `remote-claw/native-conversation-ref/v1`, `remote-claw/native-conversation-capabilities/v1`, and `remote-claw/native-registration-metadata-evidence/v1`—plus exact evidence-resolving registration, generation-fenced native-conversation process leases, generation-ordered publications, contiguous per-lease operations, bounded duplex callable ports on authenticated owner RPC, and exact close/reattach and unknown-commit reconciliation. Each authenticated connection is bounded to 64 callable ports, 32 concurrent reverse invocations, and 4,096 reverse request IDs. Reattach requires fresh current owner/coordinator authority and the exact binding/incarnation/attachment graph; a retained publication must canonically advertise `liveReattach:true`, while pre-publication recovery does not invent that capability. A stale open lease remains historical crash evidence but cannot mutate. Fresh-authority reattach atomically retains its close proof and creates a new process lease and port; for a bound predecessor whose authority tuple changed, it also rotates the transport lease on the same binding incarnation and attachment. A1.5 adds pure browser-safe A1 v2 address/token, route, KDF, frame, digest, certificate, and `ViewerOnboardingBundleV2` codecs. Schema v6 migration `006-terminal-native-root` has 36 ordered statements, digest `li87zqB0yxSfRtN-p_xT5Yk2xAvX8Iy5a1xDXNTYYZo`, and a complete 304-object manifest: 36 tables, 78 indexes, and 190 triggers. Its two-stage terminal-root repository creates and binds a current `native_root` signing reservation to the exact ready A1.4 graph. After protected signing, the trusted service performs its ephemeral callable-port proof immediately before synchronous finalization. Only the transaction-local terminal-root finalizer may store and accept that operation-attached v6 signature; it samples the acceptance/commit timestamp, rechecks authority, verifies the Ed25519 certificate, and inserts the certificate that atomically makes the chat and terminal edge current. Public runtime-owner store, accept, and abort operations reject these reservations; legacy unattached v5 signature history remains inert and compatible. The repository reconciles an unknown commit and renews only from the latest retained certificate. Recover, drain, close, and reattach demote a rooted chat back to recovering and its edge back to installing without deleting certificate history; registration must become ready again before a current-fenced renewal can restore writability. The proof is not retained or replayed by snapshot validation. Certificate expiry alone does not auto-demote the persisted chat/edge, so any future effective route or dispatch must recheck both expiry and the live attachment/process lease.

**A1.6 broker foundation today:** `@remote-claw/clawsec` now freezes the browser-safe selected-backend capability vector, its canonical bytes/digest, immutable route/store/generation records, generation-manifest digest, publish/retry/collision receipts, and bounded one-generation read pages. A separate bearer-authenticated `/api/a1/*` surface accepts only the explicit `x-broker-backend: sqlite` selector; the server derives `identity_id` from the bearer, recomputes every route token and `rcr_*` ID, and requires the pinned capability digest on open, relay, and subscribe. The SQLite/libSQL backend reserves a random immutable `rbsi_*` store instance in an A1-only catalog, provisions genesis generation zero, retains ciphertext frames, route-wide `(deliveryAttemptId, part)` tombstones, collision evidence, and sealed manifests indefinitely, automatically seals at 4,096 unique frames, and returns at most one generation and 64 frames per bounded page. An exact retry returns its original cursor even after rollover; different normalized frame bytes latch the first collision and allocate no new cursor. A known missing physical store is durably marked lost and is never silently recreated, and A0 retention cannot enumerate A1 routes. The browser-safe client requires capability negotiation before opening a route, validates every response and normalized frame, and reports an ambiguous network result as outcome-unknown instead of retrying automatically. Schema v7 migration `007-a1-broker-routes` has 22 ordered statements, digest `uShlOvT_fWScwCLQD1g6-GAd1YyKR2QIlGjC0SPQWbw`, and a complete 326-object manifest: 39 tables, 85 indexes, and 202 triggers. It adds durable capability pins, broker routes, and channel generations; its coordinator-fenced repository installs only an exact confirmed empty/open generation-zero receipt and reconciles exact unknown commits. A host-only installer performs the remote-open/local-install split safely. All of this remains dormant transport state: it creates no ingress cursor, actor, command, native effect, checkpoint, server-scope signature, or viewer projection.

**A1.7a dormant ingress today:** schema v8 migration `008-a1-durable-ingress` backfills every installed v7 route and auto-seeds later routes with a runtime head, generation observation, independent physical-fetch and semantic-prefix cursors, and an unclaimed revisioned actor. Its repository retains exact read-page and per-frame evidence, raw first-seen ciphertext, authenticated position classifications, opened plaintext evidence, multipart attempts/candidates/parts, exact-retry observations, collision and incomplete tombstones, gaps, and explicit recoveries. Physical fetch may continue within bounded lookahead while an earlier multipart proposal blocks semantic progress; only the longest contiguous advanceable prefix moves the semantic cursor. The current-fenced, per-route actor stages evidence before parsing or AEAD open, reconstructs bounded multipart chat and server-control input, survives exact retry and unknown commits, expires incomplete candidates, classifies late parts, latches collision/quota/equivocation gaps, and leaves a complete semantic result durably in `awaiting_order`. The actor module is intentionally absent from package barrels and every production run path.

**A1.7b0 dormant server signer today:** schema v9 migration `009-server-scope-signer` adds the initial server self-anchor, an AES-256-GCM-wrapped Ed25519 private-key envelope with no raw-private-key API, coordinator-fenced bootstrap and current signing leases, and durable signer-sequence reservation, payload binding, signing, acceptance, and exact reconciliation. It also replaces the existing broker-route admission trigger so the dormant route installer accepts either an `installing` server or an exact signer-activated `current` server under the same current-coordinator and capability-pin proof; this adds no route table or production call path. The bootstrap lease can sign only the initial `scope_certificate`; installing it opens the normal current lease. If coordinator authority changes before that bootstrap closes, reconciliation retains an immutable fail-stop with `writable:false` and `nonWritableReason:"stale_bootstrap_fence"`; v9 cannot re-fence or replace it or allocate another reservation, and explicit repair remains later. After installation, coordinator takeover instead supersedes the normal current signing lease and, once no `reserved`, `bound`, or signed-but-unaccepted predecessor reservation remains, permits a fresh lease at the exact next fencing token. Every later signature is bound to the exact machine, collaboration server, protected handle, identity key/generation, public key, payload purpose/schema/digest, scope certificate, signer sequence, coordinator lease/epoch, and fencing token by the frozen record/schema contract. A1.7b0's callable repository path exercises reserve/bind/sign/accept/reconcile only for that initial scope certificate; A1.7b1 now consumes the installed current lease through its closed command-result signing path, not as a generic signing endpoint. Acceptance uses its own dense per-server `acceptedAtJournalSeq`, not the schema-v3 control journal. These direct host-state/custody/repository services remain dormant. A1.7b0 itself does not consume an `awaiting_order` result or create a common command, command decision/result, generic host output, broker publish, result delivery, outbox/effect, native dispatch, projection, or production operation.

**A1.7b1 dormant command adjudication today:** schema v10 migration `010-common-command-adjudication` contains 50 ordered statements, digest `rdJC_2C5IyjfsTuXhxjFSzT0bvDYtlpT8o0xDvu4IEk`, and a 619-object manifest: 70 tables, 137 indexes, and 412 triggers. It adds exactly five tables: `command_ready_entries`, `a1_ingress_adjudications`, `collaboration_commands`, `collaboration_command_compound_signing_groups`, and `collaboration_command_result_preparations`. A ready transaction consumes the collaboration server's next shared journal offset, so `command_ready_entries` and schema-v3 `control_journal_entries` form one exact gap-free journal under `nextJournalOffset`; it admits only the earliest unadjudicated `awaiting_order` A1-ingress source on a current gap-free route. Source identity and `rcm_*` command ID are deterministic. The pure common payload contract accepts exact scalar `user_text` through 48 MiB, but this rejected-only persistence path never copies the large retained ingress plaintext: it stores a small `unsupported_recognized` envelope committing the source schema, canonical message digest, and source-event fingerprint. The current policy globally chooses the minimum `(readyAtJournalSeq, commandId)`, allocates the next dense `commandSeq`, and can only freeze `rejected`; no target capability/effect arm exists yet. Creation and decision authority are distinct retained fences, so a current successor coordinator may decide an older ready command without rewriting its creator fence or `createdAtMs`; `decidedAtMs` remains monotone. The decision transaction reserves one version-one `ccr_*` result plus deterministic `csg_*` group and `crp_*` preparation and returns that durable `reserved` generation. A separate dormant signer operation binds it to the current v9 signing lease, signs, and durably stores the signed preparation before that operation returns. A reserved or bound generation may be atomically aborted; a later reprepare reserves the next signer sequence, advances `preparationGeneration` and `supersedesPreparationRef`, and retains the exact command, command sequence, disposition, result ID, and decision time. The durable terminal state of this tranche is the current preparation/group/reservation at `signed`/`result_signed`/`signed`, while the command and A1 ingress sidecar remain `decision_reserved`/`deciding`.

**A1.8a0 dormant rejected-result finalization today:** schema v11 migration `011-a1-rejected-result-finalization` contains 38 ordered statements, digest `SkkuAFJed-7GT9XyXXPCub7VFauqNY6eu0u4IQJEInc`, and a 647-object manifest: 73 tables, 147 indexes, and 427 triggers. It adds exactly `collaboration_command_results`, `a1_ingress_terminal_results`, and `a1_ingress_result_deliveries`. One fenced repository transaction consumes only a current schema-v10 rejected preparation whose required finalization artifact is `none`; inserts the immutable common result and next dense signed-record acceptance; moves the command and A1 adjudication sidecar to `decided`/`terminal`; stores the exact compact `action_result` or `chat_creation_result` payload as a protected artifact; and inserts one causal delivery intent in `pending_seal`. The schema-v8 `authenticated_ingress_results` row stays immutable evidence in `awaiting_order` or a later `quarantined_collision`, and no channel cursor advances. The preparation, compound group, and signature reservation remain `signed`/`result_signed`/`signed`; the accepted result and terminal graph prove their consumption. Finalization deliberately does not require the source route to remain current or gap-free after signing, so later collision/quarantine or exact source-close recovery cannot erase the signed rejection or strand coordinator takeover. A narrow rule permits the exact live successor coordinator to accept a predecessor-lease command-result signature only when it was validly stored before lease supersession and the same current key/certificate/custody chain remains intact; any later successor signing lease must be acquired strictly after that predecessor acceptance, even when timestamps otherwise share a millisecond. This is not generic superseded-lease or rotation acceptance. The retained `pending_seal` row contains only semantic payload refs/digests and immutable target linkage. It is unclaimable in A1.8a0: no ciphertext, output part/signature, sealing, publication, broker call, effect, attempt, projection, native dispatch, or production path exists.

**A1.8a1 native-binding authority (E0/E1a/E1b1/E1b2 implemented; E1b3 design frozen; E1b3–E1b5/E1c/I implementation planned):** E0 supplies identities. E1a supplies only the four canonical parents and ref-free `role/schema/digest/byteLength` commitments. E1b1 closes both bounded executable manifests and generic stable-descriptor collection, with actual retained native evidence only. E1b2 closes the four workspace leaves, raw-five-view verifier, and historical direct-only Linux observation. E1b3 is frozen into E1b3a pure codecs plus a deterministic dormant inherited-FD build/activation target and E1b3b direct-only capture plus retained proof: its selected OpenCode 1.17.5 Linux-arm64 target is one Node 22.23.2/esbuild 0.28.0 ESM bundle whose compiled registry contains only output-independent declarations and symbol IDs; post-build code derives closure- and binary-bound identities, compares the sealed live declaration projection item-for-item, and verifies the six leaves plus separately supplied E1a listener parent. Fixed outer private PID/mount/network/IPC namespaces come first; inside them setup creates root/work/dev, the zero-capability install resolver fills fixed runtime temporary inodes, setup finalizes and seals the root, the inner user/PID/mount target runs, and the zero-capability verify resolver repeats the source/copy proof before response handling. Gate-init recursively clones the locked inherited subtree inside the child mount namespace before pivoting away and detaching the host root. It resets keyrings/capabilities and installs inherited seccomp plus target-only Landlock before any selected target. Exact dynamic-loader/DSO and static gate bytes are committed through `B`, and arm capture binds the same platform manifest through `S`. Two checked parent-death edges cover sudo→timeout and timeout→outer unshare; outer `--kill-child` makes setup PID 1 and kernel-contains every resolver/helper/inner descendant, while inner `--kill-child` covers its own PID 1. Caller or host loss leaves the still-armed timeout, and every loss path remains fail-closed under the nested deadlines and required absence proof. Only `POST /session/{sessionID}/prompt_async` and five observer routes are positive; the not-yet-retained status route must be present in E1b3b's exact `S` or the gate blocks. TUI and server creation remain deny-only, and every other OpenAPI operation has an explicit closed disposition. The design creates no process/socket/currentness or authority claim. E1b4 isolation and E1b5 capability plus all four parents must still close before E1c may retain the exact `user_text` authority chain. E1c's frozen staging/quarantine/reconciliation rules and I's matched-pair install remain planned; neither creates an admitted command, attempt, effect, native call, production operation, or capability claim.

**Production boundary after A1.8a1-E1b2 and the E1b3 design freeze:** the trusted registration/root orchestration surface is installed only when `startProductionRuntimeOwnerDaemon` receives an explicit `registrationAdapter`. The ordinary CLI passes none, so its operation registry remains empty, authenticated RPC remains health-only, and health reports `ownerOperationsWritable:false` and `nativeRegistrationEnabled:false`. Wrapped Claude MITM, OpenCode, and tmux remain A0 drivers. A1 broker, ingress, adjudication, signing, and rejected finalization stay confined to dormant host-only modules/tests. E0/E1a/E1b2 pure state codecs are exported; E1b1/E1b2 collectors are direct-only. E1b3 is documentation only at this point: no front-door package, collector, proof fixture, production import, owner operation, listener, dispatch, or advertised capability exists. E1b4–E1b5/E1c/I also remain unimplemented. A1.8a2 must add any admitted native attempt/front-door dispatch/effect arm atomically, and A1.8b must seal and publish before a live result capability exists.

**The A1.2/A1.5 boundary:** each chat stores the exact selector-mapping generation it used; replacing the current terminal mapping affects later selection without silently moving old chats. A1.4's repository and trusted-adapter seam can resolve and verify A1.2's evidence and durably activate the matching native binding/incarnation and lifecycle gate. A1.5 can then sign and atomically activate that exact terminal reservation, but the ordinary production CLI supplies no adapter and invokes neither operation for a real driver. A newly bootstrapped A1 graph stays recovering, with its binding unresolved and starting and its random `rcie_*` native-harness edge installing and non-writable, until the opt-in seam advances it; the absence of an adapter does not demote or rewrite previously persisted opt-in state. A1.2's actor scopes are durable addresses; A1.7a now supplies dormant route-local ingress serialization, while common command admission/order remains in A1.7b. Nested mappings and remote-server edges remain rejected until N1.

<a id="1-decision"></a>

## The design in one minute

In the selected architecture, remote-claw runs beside Claude Code, Codex, or OpenCode, normally in the same small VM. Tmux remains a lower-fidelity fallback.

The native harness is the innermost and only state-mutating coding app. It supports two participants at that boundary: one person using the real native TUI and one remote-claw bridge using the product's native remote/server protocol. For example, Claude Code should feel like its working local-plus-Remote experience: the person at the keyboard and remote-claw collaborate in one Claude session.

The remote-claw bridge appears to the native harness as one remote collaborator. Behind that bridge, a remote-claw server can support many collaborators: web users, official-client connections, automations, or another remote-claw server represented by one more bridge. This can nest repeatedly, but only the innermost end contains Claude Code, Codex, or OpenCode.

The inner coding engine will be private. It will never connect directly to Anthropic, OpenAI, or another model provider. It sends provider-shaped requests to local endpoints owned by remote-claw. A separate inference connector may call the configured model service, using credentials and sockets that the inner process cannot access.

Each remote-claw server gives its own collaborators a stable order, deduplicates their requests, and presents their combined work inward as one collaborator. It may hold or reject a remote proposal only when that source's advertised protocol can show the same outcome faithfully; otherwise the binding is not writable for that policy. It does not decide whether the coding state actually changed: the innermost native harness is the ultimate arbiter because it is the component that accepts messages, runs tools, and mutates files.

Within each remote-claw server, the logical chat is the stable, user-visible chat. Restarting an inner process, an inward edge, the coordinator, or an outward official-client connection must not create another visible chat. Starting a new chat, clearing one, or forking one remains an explicit operation.

remote-claw is authoritative for its stable chat identity, collaborator membership, and the order in which its own collaborators are offered inward. The native harness is authoritative for the final interleaving with direct TUI input and for what was actually accepted or executed. Recovery uses native state first and the remote-claw control journal second, without maintaining a competing assistant transcript.

## Where everything runs

Read this from the state-mutating inside toward the collaborating outside:

```text
native harness
├─ real native TUI
│  └─ person
└─ remote-claw bridge
   └─ one remote collaborator
      └─ server A
         ├─ web collaborator
         ├─ official client
         └─ nested server B
            └─ ...
```

The native harness appears exactly once, at the innermost end. Every remote-claw server can fan many direct collaborators into one inward collaborator and fan native observations back out. A deployment does not need recursive nesting, but the design stays correct if nesting is added later.

Model inference is a separate branch from collaboration:

```text
native harness
      │ provider-shaped request
      ▼
private local façade
      │
      ▼
inference connector
      │
      ▼
configured model service
```

An official-client connector is not the native harness's model connection. Official Claude and ChatGPT apps still use the provider-facing protocol expected by those apps; remote-claw terminates or participates in the corresponding host/worker connection and represents those clients as collaborators. The private native harness receives neither those credentials nor those sockets.

## One paired host, many independent sessions

Pairing names the host, not one coding session. One paired remote-claw host must discover and serve every independently wrapped Claude Code, Codex, and OpenCode session running on that machine:

```text
paired host “fcvm”
├─ Claude Code · /work/remote-claw · chat A
├─ Claude Code · /work/other       · chat B
├─ Codex       · /work/remote-claw · chat C
├─ Codex       · /work/experiment  · chat D
└─ OpenCode    · /work/site        · chat E
```

Each row keeps its own logical-chat ID, native conversation ID and history, working directory and project mapping, runtime or daemon attachment, local TUI path, remote collaborators, recovery state, and delivery gates. Two sessions may use the same product or even the same directory without becoming the same chat; a directory is useful display and routing metadata, never conversation identity.

Remote work is serialized only within the destination logical chat and its current inward binding. The host may assign global journal positions for durable bookkeeping, but a busy turn, uncertain delivery, restart, permission gate, or failed adapter in chat A must not delay, quarantine, reconnect, or mutate chats B–E. Each wrapper launch may own a separate native process or daemon, while native daemons that legitimately serve several conversations, such as Codex or OpenCode, may also be shared underneath. In either topology, closing one conversation lease must not close another runtime, the shared daemon, or another conversation.

After a host or coordinator restart, remote-claw enumerates every durable binding and independently reattaches its exact native session before making that row writable. It neither chooses a “most recent” native session nor creates a replacement visible chat just because one wrapper, bridge, or coordinator restarted. After a project has been allocated durably, the runtime owner may record direct-TUI conversation transitions while no coordinator lease is current; it cannot allocate the first project or infer one from a directory. Local TUIs and runtime-scoped inference remain available while no coordinator lease is current; remote mutations report unavailable and each healthy remote path is re-enabled independently only after its own lease, binding, and attachment proof passes. A failed recovery quarantines only that row. A nested remote-claw server can occupy one collaborator binding on any one of these chats without changing this isolation.

## Drop-in native-client compatibility

Changing only the native app's server endpoint or launching it inside the Claude wrapper must not create a different product experience. The same pinned client is the test client on both sides:

```text
Codex direct
  Codex TUI
      ⇅
  real app-server

Codex through remote-claw
  same Codex TUI
      ⇅
  remote-claw endpoint
      ⇅
  real private app-server

Claude direct
  Claude Code
      ⇅
  Anthropic API + Remote

Claude through remote-claw
  same Claude Code
      ⇅
  private API + RC façades
      ⇅
  isolated connectors

OpenCode direct
  OpenCode TUI
      ⇅
  real OpenCode server

OpenCode through remote-claw
  same OpenCode TUI
      ⇅
  remote-claw endpoint
      ⇅
  real private server
```

For Codex, the remote-claw endpoint is a full-duplex, protocol-transparent front door to the real private app-server, not a reduced command API. The Codex TUI's connection does not pass through the collaboration coordinator. For Claude, the inner process cannot reach Anthropic, so remote-claw must answer every API and Remote Control operation used by each supported, pinned Claude Code version with the same externally visible semantics. An unrecognized version or operation fails as unsupported instead of silently degrading.

“Same result” means the same native session and thread transitions, connection handshake, request/response and server-request behavior, streamed notifications, editing and submission behavior, busy/steer/interrupt behavior, permissions and questions, controls, errors, and reconnect behavior. Given the same model responses and the same input race, it also means the same native transcript, tool actions, and filesystem effects. Tests may alpha-rename fresh opaque IDs only after proving the same allocation count, equality and alias relationships, scope, and continuity across history, reconnect, and fork; a surprise replacement ID is a failure. Choosing a different model or provider may change model content, but remote-claw itself may not introduce a semantic difference.

The official mobile, web, desktop, and editor surfaces have the same rule for every workflow remote-claw claims to support. If a native or official client can distinguish the remote-claw route from its normal route in a way that changes behavior, that is a compatibility bug or an explicitly unsupported capability, never an accepted alternate workflow.

<a id="how-one-command-moves"></a>

## Commands and updates

<a id="5-normalized-command-path"></a>
<a id="7-delivery-state"></a>
<a id="11-core-workflows"></a>
<a id="112-local-or-web-text"></a>
<a id="113-official-client-text"></a>
<a id="114-two-writers"></a>

There are two inputs at the innermost boundary.

### The person at the keyboard

```text
person
  │
  ▼
real native TUI
  │
  ▼
native harness
```

The local person uses the product normally. Their editing, Submit action, rendering, busy state, permissions, and controls remain native. That input does not detour through a remote-claw server before reaching the native harness.

### Everyone behind remote-claw

```text
many collaborators
      │
      ▼
remote-claw server
 order / deduplicate
      │
      ▼
one bridge connection
      │
      ▼
native harness
```

The server assigns stable source identity, turns every web, official-client, automation, or nested proposal into the same common command shape, records its durable server journal position, and signs one final admitted, queued, or rejected result before any adapter may act. Within one logical chat, proposals are offered inward in that chat's stable order; different chats have independent actors and delivery gates. Claude, Codex, and OpenCode all use this decision path for remote input. Starting a chat and writing to an existing chat choose different destinations, but they do not bypass the common decision. If delivery may have started but the outcome is unknown, the server does not blindly retry that chat, while unrelated chats continue. With nested remote-claw servers, each server performs the same job and the whole server behind an edge appears as one collaborator to the next layer inward.

An admitted result is permission for exactly one pinned adapter action, not proof that the coding engine accepted it. The adapter must translate the common command into the exact native request allowed by its checked version and capability, send it only through the fenced native front door, and match the native response or read-back to that command. A missing route, changed translation, stale front door, incomplete read-back, or ambiguous outcome stops the path and records uncertainty; it never falls back to a similar-looking request.

A new submission and a steer of an already running turn are different commands. The server never guesses between them from timing or busy state. Until a native adapter has separately proved steer behavior, an explicit steer is rejected rather than sent as a new message.

### The native harness decides

```text
local TUI ─┐
           ├─► native harness
remote ────┘         │
                     ▼
                coding state
```

The native harness decides which input is accepted, how local and remote actions interleave, whether a busy turn can be steered, and what actually mutates state. A remote-claw receipt, signed admission, HTTP success, or forwarding decision is not proof of native acceptance. The remote-claw chat adopts the native result only when the harness reports evidence that matches the admitted command.

### Results move back out

```text
native harness
├──► real native TUI
└──► remote-claw bridge
         │
         ▼
    remote-claw server
         │
         ▼
    its collaborators
```

The native TUI renders the native session directly. The bridge observes the same session and projects its results outward. Every event retains its origin, direction, and edge lineage. An inward proposal may produce an outward native result that returns over the same physical edge in the opposite direction; that is the required reply path. The proposal may not traverse the same inward edge twice, the result may not traverse the same outward edge twice, and no observation or returned echo may be converted into a new inward proposal. Those rules prevent feedback loops without suppressing legitimate results.

The compatibility contract above applies to both flows. remote-claw adds one collaborator and controlled transport boundaries; it does not replace the native product experience.

## Who owns which facts

<a id="2-one-source-of-decisions-several-sources-of-evidence"></a>
<a id="6-control-journal-and-rebuildable-projection"></a>

| Fact | Authority or strongest evidence |
| --- | --- |
| Stable remote-claw chat identity and direct-collaborator order | That remote-claw server |
| Whether a remote proposal is forwarded inward | That remote-claw server |
| Final interleaving of local-TUI and remote input | Innermost native harness |
| Whether a message was accepted and what mutated | Innermost native harness and its durable store |
| Native conversation, tools, subprocesses, and side effects | Innermost native harness and its durable store |
| Representation accepted by Anthropic or OpenAI | That provider transport |
| Encrypted frames accepted for replay | remote-claw broker |
| What a client actually rendered | That client device |

Each server stores a small control journal for its own collaboration boundary: source IDs, direct-collaborator order, forwarding decisions, inward and outward delivery state, exact correlation mappings, recovery cursors, and explicit gaps. Direct TUI actions enter that journal when the native harness exposes them; remote-claw does not invent a pre-execution decision it never made.

No server tries to recreate a lost native conversation by replaying old prompts, tool calls, approvals, or questions. If native evidence proves a command happened, it is not sent again. If evidence proves delivery never began, a fenced retry may be allowed. If delivery may have begun but the result is unknown, later inward writes wait until the old work is contained or reconciled.

## What stays stable

<a id="3-nesting-and-identity"></a>

The visible hierarchy is:

```text
host
└── project
    └── logical chat
```

Each layer has its own identity:

| Identity | Meaning | Restart behavior |
| --- | --- | --- |
| Server + project ID | Stable project grouping and selector scope on one paired host | Allocated durably; never reconstructed from cwd, title, provider IDs, or whichever session is newest |
| Server + logical chat ID | Canonical chat within one remote-claw server | Stays stable across that server's infrastructure and transport restarts; never aliases another server's chat |
| Machine identity + server + logical chat ID | Broker route, visible viewer row, alias, channel, and cache coordinates | Stays stable across reconnects and prevents equal server/chat IDs under another machine credential from colliding |
| Terminal native binding ID | Relationship between the innermost server chat and its native conversation | Exists only at the terminal edge and stays stable while the same native conversation is resumed |
| Native conversation ID | Claude UUID, Codex thread ID, or OpenCode session ID | Native evidence; never used as the remote-claw routing ID |
| Native runtime generation | One proven process or server generation | Advances when a native runtime is replaced |
| Private collaborator attachment | Claude `cse_*`, remote-claw app-server/SSE connection, or tmux attachment | Reused when possible; replaceable beneath the same binding; distinct from the person's native-TUI connection |
| Collaborator binding | Web, official-client, automation, or nested remote-claw participant | Reconnects independently without changing the logical chat |
| Inward edge | One remote-claw server represented as one collaborator to the next layer toward the native harness | Reconnects without duplicating the represented subtree or its commands |

IDs are never aliases. A Claude `cse_*`, Codex thread ID, OpenCode `ses_*`, tmux pane, broker channel, and remote-claw logical chat ID remain distinct. A nested edge explicitly maps two servers' distinct chat IDs.

A durable project is selected before a durable chat or native binding is created. The first project and its initial target selector are allocated together; later launches name an exact existing project/selector or explicitly create another project. The current A0 compatibility wrappers may report no project, but that means only “unresolved in this process” and cannot be used to recover or silently assign an A1 chat.

At the terminal edge, exactly one native binding is current for a logical chat at a time. An outer server chat instead has exactly one current inward edge to another server/chat pair. Old edges, bindings, and delivery attempts remain in the journal so a late process or connector cannot act as the current owner.

A remote-claw inward write is valid only when it names the current coordinator and inward-edge generations. At the terminal edge it must also name the current native-process and private-connection generations. Revoking an old owner prevents new remote writes, but it cannot undo work already sent inward or stop the native TUI path. If an old attempt may still run, remote-claw must contain it or positively prove that it finished or was cancelled before a replacement inward edge becomes writable.

## What happens after a restart

<a id="8-restart-and-recovery"></a>
<a id="111-host-start-and-stop"></a>

The runtime owner is independently supervised and persists its own service epoch. Schema v7 and the landed repositories can persist runtime inventory, wrapped keys, local conversation transitions, exact native-registration lease/publication/operation history, the terminal-root activation chain, and dormant A1 broker capability/route/genesis receipts. The trusted A1.4/A1.5 adapter seam can register, reattach, activate, and renew that graph, while the separate host-only A1.6 installer can provision a dormant route, but the ordinary CLI supplies no adapter and invokes neither seam, so no real production driver creates either graph yet. The native client endpoint, private provider façade, inference connector, and live A1 ingress remain later integrations. If the coordinator or its journal is unavailable at cold start, the local TUI may still use the native harness, but remote collaboration stays unavailable and non-writable until its epoch and journal recover. Coordinator-independent transition persistence applies only inside an already durable project; first-project allocation remains coordinator-owned.

Recovery works from the inside out:

1. Stop taking new remote input and prevent an old server generation from issuing new inward writes.
2. Load this server's exact logical chat, direct collaborator bindings, and one inward-edge mapping.
3. If the edge targets another remote-claw server, reconnect that exact server/chat pair without creating a native app at this layer.
4. At the innermost edge, reattach the surviving native process only when its exact identity and a version-pinned live reattachment method have both been proved.
5. Otherwise, contain the old native process, start a replacement runtime, and reopen or resume the exact known native conversation; reuse its old private transport when possible.
6. Reconcile proposals and observations from inward/native evidence without replaying old work or reflecting observations inward.
7. Reattach the real TUI through the native product's normal lifecycle and reconnect remote collaborators or nested-server edges independently.
8. Make the inward remote-claw edge writable only for the next not-yet-decided proposal. A previously signed `queued` result is final; forwarding later requires a fresh authenticated proposal and command.

At the terminal native edge, common outcomes are:

| Recovery evidence | Result |
| --- | --- |
| Exact process and conversation survive | Reattach; keep the same chat and native generation |
| Same native conversation resumes in a new process | Keep the same chat and binding; advance the runtime generation |
| Same process needs a new private transport | Keep the same chat, binding, and runtime generation; replace only the attachment |
| User explicitly creates, clears, or forks | Create a new logical chat, with fork lineage when applicable |
| Expected identity cannot be proved | Keep the old chat visible but non-writable; show a recovery gap |

Recovery never guesses from a title, working directory, or similar text. A successor conversation can replace an unrecoverable one under the same visible chat only after an explicit recovery decision that records the gap. It is never a silent match.

## Native engine support

<a id="4-host-wide-native-client-adapters"></a>
<a id="9-native-adapter-recovery"></a>

These are target guarantees unless the status column says they are implemented.

### Claude Code

<a id="91-claude-code-wrapper"></a>

- **Control:** one real Claude Code TUI and one private Remote Control connection held by remote-claw as a single collaborator, plus a local Anthropic-shaped API.
- **Recovery evidence:** the Claude transcript/resume UUID and private RC state.
- **Key rule:** preserve Claude's working keyboard-plus-Remote behavior. Try the known UUID and old `cse_*` first; a proven replacement `cse_*` remains beneath the same logical chat. Worker delivery ACK, native acceptance, native observation, and permission/question terminal outcome are separate facts.
- **Status:** the process-local registration seam is implemented. The complete RC/transcript/provider source join, native gate adjudication, disconnect-safe child lifetime, takeover barrier, retained sanitized parity fixtures, durable recovery, and outward Anthropic worker are not.

### Codex

<a id="92-codex-wrapper"></a>

- **Control:** one native Codex TUI client and one remote-claw collaborator connection share a private app-server/thread, plus a local OpenAI-shaped API.
- **Recovery evidence:** Codex threads and rollout state.
- **Key rule:** the checked one-thread shape uses a native TUI connection and a separate remote-claw connection to the same real app-server. The host-wide target allows the trusted direct TUI connections that pinned Codex supports and exactly one daemon-wide native remote-claw bridge with a logical binding and aggregate subscription per managed top-level chat thread. Pinned `0.146.0` subscribes the requester for ordinary top-level thread creation but has different best-effort fan-out for core child-agent threads, so remote-claw must preserve and prove the native subscription, broadcast, and TUI-routing rules instead of inventing selected-thread isolation. A child notification remains nested evidence under its parent until lineage proof says otherwise; it does not create another visible chat. Official streams terminate in the outward gateway and never become native connections, subscribers, or writers. Their lifecycle and subscriptions stay per-stream there; joining or leaving maps the union of current host/collaborator demand to zero or one fenced native subscription transition, while an admitted semantic native mutation maps to one bridge request. The gateway first uses ordinary request-ID/handle remapping and explicit cleanup, adding only proven non-authoritative compatibility or source-lease metadata when native behavior depends on the originating client. If that cannot preserve the pinned behavior, the Codex version or method is unsupported. remote-claw does not build a second native app-server, `MessageProcessor`, thread store, or model runtime.
- **Status:** not implemented. A pinned [Codex 0.146.0 multi-client proof](codex-app-server-multiclient-proof.md) establishes two raw clients mutating one materialized thread, retains a real `codex resume --remote` TUI plus one raw client issuing and observing selected model-free shell-command events in both directions, and proves with three raw connections that two top-level creators own the native subscriptions while non-owners remain `notSubscribed` and lack the selected correlated detailed events until one host observer explicitly resumes both. The proof also shows that an unresumed late client can issue a shell command without receiving its selected correlated five-event projection, so the coordinator must not forward writes until the bridge proves its subscription. Complete Unix front-door parity; real-TUI multiplicity and core child-thread routing/identity; official-stream request/handle remapping, cleanup, durable complete transport state, and client-profile parity through one bridge; other request, notification, server-request, and model/tool families; races, reconnect, backpressure, and crash recovery; external-clock behavior; the provider façade, injected native services, outward gateway, official pairing/live clients, and schema retention remain release gates.

### OpenCode

<a id="93-opencode-server"></a>

- **Control:** one native OpenCode TUI path and one epoch-fenced remote-claw adapter lease share the same private HTTP/SSE session, plus private provider endpoints; the private endpoint enforces the lease because OpenCode exposes no persistent writer connection identity.
- **Recovery evidence:** session history and live SSE.
- **Key rule:** establish and actively drain SSE before taking a history snapshot. OpenCode remote input goes through the same common ordering and signed decision used for Claude and Codex; it has no shorter driver-only path. A chat command may target one terminal OpenCode binding or one installed nested chat edge; `new_chat` may target one terminal OpenCode server or one nested-server management binding. The first planned writable actions are exactly server-scoped `{new_chat}` and binding-scoped `{user_text}`. Compact, interrupt, steer, blank submit, permissions/questions, attachments, clear/fork, and every other unproved action receive a stored signed rejection and never reach OpenCode. An admitted `user_text` is translated deterministically into one exact native request, sent through the current fenced front door, and accepted as applied only when the matching message and order are read back from a complete, ordered OpenCode history snapshot and, when that snapshot method requires it, the matching live event. Before that send, an explicit cancel atomically quarantines the same attempt, dispatch, and command gate and never creates a replacement; only a crash with no committed abandonment may resume that one immutable attempt. Terminal delivery has no continuation. An admitted `new_chat` writes one exact two-field native metadata value containing its generated marker and the digest of the admitted creation intent. After a lost response, reconciliation uses only the complete discovery snapshot for the one current successor attachment, workspace, and observer epoch. Crossing a native incarnation additionally requires the original pre-dispatch snapshot to pin a runtime-owner-signed open/read store coordinate, followed by a typed handoff proving the predecessor stopped and fenced its store handle, the successor exclusively opened that same store, and no reset or fork intervened. If any part is unavailable, lineage is unproved and the new incarnation cannot bind. The successor snapshot must be linearly proved and exhaustive at its proved boundary. The host retains every same-marker session's full native metadata evidence and binds exactly one only when that evidence and its canonical two-field ref/digest recompute and its intent digest equals the reservation; a wrong, missing, or malformed intent, noncanonical/extra metadata, or multiple matches quarantine, while zero remains uncertain. A marker alone never identifies the resulting session. A `prompt_async` 204 is only transport receipt. Missing or conflicting read-back makes the outcome uncertain and blocks retry; changed source bytes are a collision.
- **Status:** the compatibility driver now uses the host-wide seam, opens in `starting`, fails closed on discovery/session selection and, when enabled, parent permission setup, and becomes visible only at `ready` with conservative capabilities. It creates only after a valid empty list, never adopts “most recent,” requires an exact configured target when sessions exist, keeps `nativeRef:null`, and still lacks durable binding/restart ownership. A [retained OpenCode 1.17.5 native proof](opencode-native-proof.md) establishes only the exact creation-marker and caller-message-ID seams. Stock OpenCode 1.17.5 does not yet qualify for writable A2: the retained evidence does not prove the real TUI's exact-process front door, the complete callable front-door manifest, raw-listener/tool isolation, lossless SSE snapshot linearization, or signed exclusive native-store handoff across restart. Those gates must be built and retained before `{new_chat}` or `{user_text}` is advertised; A0.2's empty-list create, compatibility permission PATCH, detach-abort, and other legacy behavior are not silently promoted.

### Tmux

<a id="94-tmux-compatibility-mode"></a>

- **Control:** one directly attached Claude TUI pane plus remote injection and transcript observation.
- **Recovery evidence:** the pane/process identity and the wrapped engine's transcript.
- **Key rule:** person and injector write one pane/editor keystream, not two native collaborator connections. Claude arbitrates only the resulting submitted buffer; simultaneous local drafts and remote paste/Enter can merge, and tmux command receipt is not native acceptance.
- **Status:** the Claude-specific compatibility driver now opens a process-local registration in `starting`, prepares an isolated private tmux runtime/socket, and publishes only after a positive pane probe plus a SessionStart marker from its required merged settings. Before `ready` it creates no broker client or announcement, so no remote mutation can reach the pane. Its published capabilities are deliberately limited: heuristic status is not advertised, native delivery evidence is best-effort, history is partial, and live reattachment is false. Independent wrapper invocations use distinct private servers and can run concurrently, but response-loss reconciliation, write-ahead origin correlation, local/remote permission first-winner parity, keep-pane detach, durable restart binding, and clear/branch identity remain unresolved.

The [technical reference](client-driven-host-runtime-reference.md#9-native-adapter-recovery) contains the per-engine startup and recovery algorithms. Current OpenCode and tmux behavior is documented in [OpenCode Driver](opencode-driver.md) and [Tmux Driver](tmux-driver.md).

Claude Code, Codex, and OpenCode must preserve the native-TUI-plus-one-remote-claw-collaborator shape. Tmux only resembles that layout on screen: the person and injector share one editor keystream, so it remains a lower-fidelity compatibility mode unless an exclusive/quiescent input boundary is proved.

## Participants

<a id="10-outside-adapters"></a>

Remote collaborator bindings are independent of the native engine. Native restart does not rotate them. The native TUI is different: it belongs to the innermost native harness and follows that product's own lifecycle.

### Local native TUI

<a id="101-wrapper-owned-local-ui"></a>

One person uses the real native TUI directly while one remote-claw bridge participates in the same native session. Local actions go to the native harness through the product's normal local path. remote-claw learns their applied order from native observations and never pretends it admitted them first.

### remote-claw web

<a id="102-remote-claw-web"></a>

The E2E-encrypted broker carries the web view. The target is one stable web chat with separate receipt and delivery states. The transport exists today; persistent logical-chat identity does not.

### Official Claude clients

<a id="103-anthropic-remote"></a>

An outward Anthropic Remote worker/session lets official commands enter as server proposals and projects native observations back. An app-side list/history/SSE/text-submission client exists today; outward worker/bridge support is missing.

### Official ChatGPT clients

<a id="104-chatgpt-remote-connection"></a>

One outward paired ChatGPT Remote host preserves the product shape of one named host containing many projects and chats. Pinned Codex source proves that normal official Remote streams and local socket clients are sibling connections to one daemon, each with connection-scoped native state. That is the outward fidelity oracle, not the inward topology: remote-claw moves provider transport and enrollment outside the isolated daemon, keeps every official stream's complete protocol state in the gateway, orders those streams as outside collaborators, and maps admitted semantic native mutations onto exactly one native remote-claw bridge with a binding and aggregate subscription per managed top-level chat thread. Stream-local lifecycle changes reconcile the union of current host/collaborator demand to zero or one fenced native subscription transition. Native management injection and exact preservation of the app-server's own subscription/routing behavior are required. Where direct parity depends on the source client's profile or resource lifetime, the admitted bridge request may carry only the smallest versioned compatibility or source-lease metadata; it creates no native connection or write authority. None of those seams or live official-client parity is implemented or proved.

### Nested remote-claw collaborator

A whole remote-claw server may join another server as one collaborator. Edges are installed from an already rooted native path outward, so simultaneous reciprocal binds cannot create a cycle. Before a nested command can be sent, the outer server completes one joint final step that stores both its signed command result and the signed lineage showing where the command came from. The edge capability separately commits the source-independent common payload schema and the outer wire-request schema. The wire carries the exact common payload bytes rather than a source-local ref; for an attachment it also carries every canonical item record and decoded content byte, so the target can verify the whole chain and create its own local refs. It treats the downstream operation as complete only after receiving a complete signed proof that ties the exact source event, command, chosen target, and target server's signed result together; a transport ACK or partial receipt is not enough. Every physical send has a one-time authorization created in `armed` state. The last pre-byte transaction consumes it and marks the child and command-wide gate started. A transport may be replaced only if the still-armed authorization is first revoked before any send, the child is marked never-started, and the source server signs exact positive-never-started evidence over the command, target, request, lease/capability, authorization, and revocation. A signed continuation may then install one fresh armed child while the same gate remains never-started; it never resets a started gate. A consumed, started, or uncertain predecessor can never be replaced. Returned native observations travel back over that edge in the outward direction and fan out, but neither server converts an observation or echo into another inward proposal or repeats a traversal in the same direction. Repeating this shape adds servers and collaborators, never another native app: Claude Code, Codex, or OpenCode exists only at the innermost end.

Every collaborator connector must verify its current capabilities before becoming writable. Before advancing a semantic ACK or cursor, it must durably record both the incoming event's classification and either the forwarding decision for a new proposal or the prior-command link for a replay. Outgoing observations use a durable send queue that preserves native order. A connector restart or provider-forced replacement never changes the internal logical chat, but that alone does not prove that an official app preserved one visible row and continuous history; the connector must prove in-place continuity or expose the provider's supported successor behavior honestly. Old provider or nested-server history repairs only that collaborator's view; it is never replayed into the native harness.

The technical reference describes the common [outside-connector lifecycle](client-driven-host-runtime-reference.md#10-outside-adapters), the [Anthropic target](client-driven-host-runtime-reference.md#103-anthropic-remote), and the [ChatGPT target](client-driven-host-runtime-reference.md#104-chatgpt-remote-connection).

## Security boundary

<a id="12-security-boundary"></a>

These are release requirements, not claims about the current wrappers:

- Inner Claude, Codex, and OpenCode process trees have no real provider credentials.
- Every provider-shaped request from an inner process terminates at a local façade.
- Network policy blocks direct provider fallback.
- Inference connectors and official-client connectors use separately isolated credentials and sockets.
- Every collaborator and inward edge is authenticated separately. Each receiver verifies the prior authenticated hop chain and appends its own hop, so removing or changing an already-attested inner hop is detectable; a server can still lie about a new event it originates and must be trusted only for that subtree.
- Acyclic edge checks and direction-typed events prevent a projection from returning inward as a command.
- Unknown inner routes and unsupported mutations fail closed.
- Provider credentials never enter argv, logs, normalized payloads, broker frames, or inner environments.
- User content remains E2E-encrypted while crossing the remote-claw broker.

## Delivery plan

<a id="13-delivery-plan"></a>
<a id="a0-host-wide-registration-seam"></a>
<a id="a01-neutral-seam-and-claude-mitm-migration"></a>
<a id="a02-opencode-and-tmux-migration"></a>
<a id="a1-runtime-ownership-control-journal-and-command-actor"></a>
<a id="a2-opencode-vertical-slice"></a>
<a id="n1-nested-remote-claw-collaboration"></a>
<a id="b-claude-code-wrapped-client"></a>
<a id="c-codex-wrapped-client"></a>
<a id="d-tmux-recovery-and-unified-product"></a>

Milestones group dependency-ordered work; each numbered slice lands as its own reviewed PR and leaves capabilities disabled until its proof gate passes. A0.1/A0.2 and A1.0 through dormant A1.8a0 are implemented. E0, E1a, E1b1, and E1b2 are implemented but non-authoritative; E1b3's design is frozen and will land as pure/build E1b3a followed by collection/proof E1b3b. E1b4 isolation, E1b5 capability/full-parent closure, E1c accepted evidence, I matched-pair install, and A1.8a2 admitted/effect arming follow in that order. A1.7b1, A1.8a0, E0, E1a, E1b1, and E1b2 still advertise nothing. A1.8b, A1.9, A1.10, A1.11, A2, N1, B, C, and D then own sealing/publishing, dispatch recovery, inference, viewer integration, nested operation, and outward connectors.

E1b3a's exact premerge gate is deliberately not a subset of E1b3's final 106 case IDs: parameterized cases cross the two implementation PRs. E1b3a proves the dormant codecs/build/measurement and socketless parser/default-deny target only. E1b3b owns the retained actual fixture, first private-namespace socket-backed serve, complete 106-ID manifest, and final historical-only E1b3 claim; no E1b3a assertion is waived from that rerun.

Every E1b3 target-executing operation runs exactly one copied implementation-pinned Node-core program as inner PID 1 inside nested private PID namespaces plus private user/mount/network/IPC state and a sealed root: item-7 `build-driver.mjs` owns only `build | package_measure`, while fixture-pinned `listener-evidence-probe.mjs` owns only `capture | measure | serve`. The fresh fixed host synchronously snapshots every outer path or bundle byte into read-only link-count-zero capsules. The caller-to-host handoff is the selected pinned program source on stdin, four bound argv coordinates, and redundant read-only program/request capsules on FD 3/FD 4; internal target/data/gate/manifest capsules and fixed coordinates never enter a DTO, and no per-runtime source capsule exists. Node 22 cannot provide the required Linux `openat2`/dirfd walk, so the same reproducibly built static gate owns two additional closed resolver modes inside the outer private namespaces. Setup invokes them through pinned demotions as UID/GID 60000 with empty groups/capabilities, NNP, a fresh keyring, the canonical seccomp policy, exact manifest/facts/copy FDs, private-null stdin, bounded empty-output captures, and no request/response access: install writes only precreated temporary inodes before sealing, while verify freshly repeats the route/identity/byte proof after target reap and before any response validation or relay. The setup script is the only repository TCB interpreted before demotion; static gate-init is the only repository-built executable run afterward, and only its inner init mode ever holds namespace capabilities. Fixed outer unshare makes setup PID 1 and contains every synchronous helper and nested descendant. The launcher/setup creates and validates the exact private root/work/dev/input state, seals the immutable root/input and dev views, and retains only bounded noexec writable work; inner unshare creates the child user/PID/mount namespace and mounts proc while preserving the 60000-to-60000 map. Gate-init starts as inner PID 1 and UID/GID 60000 with empty groups, recursively self-binds and verifies the locked inherited root/work/dev/proc subtree, pivots that child-created clone away from the host root, and detaches the old tree. It then remounts/verifies proc and the sealed inventory, drops capabilities, replaces its keyring, sets NNP, and installs a socket-family/keyring/namespace/cross-process seccomp filter. Every direct target inherits it and receives an ABI-3 Landlock layer admitting only its exact executable/runtime files, work subtree, devices, and its own `/proc/self`; `/proc/1`, host paths/sockets/FIFOs/devices/executables, AF_VSOCK, and the response coordinate remain unreachable. Inner PID 1 writes only to a private response inode; after inner exit, resolver/control/response/process checks, setup relays the opaque file and then tears down. The host accepts only after wrapper exit, relay EOF, authentication, and all postobservations. Parent-loss and hard-deadline cases—including either resolver helper—accept no frame and prove process/mount/namespace absence. This closes the proof gate's same-isolate FD ABA and host-route/credential hazards without claiming the hostile external peer, live mapping, or currentness evidence reserved for E1b4. Protected root/work/dev caps are 384 MiB/4,096 inodes, 64 MiB/16,384 inodes, and 1 MiB/16 inodes; exhaustion fails closed. The HTTP gate separately correlates a bounded raw-octet pre-parser with at most eight header pairs because Node `rawHeaders` trims wire OWS.

| Milestone | Outcome | Status |
| --- | --- | --- |
| A0.1 | Neutral host-wide registration seam; migrate Claude MITM without changing its data path | Implemented |
| A0.2 | Move OpenCode and tmux registration onto the same seam and publish truthful readiness/capabilities | Implemented (process-local; no durable recovery claim) |
| A1.0 | Canonical IDs/encodings, strict host-state records and digests, protected operation boundaries, and immutable dispatch/reconciliation contracts | Implemented foundation; no direct effects |
| A1.1 | Secure local SQLite kernel, read-only WAL-aware validation, typed migration outcomes, high-level transactions, and verified protected artifacts | Implemented; opened by the A1.3 owner, with no native effect |
| A1.2 | Schema-v3 default server/profile, projects and terminal selector generations, recovering chats, starting bindings/intents, installing `rcie_*` terminal edges, coordinator leases, immutable journal, reconciliation/inventory, and full semantic snapshot validation | Implemented; server/project operations remain inactive, with no actor queues, native effects, or nested edges |
| A1.3 | Schema-v4 runtime-owner repository, exact runtime identity, authenticated owner daemon/RPC, durable lease/takeover, wrapped key custody, multi-runtime registry, attachment/gate/signing foundations, and health-only wrapped-driver activation | Implemented (production health only; durable owner registration and A1 mutation disabled) |
| A1.4 | Schema-v5 evidence-resolving registration repository/orchestrator, sequenced process leases/publications/operations, bounded duplex callable ports, exact replay/reconciliation, and current-fenced crash reattach | Implemented closed trusted-adapter seam; ordinary CLI installs no adapter, so real drivers remain A0 |
| A1.5 | Browser-safe canonical A1 v2 wire/KDF/frame, certificate and onboarding codecs; schema-v6 runtime-owner-signed terminal-root activation, renewal, demotion, and reconciliation | Implemented dormant foundation; opt-in trusted-adapter only, with no real driver or broker integration |
| A1.6 | Selected SQLite/libSQL broker contract, exact capability negotiation, durable ciphertext routes/retry/collision/manifests, bounded rollover/read pages, browser-safe client, and schema-v7 host capability-pin/route/genesis installation | Implemented dormant foundation; ordinary CLI, drivers, and viewer make zero A1 calls |
| A1.7a | Evidence-preserving route actors, separate fetch/semantic cursors, multipart/retry/tombstone classification, gaps/recovery, and durable `awaiting_order` | Implemented dormant foundation; no production wiring, command order, signed result, or effect |
| A1.7b0 | Schema-v9 initial server self-anchor, wrapped server-key custody, fenced bootstrap/current signing leases, and reserve/bind/sign/accept/reconcile | Implemented dormant prerequisite; no command/result, output, broker publish, effect, native dispatch, projection, or production wiring |
| A1.7b1 | Schema-v10 A1-ingress ready journal, deterministic command/order/rejected decision, replaceable compound preparation, and durable result signing | Implemented dormant foundation; stops at signed-but-unaccepted preparation and advertises nothing independently |
| A1.8a0 | Schema-v11 rejected-only common result, signer acceptance, terminal overlay, exact semantic artifact, and one inert `pending_seal` intent in one transaction | Implemented dormant foundation; no route-health dependency after signing, cursor movement, claim/seal/publish, effect, projection, broker call, production wiring, or capability claim |
| A1.8a1-E0 | Add the six E-side canonical ID namespaces/types/parsers and four deterministic attestation/snapshot ID derivations | Implemented pure contract with locked vectors; no evidence digest/artifact codec, schema, repository, signer, pointer, port, owner operation, or production capability |
| A1.8a1-E1a | Freeze four ref-free native-binding evidence parent envelopes and their commitment registry | Implemented pure strict codecs, exact vectors, 64 KiB parent bounds, raw digest helper, and no child semantic parser, artifact write, schema, repository, signer, pointer, port, owner operation, or capability |
| A1.8a1-E1b1 | Implement executable-content manifests and a stable Linux collector | Implemented strict native/front-door role codecs and generic collector coverage for both roles; only native OpenCode 1.17.5 has retained real-binary proof, with no actual front-door provenance, pathname/process/currentness, complete parent, authority, or production wiring |
| A1.8a1-E1b2 | Implement exact workspace evidence | Implemented and gate passed: exact four-leaf full-u64 digest DAG, bounded raw-five-view verifier against separately supplied E1a parent bytes, synchronous independent no-follow root/target walks, two sweeps and fresh rewalks, same-mount suffix policy, and non-skipping local-direct/hosted-CI-demoted namespace/bind-mount proof; historical-only, direct-only, and non-authoritative |
| A1.8a1-E1b3 | Implement frozen actual front-door and listener evidence | Next; E1b3a closes codecs/build, then E1b3b closes direct collection, retained surface/measurement proof, and the raw-seven-view listener parent |
| A1.8a1-E1b4 | Implement runtime-isolation evidence | Planned after E1b3; must close every process/socket/policy/namespace isolation child and parent |
| A1.8a1-E1b5 | Implement capability evidence and full four-parent closure | Planned after E1b4; must close every remaining capability child and recreate all four E1a parents before E1c |
| A1.8a1-E1c | Retain exact signed OpenCode `user_text` native-binding authority evidence without changing either transport pointer | Planned after E1b5 under frozen workspace, legacy-signer, staging, artifact-link, transition-receipt, and exact-reconciliation rules; no migration number yet |
| A1.8a1-I | Atomically install or replace one accepted capability snapshot plus one credentialless authenticated callable-port ingress lease | Planned after E1c; both transport pointers change together; still no admitted command, dispatch, effect, native call, or production operation |
| A1.8a2 | Add the admitted native attempt/front-door dispatch/protected effect arm to the same command-finalization boundary | Planned after I; must not widen A1.8a0's rejected-only finalizer or advertise a partial path |
| A1.8b | Seal/publish causal result delivery, then one-time dispatch, protected authorization consumption, uncertainty quarantine, native read-back, and evidence-only reconciliation | Planned after full A1.8a |
| A1.9 | Runtime-scoped inference request/response recovery and ambiguous-upstream handling | Planned after the protected-handle and dispatch foundations |
| A1.10 | Viewer trust-store onboarding, scoped discovery, result redelivery, projection, and broker catch-up | Planned after A1.5–A1.8b |
| A1.11 | Integrated crash/restart, stale-coordinator, rollover, projection-rebuild, and local-TUI-availability gauntlet | Planned final A1 gate |
| A2 | First complete end-to-end shared chat through OpenCode; unavailable live connector kinds use authenticated collaborator stand-ins only at common ingress | Planned after A1 |
| N1 | Live nested remote-claw server collaboration, lineage, edge recovery, and loop prevention | Planned after A1; not required for the A2 stand-in proof |
| B | Fully brokered Claude wrapper, native recovery, and outward Anthropic Remote connector | Planned |
| C | Fully brokered Codex wrapper and one outward ChatGPT Remote host with many projects/chats | Planned |
| D | Durable tmux recovery and unified host/project/chat discovery | Planned |

Authenticated A2 stand-ins prove only that a source kind is normalized, ordered, and adjudicated through the common actor. They do not claim Anthropic, ChatGPT, automation, or nested-transport compatibility; only B, C, the applicable automation connector, or N1 can make that live-connector claim. Proof capture for B and C may proceed while A1 is built, but their writable integrations still depend on the A1 actor and fencing.

The exact PR slices and gates remain in the [delivery-plan reference](client-driven-host-runtime-reference.md#13-delivery-plan).

## Proof gates

<a id="14-proof-gates"></a>

The design does not claim a capability until tests establish it. A1.2 through A1.8a0 have passed their documented dormant foundation gates; E0/E1a/E1b1/E1b2 have passed their identity, parent, executable-content, and workspace-evidence gates but remain non-authoritative. E1b3's design now freezes the exact four missing leaf grammars, 19,070,976-byte raw-bundle ceiling, selected default-closed route inventory, deterministic portable bundle, complete raw `/doc` origin, cycle-free post-build identity derivation, sealed live item/order comparison, six E1a commitments, retained actual fixture, 106-case adversarial manifest, dormancy boundary, and dual-path least-privilege CI proof. None of those E1b3 implementation bytes has landed. E1b4 must still prove process/socket/policy/peer/namespace isolation and E1b5 must close capability evidence plus all four parents. E1c may then prove dependency-ordered accepted runtime-owner signatures and inert staging; I must prove matched-pair install and live-port fencing before A1.8a2 may consume authority. Production still advertises neither native registration nor live A1 mutation. The largest remaining live/integrated proofs are:

- one real trusted engine adapter consuming A1.2's durable project/chat reservation through the implemented A1.4 seam, without `project:null`, cwd/title inference, only/most-recent fallback, caller-attested native identity, or a duplicate graph after a lost response;
- one paired host concurrently serving many independent Claude Code, Codex, and OpenCode sessions in equal and different directories, with isolated native identity/history, TUI and collaborator membership, per-chat command delivery, shared-daemon lifetime, and restart recovery;
- stable chat identity and direct-collaborator order across every restart boundary;
- one real trusted adapter exercising the implemented terminal native-root operation after registration and renewal after lifecycle demotion, without exposing a generic signing operation or activating under a stale server, owner, coordinator, runtime, attachment, or process-lease claim;
- exact native identity, history completeness, live reattachment, and safe replacement for each engine;
- full native-TUI-plus-remote-claw coexistence for Claude Code and OpenCode, and for the untested Codex method, race, reconnect, and recovery families; the selected one-thread Codex model-free shell path is proved;
- Codex native multi-thread subscription/routing parity plus official-stream request-ID/handle remapping, cleanup, and client-profile parity through exactly one native bridge, with `RemoteControlService` limited to management;
- collision-safe Codex bridge mapping when different official streams reuse the same request IDs or source-owned handles, including response/error routing, reconnect tombstones, and per-stream cleanup;
- aggregate Codex subscription reconciliation across overlapping official and remote-claw collaborators, including first join, non-final leave, last aggregate leaver, reconnect, and cleanup without one stream unsubscribing the shared bridge for another;
- exclusive Codex bridge replacement while the app-server survives: require native disconnect and subscription cleanup for the old socket before replacement initialization so stale writes or responses cannot mutate state or consume a native server request;
- Codex child-thread lineage and presentation: an attach-all child notification stays nested under its managed top-level chat unless retained proof explicitly establishes another mapping;
- OpenCode single-adapter enforcement over stateless HTTP, fail-closed discovery and two-phase session creation, actively drained subscribe/snapshot overlap, native adjudication after 204/control replies, and stale old-wrapper rejection;
- OpenCode detach without aborting a TUI turn, explicit interrupt versus disconnect, terminal permission-answer races, child policy inheritance, durable origin correlation after ambiguous POST delivery, and exact child-session lineage;
- Claude worker receipt versus native acceptance, the exact private-RC/transcript/provider/turn source join, TUI-versus-remote permission/question terminal outcome, disconnect-safe child lifetime, old-epoch takeover, and retained sanitized parity fixtures;
- tmux response-loss after applied paste/Enter, local-draft collisions, transcript-UUID acceptance/origin correlation, a durable local permission-answer path, keep-pane detach, and clear/branch identity;
- drop-in native-client fidelity: changing only the native app's endpoint or Claude wrapper route preserves the complete supported protocol and product behavior, and every unexplained difference fails the release gate;
- many server-side collaborators represented inward as one collaborator without losing source identity;
- N1 live recursively nested remote-claw servers without feedback loops, reflected commands, or duplicate native execution; A2 authenticated stand-ins do not satisfy this gate;
- provider-route termination, credential isolation, and process-tree network fencing;
- delivery correlation and no automatic duplicate execution after an uncertain outcome;
- coordinator-independent direct-TUI conversation changes within an already durable project while collaboration is offline; first-project allocation remains coordinator-owned;
- one inference attempt and one native response stream across connector crashes, with no silent retry after ambiguous upstream receipt;
- collision-safe deduplication across connector restarts and provider namespace changes;
- causal outside projection without assistant or tool output overtaking its user command;
- Anthropic worker reconnect, ACK, cursor, upload, and rendering behavior;
- ChatGPT host enrollment, project grouping, transport, sequence, and ACK behavior;
- OpenCode caller-supplied native message-ID correlation without unsafe same-ID retry, plus honest lower-confidence behavior until it lands.

The exhaustive [proof list and restart matrix](client-driven-host-runtime-reference.md#14-proof-gates) defines the release tests.

## Further reading

<a id="15-evidence-baseline"></a>

- [Technical reference](client-driven-host-runtime-reference.md) — exact contracts, records, and algorithms.
- [OpenCode Native Proof](opencode-native-proof.md) — retained exact creation-marker and caller-message-ID evidence plus its limits.
- [Protocol & Runtime](protocol.md) — current as-built behavior.
- [Pluggable Harness](pluggable-harness.md) — current adapter seam.
- [Phase 0 Findings](phase0-findings.md) — captured Claude Remote Control protocol.
- [Durable Log Design](durable-log-design.md) — private Claude RC persistence.
- [Native RC Passthrough Scoping](native-rc-passthrough-scoping.md) — why private native transport and outward official-client transport remain separate.
- [Test Plan](test-plan.md) — current tests and future design gates.
