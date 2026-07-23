import { expect, test } from "./fixtures";

// Produces the BEFORE/AFTER image pairs embedded in docs/astryx-migration.md, so every correction in
// that report is backed by a picture rather than a description.
//
//   pnpm exec playwright test -c app-e2e.evidence.config.ts
//   → docs/assets/astryx/*.png  (committed; referenced from the report)
//
// The "before" state is reproduced by injecting the EXACT css/tokens that were live at the time, into
// the same layer they occupied — not by checking out an old commit. That keeps the pair honest (same
// server, same seed, same viewport, one variable changed) and keeps this runnable after the offending
// code is gone.
const OUT = "../../docs/assets/astryx";

/** Inject a rule set into @layer remote-claw — the app's own layer, declared last, which is where each
 *  of these regressions actually lived. */
async function before(page: import("@playwright/test").Page, css: string) {
  await page.addStyleTag({ content: `@layer remote-claw { ${css} }` });
}

async function pair(
  page: import("@playwright/test").Page,
  name: string,
  sel: string,
  regressionCss: string,
) {
  const el = page.locator(sel).first();
  await expect(el).toBeVisible();
  const clip = async () => {
    const b = await el.boundingBox();
    if (b === null) throw new Error(`no box for ${sel}`);
    const vp = page.viewportSize() ?? { width: 393, height: 851 };
    const pad = 10;
    return {
      x: Math.max(0, b.x - pad),
      y: Math.max(0, b.y - pad),
      width: Math.min(vp.width - Math.max(0, b.x - pad), b.width + pad * 2),
      height: Math.min(vp.height - Math.max(0, b.y - pad), b.height + pad * 2),
    };
  };
  await page.screenshot({ path: `${OUT}/${name}-after.png`, clip: await clip() });
  await before(page, regressionCss);
  await page.screenshot({ path: `${OUT}/${name}-before.png`, clip: await clip() });
  await page.reload(); // drop the injected regression before the next pair
  await expect(page.locator(sel).first()).toBeVisible();
}

test("accent inversion, reset leak, type hierarchy, elevation", async ({ page, seedHost }) => {
  const { pass } = await seedHost();
  await page.goto(`/#${encodeURIComponent(pass)}`);
  await expect(page.getByLabel("Machine pass")).toBeVisible();

  // F — seeding the accent family alone generates light-dark(#424BDA, #CBBEFF) with on-accent #001F9C:
  // in dark mode Astryx inverts the accent into a pale surface carrying dark text.
  await pair(
    page,
    "accent-inversion",
    "button.astryx-button",
    "[data-astryx-theme] { --color-accent: #CBBEFF; --color-on-accent: #001F9C; }",
  );

  // Our leftover global element resets, verbatim as they were, restyling Astryx's own components.
  await pair(
    page,
    "reset-leak-button",
    "button.astryx-button",
    "button { font: inherit; cursor: pointer; }",
  );
  await pair(
    page,
    "reset-leak-code",
    ".astryx-code",
    `code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.86em;
            background: #1b1b1f; padding: 1px 5px; border-radius: 5px; color: #c9c9d4; }`,
  );

  // H — both paragraphs as type="supporting" (the size prop that looked like it differentiated them is
  // inert), flattening a deliberate 14/12.5px hierarchy to a uniform 12px.
  await pair(
    page,
    "type-hierarchy",
    ".astryx-card",
    ".astryx-text.body { font-size: var(--text-supporting-size); }",
  );

  // The design pass: no elevation (a card sits 1.14:1 above this page), the md 32px CTA, and one
  // uniform 12px gap between every child instead of grouped rhythm.
  await pair(
    page,
    "flat-slab",
    ".astryx-card",
    `.connect .entry-card { box-shadow: none; }
     .connect .astryx-button { min-height: 0; padding: 8px 12px; }
     .astryx-stack.vertical { gap: 12px !important; }`,
  );
});
