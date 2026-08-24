# Claude native-output retained proof

This package retains the Linux arm64 Claude Code 2.1.237 compatibility evidence required by the
[Claude 1.0 finish line](../../docs/release-finish-line.md). Its retained witnesses establish two
bounded facts:

- 30 first arrivals across all eight observed worker-event types carried distinct RFC 4122 UUIDv4
  `payload.uuid` coordinates; and
- after an upstream HTTP 200 for one four-event `system`/`assistant`/`assistant`/`result` batch was
  fully buffered, one matching local response withheld before headers or writable bytes was followed
  by an exact retry on the same RC session path. The retained attempts match request length/SHA-256,
  ordered types, UUID aliases, payload hashes, and a present worker-epoch alias.

It does not prove cross-version or cross-platform compatibility, Claude process identity,
Anthropic-side application/dedup, native application, a specific question/permission subtype, or
recovery across process death. It also does not prove deterministic retry or retry behavior separately
for each event type; the four types in the retried batch are incidental to this one request-level
observation. The coverage artifact's `proofScope` records the operator-driven
scenario, but the release gate relies only on its event-type witnesses; it does not advertise a
question/tool family. The retry artifact's `proofScope` uses “accepted” only as legacy shorthand for
HTTP 200, not proved server-side application. Raw request/response bodies remain memory-only. The
retained JSON contains only fixed metadata, counts, booleans, hashes, stable aliases, top-level key
names, sizes, statuses, and placeholders.

Run the offline gate with:

```bash
pnpm --filter @remote-claw/claude-native-output-proof test:run
```

`probe.mjs` is a Node preload for the existing `--rc-trace` path, not a shipped CLI flag. A live
recapture requires the authenticated exact Claude binary on `PATH`, a fresh Remote Control session,
and a PTY. The probe rejects `RC_CLAUDE_BIN`, pins the PATH-resolved executable/package, source commit,
and directly observed remote-claw runtime sources, writes only a new owner-only file, and keeps raw
bodies in memory. The offline verifier checks those source hashes against the exact Git blobs at the
captured commit rather than conflating historical provenance with current whole-file equality; it
fails closed when that commit is absent from repository history. The same gate runs the current
argument, launch, and real-TLS trace-route contract tests, including the fully-buffered
HTTP-200/reset boundary used by this proof. A supported Claude version/platform change, a changed
proof claim or fault model, or a concrete contradiction requires a live recapture; an unrelated
relay-only implementation change does not.

From the repository root, create one new owner-only output directory, then run each leg from the CLI
package in a real terminal. Keep `RC_LOG=info`; body-trace logging would defeat the retained-artifact
sanitization boundary.

```bash
proof_root=$PWD
proof_output_dir=$(mktemp -d)
chmod 700 "$proof_output_dir"
cd packages/cli

env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID \
  -u RC_CLAUDE_BIN -u NODE_OPTIONS \
  RC_NATIVE_OUTPUT_PROOF="$proof_output_dir/coverage.json" \
  RC_NATIVE_OUTPUT_MATCH_TYPE=__no_fault__ RC_LOG=info \
  node --import="$proof_root/spikes/claude-native-output/probe.mjs" \
  --import=tsx src/cli.ts --rc-trace --remote-control --model haiku

env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID \
  -u RC_CLAUDE_BIN -u NODE_OPTIONS \
  RC_NATIVE_OUTPUT_PROOF="$proof_output_dir/retry.json" \
  RC_NATIVE_OUTPUT_MATCH_TYPE=assistant RC_LOG=info \
  node --import="$proof_root/spikes/claude-native-output/probe.mjs" \
  --import=tsx src/cli.ts --rc-trace --remote-control --model haiku
```

For coverage, drive a short text turn that yields the eight event types; the captured run used an
`AskUserQuestion` interaction only to obtain control-type coverage. For retry, drive one short text
reply and wait for both probe notices before exiting normally. Review the sanitized files, run the
same witness derivations manually, and only then replace retained evidence, update pinned hashes, and
run the offline verifier. Never overwrite the retained artifacts during capture.

The preload deliberately preserves Node's overloaded `https.request` arguments. Its synchronous reset
guard requires the matching downstream worker-events request, `headersSent === false`, and zero
writable bytes before destruction. The local Biome configuration disables only the two style
suggestions and the `finally` warning that conflict with those fail-closed probe mechanics; retained
evidence is excluded from formatting so its exact live-produced bytes remain pinned.
