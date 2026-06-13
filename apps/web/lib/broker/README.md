# Broker backends

The broker (the two routes `POST /api/relay` = publish, `GET /api/stream` = subscribe) is a dumb,
zero-knowledge relay: it moves opaque ciphertext frames on ordered, resumable, token-addressed
channels (the per-identity **bus** and per-session streams, §6A/§6B) and never holds a key. The
durable runtime behind it is **pluggable** via the `BrokerBackend` port (`backend.ts`):

| Backend    | Selector value | What it is | Runs where |
| ---------- | -------------- | ---------- | ---------- |
| **Vercel** | `vercel` (default) | Vercel Workflows — one `relayWorkflow` run per channel token | Production on Vercel |
| **Local**  | `local` | In-process `Map<token, Channel>` — an append-only frame log + live subscribers | `next start` / tests (single process) |
| **Temporal** | `temporal` | One `relayChannel` Temporal workflow per token (signal=publish, query=state, signal=close) | Any Temporal server (Cloud or self-hosted) + the worker |
| **Sqlite** | `sqlite` | Per-session libSQL — ONE database per channel token; physical isolation, retention = drop the database. The primary backend (`pnpm dev` default) | Local file **or** Turso Cloud — the only variable |

The backend is the only thing that changes; every client speaks the same HTTP/SSE, and the wire
protocol, auth, and crypto are identical across backends. The **`sqlite`** backend is one per-session
libSQL engine whose **only** deployment difference is *where each session's database lives* — a local
file (dev) or a Turso Cloud database created on demand (prod) — chosen by env, with no code or flag
change. Per session it gives physical isolation, per-session retention (drop the db), and a per-session
write lock (no global mutex).

## Selecting a backend

Per **deployment** default: the `BROKER_BACKEND` env var (`vercel` | `local` | `temporal` | `sqlite`;
unset ⇒ `vercel`).

Per **request** override (so one deployment can serve multiple backends):

- API clients send the **`x-broker-backend`** header (the `BrokerClient` `backend` option does this).
- Browser URLs use the **`?backend=`** query param (`page.tsx` forwards it to the `Viewer`).

Publish and subscribe for a given channel **must name the same backend** — the client sends the
selector on both (the `BrokerClient` puts the header on every call; the `Viewer` reads `?backend=`
once and uses it for the whole session). A selector that isn't valid for this deployment is a `400`.

Only **`local`** is restricted: it's process memory, so it's honoured **only as the deployment's own
default** (`pnpm dev` / `next start` with `BROKER_BACKEND=local`) — a per-request pick would land
publish and subscribe on different instances. Every other backend (`vercel`, `temporal`, `sqlite`) is
durable and per-request selectable; `sqlite` always reaches a consistent store — a single local
process's disk (dev / e2e) or a SHARED Turso Cloud db (prod), with file-mode on Vercel guarded off.

## Local development

```bash
# Per-session SQLite — the DEFAULT for `pnpm dev` (one libSQL db per channel under ./.rc-sqlite,
# durable across a wrapper restart, no external service). RC_SQLITE_DIR overrides the directory:
pnpm --filter @remote-claw/web dev                           # forces BROKER_BACKEND=sqlite

# In-process Local backend (no disk, no external services):
BROKER_BACKEND=local pnpm --filter @remote-claw/web dev      # or `next start` after build

# Local Temporal (the Temporal CLI dev server is in-memory; no Docker):
#   1. install the CLI once:  curl -sSf https://temporal.download/cli.sh | sh
#   2. run the worker + server, then point the broker at it:
pnpm --filter @remote-claw/web temporal:worker               # needs a server (below) on :7233
```

`scripts/with-temporal.sh <cmd>` provisions a dev server **and** the worker, runs `<cmd>` with
`TEMPORAL_ADDRESS` set, and tears it all down — used by the Temporal tests.

## Tests

```bash
pnpm --filter @remote-claw/web test:temporal     # the backend contract test against real Temporal
cd tests/web && pnpm test:app                     # the full app e2e on the LOCAL backend
cd tests/web && pnpm test:app:temporal            # the SAME app e2e flipped to Temporal via ?backend=
cd tests/web && pnpm test:app:sqlite              # the SAME app e2e flipped to per-session SQLite (file)
```

`test:app:temporal` / `test:app:sqlite` run against one Next server (default `local`) and flip
individual sessions to Temporal / SQLite with `?backend=`, proving the abstraction is swappable
per-request.

### CI

- **`web-e2e.yml`** (every PR, self-contained): installs Chromium + the Temporal CLI and runs the
  **local**, **temporal**, and **sqlite** (per-session libSQL file) app e2e + the Temporal drain e2e +
  the contract + the encryption stress (`test:stress`) + a **heavy local stress** (`test:stress:heavy`
  — thousands of sealed round-trips). No Docker, no account. The sqlite backend additionally has unit
  coverage in `test/broker/sqlite-multi.test.ts` + `test/broker/turso-cloud-locator.test.ts`.
