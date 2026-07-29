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
  for (const t of ["Client first connection", "Enable RC mid-session", "5 independent sessions"]) {
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

test("a doc-reference link opens that doc in the viewer, not the raw markdown", async ({ page }) => {
  await page.goto("/index.html#v2");
  await expect(page.locator("article h1")).toContainText("remote-claw v2", { timeout: 15000 });
  // §17 references phase0-findings.md as a relative link; clicking it should switch tabs in-place
  await page.locator('article a[href="phase0-findings.md"]').first().click();
  await expect(page.locator("article h1")).toContainText("Phase 0 — Empirical Findings");
  await expect(page.locator(".tab.active")).toHaveText("Phase 0 Findings");
  await expect(page).toHaveURL(/#phase0$/);
  // crucially we did NOT navigate away to /phase0-findings.md (the raw file)
  expect(new URL(page.url()).pathname).toBe("/index.html");
});

test("the host-runtime reference opens as a rendered viewer tab", async ({ page }) => {
  await page.goto("/index.html#host");
  await expect(page.locator("article h1")).toContainText("Client-driven host runtime", {
    timeout: 15000,
  });
  await page.locator('article a[href="client-driven-host-runtime-reference.md"]').first().click();
  await expect(page.locator("article h1")).toContainText("technical reference");
  await expect(page.locator(".tab.active")).toHaveText("Host Runtime Reference");
  await expect(page).toHaveURL(/#host-ref$/);
  expect(new URL(page.url()).pathname).toBe("/index.html");
});

test("the pinned Codex proof opens as a rendered viewer tab", async ({ page }) => {
  await page.goto("/index.html#host");
  await expect(page.locator("article h1")).toContainText("Client-driven host runtime", {
    timeout: 15000,
  });
  await page.locator('article a[href="codex-app-server-multiclient-proof.md"]').first().click();
  await expect(page.locator("article h1")).toContainText("Codex app-server multi-client proof");
  await expect(page.locator(".tab.active")).toHaveText("Codex Multi-client Proof");
  await expect(page).toHaveURL(/#codex-proof$/);
  expect(new URL(page.url()).pathname).toBe("/index.html");
});

test("the pinned OpenCode proof opens as a rendered viewer tab", async ({ page }) => {
  await page.goto("/index.html#host");
  await expect(page.locator("article h1")).toContainText("Client-driven host runtime", {
    timeout: 15000,
  });
  await page.locator('article a[href="opencode-native-proof.md"]').first().click();
  await expect(page.locator("article h1")).toContainText("OpenCode native protocol proof");
  await expect(page.locator(".tab.active")).toHaveText("OpenCode Native Proof");
  await expect(page).toHaveURL(/#opencode-proof$/);
  expect(new URL(page.url()).pathname).toBe("/index.html");
});

test("the host-runtime source does not hard-wrap prose", async ({ request }) => {
  const response = await request.get("/client-driven-host-runtime.md");
  expect(response.ok()).toBe(true);

  const wrappedLines: number[] = [];
  let inFence = false;
  let previousLineHadContent = false;
  for (const [index, line] of (await response.text()).split("\n").entries()) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      previousLineHadContent = false;
      continue;
    }
    if (inFence || line.trim() === "") {
      previousLineHadContent = false;
      continue;
    }

    const startsMarkdownBlock =
      /^(?:#{1,6}\s|<|>|\||\s*(?:[-+*]|\d+\.)\s)/.test(line);
    if (previousLineHadContent && !startsMarkdownBlock) wrappedLines.push(index + 1);
    previousLineHadContent = true;
  }

  expect(wrappedLines, "iOS Markdown previews render soft source wraps as new lines").toEqual([]);
});

test("core host-runtime diagrams fit the mobile code block without horizontal scrolling", async ({
  page,
}) => {
  const docs = [
    { id: "host", diagrams: ["server A", "Codex direct", "coding state"] },
    {
      id: "host-ref",
      diagrams: ["server A", "Codex direct", "(server, logical chat)", "real Codex TUI"],
    },
    { id: "opencode", diagrams: ["encrypted broker + web", "many collaborators"] },
    { id: "harness", diagrams: ["chosen adapter"] },
  ];

  for (const { id, diagrams } of docs) {
    await page.goto(`/index.html?diagram-fit=${id}#${id}`);
    for (const text of diagrams) {
      const block = page.locator("article pre", { hasText: text }).first();
      await expect(block, `${id}: ${text}`).toBeVisible({ timeout: 15_000 });
      const { clientWidth, scrollWidth } = await block.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(scrollWidth, `${id}: ${text}`).toBeLessThanOrEqual(clientWidth + 1);
    }
  }
});

test("a composite doc-and-section hash loads and scrolls the selected design", async ({ page }) => {
  await page.goto("/index.html#host:delivery-plan");
  await expect(page.locator("article h1")).toContainText("Client-driven host runtime", {
    timeout: 15000,
  });
  await expect(page.locator(".tab.active")).toHaveText("Client-driven Host Runtime");
  await expect(page).toHaveURL(/#host:delivery-plan$/);
  await expect(page.locator('[id="delivery-plan"]')).toBeInViewport();
});
