# remote-claw architecture

This document separates the shared system that exists now from the adapters still needed for the full
multi-agent product. The executable protocol contract is in [Protocol & Runtime](protocol.md), and
the milestone sequence is in [Product goal and release gates](release-finish-line.md).

## 1. Product outcome and current status

remote-claw is intended to add encrypted browser clients to Claude Code, Codex, OpenCode, and an
honest tmux fallback without taking away a native surface:

~~~text
local native TUI ───────────────────────┐
official provider remote ── when offered├── native conversation
remote-claw browsers ⇄ sealed broker ⇄ host adapter
~~~

The full outcome is **not implemented**. Each product adapter must preserve its local TUI, support at
least two remote-claw browsers, and preserve provider-native collaboration where available (including
Claude Remote Control and Codex/ChatGPT Remote). Tmux is deliberately lower fidelity and must say so.

Agent adapters and model routing are orthogonal. Anthropic, OpenAI, and Bedrock are inference routes,
not collaboration architectures. “Accountless” means no Anthropic account; it still requires
AWS/Bedrock credentials and remote-claw credentials.

What exists today:

| Surface | As-built status |
| --- | --- |
| Identity, viewer pass, sealed frames, broker, durable log, and browser viewer | Implemented; the Graduate commit's exact-SHA Preview gate passed against the configured SQLite/Turso broker |
| Default <code>--rc-app &lt;origin&gt; --rc-driver=mitm</code> | Implemented private replacement mode; the official client cannot join |
| <code>--rc-trace</code> | Implemented transparent inspector; the official client works, but no remote-claw browser is connected |
| Direct Anthropic RC client | Implemented and wired into the Linux/exact-2.1.237 <code>claude-native</code> companion |
| Claude native collaboration plus multiple remote-claw browsers | M1 complete on Linux/exact-2.1.237: structured provider-ordered text, local TUI, literal official web UI on the user's phone, two browsers, Graduate restart/isolation, and exact-SHA deployed-broker acceptance |
| OpenCode server adapter | M2 complete for exact 1.17.5/Linux arm64, the pinned Bedrock Sonnet model, one explicit session, non-empty non-slash text, interrupt, and fresh-projection restart |
| tmux fallback | Experimental lower-fidelity implementation with documented limits |
| Codex | M3a/M3b complete for exact 0.151.0/Linux arm64: native text/status, TUI-owned approvals/questions, two browsers, bounded same-thread official Remote coexistence through the managed Unix socket, and provider-transport isolation; per-device unsubscribe, richer controls, restart/backfill, and broker-loss are not claimed |
| Bedrock and no-Anthropic-account launch | Experimental inference/account paths, separate from adapter fidelity |

The current private relay is useful product infrastructure, but no single adapter is the whole
product.

## 2. As-built system map

The private Claude replacement (`mitm`) path is:

~~~text
┌──────────────── browser ────────────────┐
│ pass → keys → decrypt/render            │
│ prompt → seal control/content frame     │
└─────────────────┬───────────────────────┘
                  │ HTTPS: bearer + routing metadata + ciphertext
┌─────────────────▼───────────────────────┐
│ Next.js broker                          │
│ authenticate, validate, order, persist  │
│ never decrypt conversation frames       │
└─────────────────┬───────────────────────┘
                  │ HTTPS/SSE ciphertext
┌─────────────────▼───────────────────────┐
│ remote-claw host wrapper                │
│ decrypt, translate, seal native output  │
└─────────────────┬───────────────────────┘
                  │ loopback TLS proxy
┌─────────────────▼───────────────────────┐
│ Claude Code native RC worker            │
└─────────────────────────────────────────┘
~~~

The repository has three production components:

- **packages/clawsec** is the WebCrypto-compatible key, token, AEAD, chunking, handoff, and wire
  package shared by Node and the browser.
- **packages/cli** is the transparent Claude wrapper, local identity store, broker transport,
  private RC facade, trace inspector, provider-native RC companion/client, pinned OpenCode HTTP/SSE
  companion, and pinned Codex app-server companion.
- **apps/web** is both the authenticated ciphertext broker and the mobile-first viewer.

There is no required host daemon or plaintext cloud service in the current path. Each wrapper process
owns its process-local projection and binding; externally owned Claude-native and OpenCode sessions
outlive companion failure or restart. The externally owned Codex app-server, thread, and attached TUI also
outlive its companion. Sessions sharing one secret are grouped under one logical host identity.

## 3. Identity and key hierarchy

### 3.1 Root secret and logical host identity

The root is a random 32-byte secret, formatted as an <code>rc1_</code> token with a typo-detecting
checksum. It lives in one local file. The default path is:

