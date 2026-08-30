# OpenCode A1 vertical slice: retired proposal

**Status (2026-08-24): this design is retired and not implemented.** The proposal depended on
the removed generalized host runtime, A1 broker, command ledger, signing hierarchy, and isolation
evidence stack. None of those components handled a command in the shipped product.

The existing OpenCode driver remains a process-local experimental compatibility path. It discovers or
creates an exact session, mirrors permissions when configured, relays through the current encrypted
broker, and fails closed on ambiguous selection or unsupported responses. It does not gain durable A1
authority, recovery, signing, or isolation claims from this retired document.

OpenCode remains an intended product surface. Its next work begins with a user-visible vertical and
its actual threat boundary; it must not restore the deleted platform foundations merely because they
once existed. Current M1 evidence and sequencing live in
[Product goal and release gates](release-finish-line.md).
