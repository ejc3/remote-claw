import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeHandoffBox,
  generateOtk,
  handoffClaimProof,
  handoffId,
  handoffProofHash,
  sealHandoff,
  toHex,
  utf8,
} from "@remote-claw/clawsec";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Use a local file: handoff store (no Turso env). selectLocatorFromEnv() reads env at call time, so set
// RC_SQLITE_DIR + clear any Turso vars before the first request — and RESTORE them after so this file can't
// leak env into sibling suites if vitest isolation is ever relaxed.
const TURSO_KEYS = [
  "TURSO_API_TOKEN",
  "TURSO_ORG",
  "TURSO_GROUP",
  "TURSO_GROUP_AUTH_TOKEN",
] as const;
let dir: string;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of TURSO_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Clear two more the route reads, so an ambient env can't break the suite: VERCEL=1 makes the file:
  // handoff store fail closed (every PUT → 500), and RC_HANDOFF_TTL_MAX_S would lower the ceiling the
  // top-level TTL tests assert. (The nested RC_HANDOFF_TTL_MAX_S describe re-manages it per-test.)
  for (const k of ["VERCEL", "RC_HANDOFF_TTL_MAX_S", "NEXT_PUBLIC_RC_HANDOFF_ENABLED"] as const) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  saved.RC_SQLITE_DIR = process.env.RC_SQLITE_DIR;
  dir = mkdtempSync(join(tmpdir(), "rc-handoff-route-"));
  process.env.RC_SQLITE_DIR = dir;
  process.env.NEXT_PUBLIC_RC_HANDOFF_ENABLED = "1";
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const req = (method: string, body: unknown): Request =>
  new Request("https://x/api/handoff", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function mint() {
  const otk = generateOtk();
  const id = toHex(await handoffId(otk));
  const claimProof = await handoffClaimProof(otk);
  return {
    id,
    proof_hash: toHex(await handoffProofHash(claimProof)),
    proof: toHex(claimProof),
    ct: toHex(encodeHandoffBox(await sealHandoff(otk, utf8("rcp1_PASS")))),
  };
}

describe("/api/handoff route", () => {
  it("PUT then POST round-trips; second POST is a uniform 404", async () => {
    const { PUT, POST } = await import("../../app/api/handoff/route");
    const m = await mint();
    const put = await PUT(req("PUT", { id: m.id, proof_hash: m.proof_hash, ct: m.ct }));
    expect(put.status).toBe(200);

    const claim = await POST(req("POST", { id: m.id, proof: m.proof }));
    expect(claim.status).toBe(200);
    expect((await claim.json()).box).toBe(m.ct);

    const again = await POST(req("POST", { id: m.id, proof: m.proof }));
    expect(again.status).toBe(404); // one-time
  });

  it("PUT of a duplicate id is 409 (host re-mints)", async () => {
    const { PUT } = await import("../../app/api/handoff/route");
    const m = await mint();
    expect((await PUT(req("PUT", { id: m.id, proof_hash: m.proof_hash, ct: m.ct }))).status).toBe(
      200,
    );
    expect((await PUT(req("PUT", { id: m.id, proof_hash: m.proof_hash, ct: m.ct }))).status).toBe(
      409,
    );
  });

  it("POST with a wrong proof is a uniform 404 and does not burn the row", async () => {
    const { PUT, POST } = await import("../../app/api/handoff/route");
    const m = await mint();
    await PUT(req("PUT", { id: m.id, proof_hash: m.proof_hash, ct: m.ct }));
    const wrongProof = toHex(await handoffClaimProof(generateOtk())); // a proof for a different OTK
    expect((await POST(req("POST", { id: m.id, proof: wrongProof }))).status).toBe(404);
    expect((await POST(req("POST", { id: m.id, proof: m.proof }))).status).toBe(200); // real proof still works
  });

  it("malformed bodies are rejected (400), oversize is 413", async () => {
    const { PUT, POST } = await import("../../app/api/handoff/route");
    expect((await PUT(req("PUT", { id: "nothex", proof_hash: "x", ct: "y" }))).status).toBe(400);
    expect((await POST(req("POST", { id: "short" }))).status).toBe(400);
    const huge = await PUT(
      req("PUT", { id: "a".repeat(64), proof_hash: "b".repeat(64), ct: "f".repeat(9000) }),
    );
    expect(huge.status).toBe(413);
  });

  it("rejects ct that is too short / odd-length (not a real box)", async () => {
    const { PUT } = await import("../../app/api/handoff/route");
    const short = await PUT(
      req("PUT", { id: "a".repeat(64), proof_hash: "b".repeat(64), ct: "abcd" }),
    );
    expect(short.status).toBe(400);
    const odd = await PUT(
      req("PUT", { id: "a".repeat(64), proof_hash: "b".repeat(64), ct: "f".repeat(201) }),
    );
    expect(odd.status).toBe(400);
  });

  it("every response is Cache-Control: no-store", async () => {
    const { PUT, POST } = await import("../../app/api/handoff/route");
    const m = await mint();
    const put = await PUT(req("PUT", { id: m.id, proof_hash: m.proof_hash, ct: m.ct }));
    expect(put.headers.get("cache-control")).toBe("no-store");
    const claim = await POST(req("POST", { id: m.id, proof: m.proof }));
    expect(claim.headers.get("cache-control")).toBe("no-store");
    const miss = await POST(req("POST", { id: m.id, proof: m.proof })); // 404 path
    expect(miss.headers.get("cache-control")).toBe("no-store");
  });
});

// The TTL clamp is the leaked-QR-window bound (§5): a requested ttl is clamped into the code-baked
// [30s, 600s] range, and an absent/invalid ttl defaults to the 600s ceiling. This was previously
// unprobed and unit-untested (caught by the adversarial completeness critic).
describe("/api/handoff TTL clamp", () => {
  // Returns the granted window (seconds), rounded — expires_at uses the server clock inside the route.
  async function windowS(ttl?: number): Promise<number> {
    const { PUT } = await import("../../app/api/handoff/route");
    const m = await mint();
    const body: Record<string, unknown> = { id: m.id, proof_hash: m.proof_hash, ct: m.ct };
    if (ttl !== undefined) body.ttl = ttl;
    const before = Date.now();
    const res = await PUT(req("PUT", body));
    expect(res.status).toBe(200);
    const { expires_at } = (await res.json()) as { expires_at: number };
    return Math.round((expires_at - before) / 1000);
  }

  it("clamps a huge ttl DOWN to the 600s ceiling (the window can never be widened)", async () => {
    const w = await windowS(1_000_000_000);
    expect(w).toBeGreaterThanOrEqual(599);
    expect(w).toBeLessThanOrEqual(601);
  });

  it("clamps a tiny ttl UP to the 30s floor", async () => {
    const w = await windowS(5);
    expect(w).toBeGreaterThanOrEqual(30);
    expect(w).toBeLessThanOrEqual(31);
  });

  it("honors an in-range ttl", async () => {
    const w = await windowS(120);
    expect(w).toBeGreaterThanOrEqual(119);
    expect(w).toBeLessThanOrEqual(121);
  });

  it("defaults to the 600s ceiling when ttl is absent, negative, or non-integer", async () => {
    // Bound BOTH sides: a regression that widened the default past the ceiling must also fail here.
    for (const ttl of [undefined, -5, 3.5]) {
      const w = await windowS(ttl);
      expect(w, `ttl=${ttl}`).toBeGreaterThanOrEqual(599);
      expect(w, `ttl=${ttl}`).toBeLessThanOrEqual(601);
    }
  });

  // RC_HANDOFF_TTL_MAX_S can TIGHTEN the window (a stricter deploy) but never widen it past the code ceiling.
  describe("RC_HANDOFF_TTL_MAX_S can only LOWER the ceiling", () => {
    let savedMax: string | undefined;
    beforeEach(() => {
      savedMax = process.env.RC_HANDOFF_TTL_MAX_S;
    });
    afterEach(() => {
      if (savedMax === undefined) delete process.env.RC_HANDOFF_TTL_MAX_S;
      else process.env.RC_HANDOFF_TTL_MAX_S = savedMax;
    });

    it("lowers the ceiling: a 600s request is clamped down to the env max", async () => {
      process.env.RC_HANDOFF_TTL_MAX_S = "120";
      const w = await windowS(600);
      expect(w).toBeGreaterThanOrEqual(119);
      expect(w).toBeLessThanOrEqual(121);
    });

    it("ignores an env max below the 30s floor → stays at the 600s code ceiling", async () => {
      process.env.RC_HANDOFF_TTL_MAX_S = "5";
      const w = await windowS(600);
      expect(w).toBeGreaterThanOrEqual(599); // below-floor env ignored → not clamped down to ~5s
      expect(w).toBeLessThanOrEqual(601);
    });

    it("cannot RAISE the ceiling above the code-baked 600s", async () => {
      process.env.RC_HANDOFF_TTL_MAX_S = "100000";
      // REQUEST more than the code ceiling: if env could raise it, the window would exceed 600. Requesting
      // 600 (as before) was a no-op here — min(600, anything) is always 600 — so this must ask for 5000.
      const w = await windowS(5000);
      expect(w).toBeGreaterThanOrEqual(599);
      expect(w).toBeLessThanOrEqual(601);
    });
  });
});

// The body cap is enforced WHILE streaming (cappedBody), and the ct length bound is a separate 400 — distinct
// from the 413 body cap. These probe the boundary between them and the no-content-length streaming path.
describe("/api/handoff size + streaming caps", () => {
  it("rejects ct longer than MAX_CT_HEX with 400 even when the whole body is under the byte cap", async () => {
    const { PUT } = await import("../../app/api/handoff/route");
    // 6146 hex chars: even + valid hex + > MAX_CT_HEX (6144), yet the full JSON body stays < MAX_BODY (8192),
    // so this must be a 400 (ct-too-long), NOT a 413 (body cap).
    const res = await PUT(
      req("PUT", { id: "a".repeat(64), proof_hash: "b".repeat(64), ct: "ab".repeat(3073) }),
    );
    expect(res.status).toBe(400);
  });

  it("caps the POST (claim) body too — oversize is 413", async () => {
    const { POST } = await import("../../app/api/handoff/route");
    const res = await POST(
      req("POST", { id: "a".repeat(64), proof: "b".repeat(64), junk: "x".repeat(9000) }),
    );
    expect(res.status).toBe(413);
  });

  it("caps a streamed body with NO content-length WHILE reading — cancels mid-stream, never buffers it all", async () => {
    const { PUT } = await import("../../app/api/handoff/route");
    // Many small chunks (10 × 2000 B = 20000 B, well over MAX_BODY) fed lazily via pull(), so we can observe
    // HOW MUCH the route drained. A regression that buffered the whole body (req.text()) before checking would
    // pull all 10 chunks; the streaming cap must bail (and cancel) after only a few.
    const CHUNK = new Uint8Array(2000);
    let pulled = 0;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled < 10) {
          pulled++;
          c.enqueue(CHUNK);
        } else {
          c.close();
        }
      },
      cancel() {
        canceled = true;
      },
    });
    const r = new Request("https://x/api/handoff", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half", // required by Node/undici for a stream body; not in the lib DOM RequestInit type
    } as RequestInit & { duplex: "half" });
    expect(r.headers.get("content-length")).toBeNull(); // precondition: exercising the streaming path

    expect((await PUT(r)).status).toBe(413);
    // Proof the cap fired DURING the read, not after fully buffering: the route stopped well short of all
    // 10 chunks and cancelled the stream.
    expect(pulled).toBeLessThan(10);
    expect(canceled).toBe(true);
  });
});
