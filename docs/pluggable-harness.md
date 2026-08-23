# Pluggable harness drivers — the `Session` seam

`remote-claw` bridges a coding agent (today: the real `claude --remote-control`) to an
E2E-encrypted broker, so a phone or laptop can watch and drive that agent. This document records the
legacy **per-conversation compatibility port** shared by the current harness paths
(claude-behind-MITM, a plain `claude` in tmux, and OpenCode).

> **Scope:** each `Session` is one Claude-shaped compatibility chat, but the abstraction proposed in
> this document was only partially realized. `run.ts` dispatches directly to three launch functions;
> MITM can lazily create several `Session`s and has no `Driver` wrapper; OpenCode has its own driver
> class; tmux exports a `Driver` façade but dispatch calls `runTmuxDriver` directly. `DriverFactory` is
> exported but unused. The selected
> [client-driven host runtime](client-driven-host-runtime.md) now provides a neutral host-wide
> native-engine contract above it. A0.1 routes Claude MITM through one process-local registrar and one
> lease per intercepted conversation; A0.2 now routes both OpenCode and tmux through the same
> registration seam. `Session` remains a legacy RC port during migration; it does not
> become the neutral schema. In particular, Codex is one
> persistent multi-project app-server host, not another one-`Session` `DriverName`.

