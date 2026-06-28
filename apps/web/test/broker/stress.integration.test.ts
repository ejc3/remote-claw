import { type Frame, type FrameHeader, type Identity, toHex } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brokerFetch } from "../e2e/harness";
import { uniqueIdentity } from "../helpers";

// ENCRYPTION STRESS TEST — drives the REAL encrypted spine (BrokerClient seal/chunk → broker routes →
// the selected backend → openFrame/openMessage) against EACH backend, asserting the AEAD round-trip
// holds under volume + boundary conditions, and that the broker only ever moves ciphertext.
//
// Backends: local + vercel (both in-process). The backend is picked per-request via the
// x-broker-backend header; we set BROKER_BACKEND=local so both are selectable in this process (local is
// only requestable when it's the default).

const PRIOR_BACKEND = process.env.BROKER_BACKEND;
beforeAll(() => {
  process.env.BROKER_BACKEND = "local";
});
afterAll(async () => {
  if (PRIOR_BACKEND === undefined) delete process.env.BROKER_BACKEND;
  else process.env.BROKER_BACKEND = PRIOR_BACKEND;
  await teardownWorkflowTests();
});

const BACKENDS = ["local", "vercel"];

function freshIdentity(): Promise<Identity> {
  return uniqueIdentity();
}
function client(id: Identity, backend: string): BrokerClient {
  return new BrokerClient({
    baseUrl: "http://broker",
    provider: securityProvider("sealed", id),
    fetchFn: brokerFetch,
    backend,
  });
}
function hdr(id: Identity, sessionId: string, seq: number, msgId: string): FrameHeader {
  return {
    v: 1,
    identityId: id.identityId,
    sessionId,
    dir: "out",
    recordKind: "assistant", // a per-session content kind (sealed with the session key)
    seq,
    msgId,
    keyEpoch: 0,
    part: 0,
    parts: 1,
  };
}
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  // getRandomValues caps at 65536 bytes/call.
  for (let off = 0; off < n; off += 65536) crypto.getRandomValues(b.subarray(off, off + 65536));
  return b;
}

/** Read exactly `n` frames from a session channel (startIndex 0), then stop. */
async function drain(viewer: BrokerClient, sessionId: string, n: number): Promise<Frame[]> {
  const out: Frame[] = [];
  const ac = new AbortController();
  for await (const f of viewer.streamFrames({
    session: sessionId,
    startIndex: 0,
    signal: ac.signal,
  })) {
    out.push(f);
    if (out.length >= n) break;
  }
  ac.abort();
  return out;
}

// Boundary sizes: AEAD block edges, base64url group edges, 0/1, and a few larger payloads.
const SIZES = [0, 1, 2, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 255, 256, 257, 1000, 4096];

describe.each(BACKENDS)("encryption stress — %s backend", (backend) => {
  it("round-trips boundary-size payloads in order, ciphertext-only", async () => {
    const id = await freshIdentity();
    const host = client(id, backend);
    const viewer = client(id, backend);
    const sid = `stress-sizes-${backend}`;

    const inputs = SIZES.map((n) => randomBytes(n));
    for (let i = 0; i < inputs.length; i++) {
      await host.postFrame(hdr(id, sid, i, `s-${i}`), inputs[i] as Uint8Array);
    }

    const frames = await drain(viewer, sid, inputs.length);
    expect(frames.length).toBe(inputs.length);
    for (let i = 0; i < inputs.length; i++) {
      const f = frames[i] as Frame;
      const recovered = await viewer.openFrame(f);
      expect(toHex(recovered)).toBe(toHex(inputs[i] as Uint8Array)); // exact, in order
      // The broker forwarded CIPHERTEXT: the sealed ct is never the plaintext (and is longer — nonce +
      // AEAD tag), and an unrelated identity cannot open it.
      if ((inputs[i] as Uint8Array).length > 0) {
        expect(toHex(f.ct)).not.toBe(toHex(inputs[i] as Uint8Array));
      }
    }

    // Confidentiality: a DIFFERENT identity holds different keys → cannot decrypt a relayed frame.
    const stranger = client(await freshIdentity(), backend);
    await expect(stranger.openFrame(frames[0] as Frame)).rejects.toBeDefined();
  }, 60_000);

  it("reassembles chunked messages across the §8 chunk boundary", async () => {
    const id = await freshIdentity();
    const host = client(id, backend);
    const viewer = client(id, backend);
    const maxChunk = 100; // small, so we cross the boundary cheaply

    for (const n of [99, 100, 101, 250, 1001]) {
      const sid = `stress-chunk-${backend}-${n}`;
      const input = randomBytes(n);
      await host.postMessage(hdr(id, sid, 0, `c-${n}`), input, maxChunk);
      const parts = Math.max(1, Math.ceil(n / maxChunk));
      const frames = await drain(viewer, sid, parts);
      expect(frames.length).toBe(parts);
      const recovered = await viewer.openMessage(frames);
      expect(toHex(recovered)).toBe(toHex(input)); // exact reassembly + decrypt
    }
  }, 60_000);

  it("loses no frame under concurrent publishers", async () => {
    const id = await freshIdentity();
    const host = client(id, backend);
    const viewer = client(id, backend);
    const sid = `stress-concur-${backend}`;
    const K = 12;
    const inputs = Array.from({ length: K }, (_, i) => randomBytes(40 + i * 7));

    await Promise.all(inputs.map((p, i) => host.postFrame(hdr(id, sid, i, `k-${i}`), p)));

    const frames = await drain(viewer, sid, K);
    expect(frames.length).toBe(K);
    const recovered = new Set<string>();
    for (const f of frames) recovered.add(toHex(await viewer.openFrame(f)));
    // Every distinct payload came back exactly once — no loss, no corruption (order may interleave).
    expect(recovered).toEqual(new Set(inputs.map((p) => toHex(p))));
  }, 60_000);

  it("rejects a tampered frame (AEAD integrity)", async () => {
    const id = await freshIdentity();
    const host = client(id, backend);
    const viewer = client(id, backend);
    const sid = `stress-tamper-${backend}`;
    await host.postFrame(hdr(id, sid, 0, "t-0"), randomBytes(64));

    const [f] = await drain(viewer, sid, 1);
    const frame = f as Frame;
    // openFrame succeeds on the pristine frame...
    await expect(viewer.openFrame(frame)).resolves.toBeDefined();
    // ...but flipping ONE ciphertext byte makes the AEAD reject it — a malicious broker can't modify
    // a frame undetected.
    const tampered: Frame = { ...frame, ct: Uint8Array.from(frame.ct) };
    tampered.ct[0] = (tampered.ct[0] ?? 0) ^ 0x01;
    await expect(viewer.openFrame(tampered)).rejects.toBeDefined();
  }, 60_000);
});
