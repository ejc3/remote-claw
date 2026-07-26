# Native RC passthrough: dual-headed bridge scoping

**Status:** design scope plus an implemented app-side client foundation; the flag, forward-and-tap
orchestration, projector, and viewer wiring do not exist yet

**Proposed surface:** experimental `--rc-native-passthrough`, valid only with the native MITM driver

**Decision:** feasible as an experimental writable multi-client feature. Remote-claw's viewer submits
through Anthropic's canonical client API, while accepted events from it, the local TUI, and official
clients converge in Anthropic's canonical log; Anthropic acceptance and sequencing govern publication. A
lease is not a prerequisite, but general availability remains gated on the collision, reconnect,
lifecycle, and control proofs below.

**Relationship to the current architecture:** this proposal reopens, but does not supersede, the
2026-06-07 decision that current `--rc-app` keeps Anthropic's RC relay out of the loop
(`docs/v2-architecture.md` §14). Shipping the proposed flag requires an explicit decision change and a
full architecture/doc sync; absent that change, the existing MITM-only behavior remains authoritative.

## 1. Verdict

This is technically feasible. The repository already has all three foundations:

1. a TLS MITM that can forward real RC request/response bodies and SSE payload bytes unchanged while
   inspecting a separate copy (`MitmProxy.#onRequest`, `MitmProxy.#passthrough`, and
   `MitmProxy.#teeSse` in `packages/cli/src/host/rc/mitm.ts`);
2. a complete local RC-to-broker-to-viewer path
   (`docs/v2-architecture.md` §17.5, `packages/cli/src/host/rc/launch.ts:74-175`); and
3. a Phase 0 proof that an OAuth-authenticated non-official client can list a real session, post a user
   event, read history, and follow the client SSE (`phase0/spikes/rc_api_bridge.py` and
   `docs/phase0-findings.md` §4b).

The largest risk is **not transport or registration**. It is preserving one coherent event log and one
Claude worker when several input surfaces can write concurrently: the local TUI, one or more official
clients, and remote-claw's viewer. The captured protocol exposes a session-wide sequence and event UUIDs,
but no reliable non-null controller attribution, ownership token, or lease. Current
remote-claw ordering only serializes its own viewer connection. Prompt-while-busy, interrupt/prompt races,
permission responses, and duplicate worker echoes are not proven across these writers
(`docs/v2-architecture.md` §17.3, `docs/protocol.md:340-380`,
`docs/phase0-findings.md` §4c).

Accordingly:

- **GO** for an experimental forward-and-tap mode whose remote-claw viewer writes as another Anthropic
  client through canonical `POST /v1/code/sessions/{id}/events`.
- **No lease prerequisite:** an advisory controller indicator may be useful UX, but it cannot establish
  exclusivity over the local TUI or directly connected official clients and is not part of correctness.
- **NO-GO for general availability of unrestricted simultaneous writing** until a real-Claude collision,
  reconnect, and control suite demonstrates deterministic behavior.

The implementation should not pretend that `worker_jwt` is an app credential, should not open a second
worker stream, and should not locally inject viewer prompts before Anthropic accepts and sequences them.

## 2. Baseline and intended topology

### 2.1 What exists

`--rc-app` currently replaces Anthropic's RC plane. `runRcLaunch` starts a sealed broker provider,
`RelayCore`, the intercepting MITM, and one `HostRcRelay` per locally created session
(`packages/cli/src/host/rc/launch.ts:33-68`, `packages/cli/src/host/rc/launch.ts:74-143`,
`packages/cli/src/host/rc/launch.ts:145-175`). In relay mode, the MITM intercepts
`/v1/code/sessions` and `/v1/code/triggers`, fabricates the session and `/bridge` response, and serves the
worker REST/SSE endpoints itself (`INTERCEPT_PREFIXES`, `MitmProxy.#onRequest`,
`MitmProxy.#intercept`, and `MitmProxy.#streamWorker` in `packages/cli/src/host/rc/mitm.ts`). That is why
the official app cannot drive the resulting session: no real Anthropic RC session was registered.

`--rc-trace` is the other half. It starts the same TLS interception machinery without a local
`RelayCore`, forwards RC traffic to Anthropic, and only records request/response/SSE observations
(`packages/cli/src/host/rc/trace-run.ts:1-10`, `packages/cli/src/host/rc/trace-run.ts:17-46`,
`packages/cli/src/host/rc/trace-run.ts:47-96`). It preserves official RC but has no broker/viewer session.

