import { deriveIdentity, formatPass } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { MAX_RELAY_CIPHERTEXT_BYTES } from "../app/api/relay/route";
import { AttachmentTooLargeError, MAX_ATTACHMENT_TOTAL_BYTES, Viewer } from "../app/lib/viewer";

// The viewer's grouped/chunked file upload path (#44/#114). All images of one send go as ONE attachment
// MESSAGE; `postMessage` splits a large payload into ≤3 MB AEAD chunk frames sharing one msgId, so a big
// or multi-image send is NOT blocked by Vercel's ~4.5 MB edge limit (the old "Load failed"). These cover
// the client contract: a small send is one sealed frame; a large send is several, each under the cap and
// all sharing one msgId; an over-total send is rejected BEFORE the network as a clear typed error.
async function viewerWithMockFetch() {
  const id = await deriveIdentity(new Uint8Array(32).fill(9));
  const pass = await formatPass(id);
  const calls: { url: string; body: string }[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(
      JSON.stringify({ ok: true, channel: "session", runId: "r1", created: true }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  const viewer = await Viewer.fromPass(pass, "http://broker", fetchFn);
  return { viewer, calls };
}

const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;

describe("viewer grouped/chunked attachment upload (#44/#114)", () => {
  it("a small grouped attachment seals + posts ONE frame (ct is real ciphertext, not the plaintext)", async () => {
    const { viewer, calls } = await viewerWithMockFetch();
    const msgId = await viewer.sendAttachment("cse_x", {
      images: [{ name: "photo.jpg", mime: "image/jpeg", data: "QUJDRA==" }], // base64 "ABCD"
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
    expect(frame.parts).toBe(1); // small enough to be a single chunk
    // E2E: prove the bytes are ACTUALLY encrypted. base64-decode the ct and assert the recovered
    // plaintext does NOT contain the attachment fields (catches a Sealed→Open no-encryption regression).
    const decoded = Buffer.from(frame.ct, "base64url").toString("latin1");
    expect(decoded).not.toContain("photo.jpg");
    expect(decoded).not.toContain("image/jpeg");
    expect(decoded).not.toContain("what is this");
    expect(decoded).not.toContain("ABCD"); // the raw image bytes the data field base64-encodes
  });

  it("a LARGE send is CHUNKED across frames, each under Vercel's body cap, all sharing one msgId (#114)", async () => {
    const { viewer, calls } = await viewerWithMockFetch();
    // ~7 MB of data → > 2× the 3 MB chunk size → multiple parts (the case that USED to be 'Load failed').
    await viewer.sendAttachment("cse_x", {
      images: [{ name: "big.jpg", mime: "image/jpeg", data: "A".repeat(7 * 1024 * 1024) }],
      caption: "describe it",
    });
    expect(calls.length).toBeGreaterThanOrEqual(3); // chunked, not one giant POST
    const msgIds = new Set<string>();
    let parts = 0;
    for (const c of calls) {
      expect(c.body.length).toBeLessThan(VERCEL_BODY_LIMIT); // every chunk POST clears the edge cap
      const f = JSON.parse(c.body) as {
        record_kind: string;
        msg_id: string;
        parts: number;
        ct: string;
      };
      expect(f.record_kind).toBe("attachment");
      expect(Buffer.from(f.ct, "base64url").length).toBeLessThan(MAX_RELAY_CIPHERTEXT_BYTES);
      msgIds.add(f.msg_id);
      parts = f.parts;
    }
    expect(msgIds.size).toBe(1); // one logical message → host reassembles all chunks by this msgId
    expect(parts).toBe(calls.length); // parts count matches the number of chunk frames
  });

  it("rejects a send over the TOTAL cap (clear typed error, no POST)", async () => {
    const { viewer, calls } = await viewerWithMockFetch();
    await expect(
      viewer.sendAttachment("cse_x", {
        images: [
          {
            name: "huge.jpg",
            mime: "image/jpeg",
            data: "A".repeat(MAX_ATTACHMENT_TOTAL_BYTES + 1),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(calls).toHaveLength(0); // never fired a POST
  });
});
