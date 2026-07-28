# Client-driven host runtime

<!-- Keep each prose paragraph and list item on one source line. iOS Markdown previews render soft source wraps as visible line breaks. -->

**Status:** selected architecture; implementation is in progress.

This page explains the design from the user's point of view. The [technical reference](client-driven-host-runtime-reference.md) contains the exact adapter contracts, durable records, recovery algorithms, and crash-boundary rules. [Protocol & Runtime](protocol.md) describes what the current code does today.

Unless a paragraph or status label says otherwise, the behavior below is the target rather than a claim about the current wrappers.

**Today:** of this migration plan, only the process-local A0.1 registration seam has landed. Claude `--rc-app` still intercepts Remote Control traffic while tunneling other Anthropic calls, OpenCode and tmux still use their older direct bridge paths, and ordinary wrapper restarts do not preserve a stable logical-chat binding. Codex and the outward official-client connectors are not implemented.

<a id="1-decision"></a>

## The design in one minute

In the selected architecture, remote-claw runs beside Claude Code, Codex, or OpenCode, normally in the same small VM. Tmux remains a lower-fidelity fallback.

The inner coding engine will be private. It will never connect directly to Anthropic, OpenAI, or another model provider. It sends provider-shaped requests to local endpoints owned by remote-claw. A separate inference connector may call the configured model service, using credentials and sockets that the inner process cannot access.

Local input, remote-claw web input, and commands from official Claude or ChatGPT clients will all meet at one coordinator when the relevant connector is enabled and its mapping has passed its proof gates. The coordinator gives commands a stable order and decides whether each one is admitted, queued, or rejected. When the evidence is ambiguous, it records that uncertainty instead of executing the command. Only admitted writes may be sent to the coding engine, and every such send goes through its native adapter; unsupported actions fail closed.

The remote-claw logical chat is the stable, user-visible chat. Restarting an inner process, its private connection, the coordinator, or an outward official-client connection must not create another visible chat. Starting a new chat, clearing one, or forking one remains an explicit operation.

remote-claw is authoritative for the shared chat's identity and command order. The native coding engine and its durable files are the primary evidence of conversation context, tool use, subprocesses, and side effects that actually occurred. Recovery uses both facts without maintaining a second, competing assistant transcript.

## Where everything runs

```text
host / small VM
└── remote-claw
    ├── coordinator
    │   └── stable chats, command order, delivery state, and recovery journal
    ├── local input surfaces
    │   ├── wrapped Claude terminal/editor
    │   ├── Codex client endpoint
    │   ├── OpenCode client endpoint
    │   └── tmux editor/diagnostic view
    ├── native adapters and private engines
    │   ├── Claude wrapper ── Claude Code
    │   ├── Codex wrapper ── Codex app-server
    │   ├── OpenCode adapter ── OpenCode server
    │   └── tmux fallback ── supported engine in a pane
    ├── private provider-shaped APIs
    │   └── inference connectors ── configured model services
    └── outward connectors
        ├── Anthropic Remote ── official Claude clients
        ├── ChatGPT Remote ── official ChatGPT clients
        └── encrypted broker ── remote-claw web clients
```

Two paths leave the host, and they have different jobs:

| Path | Purpose | Does the inner engine own it? |
| --- | --- | --- |
| Inference connector | Obtains model results for the private coding engine | No |
| Outward connector | Lets official or web clients participate in the shared chat | No |

An outward connector is not the inner engine's model connection. The official Claude app still talks to Anthropic, and the official ChatGPT app still talks to OpenAI. remote-claw will present itself through the corresponding host/worker connection, receive official-client commands, and project updates back. The wrapped engine behind remote-claw does not get those provider credentials or connections.

<a id="how-one-command-moves"></a>

## Commands and updates

<a id="5-normalized-command-path"></a>
<a id="7-delivery-state"></a>
<a id="11-core-workflows"></a>
<a id="112-local-or-web-text"></a>
<a id="113-official-client-text"></a>
<a id="114-two-writers"></a>

Commands travel toward the wrapped coding client. Replies, tool activity, and status updates travel back from it. remote-claw handles these as two separate flows.

### A command goes in

```text
one command
(local, web, or official app)
              │
              ▼
         remote-claw
    record / check / order
              │
              ▼
       coding client
```

remote-claw records where the command came from and puts it in line with any earlier commands. It then decides whether to run it now, hold it until earlier work finishes, or reject it. Only a command approved to run is translated by the client-specific adapter and sent to Claude Code, Codex, OpenCode, or the tmux fallback.

Every command is identified by where it came from and the ID assigned there. When those facts prove that an event is a repeat, remote-claw links it to the earlier command instead of running it again. If remote-claw cannot tell whether an event is new or repeated, it records the problem and does not run the command.

### Updates come back

```text
coding client
      │
      ▼
 remote-claw
match / order / translate
      │
      ▼
connected views
(local, web, official apps)
```

The client-specific adapter reports replies, tool activity, and completion to remote-claw. remote-claw links an update to its command when there is one, keeps the updates in order, and sends each connected view the form it understands. A view can reconnect and catch up without sending an old command to the coding client again.