~~~text
$XDG_STATE_HOME/remote-claw/secret
~~~

or, when XDG state is unavailable:

~~~text
~/.local/state/remote-claw/secret
~~~

<code>--rc-file</code> and <code>REMOTE_CLAW_SECRET_FILE</code> can select another file. The identity
therefore represents a logical host profile, not a hardware identity. The CLI refuses symlinks,
non-regular files, and group- or other-readable secret files on POSIX.

Identity creation is create-once. <code>--rc-identity</code> prints the master token only when it
creates it; <code>--rc-show-secret</code> is the explicit re-reveal path. Quiet and JSON output do not
contain the root secret.

### 3.2 Derivation

All operational material is derived with HKDF-SHA256:

~~~text
PRK          = HKDF-Extract("remote-claw/v1", S)
auth_token   = HKDF-Expand(PRK, "remote-claw/v1/auth", 32)
identity_id  = first 16 bytes of SHA256(auth_token)
content_root = HKDF-Expand(PRK, "remote-claw/v1/content", 32)
control_key  = HKDF-Expand(PRK, "remote-claw/v1/control", 32)
K_meta       = HKDF-Expand(PRK, "remote-claw/v1/meta-frame", 32)
K_session    = HKDF-Expand(content_root, "session:" + session_id, 32)
~~~

The keys are domain-separated:

| Material | Purpose | Broker visibility |
| --- | --- | --- |
| <code>auth_token</code> | Bearer admission for one identity | Visible to the HTTPS endpoint |
| <code>identity_id</code> | Public routing id | Visible |
| <code>content_root</code> and <code>K_session</code> | Per-session transcript content | Never sent |
| <code>control_key</code> | Viewer-to-host control frames | Never sent |
| <code>K_meta</code> | Presence, acknowledgements, and session metadata | Never sent |

The broker recomputes <code>identity_id</code> from the presented bearer. A bearer for one identity
cannot publish a frame labelled as another identity.

### 3.3 Viewer pass

An <code>rcp1_</code> pass contains the four operational 32-byte values:
<code>auth_token</code>, <code>content_root</code>, <code>control_key</code>, and
<code>K_meta</code>. It does not contain the root secret, and the identity id is recomputed from the
auth token.

A pass holder can read and steer every session under that identity and can create valid symmetric-key
frames. Pass holders are mutually trusted. There is no per-device role and no individual pass
revocation.

Replacing the root secret creates an unrelated identity. It moves future legitimate service only
after all wrappers using the old secret stop. It does not invalidate copied old passes against old
routes or erase retained ciphertext.

## 4. Frame security and visible metadata

### 4.1 Sealing

The normal host and viewer paths use sealed mode. For each frame:

1. Choose the session, control, or metadata plane key.
2. Generate a fresh 32-byte salt and 12-byte nonce.
3. Derive a per-message key with HKDF using the plane key, salt, and canonical header bytes.
4. Encrypt with AES-256-GCM and bind the same canonical header as additional authenticated data.

The canonical header contains:

~~~text
v, identity_id, session_id, dir, record_kind, seq, msg_id,
client_msg_id?, key_epoch, part, parts
~~~

Changing a route, direction, sequence, message id, chunk coordinate, or record kind causes
authentication to fail. The wire decoder also bounds and validates all fields before crypto.

Large plaintexts are chunked before publication. Chunk coordinates are authenticated, and the relay
route caps decoded ciphertext so Vercel can return a deterministic application error before its
platform request-size limit.

### 4.2 What zero knowledge means here

For sealed broker traffic, the broker can see:

- the admission bearer at its HTTPS boundary;
- identity and session routing ids;
- direction, record kind, sequence, message and chunk coordinates;
- ciphertext size, timing, backend choice, and network metadata.

It cannot derive the content, control, or metadata keys from the bearer and cannot authenticate
changed frame bytes. It can still delay, drop, replay, or withhold captured ciphertext. Availability,
traffic analysis, and rollback of the service as a whole are outside the confidentiality claim.

Anthropic is not part of this zero-knowledge claim. In the default Claude mode Anthropic performs
inference, and in the selected companion architecture Anthropic also hosts the native RC log. It
necessarily sees provider-native plaintext.

The served web application is also a trust boundary. Encrypting a pass at rest in the browser does not
protect it from malicious same-origin JavaScript while the viewer is active. Deployment integrity,
dependency review, CSP, and XSS prevention remain necessary.

## 5. Broker channels and HTTP surface

Two derived channel kinds carry all normal traffic:

- <code>bus:presence-v2:&lt;identity_id&gt;</code> carries only
  <code>session_announce</code> and <code>session_terminal</code>.
