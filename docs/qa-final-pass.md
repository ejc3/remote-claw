# remote-claw — final QA pass (2026-06-12)

A whole-system adversarial QA sweep run after the durable-log track (PRs #80–84) landed. Two independent
reasoners audited every flow — the real `codex` CLI (gpt-5.5, xhigh effort) and an 8-dimension
verify-everything agent workflow (62 agents, ~3.2 M tokens) — and every existing test suite was run
green as a baseline. This document collects the verifications and the triaged findings so the result is
auditable, and tracks the fixes that close them.

> **Historical identity scope:** this report evaluates the shipped flat-session baseline. Its
> `cse_*` session ID is a synthetic broker channel/viewer-row key, not the stable remote-claw
> logical-chat ID targeted by the later client-driven host runtime. The collision and restart fixes
> below remain valid for that compatibility transport; they do not claim durable logical-chat,
> native-binding, or outward Anthropic/OpenAI binding recovery.

## TL;DR

- **The crypto / zero-knowledge core is verified CLEAN.** The broker never sees plaintext: AEAD binds
  every cleartext routing column (cross-channel and cross-plane replay both fail AEAD), per-frame CSPRNG
  salt+nonce plus a per-message subkey means no GCM nonce reuse, HKDF key separation is clean (bus/auth
  vs content vs control vs meta), auth-token compare is constant-time, and a Sealed client refuses Open
  frames (no silent downgrade). The master secret is suppressed from `--rc-json`/`--rc-quiet`; the web
  strips a fragment credential on entry, then stores one non-extractable AES device key in IndexedDB and
  only wrapped pass ciphertext in tab-scoped sessionStorage. The dev-only `/api/dev/sweep` route is
  prod-gated (404).
- **The real bugs are operational, not cryptographic** — session identity, host-restart / reconnect
  ordering, and retention / teardown / Turso-resilience edges. None of them weaken E2E encryption.
- **Baseline: all green** — Playwright e2e across the backends (Local, **Turso**) and the unit suites
  (clawsec, cli, web). (This report predates removing the Temporal backend; its Temporal/drain rows are
  historical.)

## Methodology

- **codex (gpt-5.5, xhigh):** an autonomous read-only adversarial review of the durable-log, broker,
  viewer, host/CLI, and crypto surfaces (brief + raw output preserved under `~/rc-traces/qa/`).
- **Adversarial workflow (62 agents):** eight flow dimensions, each deep-read and audited, every finding
  independently verified (CONFIRMED / PLAUSIBLE / ALREADY_GUARDED / REFUTED) against the actual code,
  plus a completeness critic and a ranked synthesis. Result: 37 verified findings (17 CONFIRMED, 6
  PLAUSIBLE, 9 ALREADY_GUARDED, plus coverage/CI items).
- **Baseline runs:** every suite below was executed locally and recorded.

## Baseline evidence

| Suite | Backend / scope | Result |
|-------|-----------------|--------|
| Playwright app-e2e | LocalBackend | 8/8 |
| Playwright app-e2e | **Turso (libSQL)** | 8/8 — real sealed-frame round-trip (118 KB libSQL written) |
| Playwright app-e2e | Temporal *(historical — backend since removed)* | 8/8 — asserted a `relayChannel` workflow existed |
| Playwright app-e2e | drain (real build) *(historical — removed)* | 1/1 |
| vitest | @remote-claw/clawsec | 109/109 |
| vitest | @remote-claw/cli | 271/271 |
| vitest | @remote-claw/web | 136 passed / 12 skipped |

## Fixed in this pass

Every fix ships with a regression test, and each cluster was adversarially re-reviewed (codex + the
workflow) before merge — the review of the durable-restart fix itself caught a follow-up gap (C1) that
was then closed. Landed as a reviewed commit stack:

1. **Session-id collision across launches (CRITICAL).** `newId()` was a process-local counter reset to 0
   each launch, so the first RC session of *every* launch was `cse_12654435761`; under one identity,
   sequential launches collided on a single broker channel, and on a durable backend the second session
   read/extended the first's frames. Session ids are now crypto-random (globally unique), test-injectable.
2. **Host secrets scrubbed from the child claude** (`REMOTE_CLAW_SECRET_FILE`,
   `VERCEL_AUTOMATION_BYPASS_SECRET`) in both `launch.ts` and the `--rc-trace` path; the host still
   authenticates (it reads the bypass before building the child env).
3. **Blank `?backend=` → the default, not 400**; the Turso durable e2e is wired into CI (`web-e2e.yml`).
4. **Durable-restart re-execution safety (security).** A host restart on a durable backend re-subscribed
   inbound from `startIndex:0` with an empty inbound `#seen` set and re-injected historical `user`
   prompts (and replayed `permission` answers) into claude. The relay now resumes BOTH durable cursors before the pumps
   go live — `maxSeq` (outbound seq) and a new `frameCount` (the inbound publish-order high-water mark, via
   a zero-knowledge `/api/frame-count` route) — so already-stored historical indices are skipped. A
   failed cursor read **fails closed** (no seq-0 collision). This is not semantic exactly-once: A0 does
   not persist the authenticated source digest or original `accepted` result, so a lost acknowledgement
   or the same source ID re-appended above the sampled floor remains ambiguous. A1 must persist that
   result with the contiguous ingress cursor before it can claim restart-safe replay.
5. **Durability discovered from the server, not the `--rc-backend` flag.** `/api/seq` reports `durable`,
   so a default-turso deployment is protected even when the host omits the flag. The gen-bump race is
   closed (a Turso `gen` only bumps on the internal `__close`+reopen; `/api/relay` rejects that sentinel).
6. **Turso resilience.** Writes are serialized through a per-client mutex (no `SQLITE_BUSY`→500); the
   subscribe poll retries transient libSQL errors without tearing the SSE stream; a dead cached client is
   evicted. **Retention**: the sweep is wall-clock-bounded with a `frames(token, created_at)` index, gated
   on the *active* backend, and reports channel databases swept.
7. **Input validation + security proofs.** `decodeFrame` bounds the cleartext routing strings (length +
   control-char guard) at the trust boundary; `/api/relay` caps decoded ciphertext below 3.3 MB (`413`)
   so its base64url JSON body remains below Vercel's roughly 4.5 MB edge limit. New proof tests pin: the
   zero-knowledge invariant on the launch path (no secret/authToken/keys leak to the trace, child env,
   or plaintext), cross-plane AEAD relabeling rejection, auth bearer byte-canonicalization, and the
   `dev/seed` production-404 gate.
8. **Viewer correctness — no silent blank/frozen transcript.** A host restart resets the viewer's orderer
   (via a per-process `RELAY_INCARNATION` in the announce) so non-durable re-numbered frames aren't
   dropped; a permanently missing low seq surfaces a recoverable banner (distinguishing a real gap from a
   chunk-in-progress); `permission_resolved` is now unordered (`seq=null`) so a content gap can't stall it.
9. **Permission-mode chip convergence** (the worker's true mode rides presence), **teardown flush** (the
   last outbound frame is drained before close), and a **dependency-audit pass**: the build-time **postcss**
   advisory is patched via a pnpm override; the remaining transitive advisories — **devalue**
   (low-reachability: the Workflow runtime serializes only our own sealed frames + routing, never
   attacker-controlled objects) and **undici** (dev-only, via `@workflow/vitest`) — are accepted and
   tracked for a Workflow-DevKit bump, because force-overriding them broke the **deployed** Vercel
   Workflows runtime (the in-process test tolerated the bump; the live durable runtime did not — caught by
   the deployment-targeted preview e2e).

## Threat model & security posture

remote-claw is a zero-knowledge, E2E-encrypted relay. The broker (Vercel/Turso) is an untrusted dumb
pipe: it validates the §8 envelope shape and routes opaque ciphertext, and never holds any decryption key.

### Verified controls

- **Key separation / blast radius.** The root secret `S` derives four independent HKDF-SHA256 keys:
  `authToken` (broker routing credential — the Bearer), `contentRoot`, `controlKey`, `kMeta` (decryption).
  Only `authToken` is sent to the broker; the decryption keys never leave the host/viewer. A leaked Bearer
  therefore permits routing abuse on the victim's own channel but **cannot decrypt content**. The full
  read credential is the `pass` (all four keys minus `S`). A legacy/manual entry may arrive in the URL
  `#fragment`, which is stripped immediately; persistence uses a non-extractable AES device key in
  IndexedDB and AES-GCM-wrapped pass ciphertext in tab-scoped sessionStorage. The pass is never sent to
  the server.
- **Crypto.** AEAD (AES-GCM) binds every cleartext routing column as AAD, so a frame can't be replayed
  onto another channel/plane/seq; per-frame CSPRNG salt+nonce + per-message subkey ⇒ no nonce reuse;
  auth-token comparison is constant-time; a Sealed client refuses Open frames (no silent downgrade).
- **AuthN/AuthZ.** Every identity-scoped data and recovery route requires a Bearer and scopes the channel
  token to the authenticated identity (no cross-identity access); the retention cron requires
  `CRON_SECRET`; the dev-only `/api/dev/sweep` route is 404 in production (gate-tested). Hex bearers are
  decoded to bytes before hashing (canonical, case-insensitive). `/api/handoff` is intentionally
  unauthenticated: a 256-bit one-time capability and derived claim proof gate its single-read sealed
  blob, and a platform-edge rate limit is a release requirement.
- **Input validation.** Wire routing strings are length- and charset-bounded; numeric header fields are
  range-checked; a viewer attachment filename is sanitized to a safe basename and capped (~12 MB); the
  broker publish path rejects decoded ciphertext at 3.3 MB so the serialized body stays below Vercel's
  roughly 4.5 MB edge limit.
- **Secret handling.** The secret never goes on argv, is never logged, and is suppressed from
  `--rc-json`/`--rc-quiet`; the secret file is `0o600` (enforced + warned), the MITM CA key `0o600`; the
  child claude's env is scrubbed of the host secret-file pointer + the broker bypass; `--rc-trace` traces
  RC bodies only — the upstream Anthropic credential is never passed to the tracer.
- **Web.** Static exfil-blocking CSP + HSTS / `X-Frame-Options: DENY` / `nosniff` / `no-referrer`; **no**
  XSS sink (`dangerouslySetInnerHTML` / `innerHTML` / `eval`) exists, enforced by a CI sink-guard test.
- **Supply chain.** The build-time postcss advisory is patched via a pnpm override; the remaining
  transitive advisories (devalue — low-reachability, the WDK serializes only our own data; undici —
  dev-only via `@workflow/vitest`) are tracked for a Workflow-DevKit bump rather than force-overridden,
  since that broke the deployed Workflows runtime. Lockfile pinned; `--frozen-lockfile` in CI.

### Accepted limitations (documented, not bugs)

- **Metadata is not private.** The broker sees cleartext routing — identity ids, session counts, frame
  sizes, timing. The guarantee is zero-knowledge of *content*, not of metadata. A malicious broker
  operator learns who is active and when, never what is said.
- **Rate limiting is platform-level.** There is no app-level rate limiter (serverless has no shared
  state). Unauthenticated calls to identity-scoped APIs are rejected cheaply, and an authenticated
  identity can only flood its **own** backend-bounded channels. `/api/handoff` is the deliberate
  exception: an unauthenticated PUT can write one short-lived sealed row, so a per-IP token bucket plus
  low global ceiling at Vercel's edge is a release gate, not an optional recommendation.
- **No key rotation — rotation is replacement.** Containing a compromised secret requires stopping
  every relay that captured it, minting and restarting on a new identity, and reconnecting trusted
  viewers there. This moves future traffic but does not revoke copied old credentials or retained old
  routes; in this historical flat-session baseline, the old channel's at-rest ciphertext is bounded by
  its retention policy. There is no in-place re-key.
- **Long-lived durable at-rest ciphertext weakens forward secrecy** versus the process-memory-only
  local backend. Workflow also retains ciphertext for a run, but its fixed cap/no-rollover path is not
  a safe retention policy. The SQLite/libSQL sweep bounds the historical durable backend's exposure
  window. Selected A1 deliberately differs: chat and server-control ciphertext remains retained from
  genesis because it has no safe collection or permanent route-revocation transition yet.

## Open design frontier (documented, not a regression)

Full durable cross-restart *resume* is now an A1 design target, not a property of the `cse_*` channel.
It needs a separately persisted logical-chat-to-native binding, a fenced coordinator/runtime epoch,
and a durable inbound acknowledgement cursor. A proven `claude --resume` replacement first reuses the
known private synthetic RC attachment; if that attachment must rotate, the replacement remains under
the same native binding and server/chat scope. A1 uses the stable
`(collaborationServerId, logicalChatId)` pair for the canonical chat within one machine. The
machine-facing viewer row, route, alias, broker channel, and cache keys use the full
`(identity_id, collaborationServerId, logicalChatId)` triple. An unproven or new native conversation
must not silently reuse that scope. The session-ID fix removes the compatibility-channel collision and
makes the current restart path stop automatically re-executing already-stored pre-floor indices;
replay/re-append above the floor and lost-result recovery remain A1 work. Stable logical-chat and
outward-binding recovery also remain unimplemented.

## Reproducing

- Baseline: `pnpm --filter remote-claw-web-tests run test:app` (and `:app:sqlite`);
  `pnpm --filter @remote-claw/{clawsec,cli,web} test:run`. (The `:app:temporal` / `:app:drain` legs
  named here existed only before the Temporal backend was removed.)
- The adversarial briefs, raw codex output, and the full 37-finding workflow inventory are preserved
  under `~/rc-traces/qa/` on the build host.
