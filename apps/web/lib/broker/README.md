# Broker backends

The broker data plane (`POST /api/relay` = publish, `GET /api/stream` = subscribe) is a dumb,
zero-knowledge relay: it moves opaque ciphertext frames on ordered, resumable, token-addressed
channels (the per-identity **bus** and per-session streams, §6A/§6B) and never holds a key. The
runtime behind it is **pluggable** via the `BrokerBackend` port (`backend.ts`):

| Backend    | Selector value | What it is | Runs where |
| ---------- | -------------- | ---------- | ---------- |
| **Vercel** | `vercel` (unset code fallback) | Capped Vercel Workflows compatibility/experimental profile — one `relayWorkflow` run per channel token; stable Claude rejects it | Vercel |
| **Local**  | `local` | In-process `Map<token, Channel>` — an append-only frame log + live subscribers | `next start` / tests (single process) |
| **Sqlite** | `sqlite` | Per-channel libSQL — one database per channel token; physical isolation and indefinite ordinary ciphertext retention. The supported Claude 1.0 production and `pnpm dev` default | Local file **or** Turso Cloud — the only variable |

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
cd tests/web && pnpm test:app                     # the full stable app e2e on per-channel SQLite (file)
cd tests/web && pnpm test:app:sqlite              # focused transcript e2e with explicit ?backend=sqlite
```

`test:app` hard-pins the durable SQLite profile because stable Claude rejects a non-durable broker.
`test:app:sqlite` is the narrower transcript variant that also proves explicit per-request selection.

### CI

- **`web-e2e.yml`** (every PR, self-contained): installs Chromium/WebKit and runs the full durable
  **sqlite** app e2e plus its focused explicit-selector transcript variant, unit tests, encryption stress (`test:stress`), and a
  **heavy local stress** (`test:stress:heavy` — thousands of sealed round-trips). No Docker, no account.
  The sqlite backend additionally has unit coverage in `test/broker/sqlite-multi.test.ts` +
  `test/broker/turso-cloud-locator.test.ts`.
- **`web-preview.yml`** (authenticated typed repository dispatch with a Vercel deployment ID): runs the
  deployment-targeted broker e2e and, when the protected `release-proof` environment supplies
  `VERCEL_AUTOMATION_BYPASS_SECRET`, two explicit Playwright UI legs: `E2E_BACKEND=vercel` exercises
  the Workflow compatibility backend, while `E2E_BACKEND=sqlite` exercises the deployment's real
  Turso-backed durable backend. Neither leg relies on the unset deployment default. It has no
  `deployment_status` or ref-selectable `workflow_dispatch` trigger because those can select candidate
  workflow bytes; `repository_dispatch` selects the default branch. The Vercel runtime
  (and the sqlite backend's Turso Cloud storage) only exist on a real deployment, which is why their e2e
  lives here. The sqlite/Turso-Cloud leg provisions real per-channel dbs. Those opaque proof dbs remain
  retained: `/api/dev/sweep` returns 501 and never constructs a locator because the truncated preview
  scope cannot prove exact deployment ownership. Any infrastructure cleanup must operate on a manually
  reviewed exact database list outside the app.

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

The no-store `/api/prove/deployment-attestation` release seam accepts only an exact Vercel Preview or
Production runtime, full `VERCEL_GIT_COMMIT_SHA`, `BROKER_BACKEND=sqlite`, all four fleet variables, and
no explicit `RC_TURSO_DB_SCOPE`. It returns only nonsecret coordinates: Preview derives
`pr-<7sha>`, while Production derives `prod`. The topology runner requires Preview; the post-merge
release verifier requires Production and the same organization/group inspected in Preview.

The post-merge verifier does more than read that configuration seam. Its zero-argv wrapper byte-pins
BusyBox, Git, and Node; derives the inspected candidate from the canonical private receipt filename;
requires the clean candidate-ancestor/equal-tree merge; materializes and byte-compares committed
wrapper/verifier/schema blobs before piping credentials; and rechecks the repository afterward. The
credential-bearing verifier writes only a private durable noncanonical stage. The wrapper binds its
SHA-256/device/inode/size, rechecks the exact initial merged HEAD/tree, and materializes a fresh committed
publisher closure; only that exact credential-free publisher may strict-validate/recheck the stage and
exclusively, atomically, and durably publish the canonical Production receipt. The verifier checks the
inspection completion both initially and finally, accepting at most 71 hours of age or five minutes of
future skew.
It re-attests the exact enabled active Firewall config: its sole custom rule is the valid
`/api/handoff` token bucket; owner/team is pinned; update time is canonical; its project key is the
pinned project ID plus `#active`; active `ips` and `changes` are empty; and the exact managed-rule matrix
keeps `gen`, `rce`, `sqli`, and `xss` active/log while `java`, `lfi`, `ma`, `php`, `rfi`, `sd`, and `sf`
are inactive/log. Draft/version state is
unambiguous, and the separate **Firewall** bypass list is empty. It then requests
the immutable origin without an automation bypass to prove that Vercel Deployment Protection is active.
The automation bypass is confined to runtime-attestation, frame-count, and relay requests at that
immutable origin; it is never sent to GitHub or Vercel Management APIs. Through the deployment's
unselected default backend, a random fresh session must return a null durable `/api/frame-count`, publish
one opaque frame through `/api/relay` with `created:true`, and then return a durable frame count of one.
The relay response's physical `rc-prod-s-<16 hex>` identifier is retained as the Production receipt's
`databaseId`; the challenge, bearer, and frame bytes are not retained. The canonical terminal artifact
is exact-schema mode 0600 and appears only after its complete bytes and parent directory are synced.

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
calling the low-level diagnostic `dropScope()` primitive. `<kind>` is `s` (session), `b` (bus), `c`
(selected-A1 control), or `x` (other).
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
