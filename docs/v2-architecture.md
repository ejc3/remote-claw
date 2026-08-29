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
| Identity, viewer pass, sealed frames, broker, durable log, and browser viewer | Implemented |
| <code>--rc-app &lt;origin&gt;</code> | Implemented private replacement mode; the official client cannot join |
| <code>--rc-trace</code> | Implemented transparent inspector; the official client works, but no remote-claw browser is connected |
| Direct Anthropic RC client | Implemented as a typed library foundation, not wired into a host companion |
| Claude native collaboration plus multiple remote-claw browsers | Lower-fidelity tmux coexistence observed through the Anthropic Remote API; structured bridge and official-app UI acceptance remain the next milestone |
| OpenCode server adapter and tmux fallback | Experimental implementations with documented limits |
| Codex | Pinned app-server multi-client evidence; no product adapter yet |
| Bedrock and no-Anthropic-account launch | Experimental inference/account paths, separate from adapter fidelity |

The current private relay is useful product infrastructure, but no single adapter is the whole
product.

## 2. As-built system map

The current supported beta path is:

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
  private RC facade, trace inspector, and provider-native RC client.
- **apps/web** is both the authenticated ciphertext broker and the mobile-first viewer.

There is no required host daemon or plaintext cloud service in the current path. Each wrapper process
owns the native session it is relaying. Sessions sharing one secret are grouped under one logical host
identity.

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

A backend offering only one half is treated as non-durable. The supported Claude path refuses to
serve against a backend that cannot provide both; restarting at zero could collide with retained
output or replay old mutations.

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
That is implemented for the private relay. It does not by itself establish coexistence with the
official Claude client.

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

## 10. Current Claude modes

### 10.1 Plain wrapper

Without <code>--rc-app</code>, remote-claw forwards every non-reserved argument to Claude. Claude's
own <code>--remote-control</code> then uses Anthropic normally. No remote-claw identity is created
merely by running the plain wrapper.

### 10.2 Private replacement mode

With <code>--rc-app</code>, the wrapper:

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

## 11. Agent adapters and inference connectors

The adapter seam maps a native harness into the same host session, broker, and viewer contracts.
The MITM private-relay path is the supported Claude beta; the other implementations have narrower,
truthfully labeled guarantees and remain in the product plan.

| Adapter or connector | Current role | Important limit |
| --- | --- | --- |
| tmux | Experimental Claude compatibility driver | Transcript/pane correlation is weaker than native RC; permission mirroring uses hooks |
| OpenCode | Experimental server driver | Partial history, bounded reconnect dedup, and no proven live reattach |
| Codex | Research-backed future app-server adapter | Multi-client facts are pinned, but no broker adapter or official-remote coexistence exists |
| Bedrock inference | Experimental MITM connector | Replaces Anthropic inference while preserving the private local RC facade |
| Accountless mode | Experimental Bedrock companion | Means no Anthropic account, not no credentials; AWS/Bedrock and remote-claw credentials remain required |

Capability claims are per adapter, not inherited from the shared relay. A failure should end its
remote projection without claiming that an unsupported or ambiguous native mutation succeeded.

## 12. Fail-stop and secret-handling rules

The safety boundary is small enough to state directly:

- Secrets, passes, provider OAuth, deployment bypasses, prompt text, and model output do not enter
  broker logs or normal CLI diagnostics.
- Provider OAuth stays on the host. Browser and broker code never receive it.
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
- native restart adoption under one stable logical chat;
- remote push notifications;
- official-client coexistence in private replacement mode;
- current parity across Claude, Codex, OpenCode, and tmux.

The last item is unfinished product scope, not a declaration that parity is unwanted. Implement one
thin adapter milestone at a time and extract a shared abstraction only after at least two real
adapters require it.

## 14. Next milestone: the structured Claude native companion

M0 first tested the cheaper retained route. On 2026-08-24, plain Claude 2.1.237 under the tmux driver
kept its Anthropic-hosted Remote Control session while a local pane, the host-side Anthropic API client,
and two remote-claw browsers all submitted labelled text. Provider history contained each submission
once, reload did not duplicate it, and broker loss left the native session alive. That is the honest
lower-fidelity baseline; it did not exercise the official Claude app UI or add structured delivery.

The selected next architecture leaves Claude's native RC relationship untouched:

~~~text
normal claude --remote-control
        │
        ├── local TUI
        ├── Anthropic RC log ── official client
        │
        └── host companion ── sealed remote-claw broker ── browsers
~~~

The existing <code>AnthropicRcClient</code> already provides the bounded transport foundation:

- <code>listSessions</code> for paginated session discovery;
- <code>history</code> for caller-driven ordered reconciliation;
- <code>streamEvents</code> for one independent SSE reader;
- <code>postEvent</code> for one user event with a caller-owned UUID and timestamp.

Its production transport is fixed to <code>https://api.anthropic.com</code> and the pinned API
version. The built-in credential source is Linux-only, reads native Claude's owner-only mode-0600
credential file afresh, never writes or refreshes it, and waits for native Claude to rotate a rejected
token. A 401 is retried only when the bearer actually changed. Network-ambiguous writes are not
automatically replayed.

The first companion vertical should add only the missing orchestration:

1. Bind to one exact native session without silently choosing an ambiguous newest session.
2. Page native history, then reconcile it with the live SSE stream under one local ordering owner.
3. Preserve unknown live frames until their policy is understood; do not guess them into transcript
   mutations.
4. Project supported native events into the existing sealed broker.
5. Submit one browser text event through <code>postEvent</code> with one stable UUID.
6. Reconcile an indeterminate POST through native history before allowing an intentional retry.
7. Stop the projection without terminating Claude if the companion or broker fails.

This is a bounded first adapter milestone. Add more architecture only when a failing acceptance
scenario demonstrates a concrete need, then reuse the proven pattern for OpenCode and Codex where
their native protocols support it. Tmux keeps its lower-fidelity contract.

The acceptance scenario is:

1. Start one normal Anthropic-hosted Claude Remote Control session.
2. Join it from the official Claude client.
3. Join it from two remote-claw browsers.
4. Submit labelled text from the local TUI, official client, browser A, and browser B.
5. Verify every surface observes the same ordered native history and each labelled submission once.
6. Disconnect each remote-claw browser in turn and verify the remaining surfaces stay live.
7. Restart only the companion; verify the old remote-claw projection is terminal or becomes stale, a
   fresh random projection binds the same native session, backfills history once, consumes no retired
   command, and repeats no native mutation. Stable same-row projection identity is not an M1 claim.

Until that scenario passes against a deployed broker, the Claude native-coexistence milestone remains
unfinished. Passing it will not complete the OpenCode, Codex, tmux, Bedrock/accountless, or full-product
matrix.

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

Trace mode observes the provider-hosted form of the same boundary. The direct client uses the
client-facing provider endpoints:

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
