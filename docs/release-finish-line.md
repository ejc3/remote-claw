# remote-claw execution roadmap and release gates

**Status: the full product is not implemented.** The shared crypto, broker, browser, and Claude
private-relay path work. OpenCode, tmux, Bedrock, and accountless paths have useful implementations
and evidence with narrower guarantees. M1's Linux/exact-2.1.237 structured text companion and explicit
same-native-session restart attachment are implemented. Bounded 2026-08-30 runs proved the local TUI,
an authenticated Anthropic RC API client, two remote-claw browsers, fresh-projection restart,
broker-loss isolation, installed-package use, and a bounded exact-value/log and raw-storage scan.
The exact-SHA deployed Preview gate is green. The literal logged-in official Claude web UI on the
user's phone then joined the same native session, exchanged labelled text alongside two remote-claw
browsers, and disconnected without breaking the remaining surfaces. M1 is complete.

The pinned OpenCode M2 text/interrupt adapter is also complete. Its 2026-08-30 acceptance used the
real OpenCode TUI and two browsers, exercised native-ordered IDs, browser A/B turns, immutable reload,
interrupt plus continuation, and a companion-only fresh-projection restart against the same exact
native session. Codex M3a is complete for exact 0.151.0/Linux arm64: one real local TUI and two browsers
shared an exact app-server thread, exchanged uniquely labelled text once, and kept one native approval
and one native question solely in the TUI. M3b is also complete for that exact tuple: on 2026-08-31,
the companion joined the official ChatGPT Remote thread through Codex's managed Unix socket, one
provider-origin message appeared once in both remote-claw browsers, browser-origin text completed on
the same native thread, and another browser turn completed after the provider transport disconnected.
A small viewer-parity lane may proceed in parallel without reopening completed milestones or claiming
capabilities the adapters do not expose.

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
| Claude native companion | M1 complete on Linux with exact Claude 2.1.237: exact launch/attach binding, provider-ordered text, host-only OAuth, local TUI, literal official web UI on the user's phone, two browsers, ambiguity fencing, fresh-projection restart, broker-loss isolation, packed install, and exact-SHA deployed-broker evidence | Later controls, platforms, and versions remain separate capability tranches, not M1 blockers |
| OpenCode | M2 complete for Linux arm64, exact OpenCode 1.17.5, the pinned Bedrock Sonnet model, one explicit live session, non-empty non-slash text, interrupt, native/local permissions, and fresh-projection restart | Later versions, platforms, models, permission graduation, and richer controls are separate tranches |
| Codex | M3a and M3b complete for exact 0.151.0/Linux arm64: explicit UUIDv7, local TUI plus two browsers, native-ordered text/status, TUI-only approvals/questions, explicit-loopback and literal managed-`unix://` attachment, same-thread ChatGPT Remote text coexistence, clean companion-stop isolation, and provider-transport isolation | Companion restart/backfill, Codex broker-loss acceptance, stable projection identity, per-device Remote unsubscribe, richer controls/content, and other versions/platforms remain separate results |
| tmux | Private pane, transcript capture, conservative input injection, optional permission mirroring, and one bounded Claude/Anthropic/two-browser coexistence run | Productize only its honest fallback contract; verify the official app separately and never claim native peer fidelity it cannot supply |
| Bedrock/accountless | Experimental inference translation and isolated no-Anthropic-account launch path | Credentialed compatibility matrix and coexistence gates for each agent adapter that advertises it |

The provider fixtures establish bounded facts about pinned versions. They are valuable adapter
evidence, not a separate proof/receipt program and not a substitute for the user outcome.

## 4. Delivery roadmap

The structured critical path **M1 → M2 → M3** is complete at its pinned, deliberately narrow
text/control tuples. M4 is an independent lower-fidelity graduation when it remains a bounded,
non-overlapping tranche. M5 qualification travels with each adapter instead of becoming a final
Cartesian-product marathon, and the viewer-parity lane may continue without reopening M1–M3.

