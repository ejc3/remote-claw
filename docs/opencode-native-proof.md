# OpenCode native protocol proof

**Status:** protocol evidence captured 2026-07-29; the executable manifest evidence is separately
retained without a capture timestamp. These are narrow compatibility and release-audit facts for one
pinned OpenCode build, not runtime authority. Durable A1/OpenCode is optional parked multi-engine work,
not an active outcome or blocker for the [Claude 1.0 finish line](release-finish-line.md). If that work
is explicitly resumed, it may use this fixture as a regression oracle, but no activation, admission,
dispatch, or gate reconstructs a local capability/evidence tree from it.

## Result

One isolated OpenCode `1.17.5` native server began with an empty session list. The probe issued exactly one `POST /session` with `metadata.remoteClawCreationId = "rcc_remote_claw_opencode_native_proof_001"`. The response and the next session listing contained exactly one matching `ses_*` with that marker.

The probe then sent `prompt_async` with caller-supplied `messageID = "msg_remoteclaw_native_proof_001"`, `noReply:true`, and one fixed text part. The `204` response had an empty body. Native history and legacy `/event` SSE both carried that exact message ID and one exact native part.

Sending the same request a second time returned another empty `204`. It did not deduplicate the request: the same native user message kept the caller ID and gained a second distinct part with the same text. In this exact no-model, `noReply:true`, one-server-incarnation case, the caller ID is a positive correlation seam but not an idempotency key.

The retained 58-event decoded SSE sequence contains exactly one selected connection, session-create, and session-delete event and exactly two selected message and part updates for the caller ID, in order and cross-checked against both history snapshots. The fixture requested no assistant reply and observed no assistant event for the session.

The probe deleted the native session, required session/history reads to return the pinned not-found shape, required the session list to become empty, disposed the server, and verified process-group exit, closed loopback socket and SSE/proxy resources, and removal of its temporary root.

## Executable-content addendum

The same pinned release also has a retained native-executable manifest. A separate probe
opened the real Linux arm64 native binary once with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, required a
nonempty executable regular file, performed two complete positional reads plus EOF checks on that
one descriptor, and required stable device, inode, mode, link count, size, modification time, and
change time. It read but did not execute the binary, started no server, used no network or provider
credential, and retained no raw executable or chunk bytes.

The resulting manifest covers 156,412,048 bytes in 150 domain-separated 1 MiB chunks, with a
174,224-byte final chunk. Historical generic collection also has temporary-file coverage for a
front-door role, but this retained proof closes only `listener.native_executable`; it does not observe
or provenance-bind an actual front door, pathname, running process, executable mapping, currentness,
complete parent, or authority.

## Relationship to the optional A1 design

Neither retained request is the exact optional A1 `user_text` wire request.

The creation probe used a `directory` query, a `title`, and metadata containing only
`remoteClawCreationId`. The optional design must either attach an exact existing session or durably
write ahead and reconcile one local creation before advertisement; this probe proves neither lifecycle
or binding transaction. Remote `new_chat` and generalized session creation remain further optional
scope, and the retained marker creates no authority for either path.

The prompt probe sent caller `messageID`, `noReply:true`, and one text part. It did not send a `model`
field, and its code did not set `x-opencode-directory` on that request. Native history recorded
OpenCode-selected model metadata, but that is not a caller-supplied model field. The optional design forbids
both `model` and `noReply` and requires exactly:

```json
{"messageID":"<nativeActionId>","parts":[{"type":"text","text":"<text>"}]}
```

That request must be `POST /session/{nativeConversationId}/prompt_async` with empty query and the exact
semantic header vector `content-type: application/json`, then
`x-opencode-directory: <canonical directory>`. Its JSON must use the selected strict byte-level
encoder. The current compatibility driver is different again: it sends `{model, parts}` and no caller
`messageID`.

This fixture also bypasses the common remote-claw command path. It contains no signed admitted
`CollaborationCommandResultRecord`, command-keyed execution/start transaction, current binding
activation, deterministic local-provider response, exact session-plus-history observer, durable
host-output ledger, sealed outbox, browser delivery, or credential-isolated connector. Its history/SSE
checks establish only the narrow caller-ID behavior below.

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

## Optional tests that would still be required

