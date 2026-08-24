# Codex app-server multi-client observations

The three sanitized Codex 0.146.0 JSON records are historical protocol research. They are not a
current-version gate or acceptance test. The source audit, interpretation, and limitations live in
[Codex app-server multi-client observations](../../docs/codex-app-server-multiclient-proof.md).

They preserve these forward-useful facts:

- Two initialized clients shared one materialized thread and received matching selected command-event
  projections after the second client resumed the exact thread ID.
- A late, unsubscribed client could mutate a live thread but received no correlated detailed events:
  subscription was not write authority.
- A real Codex TUI and a raw client coexisted bidirectionally on one app-server thread.
- A host observer resumed two independently created threads and observed both while each non-owner
  remained unsubscribed.
- An empty thread could not be resumed until materialized, and Codex 0.146.0 exposed no server-issued
  connection ID in the observed app-server messages.

No probe executable, binary/source hash verifier, or offline proof command is maintained. A future
Codex adapter should receive a thin acceptance test against its supported version; Git history remains
the archive for the deleted one-off probes.
