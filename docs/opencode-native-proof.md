# OpenCode native protocol proof

**Status:** evidence captured 2026-07-29; this is narrow compatibility evidence for one pinned
OpenCode build, not proof of the selected A2 request, TUI coexistence, or shared-writer adjudication.

## Result

One isolated OpenCode `1.17.5` native server began with an empty session list. The probe issued exactly one `POST /session` with `metadata.remoteClawCreationId = "rcc_remote_claw_opencode_native_proof_001"`. The response and the next session listing contained exactly one matching `ses_*` with that marker.

The probe then sent `prompt_async` with caller-supplied `messageID = "msg_remoteclaw_native_proof_001"`, `noReply:true`, and one fixed text part. The `204` response had an empty body. Native history and legacy `/event` SSE both carried that exact message ID and one exact native part.

Sending the same request a second time returned another empty `204`. It did not deduplicate the request: the same native user message kept the caller ID and gained a second distinct part with the same text. In this exact no-model, `noReply:true`, one-server-incarnation case, the caller ID is a positive correlation seam but not an idempotency key.

The retained 58-event decoded SSE sequence contains exactly one selected connection, session-create, and session-delete event and exactly two selected message and part updates for the caller ID, in order and cross-checked against both history snapshots. The fixture requested no assistant reply and observed no assistant event for the session.

The probe deleted the native session, required session/history reads to return the pinned not-found shape, required the session list to become empty, disposed the server, and verified process-group exit, closed loopback socket and SSE/proxy resources, and removal of its temporary root.

## Relationship to selected A2

Neither retained request is the selected A2 wire request.

The creation probe used a `directory` query, a `title`, and metadata containing only
`remoteClawCreationId`. Selected A2 instead requires empty query, the pinned
`x-opencode-directory` header, no title, and this exact compact body:

```json
{"metadata":{"remoteClawCreationId":"<nativeCreationMarker>","remoteClawCreationIntentDigest":"<nativeCreationIntentDigest>"}}
```

The prompt probe sent caller `messageID`, `noReply:true`, and one text part. It did not send a `model`
field, and its code did not set `x-opencode-directory` on that request. Native history recorded
OpenCode-selected model metadata, but that is not a caller-supplied model field. Selected A2 forbids
both `model` and `noReply` and requires exactly:

```json
{"messageID":"<nativeActionId>","parts":[{"type":"text","text":"<text>"}]}
```

That request must be `POST /session/{nativeConversationId}/prompt_async` with empty query and the exact
semantic header vector `content-type: application/json`, then
`x-opencode-directory: <canonical directory>`. Its JSON must use the selected strict byte-level
encoder. The current compatibility driver is different again: it sends `{model, parts}` and no caller
`messageID`.

This fixture also bypasses the common remote-claw command path. It contains no signed
`CollaborationCommandResultRecord`, admitted-result tuple, decision/executor evidence,
runtime-owner-signed capability snapshot, retained translator record, one-time front-door dispatch, or
real native TUI collaborator. Its history/SSE checks establish the narrow caller-ID behavior below;
they are not the complete linearly proved history snapshot and native-order evidence that A2 requires.

## Version and evidence pin

- OpenCode version: `1.17.5`.
- Platform: Linux `arm64`; Node `v22.23.1`.
- Launcher SHA-256: `d167e30e12cca32cc4a5da0003ee0deb1120b5ca5ee2d64cef23aec44a3c9fa9`.
- Native binary SHA-256: `fe1839ac5c417c5fc4a08dd268465907c3e8c6ca15e7ffd93f3a8dc46d63d339`.
- OpenAPI byte length: `386197`.
- OpenAPI SHA-256: `0cded4547ac93d617517419233f08f134eb002dae111534e5c02031803e35721`.
- Probe SHA-256: `ebb2ca1ea48a0c86d31bce5746fd30a6913bd4f7ed54fe9928dad69fd8d50b6a`.
- Retained evidence SHA-256: `a5641094f970884067aed3cf191cc40670420448ba938053f5ee056c02cc97bd`.
- Checked files: `spikes/opencode-native/probe.mjs`, `evidence-1.17.5.json`, and `verify-evidence.mjs`.

The retained fixture uses stable placeholders for the launcher, native binary, and disposable proof
root. Exact executable identity remains pinned by the launcher/native hashes above.