A1.0 through dormant A1.8a0 have landed. A1.0 supplies the shared canonical writer and
host-state contracts; A1.1 supplies the Linux secure-SQLite kernel and verified protected artifacts;
A1.2 supplies schema v3 plus the high-level default-server, project/selector, recovering-chat,
starting-binding/intent, installing-`rcie_*`-edge, coordinator-lease, journal, reconciliation, and
inventory repository. A1.3 adds schema v4, the runtime-owner repository and semantic validator, exact
`rcrt_*` derivation, an independently supervised Linux daemon, authenticated local RPC,
process-start-bound service-lease takeover/reconciliation, wrapped Ed25519 key custody, and durable
multi-runtime/multi-conversation ownership records. Migration 4 has 141 statements and digest
`zx52EtAFNY9hEZneG3RW14zRCYR18gg7ysnltHbOkT0`; the complete v4 manifest has 231 rows: 30 tables,
57 indexes, and 144 triggers. A1.4 adds schema v5, five canonical evidence schemas, the
evidence-resolving registration repository, sequenced process leases/publications/operations, bounded
duplex callable ports, and exact crash reconciliation/reattach. Migration 5 has 38 statements and
digest `l32ozsKKBm5ueLOk-_IeiasPgp_deE-tZHEbaZ6urOE`; the complete v5 manifest has 269 objects.
A1.5 adds pure browser-safe A1 v2 address/token/route, KDF, frame, digest, certificate, and
`ViewerOnboardingBundleV2` codecs. Schema v6 migration `006-terminal-native-root` has 36 statements,
digest `li87zqB0yxSfRtN-p_xT5Yk2xAvX8Iy5a1xDXNTYYZo`, and a complete 304-object manifest: 36 tables,
78 indexes, and 190 triggers. Its two-stage repository and narrow `native.root.activate` operation
reserve and bind under the current protected runtime-owner key, sign, then demand fresh owner/coordinator
and callable-port liveness proof immediately before synchronous finalization. Only the transaction-local
terminal-root finalizer stores and accepts the operation-attached v6 signature, samples the
acceptance/commit timestamp, and atomically activates the exact ready chat/edge; public runtime-owner
store, accept, and abort operations cannot mutate that reservation, while legacy unattached v5 history
stays inert. It reconciles an unknown commit and renews only from the latest retained certificate.
Registration recover, drain, close, and reattach demote a root without deleting history and require
re-ready plus renewal. The callable-port proof is ephemeral; snapshot validation does not store or
replay it. Expiry alone does not auto-demote the persisted chat/edge, so future effective
route/dispatch admission must recheck certificate time and the live lease.
A1.6 adds pure selected-backend capability, route/store, generation/manifest, publish/collision, and
one-generation/64-frame read-page contracts; a separate bearer-authenticated SQLite/libSQL `/api/a1/*` broker with
immutable `rbsi_*` store identity, route-wide retry/collision tombstones, retained ciphertext and
manifests, automatic 4,096-frame rollover, and an 8,000,000-byte transmitted HTTP page cap; and a
negotiation-first browser-safe client that reports ambiguous writes as outcome-unknown. Schema v7
migration `007-a1-broker-routes` has 22 ordered statements, digest
`uShlOvT_fWScwCLQD1g6-GAd1YyKR2QIlGjC0SPQWbw`, and a complete 326-object manifest: 39 tables, 85
indexes, and 202 triggers. It adds protected capability pins, broker routes, and pristine open
generation-zero receipts. A
current-coordinator-fenced repository and host-only split-commit installer install and reconcile only
that exact empty dormant route.
A1.7a adds schema v8 migration `008-a1-durable-ingress` and direct-only host-state modules for
evidence-preserving page staging, independent fetch and semantic cursors, authenticated physical
positions, bounded multipart assembly, exact replay, collision/incomplete tombstones, gaps/recovery,
and revisioned route actors. Complete chat `user` and server-control `new_chat` inputs stop at durable
`awaiting_order`. The actor is intentionally absent from every package barrel and production run
path; it creates no common command/order, signed result, server-scope signer, native effect, outbox,
dispatch, inference, or viewer projection.
A1.7b0 adds schema v9 migration `009-server-scope-signer` as a direct-only server-signer prerequisite: an initial self-anchored
server-scope certificate, AES-256-GCM-wrapped Ed25519 custody with no raw-private-key API,
coordinator-fenced bootstrap/current signing leases, and durable
reserve/bind/sign/accept/reconcile state, with acceptance ordered by its own dense per-server
`acceptedAtJournalSeq` rather than the schema-v3 control journal. The bootstrap lease is one-shot and
`scope_certificate`-only; the normal lease is bound to the exact server key/certificate and current
coordinator lease/epoch/fencing token. The callable path uses the signing state machine only for the
initial scope certificate and installs that current lease; generic current-lease signing is later.
Coordinator takeover during a non-closed bootstrap retains an immutable fail-stop reported as
`writable:false`/`stale_bootstrap_fence`: v9 cannot re-fence or replace it or allocate another
reservation, and explicit repair remains later. Takeover after installation instead supersedes the
normal lease and can acquire a fresh next-token lease once no `reserved`, `bound`, or
signed-but-unaccepted predecessor reservation remains. Migration 9 also replaces the existing
broker-route admission trigger so the dormant installer accepts either an `installing` server or an
exact signer-activated `current` server under the same current-coordinator and capability-pin proof;
this adds no route table or production call path.
This slice does not consume `awaiting_order` or create common
commands/results, generic host output, broker publishes, outboxes/effects, native dispatch,
inference, or viewer projection. The v8 digest/count/manifest pins remain unchanged. Migration 9 has
81 statements, digest `fYrN5atmwIj-tlT_tTXmrg9kNF52ah-zWmgf7vVFQWE`, and a 571-object manifest:
65 tables, 123 indexes, and 383 triggers.
A1.7b1 adds direct-only schema v10 migration `010-common-command-adjudication`. Its 50 ordered
statements are pinned to digest `rdJC_2C5IyjfsTuXhxjFSzT0bvDYtlpT8o0xDvu4IEk`; the complete
619-object manifest contains 70 tables, 137 indexes, and 412 triggers. It adds exactly
`command_ready_entries`, `a1_ingress_adjudications`, `collaboration_commands`,
`collaboration_command_compound_signing_groups`, and
`collaboration_command_result_preparations`. The ready entries share the server's gap-free
`nextJournalOffset` with schema-v3 control entries, while decisions use a separate dense
`nextCommandSeq` and globally select the minimum `(readyAtJournalSeq, commandId)`. The current
callable source is only an earliest eligible A1-ingress `awaiting_order` result on a current,
gap-free route. The pure payload contract accepts scalar `user_text` up to 48 MiB, but this
rejected-only persistence path stores only a small `unsupported_recognized` envelope over the
retained source schema/digest/fingerprint. It freezes only a rejected command decision, reserves a
deterministic version-one result/group/preparation, and uses the current server lease to bind and sign
the preparation. Creation and decision retain distinct coordinator fences. Reserved/bound
preparation generations may abort and reprepare with a burned next signer sequence while the frozen
decision/result ID remains unchanged. A1.7b1 stops at a signed-but-unaccepted preparation and cannot
terminalize the command or ingress sidecar.
A1.8a0 adds direct-only schema v11 migration `011-a1-rejected-result-finalization`. Its 38 ordered
statements are pinned to digest `SkkuAFJed-7GT9XyXXPCub7VFauqNY6eu0u4IQJEInc`; the complete
647-object manifest contains 73 tables, 147 indexes, and 427 triggers. It adds exactly
`collaboration_command_results`, `a1_ingress_terminal_results`, and
`a1_ingress_result_deliveries`. One transaction consumes only an exact signed rejected preparation
with no finalization artifact; inserts its immutable common result and next dense signer acceptance;
moves the command/sidecar to `decided`/`terminal`; stores the exact compact rejected action/chat
semantic artifact; and creates one causal plaintext intent in `pending_seal`. The base ingress row
remains immutable evidence in `awaiting_order` or later `quarantined_collision`, no cursor advances,
and preparation/group/reservation remain `signed`/`result_signed`/`signed`. Finalization does not
depend on post-sign route health. A narrow current-successor rule closes a valid predecessor-lease
signature without granting generic superseded-lease, rotation, retired-certificate, or historical
acceptance. Any later successor signing lease must be durably acquired strictly after the predecessor
acceptance, including across a same-millisecond wall-clock tie.
A1.8a1-E0 implements the six E-side canonical ID contracts and four deterministic
attestation/snapshot ID derivations. E1a now implements the four strict ref-free parent-envelope
codecs, closed role/schema/bound/scope registry, and bounded raw digest helper. E1b1 now implements
strict native/front-door executable-content manifest codecs and a direct-only two-pass stable-FD
Linux collector. Its retained real OpenCode 1.17.5 Linux arm64 proof closes only the native role; the
generic collector has front-door temporary-file coverage, but no retained or provenance-bound actual
front-door observation exists. It proves no pathname, process, currentness, complete parent,
authority, or production capability. E1b2 now implements four strict full-u64 `M → P → F → A` leaf
codecs, a bounded raw-five-view DAG/parent verifier, and synchronous direct-only Linux observation.
The collector returns only four leaf artifacts; the verifier consumes their raw views plus separately
built E1a parent bytes. A non-skipping local-direct/hosted-CI-demoted test proves real namespace and
bind-mount behavior. E1b2 remains historical-only and proves no currentness, process, authority,
stateful acceptance, production wiring, or capability; E1b3 front-door/listener, E1b4 isolation,
and E1b5 capability/full-parent closure remain planned. E1c then retains exact signed OpenCode `user_text` native-binding evidence through
dependency-ordered listener/isolation/capability phases, with key rotation blocked while an E-owned
phase is nonterminal and neither existing transport authority pointer changed. Its workspace/new-
lineage, exhaustive legacy-signer quarantine, unsigned-snapshot/accepted-inert staging, and
receipt-backed exact-reconciliation rules are frozen, but no stateful schema exists. A1.8a1-I
later installs one accepted capability snapshot plus one credentialless authenticated callable-port
ingress lease as an atomic matched pair. The port is usable only on its exact live authenticated
runtime-owner channel; no URL, socket, bearer, provider credential, or readable secret is stored.
Authority withdrawal changes only the exact durable pair; the A1.4 parent alone owns physical-port
unregistration, so late predecessor cleanup cannot disable a successor generation.
Neither E1c nor I adds a `Session` consumer, admitted command, attempt, dispatch, effect, native call,
production operation, or capability claim. The implemented E0/E1a/E1b1/E1b2 boundary and planned
E1b3–E1b5/E1c/I design are
[in the technical reference](client-driven-host-runtime-reference.md#41-a18a1-native-binding-authority-freeze-planned-dormant).
Wrapped `--rc-app` MITM, OpenCode, and tmux CLI paths connect to or
best-effort autostart that daemon after identity load. For the ordinary CLI, authenticated health is
the only successful production operation; its operation registry is empty, and health reports
`ownerOperationsWritable:false` and `nativeRegistrationEnabled:false`. The A1.4 operation seam is
installed only when the daemon receives an explicit trusted `registrationAdapter`; the ordinary CLI
passes none. No current launch path
registers a native runtime through the owner, activates an A1 binding/root, dispatches through the
owner, or advertises an A1 broker capability. Owner failure preserves the exact A0 compatibility path.
Wrapper exit closes only its owner RPC connection and leaves the owner service alive; existing A0
native teardown remains unchanged. Plain and help paths, trace mode, and the local `--rc-identity`
action do not start the owner. The A1.5 operation is installed only with that same explicit adapter;
no real driver supplies one. A1.6 calls, A1.7a ingress execution, A1.7b0/A1.7b1 signing and
adjudication, and A1.8a0 finalization are confined to
host-only direct modules and tests: ordinary
launches, all three drivers, runtime-owner RPC, and the viewer make zero `/api/a1/*` requests. There is
no production A1 ingress actor, command adjudicator, server signer, or result finalizer, and no native
effect, checkpoint, inference, or projection. A1.8a0's `pending_seal` row is unclaimable and has no
ciphertext, output part/signature, seal/publish, broker call, effect/attempt, projection, native
dispatch, or production wiring. E1b1's collector is also absent from every driver/runtime-owner/relay/viewer path. A1.8a1-E1c/I first supplies only the dormant matched native-authority
foundation; A1.8a2 must add the admitted attempt/front-door dispatch/effect arm atomically, and A1.8b
must seal and publish delivery. A1.7b1 plus A1.8a0 advertise nothing.

**Identity scope.** A compatibility `Session.id` is a synthetic `cse_*` broker channel address, and
the A0 registrar's `rcb_*` is only a process-local lease. Neither is the stable logical-chat ID
targeted by A1, and neither may stand in for an engine's semantic conversation ID. The dormant A1.2
repository keys the canonical chat by `(collaborationServerId, logicalChatId)` and records its exact
terminal selector generation, native binding, and `rcie_*` inward edge. Later slices add outward
bindings. Machine-facing route, row, alias, and cache addresses add
`identity_id` to that pair. A proven transport replacement may rotate its runtime/channel incarnation
without changing either canonical chat coordinate. A1.4 implements exact durable reattach behind its
closed trusted-adapter seam; this document does not claim that an ordinary real driver invokes it.

The common relay port is **`Session`** (`packages/cli/src/host/rc/session.ts`). Each current harness
path produces one or more `Session`s, fills them with Claude-shaped output, and consumes the input the
relay delivers. `HostRcRelay` and the web frame projection remain shared; harness launch/lifecycle is
not unified behind the exported `Driver` interface. Claude MITM, OpenCode, and tmux lifecycle are now
mediated by the neutral process-local registrar.

---

## 1. Why `Session` is the seam (grounded in the code)

`HostRcRelay` (`relay.ts`) has four required transport/session inputs and never learns how the agent
runs. Optional tracer, capability, harness, and attachment-directory fields configure the projection;
they do not expose harness mechanics:

```ts
new HostRcRelay({
  client,       // BrokerClient — the E2E broker transport
  identityId,   // Uint8Array (this machine's 16-byte identity id, = identity.identityId)
  sessionId,    // string (= session.id, the cse_… channel address)
  session,      // Session — the in-memory event bus for ONE RC session
});
```

`relay.serve(signal)` then runs two coupled pumps that are the relay's whole job:

- **OUTBOUND** — `for await (ev of session.followUpstream(...))` → `mapUpstreamItems(ev)` → seal →
  `POST` to the broker session channel.
- **INBOUND** — tail the broker session channel → for each client frame call back **into the
  session**: a `user` frame → `session.pushUserInput(text)`; a `permission` frame →
  `session.pushControlResponse(...)`; `interrupt` / `set_model` / `set_mode` →
  `session.pushControlRequest(...)`. An `end` frame emits no session event; it only clears the relay's
  open permission gates.

So the relay is *already* a pure function of `(Session, BrokerClient)`. The MITM
(`mitm.ts`) is the **reference harness path** (three modes ship today: `mitm` / `tmux` / `opencode`): it serves
claude's RC HTTP/SSE endpoints from a
`RelayCore`, turning claude's `POST /worker/events` into `session.pushUpstream(payload)` and claude's
`GET /worker/events/stream` into a `session.followDownstream(...)` SSE loop. The non-MITM paths
replace *that HTTP wiring* with another capture/inject mechanism and reuse the relay verbatim. In the
shipped code they are separate launch paths, not instances of one dispatcher interface.

The decisive fact for non-MITM drivers: **claude's transcript JSONL
(`~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`) `message.content` blocks are byte-identical to
what `mapUpstreamItems` destructures** (`text` / `thinking` / `tool_use` / `tool_result`, same field
names). A tmux driver tails that file and `pushUpstream`s it nearly verbatim — the only reshape is
`parentToolUseID` → `parent_tool_use_id` for sub-agent nesting.

```
local path
  person
    ⇅
  native TUI
    ⇅
  native harness

remote path
  same native harness
    ⇅
  chosen adapter
    ├─ capture output
    ├─ inject input
    ├─ report status
    └─ bridge permissions
    ⇅
  Session
    ⇅
  HostRcRelay
    ⇅
  broker + web viewer
```

Each current harness can coexist with a person using a native surface: the real Claude TUI in MITM
mode, the attached Claude pane in tmux mode, or a native OpenCode TUI sharing the server. That direct
local input does not pass through `Session` before native execution today. Tmux and OpenCode can mark
the resulting unmatched user record `local_prompt:true` after the fact; the MITM path does not add that
marker, so the relay drops its ordinary user echo. The selected host runtime keeps that direct TUI path
and makes remote-claw the one remote collaborator for structured Claude, Codex, and OpenCode adapters.
Its server may multiplex many remote users behind that one adapter connection; the native harness
remains the final arbiter. Tmux does not expose two native collaborators: the person and injector share
one editor keystream and require an exclusive/quiescent input boundary to avoid merged drafts.

---

## 2. The partially used `Driver` interface

`driver.ts` exports a thin `Driver` contract for two pumps against one `Session`. Tmux and OpenCode
implement it, but the current dispatcher calls their run helpers directly rather than instantiating
them through `DriverFactory`; MITM has no `Driver` implementation. The useful shared contract is
therefore the `Session`/capability/payload shape below, not a polymorphic dispatcher.

```ts
// packages/cli/src/host/rc/driver.ts

import type { Identity } from "@remote-claw/clawsec";
import type { BrokerClient } from "../../broker/client.js";
import type { Tracer } from "../../trace.js";
import type { GitInfo } from "./gitinfo.js";
import type { Session } from "./session.js";

/** The driver names the wrapper can dispatch on (`--rc-driver=<name>`, default "mitm"). */
export type DriverName = "mitm" | "tmux" | "opencode";

/**
 * Everything a driver needs to bridge a harness to the broker. Mirrors the launch surface
 * (RcLaunchOptions in launch.ts) so the MITM driver maps onto it 1:1; non-MITM drivers ignore the
 * MITM-only fields and add their own under `extra`.
 */
export interface DriverContext {
  /** Args forwarded verbatim to the harness binary. */
  harnessArgs: string[];
  /** Optional harness binary override used by child-spawning paths such as tmux. */
  harnessBin?: string;
  /** This machine's identity (its bus + session keys). identity.identityId feeds HostRcRelay. */
  identity: Identity;
  /** The broker origin (`--rc-app` / RC_APP); its /api is the relay broker. */
  brokerUrl: string;
  /** Which broker backend to target (`--rc-backend` / RC_BACKEND); omitted ⇒ broker default. */
  backend?: string;
  /** Session title for the announce (default "remote-claw"). */
  title: string;
  /** The session's working dir, snapshotted for the announce's cwd + git chip. */
  cwd: string;
  /** Static git snapshot for the viewer's git chip; null outside a repo. */
  git: GitInfo | null;
  /** Builds a fresh BrokerClient (already wired with provider + Vercel bypass + backend), one per
   *  session — exactly as launch.ts does, so each relay owns its own transport. */
  newClient: () => BrokerClient;
  /** Driver-own diagnostics tracer (target "rc.<name>"; defaults to no-op). */
  tracer?: Tracer;
  /** Notified the instant a Session registers (test parity with launch.ts's onSession). */
  onSession?: (s: Session) => void;
  /** Driver-specific knobs (e.g. { certsDir, spawnClaude } for mitm; { dangerouslySkipPermissions }
   *  for tmux). */
  extra?: Record<string, unknown>;
}

/** A driver declares which broker-side features it can faithfully service. The relay broadcasts this on
 *  every session_announce, and the VIEWER disables + labels the controls a driver can't honor — so a
 *  permission-mode / model "✓" never lies (#149). */
export interface DriverCapabilities {
  /** Can surface + round-trip structured can_use_tool gates (else auto-approve/ignore). When false the
   *  session runs WITHOUT per-tool gating and the viewer shows a "permissions off" posture. */
  structuredPermissions: boolean;
  /** Reports real workerStatus transitions (else presence is best-effort heuristic). */
  status: boolean;
  /** Per-verb control support — coarse "controlVerbs: boolean" couldn't say "interrupt works but
   *  set_mode doesn't". `end` is false on EVERY driver (claude's REPL bridge has no remote end). */
  controls: { interrupt: boolean; setModel: boolean; setMode: boolean; end: boolean };
  /** Receives viewer attachments. NOTE: attachments are relay-owned end-to-end (§5); a driver never
   *  sees the attachment frame — only the resulting `user` prompt downstream. Tracks `user`
   *  injection support; listed for documentation. */
  attachments: boolean;
}

/**
 * A pluggable harness adapter. A driver MUST:
 *   1. Create a Session via RelayCore.create({ title }) and call session.pushInitialize() once
 *      (idempotent; guarantees `initialize` is the first downstream event).
 *   2. CAPTURE: translate harness output into a canonical UpstreamPayload (§3) and call
 *      session.pushUpstream(payload). relay.mapUpstreamItems consumes it unchanged.
 *   3. INJECT: drain session.followDownstream(session.claimWorkerStream(), () => signal.aborted);
 *      for each eventType === "user" send its text to the harness; map control_request verbs.
 *   4. STATUS: set session.workerStatus + call session.wake() so the relay's presence tracks it.
 *   5. PERMISSIONS (capability-gated): raise a gate by pushUpstream-ing a can_use_tool
 *      control_request; apply an answer by observing the matching control_response in
 *      followDownstream. The relay's existing permission_request ⇄ permission round-trip does the
 *      broker side — no relay change.
 * The current harness paths open a process-local registrar lease in `starting`, publish validated
 * metadata/capabilities, and enter `ready`; that transition creates the broker client and starts the
 * shared relay. Each driver must finish its own readiness checks first. The registrar owns the bridge
 * lifecycle but not the native Session, and this process-local seam is not durable reattachment.
 */
export interface Driver {
  readonly capabilities: DriverCapabilities;
  /** Run until `signal` aborts (or the harness exits). Resolves with the harness exit code. */
  run(signal: AbortSignal): Promise<number>;
}

/** Exported factory type; the current dispatcher does not call it. */
export type DriverFactory = (ctx: DriverContext) => Driver;
```

### Historical MITM-adapter proposal — not implemented

`runRcLaunch` (launch.ts) is exported and **directly unit-tested** (`launch.test.ts` constructs it
with `{ claudeArgs, identity, brokerUrl, certsDir, spawnClaude, … }` and asserts the child env, the
teardown, and a full broker round-trip). The proposal was to wrap it in `mitmDriver`, but no
`drivers/mitm-driver.ts` exists and current `run.ts` calls `runRcLaunchPath` directly. This retained
sketch explains the intended adapter shape; it is not an implementation inventory:

```ts
// proposed only — this file/function does not exist
export function mitmDriver(ctx: DriverContext): Driver {
  return {
    capabilities: MITM_CAPABILITIES, // { structuredPermissions, status, attachments: true, controls: { interrupt:true, setModel:true, setMode:true, end:false } }
    run: (signal) =>
      runRcLaunch({
        claudeArgs: ctx.harnessArgs,
        identity: ctx.identity,
        brokerUrl: ctx.brokerUrl,
        certsDir: String(ctx.extra?.certsDir),
        title: ctx.title,
        cwd: ctx.cwd,
        ...(ctx.backend !== undefined ? { backend: ctx.backend } : {}),
        ...(ctx.onSession ? { onSession: ctx.onSession } : {}),
        spawnClaude: ctx.extra?.spawnClaude as SpawnClaudeEnv,
        // runRcLaunch derives its own git via gitInfo(cwd); signal threads through an AbortController.
      }),
  };
}
```

Had it been implemented, this would have kept `launch.test.ts`'s surface unchanged. It remains
historical: current MITM uses `LegacyRcConversationRegistrar`, which calls `startBridgeSession` at
`ready`. OpenCode now uses that registrar too, after strict native session selection and
parent-permission setup unless explicitly opted out. Tmux uses it after proving its private pane and
required startup hook:

```ts
// process-local compatibility registration (tmux shown):
const core = new RelayCore();
const session = core.create({ title: ctx.title });
session.pushInitialize();
ctx.onSession?.(session);

const lease = await registrar.open({
  phase: "starting",
  port: session,
  nativeRef: null,
  capabilities: null,
  // descriptor, attempt identity, and metadata omitted
});

// Prepare private tmux runtime/settings, spawn, require a live pane and the
// SessionStart marker, and construct the native pumps.
await lease.update(metadataWithProvedCapabilities, TMUX_NATIVE_CAPABILITIES);
await lease.setPhase("ready"); // only now starts HostRcRelay and announces
```

For all three migrated paths, the registrar validates generic and viewer-facing capabilities and
calls `startBridgeSession` only at `ready`. OpenCode first confirms one exact native session and
requires parent permission read/install/read-back unless opted out. Tmux first creates private
runtime/settings state, confirms a live pane, and requires Claude's `SessionStart` marker from the
exact merged settings source. Its optional session-hook flag controls continued exact
transcript/rotation following after startup, not the mandatory first marker. These leases isolate
live bridges inside one process; none is a persisted A1 inventory or restart attachment.

---

## 3. The canonical content-block contract (every compatibility path must emit this)

`mapUpstreamItems(ev)` (relay.ts) is the spec. A driver normalizes its harness output to the
following shape and calls `session.pushUpstream(payload)`. **If the shape drifts, the relay silently
drops the frame** — there is no driver-specific adaptation in the relay, by design. Strong typing on
the driver is the only defense.

```ts
/** What session.pushUpstream(payload) accepts. Byte-identical to claude's worker /worker/events
 *  POST bodies AND to a transcript JSONL line's top-level object. */
export interface UpstreamPayload {
  /** Event type. The relay routes on this exactly:
   *   "assistant" → text / thinking / tool_use blocks
   *   "user"      → tool_result blocks (the agent posts tool OUTPUT as a user-role message)
   *   "system"    → task_* lifecycle (sub-agent visibility); other system subtypes are dropped
   *   "result"    → end-of-turn result string
   *   "control_request" with request.subtype === "can_use_tool" → a permission gate
   *   "control_cancel_request" → clears an open gate (request_id) */
  type: "assistant" | "user" | "system" | "result"
      | "control_request" | "control_cancel_request" | string;

  /** Event uuid (unique within the session). If absent, the session mints one; supply the
   *  harness's own uuid where available so dedup/ordering is stable across reconnects. */
  uuid?: string;

  /** Sub-agent nesting: an assistant/user event produced UNDER a parent Task tool_use carries the
   *  spawning Task's tool_use_id. The viewer nests these under the Task. (Reshape from claude's
   *  JSONL `parentToolUseID` is the tmux driver's only required rename.) */
  parent_tool_use_id?: string | null;

  /** For "assistant" / "user": the message envelope. Content is normally blocks, but a
   *  driver-marked local prompt may use a plain string. */
  message?: {
    role?: "assistant" | "user" | string;
    content: ContentBlock[] | string;
  };

  /** A non-MITM driver sets this only for a prompt observed from its local/native UI rather than
   *  injected from the relay. The relay then surfaces that user text instead of dropping it. */
  local_prompt?: boolean;

  /** For "result": the turn's result (string preferred; non-string is JSON-stringified by relay). */
  result?: string | Record<string, unknown>;

  /** For "control_request": the permission gate. relay reads request_id at top level OR in request. */
  request_id?: string;
  request?: {
    subtype?: string;          // "can_use_tool" to render a permission_request
    tool_name?: string;        // e.g. "Bash", "AskUserQuestion"
    input?: unknown;           // real claude carries tool input here…
    tool_input?: unknown;      // …older/fake protocol used this; relay reads either
    tool_use_id?: string;      // rides the answer back as toolUseID (#42)
  };

  /** For "system": task lifecycle (only subtypes starting "task_" are surfaced). */
  subtype?: string;
  task_id?: string;
  description?: string;
  tool_use_id?: string;

  /** Forward-compat: any other fields are preserved (the relay ignores what it doesn't read). */
  [key: string]: unknown;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface TextBlock {
  type: "text";
  text: string;               // non-empty; empty text blocks are dropped
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;           // non-empty after trim; rendered muted/collapsible
}

export interface ToolUseBlock {
  type: "tool_use";
  name: string;               // tool name (a "Task" tool_use spawns a sub-agent)
  input: unknown;             // tool input (any JSON-serializable)
  id?: string;                // tool_use id; matched by a later tool_result.tool_use_id
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;        // matches the ToolUseBlock.id it answers
  content: string | ContentBlock[]; // Bash stdout (string) or structured blocks (text + [image])
  is_error?: boolean;         // true if the tool call failed
}
```

**Field-level rules the relay enforces (so drivers must honor):**

- `text` blocks with empty `text`, and `thinking` blocks empty after `.trim()`, are **dropped**.
  Don't rely on them to carry structure.
- A `tool_result`'s `content` is flattened to display text and **capped at 4000 chars**
  (`TOOL_RESULT_CAP`); non-text blocks (images) surface as a `[type]` marker — the host holds the
  image, `SendUserFile` is the worker→viewer image path.
- `system` events are surfaced **only** when `subtype` starts with `task_`; everything else
  (including the high-frequency `thinking_tokens` counter) is intentionally dropped.
- A `user` event's text is normally dropped because the inbound pump already echoes every viewer
  prompt; `tool_result` blocks still relay. The deliberate exception is a non-MITM driver's
  `local_prompt:true` event: OpenCode and tmux use an injected-text ledger to mark unmatched native
  user records that were not injected by this driver, and the relay surfaces that string text once.
  For tmux that identifies pane input; for OpenCode it may also be another client or backfilled history.
- The MITM path does not mark native-TUI prompts `local_prompt`, so their ordinary user echo is
  dropped even though Claude may execute the action and later output still flows upstream.

---

## 4. Downstream injection (what the driver consumes)

The relay pushes client input **into** the session; the driver pulls it **out** and drives the
harness. The driver claims a worker-stream generation token and drains downstream — exactly the
discipline `mitm.ts#streamWorker` uses, so a reconnect supersedes cleanly. The relay never emits an
`end_session` control request; an authenticated viewer `end` is consumed inside the relay to clear
open permission gates:

```ts
const gen = session.claimWorkerStream();          // newest claimer wins → single deliverer
for await (const ev of session.followDownstream(gen, () => signal.aborted)) {
  if (ev === null) continue;                       // heartbeat tick
  switch (ev.eventType) {
    case "user": {
      // ev.payload.message.content is the prompt text → send to the harness (send-keys / stdin).
      const content = (ev.payload.message as { content?: unknown })?.content;
      sendToHarness(typeof content === "string" ? content : String(content));
      break;
    }
    case "control_request": {
      const sub = (ev.payload.request as { subtype?: string })?.subtype;
      if (sub === "interrupt") interruptHarness();        // ESC / SIGINT
      else if (sub === "set_model") setModel(ev.payload); // best-effort
      else if (sub === "set_permission_mode") setMode(ev.payload);
      break;
    }
    case "control_response":
      // A permission grant the relay produced (pushControlResponse). The MITM driver forwards it
      // over the worker SSE; a structured-permission driver routes it to the harness's permission
      // mechanism. Drivers that auto-approve ignore it.
      break;
  }
}
```

Note: `initialize` is a `control_request` queued first by `pushInitialize()`; a driver typically
ignores it (it has no harness analogue) but must let it pass through the stream.
Non-MITM drivers acknowledge each event with `session.ack(ev.eventId)` after adapter dispatch or
deliberate compatibility handling returns, including handled no-ops such as `initialize`. This is
replay bookkeeping, not proof that the native harness accepted, ordered, or applied the action:
OpenCode text is ACKed after a transport-only 204 and `/compact` before summarize settles. Without that
ACK, a later `claimWorkerStream()` replays the event. The current OpenCode pump keeps draining after a
failed event, so replay requires a new claimant; an ordinary OpenCode SSE reconnect does not create
one.

Native-TUI input is not downstream injection in the current harness contract. The native client
accepts it directly; OpenCode/tmux may project it post-hoc and MITM omits its user text from the viewer.
Consequently `Session` cannot establish the final native order across TUI and viewer writes. The
selected design retains the TUI as one native participant and represents remote-claw as the other.
The future control journal orders remote-claw's server-side collaborators, then records the native
harness's observed interleaving as the applied order.

The selected neutral host contract does not let a driver decide whether remote work is admissible.
Every web, official-client, automation, or nested proposal first enters the same server-wide command
order and receives one signed final result. Only a signed admission may create one adapter attempt;
queued and rejected results create none. A new submission and a steer of a running turn remain
different commands even when the harness is busy. The person's direct TUI action bypasses this remote
decision path, and the native harness—not `Session`—decides the final local/remote order and what was
actually applied.

For OpenCode, the selected path does not promote this compatibility pump's `/compact`, interrupt, or
permission behavior. Its first writable A2 vectors are exactly server-scoped `{new_chat}` and
binding-scoped `{user_text}`. After common admission, the adapter must build the one exact native
request, use only the current fenced front door, and match the native message and order through
a complete, ordered history snapshot plus the matching live event only when that snapshot method
requires one. A 204, an ACK, missing read-back, or a different request shape is not success. Compact,
interrupt, steer, blank submit, permission, and every other unproved family is stored as rejected
before native work. Stock `1.17.5` remains unsupported for writable A2 until the real-TUI front door,
complete route manifest, raw-listener/tool fence, and observer linearization are proved.

---

## 5. Permissions and attachments are relay-owned — keep drivers transparent

- **Permissions.** The broker side (a `permission_request` content frame out, a `permission` frame
  in, the `permission_resolved` log frame, AskUserQuestion's `questions` echo, the `q.map` fix) is
  **entirely in the relay**. A driver participates only at the harness boundary: to *raise* a gate it
  `pushUpstream`s a `can_use_tool` control_request; to *apply* an answer it observes the
  `control_response` in `followDownstream`. All three paths are configured to mirror gates by default:
  MITM via Claude's native RC, **tmux** via an injected **PreToolUse hook**, and **OpenCode** via the
  session permission API (PATCH an ask-all rule ↔ SSE `permission.asked`). The opt-outs are not
  identical: `--rc-tmux-skip-permissions` restores hands-off auto-approve
  (`--dangerously-skip-permissions`), while `--rc-oc-skip-permissions` only skips the ask-PATCH and leaves
  OpenCode's own session permission config in place (auto-run unless that config already asks).
  OpenCode now treats parent permission read/PATCH/read-back failure as a registration failure, skips
  the native append when the exact catch-all already exists, and advertises
  `structuredPermissions:true` only after that setup verifies. The opt-out performs no additional
  permission setup or PATCH and advertises false; exact session confirmation still validates any
  returned policy field. Child-session setup is asynchronous and cannot prove a child's first tool was
  gated, but it now receives the run cancellation signal, is tracked, cannot PATCH after the teardown
  fence, and joins the shared bounded teardown. OpenCode answers a gate through retained
  `POST /permission/{requestID}/reply` with `{reply}` and requires successful JSON to be literal `true`.
  That is transport acknowledgement only: the global route does not prove selected-session ownership,
  a win over a native-TUI answer, or terminal `permission.replied` semantics. Tmux can disable its hook
  after an unparseable user settings file, after it has already announced
  `structuredPermissions:true`; that remains a known capability-advertisement bug.
- **Attachments.** `relay.#handleAttachmentPayload` decrypts the viewer's bytes, writes them under
  `attachmentsDir`, and **injects a normal `user` prompt** containing `@"<path>"` references. The
  driver never sees an `attachment` frame — only the resulting downstream `user` event. This is
  proven for Claude MITM/tmux. Native OpenCode file-part handling is not implemented, so OpenCode now
  advertises `attachments:false`. That bit disables the normal viewer surface; the compatibility relay
  does not enforce capabilities as an admission boundary, so a stale/custom sender can still force the
  unsupported Claude-style path until the future command actor rejects it before file/native work.

This is the central invariant: **the relay handles the broker-facing protocol; the driver handles
the harness-facing protocol; they meet only at the `Session`.**

---

## 6. `--rc-driver` wiring

The shipped value flag selects a launch path; default `mitm` preserves the original behavior.

- **`args.ts`** contains `"rc-driver": "value"` in `RC_FLAGS`.
- **`run.ts`** reads `--rc-driver`, then `RC_DRIVER`, then defaults to `"mitm"` and branches directly:
  - `mitm` → `runRcLaunchPath(...)` → `runRcLaunch(...)`;
  - `tmux` → `runTmuxDriverPath(...)` → `runTmuxDriver(ctx, ...)`;
  - `opencode` → `runOpencodeDriverPath(...)` → `runOpencodeDriver(ctx, ...)`.
  Only the non-MITM branches build the common `DriverContext`; none dispatches through
  `DriverFactory`.

All three still need `--rc-app` for the broker. The current guard warns when RC flags appear without
it, and an unknown `--rc-driver=<x>` returns exit 2 with the valid names.

```
remote-claw --rc-app https://app.example --rc-driver=tmux -- --model opus
            └ broker origin ─────────────┘ └ driver ────┘    └ forwarded to claude ┘
```

---

## 7. Current implementation inventory

### Present

- `packages/cli/src/host/rc/driver.ts` — the exported `Driver` / `DriverContext` /
  `DriverCapabilities` / `UpstreamPayload` / `ContentBlock` types + `DriverName`. It is a partial
  contract, not the dispatch mechanism.
- `packages/cli/src/host/rc/tmux/{driver,tmuxctl,transcript,inject}.ts` — `runTmuxDriver(ctx)` spawns
  plain `claude` on a private tmux server, tails transcript JSONL, and injects via an stdin-backed tmux
  paste buffer. Its process-local registrar lease stays `starting` until a live pane plus Claude's
  mandatory `SessionStart` marker prove the exact settings/native session; only then does it publish
  capabilities and enter `ready`. It also exports the currently unused `tmuxDriver(ctx)` façade.
- `packages/cli/src/host/rc/opencode/driver.ts` — `runOpencodeDriver(ctx)` bridges an `opencode serve`
  HTTP+SSE session by constructing the exported-interface implementation `OpencodeDriver`.
- `packages/cli/src/host/native/{adapter,index}.ts` — the neutral native-engine descriptors,
  registration request, conversation lease, lifecycle, capabilities, and adapter/registrar contracts.
  They do not import `Session`.
- `packages/cli/src/host/rc/drivers/legacy-registrar.ts` — the process-local A0 registrar. It assigns
  `rcb_*` bindings, enforces exact attempt replay and active identity uniqueness, validates readiness,
  owns each bridge lease, and does not own the native `Session`.
- `packages/cli/src/host/rc/drivers/bridge.ts` — `startBridgeSession` returns a lifecycle handle with a
  whole-announcement refresh; `bridgeSession` retains the older served-promise API.
- `packages/cli/src/host/rc/launch.ts` — the standalone MITM launch path and its host-scoped registrar.
  There is no `drivers/mitm-driver.ts` or `mitmDriver`.
- `packages/cli/src/host/rc/relay.ts` — the shared relay; its announcement metadata and capabilities
  can now be replaced as one post-setup snapshot without restarting the pumps. That validated local
  snapshot survives an advisory publish failure and is retried by later presence publication.
- `packages/clawsec/src/{canonical,aad}.ts` — the public cross-runtime canonical field writer and the
  A0 `canonicalAad` user of it. The extraction preserves the locked A0 byte vector. Canonical optional
  fields require explicit `null`; the older A0 DTO's omitted or `undefined` `clientMsgId` alone is
  adapted at the AAD boundary, while explicit `null` and other runtime values are rejected.
- `packages/clawsec/src/{a1-wire,a1-certificates,a1-onboarding,a1-broker,a1-ingress,a1-command,a1-result}.ts` — A1.5–A1.8a0's pure browser-safe v2
  address/token/route, KDF, frame, AEAD, digest, native-root/server-scope certificate, onboarding-key
  attestation, and `ViewerOnboardingBundleV2` transfer/verifier contracts. They retain no trust state
  and open no broker route themselves. The A1.6 broker module additionally freezes the selected
  capability, route/store, cursor/generation/manifest, retry/collision, and read-page contracts. The
  A1.8a0 result module freezes exact rejected action/chat payload bytes, stored semantic-result and
  delivery digests, stable result identity, and completion-observation selection. The same
  authority-free module now also freezes the exact `accepted` projection/admitted chat-creation
  payload bytes reserved for later A1.8a. Those codecs do not persist or authorize a result,
  projection, attempt, effect, or dispatch.
- `packages/cli/src/broker/a1-client.ts` and `apps/web/{lib/broker/a1-*,app/api/a1/**/route.ts}` — the
  dormant negotiation-first client and the separate selected SQLite/libSQL A1 provider. They are not
  invoked by any current driver, `HostRcRelay`, runtime-owner operation, or viewer path.
- `packages/cli/src/host/state/{ids,native-binding-authority,native-binding-authority-evidence,native-binding-authority-executable-evidence,native-binding-authority-workspace-evidence,path,validation,records,runtime,digests,protected,dispatch,backend}.ts`
  — A1.0's exact-shape parsers, canonical ID and digest contracts, pure database-path resolver,
  record/runtime shapes, protected-operation interfaces, separated first-dispatch and evidence-only
  reconciliation capabilities, and digest builders; plus A1.8a1-E0's six E-side canonical ID
  contracts and four deterministic builders, E1a's four strict ref-free parent codecs/commitment
  registry/raw digest helper, E1b1's strict executable-manifest codecs, and E1b2's strict workspace
  leaf codecs/raw-five-view verifier. The direct-only collectors live in
  `packages/cli/src/host/native/{linux-executable-collector,linux-workspace-collector}.ts`; E1b1's
  retained real native OpenCode proof/probe/verifier live under `spikes/opencode-native/`, without raw
  executable or chunk bytes. The E0/E1a/E1b1/E1b2 modules and tests contain no authority operation or
  runtime wiring.
- `packages/cli/src/host/state/{secure-filesystem,migrations,migration-v5,migration-v6,migration-v7,migration-v8,migration-v9,migration-v10,migration-v11,artifacts,repository,runtime-repository,registration-repository,native-root,terminal-root-repository,broker-route,broker-route-repository,broker-route-orchestrator,ingress,ingress-repository,ingress-actor,server-signing,server-signing-repository,command-adjudication,command-result-finalization,command-adjudication-repository,command-adjudication-validator,sqlite}.ts`,
  `packages/cli/src/host/native/evidence.ts`, and `packages/cli/src/host/runtime-owner/**` — A1.1–A1.8a0's
  Linux-only, descriptor-anchored SQLite kernel and protected-artifact operations. The supported Node
  range is `^22.13.0 || >=23.5.0`, admitted only from an exact stable `X.Y.Z` runtime string; the
  kernel exposes synchronous high-level transactions rather than raw SQL, and database-level
  asynchronous artifact methods reject inside a transaction callback. It behavior-probes disabled
  double-quoted string literals on every connection and validates an existing database through a
  coherent read-only WAL snapshot before a
  writable SQLite open, uses FULL migration commits followed by a non-blocking passive checkpoint and
  unconditional guardian fsync, permits a reader or competing checkpoint to leave checkpoint frames
  for later without deferring fsync, and types migration
  outcomes separately from non-retry-safe ordinary commit
  ambiguity. Schema v3 adds 81 ordered migration statements with digest
  `cMLS59JfiV7fRoK68n1kZz3DN9Vo4yu7VZAX_HxHpq4`, for an exact 91-object manifest of 13 tables,
  24 indexes, and 54 triggers. Schema v4 adds 141 ordered statements with digest
  `zx52EtAFNY9hEZneG3RW14zRCYR18gg7ysnltHbOkT0`, for an exact 231-object manifest of 30 tables,
  57 indexes, and 144 triggers. Schema v5 adds 38 ordered statements with digest
  `l32ozsKKBm5ueLOk-_IeiasPgp_deE-tZHEbaZ6urOE`, for an exact 269-object manifest.
  Schema v6 adds 36 ordered statements with digest
  `li87zqB0yxSfRtN-p_xT5Yk2xAvX8Iy5a1xDXNTYYZo`, for an exact 304-object manifest of 36 tables,
  78 indexes, and 190 triggers. Schema v7 adds 22 ordered statements with digest
  `uShlOvT_fWScwCLQD1g6-GAd1YyKR2QIlGjC0SPQWbw`, for an exact 326-object manifest of 39 tables,
  85 indexes, and 202 triggers. Schema v8 has 171 statements, digest
  `6Vf2H56rDvW2PGMrU83upUDz1r9gHP11tdq_w7T1K5E`, and 492 objects. Schema v9 has 81 statements,
  digest `fYrN5atmwIj-tlT_tTXmrg9kNF52ah-zWmgf7vVFQWE`, and 571 objects. Schema v10 has 50
  statements, digest `rdJC_2C5IyjfsTuXhxjFSzT0bvDYtlpT8o0xDvu4IEk`, and 619 objects. Schema v11
  has 38 statements, digest `SkkuAFJed-7GT9XyXXPCub7VFauqNY6eu0u4IQJEInc`, and 647 objects: 73
  tables, 147 indexes, and 427 triggers. The A1.2 high-level
  repository atomically bootstraps the first terminal
  graph, supports later explicit projects/chats and terminal selector replacement, inventories and
  reconciles durable state, and validates the complete narrow v3 graph. Its public opener exposes
  neither entropy nor clock injection, and artifact persistence
  failure poisons the live handle instead of masquerading as an unverified artifact. Forbidden async
  callback results poison before late continuation can reuse authority. Close retains guardians until
  SQLite is closed and permits a safe close retry; a failed open that leaves SQLite live quarantines
  that canonical database path until process restart without blocking other paths. A1.3's
  runtime-owner repository adds service fencing, runtime/incarnation and assignment/containment
  lineage, project-scoped local transitions, wrapped key/signature custody, binding incarnations,
  transport attachments/leases, lifecycle gates, inventory, reconciliation, and full semantic graph
  validation. Its validator binds every journaled fact one-to-one to an exact owner-fenced journal
  entry within the lease lifetime and the runtime assignment/incarnation active at that offset,
  replays acyclic exact local-conversation creation/fork/state lineage, and requires one exact
  attachment/lease/gate graph per prepared binding incarnation. A service takeover cannot mutate an
  existing runtime until it appends that runtime's successor assignment. A1.4 verifies exactly
  `remote-claw/native-engine-descriptor/v1`, `remote-claw/durable-project-selection/v1`,
  `remote-claw/native-conversation-ref/v1`, `remote-claw/native-conversation-capabilities/v1`, and
  `remote-claw/native-registration-metadata-evidence/v1`; persists sequenced native-conversation
  leases/publications/operations; reconciles uncertain commits; gates reattach on
  the retained `liveReattach` capability, and rotates a stale crash predecessor only under fresh exact
  owner/coordinator and binding/attachment fences. Ready deliberately leaves the chat recovering and
  terminal edge installing. A1.5 adds immutable root signer-activation floors, operations and
  certificates; two-stage activation/renewal; signature and full-chain semantic validation; lifecycle
  demotion with retained history; and exact replay and unknown-commit reconciliation.
- `packages/cli/src/host/state/{migration-v9,server-signing,server-signing-repository}.ts` and
  `packages/cli/src/host/server-signer/{service,orchestrator}.ts` — A1.7b0's direct-only schema-v9 signer ledger,
  strict record/digest contract, wrapped owned-file custody, initial self-anchor repository, bootstrap
  fail-stop reconciliation, and installed current-lease takeover. They are not exported from a
  production package barrel or invoked by a driver, runtime-owner operation, relay, or viewer.
- `packages/cli/src/host/state/{migration-v10,migration-v11,command-adjudication,command-result-finalization,command-adjudication-repository,command-adjudication-validator}.ts`,
  `packages/clawsec/src/{a1-command,a1-result}.ts`, and
  `packages/cli/src/host/server-signer/command-result-orchestrator.ts` — A1.7b1's direct-only
  common-command contracts, schema-v10 five-table adjudication ledger, semantic reopen validator,
  rejected-decision repository, abort/reprepare generations, and exact bind/sign/reconciliation
  composition; plus A1.8a0's schema-v11 three-table rejected closure, pure semantic-result bytes and
  digests, one-transaction finalizer, and complete-graph unknown-commit reconciliation. The pure
  contracts are exported from `@remote-claw/clawsec`, and the repository is attached to the secure
  host-state database, but the orchestrator remains outside the production import graph and no
  production operation invokes adjudication, signing, or finalization. Its `pending_seal` intent has
  no claim/seal/publish surface, ciphertext/output signature, broker call, effect, or native
  attempt/dispatch.
- No E1c/I migration, repository, signer boundary, validator, or operation exists yet. E1b1 closes
  only executable-manifest vocabulary plus the native role's retained stable-content observation.
  E1b2 closes the workspace leaf codecs, raw-byte DAG/parent verifier, synchronous direct-only
  collector, and non-skipping dual-path least-privilege namespace/bind-mount proof, but remains historical-only and
  non-authoritative; E1b3–E1b5 actual front-door/listener, isolation, capability, and full-parent
  evidence remain planned, and
  A1.8a1-I's atomic
  snapshot/credentialless-callable-port pair repository remains planned after E1c. They may reuse the protected artifact/signature ledgers and callable-port registry,
  but must remain outside every production run path until their own dormant proof gate passes.
- `packages/cli/src/host/runtime-owner/{auth,protocol,server,client,service,daemon,bootstrap,key-custody,production}.ts`
  plus `packages/cli/src/runtime-owner-cli.ts` — the machine-scoped Linux owner. It mutually
  authenticates over an abstract Unix socket, caps the server at 64 live connections and each
  unauthenticated connection at 1,024 inbound bytes and one authentication frame, rejects pre-auth
  pipelining, and bounds canonical frames and concurrency. The authenticated channel is duplex: every
  connection may register 64 callable ports, serve 32 reverse invocations concurrently, and consume
  4,096 reverse request IDs. The registry binds each port to its exact connection, binding,
  runtime/incarnation, attachment, owner/coordinator fences, and port generation. Its detached spawn
  pins cwd to the trusted
  CLI entry directory rather than a project-controlled cwd or `tsconfig`. It holds one process-start-bound durable service lease, self-tests wrapped keys before writability, reconciles
  unknown owner-lease commits after reopen, and fails closed on lease/listener/custody loss. Production
  installs A1.4 registration and A1.5 `native.root.activate` only for an explicit trusted adapter; the ordinary CLI passes none, so
  authenticated health returns `ownerOperationsWritable:false` and
  `nativeRegistrationEnabled:false`.

### Dispatcher

- `packages/cli/src/args.ts` declares `"rc-driver": "value"`.
- `packages/cli/src/run.ts` validates and directly dispatches each launch path; it builds
  `DriverContext` only for OpenCode and tmux. The wrapped MITM/OpenCode/tmux paths invoke the injected
  owner bootstrap after identity load and close only the returned RPC collaborator after driver exit.
  Owner failure is fail-soft because these remain A0 drivers; other run modes never invoke it.
- `packages/cli/src/host/rc/index.ts` re-exports the neutral lifecycle, legacy registrar, bridge
  lifecycle, driver types, and tmux façade.

### Compatibility surfaces left unchanged

- `packages/cli/src/host/rc/session.ts` — **the seam itself.** Drivers only *use* its public methods
  (`create`, `pushInitialize`, `pushUpstream`, `claimWorkerStream`, `followDownstream`,
  `pushUserInput`/`pushControlResponse`/`pushControlRequest`, `workerStatus`, `wake`, `close`). No new
  capability is required.
- `packages/cli/src/host/rc/mitm.ts` — only the MITM launch path uses it; other paths don't import it.
- `packages/cli/src/host/rc/certs.ts`, `gitinfo.ts` — MITM/announce helpers, unaffected.
- `packages/cli/src/broker/client.ts` — the transport contract is fixed; drivers go *through* the
  relay, never around it.
- `apps/web/lib/broker/**` (router, backends: vercel/local/sqlite), and **all of the web
  viewer** — they consume sealed frames keyed by `(identity, session)`. Since the frame stream is a
  pure function of the canonical `UpstreamPayload` (which every compatibility path matches), nothing
  downstream can tell which path produced the session.
- `packages/cli/src/security/provider.ts`, `packages/cli/src/trace.ts` — orthogonal (sealing,
  diagnostics).

---

## 8. Risks and mitigations

1. **Canonical-shape drift.** A driver emitting a slightly-off block (`tool_use` without `name`, a
   `null` content entry, a renamed field) is *silently dropped* by `mapUpstreamItems`. Mitigation:
   the `UpstreamPayload`/`ContentBlock` types live in `driver.ts`; current transcript tests use reduced
   captured JSONL fixtures and translation cases. A live transcript-versus-MITM parity test remains a
   proposed stronger gate.
2. **`runRcLaunch` changes regressing the MITM path.** Mitigation: keep its direct tests as the guard.
   The historical `mitmDriver` wrapper proposal was not implemented.
3. **Injection ambiguity / send-keys failures (tmux).** `runInjectPump` serializes the downstream
   stream, so a burst cannot interleave prompts. Prompt text reaches `tmux load-buffer` over stdin,
   never argv; bracketed paste and Enter are separate phases with a length-scaled settle. It ACKs
   prompt/key actions only after the tmux command succeeds, but tmux success is still not structural
   acceptance evidence from Claude, and a lost post-dispatch completion remains ambiguous. It maps
   `interrupt` (→ ESC) and `set_model` (→ `/model <id>` inject); `set_mode`/`end` have no faithful pane
   analogue (the viewer disables those controls, #149), so they safely no-op. A permission-decision
   write failure throws, leaves the response unacknowledged, and tears down the pump; it does not
   produce a false delivery receipt.
4. **Permission fidelity on non-MITM drivers.** Both non-MITM drivers attempt mirroring by default.
   **tmux** injects a **PreToolUse hook** that blocks each tool until the
   viewer answers (and pre-seeds claude's folder-trust bit so dropping `--dangerously-skip-permissions`
   doesn't hang a fresh cwd on the startup trust gate); **opencode** PATCHes an ask-all rule on the
   session and answers each SSE `permission.asked`. Opt out with `--rc-tmux-skip-permissions` (→
   `--dangerously-skip-permissions` auto-approve) or `--rc-oc-skip-permissions` (skip additional
   permission setup and PATCH; OpenCode keeps its own session permission config). OpenCode's parent
   setup now requires read/install/read-back before `ready`, but child setup remains asynchronous and
   first-tool-racy. Child tasks are run-cancelled, tracked, PATCH-fenced after cancellation, and joined
   under the shared teardown deadline. A literal-true reply response is only transport acknowledgement;
   selected-session ownership, native-TUI races, and terminal application remain unproved. Tmux now
   withholds its broker bridge until settings/trust setup, a live pane, and its mandatory startup
   `SessionStart` marker are proved. Hook-disabling modes and unmergeable settings fail closed.
5. **Status accuracy.** Without ground truth (the MITM reads claude's `PUT /worker` status), tmux
   infers `running`/`idle` from a transcript-append debounce, which lags a long "think". It advertises
   `status:false`; the internal heuristic is display/evidence only, not a promised native transition.
6. **Durable-restart cursors.** The relay's `serve()` calls `prepare()` to sample broker cursors
   before pumping; a driver must call `relay.serve(signal)` (not hand-roll the pumps). The sampled
   floor prevents replay of older inbound frames but can skip an unprocessed prompt that arrived
   before the sample; it is duplicate-prevention with a documented loss window, not fail-closed
   command recovery. It also does not make the synthetic `cse_*` channel a durable logical chat or
   recover its native/outward bindings.
7. **Launch cardinality.** Tmux and OpenCode launch one wrapper `Session`; one MITM launch can accept
   several intercepted Claude RC sessions. The dispatcher still selects one harness mode per wrapper
   process.
8. **Tmux teardown/restart.** The driver uses a private `0700` runtime and private tmux socket. Teardown
   deletes them only after a proved kill or proved absence; an unknown probe/kill retains them and logs
   the exact `tmux -S <socket> attach -t <session>` command. That preserves a possibly-live pane but
   does not make it recoverable by a new wrapper: its registrar and binding are process-local and
   `liveReattach:false`. Durable adoption is A1 work.

---

## 9. Summary

`Session` is the current shared relay port, not a complete host abstraction. Each harness path
**captures** output into the canonical content-block envelope (`pushUpstream`), **injects** downstream
user/control events (`followDownstream` or the native RC server), reports status where possible, and
lets the relay own broker-side permissions + attachments. `run.ts` directly selects
`--rc-driver={mitm|tmux|opencode}`; the exported `Driver`/`DriverFactory` pair does not unify that
dispatch. Above this compatibility port, the neutral host contract and process-local registrar now
mediate Claude MITM, OpenCode, and tmux sessions. The
capability-aware part is implemented: each path supplies `DriverCapabilities`, the relay rides them on
`session_announce`, and the viewer disables/labels declared unsupported controls. Claude MITM and
both A0.2 drivers wait for validated readiness before they start the bridge. OpenCode publishes
`status:false`, `attachments:false`, only interrupt control, and structured permissions only after
proved parent setup; §8 retains the child/reply limitations. Tmux publishes `status:false`,
records native `liveReattach:false` plus best-effort delivery evidence, and publishes structured
permissions only after its required hook/settings/trust readiness proof (or false after explicit
auto-approve opt-out).

A person can also use the harness's native TUI directly. That local path is outside the current
`Session` relay seam: tmux/OpenCode surface unmatched prompts post-hoc, while MITM drops ordinary
native user echoes. The selected runtime retains one logical remote-claw collaborator attachment per
structured session. Claude may realize that as a session-scoped physical connection. OpenCode instead
needs one epoch-fenced adapter lease enforced at its private HTTP endpoint because its server-wide SSE
plus independent HTTP requests expose no persistent writer connection identity. Replacing that lease
must also settle or quarantine requests already admitted under the old epoch; checking the epoch only
when a request arrives cannot retract a mutation forwarded to OpenCode. Codex uses one daemon-wide
native bridge with a separate logical binding per managed top-level chat thread; child-agent threads
stay nested native evidence until retained lineage proof establishes another user-visible mapping.
remote-claw can aggregate web, official-client, automation, or nested-server collaborators behind that
attachment; the native harness decides what is applied. For Claude, Codex, and OpenCode, any
native-client-facing façade or proxy sits below the future neutral host contract and must be
behaviorally indistinguishable from the pinned product's normal service. The current `Session` seam is
only a Claude-shaped compatibility projection; it is not that common adjudicator and cannot authorize
native work.
Native TUI traffic is never translated into the Claude-shaped `Session` schema on its way to the
native harness. Tmux cannot meet that structured drop-in contract and remains the explicit
lower-fidelity fallback.

A nested remote-claw server uses the same common decision path as any other collaborator. Before
sending inward, it jointly finalizes the signed result and signed lineage for that command. It calls
the nested operation complete only after a full downstream receipt ties the exact source event,
command, chosen target, and target server's signed result together. A partial ACK cannot release work.
Each edge carries commands inward and observations outward without converting one direction into the
other, so recursion cannot feed an echo back as a command. Nesting adds server boundaries only;
Claude, Codex, or OpenCode appears once, at the innermost end.

A1.0 freezes the selected host → project → logical-chat identity and record contracts above this seam.
A1.1 supplies local persistence/migration machinery and verified artifacts. A1.2 persists the narrow
server/project/mapping/chat/binding/intent/edge/coordinator graph, including each chat's exact mapping
generation. A1.3's owner opens the shared schema and persists its independent service lease. A1.4 can
now resolve A1.2 evidence, durably register the exact prepared graph, and reattach it through a bounded
callable port, but the ordinary CLI supplies no trusted adapter and therefore does not bind any A0
driver into that graph. A1.7a now uses A1.2 actor scopes for dormant route-local ingress through
`awaiting_order`; A1.7b0 supplies the dormant server signer and current-server route-install
compatibility; and A1.7b1 supplies rejected-only common command order through a signed-but-unaccepted
preparation. A1.8a0 atomically closes only that rejected arm into a final result, acceptance, terminal
overlay, and inert `pending_seal` intent. E1b1's implemented direct-only content collector does not
unblock E1c. A1.8a1-E1c/I first owns the inert evidence and
matched credentialless native-authority pair; A1.8a2 owns admitted attempt/dispatch/effect arming,
while A1.8b owns sealing/publishing, one-time dispatch, and evidence-only recovery. Nested targets/edges remain
rejected until N1. A1.3's schema and repository can persist runtime
roots/incarnations, append-only owner
assignments, positive containment, wrapped keys/signature state, already-project-scoped local
transitions, and binding/attachment/gate foundations. A1.4 adds process leases, publications,
operation sequences, and exact crash reconciliation. A1.5 adds the protected terminal-root
prepare/bind/sign/fresh-proof/transaction-local-finalize operation plus renewal and lifecycle demotion;
the finalizer exclusively stores and accepts its v6 signature. It leaves all A1 remote mutation and
broker integration disabled. The ordinary production operation registry is empty, so authenticated
health is the only successful RPC operation. Owner-RPC disconnect is detach, and one owner can
inventory many independent runtimes
and shared-daemon conversations once registration activates. The durable IDs stay separate from `Session.id`, the
`rcb_*` lease, engine-native IDs, and provider/broker connection IDs; the current `Session` seam does
not use A1 IDs or protected operations.

Alongside capabilities, each harness path supplies a `HarnessDescriptor` —
`{ agent: "claude-code" | "opencode"; mode: "rc" | "tmux" | "opencode" }` (the consts `MITM_HARNESS` /
`TMUX_HARNESS` / `OPENCODE_HARNESS`) — which the relay rides on every `session_announce` (#164).
The viewer labels each row in the session list from it (**Claude Code · RC** / **Claude Code · TX**
/ **opencode**) so the three harnesses don't look identical; a legacy host that omits it is treated
as the MITM harness (native-RC Claude Code, the only pre-#164 path).
