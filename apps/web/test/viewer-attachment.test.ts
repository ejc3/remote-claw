import { deriveIdentity, formatPass } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { MAX_RELAY_CIPHERTEXT_BYTES } from "../app/api/relay/route";
import { AttachmentTooLargeError, MAX_ATTACHMENT_BYTES, Viewer } from "../app/lib/viewer";

// The viewer's file/photo upload path (#44). The live failure was "Load failed" — Vercel rejecting an
// oversized POST body at its ~4.5 MB edge limit. These cover the client contract: a normal attachment
// seals + posts ONE frame to the session channel, and an oversized one is rejected BEFORE the network
// (a clear typed error, never a doomed POST that surfaces as the opaque "Load failed").
async function viewerWithMockFetch() {
  const id = await deriveIdentity(new Uint8Array(32).fill(9));
  const pass = await formatPass(id);
  const calls: { url: string; body: string }[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(
      JSON.stringify({ ok: true, channel: "session", runId: "r1", created: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const viewer = await Viewer.fromPass(pass, "http://broker", fetchFn);
  return { viewer, calls };
}

describe("viewer attachment upload (#44)", () => {
  it("seals + posts ONE attachment frame to the session channel (ct is real ciphertext, not the plaintext)", async () => {
    const { viewer, calls } = await viewerWithMockFetch();
    const msgId = await viewer.sendAttachment("cse_x", {
      name: "photo.jpg",
      mime: "image/jpeg",
      data: "QUJDRA==", // base64 "ABCD"
      caption: "what is this",
    });
    expect(msgId).toMatch(/^att-/);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("no fetch call");
    expect(call.url).toContain("/api/relay?session=cse_x");
    const frame = JSON.parse(call.body) as {
      record_kind: string;
      session_id: string;
      parts: number;
      ct: string;
    };
    expect(frame.record_kind).toBe("attachment");
    expect(frame.session_id).toBe("cse_x");
    expect(frame.parts).toBe(1); // the host's inbound path is single-frame by design
    // E2E: prove the bytes are ACTUALLY encrypted, not merely base64-mangled. base64-decode the ct and
    // assert the recovered plaintext does NOT contain the attachment fields — this catches a Sealed→Open
    // (no-encryption) regression that a substring check on the base64 wire body would silently pass.
    const decoded = Buffer.from(frame.ct, "base64url").toString("latin1");
    expect(decoded).not.toContain("photo.jpg");
    expect(decoded).not.toContain("image/jpeg");
    expect(decoded).not.toContain("what is this");
    expect(decoded).not.toContain("ABCD"); // the raw image bytes the data field base64-encodes
  });

  it("accepts an attachment just under the cap, rejects just over it (clear typed error, no POST)", async () => {
    const { viewer, calls } = await viewerWithMockFetch();
    // The guard measures the WHOLE JSON payload (data + name/mime/caption + keys), so size by the data
    // field minus a wrapper allowance keeps the just-under case honestly under the limit.
    const WRAPPER = 200; // JSON keys + name/mime/caption — generous headroom
    await viewer.sendAttachment("cse_x", {
      name: "ok.jpg",
      mime: "image/jpeg",
      data: "A".repeat(MAX_ATTACHMENT_BYTES - WRAPPER),
    });
    expect(calls).toHaveLength(1); // under the cap → posted

    await expect(
      viewer.sendAttachment("cse_x", {
        name: "big.jpg",
        mime: "image/jpeg",
        data: "A".repeat(MAX_ATTACHMENT_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(calls).toHaveLength(1); // still 1 — the oversize one never fired a POST
  });

  it("a near-max attachment's REAL sealed wire body stays under Vercel's serverless limit", async () => {
    // Empirical, not arithmetic: send the largest attachment the guard allows and measure the actual
    // POST body length (sealed ct as base64url + the full JSON envelope: identity_id, salt, nonce,
    // session_id, record_kind, keys). This bounds what Vercel's edge actually receives.
    const { viewer, calls } = await viewerWithMockFetch();
    await viewer.sendAttachment("cse_x", {
      name: "max.jpg",
      mime: "image/jpeg",
      data: "A".repeat(MAX_ATTACHMENT_BYTES - 200),
    });
    const body = calls[0]?.body;
    if (body === undefined) throw new Error("no POST body");
    const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;
    expect(body.length).toBeLessThan(VERCEL_BODY_LIMIT);
    // ...and the sealed ct must clear the relay route's own decoded-ciphertext cap.
    const ct = (JSON.parse(body) as { ct: string }).ct;
    expect(Buffer.from(ct, "base64url").length).toBeLessThan(MAX_RELAY_CIPHERTEXT_BYTES);
  });
});
