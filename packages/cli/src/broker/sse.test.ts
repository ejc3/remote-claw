import { describe, expect, it } from "vitest";
import { BrokerStreamRotationError, BrokerTimeoutError, SSE_IDLE_MS, sseData } from "./client.js";

const enc = new TextEncoder();

/** Build an SSE body that emits each `[afterMs, payload]` step at its cumulative delay; a `null`
 *  payload is pure silence (no bytes). The stream never auto-closes, so the ONLY way the consumer
 *  finishes is the idle-watchdog (or it consuming a `done`) — exactly what we want to exercise. */
function body(script: Array<[number, string | null]>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let t = 0;
      for (const [after, payload] of script) {
        t += after;
        setTimeout(() => {
          if (payload !== null) controller.enqueue(enc.encode(payload));
        }, t);
      }
    },
  });
}

async function collectUntilIdle(
  stream: ReadableStream<Uint8Array>,
  idleMs: number,
): Promise<{ out: string[]; error: unknown }> {
  const out: string[] = [];
  let error: unknown;
  try {
    for await (const data of sseData(stream, idleMs)) out.push(data);
  } catch (caught) {
    error = caught;
  }
  return { out, error };
}

describe("sseData idle-watchdog", () => {
  it("returns cleanly only for the broker's explicit absent-channel marker", async () => {
    const absent = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(": empty\n\n"));
        controller.close();
      },
    });

    await expect(
      (async () => {
        const out: string[] = [];
        for await (const data of sseData(absent, 50)) out.push(data);
        return out;
      })(),
    ).resolves.toEqual([]);
  });

  it("reports the broker's exact planned-rotation marker distinctly from raw EOF", async () => {
    const rotated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(": open\n\n: rotate\n\n"));
        controller.close();
      },
    });

    const { out, error } = await collectUntilIdle(rotated, 50);

    expect(out).toEqual([]);
    expect(error).toBeInstanceOf(BrokerStreamRotationError);
  });

  it.each([
    ["before open", ": rotate\n\n"],
    ["with data", ": open\n\n: rotate\ndata: no\n\n"],
    ["followed by another record", ": open\n\n: rotate\n\n: ping\n\n"],
  ])("rejects a rotation marker %s", async (_name, payload) => {
    const invalid = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(payload));
        controller.close();
      },
    });

    const { error } = await collectUntilIdle(invalid, 50);

    expect(error).toMatchObject({ name: "BrokerError", status: 502 });
  });

  it.each([
    ["opened EOF", ": open\n\n"],
    ["unclassified EOF", ""],
    ["data EOF", "data: one\n\n"],
  ])("rejects %s instead of reporting a clean absent response", async (_name, payload) => {
    const ended = new ReadableStream<Uint8Array>({
      start(controller) {
        if (payload !== "") controller.enqueue(enc.encode(payload));
        controller.close();
      },
    });

    const { out, error } = await collectUntilIdle(ended, 50);

    expect(out).toEqual(payload.startsWith("data:") ? ["one"] : []);
    expect(error).toMatchObject({
      name: "BrokerError",
      status: 502,
      message: expect.stringContaining("broker stream ended unexpectedly"),
    });
  });

  it("rejects a stream that continues after claiming it is empty", async () => {
    const contradictory = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(": empty\n\ndata: impossible\n\n"));
        controller.close();
      },
    });

    const { out, error } = await collectUntilIdle(contradictory, 50);

    expect(out).toEqual([]);
    expect(error).toMatchObject({ name: "BrokerError", status: 502 });
  });

  it("parses data records and skips comment/keepalive lines", async () => {
    const b = body([
      [0, ": open\n\n"],
      [5, "data: alpha\n\n"],
      [5, ": ping\n\n"],
      [5, "data: beta\n\ndata: gamma\n\n"], // two records in one chunk
    ]);
    const { out, error } = await collectUntilIdle(b, 60);
    expect(out).toEqual(["alpha", "beta", "gamma"]);
    expect(error).toBeInstanceOf(BrokerTimeoutError);
  });

  it("FAILS the stream when no bytes arrive for idleMs (so the relay counts the stall)", async () => {
    const b = body([
      [0, "data: one\n\n"],
      [500, null], // then silence far longer than the idle window
    ]);
    const start = Date.now();
    const { out, error } = await collectUntilIdle(b, 50);
    const elapsed = Date.now() - start;
    expect(out).toEqual(["one"]);
    expect(error).toMatchObject({ name: "BrokerTimeoutError", operation: "broker stream idle" });
    expect(elapsed).toBeLessThan(400); // ended ~50ms on idle, did NOT hang for the full 500ms silence
  });

  it("does not let an endless stream of zero-length chunks refresh the byte-idle wall", async () => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const empty = new ReadableStream<Uint8Array>({
      start(controller) {
        interval = setInterval(() => controller.enqueue(new Uint8Array()), 2);
      },
      cancel() {
        if (interval !== undefined) clearInterval(interval);
      },
    });
    const start = Date.now();

    const { out, error } = await collectUntilIdle(empty, 30);

    expect(out).toEqual([]);
    expect(error).toMatchObject({ name: "BrokerTimeoutError", operation: "broker stream idle" });
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("a periodic keepalive resets the idle window — a live-but-idle stream is NOT torn down early", async () => {
    // `: ping` every 20ms for ~120ms (each < the 50ms idle), then a real frame, then silence.
    const script: Array<[number, string | null]> = [];
    for (let i = 0; i < 6; i++) script.push([20, ": ping\n\n"]);
    script.push([20, "data: survived\n\n"]);
    const { out, error } = await collectUntilIdle(body(script), 50);
    // Without the keepalive resetting the timer this would have ended at ~50ms, before the 140ms frame.
    expect(out).toEqual(["survived"]);
    expect(error).toBeInstanceOf(BrokerTimeoutError);
  });

  it("the default idle window is comfortably above the server keepalive cadence", () => {
    expect(SSE_IDLE_MS).toBeGreaterThan(2 * 15_000); // > 2× SSE_KEEPALIVE_MS, so one lost ping can't trip it
  });
});
