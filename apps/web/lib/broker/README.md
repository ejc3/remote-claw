# Broker backends

The broker (the two routes `POST /api/relay` = publish, `GET /api/stream` = subscribe) is a dumb,
zero-knowledge relay: it moves opaque ciphertext frames on ordered, resumable, token-addressed
channels (the per-identity **bus** and per-session streams, §6A/§6B) and never holds a key. The
durable runtime behind it is **pluggable** via the `BrokerBackend` port (`backend.ts`):

| Backend    | Selector value | What it is | Runs where |
| ---------- | -------------- | ---------- | ---------- |
| **Vercel** | `vercel` (default) | Vercel Workflows — one `relayWorkflow` run per channel token | Production on Vercel |
| **Local**  | `local` | In-process `Map<token, Channel>` — an append-only frame log + live subscribers | `next dev` / `next start` / tests (single process) |
| **Temporal** | `temporal` | One `relayChannel` Temporal workflow per token (signal=publish, query=state, signal=close) | Any Temporal server (Cloud or self-hosted) + the worker |

The backend is the only thing that changes; every client speaks the same HTTP/SSE, and the wire
protocol, auth, and crypto are identical across backends.

## Selecting a backend

Per **deployment** default: the `BROKER_BACKEND` env var (`vercel` | `local` | `temporal`; unset ⇒
`vercel`).

Per **request** override (so one deployment can serve multiple backends):

- API clients send the **`x-broker-backend`** header (the `BrokerClient` `backend` option does this).
- Browser URLs use the **`?backend=`** query param (`page.tsx` forwards it to the `Viewer`).

Publish and subscribe for a given channel **must name the same backend** — the client sends the
selector on both (the `BrokerClient` puts the header on every call; the `Viewer` reads `?backend=`
once and uses it for the whole session). A selector that isn't valid for this deployment is a `400`.

Only **durable, shared** backends (`vercel`, `temporal`) are selectable per request. `local` is
process-memory, so it's honoured **only when it's the deployment's own default** (dev / `next start`
with `BROKER_BACKEND=local`) — a request can't pick `local` on a Vercel/Temporal deployment (it would
land publish and subscribe on different instances).

## Local development

```bash
# Local backend (no external services):
BROKER_BACKEND=local pnpm --filter @remote-claw/web dev      # or `next start` after build

# Local Temporal (the Temporal CLI dev server is in-memory; no Docker):
#   1. install the CLI once:  curl -sSf https://temporal.download/cli.sh | sh
#   2. run the worker + server, then point the broker at it:
pnpm --filter @remote-claw/web temporal:worker               # needs a server (below) on :7233
```

`scripts/with-temporal.sh <cmd>` provisions a dev server **and** the worker, runs `<cmd>` with
`TEMPORAL_ADDRESS` set, and tears it all down — used by the Temporal tests.

## Tests (both backends)

```bash
pnpm --filter @remote-claw/web test:temporal     # the backend contract test against real Temporal
cd tests/web && pnpm test:app                     # the full app e2e on the LOCAL backend
cd tests/web && pnpm test:app:temporal            # the SAME app e2e flipped to Temporal via ?backend=
```

`test:app:temporal` runs against one Next server (default `local`) and flips individual sessions to
Temporal with `?backend=temporal`, proving the abstraction is swappable per-request.

### CI

- **`web-e2e.yml`** (every PR, self-contained): installs Chromium + the Temporal CLI and runs the
  **local** and **temporal** app e2e + the contract + the encryption stress (`test:stress`) + a
  **heavy local stress** (`test:stress:heavy` — thousands of sealed round-trips). No Docker, no account.
- **`web-preview.yml`** (on a Vercel preview): runs the deployment-targeted broker e2e, and — once the
  `DEV_SEED_TOKEN` secret is set (GitHub + the Vercel *Preview* env) — the Playwright UI e2e against the
  **vercel** backend. The vercel runtime only exists on a deployment, which is why its e2e lives here.

## Production (Temporal Cloud)

Set these as **Vercel encrypted env vars**, scoped per environment (Production / Preview / Development)
so prod, stage, and CI can target different Temporal namespaces — see `.env.example`:

```
BROKER_BACKEND=temporal            # or keep vercel as default and opt in per-request via the header
TEMPORAL_ADDRESS=<namespace>.<account>.tmprl.cloud:7233
TEMPORAL_NAMESPACE=<namespace>.<account>
TEMPORAL_API_KEY=<temporal-cloud-api-key>     # API-key auth (implies TLS); or use TEMPORAL_TLS_* for mTLS
```

The Next routes only need `@temporalio/client`. The **`relayChannel` worker** (`temporal/worker.ts`)
is a separate long-running service — deploy it against the same cluster/namespace (Vercel functions
can't host a persistent worker), e.g. on a container/VM. In dev it runs via `tsx`; for prod, run it
with a TS loader (`tsx`/`ts-node`) or compile it first — it bounds history with `continueAsNew` and
shuts down gracefully on SIGTERM/SIGINT.

### Notes / limits

- `subscribe()` on Temporal **polls** the workflow `state` query (`TEMPORAL_POLL_MS`, default 150ms) —
  Temporal has no native server→client push for workflow state.
- A single Temporal channel's total frame log must fit Temporal's payload size limit across a
  `continueAsNew` (true for RC sessions; an unbounded firehose would need windowing).
- The `local` backend keeps state in one process's memory, so it is **not** valid on a multi-instance
  / serverless deployment — it's for `next dev`/`next start` and tests only.
