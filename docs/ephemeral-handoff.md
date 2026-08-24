# Ephemeral one-time credential handoff (OTK)

**Status:** **IMPLEMENTED (code)** — PR1 (clawsec `handoff.ts`), PR2 (zero-knowledge `HandoffStore` +
`/api/handoff`), PR3 (QR `otk1_` + web client + §3.6 non-extractable storage). Research-grounded (8-angle
workflow) **and adversarially reviewed** (codex + 7-dimension red-team on the design; codex + `/code-review`
per PR; all resolutions in §8). The §1 invariant was honestly scoped after review.

> **Claude 1.0 release scope:** manual pass onboarding is sufficient. QR/OTK handoff may be enabled only
> when every §5 control ships together, including the externally provisioned WAF rate limit verified
> live by the trusted release proof. If that rule is not verified, the handoff route and QR/OTK UI/CLI
> path stay disabled; the missing WAF rule then does not
> block the core [Claude 1.0 finish line](release-finish-line.md). Safety is conditional on feature
> enablement, never optional within an enabled handoff flow.

**Goal:** replace the *forever pass embedded in the QR* with a **one-time, short-TTL bootstrap token**, so the
handoff store is — to an *honest-but-curious* broker, a DB dump, or a passive log/edge observer — a store it
**cannot read**, that yields a blob to **one** caller **once**.

## 1. The invariant (honest scope)

The handoff store guarantees, against **an honest-but-curious broker, a DB/backup dump, and a passive
log/edge observer**:

1. **Confidentiality (cryptographic):** the stored row is `id = SHA256(OTK)` + a hash of a claim proof +
   AES-256-GCM ciphertext under a key derived from OTK. With OTK only ever in the QR `#fragment`, the broker
   **cannot read, decrypt, or derive a key from** what it stores (inverting `id`/wrap is ≥2¹²⁸).
2. **One-time + TTL (API-enforced, not cryptographic erasure):** a single atomic claim returns the blob to
   **at most one** caller and deletes the row; after a configurable TTL (default **10 min**) the row is
   un-claimable and swept. This is enforced by the API + store, **not** by erasure — see the two limits.

**Two limits this design does NOT cross (stated, not glossed):**

- **It is not zero-knowledge against a *compromised code/edge* broker.** A *server-delivered web viewer*
  cannot be ZK against the server that ships its JS: that server could serve malicious JS that reads
  `location.hash` before the scrub and decrypts. Closing this needs a **pinned/native/separate-trust-root
  client** (tracked as the §5 follow-up); the web viewer's guarantee is against an honest server + passive
  observers, not a malicious app-delivery server.
- **Delete-on-read is not cryptographic forgetting.** DB dumps, WAL, replicas, and **Turso PITR/backups** may
  retain an **undecryptable** ciphertext past the claim/TTL. Confidentiality still holds (no OTK ⇒ no
  plaintext); the "broker forgets the bytes" property is best-effort (frequent sweep + `no-store`), not a
  guarantee.

## 2. Today, and why it must change

The viewer credential is the `rcp1_` **pass** = `authToken ‖ contentRoot ‖ controlKey ‖ kMeta` (128 B,
HKDF-derived from root secret `S`; `packages/clawsec/src/{kdf,pass}.ts`). A pasted pass or bare-pass QR
is a **forever, symmetric capability** (read **and** steer **and** forge) with no in-place revocation.
Resetting `S` moves future legitimate host service to a new identity but does not invalidate copied
passes on retained old routes. A pass in a URL fragment is not sent as an HTTP request, but the fragment
shields only Referer/server logs—not a screenshot/photo, shoulder-surf, browser history, or third-party
scripts that can read it. The shipped `--rc-qr` path with an app origin therefore uses the
OAuth-auth-code shape below: a single-use, at-most-10-minute handoff token, never a pass deep link.

## 3. Design

### 3.1 Crypto — purpose-built handoff sealer (`packages/clawsec/src/handoff.ts`)

A tiny module mirroring `aead.ts`'s construction (random salt → HKDF subkey → AES-256-GCM) but **not** the
Frame `seal()` (that binds a `FrameHeader` AAD incl. `identityId`, which would leak handoff↔identity). From a
**256-bit CSPRNG OTK** (`crypto.getRandomValues`, 128-bit hard floor — NIST SP 800-63B / OWASP ASVS), derive
**three domain-separated values** (`prk = HKDF-Extract("remote-claw/v1", OTK)`):

