# remote-claw execution roadmap and release gates

**Status: the full product is not implemented.** The shared crypto, broker, browser, and Claude
private-relay path work. OpenCode and tmux have completed narrow supported tuples; Bedrock inference and
accountless have useful implementations with narrower evidence. M1's Linux/exact-2.1.237 structured
text companion and explicit
same-native-session restart attachment are implemented. Bounded 2026-08-30 runs proved the local TUI,
an authenticated Anthropic RC API client, two remote-claw browsers, fresh-projection restart,
broker-loss isolation, installed-package use, and a bounded exact-value/log and raw-storage scan.
The exact-SHA deployed Preview gate is green. The literal logged-in official Claude web UI on the
user's phone then joined the same native session, exchanged labelled text alongside two remote-claw
browsers, and disconnected without breaking the remaining surfaces. M1 is complete.

The pinned OpenCode M2 text/interrupt adapter is also complete. Its 2026-08-30 acceptance used the
real OpenCode TUI and two browsers, exercised native-ordered IDs, browser A/B turns, immutable reload,
interrupt plus continuation, and a companion-only fresh-projection restart against the same exact
native session. Its separate read-only MAIN-session status follow-on and real-TUI/two-browser
acceptance are also complete. Codex M3a is complete for exact
0.151.0/Linux arm64: one real local TUI and two browsers
shared an exact app-server thread, exchanged uniquely labelled text once, and kept one native approval
and one native question solely in the TUI. M3b is also complete for that exact tuple: on 2026-08-31,
the companion joined the official ChatGPT Remote thread through Codex's managed Unix socket, one
provider-origin message appeared once in both remote-claw browsers, browser-origin text completed on
the same native thread, and another browser turn completed after the provider transport disconnected.
Viewer UI-1 is also complete: routine contiguous tool/task events now collapse into an exact-count
activity row with a responsive detail sheet, while errors and other already-visible non-routine rows
remain first-class. This does not claim background-task lifecycle semantics the adapters do not expose.
M5 is complete for the currently published inference ledger: the existing exact OpenCode M2 Bedrock
tuple and the exact Claude private-relay accountless tuple qualified below. New tuples remain separate
incremental work.

M4 is complete for the maintained lower-fidelity tmux fallback. On 2026-08-31, a packed-installed CLI,
exact Claude 2.1.237/Linux arm64, Bedrock Sonnet 4.6, a real local pane, and two browsers passed labelled
turns and durable reload. A browser turn remained queued behind an active model turn and its focused
native permission modal; both browsers departed, local approval completed the native turn, and the
queued browser turn then completed. Forced broker loss left the pane usable for a later local turn. The
idle editor and idle slash/config UI still share the pane keystream and must not be manipulated while
remote viewers may submit. The result claims neither independent peer ordering nor
provider-native/official-client coexistence.

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
delivery receipts. M4's maintained acceptance covers the local pane and remote-claw browsers only. The
bounded M0 provider-side result remains architecture evidence; tmux advertises neither provider-native
nor official-client coexistence. Its idle local editor, partial drafts, slash commands, and configuration
UI must not be manipulated while remote viewers may submit.

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

  The supported manual Connect gate and normal `--rc-pass` output now state the indefinite
  machine-wide read/control/record-forging authority, mutual trust, lack of individual revocation, and
  retained-old-route consequence. Machine-readable and quiet pass output remain stable. Handoff is
  still default-off and retains its separate pre-claim disclosure gate.
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
| OpenCode | M2 complete for Linux arm64, exact OpenCode 1.17.5, the pinned Bedrock Sonnet model, one explicit live session, non-empty non-slash text, interrupt, native/local permissions, and fresh-projection restart; the separate read-only MAIN running/idle status follow-on is also complete | Later versions, platforms, models, permission graduation, and richer controls are separate tranches |
| Codex | M3a and M3b complete for exact 0.151.0/Linux arm64: explicit UUIDv7, local TUI plus two browsers, native-ordered text/status, TUI-only approvals/questions, explicit-loopback and literal managed-`unix://` attachment, same-thread ChatGPT Remote text coexistence, clean companion-stop isolation, and provider-transport isolation | Companion restart/backfill, Codex broker-loss acceptance, stable projection identity, per-device Remote unsubscribe, richer controls/content, and other versions/platforms remain separate results |
| tmux | M4 complete for exact Claude 2.1.237/Linux arm64 with Bedrock Sonnet 4.6: packed install, private pane, two browsers, reload, non-empty non-slash text plus attachments held behind an active turn and its native modal, queued completion after browser departure, and broker-loss isolation | Idle editor/slash/config UI concurrency is unsupported; other versions/platforms/providers, native peer ordering, exactly-once native application, raw browser controls, slash commands, and provider-native/official-client coexistence remain unclaimed |
| Bedrock/accountless | M5 complete for one tools-disabled text round-trip on exact Linux arm64 / Claude 2.1.237 / `us-east-1` / `anthropic.claude-opus-4-8` / temporary IMDSv2 SigV4, plus the already-qualified OpenCode M2 tuple | Each newly advertised capability, version, platform, model, region, credential source, or adapter tuple needs its own bounded gate |

