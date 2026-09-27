import { decodeFrame, deriveIdentity, utf8 } from "@remote-claw/clawsec";
import { describe, expect, it, vi } from "vitest";
import { securityProvider } from "../security/provider.js";
import { BrokerClient, BrokerTimeoutError } from "./client.js";
import {
  boundLiveText,
  compareLiveCoordinates,
  LIVE_OUTPUT_KIND,
  LIVE_OUTPUT_PLAINTEXT_LIMIT,
  LIVE_OUTPUT_WIRE_LIMIT,
  liveOutputId,
  parseLiveCoordinate,
  parseLiveOutput,
  readLiveBody,
} from "./live-output.js";

const coordinate = { startedAt: 123, incarnation: "launch-a", revision: 7 };
const item = { finalMsgId: `native-text-${"a".repeat(64)}`, text: "draft", truncated: false };
describe("bounded live output protocol", () => {
  it("seals preview requests on the session plane with origin-bound auth and no caching", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(53));
    const provider = securityProvider("sealed", identity);
    let submitted = "";
    const client = new BrokerClient({
      baseUrl: "https://broker",
      provider,
      fetchFn: async (url, init) => {
        expect(String(url)).toBe("https://broker/api/live-output?session=s");
        expect(init?.redirect).toBe("error");
        expect(init?.cache).toBe("no-store");
        expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer [a-f0-9]{64}$/);
        submitted = String(init?.body);
        return Response.json({ stored: true });
      },
    });
    expect(
      await client.putLiveOutput(
        {
          v: 1,
          identityId: identity.identityId,
          sessionId: "s",
          dir: "out",
          recordKind: LIVE_OUTPUT_KIND,
          seq: null,
          msgId: liveOutputId(coordinate),
          keyEpoch: 0,
          part: 0,
          parts: 1,
        },
        utf8("private preview"),
        new AbortController().signal,
      ),
    ).toBe(true);
    expect(submitted).not.toContain("private preview");
    expect(
      new TextDecoder().decode(
        await provider.openFrame("session", decodeFrame(JSON.parse(submitted))),
      ),
    ).toBe("private preview");
  });
  it("bounds a non-cooperative read without exposing broker-controlled error text", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(54));
    const provider = securityProvider("sealed", identity);
    const unsupported = new BrokerClient({
      baseUrl: "https://broker",
      provider,
      fetchFn: async () => new Response(null, { status: 501 }),
    });
    expect(await unsupported.getLiveOutput("s", new AbortController().signal)).toBeUndefined();
    const bad = new BrokerClient({
      baseUrl: "https://broker",
      provider,
      fetchFn: async () => new Response("private provider text", { status: 503 }),
    });
    await expect(bad.getLiveOutput("s", new AbortController().signal)).rejects.toThrow(
      "preview unavailable",
    );
    vi.useFakeTimers();
    try {
      const hung = new BrokerClient({
        baseUrl: "https://broker",
        provider,
        fetchFn: () => new Promise(() => {}),
      });
      const check = expect(
        hung.getLiveOutput("s", new AbortController().signal),
      ).rejects.toBeInstanceOf(BrokerTimeoutError);
      await vi.advanceTimersByTimeAsync(5_000);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });
  it("binds a canonical safe-integer generation/revision coordinate", () => {
    expect(parseLiveCoordinate(liveOutputId(coordinate))).toEqual(coordinate);
    for (const id of [
      "preview.v1.0123.launch.7",
      "preview.v1.-1.launch.7",
      "preview.v1.1.x.9007199254740992",
      "preview.v1.1.x.y.1",
    ])
      expect(parseLiveCoordinate(id)).toBeNull();
    expect(compareLiveCoordinates(coordinate, { ...coordinate, revision: 6 })).toBeGreaterThan(0);
    expect(
      compareLiveCoordinates(coordinate, { ...coordinate, startedAt: 124, revision: 0 }),
    ).toBeLessThan(0);
    expect(
      compareLiveCoordinates(coordinate, { ...coordinate, incarnation: "launch-b", revision: 0 }),
    ).toBeLessThan(0);
  });
  it("bounds serialized escaped UTF-8 without breaking surrogate pairs", () => {
    for (const text of ["😀".repeat(20_000), '\n"\\'.repeat(20_000)]) {
      const bounded = boundLiveText(text);
      expect(bounded.truncated).toBe(true);
      expect(
        new TextEncoder().encode(
          JSON.stringify({ ...coordinate, v: 1, sentAt: 1, item: { ...item, ...bounded } }),
        ).length,
      ).toBeLessThan(LIVE_OUTPUT_PLAINTEXT_LIMIT);
      expect(bounded.text).not.toMatch(/[\uD800-\uDBFF]$/);
    }
    expect(boundLiveText("plain")).toEqual({ text: "plain", truncated: false });
  });
  it("requires plaintext and AAD coordinates to match and rejects malformed/oversized bodies", () => {
    const value = { ...coordinate, v: 1, sentAt: 1, item };
    expect(parseLiveOutput(JSON.stringify(value), liveOutputId(coordinate))).toEqual(value);
    for (const patch of [
      { revision: 8 },
      { item: {} },
      { item: { ...item, finalMsgId: "native-id" } },
      { sentAt: -1 },
    ])
      expect(
        parseLiveOutput(JSON.stringify({ ...value, ...patch }), liveOutputId(coordinate)),
      ).toBeNull();
    expect(
      parseLiveOutput("x".repeat(LIVE_OUTPUT_PLAINTEXT_LIMIT + 1), liveOutputId(coordinate)),
    ).toBeNull();
  });
  it("caps a streaming body before consuming its unbounded tail", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(LIVE_OUTPUT_WIRE_LIMIT + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readLiveBody(stream)).toBeNull();
    expect(cancelled).toBe(true);
  });
});