- **`id = SHA256(OTK)`** — the public lookup key.
- **`wrapKey = HKDF-Expand(prk, "remote-claw/v1/handoff-wrap", 32)`** — the per-OTK **plane key** (not the
  AES key directly; the AES key is a per-box subkey derived from it below, mirroring `aead.ts`).
- **`claimProof = HKDF-Expand(prk, "remote-claw/v1/handoff-claim", 32)`** — the consume capability (§3.3).

`id` is a **bare unkeyed SHA-256** while `wrapKey`/`claimProof` are **HMAC-keyed HKDF** outputs — *distinct
PRFs of OTK*, so the public `id` is computationally independent of the key/proof (review fix: the prior
"different info label" justification was the wrong mechanism). Each box derives a fresh **per-box AES key**
exactly as `aead.ts` does: `K_box = HKDF-Expand(HKDF-Extract(boxSalt, wrapKey), "remote-claw/v1/handoff-msg"
‖ AAD, 32)` with a fresh random 32 B `boxSalt` + 12 B nonce. Ciphertext = AES-256-GCM (128-bit tag) under
`K_box`, **AAD = `"rc-handoff/v1" ‖ id`** (binds version + id ⇒ no cross-id substitution; one wrap/OTK ⇒
NIST SP 800-38D nonce ceiling is moot). The on-wire box is
**versioned** (`v` field) for format evolution. Codec: `otk1_` + base64url(OTK) (43 chars) + Crockford
checksum (mirrors `pass.ts`). Reuse `hkdf.ts`/`bytes.ts`/`base64url.ts`/`checksum.ts` verbatim; one new file
to review, with round-trip / wrong-OTK / tamper / wrong-version tests.

### 3.2 Store — dedicated, isolated, cloud-primary, atomic

`HandoffStore` (`apps/web/lib/broker/handoff-store.ts`), **separate** from all per-channel frame DBs,
including the per-identity bus DB (coupling to the bus DB would force the broker to learn the identity; the frames log
never partial-deletes). Schema: `handoff(id TEXT PRIMARY KEY, proof_hash TEXT NOT NULL, ct TEXT NOT NULL,
expires_at INTEGER NOT NULL)` + index on `expires_at` (`id`/`proof_hash`/`ct` are stored as **hex TEXT** — the
OTK never reaches the server, so the bytes it does store are hex-encoded one-way hashes + an opaque box).

- **Cloud primary only.** Selected by the broker's env switch via `DbLocator.handoffConfig()` → a dedicated
  Turso DB **`rc-<scope>-hx`**. The `-hx` suffix is distinct from the relay-channel kinds
  (`s`/`b`/`c`/`x`), so it
  is **not** a channel db. It shares the `rc-<scope>-` prefix for naming only; that truncated prefix is
  not exact deployment ownership and never authorizes deletion. The HTTP `/api/dev/sweep` route returns
  501 without constructing a locator. Expired handoff rows are still removed by the dedicated frequent
  sweep and PUT-time opportunistic reaper, while the database container remains retained. The low-level
  `dropScope()` method is available only to explicit diagnostic tooling over a manually reviewed scope.
  The atomic
  guarantee holds only on a single remote primary write path, so **fail closed on Vercel / file mode** (no
  `file:` handoff store on serverless — it's per-instance ephemeral). A two-client concurrent test (file
  libSQL — the same atomic `DELETE…RETURNING` engine as Turso) proves exactly-one-winner.
- **Atomic burn = one statement, burn-on-touch:** `DELETE FROM handoff WHERE id=? AND proof_hash=? RETURNING
  ct, expires_at` — delete unconditionally on a matching `id`+`proof_hash`, then the app **discards `ct` if
  `expires_at ≤ now`** (so an expired row is burned even before the sweep). Exactly one of two concurrent
  claims wins. **Never** SELECT-then-DELETE — which is *why* the proof match is a plain SQL equality on
  `proof_hash` rather than a JS `timingSafeEqual`: the match lives inside the single `DELETE`, and the
  comparand is a 256-bit SHA-256 the attacker cannot iteratively approach, so the equality is not a usable
  timing oracle (a constant-time primitive would buy nothing and would force the forbidden read-then-compare).
  No app-level lock is needed: `claim` is one `client.execute()` and `put` is one `client.batch(…, "write")`
  (libSQL `"write"` opens a `BEGIN IMMEDIATE` transaction), and the dedicated handoff DB has its own client, so
  libSQL serializes the writes on the single primary.
