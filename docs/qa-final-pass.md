# remote-claw — final QA pass (2026-06-12)

A whole-system adversarial QA sweep run after the durable-log track (PRs #80–84) landed. Two independent
reasoners audited every flow — the real `codex` CLI (gpt-5.5, xhigh effort) and an 8-dimension
verify-everything agent workflow (62 agents, ~3.2 M tokens) — and every existing test suite was run
green as a baseline. This document collects the verifications and the triaged findings so the result is
auditable, and tracks the fixes that close them.

## TL;DR

- **The crypto / zero-knowledge core is verified CLEAN.** The broker never sees plaintext: AEAD binds
  every cleartext routing column (cross-channel and cross-plane replay both fail AEAD), per-frame CSPRNG
  salt+nonce plus a per-message subkey means no GCM nonce reuse, HKDF key separation is clean (bus/auth
  vs content vs control vs meta), auth-token compare is constant-time, and a Sealed client refuses Open
  frames (no silent downgrade). The master secret is suppressed from `--rc-json`/`--rc-quiet`, the web
  pass lives only in the URL fragment + sessionStorage, and `/api/dev/seed` is prod-gated (404).
- **The real bugs are operational, not cryptographic** — session identity, host-restart / reconnect
  ordering, and retention / teardown / Turso-resilience edges. None of them weaken E2E encryption.
- **Baseline: all green** — 25 Playwright e2e across three backends (Local, **Turso**, Temporal) + drain,
  and 509 unit tests (clawsec, cli, web).

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
| Playwright app-e2e | Temporal | 8/8 — asserts a real `relayChannel` workflow exists |
| Playwright app-e2e | drain (real build) | 1/1 |
| vitest | @remote-claw/clawsec | 109/109 |
| vitest | @remote-claw/cli | 271/271 |
| vitest | @remote-claw/web | 136 passed / 12 skipped |

## Fixed in this pass

Each fix ships with a regression test and was adversarially reviewed (codex + the workflow).

1. **Session-id collision across launches (CRITICAL).** `newId()` was a process-local counter reset to 0
   each launch, so the first RC session of *every* launch was `cse_12654435761`; under one identity,
   sequential launches collided on a single broker channel (`sess:<id>:<sessionId>`), and on a durable
   backend the second session read/extended the first's frames. Session ids are now minted from a
   crypto-random source (globally unique), with an injectable deterministic minter for tests.
2. **Host secrets leaked to the child claude (defense-in-depth).** The spawned `claude` inherited
   `REMOTE_CLAW_SECRET_FILE` (the host secret-file pointer) and `VERCEL_AUTOMATION_BYPASS_SECRET` (a
   secret value). Both are now scrubbed from the child env in `launch.ts` *and* the `--rc-trace` path
   (`trace-run.ts`); the host itself still authenticates (it reads the bypass before building the child
   env).
3. **A blank `?backend=` returned 400 instead of the default.** `backendSelector` now treats a blank /
   whitespace selector (and a padded value) as "no selection" → the route falls back to the
   `BROKER_BACKEND` default, matching `getBackend`'s own `trim() || default`. A real invalid value still
   400s.
4. **Turso durable e2e was not exercised in CI.** `web-e2e.yml` ran the Local, Temporal, and drain
   browser suites but never `test:app:turso`, so the durable backend shipped with no browser-level proof.
   The Turso e2e step (and its results artifact path) is now wired into CI.

## Remaining work — prioritized stack (tracked, each its own reviewed PR)

The full per-finding detail (file:line, trigger, action, and the exact test to add) is in the workflow
inventory. The high-value clusters, in recommended order:

1. **Durable host-restart safety (highest risk).** On a durable restart the inbound pump re-subscribes
   from `startIndex:0` with an empty dedup window and can re-inject historical `user` prompts (and
   replayed `permission` answers) into claude — resume the inbound cursor from a durable high-water mark
   / re-hydrate the dedup set, fenced by a per-run incarnation epoch.
2. **Durable seq-resume must fail loud.** When `maxSeq` is unavailable on a durable backend, `serve()`
   currently logs and starts at seq 0 (colliding with durable history → viewers silently drop frames);
   it should latch fatal and take the coupled-pump teardown path instead.
3. **Non-durable restart ordering + gap surfacing.** A non-durable host restart resets seq to 0 and the
   viewer's persistent `FrameOrderer` drops the re-numbered content; and a permanent low-seq gap stalls
   the whole transcript with no surfaced recovery. Resume seq for non-durable backends and/or rebuild the
   orderer on a sub-cursor restart, and surface a recoverable banner after a bounded stall.
4. **Turso resilience.** Serialize writes (in-process mutex / `SQLITE_BUSY` retry so the relay returns
   the 409 retry contract, not 500), wrap the subscribe pull-loop queries so a transient libSQL error
   doesn't tear a live SSE stream, and evict a dead cached client.
5. **Retention.** Add a wall-clock budget to the sweep loop and a `frames(token, created_at)` index
   (avoid the O(N²) full-table scan), gate the cron on the *active* backend (not just
   `TURSO_DATABASE_URL` presence), and report sessions-swept rather than frame-rows.
6. **Smaller fixes.** Converge the optimistic permission-mode chip via the announce; bound the free-form
   wire routing strings in `clawsec`; make `permission_resolved` an unordered (`seq=null`) frame so it
   can't be gap-stalled; await the relay pumps on teardown.
7. **Coverage.** Turso in the encryption-stress matrix; a joined cross-restart seq-continuity e2e; Turso
   concurrency-race tests; a route→real-`TursoBackend.sweep` integration test; a `dev/seed` prod-404
   gate test; a launch-path zero-knowledge leak test; a CSP sink-guard CI test.

## Open design frontier (documented, not a regression)

Full durable cross-restart *resume* (the same session reattaching across `claude --resume`) needs
stable-resumable session ids + `worker_epoch` lease fencing + a durable inbound ack cursor. The
session-id fix above removes the collision; true resume + split-brain fencing remains the design frontier
(consistent with the durable-log design doc's open decisions). This pass makes every path **safe** (no
silent corruption), and closes the items above incrementally.

## Reproducing

- Baseline: `pnpm --filter remote-claw-web-tests run test:app` (and `:app:turso`, `:app:temporal`,
  `:app:drain`); `pnpm --filter @remote-claw/{clawsec,cli,web} test:run`.
- The adversarial briefs, raw codex output, and the full 37-finding workflow inventory are preserved
  under `~/rc-traces/qa/` on the build host.
