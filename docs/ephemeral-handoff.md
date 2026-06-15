# Ephemeral one-time credential handoff (OTK)

**Status:** **SHIPPED** — PR1 (clawsec `handoff.ts`), PR2 (zero-knowledge `HandoffStore` + `/api/handoff`),
PR3 (QR `otk1_` + web client + §3.6 non-extractable storage). Research-grounded (8-angle workflow) **and
adversarially reviewed** (codex + 7-dimension red-team on the design; codex + `/code-review` per PR; all
resolutions in §8). The §1 invariant was honestly scoped after review.
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
HKDF-derived from root secret `S`; `packages/clawsec/src/{kdf,pass}.ts`). `--rc-qr` puts it in a QR deep link
`<origin>/#<pass>`. It rides the `#fragment` (never sent to a server) — but it is a **forever, symmetric
capability** (read **and** steer **and** forge; revoke only by resetting `S`), the textbook W3C
"capability-URL as forever credential" anti-pattern. The fragment shields only Referer/server-logs, not a QR
screenshot/photo, shoulder-surf, browser history, or third-party scripts (which can read the fragment). A
leaked QR = forever control. The fix is the OAuth-auth-code shape (RFC 6749 §4.1.2: single-use, ≤10 min).

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

`HandoffStore` (`apps/web/lib/broker/handoff-store.ts`), **separate** from the per-session frames DBs and the
per-identity bus DB (coupling to the bus DB would force the broker to learn the identity; the frames log
never partial-deletes). Schema: `handoff(id TEXT PRIMARY KEY, proof_hash BLOB NOT NULL, ct BLOB NOT NULL,
expires_at INTEGER NOT NULL)` + index on `expires_at`.

