import { fromHex, sha256, toHex } from "@remote-claw/clawsec";
import { getHandoffStore } from "../../../lib/broker/handoff-store";

// Ephemeral one-time-handoff endpoint (docs/ephemeral-handoff.md). An UNAUTHENTICATED high-entropy
// CAPABILITY endpoint — the 256-bit OTK (and the claim proof derived from it) are the gate, not a Bearer.
// PUT stores a sealed blob keyed by id=SHA256(OTK); POST atomically returns-and-burns it iff the caller
// proves knowledge of the OTK. The server only ever sees one-way hashes + a blob it cannot read.
//
// Abuse is bounded by: a pre-parse body cap, single-read + short TTL, and a MANDATORY platform rate-limit.
//   ⚠️ DEPLOY REQUIREMENT: add a Vercel WAF rate-limit rule on path `/api/handoff` (per-IP token bucket +
//   a low global ceiling). A serverless in-memory limiter is per-instance and unreliable, so the rate limit
//   MUST live at the edge (WAF). This is a §5 must-have, not optional.
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;
const MAX_BODY = 8192; // bytes; a sealed handoff is ~200 B (≈400 hex) — this is generous headroom
const MAX_CT_HEX = 6144; // ≈3 KiB sealed box, hex-encoded
const TTL_MIN_S = 30;

function ttlMaxS(): number {
  const n = Number.parseInt(process.env.RC_HANDOFF_TTL_MAX_S ?? "", 10);
  return Number.isFinite(n) && n >= TTL_MIN_S ? n : 600; // default 10 min, hard-capped
}

/** Read the body with a hard cap BEFORE buffering an attacker-sized payload. Returns null if over-cap. */
async function cappedBody(req: Request): Promise<string | null> {
  const len = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(len) && len > MAX_BODY) return null;
  const text = await req.text();
  return text.length > MAX_BODY ? null : text;
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// PUT: the host uploads a sealed handoff. Returns 200 (stored), 409 (id already taken → host re-mints),
// 400 (malformed), 413 (over-cap), 500 (backend). No auth — the id is the capability.
export async function PUT(req: Request): Promise<Response> {
  const text = await cappedBody(req);
  if (text === null) return Response.json({ error: "too large" }, { status: 413 });
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
    ct.length === 0 ||
    ct.length > MAX_CT_HEX
  ) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  // TTL: accept only a non-negative safe integer, else default; then clamp into [MIN, MAX] (server clock).
  const rawTtl = body?.ttl;
  const ttlReq =
    typeof rawTtl === "number" && Number.isSafeInteger(rawTtl) && rawTtl >= 0 ? rawTtl : ttlMaxS();
  const ttlS = Math.min(Math.max(ttlReq, TTL_MIN_S), ttlMaxS());
  const expiresAt = Date.now() + ttlS * 1000;

  try {
    const store = await getHandoffStore();
    const stored = await store.put(id, proofHash, ct, expiresAt);
    if (!stored) return Response.json({ error: "id exists" }, { status: 409 });
    // Opportunistic cleanup of expired rows (cheap, indexed) — best-effort; never fails the PUT.
    store.sweepExpired(Date.now()).catch(() => {});
    return Response.json({ ok: true, expires_at: expiresAt });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 500 });
  }
}

// POST (claim): the viewer presents id + proof (=hex(claimProof)); the server matches SHA256(proof) against
// the stored proof_hash and atomically burns the row. Returns 200 {box} on success; a UNIFORM 404 for
// absent/expired/already-claimed/bad-proof (no oracle); 400 malformed; 500 backend. Never reveals which.
export async function POST(req: Request): Promise<Response> {
  const text = await cappedBody(req);
  if (text === null) return Response.json({ error: "too large" }, { status: 413 });
  const body = parse(text);
  const id = body?.id;
  const proof = body?.proof;
  if (
    typeof id !== "string" ||
    !HEX64.test(id) ||
    typeof proof !== "string" ||
    !HEX64.test(proof)
  ) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  try {
    const proofHash = toHex(await sha256(fromHex(proof)));
    const store = await getHandoffStore();
    const box = await store.claim(id, proofHash, Date.now());
    if (box === null) return Response.json({ error: "not found" }, { status: 404 }); // uniform miss
    return Response.json({ box }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 500 });
  }
}
