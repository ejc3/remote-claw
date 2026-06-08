# P3 spike — value-addressed bus on Vercel Workflows

A throwaway app that **empirically verifies the §6B bus design** (`docs/v2-architecture.md`)
on real Vercel Workflows infra. It is *not* the production broker — it has no `T_app`/auth,
no E2E crypto, no chunking. It exists only to prove the four linchpins the design rests on.

Stack: `next@16.2.7`, `workflow@4.3.1` (Workflow DevKit), Vercel World (`iad1`).

## What it proves

| # | Linchpin | Endpoint(s) |
| - | --- | --- |
| 1 | **Cross-process value-addressing** — resolve a derived token to another process's run and tail its stream: `getHookByToken(token).runId → getRun(runId).getReadable({startIndex})` | `POST /api/publish`, `GET /api/subscribe` |
| 2 | **Recent-window cold start** — `getReadable({startIndex: -N})` returns the last N chunks and keeps streaming | `GET /api/subscribe?startIndex=-2` |
| 3 | **One-bus-per-identity** — a duplicate `createHook` on a held token throws `HookConflictError` | `POST /api/conflict` |
| 4 | **Completion → hook dispose → token frees** (the cap-roll/teardown path) | `__close` sentinel + `GET /api/status` |

`workflows/bus.ts` is the bus: one run per token, holds a custom-token `createHook`, and
re-emits every `resumeHook` payload onto its out-stream (`for await … of hook`). Subscribers
tail that stream by resolving the token. `app/api/publish` does resume-or-`start()`.

## Run it

```bash
pnpm install
pnpm build           # local compile + typecheck
vercel deploy --yes  # deploy (Vercel World auto-provisions; protection is on by default)
bash ./test.sh       # drive the 4 checks via `vercel curl` (auths the protected deployment)
```

`vercel curl` is used instead of `curl` because new deployments have Deployment Protection
(Vercel Authentication) on by default — it authenticates via the logged-in CLI session.

## Verified result (2026-06-08)

All four checks passed on a real deployment:

```
CHECK 1  publish ×3 → one runId; subscribe(startIndex=0) → [{n:1},{n:2},{n:3}], tailIndex:2
CHECK 2  subscribe(startIndex=-2) → [{n:2},{n:3}]
CHECK 3  conflict → {conflict:true, name:"HookConflictError",
                     message:"Hook token \"…\" is already in use by another workflow"}
CHECK 4  before __close: tokenResolves:true →
         after  __close: tokenResolves:false (HookNotFound), subscribe → empty
```

Recorded in `docs/v2-architecture.md` §14A ("P3 spike — empirically verified on Vercel").
