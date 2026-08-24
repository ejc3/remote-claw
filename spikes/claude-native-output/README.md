# Claude native-output observations

These sanitized JSON records preserve two narrow observations from Claude Code 2.1.237 on Linux
arm64. They are historical research, not a release gate or current-version compatibility claim.

- Thirty first arrivals covered all eight observed worker-event types: `assistant`,
  `control_cancel_request`, `control_request`, `control_response`, `rate_limit_event`, `result`,
  `system`, and `user`. Each carried a distinct RFC 4122 UUIDv4 `payload.uuid`.
- In one four-event `system`/`assistant`/`assistant`/`result` batch, the upstream HTTP 200 was fully
  buffered while the local downstream response was destroyed before headers or writable bytes. Claude
  then retried the exact request on the same RC session path: request length and digest, ordered event
  types, UUID aliases, payload digests, and worker-epoch alias matched.

The records do not prove Anthropic-side application or deduplication, deterministic retry, retry for
every event type, cross-process recovery, or compatibility across versions and platforms. Hashes in
the retained JSON are capture metadata only; no source-, binary-, tool-, or receipt-hash verifier is
maintained. The deleted one-off capture tooling remains available in Git history if a future protocol
change justifies a fresh, purpose-built recapture.
