import { expect, test } from "./fixtures";

// Regression guards for the design-pass UX fixes (PR: viewer-ux-design-pass). Each test pins a
// specific finding from the driven browser pass so a future change can't silently undo it. These run
// against the SAME real spine as transcript.spec.ts (real Chromium → Next client → broker → scripted
// host); the assertions target the actual rendered DOM / computed CSS, not a mock.
const BACKEND = process.env.E2E_BACKEND;
const qp = BACKEND ? `?backend=${BACKEND}` : "";

// #design-pass: the gate is a single-field page — it must autofocus so a pasted pass lands immediately
// without a click. Caught in the pass: every connect started with an extra tab/click into the field.
test("the connect gate autofocuses its pass field", async ({ page }) => {
  await page.goto(`/${qp}`);
  await expect(page.locator("textarea.field")).toBeFocused();
});

// #design-pass: the disabled primary CTA used to render as a dead grey slab indistinguishable from a
// broken button. The fix keeps the accent identity and just dims it (opacity .5) so it reads as an
// inactive primary, not a failure. Assert the COMPUTED style so a CSS regression fails here.
test("the disabled Connect CTA stays a dimmed primary, not a dead grey slab", async ({ page }) => {
  await page.goto(`/${qp}`);
  const btn = page.getByRole("button", { name: "Connect" });
  await expect(btn).toBeDisabled(); // empty pass ⇒ disabled
  const style = await btn.evaluate((el) => ({
    opacity: getComputedStyle(el).opacity,
    bg: getComputedStyle(el).backgroundColor,
  }));
  expect(style.opacity).toBe("0.5"); // dimmed, not hidden
  expect(style.bg).not.toBe("rgba(0, 0, 0, 0)"); // still carries the accent fill (not transparent)
});

// #design-pass (#8): the session row truncates its title/cwd to one line; the full identity (title ·
// branch · cwd) must be available as a hover tooltip so a long path isn't lost to the ellipsis.
test("the session row title carries branch + cwd as a hover tooltip", async ({ page, seedHost }) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  const row = page.locator("button.row", { hasText: "rc box" });
  await expect(row).toBeVisible();
  const title = await row.getAttribute("title");
  expect(title).toContain("rc box"); // the session title
  expect(title).toContain("main"); // the git branch from the announce
  expect(title).toContain("/home/ubuntu/remote-claw"); // the full cwd (the part the ellipsis hides)
});

// #design-pass: "Forget pass" wipes the credential and bounces to the gate — a single misclick used to
// drop a live session instantly. It is now a two-step confirm: the first tap only ARMS (relabels), and
// the session stays connected; only the second tap forgets.
test("Forget pass is a two-step confirm — one tap arms without dropping the session", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("button.row", { hasText: "rc box" })).toBeVisible();

  // First tap: ARMS (the label/aria-label flips) but does NOT forget. The armed button's presence already
  // proves we didn't bounce to the gate (the gate has no such button), so we assert that and click confirm
  // PROMPTLY — the arm auto-disarms after 4s, so we must not sit on slow intervening assertions here.
  await page.getByRole("button", { name: "Forget pass", exact: true }).click();
  const confirm = page.getByRole("button", { name: "Confirm forget pass" });
  await expect(confirm).toHaveText("Tap again to forget"); // armed, still in the Console (not the gate)
  await confirm.click(); // second tap forgets

  // Now the credential is wiped and we land back on the connect gate.
  await expect(page.locator("textarea.field")).toBeVisible();
});

// #design-pass (review follow-up): the transcript must FOLLOW to the foot when the reader is pinned there
// — a multi-frame turn (tool output + sub-agent task + error + prose) should leave the viewer scrolled to
// the bottom with no "jump to latest" pill. Guards the streaming-follow regression the smooth-scroll
// version had (intermediate scroll events latching "not at bottom"); the follow is now an instant scroll.
test("the transcript follows to the bottom on a multi-frame turn (no jump pill)", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();
  // Wait for the turn's prose (the last visible block) to render.
  await expect(page.locator(".prose.assistant", { hasText: "Build is green" })).toBeVisible();
  // The scroller is pinned to the foot …
  const atBottom = await page
    .locator(".transcript")
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 64);
  expect(atBottom).toBe(true);
  // … and no "jump to latest" pill is shown (we never left the bottom).
  await expect(page.locator(".jump-latest")).toHaveCount(0);
});

// #design-pass (a11y): the session row's connection state was conveyed by the dot's COLOR alone. The
// dot now carries an accessible name (role=img + aria-label) so AT users get the same state.
test("the connection-state dot exposes an accessible name (not color alone)", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  const dot = page.locator("button.row .dot").first();
  await expect(dot).toBeVisible();
  // A freshly-seeded announce reads "online" specifically — assert the exact state, not just "some label",
  // so a bug that always rendered the wrong-but-valid state would still fail.
  await expect(dot).toHaveAttribute("aria-label", "online");
});

// #design-pass (a11y/touch): granting/denying a permission is irreversible — its buttons must meet the
// 44px minimum touch target so they aren't fat-fingered on mobile.
test("permission Allow/Deny buttons meet the 44px minimum touch target", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost({ perm: true });
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();
  const allow = page.locator(".perm .perm-btn").first();
  await expect(allow).toBeVisible();
  const minH = await allow.evaluate((el) => parseFloat(getComputedStyle(el).minHeight));
  expect(minH).toBeGreaterThanOrEqual(44);
});

// #design-pass (functional-1): the session ⋯ actions (model switcher / interrupt / copy-branch) were
// only reachable from the MOBILE header — on desktop the chat header was hidden, so they were
// completely unreachable. The fix shows the chat header on every viewport (carrying ⋯) and hides only
// the now-redundant in-chat back button on desktop (the sidebar already navigates).
test.describe("desktop layout (≥761px)", () => {
  test.use({ viewport: { width: 1100, height: 900 }, isMobile: false, hasTouch: false });

  test("the session ⋯ actions are reachable on desktop; the redundant back button is hidden", async ({
    page,
    seedHost,
  }) => {
    const { pass } = await seedHost();
    await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("button.row", { hasText: "rc box" }).click();

    // The in-chat back button is redundant on desktop (sidebar visible) → hidden.
    await expect(page.locator(".back")).toBeHidden();

    // The ⋯ menu IS reachable on desktop and opens the session-actions sheet (model + interrupt).
    const menu = page.locator("button.chat-menu");
    await expect(menu).toBeVisible();
    await menu.click();
    const sheet = page.locator(".sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Change model");
    await expect(sheet).toContainText("Interrupt");
  });
});