The proposed mode combines forwarding from trace mode with the broker projection from relay mode. It is
not a small switch from “intercept” to “forward”: it also needs a real RC client, upstream identity and
sequence preservation, deduplication, canonical acceptance semantics, and precise capability policy.

### 2.2 Parties and exact interposition

```text
                                      REAL ANTHROPIC RC SERVICE
                               +-----------------------------------+
                               | session registry + canonical log  |
                               | worker REST/SSE    client REST/SSE |
                               +---------^----------------^--------+
                                         |                |
          forwarded worker side          |                | OAuth client side
  +---------------------------+           |                |
  | Claude host               |           |       +--------+-----------+
  | real `claude` + local TUI |           |       | official Claude app |
  | native --remote-control   |           |       | / mobile             |
  +-------------+-------------+           |       +---------------------+
                | HTTPS via injected proxy|               (direct; not proxied)
                v                         |
  +-------------+-------------------------+-----------------------------+
  | remote-claw on the Claude host                                      |
  |                                                                    |
  | [A] downstream-facing TLS/application server                       |
  |     terminates and observes /v1/code/sessions/** from native Claude |
  | [B] upstream-facing transparent worker proxy/client                 |
  |     forwards registration, bridge, worker REST and worker SSE       |
  | [C] OAuth RC client                                                 |
  |     reads client history/SSE and POSTs canonical viewer input       |
  | [D] projector + existing Session/HostRcRelay                        |
  |     maps the real canonical log into remote-claw frames             |
  +------------------------------+-------------------------------------+
                                 | clawsec-sealed frames
                                 v
                    +------------+-------------+
                    | remote-claw broker/relay |  ciphertext + routing
                    +------------+-------------+
                                 | clawsec-sealed frames
                                 v
                    +------------+-------------+
                    | our web viewer           |
                    | observe / submit input   |
                    +--------------------------+
```

Remote-claw interposes as a **server** only on the host's proxied connection: it presents a locally trusted
certificate and receives native Claude's Anthropic-origin requests. It interposes as an upstream
**worker-side proxy/client** by making the corresponding requests to Anthropic. Separately, it acts as an
OAuth-authenticated RC **app-side client** to read or append to the same real session. Its existing
`Session`/`HostRcRelay` remains remote-claw's own server-side capability toward the web viewer.

The official app-to-Anthropic connection remains direct. Without putting the phone/device behind another
proxy, remote-claw cannot and need not proxy the official app's socket. “Full MITM” here therefore means
full visibility and mediation of the native host leg, plus a peer client on the real canonical log—not
network interception of the official device.

## 3. Protocol and authentication mechanics

### 3.1 Observed real flow

The current protocol is HTTP/JSON plus SSE, not Claude's separate `--sdk-url` CCRv1 WebSocket transport
(`docs/v2-architecture.md` §17.1). The observed split is:

| Role | Operations | Credential |
|---|---|---|
| Native host before bridge | create/read session and request bridge | user's Claude OAuth bearer |
| Native worker after bridge | worker metadata/status, heartbeat, event POST, delivery ACK, worker SSE | returned `worker_jwt` |
| App/client | list/read sessions, history, client SSE, client event POST | user's Claude OAuth bearer |

The endpoint maps and auth split are recorded in `docs/v2-architecture.md` §17.2 and
`docs/phase0-findings.md` §4b.

The tracked Phase 0 endpoint map records native Claude registering a session, requesting `/bridge`, then
using the worker metadata, heartbeat, event, delivery and SSE endpoints
(`docs/phase0-findings.md` §4b, `docs/v2-architecture.md` §17.2). In passthrough mode all of
these requests and responses must be forwarded, including the real session ID, bridge base URL, epoch,
expiry and token. Unlike current relay mode, the proxy must never substitute the synthetic `rcw-*`
bridge response (`MitmProxy.#intercept` in `packages/cli/src/host/rc/mitm.ts`).

### 3.2 What `worker_jwt` authenticates

The tracked findings show `/bridge` returning a session-scoped `worker_jwt` with role `worker`,
`worker_epoch` and `expires_in: 14400`; worker metadata, heartbeat, delivery, event and stream calls form
the corresponding host-side surface (`docs/phase0-findings.md` §4b,
`docs/v2-architecture.md` §17.2). Detailed decoded JWT header/claim assertions remain local capture
evidence until a sanitized fixture is committed.

