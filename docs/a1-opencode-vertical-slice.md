# A1 OpenCode vertical slice

**Status:** optional, parked multi-engine platform design. It is not the active roadmap, the next
tranche, or a blocker for the original remote-claw product. The only active project finish line is
[Claude 1.0](release-finish-line.md). A0 remains the only shipped OpenCode compatibility path. The
repository contains useful A1 codecs, durable-state foundations, audit collectors, and that
compatibility driver, but it does not contain the optional safe runtime described here.

If the project later makes an explicit product decision to build a multi-engine collaboration
platform, this document is the preserved OpenCode design baseline. The E0/E1a/E1b1/E1b2 artifacts
remain audit and release-engineering tools; they are not sufficient runtime authority. The unmerged
private-root grammar and C evidence parser remain out of scope.

## Optional product boundary

One remote collaborator can send one scalar `user_text` command through the zero-knowledge A1 broker
to one explicitly selected OpenCode conversation. A mediated real OpenCode TUI shares that conversation.
Exactly one native request may begin. Strict session and message read-back determines its outcome. The
signed command outcome and exact native output are sealed, durably published, and rendered in the same
browser.

If resumed, the first demonstrable increment would be a user-runnable local-provider alpha, not a
collection of internal proof fixtures. A later credentialed gate would promote that exact topology.
Neither is currently scheduled, advertised, or required for Claude 1.0. Resuming the work must not
replace the request, authority, output, onboarding, TUI, or isolation architecture between those gates.

## Trust boundaries

- The broker relays ciphertext and is not trusted with command or result plaintext.
- The runtime owner and its securely opened SQLite state are the trusted local enforcement boundary.
- OpenCode, its plugins, and tool descendants are untrusted. They may access the explicitly selected
  workspace and named toolchain paths, but not owner state, another workspace, connector-owned
  credentials, ambient host paths, or unrestricted network peers.
- The provider facade and connector are outside the OpenCode/tool credential boundary. Only the
  connector owns external-provider credentials and sockets.
- The viewer trusts the server identity and signed cross-boundary records. A second signature tree in
  which the runtime owner describes its own local process adds no independent trust boundary.

The selected user workspace may itself contain user-managed secrets such as `.env` files. Selecting
that workspace intentionally makes its contents available to the coding agent; remote-claw does not
claim otherwise. The isolation guarantee applies absolutely to connector-owned credentials and
credential stores, and to host paths outside the declared workspace/toolchain allowlist.

## Non-negotiable safety invariants if resumed

These gates block only an optional OpenCode capability. They do not block the active Claude 1.0
release.

1. Only binding-scoped `user_text` is writable. Empty text and every string whose first code point is
   U+002F (`/`) are rejected before an admitted result, execution row, or native request exists.
   Attachments, steer, interrupt, permissions, questions, remote session creation, and all other
   mutations are also rejected.
2. The actor calls one typed adapter method. No command value can select a URL, header, query, generic
   JSON body, raw socket, provider, model, agent, or system prompt.
3. Connector-owned credentials never enter OpenCode's argv, environment, inherited descriptors,
   readable filesystem, logs, normalized commands, host-state artifacts, broker frames, or tool
   namespace.
4. OpenCode and its descendants can reach only the selected workspace/toolchain paths and named local
   TUI, control, observation, and provider-facade peers. A tool cannot reach the raw OpenCode listener,
   runtime-owner IPC/state, another workspace, ambient host paths, or an external network route.
5. A signed admitted result and one command-keyed execution row land atomically. The execution row
   binds the command digest, result ID, and signed-result digest. Unsigned state never authorizes I/O.
6. Immediately before the first possible native byte, one SQLite transaction changes that row from
   `prepared` to `started`, selects one exact current compatible activation, and rechecks every durable
   fence. Unknown commit outcome sends nothing. No state after `started` authorizes another send.
7. HTTP `204`, SSE timing, matching text, and absence from one read are not application proof. Outcome
   requires the strict composite observation defined below.
8. Ambiguous transport or read-back becomes `outcome_unknown`, quarantines later writes for the
   binding, and never resends. Recovery may add exact positive observation, not another mutation.
9. Before the provider facade permits the first external inference byte, a durable provider-request
   row is written ahead and moved to `started` under a one-use fence. Ambiguous connector delivery or
   response never authorizes a second provider request; it terminates or quarantines the command.
10. Replacement of the binding, runtime, process, attachment, workspace, callable port, observer,
   owner, coordinator, provider facade, connector, authenticated channel, configuration, model
   mapping, or isolation generation revokes writability.
11. Advertisement, admission, dispatch, and output publication fail closed independently. A stale
    advertisement is never authority.
12. Every host output is sealed and stored byte-for-byte before publish. The host recognizes its own
    echoed frame only by an exact durable-ledger match; unknown or conflicting outbound frames gap the
    route.