- <code>sess:&lt;identity_id&gt;:&lt;session_id&gt;</code> carries one session's content,
  control, acknowledgements, and recovery traffic.

The broker is addressed by value; it does not need a plaintext session registry.

Core endpoints:

| Endpoint | Purpose |
| --- | --- |
| <code>POST /api/relay</code> | Publish one bus frame |
| <code>POST /api/relay?session=&lt;id&gt;</code> | Publish one per-session frame |
| <code>GET /api/stream?startIndex=&lt;n&gt;</code> | Subscribe to the identity bus as SSE |
| <code>GET /api/stream?session=&lt;id&gt;&amp;startIndex=&lt;n&gt;</code> | Subscribe to a session as SSE |
| <code>GET /api/seq?session=&lt;id&gt;</code> | Read durable transcript-sequence recovery capability |
| <code>GET /api/frame-count?session=&lt;id&gt;</code> | Read durable publish-order recovery cursor |
| <code>PUT /api/handoff</code> | Store an opaque, short-lived pairing box |
| <code>POST /api/handoff</code> | Atomically claim and burn a pairing box |

Identity-scoped routes require <code>Authorization: Bearer &lt;hex auth_token&gt;</code>.
<code>/api/handoff</code> is deliberately different: it is an unauthenticated high-entropy capability
route with bounded bodies, short TTL, single-read semantics, and a required edge rate limit.

<code>?backend=</code> or <code>x-broker-backend</code> can select a permitted backend. Publishers and
subscribers for one channel must select the same backend.

## 6. Ordering, presence, and recovery

### 6.1 Presence

The host seals a session announcement on the identity bus when a native session becomes ready and
normally refreshes it every 20 seconds. The viewer treats a valid announcement as connected for
45 seconds. A canonical terminal frame permanently absorbs later announcements for that session in
the durable backend.

On cold start the viewer tails the last 64 bus frames. This is a bounded presence view, not a complete
offline session directory.

### 6.2 Session ordering

The host assigns transcript sequence numbers. The viewer:

- authenticates before deduplication;
- buffers out-of-order content until gaps fill;
- deduplicates replayed message coordinates;
- keeps transport offsets separate from transcript sequence numbers;
- reconnects the SSE stream from its publish-order cursor.

Viewer prompts carry a stable client message id. The host returns a sealed acceptance record and emits
the user turn into the transcript. An ambiguous send is displayed as delivery unknown and is not
silently repeated under a fresh identity.

### 6.3 Durable restart

Durable recovery is a paired capability:

- <code>maxSeq</code> recovers the next host transcript sequence.
- <code>frameCount</code> fences old inbound actions by publish-order offset.

A backend offering only one half is treated as non-durable. The supported stable-Claude and pinned
Codex M3a paths refuse to serve against a backend that cannot provide both; restarting at zero could
collide with retained output or replay old mutations.

## 7. Storage profiles

| Backend | Role | Durability |
| --- | --- | --- |
| SQLite/libSQL | Supported production and local durable profile | Implements ordered log, dedup coordinates, <code>maxSeq</code>, and <code>frameCount</code> |
| Turso Cloud locator | Vercel storage for the SQLite/libSQL profile | One remote database per channel plus a durable channel catalogue |
| Vercel Workflows | Compatibility and experimentation | Ordered stream, but no paired host-restart cursors and a finite event ceiling |
| Local memory | Tests and single-process development | No restart durability |

The SQLite adapter places each channel in its own database. A channel witness, the durable catalogue,
and the first frame are committed in an order that distinguishes a genuinely new channel from missing
storage for a known channel. Frame append and idempotency checks share one transaction. Reusing a
durable coordinate with changed transport bytes is a hard collision.

On Turso, database creation can precede query availability. The locator waits through the bounded
create-to-serve window before treating a new database as usable. A known database that disappears is
reported as permanent channel storage loss, not recreated as an empty transcript.

Ordinary sealed-channel retention is deliberately a no-op: inactivity is not authenticated deletion
authority, so the cron does not drop or compact channel data. Handoff rows have a separate, frequent
expiration sweep because their one-time TTL is part of that protocol. Development-scope deletion also
remains disabled because a truncated deployment name is not sufficient ownership authority.

## 8. Browser viewer

The browser:

1. Parses an <code>rcp1_</code> pass or, only when the deployment gate in §9 is enabled, claims an
   <code>otk1_</code> handoff.
2. Derives the public identity and opens the bus.
3. Authenticates and decrypts announcements locally.
4. Opens a selected session stream and renders its ordered transcript.
5. Seals prompts and supported controls locally before publication.