The defensible conclusion is that `worker_jwt` authenticates the **Claude host/worker for this session**.
It does not authenticate an app/controller. Holding it would let remote-claw replay or originate
worker-role calls, not appear as the official app. Opening a second worker SSE with it could supersede or
compete with the native worker, exactly the failure this mode must avoid. The proxy should therefore:

- forward the bridge response and the host's worker requests unchanged;
- tap the existing worker SSE in flight instead of opening another worker stream;
- retain only non-secret parsed session/epoch metadata; and
- never persist or repurpose `worker_jwt`.

To speak as an app, remote-claw needs the user's OAuth credential. The Phase 0 client obtains
`claudeAiOauth.accessToken` and successfully uses it for history, SSE, and user-event POST
(`phase0/spikes/rc_api_bridge.py:26-32`, `phase0/spikes/rc_api_bridge.py:54-92`,
`phase0/spikes/rc_api_bridge.py:142-169`). Production app-side calls require a secure credential source,
but native Claude remains the sole writer and refresher of its credential file. Remote-claw reads the
current access token, waits for and rereads a safely validated file rotation after a 401, and never writes
or independently refreshes that shared credential. It must still respect revocation. Do not repurpose
`worker_jwt` or harvest the proxied registration `Authorization` header: keeping worker forwarding and
app authority separate makes the credential lifecycle and no-additional-persistence boundary explicit.
Proxying the official app's own connection is neither required nor available in the normal topology.
The implemented default file reader is Linux-only and requires ownership checks plus `O_NOFOLLOW`.
macOS Keychain and Windows ACL-backed credentials need separate secure providers before this client can
be wired there; callers can inject such a provider without changing the fixed-origin RC transport.

### 3.3 Event projection and deduplication

Anthropic must be the authoritative sequencer. A viewer prompt must be posted through remote-claw's
OAuth client; the native worker and official app should then observe that accepted event through their
ordinary streams/history. Local injection followed by best-effort mirroring would create split-brain
ordering and make an event visible locally before it exists in official history. The durable-log design
already identifies “viewer prompt through real client API” as the coherent passthrough model
(`docs/durable-log-design.md:588-603`).

Source-based filtering is insufficient. The client event POST returns
`duplicate`/`event_id`/`sequence_num` fields, while related observations can arrive through the worker
path, client history and client SSE (`docs/phase0-findings.md` §4b). The tracked spike proves those
surfaces independently, not that every path exposes the same stable identity. The projector must treat the
submitted UUID, returned event ID, sequence and part identity as correlation candidates until the first
writable release verifies the POST-result/worker/history/SSE relationship. Phase 4 expands that proof to
collisions, reconnects, and lifecycle changes.

The existing canonical `Session` cannot be used unchanged as the source of truth: it maintains independent
local counters/logs and mints IDs (`packages/cli/src/host/rc/session.ts:140-161`,
`packages/cli/src/host/rc/session.ts:177-220`, `packages/cli/src/host/rc/session.ts:270-284`), while
`RelayCore.create` mints a local session ID (`packages/cli/src/host/rc/session.ts:376-398`). The new
projector needs to adopt the real session ID and map sparse/composite upstream positions into the dense
broker transcript sequence without conflating the two domains
(`docs/durable-log-design.md:389-421`).

It must also tolerate protocol variation. The tracked 2.1.168 reference flow begins with an
`initialize` event and response (`docs/phase0-findings.md` §4b), and remote-claw's synthetic relay
guarantees that ordering. A separate manual local capture did not show `initialize` before a sequence-1
user event; because that raw credential-adjacent capture is intentionally uncommitted, treat the
variation as a compatibility risk to reconfirm in the gated proof, not as a repository fixture. The
projector must not blindly synthesize an upstream initialize. It should use client history to repair
gaps because worker SSE does not backfill history (`docs/protocol.md:484-497`,
`docs/v2-architecture.md` §14).

## 4. Multiple input surfaces on one session

### 4.1 What the protocol appears to assume

The observed event envelope distinguishes `source: "client" | "worker"` and includes attribution fields
such as `sent_by_account_id` and `device_attestation_status`, but the tracked example has a null account
ID and exposes no ownership or lease primitive (`docs/phase0-findings.md` §4b,
`docs/v2-architecture.md` §17.3). The evidence proves a custom client and native worker path
sequentially; it does not prove concurrent local-TUI, official-client and custom-client writers.

Remote-claw also has single-controller assumptions:

