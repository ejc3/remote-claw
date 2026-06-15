import { describe, expect, it } from "vitest";
import { SSE_IDLE_MS, sseData } from "./client.js";

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

describe("sseData idle-watchdog", () => {
  it("parses data records and skips comment/keepalive lines", async () => {
    const b = body([
      [0, ": open\n\n"],
      [5, "data: alpha\n\n"],
      [5, ": ping\n\n"],
      [5, "data: beta\n\ndata: gamma\n\n"], // two records in one chunk
    ]);
    const out: string[] = [];
    for await (const d of sseData(b, 60)) out.push(d); // idle 60ms ends it after the last byte
    expect(out).toEqual(["alpha", "beta", "gamma"]);
  });

  it("ENDS the stream when no bytes arrive for idleMs (the stall the watchdog catches)", async () => {
    const b = body([
      [0, "data: one\n\n"],
      [500, null], // then silence far longer than the idle window
    ]);
    const out: string[] = [];
    const start = Date.now();
    for await (const d of sseData(b, 50)) out.push(d);
    const elapsed = Date.now() - start;
    expect(out).toEqual(["one"]);
    expect(elapsed).toBeLessThan(400); // ended ~50ms on idle, did NOT hang for the full 500ms silence
  });

  it("a periodic keepalive resets the idle window — a live-but-idle stream is NOT torn down early", async () => {
    // `: ping` every 20ms for ~120ms (each < the 50ms idle), then a real frame, then silence.
    const script: Array<[number, string | null]> = [];
    for (let i = 0; i < 6; i++) script.push([20, ": ping\n\n"]);
    script.push([20, "data: survived\n\n"]);
    const out: string[] = [];
    for await (const d of sseData(body(script), 50)) out.push(d);
    // Without the keepalive resetting the timer this would have ended at ~50ms, before the 140ms frame.
    expect(out).toEqual(["survived"]);
  });

  it("the default idle window is comfortably above the server keepalive cadence", () => {
    expect(SSE_IDLE_MS).toBeGreaterThan(2 * 15_000); // > 2× SSE_KEEPALIVE_MS, so one lost ping can't trip it
  });
});
