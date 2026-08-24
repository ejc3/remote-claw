# remote-claw product goal and release gates

**Status: the full product is not implemented.** The shared crypto, broker, browser, and Claude
private-relay path work. OpenCode, tmux, Bedrock, and accountless paths have useful implementations
and evidence with narrower guarantees. A bounded M0 run proved lower-fidelity Claude/tmux coexistence
through the Anthropic Remote API; structured fidelity and official-app UI acceptance are still missing.

The next milestone is structured Claude native coexistence because the retained tmux route has now
answered the basic topology question. It is not the entire product or a reason to discard the other
surfaces.

## Decision policy

- Label every claim as **current**, **this milestone**, or **final target**.
- A required surface may move later in the sequence; it may not be deleted merely to make the current
  milestone smaller.
- Every retained module and gate must own a named surface or shared safety invariant.
- Expensive gates are opt-in or path-owned, never ceremonial requirements for unrelated changes.
- Use realistic E2E to discover and sentinel outcomes; move each regression to the earliest
  trustworthy deterministic boundary, and record why cross-process/provider/deployment cases cannot
  shift left. Never duplicate the same scenario at every layer.
- Experimental support graduates only after its executable real-user acceptance scenario passes.
- Do not add a coordinator, schema, signing hierarchy, or proof layer until a demonstrated causal
  failure needs it and a focused fault test can exercise it.
- Remove or merge proof machinery when a cheaper causal test supersedes it.
- When code is removed, record the unreachable/duplicate responsibility and why Git history is enough;
  retain the smallest foundations used by a named future surface.

## 1. Full product outcome

remote-claw is an E2E-encrypted multiplayer layer for Claude Code, Codex, OpenCode, and an honest
lower-fidelity tmux fallback. For every supported surface:

- the local native TUI remains usable;
- at least two remote-claw browsers observe one coherent conversation and can submit supported
  actions;
- official provider collaboration remains usable when that provider offers it, including Claude
  Remote Control and Codex/ChatGPT Remote;
- losing a browser or remote-claw projection does not kill a healthy local/native session; and
- capability and delivery states describe what that adapter can actually prove.

The shared topology is:

```text
local native TUI ───────────────────────┐
official provider remote ── when offered├── native conversation
remote-claw browsers ⇄ sealed broker ⇄ host adapter
```

tmux is deliberately different. It offers terminal compatibility when no native structured seam is
available, but a shared pane keystream cannot honestly promise independent peer ordering or structured
delivery receipts. Its plain-Claude launch preserved provider-native collaboration in the bounded M0
run; keep that result labeled as architecture evidence until M4 adds a maintained acceptance gate.

## 2. Orthogonal axes

Do not decompose the product by assuming one agent implies one model provider.

| Axis | Choices and rule |
| --- | --- |
| Agent/native surface | Claude Code, Codex, OpenCode, or tmux compatibility; each owns capture, mutation, readiness, and capability truth |
| Collaboration surface | Local TUI, provider-native remote where available, and multiple remote-claw browsers; preserve rather than replace native collaboration when the API allows it |
| Inference route | Anthropic, OpenAI, Amazon Bedrock, or another explicitly supported provider; routing must stay separate from broker identity and collaboration semantics |
| Broker/store | E2E-sealed remote-claw transport with SQLite/libSQL as the durable profile; the broker never receives content keys or provider credentials |

“Accountless” means **without an Anthropic account**. It never means anonymous or credential-free.
The current accountless path uses Bedrock, so it still requires AWS/Bedrock credentials, a
remote-claw identity/viewer pass, and any deployment credential needed for a protected broker.

## 3. Current truth

| Surface | Implemented now | Still required for its product outcome |
| --- | --- | --- |
| Shared broker/browser/security | Sealed frames, identity/pass derivation, durable replay, multi-viewer state, capability gating, and fail-stop behavior | Exercise the same boundaries through each production adapter |
| Claude private relay | Real Claude behind a local RC façade; browser turns and native output cross the broker | It replaces Anthropic RC, so the official client cannot join |
| Claude trace | Normal Anthropic RC and official-client control with protocol observation | It does not project to or accept commands from remote-claw browsers |
| Native Anthropic client | Bounded session list/history/SSE/text POST transport and host-only credential source | Readiness-gated bridge, exact session binding, reconciliation, and browser wiring |
| OpenCode | Experimental server adapter with history/SSE capture, text injection, permissions, and capability limits | Real TUI coexistence, durable binding/recovery, ambiguity handling, and supported release matrix |
| Codex | Pinned evidence that multiple app-server clients can share one native thread | Product adapter, local TUI plus browser coexistence, and provider-native Codex/ChatGPT Remote integration |
| tmux | Private pane, transcript capture, conservative input injection, optional permission mirroring, and one bounded Claude/Anthropic/two-browser coexistence run | Productize only its honest fallback contract; verify the official app separately and never claim native peer fidelity it cannot supply |
| Bedrock/accountless | Experimental inference translation and isolated no-Anthropic-account launch path | Credentialed compatibility matrix and coexistence gates for each agent adapter that advertises it |

The provider fixtures establish bounded facts about pinned versions. They are valuable adapter
evidence, not a separate proof/receipt program and not a substitute for the user outcome.

## 4. Milestone sequence

### M0 — retained tmux coexistence route (completed decision gate)

On 2026-08-24, Claude Code 2.1.237 ran through the existing tmux driver with Claude's own
`--remote-control` forwarded unchanged. One local pane, one host-side Anthropic Remote API client, and
two independent remote-claw browser contexts submitted labelled text to the same native conversation.
Each user event appeared once in provider history; both browsers saw all turns, a reload added no
duplicate, and killing the remote-claw broker left the wrapper, pane, and provider-native session live.

