# Broker backends

The broker data plane (`POST /api/relay` = publish, `GET /api/stream` = subscribe) is a dumb,
zero-knowledge relay: it moves opaque ciphertext frames on ordered, resumable, token-addressed
channels (the per-identity **bus** and per-session streams, §6A/§6B) and never holds a key. The
runtime behind it is **pluggable** via the `BrokerBackend` port (`backend.ts`):

| Backend    | Selector value | What it is | Runs where |
| ---------- | -------------- | ---------- | ---------- |
| **Vercel** | `vercel` (unset code fallback) | Capped Vercel Workflows compatibility/experimental profile — one `relayWorkflow` run per channel token; stable Claude rejects it | Vercel |
| **Local**  | `local` | In-process `Map<token, Channel>` — an append-only frame log + live subscribers | `next start` / tests (single process) |
| **Sqlite** | `sqlite` | Per-channel libSQL — one database per channel token; physical isolation and indefinite ordinary ciphertext retention. The supported production and `pnpm dev` default | Local file **or** Turso Cloud — the only variable |

The backend is the only thing that changes; every client speaks the same HTTP/SSE, and the wire
protocol, auth, and crypto are identical across backends. The **`sqlite`** backend uses one libSQL
database per channel token, including both identity buses and session streams. Its **only** deployment
difference is *where each channel database lives* — a local file (dev) or a Turso Cloud database created
on demand (prod) — chosen by env, with no code or flag change. Per channel it gives physical isolation,
an exact-retry/collision-fenced durable log, and a per-channel write lock (no global mutex). Ordinary
`sweep()` is deliberately non-mutating because inactivity is not an authenticated collection transition.
The successful `POST /api/relay` response keeps the cross-backend field name `runId`, but its value is
the selected backend's opaque channel identifier. For SQLite that is the locator's physical identifier:
the local file path in development or `rc-<scope>-<kind>-<16 hex>` Turso database name in deployment,
never the derivable channel token.

## Selecting a backend

Per **deployment** default: the `BROKER_BACKEND` env var (`vercel` | `local` | `sqlite`;
unset code fallback ⇒ `vercel`). A supported stable-Claude deployment must set
`BROKER_BACKEND=sqlite`; its Vercel runtime must also have the complete Turso fleet configuration.
Stable Claude discovers the effective server capability and closes its remote session before discovery
or serving if the backend reports `durable:false`.

Per **request** override (so one deployment can serve multiple backends):

- API clients send the **`x-broker-backend`** header (the `BrokerClient` `backend` option does this).
- Browser URLs use the **`?backend=`** query param (`page.tsx` forwards it to the `Viewer`).

Publish and subscribe for a given channel **must name the same backend** — the client sends the
selector on both (the `BrokerClient` puts the header on every call; the `Viewer` reads `?backend=`
once and uses it for the whole session). A selector that isn't valid for this deployment is a `400`.

Only **`local`** is restricted: it's process memory, so it's honoured **only as the deployment's own
default** (`pnpm dev` / `next start` with `BROKER_BACKEND=local`) — a per-request pick would land
publish and subscribe on different instances. Vercel and SQLite are per-request selectable, but only
SQLite reports `durable:true` to the host and supplies the retained frame-log cursors. Vercel stores a
persistent run stream that subscribers resume by absolute frame index (a negative `startIndex` merely
selects a tail starting point); it does not maintain an evicting recent window. The current adapter
still reports it as non-durable to the host because it supplies neither `maxSeq` nor `frameCount`.
Every publish also consumes Workflow events, so the one run reaches a fixed 25,000-event cap; there is
currently no pre-cap rollover, making that boundary a cap cliff rather than retention. SQLite always
reaches a consistent store—a single local process's disk (dev/e2e) or a shared Turso Cloud database
(prod), with file mode on Vercel guarded off.

## Local development

```bash
# Per-channel SQLite — the DEFAULT for `pnpm dev` (one libSQL db per channel under ./.rc-sqlite,
# durable across a wrapper restart, no external service). RC_SQLITE_DIR overrides the directory:
pnpm --filter @remote-claw/web dev                           # forces BROKER_BACKEND=sqlite

# In-process Local backend (no disk, no external services):
BROKER_BACKEND=local pnpm --filter @remote-claw/web dev      # or `next start` after build
```

