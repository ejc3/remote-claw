# Durability boundary

**Current status (2026-08-24): broker-durable, host-session fail-stop.** The supported deployed
SQLite/libSQL broker durably retains encrypted remote-claw frames and replay cursors. The host does not
maintain a second generalized command database or a durable synthetic-Claude protocol server.

If the wrapper or native session dies, remote-claw ends that projection, reports that the tail may be
incomplete, and does not replay uncertain commands into a replacement session. This is the deliberate
safe behavior today.

## What is durable

- encrypted broker frames and their backend ordering/deduplication state;
- the local machine identity secret;
- provider-native history available from Anthropic for the selected coexistence experiment; and
- native application state owned by Claude Code itself.

## What is not durable

- an adapter-local generalized command ledger;
- private RC worker epochs and unacknowledged synthetic-server delivery state across wrapper death;
- a remote-claw logical chat that can transparently take over another native session; or
- automatic resend authority after an ambiguous provider or broker write.

## Recovery rule

Reconnect by reading the authoritative history available from the active transport, reconciling
stable event identities, and continuing only from an unambiguous boundary. Never infer that transport
receipt means native execution, and never turn an unknown outcome into a new logical command.

A more elaborate host log is warranted only after a concrete required recovery case cannot be solved
from broker and provider-native history. Such a change must name the lost state, its authority, its
atomic boundary, and one crash test. The retired generalized runtime is not the default answer.
