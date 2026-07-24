import { expect, test } from "./fixtures";

// A screenshot harness for the Astryx migration — NOT part of the gate (see app-e2e.shots.config.ts;
// the default app-e2e.config.ts testMatch excludes this file). It drives the same real spine as the
// other app-e2e specs (real Chromium → real Next client → real broker → real HostRcRelay) and captures
// every surface of the viewer, so a migration step can be compared against the same shots taken on the
// pre-migration commit instead of being eyeballed from a description.
//
//   pnpm exec playwright test -c app-e2e.shots.config.ts            # → tests/web/shots/<project>/*.png
//
// Each capture is a REGION (a specific element) rather than the whole viewport wherever a region exists,
// so a shot doesn't churn on unrelated layout above/below it.
// Keyed by PROJECT: both projects run the same test titles, and a bare "shots/03-transcript.png"
// would have the desktop run silently overwrite the phone run's file.
const OUT = () => `shots/${test.info().project.name}`;

/** Wait for the bottom-sheet's slide-up + scrim-fade animations to finish before capturing — otherwise
 *  the shot catches a mid-animation frame (transparent scrim, transcript bleeding through), which makes
 *  the artifact useless for review. */
async function settleSheet(page: import("@playwright/test").Page) {
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  await page.waitForFunction(() => {
    const scrim = document.querySelector(".sheet-scrim") as HTMLElement | null;
    const sheet = document.querySelector(".sheet") as HTMLElement | null;
    if (!scrim || !sheet) return false;
    return scrim.getAnimations().every((a) => a.playState !== "running")
      && sheet.getAnimations().every((a) => a.playState !== "running");
  });
}

async function connect(page: import("@playwright/test").Page, pass: string) {
  await page.goto(`/#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
}

test("connect + pass screen", async ({ page, seedHost }) => {
  const { pass } = await seedHost();
  await page.goto(`/#${encodeURIComponent(pass)}`);
  await expect(page.getByLabel("Machine pass")).toBeVisible();
  await page.screenshot({ path: `${OUT()}/01-connect.png` });
});

test("session list", async ({ page, seedHost }) => {
  const { pass } = await seedHost({ harness: "tmux" });
  await connect(page, pass);
  await expect(page.locator("button.row", { hasText: "rc box" })).toBeVisible();
  await page.screenshot({ path: `${OUT()}/02-session-list.png` });
});

test("transcript: prose, tool rows, diff, task nesting", async ({ page, seedHost }) => {
  const { pass } = await seedHost();
  await connect(page, pass);
  await page.locator("button.row", { hasText: "rc box" }).click();
  await expect(page.locator(".prose.assistant", { hasText: "Build is green" })).toBeVisible();
  await page.screenshot({ path: `${OUT()}/03-transcript.png`, fullPage: true });

  // Expanded tool detail (the Output pre + the chevron/summary treatment).
  const output = page.locator('details.tool-result[data-sub="false"][data-error="false"]');
  await output.click();
  await expect(output.locator("pre.tool-output")).toContainText("built in 3.42s");
  await page.screenshot({ path: `${OUT()}/04-tool-output-expanded.png`, fullPage: true });
});

test("permission prompt", async ({ page, seedHost }) => {
  const { pass } = await seedHost({ perm: true });
  await connect(page, pass);
  await page.locator("button.row", { hasText: "rc box" }).click();
  const perm = page.locator(".perm").first();
  await expect(perm).toBeVisible();
  await perm.screenshot({ path: `${OUT()}/05-permission.png` });
});

test("AskUserQuestion card (single-select + freeform)", async ({ page, seedHost }) => {
  const { pass } = await seedHost({ askq: true });
  await connect(page, pass);
  await page.locator("button.row", { hasText: "rc box" }).click();
  const card = page.locator(".perm.perm-q").first();
  await expect(card).toBeVisible();
  await expect(card.locator(".q-freeform")).toBeVisible();
  await card.screenshot({ path: `${OUT()}/06-question-card.png` });

  // …and the resolved state, which is what the transcript keeps after answering.
  await card.locator(".q-option").first().click();
  await card.locator(".q-submit").click();
  await expect(card.locator(".perm-resolved")).toBeVisible();
  await card.screenshot({ path: `${OUT()}/07-question-answered.png` });
});

test("composer: staged state + mode sheet + session sheet", async ({ page, seedHost }) => {
  const { pass } = await seedHost();
  await connect(page, pass);
  await page.locator("button.row", { hasText: "rc box" }).click();

  await page.getByPlaceholder(/Send a prompt/).fill("a drafted prompt that wraps onto a second line");
  await page.locator("form.composer").screenshot({ path: `${OUT()}/08-composer.png` });

  await page.getByTestId("composer-mode").click();
  await settleSheet(page);
  await page.screenshot({ path: `${OUT()}/09-mode-sheet.png` });
  await page.keyboard.press("Escape");

  await page.locator("button.chat-menu").click();
  await settleSheet(page);
  await page.screenshot({ path: `${OUT()}/10-session-sheet.png` });
});

test("status strip: disconnected + bus error", async ({ page, seedHost }) => {
  const { pass } = await seedHost();
  await connect(page, pass);
  await page.locator("button.row", { hasText: "rc box" }).click();
  await expect(page.locator(".transcript")).toBeVisible();
  // The strip only shows for a non-quiet state; drive it by aging the announce past the connected window
  // rather than faking DOM, so what's captured is what a real lapsed host looks like.
  await page.clock.install();
  await page.clock.fastForward(120_000);
  await expect(page.locator(".chat-status")).toBeVisible();
  await page.locator(".chat-status").screenshot({ path: `${OUT()}/11-status-strip.png` });
});