- local worker SSE deliberately supersedes the prior follower
  (`MitmProxy.#streamWorker` in `packages/cli/src/host/rc/mitm.ts`);
- viewer prompts are accepted, echoed, and injected immediately
  (`packages/cli/src/host/rc/relay.ts:811-885`);
- ordinary upstream user text is hidden because the current viewer echo supplies it
  (`packages/cli/src/host/rc/relay.ts:186-199`, `packages/cli/src/host/rc/relay.ts:243-268`);
- control frames have `seq: null`, and order-dependent controls rely on client-side serialization
  (`docs/protocol.md:131-143`, `docs/v2-architecture.md:841-849`); and
- the existing multi-client test sends one prompt only after the previous result, so it does not test a
  collision (`apps/web/test/e2e/rc-spine.integration.test.ts:627-659`).

Those choices would mis-handle a canonical prompt from the local TUI or an official app, race viewer
acceptance ahead of Anthropic's order, or duplicate an echo. Passthrough needs origin correlation and
must publish a prompt to the viewer only from the accepted canonical event (an optional “sending” UI
state may precede it).

### 4.2 Collision and ordering rules that must be explicit

1. **Canonical order:** Anthropic `sequence_num`, plus stable within-event part order, wins. Arrival time
   at the MITM, client SSE, or broker does not.
2. **Echo/dedup:** the UUID/event ID identifies a logical event even when it appears as client input,
   worker echo, POST result, history, and reconnect replay. Existing relay UUID handling is not enough:
   the driver contract explicitly requires dedup before `pushUpstream`
   (`packages/cli/src/host/rc/driver.ts:238-259`).
3. **Prompt collision:** the service's prompt-while-busy behavior is unknown. Until proven, a later input
   surface must not be told its turn was accepted merely because remote-claw queued it.
4. **Control collision:** interrupt, model, mode, and permission responses are order-dependent and may not
   share the normal event sequence. Permission handling is first-consumer-wins locally
   (`packages/cli/src/host/rc/relay.ts:898-945`), which is not a distributed arbitration policy.
5. **Reconnect:** history reconciliation must occur before new local publication, with a bounded dedup
   cache or durable cursor. The broker's `FrameOrderer` can reorder/dedup broker frames but cannot resolve
   upstream controller intent (`packages/cli/src/broker/order.ts:1-11`,
   `packages/cli/src/broker/order.ts:48-129`).

### 4.3 Writable baseline and optional coordination policies

| Policy | Behavior | Assessment |
|---|---|---|
| Writable multiplex | Every enabled input surface may submit; Anthropic acceptance and sequence are authoritative and all echoes are correlated | **Selected experimental baseline.** The first release needs bounded idle/busy proofs; this selection is not a GA stability claim |
| Read-only viewer | Local TUI and official app(s) may write; our viewer observes canonical history/status | Optional restricted capability, not the initial rollout stage; it requires a real authorization boundary because the current pass grants steer |
| Advisory coordination / hand-off | The UIs display a preferred controller and remote-claw may warn before submitting while another controller is preferred | Optional UX only; it cannot prevent the local TUI or official app(s) from writing and must not determine ACK, ordering, or correctness |
| Single-writer hand-off | User explicitly stops writing in one UI before enabling the other | Operationally clear, least convenient, still needs collision recovery |
| Local inject + mirror | Inject into native worker first, later copy to Anthropic | Reject: split ordering, duplicate risk, and official history can disagree |

No lease or hand-off is a prerequisite for the writable baseline. If an advisory controller indicator is
added, an unexpected canonical input from the local TUI or an official app must not be silently dropped.
It may mark the preference contested, but the event must be incorporated at its upstream sequence. A hard
lease is impossible without an Anthropic-supported controller primitive plus control of every app
connection and local keyboard input.

## 5. Security and privacy boundary

Current `--rc-app` is zero-knowledge with respect to **remote-claw's broker**, not necessarily with
respect to Anthropic inference. The MITM keeps RC endpoints local, while `/v1/messages` and OAuth traffic
pass to Anthropic in the default inference mode; Bedrock/accountless mode is the stronger “nothing reaches
Anthropic” variant (`packages/cli/src/host/rc/launch.ts:1-6`,
`packages/cli/src/host/rc/launch.ts:176-207`, and `MitmProxy.#serveBedrock` in
`packages/cli/src/host/rc/mitm.ts`).

Native passthrough deliberately gives up RC zero-knowledge relative to Anthropic. Anthropic receives:

