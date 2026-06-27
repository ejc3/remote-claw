import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeHandoffBox,
  encodeHandoffBox,
  fromHex,
  generateOtk,
  handoffClaimProof,
  handoffId,
  handoffProofHash,
  openHandoff,
  sealHandoff,
  sha256,
  toHex,
  utf8,
} from "@remote-claw/clawsec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HandoffStore, handoffStoreForTest } from "../../lib/broker/handoff-store";
import { FileDbLocator } from "../../lib/broker/sqlite-multi";

const PASS = "rcp1_A_VIEWER_PASS_payload";

// Build the (id, proof_hash, proof-the-viewer-sends, ct) tuple for a fresh OTK, exactly as the host (PUT)
// and viewer (POST) would. The server stores proof_hash and matches SHA256(proof) against it.
async function mint(plaintext = utf8(PASS)) {
  const otk = generateOtk();
  const id = toHex(await handoffId(otk));
  const claimProof = await handoffClaimProof(otk);
  const proofHash = toHex(await handoffProofHash(claimProof)); // what the host PUTs
  const proofHex = toHex(claimProof); // what the viewer POSTs
  const ct = toHex(encodeHandoffBox(await sealHandoff(otk, plaintext)));
  // What the server computes from the POSTed proof to match the stored proof_hash:
  const serverProofHash = toHex(await sha256(fromHex(proofHex)));
  expect(serverProofHash).toBe(proofHash); // host-stored hash == server-recomputed hash
  return { otk, id, proofHash, serverProofHash, ct };
}

describe("HandoffStore (file: libSQL)", () => {
  let dir: string;
  let store: HandoffStore;
  let locator: FileDbLocator;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "rc-handoff-"));
    locator = new FileDbLocator(dir);
    store = await handoffStoreForTest(locator);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("put → claim round-trips and the ct opens with the OTK", async () => {
    const m = await mint();
    expect(await store.put(m.id, m.proofHash, m.ct, Date.now() + 60_000)).toBe(true);
    const box = await store.claim(m.id, m.serverProofHash, Date.now());
    expect(box).toBe(m.ct);
    const out = await openHandoff(m.otk, decodeHandoffBox(fromHex(box as string)));
    expect(new TextDecoder().decode(out)).toBe(PASS);
  });

  it("a second claim of the same id returns null (one-time burn)", async () => {
    const m = await mint();
    await store.put(m.id, m.proofHash, m.ct, Date.now() + 60_000);
    expect(await store.claim(m.id, m.serverProofHash, Date.now())).toBe(m.ct);
    expect(await store.claim(m.id, m.serverProofHash, Date.now())).toBeNull();
  });

  it("a WRONG proof never returns the ct and never burns the row", async () => {
    const m = await mint();
    await store.put(m.id, m.proofHash, m.ct, Date.now() + 60_000);
    const wrong = toHex(await sha256(utf8("not the proof")));
    expect(await store.claim(m.id, wrong, Date.now())).toBeNull();
    // the row survived a wrong-proof attempt → the real proof still works
    expect(await store.claim(m.id, m.serverProofHash, Date.now())).toBe(m.ct);
  });

  it("an EXPIRED row is not served, and is burned on the touch", async () => {
    const m = await mint();
    await store.put(m.id, m.proofHash, m.ct, Date.now() - 1); // already expired
    expect(await store.claim(m.id, m.serverProofHash, Date.now())).toBeNull();
    // it was deleted by that claim → even a second attempt is gone (not a re-serve)
    expect(await store.claim(m.id, m.serverProofHash, Date.now())).toBeNull();
  });

  it("PUT is first-writer-wins on id collision (409 signal)", async () => {
    const m = await mint();
    expect(await store.put(m.id, m.proofHash, m.ct, Date.now() + 60_000)).toBe(true);
    expect(await store.put(m.id, m.proofHash, "deadbeef", Date.now() + 60_000)).toBe(false);
  });

  it("CONCURRENT claims across two connections yield exactly one winner", async () => {
    const m = await mint();
    await store.put(m.id, m.proofHash, m.ct, Date.now() + 60_000);
    // two SEPARATE clients to the same file db → a real two-connection race (SQLite serializes writes)
    const a = await handoffStoreForTest(locator);
    const b = await handoffStoreForTest(locator);
    try {
      const [ra, rb] = await Promise.all([
        a.claim(m.id, m.serverProofHash, Date.now()),
        b.claim(m.id, m.serverProofHash, Date.now()),
      ]);
      const wins = [ra, rb].filter((x) => x === m.ct).length;
      const misses = [ra, rb].filter((x) => x === null).length;
      expect(wins).toBe(1);
      expect(misses).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });

  it("sweepExpired removes only expired rows", async () => {
    const live = await mint();
    const dead = await mint();
    await store.put(live.id, live.proofHash, live.ct, Date.now() + 60_000);
    await store.put(dead.id, dead.proofHash, dead.ct, Date.now() - 1);
    expect(await store.sweepExpired(Date.now())).toBe(1);
    expect(await store.claim(live.id, live.serverProofHash, Date.now())).toBe(live.ct);
  });

  it("PUT opportunistically reaps expired rows in the same write (GC on every write)", async () => {
    const dead = await mint();
    const fresh = await mint();
    const t0 = 1_000_000_000_000;
    // Store an already-expired row (its own PUT's opportunistic DELETE runs before its INSERT, so it lands).
    await store.put(dead.id, dead.proofHash, dead.ct, t0 - 1, t0 - 1000);
    // A later PUT of a DIFFERENT row reaps the expired one in the same write transaction — not via claim/cron.
    expect(await store.put(fresh.id, fresh.proofHash, fresh.ct, t0 + 60_000, t0)).toBe(true);
    // Observe the PHYSICAL reap via sweepExpired (claim() can't: it burns-on-touch-expired itself, so it
    // returns null whether or not the PUT already reaped). If the PUT didn't reap, sweepExpired finds 1.
    expect(await store.sweepExpired(t0)).toBe(0); // dead already gone; fresh (expires t0+60s) untouched
    expect(await store.claim(fresh.id, fresh.serverProofHash, t0)).toBe(fresh.ct); // fresh intact
  });
});
