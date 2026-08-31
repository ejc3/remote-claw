# remote-claw test plan

This plan maps tests to product outcomes and safety boundaries. It is intentionally smaller than the
historical gate stack: a green result should mean that a user-facing path or a concrete invariant was
tested, not that one script vouched for another script.

The full Claude/Codex/OpenCode/tmux matrix is incomplete. M1's structured Claude text, literal official
web UI coexistence on the user's phone, fresh-projection restart, broker-loss isolation, packed install,
bounded credential/storage checks, and exact-SHA deployed Preview are green. The pinned OpenCode M2
text/interrupt tuple and its real-TUI/two-browser acceptance are also green. Its read-only MAIN status
follow-on and separate real-TUI/two-browser running-to-idle acceptance are also green. Codex M3a's exact
0.151.0/Linux arm64 app-server text/status tuple and real-TUI/two-browser acceptance are green. M3b's
exact official-Remote/TUI/two-browser coexistence and provider-transport-isolation outcome is also
green for that tuple; maintained tmux support waits for M4. See
[Product goal and release gates](release-finish-line.md) and [Architecture](v2-architecture.md).

## 1. Gate policy

Use four rules:

1. Run the smallest relevant tests while code is moving.
2. After interfaces and schema stop changing, run one focused gate and one full local gate.
3. Run browser, provider, durable-cloud, and deployment gates only when their surface or release
   claim needs them.
4. Treat only a reachable high-severity safety failure or durable liveness loss as a release blocker.
   Record lower-severity hardening without silently expanding the tranche.

## 1.1 Testing factory

A realistic E2E run discovers integration failures and proves the final user outcome. Diagnose each
failure first: is it a reproducible product defect, a test-harness defect, an external outage, or an
unsupported claim? Fix it at that owner. For a product defect likely to recur:

1. identify the earliest trustworthy boundary that caused it;
2. add the cheapest deterministic regression at that boundary;
3. keep only a thin E2E sentinel when the cross-layer wiring itself is causal; and
4. record why the test cannot shift left when it depends on cross-process, provider, or deployment
   semantics.

Do not duplicate one scenario at unit, package, browser, Preview, and provider layers. Do not preserve
incidental timing or fixture data as product behavior, and do not introduce an abstraction solely to
make a test cheaper. Reachable security failures get a causal trust-boundary test plus the smallest
wiring sentinel. Lower-risk bugs get coverage proportional to recurrence and blast radius. New proof
machinery requires a demonstrated failure; remove or merge it when a cheaper test supersedes it.
Prefer named failure paths over hypothetical exhaustive state graphs and whack-a-mole assertions.

“Cheapest” means the lowest-cost test that still reproduces the causal boundary. A mock is not cheaper
when it removes the provider, browser engine, process race, storage behavior, or security boundary that
caused the failure. Before retaining an expensive regression, record the observed failure, causal
boundary, cheaper tests considered, and why the remaining E2E is the smallest faithful sentinel.

Do not require receipt chains, tool-installation snapshots, executable byte attestations, or repeated
full-suite runs on a moving tree. Exact checkout SHA, deterministic tests, strict runtime parsing, and
one deployed outcome smoke are sufficient infrastructure checks.

Every test run must fail rather than silently skip when its prerequisites were declared required.

## 2. Fast local gate

Run this once the change is ready:

~~~bash
pnpm check
pnpm typecheck
pnpm test
pnpm test:install
~~~

This covers formatting/lint, strict TypeScript, package tests, and the packed standalone CLI. It does
not launch a logged-in Claude, a real browser, Turso Cloud, or a Vercel deployment.

For iteration, select the owning package:

~~~bash
pnpm --filter @remote-claw/clawsec run test:run
pnpm --filter @remote-claw/cli exec vitest run
pnpm --filter @remote-claw/web run test:run
~~~

## 3. Test ownership