## Tests

```bash
cd tests/web && pnpm test:app                     # built app e2e on durable per-channel SQLite
```

`test:app` hard-pins the durable SQLite profile because stable Claude rejects a non-durable broker.

### CI

- **`web-e2e.yml`** (path-relevant PRs): runs the primary durable SQLite browser path. Ordinary web
  Vitest includes bounded in-process stress for the local and experimental Vercel backends;
  **`web-stress.yml`** schedules only the opt-in heavy local profile. The supported SQLite backend has
  focused durable-store coverage in `test/broker/sqlite-multi.test.ts` and
  `test/broker/turso-cloud-locator.test.ts`; the deployed Preview smoke owns the configured Turso path.
- **`web-preview.yml`** (authenticated typed repository dispatch with a Vercel deployment ID): runs the
  deployment-targeted broker smoke when the protected environment supplies
  `VERCEL_AUTOMATION_BYPASS_SECRET`. A no-secret resolver binds the immutable deployment to the expected
  full SHA before the secret-bearing job runs. The smoke exercises the deployment's durable
  Turso-backed default rather than duplicating every backend in the release path. Turso databases remain
  retained: `/api/dev/sweep` returns 501 because the truncated preview scope cannot prove exact
  deployment ownership. Infrastructure cleanup must use a manually reviewed exact database list.

## Production — per-channel SQLite on Turso Cloud

Set the `sqlite` backend's storage to **Turso Cloud** and it creates one libSQL database per channel token,
no code change — the same engine as local-file dev. Set these as **Vercel encrypted env vars** (e.g.
provisioned by the Vercel↔Turso integration, plus a Platform API token) — see `.env.example`:

```
BROKER_BACKEND=sqlite
TURSO_API_TOKEN=<turso-platform-api-token>   # creates/looks-up per-channel databases
TURSO_ORG=<turso-org-slug>
TURSO_GROUP=<group-the-channel-dbs-live-in>
TURSO_GROUP_AUTH_TOKEN=<group-token>         # libSQL connect credential (auths the whole group)
```

`TURSO_GROUP_AUTH_TOKEN` is deliberately NOT the conventional `TURSO_AUTH_TOKEN`: the Vercel↔Turso
integration owns `TURSO_AUTH_TOKEN` (+ `TURSO_DATABASE_URL`) and points it at a *per-database* token for
its own managed db — a different scope and a different org. The per-channel fleet needs a *group* token,
so it reads a distinct name to stay independent of (and un-clobbered by) the integration. Mint it with
`turso group tokens create <group>`; the Platform API token comes from `turso auth api-tokens mint`.

If those four are set, `selectLocatorFromEnv()` uses the `TursoCloudDbLocator` (one Turso Cloud db per
channel token, created on first publish via the Platform API, connected with the group token);
otherwise it uses local files. **File storage is not durable on Vercel** (ephemeral, per-instance fs) —
the file locator fails closed there, so configure Turso Cloud for a Vercel deployment.

The no-store `/api/health/deployment` deployment-binding seam accepts only an exact Vercel
Preview or Production runtime, a full `VERCEL_GIT_COMMIT_SHA`, `BROKER_BACKEND=sqlite`, all four
fleet variables, and no explicit `RC_TURSO_DB_SCOPE`. It returns only nonsecret coordinates: Preview
derives `pr-<7sha>`, while Production derives `prod`. The deployment smoke requires the returned SHA
and storage profile to match the candidate before exercising the data plane. It does not attest host
tools, scan a provider fleet, or publish a durable receipt.

Every newly opened channel, continuity-index, and handoff Turso client crosses a hard create→serve
readiness barrier before schema or data operations. The default wall is 30 seconds and
`RC_TURSO_READY_DEADLINE_MS` can only tighten it. Readiness failure closes the half-open client and
never caches it. Every continuity-index build/rebuild first forces Platform create-or-existing
confirmation, then opens and awaits readiness before constructing `SessionIndex`; no catalog DDL/read
precedes that barrier, so a fresh deployment does not require a sacrificial warm-up request.

