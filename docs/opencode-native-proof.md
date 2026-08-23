# OpenCode native protocol proof

**Status:** protocol evidence captured 2026-07-29; the executable manifest evidence is separately
retained without a capture timestamp. These are narrow facts for one pinned OpenCode build, not proof
of the selected A2 request, TUI coexistence, or shared-writer adjudication. A1.8a1-E1b3's design now
selects these pinned `/doc` length/hash and native-executable facts as inputs, but E1b3 remains
unimplemented: this fixture does not retain the raw `/doc` body, build or observe the dormant front
door, close the listener parent, or prove process/socket/currentness or authority.

## Result

One isolated OpenCode `1.17.5` native server began with an empty session list. The probe issued exactly one `POST /session` with `metadata.remoteClawCreationId = "rcc_remote_claw_opencode_native_proof_001"`. The response and the next session listing contained exactly one matching `ses_*` with that marker.

The probe then sent `prompt_async` with caller-supplied `messageID = "msg_remoteclaw_native_proof_001"`, `noReply:true`, and one fixed text part. The `204` response had an empty body. Native history and legacy `/event` SSE both carried that exact message ID and one exact native part.

Sending the same request a second time returned another empty `204`. It did not deduplicate the request: the same native user message kept the caller ID and gained a second distinct part with the same text. In this exact no-model, `noReply:true`, one-server-incarnation case, the caller ID is a positive correlation seam but not an idempotency key.

The retained 58-event decoded SSE sequence contains exactly one selected connection, session-create, and session-delete event and exactly two selected message and part updates for the caller ID, in order and cross-checked against both history snapshots. The fixture requested no assistant reply and observed no assistant event for the session.

The probe deleted the native session, required session/history reads to return the pinned not-found shape, required the session list to become empty, disposed the server, and verified process-group exit, closed loopback socket and SSE/proxy resources, and removal of its temporary root.

## Executable-content addendum

The same pinned release also has a retained A1.8a1-E1b1 native-executable manifest. A separate probe
opened the real Linux arm64 native binary once with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, required a
nonempty executable regular file, performed two complete positional reads plus EOF checks on that
one descriptor, and required stable device, inode, mode, link count, size, modification time, and
change time. It read but did not execute the binary, started no server, used no network or provider
credential, and retained no raw executable or chunk bytes.

The resulting manifest covers 156,412,048 bytes in 150 domain-separated 1 MiB chunks, with a
174,224-byte final chunk. Generic collection also has temporary-file coverage for the front-door
role, but this retained proof closes only `listener.native_executable`; it does not observe or
provenance-bind an actual front door, pathname, running process, executable mapping, currentness,
complete parent, or authority.

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
- Executable raw SHA-256 (base64url): `_hg5rFxBfF_EoI3SaEZZB8PoxsoV5__ZPzqNxG1j0zk`.
- Executable probe SHA-256: `e9ad440c6ca3e6c1e16bfc8a3225a0a7a0a89540f6a613cb0f31f94fe2febc91`.
- Retained executable evidence SHA-256: `2d72aed48760e320317b94009d90ea290b094f9f6b26796074c421f3e5749901`.
- Executable chunk-vector digest (base64url): `d14lrmnOFib3qvN7y_d0NqAoApcwv8YugDaN_Q1eDOM`.
- Canonical executable manifest: 11,026 bytes; SHA-256 `54dcae0f611f2ebe8e91531c73d475f1e2aaf1ea57304e9e0b5aca1ac03e3af8`.
- Checked files: `spikes/opencode-native/{probe.mjs,evidence-1.17.5.json,verify-evidence.mjs,executable-manifest-probe.mjs,executable-manifest-evidence-1.17.5.json,verify-executable-manifest.mjs}`.

The retained fixture uses stable placeholders for the launcher, native binary, and disposable proof
root. Exact executable identity remains pinned by the launcher/native hashes above.

The two verifiers pin both full evidence files and both exact probe programs. The protocol verifier
also checks the selected OpenAPI schemas for session creation metadata, caller `messageID`,
`noReply`, the global pending-permission list, and the nondeprecated permission-reply request shape.
The fixture observes an empty pending list but does not create or answer a permission request. The
executable verifier independently rebuilds all retained descriptor, vector, and manifest canonical
bytes/digests; because raw binary/chunk bytes are deliberately absent, recomputing chunk digests
requires live regeneration on a matching release host.

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
node spikes/opencode-native/executable-manifest-probe.mjs
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