- **`web-preview.yml`** (on a Vercel preview): runs the deployment-targeted broker e2e, and — once the
  `DEV_SEED_TOKEN` secret is set (GitHub + the Vercel *Preview* env) — the Playwright UI e2e against the
  **vercel** backend. The vercel runtime (and the sqlite backend's Turso Cloud storage) only exist on a
  real deployment, which is why their e2e lives here.

## Production — per-session SQLite on Turso Cloud

Set the `sqlite` backend's storage to **Turso Cloud** and it creates one libSQL database per session,
no code change — the same engine as local-file dev. Set these as **Vercel encrypted env vars** (e.g.
provisioned by the Vercel↔Turso integration, plus a Platform API token) — see `.env.example`:

```
BROKER_BACKEND=sqlite
TURSO_API_TOKEN=<turso-platform-api-token>   # creates/looks-up per-session databases
TURSO_ORG=<turso-org-slug>
TURSO_GROUP=<group-the-session-dbs-live-in>
TURSO_GROUP_AUTH_TOKEN=<group-token>         # libSQL connect credential (auths the whole group)
```

`TURSO_GROUP_AUTH_TOKEN` is deliberately NOT the conventional `TURSO_AUTH_TOKEN`: the Vercel↔Turso
integration owns `TURSO_AUTH_TOKEN` (+ `TURSO_DATABASE_URL`) and points it at a *per-database* token for
its own managed db — a different scope and a different org. The per-session fleet needs a *group* token,
so it reads a distinct name to stay independent of (and un-clobbered by) the integration. Mint it with
`turso group tokens create <group>`; the Platform API token comes from `turso auth api-tokens mint`.

If those four are set, `selectLocatorFromEnv()` uses the `TursoCloudDbLocator` (one Turso Cloud db per
channel token, created on first publish via the Platform API, connected with the group token);
otherwise it uses local files. **File storage is not durable on Vercel** (ephemeral, per-instance fs) —
the file locator fails closed there, so configure Turso Cloud for a Vercel deployment.

## Production — Temporal Cloud (alternative)

Set these as **Vercel encrypted env vars**, scoped per environment (Production / Preview / Development)
so prod, stage, and CI can target different Temporal namespaces — see `.env.example`:

```
BROKER_BACKEND=temporal            # or keep vercel as default and opt in per-request via the header
TEMPORAL_ADDRESS=<namespace>.<account>.tmprl.cloud:7233
TEMPORAL_NAMESPACE=<namespace>.<account>
TEMPORAL_API_KEY=<temporal-cloud-api-key>     # API-key auth (implies TLS); or use TEMPORAL_TLS_* for mTLS
```

The Next routes only need `@temporalio/client`. The **`relayChannel` worker** must run *somewhere* —
Temporal Cloud stores state + the task queue but never executes your workflow code; a worker polls the
queue and runs it. Two ways to host it:

**A. Keep-warm worker on Vercel itself (no extra infra).** A cron (`apps/web/vercel.json`,
`* * * * *`) hits `GET /api/temporal/drain` every minute; the route boots the worker for a bounded
window (default 70s, > the 60s tick) so there's always ≥1 poller draining the queue. The window
overlaps the next tick, Fluid Compute bills only active CPU (a long-poller is mostly idle), and
`worker.shutdown()` drains gracefully before `maxDuration`. The route and the standalone worker share
`createRelayWorker()` (`temporal/run.ts`) so they can't drift. Requirements/notes:

- **Vercel Pro** — per-minute crons are Pro-only; Hobby caps at once/day and *fails the deploy* for
  anything more frequent.
- **`CRON_SECRET`** (Vercel env, Production + Preview) gates the route — Vercel sends
  `Authorization: Bearer $CRON_SECRET` on cron calls; everything else gets a `404`.
- Crons fire only on the **production** deployment. On a preview, drive it with an authenticated
  request: `curl -H "authorization: Bearer $CRON_SECRET" "$URL/api/temporal/drain"`.
- `GET …/drain?selftest=1` builds the workflow bundle in-function **without** connecting — proves the
  native worker bundler runs in the Vercel function (the riskiest part) even before creds are wired.
- Tunable: `TEMPORAL_DRAIN_WINDOW_MS` (default 70s). Overlap with the next tick is what removes gaps,
  so it only needs to sit a little above the 60s interval — it is clamped under the route's
  `maxDuration` (300s) regardless, since a much longer window just stacks redundant pollers.

**B. A dedicated always-on worker** (`temporal/worker.ts`) on a container/VM/Fly/Render against the
same cluster/namespace — the classic option if you'd rather not run a cron. In dev it runs via `tsx`;
for prod run it with a TS loader or compile it. Either way it bounds history with `continueAsNew` and
shuts down gracefully on SIGTERM/SIGINT.

### Notes / limits

- `subscribe()` on Temporal **polls** the workflow `state` query (`TEMPORAL_POLL_MS`, default 150ms) —
  Temporal has no native server→client push for workflow state.
- A single Temporal channel's total frame log must fit Temporal's payload size limit across a
  `continueAsNew` (true for RC sessions; an unbounded firehose would need windowing).
- `subscribe()` on **Sqlite** also **polls** (libSQL has no server→client push): `RC_SQLITE_POLL_MS`,
  default 150ms. Knobs: `RC_SQLITE_DIR` (file storage dir), `RC_SQLITE_MAX_CLIENTS` (bounded client LRU,
  default 256), `RC_SQLITE_POLL_MS`. Each session db opens in **WAL** so reads (the poll-tail, the
  retention sweep probe) run concurrently with the writer — matching remote libSQL; writes serialize
  structurally (one writer connection per session token), not via a busy_timeout.
- **Retention scales to an unlimited fleet via a COLD session index** — used in BOTH modes (so the same
  engine runs locally, where it's fully testable). Turso's list-databases is un-paginated and has no
  last-activity timestamp, so a fleet-wide list+probe can't scale. Instead a catalog db (cloud:
  `rc-index`; file: `_index.db`) — written once on session-create, deleted on drop (never on the hot
  publish path) — holds only `(db id, url, created_at)` (public routing metadata, no ciphertext or keys).
  The retention cron walks it in resumable batches (`RC_SQLITE_SWEEP_BATCH`, a persisted cursor rotating
  through the fleet across runs), probing only each batch's own `MAX(created_at)`.
- The `local` backend keeps state in one process's memory, so it is **not** valid on a multi-instance
  / serverless deployment — it's for `pnpm dev` / `next start` and tests only.