- **Cloud primary only.** Selected by the broker's env switch via `DbLocator.handoffConfig()` → a dedicated
  Turso DB **`rc-<scope>-hx`** (note: a **non-`rc-<scope>-` -session-shaped name** so the dev/CI `dropScope`
  prefix sweep does not nuke it — review fix; give it its own cleanup). The atomic guarantee holds only on a
  single remote primary write path, so **fail closed on Vercel / file mode** (no `file:` handoff store on
  serverless — it's per-instance ephemeral). Add a two-client concurrent-Turso test proving exactly-one-winner.
- **Atomic burn = one statement, burn-on-touch:** `DELETE FROM handoff WHERE id=?1 AND proof_match RETURNING
  ct, expires_at` — delete unconditionally on a valid `id`+proof, then the app **discards `ct` if
  `expires_at ≤ now`** (so an expired row is burned even before the sweep). Exactly one of two concurrent
  claims wins. **Never** SELECT-then-DELETE. `proof_match` = constant-time compare of `SHA256(claimProof)`
  against the stored `proof_hash` (§3.3). Reuse `sqlite-multi.ts` `withWriteLock`/`runWriteTransaction`.
- **Frequent dedicated sweep** (review fix): a **separate cron** (e.g. `*/5 * * * *`) running
  `DELETE FROM handoff WHERE expires_at<=now` — NOT the once-daily, sqlite-gated session-retention cron — plus
  opportunistic delete on each PUT. Document that backups/WAL/PITR are non-erasing (only undecryptable bytes).

### 3.3 Endpoints — `apps/web/app/api/handoff/route.ts` (an unauthenticated high-entropy *capability* endpoint)

- **`PUT`** (host upload): a **route-level body cap before JSON parse**; body `{id: 64-hex, proof_hash: 64-hex,
  ct: hex, ttl?: int}` (all wire values are hex — the OTK itself stays base64url in the `#fragment`). Validate
  `ttl` like `retentionMs` (non-negative **safe integer**, else default 600 s) then clamp to a **code-baked
  `[MIN, MAX]`** (default 600 s). `INSERT … ON CONFLICT(id) DO NOTHING` → **return 409 on conflict** so the
  host **re-mints OTK** rather than publishing a QR for a poisoned row.
- **`POST` (claim):** body `{id: 64-hex, proof: 64-hex}` (`proof = hex(claimProof)`) → atomic burn (§3.2)
  gated on `SHA256(proof) == proof_hash` matched **inside the single `DELETE … WHERE id=? AND proof_hash=?`**
  (a 256-bit hash key, so the equality is not a usable timing oracle) → `{box}` or a **uniform `404`**. Claim is **POST, never GET**. The
  **full non-success contract is fail-closed and uniform**: absent / expired / already-claimed / **bad proof**
  → identical opaque `404`; malformed `{id}`/over-size → `400`; backend fault (SQLITE_BUSY, create→serve race
  #346, etc.) → `500` with **no body detail**. `Cache-Control: no-store`. Constant-time id+proof handling
  (`timingSafeEqual`).
- **The proof closes the edge-pre-burn (review CONFIRMED):** the claim presents `claimProof`; the server stores
  only `SHA256(claimProof)`. A TLS-terminating edge/log that sees only `id = SHA256(OTK)` **cannot** burn or
  claim (it lacks `claimProof`, which needs OTK). This is **mandatory in v1** (no longer deferred).
- **No Bearer auth** (it would re-introduce handoff↔identity correlation); the **256-bit `id` + proof** are the
  gate. Abuse bounded by: the pre-parse size cap, a **mandatory Vercel WAF rate-limit rule** on
  `path=/api/handoff` keyed on the platform-trusted client IP (per-IP token bucket + a low global ceiling —
  *enumerated as a v1 must-have, not prose*), the short TTL, single-read, and the dedicated Turso DB so PUT
  write-contention can't touch session frames.

### 3.4 QR + web client (with a user gesture and binding)

- `qr.ts`/`pass.ts`: with `--rc-app <origin>`, `runPass` mints OTK, seals the pass (+ a short **host
  fingerprint/title** for binding), `PUT`s `{id, proof_hash, ct}`, and the QR carries `<origin>/#otk1_<OTK>`.
  On a `409` it **re-mints and retries**. **Raw-pass output becomes an explicit legacy/export mode** and the
  `rcp1_` **QR/deep-link path is dropped** (keeps "replace" real; a bare pass still prints for piping with a
  hard warning). Optional host-side **interception detection**: a non-consuming `lookup` poll of its own `id`;
  if the row is gone before the phone confirms → alarm + re-mint (delivers §4's "detectable").
- Web client (`app/page.tsx`): on an `otk1_` fragment, **strip it immediately** (`history.replaceState`), then
  **require an explicit user gesture** ("Pair this device") **before** the destructive POST claim — so a
  webview/prefetch/unfurler that runs JS can't auto-burn it. Show the **host fingerprint/title (binding) for
  the user to confirm** before trusting the resolved pass (anti-QR-swap; RFC 8628/CIBA `binding_message`).
  After a successful claim, **decrypt, then store the credential as non-extractable WebCrypto `CryptoKey`s in
  IndexedDB** (see §3.6) — never the raw pass; never the OTK. Serve the route with `Referrer-Policy:
  no-referrer` + the existing strict exfil-blocking CSP. Back-compat: still *accept* a pasted `#rcp1_` for one
  release (with a deprecation warning), but do not *emit* it.

### 3.5 What the OTK delivers (scope) — explicit decision

v1 wraps the **existing `rcp1_` pass** (simplest; trivial migration). This **hardens delivery, not the
credential's authority**: a claimed pass is still full read+steer+forge, revocable only by machine reset.

> **Deferred follow-ups (higher value, tracked):** (a) deliver a *scoped / expiring / per-viewer-revocable*
> grant so a compromised **viewer** is recoverable without resetting `S`; (b) a **pinned/native client** to
> get true ZK against a malicious app-delivery server (the §1 limit). These are the real residual risks the
> OTK handoff does not by itself remove.

### 3.6 Post-claim storage hardening (browser enclave) — answers "can the key be un-fetchable?"

After claim, the viewer must **not** keep the pass as bytes. Two levels, both supported by browsers today:

- **Non-extractable `CryptoKey` + IndexedDB (baseline, cheap):** import the operational keys with
  `extractable:false` and `put()` the `CryptoKey` handles into IndexedDB. `exportKey()` then throws and **no
  JS — including injected XSS — can read the raw bytes**; the viewer can only *use* them via WebCrypto. This
  stops *exfiltration/portability* of the forever-credential (a storage dump or later XSS can't walk away with
  it). It does **not** stop *use-while-resident* (a live XSS can still call `decrypt()`), and it is software,
  not hardware, isolation.
- **WebAuthn `prf` extension (optional, hardware-gated):** wrap the credential with a secret derived **inside
  the platform authenticator** (Secure Enclave / TPM / StrongBox) after a biometric/PIN gesture; IndexedDB
  then holds only a wrapped blob and the unwrap key materializes briefly, only on a hardware-gated touch.

Neither makes a *server-delivered* viewer ZK against its own server (that's the §3.5(b) follow-up) — but both
materially shrink the §3.5(a) post-claim residual, so the baseline **shipped** in v1
(`apps/web/app/lib/credential-store.ts`): a non-extractable AES-256-GCM device key in IndexedDB wraps the
tab-scoped (sessionStorage) ciphertext, so `exportKey()` throws and a storage dump can't recover the pass.

## 4. Threat model (vs. today's forever-pass-in-fragment)

| Adversary | Today | With OTK handoff |
|---|---|---|
| Leaked QR **screenshot taken at scan time** | **forever** read+steer+forge | holds the OTK ⇒ can claim within the TTL (race the phone); after one claim/10 min, inert |
| Browser history / shoulder-surf / lost phone later | forever | inert after one claim or 10 min |
| Passive network (TLS) | secret never sent | OTK never sent; claim sends `id`+`proof` (both one-way) — broker can't decrypt |
| Honest-but-curious broker / DB+backup dump | holds only routed ciphertext | holds only `id` + `proof_hash` + an **undecryptable** blob (≥2¹²⁸ to invert) |
| **Compromised code/edge broker** | serves the app | **NOT defended** — can ship malicious JS to read the fragment + decrypt (§1 limit; needs native client) |
| Edge/logs **correlation** | n/a | broker learns a handoff *exists* and can **correlate it to an identity** via claim **IP/timing** + the subsequent Bearer relay request (the *row* has no identity; the *traffic* does) |
| Pre-emptive claim / unfurler / prefetch | n/a | needs `claimProof` (⇒ OTK) to burn ⇒ edge-only observer can't; POST + user-gesture stop bots; re-mint on lockout |
| Online brute-force of `id` | n/a | 256-bit + WAF rate-limit + uniform 404 ⇒ infeasible |
| Malicious/compromised **viewer** post-claim | full forever credential | exfiltration blocked by §3.6 non-extractable storage; *use-while-resident* unchanged (→ §3.5(a)) |

**Net:** a clear win for the leaked-QR / history / shoulder-surf / lost-phone threats and it removes the
never-expiring-capability anti-pattern — **conditional on the v1 must-haves shipping together** (§5). It does
**not** make the web client ZK against a malicious app-delivery server, does **not** cryptographically erase
backups, and does **not** reduce the post-claim credential's authority (only its exfiltration). Some
guarantees move from *structural* (secret never sent) to *operational* (atomicity + TTL + sweep + rate-limit).

## 5. Decisions, v1 must-haves, non-goals

**v1 must-haves (the net-security claim is conditional on ALL of these):** (1) atomic burn-on-touch on the
**cloud primary** (fail closed on Vercel/file); (2) **256-bit OTK**, distinct-PRF `id`/`wrapKey`/`claimProof`;
(3) **mandatory claim proof-of-OTK**; (4) **dedicated frequent sweep** + read-time expiry; (5) **mandatory
WAF rate-limit** + uniform fail-closed responses + pre-parse size cap; (6) **user gesture before claim** +
**binding fingerprint** confirmation; (7) **non-extractable CryptoKey + IndexedDB** for the resolved
credential; (8) PUT `409`-on-conflict with host re-mint.

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

## 7. Implementation plan (stacked PRs; gate: biome + tsc + vitest → /code-review + codex → CI green)

1. **PR1 — clawsec `handoff.ts` + tests** (no behavior change): `generateOtk`, `handoffId`, `claimProof`,
   `sealHandoff`/`openHandoff` (versioned box, AAD), `formatOtk`/`parseOtk`; round-trip / wrong-OTK / tamper /
   wrong-version tests.
2. **PR2 — store + locator + route** (dormant): cloud-primary `HandoffStore` (fail-closed on Vercel/file) +
   `DbLocator.handoffConfig()` (the `rc-<scope>-hx` non-session name) + `PUT`/`POST /api/handoff` (proof-gated
   atomic burn, uniform fail-closed contract, pre-parse cap, 409); dedicated handoff sweep cron + WAF rule;
   concurrent-Turso atomic test; contract tests.
3. **PR3 — QR + web client** (flips default): `--rc-app` emits `#otk1_…` (re-mint on 409); legacy raw-pass
   export mode (drop `rcp1_` QR/deep-link emission, accept-only one release); web client = strip-fragment →
   user-gesture → binding-confirm → claim → **non-extractable CryptoKey + IndexedDB**; `no-referrer` + CSP.
   Live e2e: scan → confirm → claim → viewer loads; second scan → "already used"; edge-only `id` can't burn.

## 8. Adversarial review (recorded)

**Reviewers:** codex (read-only) + a 7-dimension red-team workflow (42 candidate attacks → 24 refuted → **18
survived**, several invariant-breaking). **Verdict:** *the first draft was "not sound to implement as
written" — it overclaimed.* This revision applies the survivors. Key resolutions:

- **[CRITICAL] ZK vs compromised code/edge** → §1 re-scoped to honest-but-curious + passive observers; the
  malicious-app-delivery-server case is an explicit limit (→ pinned/native client follow-up §3.5(b)).
- **[HIGH] "forget/cannot re-serve" vs WAL/PITR/backups** → §1 downgraded to confidentiality + API-enforced
  one-time; backups documented as non-erasing.
- **[HIGH/CONFIRMED] edge sees `SHA256(OTK)` ⇒ pre-burn/substitute** → claim proof-of-OTK **mandatory v1**
  (§3.1/§3.3).
- **[HIGH/CONFIRMED] TTL not physically enforced (daily cron)** → burn-on-touch `DELETE…RETURNING` + discard
  expired + **dedicated frequent sweep** (§3.2).
- **[HIGH/CONFIRMED] handoff↔identity correlation via IP/timing** → §1/§4 scoped honestly (row has no
  identity; traffic does).
- **[MEDIUM] atomic burn only on cloud primary** → fail-closed on Vercel/file + concurrent-Turso test (§3.2);
  **dropScope prefix would nuke the handoff DB** → renamed `rc-<scope>-hx` + own cleanup.
- **[MEDIUM] unauth PUT dead-drop / clobber** → pre-parse cap + WAF + 409-on-conflict + re-mint (§3.3/§3.4).
- **[MEDIUM] prefetch/unfurler auto-burn; QR-swap** → user gesture before claim + binding fingerprint (§3.4).
- **[MEDIUM] back-compat keeps the anti-pattern** → drop `rcp1_` QR emission; raw pass = legacy export (§3.4).
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