- real session registration metadata such as title, working directory, model and repository metadata
  (`docs/phase0-findings.md` §4b);
- every client/worker event needed for official history and driving, including prompts, assistant/tool
  content, results, controls/status and heartbeats; and
- normal inference traffic when Anthropic is the inference provider.

The remote-claw transport can remain E2E-encrypted. `BrokerClient` seals before publish and opens after
receive (`packages/cli/src/broker/client.ts:130-188`, `packages/cli/src/broker/client.ts:235-260`);
the web viewer derives the sealed provider from the pass
(`apps/web/app/lib/viewer.ts:265-300`, `apps/web/app/lib/viewer.ts:427-600`); and the broker route/workflow
handle routing plus opaque ciphertext rather than decrypting content
(`apps/web/app/api/relay/route.ts:8-10`, `apps/web/app/api/relay/route.ts:61-119`,
`apps/web/workflows/relay.ts:4-9`, `apps/web/workflows/relay.ts:41-50`). `clawsec` binds frame headers in
AAD and its pass grants read+steer capability (`packages/clawsec/src/aad.ts:87-113`,
`packages/clawsec/src/pass.ts:44-99`).

Under the writable baseline, possession of the current pass authorizes canonical user-event submission,
not merely transcript viewing. A UI-only read-only state is not an authorization boundary. A shareable
read-only viewer would require a separate cryptographic capability and host-side enforcement.

Thus a hybrid is coherent but must be described accurately:

- host and authorized viewer see plaintext;
- Anthropic has a separate plaintext RC copy so the official app can work;
- remote-claw's broker/storage sees ciphertext and routing metadata; and
- viewer-only annotations may remain E2E-only, but any prompt/control intended to drive the shared
  session must go through Anthropic to remain canonical.

Attachments expose the tradeoff sharply. Today's viewer attachment bytes remain E2E and are materialized
on the host before a local `Read`; official RC uses attachment metadata plus out-of-band file UUIDs
(`docs/protocol.md:476-483`). Official parity requires implementing Anthropic's upload path—thereby giving
Anthropic the bytes—or explicitly disabling passthrough attachments at first. A local-only attachment
injection would make official history incomplete.

Secret-safe tracing is now the baseline. Trace mode recursively redacts credential-bearing fields and
recognized token patterns from bounded RC request, JSON-response and SSE trace copies;
malformed/truncated JSON fails closed. On supported POSIX hosts with `O_NOFOLLOW`, `RC_LOG_FILE` appends
only to an owned regular `0600` non-symlink file; unsafe or unsupported targets cause records to be
dropped with a warning. Transparent-forwarding tests prove the unredacted payload bytes still reach the
worker/upstream while trace copies do not
(`packages/cli/src/host/rc/mitm.ts`, `packages/cli/src/host/rc/mitm-trace.test.ts`,
`packages/cli/src/trace.ts`). A manual local run on 2026-07-26 against Claude Code 2.1.218 observed real
registration, bridge, worker SSE, OAuth list/history/post and client-SSE reconnect; scans found no
bearer/JWT pattern in either capture. The credential-adjacent raw captures were deleted rather than
committed, so this is a run note, not reproducible repository evidence. The passthrough mode must preserve
this boundary: bridge tokens and OAuth values remain memory-only, never enter broker frames, and every
gated proof includes a full artifact scan plus a sanitized, reviewable result.

## 6. Proposed implementation

### 6.1 Flag and constraints

Add boolean `--rc-native-passthrough` (environment equivalent
`RC_NATIVE_PASSTHROUGH=1`). Absence preserves today's `--rc-app` behavior. Require:

- `--rc-app`;
- native `--rc-driver=mitm`;
- `--rc-inference=anthropic`;
- a real Claude account/OAuth credential; and
- native RC enabled either by forwarded `--remote-control` or later `/remote-control`.

During development, every gated real-service proof must use a session created specifically for that test,
never an existing human live session, until explicit credential, lifecycle and collision guardrails pass.
This preserves the test-session boundary in `docs/durable-log-design.md` Phase C and its PR gate.

The relevant parser/help/dispatch seams are
`packages/cli/src/args.ts:8-43`, `packages/cli/src/help.ts:33-45`,
`packages/cli/src/help.ts:75-80`, and `packages/cli/src/run.ts:193-266`. The wrapper already preserves the
native `--remote-control` argument (`packages/cli/src/args.ts:76-79`) and supports lazy registration after
launch (`packages/cli/src/host/rc/launch.ts:1-6`).

