# Deferred product directions after the M0 coexistence decision

**Status:** backlog and design constraints, not a second roadmap. The authoritative delivery order,
V1 decisions, and release gates live in [Product goal and release gates](release-finish-line.md).

The full target is Claude Code, Codex, OpenCode, and an honest tmux fallback, each with its local UI
plus multiple remote-claw browsers and with provider-native collaboration preserved where available.
[Product goal and release gates](release-finish-line.md) owns the sequence.

M0 proved a lower-fidelity version through the tmux adapter, the Anthropic Remote API, and two
remote-claw browsers. The first structured M1 merge now implements the small readiness-gated native
companion and has passed a local-TUI, two-browser, authenticated-provider-API run. Literal official
Claude app UI validation and the Graduate restart, broker-loss, log, install, and deployment gates
remain open. See [native coexistence](native-rc-passthrough-scoping.md).

## Sequencing rule

Each milestone names:

- one user-visible adapter outcome;
- the exact native and security boundaries it changes;
- capability claims that become true;
- a real acceptance scenario; and
- the smallest fault tests needed for ambiguous writes, reconnect, and failure isolation.

Do not require every later surface to block an earlier shippable milestone. Also do not rewrite a
milestone as the entire product or delete working adapter foundations merely because they are not next.

## Adapter follow-ons

### Claude Code

Finish Coexistence Text with one literal official-client UI run, then Graduate the implemented
text-only native companion through restart, broker-loss, log, install, and deployment acceptance—without
expanding it into controls or rich content. The structured critical path then moves to OpenCode and
Codex; Claude permissions, questions, interrupts, modes, slash commands, and attachments may graduate
later one family at a time without holding M1 open. Keep the private replacement relay as a separately
labeled mode for environments that do not need the official client.

### OpenCode

Productize the existing HTTP/SSE adapter non-empty non-slash text and interrupt path: prove real TUI
coexistence, reject ungraduated slash commands, close ambiguous-send and origin-trust gaps, define
truthful new-projection recovery, and pin a supported version matrix. The supported path does not mutate
native permission policy by default and advertises structured permissions as false; the current mirror
becomes an explicit experimental opt-in until child-session and competing-local-answer races have a
native, executable resolution. It must label an existing native ask/deny posture as local/native, not
“permissions off,” or reject that policy tuple when the posture cannot be known. Preserve native
collaboration if a selected OpenCode version exposes one.

### Codex

Build from the retained app-server multi-client evidence in two outcomes. First recapture a current
version and prove one local Codex TUI plus multiple remote-claw browsers submit labeled text exactly once
on the same native thread. Then run a bounded feasibility gate and preserve Codex/ChatGPT Remote only
through a currently supported provider boundary. While browser approvals remain disabled, separately
prove that attaching the companion does not steal, answer, error, or strand one native approval and one
native question handled by the local TUI. Label that posture local/native rather than “permissions off,”
or reject the tuple. Historical evidence is a reason to test the seam, not proof of the final topology.

### tmux compatibility

Keep tmux as the fallback when no structured native adapter exists. Improve conservative input states,
transcript attribution, and recovery, but never describe pane paste as independent peer collaboration
or exactly-once native application. Advertising Claude Remote Control coexistence requires one bounded
official Claude client UI run; an API-only client does not establish that product claim.

## Inference and accounts

Model routing is orthogonal to agent integration. Anthropic, OpenAI, Bedrock, and later providers need
per-agent compatibility entries and credentialed smokes; they do not need a second collaboration
protocol. Land each smoke with the advertised tuple; do not defer a Cartesian product to the end.

Accountless means no Anthropic account. The current path still needs AWS/Bedrock credentials,
remote-claw identity/pass material, and possibly a protected-deployment bypass. Test and document those
credentials explicitly instead of using “accountless” as “no accounts or credentials anywhere.”

## Shared follow-ups

- Per-viewer roles and revocation, after a concrete authority policy exists.
- Stable same-row native restart adoption, after M1's fresh-projection restart contract, with exact
  adapter-local binding and a duplicate-mutation crash test.
- Push notifications and offline discovery without plaintext payloads.
- Retention/deletion with authenticated ownership and partial-failure handling.
- Shared adapter abstractions only after two production adapters demonstrate the same requirement.

Do not default to a durable host daemon, generalized command ledger, second broker protocol, nested
receipt chain, fleet-wide scan, or executable byte attestation. Add such machinery only when a named
safety or liveness failure requires it and a focused test can prove it works.
