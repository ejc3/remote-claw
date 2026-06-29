import { expect, test } from "./fixtures";

// Bus-transport liveness signal (#G). When the broker is unreachable — a wrong/stale pass that can't reach
// the bus, or a broker outage — the viewer used to sit on an empty session list with the misleading "No
// live sessions yet" copy and no error, because Viewer.announces() swallowed every transport throw and
// retried forever in silence (the page's streamError state was dead code: the generator never threw).
//
// Now the generator REPORTS transport health via a callback and the page debounces it into a visible
// "Can't reach the broker — retrying…" banner (role=alert) past a small consecutive-failure threshold —
// while discovery keeps retrying, so it clears itself the moment the broker is reachable again.
//
// This is the BROWSER guard for that path: abort the bus discovery stream (the GET /api/stream with
// startIndex=-64 and NO session= param), assert the banner appears and the misleading empty-state is
// suppressed, then restore the transport and assert the banner clears and the live session shows up.
const BACKEND = process.env.E2E_BACKEND;
const qp = BACKEND ? `?backend=${BACKEND}` : "";

// The bus discovery stream is GET /api/stream with NO session= (transcript subscriptions carry session=…).
const isBusStream = (url: string) => url.includes("/api/stream") && !url.includes("session=");

test("a persistent bus outage shows the broker-unreachable banner, then clears on recovery", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();

  // Model the outage: fail the bus discovery stream while `down` is set; leave transcript streams alone.
  let down = true;
  await page.route("**/api/stream**", async (route) => {
    if (down && isBusStream(route.request().url())) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();

  // Past the consecutive-failure threshold the banner appears (role=alert for AT), and the misleading
  // "No live sessions yet" empty-state is suppressed — the real reason is the outage, not an empty bus.
  const banner = page.locator(".bus-error");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText(/can.t reach the broker/i);
  await expect(banner).toHaveAttribute("role", "alert");
  await expect(page.locator(".empty-pad")).toHaveCount(0);

  // Restore the transport: the next subscribe streams the host's announce → the banner clears and the live
  // session row appears. Discovery never stopped retrying, so no reconnect action is needed from the user.
  down = false;
  await expect(banner).toHaveCount(0);
  await expect(page.locator("button.row", { hasText: "rc box" })).toBeVisible();
});
