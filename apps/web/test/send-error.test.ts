import { describe, expect, it } from "vitest";
import { friendlySendError } from "../app/lib/send-error";
import { AttachmentTooLargeError } from "../app/lib/viewer";

describe("friendlySendError", () => {
  it("maps WebKit's bare 'Load failed' transport error to an actionable line", () => {
    expect(friendlySendError(new TypeError("Load failed"))).toMatch(/connection dropped/i);
  });

  it("maps Chromium's 'Failed to fetch' the same way", () => {
    expect(friendlySendError(new TypeError("Failed to fetch"))).toMatch(/connection dropped/i);
  });

  it("explains an oversized attachment as too-large, not a transport error", () => {
    expect(friendlySendError(new AttachmentTooLargeError(9_000_000))).toMatch(/too large/i);
  });

  it("passes a real, actionable error message through unchanged", () => {
    expect(friendlySendError(new Error("broker 403: forbidden"))).toBe("broker 403: forbidden");
  });
});
