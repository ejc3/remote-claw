# remote-claw Claude 1.0 finish line

**Status:** this is the sole release finish line for remote-claw. A releasable tree must satisfy the
full local gate, independent review, exact-candidate CI, the three-receipt Preview-to-Production proof
chain below, and exact-merge CI. Execution state and receipt hashes live in the PR release record and
private proof artifacts, not in this candidate-bound source file. The broader client-driven host
runtime, OpenCode, Codex, tmux durability,
nested collaboration, and provider façades are parked future-platform work. They do not block Claude
1.0.

## Product outcome

Ship one installable, supportable path that lets a person use an owned browser to drive the real
Claude Code TUI on their machine through a zero-knowledge broker:

```text
real browser ⇄ ciphertext-only broker ⇄ installed host wrapper/MITM ⇄ real Claude Code TUI
```

The core path already works as a developer beta. Claude 1.0 is done only when that path fails safely
under ambiguous delivery and relay failure, presents its evidence honestly, installs without the
repository's TypeScript toolchain, and passes one deployed real-topology proof.

## Current evidence, without roadmap inflation

| Surface | Current truth |
| --- | --- |
| Core product | Real Claude MITM, E2E crypto, broker, browser viewer, turns, compatibility permissions/attachments, and multi-client behavior are implemented and tested. The stable Claude 1.0 surface deliberately exposes text only. |
| Browser publish | Implemented: one random source ID is retained through an ambiguous POST. The UI preserves the bubble as **Delivery unknown — it may have reached the host. It was not retried.** It has no automatic Retry/new-ID path. |
| Host intake | Implemented: the relay fences the exact identity/session/direction before opening or deduplicating, AEAD-authenticates every frame and attachment part, and then uses one incarnation-long unbounded `#seen` set. A fresh launch gets a new random `cse_*`; it never adopts the old relay. |
| Native delivery | Implemented fail-stop boundary: the Claude MITM marks every downstream mutation immediately before its first SSE write attempt and never offers it to a later worker generation. Only the genuinely minted initialize handshake is reconnectable. |
| Native output | Implemented for the pinned Claude path: `/worker/events` atomically validates epoch, the retained eight types, UUIDv4 coordinate, and normalized payload bytes; exact replay returns the original event/sequence, while any invalid/colliding batch admits nothing and terminally closes that `cse_*`. One shared queue owns projection allocation/publication across both pumps and serializes native control side effects behind it. |
| Relay failure | Implemented per `cse_*`: durable-cursor attempts have a 70 s wall, initial stream headers have a 20 s wall, established SSE fails after 40 s without an actual byte, a whole logical post has a 65 s wall, and the third consecutive inbound transport failure is terminal. A clean absent-channel result or newly admitted authenticated frame resets that count; owner abort is exempt. The server's exact 240 s `: rotate` boundary is neutral—it neither increments nor resets the count—while raw/unmarked EOF is a failure. The first must-succeed publication failure, permanent identity-bus storage loss, or exhausted inbound transport latches its cause, closes that Session before queued work can proceed, and every later route under the closed session returns 410. A timed-out ambiguous post is not replayed. The local Claude TUI is not killed. |
| Lifecycle truth | Implemented: the versioned identity bus carries an authenticated, absorbing `session_terminal` marker. Local and SQLite brokers suppress every later announce for that session; Workflow does so within its current run/generation (the stable Claude profile rejects Workflow). The viewer permanently removes the session and shows the incomplete-tail disclosure. Raw `sent_at` orders legacy frames but does not directly grant liveness: an exact coordinate keeps its first `freshnessAt`, host lead over 5 s starts at the stale edge, and every other accepted coordinate uses `min(sentAt, receivedAt)`. Thus farther-future presence is immediately reconnecting/non-writable and exact replay cannot refresh liveness. |
| Durable broker | Implemented: ordinary SQLite/libSQL replay requires byte-identical stored wire frames at `(generation, msgId, part)`; changed bytes fail with a hard collision. A channel is established in the crash-safe order physical provision → readiness/preparation → core schema → singleton channel witness → mandatory durable catalog → first frame. A catalogued channel whose physical store, either core table, or singleton witness disappears fails closed and is never recreated under the same token. Every newly opened channel, continuity-index, and handoff client crosses a hard 30 s create→serve readiness barrier; cursor routes allow 60 s and the caller 70 s. Subscription queries have a 15 s maximum and one shared three-transient-failure budget, so provider hangs/outages reach the host fail-stop circuit instead of being hidden behind SSE keepalives. Inactivity is not collection authority, so ordinary sweep deletes and compacts nothing. The HTTP dev-sweep route also returns 501 without constructing a locator or deleting; exact-ownership cleanup remains future work. |
| Distribution | Implemented in the candidate: the root package builds an esbuild bundle, exposes `bin.remote-claw`, packs only the compiled artifact plus README, and has an install smoke that consumes the tarball with scripts disabled. It remains private `0.0.0`; registry publication is not a release requirement. |
| End-to-end proof | Required evidence is one chained result: exact-candidate Preview topology `browser-leg/v4`, bounded sentinel inspection `inspection/v1`, then post-merge `production-release-attestation/v1`. The terminal link proves the candidate is an ancestor with exactly the live Production merge tree; re-attests the live WAF and Deployment Protection; and exercises a fresh default relay→Turso create/write/read. Exact-SHA Actions CI remains separate release-record evidence. The private durable receipts and PR release record carry execution status; source prose defines the invariant without claiming a particular run. |

