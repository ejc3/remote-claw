# remote-claw

A custom client + relay for driving a **real `claude --remote-control` session**
— your own frontend in place of Anthropic's web/mobile app.

> **Current product status:** the Claude own-relay is a working developer beta. The sole active finish
> line is an installable, failure-safe, truthfully presented
> [remote-claw Claude 1.0](docs/release-finish-line.md). The broader client-driven host runtime,
> OpenCode, Codex, tmux durability, provider façades, and nested collaboration are parked future work;
> they do not block this release.

## What this is

Claude Code's official **Remote Control** lets you drive a local Claude Code
session from claude.ai/code or the Claude mobile app: the session keeps running
on your machine (your filesystem, MCP servers, tools), and the web/app are thin
windows that sync conversation **state** (not your terminal screen).

`remote-claw` provides the same local-session shape with **a client you control**. Today it runs the
real Claude Code behind a process-scoped local TLS proxy, answers Claude's
`/v1/code/sessions/**` Remote Control calls, and sends E2E-encrypted frames through a broker to the
remote-claw web client:

```text
remote-claw web ⇄ ciphertext broker ⇄ host relay ⇄ local RC façade ⇄ real Claude Code
```

It does **not** depend on redirecting `--sdk-url`; that route was patched out. The current default
still passes non-RC traffic, including inference/OAuth, to Anthropic. A retained experimental
Bedrock/accountless mode terminates the Anthropic control plane locally, but is outside the Claude 1.0
release surface. The default boundary is not a claim that Anthropic inference is zero knowledge.

## Status

✅ **Phase 0 done — working own-relay (proved with Claude Code v2.1.168).** The original
`--sdk-url` trick is **patched** (hardcoded 5-host allowlist + wss/https-only,
rejected before any socket opens). But the real Remote Control transport turned
out to be a plain HTTPS API on `api.anthropic.com` (`/v1/code/sessions/…`), so
`remote-claw` instead **MITMs that host per-process**: it intercepts the RC
endpoints to become your own relay, while passing `/v1/messages` through to real
inference. A local `claude --remote-control` TUI and our own web client drive the
same live Claude session for browser-originated turns and observed outputs. Local-TUI prompt text is
not currently projected to viewers; remote-claw does not promise a lossless mirror of local-only input.

```bash
cd phase0
./remote-claw doctor      # check claude/openssl/certs/ports/auth
./remote-claw up mysession   # relay + TUI; prints a tokenised UI URL (:9100)
./remote-claw test        # automated tests (e2e + two-surface)
```

Hardened: stdlib-only `remote_claw` package, token-gated client face, secret-redacted
logs, 0600 cert keys, graceful shutdown, unit + integration tests, and CI
(`.github/workflows/ci.yml`). See [`phase0/README.md`](phase0/README.md).

The current Claude 1.0 native-output compatibility proof is separately pinned to Linux arm64 Claude
Code 2.1.237. Its sanitized retained artifacts cover all eight observed worker-event types and prove
that one fully buffered HTTP-200 `/worker/events` response withheld before downstream headers was
followed by a byte-identical same-session retry with the same ordered UUID coordinates. This is one
request-level observation, not a deterministic or per-event-type retry claim. See
[`spikes/claude-native-output`](spikes/claude-native-output). The offline artifact check verifies its
historical captured-source blobs; executable current-tree tests separately guard the trace/reset seam.

## v2 — cloud-brokered, zero-knowledge, E2E-encrypted baseline

Phase 0 proved the interception. **v2** is the product: drive your machine's Claude
sessions from a phone/browser through a **zero-knowledge cloud broker** that sees only
ciphertext. The baseline was previously proved end to end; the stricter installable Claude 1.0 tree is
releasable only when its full gates, independent review, exact-SHA CI, and chained
Preview-to-Production receipts all pass. Actual run state and hashes live in the PR release record, not
in these candidate-bound bytes.

- **`packages/clawsec`** — the crypto core: the HKDF key hierarchy, per-message AES-256-GCM,
  the §8 wire envelope, the derivable channel tokens, and the `rcp1_` viewer **pass**.
