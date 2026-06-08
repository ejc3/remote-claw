import { expect, test } from "@playwright/test";

// These run against docs/index.html (served by the webServer in playwright.config.ts), which
// renders docs/v2-architecture.md live via marked.js — so they guard both the page chrome
// (the mobile TOC drawer) and the rendered markdown (the ordered-list "jumble" regression).

async function openDocAndToc(page: import("@playwright/test").Page) {
  await page.goto("/index.html#v2");
  // wait for the doc to fetch + render and the TOC to build
  await expect(page.locator("nav#toc a")).not.toHaveCount(0, { timeout: 15000 });
  await page.locator("#menu").click();
  await expect(page.locator("nav#toc")).toHaveClass(/open/);
}

test.describe("mobile TOC drawer (hamburger)", () => {
  test("opens scrollable: its content exceeds its clipped height", async ({ page }) => {
    await openDocAndToc(page);
    const { clientH, scrollH } = await page.locator("nav#toc").evaluate((el) => ({
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
    }));
    expect(scrollH).toBeGreaterThan(clientH); // there is something to scroll
    expect(clientH).toBeLessThan(scrollH); // the box is clipped to the viewport, not content-tall
  });

  test("scrolling the open drawer moves the menu, not the document", async ({ page }) => {
    await openDocAndToc(page);
    const toc = page.locator("nav#toc");
    const box = (await toc.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const winBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 500); // a real wheel gesture over the drawer
    await expect.poll(() => toc.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
    expect(await page.evaluate(() => window.scrollY)).toBe(winBefore); // doc did NOT scroll
  });

  test("the page behind the open drawer is scroll-locked", async ({ page }) => {
    await openDocAndToc(page);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
    expect(await page.evaluate(() => document.body.classList.contains("nav-open"))).toBe(true);
  });

  test("tapping a TOC link closes the drawer and unlocks the page", async ({ page }) => {
    await openDocAndToc(page);
    await page.locator("nav#toc a", { hasText: "What changes and why" }).first().click();
    await expect(page.locator("nav#toc")).not.toHaveClass(/open/);
    expect(await page.evaluate(() => document.body.classList.contains("nav-open"))).toBe(false);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");
  });
});

test("§15 scenarios render as list items, not run-on paragraphs (jumble fix)", async ({ page }) => {
  await page.goto("/index.html#v2");
  await expect(page.locator("article ol li")).not.toHaveCount(0, { timeout: 15000 });
  // these scenarios were previously trapped inside the <p> of their bold category header
  for (const t of ["Client first connection", "Enable RC mid-session", "One identity, 5 independent"]) {
    await expect(page.locator("article li", { hasText: t }).first()).toBeVisible();
  }
  // no article <p> is a stranded multi-item numbered run-on
  const jumbled = await page.evaluate(
    () =>
      [...document.querySelectorAll("article p")].filter((p) =>
        /(^|\n)\s*\d+\.\s+\S[\s\S]*\n\s*\d+\.\s/.test(p.textContent || ""),
      ).length,
  );
  expect(jumbled).toBe(0);
});

test.describe("mobile layout", () => {
  test("no horizontal overflow — the page cannot scroll left/right", async ({ page }) => {
    await page.goto("/index.html#v2");
    await expect(page.locator("article h1")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      window.scrollTo(9999, 0);
      const scrollX = window.scrollX;
      window.scrollTo(0, 0);
      return { vw: de.clientWidth, docW: de.scrollWidth, bodyW: document.body.scrollWidth, scrollX };
    });
    expect(m.scrollX).toBe(0); // attempting to scroll right does nothing
    expect(m.docW).toBeLessThanOrEqual(m.vw + 1); // no document-level horizontal overflow
    expect(m.bodyW).toBeLessThanOrEqual(m.vw + 1);
  });

  test("the sticky header stays pinned when the page scrolls", async ({ page }) => {
    await page.goto("/index.html#v2");
    await expect(page.locator("article h1")).toBeVisible({ timeout: 15000 });
    const top = await page.evaluate(() => {
      window.scrollTo(0, 800);
      const t = Math.round(document.querySelector("header.top")!.getBoundingClientRect().top);
      window.scrollTo(0, 0);
      return t;
    });
    expect(top).toBe(0); // overflow-x guard on .wrap didn't break the sticky header
  });
});