The release work closes only these product gaps. Dormant platform foundations do not substitute for
them.

## Scope boundary

Claude 1.0 includes only the existing Claude Remote Control MITM lane, browser viewer, identity/pass
flow, and one durable sealed-log broker profile. SQLite/libSQL is the production profile; the capped
Vercel Workflow backend remains experimental unless safe rollover is implemented and proven. The
supported deployment sets `BROKER_BACKEND=sqlite` with the complete Turso fleet configuration so host
and viewer select the same durable profile; stable Claude fails closed before discovery on a backend
that reports `durable:false`.

Ordinary SQLite/libSQL channel retention is indefinite for 1.0. An idle transcript database can still
belong to a live host whose keepalives are written only to the identity bus, and the zero-knowledge
broker cannot authenticate a collection transition from inactivity. Deleting or compacting on that
heuristic could erase an acknowledged projection or allow a retired session to reappear. The release
therefore accepts quota/storage pressure as an explicit operational cost. The HTTP dev-sweep route is
disabled and returns 501 because its truncated name prefix cannot prove exact deployment ownership;
local-file cleanup is not silently substituted. Any manual infrastructure deletion remains an explicit
operator action over a reviewed exact database list, not application retention behavior.

Manual pass onboarding is sufficient for 1.0. One-time QR/OTK handoff may ship only if the trusted
release runner verifies the exact live Vercel Firewall config and active `/api/handoff` per-IP rule;
otherwise that route and UI are disabled. Vercel's platform-managed System Mitigations remain the
documented global volumetric backstop, but the Management API used by this proof does not expose them
and the receipt does not claim to attest them.

OpenCode, Codex, tmux, alternate provider connectors, nested collaboration servers, and the A1
signer/certificate/runtime graph are out of scope. Existing compatibility code may stay, but cannot
expand the stable surface or weaken its gates. The stable entrypoint must not initialize the dormant
A1 runtime owner, and experimental drivers must not look like supported alternatives.

Claude 1.0 keeps the existing single-user pass trust model: every pass holder is a trusted controller
for every session under that machine identity and can construct valid input- or output-shaped sealed
frames. Per-viewer roles, individual pass revocation, and host-only output signatures require a
separate product decision.

The supported synchronization boundary is browser-originated mutations plus native RC events that
remote-claw observes. Local-TUI prompt text may be absent and the viewer must say so. Lossless local
transcript mirroring is not a 1.0 requirement.

## Fail-stop incarnation boundary

One live relay owns one random `cse_*`. Native process death, wrapper death, or fatal bridge/publisher
failure ends that remote session. Claude may continue as a local TUI after a bridge failure, but the
old remote session becomes non-writable and receives no more native events. A later launch gets a new
session identity and never replays an old command into it.

Liveness failures are part of that same terminal boundary. Each durable-cursor read has a 70 s attempt
wall and each initial SSE response has a 20 s wall; an established SSE stream that yields no actual byte for 40 s fails; one
logical post, including all chunks and authoritative 409 retries, has a 65 s wall; and three
consecutive inbound failures close the `cse_*`. Only a clean absent-channel completion or a newly
admitted authenticated frame resets the failure count. Owner abort is ordinary shutdown and does not
consume the budget. A healthy route emits exact `: rotate` 240 s after its response body starts,
nominally 60 s before its configured 300 s
deployment wall; that marker causes a durable-cursor reconnect without charging or forgiving the
failure budget. Raw/open/data/bodyless EOF remains failure. Once a logical post times out its outcome
is ambiguous, so the relay closes rather than replaying it. The fixed coordinate-free HTTP 410 JSON
disposition for permanent
identity-bus storage loss is the only non-advisory presence-publication failure; it synchronously closes
the Session, while ordinary announce 5xx remains advisory.

