# remote-claw — test plan

What we verify, how, and where. The current system is a zero-knowledge, E2E-encrypted relay with
Claude, OpenCode, and tmux compatibility paths; the selected host runtime also targets Codex and
official-client collaborators. The test strategy mirrors those trust boundaries and labels retained
native evidence separately from future release gates.

## Strategy — the pyramid

| Layer | Where | What it proves | Runtime |
| --- | --- | --- | --- |
| **Unit (crypto core)** | `packages/clawsec/src/*.test.ts` | HKDF hierarchy, AEAD per-message keys, the §8 wire envelope, channel tokens, the pass, chunking, the shared canonical field writer with strict-null optionals and defensive snapshots, the locked A0 AAD regression vector, A1.5's pure v2 wire/KDF/frame/digest/certificate/onboarding contracts, A1.6's exact selected capability/route/store/generation/manifest/retry/collision/read-page contracts, A1.7a's bounded ingress identifiers/digests/cursors plus strict `user`/`new_chat` payload codecs, A1.7b1's exact common payload/source/command/decision/result/signing bytes and deterministic IDs, A1.8a0's exact rejected action/chat payload bytes, stored-result/delivery digests, stable identity, and completion-observation selection, and authority-free exact `accepted` projection/admitted chat-creation byte vectors for later A1.8a — pure functions, no network | Node + WebCrypto |
| **Unit (CLI seam + transport)** | `packages/cli/src/**/*.test.ts` | SecurityProvider (Open/Sealed, downgrade floor), A0 BrokerClient (HTTP/SSE), viewer-side FrameOrderer (dedup/reorder), HostRelay (fake backend), ClaudeStreamSession env passthrough, A1.0 contracts, the A1.1 secure-filesystem/SQLite/protected-artifact kernel, A1.2 server/project repository, A1.3 runtime-owner/key-custody/daemon/RPC, A1.4 schema-v5 evidence/registration/reconciliation/duplex-port/trusted-adapter boundaries, A1.5 schema-v6 terminal-root repository/service boundaries, A1.6's negotiation-first client plus schema-v7 capability-pin/route/genesis repository and host-only installer, A1.7a's schema-v8 evidence-preserving ingress repository/dormant actor through `awaiting_order`, A1.7b0's schema-v9 wrapped server-key custody/self-anchor/fenced leases, A1.7b1's schema-v10 ready/order/rejected-decision/replaceable-preparation/signing boundary, A1.8a0's schema-v11 rejected-only atomic finalization and secure-reopen closure, and E0/E1a/E1b1's pure IDs/parents/executable manifests plus direct-only Linux stable-FD collector | Node, mock fetch / fixture + real temporary SQLite |
| **Unit/integration (A1 broker)** | `apps/web/test/{api/a1-routes,broker/a1-sqlite}.test.ts` | Strict bearer/selector/capability admission, route recomputation, A1-only catalog/store provisioning and loss, bounded canonical relay/read, route-wide exact retry and first collision, rollover/manifests, quota/counter exhaustion, pagination, and isolation from A0 retention | Node + mock/local SQLite/libSQL |
| **Retained native proof (Codex)** | `spikes/codex-multiclient/verify-*.mjs` | pinned probe/binary hashes, one real app-server, raw and real-TUI coexistence, top-level multi-chat subscription evidence, model/network isolation, native deletion, and cleanup | Node over checked JSON evidence; no provider/model |
| **Retained native proof (OpenCode)** | [`spikes/opencode-native/verify-evidence.mjs`](opencode-native-proof.md) and `verify-executable-manifest.mjs` | pinned binary/schema evidence, exact session-marker correlation, caller message-ID read-back, same-ID `noReply:true` append behavior within one incarnation, and an independently rebuilt 150-chunk native executable manifest; raw executable/chunk bytes are not retained | Node over checked JSON evidence; no provider/model |
| **Integration (broker)** | `apps/web/test/*.integration.test.ts` | the **real** broker routes on the **real** Workflow runtime (`@workflow/vitest`): admission, routing, bus/session isolation, SSE, the full encrypted turn, control plane, the browser Viewer | in-process Vercel Workflows |
| **App e2e (real browser)** | `tests/web/app-e2e/*.spec.ts` (Playwright) | a real **Chromium** drives the BUILT viewer against a real Next server + broker — the full RC turn, the one-time-handoff pairing, the three drivers' capability profiles (mitm/tmux/opencode, via capability presets — not real tmux/opencode hosts), and the bus-unreachable banner; **WebKit** runs the iOS-Safari foreground-revive spec; the RC turn re-runs on the per-channel SQLite backend | Playwright (Chromium + WebKit), built prod server |
| **Proof (real claude)** | `apps/web/test/prove/*.prove.test.ts` (gated `RC_PROVE_REAL_CLAUDE=1`) | a **real, logged-in `claude`** driven end-to-end through the encrypted broker — single turn and stateful multi-turn | spawns real `claude`, network |
| **Exploratory** | manual real-`claude` runs (`tests/web/cross-mode-verify.mjs`) | a LIVE session driven through the real viewer for any bridged driver: type a prompt, assert a real assistant reply (real LLM round-trip) carrying a needle, screenshot | real, on demand |

CI keeps the unit + integration layers fast and network-free, verifies retained native evidence when
its spike or verifier changes, and on every PR that touches the
web/CLI/crypto paths also runs the **app-e2e** layer (Chromium + WebKit; the RC turn re-runs on
per-channel SQLite) plus the encryption-stress suites (`.github/workflows/web-e2e.yml`, path-filtered);
the real-claude proofs are env-gated so they never gate CI but are run on demand. Every PR must pass
the relevant path-filtered checks plus the repository's `biome`, `tsc`, and `vitest` gate before merge.

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
10. Bus carries only `session_announce` — ✅ `broker.integration.test.ts`
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
23. Web client in a real browser — ✅ `tests/web/app-e2e/*.spec.ts` (RC turn, pairing, the 3 driver capability profiles, iOS revive, bus-unreachable banner) + 🔬 screenshots