Hard-error with Bedrock or accountless operation: those modes intentionally synthesize the control plane
and prevent real Anthropic access (`packages/cli/src/run.ts:304-380`,
`packages/cli/src/host/rc/launch.ts:75-83`, `packages/cli/src/host/rc/launch.ts:176-207`). Keep
`--rc-trace` mutually exclusive and diagnostic rather than overloading it
(`packages/cli/src/run.ts:175-190`).

Controller posture should be separate from transport. The initial flag means passthrough plus writable
viewer input submitted only through `AnthropicRcClient.postEvent`; it does not enable local injection or
best-effort mirroring. No lease is required. A future read-only capability or advisory controller
indicator is a separate policy surface and must not alter canonical acceptance or ordering.

### 6.2 Reuse versus new driver

Keep `--rc-driver=mitm`: the harness is still native Claude RC. Reuse:

- certificate generation, child proxy environment and teardown from `runRcLaunch`
  (`packages/cli/src/host/rc/launch.ts:74-143`, `packages/cli/src/host/rc/launch.ts:222-235`);
- payload-byte-preserving upstream forwarding and SSE teeing from `MitmProxy`
  (`MitmProxy.#passthrough`, `MitmProxy.#teeSse`, and `MitmProxy.#teeJson` in
  `packages/cli/src/host/rc/mitm.ts`);
- `bridgeSession` and the existing sealed broker/viewer route
  (`packages/cli/src/host/rc/drivers/bridge.ts:38-72`); and
- `HostRcRelay`'s transcript, permission, presence and control mapping where its immediate-local-echo
  assumptions are removed or bypassed.

Do **not** force the Anthropic app-side client into the existing generic `Driver` contract unchanged.
That contract assumes a harness adapter creates a local `Session`, pushes one synthetic initialize,
injects viewer events directly into the harness, and owns acknowledgements
(`packages/cli/src/host/rc/driver.ts:116-141`). Passthrough instead projects an externally sequenced
session and submits viewer input to that sequencer. Implement a new internal orchestration
(`runRcNativePassthrough`) with two focused adapters:

1. `AnthropicRcClient`: OAuth list/history, a one-connection SSE primitive (with multiple
   simultaneous calls permitted), user-event POST, and secure credential reread after native-Claude
   rotation—never an OAuth refresh writer; and
2. `RcPassthroughProjector`: merge registration, tapped worker traffic, client history/SSE and POST
   results into one deduplicated real-session view.

This is a new internal mode/adapter, not a new user-facing harness driver.

### 6.3 Minimal code seams

1. **CLI:** add the flag, validation, and dispatch at the parser/help/run seams above.
2. **Launch:** factor the common certificate/proxy/child lifecycle out of `runRcLaunch` and
   `runRcTrace`; start the broker bridge only after the real registration response identifies a session.
3. **MITM:** extend `MitmOptions.mode` in `packages/cli/src/host/rc/mitm.ts` with a forward-and-tap
   mode or structured callbacks.
   Registration, bridge, worker POST/ACK/status and worker SSE must all forward; callbacks receive parsed,
   redacted metadata/events. Do not call the existing `MitmProxy.#intercept` local interceptor.
4. **Upstream client (foundation implemented):** the production TypeScript equivalent of the Phase 0
   client now provides list/history, canonical user-event POST, a secure read-only credential source,
   bounded wait/reread after native-Claude rotation on 401, a one-connection SSE primitive that permits
   multiple simultaneous calls, aborts, and secret-safe diagnostics. The SSE primitive promotes only
   direct canonical `client_event`/unnamed envelopes and preserves every other JSON record as an opaque
   tagged frame. A sanitized exact client-SSE fixture, full tagged-union semantics, reconnect/cursor
   behavior, and bounded history repair remain later work until their production behavior is proven.
5. **Session/projector:** support a real external session ID and raw canonical event identity rather than
   minting everything locally (`packages/cli/src/host/rc/session.ts:140-220`,
   `packages/cli/src/host/rc/session.ts:376-398`).
6. **Relay:** replace immediate viewer echo/injection with “submit, correlate, then publish accepted
   upstream event”; surface unmatched official-app user events instead of dropping all upstream user text
   (`packages/cli/src/host/rc/relay.ts:186-199`, `packages/cli/src/host/rc/relay.ts:811-885`).
