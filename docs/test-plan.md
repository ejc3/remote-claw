# remote-claw — test plan

What we verify, how, and where. The current system is a zero-knowledge, E2E-encrypted relay with
Claude, OpenCode, and tmux compatibility paths. The only active project finish line is
[Claude 1.0](release-finish-line.md). Durable A1/OpenCode, Codex, nested collaboration, and the neutral
multi-engine host runtime are optional parked platform work. The test strategy mirrors those trust
boundaries and distinguishes current Claude release gates, as-built compatibility tests, implemented
dormant inventory, and optional future suites.

The [A1 OpenCode vertical slice](a1-opencode-vertical-slice.md) preserves non-negotiable safety gates if
that optional product is ever resumed; none is planned next or blocks Claude 1.0. Historical
E0/E1a/E1b1/E1b2 codecs and retained fixtures remain implemented audit regressions only; they do not
authorize or gate a live adapter, activation, attempt, or dispatch.

## Active Claude 1.0 release suite

Claude 1.0 requires two non-skippable proof legs. The deterministic leg can control every crash
boundary; the installed smoke proves the real topology. Neither substitutes for the other, and the
existing split proofs below do not satisfy the suite by themselves.

| Required leg | Required proof |
| --- | --- |
| Deterministic fail-stop matrix | Use production MITM/relay/session/viewer-state code, the real SQLite/libSQL broker, and the faithful fake worker. Prove stable selection requires exact harness `{agent:"claude-code",mode:"rc"}` plus exact vector `{structuredPermissions:false,status:true,controls:{interrupt:false,setModel:false,setMode:false,end:false},attachments:false}`; absent/non-object vectors and partial/malformed present vectors stay compatibility-only. Prove no automatic new-ID retry after ambiguous browser publish; one host handling across broker reconnect; no second user/control SSE emission after disconnect-before-ACK; disabled permission/question answers; exact native-event retry versus UUID collision; head-of-line projection publication across both pumps; a hard 30 s Turso readiness wall under 60 s cursor routes and a 70 s client cursor wall; a hard 15 s broker subscription-query maximum and shared three-transient poll budget; a separate 20 s stream-header wall even when fetch ignores abort; 40 s actual-byte SSE idle failure; exact 240 s planned rotation neutral to the failure budget while raw EOF charges it; one 65 s wall over an entire logical post with no ambiguous replay; closure on the third consecutive inbound failure, reset only by clean absence or newly admitted authenticated traffic, with owner abort exempt; fatal bridge closure with truthful incomplete-tail status; create-once channel continuity and permanent identity-bus-loss closure; five-second future-skew/cold-replay liveness bounds; disabled unsupported controls; and a fresh successor with no old-command replay. No durable command journal or opaque native-application claim is part of this gate. |
| Installed real-topology smoke | From the repository root enter only through the executable pinned static BusyBox clean-environment launcher; archive the exact clean HEAD and build/pack/install only inside that isolated source; launch the exact byte-pinned `/usr/bin/claude` under a PTY, require the running descendant's resolved executable path, select only its exact release-payload argument tail, and then attest its size/hash/release-clean environment through `/proc`; drive the actual browser UI; verify the exact live handoff WAF rule; and use a deployed production-code Vercel Preview whose default backend is SQLite/Turso, without a host or browser backend selector. Cover onboarding, discovery, a first received/replied turn, durable reload, measured 235–270 s `: rotate`, later session subscription, re-attestation of the same Claude descendant, a second received/replied turn on the same `cse_*`, local-input and fail-stop-tail disclosure, and disabled permission/question answer controls. Then require zero run-bound sentinel occurrences on the exact bounded Preview surfaces. Post-merge, require independently proved candidate ancestry/equal trees, fresh inspection evidence, the exact live Production WAF and Deployment Protection, and a fresh default relay→Turso create/write/read before the terminal receipt. Do not claim opaque native execution can be counted during injected crashes. |
| Operations | Direct Node and npm/pnpm lifecycle invocations are refused. The `#!/bin/busybox ash` process self-attests `/proc/$$/exe` as exact resolved `/usr/bin/busybox`, root:root mode `0755`, 1,914,704 bytes, SHA-256 `52151e7f322f926b64049cdaa1410dc3ea6485525e0624b05813791c219ae933`; accepts no arguments; and NUL-pipes the seven allowlisted proof inputs to an `env -i` Node runner, with no secret in argv. The runner requires a clean full HEAD, resolves a caller-supplied GitHub deployment ID, accepts only the newest successful `vercel[bot]` Preview status at the pinned project/team origin, requires its deployment SHA to equal HEAD, and fetches a non-cacheable, content-free runtime attestation from that exact origin with redirects forbidden. With trusted system binaries it archives that exact digest, frozen-installs/builds/packs in private isolated state, and binds the tarball digest. It resolves the intended `/usr/bin/claude` launcher symlink, opens and pins its resolved target, and requires that target to be a root:root regular mode-`0755` Linux arm64 file with version `2.1.237 (Claude Code)`, exactly 331,864,296 bytes, SHA-256 `a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177`. After the executable-path check and before size/hash/environment attestation, it boundedly selects the exact nonsecret release-payload argument tail, so the same-inode `--version` probe is ignored. A parent-only Vercel management credential verifies the exact live enabled WAF config/rule and empty bypass list before Playwright. Separate minimal allowlists prevent management/Turso/cron credentials or ambient caller state from reaching Playwright, the wrapper, browser, or Claude. Missing Vercel system variables, real-Claude cwd, exact executable bytes, complete Turso fleet configuration, or default-backend durability fail closed. Ordinary preview CI may skip secret-dependent optional coverage and is not a release-proof receipt. |

The deterministic implementation has production-path tests for strict retry versus
terminal collision/invalid intake, SSE disconnect-before-ACK fencing, both cross-pump head-of-line
failure directions, control-side-effect serialization, 70 s durable-cursor and 20 s stream-header boundaries, 40 s
actual-byte SSE idle failure, exact neutral 240 s rotation, the 65 s logical-post wall, third-consecutive-inbound-failure closure,
exact executable inode retention, fatal per-session closure, local-TUI survival,
a fresh successor with no old mutation, exact SQLite replay/collision and create-once loss detection,
absorbing lifecycle presence, bounded viewer future skew/replay freshness,
non-mutating ordinary retention, authenticated intake before dedup/order, ambiguous-send truth, and
the stable text-only browser surface. A release record must bind the final frozen tree to its local
gate, independent review, exact-SHA CI, and three receipts; mutable execution status is deliberately
kept outside this candidate-bound document. The precise fail-stop contract and security boundary are in
[Claude 1.0](release-finish-line.md).

## Strategy — the pyramid