The pass is not stored in plaintext. The browser wraps it with a non-extractable AES-GCM key held in
IndexedDB and stores the wrapped blob in tab-scoped <code>sessionStorage</code>. Decrypted transcript
state is memory-only. Forgetting the identity removes the wrapped blob, best-effort deletes the device
key, and clears live viewer state.

Multiple browsers holding the same pass can subscribe and submit to the same remote-claw session.
That is implemented for the private relay, Claude native companion, pinned OpenCode companion, and
pinned Codex companion. A native API-path run alone does not establish coexistence through a literal
provider app UI; those boundaries need their own acceptance.

The viewer renders only capabilities announced by the active driver. Unsupported controls remain
disabled instead of producing a false success indication.

## 9. One-time pairing

One-time pairing is implemented but default-off. The route, CLI producer, and browser consumer all
require <code>NEXT_PUBLIC_RC_HANDOFF_ENABLED=1</code>. Operators may set that public deployment flag only
after the pre-claim authority disclosure test is green and after externally verifying the route-specific
per-IP WAF rate limit described in <a href="ephemeral-handoff.md">ephemeral-handoff.md</a>; the flag itself
proves neither condition. Disabled deployments return an opaque 404 without reading a handoff body, do
not upload or claim, and retain manual pass entry.

When those gates are satisfied and handoff is enabled,
<code>--rc-pass --rc-qr --rc-app &lt;origin&gt;</code> avoids putting the long-lived pass in a QR:

1. The host generates a 256-bit one-time key.
2. It derives separate box-encryption and claim values.
3. It seals the pass locally and uploads only the lookup hash, proof hash, and ciphertext.
4. The QR carries <code>&lt;origin&gt;/#otk1_...</code>; URL fragments do not reach the server.
5. The browser proves possession, atomically consumes the row, and decrypts locally.

An absent, expired, already-used, or wrongly proved row returns the same 404 result. Pairing does not
change the authority of the resulting pass. Before the destructive claim, the pairing UI must make clear
that the link is one-time but the recovered pass grants indefinite machine-wide read, control, and
record-forging authority. The current pairing copy does not yet meet that disclosure gate, so handoff
must remain disabled even where the external rate limit exists.

## 10. Current native modes

### 10.1 Plain wrapper

Without <code>--rc-app</code>, remote-claw forwards every non-reserved argument to Claude. Claude's
own <code>--remote-control</code> then uses Anthropic normally. No remote-claw identity is created
merely by running the plain wrapper.

### 10.2 Private replacement mode

With <code>--rc-app … --rc-driver=mitm</code> (the default driver), the wrapper:

- checks the exact supported Claude report, currently <code>2.1.237 (Claude Code)</code>;
- creates a loopback certificate authority and TLS proxy;
- launches a fresh top-level Claude with proxy variables and the local CA;
- intercepts only Claude RC session and trigger endpoints;
- passes inference, OAuth, telemetry, and unrelated requests through to Anthropic by default;
- bridges each intercepted session to the sealed broker.

The version check limits private-protocol drift. It is not an authenticity statement about the local
executable path, file ownership, inode, size, or bytes. The user account and operating system are
inside the host trust boundary.

The child environment removes the broker bypass, secret-file pointer, inherited parent-session ids,
and proxy bypass variables. This prevents accidental secret inheritance and prevents a child launched
inside another Claude session from becoming that parent's stub.

Stable capability advertisement is intentionally text-only. Structured remote permissions,
attachments, interrupt, model switching, and permission-mode switching remain disabled on the
supported surface even though compatibility plumbing exists. Native runtime messages are admitted
through a closed type set and strict UUID, session, epoch, and replay checks. A contradiction closes
the remote session.

Because the proxy answers the RC endpoints locally, Claude does not register this session with
Anthropic's RC service. The official Claude client therefore cannot see it.

### 10.3 Trace mode

<code>--rc-trace</code> uses the same loopback proxy setup but passes every request to
<code>https://api.anthropic.com</code>. Claude registers and obtains its real worker credential, so
the official client can join.

Trace mode writes no frames to the remote-claw broker. Diagnostics are off by default. Debug logging
shows shapes; trace logging shows bounded, recursively redacted JSON. On POSIX a log file must be an
owned mode-0600 regular non-symlink file. Unsupported targets drop records.

### 10.4 Native text companion

<code>--rc-app &lt;origin&gt; --rc-driver=claude-native --remote-control</code> also forwards ordinary
Anthropic Remote Control unchanged. Its transparent proxy observes the spawned child's one successful
<code>POST /v1/code/sessions/{cse_*}/bridge</code> and uses that exact ID; it never chooses by title or
recency. The host opens and validates provider SSE before reading bounded ascending history, then one
ordering owner reconciles history and live events by provider coordinates. It projects supported text
to a fresh random remote-claw session ID distinct from the native <code>cse_*</code>.

