# Client-driven host runtime

<!-- Keep each prose paragraph and list item on one source line. iOS Markdown previews render soft source wraps as visible line breaks. -->

**Status:** selected architecture; implementation is in progress.

This page explains the design from the user's point of view. The [technical reference](client-driven-host-runtime-reference.md) contains the exact adapter contracts, durable records, recovery algorithms, and crash-boundary rules. [Protocol & Runtime](protocol.md) describes what the current code does today.

Unless a paragraph or status label says otherwise, the behavior below is the target rather than a claim about the current wrappers.

**Today:** the process-local A0.1 and A0.2 registration work has landed. In its default Anthropic-inference mode, Claude `--rc-app` intercepts Remote Control traffic while tunneling other Anthropic calls; its Bedrock mode terminates the Anthropic-shaped surface locally. OpenCode and tmux now fail closed through the same registration seam before their compatibility bridges become visible. Tmux uses one private per-launch server/socket and permits many independent wrapper invocations on one host, but the registration and synthetic broker chat remain process-local: an ordinary wrapper restart does not recover the same stable logical-chat/native binding. Codex and the outward official-client connectors are not implemented.

**A1.0 and A1.1 today:** the canonical field writer and dormant host-state contracts have landed, along with a Linux-only secure SQLite kernel, migration registry, synchronous high-level transactions, and scoped verified protected-artifact storage. Existing state is validated as one read-only WAL snapshot before any writable SQLite connection opens; FULL migration commits attempt a non-blocking passive checkpoint and then run guardian fsync, with a reader or competing checkpoint allowed to leave checkpoint frames for later while fsync still runs. Typed retry-open-safe migration outcomes remain separate from non-retry-safe unknown ordinary commits. No run, registrar, RC, coordinator, or native-driver path imports or opens that kernel; it creates no production database, acquires no lease, performs no native effect, starts no broker handshake, and advertises no writable A1 behavior. A1.2 is the next state slice.

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

After a host or coordinator restart, remote-claw enumerates every durable binding and independently reattaches its exact native session before making that row writable. It neither chooses a “most recent” native session nor creates a replacement visible chat just because one wrapper, bridge, or coordinator restarted. Local TUIs and runtime-scoped inference remain available while no coordinator lease is current; remote mutations report unavailable and each healthy remote path is re-enabled independently only after its own lease, binding, and attachment proof passes. A failed recovery quarantines only that row. A nested remote-claw server can occupy one collaborator binding on any one of these chats without changing this isolation.

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

The runtime owner, native client endpoint, private provider façade, and inference connector are supervised independently of the collaboration coordinator. If the coordinator or its journal is unavailable at cold start, the local TUI may still use the native harness, but remote collaboration stays unavailable and non-writable until its epoch and journal recover.

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

Milestones group dependency-ordered work; they are not promises to put an entire milestone into one pull request. Each numbered slice in the [delivery-plan reference](client-driven-host-runtime-reference.md#13-delivery-plan) lands as its own reviewed pull request and leaves capabilities disabled until that slice's proof gate passes. A0.1 and A0.2 are complete process-local compatibility milestones; A1.0 and A1.1 are complete dormant library slices; A1.2 onward, A2, N1, B, C, and D own durable coordination, native recovery, and the outward connectors.

| Milestone | Outcome | Status |
| --- | --- | --- |
| A0.1 | Neutral host-wide registration seam; migrate Claude MITM without changing its data path | Implemented |
| A0.2 | Move OpenCode and tmux registration onto the same seam and publish truthful readiness/capabilities | Implemented (process-local; no durable recovery claim) |
| A1.0 | Canonical IDs/encodings, strict host-state records and digests, protected operation boundaries, and immutable dispatch/reconciliation contracts | Implemented (dormant; no persistence or effects) |
| A1.1 | Secure local SQLite kernel, read-only WAL-aware validation, typed migration outcomes, high-level transactions, and verified protected artifacts | Implemented (dormant; no production opens or effects) |
| A1.2–A1.11 | Durable many-session host inventory, logical chats, native bindings, per-chat collaborator actors, fenced runtime ownership, broker/ingress/outbox/inference/projection, and recovery | Planned |
| A2 | First complete end-to-end shared chat through OpenCode; unavailable live connector kinds use authenticated collaborator stand-ins only at common ingress | Planned after A1 |
| N1 | Live nested remote-claw server collaboration, lineage, edge recovery, and loop prevention | Planned after A1; not required for the A2 stand-in proof |
| B | Fully brokered Claude wrapper, native recovery, and outward Anthropic Remote connector | Planned |
| C | Fully brokered Codex wrapper and one outward ChatGPT Remote host with many projects/chats | Planned |
| D | Durable tmux recovery and unified host/project/chat discovery | Planned |

Authenticated A2 stand-ins prove only that a source kind is normalized, ordered, and adjudicated through the common actor. They do not claim Anthropic, ChatGPT, automation, or nested-transport compatibility; only B, C, the applicable automation connector, or N1 can make that live-connector claim. Proof capture for B and C may proceed while A1 is built, but their writable integrations still depend on the A1 actor and fencing.

The exact PR slices and gates remain in the [delivery-plan reference](client-driven-host-runtime-reference.md#13-delivery-plan).

## Proof gates

<a id="14-proof-gates"></a>

The design does not claim a capability until tests establish it. The largest open proofs are:

- durable project bootstrap: one random server-scoped project plus its initial selector mapping are allocated atomically and replay-idempotently, while `project:null`, cwd/title inference, and only/most-recent fallback cannot create or select an A1 chat or binding;
- one paired host concurrently serving many independent Claude Code, Codex, and OpenCode sessions in equal and different directories, with isolated native identity/history, TUI and collaborator membership, per-chat command delivery, shared-daemon lifetime, and restart recovery;
- stable chat identity and direct-collaborator order across every restart boundary;
- terminal native-root activation only after the independently supervised runtime owner proves the exact durable binding and matching attachment lease current and signs with its current protected runtime-owner key; a server key or pre-registration reservation cannot activate it;
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
- coordinator-independent local cold start and direct-TUI conversation changes while collaboration is offline;
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
