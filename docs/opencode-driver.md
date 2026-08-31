# OpenCode 1.17.5 text/interrupt/status driver

`--rc-driver=opencode` attaches remote-claw to one already-running OpenCode session through the
OpenCode HTTP/SSE server. M2 is complete for one frozen tuple:

- Linux arm64;
- exact OpenCode 1.17.5;
- `amazon-bedrock/global.anthropic.claude-sonnet-4-6`;
- `AWS_REGION=us-west-1` plus explicit temporary SigV4 credential environment values in the OpenCode
  server process;
- one caller-supplied existing canonical `ses_*` over literal loopback; and
- non-empty non-slash browser text plus interrupt.

That list records the completed M2 acceptance boundary. A later bounded follow-on now advertises
read-only MAIN-session running/idle status. Its implementation and separate real-TUI/two-browser
acceptance are complete; this does not change the 2026-08-30 M2 evidence.

Other OpenCode versions, platforms, models, permission graduation, controls, and collaboration
surfaces are not implied by that support claim. The external OpenCode process owns the native
conversation and TUI. remote-claw creates a fresh synthetic `cse_*` projection for its broker and
viewers; restarting the companion against the same `ses_*` creates another fresh projection of the
same bounded native history.

## 1. Topology and configuration

```text
OpenCode TUI ─┐
              ├─ opencode serve ⇄ OpencodeDriver ⇄ Session ⇄ encrypted broker/viewers
model provider┘
```

The driver neither starts nor stops `opencode serve`, and it does not use the Claude MITM. It accepts
no forwarded Claude or OpenCode arguments. The supported configuration is:

- `--rc-oc-url` or `OPENCODE_URL` — an explicit-port `http://127.0.0.1:<port>` or
  `http://[::1]:<port>` origin; default `http://127.0.0.1:4096`. Credentials, query, fragment,
  redirects, hostnames, non-loopback addresses, non-root paths, and HTTPS are rejected. A trailing root
  slash is accepted and normalized away.
- `--rc-oc-session` or `RC_OC_SESSION` — required exact existing canonical `ses_*`.
- `--rc-oc-model` or `RC_OC_MODEL` — must be exactly
  `amazon-bedrock/global.anthropic.claude-sonnet-4-6`.
- `OPENCODE_SERVER_USERNAME` — Basic-auth username; default `opencode`.
- `OPENCODE_SERVER_PASSWORD` — optional Basic-auth password. Its bytes are preserved and never
  logged. No Authorization header is sent when it is absent.
- `--rc-oc-mirror-permissions` or `RC_OC_MIRROR_PERMISSIONS=1` — experimental positive opt-in to
  policy mutation and browser permission replies. It is off by default and outside M2.

`--rc-oc-skip-permissions` is retired and is a usage error. Permissions remain native/local by
default, so an inverse flag is unnecessary.

The OpenCode server process must receive the region and credentials its model provider requires.
The `global.` Bedrock inference profile selects a cross-region model, but the AWS SDK still requires
a region. OpenCode 1.17.5 did not consume the normal shared AWS configuration in the acceptance run.
Other regions or credential modes require their own gate. remote-claw does not acquire provider
credentials or send them through the browser.

## 2. Fail-closed exact attachment

The supported path never lists, discovers, selects, or creates the attached root native session. It
does follow child sessions announced from that root. Before publishing presence it:

1. proves exact OpenCode version 1.17.5 through `GET /global/health`;
2. confirms that `GET /session/{id}` returns the exact configured `ses_*`;
3. opens the server-wide SSE stream and requires `server.connected` as its first event;
4. re-proves the exact version and session behind that live stream;
5. strictly reconciles bounded history, message order, assistant parents, and the exact session's
   status; and
6. starts the broker bridge once with the final capability vector.

Until all six steps pass, no broker client or presence announcement exists and no browser write can
reach OpenCode. A malformed response, changed identity, unsupported version, over-limit history,
missing SSE readiness marker, or indeterminate status fails closed.

The client retains strict create, list, and summarize helpers as research/test plumbing. None is a
capability or code path of the supported M2 companion.

## 3. Native HTTP and SSE surface

The release path uses this subset:

| Purpose | Native route |
| --- | --- |
| Pin version | `GET /global/health` |
| Confirm exact session | `GET /session/{id}` |
| Reconcile exact status | `GET /session/status` |
| Read bounded history | `GET /session/{id}/message?limit=4097` |
| Send text | `POST /session/{id}/prompt_async` |
| Interrupt | `POST /session/{id}/abort` |
| Follow native events | `GET /event` |