- **`apps/web`** — the pluggable **broker** (`POST /api/relay`, `GET /api/stream`; a per-identity
  bus + per-session relay) with capped Vercel Workflow run streams and durable SQLite/libSQL
  backends. The
  current host and viewer use sealed mode with every backend, so the backend sees only ciphertext and
  routing metadata. It also serves the mobile-first **web client** (paste a pass → discover sessions →
  drive them, decrypted in-browser).
- **`packages/cli`** — the `remote-claw` wrapper: identity/pass management (`--rc-identity`,
  `--rc-pass`), the broker transport (`BrokerClient`), and the **RC MITM backend** (`@remote-claw/cli/rc`:
  `MitmProxy` + `RelayCore`/`Session` + `HostRcRelay`) — the Phase-0 interception core ported to TS.
  Its `host/native` compatibility contract is independent of `Session`; the process-local registrar
  assigns a distinct lease to each intercepted Claude conversation and starts its bridge only after
  validated setup reaches `ready`. The MITM use of that seam is active; expanding it into a durable
  multi-engine host is not.

**The RC backend (the real one, §14/§17.5):** you run `remote-claw` like `claude` (`--rc-app <broker>`
arms it); inside, `/remote-control` lands on **our local TLS MITM of `api.anthropic.com`** (set via
`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`), which serves the `/v1/code/sessions*` worker endpoints itself
and, with the default `--rc-inference=anthropic`, passes `/v1/messages` + OAuth through. With
the experimental `--rc-inference=bedrock`, it routes inference to Bedrock and synthesizes the remaining
Anthropic-origin control/API responses locally; that connector is not part of the Claude 1.0 release
claim. Stable launch requires Linux arm64 plus exact Claude
`2.1.237 (Claude Code)` before identity creation and does not initialize the parked A1 runtime owner.
The production compatibility probe resolves the requested Claude launcher (`RC_CLAUDE_BIN` or
`claude` on `PATH`), opens its resolved target with `O_RDONLY|O_NOFOLLOW`, and requires that target to be a root:root regular
mode-`0755` file with exactly 331,864,296 bytes and SHA-256
`a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177`, and holds that executable inode
through `/proc` until the child exits; replacing the pathname after the probe cannot substitute different
bytes for the launched process. The trusted installed release proof is narrower: it refuses
`RC_CLAUDE_BIN` and hard-pins the requested launcher to `/usr/bin/claude`.
The supported deployment must default both host and viewer to the durable SQLite/Turso profile
(`BROKER_BACKEND=sqlite`); an explicit `--rc-backend sqlite` is safe only when the viewer also selects
`?backend=sqlite`. The stable host discovers effective durability from the server and fails closed
before announcing or serving a non-durable Workflow/local route.
The wrapper *is* the RC backend, so it strictly deduplicates native UUID coordinates, terminally
closes that `cse_*` on an invalid/colliding native batch, fences each downstream mutation before its
first SSE write attempt, and serializes both projection pumps plus native control side effects through
one publisher. Durable-cursor reads have a 70 s attempt wall, initial stream headers have a 20 s wall, an established SSE
stream fails after 40 s without an actual byte, one complete logical publication (all chunks and
authoritative 409 retries) has a 65 s wall, and the third consecutive inbound transport failure closes
the remote `cse_*`. A clean absent-channel response or newly admitted authenticated frame resets that
failure count; owner abort is normal shutdown. The server deliberately ends each healthy SSE response
240 s after its body starts with the exact `: rotate` marker, nominally 60 s before Vercel's configured
300 s wall; that planned reconnect neither
increments nor resets the failure count, while an unmarked/raw EOF still counts as failure. A timed-out
publication is ambiguous and is never replayed automatically. A fatal publication, permanent identity-bus
storage loss, or exhausted inbound transport closes only that remote `cse_*` while leaving the local TUI
alive. The durable backend records create-once channel continuity: a catalogued channel whose physical
store, in-database witness, or core schema disappears fails closed and is never silently recreated under
the same token. A hard 30 s create→serve readiness barrier sits inside the 60 s cursor routes and the
70 s caller wall; every newly opened channel, continuity-index, and handoff client crosses it before schema
or data access and is never cached on failure.
Each SQLite subscription query also has a hard 15 s maximum, configurable only downward, and frame/state
polls share a three-consecutive-transient-failure budget. A row-bearing frame query or a complete
successful empty-frame/state decision resets it; the third transient, any timeout, or a nontransient
failure terminates and evicts/releases the client so SSE keepalives cannot hide a durable-provider outage.
It bridges accepted frames E2E-encrypted to the broker. The broader compatibility path is proven by
`rc-spine.integration.test.ts`: a fake worker speaks the captured `--remote-control` worker protocol
(register → triggers → bridge → SSE → delivery-ack → events → heartbeat) through the real MITM, while
the browser drives a turn, catch-up, sub-agents, compatibility-only permission grants, and multi-client
through the real broker on the Workflow runtime. The exact stable production launch boundary—tuple and
capability gate, registrar/readiness, and child-env scrubs—is exercised with a real logged-in Claude and
PTY by gated `real-launch.prove.test.ts`; `real-rc.prove.test.ts` remains lower-level MITM/relay coverage.
The viewer keeps authenticated `sent_at` for legacy ordering but derives liveness from `freshnessAt`:
an exact coordinate keeps its first value, host lead over five seconds starts at the stale edge, and
every other accepted coordinate uses `min(sentAt, receivedAt)`. Thus exact replay cannot refresh it
across stream reconnects or cold reloads. The release evidence is one three-receipt chain over a frozen
candidate tree. First, `remote-claw-real-topology-browser-leg/v4` records the exact-HEAD archived and
packed CLI, deployed-default Turso/browser leg, runner-owned log window/canaries, and a measured
235–270 s rotation plus reconnect and second same-session turn. Its pinned static clean-environment launcher self-attests
the exact `/usr/bin/busybox` bytes through `/proc/$$/exe`, then the trusted runner pins the exact Claude
tuple. After launch it verifies the descendant's resolved executable path, selects only the exact
nonsecret release-payload argument tail (not the same-binary `--version` probe), and re-verifies its
size, hash, and release-clean environment. It uses minimal child environments and requires a non-cacheable
runtime attestation binding the full Preview SHA plus canonical `sqlite`/Turso organization, group, and
`pr-<7sha>` scope; any explicit scope override fails the proof. It also requires live evidence
for the exact `/api/handoff` WAF rule before the credential-bearing browser leg. That leg must observe
the real 240 s rotation, reconnect, re-attest the same Claude process, and complete a second turn on the
same `cse_*` before its receipt can pass. Second, `remote-claw-real-topology-inspection/v1` binds that
receipt to zero occurrences of its run-bound plaintext sentinel across every value in the stable
exact-prefix Preview Turso fleet and the queryable retained Runtime Logs for the immutable deployment/window;
the bounded scanner does not claim provider-internal or expired telemetry. Its bootstrap byte-pins
BusyBox, Git, and Node, executes a committed candidate snapshot of the inspection modules, independently
requires the clean exact candidate HEAD before and after provider access, and snapshots the exact pinned
libSQL dependency bytes. Its credential-bearing runner writes only a private durable noncanonical stage.
The wrapper binds that stage's SHA-256 and file identity, independently rechecks the exact candidate,
and materializes a fresh committed publisher snapshot; only that exact credential-free publisher may
strict-validate the stage and exclusively, atomically, and durably publish the canonical inspection
receipt. Both downstream publishers use the same three-phase hard-link transaction: sync an exact
random hash-bound source file and its source-only directory entry; link the still-non-authoritative
two-name canonical/source pair, sync the directory, and re-open/revalidate both names plus the visible
root; then unlink the source, sync the canonical file and directory, and perform a final exact
single-link revalidation. When canonical is absent or two-linked, recovery refuses on directory entry
4,097 while streaming from a pinned handle, adopts an exact same-stage orphan, ignores torn/stale
sources, and reconciles an exact two-link pair without deleting conflicting evidence. Exact single-link
canonical state is recovered directly without directory enumeration. The wrapper retries one typed
indeterminate or signal-killed publisher in a fresh process with the same bound stage. Any unresolved
publisher result preserves that stage, and a later normal wrapper invocation refuses a preserved stage
rather than destroy or supersede it. Once publisher success is observed, cleanup may remove the stage;
a later outer-wrapper interruption still reports no success and leaves the committed canonical inode.
Automatic recovery across whole-wrapper death is not claimed without an external caller-held
provenance ticket. Third, after merge,
`remote-claw-production-release-attestation/v1` accepts the inspection only
within a 71-hour age and five-minute future-skew bound. Its zero-argv wrapper byte-pins
BusyBox, Git, and Node; derives the candidate from the canonical private inspection filename; requires
the clean candidate-ancestor/equal-tree merge; materializes committed wrapper/verifier/schema blobs
before piping credentials; and rechecks the repository afterward. The credential-bearing verifier also
writes only a private durable noncanonical stage. The wrapper binds that stage's SHA-256 and file
identity, rechecks the exact initial merged HEAD/tree, and materializes a fresh committed publisher
snapshot; only that exact credential-free publisher may strict-validate the stage and publish the
canonical Production receipt. The verifier proves ancestry and candidate/merge tree equality through
both raw local Git and GitHub's compare/commit
objects and binds the newest successful exact-`main` Production deployment. It re-attests an exact live,
enabled active Firewall config whose sole custom rule is the valid `/api/handoff` token bucket, whose
owner/team is pinned, whose update time is canonical, whose project key is the pinned project ID plus
`#active`, whose `ips` and `changes` are empty, and whose exact managed-rule matrix keeps `gen`, `rce`,
`sqli`, and `xss` active/log while `java`, `lfi`, `ma`, `php`,
`rfi`, `sd`, and `sf` are inactive/log. Draft/version state is unambiguous, and the separate
Firewall-bypass list is empty. It independently proves that the immutable origin remains Deployment
Protected without a bypass and confines the automation bypass to that origin's runtime-attestation,
frame-count, and relay calls. A fresh default-backend session must read as absent, create and durably write one opaque frame through
`/api/relay`, then read back a frame count of one from its physical `rc-prod-s-*` Turso database. The
content-free receipt retains only nonsecret coordinates, including the database ID and frame digest;
finalized receipts are private, complete, file-and-directory-synced artifacts. Candidate and merge
commit SHAs may differ; their trees must not.

