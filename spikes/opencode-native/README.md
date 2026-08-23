# OpenCode native protocol proof

**Project status:** retained optional OpenCode audit evidence. Durable OpenCode/A1 is parked
multi-engine platform work, not the next tranche or a blocker for the active
[Claude 1.0 finish line](../../docs/release-finish-line.md). This package remains useful because its
narrow facts and negative boundaries do not depend on that roadmap decision.

This package retains two narrow proofs against the pinned OpenCode 1.17.5 Linux arm64 release: a
model-free native-server protocol run and a two-pass executable-content manifest of the real native
binary. The executable proof reads but does not execute the binary and retains no raw chunk bytes.

Run the retained-evidence verifier with:

```bash
pnpm --filter @remote-claw/opencode-native-proof test:run
```

The retained runs pin Linux arm64 and the exact launcher/native-binary hashes recorded in the
evidence; the protocol proof additionally pins Node 22.23.1. Emitted paths use stable placeholders
because the install location is not part of either proof. The package does not install OpenCode. A
fresh protocol run requires `opencode`, `unshare`, and `ip`; executable regeneration requires the
same pinned `opencode` launcher/native bytes. Both probes fail closed on a mismatch. On a matching
host, write fresh JSON to standard output with:

```bash
node spikes/opencode-native/probe.mjs
node spikes/opencode-native/executable-manifest-probe.mjs
```

The package aliases are `pnpm --filter @remote-claw/opencode-native-proof proof` and
`pnpm --filter @remote-claw/opencode-native-proof proof:executable`. `verify-evidence.mjs` and
`verify-executable-manifest.mjs` pin both retained JSON files and both exact probe programs.
Intentionally replacing any artifact therefore requires reviewing the new run and updating its
corresponding expected hash.

The probe starts the pinned native executable inside a private network namespace containing only loopback and no default route. It supplies fresh empty `HOME` and XDG directories, constructs the child environment from a fixed allowlist with no provider credentials, and routes proxy-aware connection attempts to a local deny server.

The proof creates exactly one session with a fixture-specific `metadata.remoteClawCreationId`, confirms that this exact marker is returned and listable on exactly one `ses_*`, and never retries session creation. It subscribes to native SSE, sends `prompt_async` twice with the same caller-supplied `messageID`, `noReply: true`, and a fixed text part, and retains the complete decoded event sequence observed from connection through native deletion plus both exact history snapshots. Across that complete sequence it requires exactly one connection, creation, and deletion event and exactly two caller-ID message and part events; the selected records must occur in order and match native history. In this one OpenCode 1.17.5 process incarnation, resending that same ID with `noReply: true` is not idempotent: the one user message keeps the caller ID and gains a second, distinct text part.

The retained OpenAPI hash and selected schema assertions show that session creation currently declares `metadata` as an object and cover caller-supplied `messageID`, `noReply`, pending-permission listing, and the current permission-reply request shape. Runtime metadata behavior is exercised only for the exact marker above. Runtime permission creation and reply behavior are not exercised because this model-free fixture creates no permission request.

The prompt requests no model reply, and the probe supplies no provider credential through the child environment or fresh `HOME`/XDG trees. This fixture therefore does not exercise provider inference. OpenCode can still make unrelated startup connection attempts; the private namespace prevents external routing and the local deny server closes proxy-aware attempts. Their targets and protocols are not retained, so the fixture does not classify them.

## Protocol-fixture scope boundary

This is a narrow native-protocol fact proof, not an OpenCode driver adjudication, coexistence, or parity proof. It does not prove:

- concurrent driving by a real OpenCode TUI and a remote-claw adapter, or any multi-writer ordering;
- a complete callable TUI/adapter/observer/creation front-door manifest, exact-process TUI authority,
  or spawned-tool denial of the raw private OpenCode listener;
- leases, takeover, an in-flight handoff barrier, or crash recovery;
- the implemented schema-v6 terminal-root authority being revalidated by any later activation;
- attachment to one exact existing session or durable write-ahead/reconciliation of one session
  creation after a lost response;
- runtime permission-request races, replies, or terminal permission state;
- arbitrary metadata-field semantics or idempotency of session-creation POSTs;
- control-event handling or source attribution;
- durability of `remoteClawCreationId` across a native-server restart;
- same-ID prompt behavior with model replies or across a native-server restart;
- SSE reconnect, replay, gap detection, subscribe/snapshot linearization, status convergence, or
  long-running stream behavior;
- provider-façade behavior, write-ahead/start-once inference requests, no resend after ambiguous
  connector delivery, or the exact-process provider/network fence;
- causal assistant attribution through exact `assistant.parentID` during a concurrent TUI turn;
- one atomic observation-to-terminal-or-quarantine transition with its matching output intent;
- the optional binding-scoped `{user_text}` design, or any later server-scoped `{new_chat}` design; or
- mount/filesystem isolation, including whether the child could read an absolute ambient host path outside the fresh homes.

## Executable-fixture scope boundary

The executable proof establishes two stable complete reads of one opened native-binary descriptor
and the exact retained content manifest. `O_NOFOLLOW` applies only to the opened final component, and
the fixture does not prove a pathname, all-component symlink policy, running process, executable
mapping, actual front door or its provenance, currentness, complete parent, authority, or production
capability. The offline verifier reconstructs retained descriptor/vector/manifest bytes and digests;
only live regeneration on the matching pinned binary can recompute chunk digests from raw bytes.
