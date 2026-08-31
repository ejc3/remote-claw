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

The exact OpenCode M2 text/interrupt tuple and exact Codex 0.151.0/Linux arm64 M3a app-server
text/status tuple are supported. OpenCode now also advertises implemented read-only MAIN running/idle
status; its separate real-TUI/two-browser status acceptance passed on 2026-08-31 without rewriting M2.
M3b also proved same-thread ChatGPT Remote text coexistence through
the managed Unix socket and continued browser turns after provider-transport disconnect. It did not
prove per-device Remote unsubscribe, Codex companion restart/backfill, broker-loss acceptance, richer
controls/content, or another version/platform. Other OpenCode/Codex tuples are unsupported; only
OpenCode's positive permission-mirroring opt-in retains experimental guarantees. The tmux adapter
is maintained for its exact M4 tuple: ordinary non-empty non-slash text plus attachments are fenced
behind an active model turn and its native permission/question modal, every raw browser control is
disabled, and permissions/questions stay in Claude's native/local pane unless resolved caller policy
explicitly bypasses them. The idle editor and slash/config UI share one keystream and must not be
manipulated while remote viewers may submit. It retains lower-fidelity ordering and delivery
limits, not an experimental permission guarantee. A fresh lazy transcript may
publish explicit unknown posture while text remains enabled; the viewer says the mode is being
confirmed until the current SessionStart mode or timestamped matching-session evidence written after
the current transcript attach updates presence, including later local mode changes; every attached
backfill is ignored; rotation clears the current announce's mode and republishes without one, restoring
`unknown`. Pane-bound text/captions also reject C0/C1
terminal controls other than TAB/LF at the viewer and relay and again before tmux. A fixed helper and
Claude's synchronous hooks share a startup-probed Linux `flock`; prompt-hook failure blocks with status
`2`, SessionEnd retires the projection while preserving the pane, and no global Enter binding, TUI
parser, settings parser, or permission hook is added.
See the current architecture and driver documents for each exact boundary.