History accepts at most 4,096 messages and 4,096 total parts. OpenCode 1.17.5 omits idle sessions
from `/session/status`, so an absent exact key means idle; a present value must be exactly `idle`,
`busy`, or `retry`. That snapshot corroborates history but is not treated as a native atomic lock.

HTTP errors expose only stable operation and status information. Native response bodies, credentials,
and provider messages do not enter diagnostics. The SSE reader is bounded, filters exact session
identity from all supported event shapes, and follows child sessions discovered from a followed
parent. Session-less events other than `server.*` are dropped rather than broadcast across sessions;
the deliberate predicate-stream exception is `session.created`, which can carry a new child's identity
only inside that event.

## 4. Canonical capture

OpenCode generates the canonical native message IDs. The accepted form is
`msg_<12 lowercase hex><14 Base62>`, and their lexical order is the native chronological order. The
driver never supplies a message ID for a browser turn. It preserves a projection-long immutable
ledger and requires every reconciliation to retain all prior coordinates and append only a new suffix.
Changed, removed, reordered, cross-session-reused, or behind-order coordinates terminate the
projection. An exact repeated live coordinate with the same retained projection semantics is a no-op;
a duplicated row inside one history response is malformed.

Every new assistant must name the latest preceding native user as its `parentID`. An already-known
assistant may continue receiving part updates after a later steering user appears, but its parent may
not change. OpenCode emits whole part replacements rather than token deltas; the driver buffers one
message and emits it once complete. A mid-turn attach waits for completion rather than publishing a
partial assistant as final.

For browser text, the host derives an exact part marker from its canonical downstream event UUID:

```text
prt_rc_<32 lowercase hexadecimal UUID characters, without hyphens>
```

`prompt_async` sends that marker as the text-part ID and deliberately omits `messageID`. The browser
turn is correlated only after capture observes one complete OpenCode-generated user message whose
marker's text and full user-message text both equal the original accepted bytes. A missing, changed,
merged, repeated, or partial marker fails closed. The marker is a correlation coordinate, not an
idempotency key.

Both browser-origin and TUI-origin user rows enter the shared transcript at this canonical native
observation. The browser's authenticated `client_msg_id` is retained only as a viewer reconciliation
coordinate. Canonical transcript order and UUID come from OpenCode.

The understood part translation remains intentionally bounded:

| OpenCode part | Canonical viewer block |
| --- | --- |
| text | `text` |
| reasoning | `thinking` |
| pending/running tool | `tool_use` |
| completed/failed tool | `tool_use`, then user-role `tool_result` |
| subtask | `Task` `tool_use` anchor |
| housekeeping or unknown | dropped |

Live child sessions are nested under a parent Task when the observed parent, agent, and FIFO anchor
can be matched. The native subtask part carries no child-session ID, so concurrent same-agent children
under one parent can still be display-misnested. This limitation does not drop or reroute a native
mutation and is not a richer subagent-parity claim.

## 5. Text and interrupt admission

The relay rejects blank text and text whose trimmed start begins with `/`; all other accepted text
bytes are preserved. Unsupported control families are capability-gated and harmless if an old or
handcrafted client sends them. The supported actions are:

| Browser event | Native result |
| --- | --- |
| ordinary text | FIFO wait, atomic transport+idle claim, one `prompt_async`, exact marker+text correlation, then downstream event acknowledgement |
| interrupt | wait for trustworthy transport, one `abort`, require literal JSON `true`, then downstream event acknowledgement |
| initialize | no native mutation |
| model, mode, status mutation, end, attachment, slash command | unsupported; no native mutation |

One process-local latch owns both transport trust and native-idle admission. A text writer claims both
conditions synchronously and consumes idle before posting. Browser turns wait FIFO. A newly observed
local native user closes admission immediately; native `busy` and `retry` never open it.

A live `session.idle` event is only a trigger. The capture owner must re-read strict bounded history
and `/session/status`. For an active browser turn, the exact marker must remain the latest native user
and the turn must have crossed a native busy epoch before live idle releases the next writer. This
prevents a stale or unrelated idle event from admitting concurrent text.

SSE loss pauses transport admission while retaining the last verified viewer status. Before any write
resumes, reconnect must establish a new ready stream and re-prove exact version, exact session, strict
history and parents, browser correlation, and exact status; that reproof converges the viewer state.
Failure to prove continuity closes the writable projection.

A MAIN `session.error` surfaces the failure, then re-reads exact native status for the viewer without
opening write admission or clearing browser correlation. Child errors never drive MAIN status.