Separately, the native **`stream-json` SDK transport** (`HostRelay` + `ClaudeStreamSession`,
`--print --input-format stream-json`) remains as the **documented cousin** for cross-checking the protocol and
for an inference-agnostic headless path — point it at **Amazon Bedrock**/Vertex (`{ bedrock: true }`)
and claude routes inference via the AWS SDK while remote-claw relays it, never touching the creds.

📐 **Design:** [`docs/v2-architecture.md`](docs/v2-architecture.md) — the full v2 design,
threat model, key hierarchy, broker, and phased plan.

🎯 **Active release finish line:** [`docs/release-finish-line.md`](docs/release-finish-line.md) — the
smallest honest path from the working Claude developer beta to an installable 1.0: one-incarnation
command safety, fail-stop delivery/output, truthful UI states, supported-version and deployment boundaries,
and one required two-leg crash-matrix/real-topology release suite.

🧭 **Parked future platform:** [`docs/client-driven-host-runtime.md`](docs/client-driven-host-runtime.md)
and [`docs/a1-opencode-vertical-slice.md`](docs/a1-opencode-vertical-slice.md) preserve the optional
multi-engine design and its safety requirements. They are not the current delivery sequence.

🔑 **Credential handoff:** [`docs/ephemeral-handoff.md`](docs/ephemeral-handoff.md) — the one-time-key
(OTK) ephemeral handoff that replaces the forever pass-in-QR with a single-use, short-TTL bootstrap
token sealed in a zero-knowledge broker store.