Seeing submitted text in an app does not prove that remote-claw accepted it. Acceptance does not prove that the coding client ran it, and starting work does not prove that the work finished. The [technical reference](client-driven-host-runtime-reference.md#5-normalized-command-path) defines those exact delivery states.

No supported client writes around the coordinator. A raw terminal, pane, or private server connection that can change the coding client directly is outside this shared-chat mode.

## Who owns which facts

<a id="2-one-source-of-decisions-several-sources-of-evidence"></a>
<a id="6-control-journal-and-rebuildable-projection"></a>

| Fact | Authority or strongest evidence |
| --- | --- |
| Stable chat identity and command order | remote-claw coordinator |
| Admit, queue, reject, or hold a command | remote-claw coordinator |
| Native conversation, tools, subprocesses, and side effects | Native engine and its durable store |
| Representation accepted by Anthropic or OpenAI | That provider transport |
| Encrypted frames accepted for replay | remote-claw broker |
| What a client actually rendered | That client device |

The coordinator stores a small control journal: command IDs and order, admission decisions, native and outward delivery state, exact correlation mappings, recovery cursors, and explicit gaps. It may cache a read model for the UI, but that cache is rebuildable and is not a replacement native transcript.

The coordinator never tries to recreate a lost native conversation by replaying old prompts, tool calls, approvals, or questions. If native evidence proves a command happened, it is not sent again. If evidence proves delivery never began, it may be delivered in order. If delivery may have begun but the result is unknown, later writes wait until the old work is contained or reconciled.

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
| Logical chat ID | Canonical remote-claw chat and visible web row | Stays stable across infrastructure and transport restarts |
| Native binding ID | Relationship between that chat and its native conversation | Stays stable while the same native conversation is resumed |
| Native conversation ID | Claude UUID, Codex thread ID, or OpenCode session ID | Native evidence; never used as the remote-claw routing ID |
| Native runtime generation | One proven process or server generation | Advances when a native runtime is replaced |
| Private transport attachment | Claude `cse_*`, app-server connection, SSE connection, or tmux attachment | Reused when possible; replaceable beneath the same binding |
| Outward binding | Anthropic Remote, ChatGPT Remote, local, or web representation | Reconnects independently without changing the logical chat |

IDs are never aliases. A Claude `cse_*`, Codex thread ID, OpenCode `ses_*`, tmux pane, broker channel, and remote-claw logical chat ID remain distinct.

Exactly one native binding is writable for a logical chat at a time. Old bindings and delivery attempts remain in the journal so a late process or connector cannot act as the current owner.

A write is valid only when it names the current coordinator generation, native process generation, and private connection generation. Revoking an old owner prevents new writes, but it cannot undo work already sent to the engine. If an old attempt may still run, remote-claw must contain it or positively prove that it finished or was cancelled before a replacement becomes writable.

## What happens after a restart

<a id="8-restart-and-recovery"></a>
<a id="111-host-start-and-stop"></a>

Recovery works from the inside out:

1. Stop taking new input and prevent an old coordinator from issuing new native writes.
2. Load the expected logical chat, native binding, conversation identity, and transport attachments.
3. Reattach the surviving native process only when its exact identity and a version-pinned live reattachment method have both been proved.
4. Otherwise, contain the old process, start a replacement runtime, and reopen or resume the exact known native conversation.
5. Reuse the old private transport when the protocol permits; otherwise record a proven replacement beneath the same binding.
6. Reconcile commands and observations from native evidence without replaying old work.
7. Reconnect Anthropic, ChatGPT, local, and web views independently.
8. Make the chat writable only when the next ordered command is safe.

Common outcomes are:

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

- **Control:** a private Remote Control wrapper plus a local Anthropic-shaped API.
- **Recovery evidence:** the Claude transcript/resume UUID and private RC state.
- **Key rule:** try the known UUID and old `cse_*` first. A proven replacement `cse_*` remains beneath the same logical chat.
- **Status:** the process-local registration seam is implemented. Durable recovery and the outward Anthropic worker are not.

### Codex

<a id="92-codex-wrapper"></a>

- **Control:** a client-facing proxy around one host-scoped private app-server, plus a local OpenAI-shaped API.
- **Recovery evidence:** Codex threads and rollout state.
- **Key rule:** one named host contains many projects and threads. Restarting app-server must not re-pair the host or duplicate those projects and chats.
- **Status:** not implemented.

### OpenCode

<a id="93-opencode-server"></a>

- **Control:** a controlled HTTP/SSE server proxy plus private provider endpoints.
- **Recovery evidence:** session history and live SSE.
- **Key rule:** subscribe before taking a history snapshot. A lost `prompt_async` 204 is uncertain unless history proves its outcome.
- **Status:** the direct driver exists; migration to the host-wide seam is next.

### Tmux

<a id="94-tmux-compatibility-mode"></a>

- **Control:** a wrapper-owned editor plus transcript observation.
- **Recovery evidence:** the pane/process identity and the wrapped engine's transcript.
- **Key rule:** the shared pane is read-only. Injection and in-flight recovery remain lower confidence.
- **Status:** the existing fallback is Claude-specific; migration to the host-wide seam is next.

The [technical reference](client-driven-host-runtime-reference.md#9-native-adapter-recovery) contains the per-engine startup and recovery algorithms. Current OpenCode and tmux behavior is documented in [OpenCode Driver](opencode-driver.md) and [Tmux Driver](tmux-driver.md).

## Outside clients

<a id="10-outside-adapters"></a>

An outside binding is independent of the native engine. Native restart does not rotate it.

### Local wrapper

<a id="101-wrapper-owned-local-ui"></a>

The client-facing proxy or wrapper editor submits through the coordinator. A raw native view may remain available as a read-only diagnostic surface. Structural interception is not complete today.

### remote-claw web

<a id="102-remote-claw-web"></a>

The E2E-encrypted broker carries the web view. The target is one stable web chat with separate receipt and delivery states. The transport exists today; persistent logical-chat identity does not.

### Official Claude clients

<a id="103-anthropic-remote"></a>

An outward Anthropic Remote worker/session lets official commands enter the coordinator and projects native observations back. An app-side list/history/SSE/text-submission client exists today; outward worker/bridge support is missing.

### Official ChatGPT clients

<a id="104-chatgpt-remote-connection"></a>

One outward paired ChatGPT Remote host preserves the product shape of one named host containing many projects and chats. That shape is known; the paired transport still needs pinned protocol evidence.

Every outward connector must verify its current capabilities before becoming writable. Before advancing a semantic ACK or cursor, it must durably record both the incoming event's classification and either the admission decision for a new command or the prior-command link for a replay. Outgoing updates use a durable send queue that keeps them in command order. A connector restart or provider-forced replacement never changes the logical chat. Old provider history repairs only that outside view; it is never replayed into the native engine.

The technical reference describes the common [outside-connector lifecycle](client-driven-host-runtime-reference.md#10-outside-adapters), the [Anthropic target](client-driven-host-runtime-reference.md#103-anthropic-remote), and the [ChatGPT target](client-driven-host-runtime-reference.md#104-chatgpt-remote-connection).

## Security boundary

<a id="12-security-boundary"></a>

These are release requirements, not claims about the current wrappers:

- Inner Claude, Codex, and OpenCode process trees have no real provider credentials.
- Every provider-shaped request from an inner process terminates at a local façade.
- Network policy blocks direct provider fallback.
- Inference connectors and official-client connectors use separately isolated credentials and sockets.
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
<a id="b-claude-code-wrapped-client"></a>
<a id="c-codex-wrapped-client"></a>
<a id="d-tmux-recovery-and-unified-product"></a>

Each milestone lands as separate reviewed pull requests.

| Milestone | Outcome | Status |
| --- | --- | --- |
| A0.1 | Neutral host-wide registration seam; migrate Claude MITM without changing its data path | Implemented |
| A0.2 | Move OpenCode and tmux registration onto the same seam and publish truthful readiness/capabilities | Next |
| A1 | Durable logical chats, native bindings, coordinator journal, fenced runtime ownership, and command actor | Planned |
| A2 | First complete end-to-end shared chat through OpenCode | Planned after A1 |
| B | Fully brokered Claude wrapper, native recovery, and outward Anthropic Remote connector | Planned |
| C | Fully brokered Codex wrapper and one outward ChatGPT Remote host with many projects/chats | Planned |
| D | Durable tmux recovery and unified host/project/chat discovery | Planned |

The exact work items and gates remain in the [delivery-plan reference](client-driven-host-runtime-reference.md#13-delivery-plan).

## Proof gates

<a id="14-proof-gates"></a>

The design does not claim a capability until tests establish it. The largest open proofs are:

- stable chat identity and command order across every restart boundary;
- exact native identity, history completeness, live reattachment, and safe replacement for each engine;
- interception of every local shared-chat mutation before native execution;
- provider-route termination, credential isolation, and process-tree network fencing;
- delivery correlation and no automatic duplicate execution after an uncertain outcome;
- collision-safe deduplication across connector restarts and provider namespace changes;
- causal outside projection without assistant or tool output overtaking its user command;
- Anthropic worker reconnect, ACK, cursor, upload, and rendering behavior;
- ChatGPT host enrollment, project grouping, transport, sequence, and ACK behavior;
- honest lower-confidence behavior for OpenCode 204 delivery and tmux injection.

The exhaustive [proof list and restart matrix](client-driven-host-runtime-reference.md#14-proof-gates) defines the release tests.

## Further reading

<a id="15-evidence-baseline"></a>

- [Technical reference](client-driven-host-runtime-reference.md) — exact contracts, records, and algorithms.
- [Protocol & Runtime](protocol.md) — current as-built behavior.
- [Pluggable Harness](pluggable-harness.md) — current adapter seam.
- [Phase 0 Findings](phase0-findings.md) — captured Claude Remote Control protocol.
- [Durable Log Design](durable-log-design.md) — private Claude RC persistence.
- [Native RC Passthrough Scoping](native-rc-passthrough-scoping.md) — why private native transport and outward official-client transport remain separate.
- [Test Plan](test-plan.md) — current tests and future design gates.