The verifier pins the full evidence bytes and exact probe bytes. It also checks the selected OpenAPI schemas for session creation metadata, caller `messageID`, `noReply`, the global pending-permission list, and the nondeprecated permission-reply request shape. The fixture observes an empty pending list but does not create or answer a permission request.

## Isolation

The probe re-executed inside an unprivileged private network namespace with only loopback and no default route. It used fresh empty `HOME`, XDG, temporary, and workspace directories and a fixed child-environment allowlist with no inherited provider credential variables. Six proxy-aware startup attempts reached a loopback deny server and were closed; their targets and protocols were not retained. The fixture does not prove mount/filesystem isolation from absolute ambient host paths.

The exact retained run is host-specific. The package does not install OpenCode, and live regeneration fails unless the host resolves the same pinned launcher and native binary bytes.

## Verification

Verify the checked evidence without starting OpenCode:

```bash
pnpm --filter @remote-claw/opencode-native-proof run check
pnpm --filter @remote-claw/opencode-native-proof run test:run
```

On a matching Linux host, produce fresh evidence on standard output:

```bash
node spikes/opencode-native/probe.mjs
```

## Missing positive release fixture

A2 remains non-writable until a separate checked-in fixture proves at least one exact positive
`user_text` path end to end. That fixture must:

1. enter through a real remote source and the common server-wide adjudicator;
2. retain the exact signed admitted-result tuple, matching decision/executor evidence, current signed
   OpenCode capability snapshot, translator input/output, generated caller `msg_*`, request bytes, and
   one-time front-door dispatch;
3. send exactly one selected `POST /session/{ses_*}/prompt_async` with empty query, the two selected
   semantic headers, one strict-JSON text part, and no `model` or `noReply`;
4. run the model path through the private provider façade while a real supervised OpenCode TUI shares
   the same native session;
5. prove application and applied order from one complete, linearly proved native history snapshot
   joined to the exact message/part IDs and fingerprint, not from `204`, text matching, or SSE alone;
   and
6. crash and recover around adjudication, dispatch, receipt, and observation without a second native
   send.

The release fixture also needs the companion exact `new_chat` request: empty query, the same two
semantic headers, no title or extra metadata, both generated marker and intent-digest fields, and
marker/intent survival in response, discovery, and a real native-server restart. No such retained
fixture exists in this repository today.

## What remains unproved

This fixture does not establish:

- common remote-source normalization/order, signed-result admission, exact-result-tuple authorization,
  signed capability/translator evidence, or one-time native dispatch;
- real OpenCode TUI plus remote-claw adapter coexistence, multi-writer order, or source attribution;
- a complete callable TUI/adapter/observer/creation front-door manifest, exact-process TUI authority,
  or spawned-tool denial of the raw private OpenCode listener;
- one-adapter lease enforcement, old in-flight request takeover, wrapper restart, or native-server recovery;
- `POST /session` idempotency behavior, arbitrary or typed-intent metadata, or marker durability across restart;
- model-bearing, concurrent, TUI-origin, reconnect, or cross-incarnation caller-message-ID behavior;
- a pre-dispatch runtime-owner-signed native-store open/read anchor or an exclusive no-reset/no-fork
  store handoff across native incarnations;
- runtime permission replies, `permission.replied` terminality, child permission inheritance, or TUI/remote permission races;
- abort, compaction, question, or other control causality;
- v2 `/api/event` sequence scope, replay, gap detection, subscribe/snapshot linearization, status
  convergence, or long-running SSE behavior;
- the provider façade, inference-request recovery, exact-process provider fence, official clients, or
  network/mount isolation for the eventual product runtime; or
- the exact selected requests for writable server-scoped `{new_chat}` and binding-scoped
  `{user_text}`, including empty query, canonical directory header, strict JSON without `model` or
  `noReply`, complete front-door/TUI/provider-façade coexistence, observer linearization, recovery, and
  isolation.

Those are explicit release gates in the [OpenCode driver design](opencode-driver.md) and [host-runtime test plan](test-plan.md). The safe conclusion from this proof is deliberately small: persist a caller `msg_*` before one send and use exact native read-back as positive evidence, but never blindly resend after an ambiguous result; use the tested creation marker for correlation only after the selected typed metadata shape and recovery behavior are separately proved.