📄 **[`phase0/README.md`](phase0/README.md)** — how to run it ·
**[`docs/phase0-findings.md`](docs/phase0-findings.md)** — the full reverse-engineered
protocol, the de-minified `--sdk-url` validator, and the build writeup (§4a–4c) ·
**[`phase0/TEST_PLAN.md`](phase0/TEST_PLAN.md)** — test plan.

🔬 The Phase 0 notes are **pre-investigation research**. Read Parts 3/5/6 of the research doc as
history; the verified current protocol is in `protocol.md` and `phase0-findings.md`.

## Start here

For the current implementation, read:

- [`docs/release-finish-line.md`](docs/release-finish-line.md) — the sole active Claude 1.0 outcome,
  safety invariants, scope boundary, and executable release gate.
- [`docs/protocol.md`](docs/protocol.md) — as-built protocol and runtime.
- [`docs/phase0-findings.md`](docs/phase0-findings.md) — reverse-engineered Claude RC evidence.
- [`docs/client-driven-host-runtime.md`](docs/client-driven-host-runtime.md) — parked future-platform
  design, not a Claude 1.0 dependency.
- [`docs/remote-control-research.md`](docs/remote-control-research.md) — historical research that led
  to Phase 0.

## Getting started

Clone on your server and check out `main`:

```bash
# git
git clone https://github.com/ejc3/remote-claw.git
cd remote-claw && git checkout main

# or GitHub CLI
gh repo clone ejc3/remote-claw -- --branch main
```

Then install dependencies and run the repository gates:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm test
pnpm test:install
```

**Auth for current default Anthropic inference.** A real end-to-end test needs `claude` authenticated
with a full claude.ai login. An inference-only `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY` cannot establish an official Remote Control session:

```bash
claude auth login      # full-scope; uses your Pro/Max subscription
claude auth status
```

The experimental `--rc-inference=bedrock --rc-accountless` path is separate and outside the Claude
1.0 release surface: remote-claw supplies the private RC/control façade and routes inference to
Bedrock, so it does not create an official Anthropic Remote session.

## Claude 1.0 release candidate

There is one required outcome: **remote-claw Claude 1.0**. A candidate closes one causal
path: pinned stable launch, strict native-event identity, at-most-one worker-SSE write attempt,
cross-pump head-of-line publication, fatal per-session closure, authenticated terminal presence,
exact SQLite replay versus collision, no automatic new-ID retry after an ambiguous POST, only
non-empty non-slash text writable, unsupported controls/permission answers absent or disabled, and
truthful **Received by host** / **Delivery unknown** / incomplete-tail wording. The root package now
builds, packs, and installs a compiled `remote-claw` executable without repository tooling.

The release gate is proof, not another product tranche: full local checks, independent review,
exact-candidate CI, topology v4, bounded inspection v1, an equal-tree merge, exact-merge CI, and the
Production release attestation. Because the repository has no enforced branch protection, “green CI”
means checking the required repository Actions runs against immutable 40-character SHAs, not a branch
name or check label. The exact scope and stop condition are in the
[Claude 1.0 finish line](docs/release-finish-line.md). Multi-engine work resumes only after a separate
product decision.

## ⚠️ Security

The v2 broker authenticates identity-scoped data and recovery requests and sees only sealed frames plus
routing metadata. The optional one-time handoff bootstrap is a separate, unauthenticated high-entropy
capability: if it ships enabled, its proof, short TTL, body cap, single-read store, and edge rate limit
are its gate. The host's
TLS proxy binds to `127.0.0.1`. Keep the machine secret/pass, provider credentials, generated CA key,
and Vercel bypass secret private. The current default Anthropic inference path intentionally forwards
non-RC traffic; the zero-knowledge claim applies to the remote-claw broker, not to the model provider.
The Claude 1.0 target does not require a new multi-provider credential or connector architecture. A
viewer pass grants read and control for every session on that machine identity; pass holders are
mutually trusted and can construct valid sealed frames. There is no per-viewer role or individual
revocation in v1: resetting the machine identity moves future service but does not revoke copied old
credentials on retained routes.

## License

TBD.