| Layer | Where | What it proves | Runtime |
| --- | --- | --- | --- |
| **Unit (crypto core)** | `packages/clawsec/src/*.test.ts` | HKDF hierarchy, AEAD per-message keys, the §8 wire envelope, channel tokens, the pass, chunking, the shared canonical field writer with strict-null optionals and defensive snapshots, the locked A0 AAD regression vector, A1.5's pure v2 wire/KDF/frame/digest/certificate/onboarding contracts, A1.6's exact selected capability/route/store/generation/manifest/retry/collision/read-page contracts, A1.7a's bounded ingress identifiers/digests/cursors plus strict `user`/`new_chat` payload codecs, A1.7b1's exact common payload/source/command/decision/result/signing bytes and deterministic IDs, A1.8a0's exact rejected action/chat payload bytes, stored-result/delivery digests, stable identity, and completion-observation selection, and authority-free exact `accepted` projection bytes retained for optional `user_text`/chat-creation research — pure functions, no network | Node + WebCrypto |
| **Unit (CLI seam + transport)** | `packages/cli/src/**/*.test.ts` | SecurityProvider (Open/Sealed, downgrade floor), A0 BrokerClient HTTP/SSE including hard cursor/connect/idle deadlines and ignored-abort behavior, HostRcRelay whole-logical-post timeout and three-failure terminal intake, viewer-side FrameOrderer (dedup/reorder), exact stable-Claude executable/inode pinning, HostRelay (fake backend), ClaudeStreamSession env passthrough, A1.0 contracts, the A1.1 secure-filesystem/SQLite/protected-artifact kernel, A1.2 server/project repository, A1.3 runtime-owner/key-custody/daemon/RPC, A1.4 schema-v5 evidence/registration/reconciliation/duplex-port/trusted-adapter boundaries, A1.5 schema-v6 terminal-root repository/service boundaries, A1.6's negotiation-first client plus schema-v7 capability-pin/route/genesis repository and host-only installer, A1.7a's schema-v8 evidence-preserving ingress repository/dormant actor through `awaiting_order`, A1.7b0's schema-v9 wrapped server-key custody/self-anchor/fenced leases, A1.7b1's schema-v10 ready/order/rejected-decision/replaceable-preparation/signing boundary, A1.8a0's schema-v11 rejected-only atomic finalization and secure-reopen closure, and the merged E0/E1a/E1b1/E1b2 audit-only native-authority codecs plus direct-only Linux executable/workspace collectors and production-dormancy guards | Node, mock fetch / fixture + real temporary SQLite; CLI CI separately runs `linux-workspace-collector.test.ts` after capability-free non-root demotion |
| **Unit/integration (A1 broker)** | `apps/web/test/{api/a1-routes,broker/a1-sqlite}.test.ts` | Strict bearer/selector/capability admission, route recomputation, A1-only catalog/store provisioning and loss, bounded canonical relay/read, route-wide exact retry and first collision, rollover/manifests, quota/counter exhaustion, pagination, and isolation from A0 retention | Node + mock/local SQLite/libSQL |
| **Retained native proof (Codex)** | `spikes/codex-multiclient/verify-*.mjs` | pinned probe/binary hashes, one real app-server, raw and real-TUI coexistence, top-level multi-chat subscription evidence, model/network isolation, native deletion, and cleanup | Node over checked JSON evidence; no provider/model |
| **Retained native proof (Claude)** | [`spikes/claude-native-output`](https://github.com/ejc3/remote-claw/tree/main/spikes/claude-native-output) | pinned Linux arm64 Claude Code 2.1.237 binary/package/probe/evidence bytes plus historical captured-source blobs; sanitized witnesses derive UUIDv4 coverage across all eight observed event types and one exact same-session request retry observed after a withheld HTTP 200; executable current-tree tests guard trace pass-through and the fully-buffered-response/reset seam; evidence does not claim deterministic/per-type retry, runtime dedup, or a question family | Node over checked sanitized JSON + current trace contract; live capture requires authenticated Claude + PTY only when the supported tuple, proof claim, or fault model changes |
| **Retained native proof (OpenCode)** | [`spikes/opencode-native/{verify-evidence,verify-executable-manifest}.mjs`](opencode-native-proof.md) | pinned binary/schema evidence, exact session-marker correlation, caller message-ID read-back, same-ID `noReply:true` append behavior within one incarnation, and independent reconstruction of the retained 150-chunk native executable manifest; raw executable/chunks are not retained | Node over checked JSON evidence; no provider/model |
| **Optional parked OpenCode suite** | Safety matrix in [`a1-opencode-vertical-slice.md`](a1-opencode-vertical-slice.md) | if resumed: exact-existing or reconciled-created session; schema-v6 root authority; signed command-keyed execution; native and provider write-ahead/no-resend; strict read-back plus `assistant.parentID` under concurrent TUI; atomic observation-to-terminal/output intent; sealed-output self-recognition; isolation and crash recovery | not scheduled; real OpenCode required, never a Claude 1.0 gate |
| **Integration (broker)** | `apps/web/test/*.integration.test.ts` | the **real** broker routes on the **real** Workflow runtime (`@workflow/vitest`): admission, routing, bus/session isolation, SSE, the full encrypted turn, control plane, the browser Viewer | in-process Vercel Workflows |
| **App e2e (real browser)** | `tests/web/app-e2e/*.spec.ts` (Playwright) | a real **Chromium** drives the BUILT viewer against a real Next server + broker — the full RC turn, the one-time-handoff pairing, the three drivers' capability profiles (mitm/tmux/opencode, via capability presets — not real tmux/opencode hosts), and the bus-unreachable banner; **WebKit** runs the iOS-Safari foreground-revive spec; the RC turn re-runs on the per-channel SQLite backend | Playwright (Chromium + WebKit), built prod server |
| **Proof (source-tree real Claude)** | `apps/web/test/prove/*.prove.test.ts` (gated `RC_PROVE_REAL_CLAUDE=1`), including `real-launch.prove.test.ts` | a **real, logged-in `claude`** driven end to end through source `runRcLaunch`; the stable proof exercises one native-RC inference turn with the exact supported tuple and no installed-artifact substitution | spawns real `claude`, PTY/network |
| **Release proof (installed deployed topology)** | trusted topology, inspection, and Production BusyBox wrappers under `scripts/` | topology v4: one real Chromium drives the deployed-default SQLite/Turso broker through an exact-HEAD archive-built tarball and byte-pinned real Claude PTY, with live WAF, running-process, 235–270 s rotation/reconnect, and second same-`cse_*` turn evidence; inspection v1: committed-scanner and pinned-libSQL provenance plus zero run-bound sentinel occurrences in every stable exact-prefix Preview Turso value and queryable retained immutable-deployment Runtime Log; Production v1: inspection completion at most 71 hours old or five minutes in the future, raw-local and GitHub candidate ancestry/equal trees, exact live WAF with empty Firewall bypass list, no-bypass Deployment Protection, exact live Production runtime, and fresh default relay→Turso null/create/write/read-to-one evidence with physical database ID. | explicit manual three-receipt release gate; topology has a 780 s Playwright wall and two Claude inference turns; provider inspection is bounded/fail-closed; finalized receipts are private durable artifacts; no trace/screenshot/video artifacts |
| **Exploratory** | manual real-`claude` runs (`tests/web/cross-mode-verify.mjs`) | a LIVE session driven through the real viewer for any bridged driver: type a prompt, assert a real assistant reply (real LLM round-trip) carrying a needle, screenshot | real, on demand |

CI keeps the unit + integration layers fast and network-free. The Claude native-proof workflow runs
for every `packages/cli/**` or proof-package change, checks the historical source blobs with full Git
history, requires OpenSSL, and then executes the current run/trace/real-TLS contract tests. PRs that
touch the web/CLI/crypto paths also run the **app-e2e** layer (Chromium + WebKit; the RC turn re-runs
on per-channel SQLite) plus the encryption-stress suites (`.github/workflows/web-e2e.yml`,
path-filtered). Source-tree real-Claude proofs are env-gated and run on demand. The deployment-preview
workflow is an authenticated post-main smoke: it has no `deployment_status` or ref-selectable
`workflow_dispatch` trigger because those can select candidate workflow bytes. A typed
`repository_dispatch` fixes the workflow bytes/ref to the default branch and supplies an untrusted
deployment ID to a no-secret resolver, which binds a successful Vercel-bot preview to its exact full
SHA, approved project/team hostname, and a commit contained in `main`. The secret-bearing job uses the
protected `release-proof` environment, whose
credentials exist only at environment scope and whose branch policy admits `main` but not tags.
Secrets remain step-scoped, and the workflow requires the exact pinned origin's non-cacheable runtime
Preview/full-SHA attestation before any bypass-bearing broker, browser, or Turso leg can run. Its UI
coverage passes `E2E_BACKEND=vercel` for the Workflow compatibility leg and
`E2E_BACKEND=sqlite` for the Turso-backed durable leg; neither is an accidental unset-default run. Its
optional secret-dependent legs may still skip, so green status is not the installed deployed release
receipt.

This repository currently has no enforced branch protection. Before merge, the release operator must
query GitHub Actions by the immutable 40-character candidate SHA—not a branch, mutable check label, or
latest run—and require a repository-owned `pull_request` run with conclusion `success` for each
path-relevant workflow/job. For this cross-cutting release tranche those identities are exactly:

- `.github/workflows/cli.yml` / `test`;
- `.github/workflows/web.yml` / `test`;
- `.github/workflows/clawsec.yml` / `test`;
- `.github/workflows/web-e2e.yml` / `e2e`;
- `.github/workflows/native-proofs.yml` / `retained-evidence`;
- `.github/workflows/workspace.yml` / `lockfile`; and
- `.github/workflows/docs.yml` / `web-tests`.

An absent, skipped, neutral, wrong-SHA, or duplicate same-name result from an untrusted app fails the
gate. After topology v4 and inspection v1 pass, merge only the inspected candidate, require exact-merge
CI, and run the Production verifier. That verifier requires fresh inspection completion, proves
candidate ancestry and equal candidate/merge trees through raw local Git and GitHub's independent
compare/commit objects, and then binds the newest successful Production deployment, live runtime, exact
WAF/empty Firewall-bypass list, Deployment Protection, and a fresh default relay→Turso write/read into
the terminal receipt. Exact-SHA Actions CI remains separate release-record evidence: the verifier does
not query it, and neither CI nor the three-receipt chain substitutes for the other.

## Coverage map — the 26 scenarios → proof

(Numbered as in issue #40.) ✅ = automated test, 🔬 = exploratory (run + captured).

**Crypto core (clawsec)**

1. Key hierarchy (HKDF, domain-separated) — ✅ `kdf.test.ts`, `hkdf.test.ts`
2. Pass = viewer credential, not S — ✅ `pass.test.ts`
3. §8 wire envelope round-trip + strict boundary — ✅ `wire.test.ts`
4. Derivable, collision-free channel tokens — ✅ `tokens.test.ts`
5. AEAD tamper / wrong-key / wrong-identity rejected — ✅ `aead.test.ts`, `aad.test.ts`

**Security seam (cli)**

6. Open vs Sealed byte-identical wire — ✅ `security/provider.test.ts`
7. Downgrade floor (Sealed refuses plaintext) — ✅ `security/provider.test.ts`

**Broker (apps/web, real runtime)**

8. Admission: bad/absent bearer → 401 — ✅ `broker.integration.test.ts`
9. Frame identity mismatch → 403; bad JSON → 400 — ✅ `broker.integration.test.ts`
10. Bus carries only `session_announce` / canonical `session_terminal` lifecycle — ✅
    `broker.integration.test.ts`, `broker/{local-backend,sqlite-multi}.test.ts`
11. Discovery announce round-trip (ciphertext only) — ✅ `broker.integration.test.ts`
12. Session/bus channel isolation — ✅ `broker.integration.test.ts`
13. Recent-window cold start — ✅ `broker.integration.test.ts`

**Transport (cli)**

14. BrokerClient post/stream round-trip + auth + errors — ✅ `broker/client.test.ts`
15. Dedup + reorder discipline — ✅ `broker/order.test.ts`
16. Browser fetch binding — 🔬 caught + fixed by the first real-browser render (#38)

**End-to-end (apps/web, real runtime)**

17. Full encrypted turn (ack+echo+assistant+result, reordered) — ✅ `e2e.integration.test.ts`
18. Control plane (`interrupt` under `control_key`) — ✅ `e2e.integration.test.ts`
19. HostRelay drives a turn + dedups a replay — ✅ `host/relay.test.ts`

**Real claude / browser**

20. REAL claude single turn through the broker — ✅(gated) `prove/real-claude.prove.test.ts`
21. REAL claude multi-turn (stateful) — ✅(gated) `prove/real-session.prove.test.ts`
22. Inference-agnostic (Bedrock env passthrough) — ✅ `host/claude.test.ts`
23. Web client in a real browser — ✅ `tests/web/app-e2e/*.spec.ts` (RC turn, pairing, the 3 driver capability profiles, iOS revive, bus-unreachable banner) + 🔬 screenshot matrix (12 surfaces × 4 phone/desktop/light/dark projects = 48 generated images; review artifacts are not committed)

**Advanced**

24. Interactive multi-turn — ✅/🔬 `prove/real-session.prove.test.ts` + browser
25. Compatibility-only tool-use permission grant — ✅ `e2e/rc-spine.integration.test.ts` (a worker `can_use_tool` surfaces to a compatibility viewer, which grants it back to the worker) + ✅ `tests/web/app-e2e/transcript.spec.ts` (a compatibility permission survives reload; an AskUserQuestion answer submits). Stable Claude 1.0 suppresses permission/question interaction and does not advertise this family.
26. Sub-agents (Task tool) — ✅ `e2e/rc-spine.integration.test.ts` (a Task `tool_use` + sub-agent output relay through as `tool_use` + `assistant_sub` frames) + ✅ `tests/web/app-e2e/transcript.spec.ts` (sub-agent Task nesting renders in a real browser) + 🔬 real `claude` sub-agent run

## Known gaps / honest limits

- **Scenarios 25–26** are automated end-to-end compatibility coverage: a viewer `permission` frame maps back to the worker's
  RC control-response (`HostRcRelay` → `session.pushControlResponse`), and a Task spawn relays its
  sub-agent frames — both covered by `e2e/rc-spine.integration.test.ts` and rendered in a real browser by
  `tests/web/app-e2e/transcript.spec.ts`. Stable Claude 1.0 suppresses the permission/answer family;
  the sub-agent projection remains read-only output. A real logged-in Claude tool/sub-agent
  compatibility run stays exploratory and is not a stable release claim.
- The **native `--remote-control` HTTPS MITM** path (a real `claude --remote-control` through `MitmProxy`
  + `HostRcRelay`, with a viewer turn round-tripping the real model's reply) has gated compatibility
  proof `prove/real-rc.prove.test.ts` and the current stable source-tree proof
  `prove/real-launch.prove.test.ts` (`RC_PROVE_REAL_CLAUDE=1`). Neither substitutes for the
  exact-candidate installed/deployed topology, bounded inspection, and equal-tree Production chain.
- Negative-`startIndex` exact last-N semantics are real-Vercel-verified (spike §14A); the in-process
  harness only guarantees an in-order suffix incl. the latest — asserted accordingly.

## Optional platform inventory and safety gates

This section preserves implemented dormant inventory and optional design tests for
[Client-driven Host Runtime](client-driven-host-runtime.md). It is not an active roadmap and makes no
claim about the current A0 implementation or the Claude 1.0 release gate.

### Milestone status and proof ownership

| Milestone | Current status | Required proof before its advertised capability |
| --- | --- | --- |
| A0.1 | Implemented | Neutral registrar lifecycle, multi-session isolation, ready-before-bridge, and exact-replay/first-bind tests |
| A0.2 | Implemented (process-local) | OpenCode and tmux driver tests for post-setup capabilities, cancellation and bounded teardown, no pre-ready broker client/announcement/remote mutation, and no ghost registration after setup or spawn failure; tmux additionally proves mandatory native readiness, private socket/runtime and owner-only launch artifacts, prompt/environment/settings absence from tmux argv and public errors, concurrent wrapper isolation, failed permission-decision persistence withholding ACK, and runtime retention when pane termination is uncertain |
| A1.0 | Implemented contract foundation | Exact canonical primitive, ID namespace, path-resolution, record-shape, digest, fence, protected-operation, dispatch/reconciliation-separation, and backend-capability unit tests; no direct effect or A1 capability is advertised |
| A1.1 | Implemented storage kernel | Linux descriptor-anchored secure create/open/reopen, read-only WAL-aware validation before writable SQLite open, exact schema-v2 migration/digest/manifest validation, FULL migration commits with non-blocking passive checkpoint and guardian fsync, typed commit and guardian-retaining cleanup outcomes, synchronous high-level transactions with generic multiwrite rollback, and immutable protected artifacts with verified scope, schema, reference, digest, and stored length; A1.3 now opens it, while no native effect or A1 broker capability is advertised |
| A1.2 | Implemented host repository; operations inactive | Exact schema-v3 migration/manifest; default profile/server; atomic first project/mapping/chat/binding/intent/`rcie_*` edge; explicit later projects; terminal mapping-generation replacement; many-chat inventory; coordinator lease CAS, renewal, release, takeover and reconciliation; contiguous immutable journal; full semantic read-only snapshot validation; no live registration, command actor, native effect, or nested target/edge is advertised |
| A1.3 | Implemented; experimental-driver health only | Exact schema-v4 migration/manifest and full runtime-owner semantic graph; `rcrt_*` vector; service lease fencing/takeover/reconciliation; runtime/incarnation/assignment/containment and local-conversation registry; wrapped Ed25519 custody/signing discipline; binding/attachment/gate foundations; authenticated bounded RPC; daemon/bootstrap and failure cleanup; multi-runtime isolation; experimental OpenCode/tmux connect/autostart/detach boundary; stable MITM exact-tuple check and owner skip; health reports `ownerOperationsWritable:false` and `nativeRegistrationEnabled:false`, with no installed production dispatch operation, durable owner registration, A1 binding activation, remote mutation, or broker capability |
| A1.4 | Implemented closed trusted-adapter seam; ordinary CLI has it disabled | Exact schema-v5 migration and 269-object manifest; five canonical evidence schemas; sequenced process leases/publications/operations; replay/collision and request-bound reconciliation; lifecycle/publication closure plus validator-enforced no-extra-row closure; duplex bounded callable ports; `liveReattach` admission; stale-open crash takeover and fresh-fenced same-binding process/port reattach with authority-change transport rotation; explicit-adapter production activation while ordinary health remains `ownerOperationsWritable:false` and `nativeRegistrationEnabled:false` |
| A1.5 | Implemented dormant foundation; ordinary CLI has it disabled | Pure browser-safe A1 v2 route/token/KDF/frame/digest, certificate, and onboarding codecs; exact schema-v6 304-object terminal-root ledger; activation/renewal replay, collision, fencing, expired-preparation refusal, rollback, lost-commit reconciliation, semantic reopen, lifecycle demotion, and re-ready renewal; closed v6 signature reservation, protected signing, fresh callable-port proof, and transaction-local store/accept/finalization through the opt-in trusted-adapter operation; no real driver or broker integration |
| A1.6 | Implemented dormant foundation; ordinary CLI/drivers/viewer make zero A1 calls | Exact capability negotiation; selected SQLite/libSQL route provisioning; auth/route/store binding; raw and decoded bounds; retained route-wide exact retry/collision/manifests; automatic rollover and bounded one-generation pagination; outcome-unknown client behavior; exact 22-statement schema-v7/326-object capability-pin/route/pristine-genesis install and split-commit recovery; no ingress cursor, actor, native effect, checkpoint/signing, inference, or projection claim |
| A1.7a | Implemented dormant foundation; absent from production barrels/run paths | Schema-v8 route backfill/auto-seeding, exact retained page/frame/raw/plaintext evidence, independent fetch/semantic cursors, current-fenced actor takeover, multipart/exact-retry/collision/tombstone/recovery, quotas/lookahead, secure reopen, and durable `awaiting_order`; no command/order, signed result, server-scope signer, outbox/effect, native dispatch, or live A1 claim |
| A1.7b0 | Implemented dormant prerequisite; no production wiring | Schema-v9 migration `009-server-scope-signer`; initial self-anchor, AES-GCM-wrapped server Ed25519 custody without raw-key export, coordinator-fenced bootstrap/current leases, immutable signer sequences and payload bindings, dense per-server `acceptedAtJournalSeq` signed-record acceptance, non-closed-bootstrap `stale_bootstrap_fence` fail-stop versus installed-lease supersession/next-token takeover, exact replay/collision/reconciliation, semantic reopen, and compatibility admission of dormant route installation for an exact signer-activated current server; no command/result, generic host output, broker publish, outbox/effect, native dispatch, or projection claim |
| A1.7b1 | Implemented dormant foundation; no production wiring or independent capability claim | Schema-v10 `010-common-command-adjudication`, exact five-table/619-object boundary, shared ready/control journal closure, A1-ingress-only route-head admission, deterministic source/command/result/group/preparation identities, small `unsupported_recognized` persistence, global order, rejected-only decision, distinct creation/decision fences, signer binding/store, abort/reprepare generations, crash reconciliation, semantic reopen, and a hard signed-but-unaccepted terminal boundary |
| A1.8a0 | Implemented dormant rejected-only closure; no production wiring or capability claim | Schema-v11 `011-a1-rejected-result-finalization`, exact three-table/647-object boundary, one-transaction common result + dense signer acceptance + `decided`/`terminal` overlay + exact semantic artifact + inert `pending_seal` intent, immutable base ingress evidence, no cursor movement or post-sign route-health dependency, narrow safe predecessor-signature takeover with strictly later successor-lease acquisition, crash reconciliation, and semantic reopen |
| Native-authority audit utilities | Implemented, dormant, non-authoritative | E0/E1a/E1b1/E1b2 canonical IDs/derivations, bounded parent/executable/workspace codecs, retained manifest verification, direct-only collectors, and production-import dormancy; never a prerequisite for an optional capability or Claude 1.0 |
| Optional OpenCode durable capability | Parked; no schedule | If explicitly resumed, one user-runnable local-provider path and a later credentialed gate must pass the optional safety matrix below; neither is planned next or a Claude 1.0 blocker |
| Broader OpenCode platform | Optional; no schedule | Additional mutation families, remote session creation, shared-runtime optimization, and collaborator/connectors only after separate executable safety proofs |
| N1.1–N1.3 | Optional; no schedule | Two live nested servers, rooted edge installation, complete signed downstream receipt, reconnect/reparent recovery, and cycle/reflection/duplicate-execution rejection |
| B.1–B.5 | Optional; no schedule | Pinned Claude differential fixtures, durable private RC recovery, native correlation/gate races, and live outward Anthropic Remote parity |
| C.1–C.5 | Optional; no schedule | Pinned Codex direct-versus-front-door fixtures, one bridge/subscription model, and live paired ChatGPT Remote mapping/reconnect parity |
| D.1–D.4 | Optional; no schedule | Durable pane/injection ambiguity, transcript correlation, gate/handoff, clear/branch identity, and unified discovery presentation |

If optional platform work resumes, every numbered slice is a separate reviewed PR. A schema-only or
stand-in proof may land with the capability disabled; it cannot satisfy a later live-connector gate.
In the parked material, references below to an
official-client, automation, or nested-server source mean an authenticated collaborator stand-in at
the common ingress until its real connector lands. Such a stand-in proves source normalization,
ordering, signing, and executor isolation only; B, C, the applicable automation connector, or N1 owns
transport, reconnect, rendering, and fidelity proof.

A1.0's unit tests prove only the in-memory and pure-function contracts. By themselves they do not prove a
lease compare-and-swap or takeover, non-artifact protected-value custody, native dispatch, broker
conformance, driver integration, or restart recovery.
They include negative-zero, `U+0000`, lone-surrogate, overlong-string, accessor/TOCTOU snapshot, immutable
validator-registry, symbol-key, noncanonical base64url alias, pre-decode size rejection, protected
byte snapshots across `Buffer`, fixed and growable `SharedArrayBuffer`, and returned-copy mutation,
cross-scope canonical-ID, exact active runtime-owner import allowlisting, and non-advertisement vectors.

A1.1's Linux/`node:sqlite` kernel accepts only an exact stable Node.js `X.Y.Z` version in
`^22.13.0 || >=23.5.0`. Its tests cover version boundaries and prerelease-like suffix refusal;
`/proc/self/fd`
descriptor anchoring; owner/mode/link/inode and filesystem-policy-v1 checks; rollback-journal and
non-WAL refusal; the required writable posture and `query_only` read-only posture; application,
machine, version, full `sqlite_schema`,
integrity, locked migration-digest, and disabled-double-quoted-string behavior checks; read-only
validation of crash-surviving WAL before any writable SQLite open; rejection of a future version in
WAL without changing the main file or WAL;
safe SHM-only reconstruction; v1→v2 FULL commit with non-blocking passive checkpoint, acceptance of
the exact competing-checkpoint `busy=1`/`log=-1`/`checkpointed=-1` sentinel, and guardian fsync; and
reopen after a typed committed migration-finalization failure. The kernel also types an
unproved migration-commit outcome as retry-open-safe, but never makes an unknown ordinary transaction
retry-safe. Ordinary transaction tests cover pre-commit guardian rollback/poisoning, distinct
committed-state reporting and poisoning after a post-commit guardian failure, success while an active
reader defers checkpointing, guardian revalidation after the writer-lock wait and before the callback,
escaped/async/nested-transaction rejection, poisoning before hostile Promise-species or thenability
handling can reuse authority, synchronous rejection of database-level asynchronous artifact calls
inside the callback, generic protected-artifact multiwrite rollback, and retry-close-safe guardian
retention when SQLite initially remains open. Failed-open cleanup tests prove that an incompletely
closed canonical database path stays quarantined until process restart while another path can open.
Artifact vectors cover the 16 MiB limit, random `rcph_*`
allocation with an eight-collision ceiling, immutability, exact scope/schema/reference/digest and
stored-length verification, append-only database triggers, distinct persistence failures, and
live-handle poisoning. The public opener's type test excludes entropy and clock injection. A1.1's
tests open only temporary databases; A1.3 is now the narrow production caller of the same kernel.

A1.2's tests apply the exact v3 migration over real SQLite, exercise its foreign keys, uniqueness,
append-only and monotonic triggers, and migrate the exact v2 manifest forward. Repository tests lock
the synchronous and asynchronous digest/derived-ID vectors together; reject malformed actor scopes;
bootstrap/replay/collide the default server and first complete terminal graph; allocate an explicit
project only after first bootstrap; replace an exact terminal selector generation by compare-and-swap;
keep earlier chats pinned to their old mapping; reserve and inventory multiple chats; exhaust ID and
journal allocation without partial writes; and acquire, renew, release, reconcile, and take over
coordinator leases without consuming offsets on stale/early requests. Secure-file integration closes
and reopens the complete graph, combines protected evidence and A1.2 records in one outer transaction,
and refuses an existing semantically corrupt graph before writable open, while validating a newly
migrated graph before its handle returns. The accepted v3 graph is intentionally dormant:
one default profile/server, current projects, contiguous terminal mapping chains, recovering
topology-generation-one chats with exact mapping IDs, unresolved starting bindings with one intent,
and installing native-harness `rcie_*` edges. Nested mappings/remote-server edges, live runtimes,
binding incarnations, actors/queues, and native effects remain later proof gates. A1.2 treats its
evidence refs/digests as opaque coordinates; A1.4 now owns their canonical verification and the
callable-port/native registration workflow, while the ordinary CLI invokes neither for a real driver.

A1.3's tests lock migration 4 to 141 statements and digest
`zx52EtAFNY9hEZneG3RW14zRCYR18gg7ysnltHbOkT0` and the complete v4 manifest to 231 rows: 30 tables,
57 indexes, and 144 triggers. They cover strict runtime-owner record parsers; the canonical
`rcrt_9eXZ6t2i1B6q6KnTszDoABv6BWYw0blCRXoNgPxF1WM` vector; service-lease acquisition, renewal,
release, explicit-release takeover, exact replay/collision, and acquisition-COMMIT
reopen/reconciliation; runtime creation, same-incarnation reassignment, positive
replacement/termination containment, project-scoped
local conversation transitions, binding/attachment/gate detach, key rotation, signature
reserve/bind/sign/accept/abort, and complete semantic snapshot rejection. Cross-table `rcph_*`
collisions, stale owner/coordinator fences, predecessor time reversal, duplicate signed digests or
signer tuples, and termination while the tested binding remains live are rejected; detaching that
binding leaves its runtime current. Key tests cover AES-256-GCM wrapped
PKCS#8 custody, binding/AAD tamper, self-test, signing, and zeroing temporary secret material; retained
ciphertext is logical destruction, not claimed physical erasure.

RPC/service tests cover mutual challenge/response authentication on the Linux abstract socket, the
64-total-connection and 1,024-byte pre-authentication bounds, rejection of pre-authentication
pipelining, canonical four-byte-length frames, the 1 MiB/32-in-flight/4,096-request bounds, duplicate
request IDs, replay, malformed frames, per-request timeout, listener loss, heartbeat loss, service
poisoning,
normal and signal shutdown, and disconnect-as-detach. Bootstrap/production tests cover connect-first,
one detached autostart attempt, machine-ID verification, allowlisted child environment/loader
arguments, a cwd pinned to the trusted CLI entry directory, absence of secret bytes from
argv/environment, owner-acquisition unknown-commit reconciliation, and health-only activation on the
experimental OpenCode/tmux paths. The stable `--rc-app` MITM path instead proves its exact Linux arm64
Claude 2.1.237 tuple plus the resolved `/usr/bin/claude` target's root uid/gid, regular-file mode,
byte length, and SHA-256 before identity,
holds that executable inode through `/proc` until child exit, and never starts the owner. Plain and help
paths, trace mode, and
the local `--rc-identity` action also do not start it; unavailable/auth/start failure preserves the
experimental A0 path; wrapper exit closes only its owner RPC collaborator without replacing A0 native
teardown.

A1.4's tests lock migration 5 to 38 statements and digest
`l32ozsKKBm5ueLOk-_IeiasPgp_deE-tZHEbaZ6urOE` and the complete v5 manifest to 269 objects. Canonical
evidence vectors cover exactly `remote-claw/native-engine-descriptor/v1`,
`remote-claw/durable-project-selection/v1`, `remote-claw/native-conversation-ref/v1`,
`remote-claw/native-conversation-capabilities/v1`, and
`remote-claw/native-registration-metadata-evidence/v1`, including schema, digest, canonical-byte, and
semantic-value validation. Registration fixtures exercise server-, runtime-, and binding-scoped
artifact handles, and a tamper test rejects a canonical binding-scoped metadata transplant that
differs from the A1.2 intent. Repository and SQLite tests cover exact open/bind/publish/ready,
recover/drain/close, contiguous per-lease operations, replay versus changed collision, read-only
request-bound reconciliation, mutating replay after a lost COMMIT acknowledgement, and complete-graph
recovery. The repository enforces generation-ordered publications, preflights operation-sequence
exhaustion as a non-poisoning conflict, and rejects unreachable extra rows during snapshot validation.
Ready atomically activates the exact runtime incarnation, native binding, lifecycle gate, and process
lease while proving the logical chat remains recovering and its terminal edge remains installing.

Crash tests reopen after owner/coordinator takeover while the predecessor process lease is still open,
reject a stale-owner recovery mutation, then use fresh-authority reattach to atomically close the
predecessor and create a new process lease and port. A changed fence rotates the transport lease on the
same binding incarnation/attachment and requires ordered predecessor-detach/successor-acquire journal
facts. Canonical
`liveReattach:false` rejects a published predecessor without poisoning; true permits reattach, while a
bound pre-publication predecessor may recover without inventing that capability. Tamper tests cover
operation digest/fence/time/sequence, publication transplant, stale-open mutation,
predecessor/transport journal order, and retained lineage guards against legacy
detach/replace/terminate and local clear/archive.

Duplex RPC tests cover configurable per-connection callable-port, reverse-in-flight, and
reverse-request-ID bounds, exact tuple binding, timeout/replay/error handling, and disconnect
invalidation. The production limits remain 64 ports, 32 reverse invocations in flight, and 4,096
reverse request IDs per authenticated connection. Trusted-adapter service/production tests cover
registration, ready-time before/after port authorization, teardown, and crash reattach. The seam is
installed only when an explicit `registrationAdapter` is supplied. The experimental OpenCode/tmux
production harness supplies none, so its operation registry is empty, its authenticated RPC surface is health-only, and health reports
`ownerOperationsWritable:false` and `nativeRegistrationEnabled:false`; these tests do not claim a
real-driver A1 registration, terminal root, inference connector, or remote A1 mutation. The stable
Claude MITM skips the runtime owner and creates no owner/RPC surface.

A1.5 pure tests cover exact route addresses/tokens and `rcr_*` IDs; three chat and two directional
server-control KDFs; closed kind-to-plane, direction, sequence, client-ID, authentication-field, and
part-shape rules; AEAD seal/open and route binding; canonical JSON frame encoder order, reordered-member
parse/normalized re-encoding, and duplicate/extra/noncanonical-value rejection; signature preimages;
a transport-frame digest; and stable attempt-header,
authenticated-part, and whole-message digests. Certificate tests cover strict native-root, server-scope rotation, four onboarding-key
commitments/attestation, signer-generation derivation, Ed25519 verification, TTL, and signature
transplant rejection. `ViewerOnboardingBundleV2` tests cover canonical `rcp2` transfer/checksum,
cold self-signed anchor and trusted-suffix modes, current-key binding, optional key pinning, and tamper,
chain, identity, noncanonical, and size failures, including rejection of any supplied-chain successor
that reuses an earlier Ed25519 public key under a renamed ID. A suffix begins at the exact
caller-supplied trusted certificate; older omitted key-ID and public-key history is deliberately left
to the caller trust store. These are pure Web-Platform contracts; they do not
claim viewer installation or a broker route.

Schema-v6 tests lock migration `006-terminal-native-root` to 36 statements, digest
`li87zqB0yxSfRtN-p_xT5Yk2xAvX8Iy5a1xDXNTYYZo`, and the complete manifest to 304 objects: 36 tables,
78 indexes, and 190 triggers. Repository/SQLite coverage includes initial activation and renewal,
exact replay/collision, stale owner/coordinator fences, expired-preparation refusal, rollback, lost-COMMIT reopen and exact
reconciliation, cryptographic/full-chain semantic reopen, machine/server/chat/operation-scoped `nrpc_*`
derivation and snapshot re-verification, a prepared renewal fork with exactly one
committed successor, backward-clock finalization rollback, and a committed certificate chain that
survives recover followed by re-ready/renew. Registration lifecycle tests separately prove that
recover, drain, close, and reattach atomically demote the rooted chat to recovering and edge to
installing; the append-only certificate ledger itself is not deleted by those transitions. Tests prove
that public runtime-owner store/accept/abort cannot mutate a prepared operation-attached v6
`native_root` reservation. The same test reopens the database and stores and accepts it through the
transaction-local terminal-root finalizer, which samples the acceptance/commit timestamp; legacy
unattached v5 signature history remains inert. Trusted-adapter service tests cover the closed
`native.root.activate` payload, protected runtime-owner signing before a fresh nonce-bound reverse
proof of the exact connection/binding/runtime/incarnation/attachment/port generation, immediate
synchronous finalization after that proof, and historical replay that does not claim present liveness.
The ordinary CLI installs no adapter. The reverse proof is ephemeral—not a row checked
on reopen—and A1.5 expiry does not auto-demote a persisted chat/edge. The later effective-route/
dispatch gate must separately prove certificate-time and current live-lease rechecks.

A1.6 pure tests lock the selected capability vector/digest, canonical route/store and cursor records,
generation-manifest digest, strict publish/exact-retry/first-collision receipts, and one-generation
read-page ordering and frame/count bounds. Web backend and route tests cover bearer-derived identity, literal
SQLite selection, capability pinning, strict duplicate-safe control/frame JSON, route/token/ID
recomputation, content-type and streaming body bounds, decoded ciphertext and part bounds, A1-only
catalog quota and concurrent provisioning, immutable `rbsi_*` identity, exact retry across automatic
4,096-frame rollover, changed-byte collision without allocation, immutable first-conflict evidence,
empty-generation seal/read advance, at most 64 frames and an 8,000,000-byte cap on each transmitted
snake-case HTTP response page, safe-
integer exhaustion, missing-store loss latching, and A0 retention isolation. Client tests cover
required negotiation, fixed bearer/selector/capability headers, redirect refusal, strict bounded
responses, canonical frame and digest validation, typed collision, original-cursor replay, store and
capability mismatches, secret scrubbing, and outcome-unknown network failure without automatic retry.
Schema-v7 tests lock migration `007-a1-broker-routes` to 22 statements, digest
`uShlOvT_fWScwCLQD1g6-GAd1YyKR2QIlGjC0SPQWbw`, and the complete manifest to 326 objects: 39 tables,
85 indexes, and 202 triggers. Migration/repository/SQLite tests cover exact protected capability artifacts in
`host_profile/default`, deterministic `rbcp_*` pins, canonical `rcr_*` route/token/store tuples,
current-coordinator and installing-server fencing, exact pristine open-generation-zero installation,
replay/collision, rollback, historical unknown-commit reconciliation, and full semantic reopen. The
host-only installer tests the remote-open/local-install split and exact recovery after either side is
already durable. None of these tests proves an ordinary CLI/driver/viewer A1 request or
runtime-owner broker operation.

A1.7a migration, parser, repository, actor, and real-SQLite tests cover v7-route backfill and post-v8
auto-seeding; exact route/artifact/page/frame closure; current-fenced revision CAS, stale refusal, and
crash-retained actor takeover; bounded page staging and independent fetch/semantic cursor movement;
one-part and multipart `awaiting_order`; exact retry; transport/semantic collisions; invalid payload;
incomplete expiry and late tombstones; quota and 1,024-position lookahead; explicit gap recovery;
unknown-commit reconciliation; and secure-reopen corruption refusal. Negative migration assertions
also prohibit later command, signature, result-delivery, outbox, effect, dispatch, viewer, and native
tables. The dormant actor has unit composition coverage but no ordinary CLI, driver, runtime-owner,
or viewer wiring, so the tests do not establish a live A1 collaboration path.

A1.7b0 parser, custody, migration, repository, service, and real-SQLite tests cover strict record
shapes and lifecycle tuples; deterministic server identity, bootstrap-intent/signed-certificate
digests, and AAD vectors; sign/verify without any
raw PKCS#8 API; rejection after transplanting the machine, server, protected handle, key ID,
generation, algorithm/backend, public key, PKCS#8 digest, ciphertext/tag, or root secret; initial
`scope_certificate`-only bootstrap; current coordinator lease/epoch/fencing checks; monotone burned
signer sequences; exact initial-certificate reserve/bind/sign/accept replay and collision; acquisition
of the installed current lease without a generic current-lease signing API; stale-authority refusal;
immutable `writable:false`/`stale_bootstrap_fence` reconciliation when coordinator takeover strands a
non-closed initial bootstrap, including refusal to re-fence, replace, or reserve again; installed
current-lease supersession and custody-qualified fresh exact-next-token acquisition after no
`reserved`, `bound`, or signed-but-unaccepted predecessor reservation remains;
the dense per-server `acceptedAtJournalSeq` signer-acceptance coordinate without any schema-v3
control-journal expansion; atomic artifact-plus-phase persistence; landed/absent unknown-commit cuts
for prepare, bind, signed store, finalization, and takeover acquisition; process-crash resume from
every durable phase without replacement-key generation; and semantic reopen. Negative tests require the schema-v9
slice to remain dormant and prohibit a common command/result, generic host-output record, broker
publish, result delivery, outbox/effect, native attempt/dispatch, viewer projection, native table, or
production import. Migration 9 is pinned at 81 statements, digest
`fYrN5atmwIj-tlT_tTXmrg9kNF52ah-zWmgf7vVFQWE`, and a 571-object manifest: 65 tables, 123 indexes,
and 383 triggers.

A1.7b1 pure-contract, migration, repository, signing-orchestrator, and real-SQLite tests lock migration
`010-common-command-adjudication` to 50 statements, digest
`rdJC_2C5IyjfsTuXhxjFSzT0bvDYtlpT8o0xDvu4IEk`, and the complete 619-object manifest: 70 tables,
137 indexes, and 412 triggers. They require exactly the five new ready/adjudication/command/group/
preparation tables and prohibit final-result, command-result acceptance, result-delivery, outbox, effect,
attempt, dispatch, native, viewer, and production surfaces. Contract tests cover defensive exact-shape
parsing; scalar text through 48 MiB; the bounded small `unsupported_recognized` envelope; canonical
A1 source identity, command, decision-evidence, command-record, result-payload, signed-result, and
deterministic `rcm_*`/`ccr_*`/`csg_*`/`crp_*` identities. SQLite/repository tests require the union of
control and ready entries to be unique, contiguous, and equal to `nextJournalOffset`; current,
gap-free, earliest-unadjudicated route-head selection; a 256-unresolved-command ceiling; global
minimum `(readyAtJournalSeq, commandId)` decision order; dense `commandSeq`/signer-sequence allocation;
rejected-only decisions; unchanged creation provenance under successor-coordinator decisions;
monotone decision/preparation times; exact reserve→bind→sign and unknown-commit recovery; signer
takeover fencing; repeated generation-one/two abort and generation-three reprepare; full semantic
reopen/corruption refusal; and the durable stop at command `decision_reserved`, ingress `deciding`,
preparation `signed`, group `result_signed`, and reservation `signed`. Those remain the exact schema-v10
boundary; schema v11 closes only the rejected arm below.

A1.8a0 pure-contract, migration, repository, finalization-orchestrator, validator, and real-SQLite
tests lock migration `011-a1-rejected-result-finalization` to 38 statements, digest
`SkkuAFJed-7GT9XyXXPCub7VFauqNY6eu0u4IQJEInc`, and the complete 647-object manifest: 73 tables, 147
indexes, and 427 triggers. They require exactly `collaboration_command_results`,
`a1_ingress_terminal_results`, and `a1_ingress_result_deliveries`; exact compact rejected
`action_result`/`chat_creation_result` bytes and schema IDs; the domain-separated stored semantic
digest; `ingressResultId === stableSemanticResultId`; deterministic `rrd_*`; a once-retained random
`rda_*`; and the greatest route-ordered accepted `new_part` observation only after proving exactly one
observation for every expected part. Repository/migration tests prove one-transaction result,
acceptance, command/sidecar terminalization, artifact, and `pending_seal`; exact replay without ID
reallocation; full rollback on a mismatched signed digest; partial-graph corruption classification;
landed/absent unknown-commit reconciliation; finalization after source collision and route close; and
the narrow max-fence predecessor-signature takeover under an exact live successor. Secure-reopen
tests retain the immutable v8 evidence row in `awaiting_order` or later
`quarantined_collision`, retain v10 preparation/group/reservation at
`signed`/`result_signed`/`signed`, and reject hostile mutations, an intervening higher signing fence,
orphan artifacts, and inconsistent completion anchors. Negative gates prove that `pending_seal` is
unclaimable plaintext semantic intent: no ciphertext, output part/signature, claim/seal/publish,
effect/attempt, projection, native/broker operation, cursor movement, or production import exists.
If optional OpenCode work resumes, these dormant tests are still insufficient: the complete admitted
browser-to-viewer loop and a separately gated credentialed connector/isolation path must be proved
before any OpenCode advertisement. Their absence does not block Claude 1.0.

### Long-horizon multi-engine acceptance matrix

This is retained optional long-horizon research across A1, A2, B, and C, not an active release gate.
If an OpenCode product is explicitly resumed, its narrow safety suite uses only the cases in the
[optional OpenCode matrix](#optional-opencode-safety-matrix). The remaining cases become binding only
after a separate product decision selects the corresponding engine, source, mutation family, or
shared-runtime feature.

- pair one host once, then concurrently launch at least two wrapper invocations for each of Claude, Codex, and OpenCode. Use different directories for at least one pair and the same directory for another pair. For Codex and OpenCode, run the matrix once with separate private daemons and once with two conversations sharing one pinned daemon. Require one stable logical-chat row and distinct native binding for every semantic native conversation; directory, title, product, wrapper registration, daemon ID, and provider IDs must not merge or replace a row;
- for every row, prove one live local TUI and one remote-claw collaborator can act on the same native conversation. Join two additional remote collaborators to one selected row and a live nested remote-claw collaborator to another; neither join may create another native connection where the adapter contract allows only one bridge, nor alter collaborator membership on a sibling row;
- reuse identical source event IDs, viewer `msg_id`s, native request IDs where their namespaces permit, prompt text, and project names across rows while interleaving submissions. Require independent source namespaces, per-chat actor order, attempts, effect gates, broker routes, projections, native read-back, and filesystem effects with no cross-row lookup or deduplication. Each chat's admitted provisional rows must use its own dense `viewerProjectionSeq` starting at zero even when the server-wide `command_seq` interleaves other chats; one chat's sequence gap must not block another;
- hold chat A busy, chat B at a permission gate, chat C in `outcome_unknown`, and crash chat D's wrapper or adapter while continuously submitting to chats E and F. E and F must admit, dispatch, observe, and project without waiting for A–D. No error, cancellation, quarantine, teardown, or shared-daemon subscription cleanup may change another chat's writable state, native history, TUI, runtime generation, or working directory;
- restart the coordinator and host inventory while native runtimes survive. Reattach A to the same live process, cold-resume B to the same native conversation, replace only C's proved private transport, and make D fail native identity proof. Require A–C to keep the same visible rows, logical-chat IDs, bindings, histories, collaborators, and per-chat ordering; quarantine only D without minting a replacement row. E/F local TUIs and runtime-scoped inference remain available throughout. While no coordinator lease is current their remote mutations fail unavailable; each remote path is re-enabled independently only after its own lease, binding, and attachment proof passes;
- stop or close one Codex thread lease and one OpenCode session lease while sibling conversations share their daemon. Require the shared daemon, bridge/observer resources still demanded by siblings, sibling TUIs, subscriptions, and chats to remain alive. Then stop the last owning lease and require only the explicitly selected daemon policy to run;
- disconnect and reconnect the nested collaborator on its one row, replay its last exact command/result, and attempt to reflect or transplant it into every sibling row. Require one stored replay result on the original edge, no second native execution, rejection of every transplant before dispatch, and no change to any sibling's lineage or readiness.

- bootstrap one random default `rcs_*` per local state profile, reopen it across process restart, and
  require an explicit new-profile/re-pair event after loss; never derive it from machine, project,
  broker, or native IDs;
- bootstrap a server's first random `rcpj_*` and generation-one
  `ProjectTargetSelectorMappingRecord` atomically from one exact allocation intent and terminal target;
  in that same transaction create the recovering logical chat, starting native binding, registration
  intent, and its random `rcie_*` installing native-harness inward edge, with the chat pointing to the
  edge, the chat storing the exact generation-one mapping ID, and every
  root-certificate/live-lease/capability pointer null. Retry the exact intent and return the same
  project/mapping/chat/binding/edge, collide changed selector/target bytes, and require explicit project
  creation only after first bootstrap or exact `(projectId, workspaceSelectorId)` selection after any
  project exists. Reject `project:null`, a missing/closed project, cwd/title inference,
  only/most-recent fallback, and every nested selector target/remote-server edge in schema v3 before writing any A1 registration intent,
  logical chat, or native binding;
- replace a terminal selector mapping only when its exact current mapping ID, generation, and target
  digest match; atomically supersede that row, install generation `n+1`, and journal the new mapping.
  Require exact retry, collision on changed replacement bytes, read-side lost-response reconciliation,
  a contiguous mapping inventory with one current tail, and old logical chats remaining pinned to their
  original superseded generation while later chat reservations may select the new tail;
- reopen and migrate one owner-only `host-state-v1.db` on Linux with an exact stable Node.js `X.Y.Z`
  version in `^22.13.0 || >=23.5.0`; reject unsupported versions and any prerelease/build-like suffix;
  require owned, non-symlink parents below the selected state home, a state
  home that is not group- or world-writable, exact `0700` application/identities/identity directories,
  and owned regular `0600` database/WAL/SHM files with link count one. Exercise `/proc/self/fd`
  descriptor anchoring and no-follow/exclusive create,
  reject a relative or empty fallback home before resolving any path,
  descriptor-versus-path device/inode checks before and after open/migration, symlink/hardlink/path
  replacement races, policy-v1 refusal for everything except ext/XFS/Btrfs/F2FS/ZFS, non-WAL refusal,
  and a safely inspected but refused `host-state-v1.db-journal`. On every connection require and read
  back `foreign_keys=ON`, `trusted_schema=OFF`, `journal_mode=WAL`, `synchronous=FULL`,
  `busy_timeout=5000`, `temp_store=MEMORY`, and `recursive_triggers=ON`; require `query_only=ON` on the
  initial existing-state validator. Validate the logical WAL state in one read-only transaction
  snapshot only after behavior-probing that double-quoted string literals are disabled on every
  connection. Open a writable SQLite connection only after that validation. Recover a valid older
  version committed only in WAL even when the main header remains at zero. Reject a future version
  committed only in WAL without changing the main database or WAL; treat SHM as transient state that may change while its
  path and file contract remain guarded. Reconstruct a safe SHM-only remnant beside an existing
  database, but refuse either sidecar without a database.

  Treat FULL WAL `COMMIT` as migration durability, then validate a coherent snapshot, attempt
  `wal_checkpoint(PASSIVE)`, and fsync guarded database/sidecar/directory descriptors. Prove that an
  active reader may leave WAL frames and a competing checkpoint may return exactly
  `busy=1`/`log=-1`/`checkpointed=-1` without turning a committed migration into rollback; reject every
  other inconsistent result.
  For both migrations and ordinary transactions, swap a guarded path while `BEGIN IMMEDIATE` waits and
  require guardian revalidation after writer-lock acquisition to fail before migration SQL or a public
  callback runs.
  Distinguish typed committed and unknown migration outcomes and make both retry-open-safe; reopening
  must validate and complete the exact migration. Ordinary writes have no mandatory checkpoint or
  extra fsync: force a guardian failure after `COMMIT`, report committed state, and poison the handle;
  type an unknown ordinary commit as not retry-safe. Keep protected-artifact persistence failures
  distinct from verification failures and poison the live handle. Expose no entropy or clock injection
  through the public database opener. Release descriptor guardians only after SQLite proves closed;
  make an incomplete close guardian-retaining and retry-close-safe. If cleanup after a failed open
  leaves any SQLite connection live, retain the connection and guardians in fail-stop quarantine until
  process restart, reject every later open of that canonical database path while allowing another path
  to open independently, and mark that open failure not retry-safe. Poison before forbidden async
  Promise-species or thenability handling can reenter the transaction authority.

  Refuse a wrong SQLite `application_id` (expected `0x52434c57`); wrong stored machine identity; a
  changed exact per-version schema manifest; a changed, partial, or future migration history; and a
  corrupt database. Before migration 1, require a newly created database to retain
  `application_id=0` and literally zero `sqlite_schema` rows. Lock migration 1 to
  `Pk8Yrc3jVK9xoHKDcBdeyejFYUSbyjnp-SH0VMA_Hec`, migration 2 to
  `yx23Bca9rSZttCEInDAEOrzLVhq-KWcZLE1i27tqNiY`, and the 81-statement migration 3 to
  `cMLS59JfiV7fRoK68n1kZz3DN9Vo4yu7VZAX_HxHpq4`; require the exact v1 six-object manifest of three
  tables, one explicit unique index, and two triggers, the v2 ten-object manifest with six triggers,
  the v3 91-object manifest of 13 tables, 24 indexes, and 54 triggers, and the 141-statement migration 4
  to `zx52EtAFNY9hEZneG3RW14zRCYR18gg7ysnltHbOkT0` with the v4 231-object manifest of 30 tables,
  57 indexes, and 144 triggers. Lock the 38-statement migration 5 to
  `l32ozsKKBm5ueLOk-_IeiasPgp_deE-tZHEbaZ6urOE` and the v5 manifest to 269 objects. Lock the
  36-statement migration 6 to `li87zqB0yxSfRtN-p_xT5Yk2xAvX8Iy5a1xDXNTYYZo` and the v6 manifest
  to 304 objects: 36 tables, 78 indexes, and 190 triggers. Match every `sqlite_schema` row and reject
  even a hidden `sqlite_*` extra; reject update, delete, or replacement of migration/artifact rows.
  Expose no raw SQL; reject nested/async/escaped transactions and database-level asynchronous artifact
  calls inside a transaction callback; and roll back multiple protected-artifact writes as one unit.
  Exercise the 16 MiB limit, immutable artifact rows, exact
  scope/schema/reference/digest reads with stored-length validation, fresh returned snapshots, and
  failure after eight random handle collisions;
- race two coordinator acquisitions and require one current pointer, contiguous epochs, and one
  allocated journal offset per committed entry; every stale `(leaseId, epoch)` RPC fails before a
  mutation while the native TUI remains usable. Renew only by exact old-deadline compare-and-swap,
  release only the current fence, and reconcile each lost acquisition/renewal/release response from
  durable rows. Take over an explicitly released predecessor no earlier than its release time or an
  expired predecessor no earlier than its deadline; advance the server pointer/epoch without rewriting
  the predecessor row; clear the server pointer only after releasing the exact current lease and
  epoch it still names; and accept only current/released lease states in v3 semantic validation;
- race runtime-owner daemon starts for one machine identity and require exactly one current
  process-start-bound service lease and monotonic owner epoch. Renew only the exact current deadline;
  on unknown acquisition or release commit, close the poisoned handle, reopen, and reconcile the
  immutable operation before retry. Expiry or explicit release permits takeover without rewriting the
  predecessor. Listener loss, lease loss, clock failure, or unusable key custody must remove writability
  and stop the daemon; a wrapper RPC disconnect must detach only that collaborator and must not release
  the service lease or terminate any native runtime;
- derive the runtime root exactly once from its 32-byte launch nonce, start-identity schema, and
  32-byte start-identity digest. Register many independent Claude/Codex/OpenCode runtimes and many
  conversations in one owner inventory; preserve shared-daemon siblings when one binding detaches.
  Reassignment appends a successor owner assignment; replacement/termination requires positive
  containment evidence and advances or closes the native incarnation without re-deriving the runtime
  root. While the coordinator is unavailable, append local conversation transitions only for an
  already durable project; reject an unknown/closed project, and leave first-project allocation to the
  coordinator;
- wrap every runtime-owner Ed25519 private key as an authenticated ciphertext envelope bound to its
  runtime, key ID, generation, public key, and plaintext digest. Expose only a typed opaque handle and
  closed signing capability; never return root, wrap-key, or PKCS#8 plaintext over RPC or repository
  inventory. Require current-key startup self-test, monotonically reserved signer sequences, exact
  purpose/schema binding, one acceptance per signed digest and signer tuple, and rejection of stale,
  revoked, transplanted, tampered, cross-handle, or duplicate records. Retain ciphertext for audit and
  call revocation logical destruction, not physical erasure;
- allocate each terminal chat's installing native inward edge with its binding and point the recovering
  chat at it; that one edge is the non-writable terminal-root reservation and has no certificate yet.
  Prove activation is impossible before the A1.3 runtime owner has a current protected
  `RuntimeOwnerIdentityKeyRecord` and attachment lease and A1.4 has made the exact matching durable
  binding/runtime/incarnation current. Then activate only with that runtime-owner signature; reject a
  server-key signature, stale/revoked runtime-owner key, stale or cross-binding attachment, and every
  pre-A1.4 attempt. Reject A1/A2 native dispatch when the terminal edge is absent, unsigned, stale, or
  points to another chat. A current native-harness edge must keep its remote-server connection epoch at
  zero and both live-lease/capability pointers null; its current attachment lease and native capability
  snapshot are the terminal live proof. N1 must extend that existing root rather than create or replace
  it, and only N1 remote-server edges may install an `InwardEdgeLiveLeaseRecord`;
- retry one durable native registration intent after process restart and return the same binding;
  change any descriptor/project/native/phase/metadata/capability or operation-controlled byte under
  the same attempt/operation ID and require collision. Keep operations contiguous, publications
  generation-ordered, and every canonical evidence artifact in its exact server, runtime, or binding
  scope.
  Reconcile an uncertain commit by recomputing the complete request without treating stale authority
  as current. After a crash, preserve the stale open predecessor as non-writable evidence, acquire
  fresh owner/coordinator fences, and replace the process port with a new lease on the same binding.
  Rotate the transport lease exactly when those fences change, retain the predecessor close proof,
  and require `liveReattach:true` from a retained publication; allow pre-publication recovery without
  inventing that capability. Reject legacy detach/replace/terminate and clear/archive when retained
  registration lineage would be broken;
- atomically arm one protected dispatch authorization with its immutable attempt, front-door dispatch,
  and command gate. Persist only its typed `rcph_*` reference, never the raw 32-byte value. Crash and
  reopen before consume, reconstruct the exact stable request from the row, and require the same
  reference and digest without a generic protected lookup. Let a replacement coordinator present its
  own current fence for that unchanged identity; reject the predecessor, a stale replacement, and a
  forged fence. In the final owner transaction, consume once, move all three rows to started, and
  return the raw authorization only to the in-process adapter. Crash at each pre-byte/post-byte
  boundary; after consume require evidence-only reconciliation and prove it has no native send
  capability and returns no raw authorization. Correlate both first-dispatch and post-restart
  reconciliation receipts through the same strict raw-free attempt-ID plus canonical-dispatch-digest
  expectation reconstructed from the durable dispatch row. Require receipt evidence to be absent at
  `started`, present at `transport_receipt`/`native_observed`/`completed`, atomic and explicitly
  optional at `outcome_unknown`. A `rejected` delivery attempt must retain its claiming epoch and
  complete negative outcome evidence, reject positive native read-back evidence, and permit a prior
  transport receipt without requiring one. Changed scope, attempt, reference kind/ID, ingress lease,
  target, request, or translation bytes must fail before consume. Roll back a transaction spanning the
  native attempt, front-door dispatch, and effect gate as one unit; this is optional generalized
  executor research, not an A1.1 protected-artifact-kernel claim or the optional narrow one-row model;
- negotiate the exact A1 broker capability vector, reject A0/partial/changed vectors, and independently
  prove route-wide uniqueness, broker-recomputed digests, exact retry cursor, manifests, and collision
  tombstones across restart and rollover;
- persist a distinct `(collaborationServerId, logicalChatId)` canonical chat, native
  binding/conversation, private transport, broker channel, and outward-provider IDs, and assert that
  none is silently aliased; chat route/row/alias/cache keys additionally include `identity_id`, while
  the separate discovery-bus route/cursor is `(identity_id, collaborationServerId, scope_bus, null)`
  and typed **New chat** uses the distinct
  `(identity_id, collaborationServerId, server_control, null)` route;
- verify byte-exact cross-runtime A1 vectors for canonical field encoding, scope-bus/server-control/chat route hashes,
  the exact version-2 JSON frame/AAD/base64url/tag contract, normalized transport-frame digest,
  chat-scoped content/control/meta KDFs plus distinct server-control inbound/outbound KDFs, message encryption, stable part/whole-message digest
  encodings, exact accepted/action-result/chat-creation-result payloads and key order, exact
  broker-route IDs and sealed-generation
  manifest digests, and initial/rotated Ed25519 scope-certificate
  chains; reject alternative encodings, null rules, algorithms, wrapped keys, padded base64, and A0/A1
  cross-version opens; reject quote, backslash, control, non-ASCII, and alternative-escape forms in
  exact result string fields; require exact result `v` token `1`, and reject signed, leading-zero,
  fractional, exponent, or over-safe-range result number tokens; apply the same
  sign/leading-zero/fraction/exponent/over-range rejection to all
  outer-frame JSON numbers before conversion; reject duplicate JSON members before object construction and vector every
  versioned kind-to-plane mapping, including distinct A1 `action_result` and `permission_resolved`
  semantics; vector every allowed and rejected kind/direction/sequence/client-ID header combination
  and its invalid-position cursor/quarantine result; cover cold-chain verification,
  rollback/fork/skipped-generation/key-ID-rebinding rejection and atomic current-certificate
  compare-and-swap; also vector the exact broker generation/cursor ordering and successor rules;
  include the four onboarding key-commitment formulas and exact attestation payload, per-key
  substitution, canonical bundle wire/checksum, host-output signature preimage/digest/verification,
  signer key/certificate/generation/sequence AAD fields, unsigned output, route/signature transplant,
  stale/burned signing reservations, duplicate/equivocating server-wide signer sequences, signed rotation
  cutoffs, certificate-update order/fork, historical reattestation publication/retrieval/equivocation,
  and current versus retired/revoked-key behavior;
- restart Claude, explicitly resume the same native UUID, accept a re-bridge of the persisted private
  `cse_*`, bind the new worker epoch to the new native/coordinator epochs, and keep one server/chat
  scope and machine-aware web row with continuing RC and broker sequences;
- when the same proven Claude UUID creates a replacement private `cse_*`, fence the old worker and
  retain the server/chat scope, machine-aware web channel, command order, and outward Anthropic
  binding without duplicate turns;
- reject wrong UUID/project/product adoption and stale worker/coordinator/presence writes without
  matching by title or text;
- retain sanitized exact-version Claude fixtures with binary/schema/probe hashes; cover worker ACK
  before/no native application, native application followed by lost ACK and reconnect, and the exact
  join among private-RC command UUID, worker echo/receipt, transcript row/UUID, provider exchange, and
  resulting native turn;
- race Claude TUI and remote permission/question answers with native cancellation, interrupt, tool
  completion, answer-delivery loss, and disconnect; keep remote choice, worker delivery, and native
  terminal outcome separate and close gates only from native evidence;
- detach an outside Claude collaborator/connector and replace the private-RC epoch while a child turn,
  gate, or inference request is active; keep the child/TUI/private RC/inference path alive and hold the
  replacement non-writable until old work is terminal or unknown, quarantined, and contained;
- crash before and after binding commit, native write-ahead, native observation, broker cursor
  advance, outward publish, and provider ingress ACK; assert exactly-once decisions where provable and
  quarantine every ambiguous delivery;
- lose a web-input `accepted` result, retry the complete exact logical frame with the same semantic
  `msg_id` and a fresh authenticated `delivery_attempt_id`, and require one command plus delivery of
  the stored result before and after coordinator restart; race the retry while the first decision is
  `assembling`, `awaiting_order`, and `deciding` and allocate no second command/projection sequence;
  redeliver one committed physical cursor across a crash and require the same deterministic
  observation/result-delivery records and output attempt ID; after part-body compaction, lose and
  replay the result delivery and require the retained stable result ID/exact payload;
- request the same stored projection through A1 catch-up twice in one broker generation; require a
  fresh persisted delivery attempt per catch-up request, reuse that attempt for an exact outbox retry,
  preserve semantic `msg_id`/`seq`, and fold one viewer projection without broker suppression;
- reuse one semantic `msg_id` with a changed whole-message digest and require collision quarantine
  before cursor advance; for multipart input, test partial/exact/full replay, changed sibling parts,
  candidate and byte/count limits, durable incomplete tombstone expiry, late parts, sealed-generation
  rollover/empty-generation manifests, and crash at every part/cursor/decision/result-outbox boundary;
  place complete proposal B after the first position of incomplete proposal A and prove B cannot enter
  decision/order allocation before A completes or expires; retry one identical delivery attempt within
  a generation and after rollover and require its one original cursor with no new semantic result;
  reject changed normalized bytes under that route-wide attempt/part key; retry one part of a formerly
  complete multipart attempt after rollover and require the same original position with no result
  delivery or candidate completion; then have the hostile broker replay that valid part at a fabricated
  new cursor and require one `exact_transport_retry` with no result delivery/candidate change; keep a
  semantic collision blocked until audited recovery; crash after a generation seals but before its
  final frame is consumed, then resume the durable cursor,
  drain through the stored frame count, and only then consume its successor;
  in the later retention/compaction gate, compact only a checkpointed discovery scope-bus frame body after recovery leases pass, then retry
  the old attempt/part unchanged and changed; require the retained route-wide tombstone to return the
  original cursor or a collision, never a new position. Attempt chat- or server-control-body
  compaction and require rejection because cold semantic/result recovery retains those routes from
  genesis;
- interleave announcements for chats A and B on one scope bus across rollover and require one
  route-wide bus cursor/manifest sequence, distinct from both chat routes; inject a malformed bus
  position and require only the bus actor to quarantine while both chat actors continue, then clear it
  only through explicit bus-position recovery;
- in future A2, interleave live web and authenticated official-client, automation, and nested-server
  stand-ins for `new_chat` through the one server-wide common command sequencer; require each proven-new event to
  receive one command and signed common result before exactly one enabled terminal-native effect.
  Exact replay links the same command/result, changed bytes collide, and direct
  OpenCode/Codex/Claude adapter calls without an admitted common command composite FK fail. N1 repeats
  the same actor test with a live nested target and its nested-management effect;
- crash after common decision reservation but before signing, and after signature persistence but
  before signed-result finalization. Abort/burn one signing reservation and require a higher
  `preparationGeneration` for the same result version and byte-identical frozen decision; race two
  finalizers. Before finalization there must be no source ACK, protocol result delivery, projection
  intent, native/nested attempt, or effect gate. After recovery, require exactly one immutable signed
  common result, one causal source outbox, and exactly one selected enabled executor arm. In A1/A2,
  only the terminal arm is enabled and it creates zero nested-management attempts. N1 separately
  enables the nested arm and requires it to create zero outer OpenCode binding, native creation
  reservation, or OpenCode front-door call;
- in future A2, exercise the server-control route from generation-zero genesis with null chat, its distinct address,
  token, dedicated server-control input/output KDFs, typed `new_chat`/`chat_creation_result` allowlist,
  and target allocation. Require `new_chat` to be inbound with null `seq`, a client ID, 0/1 chunk
  shape, and null host-authentication fields. Require `chat_creation_result` to be outbound with
  `seq=command_seq`, the echoed client ID, stable result `msg_id`, 0/1 chunk shape, and every certified
  host-output field non-null. Before AEAD open, reject wrong route, machine/server/null-chat scope,
  direction, header nullability, client-ID presence/correlation, chunk shape, host signature, and
  bus/chat/control transplant. Require a wrong server-control key to fail at open. After open, reject
  non-canonical payload bytes/key order, `seq`/`command_seq`, header/payload result-ID, decision/target,
  or source-result correlation mismatches before semantic dispatch or target allocation. Expire or
  collide an incomplete server-control candidate and require quarantine with no fabricated command
  sequence or result;
- in N1, create through a server-scoped nested-management binding before any inner chat edge exists; verify
  stable target outside-binding namespace/event identity, authenticated acyclic management lineage,
  one write-ahead physical child, target common result, target-ready/root proof, two-party edge
  installation, and mutual live lease before the outer chat becomes ready. Race reconnect, reject
  cycle/hop-limit proposals with an ordered result, and require no second inward send after started or
  ambiguous delivery. Require hop zero's source command/result/target to equal the origin common
  result, and every later hop's source tuple to composite-FK the preceding target server's verified
  command/result; attempt an intermediary command/result splice and reject it before target command
  allocation. Vector the management live handshake's exact exporter label/context/output digest,
  source/target nonces and coordinator epochs, transport epoch, live TLS peer certificates,
  side-specific signed attestations, deterministic handshake/lease IDs, and two current pointer
  installs. Substitute any transcript field/signature or hold only one pointer current and require
  non-writability. Replace the management lease/capability snapshot before send and require the exact
  signed management continuation with unchanged binding, target, request/receipt schemas, semantic
  request, and `newChatCapabilityDigest`. Substitute an old/new lease, snapshot ID/digest, target,
  capability, or positive-never-started proof and reject. Create the physical child and its exact
  `armed@1` nested-dispatch authorization together, persisting only its typed `rcph_*` reference and
  canonical dispatch digest. Prove that the final send CAS consumes it while returning the raw value
  only to the in-process transport writer and
  moving both child and command-wide gate to `started` before any byte, whereas pre-send abandonment
  alone may revoke it to `revoked@2`, mark the child `never_started`, and leave the gate
  `(never_started,null)`. Sign the exact version-one positive-never-started payload with the current
  certified source-server key and reserved signer purpose, then verify its command/result/decision,
  semantic/physical/transport attempt, route/target/topology, prior lease/snapshot/capability,
  request, authorization ID/protected reference/canonical dispatch digest, revocation
  version/journal sequence, and literal assertion. Assert that no durable child, authorization row,
  continuation, attestation, log, environment, or wire payload contains the raw value.
  Exercise current-key, permitted retired-key, and historical-reattestation verification; reject a
  revoked/too-new/unreattested signer, bad purpose/schema/encoding/signature, or any substituted
  binding. Install the successor only by CASing the still-revoked predecessor, exact signed evidence,
  still-never-started child/gate, and current successor lease/snapshot, creating one fresh `armed@1`
  authorization while leaving the gate never-started. Crash/race before and after each CAS and prove
  at most one child can send; a consumed, started, uncertain, or partially populated evidence tuple
  can never continue, and no transition rewrites `started` to `never_started`;
- in N1, send ordinary `user_text` through two live nested servers and require a common command at each server,
  one edge capability/semantic attempt, immutable physical transport children, stable source event,
  verified target result chain, and one terminal OpenCode attempt. Reorder/fork target results,
  replace the edge lease before/after send, verify the exact signed capability-continuation payload and
  the same authorization-ledger and signed positive-never-started contract before a replacement
  child. Require the continuation's evidence schema/digest and the predecessor child/gate's
  schema/ref/digest tuple to agree, install exactly one fresh armed successor while the common gate
  remains never-started, and let only that successor's final send CAS name itself on the gate. Reflect the outward observation
  inward, and require quarantine or deduplication with exactly one native mutation;
- create every route with generation-zero genesis; require mutating chat cold start to replay from
  genesis or a retained cursor and reject a broker that starts at `N`, omits genesis, or breaks a
  manifest successor. For the discovery bus only, prove the separate signed checkpoint over a
  broker-sealed tip, including non-empty and empty generations, persisted effective successor across
  restart, stale/open/forked checkpoint rejection, rollover, and the prohibition on using it for chat
  or semantic state;
- redeliver one cursor with identical bytes and require its stored disposition; equivocate at that
  cursor with valid-A/valid-B and valid/malformed bytes across restart and require durable alternate
  digest evidence, route quarantine, and no parse/mutation/progress; transplant valid frames across
  machine, server, equal-ID cross-server chat, different chat, bus↔control↔chat routes, and null↔non-null
  chat coordinates and require invalid positions on the externally selected route before KDF/open;
- replay an exact sealed-generation manifest, then change its count/state/successor and separately
  try to reopen it and present an index at or beyond its sealed frame count; require idempotency only
  for the exact duplicate and a durable manifest-equivocation gap/quarantine with raw observation
  digest for every changed form across restart, without rewriting the accepted manifest or cursor
  order;
- reconnect/replace the web client and coordinator, then reveal unseen pre-boundary ciphertext; require
  the same deterministic web source namespace; reject an attempted in-place namespace reset while old
  A1 keys/routes remain live; attempt tombstone GC after ordinary retention, local chat closure, and
  machine reset, and require all three to fail because the optional A1 design has no broker-enforced route
  revocation and copied bearer/key material may remain valid;
- admit one multipart `attachment` through each supported source path and require the exact common
  `remote-claw/command-payload/attachment/v1` payload, contiguous ordered version-one item records,
  item-vector count/digest, strict filename/media/size rules, and every decoded-content ref/length/
  digest to recompute. Vector absent-caption canonical null separately from a present empty string and
  reject any adapter that conflates them. Require the target family capability to name that same common schema and its
  proved translator/read-back contract; adapter-shaped JSON, source-base64 spelling, a substituted
  item/ref/digest/order/count, or `unsupported_recognized` payload cannot receive an admitted result.
  For the N1 live nested-source path, require the selected edge family to hash both the distinct common
  payload schema and wire-request schema, then transmit the exact portable payload-transfer bytes:
  common payload bytes plus every canonical item-record byte and decoded content byte. Make every
  source-local ref unavailable at the target and require successful target-local rematerialization;
  omit, reorder, add, or change an item/content byte or either schema and require rejection before
  target source-event normalization.
  For the valid A1 case require one viewer-projection sequence, one exact `accepted` result, one user
  attachment projection, one file-write/native attempt, and native outcome adjudication independent
  of that result. Replay the full exact attachment under a fresh delivery attempt and require only
  stored-result redelivery, then change one byte under the same semantic ID and require collision
  quarantine before any second file write or native attempt;
- interleave journaled host output and fresh catch-up output before inbound proposals across crash and
  rollover; require the current fenced signing reservation, certified host signature, exact durable
  outbox/frame match, and signer-sequence index to advance those physical positions without source
  adjudication. Forge signed-looking announce/accepted/projection frames with a copied pass, omit the
  signature, transplant a real signature across bus/chat/server, race key rotation, and conflict a
  local multipart outbox insert; each must block before render or mutation, while an exact signed replay
  folds once;
- for multipart native output, catch-up, accepted, and action-result deliveries, crash after broker
  acceptance but before the publish response/local receipt; require the outbox retry to reuse the exact
  persisted header/salt/nonce/ciphertext/tag bytes and original cursor, never re-seal under the same
  attempt ID;
- place duplicate/missing/wrong-type header JSON, bad encoding/tag, unknown-kind, and wrong-plane
  frames before valid input;
  require one immutable invalid-position gap and terminal no-mutation cursor disposition per frame,
  keep the valid proposal buffered/non-writable across restart, and release it only through the explicit
  current-epoch invalid-frame recovery transition;
  after large part bodies are compacted, replay a changed sibling and the full message to prove the
  retained per-part digest vector and full-lifetime result/tombstone still prevent a second command;
- replay one provider event before and after connector restart, credential rotation, forced
  outside-binding incarnation, and history/cursor overlap; assert one command across a continuous
  source-event namespace, and deliver old history after a proven namespace reset while still linking
  it to that one command;
- create a genuinely post-boundary provider event that reuses an old raw ID in a proven reset
  namespace and assert exactly two commands; separately assert fail-closed behavior for a changed
  payload under one canonical identity and quarantine when namespace continuity or event-boundary
  classification is ambiguous;
- race the same source event through old/new connector incarnations and assert one canonical command;
  separately race an old replay against a distinct, proven post-boundary reuse of its raw ID and
  assert one old-command link plus exactly one new command;
- crash before/after namespace-transition install, cross-incarnation lookup, observation
  classification, canonical source-event insertion, and `command.proposed`; assert recovery of one
  recorded branch and no semantic ACK/cursor advance for collision/ambiguous input;
- restart one Codex app-server with several threads while preserving exactly one native remote-claw
  bridge, the paired ChatGPT host, projects, managed top-level logical-chat mappings, child lineage,
  and sibling isolation without duplicating an official chat;
- crash that Codex bridge while the app-server/TUI survive, require native `ConnectionClosed` handling
  and subscription cleanup before replacement initialization, reject stale writes/responses, then
  rebind the managed top-level chats through exactly one new bridge `ConnectionId`;
- overlap two official Codex streams and another remote-claw collaborator on one managed chat, then
  exercise first join, non-final leave, last aggregate leaver, reconnect, and cleanup; preserve
  per-stream lifecycle while emitting zero or one fenced native subscription transition per change;
- concurrently reuse official request IDs and process/watch handles, then prove bridge-wide remapping,
  exact response/error routing, tombstones, and source-specific cleanup;
- if OpenCode platform work is explicitly resumed, run the complete optional safety matrix in
  [A1 OpenCode vertical slice](a1-opencode-vertical-slice.md); no retained audit fixture or partial
  alpha substitutes for that gate;
- restart tmux only into a binding whose process/transcript lineage is proven; otherwise expose
  recovery/quarantine rather than a duplicate or silently repointed chat;
- lose the tmux response after the server applies paste and after it applies Enter; never blindly
  retry, and classify the write from a pre-send durable attempt plus a correlated native transcript
  UUID/row rather than terminal-control receipt or text equality;
- collide a person's partial pane draft with remote paste/Enter and require a proved
  quiescent/exclusive input boundary or report simultaneous keyboard-plus-remote fidelity unsupported;
- race tmux capture before the injection call returns, local versus remote permission decisions, and a
  failed decision-file write; never mislabel origin, ACK failed persistence, or claim a native
  first-winner without a local answer seam and terminal observation;
- detach/restart tmux in keep-pane mode with hooks, decision state, transcript cursor, and orphan gates
  preserved, and prove outside disconnect does not kill the active TUI turn; then map `/clear` to a new
  logical chat and `/branch` to explicit fork lineage.

### Optional OpenCode safety matrix

This matrix is parked. It blocks only a future decision to advertise durable OpenCode; it does not
block Claude 1.0. If resumed, the [A1 OpenCode vertical slice](a1-opencode-vertical-slice.md), not the
former capability-snapshot/front-door evidence matrix, governs it:

- revalidate the actual current schema-v6 terminal root; any later activation supplements rather than
  bypasses it;
- bind either one exact existing session, or one write-ahead local creation whose lost response is
  reconciled from exact state; never retry an ambiguous create or adopt “most recent”;
- atomically bind a signed admitted result to one command-keyed execution and consume its
  start-before-native-byte fence at most once;
- write ahead the separate provider request and never resend after ambiguous connector delivery or
  response, including with the credentialless local connector;
- require strict session/history read-back and attribute assistant output only through exact
  `assistant.parentID`, with concurrent TUI turns proving that timing and adjacency are irrelevant;
- in one transaction consume the observation, write terminal completion or quarantine, and insert the
  matching output intent; then prove exact sealed-output self-recognition and broker reconciliation;
  and
- preserve connector-only credentials/egress, hostile-child isolation, health withdrawal, and all
  no-resend behavior before any optional advertisement.

The retained OpenCode native fixture and dormant E0/E1a/E1b1/E1b2 codecs remain implemented regression
and audit inputs. They create no runtime authority. Slash commands, steer, interrupt, permissions,
questions, attachments, remote session creation, and every mutation other than binding-scoped
`user_text` stay non-writable within this optional design.

### N1 signed-nesting release matrix

This gate belongs to live N1 and is not satisfied by A2's authenticated nested-source stand-in:

- For nested management and ordinary nested chat, crash at every result-first/secondary-signature/
  joint-finalization boundary and require no partial result, ACK, lineage, attempt, or effect.
  Substitute a same-ID management capability snapshot, `newChatCapabilityDigest`, request/receipt
  schema, proof ref/digest, lease/generation/state, or canonical snapshot digest. Exercise readiness
  `maxWaitMs` at zero, one, 120000, 120001, overflow, stale/current policy replacement, and
  deadline derivation. Then substitute a same-ID nested-edge capability snapshot or its
  family/proof/live-lease/topology/namespace digest, then substitute core, hop, wire, request schema,
  receipt-proof schema, source event, command payload, decision/executor evidence, signed result,
  target command/result ID, result version/predecessor, ready-attestation result signed-record digest,
  or readiness policy/deadline. The nested family capability must carry exactly one envelope-schema
  field, `targetRequestSchemaId`, and the distinct common `canonicalCommandPayloadSchemaId`; both
  participate in its family digest. Derive the attempt's `canonicalEnvelopeSchemaId` from
  `targetRequestSchemaId` and require exact equality. Reject any independent second family
  envelope-schema field, payload-schema substitution, transfer schema/ref/digest substitution, or
  attempt-level envelope-schema substitution before source normalization. The complete downstream
  receipt proof must verify as one chain; queued creation is invalid, ordinary queued chat is terminal
  for that event, exact replay is idempotent, and every fork quarantines without another send.

## How to run

```bash
# unit + integration (fast, network-free) — what CI runs
(cd packages/clawsec && pnpm test:run)
(cd packages/cli && pnpm test:run)
(cd apps/web && pnpm test:run)
pnpm test:install

# retained pinned native evidence — also runs in CI when its spike changes
pnpm --filter @remote-claw/codex-multiclient-proof test:run
pnpm --filter @remote-claw/claude-native-output-proof test:run
pnpm --filter @remote-claw/opencode-native-proof test:run

# app e2e in a real browser (Chromium + WebKit) — also runs in CI
pnpm --filter remote-claw-web-tests test:app          # primary durable per-channel SQLite matrix
pnpm --filter remote-claw-web-tests test:app:sqlite   # focused SQLite transcript config

# the real-claude proofs (needs a logged-in claude)
(cd apps/web && RC_PROVE_REAL_CLAUDE=1 pnpm exec vitest run test/prove)

# manual live cross-driver verify — a real LLM round-trip through the real viewer (any driver)
node tests/web/cross-mode-verify.mjs <base> <pass> <prompt> <needle> <shot.png> [label]

# mandatory installed/deployed topology/browser leg (values supplied out of band; never print secrets)
GITHUB_REPOSITORY=<owner/repository> \
GITHUB_TOKEN=<github-token> \
RC_DEPLOYMENT_ID=<github-deployment-id> \
VERCEL_TOKEN=<vercel-management-token> \
VERCEL_AUTOMATION_BYPASS_SECRET=<secret> \
RC_PROVE_CLAUDE_CWD=<trusted-existing-directory> \
./scripts/run-trusted-real-topology-clean.sh

# immediately after topology v4; mint a separate short-lived read-only group token first
RC_TOPOLOGY_RECEIPT_FILE=<absolute-private-browser-leg-v4-path> \
TURSO_API_TOKEN=<turso-platform-api-token> \
TURSO_GROUP_AUTH_TOKEN=<short-lived-read-only-group-token> \
VERCEL_TOKEN=<vercel-management-token> \
./scripts/run-trusted-final-inspection-clean.sh

# after equal-tree merge, exact-merge CI, and the newest Production deployment
GITHUB_REPOSITORY=<owner/repository> \
GITHUB_TOKEN=<github-token> \
RC_PRODUCTION_DEPLOYMENT_ID=<newest-github-production-deployment-id> \
RC_INSPECTION_RECEIPT_FILE=<absolute-private-inspection-v1-path> \
VERCEL_AUTOMATION_BYPASS_SECRET=<secret> \
VERCEL_TOKEN=<vercel-management-token> \
./scripts/verify-production-release-clean.sh
```

The executable static BusyBox entry from the repository root is mandatory; direct Node refuses. Its
`#!/bin/busybox ash` process self-attests `/proc/$$/exe` as resolved `/usr/bin/busybox`, root:root mode
`0755`, exactly 1,914,704 bytes, and SHA-256
`52151e7f322f926b64049cdaa1410dc3ea6485525e0624b05813791c219ae933`. It accepts no arguments and
NUL-pipes the six explicitly assigned inputs shown above plus inherited `HOME`—seven total—to a Node
process whose environment is exactly
`PATH=/usr/bin:/bin`, `LANG=C.UTF-8`, and `RC_PROOF_INPUT_FD=0`; no secret enters argv. The JavaScript
runner refuses npm/pnpm lifecycle execution. It, not the caller, resolves `WEB_E2E_URL`. Before Playwright it fetches only the
exact pinned origin's non-cacheable `/api/prove/deployment-attestation` response with the Vercel bypass,
forbids redirects, and requires its runtime `environment:"preview"` plus full `sha` to equal the clean
40-character HEAD. This prevents a mutable branch alias from satisfying metadata-only SHA checks;
missing Vercel system variables fail closed.

Using trusted `/usr/bin/git` and `/usr/bin/tar`, the runner archives that validated HEAD into private
scratch, extracts it, frozen-installs the complete workspace under isolated home/store state, and builds
and `npm pack`s only inside the archive. The resulting tarball is an owned regular `0400` file. Its
absolute path and SHA-256 cross the Playwright boundary; the spec rehashes before and after install and
never builds, packs, or imports the checkout. Scratch survives the browser leg and is exactly cleaned
afterward. The receipt's packed-tarball digest must equal the runner's proof coordinate.

The runner rejects an inherited `RC_CLAUDE_BIN`. It resolves the intended `/usr/bin/claude` launcher
symlink and requires its resolved target to be a root:root regular mode-`0755` Linux arm64 file with
exact version `2.1.237 (Claude Code)`, exactly 331,864,296 bytes, and
SHA-256 `a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177`. After launch it verifies the
descendant's resolved executable path, then boundedly requires the exact release-payload argument tail
before verifying size, hash, and release-clean environment through `/proc` before shutdown. This rejects
the same-inode `--version` compatibility probe without relaxing failures on the payload. The
production launcher itself holds the proved executable inode from compatibility probe through child
exit, so an atomic replacement of `/usr/bin/claude` cannot substitute different bytes.

Before Playwright the parent-only `VERCEL_TOKEN` performs bounded, redirect-forbidden Management API
reads for project `prj_qUeYYc7P87JmsQUipJG0m0kqmYbM` and team
`team_fYexi4KRmIrq9wtYsiXs9e9H`. They require enabled live config `waf_TG8xDULMuMuR` version 3 with no
draft, changes, or extra versions; exactly active and valid rule
`rule_handoff_per_ip_rate_limit_UWaS5F` (`handoff-per-ip-rate-limit`) matching the `/api/handoff` path
prefix, token bucket 20/60 keyed by IP, excess denied; and an empty firewall-bypass list. The Vercel API
does not expose platform System Mitigations, so the proof does not claim to attest them.

Playwright receives only its HOME/PATH/locale/XDG values, trusted cwd, the automation bypass, and
nonsecret proof coordinates. The wrapper receives a separate minimum including TERM, the bypass,
`RC_LOG=warn`, and the internally pinned Claude path. The browser process does not inherit the bypass.
GitHub/Vercel-management/Turso/cron credentials and ambient source environment are excluded from every
child. The private exact-schema topology/browser-leg receipt binds runtime/HEAD/deployment, installed
tarball digest, pinned Claude tuple plus `binaryBytes` and `executableSha256`, normalized
`edgeRateLimit`, runner-owned BEGIN/END log canaries and a proof window of at most 30 minutes,
monotonically measured 235–270 s `streamRotation`, browser reconnect/post-rotation same-`cse_*` turn,
Chromium result, and the nonsecret scan sentinel. The 780 s proof consumes two Claude inference
turns and must cross the deployed 240 s rotation boundary.
BusyBox bootstrap metadata is gate-attested and deliberately is not added to that durable receipt.

The deployed origin must have the complete four-variable Turso fleet configuration and make its
**deployment default** durable SQLite/Turso. Its non-cacheable runtime attestation and receipt bind the
exact `sqlite`/Turso organization, group, and canonical `pr-<7sha>` scope; any explicit
`RC_TURSO_DB_SCOPE` fails before Playwright, and final inspection must use those attested coordinates.
The proof supplies neither `--rc-backend` nor
`?backend=sqlite`; the stable host's `/api/seq` and `/api/frame-count` preflight must therefore prove the
real default. The runner performs no broker data-plane warm-up before launching the installed host, but
the topology receipt attests the exact Preview SHA/storage coordinates—not physical absence of its
SHA-scoped Turso index. Preview CI or an earlier manual request may already have warmed
that store. The deterministic never-settling/16.5-second first-index regressions own the hard cold-start
behavior; if an operationally cold live observation is required, use and preserve evidence for a
separately verified unused scope rather than inferring freshness from the receipt. The topology receipt
remains explicitly inspection-pending.

Immediately mint a separate short-lived read-only token for the attested Turso group and invoke only
`run-trusted-final-inspection-clean.sh`. The scanner cannot prove the supplied token's expiry or
authorization, so this is an operator requirement. Its wrapper accepts no argv; byte-pins BusyBox, Git,
and Node; and NUL-pipes exactly four private inputs into an exact clean Node environment. Before those
credentials reach Node, it requires the clean exact topology HEAD, materializes and byte-compares the
committed wrapper/runner/schema closure from candidate Git blobs, and executes that snapshot. Wrapper
and runner independently check the clean exact HEAD again after provider access. The runner validates
the locked `@libsql/client` 0.17.3 dependency closure by package bytes/counts, copies it into a private
snapshot, revalidates it after use, and removes it. Inspection may start at most 71 hours after the
topology proof window began, while that window may complete at most five minutes in the future. The
runner has a 10-minute overall wall plus 30-second operation walls. Turso inspection enumerates the
exact `rc-pr-<7sha>-` fleet before and after, binds physical `DbId`, uses read snapshots, and scans
`sqlite_schema`, `table_xinfo`, and every table value. An enumerated hostname must be exact legacy
`<database>-<organization>.turso.io` or have one extra DNS label that exactly equals its validated
`primaryRegion`; a malformed `primaryRegion`, a regional hostname without that exact matching label,
or any additional hostname label fails closed. Caps are 256 databases,
4,096 tables, 65,536 columns, 250,000 rows per table, 5,000,000 rows total, 100,000,000 values, and 4
GiB of value bytes.

Vercel inspection resolves the immutable Preview deployment, then queries the CLI-compatible historical
Runtime Log endpoint only for its exact deployment and proof window. It recursively bisects page zero
until each leaf returns `hasMoreRows:false`, with a one-millisecond overlap and request-row digest
deduplication. A saturated one-millisecond leaf, wrong-deployment/malformed/truncated row, missing
BEGIN/END canary, cap/deadline, or two non-identical settled snapshots fails. The log caps are 4,096
queries and 1,000,000 retained requests. `remote-claw-real-topology-inspection/v1` contains only
coordinates, hashes, bounded counts, times, and zero sentinel matches. Its claim covers every value in
the stable exact-prefix Preview fleet and queryable retained Runtime Logs for the immutable deployment
and window—not provider-internal, expired, or otherwise unqueryable telemetry. Its complete exact-schema
receipt is first written only as a private durable noncanonical stage by the credential-bearing runner.
The wrapper binds its SHA-256/device/inode/size, independently rechecks the exact candidate, and
materializes a fresh committed publisher closure. Only that exact credential-free publisher may
strict-validate the stage and publish the canonical mode-0600 artifact without overwrite after
complete-byte and parent-directory sync.

Both publishers prove the same three durability phases: exact random hash-bound source file plus
source-only parent sync; canonical/source hard-link pair plus parent sync and exact post-sync
same-inode/root revalidation; then source unlink, canonical-file sync, parent sync, and exact final
single-link revalidation. When canonical is absent or two-linked, recovery streams the pinned directory
and refuses on the 4,097th entry; exact single-link recovery bypasses enumeration and directly syncs and
revalidates canonical. Tests cover torn random sources, deterministic selection among multiple exact
same-stage orphans, source-only sync failure, ambiguous link results, pair-sync failure, post-sync
path/inode substitution, unlink and
final-sync failure, visible-root replacement, exact one-link/two-link fresh recovery, stale-stage
isolation, and mismatched/conflicting evidence preservation. The wrapper retries once in a fresh process
after typed exit 75 or a signal-killed publisher and latches any failed retry back to 75. Once
publication has started, an outcome still unresolved after that retry—or an outer-wrapper signal while
the publisher outcome remains unresolved—preserves the bound stage. Once publisher success is observed,
cleanup may remove the stage; a later outer-wrapper signal still reports no success and leaves committed
canonical evidence. A normal later invocation refuses any preserved stage rather than replacing it.
Whole-wrapper-death auto-recovery is outside the release claim without an external caller-held
provenance ticket; the observable outcome is fail-stop and indeterminate to the caller. An irreversible
canonical inode may already exist, but the interrupted wrapper does not report success.

After that exact candidate merges without changing its Git tree and exact-merge CI passes, invoke only
`verify-production-release-clean.sh`. Its wrapper accepts no argv and independently byte-pins BusyBox,
Git, and Node. It derives the inspected candidate from the canonical private receipt filename, requires
a clean merged HEAD with that candidate as ancestor and an equal tree, and materializes and byte-compares
the committed wrapper/verifier/schema blobs before NUL-piping exactly the six inputs shown above. It
rechecks the repository after the verifier exits. The credential-bearing verifier writes only a private
durable noncanonical stage. The wrapper binds its SHA-256/device/inode/size, rechecks the exact initial
merged HEAD/tree, and materializes a fresh committed publisher closure; only that exact credential-free
publisher may strict-validate/recheck the stage and atomically/durably/exclusively publish the canonical
Production receipt.
The verifier reads the private inspection receipt safely and checks its `completedAt` both initially and
immediately before staging: it may be at most 71 hours old or five minutes in the future. Raw local Git
rejects replacement refs and graft metadata, requires a clean merge HEAD, proves candidate ancestry,
and requires equal candidate/merge tree objects.
GitHub independently requires its compare result to prove that ancestry and both commit-tree objects to
match the local trees. The supplied numeric Production deployment must be first/newest in the filtered
Production enumeration, successful, created by `vercel[bot]`, and exact merge HEAD; it and
`refs/heads/main` are rechecked before receipt creation. The immutable Vercel deployment must be owned
by the pinned team/project, READY, target Production, and exact `main`. Its no-store runtime attestation
must bind the merge SHA,
`sqlite`/Turso/`prod`, and the same organization and group inspected in Preview.

Production verification also re-reads the exact enabled live active Firewall configuration and requires
its owner/team to be pinned, update time to be canonical, project key to be the pinned project ID plus
`#active`, active `ips`/`changes` to be empty, and the exact
managed-rule matrix to be `gen`/`rce`/`sqli`/`xss` active/log plus
`java`/`lfi`/`ma`/`php`/`rfi`/`sd`/`sf` inactive/log. Its sole custom rule must be the valid
`/api/handoff` token bucket, draft/version state must be unambiguous, and the separate **Firewall**
bypass list must be empty. Independently, an
immutable-origin request without the automation bypass must return the exact Vercel Deployment
Protection response. For either accepted 401 or 302 shape, its Secure+HttpOnly `_vercel_sso_nonce`
cookie must contain exactly 48 lowercase hex characters, and the 64-lowercase-hex SSO callback nonce
must equal SHA-256 of that cookie nonce's ASCII bytes. The automation bypass is sent only to that
origin's application requests—the runtime attestation and the data-plane frame-count/relay calls—and
never to GitHub or Vercel Management APIs. With no backend selector, a random fresh session must first return `{durable:true,frameCount:null}`;
`POST /api/relay` must return `created:true`, a session channel, and its physical
`rc-prod-s-<16 hex>` Turso database ID; and the final frame count must be one. The content-free
data-plane evidence retains only that `databaseId`, the frame digest, counts, merge SHA, and
durable/protected facts—not the random challenge, bearer, or frame bytes.

The terminal `remote-claw-production-release-attestation/v1` binds the inspection file hash, local and
GitHub tree coordinates, deployment/runtime, normalized WAF result, and data-plane evidence. Its
canonical complete mode-0600 bytes cannot appear before the wrapper's outer Git recheck; publication is
performed only by a fresh committed credential-free publisher, is exclusive and atomic, and includes
complete-byte and parent-directory sync. Exact-merge Actions CI remains
separate release-record evidence and is not queried by the verifier; the real Claude/browser turn is
not rerun on Production.

Do not copy request bodies, bearers, passes, tokens, model content, or the sentinel itself into either
content-free downstream receipt. Any sentinel match or incomplete/untrusted coordinate fails the proof.
