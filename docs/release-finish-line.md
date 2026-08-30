# remote-claw execution roadmap and release gates

**Status: the full product is not implemented.** The shared crypto, broker, browser, and Claude
private-relay path work. OpenCode, tmux, Bedrock, and accountless paths have useful implementations
and evidence with narrower guarantees. M1's Linux/exact-2.1.237 structured text companion and explicit
same-native-session restart attachment are implemented. Bounded 2026-08-30 runs proved the local TUI,
an authenticated Anthropic RC API client, two remote-claw browsers, fresh-projection restart,
broker-loss isolation, installed-package use, and a bounded exact-value/log and raw-storage scan.
The exact-SHA deployed Preview gate is green. Literal official-app UI validation remains open.

The active milestone is finishing Claude native coexistence. It is not the entire product or a reason
to discard the other surfaces.

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

### V1 release decisions

These decisions close scope without weakening the security boundary:

- **Trusted-machine/pass-holder beta:** one indefinite viewer pass grants read, control, and record-
  forging authority for every retained route under the machine identity. Pass holders are mutually
  trusted; there is no in-place per-viewer revocation, and resetting the current identity does not
  revoke access to already retained old routes. V1 acceptance requires every credential-acquisition UI
  and the documentation to present the pass as a full bearer credential rather than a room-scoped
  invitation. Per-viewer identity, roles, individual revocation, and delegated authority are not V1
  claims; adding them requires a separate authority milestone rather than an implicit schema expansion.
- **Manual join:** manual viewer-pass entry is the supported V1 join path. One-time handoff stays
  default-off and is not a release dependency; a deployment may enable it only after the documented
  external per-IP rate limit is verified. Before an enabled handoff claims its destructive one-time link,
  the pairing UI must state that “one-time” applies only to delivery and that the recovered pass grants
  the same indefinite machine-wide authority.
- **Text before controls:** each structured adapter graduates observation and non-empty, non-slash text
  before permissions, questions, modes, attachments, or broad tool control. Unsupported controls stay
  disabled rather than simulated.
- **Honest restart:** restarting a native companion creates a fresh random remote-claw projection ID for
  the same native conversation. A clean stop attempts to terminalize the old projection; if that publish
  cannot complete, or after an unclean stop, its existing liveness rules make it stale. The new
  projection backfills native history as observation, never consumes the retired projection's command
  stream, and must never repeat a native mutation.
  Stable same-row restart identity is deferred until a demonstrated user need justifies adapter-local
  durable binding.
- **Narrow support first:** an adapter may initially support one pinned native version, host platform,
  and provider tuple. It must reject or label everything else truthfully. M1 may therefore ship Linux
  first around the existing secure Claude credential source instead of blocking on cross-platform OAuth.

A later requirement can change one of these decisions, but it becomes a named milestone with its own
acceptance. It does not silently expand the active tranche.

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
| Shared broker/browser/security | Sealed frames, identity/pass derivation, durable replay, multi-viewer state, capability gating, fail-stop behavior, and exact-SHA Preview evidence against the configured SQLite/Turso broker | Exercise the same boundaries through each production adapter |
| Claude private relay | Real Claude behind a local RC façade; browser turns and native output cross the broker | It replaces Anthropic RC, so the official client cannot join |
| Claude trace | Normal Anthropic RC and official-client control with protocol observation | It does not project to or accept commands from remote-claw browsers |
| Claude native companion | Exact launch binding or explicit exact-ID attach-only restart, subscribe-before-history reconciliation, provider-ordered text projection/injection, host-only OAuth, two-browser capability gating, fail-stop ambiguity handling, broker-loss isolation, and installed-package evidence on Linux with exact Claude 2.1.237 | Literal official-app UI validation |
| OpenCode | Experimental server adapter with history/SSE capture, text injection, permissions, and capability limits | Real TUI coexistence, durable binding/recovery, ambiguity handling, and supported release matrix |
| Codex | Pinned evidence that multiple app-server clients can share one native thread | Product adapter, local TUI plus browser coexistence, and provider-native Codex/ChatGPT Remote integration |
| tmux | Private pane, transcript capture, conservative input injection, optional permission mirroring, and one bounded Claude/Anthropic/two-browser coexistence run | Productize only its honest fallback contract; verify the official app separately and never claim native peer fidelity it cannot supply |
| Bedrock/accountless | Experimental inference translation and isolated no-Anthropic-account launch path | Credentialed compatibility matrix and coexistence gates for each agent adapter that advertises it |

The provider fixtures establish bounded facts about pinned versions. They are valuable adapter
evidence, not a separate proof/receipt program and not a substitute for the user outcome.

## 4. Delivery roadmap

The structured critical path is **M1 → M2 → M3**: prove Claude's native coexistence, use OpenCode to
validate the adapter seam a second time, then build Codex on evidence from two production adapters.
M4 is an independent lower-fidelity graduation and may merge after M1 when it remains a bounded,
non-overlapping tranche. M5 qualification travels with each adapter instead of becoming a final
Cartesian-product marathon.

