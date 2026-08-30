# OpenCode A1 vertical slice: retired proposal

**Status (2026-08-24): this design is retired and not implemented.** The proposal depended on
the removed generalized host runtime, A1 broker, command ledger, signing hierarchy, and isolation
evidence stack. None of those components handled a command in the shipped product.

The current pinned OpenCode driver remains process-local and does not use this retired design. Its M2
release path attaches only to one explicitly named existing session, leaves permission policy untouched
by default, relays through the current encrypted broker, and creates a fresh projection on companion
restart. It does not gain durable A1 authority, signing, or stable same-row identity from this retired
document.

OpenCode remains an intended product surface, and its pinned M2 text/interrupt vertical is complete.
Later capability work must not restore the deleted platform foundations merely because they once
existed. Current evidence and sequencing live in
[Product goal and release gates](release-finish-line.md).