No qualifying durable A1 `user_text` fixture exists in this repository today. That absence does not
block Claude 1.0; it blocks only a future decision to advertise the optional OpenCode capability.

If resumed, a safe local-provider fixture must be user-runnable and retain one complete positive path:

1. a real browser sends an encrypted command through the real A1 broker and common adjudicator;
2. the current schema-v6 terminal root is revalidated, and a fully signed admitted result creates one
   execution row keyed by `commandId`;
3. the start-before-byte transaction selects one current binding activation and sends exactly one
   `POST /session/{ses_*}/prompt_async` with empty query, the two selected semantic headers, one
   strict-JSON text part, and no `model` or `noReply`;
4. the owned private listener and mediated real TUI run inside the production containment topology;
   before a deterministic credentialless local connector may send an inference request, a separate
   provider-request row is written ahead and started once, with no resend after ambiguity;
5. a strict session read proves the exact `ses_*`, directory, and OpenCode version, and a complete unfiltered post-send
   history read proves exactly one matching `msg_*` user message and one exact index-zero text part;
6. assistant output is attributed only when `assistant.parentID` equals the exact caller `msg_*`,
   including with a concurrent TUI turn; one transaction then consumes the observation, writes terminal
   completion or quarantine, and inserts the matching output intent;
7. the signed outcome and exact native output enter a durable host-output ledger, are sealed and
   published through the broker outbox, and render in that browser; and
8. negative cases prove empty and all U+002F-leading text, unsupported families, plaintext broker
   storage, hostile-child access to protected local peers or ambient paths, external egress, and
   connector credentials fail closed before native work.

The optional fixture must cover both an exact existing-session attachment and durable write-ahead
session-creation reconciliation; neither may adopt “most recent” or resend an ambiguous create. A later
credentialed gate would rerun the same topology through the ordinary daemon and a persistent selected
workspace, add exhaustive recovery at every start/read-back/ledger/publish and lifecycle boundary, and
keep real connector credentials and external sockets outside the OpenCode/tool boundary. These are
OpenCode-only gates, not active project-release gates.

Native `new_chat`, generic HTTP/TUI front doors, and broader adapter or mutation families remain further
optional scope. Native-attempt IDs remain historical/dormant and authorize no capability.

## What remains unproved

This fixture does not establish:

- common remote-source normalization/order, signed-result admission, exact-result-tuple authorization,
  command-keyed execution, or one-use start-before-byte dispatch;
- mediated native-TUI/remote-claw multi-writer order or source attribution;
- a complete production typed-adapter/TUI/observer runtime and hostile-child denial of the raw private
  OpenCode listener;
- binding-activation enforcement, old in-flight request takeover, wrapper restart, or native-server recovery;
- `POST /session` idempotency behavior, arbitrary or typed-intent metadata, or marker durability across restart;
- model-bearing, concurrent, TUI-origin, reconnect, or cross-incarnation caller-message-ID behavior;
- A2 cross-incarnation session/store continuity;
- runtime permission replies, `permission.replied` terminality, child permission inheritance, or TUI/remote permission races;
- abort, compaction, question, or other control causality;
- v2 `/api/event` sequence scope, replay, gap detection, subscribe/snapshot linearization, status
  convergence, or long-running SSE behavior;
- the credentialless alpha provider path, host-output ledger, sealing/outbox publication, browser
  rendering, credentialed provider façade, inference-request recovery, exact-process provider fence,
  official clients, or network/mount isolation for the eventual product runtime; or
- the exact selected request for writable binding-scoped `{user_text}`, including empty query,
  canonical directory header, strict JSON without `model` or `noReply`, complete
  adapter/mediated-TUI/local-provider path, strict session-plus-history read-back, output publication, recovery, and
  isolation. Remote session creation and generic front doors remain separate optional capabilities.

Those are optional gates in the [OpenCode driver design](opencode-driver.md) and
[host-runtime test plan](test-plan.md), not Claude 1.0 release gates. The safe conclusion from this
proof is deliberately small:
persist a unique caller `msg_*` before one send and use strict native read-back as positive evidence,
but never blindly resend after an ambiguous result. The tested creation marker remains protocol
research and does not authorize remote `new_chat`.