**Advanced**

24. Interactive multi-turn — ✅/🔬 `prove/real-session.prove.test.ts` + browser
25. Tool-use permission grant — ✅ `e2e/rc-spine.integration.test.ts` (a worker `can_use_tool` surfaces to the viewer, which grants it back to the worker) + ✅ `tests/web/app-e2e/transcript.spec.ts` (a granted permission survives a reload; an AskUserQuestion answer submits) + 🔬 real `claude` tool run
26. Sub-agents (Task tool) — ✅ `e2e/rc-spine.integration.test.ts` (a Task `tool_use` + sub-agent output relay through as `tool_use` + `assistant_sub` frames) + ✅ `tests/web/app-e2e/transcript.spec.ts` (sub-agent Task nesting renders in a real browser) + 🔬 real `claude` sub-agent run

## Known gaps / honest limits

- **Scenarios 25–26** are automated end-to-end: a viewer `permission` frame maps back to the worker's
  RC control-response (`HostRcRelay` → `session.pushControlResponse`), and a Task spawn relays its
  sub-agent frames — both covered by `e2e/rc-spine.integration.test.ts` and rendered in a real browser by
  `tests/web/app-e2e/transcript.spec.ts`. What stays exploratory (🔬) is a *real* logged-in `claude`
  driving a tool/sub-agent turn through that path — gated, like the real-claude scenarios 20–21.