<code>--rc-app &lt;origin&gt; --rc-driver=claude-native --rc-native-session &lt;cse_…&gt;</code> is the
attach-only restart form. It requires one explicit canonical native ID, accepts no forwarded Claude
arguments, and starts no interactive Claude session or proxy; the pinned-version probe still runs. It
performs the same readiness/reconciliation work in a fresh random projection; it never discovers by
title/recency, persists an owner registry, or reuses the retired projection.

Browser text uses a caller-owned UUID and one serialized provider writer. A rejected or
outcome-unknown POST permanently fences only the remote projection and is never replayed; ordinary
Claude and its provider session remain alive. The viewer advertises
<code>{agent:"claude-code",mode:"native-rc"}</code> with permissions, status, controls, and
attachments all disabled. This surface is Linux-only and pins exact Claude 2.1.237.

### 10.5 Pinned OpenCode text/interrupt companion

<code>--rc-app &lt;origin&gt; --rc-driver=opencode --rc-oc-session &lt;ses_…&gt;</code> attaches to one
exact already-running OpenCode 1.17.5 session on Linux arm64 through an explicit-port literal HTTP
loopback origin. It pins <code>amazon-bedrock/global.anthropic.claude-sonnet-4-6</code>, accepts no
forwarded arguments, performs no attached-root listing, discovery, or creation, and does not own the
external OpenCode process. The companion follows child sessions announced from that root. The proved
server environment was <code>AWS_REGION=us-west-1</code> plus explicit temporary SigV4 credential
values; other regions or credential modes require their own gate.

OpenCode generates the canonical ordered message IDs. Browser text uses an exact
<code>prt_rc_&lt;compact host UUID&gt;</code> part marker; capture requires that complete marker and the
complete immutable text before acknowledging the downstream event and publishing the canonical native
user row. One atomic transport-plus-idle latch serializes browser text FIFO. An observed intervening
local TUI user, <code>busy</code>, or <code>retry</code> blocks admission; live idle merely triggers
bounded history plus exact status reproof. The status snapshot is corroboration, not a native atomic
lock. Reconnect reconciles before writes resume.

Only non-empty non-slash text and interrupt are advertised. Permissions remain native/local and
structured permissions are false by default; the separate positive permission-mirroring opt-in is
experimental. Companion teardown and broker/capture loss never abort the native run. Restart against
the same exact <code>ses_*</code> creates a fresh remote-claw projection and does not consume old broker
commands.

### 10.6 Pinned Codex text/status companion

<code>--rc-app &lt;origin&gt; --rc-driver=codex --rc-codex-thread &lt;uuidv7&gt;</code> resumes/joins
one exact thread through either a caller-owned explicit-port loopback Codex app-server or literal
<code>unix://</code>. The literal token resolves only to Codex's same-user managed control socket under
<code>$CODEX_HOME/app-server-control/</code> (falling back to <code>~/.codex</code>); arbitrary Unix
paths are rejected. The supported tuple is exact 0.151.0 on Linux arm64. The companion accepts no
forwarded arguments and never starts/stops app-server, discovers/selects/creates/deletes/stops a
thread, or owns the TUI. Resume may load the exact stored thread, but the supported topology requires
the caller to keep a local TUI attached for the companion lifetime.

The driver subscribes before history. Resume's <code>historyMode</code> selects bounded ascending
<code>thread/items/list</code> for <code>paginated</code> or bounded ascending
<code>thread/turns/list</code> with <code>itemsView:"full"</code> for <code>legacy</code>. Both paths
validate native envelopes and filter to supported user/assistant text before the 10,000 projected-item
cap, then drain buffered notifications before readiness. Completed text is keyed by immutable
<code>(turnId,itemId)</code>, not the turn-scoped item ID alone; exact replay deduplicates and changed
projected bytes at the same coordinate fence the projection. Browser text first
gets seq-less pending admission; its final acknowledgement waits for the exact native user item carrying
the host client ID and text. A 15-second correlation deadline and bounded history/dedup fence ambiguous
or contradictory outcomes. Native active/idle status is advertised. Every browser control, attachment,
and structured permission/question answer is disabled.

For current app-server approval/question requests, the first result or error wins globally. The
companion client has no response method, so it can send neither and the attached TUI remains sole owner.
Closing or failing the projection closes only the companion socket and remote-claw session, never the
app-server, TUI, or native thread.

## 11. Agent adapters and inference connectors

