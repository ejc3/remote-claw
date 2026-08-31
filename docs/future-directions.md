# Deferred product directions after the M0 coexistence decision

**Status:** backlog and design constraints, not a second roadmap. The authoritative delivery order,
V1 decisions, and release gates live in [Product goal and release gates](release-finish-line.md).

The full target is Claude Code, Codex, OpenCode, and an honest tmux fallback, each with its local UI
plus multiple remote-claw browsers and with provider-native collaboration preserved where available.
[Product goal and release gates](release-finish-line.md) owns the sequence.

M0 proved a lower-fidelity version through the tmux adapter, the Anthropic Remote API, and two
remote-claw browsers. M1 completed the small readiness-gated native companion, explicit exact-session
fresh-projection restart, and literal official-client coexistence path. M2 completed the pinned
OpenCode 1.17.5 text/interrupt adapter and its real-TUI, two-browser acceptance. M3a completed the exact
Codex 0.151.0/Linux arm64 app-server text/status companion, including a local TUI, two browsers, and
TUI-only approval/question handling. M3b then completed same-thread ChatGPT Remote text coexistence
through the managed Unix socket, including provider-origin and browser-origin text plus continued
browser turns after provider-transport disconnect. To avoid duplicating volatile pass/fail lists here,
current evidence and remaining gates live in
[native coexistence](native-rc-passthrough-scoping.md) and the
[release roadmap](release-finish-line.md).

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

M1 is complete. Do not reopen it by expanding the text-only native companion into controls or rich
content. The structured critical path remains outside Claude; Claude permissions,
questions, interrupts, modes, slash commands, and attachments may graduate later one family at a time.
Keep the private replacement relay as a separately labeled mode for environments that do not need the
official client.

### OpenCode

M2 is complete for exact OpenCode 1.17.5 on Linux arm64, the pinned Bedrock Sonnet model, one explicit
live session over literal loopback, non-empty non-slash text, interrupt, and truthful fresh-projection
restart. The accepted server environment used `AWS_REGION=us-west-1` plus explicit temporary SigV4
credential values; other regions or credential modes need their own gate. The supported path does not
mutate native permission policy and advertises structured permissions as false; the mirror remains
only behind the explicit positive experimental opt-in. The viewer labels permission handling
local/native, not “permissions off.” Other versions, models, platforms, permission graduation, and
OpenCode-native collaboration surfaces need their own later gate; they do not reopen M2.

### Codex

M3a is complete for exact Codex 0.151.0 on Linux arm64. One local TUI and two browsers exchanged
native-ordered text on one exact app-server thread; one approval and one question remained solely in the
TUI while the structurally response-less companion stayed live. M3b is also complete at that pinned
boundary: the companion attached through literal `unix://` to the same official ChatGPT Remote thread,
provider-origin and browser-origin text appeared once in two browsers, and a second browser turn
completed after the provider transport disconnected.

Keep the result narrow: explicit UUIDv7, attached-TUI precondition, non-empty non-slash text, real
status, and no other browser controls. Provider-transport isolation does not prove that a particular
phone or desktop client unsubscribed. Companion restart/backfill, broker-loss acceptance, stable
projection identity, richer content and controls, and other Codex versions/platforms remain later
adapter-local gates; they do not reopen M3a or M3b.

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

- Post-M2 viewer parity, starting with an activity rollup and background-task sheet over event families
  remote-claw already represents. Richer Claude-native commands, task phases, media, and composer states
  graduate only after trace evidence defines their real semantics; visual resemblance alone is not a
  capability claim and does not reopen M1.
- Per-viewer roles and revocation, after a concrete authority policy exists.
- Stable same-row native restart adoption, after the current adapter-local fresh-projection contracts,
  with exact binding and a duplicate-mutation crash test.
- Push notifications and offline discovery without plaintext payloads.
- Retention/deletion with authenticated ownership and partial-failure handling.
- Shared adapter abstractions only after two production adapters demonstrate the same requirement.

Do not default to a durable host daemon, generalized command ledger, second broker protocol, nested
receipt chain, fleet-wide scan, or executable byte attestation. Add such machinery only when a named
safety or liveness failure requires it and a focused test can prove it works.
