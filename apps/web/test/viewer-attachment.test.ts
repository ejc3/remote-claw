import { deriveIdentity, formatPass } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
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
  it("seals + posts ONE attachment frame to the session channel (bytes never in cleartext)", async () => {
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
    };
    expect(frame.record_kind).toBe("attachment");
    expect(frame.session_id).toBe("cse_x");
    expect(frame.parts).toBe(1); // the host's inbound path is single-frame by design
    // E2E: the cleartext name/data/caption must NOT appear in the wire body (sealed under the session key).
    expect(call.body).not.toContain("photo.jpg");
    expect(call.body).not.toContain("QUJDRA==");
    expect(call.body).not.toContain("what is this");
  });

  it("rejects an oversized attachment BEFORE any network call (clear error, not 'Load failed')", async () => {
    const { viewer, calls } = await viewerWithMockFetch();
    const huge = "A".repeat(MAX_ATTACHMENT_BYTES + 1);
    await expect(
      viewer.sendAttachment("cse_x", { name: "big.jpg", mime: "image/jpeg", data: huge }),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(calls).toHaveLength(0); // never fired a doomed POST
  });

  it("the attachment cap keeps the sealed POST under Vercel's serverless body limit", () => {
    // base64url ct ≈ 1.34× plaintext; the whole frame body must clear the ~4.5 MiB platform edge cap.
    const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;
    expect(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3)).toBeLessThan(VERCEL_BODY_LIMIT);
  });
});