- **Frequent dedicated sweep** (review fix): a **separate cron** (`*/5 * * * *` in `apps/web/vercel.json`)
  running `DELETE FROM handoff WHERE expires_at<=now` — independent of the ordinary channel `sweep()`,
  which is deliberately a no-op — plus an **opportunistic delete batched into every PUT** (`HandoffStore.put` runs the expiry-delete in
  the same write transaction as the insert), so writes reap expired rows even if the cron is degraded. ⚠️ the
  `*/5` cron needs Vercel **Pro** — Hobby silently downgrades sub-daily crons to daily, which is exactly the
  "vercel-default" 24h-persistence failure this guards against, so the PUT-time reaper is the floor on Hobby.
  Document that backups/WAL/PITR are non-erasing (only undecryptable bytes).

### 3.3 Endpoints — `apps/web/app/api/handoff/route.ts` (an unauthenticated high-entropy *capability* endpoint)

- **`PUT`** (host upload): a **route-level body cap before JSON parse** — `MAX_BODY = 8192` bytes, enforced
  *while streaming* so a chunked / missing-`content-length` body can't force an unbounded buffer; an over-cap
  body → **`413`**. Body `{id: 64-hex, proof_hash: 64-hex, ct: hex, ttl?: int}` (all wire values are hex — the
  OTK itself stays base64url in the `#fragment`); `ct` must be **even-length hex bounded to `[MIN_CT_HEX,
  MAX_CT_HEX] = [122, 6144]`** chars — `122` is the floor of a real sealed box (version + 32 B salt + 12 B
  nonce + 16 B GCM tag = 61 B), `6144` ≈ a 3 KiB box — and a `ct` outside that range (or any other malformed
  field) → **`400`** (distinct from the `413` whole-body cap). **TTL clamp:** `ttl` is accepted only as a
  non-negative **safe integer** (else the default is used), then clamped into `[TTL_MIN_S, TTL_MAX_S] =
  [30 s, 600 s]`; **omitted or invalid ⇒ the default, which is the effective ceiling** — `TTL_MAX_S`
  (600 s / 10 min), or the lower `RC_HANDOFF_TTL_MAX_S` when that env is set (the default is `ttlMaxS()`,
  not a hard-coded 600). `TTL_MAX_S` is a code-baked absolute ceiling; the optional `RC_HANDOFF_TTL_MAX_S`
  env can only *lower* it (within `[30, 600]`), never raise it.
  `INSERT … ON CONFLICT(id) DO NOTHING` → **return 409 on conflict** so the
  host **re-mints OTK** rather than publishing a QR for a poisoned row.