- The **native `--remote-control` HTTPS MITM** path (a real `claude --remote-control` through `MitmProxy`
  + `HostRcRelay`, with a viewer turn round-tripping the real model's reply) has a gated proof —
  `prove/real-rc.prove.test.ts` (`RC_PROVE_REAL_CLAUDE=1`); env-gated so it never gates CI but runs on
  demand.
- Negative-`startIndex` exact last-N semantics are real-Vercel-verified (spike §14A); the in-process
  harness only guarantees an in-order suffix incl. the latest — asserted accordingly.

## Selected host-runtime recovery gates

These are design gates for [Client-driven Host Runtime](client-driven-host-runtime.md), not claims
about the current A0 implementation:

### Milestone status and proof ownership

| Milestone | Current status | Required proof before its advertised capability |
| --- | --- | --- |
| A0.1 | Implemented | Neutral registrar lifecycle, multi-session isolation, ready-before-bridge, and exact-replay/first-bind tests |
| A0.2 | Implemented (process-local) | OpenCode and tmux driver tests for post-setup capabilities, cancellation and bounded teardown, no pre-ready broker client/announcement/remote mutation, and no ghost registration after setup or spawn failure; tmux additionally proves mandatory native readiness, private socket/runtime and owner-only launch artifacts, prompt/environment/settings absence from tmux argv and public errors, concurrent wrapper isolation, failed permission-decision persistence withholding ACK, and runtime retention when pane termination is uncertain |
| A1.0 | Implemented contract foundation | Exact canonical primitive, ID namespace, path-resolution, record-shape, digest, fence, protected-operation, dispatch/reconciliation-separation, and backend-capability unit tests; no direct effect or A1 capability is advertised |
| A1.1 | Implemented storage kernel | Linux descriptor-anchored secure create/open/reopen, read-only WAL-aware validation before writable SQLite open, exact schema-v2 migration/digest/manifest validation, FULL migration commits with non-blocking passive checkpoint and guardian fsync, typed commit and guardian-retaining cleanup outcomes, synchronous high-level transactions with generic multiwrite rollback, and immutable protected artifacts with verified scope, schema, reference, digest, and stored length; A1.3 now opens it, while no native effect or A1 broker capability is advertised |
| A1.2 | Implemented host repository; operations inactive | Exact schema-v3 migration/manifest; default profile/server; atomic first project/mapping/chat/binding/intent/`rcie_*` edge; explicit later projects; terminal mapping-generation replacement; many-chat inventory; coordinator lease CAS, renewal, release, takeover and reconciliation; contiguous immutable journal; full semantic read-only snapshot validation; no live registration, command actor, native effect, or nested target/edge is advertised |
| A1.3 | Implemented; production health only | Exact schema-v4 migration/manifest and full runtime-owner semantic graph; `rcrt_*` vector; service lease fencing/takeover/reconciliation; runtime/incarnation/assignment/containment and local-conversation registry; wrapped Ed25519 custody/signing discipline; binding/attachment/gate foundations; authenticated bounded RPC; daemon/bootstrap and failure cleanup; multi-runtime isolation; wrapped-driver connect/autostart/detach boundary; health reports `ownerOperationsWritable:false` and `nativeRegistrationEnabled:false`, with no installed production dispatch operation, durable owner registration, A1 binding activation, remote mutation, or broker capability |
| A1.4 | Implemented closed trusted-adapter seam; ordinary CLI has it disabled | Exact schema-v5 migration and 269-object manifest; five canonical evidence schemas; sequenced process leases/publications/operations; replay/collision and request-bound reconciliation; lifecycle/publication closure plus validator-enforced no-extra-row closure; duplex bounded callable ports; `liveReattach` admission; stale-open crash takeover and fresh-fenced same-binding process/port reattach with authority-change transport rotation; explicit-adapter production activation while ordinary health remains `ownerOperationsWritable:false` and `nativeRegistrationEnabled:false` |
| A1.5 | Implemented dormant foundation; ordinary CLI has it disabled | Pure browser-safe A1 v2 route/token/KDF/frame/digest, certificate, and onboarding codecs; exact schema-v6 304-object terminal-root ledger; activation/renewal replay, collision, fencing, expired-preparation refusal, rollback, lost-commit reconciliation, semantic reopen, lifecycle demotion, and re-ready renewal; closed v6 signature reservation, protected signing, fresh callable-port proof, and transaction-local store/accept/finalization through the opt-in trusted-adapter operation; no real driver or broker integration |
| A1.6 | Implemented dormant foundation; ordinary CLI/drivers/viewer make zero A1 calls | Exact capability negotiation; selected SQLite/libSQL route provisioning; auth/route/store binding; raw and decoded bounds; retained route-wide exact retry/collision/manifests; automatic rollover and bounded one-generation pagination; outcome-unknown client behavior; exact 22-statement schema-v7/326-object capability-pin/route/pristine-genesis install and split-commit recovery; no ingress cursor, actor, native effect, checkpoint/signing, inference, or projection claim |
| A1.7a | Implemented dormant foundation; absent from production barrels/run paths | Schema-v8 route backfill/auto-seeding, exact retained page/frame/raw/plaintext evidence, independent fetch/semantic cursors, current-fenced actor takeover, multipart/exact-retry/collision/tombstone/recovery, quotas/lookahead, secure reopen, and durable `awaiting_order`; no command/order, signed result, server-scope signer, outbox/effect, native dispatch, or live A1 claim |
| A1.7b0 | Implemented dormant prerequisite; no production wiring | Schema-v9 migration `009-server-scope-signer`; initial self-anchor, AES-GCM-wrapped server Ed25519 custody without raw-key export, coordinator-fenced bootstrap/current leases, immutable signer sequences and payload bindings, dense per-server `acceptedAtJournalSeq` signed-record acceptance, non-closed-bootstrap `stale_bootstrap_fence` fail-stop versus installed-lease supersession/next-token takeover, exact replay/collision/reconciliation, semantic reopen, and compatibility admission of dormant route installation for an exact signer-activated current server; no command/result, generic host output, broker publish, outbox/effect, native dispatch, or projection claim |
| A1.7b1 | Implemented dormant foundation; no production wiring or independent capability claim | Schema-v10 `010-common-command-adjudication`, exact five-table/619-object boundary, shared ready/control journal closure, A1-ingress-only route-head admission, deterministic source/command/result/group/preparation identities, small `unsupported_recognized` persistence, global order, rejected-only decision, distinct creation/decision fences, signer binding/store, abort/reprepare generations, crash reconciliation, semantic reopen, and a hard signed-but-unaccepted terminal boundary |
| A1.8a0 | Implemented dormant rejected-only closure; no production wiring or capability claim | Schema-v11 `011-a1-rejected-result-finalization`, exact three-table/647-object boundary, one-transaction common result + dense signer acceptance + `decided`/`terminal` overlay + exact semantic artifact + inert `pending_seal` intent, immutable base ingress evidence, no cursor movement or post-sign route-health dependency, narrow safe predecessor-signature takeover with strictly later successor-lease acquisition, crash reconciliation, and semantic reopen |
| A1.8a1-E0 | Implemented pure identity contract; no authority state or capability | Six E-side canonical namespaces/types/parsers; four deterministic attestation/snapshot ID derivations; locked vectors, exact-preimage sensitivity, hostile shape/namespace/integer rejection, and a code boundary with no evidence digest/artifact codec, schema, repository, signer, pointer, port, owner operation, runtime wiring, or production capability |
| A1.8a1-E1a | Implemented pure ref-free parent contract; no authority state or capability | Four strict 64 KiB parent codecs; fixed schema-first byte order and ordered role/schema/digest/length commitments; closed role/schema/bound/scope registry; derived-ID checks; exact byte/digest vectors; allocation-safe raw hashing through 16 MiB; rejection of refs, hostile bytes/shapes, reordered roles, wrong schemas, and oversized children; no child semantic parser, collector, artifact write, schema, repository, signer, pointer, port, owner operation, runtime wiring, or capability |
| A1.8a1-E1b1 | Implemented executable-content manifests/collector; direct-only and non-authoritative | Both strict role-correlated codecs; 1 MiB chunks, 256 MiB source and 64 KiB manifest bounds; two stable complete reads of one Linux FD; raw/chunk digest equality, metadata/EOF, success-close, and deterministic post-first-read abort-close gates; schema-transplant rejection; generic front-door temporary-file coverage; retained real OpenCode 1.17.5 native vector independently rebuilt offline; no retained actual front-door provenance or path/process/currentness/full-parent/authority proof |
| A1.8a1-E1b2 | Design frozen; implementation planned | Four strict u64-safe leaf codecs in a mount-namespace → canonical-directory → filesystem-identity → allowed-root-ancestry digest DAG; synchronous independent no-follow allowed-root/target walks; two fact sweeps and fresh full rewalks; same-mount suffix policy; exact E1a workspace-parent reconstruction; historical-only, direct-only, and no authority |
| A1.8a1-E1b3 | Planned front-door/listener evidence | Actual front-door executable collection plus build closure, generated surface, build-route registry, measured dispatch, and listener-parent closure |
| A1.8a1-E1b4 | Planned runtime-isolation evidence | Every registered process/socket/policy/peer/network/mount-namespace child and isolation-parent closure |
| A1.8a1-E1b5 | Planned capability/full-parent evidence | Every remaining capability child plus exact recreation of all four E1a parent commitments; reserved schema names or synthetic commitments are insufficient |
| A1.8a1-E1c | Planned stateful accepted evidence after E1b5 | Exhaustive legacy E-purpose quarantine/nonadoption; new-lineage-only workspace changes; dependency-ordered listener/isolation/capability acceptance; exact unsigned-snapshot/accepted-inert staging; immutable artifact links and dense transition receipts; request-bound reconciliation and semantic reopen; nonterminal E-owned rotation barrier; both transport pointers byte-identical |
| A1.8a1-I | Planned after E1c | One-transaction null/null-or-matched snapshot/credentialless-ingress pair install and replacement; live callable-port proof; pair-only withdrawal with A1.4-owned physical-port teardown; parent close/detach/reattach/takeover closure; exact unknown-commit reconciliation and absent-generation reuse; hostile-SQL closure; no admitted command, dispatch, effect, native call, or advertised capability |
| A1.8a2 | Planned after I | Add an admitted command's pinned native attempt/front-door dispatch/protected effect arm atomically without widening the rejected-only finalizer or exposing a partial path |
| A1.8b | Planned after full A1.8a | Seal/publish causal result delivery, then one-time dispatch, protected authorization consumption, uncertainty quarantine, native read-back, and evidence-only recovery without replaying a possibly started effect |
| A1.9 | Planned after the protected-handle and dispatch foundations | Runtime-scoped inference identity, encrypted exact request/response retention, connector leases, and ambiguous-upstream no-silent-retry proof |
| A1.10 | Planned after A1.5–A1.8b | Viewer trust-store onboarding, certificate status policy, scoped discovery, result redelivery, broker catch-up, projection rebuild, and no duplicate optimistic row |
| A1.11 | Planned final A1 gate | Kill/restart at every commit/send boundary, stale-coordinator takeover, broker rollover, projection rebuild, and proof that local TUI use survives remote-collaboration outage |
| A2.1–A2.4 | Planned after A1 | Retained real OpenCode TUI/front-door/isolation fixture and the signed `{new_chat}`/`{user_text}` adjudication matrix; unavailable connector kinds use authenticated stand-ins only |
| N1.1–N1.3 | Planned after A1 | Two live nested servers, rooted edge installation, complete signed downstream receipt, reconnect/reparent recovery, and cycle/reflection/duplicate-execution rejection |
| B.1–B.5 | Planned after A1 | Pinned Claude differential fixtures, durable private RC recovery, native correlation/gate races, and live outward Anthropic Remote parity |
| C.1–C.5 | Planned after A1 | Pinned Codex direct-versus-front-door fixtures, one bridge/subscription model, and live paired ChatGPT Remote mapping/reconnect parity |
| D.1–D.4 | Planned after A1 | Durable pane/injection ambiguity, transcript correlation, gate/handoff, clear/branch identity, and unified discovery presentation |

Every numbered slice is a separate reviewed PR. A schema-only or stand-in proof may land with the
capability disabled; it cannot satisfy a later live-connector gate. In A2, references below to an
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
argv/environment, owner-acquisition unknown-commit reconciliation, and health-only
activation on exactly wrapped `--rc-app` MITM/OpenCode/tmux paths. Plain and help paths, trace mode,
and the local `--rc-identity` action do not start the owner; unavailable/auth/start failure preserves
the exact A0 path; wrapper exit closes only its owner RPC collaborator without replacing A0 native
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
installed only when an explicit `registrationAdapter` is supplied. The ordinary CLI supplies none, so
its operation registry is empty, its authenticated RPC surface is health-only, and health reports
`ownerOperationsWritable:false` and `nativeRegistrationEnabled:false`; these tests do not claim a
real-driver A1 registration, terminal root, inference connector, or remote A1 mutation.

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
also prohibit A1.8 command, signature, result-delivery, outbox, effect, dispatch, viewer, and native
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
A1.8a1-E1c/I must first establish the dormant native-binding authority foundation after E1b5; A1.8a2 still needs
the admitted attempt/front-door-dispatch/effect atomic arm, and A1.8b still needs sealing/publishing
and one-time delivery before any capability can be advertised.

A1.8a1-E0's passed gate is intentionally identity-only. It locks the canonical
namespace/type/parser contract for `nwb_*`, `nlra_*`, `nria_*`, `nbcs_*`, `ncsa_*`, and `nbao_*`;
fixed success vectors, domain separation, and exact-preimage sensitivity for
`nativeListenerRegistrationAttestationId`, `nativeRuntimeIsolationAttestationId`,
`nativeBindingCapabilitySnapshotId`, and `nativeCapabilitySnapshotAttestationId`; rejection of
missing, extra, accessor, cross-namespace, wrong-prefix, wrong-length, padded/noncanonical-base64url,
zero, negative, fractional, and unsafe inputs; and the selected random-versus-derived allocation
metadata. The code/diff boundary contains only pure ID contracts, tests, and their host-state barrel
export: no evidence digest or artifact codec, SQLite schema/migration, repository, signer/custody
mutation, key-rotation barrier, transport-pointer write, callable-port access, runtime-owner
operation, protocol packet, runtime wiring, or production capability landed. E0 therefore supplies
identity vocabulary, not accepted evidence or authority.

A1.8a1-E1a's passed gate locks all four strict parent parsers/writers/decoders, schema-first canonical
order, fixed child roles, role/schema/digest/length sensitivity, 64 KiB parent and per-role child
bounds, fatal UTF-8/truncation/trailing/presence/integer rejection, derived-ID cross-checks, exact
round-trip vectors, and allocation-safe raw artifact hashing through 16 MiB. It proves refs are absent
from every commitment and byte vector and that no child semantic parser, collector, artifact write,
schema, repository, signer, pointer, port, owner operation, runtime wiring, or capability landed.

A1.8a1-E1b1's passed gate covers both strict role-correlated executable-manifest codecs; all chunk,
source, count, and manifest bounds; exact canonical round trips and digest sensitivity;
role/schema-transplant rejection; two complete same-descriptor reads with pre/middle/post metadata and
EOF stability; equal raw and ordered chunk digests; descriptor close after success and cooperative
post-first-read cancellation; generic front-door temporary-file collection; and an independently
rebuilt retained 150-chunk native OpenCode vector. No retained actual front-door provenance exists.
The direct-only collector and its nominal result type do not prove runtime authenticity, pathname,
process, front door, currentness, complete parent, authority, or production wiring.

E1b2's frozen gate requires strict exact-shape/canonical leaf codecs and locked vectors; full-u64
zero/max/noncanonical rejection; every-field and cross-leaf digest sensitivity; the complete Unicode
POSIX path grammar and exact component-prefix containment; independent allowed-root/target descriptor
chains, two stable fact sweeps, fresh full chained rewalks, every-position symlink/non-directory/race
rejection, same-mount suffix enforcement, bounded exact fdinfo/boot/namespace checks, exhaustive FD
cleanup and error precedence, live Linux collection, exact E1a workspace-parent recreation, no
promise-fs observation, no filesystem call after the synchronous observation, no misleading
mid-call `AbortSignal` surface, and no production importer. It remains historical evidence rather than
current authority. E1b3 must prove actual front-door/listener evidence, E1b4 isolation evidence, and
E1b5 capability evidence plus recreation of all four E1a parents. E1c
may pin a future migration only after E1b5's byte set settles. E1c's gate must verify the
three exact runtime-owner signatures and
acceptances in listener → isolation → capability order; race two attachments at the same
runtime/incarnation/key generation and prove only one singleton listener/isolation reservation is
allocated while the other joins its exact accepted tuple; reject phase skips, orphan prefixes,
signed-but-unaccepted abandonment, generic signer mutation, in-lineage workspace replacement, key
rotation while an E-owned phase is nonterminal, and every cross-server/chat/workspace/runtime/
incarnation/attachment transplant; prove exhaustive immutable quarantine/nonadoption of every
pre-E1c E-purpose signer row; verify `capability_prepared` has only the unsigned snapshot artifact and
reservation while `accepted_inert` atomically co-lands normalized snapshot/attestation/acceptance;
prove ref-free caller requests and parent/recipe coordinates, repository-local immutable artifact links, dense transition receipts,
exact landed/absent/retry reconciliation, and semantic-reopen no-extra-row closure; and prove that
accepted evidence leaves both transport pointers byte-identical after every success and fault. I's later gate
must reject owner/coordinator/channel fence transplants, prove the pointer XOR state impossible,
exact pair CAS/replacement/withdrawal, stale or missing live-port refusal, process-loss
non-writability, and parent close/detach/reattach/takeover closure. Race a late predecessor withdrawal
against successor install and prove it neither clears the successor pair nor unregisters the shared
A1.4 port. Prove exact landed/absent/changed-byte unknown-commit outcomes, including that a landed
aborted preparation burns its generations while a proved-absent preparation consumes none and may
reuse the still-next derived ingress ID. Require semantic-reopen no-extra-row closure and absence of
admitted/result/attempt/dispatch/effect/native-call or production-operation surfaces. A synthetic callable-port fixture cannot satisfy the retained live
OpenCode proof; it only closes the dormant authority metadata. The canonical matrix is
[in the technical reference](client-driven-host-runtime-reference.md#41-a18a1-native-binding-authority-freeze-planned-dormant).

### One-host/many-session acceptance matrix

This is an integrated release gate across A1, A2, B, and C, not a claim that one early slice proves every native product:

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
  native attempt, front-door dispatch, and effect gate as one unit; this is an A1.8 proof, not an A1.1
  protected-artifact-kernel claim;
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
  in the later A1.10 retention gate, compact only a checkpointed discovery scope-bus frame body after recovery leases pass, then retry
  the old attempt/part unchanged and changed; require the retained route-wide tombstone to return the
  original cursor or a collision, never a new position. Attempt chat- or server-control-body
  compaction and require rejection because cold semantic/result recovery retains those routes from
  genesis;
- interleave announcements for chats A and B on one scope bus across rollover and require one
  route-wide bus cursor/manifest sequence, distinct from both chat routes; inject a malformed bus
  position and require only the bus actor to quarantine while both chat actors continue, then clear it
  only through explicit bus-position recovery;
- interleave live web and authenticated official-client, automation, and nested-server stand-ins for
  `new_chat` through the one server-wide common command sequencer; require each proven-new event to
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
- exercise the server-control route from generation-zero genesis with null chat, its distinct address,
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
  machine reset, and require all three to fail because selected A1 has no broker-enforced route
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
- restart OpenCode only into a binding whose server/session lineage is proven, subscribe before
  snapshot, and preserve exactly one remote-claw bridge into the native session; otherwise expose
  recovery/quarantine rather than a duplicate or silently repointed chat;
- under one constant `identity_id`, create server A/chat X bound to `ses_A` and server B/chat X bound
  to `ses_B`; deliberately reuse the same source-local semantic `msg_id` but require distinct web
  namespaces derived from the two server scopes, then require independent
  adapter leases, ingress/result/native-attempt rows, projection sequences, machine-aware
  cache/channels, restart recovery, and OpenCode-native adjudication with no cross-binding lookup,
  delivery, observation, or result. Transplant server A's namespace/frame onto server B and reject it
  before adjudication;
- fail closed on discovery error and never adopt “most recent”; separately test exact existing-binding
  reattach, missing/wrong-lineage binding quarantine, exact first import of a TUI-created session,
  explicit first-bootstrap intent plus positive-empty snapshot, and explicit **New chat** while other
  sessions exist. Race first-bootstrap against direct-TUI create/import/switch/clear/fork/archive/
  unarchive under the one workspace transition barrier and require at most one first session; explicit
  later creates remain allowed. Crash with the bootstrap claim and dispatch still `not_started` and
  require recovery to resume only the exact original reservation/authorization. Exercise explicit
  pre-send abandonment and require one atomic `reserved → quarantined`,
  `claimed → inapplicable` transition while the dispatch/gate remain never-started; reject a
  `claimed → available` transition, a successor reservation, and any use of the abandoned
  authorization. Require the last pre-byte CAS to make `claimed → consumed`, which is irreversible.
  Reject any unclassified TUI operation that can change top-level
  identity, active selection, or discovery availability before it reaches the private listener;
- lose each `POST /session` response and reconcile the exact write-ahead marker plus expected typed
  creation-intent digest through the retained canonical two-field metadata ref/digest. Enumerate all
  same-marker candidates before intent filtering: zero remains uncertain; exactly one binds only when
  its intent equals the reservation and its canonical metadata recomputes; wrong-intent,
  noncanonical/extra metadata, and multiple matches quarantine. Require the reconciliation record to
  retain both expected values, and test their durability across server restart. A stale, incomplete,
  gap, or non-linearly-proved successor discovery snapshot cannot reconcile or bind, while the same
  marker on distinct session IDs must remain visible for `quarantine_many`; a marker-only match never
  binds. For a different native incarnation, require the original snapshot's pre-dispatch signed
  open/read store coordinate plus a typed predecessor-stop/fence and exclusive-successor-open
  no-reset/no-fork handoff. Clone the store, copy its embedded identity, leave the predecessor handle
  open, add a parallel writer, reset/fork the continuity registry, and omit or alter each proof field;
  every case must become `cross_incarnation_unproved`/`lineage_unproved` with no bind;
- establish and actively drain the SSE overlap before snapshot; inject slow history, high event rate,
  stream drop, bounded-buffer overflow, snapshot failure, and pre-merge crash, each becoming an
  explicit non-writable gap rather than silent loss. Delay a pre-snapshot event in transport until
  after the apparent drain and require a proved sequence watermark, same-stream barrier event, or
  atomic-store boundary before `complete`; legacy no-cursor SSE alone stays a gap;
- prove exact caller `msg_*` history/SSE read-back and the retained `noReply:true`, one-incarnation
  same-ID append behavior; gate model-bearing, concurrent, TUI, and restart variants separately, and
  forbid automatic retry after a lost `prompt_async` response;
- run an OpenCode A2 vertical slice through the common A1 ingress actor across
  decision/outbox/native-attempt crashes, broker rollover, and exact A1-input replay through a fresh
  broker delivery while native recovery retains the one original `NativeDeliveryAttemptRecord`; a
  crash before `delivery.started` must eventually permit exactly one `prompt_async`, while every crash
  after `delivery.started` permits at most one send and must produce either exact caller-`msg_*`
  read-back of one native user message with the expected part cardinality/fingerprints or
  `outcome_unknown` plus binding quarantine; stored-result replay must add no native send, and
  extra/mismatched native parts are a native collision/gap rather than one accepted attempt;
- explicitly abandon terminal `user_text` before dispatch and require one atomic quarantine of the
  original native attempt, dispatch, and command gate with one exact abandonment schema/ref/digest
  triple, no start/receipt/read-back, no native send, and no terminal replacement or continuation.
  Race dispatch in both orders, crash on both sides, replay exactly, corrupt every precondition, and
  require all-or-nothing state without downgrade. With no committed record, restart must resume only
  the same attempt; process exit alone never implies abandonment. Require null terminal
  `positiveNeverStartedSchemaId`, reject this local record as nested continuation evidence, and prove
  the otherwise-current binding can still admit a distinct authenticated source event;
- interleave web, official-client, automation, and nested-server chat proposals against the same
  OpenCode binding. Every proven-new source event must receive one common command and signed result;
  only an admitted `{user_text}` command may create one terminal OpenCode attempt, while rejected
  unsupported families create none. Race those attempts with the direct TUI and require the projected
  applied order to follow OpenCode history/events rather than coordinator or source arrival order;
- pin the current immutable OpenCode binding/incarnation/attachment capability snapshot in the A1
  decision and native attempt; race proof downgrade/withdrawal and adapter upgrade at decision, claim,
  restart, and replay. Require missing/stale snapshots to reject, preserve a started attempt's
  historical read-back schema without making it writable for a new command, and forbid generic
  attachment admission from bypassing the OpenCode family gate;
- place OpenCode behind four runtime-owned front-door audiences—TUI, binding adapter, server creation,
  and internal observer—and compare the pinned TUI directly versus through its front door. Generate
  and attest the complete wrapper allowlist with audience/auth-handler/binary identities; reject every
  unlisted method/path/query/body/Upgrade before the private listener. Prove exact credential-redacted
  synthetic reads for every real-TUI startup/active route, and pinned unsupported responses for
  provider/config mutations. Reject raw access, an unclassified third client, a second TUI,
  stale/concurrent wrappers, and a valid adapter credential aimed at the wrong `ses_*`, child, or
  permission. Spawn an OpenCode tool and require exact-process denial of the raw private OpenCode
  listener plus TUI, adapter, observer, creation, provider-façade control, and inference sockets.
  Crash before the last-hop dispatch CAS and recover the one stored send. After that CAS, require at
  most one forward and exact native read-back or `outcome_unknown` quarantine, never a retry; contain
  old endpoints and forwarded requests before lease replacement;
- normalize OpenCode slash commands before the common decision. In selected A2, the only candidates
  for writability are server `{new_chat}` and binding `{user_text}`: typed `/compact`, blank input, `/clear`,
  `/model`, `/context`, interrupt, permission/question answers, attachments, and every other unproved
  family receive a stored rejected `action_result` with no generic `accepted`, user projection,
  native attempt, or `summarize` call. Reject raw-as-user bypass, redeliver only the stored result on
  exact replay, collide changed bytes, and keep each family unsupported until its own causal/recovery
  proof lands;
- replace the OpenCode adapter while an old request is paused both before native forwarding and after
  possible native acceptance; the new lease stays non-writable until old work is settled or
  `outcome_unknown` with the binding quarantined;
- for OpenCode text—and future compact, interrupt, permission, and question capabilities before they
  are enabled—assert that
  coordinator admission is only permission to try, a `prompt_async` `204` is only transport receipt,
  and native history/events/status decide whether, where, and in what order the action applied; prove
  response-body semantics and source causality separately, retaining `unknown` for abort/compact when
  no durable causal seam exists, including direct-TUI races and lost responses;
- keep OpenCode attachments non-writable until a retained native fixture proves exact file-part
  request, history/event read-back, and replay behavior; before that proof, authenticate/parse the
  proposal and deterministically reject it with one stored `action_result`, no `accepted`, projection
  sequence/intent, file write, or native attempt; exact replay only redelivers the rejection and changed
  bytes collide; once enabled, run the exact common attachment manifest/item/content-digest and
  accepted/result/collision gate and prove that no OpenCode JSON/file-part translation can bypass the
  common-schema or adapter-capability checks;
- race a direct OpenCode TUI action or permission answer against remote-claw, and prove that the
  OpenCode session's observed order and terminal gate state win without replay, contradiction, or a
  second inward collaborator;
- parse the native permission reply boolean, close every outward copy only from a proved terminal gate
  record, and race child creation/first tool against policy installation;
- detach an outside collaborator, crash/replace the adapter, and disconnect the front door without
  aborting a direct-TUI run; separately test explicit interrupt and owned-server shutdown;
- kill/restart the real native server with an incomplete assistant message and classify it from server
  incarnation, status, and history without fabricating running or completion;
- compare legacy `/event` and v2 `/api/event`, pin event-ID/sequence scope and reset across reconnect
  and restart, and merge a native status snapshot before readiness;
- retain a pinned real OpenCode TUI plus adapter PTY fixture on one exact `ses_*`; do not count the
  current second-API-client stand-in as TUI proof, and cover both directions, simultaneous submit/busy
  behavior, permission first-winner, adapter/front-door restart, and hard server restart;
- retain a separate sanitized full OpenCode A2 release fixture containing the exact generated
  front-door manifest/classification/registration-attestation vectors, real-TUI route trace,
  read/redaction and unsupported-response policies, observer linearization/filter evidence, creation
  marker/restart evidence, provider/process fence, and canonical bytes behind every digest. Keep the
  current 1.17.5 marker/message-ID proof labeled narrow;
- drive the provider façade with a pinned native request-ID extraction schema; replay the same
  namespace/ID and digest across façade and inference-connector restart and require one inference
  attempt/response stream, then change bytes under the ID and require collision before upstream send.
  Prove the coordinate is retry-stable and never reused for distinct requests throughout the native
  incarnation; a tuple that proves only retry stability remains non-writable. Crash after write-ahead
  but before first provider byte and require recovery to decrypt the retained exact canonical request,
  verify its envelope/schema/plaintext digest, and send those bytes rather than reconstructing them.
  Replace the inference lease before send, after possible upstream receipt, and mid-stream; allow a
  fresh child only with positive never-started evidence or a proved resume cursor for the same upstream
  request, never a second model request. Require replacement leases to repeat the incarnation's façade,
  namespace, extraction schema, and uniqueness-proof digest; a semantics change must close/fence the
  old incarnation and advance to a new one so an old retry cannot enter a fresh namespace;
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

### OpenCode signed-adjudication release matrix

The OpenCode A2 release gate is the following exact matrix. Every pre-dispatch validation or
substitution failure asserts that no byte reaches the private OpenCode listener. A negative discovered
after the dispatch CAS asserts no duplicate send and no inferred native effect without the selected
positive evidence:

- Prove one canonical `user_text` payload vector from live web A1 and authenticated collaborator
  stand-ins for official-client, automation, and nested-server input until those connectors land. The
  source-independent payload bytes/digest must match; the source-specific event, command, decision,
  and signed-result vectors must recompute exactly. Interleave all four sources at one ready boundary
  and require the server-wide `(readyAtJournalSeq, commandId)` order. Do not count a stand-in vector as
  live connector evidence.
  Substitute the source parser/normalizer capability entry, verification digest, source epoch,
  payload schema, payload digest, or event fingerprint under the same source ID and require collision
  or rejection before command admission.
- Exercise the exact effect foreign key
  `(collaborationServerId, commandId, admittingCommandResultId,
  canonicalCommandRecordDigest, admittingCommandResultSignedRecordDigest)`. Reject an unsigned
  result, a `decision_reserved` command, queued/rejected result, altered signature, result version
  other than one, non-null predecessor, result A with command/payload/decision/executor coordinates
  from B, and an admitted result transplanted among OpenCode, Claude, Codex, nested-management, or
  nested-chat executor arms. Only the one signed admitted tuple may create its one effect gate and
  attempt.
- Vector the selected binding and server capability snapshots, their runtime-owner signed
  attestations, family entries, operation coordinates, and translator records. Reject a same-ID
  snapshot with changed bytes, wrong attestation ref/digest/kind/runtime/incarnation, stale or revoked
  pointer, family/scope transplant, changed request/response schema, translator
  schema/implementation/build digest, missing injectivity proof, many-to-one translation, or
  historical translator unavailable after restart.
- For selected `user_text`, assert the exact credential-free request: `POST`
  `/session/{nativeConversationId}/prompt_async`, empty query, headers in the fixed
  `content-type` then `x-opencode-directory` order, and compact body
  `{"messageID":"<nativeActionId>","parts":[{"type":"text","text":"<text>"}]}`, where each placeholder
  denotes the strict JSON-escaped generated string bytes. Reject an altered
  session, method, route, directory, header name/value/order, query, message ID, text, part ID/type/
  order/count, alternate JSON escape, extra key, `model`, `noReply`, provider/agent/system field,
  redirect, absolute URI, or method override. Recompute the request and translation from retained
  common bytes immediately before dispatch; a matching digest paired with a different retained ref
  is invalid.
- For selected `new_chat`, assert exact `POST /session`, empty query, the same fixed headers, and body
  `{"metadata":{"remoteClawCreationId":"<marker>","remoteClawCreationIntentDigest":"<digest>"}}`, with
  the same strict JSON-string placeholder convention.
  Reject titles, caller session IDs, directory/model/provider/parent aliases, extra metadata, changed
  marker/intent/selector/mapping/workspace transition, or a first-bootstrap/new-chat transition-kind
  mismatch. Lose the response at every boundary, retain all same-marker candidates, and bind only one
  candidate whose exact canonical two-field metadata ref/digest recomputes and whose intent digest
  equals the reservation's `expectedNativeCreationIntentDigest`; quarantine wrong-intent,
  noncanonical, extra-field, or multiple-marker cases, and never accept marker-only reconciliation.
- Vector the strict JSON encoder for quotes, backslashes, every C0 scalar, DEL, slash, non-ASCII,
  U+2028/U+2029, invalid UTF-8, lone surrogates, overlong input, alternate escapes, and normalization.
  Vector the selected safe absolute POSIX directory grammar, including empty components, dot/dot-dot,
  symlink identity, percent, backslash, space, colon, non-ASCII, NUL, CR/LF, C0/DEL, and header
  injection. Keep the same path bytes while changing filesystem identity, allowed root, mount
  namespace, or workspace generation and require an unchanged path digest but a changed full
  workspace-binding digest; substitute either digest in a lease, generated coordinate, target, or
  request join and reject. Allocate `nativeActionId` as persisted `msg_` plus 16 random bytes; reject caller IDs,
  malformed/duplicate/history-reused IDs, RNG failure, crash-time reallocation, and ID transplant.
- Attest exactly the four allowed runtime-owned peers—TUI front door, binding adapter front door,
  server-creation front door, and observer—against the raw listener inode, pidfd/start identity,
  executable/build identities, typed exhaustive role-manifest and authorization-handler vectors,
  attach-before-run program, and installed map. Attest the one exact native OpenCode server process
  allowed to reach the provider façade, including TGID, pidfd/start, cgroup, executable, socket, map
  entry, and descendant-denial digest. Replace
  any PID, start time, binary, role, handler, socket/inode, policy map, network namespace, mount
  namespace, provider façade, or tool/descendant rule and require quarantine. A tool subprocess,
  unclassified peer, copied credential, second TUI, or inner process direct access to the raw listener,
  provider control socket, or external network must fail.
- Sign the exact TUI policy snapshot and require its schema/digest, proof tuple, manifest/isolation/
  operation vectors, unsupported/read vectors, runtime/incarnation, server attachment, and
  process-ingress lease to join one current runtime-owner attestation with the TUI-specific signature
  purpose. Substitute a same-ID policy, attestation kind/ref/digest, signer purpose, path/workspace
  digest, or stale process lease and require rejection before a TUI request reaches the listener.
- Build one complete `OpenCodeConversationHistorySnapshotRecord` and typed message/part join for the
  generated action ID. Vary role, message/part ID, message/part index, part schema/payload/text,
  cardinality, ordering, expected fingerprint, history snapshot, runtime/incarnation/binding/session,
  observer epoch, linearization proof/sequence, or filtered SSE coordinate and require mismatch or
  ambiguity. Cover sequence-watermark, barrier-event, and atomic-store recovery; incomplete history,
  SSE-only evidence, buffer gaps, stale reconnect events, duplicate parts, and cross-snapshot joins
  never complete an attempt.
- Distinguish explicit submit, explicit steer, blank submit, and exact reserved slash commands before
  decision. Race snapshot/table replacement during normalization; reject raw-as-user fallthrough,
  prefix/argument aliases, reordered/duplicate table entries, and busy-state inference. In selected
  A2, only `user_text` and server `new_chat` may become writable; every unsupported recognized family
  receives one signed ordered rejection and no native attempt.
- Retain a positive full A2 fixture for the exact selected `user_text` request with `model` absent and
  `noReply` absent, through the private provider façade to an assistant completion, with the real TUI
  active. Repeat the positive result across adapter/coordinator restart in the same native
  incarnation, concurrent direct-TUI input, lost `204`, and history/SSE reconnect. Under the selected
  version-one oracle, a native-server restart changes incarnation and must produce
  `outcome_unknown`/quarantine rather than positive completion; make cross-incarnation completion a
  separate future gate for a lineage-qualified read-back schema. The existing `noReply:true` fixture
  remains a narrow caller-ID/duplicate-append compatibility proof and cannot satisfy this gate.
- Crash before/after attempt preparation, action-ID persistence, translation retention, dispatch-row
  creation, dispatch CAS, socket write, `204`, history snapshot, read-back CAS, and result projection.
  Before the dispatch CAS, recovery may perform the one stored send; after it, recovery may only prove
  the existing native outcome or mark `outcome_unknown`. Never reconstruct under a newer translator,
  capability, workspace, or action ID and never send twice. Require the final pre-write transaction
  to move attempt, dispatch, and command gate to `started` together; no crash or race may expose a
  partial started state.
- Explicitly cancel one terminal `user_text` attempt before its dispatch CAS. Require one atomic
  `NativeBindingPreSendAbandonmentRecord`; attempt, front-door dispatch, and command gate all
  `quarantined` with the same exact evidence schema/ref/digest triple; null dispatch-start time, receipt,
  started-attempt ID, transport receipt, and native read-back; and zero `prompt_async`. Crash on each
  side of the journal commit and require either the complete quarantine or the original resumable
  attempt, never a partial state. Exact replay returns the same record; a changed reason, sequence,
  coordinate, or digest collides. The old protected authorization stays unusable and no replacement, terminal
  continuation, or successor may start. Assert the selected terminal family has null
  `positiveNeverStartedSchemaId`; the nested signed continuation fixture remains distinct and rejects
  this local record as a transplant. Race abandonment against dispatch in both commit orders, and
  substitute a started attempt, receipt/read-back, started dispatch/time, started gate/attempt ID,
  stale executor, protected reference, or digest; abandonment must fail without downgrading any row. A disconnect,
  process death, signal, or ordinary restart with no committed record follows crash recovery rather
  than inferred abandonment. Finally, admit a distinct authenticated source event through the same
  otherwise-current binding to prove the quarantine is command-local.
- Substitute the native workspace transition classification, provider canonical request schema,
  provider request-ID extraction/uniqueness proof, or replacement inference lease coordinates after
  admission. Require exact positive-never-started or proved resume evidence for any provider child;
  uncertainty never creates a second model request.

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

# retained pinned native evidence — also runs in CI when its spike changes
pnpm --filter @remote-claw/codex-multiclient-proof test:run
pnpm --filter @remote-claw/opencode-native-proof test:run

# app e2e in a real browser (Chromium + WebKit) — also runs in CI
pnpm --filter remote-claw-web-tests test:app          # LocalBackend
pnpm --filter remote-claw-web-tests test:app:sqlite   # per-channel SQLite (?backend=sqlite)

# the real-claude proofs (needs a logged-in claude)
(cd apps/web && RC_PROVE_REAL_CLAUDE=1 pnpm exec vitest run test/prove)

# manual live cross-driver verify — a real LLM round-trip through the real viewer (any driver)
node tests/web/cross-mode-verify.mjs <base> <pass> <prompt> <needle> <shot.png> [label]
```