13. No source command or output is acknowledged until its sealed broker frame is durably accepted, or
    exact reconciliation proves that the same frame was already accepted.

## One topology from alpha onward

```text
real browser
  ↕ A1 ciphertext through the real broker
host ingress + server signing + secure SQLite
  ↕ runtime-owner typed RPC
typed user_text adapter → private raw OpenCode listener ← mediated real OpenCode TUI
  ↕ selected local provider facade
connector (deterministic/local in alpha; credentialed/external in release)
```

The runtime owner launches and owns the private listener, TUI mediation, observer, facade channel, and
containment boundary. The listener is not caller-supplied and is unreachable from OpenCode tools and
unclassified local peers. The existing `--rc-driver=opencode` compatibility bridge remains separate;
if optional A1 resumes, pointing it at an arbitrary `--rc-oc-url` is forbidden.

An optional alpha would add an explicit ordinary CLI mode:

```text
remote-claw --rc-app <origin> --rc-driver=opencode \
  --rc-a1-local-alpha --rc-oc-workspace <absolute-path>
```

`--rc-a1-local-alpha` would select the deterministic credentialless connector, disable external
egress, require a disposable workspace, and advertise only an explicit alpha capability while live
health is green. `--rc-a1-pass` would be a local action that issues the canonical `rcp2.` onboarding
wire for the configured server; it would never launch OpenCode. These flag spellings are parked
interface candidates, not claims about the current parser or committed roadmap.

Before advertisement, onboarding must resolve native session identity by one of two safe paths:

- attach an explicitly selected, exact existing `ses_*` and prove its session/workspace identity; or
- durably write ahead one local creation intent, send `POST /session` at most once, and reconcile a
  lost response from exact native state before binding.

An ambiguous creation never authorizes blind retry, adoption of “most recent,” or a writable binding.
Remote `new_chat` remains unsupported within this optional slice and requires a separate product
decision.

## Onboarding, discovery, and selection

The first outcome includes the whole usable enrollment seam:

1. The host issues a canonical `ViewerOnboardingBundleV2`/`rcp2.` wire with the server certificate
   chain, current server key, route credentials, and signed key commitments.
2. The viewer verifies it with the existing pure verifier, then atomically installs the server trust
   and route credentials. Invalid, conflicting, or partially installed bundles fail closed.
3. The host signs and seals a `session_announce` only for a healthy current A1 activation. Discovery
   names the exact logical chat, binding, native session, project, and workspace display identity.
4. The viewer selects that announcement; the command repeats the stable selection coordinates and the
   host revalidates them at admission and start.

The existing A0 `rcp1_` store remains separate. A fixture-injected route credential is not an
acceptable alpha gate.

## Existing schema-v6 authority and optional extension

The implemented schema-v6 terminal-root graph remains real authority, not mere audit history. Its
closed prepare/sign/finalize path installs `current_native_root_certificate_id` and atomically makes the
terminal logical chat and edge current. Any future OpenCode activation must be downstream of that
current, unexpired certificate and recheck the same owner/coordinator/binding/attachment graph at
admission and start. A later migration must not delete, bypass, or describe the schema-v6 root as
non-authoritative.

Current schema v10/v11 can decide, sign, and finalize only the rejected arm; v11's delivery row is an
unclaimable plaintext `pending_seal` intent. No admitted OpenCode command, execution, output ledger,
sealing, broker publication, or viewer path exists today.

If this optional design resumes, a schema extension may replace the two unused planned transport
pointers with one nullable `current_binding_activation_id` only when both old pointers are null;
non-null legacy values require explicit repair. The activation supplements rather than replaces the
schema-v6 terminal-root authority.

`opencode_binding_activations` records one immutable generation with:

- server, chat, binding, native-conversation lease/session, project, workspace, and canonical-directory
  identity;
- runtime, process lease/start identity, attachment/transport, owner, and coordinator generations;
- OpenCode `1.17.5`, adapter contract, `user_text` family, leading-slash rejection, and input bound;
- callable-port, observer, live-instance, and isolation generations;
- provider-facade identity/generation, authenticated channel binding, configuration and model-mapping
  digests; and
- connector identity/kind, lease, and generation, but no credential reference or credential material.

The live instance resolves only in runtime-owner memory to held process, listener, observer, facade,
workspace, and containment handles. Install validates those handles, then one per-binding
`BEGIN IMMEDIATE` transaction inserts the immutable activation and compare-and-swaps the current
pointer. A post-commit live recheck precedes readiness. Unknown commit reopens and reconciles the exact
install request; only wholly absent work may same-byte retry after fresh live validation. Owner restart
withdraws an activation whose live handles cannot be recovered.

That optional extension also needs versioned OpenCode-specific admitted command/decision/result
records, plus:

- `collaboration_command_executions`, keyed by `command_id`; and
- `a1_host_output_messages` and `a1_host_output_parts`, the logical-output and exact sealed-frame
  ledgers.

The v1 rejected-only and capability-snapshot codecs remain readable history. New admitted records use
versioned OpenCode schemas and do not depend on a local capability/evidence signature chain.

## Signed admission and command-keyed execution

Admission first reserves stable record IDs and canonical bytes, then obtains the server signature.
One finalization transaction verifies that signature and atomically writes the common admitted result,
signer acceptance, OpenCode sidecar, and prepared execution row. It performs no native I/O.

The execution row binds:

- command ID/digest, admitted-result ID, and signed-result digest;
- stable server/chat/binding/native-session/project/workspace target;
- adapter contract, exact canonical request artifact/digest/length, and input digest; and
- one preallocated caller message ID, `msg_` plus unpadded base64url of 16 random bytes.

There is no separate native-attempt identity. The execution row is the attempt and is keyed by
`commandId`; runtime incarnation is deliberately absent from its identity. Existing `nat_` derivation
code remains a dormant historical/generalization contract and is not A1 authority.

The typed port accepts only:

```text
OpenCodeUserTextV1 {
  activationId
  commandId
  nativeConversationId
  nativeActionId
  canonicalDirectory
  text
}
```

It constructs exactly:

```text
POST /session/{nativeConversationId}/prompt_async
query: empty
content-type: application/json
x-opencode-directory: {canonicalDirectory}

{"messageID":"<nativeActionId>","parts":[{"type":"text","text":"<text>"}]}
```

The strict encoder rejects invalid Unicode and every extra key, part, query, or header. The selected
path sends neither `model` nor `noReply`; facade/connector configuration comes only from the activation.

The start transaction requires `state = prepared`, `activation_id IS NULL`, the exact signed-result and
request digests, and a current compatible activation. It stores that activation and changes the row to
`started`. Only the caller holding the returned one-use in-memory authorization may write the stored
request through the held port. Activation replacement before start is allowed when every stable target
and contract coordinate matches. After start, activation and request are immutable forever.

## Provider-request effect

The OpenCode prompt and the provider request are distinct irreversible effects. Before the facade lets
the connector send an inference request, the host durably stores the exact request identity and digest,
then consumes one start authorization immediately before the first possible connector byte. A lost or
ambiguous connector response never causes an automatic resend, even when no assistant message is yet
visible. Exact correlated response/assistant observation may complete the original row; otherwise the
command terminates or quarantines as unknown. The deterministic local connector used by an optional
alpha must exercise this same write-ahead boundary rather than bypass it.

## Exact native observation

Before dispatch, the observer establishes the selected session's SSE stream. After the `204` transport
receipt it waits for the selected terminal barrier (`session.idle` or the completed assistant event),
then performs both strict reads:

1. `GET /session/{id}` must return the exact session ID, canonical directory, and expected version.
2. `GET /session/{id}/message` must return a top-level array. No malformed entry or part may be silently
   filtered. Returned vector order is native order.

Exactly one user message must have the stored caller `msg_*`, and that message must contain exactly one
text part equal to the admitted scalar. Workspace proof comes from the session read, not message
history. Each assistant output attributed to this command must carry `assistant.parentID` equal to that
exact user `msg_*`. A concurrent TUI turn may interleave adjacent user and assistant messages, so
position, timing, text similarity, and “nearest message” are never causal evidence. An absent, changed,
or multiply claimed `parentID` is unowned/ambiguous output, not this command's success.

One host transaction consumes the exact observation and performs exactly one terminal transition:
either it marks the execution completed and inserts every corresponding logical output intent, or it
marks the execution `outcome_unknown`, quarantines the binding, and inserts the matching signed unknown
result intent. There is no committed state with a terminal command but missing output intent, or an
output intent for a nonterminal command. A conflicting duplicate, malformed response, incomplete
barrier, process replacement, uncertain read, or transaction outcome becomes `outcome_unknown`;
absence never authorizes resend.

## Exact output ledger

Every `accepted`, `assistant`, `action_result`, and `session_announce` frame is signed and sealed before
publish. The logical ledger stores stable output ID, route/chat, command/result reference, kind,
projection sequence, plaintext artifact, and digest. The part ledger stores message/part coordinates,
delivery attempt, exact encoded frame artifact/digest/length, normalized transport digest, signed-record
digest, cursor, and `sealed | accepted | outcome_unknown` state.

Projection sequence is allocated from the logical chat. The ingress actor classifies an echoed frame as
`known_host_output` only when bytes, digest, route, and authenticated header match one exact ledger row.
Everything else remains `unknown_outbound` and fails closed. An optional alpha must not resend after
ambiguous publish; a later credentialed gate may replay only the exact stored sealed bytes and
reconcile prior acceptance.

## Provider and local-boundary enforcement

