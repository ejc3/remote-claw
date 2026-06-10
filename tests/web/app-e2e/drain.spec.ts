import { expect, test } from "@playwright/test";

// The keep-warm drain route, proven END TO END against a REAL production build with NO standalone
// worker: a ?backend=temporal session is seeded (its frames queue on Temporal with nothing polling),
// stays invisible, and only renders once the BUILT `GET /api/temporal/drain` boots a worker from the
// pre-built workflow bundle and drains the queue. If the route 500s in the built server (e.g. the
// workflow bundle can't load / resolve its imports), the worker never boots and the session never
// appears — so this test fails, which is exactly the regression guard we want.

const SEED_TOKEN = process.env.E2E_SEED_TOKEN; // set on a Vercel preview; locally the seed is loopback-gated
const seedOpts = SEED_TOKEN ? { headers: { "x-dev-seed-token": SEED_TOKEN } } : {};
const CRON_SECRET = process.env.E2E_CRON_SECRET ?? "test-cron-secret";

test("a queued Temporal session renders only after the BUILT drain route boots a worker", async ({
  page,
  request,
}) => {
  // Seed the host side onto the Temporal backend. With no worker polling, every publish (the bus
  // announce + the scripted turn) is buffered on its workflow but not yet applied.
  const res = await request.post("/api/dev/seed?backend=temporal", seedOpts);
  expect(res.ok()).toBeTruthy();
  const { pass } = (await res.json()) as { pass: string };

  await page.goto(`/?backend=temporal#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();

  const row = page.locator("button.row", { hasText: "rc box" });
  // Nothing is draining the queue yet, so the session must not surface. Give it a beat to be sure
  // we're asserting "queued", not "hasn't arrived yet".
  await page.waitForTimeout(3000);
  await expect(row).toHaveCount(0);

  // Boot the worker via the BUILT route (fire it; it runs for the short configured window). A 404
  // here would mean the CRON_SECRET gate rejected us; a 500 would mean the bundle failed to load.
  const drainP = request.get("/api/temporal/drain", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
    timeout: 60_000,
  });

  // The queued bus announce now drains and the session appears, then its transcript renders.
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(".prose.assistant", { hasText: "Build is green" })).toBeVisible();

  const drain = await drainP;
  expect(drain.ok()).toBeTruthy();
  const body = (await drain.json()) as { ran?: boolean };
  expect(body.ran).toBe(true);
});