7. **Capability and authorization policy:** advertise only the proven writable prompt capability and
   enforce it on the host. A pass currently grants both read and steer
   (`packages/clawsec/src/pass.ts:44-99`), so viewer UI policy alone is not a strong authorization
   boundary; a genuinely shareable read-only pass would be a separate security feature. Any advisory
   controller indicator is optional UX and must not participate in ACK or ordering decisions.
8. **Proof:** extend or fork the gated real-Claude harness rather than claiming the current test covers
   passthrough. It currently launches a real logged-in Claude behind the local relay and proves only the
   synthetic remote-claw registration/turn (`apps/web/test/prove/real-rc.prove.test.ts:1-13`,
   `apps/web/test/prove/real-rc.prove.test.ts:65-123`).

## 7. Phased delivery and proof milestones

Every phase needs deterministic fake-service tests plus a gated real-service milestone. Captures were made
against one account and one Claude Code version, and the protocol is explicitly reverse-engineered and
version-sensitive (`docs/phase0-findings.md:3-6`, `docs/v2-architecture.md` §17). A test must fail
loudly on unknown shapes rather than normalizing drift invisibly.

### Phase 0 — reconfirm protocol and close secret leakage

Implementation hardening completed 2026-07-26, with a manual local run against Claude Code 2.1.218:

- re-ran registration/bridge/worker plus OAuth list/history/post and client-SSE reconnect probes;
- added structural redaction for bridge response tokens, OAuth/recognized token patterns and diagnostics;
- added transparent-forwarding, leak-scan, bounded-copy, POSIX capture-file safety and shutdown tests.

Still specify the production lifecycle contract for credential rotation/401/revocation, SSE cursors,
worker epoch/rebridge, and archive before Phase 1 is complete. Native Claude remains the sole OAuth
refresher; remote-claw only rereads a validated rotation.

**Manual Real-Claude result (uncommitted captures, deleted after scanning):** native Claude registered
and bridged a real Anthropic session; a custom OAuth client found it, read history, reconnected client
SSE and posted events; the worker consumed them and returned assistant events; and scans of both emitted
captures found no bearer/JWT pattern. Re-run this gated proof and retain a sanitized result before using
it as a release gate.

### Phase 1 — forward, tap and canonical viewer write

- Add forward-and-tap MITM mode and real-session projector.
- Use the implemented `AnthropicRcClient.postEvent` foundation to submit every viewer prompt with a stable
  viewer-generated UUID.
- Reconcile client history with the tapped worker stream and publish exactly-once remote-claw transcript
  frames.
- Keep a submitted prompt provisional until Anthropic returns its POST result and the projector correlates
  the accepted canonical event. Never locally inject, mirror, or report acceptance first.

**Real-Claude milestone:** a web-viewer prompt sent while idle drives native Claude through canonical
`POST /v1/code/sessions/{id}/events`; the local TUI, official history, and our viewer show it exactly once
with the same `event_id`/`sequence_num` ordering. A following local-TUI or official-app prompt appears in
that same canonical log without restart, including across a forced SSE reconnect.

### Phase 2 — writable multi-client experimental release gate

- Determine and persist the observed mapping among the submitted UUID, POST result identity, worker
  delivery/echo, history, and client SSE; do not assume one field spans every path before this gate.
- Exercise viewer, local-TUI, and official/custom-client user prompts both while idle and while a turn is
  active. Honor Anthropic's observed accept, queue, reject, or timeout result; do not substitute a local
  queue and do not emit a false accepted ACK.
- Bound retry and reconnect behavior so one viewer submission cannot become two canonical turns.
- An advisory controller indicator may be explored as optional UX, but it is not required for submission
  and cannot establish exclusivity or participate in correctness.

**Real-Claude milestone:** a repeatable user-prompt matrix across the viewer and at least one other live
input surface produces canonical FIFO behavior or an explicit upstream rejection for both idle and busy
cases, with no duplicate rows, lost turns, false acceptance, or lease prerequisite. Passing this milestone
permits an explicitly experimental writable release; it is not the GA stability claim.

### Phase 3 — controls and interactive parity

- Reverse-engineer and implement only proven client-side shapes for interrupt, model, mode, permission and
  AskUserQuestion responses.
- Either implement the real attachment upload path or advertise attachments unsupported.
- Preserve explicit per-verb capabilities; never fabricate confirmed state
  (`packages/cli/src/host/rc/driver.ts:13-56`).