The broker-side SQLite subscription cannot mask a provider outage with healthy SSE comments. Frame and
state queries each have a hard 15 s maximum (`RC_SQLITE_POLL_QUERY_TIMEOUT_MS` can only tighten it) and
share a three-consecutive-transient-failure budget. A row-bearing frame query, or a complete successful
empty-frame/state decision, resets it. The third transient, any query timeout, or a nontransient failure
terminates with a coordinate-free error and evicts/releases the client; channel disappearance remains
immediate permanent storage loss.

The viewer discloses that the ended session's most recent delivery and output tail may be incomplete.
Claude 1.0 deliberately makes no transparent restart, old-`cse_*` takeover, complete unpublished-tail
recovery, or cross-process conversation-recovery promise. Those availability features would require a
durable host coordinator; they are not silently added to this release.

## Supported mutation boundary

The stable viewer is selected only for exact harness `{agent:"claude-code", mode:"rc"}` together with
exact capabilities
`{structuredPermissions:false,status:true,controls:{interrupt:false,setModel:false,setMode:false,end:false},attachments:false}`.
An absent/non-object vector selects legacy compatibility. In a present vector, missing or ill-typed
`status` parses as `false`, while missing mutation bits retain legacy compatibility-enabled defaults.
Only the complete literal tuple selects stable Claude; every partial vector or bit drift remains on the
compatibility surface.

The stable browser emits one mutation family: non-empty, non-slash-prefixed text. Permission and
question answers are disabled for Claude 1.0 because the current retained native-output proof
establishes control event types but deliberately retains no question/tool subtype. A later release may
enable an answer family only after a supported compatibility proof advertises that exact family.

Attachments, slash-prefixed text, interrupt, model changes, permission-mode changes, and end-session
are disabled in the stable UI. Compatibility code may remain internal, but it is not a shipped stable
capability.

## Minimum command safety contract

This release uses the fail-stop ownership boundary instead of a new command journal or broker-side
dispatch CAS:

1. A browser mutation has one random source `msgId` and immutable semantic content. After an ambiguous
   publish failure, the stable UI does not automatically Retry or mint a replacement ID. An explicitly
   cached transport retry, if retained at all, must repost the exact encoded frame bytes.
2. SQLite/libSQL treats an exact encoded-frame replay under `(generation, msgId, part)` as the existing
   row and rejects different encoded bytes under that identity as a collision. It does not silently
   report changed bytes as success. The sole exception is a freshly sealed retry of the canonical
   `session_terminal` operation after its per-session absorbing fence already exists: it is a semantic
   success that neither inserts nor updates the first stored terminal bytes.
3. One `HostRcRelay` owns the session. Its incarnation-long `#seen` set is populated before the first
   awaited native side effect, so broker reconnect cannot re-handle a source ID. No replacement relay
   may adopt the old `cse_*`.
4. `Session` keeps the session-wide `#downstreamWriteAttempted` set and
   `claimDownstreamWriteAttempt(...)` fence for every mutating downstream event. The MITM claims an
   event immediately before its first `res.write` and never emits that event on a later worker stream,
   even if the delivery acknowledgement was lost. Only the genuine non-mutating initialize handshake
   may retain its separately proved reconnect behavior.
5. Permission/question answers are absent or disabled in the Claude 1.0 stable surface. Compatibility
   code may remain internal but cannot emit a stable native mutation.
6. The existing `accepted` compatibility frame means only **Received by host**. The browser may show
   local **Sending** followed by **Received by host**, but never “delivered,” “applied,” or “executed.” A
   worker receipt is diagnostic only. On session loss, the browser says **Delivery unknown**.
7. Existing `permission_resolved` compatibility frames are not presented as a stable native answer or
   as native “Allowed” or “Denied.”

For one source identity, remote-claw therefore attempts at most one mutating RC emission. It does not
claim exactly-once native execution. Durable per-command status rows and broker-before-dispatch
round-trips would become necessary only if same-session host takeover or automatic ambiguous retry is
reintroduced.

## Native output contract