The provider fixtures establish bounded facts about pinned versions. They are valuable adapter
evidence, not a separate proof/receipt program and not a substitute for the user outcome.

## 4. Delivery roadmap

The structured critical path **M1 → M2 → M3** and the independent lower-fidelity M4 graduation are
complete at their pinned, deliberately narrow tuples. M5 qualification travels with each adapter instead of becoming a final
Cartesian-product marathon, and the viewer-parity lane may continue without reopening M1–M3.

| Delivery | User-visible result | Why this order |
| --- | --- | --- |
| M0 — complete | Lower-fidelity topology decision | Already answered whether native/provider and remote-claw surfaces can remain live together |
| M1 — complete | Structured Claude text coexistence | Local TUI, literal official web UI on the user's phone, two browsers, Graduate restart/isolation, and the separate exact-SHA deployed-broker gate are green |
| M2 — complete | Supported OpenCode text/interrupt adapter | The second structured adapter and its bounded real-user acceptance are green |
| M3a — complete | Codex TUI plus remote-claw browsers | Exact 0.151.0/Linux arm64 text/status companion and bounded real-user acceptance are green |
| M3b — complete | Codex Remote same-thread coexistence | The official Remote thread, local TUI, companion, and two browsers exchanged text; a browser turn still completed after provider-transport disconnect |
| UI-1 — complete | Compact activity rollup and detail sheet | Exact transcript event counts and chronological details reduce routine noise without inventing task status |
| OpenCode status — complete | Viewer-visible read-only MAIN running/idle status | Startup/live/reconnect/child/error behavior has focused ownership, and the separate real-TUI/two-browser running-to-idle acceptance passed |
| M4 — complete | Maintained, honest tmux fallback | Exact accepted tuple is green without widening the structured critical path or claiming provider-native coexistence |
| M5 — complete for current ledger | Advertised inference/account tuples | Exact current claims are qualified; later tuples extend the ledger incrementally |

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
capabilities at the M2 cutoff were non-empty non-slash text and interrupt; permissions, questions,
status, model/mode changes, attachments, and end remained native/local and were advertised
unsupported.

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

### OpenCode status follow-on — complete

The current pinned adapter advertises <code>status:true</code> as a read-only MAIN-session capability.
Native <code>busy</code> and <code>retry</code> map to viewer running. Idle is published only after exact
history/status reproof on the ordinary lifecycle path. Child lifecycle never drives MAIN. On SSE loss,
write admission pauses while the viewer retains the last verified state; exact reconnect reproof
converges it. A MAIN error instead re-reads exact status for the viewer without opening admission or
clearing browser correlation.

No mutation boundary changed: text and interrupt remain the only supported browser mutations, and
permissions, questions, model/mode, attachments, end, and status mutation remain native/local or
unsupported exactly as before. Focused startup/live/reconnect/child/error regressions own those causal
boundaries. At 2026-08-31T05:09:54Z, the exact OpenCode 1.17.5/Linux arm64/pinned Bedrock Sonnet/
<code>us-west-1</code> temporary-SigV4-environment tuple passed the separate status gate. An attached
TUI drove the MAIN session from native busy to idle; two independent Chromium contexts both showed and
cleared “working,” and each displayed one user and assistant copy. This acceptance is separate from,
and does not retroactively change, the 2026-08-30 M2 evidence.

