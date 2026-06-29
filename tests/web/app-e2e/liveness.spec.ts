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

test("a brief bus blip BELOW the threshold never flashes the banner", async ({ page, seedHost }) => {
  const { pass } = await seedHost();

  // Fail the bus discovery stream exactly TWICE (one below BUS_ERROR_THRESHOLD=3), then PARK the third
  // subscribe — the recovery — until the test has inspected the page at the stable sub-threshold state.
  // Checking only the END state (banner gone after recovery) is a FALSE GREEN: if the threshold regressed
  // to 2, the banner would flash on the 2nd failure and clear the instant the 3rd subscribe succeeded,
  // before any assertion could see it. Parking the recovery freezes busFailures===2 with nothing in flight
  // to clear it, so the banner's presence is observable — not a race against a fast recovery. (codex review.)
  let busHits = 0;
  let aborts = 0;
  let releaseRecovery = () => {};
  const recoveryAllowed = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });

  await page.route("**/api/stream**", async (route) => {
    if (!isBusStream(route.request().url())) {
      await route.continue();
      return;
    }
    busHits += 1;
    if (busHits <= 2) {
      aborts += 1;
      await route.abort("failed");
      return;
    }
    await recoveryAllowed; // park the recovery subscribe until the test releases it
    await route.continue();
  });

  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();

  // Wait until the recovery subscribe is PARKED — i.e. both sub-threshold failures already happened and the
  // page is sitting at busFailures===2 with nothing in flight to clear it. Exactly two aborts, no more.
  await expect.poll(() => busHits, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  expect(aborts).toBe(2);

  // Deterministic check (no timing luck): at 2 consecutive failures < threshold(3) the bus is still
  // "reachable" (busError===null), so the "No live sessions yet" empty-state renders and the banner is
  // ABSENT — the two are mutually exclusive in the markup (empty-pad iff busError===null; bus-error iff
  // busError!==null). A regressed threshold (≤2) would instead SHOW the banner and SUPPRESS the empty-pad,
  // failing BOTH assertions below. The empty-pad toBeVisible() is the positive sync that defeats the
  // React-paint race: in a regression it never becomes visible (the parked recovery never clears it).
  await expect(page.locator(".empty-pad")).toBeVisible();
  await expect(page.locator(".bus-error")).toHaveCount(0);

  // Release the recovery: the host's announce streams in → the live row appears and the banner stays gone.
  releaseRecovery();
  await expect(page.locator("button.row", { hasText: "rc box" })).toBeVisible();
  await expect(page.locator(".bus-error")).toHaveCount(0);
});