**Meaningful, scoped db names (isolation + scannability):** every db name is human-readable in
`turso db list` — `rc-<scope>-<kind>-<16 hex>`:

```
rc-prod-s-3f9a1c2e8b7d6045          # production, session channel
rc-prod-b-3f9a1c2e8b7d6045          # production, bus channel
rc-pr-a1b2c3d-s-3f9a1c2e8b7d6045    # preview of commit a1b2c3d, session channel
rc-prod-index   /   rc-pr-a1b2c3d-index    # the per-scope cold-index catalog db
```

`<scope>` is the deployment environment — `prod`, `pr-<7-char commit sha>` for a preview, or `dev` —
derived automatically from `VERCEL_ENV`/`VERCEL_GIT_COMMIT_SHA` (override with `RC_TURSO_DB_SCOPE`). It
separates ordinary routing names, but it is **not deletion authority**: two commits can share a seven-
character prefix, and an override can select another deployment's scope. Ordinary production and
preview retention is indefinite; `sweep()` deletes nothing and `/api/dev/sweep` returns 501 without
calling the low-level diagnostic `dropScope()` primitive. `<kind>` is `s` (session), `b` (bus), or
`x` (other).
(Turso db names are capped at 36 chars, which this scheme respects.)

### Notes / limits

- `subscribe()` on **Sqlite** **polls** (libSQL has no server→client push): `RC_SQLITE_POLL_MS`,
  default 150ms. Knobs: `RC_SQLITE_DIR` (file storage dir), `RC_SQLITE_MAX_CLIENTS` (bounded client LRU,
  default 256), `RC_SQLITE_POLL_MS`, and `RC_SQLITE_POLL_QUERY_TIMEOUT_MS` (tighten-only from the hard
  15-second per-query maximum). One subscription shares a three-consecutive-transient-failure budget
  across frame and state polls. A row-bearing frame query resets it; an empty frame query resets it only
  after the paired state query also succeeds. The third transient failure, any query deadline, or any
  nontransient poll failure terminates the subscription with a coordinate-free error, evicts the cached
  client, and releases its lease so the host's fail-stop circuit can observe the outage. A missing
  channel remains immediate permanent storage loss rather than entering that retry budget. Each channel
  db opens in **WAL** so poll-tail reads run concurrently with the writer — matching remote libSQL;
  writes serialize structurally (one writer connection per channel token), not via a busy_timeout.
- The per-scope channel catalog contains only database identifiers, locators, and creation
  timestamps—no ciphertext or keys. It is not collection authority, but it is the mandatory
  create-once continuity witness. For a genuinely new token, the order is physical provision →
  readiness/preparation → core schema → singleton `channel` witness row → catalog commit → first
  frame. A catalogued token missing its physical store, either core table (`channel` or `frames`), or
  singleton witness row fails with `ChannelStorageLossError` and is never recreated as an empty log.
  An intact uncatalogued store with its witness is recatalogued; an empty pre-witness provision may
  finish initialization. Ordinary `sweep()`
  returns zero without reading, dropping, or compacting channel/bus data; a future bounded retention
  design needs an authenticated collection or permanent revocation transition first.
- `POST /api/relay` maps only server-classified `ChannelStorageLossError` to coordinate-free HTTP 410
  JSON `{ok:false,code:"channel_storage_lost",error:"permanent channel storage loss"}`. The CLI creates
  `BrokerPermanentStorageLossError` only for status 410 plus the parsed exact code; a bare/proxy 410 or
  that code on another status remains ordinary `BrokerError`, and the typed error discards response
  text. That typed failure on either the initial or a later identity-bus announcement closes the
  Session; ordinary announcement transport/5xx failure remains advisory and retryable.
- The `local` backend keeps state in one process's memory, so it is **not** valid on a multi-instance
  / serverless deployment — it's for `pnpm dev` / `next start` and tests only.