An optional alpha must already use the production process topology. OpenCode and its TUI/tools receive fresh
credential-free homes and an explicit environment, filesystem, and network allowlist. They may access
the disposable selected workspace and named toolchain paths. The facade authenticates the exact
OpenCode process/channel and accepts no tool or arbitrary local peer. The connector alone may own an
external route in the later credentialed gate.

The executable isolation gate proves that a spawned hostile tool cannot reach the raw listener, owner
IPC/database, observer, facade as an unclassified peer, another workspace, ambient host paths,
connector-owned credentials, DNS/proxy escape, or external TCP/UDP. It also proves that replacing any
bound process, socket, channel, workspace, facade, connector, or containment generation withdraws
writability before another command starts, and killing the containment parent tears down the tree.

Namespaces, cgroups, seccomp, Landlock, or a small native launcher may implement those observable
properties. A bespoke C parser, serialized kernel-evidence grammar, or private reproducible root is not
part of the authority model.

## Optional proof gates if work resumes

These gates preserve a coherent design; they are not an active sequence and have no ordering claim
relative to Claude 1.0 work.

### Parked safe local-provider alpha

**Candidate endpoint:** the documented alpha CLI launches the real mediated TUI/private-listener topology
in a disposable selected workspace. `rcp2.` pairing installs trust; signed discovery exposes one healthy
binding; a real browser sends one encrypted `user_text` through the real broker and persistent secure
SQLite; signed admission, command-keyed start, exact OpenCode request/read-back, sealed output ledger,
broker acceptance, and browser rendering all complete. A deterministic credentialless local connector
produces the assistant response with external egress disabled.

**Required failure behavior:** admission, start, native send, provider-request start/response, read-back,
atomic observation-to-terminal/output-intent finalization, and publish ambiguity fail stop. The host
never emits a second native or provider request. Exact output self-recognition and quarantine are not
postponed. The real TUI and a hostile spawned tool exercise the listener and containment boundary;
concurrent TUI turns prove assistant `parentID` causality.

**Forbidden:** real provider credentials or external provider routes; arbitrary server URLs; persistent
user workspaces; remote session creation; another mutation family; generic forwarding; fixture-only
onboarding; mock broker/repository/OpenCode/browser substitutions in the optional gate; or an unsigned
execution authority.

**Executable gate if resumed:** one retained real-browser test proves ciphertext-in/ciphertext-out and
exact request/read-back/output bytes. It covers exact-existing-session attachment and durable
create-intent reconciliation. Focused crash points on both sides of admission, native/provider starts,
send, observation finalization, ledger sealing, and publish end in one completion or one quarantined
unknown, never a second send. Hostile-child tests prove the exact filesystem, credential, raw-listener,
IPC, facade, and egress fences.

### Parked credentialed production gate

**Candidate endpoint:** the exact alpha topology, schemas, onboarding, request, authority, observation, and
output path runs from the normal daemon against an explicitly selected persistent user workspace. The
activation binds the real facade/connector; connector-only credentials and egress reach the configured
external provider. Optional OpenCode advertisement is enabled only while complete live health remains green.

**Additional proof breadth:** owner/runtime/OpenCode/facade/connector/browser restart and takeover;
crash on both sides of every transaction and I/O boundary; exact sealed-frame replay after ambiguous
publish; broker rollover; direct-TUI coexistence; hostile tool/child attacks; projection rebuild;
activation withdrawal and replacement; certificate/key rollover; and persistent-workspace policy.

**Forbidden:** redesigning or duplicating the alpha topology; changing command/request/read-back/output
semantics; automatic resend after `started`; another mutation family; shared OpenCode runtimes;
plaintext broker state; or placing connector credentials/egress inside the OpenCode/tool boundary.

**Executable gate if resumed:** the real browser-to-broker-to-host-to-OpenCode-to-facade-to-connector-to-viewer run
uses configured credentials while proving they remain connector-only. Every injected failure ends in
one completed command, exact replay of already sealed output, or quarantined unknown—never two native
sends. Full local gates, independent code/security review, CI, and documented recovery complete before
any optional OpenCode merge or advertisement.

## Ownership and cutoff

Only an explicit post-Claude-1.0 product decision may resume this work. At that point one integration
owner controls schema, repository, runtime-owner RPC, adapter, output ledger, and end-to-end wiring.
Parallel changes use frozen interfaces and non-overlapping files. Focused tests run while code moves;
migration bytes and cross-doc pins freeze once; then one combined focused gate, one full local gate,
independent review, and CI run.

A new finding blocks only the optional OpenCode capability when it demonstrates a reachable P0/P1
safety failure or durable liveness loss in that capability. It does not expand or block the Claude 1.0
finish line. Broader engines, remote chat creation, extra mutation families, multi-runtime
optimization, reproducibility attestations, and richer audit export remain optional scope.