**Real-Claude milestone:** each advertised verb is exercised from our viewer and observed consistently by
native Claude plus the official app. Unsupported verbs are visibly disabled. AskUserQuestion and file
behavior are either proven or explicitly absent.

### Phase 4 — collision and resilience gate

- Expand the Phase 2 user-prompt matrix across multiple app clients, reconnects, expiry boundaries, and
  longer-running turns.
- Test prompt/interrupt, model/mode, and permission-response races.
- Test OAuth credential rotation/401/revocation without remote-claw writes, worker JWT expiry/rebridge,
  worker epoch changes, app and worker SSE reconnect, process restart, and history replay.
- If an advisory controller indicator exists, verify that contention never revokes, drops, reorders, or
  independently ACKs a canonical event.

**Real-Claude milestone:** a repeatable matrix produces canonical FIFO behavior or an explicit rejection
for every case, with no duplicate transcript rows, lost turns, fenced native worker, false acceptance, or
secret-bearing logs. Only after this milestone should multiplexing be considered for GA.

## 8. What is simpler, what is harder, and open questions

### Simpler than a ground-up bridge

- The real protocol is ordinary HTTP/JSON/SSE and both halves have already been independently observed
  (`docs/v2-architecture.md` §§17.1-17.2).
- Trace mode already performs the required payload-byte-preserving host-side forwarding and SSE tap.
- The Phase 0 OAuth client proves basic app-side operations end-to-end.
- Existing broker, viewer and clawsec code can carry a projected transcript without exposing plaintext to
  the broker.
- The real service supplies a canonical session ID, sequence and history that can anchor reconnect repair.
- The PTY proof already solves the difficult mechanics of launching and driving a logged-in real Claude.

### Harder than current `--rc-app`

- There are two credential domains with different authority, expiry and refresh behavior.
- Upstream sequence/UUID identity must be translated into remote-claw's dense broker sequence without
  double publication from several observation paths.
- No reliable non-null controller attribution or hard lease primitive has been observed.
- Only user-event POST is proven for the custom client; control and attachment client APIs remain
  reverse-engineering work.
- `initialize` behavior differs between captures.
- Worker epoch/rebridge, OAuth credential rotation/reload, archive and long-lived reconnection paths are
  unproven.
- Real-service tests require a logged-in account, are slower/flakier, and may break on an unannounced
  protocol revision.
- Product copy must explain that broker E2E encryption remains, but Anthropic now receives the RC
  transcript by design.

### Open questions that bound the writable experiment or block GA

1. Does Anthropic accept client-side interrupt, model, permission-mode, permission and AskUserQuestion
   responses through public observed endpoints, and what are their exact ACK/error semantics? Until
   proven, these capabilities remain disabled rather than blocking canonical user prompts.
2. What happens when a second user event arrives while the worker is busy: queue, reject, interrupt,
   merge, or undefined behavior? The Phase 2 release gate must record and safely surface this result.
3. Do the local TUI and multiple official clients have an undocumented arbitration or attribution
   mechanism absent from the captured envelope?
4. What secure macOS Keychain and Windows ACL-backed OAuth providers should complement the implemented
   Linux file reader, and do policy, device-attestation or elevated-auth constraints apply to custom
   clients?
5. What cursor/`Last-Event-ID` and history semantics are reliable after client or worker SSE reconnect?
6. How are `worker_jwt` renewal, bridge replay and `worker_epoch` fencing expected to work?
7. Will official apps render events created by an unknown custom client identically, including
   attachments and interactive controls?
8. What upload API and retention/privacy behavior are required for official-compatible attachments?
9. What are session archive/end ownership, rate-limit, and lifecycle rules with multiple input surfaces?
10. What compatibility and user-warning policy is acceptable for an undocumented protocol that can drift?

## 9. Recommendation

Build `--rc-native-passthrough` as an **experimental, Anthropic-only, writable multi-client
forward-and-tap projection**. Reuse the native MITM and sealed broker path, add a distinct OAuth RC client
and externally sequenced projector, leave the official app directly connected, and submit viewer prompts
only through Anthropic's canonical `POST /v1/code/sessions/{id}/events` path. No lease is a prerequisite;
any controller indicator is optional UX. Release the writable experiment only after the Phase 2
prompt/ACK/dedup proof, and do not market it as generally available until the Phase 4 collision matrix,
OAuth/JWT lifecycle, controls, reconnect repair, and mandatory secret-redaction gates all pass. That
sequence enables the selected multi-client baseline without pretending the observed protocol already has
GA-grade arbitration.
