# Codex app-server multi-client probe

The evidence, source audit, limitations, and interpretation live in
[Codex app-server multi-client proof](../../docs/codex-app-server-multiclient-proof.md).

Validate the checked-in probe hashes and retained evidence invariants with:

```bash
pnpm --filter @remote-claw/codex-multiclient-proof test:run
```

Run the safe model-free raw-client probe with:

```bash
node spikes/codex-multiclient/probe.mjs
```

The pinned output is `evidence-0.146.0.json`.

Run the contained real-TUI coexistence probe with:

```bash
node spikes/codex-multiclient/real-tui-probe.mjs
```

This second probe launches one real app-server, attaches one raw protocol client and one real `codex resume --remote` TUI to the same native thread, and exchanges only user-shell commands. It requires Linux user and network namespaces, `ip`, and `tmux`. It creates a fixed synthetic ChatGPT-shaped authentication record only inside the temporary contained server home so the TUI can pass local onboarding; it never reads or copies ambient Codex credentials, and verified cleanup removes the synthetic record.

The real-TUI probe has no external route. Connection attempts that reach its local deny proxy are recorded and closed; their targets and protocols are not retained. The probe sends no model prompt or `turn/start`. Its pinned output is `evidence-real-tui-0.146.0.json`.

Run the contained top-level multi-chat attachment probe with:

```bash
node spikes/codex-multiclient/multi-chat-attachment-probe.mjs
```

This third probe uses two direct-client stand-ins, one host observer, and two distinct persistent top-level threads on one app-server. It proves requester-scoped top-level subscriptions before the host joins, then proves that the host can resume and observe both exact native thread IDs without subscribing either non-owning direct client. It is model-free and does not exercise core-created child-agent threads. Its pinned output is `evidence-multi-chat-attachment-0.146.0.json`.

## Residual identity limitation

Codex 0.146.0 does not expose a server-issued connection ID through the app-server messages retained by these fixtures. The evidence therefore pins distinct fixture labels and client names, independent request-ID counters, separately opened WebSocket connections, and the recorder's physical downstream/upstream connection counts. It does not claim to compare native connection IDs that were never observable or retained.