### Post-M2 viewer parity lane

**UI-1 is complete.** The viewer projects each maximal contiguous run of routine, visible
<code>tool_use</code>, non-error/non-empty <code>tool_result</code>, and <code>task</code> frames into a
compact Activity row. Its label contains exact frame counts only. Every frame remains in original order
inside the existing responsive sheet. The row exists from the first routine event so its identity and
focus remain stable as a live run grows; any other retained transcript message breaks the run. Explicit
errors remain first-class in the transcript. The projection does not rewrite durable history, pair
results to calls, or infer running/completed state, duration, tokens, phases, workflow, or provider.

The focused real-spine tests cover both rollups, chronological detail, output expansion, salient error,
keyboard traversal through native <code>&lt;summary&gt;</code> controls, Escape/close focus restoration,
short-viewport popover scrolling, and 44 px targets. The visual gate is 40 executions across
phone/desktop and light/dark, producing 68 reviewed artifacts including collapsed, sheet, and
expanded-output states. Later parity work must still graduate one observed event family at a time from
redacted trace evidence. Visual resemblance without equivalent semantics and capability gating is
inspiration, not parity.

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

M4 completed on 2026-08-31 as an explicitly lower-fidelity adapter. The retained opt-in acceptance used
a packed-installed CLI, exact Claude 2.1.237/Linux arm64, Bedrock
`global.anthropic.claude-sonnet-4-6` in `us-west-1`, a real private tmux pane, a durable local SQLite
broker, and two independent Chromium contexts. Browser-A and browser-B labels appeared once in both
viewers, and reload reconstructed both. The fresh session first showed that permission mode was being
confirmed without disabling browser text; native transcript evidence then resolved the viewer posture.
A safe local Bash turn next focused Claude's native permission prompt. Browser B submitted another
prompt, but the modal remained focused and the native turn did not complete: the browser paste and
Enter stayed behind the already-active turn's gate. Both browsers departed; local approval completed the Bash turn
and the queued browser turn then completed. The test next closed its broker proxy and every accepted
socket, then proved a new local turn still completed in the retained pane. The closed transport is the
broker-loss fact; no internal retry-log wording is part of the gate.

The maintained command is `pnpm --dir tests/web test:tmux-live` with explicit packed-CLI, exact-Claude,
pre-trusted-cwd, provider, region, and model environment shown in [the tmux driver document](tmux-driver.md).
Missing prerequisites fail the dedicated gate rather than skipping it. Deterministic tests own the
private-buffer load followed by a fixed helper's shared Linux-`flock` claim/paste/settle/Enter critical
section, the working-flock startup probe, synchronous `UserPromptSubmit` arbitration, normalization of
every prompt-helper failure to blocking status `2`, exact-2.1.237 main-transcript
`system/turn_duration` and latched-interrupt records with generation-safe atomic reconcile, and exact
current-launch hook-rejection warnings that retire only the projection, leaving the gate closed and pane
usable, because their concurrent-hook generation is ambiguous. Old backfill and generic warnings do
neither. Normal `SessionEnd` uses the same lock, closes the gate, then writes the retirement marker and
retires the remote projection while preserving the local pane. Its fallback requires the private marker
first and then best-effort closes the gate. `Stop`, `StopFailure`, and asynchronous notifications cannot
release the gate because they can continue or race newer work. Tests also require the absence of any
global Enter binding or TUI parser. Deterministic tests additionally own three-layer
slash/raw-control rejection, fixed `structuredPermissions:false`, optional
`permissionPosture:"local"|"bypassed"|"unknown"`, current-launch permission-mode resolution, the
fresh-session unknown disclosure with text still enabled, later presence-mode updates, native settings
preservation, absence of request/decision content, trust mutation, and automatic
`--dangerously-skip-permissions`, immediate pre-readiness recovery output, conservative injection, and
bounded teardown.

