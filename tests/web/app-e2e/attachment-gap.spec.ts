import { expect, test } from "./fixtures";

// REAL e2e reproduction of the "uploaded image is missing from the message list right after Send" gap.
//
// This drives the SAME real spine every other app-e2e test uses — real Chromium → real Next client
// (page.tsx) → real broker routes (BROKER_BACKEND=local) → a real persistent HostRcRelay (host-runner.ts).
// The ONLY thing scripted is the worker leg. Nothing about the gap is faked: there is no stubbed message
// list, no injected "missing" state, and the broker is the genuine in-process LocalBackend. The image
// bubble is absent because of the real viewer→broker→host(write+seq+emit)→broker→viewer round-trip and
// the deliberate absence of any optimistic local echo (page.tsx send(): on a staged send it awaits
// sendComposer, then clearStaged() removes the only local copy — the staged thumbnail — and NEVER calls
// setMessages() for the user's own image). The bubble can only appear when the host's echoed dir:out
// `user` frame round-trips back through viewer.transcript()→appendUniqueMessage.
//
// AMPLIFICATION (clearly stated): the gap is real but on localhost the round-trip can be a few hundred ms,
// which is hard to assert deterministically. So `seedHost({ attachDelayMs })` makes the REAL host wait that
// many ms AFTER it has written the file but BEFORE it allocates the seq and publishes the `user` echo —
// standing in for a slow/large disk write, which the host-relay trace identifies as the dominant host-side
// latency point (relay.ts #handleAttachment: mkdir+writeFile happen BEFORE seq alloc + #emit). The echo
// genuinely does not exist on the channel during that window; we are widening the real gap, not manufacturing
// one. The un-amplified test below proves the same window exists with ZERO injected delay.

// A real (tiny 4x4) PNG so the browser's canvas downscale can actually decode it (same fixture the existing
// attachment test uses).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4YWMDRwzEcQAREhQBbrqBkwAAAABJRU5ErkJggg==",
  "base64",
);

const PILL = ".row-user .pill"; // the echoed attachment bubble: <div class="row-user"><div class="pill">📎 photo.png</div></div>
const ECHO = `${PILL}:has-text("📎 photo.png")`;

async function openSession(page: import("@playwright/test").Page, pass: string) {
  await page.goto(`/#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();
}

async function stageImage(page: import("@playwright/test").Page) {
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
  // Attaching STAGES the image as a removable composer thumbnail — it is NOT in the transcript yet (#112).
  await expect(page.locator(".staged-item img")).toBeVisible();
  await expect(page.locator(ECHO)).toHaveCount(0);
}

// (1) AMPLIFIED: a 3s real host echo-delay makes the absence window unmistakable and assertable. We click
// Send, then for a sustained window assert the echo bubble is STILL absent (it cannot be present — the host
// hasn't published it), recording when it finally appears. The staged thumbnail is gone (clearStaged) the
// whole time, so the image is in NEITHER surface — the exact "where did my image go" gap.
test("REPRO (amplified): the sent image is absent from the message list for the whole host round-trip", async ({
  page,
  seedHost,
}) => {
  const DELAY_MS = 3000;
  const { pass } = await seedHost({ attachDelayMs: DELAY_MS });
  await openSession(page, pass);
  await stageImage(page);

  const t0 = Date.now();
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // The instant Send is clicked the staged thumbnail is cleared on success; capture both surfaces being
  // empty for a sustained window WHILE the host sleeps before publishing the echo. We poll the live DOM.
  let sawAbsentMs = 0;
  let firstSeenMs = -1;
  // Poll up to ~6s (well past the 3s host delay) at ~50ms; the echo MUST be absent through the delay.
  for (let i = 0; i < 120; i++) {
    const present = (await page.locator(ECHO).count()) > 0;
    const elapsed = Date.now() - t0;
    if (present) {
      firstSeenMs = elapsed;
      break;
    }
    sawAbsentMs = elapsed;
    // While absent, the staged thumbnail must ALSO be gone — proving neither surface holds the image.
    if (i === 4) await expect(page.locator(".staged-item img")).toHaveCount(0);
    await page.waitForTimeout(50);
  }

  // The bubble was observably absent for at least the bulk of the injected host delay (the real gap, widened).
  // Use a conservative floor (< the full DELAY to tolerate scheduling jitter) so this asserts the WINDOW, not luck.
  expect(sawAbsentMs).toBeGreaterThan(DELAY_MS - 800);
  // …and then it DID appear after the round-trip resolved.
  expect(firstSeenMs).toBeGreaterThan(0);
  await expect(page.locator(ECHO)).toBeVisible();

  // Report the measured window (verbatim in the run output).
  console.log(
    `[GAP amplified] host echo-delay=${DELAY_MS}ms | bubble ABSENT for ≥${sawAbsentMs}ms after Send | first VISIBLE at ${firstSeenMs}ms`,
  );
});

// (2) UN-AMPLIFIED: with ZERO injected delay, the same window still exists — the image is absent from the
// transcript at the moment Send completes and only appears after the genuine round-trip. We sample the DOM
// immediately after the Send click resolves; if absent even once, the no-optimistic-echo gap is real on its
// own (any non-zero ms is the real round-trip). This proves the amplification widened a real gap, not faked one.
test("REPRO (un-amplified): the same no-optimistic-echo window exists with zero injected delay", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost(); // no attachDelayMs — pure round-trip
  await openSession(page, pass);
  await stageImage(page);

  const t0 = Date.now();
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // Sample as fast as we can right after the click; record the first moment the echo is present.
  let firstSeenMs = -1;
  let absentSamples = 0;
  for (let i = 0; i < 400; i++) {
    if ((await page.locator(ECHO).count()) > 0) {
      firstSeenMs = Date.now() - t0;
      break;
    }
    absentSamples++;
  }
  await expect(page.locator(ECHO)).toBeVisible();

  // Honest reporting: the natural window can be small on localhost. We assert the bubble was NOT present in
  // the very first sample after Send (no synchronous optimistic echo) — that alone is the structural gap —
  // and report the measured first-visible latency.
  expect(absentSamples).toBeGreaterThan(0);
  console.log(
    `[GAP natural] no injected delay | bubble absent for ${absentSamples} immediate sample(s) | first VISIBLE ~${firstSeenMs}ms after Send`,
  );
});
