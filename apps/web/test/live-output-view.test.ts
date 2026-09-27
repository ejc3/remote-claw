import type { LiveOutput } from "@remote-claw/cli/broker";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type Announce, parseCapabilities, visibleLiveItem } from "../app/lib/viewer";
import { LivePreview } from "../app/page";

const output: LiveOutput = {
  v: 1,
  startedAt: 1,
  incarnation: "launch",
  revision: 1,
  sentAt: 1_000,
  item: {
    finalMsgId: `native-text-${"a".repeat(64)}`,
    text: "**draft** <img src=x onerror=alert(1)>",
    truncated: false,
  },
};
const announce = {
  incarnation: "launch",
  incarnationStartedAt: 1,
  capabilities: parseCapabilities({ liveAssistant: true }),
} as Announce;
describe("live assistant presentation", () => {
  it("never restores a preview after its canonical final, including a newer delayed snapshot", () => {
    expect(visibleLiveItem(output, announce, [], 2_000)).toEqual(output.item);
    const finals = [{ msgId: output.item?.finalMsgId ?? "" }];
    expect(visibleLiveItem(output, announce, finals, 2_000)).toBeNull();
    expect(visibleLiveItem({ ...output, revision: 9 }, announce, finals, 2_000)).toBeNull();
    expect(
      visibleLiveItem(output, { ...announce, incarnation: "replacement" }, [], 2_000),
    ).toBeNull();
    expect(visibleLiveItem(output, undefined, [], 2_000)).toBeNull();
    expect(visibleLiveItem(output, announce, [], 31_000)).toBeNull();
    expect(visibleLiveItem({ ...output, sentAt: 100_000 }, announce, [], 2_000)).toBeNull();
  });
  it("uses safe Markdown and an explicit incomplete label without action buttons", () => {
    if (!output.item) throw new Error("missing item");
    const html = renderToStaticMarkup(
      createElement(LivePreview, { item: { ...output.item, truncated: true } }),
    );
    expect(html).toContain("Live · reply in progress");
    expect(html).toContain("<strong");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<button");
    expect(html).toContain("Preview limit reached");
  });
});
