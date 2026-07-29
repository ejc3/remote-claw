# OpenCode native protocol proof

**Status:** evidence captured 2026-07-29; this is a narrow model-free proof for one pinned OpenCode build, not a TUI-coexistence or shared-writer adjudication proof.

## Result

One isolated OpenCode `1.17.5` native server began with an empty session list. The probe issued exactly one `POST /session` with `metadata.remoteClawCreationId = "rcc_remote_claw_opencode_native_proof_001"`. The response and the next session listing contained exactly one matching `ses_*` with that marker.

The probe then sent `prompt_async` with caller-supplied `messageID = "msg_remoteclaw_native_proof_001"`, `noReply:true`, and one fixed text part. The `204` response had an empty body. Native history and legacy `/event` SSE both carried that exact message ID and one exact native part.

Sending the same request a second time returned another empty `204`. It did not deduplicate the request: the same native user message kept the caller ID and gained a second distinct part with the same text. In this exact no-model, `noReply:true`, one-server-incarnation case, the caller ID is a positive correlation seam but not an idempotency key.

The retained 58-event decoded SSE sequence contains exactly one selected connection, session-create, and session-delete event and exactly two selected message and part updates for the caller ID, in order and cross-checked against both history snapshots. The fixture requested no assistant reply and observed no assistant event for the session.

The probe deleted the native session, required session/history reads to return the pinned not-found shape, required the session list to become empty, disposed the server, and verified process-group exit, closed loopback socket and SSE/proxy resources, and removal of its temporary root.

## Version and evidence pin

- OpenCode version: `1.17.5`.
- Platform: Linux `arm64`; Node `v22.23.1`.
- Launcher SHA-256: `d167e30e12cca32cc4a5da0003ee0deb1120b5ca5ee2d64cef23aec44a3c9fa9`.
- Native binary SHA-256: `fe1839ac5c417c5fc4a08dd268465907c3e8c6ca15e7ffd93f3a8dc46d63d339`.
- OpenAPI byte length: `386197`.
- OpenAPI SHA-256: `0cded4547ac93d617517419233f08f134eb002dae111534e5c02031803e35721`.
- Probe SHA-256: `f7bbbecfa7ea7c28eedb4dc7836972f63fdaa03c996a18b9982aa1f0782a2939`.
- Retained evidence SHA-256: `521558490f9bb0c759deb10b2aa0e849f230fae8193aec3a7073607f5864afe6`.
- Checked files: `spikes/opencode-native/probe.mjs`, `evidence-1.17.5.json`, and `verify-evidence.mjs`.

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

## What remains unproved

This fixture does not establish:

- real OpenCode TUI plus remote-claw adapter coexistence, multi-writer order, or source attribution;
- one-adapter lease enforcement, old in-flight request takeover, wrapper restart, or native-server recovery;
- `POST /session` idempotency behavior, arbitrary or typed-intent metadata, or marker durability across restart;
- model-bearing, concurrent, TUI-origin, reconnect, or cross-incarnation caller-message-ID behavior;
- runtime permission replies, `permission.replied` terminality, child permission inheritance, or TUI/remote permission races;
- abort, compaction, question, or other control causality;
- v2 `/api/event` sequence scope, replay, gap detection, status convergence, or long-running SSE behavior; or
- provider façade behavior, provider inference, official clients, or network/mount isolation for the eventual product runtime.

Those are explicit release gates in the [OpenCode driver design](opencode-driver.md) and [host-runtime test plan](test-plan.md). The safe conclusion from this proof is deliberately small: persist a caller `msg_*` before one send and use exact native read-back as positive evidence, but never blindly resend after an ambiguous result; use the tested creation marker for correlation only after the selected typed metadata shape and recovery behavior are separately proved.
