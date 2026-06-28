import { type Frame, type FrameHeader, type Identity, toHex } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brokerFetch } from "../e2e/harness";
import { uniqueIdentity } from "../helpers";

// HEAVY local encryption stress — the LocalBackend is in-process, so we crank the volume far past what
// the Vercel runtime could absorb in a unit test: thousands of sealed round-trips, hundreds
// of concurrent publishers, and a multi-hundred-part chunked message. Proves the AEAD round-trip + the
// LocalBackend hold under real load. Gated by STRESS_HEAVY so the normal gate stays fast; the CI
// web-e2e job sets it (`pnpm --filter @remote-claw/web test:stress:heavy`). Scale via STRESS_N/STRESS_K.

const HEAVY = Boolean(process.env.STRESS_HEAVY);
const N = Number.parseInt(process.env.STRESS_N ?? "2000", 10);
const K = Number.parseInt(process.env.STRESS_K ?? "200", 10);

// `local` is only requestable per-request when it's the deployment default — set it so the routes
// honour the backend: "local" header in this process.
const PRIOR_BACKEND = process.env.BROKER_BACKEND;
beforeAll(() => {
  process.env.BROKER_BACKEND = "local";
});
afterAll(() => {
  if (PRIOR_BACKEND === undefined) delete process.env.BROKER_BACKEND;
  else process.env.BROKER_BACKEND = PRIOR_BACKEND;
});

function freshIdentity(): Promise<Identity> {
  return uniqueIdentity();
}
function client(id: Identity): BrokerClient {
  return new BrokerClient({
    baseUrl: "http://broker",
    provider: securityProvider("sealed", id),
    fetchFn: brokerFetch,
    backend: "local",
  });
}
function hdr(id: Identity, sessionId: string, seq: number, msgId: string): FrameHeader {
  return {
    v: 1,
    identityId: id.identityId,
    sessionId,
    dir: "out",
    recordKind: "assistant",
    seq,
    msgId,
    keyEpoch: 0,
    part: 0,
    parts: 1,
  };
}
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) crypto.getRandomValues(b.subarray(off, off + 65536));
  return b;
}
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

describe.skipIf(!HEAVY)("HEAVY local encryption stress", () => {
  it(`round-trips ${N} sealed frames exactly, in order`, async () => {
    const id = await freshIdentity();
    const host = client(id);
    const viewer = client(id);
    const sid = "heavy-volume";

    // Varied boundary-ish sizes so we exercise short and multi-block payloads throughout.
    const sizeOf = (i: number) => [0, 1, 16, 17, 63, 64, 200, 777, 2048][i % 9] as number;
    const inputs: Uint8Array[] = [];
    for (let i = 0; i < N; i++) {
      const p = randomBytes(sizeOf(i));
      inputs.push(p);
      await host.postFrame(hdr(id, sid, i, `h-${i}`), p);
    }

    const frames = await drain(viewer, sid, N);
    expect(frames.length).toBe(N);
    let sampledCiphertext = false;
    for (let i = 0; i < N; i++) {
      const f = frames[i] as Frame;
      expect(toHex(await viewer.openFrame(f))).toBe(toHex(inputs[i] as Uint8Array)); // exact, in order
      // Sample the ciphertext-only property periodically (the broker never saw plaintext).
      if (i % 250 === 0 && (inputs[i] as Uint8Array).length > 0) {
        expect(toHex(f.ct)).not.toBe(toHex(inputs[i] as Uint8Array));
        sampledCiphertext = true;
      }
    }
    expect(sampledCiphertext).toBe(true);
  }, 120_000);

  it(`loses no frame across ${K} concurrent publishers`, async () => {
    const id = await freshIdentity();
    const host = client(id);
    const viewer = client(id);
    const sid = "heavy-concur";
    const inputs = Array.from({ length: K }, (_, i) => randomBytes(32 + (i % 97)));

    await Promise.all(inputs.map((p, i) => host.postFrame(hdr(id, sid, i, `kc-${i}`), p)));

    const frames = await drain(viewer, sid, K);
    expect(frames.length).toBe(K);
    const recovered = new Set<string>();
    for (const f of frames) recovered.add(toHex(await viewer.openFrame(f)));
    expect(recovered).toEqual(new Set(inputs.map((p) => toHex(p)))); // every payload exactly once
  }, 120_000);

  it("reassembles a many-part chunked message and rejects a tampered part", async () => {
    const id = await freshIdentity();
    const host = client(id);
    const viewer = client(id);
    const sid = "heavy-chunk";
    const maxChunk = 1024;
    const input = randomBytes(256 * 1024); // 256 KB → 256 parts
    await host.postMessage(hdr(id, sid, 0, "hc-0"), input, maxChunk);

    const parts = Math.ceil(input.length / maxChunk);
    const frames = await drain(viewer, sid, parts);
    expect(frames.length).toBe(parts);
    expect(toHex(await viewer.openMessage(frames))).toBe(toHex(input)); // exact reassembly + decrypt

    // Flip one byte of one part's ciphertext → reassembly MUST reject (per-chunk AEAD).
    const tampered = frames.map((f, i) =>
      i === parts >> 1 ? ({ ...f, ct: Uint8Array.from(f.ct) } as Frame) : f,
    );
    const victim = tampered[parts >> 1] as Frame;
    victim.ct[0] = (victim.ct[0] ?? 0) ^ 0x01;
    await expect(viewer.openMessage(tampered)).rejects.toBeDefined();
  }, 120_000);
});