| Delivery | User-visible result | Why this order |
| --- | --- | --- |
| M0 — complete | Lower-fidelity topology decision | Already answered whether native/provider and remote-claw surfaces can remain live together |
| M1 — in progress | Structured Claude text coexistence | Text, local Graduate acceptance, and the separate exact-SHA deployed-broker gate are green; literal official-app UI remains |
| M2 | Supported OpenCode text/interrupt adapter | Existing code makes this the cheapest second structured adapter and tests whether a shared seam is real |
| M3a | Codex TUI plus remote-claw browsers | Converts pinned app-server evidence into product code without depending on provider Remote |
| M3b | Codex/ChatGPT Remote coexistence | Ships only after a current supported provider boundary passes a bounded feasibility gate |
| M4 — independent after M1 | Maintained, honest tmux fallback | Nearer to graduation, but deliberately outside the structured critical path |
| M5 — incremental | Advertised inference/account tuples | Qualifies claims as they ship; the final pass only closes the published matrix |

### Execution contract

Every implementation tranche starts from current <code>origin/main</code> and freezes five things before
coding: one durable user outcome, supported capability tuple, forbidden surfaces, owning files, and one
real acceptance. Retired A1 branches, worktrees, and generalized runtime designs are archival input,
not code to merge or cherry-pick wholesale. A retained fragment must map to a current product surface
or safety invariant and survive ordinary review as if newly written.

Use one integration owner for shared contracts. Parallel work is read-only or confined to frozen,
non-overlapping files. Prefer the thinnest end-to-end vertical that a user can exercise; merge it once
its causal tests, real acceptance, review, and CI are green. Do not hold a closed milestone for later
capabilities, and do not reopen a merged decision without a new product requirement or concrete causal
evidence. Add the cheapest faithful regression when the behavior is reproducible.

A finding blocks the current tranche only when it demonstrates a reachable high-impact safety failure
or loss of the promised user outcome with a concrete causal path. Fix that owner. Record unrelated
hardening for its owning milestone instead of expanding the active one. During implementation run
focused tests; after the bytes freeze, run the common gate once, the tranche's real acceptance once,
independent review, CI, and the exact-SHA deployment smoke when deployment is in scope. If E2E discovers
a recurring defect, move its detailed regression to the earliest faithful deterministic boundary and
retain only the smallest cross-layer sentinel.

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

The first text implementation now exists behind <code>--rc-driver=claude-native</code>. On 2026-08-30,
exact Claude Code 2.1.237 ran with ordinary Anthropic Remote Control, one local TUI, an authenticated
Anthropic RC API client, and two simultaneous remote-claw Chromium contexts. Local, API-client, and
both browser prompts were provider-observed and rendered once in both browsers. This is real
structured/API-path evidence, not literal official-app UI evidence: the isolated browser was redirected
to Claude login behind Cloudflare and had no authenticated Claude web session.

The Linux/exact-2.1.237 text-only host bridge keeps normal `claude --remote-control` connected to
Anthropic. It:

1. waits until one exact native `cse_*` is selected and ready;
2. reconciles ascending history with one live SSE reader;
3. projects supported events into the E2E-encrypted broker;
4. submits text with one caller-owned UUID and timestamp; and
5. permanently fences its projection after a rejected or outcome-unknown POST instead of issuing a
   fresh command.

Acceptance: one local Claude TUI, the official Claude client, and two remote-claw browsers share one
session; labeled text from every surface appears once; browser reconnect on one projection adds no
duplicate; companion restart creates a fresh random projection of the same native session, backfills
history once, consumes no retired commands, and repeats no native mutation; broker loss leaves the
native surfaces alive.

The implementation uses a small readiness-gated bridge helper, not a generalized host coordinator. No
presence or browser mutation is published before exact native identity, capture, and mutation
prerequisites are ready. Cancellation wins over a late readiness transition.

Restart uses an explicit attach-only command:

```text
--rc-app <origin> --rc-driver=claude-native --rc-native-session <cse_…>
```

Apart from the required pinned-version probe, it starts no interactive Claude session or proxy,
forwards no Claude arguments, performs no session discovery, and creates a fresh projection rather than
reviving the terminal old one. On 2026-08-30 the packed-installed CLI completed two such projections
against one still-live native session. The second backfilled local, two-browser, and authenticated API
turns once; a broker kill failed only the companion, after which the native TUI completed another turn.
The bounded exact-value scan found no provider/root/pass/bypass value in owned logs or raw broker files,
and raw broker storage contained none of the labelled plaintext.

The two code merge points are closed, each based on the previous merged <code>main</code>:

1. **Coexistence text:** bind one exact native session, reconcile history/SSE, admit browser text with
   one stable caller coordinate, and stop writes on ambiguity. The implementation, local TUI, two-
   browser, and authenticated provider-client API path are green; a literal official Claude client UI
   run remains required before advertising this outcome as fully accepted.