The adapter seam maps a native harness into the same host session, broker, and viewer contracts.
The MITM private-relay path, Claude native text companion, exact OpenCode M2 tuple, and exact Codex M3a/M3b
tuple are supported at their stated boundaries. Other implementations have narrower, truthfully
labeled guarantees.

| Adapter or connector | Current role | Important limit |
| --- | --- | --- |
| Claude native companion | Structured text projection over ordinary Anthropic RC, including explicit exact-ID fresh-projection restart and literal official-client coexistence | Exact Linux/2.1.237 only; no remote controls, permissions, attachments, or status |
| tmux | Experimental Claude compatibility driver | Transcript/pane correlation is weaker than native RC; permission mirroring uses hooks |
| OpenCode | Supported text/interrupt server companion for the frozen 1.17.5/Linux arm64/pinned-model tuple | One explicit session, bounded history, fresh projection on restart; broader tuples and permission mirroring are not graduated |
| Codex | Supported text/status app-server companion for exact 0.151.0/Linux arm64, including bounded same-thread official Remote coexistence | One explicit thread and attached local-TUI precondition; provider-transport isolation is proved, but per-device unsubscribe, browser controls, restart/backfill, and broker-loss are not |
| Bedrock inference | Experimental MITM connector | Replaces Anthropic inference while preserving the private local RC facade |
| Accountless mode | Experimental Bedrock companion | Means no Anthropic account, not no credentials; AWS/Bedrock and remote-claw credentials remain required |

Capability claims are per adapter, not inherited from the shared relay. A failure should end its
remote projection without claiming that an unsupported or ambiguous native mutation succeeded.

## 12. Fail-stop and secret-handling rules

The safety boundary is small enough to state directly:

- Secrets, passes, provider OAuth, deployment bypasses, prompt text, and model output do not enter
  broker logs or normal CLI diagnostics.
- Provider OAuth stays on the host. Browser and broker code never receive it.
- Broker-controlled HTTP rejection text/status, SSE error data, malformed-frame parser details, and
  invalid-success parse details are discarded at the client boundary; only local status/disposition
  reaches normal relay logs. The one exact <code>410 + channel_storage_lost</code> pair remains a typed
  permanent-loss signal.
- Authenticate a frame before persistent deduplication.
- Reject malformed routing, wrong identity/session labels, changed durable coordinates, and unsupported
  native event shapes before a native side effect.
- Never convert an unknown mutation outcome into an automatic fresh command.
- Stable Claude requires paired durable recovery cursors.
- A permanent durable-storage loss closes the affected remote projection.
- A stale or terminal presence record cannot authorize a browser mutation.
- Teardown is bounded for ordinary network work, but terminal publication follows its own fail-stop
  policy.
- Losing the remote relay must not kill a user's otherwise healthy local native session.

Deployment Protection, when enabled, is an additional edge admission layer. Its automation bypass is
used by the host and deployment smoke only; it is not a content-encryption key and is scrubbed from
the Claude child.

## 13. Current limits

The current product does not claim:

- metadata privacy;
- forward secrecy;
- per-viewer permissions or revocation;
- a complete durable offline session directory;
- stable same-row remote-claw projection identity across companion restart;
- remote push notifications;
- official-client coexistence in private replacement mode;
- current parity across Claude, Codex, OpenCode, and tmux.

The last item is unfinished product scope, not a declaration that parity is unwanted. Implement one
thin adapter milestone at a time and extract a shared abstraction only after at least two real
adapters require it.

## 14. M1 complete: the structured Claude native companion

M0 first tested the cheaper retained route. On 2026-08-24, plain Claude 2.1.237 under the tmux driver
kept its Anthropic-hosted Remote Control session while a local pane, the host-side Anthropic API client,
and two remote-claw browsers all submitted labelled text. Provider history contained each submission
once, reload did not duplicate it, and broker loss left the native session alive. That is the honest
lower-fidelity baseline; it did not exercise the official Claude app UI or add structured delivery.

The selected architecture leaves Claude's native RC relationship untouched:

~~~text
normal claude --remote-control
        │
        ├── local TUI
        ├── Anthropic RC log ── official client
        │
        └── host companion ── sealed remote-claw broker ── browsers
~~~

The <code>claude-native</code> driver uses these bounded <code>AnthropicRcClient</code> operations:

- <code>history</code> for caller-driven ordered reconciliation;
- <code>streamEvents</code> for one independent SSE reader;
- <code>postEvent</code> for one user event with a caller-owned UUID and timestamp.

