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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Use a local file: handoff store (no Turso env). selectLocatorFromEnv() reads env at call time, so set
// RC_SQLITE_DIR before the first request; clear any Turso vars so FileDbLocator is chosen.
let dir: string;
for (const k of ["TURSO_API_TOKEN", "TURSO_ORG", "TURSO_GROUP", "TURSO_GROUP_AUTH_TOKEN"]) {
  delete process.env[k];
}
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rc-handoff-route-"));
  process.env.RC_SQLITE_DIR = dir;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
});