| Surface | Primary tests | What they establish |
| --- | --- | --- |
| Crypto and tokens | <code>packages/clawsec/src/*.test.ts</code> | Derivation, AEAD, canonical AAD, strict wire parsing, chunking, pass and handoff formats |
| CLI identity and install | <code>packages/cli/src/identity*.test.ts</code>, <code>store.test.ts</code>, <code>scripts/test-installed-cli.mjs</code> | Secret custody, output redaction, wrapper behavior, install artifact |
| Broker transport | <code>packages/cli/src/broker/*.test.ts</code> | Authenticated HTTP/SSE, retries, ordering, and cursor handling |
| Claude private facade | <code>packages/cli/src/host/rc/mitm*.test.ts</code>, <code>session.test.ts</code>, <code>relay.test.ts</code>, <code>launch.test.ts</code> | Strict native intake, worker delivery, translation, fail-stop, and child isolation |
| Anthropic direct client and native companion | <code>packages/cli/src/host/rc/anthropic/*.test.ts</code> | Fixed-origin OAuth transport, exact launch/attach binding, subscribe/history reconciliation, provider-coordinate dedup, fresh-projection restart, conservative writes, and native/projection isolation |
| Pinned OpenCode adapter | <code>packages/cli/src/host/rc/opencode/*.test.ts</code>, focused relay/viewer tests | Exact-session capture, native coordinates and parents, marker correlation, FIFO idle admission, reconnect fencing, interrupt, restart projection, and honest text/interrupt plus read-only MAIN-status capabilities |
| Pinned Codex adapter | <code>packages/cli/src/host/rc/codex/*.test.ts</code>, CLI/relay/viewer tests | Explicit-port loopback and literal same-user managed-socket URL boundaries, UUID/version/platform checks, `historyMode` API selection, supported-text filtering before bounds, `(turnId,itemId)` identity and changed-byte fencing, subscribe/history/readiness, native item correlation and deadline, response-less server requests, disconnect/archive/revert fencing, teardown, dispatch intent, and honest M3a/M3b capabilities |
| Experimental adapters and inference | <code>packages/cli/src/host/rc/tmux/*.test.ts</code>, <code>bedrock/*.test.ts</code> | Current adapter-local contracts and honest capability limits; not full-product parity |
| Broker backends | <code>apps/web/test/broker/*.test.ts</code> | Ordered publish/subscribe, SQLite recovery, Turso locator behavior, retention, handoff storage |
| HTTP routes | <code>apps/web/test/api/*.test.ts</code>, <code>auth.test.ts</code> | Bearer binding, route validation, error mapping, handoff semantics |
| In-process spine | <code>apps/web/test/e2e/*.integration.test.ts</code> | Host, crypto, real broker routes, Workflow runtime, and viewer with only the model faked |
| Viewer logic | <code>apps/web/test/viewer*.test.ts</code> plus focused component tests | Decrypt/order/render, recovery, presence, send state, credential restore |
| Product browser | <code>tests/web/app-e2e/*.spec.ts</code> | Built Next app, durable local broker, persistent host process, mobile UX, WebKit revive |
| Deployed broker | <code>tests/web/app-e2e.preview.config.ts</code> | Exact deployed Preview, real network, default SQLite/Turso path |
| Documentation | <code>tests/web/docs.spec.ts</code> plus Markdown render check | Navigation, mobile rendering, and no malformed lists |

## 4. Pull-request CI

CI is path-scoped. A change should run the jobs that own its changed surface:

| Workflow | Triggered surface | Steps |
| --- | --- | --- |
| <code>clawsec.yml</code> | Crypto package and workspace dependency files | Install, Biome, typecheck, crypto tests |
| <code>cli.yml</code> | CLI, crypto dependency, build/install scripts | Biome, typecheck, deterministic CLI Vitest, packed install smoke |
| <code>web.yml</code> | Web, CLI, crypto, workspace files | Biome, typecheck, theme drift, production Next build, web Vitest |
| <code>web-e2e.yml</code> | Web/client/crypto/browser harness | Browser-harness typecheck, Chromium and WebKit product suite |
| <code>docs.yml</code> | Documentation and docs harness | Rendered docs browser checks |
| <code>deployment-tools.yml</code> | Preview resolver, attester, workflow | Small Node tests for exact deployment binding |

Every ordinary workflow checks out the pull-request head SHA directly, disables persisted checkout
credentials, and asserts the checkout revision. That is source binding, not a product test.

### Browser PR gate

Run locally when viewer behavior, browser transport, CSS, or broker/viewer integration changes:

~~~bash
pnpm --filter remote-claw-web-tests exec playwright install --with-deps chromium webkit
pnpm --filter remote-claw-web-tests run test:app
~~~

The main configuration:

- builds and serves the production Next application;
- uses the durable local SQLite profile;
- runs transcript, handoff, UX, revive, liveness, and send-guard scenarios in mobile Chromium;
- runs the background-to-foreground revive scenario in iPhone WebKit;
- uses one worker and no retry, so a race remains visible.

For visual changes, also run the light/dark screenshot configuration and inspect the images:

~~~bash
cd tests/web
pnpm exec playwright test -c app-e2e.shots.config.ts
~~~

## 5. Conditional gates

### 5.1 Real Claude replacement-mode smoke

This is opt-in because it needs a logged-in Claude, a TTY, the supported Claude version, and a real
inference call:

~~~bash
pnpm --filter @remote-claw/web run test:real-claude
~~~

It proves one viewer-client turn can traverse the current private replacement path and that Claude
remains alive until teardown. It **does not** prove a browser or official-client coexistence.

Use it when private RC interception, launch, translation, or the real Claude compatibility boundary
changes.

### 5.2 Provider-specific checks

The direct Anthropic client remains covered deterministically by its CLI tests. Any change that claims
provider-native behavior must additionally run against a disposable real native session with
sanitized diagnostics.

Retained Claude, OpenCode, and Codex fixtures are sanitized observations for exact historical versions
and protocol claims. The retained Codex fixture remains 0.146.0 history; the supported 0.151.0 M3a
claim comes from current deterministic tests plus the bounded real TUI/two-browser acceptance. Fixtures
do not make products equivalent or satisfy a new coexistence gate. They are research assets, not
ordinary CI or the root Biome/test gate. The one-off capture programs and verifiers live in Git history;
reintroduce a small purpose-specific capture only when a concrete compatibility claim requires it.

OpenCode's live driver suite is an explicit opt-in and must never probe a developer's port 4096 during
ordinary tests:

~~~bash
OPENCODE_URL=http://127.0.0.1:4096 \
RC_OPENCODE_E2E_SESSION=ses_0123456789abcdef \
pnpm --filter @remote-claw/cli run test:opencode-live
~~~

The package script sets `RC_OPENCODE_E2E_RUN=1`; without that exact opt-in the live file skips before
any network call. Once opted in, an unreachable declared target is a failure. This is a narrow
driver/native-seam regression with model-bearing turns; it now compares projected running/idle with an
independent native event reader. It does not replace either the completed real-TUI/two-browser M2
text/interrupt acceptance or the completed separate real two-browser status acceptance.

Bedrock and accountless changes require an explicitly credentialed provider smoke before release of
those surfaces. Accountless means no Anthropic account; the smoke must still prove the expected
AWS/Bedrock and remote-claw credentials are present and safely confined.

### 5.3 Turso and durable-storage checks

SQLite unit and integration tests are part of normal web CI. Run a real Turso check when changing the
cloud locator, create/readiness policy, catalogue, channel-loss handling, or retention:

~~~bash
pnpm --filter @remote-claw/web run verify:turso-404
~~~

The environment must point to a dedicated development Turso scope. Preserve and report request or
invocation identifiers when the provider exposes them; never log tokens.

That live harness has one job: race a cold subscriber against database creation and verify the
bounded readiness gate absorbs the data-plane 404 window. Durable coordinates, channel-loss
classification, terminal fencing, and cursor recovery stay in the deterministic SQLite tests. The
deployed Preview browser smoke covers real Turso publication and subscription through the product
path.

Exit 0 requires at least one Phase-2 connection to observe an open create-to-serve window and the
bounded readiness gate to absorb it. Missing credentials, provider/creation failure, or a run in which
Phase 2 never opens the window exits 2 as inconclusive and must be rerun; a post-gate 404 or readiness
timeout exits 1 as a regression.

### 5.4 Stress

The bounded in-process transport stress suite drives the local and experimental Vercel backends in
ordinary web Vitest. Deterministic SQLite tests own durable-store ordering and recovery; the deployed
Preview smoke owns the configured production SQLite/Turso path. Do not label those three distinct
boundaries as one all-backend stress proof. Add a SQLite/Turso stress case only when a demonstrated
failure mode needs volume or concurrency to reproduce it. The scheduled/manual
<code>web-stress.yml</code> workflow adds only the opt-in heavy local profile:

~~~bash
pnpm --filter @remote-claw/web run test:stress:heavy
~~~

Stress is not a per-edit gate. Use it for backend concurrency, stream ordering, retention, or large
frame changes and as a scheduled regression signal.

### 5.5 Deployed Preview

The deployment smoke is triggered from a trusted default-branch dispatch after Vercel reports a
Preview deployment. It:

1. resolves a GitHub deployment id to an immutable Preview on <code>main</code>;
2. checks out that exact deployment SHA;
3. queries `/api/health/deployment` and requires the same SHA and intended storage profile;
4. uses the protected environment only for the Vercel automation bypass;
5. runs one real-browser outcome sentinel against the deployed default SQLite/Turso backend: discover
   the host session, deliver one prompt, reload, and verify exact replay.

The browser run retains no credential-bearing trace, screenshot, or video. A missing deployment,
wrong SHA, wrong storage profile, absent bypass, or incomplete browser turn is a failure, not a
successful receipt with caveats.

### 5.6 Handoff enablement — disclosure plus WAF

In-process route tests prove body limits, expiry, atomic single-use claim, and uniform misses; they
cannot prove an edge provider's per-IP rule. Before setting
<code>NEXT_PUBLIC_RC_HANDOFF_ENABLED=1</code>, require a browser test of the pre-claim authority disclosure
and run the outside-in bounded-burst procedure in
[Ephemeral one-time credential handoff §5](ephemeral-handoff.md#5-decisions-enabled-feature-must-haves-non-goals)
from one external source IP, retaining the provider rule identifier and telemetry. If either check is
not green or cannot be repeated, leave handoff off. The conditional WAF check is not part of ordinary CI
and does not block manual-pass onboarding while the feature remains disabled.

## 6. Security regression matrix

| Boundary | Required behavior |
| --- | --- |
| Secret file | Create atomically; reject symlink, non-file, insecure mode, malformed token |
| CLI output | Root secret appears only on explicit create/reveal paths; passes and provider credentials never leak into diagnostics |
| Viewer-pass UX | Manual join and any enabled pairing path label the pass as indefinite machine-identity-wide read/control/forge authority for mutually trusted holders, not a room-scoped or individually revocable invitation; pairing distinguishes the one-time link from the pass it recovers before claim |
| Broker target | Exact root origin only; remote HTTP, credentials, paths, queries, and fragments fail before identity/network; an ambient Vercel bypass is sent only when the remote HTTPS target canonically equals `RC_APP`, never to loopback, and credential-bearing requests refuse redirects |
| Bearer routing | Recompute identity id; reject cross-identity and cross-session frames |
| Wire intake | Snapshot only known own-data properties; ignore unknown extension fields; reject missing, noncanonical, oversized, and malformed known fields before decrypt or native mutation |
| AEAD | Authenticate every visible header and chunk coordinate; tamper or wrong key fails |
| Dedup | Authenticate first; exact durable replay is idempotent; changed replay is terminal |
| Native intake | Closed event set, exact session/epoch coordinates, stable UUID semantics |
| Ambiguous write | No automatic fresh-id retry; expose unknown outcome and reconcile |
| Durable restart | Require both sequence and publish-order cursors; never replay old commands from zero |
| Presence | Future-skew, stale, terminal, and unauthenticated records cannot enable controls |
| Handoff | Default-off; bounded body, short TTL, single-use atomic claim, uniform miss, external per-IP rate limit, and pre-claim disclosure that the resulting pass remains indefinite and machine-wide |
| Logging | Redact credential-shaped values; discard broker-controlled rejection/SSE/parser/invalid-success detail from normal errors; bound trace bodies; refuse unsafe trace-file targets |
| Failure isolation | Remote projection can stop without killing the user's healthy local native session |

## 7. Claude native coexistence acceptance

### M0 lower-fidelity baseline — observed 2026-08-24

A bounded real run used Claude Code 2.1.237, the existing tmux driver, Claude's own
<code>--remote-control</code>, one local pane, one host-side Anthropic Remote API client, and two
independent Chromium contexts. Four labelled submissions appeared exactly once in provider history and
both browsers; browser reload added no duplicate; killing the broker left the wrapper, pane, and native
provider session live. The temporary experiment was removed after recording the result because its
value was the architecture decision, not a permanent new proof harness.

This run did not exercise the official Claude web/mobile UI and does not promote tmux to structured or
exactly-once peer collaboration.

### M1 structured Claude native acceptance — complete

On 2026-08-30, a production-built local SQLite broker and exact Claude Code 2.1.237 exercised the
implemented <code>claude-native</code> path. One local-TUI prompt and prompts from two simultaneous
remote-claw Chromium contexts were accepted by Anthropic, answered by Claude, and rendered once in
both browsers. A separate authenticated <code>AnthropicRcClient.postEvent</code> prompt traversed the
same live session and was also rendered once in both browsers. Deterministic tests own binding,
subscribe-before-history overlap, both client/worker echo orders, reconnect reconciliation, reused or
regressing provider coordinates, unsupported controls, and ambiguous POST fencing.

That run proved the structured provider API path and multiple-viewer outcome. It did not by itself
prove a literal official Claude web/mobile UI interaction; that separate boundary was exercised in the
final run below.

A second bounded run used the packed-installed CLI and exact Claude version. Two attach-only companion
processes successively projected the same explicitly named live native session into fresh remote-claw
rows. The second backfilled the first row's local, browser-A, browser-B, and API turns once, then applied
one post-restart browser turn once. Killing the local SQLite broker made only the companion fail; the
native TUI immediately completed another turn. Provider history held one user event and one answer for
each label. Exact scans of owned mode-0600 logs and raw broker files found none of fourteen tested
provider/root/pass/bypass credentials, and raw broker storage contained none of the six plaintext
labels. Deterministic tests own the retired-channel and committed-but-response-lost no-repeat cases.

Evidence is cumulative by causal boundary; M1 does not require every green failure and delivery case to
be repeated in one provider marathon. Those runs plus deterministic tests own launch binding,
local/browser/API text, reload, restart, retired-channel fencing, broker-loss isolation, installed-
package use, and the bounded credential/storage inspection.

The final bounded run kept exact Claude 2.1.237, the real local TUI, two independent remote-claw
Chromium contexts, and the literal logged-in official Claude web UI on the user's phone using one
ordinary Anthropic RC session. A browser-labelled turn and reply appeared once in both browser views;
the official client also displayed that browser turn, then submitted its own labelled turn and its
reply, which appeared once in both views, while the local TUI visibly observed the official turn and
answer. Those browser assertions were populated from canonical provider history/SSE. A separate direct
provider-history recount was unavailable under the current host credential and is not claimed; the
earlier API-path run owns that transport-read boundary. After the official client disconnected,
another browser turn and reply appeared once in both views and the native TUI remained live. That
closes the literal-client boundary without replaying the already-green restart, broker-loss,
credential/storage, and deployment scenarios.

Trusted Preview run 33323332395 passed the separate deployment item against exact deployed commit
<code>bcab0c9c0fa6ad036f4996b9d0f0540aebec4d26</code>. It bound the served runtime to that SHA and the
configured default SQLite/Turso profile, then passed browser discovery, host receipt, and reload replay.
It used no live Claude or provider credential.

The initial launch must use
<code>--rc-app &lt;origin&gt; --rc-driver=claude-native --remote-control</code>. Companion-only restart uses
<code>--rc-app &lt;origin&gt; --rc-driver=claude-native --rc-native-session &lt;cse_...&gt;</code> with no
forwarded Claude arguments. Neither may use the default <code>--rc-driver=mitm</code> /
<code>runRcLaunch</code> replacement path: it cannot satisfy official-client coexistence by design, and
trace mode cannot connect remote-claw browsers.

M1 and the bounded Codex M3b live gate are complete. CI green alone still does not establish broader
Codex/OpenCode tuples, tmux, Bedrock/accountless, or the full product matrix.

## 8. OpenCode M2/status, Codex M3a/M3b, and remaining adapter acceptance

On 2026-08-30, the exact supported OpenCode 1.17.5/Linux arm64/Bedrock Sonnet tuple passed with the
real TUI and two independent browser contexts. Its OpenCode server used `AWS_REGION=us-west-1` plus
explicit temporary SigV4 credential environment values; other regions or credential modes need their
own gate. OpenCode generated the ordered native IDs; browser A and B correlated through their exact
`prt_rc_*` markers. TUI/browser turns appeared once, reload left the native-history SHA-256 unchanged,
a browser interrupted a genuinely busy turn and then completed a later turn, and companion-only
restart against the same `ses_*` created a fresh projection with the identical history SHA-256 and
every old command once. Deterministic tests own malformed or reused coordinates, parent/order rules,
FIFO and busy/retry admission, local-user exclusion, live-idle history/status reproof,
reconnect-before-write, ambiguous writes, broker projection loss, and no teardown abort.

That 2026-08-30 M2 run did not prove viewer status. The current follow-on advertises
<code>status:true</code> for read-only MAIN state: native <code>busy</code>/<code>retry</code> maps to
running; ordinary idle requires exact history/status reproof; child activity never drives MAIN; SSE
loss retains the last verified viewer state while admission pauses; reconnect reproof converges it;
and a MAIN error instead re-reads exact status without opening admission. Deterministic driver, relay,
and viewer tests own those startup/live/reconnect/child/error boundaries. The separate real gate used
one installed OpenCode 1.17.5 session in which two independent browsers observed the same MAIN
running-to-idle turn; it passed at 2026-08-31T05:09:54Z on Linux arm64 with the pinned Bedrock Sonnet,
<code>us-west-1</code>, temporary SigV4 environment credentials, and an attached TUI. Both Chromium
contexts showed and cleared “working,” with one user and assistant copy each. Permissions, questions,
remaining controls, model/mode, attachments, and end remain unchanged.

The exact Codex 0.151.0/Linux arm64 M3a tuple also passed on 2026-08-30 with the production web build,
durable SQLite broker, one attached real TUI, and two independent Chromium contexts on one exact
app-server thread. Uniquely labelled TUI/A/B turns and replies appeared once in both browsers and the
TUI. One native approval was declined only in the TUI with no side effect; one native question was
answered only in the TUI. The companion returned neither a result nor error for those global first-
response-wins requests and stayed live. Clean companion stop left app-server, TUI, and thread live.
The real gate is retained because cross-process request fan-out and local TUI ownership cannot be
faithfully established by a mock. It is a bounded acceptance outcome, not a permanent raw-probe suite.
Focused tests own the deterministic boundaries listed in the ownership table. Restart/backfill and a
live broker-loss run are not claimed.

M3b used an exact official Remote thread on Codex 0.151.0/Linux arm64, literal `unix://` to Codex's
same-user managed control socket, and `historyMode:"legacy"` full-turn hydration. The attached local TUI
remained the sole approval/question owner. A provider-origin marker appeared exactly once in two
independent browsers. A browser-origin prompt and acknowledgement appeared exactly once in the official
thread, TUI, and both browsers, and the sending browser showed its host receipt. An ephemeral provider
transport then stayed disabled while a browser-B turn completed; the managed daemon, TUI, companion,
and both browsers stayed live before provider transport restored to connected.

That failure step proves provider-transport isolation, not per-device unsubscribe: the gate did not
selectively disconnect one official provider device while retaining another. It also did not exercise
richer controls, attachments, companion restart/backfill, or broker-loss. Deterministic tests continue
to own URL boundaries, both history modes, filtering, `(turnId,itemId)` identity, changed-byte fencing,
and the other adapter invariants in the ownership table.

The later milestones use the same shared security checks but keep product-specific truth:

| Surface | Required real outcome |
| --- | --- |
| OpenCode status follow-on | Complete: one installed exact 1.17.5 session's MAIN running-to-idle transition was observed consistently by an attached TUI and two independent Chromium contexts; this does not reopen M2 |
| OpenCode beyond M2 | Each added version, platform, model, permission/control family, or native collaboration surface needs its own exact tuple and bounded outcome; it does not reopen the completed text/interrupt tuple |
| Codex beyond M3a/M3b | Later versions, platforms, controls, attachments, restart/backfill, broker-loss, and any per-device unsubscribe claim need their own bounded outcome without reopening the completed exact-tuple text/status/coexistence result |
| tmux | Recoverable local pane plus two browsers, with conservative injection states and no claim of independent peer ordering or exactly-once native application; any advertised Claude Remote coexistence uses the official Claude client UI |
| Provider/account mode | Credentialed inference smoke for every exact advertised agent/provider/model/region/account-mode/capability tuple; no Anthropic account/API when claimed, while required provider and remote-claw credential handling is verified |

OpenCode creation is not part of the M2 release path. The client's retained create helper and its
focused ambiguity regression are future plumbing, not an advertised capability.

Passing one row does not turn an untested row green. Agent collaboration and inference routing are
orthogonal, so a Bedrock model response does not prove OpenCode/Claude collaboration and vice versa.

## 9. Release decision

After the candidate bytes are frozen:

1. Run the fast local gate once.
2. Run the path-relevant conditional gates once.
3. Obtain one independent code and documentation review.
4. Require the ordinary path-scoped CI checks to be green.
5. Run the exact-SHA deployed Preview smoke only when deployment/broker routing changes or the release
   claim depends on that deployment.
6. Run the acceptance for each product surface whose support claim changes.

A later code, schema, workflow, or deployment change invalidates only the gates whose tested surface
changed. Documentation-only clarification does not require replaying provider or cloud fault tests.

Green is evidence about the named scenario. It is not a reason to add another layer of self-checking
machinery.