| Delivery | User-visible result | Why this order |
| --- | --- | --- |
| M0 — complete | Lower-fidelity topology decision | Already answered whether native/provider and remote-claw surfaces can remain live together |
| M1 — complete | Structured Claude text coexistence | Local TUI, literal official web UI on the user's phone, two browsers, Graduate restart/isolation, and the separate exact-SHA deployed-broker gate are green |
| M2 — complete | Supported OpenCode text/interrupt adapter | The second structured adapter and its bounded real-user acceptance are green |
| M3a — complete | Codex TUI plus remote-claw browsers | Exact 0.151.0/Linux arm64 text/status companion and bounded real-user acceptance are green |
| M3b — complete | Codex Remote same-thread coexistence | The official Remote thread, local TUI, companion, and two browsers exchanged text; a browser turn still completed after provider-transport disconnect |
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
the Anthropic-side surface was the typed host client. M1 later closed those added guarantees through
the structured native companion.

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
   browser, and authenticated provider-client API path are green.
2. **Graduate:** fresh-projection companion restart, broker-loss isolation, installed-package use, and
   the bounded credential/log/storage scan are green locally. The merge point landed in
   [PR 215](https://github.com/ejc3/remote-claw/pull/215), and
   [trusted Preview run 33323332395](https://github.com/ejc3/remote-claw/actions/runs/33323332395)
   passed against exact deployed commit <code>bcab0c9c0fa6ad036f4996b9d0f0540aebec4d26</code>. The gate
   attested the Preview runtime's exact SHA and default SQLite/Turso profile
   (<code>pr-bcab0c9</code>), then passed browser discovery, host receipt, and reload replay. It did not
   exercise live Claude or the official Claude UI; those boundaries were exercised separately.

On 2026-08-30, the final bounded M1 run used exact Claude 2.1.237, a production-built local SQLite
broker, the real local TUI, two independent remote-claw Chromium contexts, and the literal logged-in
official Claude web UI on the user's phone using one ordinary Anthropic RC session. A
browser-labelled turn and its unique reply appeared once in both remote-claw views, and the official
client displayed that browser turn. The official client then submitted its own labelled turn; that
turn and its unique reply also appeared once in both views, while the local TUI visibly observed the
official turn and answer. Both browser assertions came from the companion's canonical provider
history/SSE rows. A separate direct
provider-history recount was unavailable under the host's current credential and is not claimed; the
earlier API-path run already owns that transport read boundary. After the official client disconnected,
a second browser-labelled turn and reply again appeared once in both views, and the native TUI remained
live. This closes M1 without rerunning the already-green restart, broker-loss, credential/storage, or
deployment boundaries.

### M2 — OpenCode production adapter — complete

The supported M2 tuple is frozen: Linux arm64, exact OpenCode 1.17.5,
<code>amazon-bedrock/global.anthropic.claude-sonnet-4-6</code>, <code>AWS_REGION=us-west-1</code> plus
explicit temporary SigV4 credential environment values in the OpenCode server process, one explicitly
named live <code>ses_*</code>, a loopback HTTP server, and a fresh random remote-claw projection on every
companion start. The release path is attach-only. It does not select the root native session by
discovery or create one; child sessions announced from that root may be followed. Its only mutable
capabilities are non-empty non-slash text and interrupt; permissions, questions, status, model/mode
changes, attachments, and end remain native/local and are advertised unsupported.

The bounded implementation owners were:

- CLI argument, help, and run wiring plus their tests;
- the OpenCode client/driver and focused client, driver, and live tests;
- OpenCode text admission in the relay and its focused tests;
- the viewer's permission label and composer/capability tests; and
- the existing web host runner and viewer acceptance spec.

Shared session contracts, broker storage/API, schemas, crypto, and other adapters are not owners unless
the real acceptance demonstrates a concrete failure there.

Use the existing native HTTP/SSE seam. After URL parsing and canonicalization, accept only
<code>http://127.0.0.1:&lt;port&gt;/</code> or <code>http://[::1]:&lt;port&gt;/</code>; reject
<code>localhost</code>, URL credentials, a non-root path, query, fragment, non-loopback hosts, and every
redirect. Optional Basic authentication reads <code>OPENCODE_SERVER_USERNAME</code> (default
<code>opencode</code>) and <code>OPENCODE_SERVER_PASSWORD</code>, preserves password bytes, and never
logs them. Require exact 1.17.5 before presence.

OpenCode, not remote-claw, generates the native ordered message coordinate. The accepted shape is
<code>msg_&lt;12 lowercase hex&gt;&lt;14 Base62&gt;</code>. For a browser prompt, the host derives one exact
<code>prt_rc_&lt;32 lowercase hex&gt;</code> text-part marker from the canonical host event UUID and omits
<code>messageID</code> from <code>prompt_async</code>. The capture owner correlates only a complete native
user record whose marker text and complete user text both equal the immutable browser text. A partial,
missing, changed, merged, or reused marker fails closed. The marker is correlation, not an idempotency
key.

The relay publishes only the pending host-admission receipt before native delivery. It retains the
authenticated frame's original <code>client_msg_id</code> and attaches that browser coordinate to the
canonical native user row after exact correlation. The user row and viewer sequence are allocated only
when that OpenCode-generated message appears in strict history/SSE. Every new native assistant must
name the latest preceding native user as its exact <code>parentID</code>; an already-known assistant may
continue receiving updates after a later steering user. Reject when <code>text.trim()</code> is empty or
starts with <code>/</code>; otherwise preserve the original accepted bytes. No ungraduated slash command
is invoked.

Text admission uses one process-local atomic latch, not a parallel receipt framework. The latch is open
only when the SSE transport is trustworthy and the exact native session is re-proved idle. One text
claim synchronously consumes that idle state; browser turns wait in FIFO order. A newly observed local
native user closes admission immediately. <code>busy</code> and <code>retry</code> never admit text.
<code>session.idle</code> is only a trigger: the capture owner must reconcile bounded strict history and
confirm that the exact session is idle through <code>GET /session/status</code>. For a live browser turn,
the exact marker must still identify the latest native user and the turn must have crossed a native
busy epoch before live idle can release the next writer. On SSE loss, transport admission pauses;
reconnect re-proves version, exact session, history, parents, correlation, and status before writes
resume.

Prompt and interrupt remain separate irreversible HTTP boundaries. Each gets one native attempt. A
rejection, timeout, malformed acknowledgement, or response-unknown outcome fences the projection and
is not replayed. Interrupt waits for trustworthy transport but deliberately does not wait for idle,
because it must reach a running turn. Creation remains outside the M2 release path.

The supported M2 path does not mutate native permission policy by default and advertises structured
permissions as false. The existing permission mirror remains only behind the positive experimental
<code>--rc-oc-mirror-permissions</code> / <code>RC_OC_MIRROR_PERMISSIONS=1</code> opt-in. The old inverse
<code>--rc-oc-skip-permissions</code> is retired and produces a usage error explaining that no mutation
is now the default. Child-session and competing-local-answer races do not block text/interrupt. Structured
permissions false means only that the browser cannot answer; M2 labels permission handling as
native/local and never renders it as “permissions off” or “tools execute without asking.”

Before presence, one live SSE connection, a repeated exact-version/session check, and one strict
bounded history/status reconciliation must be ready. Restart names the same exact <code>ses_*</code>,
creates a fresh projection, backfills history as observation, and consumes no old projection commands.
The companion calls native
<code>/abort</code> only for an admitted authenticated browser interrupt; companion cancellation, broker
loss, capture failure, restart, and ordinary teardown never cause it to abort the externally owned
native run, session, or server.

The bounded 2026-08-30 acceptance passed with the actual OpenCode TUI and two independent browser
contexts on the exact supported tuple. The run verified OpenCode-generated message IDs and exact
<code>prt_rc_*</code> markers for browser A and B, one canonical copy of every old command, and an
unchanged native-history SHA-256 across browser reload. A browser interrupted a genuinely busy turn,
the native stream reached idle without a session error, and a later browser turn succeeded. A
companion-only restart named the same exact <code>ses_*</code>, created a fresh remote-claw projection,
and reproduced the identical native-history SHA-256 without repeating an old command. Focused
deterministic tests own malformed/reused coordinates, parent ordering, busy/retry admission, reconnect,
ambiguous writes, broker projection loss, and the rule that teardown never aborts OpenCode.

The M2 cutoff remains closed: broker schemas, stable same-row binding, coordinators, command ledgers, receipt or
proof frameworks, default-path permission mutation or permission graduation, new control families,
cross-platform/version matrices, and a new permanent browser harness. This adapter-only tranche does
not rerun the Claude official-UI or exact-SHA deployment gates unless it changes those surfaces.

### Post-M2 viewer parity lane

This is a small product lane, not a reason to reopen M1 or broaden M2. First render a compact activity
rollup and background-task sheet from task/tool/activity families remote-claw already represents.
Later add richer Claude-native commands, task phases, media, and composer states one observed family at
a time from redacted trace evidence. A visual match without equivalent event semantics, lifecycle,
and capability gating is inspiration, not parity.

### M3 — Codex and provider-native remote coexistence

M3's two independently mergeable outcomes are complete at their narrow contracts.

**M3a is complete.** On 2026-08-30, exact Codex 0.151.0/Linux arm64 ran with the production web build,
a durable SQLite broker, one real attached Codex TUI, and two independent Chromium browser contexts on
one exact app-server thread. Uniquely labelled TUI, browser-A, and browser-B turns and replies appeared
once in both browsers and the TUI. A native command approval was shown and declined only in the TUI;
its side effect did not occur. A separate native question was answered only in the TUI. The companion
returned neither result nor error for either global first-response-wins request and stayed live. A clean
companion stop left app-server, TUI, and native thread live.

The M3a release contract is intentionally narrow: caller-owned explicit-port loopback app-server,
required exact UUIDv7, a broker with paired durable cursors, local-TUI attachment for the whole
projection lifetime, non-empty non-slash text, real native status, and every browser
control/attachment/permission answer disabled. Focused tests own URL/UUID/version/platform checks,
subscribe/bounded-history/readiness ordering, history/live deduplication, exact item correlation and
deadline, response-less request handling, disconnect/archive/revert and broker/projection fail-stop,
companion-only teardown, dispatch, and capability gates. The live run does not claim companion
restart/backfill or stable projection identity.

**M3b is complete.** On 2026-08-31, the exact Codex 0.151.0/Linux arm64 managed daemon exposed the
already-running official ChatGPT Remote thread through literal <code>unix://</code>. The companion
selected the native <code>legacy</code> history reader, attached to that exact UUIDv7 alongside the
local TUI, and served two independent Chromium browser contexts. One message entered through the
official provider surface and appeared exactly once in both browsers. A uniquely labelled browser-A
prompt reached the same native/provider thread, and its exact answer appeared once in both browsers.
After the provider transport disconnected, a separate browser-B prompt and exact answer still
completed and appeared once in both browsers.

This establishes same-thread text coexistence and **provider-transport** failure isolation for the
accepted tuple. It does not identify or prove the unsubscribe state of any particular phone or desktop
client. It also does not graduate browser permissions/questions, interrupts, model or mode changes,
attachments, slash commands, companion restart/backfill, broker-loss recovery, stable projection
identity, or another Codex version/platform. The M3a TUI-only ownership and disabled-capability
boundaries remain unchanged. See the official
[Codex app-server](https://learn.chatgpt.com/docs/app-server) and
[Remote connections](https://learn.chatgpt.com/docs/remote-connections).

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

M4 has no dependency on the structured M1 or M2 adapters. Now that both have frozen the shared
session/capability contract, M4 can proceed independently when its remaining work stays driver-local
and its maintained real acceptance is green. It must not interrupt the structured critical path or
grow into a second protocol.

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

Milestones may ship independently with truthful labels. M1 proves its Claude-native row, M2 proves its
pinned OpenCode text/interrupt row, and M3a plus M3b prove only the pinned Codex app-server/ChatGPT
Remote text/status coexistence row described above. Broader tuples and controls, Codex restart and
broker-loss acceptance, maintained tmux graduation, the advertised Bedrock/account matrix, viewer
parity, and the full product remain separate outcomes.
Line count, fixture count, and proof machinery are not success metrics. The metric is supported user
surfaces working safely with the smallest maintainable implementation.