Prompt and interrupt are separate irreversible native HTTP boundaries. Each receives one attempt. A
rejection, timeout, malformed acknowledgement, or response-unknown outcome is never retried and fences
the projection. This is fail-closed ambiguous-outcome handling, not native idempotency.

## 6. Permission posture

The supported M2 path leaves OpenCode's native policy unchanged and advertises structured permissions
as false. That means the browser cannot answer native gates; it does not mean “permissions off,” “all
tools allowed,” or “remote-claw bypasses policy.” OpenCode and its local UI remain authoritative.

The positive `--rc-oc-mirror-permissions` opt-in is experimental. It adds a catch-all `ask` rule to the
parent and best-effort followed children, exposes `permission.asked`, and maps explicit viewer allow to
native `once`; deny or malformed input maps to `reject`. OpenCode's policy update is append-only, so a
rule the driver adds can persist after teardown. Child first-tool and competing-local-answer races also
remain. These limits are why mirroring is default-off and outside M2.

## 7. Advertised capabilities

The default supported vector is:

| Capability | Value | Meaning |
| --- | --- | --- |
| Structured permissions | false | policy and gates stay native/local |
| Status | true | read-only MAIN status: native `busy`/`retry` maps to running; ordinary idle requires exact history/status reproof |
| Interrupt | true | exact-session native abort |
| Set model | false | tuple is pinned |
| Set mode | false | no graduated mapping |
| End | false | companion does not own the native session |
| Attachments | false | no proved native file-part fidelity |

Experimental permission mirroring changes only `structuredPermissions` to true after its parent rule
is installed and read back. It does not graduate any other capability. Attachment rejection happens
before reassembly or file writes.

## 8. Teardown and restart

The external OpenCode session is never companion-owned. Only an admitted authenticated browser
interrupt calls native `/abort`. Cancellation, broker loss, capture failure, companion restart, and
ordinary teardown close the remote-claw projection without aborting the native turn or stopping the
server.

A restart must name the same exact `ses_*`. It creates a fresh `cse_*`, opens a fresh stream, and
reconciles the same bounded native history before publishing presence or accepting writes. Old broker
commands are not consumed by the new projection. Stable same-row adoption, a durable native binding,
and history beyond the current bound are future capabilities, not hidden M2 claims.

## 9. Acceptance and deterministic ownership

The 2026-08-30 release acceptance passed on the exact supported tuple with the real OpenCode TUI and
two independent browser contexts. It verified:

- OpenCode-generated native message IDs and exact `prt_rc_*` marker correlation for browser A and B;
- TUI and browser turns appearing once in native order on both browsers;
- an immutable reload with an unchanged native-history SHA-256;
- interrupt of a genuinely busy turn followed by a successful continuation;
- companion-only restart against the same exact `ses_*`, a fresh projection, and identical history
  SHA-256; and
- every old command appearing once after restart.

Focused client, driver, relay, and viewer tests own malformed or reused coordinates, parent/order
invariants, FIFO and busy/retry admission, local-user exclusion, live-idle reproof, reconnect-before-
write, ambiguous mutation fencing, broker-projection loss, and no teardown abort.

The status follow-on adds deterministic ownership for startup idle/busy/retry, live MAIN
running-to-reproved-idle, child isolation, retained last-known status during SSE loss, reconnect
convergence, and exact-status reread after a MAIN error without reopening admission. At
2026-08-31T05:09:54Z, the exact OpenCode 1.17.5/Linux arm64/pinned Bedrock Sonnet/
`us-west-1` temporary-SigV4-environment tuple passed its separate status acceptance: an attached TUI
drove the MAIN session from native busy to idle, two independent Chromium contexts both showed and
cleared “working,” and each displayed one user and assistant copy.

The optional package live suite remains a narrower driver/native-seam check:

```bash
OPENCODE_URL=http://127.0.0.1:4096 \
RC_OPENCODE_E2E_SESSION=ses_0123456789abcdef \
pnpm --filter @remote-claw/cli run test:opencode-live
```

It requires the script's explicit `RC_OPENCODE_E2E_RUN=1` opt-in and never probes a coincidental local
server during ordinary tests. That suite compares projected status with an independent native event
reader, but it does not replace the completed real two-browser status acceptance. The earlier real-
TUI/two-browser acceptance remains the historical M2 text/interrupt product proof.

The retained [OpenCode protocol fixture](opencode-native-proof.md) records narrower 1.17.5 API
observations. It is research evidence, not runtime authority or a broader compatibility promise.
