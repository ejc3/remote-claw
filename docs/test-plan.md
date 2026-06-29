# remote-claw — test plan

What we verify, how, and where. The system is a zero-knowledge, E2E-encrypted relay for driving
`claude` sessions from a phone/browser; the test strategy mirrors the trust boundaries.

## Strategy — the pyramid

| Layer | Where | What it proves | Runtime |
| --- | --- | --- | --- |
| **Unit (crypto core)** | `packages/clawsec/src/*.test.ts` | HKDF hierarchy, AEAD per-message keys, the §8 wire envelope, channel tokens, the pass, chunking — pure functions, no network | Node + WebCrypto |
| **Unit (CLI seam + transport)** | `packages/cli/src/**/*.test.ts` | SecurityProvider (Open/Sealed, downgrade floor), BrokerClient (HTTP/SSE) against an in-memory broker, FrameOrderer (dedup/reorder), HostRelay (fake backend), ClaudeStreamSession env passthrough | Node, mock fetch / fixture |
| **Integration (broker)** | `apps/web/test/*.integration.test.ts` | the **real** broker routes on the **real** Workflow runtime (`@workflow/vitest`): admission, routing, bus/session isolation, SSE, the full encrypted turn, control plane, the browser Viewer | in-process Vercel Workflows |
| **App e2e (real browser)** | `tests/web/app-e2e/*.spec.ts` (Playwright) | a real **Chromium** drives the BUILT viewer against a real Next server + broker — the full RC turn, the one-time-handoff pairing, the three drivers' capability profiles (mitm/tmux/opencode, via capability presets — not real tmux/opencode hosts), and the bus-unreachable banner; **WebKit** runs the iOS-Safari foreground-revive spec; the RC turn re-runs on the per-session SQLite backend | Playwright (Chromium + WebKit), built prod server |
| **Proof (real claude)** | `apps/web/test/prove/*.prove.test.ts` (gated `RC_PROVE_REAL_CLAUDE=1`) | a **real, logged-in `claude`** driven end-to-end through the encrypted broker — single turn and stateful multi-turn | spawns real `claude`, network |
| **Exploratory** | manual real-`claude` runs (`tests/web/cross-mode-verify.mjs`) | a LIVE session driven through the real viewer for any bridged driver: type a prompt, assert a real assistant reply (real LLM round-trip) carrying a needle, screenshot | real, on demand |

CI keeps the unit + integration layers fast and network-free, and on every PR that touches the
web/CLI/crypto paths also runs the **app-e2e** layer (Chromium + WebKit; the RC turn re-runs on
per-session SQLite) plus the encryption-stress suites (`.github/workflows/web-e2e.yml`, path-filtered);
the real-claude proofs are env-gated so they never gate CI but are run on demand. Each PR passes
`biome` + `tsc` + `vitest` + the e2e suite before merge.

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

## How to run

```bash
# unit + integration (fast, network-free) — what CI runs
(cd packages/clawsec && pnpm test:run)
(cd packages/cli && pnpm test:run)
(cd apps/web && pnpm test:run)

# app e2e in a real browser (Chromium + WebKit) — also runs in CI
pnpm --filter remote-claw-web-tests test:app          # LocalBackend
pnpm --filter remote-claw-web-tests test:app:sqlite   # per-session SQLite (?backend=sqlite)

# the real-claude proofs (needs a logged-in claude)
(cd apps/web && RC_PROVE_REAL_CLAUDE=1 pnpm exec vitest run test/prove)

# manual live cross-driver verify — a real LLM round-trip through the real viewer (any driver)
node tests/web/cross-mode-verify.mjs <base> <pass> <prompt> <needle> <shot.png> [label]
```
