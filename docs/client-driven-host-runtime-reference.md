# Host-runtime reference map

The generalized A1 host runtime was retired and its unused implementation removed on 2026-08-24.
Git history is the archive; the repository no longer carries a parallel 18,000-line design copy.

Use these current sources:

- [Product goal and release gates](release-finish-line.md) for the outcome and gate policy.
- [Architecture](v2-architecture.md) for the as-built encrypted broker and current drivers.
- [Protocol](protocol.md) for current wire and mutation behavior.
- [Native RC coexistence scoping](native-rc-passthrough-scoping.md) for the selected thin
  provider-native experiment.
- [Retired host-runtime decision](client-driven-host-runtime.md) for why the generalized coordinator
  was removed.

The exact OpenCode M2 text/interrupt tuple and exact Codex M3a app-server text/status tuple are
supported. Other OpenCode/Codex tuples are unsupported; only OpenCode's positive permission-mirroring
opt-in and the tmux adapter retain experimental guarantees. Codex/ChatGPT Remote coexistence remains
M3b. See the current architecture and driver documents for each exact boundary.
