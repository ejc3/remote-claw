# OpenCode native protocol proof

This package retains a model-free runtime proof against the pinned OpenCode 1.17.5 native server.

Run the retained-evidence verifier with:

```bash
pnpm --filter @remote-claw/opencode-native-proof test:run
```

The retained run is deliberately host-specific: Linux arm64, Node 22.23.1, and the absolute launcher and native-binary paths and hashes recorded in the evidence. The package does not install OpenCode. A fresh run only works on a host where `opencode`, `unshare`, and `ip` are available and `opencode` resolves to those exact pinned 1.17.5 launcher and native bytes; the probe fails closed otherwise. On that captured host, write fresh JSON to standard output with:

```bash
node spikes/opencode-native/probe.mjs
```

`verify-evidence.mjs` pins both the retained JSON bytes and the exact `probe.mjs` bytes. Intentionally replacing either artifact therefore also requires reviewing the new run and updating its corresponding expected hash.

The probe starts the pinned native executable inside a private network namespace containing only loopback and no default route. It supplies fresh empty `HOME` and XDG directories, constructs the child environment from a fixed allowlist with no provider credentials, and routes proxy-aware connection attempts to a local deny server.

The proof creates exactly one session with a fixture-specific `metadata.remoteClawCreationId`, confirms that this exact marker is returned and listable on exactly one `ses_*`, and never retries session creation. It subscribes to native SSE, sends `prompt_async` twice with the same caller-supplied `messageID`, `noReply: true`, and a fixed text part, and retains the complete decoded event sequence observed from connection through native deletion plus both exact history snapshots. Across that complete sequence it requires exactly one connection, creation, and deletion event and exactly two caller-ID message and part events; the selected records must occur in order and match native history. In this one OpenCode 1.17.5 process incarnation, resending that same ID with `noReply: true` is not idempotent: the one user message keeps the caller ID and gains a second, distinct text part.

The retained OpenAPI hash and selected schema assertions show that session creation currently declares `metadata` as an object and cover caller-supplied `messageID`, `noReply`, pending-permission listing, and the current permission-reply request shape. Runtime metadata behavior is exercised only for the exact marker above. Runtime permission creation and reply behavior are not exercised because this model-free fixture creates no permission request.

The prompt requests no model reply, and the probe supplies no provider credential through the child environment or fresh `HOME`/XDG trees. This fixture therefore does not exercise provider inference. OpenCode can still make unrelated startup connection attempts; the private namespace prevents external routing and the local deny server closes proxy-aware attempts. Their targets and protocols are not retained, so the fixture does not classify them.

## Scope boundary

This is a narrow native-protocol fact proof, not an OpenCode driver adjudication, coexistence, or parity proof. It does not prove:

- concurrent driving by a real OpenCode TUI and a remote-claw adapter, or any multi-writer ordering;
- leases, takeover, an in-flight handoff barrier, or crash recovery;
- runtime permission-request races, replies, or terminal permission state;
- arbitrary metadata-field semantics or idempotency of session-creation POSTs;
- control-event handling or source attribution;
- durability of `remoteClawCreationId` across a native-server restart;
- same-ID prompt behavior with model replies or across a native-server restart;
- SSE reconnect, replay, gap detection, status convergence, or long-running stream behavior; or
- mount/filesystem isolation, including whether the child could read an absolute ambient host path outside the fresh homes.
