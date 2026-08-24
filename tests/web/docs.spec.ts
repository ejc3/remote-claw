import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// These run against docs/index.html (served by the webServer in playwright.config.ts), which
// renders docs/*.md live via marked.js — so they guard both the page chrome
// (the mobile TOC drawer) and the rendered markdown (the ordered-list "jumble" regression).

const markdownDocs = [
  ...["README.md", "AGENTS.md", "CLAUDE.md"].map((name) => ({
    name,
    source: readFileSync(new URL(`../../${name}`, import.meta.url), "utf8"),
  })),
  ...readdirSync(new URL("../../docs/", import.meta.url))
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({
      name: `docs/${name}`,
      source: readFileSync(new URL(`../../docs/${name}`, import.meta.url), "utf8"),
    })),
];

test("every maintained markdown document has balanced fences and clean list rendering", async ({
  page,
}) => {
  for (const { name, source } of markdownDocs) {
    for (const [kind, pattern] of [
      ["backtick", /^\s*```/gm],
      ["tilde", /^\s*~~~/gm],
    ] as const) {
      const fences = source.match(pattern) ?? [];
      expect(fences.length % 2, `${name}: unbalanced ${kind} fences`).toBe(0);
    }
  }

  await page.goto("/index.html#release");
  const bad = await page.evaluate((docs) => {
    const renderer = (
      globalThis as unknown as {
        marked: { parse(source: string): string };
      }
    ).marked;
    const parser = new DOMParser();
    return docs.flatMap(({ name, source }) => {
      const document = parser.parseFromString(renderer.parse(source), "text/html");
      const stranded = [...document.querySelectorAll("p")].filter((paragraph) =>
        /\n\s*(?:\d+\.|[-*])\s+\S/.test(paragraph.innerHTML),
      );
      return stranded.length === 0 ? [] : [`${name}: ${stranded.length}`];
    });
  }, markdownDocs);
  expect(bad, `list markers stranded in rendered paragraphs: ${bad.join(", ")}`).toEqual([]);
});

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
    await page
      .locator("nav#toc a", { hasText: "Product outcome and current status" })
      .first()
      .click();
    await expect(page.locator("nav#toc")).not.toHaveClass(/open/);
    expect(await page.evaluate(() => document.body.classList.contains("nav-open"))).toBe(false);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");
  });
});

test("numbered architecture steps render as list items, not run-on paragraphs", async ({
  page,
}) => {
  await page.goto("/index.html#v2");
  await expect(page.locator("article ol li")).not.toHaveCount(0, { timeout: 15000 });
  for (const t of [
    "Bind to one exact native session",
    "Page native history",
    "Preserve unknown live frames",
  ]) {
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
      return {
        vw: de.clientWidth,
        docW: de.scrollWidth,
        bodyW: document.body.scrollWidth,
        scrollX,
      };
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

test("a doc-reference link opens that doc in the viewer, not the raw markdown", async ({
  page,
}) => {
  await page.goto("/index.html#v2");
  await expect(page.locator("article h1")).toContainText("remote-claw architecture", {
    timeout: 15000,
  });
  // §17 references phase0-findings.md as a relative link; clicking it should switch tabs in-place
  await page.locator('article a[href="phase0-findings.md"]').first().click();
  await expect(page.locator("article h1")).toContainText("Phase 0 — Empirical Findings");
  await expect(page.locator(".tab.active")).toHaveText("Phase 0 Findings");
  await expect(page).toHaveURL(/#phase0$/);
  // crucially we did NOT navigate away to /phase0-findings.md (the raw file)
  expect(new URL(page.url()).pathname).toBe("/index.html");
});

test("the default docs route opens the active product goal", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page.locator("article h1")).toContainText(
    "remote-claw product goal and release gates",
    {
      timeout: 15000,
    },
  );
  await expect(page.locator(".tab.active")).toHaveText("Product Goal & Gates");
  await expect(page).toHaveURL(/#release$/);
  expect(new URL(page.url()).pathname).toBe("/index.html");
});

test("the pinned Codex proof opens as a rendered viewer tab", async ({ page }) => {
  await page.goto("/index.html#codex-proof");
  await expect(page.locator("article h1")).toContainText("Codex app-server multi-client proof");
  await expect(page.locator(".tab.active")).toHaveText("Codex Evidence");
  await expect(page).toHaveURL(/#codex-proof$/);
  expect(new URL(page.url()).pathname).toBe("/index.html");
});

test("the pinned OpenCode proof opens as a rendered viewer tab", async ({ page }) => {
  await page.goto("/index.html#opencode-proof");
  await expect(page.locator("article h1")).toContainText("OpenCode 1.17.5 protocol fixture");
  await expect(page.locator(".tab.active")).toHaveText("OpenCode Evidence");
  await expect(page).toHaveURL(/#opencode-proof$/);
  expect(new URL(page.url()).pathname).toBe("/index.html");
});

test("primary architecture diagrams fit the mobile code block without horizontal scrolling", async ({
  page,
}) => {
  const docs = [{ id: "v2", diagrams: ["local native TUI"] }];

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

test("a composite doc-and-section hash loads and scrolls the active product goal", async ({
  page,
}) => {
  await page.goto("/index.html#release:5-shared-safety-invariants");
  await expect(page.locator("article h1")).toContainText(
    "remote-claw product goal and release gates",
    {
      timeout: 15000,
    },
  );
  await expect(page.locator(".tab.active")).toHaveText("Product Goal & Gates");
  await expect(page).toHaveURL(/#release:5-shared-safety-invariants$/);
  await expect(page.locator('[id="5-shared-safety-invariants"]')).toBeInViewport();
});
