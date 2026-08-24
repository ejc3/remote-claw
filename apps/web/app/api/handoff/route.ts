import { fromHex, sha256, toHex } from "@remote-claw/clawsec";
import { getHandoffStore, resetHandoffStore } from "../../../lib/broker/handoff-store";

// Ephemeral one-time-handoff endpoint (docs/ephemeral-handoff.md). An UNAUTHENTICATED high-entropy
// CAPABILITY endpoint — the 256-bit OTK (and the claim proof derived from it) are the gate, not a Bearer.
// PUT stores a sealed blob keyed by id=SHA256(OTK); POST atomically returns-and-burns it iff the caller
// proves knowledge of the OTK. The server only ever sees one-way hashes + a blob it cannot read.
//
// Abuse is bounded by: a streaming pre-buffer body cap, single-read + short TTL, and a MANDATORY platform
// rate-limit. ⚠️ DEPLOY GATE (infra, NOT in repo): a Vercel WAF rate-limit rule on path `/api/handoff`
// (per-IP token bucket), backed by Vercel's always-on System Mitigations for global volumetric abuse.
// A custom global counter is deliberately absent because an attacker could trip it to deny all pairings.
// A serverless in-memory limiter is per-instance and unreliable, so the per-IP limit MUST live at the edge
// (WAF). vercel.json cannot carry firewall rules — provision it via the Vercel dashboard / Firewall API,
// and treat it as a release gate for this route.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;
const MAX_BODY = 8192; // bytes; a sealed handoff is ~200 B (≈400 hex) — generous headroom
const MIN_CT_HEX = 2 * (1 + 32 + 12 + 16); // version + salt + nonce + GCM tag = 61 B = 122 hex
const MAX_CT_HEX = 6144; // ≈3 KiB sealed box, hex-encoded
const TTL_MIN_S = 30;
const TTL_MAX_S = 600; // absolute code-baked ceiling (10 min); env can only LOWER it, never raise it

function ttlMaxS(): number {
  const n = Number.parseInt(process.env.RC_HANDOFF_TTL_MAX_S ?? "", 10);
  // env may tighten the ceiling but never exceed the code-baked TTL_MAX_S, and never below TTL_MIN_S.
  return Number.isFinite(n) && n >= TTL_MIN_S ? Math.min(n, TTL_MAX_S) : TTL_MAX_S;
}

// Every response is no-store (a handoff blob must never be cached by a proxy/CDN).
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

/** Read the body with a hard byte cap enforced WHILE streaming (before fully buffering), so a chunked /
 *  missing-content-length body can't force an unbounded buffer. Returns null if over-cap. */
async function cappedBody(req: Request): Promise<string | null> {
  const len = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(len) && len > MAX_BODY) return null;
  const reader = req.body?.getReader();
  if (reader === undefined) {
    const t = await req.text();
    return t.length > MAX_BODY ? null : t;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > MAX_BODY) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// PUT: the host uploads a sealed handoff. 200 (stored), 409 (id taken → host re-mints), 400 (malformed),
// 413 (over-cap), 500 (backend). No auth — the id is the capability.
export async function PUT(req: Request): Promise<Response> {
  const text = await cappedBody(req);
  if (text === null) return json({ error: "too large" }, 413);
  const body = parse(text);
  const id = body?.id;
  const proofHash = body?.proof_hash;
  const ct = body?.ct;
  if (
    typeof id !== "string" ||
    !HEX64.test(id) ||
    typeof proofHash !== "string" ||
    !HEX64.test(proofHash) ||
    typeof ct !== "string" ||
    !HEX.test(ct) ||
    ct.length % 2 !== 0 ||
    ct.length < MIN_CT_HEX ||
    ct.length > MAX_CT_HEX
  ) {
    return json({ error: "bad request" }, 400);
  }
  // TTL: accept only a non-negative safe integer, else default; then clamp into [MIN, MAX] (server clock).
  const rawTtl = body?.ttl;
  const ttlReq =
    typeof rawTtl === "number" && Number.isSafeInteger(rawTtl) && rawTtl >= 0 ? rawTtl : ttlMaxS();
  const ttlS = Math.min(Math.max(ttlReq, TTL_MIN_S), ttlMaxS());
  const now = Date.now();
  const expiresAt = now + ttlS * 1000;

  try {
    const store = await getHandoffStore();
    // put() also reaps expired rows in the same write (opportunistic GC); pass the same clock read.
    const stored = await store.put(id, proofHash, ct, expiresAt, now);
    if (!stored) return json({ error: "id exists" }, 409);
    return json({ ok: true, expires_at: expiresAt });
  } catch {
    resetHandoffStore(); // a dead cached client self-heals on the next request
    return json({ error: "unavailable" }, 500);
  }
}

// POST (claim): the viewer presents id + proof (=hex(claimProof)); the server matches SHA256(proof) against
// the stored proof_hash and atomically burns the row. 200 {box} on success; a UNIFORM 404 for
// absent/expired/already-claimed/bad-proof (no oracle); 400 malformed; 413 over-cap; 500 backend.
export async function POST(req: Request): Promise<Response> {
  const text = await cappedBody(req);
  if (text === null) return json({ error: "too large" }, 413);
  const body = parse(text);
  const id = body?.id;
  const proof = body?.proof;
  if (
    typeof id !== "string" ||
    !HEX64.test(id) ||
    typeof proof !== "string" ||
    !HEX64.test(proof)
  ) {
    return json({ error: "bad request" }, 400);
  }
  try {
    const proofHash = toHex(await sha256(fromHex(proof)));
    const store = await getHandoffStore();
    const box = await store.claim(id, proofHash, Date.now());
    if (box === null) return json({ error: "not found" }, 404); // uniform miss
    return json({ box });
  } catch {
    resetHandoffStore();
    return json({ error: "unavailable" }, 500);
  }
}