2. **Graduate:** fresh-projection companion restart, broker-loss isolation, installed-package use, and
   the bounded credential/log/storage scan are green locally. The merge point landed in
   [PR 215](https://github.com/ejc3/remote-claw/pull/215), and
   [trusted Preview run 33323332395](https://github.com/ejc3/remote-claw/actions/runs/33323332395)
   passed against exact deployed commit <code>bcab0c9c0fa6ad036f4996b9d0f0540aebec4d26</code>. The gate
   attested the Preview runtime's exact SHA and default SQLite/Turso profile
   (<code>pr-bcab0c9</code>), then passed browser discovery, host receipt, and reload replay. It did not
   exercise live Claude or the official Claude UI; that separate acceptance remains above.

### M2 — OpenCode production adapter

Use the existing native HTTP/SSE seam. Graduate text and interrupt first. Supported HTTP targets are
loopback-only; a non-loopback target requires authenticated HTTPS with normal certificate validation
before provider credentials or native control cross that boundary. Supply the native caller-message
identity, reject blank and slash-prefixed browser text rather than invoking an ungraduated command such
as <code>/compact</code>, and define truthful new-projection recovery. Gate against a pinned supported
OpenCode version with the real TUI plus two browsers.

Treat create, prompt, and interrupt as separate ambiguous POST boundaries. Fault-test each after native
commit but before the response arrives: an uncertain create remains unannounced and is neither guessed
nor recreated; an uncertain prompt or interrupt terminally fences the writable projection, is not
replayed, and admits no later write.

The supported M2 path does not mutate native permission policy by default and advertises structured
permissions as false. The existing permission mirror becomes an explicit experimental opt-in until
child-session and competing-local-answer races have a native, executable resolution. Permission work
does not block the text/interrupt release. That capability means only that the browser cannot answer;
M2 must label native-local permission handling truthfully and must not render an existing ask/deny
policy as “permissions off” or “tools execute without asking.” If the pinned version cannot expose
enough state for that claim, reject the interactive-policy tuple rather than guessing. Preserve any
native collaboration exposed by the pinned version.

### M3 — Codex and provider-native remote coexistence

Treat this as two mergeable outcomes. **M3a** first recaptures the seam against a selected current Codex
version, then proves local Codex TUI plus multiple remote-claw browsers on one exact native thread.
Uniquely labeled text from the TUI and each browser must appear exactly once on every surface. **M3b**
begins with a bounded feasibility test of the currently supported provider boundary and only then
integrates Codex/ChatGPT Remote. Historical app-server evidence justifies trying the seam; it does not
justify a compatibility claim, gateway, or parity the current provider does not expose.

M3a also keeps browser approvals and questions disabled while one native approval and one native
question are separately handled by the local TUI with the companion attached. For both families, the
companion must not steal, answer, error, or strand the first-response-sensitive request. The viewer must
label that posture as local/native rather than “permissions off”; reject the tuple if it cannot do so
truthfully.

### M4 — tmux fallback contract

Ship tmux as an explicitly lower-fidelity adapter: local pane plus multiple browsers, conservative
input states, truthful transcript attribution, and safe recovery instructions. Do not label pane paste
as exactly-once native application or independent official collaboration. Before advertising provider
coexistence, retain and run the smallest opt-in real acceptance covering the local pane, provider-side
client, two browsers, reload, and broker-loss isolation. The one-off M0 result selected the architecture;
it is not a permanent regression gate.

If M4 advertises Claude Remote Control coexistence, that acceptance uses the official Claude client UI;
another host-side API client is insufficient. Otherwise the release explicitly declines the official-
client claim.

M4 has no dependency on the structured M1 bridge. After M1 freezes the shared session/capability
contract, M4 may ship ahead of M2 if its remaining work stays driver-local and its maintained real
acceptance is green. It must not interrupt the structured critical path or grow into a second protocol.

### M5 — inference and account matrix

For each exact advertised tuple—agent, provider, model, region where applicable, account mode, and
capability set—run a credentialed smoke and document the support level. Model routing remains outside
the collaboration adapter. Accountless acceptance proves no Anthropic account or credential was used
while also proving the required AWS/Bedrock and remote-claw credentials were handled safely.

Add each tuple's credentialed smoke when the adapter first advertises that tuple. M5 only closes the
exact published ledger; it does not test every theoretical agent, model, region, and credential
combination or invent a cross-adapter E2E without an advertised outcome.

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
shared safety invariants have focused regression tests. The installed package must also complete one
documented V1 journey: launch a supported native version, join two trusted pass-holder browsers by
manual pass, submit and reconcile supported actions, survive projection loss, and report unsupported
versions and capabilities without guessing.

Milestones may ship independently with truthful labels. M1 being green means Claude native
coexistence is green; it does not mean Codex, OpenCode, tmux, Bedrock, or the full product is complete.
Line count, fixture count, and proof machinery are not success metrics. The metric is supported user
surfaces working safely with the smallest maintainable implementation.