- **`POST` (claim):** body `{id: 64-hex, proof: 64-hex}` (`proof = hex(claimProof)`) → atomic burn (§3.2)
  gated on `SHA256(proof) == proof_hash` matched **inside the single `DELETE … WHERE id=? AND proof_hash=?`**
  (a 256-bit hash key, so the equality is not a usable timing oracle) → `{box}` or a **uniform `404`**. Claim is **POST, never GET**. The
  **full non-success contract is fail-closed and uniform**: absent / expired / already-claimed / **bad proof**
  → identical opaque `404`; malformed `{id}` → `400`; **over-cap body → `413`** (PUT and POST alike); backend
  fault (SQLITE_BUSY, exhausted bounded create→serve readiness #346, etc.) → `500` with **no body detail**. `Cache-Control:
  no-store`. The id+proof match is the in-`DELETE` SQL equality from §3.2 (no JS `timingSafeEqual`, and none
  is needed — it compares 256-bit SHA-256 values, not a usable timing oracle).
- **The proof closes the edge-pre-burn (review CONFIRMED):** the claim presents `claimProof`; the server stores
  only `SHA256(claimProof)`. A TLS-terminating edge/log that sees only `id = SHA256(OTK)` **cannot** burn or
  claim (it lacks `claimProof`, which needs OTK). This is **mandatory whenever OTK handoff is enabled**.
- **No Bearer auth** (it would re-introduce handoff↔identity correlation); the **256-bit `id` + proof** are the
  gate. Abuse bounded by: the pre-parse size cap, a **release-gated, live-verified Vercel WAF
  rate-limit rule** on
  `/api/handoff` (matched by `path` prefix) keyed on the platform-trusted client IP — **20 requests / 60 s per IP** (a token bucket;
  excess is denied), the *primary* abuse control. The expected live rule is
  `rule_handoff_per_ip_rate_limit_UWaS5F` (`handoff-per-ip-rate-limit`) in enabled WAF configuration
  `waf_TG8xDULMuMuR` v3 for project `prj_qUeYYc7P87JmsQUipJG0m0kqmYbM` and team
  `team_fYexi4KRmIrq9wtYsiXs9e9H`, with no pending changes, draft, versions, or bypass entries. The trusted
  release runner must verify those exact live coordinates and normalized semantics through the Vercel API
  before handoff is release-enabled. The **global volumetric backstop is Vercel's platform-described
  always-on System Mitigations** (platform-managed automatic DDoS protection) — not a custom rule, so there is no custom
  global counter an attacker could deliberately trip to deny pairings. The honest residual tradeoff runs the
  other way: a coarse per-IP key can throttle legitimate clients behind one shared egress IP (carrier-grade
  NAT), so the per-IP limit is set generously — 20 / 60 s ≫ the ~2 requests a real pairing needs. This
  rate-limit is an **externally provisioned infra deploy gate for any deployment that enables handoff**
  (provisioned in the Vercel Firewall, not in `vercel.json`; live state is checked by the trusted proof —
  §5 #5), atop the short TTL, single-read, and
  the dedicated Turso DB so PUT write-contention can't touch relay frames. **Abuse telemetry lives at the edge, not the app:** the WAF
  dashboard (claim-rate, per-IP throttle hits, brute-force volume) is where §4's online-attack guarantees are
  observed. The serverless route deliberately does **not** log per-claim outcomes (the `id` is public and a
  per-instance function has no actionable signal); a backend fault returns an opaque `500` and self-heals the
  cached client, and store-build failures are logged server-side (`handoff-store.ts`).

### 3.4 QR + web client (with a user gesture and binding)

- `qr.ts`/`pass.ts`: with `--rc-app <origin>`, `runPass` mints OTK, seals the **bare pass** (no separate
  fingerprint field — the pass *determines* the host's `identity_id`, recomputed from its `authToken` on
  parse, which **is** the binding value; see the web client below), `PUT`s `{id, proof_hash, ct}`, and the QR
  carries `<origin>/#otk1_<OTK>`.
  On a `409` it **re-mints and retries**. **Raw-pass output becomes an explicit legacy/export mode:** the
  forever `#rcp1_` **deep-link** QR is dropped (fail closed — a failed handoff upload renders *no* QR, never an
  `#rcp1_` fallback), though `--rc-qr` **without** `--rc-app` still renders the **bare pass** as a QR for
  manual entry (the original behavior, not a deep link), and the bare pass still prints (default mode under a
  hard live-credential warning; `--rc-quiet` prints only the pass, for piping). Host-side **interception
  detection** (a non-consuming `lookup` poll of its own `id` →
  alarm + re-mint if the row vanishes before the phone confirms) is a **deferred follow-up**, not in the
  enabled baseline: the route exposes no lookup verb. In that baseline, §4's "detectable" is delivered
  **viewer-side** (next bullet).
- Web client (`app/page.tsx`): on an `otk1_` fragment, **strip it immediately** (`history.replaceState`), then
  **require an explicit user gesture** ("Pair this device") **before** the destructive POST claim — so a
  webview/prefetch/unfurler that runs JS can't auto-burn it. After the claim, **reveal the resolved pass's
  `identity_id`** for the user to confirm against the host's `--rc-pass` output **before the credential is
  trusted/used** (the binding — anti-QR-swap; RFC 8628/CIBA `binding_message`). The confirm is necessarily
  *after* the claim (the binding value lives inside the sealed box) but *before* connect; if it fails to match,
  the user re-pairs (this is the enabled baseline's viewer-side "detectable"). After a successful claim+confirm, **decrypt,
  wrap the pass with one non-extractable AES-256-GCM device key in IndexedDB, and store only the wrapped
  ciphertext in tab-scoped sessionStorage** (see §3.6) — never a raw pass or OTK in browser storage. Serve
  the route with `Referrer-Policy: no-referrer` + the existing strict
  exfil-blocking CSP. Back-compat: still *accept* a pasted/opened `#rcp1_` for one release (the viewer
  classifies it as a pass and prefills the manual-entry field), but do not *emit* it.

### 3.5 What the OTK delivers (scope) — explicit decision

The implemented OTK flow wraps the **existing `rcp1_` pass** (simplest; trivial migration). This **hardens delivery, not the
credential's authority**: a claimed pass still grants full read+steer and shared-key inbound authority.
Machine reset moves future host service to a new identity but does not revoke copied passes against
retained old routes. A future asymmetric server-output-signature design could prevent a pass holder
from forging projections or announcements; the shipped A0 envelope does not, and Claude 1.0 explicitly
retains that mutually trusted pass-holder model.

> **Deferred follow-ups (higher value, tracked):** (a) deliver a *scoped / expiring / per-viewer-revocable*
> grant so a compromised **viewer** is recoverable without resetting `S`; (b) a **pinned/native client** to
> get true ZK against a malicious app-delivery server (the §1 limit). These are the real residual risks the
> OTK handoff does not by itself remove.

### 3.6 Post-claim storage hardening

After claim, the viewer must **not** keep the raw pass in browser storage. The shipped baseline and a
stronger optional direction are:

- **Non-extractable device key + wrapped tab ciphertext (shipped baseline):**
  `apps/web/app/lib/credential-store.ts` keeps one non-extractable AES-256-GCM device key in IndexedDB
  and stores the wrapped pass ciphertext in tab-scoped sessionStorage. `exportKey()` cannot recover the
  device-key bytes, so a passive dump of either store alone does not reveal the pass. Same-origin
  malicious JavaScript that can access both stores can still ask WebCrypto to unwrap the pass and
  exfiltrate it; this is at-rest storage hardening, not an XSS or compromised-app boundary.
- **WebAuthn `prf` extension (optional, hardware-gated):** wrap the credential with a secret derived **inside
  the platform authenticator** (Secure Enclave / TPM / StrongBox) after a biometric/PIN gesture; IndexedDB
  then holds only a wrapped blob and the unwrap key materializes briefly, only on a hardware-gated touch.

Neither makes a *server-delivered* viewer ZK against its own server (that's the §3.5(b) follow-up).

## 4. Threat model (vs. today's forever-pass-in-fragment)

| Adversary | Today | With OTK handoff |
|---|---|---|
| Leaked QR **screenshot taken at scan time** | **forever** read+steer+forge | holds the OTK ⇒ can claim within the TTL (race the phone); after one claim/10 min, inert |
| Browser history / shoulder-surf / lost phone later | forever | inert after one claim or 10 min |
| Passive network (TLS) | secret never sent | OTK never sent; claim sends `id`+`proof` (both one-way) — broker can't decrypt |
| Honest-but-curious broker / DB+backup dump | holds only routed ciphertext | holds only `id` + `proof_hash` + an **undecryptable** blob (≥2¹²⁸ to invert) |
| **Compromised code/edge broker** | serves the app | **NOT defended** — can ship malicious JS to read the fragment + decrypt (§1 limit; needs native client) |
| Edge/logs **correlation** | n/a | broker learns a handoff *exists* and can **correlate it to an identity** via claim **IP/timing** + the subsequent Bearer relay request (the *row* has no identity; the *traffic* does) |
| Pre-emptive claim / unfurler / prefetch | n/a | needs `claimProof` (⇒ OTK) to burn ⇒ edge-only observer can't; POST + user-gesture stop bots; a failed legit claim is **detectable** viewer-side ("already used" → re-pair) and the host re-mints on lockout |
| Online brute-force of `id` | n/a | 256-bit `id` + uniform 404 ⇒ **structurally** infeasible (these ship in-repo); the WAF rate-limit (infra deploy-gate, §3.3) is DoS/abuse defense-in-depth on top |
| Malicious/compromised **viewer** post-claim | full forever credential | unchanged while resident: same-origin malicious JS can use the non-extractable wrapping key to unwrap and exfiltrate the pass (→ §3.5(a)); §3.6 protects passive storage copies |

**Net:** a clear win for the leaked-QR / history / shoulder-surf / lost-phone threats and it removes the
never-expiring-capability anti-pattern — **conditional on all enabled-feature must-haves shipping together** (§5). It does
**not** make the web client ZK against a malicious app-delivery server, does **not** cryptographically erase
backups, and does **not** reduce the post-claim credential's authority (only passive at-rest exposure). Some
guarantees move from *structural* (secret never sent) to *operational* (atomicity + TTL + sweep + rate-limit).

## 5. Decisions, enabled-feature must-haves, non-goals

**Must-haves whenever QR/OTK handoff is enabled (the net-security claim is conditional on ALL of
these):** (1) atomic burn-on-touch on the
**cloud primary** (fail closed on Vercel/file); (2) **256-bit OTK**, distinct-PRF `id`/`wrapKey`/`claimProof`;
(3) **mandatory claim proof-of-OTK**; (4) **dedicated frequent sweep** + read-time expiry; (5) **mandatory
WAF rate-limit** (uniform fail-closed responses + pre-parse size cap are in-repo, but the **rate-limit rule
itself is an out-of-band infra deploy-gate** — see below); (6) **user gesture before claim** +
**`identity_id` binding** confirmation (the host's identity, recomputed from the pass's `authToken`); (7)
**non-extractable AES device key in IndexedDB + wrapped pass ciphertext in sessionStorage**; (8) PUT
`409`-on-conflict with host
re-mint.

> **#5 is the one enabled-feature must-have provisioned outside the repo.** The per-IP rate-limit rule
> cannot live in `vercel.json`, but the trusted real-topology release proof queries the Vercel API directly
> and fails closed unless the exact project/team, enabled WAF v3 configuration, sole active valid rule,
> `/api/handoff` path-prefix match, 20-per-60-second per-IP token bucket, deny action, and empty bypass list
> match the coordinates above. A passing topology-v4 receipt is the run-specific evidence; its digest and
> execution status live in the PR release record rather than this candidate-bound document. The API does
> not expose System Mitigations, and the proof deliberately does not attest them. When handoff is disabled,
> this conditional gate does not block
> manual-pass Claude 1.0.

- **No PAKE** (high-entropy OTK ⇒ SPAKE2 adds EC-correctness surface for zero gain; NIST SP 800-63B).
- **TTL = 10 min, configurable**, hard-capped; shorter is safer (it's the leaked-QR window).
- **`id = SHA256(OTK)`** is a *capability lookup*, not auth — the endpoint is an unauthenticated high-entropy
  capability endpoint (not "gated like `identity_id`", which is Bearer-recomputed; review fix).
- **Non-goals (deferred follow-ups):** scoped/revocable delivered grant; pinned/native ZK client; WebAuthn-PRF
  hardware wrapping.

## 6. Standards grounding

RFC 5869 (HKDF + domain separation) · NIST SP 800-108r1 / 800-56Cr2 (KDF) · NIST SP 800-38D (GCM) · NIST SP
800-63B (look-up-secret entropy ⇒ no PAKE/stretch needed) · RFC 6749 §4.1.2 / RFC 6819 (single-use ≤10-min
code, reuse-detection) · RFC 8628 / OIDC CIBA (cross-device one-time code; `binding_message`) · W3C Capability
URLs (expire + one-time) · OWASP (Secrets / Crypto-Storage / Session / tokens-in-URL CWE-598 / Forgot-Password)
· HashiCorp Vault response-wrapping + cubbyhole + AppRole (single-use reference, isolation, interception
detection) · WebCrypto non-extractable `CryptoKey` + WebAuthn `prf` (§3.6). Prior art: Yopass, Bitwarden Send,
PrivateBin (#174), Snappass; anti-patterns: OneTimeSecret/Password Pusher (server-readable), Firefox Send (abuse).

## 7. Implementation plan (stacked PRs; gate: biome + tsc + vitest → /code-review + codex → exact-SHA CI gate)

1. **PR1 — clawsec `handoff.ts` + tests** (no behavior change): `generateOtk`, `handoffId`, `claimProof`,
   `sealHandoff`/`openHandoff` (versioned box, AAD), `formatOtk`/`parseOtk`; round-trip / wrong-OTK / tamper /
   wrong-version tests.
2. **PR2 — store + locator + route** (dormant): cloud-primary `HandoffStore` (fail-closed on Vercel/file) +
   `DbLocator.handoffConfig()` (the dedicated, non-per-session `rc-<scope>-hx` name) + `PUT`/`POST /api/handoff`
   (proof-gated atomic burn, uniform fail-closed contract, pre-parse cap, 409); dedicated handoff sweep cron
   (`vercel.json`) + PUT-time opportunistic reaper; two-client concurrent atomic test; contract tests. (The
   **WAF rate-limit rule is out-of-band infra**, provisioned in the Vercel Firewall — not code in this PR.)
3. **PR3 — QR + web client** (flips default): `--rc-app` emits `#otk1_…` (re-mint on 409); the forever
   `#rcp1_` **deep-link** QR is dropped (fail-closed; a bare-pass QR for manual entry still renders when no
   `--rc-app` origin is given, and the legacy `#rcp1_` fragment is accepted for one release); web client =
   strip-fragment → user-gesture → binding-confirm → claim → **non-extractable AES device key in
   IndexedDB + wrapped pass ciphertext in sessionStorage**;
   `no-referrer` + CSP. Live e2e: scan → confirm → claim → viewer loads; second scan → "already used";
   edge-only `id` can't burn.

## 8. Adversarial review (recorded)

**Reviewers:** codex (read-only) + a 7-dimension red-team workflow (42 candidate attacks → 24 refuted → **18
survived**, several invariant-breaking). **Verdict:** *the first draft was "not sound to implement as
written" — it overclaimed.* This revision applies the survivors. Key resolutions:

- **[CRITICAL] ZK vs compromised code/edge** → §1 re-scoped to honest-but-curious + passive observers; the
  malicious-app-delivery-server case is an explicit limit (→ pinned/native client follow-up §3.5(b)).
- **[HIGH] "forget/cannot re-serve" vs WAL/PITR/backups** → §1 downgraded to confidentiality + API-enforced
  one-time; backups documented as non-erasing.
- **[HIGH/CONFIRMED] edge sees `SHA256(OTK)` ⇒ pre-burn/substitute** → claim proof-of-OTK **mandatory when enabled**
  (§3.1/§3.3).
- **[HIGH/CONFIRMED] TTL not physically enforced (daily cron)** → burn-on-touch `DELETE…RETURNING` + discard
  expired + **dedicated frequent sweep** + a **PUT-time opportunistic reaper** (the floor when the `*/5` cron
  is unavailable, e.g. Vercel Hobby) (§3.2).
- **[HIGH/CONFIRMED] handoff↔identity correlation via IP/timing** → §1/§4 scoped honestly (row has no
  identity; traffic does).
- **[MEDIUM] atomic burn only on cloud primary** → fail-closed on Vercel/file + a two-client concurrent test
  (§3.2); **the handoff DB shares the truncated scope prefix** → naming is not deletion authority, so
  `/api/dev/sweep` is disabled (501) and the database container remains retained. Row expiry is enforced
  by the dedicated sweep, burn-on-touch, and PUT-time reaper; `dropScope()` is diagnostic-only.
- **[MEDIUM] unauth PUT dead-drop / clobber** → pre-parse cap + WAF + 409-on-conflict + re-mint (§3.3/§3.4).
- **[MEDIUM] prefetch/unfurler auto-burn; QR-swap** → user gesture before claim + `identity_id` binding
  confirmation (§3.4).
- **[MEDIUM] back-compat keeps the anti-pattern** → drop the forever `#rcp1_` **deep-link** QR; raw pass =
  legacy export (a bare-pass QR for manual entry still renders without `--rc-app`) (§3.4).
- **[LOW] id↔key "independence" / "gated like identity_id" wording** → corrected to distinct-PRFs +
  "unauthenticated capability endpoint" (§3.1/§5).

Residual (accepted, documented): malicious-app-delivery-server (needs native client), backup non-erasure,
post-claim credential authority (mitigated-not-removed by §3.6), and a QR photographed at scan time (bounded
by TTL + one-time).

**Implementation review (PR1–PR3), all applied:** codex + `/code-review` per PR. PR2 — `file:` handoff
hard-fails on Vercel (cloud-primary); streaming pre-buffer body cap; absolute code-baked `TTL_MAX_S`;
dead-client self-heal; opaque sweep error; `no-store` on every response; full cause-chain 404 detect.
PR3 — `--rc-qr --rc-app` **fails closed** (never a forever-pass QR); https-only bypass; origin
validate/normalize; **full** identity_id binding; claim re-entry guard + JSON-parse hardening; §3.6
non-extractable post-claim storage. **Signed off.**
