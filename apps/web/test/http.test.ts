import { describe, expect, it } from "vitest";
import { sseResponse } from "../lib/http.js";

/** A source stream that enqueues each value at its cumulative delay, then closes after the last step
 *  (or after `closeAfter` ms of trailing idle if no value closes it). */
function source(
  steps: Array<{ after: number; value?: unknown }>,
  closeAfter = 0,
): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      let t = 0;
      for (const s of steps) {
        t += s.after;
        setTimeout(() => {
          if (s.value !== undefined) controller.enqueue(s.value);
        }, t);
      }
      setTimeout(() => controller.close(), t + closeAfter);
    },
  });
}

describe("sseResponse keepalive", () => {
  it("opens with a comment and closes when the source ends", async () => {
    const text = await sseResponse(source([{ after: 5, value: { a: 1 } }]), 1000).text();
    expect(text).toContain(": open\n\n");
    expect(text).toContain('data: {"a":1}\n\n');
  });

  it("emits `: ping` while the source is idle, THEN delivers the later frame intact", async () => {
    // Source stays silent ~70ms, then emits one frame and closes. With a 15ms keepalive that's ~4 pings.
    const res = sseResponse(source([{ after: 70, value: { hello: "world" } }]), 15);
    const text = await res.text();
    const pings = (text.match(/: ping\n\n/g) ?? []).length;
    expect(pings).toBeGreaterThanOrEqual(2); // the stream proved itself alive while idle
    expect(text).toContain('data: {"hello":"world"}\n\n'); // and the frame is NOT dropped by a ping
    // ordering: pings precede the frame
    expect(text.indexOf(": ping")).toBeLessThan(text.indexOf("data:"));
  });

  it("does not inject pings when frames flow faster than the keepalive", async () => {
    const res = sseResponse(
      source([
        { after: 2, value: { n: 1 } },
        { after: 2, value: { n: 2 } },
        { after: 2, value: { n: 3 } },
      ]),
      200, // keepalive far longer than the inter-frame gap
    );
    const text = await res.text();
    expect((text.match(/: ping/g) ?? []).length).toBe(0);
    expect(text).toContain('data: {"n":1}\n\n');
    expect(text).toContain('data: {"n":3}\n\n');
  });
});