Its production transport is fixed to <code>https://api.anthropic.com</code> and the pinned API
version. The built-in credential source is Linux-only, reads native Claude's owner-only mode-0600
credential file afresh, never writes or refreshes it, and waits for native Claude to rotate a rejected
token. A 401 is retried only when the bearer actually changed. Network-ambiguous writes are not
automatically replayed.

The native companion implements this bounded orchestration:

1. Bind only from the spawned child's successfully forwarded bridge request in launch form, or from the
   explicit canonical <code>--rc-native-session</code> value in attach-only form; never select by newest
   or title.
2. Open and validate SSE first, then reconcile bounded ascending history and live frames under one
   provider-coordinate ordering owner.
3. Admit only pinned supported provider event shapes; do not guess unknown frames into transcript
   mutations.
4. Project supported text into the existing sealed broker under a fresh random projection ID.
5. Submit browser text through <code>postEvent</code> with one stable UUID and one serialized writer.
6. Fence the projection after any rejected or outcome-unknown POST; never retry the mutation.
7. Stop the projection without intentionally terminating Claude if the companion or broker fails.
8. On restart, create a fresh projection for the explicitly named same native session; do not consume
   the retired projection's channel or turn historical backfill into another provider POST.

This remains a bounded adapter milestone. Add more architecture only when a failing acceptance
scenario demonstrates a concrete need, then reuse proven patterns where another native protocol needs
them. Tmux keeps its lower-fidelity contract.

On 2026-08-30, an exact isolated Claude 2.1.237 run bound ordinary Anthropic RC and kept the local TUI
active. A local prompt, prompts from two simultaneous remote-claw browsers, and a prompt from an
authenticated client using Anthropic's RC API each received an answer and rendered once in both
browsers. This proves the companion and provider API path. It does **not** prove the literal
official web/mobile UI: headless and Xvfb Chromium reached Cloudflare login rather than an authenticated
Claude UI.

A second bounded run used the packed-installed CLI against the same exact native session. Two
successive attach-only companions produced fresh projections; the second backfilled the local,
browser-A, browser-B, and authenticated-API turns once and accepted one new browser turn. Broker loss
made only that companion exit with failure, while the native TUI completed another provider turn.
Deterministic coverage owns retired-channel fencing and committed-but-response-lost no-repeat. An exact
credential scan found no provider/root/pass/bypass value in the owned mode-0600 logs or raw SQLite
files, and raw broker files contained none of the six labelled prompts.

On 2026-08-30, trusted Preview run 33323332395 passed against exact deployed commit
<code>bcab0c9c0fa6ad036f4996b9d0f0540aebec4d26</code>. It attested the served Preview SHA and configured
default SQLite/Turso profile, then passed browser discovery, host receipt, and reload replay. This
deployment smoke used no live Claude or provider credential.

The final bounded M1 run used exact Claude 2.1.237, a production-built local SQLite broker, the real
local TUI, two independent remote-claw Chromium contexts, and the literal logged-in official Claude web
UI on the user's phone using one native session. A browser-labelled turn and its unique reply appeared
once in both remote-claw views, and the official client displayed that browser turn. The official
client submitted another labelled turn; it and its unique reply also appeared once in both views, while
the local TUI visibly observed the official turn and answer. Those browser rows came from canonical
provider history/SSE; a separate direct provider-history recount was unavailable under the current host
credential and is not claimed. After the official client disconnected, another browser turn and reply
appeared once in both views and the native TUI remained live.

M1 is complete. M1 alone does not complete Codex, broader OpenCode tuples, tmux,
Bedrock/accountless, or the full-product matrix.

## 15. M2 complete: pinned OpenCode text/interrupt companion

The OpenCode companion intentionally reuses the `Session`, relay, broker, and viewer rather than
introducing a second control plane. Its native boundary is different from Claude's: attach to one exact
externally owned `ses_*`; subscribe first; reconcile a bounded append-only native message graph; admit
FIFO browser text only through one atomic transport-plus-idle latch; and use an exact caller part marker
to bind OpenCode's generated native user coordinate. Native status is an internal admission proof, not
an advertised viewer capability.

On 2026-08-30, the exact OpenCode 1.17.5/Linux arm64/pinned-Bedrock tuple passed with the real TUI and
two independent browsers. The OpenCode server used <code>AWS_REGION=us-west-1</code> plus explicit
temporary SigV4 credential values. The run verified OpenCode-generated IDs, exact markers for browser
A and B, one copy of each TUI/browser turn, immutable reload, interrupt of a busy turn plus a later
continuation, and companion-only restart against the same exact session. Native history had the same
SHA-256 before and after restart, and every old command appeared once. Deterministic tests own
malformed/reused coordinates, parent and order changes, busy/retry and local-user exclusion, live-idle
history/status reproof, reconnect-before-write, ambiguous mutations, projection loss, and no teardown
abort. Other regions or credential modes require their own gate.