This establishes the honest lower-fidelity baseline without adding a companion adapter. It does not
prove independent peer ordering, structured native delivery, or the official Claude web/mobile UI:
the Anthropic-side surface was the typed host client. M1 remains scoped to those added guarantees.

### M1 — structured Claude native coexistence

Keep normal `claude --remote-control` connected to Anthropic. Add a small host bridge that:

1. waits until one exact native `cse_*` is selected and ready;
2. reconciles ascending history with one live SSE reader;
3. projects supported events into the E2E-encrypted broker;
4. submits text with one caller-owned UUID and timestamp; and
5. treats a potentially completed POST as outcome-unknown instead of issuing a fresh command.

Acceptance: one local Claude TUI, the official Claude client, and two remote-claw browsers share one
session; labeled text from every surface appears once; reconnect and bridge restart add no duplicate;
broker loss leaves the native surfaces alive.

This milestone needs a small readiness-gated bridge helper, not a generalized host coordinator. No
presence or browser mutation is published before exact native identity, capture, and mutation
prerequisites are ready. Cancellation must win over a late readiness transition.

### M2 — OpenCode production adapter

Use the existing native HTTP/SSE seam. Close the documented TUI-coexistence, ambiguous-send,
permission-race, and durable-recovery gaps. Gate against a pinned supported OpenCode version with the
real TUI plus two browsers. Preserve any native collaboration exposed by that version.

### M3 — Codex and provider-native remote coexistence

Build from the pinned app-server multi-client evidence. First prove local Codex TUI plus multiple
remote-claw browsers on one native thread. Then integrate Codex/ChatGPT Remote through the provider's
supported boundary without inventing parity the current evidence does not establish.

### M4 — tmux fallback contract

Ship tmux as an explicitly lower-fidelity adapter: local pane plus multiple browsers, conservative
input states, truthful transcript attribution, and safe recovery instructions. Do not label pane paste
as exactly-once native application or independent official collaboration. Before advertising provider
coexistence, retain and run the smallest opt-in real acceptance covering the local pane, provider-side
client, two browsers, reload, and broker-loss isolation. The one-off M0 result selected the architecture;
it is not a permanent regression gate.

### M5 — inference and account matrix

For each advertised agent/provider pair, run a credentialed smoke and document the exact support
level. Model routing remains outside the collaboration adapter. Accountless acceptance proves no
Anthropic account or credential was used while also proving the required AWS/Bedrock and remote-claw
credentials were handled safely.

More actions—permissions, questions, interrupts, modes, attachments, and tool controls—graduate per
adapter only after their native contract and failure states are captured.

## 5. Shared safety invariants

These remain release-blocking wherever reachable:

- Authenticate routing and sealed content before any native side effect.
- Keep the broker ciphertext-only. Provider credentials, machine secrets, passes, plaintext prompts,
  responses, tools, and attachments stay out of broker storage and normal logs.
- Keep provider credentials on the host and secrets off argv and structured status output.
- Bind local adapter interfaces to loopback unless a separately authenticated design changes that
  boundary.
- Give every browser mutation one stable random identity and immutable semantics. Never turn an
  ambiguous outcome into a second logical command through an automatic fresh-ID retry.
- Treat byte-identical durable replay as the same event and changed bytes under one identity as a hard
  collision.
- Fail closed on malformed, unsupported, or ambiguous native protocol data.
- Publish readiness and capabilities only after the exact native identity and prerequisites they
  describe are true.
- Distinguish broker receipt, host receipt, provider acknowledgement, native-history observation, and
  native application in the UI. Unknown means unknown.
- Isolate failure: stop the affected projection without killing an otherwise healthy local/native
  session or provider collaboration path.

The remote-claw broker is zero knowledge for conversation content. Anthropic, OpenAI, AWS, or another
selected inference/collaboration provider necessarily sees the plaintext its own API requires.

## 6. Lean gate policy

During implementation, run the smallest relevant tests. Once code and docs settle, run the common
gate once:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm test:install
```

Then add only the surface-specific evidence:

| Changed surface | Additional evidence |
| --- | --- |
| Native adapter, parser, readiness, or session binding | Focused protocol tests and one real native coexistence run for that adapter |
| Inference routing or accountless mode | Credentialed provider smoke plus credential/log inspection |
| Crypto, identity, replay, or mutation admission | Vectors, collision/replay tests, and the smallest causal fault test |
| SQLite/libSQL durability | Real Turso create/write/read/reconnect and relevant provider-failure test |
| Browser behavior or styling | Browser E2E and reviewed light/dark phone/desktop screenshots |
| Deployment or broker routing | Exact-commit Preview smoke against the configured durable backend |
| Handoff/public admission | In-process body-limit, expiry, single-use, and uniform-miss tests; when enabling handoff, the named outside-in per-IP WAF procedure |

Every production adapter has its own acceptance scenario. A skip is not green when the release claim
requires that scenario. Exact commit SHA and ordinary CI artifacts are sufficient source binding; do
not rebuild custom receipt chains, host-tool byte attestations, fleet-wide log scans, or frozen
firewall matrices.

## 7. Definition of done

The full product is done when the Claude, OpenCode, Codex, and tmux acceptance scenarios above pass
against the supported deployed broker, provider/inference claims have credentialed coverage, and the
shared safety invariants have focused regression tests.

Milestones may ship independently with truthful labels. M1 being green means Claude native
coexistence is green; it does not mean Codex, OpenCode, tmux, Bedrock, or the full product is complete.
Line count, fixture count, and proof machinery are not success metrics. The metric is supported user
surfaces working safely with the smallest maintainable implementation.
