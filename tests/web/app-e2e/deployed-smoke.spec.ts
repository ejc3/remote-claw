import { expect, test } from "./fixtures";

// This is deliberately the only deployed browser scenario. It owns the integration facts that local
// tests cannot: the exact Preview, protected edge, real network, and configured SQLite/Turso backend
// can carry discovery, a host-accepted browser turn, and durable replay after browser reload.
test("deployed broker supports discovery, host receipt, and reload replay", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost({ profile: "smoke" });
  // Never put a viewer pass in a Playwright navigation argument: failed-navigation call logs include
  // the target URL. Load the public shell first, then place the fragment inside the browser process.
  await page.goto("/");
  await page.evaluate((viewerPass) => {
    window.location.hash = encodeURIComponent(viewerPass);
  }, pass);
  await page.getByRole("button", { name: "Connect" }).click();

  const session = page.locator("button.row", { hasText: "rc box" });
  await expect(session).toBeVisible();
  await expect(session).toHaveAttribute("data-state", "connected");
  await session.click();
  await expect(
    page.locator(".prose.assistant", { hasText: "Deployed broker smoke is ready." }),
  ).toBeVisible();

  const prompt = `deployed-smoke-${Date.now()}`;
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const userTurn = page.locator(".row-user", { hasText: prompt });
  await expect(userTurn).toHaveCount(1);
  await expect(userTurn.locator('.delivery-status[data-state="received"]')).toHaveText(
    "Received by host",
  );

  await page.reload();
  await expect(session).toBeVisible();
  await session.click();
  await expect(page.locator(".row-user", { hasText: prompt })).toHaveCount(1);
});