The supported path leaves permissions native/local. Experimental permission mirroring, stable same-row
identity, other OpenCode versions/platforms/models, and richer control families are separate future
capabilities and do not reopen M2.

## 15.1 M3a complete: pinned Codex app-server companion

On 2026-08-30, exact Codex 0.151.0/Linux arm64 passed against the production web build and a durable
SQLite broker. One real Codex TUI and two independent Chromium browser contexts shared one exact native
thread. Uniquely labelled turns from the TUI, browser A, and browser B, plus their replies, appeared once
in both browsers and the TUI. The viewer showed Codex's app-server harness, real status, disabled
controls, and the local approval/question boundary.

A native command approval appeared only in the local TUI, was declined there, and performed no side
effect. A separate native question appeared in the TUI and was answered there. Both app-server
subscribers observed the requests resolve; the structurally response-less companion returned neither a
result nor error and stayed live. A clean companion stop left app-server, TUI, and native thread live.
Focused deterministic tests own compatibility, bounded-history/readiness ordering, history/live mode
selection, supported-text filtering, `(turnId,itemId)` deduplication and changed-byte fencing, exact
correlation and timeout, response-less request handling, disconnect/archive/revert
and broker/projection fail-stop, companion-only teardown, dispatch, and capability gates. This live
run does not claim companion restart/backfill.

M3a did not itself prove provider-app coexistence. M3b subsequently exercised that boundary through
the literal managed Unix socket and legacy full-turn reader; its bounded result is recorded separately
below. See the official
[Codex app-server](https://learn.chatgpt.com/docs/app-server) and
[Remote connections](https://learn.chatgpt.com/docs/remote-connections).

## 15.2 M3b complete: official Codex Remote coexistence

The bounded M3b run used an exact official Remote thread for Codex 0.151.0/Linux arm64, literal
`unix://` to the managed same-user control socket, `historyMode:"legacy"` full-turn hydration, one
attached local TUI, and two independent remote-claw browsers. The TUI remained the sole owner of
approval and question handling.

One provider-origin marker appeared exactly once in each browser. One browser-origin prompt and its
acknowledgement appeared exactly once in the official thread, TUI, and both browsers; the sending
browser also showed the host receipt. For the failure-isolation step, an ephemeral provider transport
was disabled and remained disabled while a browser-B turn completed. The managed daemon, TUI,
companion, and both browsers stayed live, and provider transport subsequently restored to connected.

This proves provider-transport isolation: browser collaboration stayed live while the provider
transport was absent. It does not prove that one provider device was selectively unsubscribed while
another remained connected, so it is not a per-device unsubscribe result. The run also does not
graduate richer controls, attachments, browser approval/question ownership, companion
restart/backfill, or broker-loss behavior.

## 16. Post-M2 viewer parity lane

Viewer work may proceed as a small parallel product lane without reopening M1 or M2. Start with a
compact activity rollup and background-task sheet built from event families already represented by the
shared transcript. Graduate richer Claude-native command, task-phase, media, and composer families only
after redacted trace evidence defines their semantics and lifecycle. Visual resemblance is useful UI
inspiration; it is not a capability or cross-agent parity claim.

## 17. Claude Remote Control boundary

The private facade models the worker-facing subset observed from Claude:

- session registration at <code>POST /v1/code/sessions</code>;
- bridge creation under <code>/v1/code/sessions/{id}/bridge</code>;
- downstream worker SSE under <code>/worker/events/stream</code>;
- worker event POSTs and delivery acknowledgements;
- trigger discovery at <code>/v1/code/triggers</code>.

The first downstream event is the synthetic initialize request. Viewer text becomes a native user
event; native assistant, result, selected system/task, tool, and permission records are translated
into sealed viewer records. A reconnecting worker stream supersedes the prior stream so only one
follower attempts downstream delivery.

Trace mode observes the provider-hosted form of the same boundary. The native companion's direct
client uses the client-facing provider endpoints:

| Method | Path |
| --- | --- |
| GET | <code>/v1/code/sessions</code> |
| GET | <code>/v1/code/sessions/{id}/events</code> |
| GET | <code>/v1/code/sessions/{id}/events/stream</code> |
| POST | <code>/v1/code/sessions/{id}/events</code> |

These are private provider interfaces and can change. Runtime parsing, exact session binding, bounded
bodies, redacted errors, and conservative mutation retry policy are therefore required even when the
reported Claude version matches.

The underlying observations and protocol caveats are preserved in
[Phase 0 findings](phase0-findings.md).
