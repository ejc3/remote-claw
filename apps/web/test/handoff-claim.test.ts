import {
  encodeHandoffBox,
  formatOtk,
  generateOtk,
  sealHandoff,
  toHex,
  utf8,
} from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { claimHandoff } from "../app/lib/handoff-claim";

// The viewer-side claim helper (app/lib/handoff-claim.ts): POST {id, proof} → open the returned box with
// the OTK → return the pass. These exercise its user-facing error mapping (used/expired, failed, malformed)
// and the happy round-trip, with an injected fetch (no network). The crypto is real (clawsec), so the
// happy path proves the host-seal ↔ viewer-open contract end to end.

const PASS = "rcp1_A_VIEWER_PASS_payload";

/** A fresh `otk1_…` token plus the sealed box (hex) a host would have PUT for it. */
async function mint(plaintext = PASS) {
  const otk = generateOtk();
  const token = await formatOtk(otk);
  const box = toHex(encodeHandoffBox(await sealHandoff(otk, utf8(plaintext))));
  return { token, box };
}

/** A fetch stub that always returns `res` (claimHandoff only ever calls fetch once). */
function fetchReturning(res: Response): typeof fetch {
  return (async () => res) as unknown as typeof fetch;
}

describe("claimHandoff", () => {
  it("round-trips: POSTs id+proof to /api/handoff and opens the returned box back to the pass", async () => {
    const { token, box } = await mint();
    let sentUrl: string | undefined;
    let sentMethod: string | undefined;
    let sentBody: unknown;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      sentUrl = url;
      sentMethod = init?.method;
      sentBody = JSON.parse(String(init?.body));
      return Response.json({ box });
    }) as unknown as typeof fetch;

    expect(await claimHandoff(token, fetchFn)).toBe(PASS);
    // It claims the same-origin endpoint with POST (a regression off this path must fail here)…
    expect(sentUrl).toBe("/api/handoff");
    expect(sentMethod).toBe("POST");
    // …sending only the one-way id + proof (hex), never the OTK.
    expect(sentBody).toMatchObject({ id: expect.any(String), proof: expect.any(String) });
    expect((sentBody as { id: string }).id).toMatch(/^[0-9a-f]{64}$/);
    expect((sentBody as Record<string, unknown>).otk).toBeUndefined(); // the OTK must never be sent
  });

  it("maps a 404 to the 'already used or expired' message", async () => {
    const { token } = await mint();
    await expect(
      claimHandoff(token, fetchReturning(new Response("", { status: 404 }))),
    ).rejects.toThrow(/already used or has expired/i);
  });

  it("maps a non-404 failure to a generic 'try again' message", async () => {
    const { token } = await mint();
    await expect(
      claimHandoff(token, fetchReturning(new Response("boom", { status: 500 }))),
    ).rejects.toThrow(/Pairing failed — please try again/i);
  });

  it("rejects a non-JSON 200 body without leaking a raw parse error", async () => {
    const { token } = await mint();
    await expect(
      claimHandoff(token, fetchReturning(new Response("<html>not json", { status: 200 }))),
    ).rejects.toThrow(/malformed response/i);
  });

  it("rejects a 200 whose box is missing/not a string", async () => {
    const { token } = await mint();
    await expect(claimHandoff(token, fetchReturning(Response.json({ box: 123 })))).rejects.toThrow(
      /malformed response/i,
    );
  });

  it("rejects a malformed otk1_ token before any fetch", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    await expect(claimHandoff("otk1_not-a-real-token", fetchFn)).rejects.toThrow();
    expect(called).toBe(false); // never hits the network for a bad token
  });

  it("fails to open a box sealed under a DIFFERENT OTK (wrong-key authentication failure)", async () => {
    const { token } = await mint(); // token for OTK-A
    const other = await mint(); // box sealed under OTK-B
    await expect(
      claimHandoff(token, fetchReturning(Response.json({ box: other.box }))),
    ).rejects.toThrow();
  });
});
