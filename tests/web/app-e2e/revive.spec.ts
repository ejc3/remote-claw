import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// iOS-Safari foreground revive (#121/#125). When a tab is backgrounded (photo picker, app switch, lock
// screen), iOS Safari SUSPENDS the in-flight fetch streams (the announce bus + the transcript SSE) and
// never delivers `done`/error, so the streams stay dead on return. The viewer recovers by re-subscribing
// on visibilitychange→visible (page.tsx: announceRevive + reviveKey): it aborts the dead generators and
// re-reads the transcript from seq 0, relying on msgId dedup (appendUniqueMessage) + the persistent
// FrameOrderer to make the full re-read flash-free and duplicate-free.
//
// This is the BROWSER guard for that path. It runs on "mobile" (Chromium) AND "ios-safari" (WebKit) — the
// only faithful iOS-Safari engine for the fetch/streaming behavior this recovers from. Two REAL guards
// (neither satisfied by the local optimistic echo):
//   1. the transcript stream actually RE-SUBSCRIBES on foreground (a fresh GET /api/stream?session=… fires)
//      — remove the visibilitychange handler and this times out;
//   2. the post-foreground send reconciles to a HOST-CONFIRMED solid pill (`.pill` without `.pill-pending`)
//      — that flip only happens when the `accepted` ack arrives over the (re-subscribed) transcript stream,
//      so a dead stream leaves it `.pill-pending` forever.
// A full simulation of iOS's "frozen but un-errored fetch" isn't reproducible in Playwright (no API
// freezes a live fetch without erroring it, which would trigger the generator's own re-subscribe loop), so
// we assert the recovery MACHINERY runs and delivers, not the OS-level suspend itself.
const BACKEND = process.env.E2E_BACKEND;
const qp = BACKEND ? `?backend=${BACKEND}` : "";

// A transcript subscription is GET /api/stream?session=… (the bus uses startIndex=-64 with no session).
const isTranscriptStream = (url: string) => url.includes("/api/stream") && url.includes("session=");

// Shadow the prototype getters with an own property on `document`, then fire the event the viewer listens
// for. (Playwright has no portable setVisibility; CDP's Emulation.setVisibilityState is Chromium-only, so
// this defineProperty technique is what works on BOTH Chromium and WebKit.)
async function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

// Type a prompt + send it. Uses pressSequentially (real per-char key events) rather than fill(): WebKit
// intermittently drops fill()'s single synthetic input event for a React-controlled <textarea>, so React's
// onChange never fires and `input` stays empty — leaving the Send button permanently disabled (a real flake
// observed on the ios-safari project). Real keystrokes always fire onChange. The toBeEnabled gate then
// confirms the composer state propagated before we click.
async function sendPrompt(page: Page, text: string): Promise<void> {
  const ta = page.getByRole("textbox", { name: "Message" });
  await ta.click();
  await ta.fill("");
  await ta.pressSequentially(text);
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
}

test("survives a background→foreground cycle: re-subscribes idempotently (no dup) and stays live", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();

  // A live transcript is established (the scripted prose), and a typed prompt round-trips to a
  // HOST-CONFIRMED solid pill — `.pill` without `.pill-pending` only after the `accepted` ack lands over
  // the stream (not the instant optimistic echo). Proves the stream + ack work BEFORE the cycle.
  await expect(page.locator(".prose.assistant", { hasText: "Build is green" })).toBeVisible();
  await sendPrompt(page, "before background");
  await expect(
    page.locator(".row-user .pill:not(.pill-pending)", { hasText: "before background" }),
  ).toBeVisible();

  // Foreground must open a NEW transcript subscription (the iOS revive). Arm the waiter BEFORE the cycle so
  // it catches the re-subscribe that reviveKey triggers — remove the visibilitychange handler and this
  // request never fires (the assertion below times out).
  const reSubscribe = page.waitForRequest((r) => isTranscriptStream(r.url()), { timeout: 15_000 });
  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
  await reSubscribe;

  // The full re-read is idempotent: the prior turn is present EXACTLY ONCE (msgId dedup absorbed the
  // replay; the #121 regression re-rendered the replayed frames and showed it twice).
  await expect(page.locator(".row-user .pill", { hasText: "before background" })).toHaveCount(1);
  await expect(page.locator(".prose.assistant", { hasText: "Build is green" })).toHaveCount(1);

  // The re-subscribed stream is LIVE: a prompt sent after foreground round-trips to a HOST-CONFIRMED solid
  // pill — the `accepted` ack proves the (re-subscribed) stream delivers, not just the optimistic echo.
  await sendPrompt(page, "after foreground");
  await expect(
    page.locator(".row-user .pill:not(.pill-pending)", { hasText: "after foreground" }),
  ).toBeVisible();
  await expect(page.locator(".row-user .pill", { hasText: "before background" })).toHaveCount(1);
});