The posture is published from a direct actual-bypass argument or current-launch native evidence:
Claude's resolved SessionStart mode when supplied or a timestamped matching-session record written after
the current transcript attach. Every attached backfill is ignored; rotation clears the current
announce's prior mode and republishes without one, immediately restoring `unknown`. A flag that only
makes bypass selectable is not itself bypass. Because
Claude 2.1.237 creates a fresh transcript lazily, missing, stale, or unreadable evidence publishes
explicit `unknown`; the maintained viewer says the mode is being confirmed and keeps ordinary text and
attachments enabled, subject to the no-concurrent-idle-TUI rule. Later timestamped permission-mode
evidence for the current native session updates existing presence `mode`, so the viewer resolves to
`local` or `bypassed` and follows later
local changes. This does not add a settings parser, permission hook, request content, or decision
content. Explicit bypass and legacy missing posture show **Permissions off**; an older viewer also treats
the new local or unknown posture pessimistically.

Three-layer text rejection also means terminal control bytes cannot masquerade as ordinary text: tmux
viewer/relay admission rejects C0/C1 controls other than TAB/LF in text and attachment captions, and the
pane injector independently checks every downstream prompt before `load-buffer`.

This result does not label pane paste as exactly-once native application or independent peer ordering.
It also does not advertise provider-native Remote Control or official-client coexistence; M1's
structured `claude-native` adapter owns that product surface. The one-off M0 provider/API run remains
architecture evidence, not a second permanent gate.

The safety claim is deliberately narrower than generic terminal isolation. Browser pane keys cannot
cross an active model turn or the native permission/question modal reached within it. The idle local
editor, partial drafts, slash commands, and configuration UI share one terminal stream and must not be
manipulated while remote viewers may submit; they may otherwise merge or reorder.

### M5 — complete for the current inference and account matrix

For each exact advertised tuple—agent, provider, model, region where applicable, account mode, and
capability set—run a credentialed smoke and document the support level. Model routing remains outside
the collaboration adapter. Accountless acceptance proves no Anthropic account or credential was used
while also proving the required AWS/Bedrock and remote-claw credentials were handled safely.

Add each tuple's credentialed smoke when the adapter first advertises that tuple. M5 only closes the
exact published ledger; it does not test every theoretical agent, model, region, and credential
combination or invent a cross-adapter E2E without an advertised outcome.

The current ledger closed on 2026-08-31. The existing OpenCode M2 acceptance already owns its exact
Linux-arm64/1.17.5/Bedrock-Sonnet/`us-west-1` tuple. The added Claude private-relay gate used Linux
arm64, exact Claude 2.1.237, accountless isolated state, `bedrock-mantle` in `us-east-1`,
`anthropic.claude-opus-4-8`, and temporary IMDSv2 SigV4 credentials. One viewer-client prompt reached
the real Claude worker, produced a real Bedrock answer, returned through the sealed viewer transcript,
and left Claude alive until teardown. This gate exercises the same viewer protocol as the browser, but
it is not a literal browser or official-client test. The tools-disabled child environment held no
usable Anthropic auth variable, alternate API base, custom authorization header, or AWS credential
variable; its config, secure-storage, and Anthropic-profile roots were isolated, inherited settings
overrides were removed, fixed CCR-host token files and Linux managed settings were covered by
fail-closed guards, and conforming SDK metadata discovery was disabled. This does not claim a network
sandbox against raw IMDS access. A
deterministic companion test makes any Anthropic upstream request fail while exercising Bedrock
inference, synthesized control-plane traffic, and local RC registration.

More actions—permissions, questions, interrupts, modes, attachments, and tool controls—graduate per
adapter only after their native contract and failure states are captured. M4 already supports
attachments as ordinary user input under its active-turn gate and shared-idle-TUI limitation; that
does not enable raw control.

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
pinned OpenCode text/interrupt row, M3a plus M3b prove only the pinned Codex app-server/ChatGPT
Remote text/status coexistence row described above. OpenCode's read-only status follow-on is a current
implemented and accepted capability; it does not rewrite M2. M4 proves only the pinned lower-fidelity
tmux row. Broader tuples and controls, Codex restart and broker-loss acceptance, the advertised
Bedrock/account matrix, viewer
parity, and the full product remain separate outcomes.
Line count, fixture count, and proof machinery are not success metrics. The metric is supported user
surfaces working safely with the smallest maintainable implementation.
