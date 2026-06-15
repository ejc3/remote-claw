import { describe, expect, it } from "vitest";
import { parseAccepted } from "../app/lib/transcript.js";
import type { Message } from "../app/lib/viewer.js";
import { optimisticMessage, reconcileAccepted } from "../app/page.js";

// Optimistic local echo (#113): a sent message renders INSTANTLY (msgId `pending-<clientMsgId>`), then the
// host's `accepted` ack {client_msg_id, seq} reconciles it to the real `user-<seq>` so the content echo
// dedups by msgId — one bubble, no flash, no duplicate, regardless of ack/echo arrival order.
const staged = (names: string[]) =>
  names.map((name, i) => ({ id: String(i), name, file: new File([], name), url: `blob:${name}` }));

describe("optimisticMessage", () => {
  it("renders a text prompt verbatim as a pending user bubble", () => {
    const m = optimisticMessage("cm-1", "hello world", []);
    expect(m).toMatchObject({
      kind: "user",
      text: "hello world",
      msgId: "pending-cm-1",
      clientMsgId: "cm-1",
      optimistic: true,
    });
  });
  it("renders staged images as 📎 chips + the caption ONCE (mirrors the host echo)", () => {
    const m = optimisticMessage("cm-2", "what is this", staged(["a.jpg", "b.jpg"]));
    expect(m.text).toBe("📎 a.jpg, 📎 b.jpg\nwhat is this");
    expect(m.optimistic).toBe(true);
  });
  it("renders images with no caption as just the chips", () => {
    expect(optimisticMessage("cm-3", "", staged(["x.png"])).text).toBe("📎 x.png");
  });
});

describe("reconcileAccepted", () => {
  const opt = (cid: string): Message => optimisticMessage(cid, `msg ${cid}`, []);

  it("re-keys the optimistic bubble to user-<seq> when the echo hasn't arrived yet", () => {
    const out = reconcileAccepted([opt("cm-1")], "cm-1", 7);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ msgId: "user-7", optimistic: false, clientMsgId: "cm-1" });
  });

  it("drops the optimistic twin if the real echo already landed (no duplicate)", () => {
    const echo: Message = { kind: "user", seq: 7, text: "msg cm-1", msgId: "user-7" };
    const out = reconcileAccepted([echo, opt("cm-1")], "cm-1", 7);
    expect(out).toEqual([echo]); // only the real echo remains
  });

  it("is a no-op for an ack with no matching optimistic bubble (e.g. another device)", () => {
    const others = [opt("cm-2")];
    expect(reconcileAccepted(others, "cm-999", 3)).toEqual(others);
  });

  it("end-to-end: optimistic → accepted re-key → echo dedups by msgId (one bubble either order)", () => {
    // Order A: accepted before echo
    let msgs = [opt("cm-9")];
    msgs = reconcileAccepted(msgs, "cm-9", 4); // re-keyed to user-4
    const echo: Message = { kind: "user", seq: 4, text: "msg cm-9", msgId: "user-4" };
    const hasDup = msgs.some((m) => m.msgId === echo.msgId);
    expect(hasDup).toBe(true); // appendUniqueMessage would dedup the echo → still one bubble
    expect(msgs).toHaveLength(1);
  });
});

describe("parseAccepted", () => {
  it("parses a well-formed ack", () => {
    expect(parseAccepted(JSON.stringify({ client_msg_id: "cm-1", seq: 12 }))).toEqual({
      clientMsgId: "cm-1",
      seq: 12,
    });
  });
  it("returns null for a missing/typed field or bad JSON (ignored)", () => {
    expect(parseAccepted(JSON.stringify({ seq: 1 }))).toBeNull();
    expect(parseAccepted(JSON.stringify({ client_msg_id: "x" }))).toBeNull();
    expect(parseAccepted(JSON.stringify({ client_msg_id: 7, seq: 1 }))).toBeNull();
    expect(parseAccepted("{not json")).toBeNull();
  });
  it("tolerates a null client_msg_id (a send with no clientMsgId) by returning null", () => {
    expect(parseAccepted(JSON.stringify({ client_msg_id: null, seq: 1 }))).toBeNull();
  });
});