1. The retained Linux arm64 Claude 2.1.237 proof establishes the observed compatibility boundary. In
   one current-version coverage run, all 30 first-arrival events across `assistant`,
   `control_cancel_request`, `control_request`, `control_response`, `rate_limit_event`, `result`,
   `system`, and `user` carried distinct RFC 4122 UUIDv4 `payload.uuid` values. In a separate
   lost-response run, the probe fully buffered an upstream HTTP 200 for a four-event
   `system`/`assistant`/`assistant`/`result` batch, reset the matching local response with no headers or
   writable bytes started, and observed an exact retry in the same trace-wrapper run and RC session
   path. The retained witnesses independently match request length/SHA-256, ordered types, aliased UUID
   coordinates, payload hashes, and a present worker-epoch alias. The sanitized artifacts, exact probe,
   pinned runtime-source/binary/package hashes, and offline verifier live in the
   [`spikes/claude-native-output` package](https://github.com/ejc3/remote-claw/tree/main/spikes/claude-native-output).
   The offline evidence gate verifies those historical source blobs at their captured Git commit;
   executable trace-contract tests guard the current pass-through/fault seam. A supported Claude
   tuple, proof claim, or fault-model change requires live recapture. This is one request-level
   observation; the four included event types are incidental, and the proof does not establish
   deterministic or per-type retry, Claude process identity, a specific question/permission subtype,
   or server-side application/dedup.
2. Within one live incarnation, exact identity plus the exact UTF-8 bytes of
   `JSON.stringify(payload)` returns the original event ID and sequence on retry. Changed normalized
   bytes under one identity are rejected as a collision and terminally close that remote session. An
   event without the proved coordinate or outside the retained type/epoch boundary does the same
   rather than receiving a synthetic identity.
3. One head-of-line publisher owns projection sequence allocation and broker publication across both
   relay pumps; native control side effects join the same queue without needing a sequence. It does not
   allocate, publish, or inject `N+1` until `N` is durably accepted. Failure latches the session closed
   before a queued publisher can proceed. The 65 s wall covers the complete logical post rather than
   one individual chunk or fetch; expiry is terminal and never authorizes an ambiguous replay.
4. Native `/worker/events` is observation intake, not a native mutation. It may be acknowledged after
   validated in-memory dedup rather than waiting on the broker, provided publisher failure ends the
   remote session and the viewer always discloses the possibly incomplete tail. Complete acknowledged
   output recovery across wrapper death would require a durable outbox and is not a 1.0 promise.

## Security and compatibility invariants

- Broker storage and application logs contain no prompt, response, tool, permission, or attachment
  plaintext; no content keys, pass/master secret, or provider credentials; and the broker cannot
  decrypt protected content. The broker necessarily receives its bearer admission capability, so a raw
  request capture is not claimed to contain no secret at all.
- The CLI is compiled and installable, and secrets remain off argv and logs. Stable MITM launch resolves
  the requested Claude launcher (`RC_CLAUDE_BIN` or `claude` on `PATH`), opens its resolved target with
  `O_RDONLY|O_NOFOLLOW`, and requires that target to be a root:root regular mode-`0755` file on Linux
  arm64 with exact version
  `2.1.237 (Claude Code)`, 331,864,296 bytes, and SHA-256
  `a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177` before identity creation. It
  holds that executable inode and launches through `/proc` until child exit, so an atomic pathname
  replacement cannot substitute unverified bytes. Its strict worker intake is the fail-closed protocol
  gate. Unsupported behavior requires an explicit experimental opt-in.
- The installed real-topology proof is invoked only as
  `./scripts/run-trusted-real-topology-clean.sh` from the repository root; direct Node and npm/pnpm
  lifecycle execution are refused. Its `#!/bin/busybox ash` process self-attests `/proc/$$/exe` as
  resolved `/usr/bin/busybox`, root:root mode `0755`, exactly 1,914,704 bytes, and SHA-256
  `52151e7f322f926b64049cdaa1410dc3ea6485525e0624b05813791c219ae933`. It accepts no arguments and
  NUL-pipes exactly `HOME`, `GITHUB_REPOSITORY`, `GITHUB_TOKEN`, `RC_DEPLOYMENT_ID`,
  `VERCEL_AUTOMATION_BYPASS_SECRET`, `VERCEL_TOKEN`, and `RC_PROVE_CLAUDE_CWD` into an `env -i` Node
  runner; no secret enters argv. It requires a clean full committed HEAD, creates and
  extracts a private `git archive` of that exact digest with trusted system binaries, frozen-installs
  the isolated workspace, and builds/packs only there. The installed tarball is a private owned regular
  file whose SHA-256 is checked before and after installation and bound into the receipt; Playwright
  neither imports nor packages the checkout.
- The runner resolves a supplied GitHub deployment ID only from the newest successful `vercel[bot]`
  Preview status at the pinned project/team origin and requires that deployment SHA to equal HEAD. It
  then fetches only that immutable origin's non-cacheable runtime attestation with redirects forbidden;
  the served Vercel environment must be Preview, its full `VERCEL_GIT_COMMIT_SHA` must equal HEAD, and
  its exact credential-free storage profile must be canonical `sqlite`/Turso with the attested
  organization, group, and `pr-<7sha>` scope. The four fleet variables must be complete and any explicit
  `RC_TURSO_DB_SCOPE` fails the attestation before Playwright. The browser and installed host use the deployment default—neither
  `--rc-backend` nor `?backend=` is present—so the stable relay's durable-cursor preflight proves the
  configured default is SQLite/Turso.
- Descendant discovery first requires `/proc/<pid>/exe` to resolve to the pinned Claude executable, then
  boundedly reads `/proc/<pid>/cmdline` with `O_NOFOLLOW` and accepts only the exact nonsecret
  release-payload argument tail before size/hash/environment attestation. The expected tail ends in
  `--remote-control remote-claw-release-proof`; the installed CLI's same-inode `--version`
  compatibility probe is a noncandidate; after the release payload matches, every byte or environment
  failure remains fatal.
- Before any credential-bearing browser leg, a bounded redirect-forbidden Management API read using a
  parent-only Vercel token verifies the exact enabled live active Firewall config, no
  draft/change/version ambiguity, pinned owner/team, canonical update time, the pinned project ID plus
  `#active` project key, empty active `ips` and `changes`, and the exact 11-category managed-rule matrix:
  `gen`, `rce`, `sqli`, and `xss` are
  active/log; `java`, `lfi`, `ma`, `php`, `rfi`, `sd`, and `sf` are inactive/log. Its sole active valid
  custom rule is the `/api/handoff` token bucket (20 requests per 60 s keyed by IP, excess denied), and
  the separate Firewall-bypass list is empty. The receipt retains only normalized nonsecret coordinates.
  Playwright, the wrapper, the browser process, and Claude receive separate minimal
  allowlisted environments; GitHub/Vercel-management/Turso/cron credentials and the caller's ambient
  environment do not flow into them. Missing prerequisites fail closed. The post-merge Production
  verifier independently repeats this exact live WAF and empty Firewall-bypass-list check before staging
  its receipt; that list is distinct from the Deployment Protection automation bypass.
- The Preview runner brackets the browser leg with Preview-only BEGIN/END Runtime Log canaries inside a
  runner-owned proof window of at most 30 minutes. Its private
  `remote-claw-real-topology-browser-leg/v4` receipt binds both canaries and a monotonic measurement of
  the deployed rotation: the exact marker must arrive 235–270 seconds after response open, a later
  session subscription must succeed, and a second turn must complete on the same `cse_*`.
- The topology receipt is inspection-pending until the operator invokes only
  `./scripts/run-trusted-final-inspection-clean.sh`. Its wrapper accepts no argv; byte-pins BusyBox, Git,
  and Node; and NUL-pipes exactly `RC_TOPOLOGY_RECEIPT_FILE`, `TURSO_API_TOKEN`,
  `TURSO_GROUP_AUTH_TOKEN`, and `VERCEL_TOKEN` into an exact `env -i` runner. Before credentials reach
  Node, the wrapper requires the clean exact topology HEAD and materializes and byte-compares its
  committed wrapper/runner/schema closure from that candidate's Git blobs. Both wrapper and runner
  independently recheck the clean exact HEAD after scanning. The runner also validates the exact locked
  `@libsql/client` 0.17.3 dependency closure, copies it to a private snapshot, revalidates it after use,
  and removes it. Operationally, the group credential must be newly minted, short-lived, and read-only;
  the scanner uses it only for reads but cannot prove the supplied credential's authorization or expiry.
- `remote-claw-real-topology-inspection/v1` is a bounded, content-free candidate receipt, not the final
  release attestation. It requires two stable physical-`DbId` enumerations of the exact attested
  `rc-pr-<7sha>-` fleet and scans `sqlite_schema`, `table_xinfo`, and every value under read snapshots.
  Each database hostname must be exact legacy `<database>-<organization>.turso.io` or contain exactly
  one additional DNS label equal to that API row's validated `primaryRegion`; all other shapes fail.
  It also resolves the immutable Preview deployment and recursively bisects page-zero Runtime Log
  queries until every leaf says `hasMoreRows:false`; a saturated 1 ms leaf, truncation, malformed or
  wrong-deployment row, missing canary, unsettled second snapshot, cap/deadline, or sentinel occurrence
  fails closed. Its zero-match statement is limited to every value in that stable Preview fleet and
  queryable retained Runtime Logs for that immutable deployment and proof window. It does not claim to
  inspect provider-internal, expired, or otherwise unqueryable telemetry. The credential-bearing runner
  writes only a private durable noncanonical stage. The wrapper binds its SHA-256/device/inode/size,
  independently rechecks the exact candidate, and materializes a fresh committed publisher closure. Only
  that exact credential-free publisher may strict-validate the stage and exclusively publish the
  canonical exact-schema 0600 receipt after complete-byte and parent-directory sync.
- This repository has no enforced branch protection. Before merge, the operator queries Actions by the
  immutable 40-character candidate SHA and requires a repository-owned `pull_request` run with
  conclusion `success` for `.github/workflows/cli.yml` job `test`, `web.yml`/`test`,
  `clawsec.yml`/`test`, `web-e2e.yml`/`e2e`, `native-proofs.yml`/`retained-evidence`,
  `workspace.yml`/`lockfile`, and `docs.yml`/`web-tests`. Missing, skipped, neutral, wrong-SHA, or
  duplicate untrusted-app results fail the gate. After the inspected candidate merges, the operator
  invokes only `./scripts/verify-production-release-clean.sh` with six NUL-delimited private inputs:
  `GITHUB_REPOSITORY`, `GITHUB_TOKEN`, `RC_PRODUCTION_DEPLOYMENT_ID`,
  `RC_INSPECTION_RECEIPT_FILE`, `VERCEL_AUTOMATION_BYPASS_SECRET`, and `VERCEL_TOKEN`. Before piping
  those credentials, the zero-argv wrapper independently byte-pins BusyBox, Git, and Node; derives the
  inspected candidate from the canonical private receipt filename; requires a clean merged HEAD with
  that candidate as ancestor and an equal tree; and materializes and byte-compares the committed
  wrapper/verifier/schema blobs. The credential-bearing verifier writes only a private durable
  noncanonical stage. After it exits, the wrapper binds the stage's SHA-256/device/inode/size, rechecks
  the exact initial merged HEAD/tree, and materializes a fresh committed publisher closure. Only that
  exact credential-free publisher may strict-validate/recheck the bound stage and exclusively,
  atomically, and durably publish the canonical Production receipt. The verifier checks the inspection
  both before provider access and immediately before staging: `completedAt` may be at most 71 hours old
  or five minutes in the future. Raw local Git rejects replacement refs and graft metadata, requires a
  clean merge HEAD, proves candidate ancestry, and requires equal
  candidate/Production tree objects. GitHub independently proves the same ancestry through its compare
  result and requires both commit-tree objects to equal the local trees. `main` and the supplied numeric
  Production deployment must be the newest successful `vercel[bot]` result at that merge HEAD and are
  rechecked before staging.
  The immutable Vercel deployment must be owned by the pinned team/project, READY, Production, and exact
  `main`; its no-store runtime attestation must bind the merge SHA plus `sqlite`/Turso/`prod` and the same
  organization/group inspected in Preview. The verifier re-attests the exact enabled live active
  Firewall config with pinned owner/team, canonical update time, the pinned project ID plus `#active`
  project key, empty `ips`/`changes`, and the exact managed-rule matrix (`gen`/`rce`/`sqli`/`xss`
  active/log; `java`/`lfi`/`ma`/`php`/`rfi`/`sd`/`sf`
  inactive/log), its sole valid `/api/handoff` custom rule, unambiguous draft/version state, and a
  separate empty Firewall-bypass list. It separately requests the immutable application origin with no
  automation bypass to prove Deployment Protection. In either accepted 401 or 302 shape, the
  Secure+HttpOnly `_vercel_sso_nonce` cookie must be exactly 48 lowercase hex characters and the
  64-lowercase-hex SSO callback nonce must equal SHA-256 of that cookie nonce's ASCII bytes. It sends the
  automation bypass only to that origin's runtime attestation, frame-count, and relay requests—never to
  GitHub or Vercel Management APIs. A random fresh
  session on the deployment default must progress from a null durable frame count through a
  `created:true` `/api/relay` write to a durable count of one. The resulting atomic private
  `remote-claw-production-release-attestation/v1` receipt retains the physical `rc-prod-s-*` database ID
  and frame digest/counts, not the challenge, bearer, or frame bytes; complete receipt bytes and the
  parent directory are synced before success. Exact-merge CI must also pass as separate release-record
  evidence; the receipt does not query Actions. Ordinary CI cannot substitute for the recorded
  topology/inspection chain, and the real Claude/browser turn is not rerun on Production.

## One required release suite, two proof legs

Both legs are required; neither substitutes for the other.

### 1. Deterministic fail-stop matrix

Use the production MITM, relay, session, viewer-state code, real SQLite/libSQL broker, and faithful fake
worker. Prove:

- an ambiguous browser POST never creates an automatic new-ID retry;
- broker stream reconnect handles one source `msgId` once;
- six planned stream rotations remain live without changing the inbound failure budget, while raw EOF
  still consumes it;
- worker SSE disconnect after the first user/control write but before its acknowledgement never emits
  that mutation again;
- permission/question answer controls are absent or disabled;
- exact native-event retry returns one event/projection and a UUID collision fails closed;
- a stalled or failed projection `N` prevents `N+1` from reaching the broker across both pumps;
- never-settling cursor requests cross their 70 s attempt walls and stream-header requests cross their
  20 s walls; an established SSE
  stream with no actual byte crosses its 40 s idle wall; and only clean absence or a newly admitted
  authenticated frame resets the inbound failure count;
- one entire multi-chunk logical post, including 409 retries, crosses its 65 s wall without a late
  replay, while the third consecutive inbound failure closes the `cse_*` and owner abort remains
  exempt;
- fatal publication closes the remote session, stops further intake/emission, and leaves the local TUI
  only under the disclosed fail-stop boundary;
- known physical loss of a transcript or identity-bus database cannot recreate the same live channel;
  permanent bus loss closes the Session, while an ordinary announce 5xx does not;
- a far-future authenticated announce is visible but non-writable on first load and cold reload, exact
  replay does not refresh it, and a corrected higher `announce_seq` restores liveness;
- a successor session has a fresh `cse_*` and receives no old command; and
- every unsupported stable control is absent or disabled.

### 2. Installed real-topology smoke

Invoke the trusted proof only through
`./scripts/run-trusted-real-topology-clean.sh` from the repository root, build and install only from
its isolated exact HEAD archive, use the exact byte-pinned `/usr/bin/claude` under a PTY, drive the
actual browser UI, and use a deployed production-code Vercel Preview whose **default** backend is
SQLite/Turso. Cover live WAF
verification, the launched Claude descendant's resolved path, exact argument-tail selection, `/proc`
executable bytes, and release-clean environment, plus onboarding, discovery, a first
text turn and assistant output, durable browser reload, the actual 240 s `: rotate` marker and later
successful subscription, re-attestation of the same Claude descendant, a second received/replied turn
on the same `cse_*`, truthful local-input and incomplete-tail disclosure,
zero occurrences of its run-bound plaintext sentinel across the bounded Preview storage/log surfaces
defined below, and disabled permission/question answer
controls. No CLI or browser backend selector may make a misconfigured deployment appear valid.

The trusted runner's private `remote-claw-real-topology-browser-leg/v4` receipt is the first chain link
and remains explicitly inspection-pending. Its exact schema binds the archived package digest, deployed/runtime
SHA, pinned Claude version/platform/arch plus `binaryBytes` and `executableSha256`, normalized
`edgeRateLimit` coordinates, both log canaries, a proof window no longer than 30 minutes, measured
235–270 s stream rotation, reconnect/post-rotation same-`cse_*` turn facts, Chromium result, and the
nonsecret scan sentinel. The Playwright wall is 780 s because a valid run must cross the real rotation
and consumes two Claude inference turns. The self-attested BusyBox bootstrap metadata is a gate
precondition, not an added durable-receipt field.

The second link, `remote-claw-real-topology-inspection/v1`, binds the v4 receipt digest and records only
coordinates, hashes, bounded counts, times, and zero sentinel matches. Its committed-module and pinned
dependency bootstrap requires the clean exact candidate before and after scanning. Turso inspection is
capped at 256 databases, 4,096 tables, 65,536 columns, 250,000 rows per table, 5,000,000 rows,
100,000,000 values, and 4 GiB of value bytes. Runtime Log inspection is capped at 4,096 queries and
1,000,000 requests and requires two identical exhausted snapshots after the END canary. Inspection may
start at most 71 hours after the topology proof window began, and that window may complete at most five
minutes in the future. Each operation has a 30 s wall and the entire inspection has a 10-minute wall.
Missing/incomplete evidence, provider drift, or any sentinel match fails the suite. The exclusive 0600
canonical receipt cannot exist before the credential-bearing runner emits a private durable
noncanonical stage and the outer wrapper binds its digest/file identity and passes its independent Git
recheck. A freshly materialized committed credential-free publisher then strict-validates the stage and
atomically/durably/exclusively publishes the receipt after file and directory sync.

Inspection and Production share one publication state machine. The publisher writes exact staged bytes
to a random hash-bound mode-0600 source, syncs that file, syncs the pinned parent while only the source
name exists, and revalidates the source, stage, root, and absent canonical name. It then hard-links the
canonical name while the inode remains non-authoritative at link count two, syncs the parent, and
re-opens and revalidates both exact same-inode names plus the visible root before unlinking the source.
Finally it syncs the canonical file and parent and revalidates the exact single-link canonical inode.
When canonical is absent or two-linked, fresh recovery uses a pinned streaming directory read that
refuses on the 4,097th entry: it deterministically adopts an exact same-stage single-link orphan, ignores
torn or stale random sources, or reconciles the sole grammar-valid alias of an exact two-link canonical
inode. An exact single-link canonical inode bypasses enumeration and is recovered by direct file and
directory sync plus revalidation. Recovery never deletes conflicting evidence. Exit 75 or a
signal-killed publisher gets one fresh same-stage process retry; a failed retry remains 75. Once
publication has started, an outcome still unresolved after that retry—or an outer-wrapper signal while
the publisher outcome remains unresolved—preserves the stage. Once publisher success is observed,
cleanup may remove the stage; a later outer-wrapper signal still reports no success and leaves the
committed canonical inode. A later normal wrapper invocation refuses any preserved stage instead of
regenerating different evidence. Automatic recovery after death of the whole outer wrapper is not a 1.0
claim because it would require a caller-held provenance ticket outside the same-UID receipt namespace.
The retained transaction is fail-stop and indeterminate to the caller: it may include an irreversibly
visible canonical inode, but the interrupted wrapper never reports a passed receipt.

The terminal post-merge link, `remote-claw-production-release-attestation/v1`, binds that inspection
receipt's exact bytes only while its completion is at most 71 hours old or five minutes in the future.
It binds raw-local and GitHub-proved candidate ancestry/equal trees to the exact live Production
deployment/runtime, re-attests the live WAF and empty Firewall-bypass list, proves Deployment Protection
with a no-bypass request, and records a fresh default relay→Turso null/create/write/read-to-one result
with its physical database ID. The automation bypass is confined to immutable-origin application calls.
Its credential-bearing verifier likewise creates only a private durable noncanonical stage. The outer
wrapper binds its digest/file identity, rechecks the initial merged HEAD/tree, and then materializes the
fresh committed credential-free publisher that strict-validates/rechecks and
atomically/durably/exclusively publishes the canonical mode-0600 receipt. Exact-merge CI is a separate
release-record requirement.
Candidate and merge commit SHAs normally differ; their Git trees must be identical.

The runner performs no broker data-plane warm-up before installed-host launch, but its receipt attests
the exact Preview SHA and canonical storage coordinates—not physical absence of that SHA-scoped Turso
index. Preview CI or a prior manual request may have warmed it. The deterministic hard-wall regressions own
the cold-index behavior. A separately verified unused scope is required before describing a live run as
physically cold; release evidence must not infer that fact from the topology receipt alone.

## Implementation order

These are internal merge boundaries, not separate product tranches. Each implementation boundary must
close one runnable causal path; there is no additional design-only “freeze” change:

1. Retain and gate the Linux arm64 Claude 2.1.237 lost-HTTP-200 UUID proof. This evidence boundary is
   complete; further native retry research is out of scope unless implementation finds a concrete
   contradiction.
2. **Implemented:** one host/native fail-stop vertical. The stable MITM entrypoint skips dormant A1
   runtime-owner initialization, enforces the supported Claude tuple and exact executable bytes, and
   holds the proved inode through child exit; strict `/worker/events`
   intake atomically reserves UUID plus normalized bytes; exact retry reuses its result, while invalid
   or colliding admission terminally closes that `cse_*`; a session-wide fence prevents mutating SSE
   redelivery; one head-of-line queue owns projection sequencing/publication across both pumps and
   native control side effects; 70 s durable-cursor and 20 s stream-header walls, 40 s actual-byte SSE idle failure, a
   neutral planned 240 s rotation, a 65 s logical-post wall, and the third consecutive inbound failure
   bound transport liveness; and any fatal publisher, permanent identity-bus loss, or inbound-exhaustion
   failure closes that `cse_*` before later intake, publication, or injection. Deterministic production-path tests cover both
   cross-pump failure directions, closed-route behavior, the local-TUI survival boundary, and a fresh
   successor receiving no old mutation.
3. **Implemented:** the browser/broker stable-surface vertical. SQLite distinguishes exact replay from
   changed-byte collision and fails closed on known channel-store/core loss; terminal presence is
   absorbing; viewer liveness has a 5 s future-skew ceiling and replay cannot refresh it; ordinary inactivity sweep is non-mutating;
   ambiguous publish has no automatic new-ID retry; permission/question answers and other unsupported
   controls are absent or disabled; and status/tail/local-input wording states only supported facts.
4. **Release evidence boundary:** archive the exact clean HEAD, build and install the stable CLI without
   repository tooling, then pass both release-suite legs, the repository's full checks, independent
   review, and exact-candidate CI. Seal topology v4 and inspection v1 before merge; merge only an
   equal-tree candidate; then pass exact-merge CI and seal the Production release attestation. Record
   the actual SHAs and receipt digests outside the candidate tree so reporting cannot invalidate the
   bytes it claims to prove.

Then release Claude 1.0 and stop. Any multi-engine platform work requires a new explicit product
decision; it is not an automatic “next tranche.”
