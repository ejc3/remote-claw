# Product roadmap after the M0 coexistence decision

The full target is Claude Code, Codex, OpenCode, and an honest tmux fallback, each with its local UI
plus multiple remote-claw browsers and with provider-native collaboration preserved where available.
[Product goal and release gates](release-finish-line.md) owns the sequence.

M0 already proved a lower-fidelity version through the tmux adapter, the Anthropic Remote API, and two
remote-claw browsers. The immediate milestone is deliberately narrower than the whole product but
higher fidelity than M0: use the existing host-side native client and a small readiness-gated bridge,
then verify one ordinary Anthropic-hosted session through the local TUI, official Claude app UI, and
two remote-claw browsers. See [native coexistence](native-rc-passthrough-scoping.md).

## Sequencing rule

Each milestone names:

- one user-visible adapter outcome;
- the exact native and security boundaries it changes;
- capability claims that become true;
- a real acceptance scenario; and
- the smallest fault tests needed for ambiguous writes, reconnect, and failure isolation.

Do not require every later surface to block an earlier shippable milestone. Also do not rewrite a
milestone as the entire product or delete working adapter foundations merely because they are not next.

## Planned adapter work

### Claude Code

Finish native coexistence first. Then add permissions, questions, interrupts, modes, slash commands,
and attachments one family at a time. Keep the private replacement relay as a separately labeled mode
for environments that do not need the official client.

### OpenCode

Productize the existing HTTP/SSE adapter: prove real TUI coexistence, close ambiguous-send and
permission races, add durable native binding/recovery, and pin a supported version matrix. Preserve
native collaboration if a selected OpenCode version exposes one.

### Codex

Build from the retained app-server multi-client evidence. Prove one local Codex TUI and multiple
remote-claw browsers on the same native thread, then preserve Codex/ChatGPT Remote through a supported
provider boundary. The current evidence is a seam, not proof of that final topology.

### tmux compatibility

Keep tmux as the fallback when no structured native adapter exists. Improve conservative input states,
transcript attribution, and recovery, but never describe pane paste as independent peer collaboration
or exactly-once native application.

## Inference and accounts

Model routing is orthogonal to agent integration. Anthropic, OpenAI, Bedrock, and later providers need
per-agent compatibility entries and credentialed smokes; they do not need a second collaboration
protocol.

Accountless means no Anthropic account. The current path still needs AWS/Bedrock credentials,
remote-claw identity/pass material, and possibly a protected-deployment bypass. Test and document those
credentials explicitly instead of using “accountless” as “no accounts or credentials anywhere.”

## Shared follow-ups

- Per-viewer roles and revocation, after a concrete authority policy exists.
- Native restart adoption, with exact binding and a duplicate-mutation fault test.
- Push notifications and offline discovery without plaintext payloads.
- Retention/deletion with authenticated ownership and partial-failure handling.
- Shared adapter abstractions only after two production adapters demonstrate the same requirement.

Do not default to a durable host daemon, generalized command ledger, second broker protocol, nested
receipt chain, fleet-wide scan, or executable byte attestation. Add such machinery only when a named
safety or liveness failure requires it and a focused test can prove it works.
