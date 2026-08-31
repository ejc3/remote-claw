import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "./fixtures";

// A DESIGN-INSPECTION harness: tight, high-DPI crops of every interesting region, plus the measured
// geometry behind them. Not a gate (its own config, app-e2e.zoom.config.ts; excluded from the app-e2e
// testMatch) — it exists so spacing, contrast and alignment are judged on numbers instead of vibes.
//
//   pnpm exec playwright test -c app-e2e.zoom.config.ts
//   → tests/web/zoom/*.png  (3× DPI, cropped to the region + a small bleed)
//   → tests/web/zoom/metrics.json  (padding, gaps, sizes, contrast for each region)
//
// Every capture goes through `shot()`, which screenshots a REGION WITH BLEED rather than the bare
// element: a crop flush to an element's box hides the very thing we're inspecting — the space around it.
const OUT = "zoom";
const BLEED = 12;

interface Metric {
  region: string;
  box?: { w: number; h: number };
  padding?: string;
  gaps?: number[];
  notes?: Record<string, string | number>;
}
const metrics: Metric[] = [];

function ensure() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
}

/** Crop `sel` plus `BLEED` px of its surroundings, at the project's deviceScaleFactor. */
async function shot(page: import("@playwright/test").Page, name: string, sel: string) {
  ensure();
  const el = page.locator(sel).first();
  await expect(el).toBeVisible();
  // Scroll it into view FIRST. A region above the fold has a negative y, and clamping that to 0 silently
  // crops the top of the page instead — which is how an early run produced a "question option" image
  // showing the topbar. Assert it landed, so a crop can never quietly capture the wrong thing.
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  if (b === null) throw new Error(`no box for ${sel}`);
  const vp = page.viewportSize() ?? { width: 393, height: 851 };
  if (b.y < 0 || b.y > vp.height) {
    throw new Error(
      `${sel} is off-screen after scrollIntoView (y=${b.y}) — the crop would be wrong`,
    );
  }
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x: Math.max(0, b.x - BLEED),
      y: Math.max(0, b.y - BLEED),
      width: Math.min(vp.width - Math.max(0, b.x - BLEED), b.width + BLEED * 2),
      height: Math.min(vp.height - Math.max(0, b.y - BLEED), b.height + BLEED * 2),
    },
  });
  return b;
}

/** Computed padding + the vertical gaps between a container's children — the numbers that decide
 *  whether spacing "looks reasonable", measured rather than judged from a picture. */
async function geometry(page: import("@playwright/test").Page, sel: string) {
  return page
    .locator(sel)
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      const kids = [...el.children].map((c) => c.getBoundingClientRect());
      const gaps: number[] = [];
      for (let i = 1; i < kids.length; i++) {
        const prev = kids[i - 1];
        const cur = kids[i];
        if (prev && cur) gaps.push(Math.round((cur.top - prev.bottom) * 10) / 10);
      }
      return {
        padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
        gap: s.rowGap,
        radius: s.borderRadius,
        bg: s.backgroundColor,
        border: `${s.borderTopWidth} ${s.borderTopColor}`,
        gaps,
      };
    });
}

/** Relative luminance contrast between two computed rgb() strings — for "is this surface actually
 *  distinguishable from the page behind it". */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r = 0, g = 0, bl = 0] = (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}

test.afterAll(() => {
  ensure();
  writeFileSync(`${OUT}/metrics.json`, `${JSON.stringify(metrics, null, 2)}\n`);
});

test("entry screen regions", async ({ page, seedHost }) => {
  const { pass } = await seedHost();
  await page.goto(`/#${encodeURIComponent(pass)}`);
  await expect(page.getByLabel("Machine pass", { exact: true })).toBeVisible();

  const card = await geometry(page, ".astryx-card");
  const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  metrics.push({
    region: "entry-card",
    padding: card.padding,
    gaps: card.gaps,
    notes: {
      radius: card.radius,
      cardBg: card.bg,
      bodyBg: body,
      // The complaint that this "looks like one flat slab": if the card can't be told from the page,
      // the layout has no structure regardless of how the insides are spaced.
      cardVsPageContrast: contrast(card.bg, body),
      border: card.border,
      innerGap: card.gap,
    },
  });

  await shot(page, "01-brand-lockup", ".brand");
  await shot(page, "02-heading-block", "h1");
  await shot(page, "03-field", ".pass-control");
  await shot(page, "04-cta", 'button:has-text("Connect")');
  await shot(page, "05-help", ".connect-help > summary");
  await page.locator(".connect-help > summary").click();
  await shot(page, "05a-help-command", ".connect-command");
  await shot(page, "06-card-whole", ".astryx-card");

  // Focused state: the ring is the loudest thing on the screen when the field autofocuses.
  await page.getByLabel("Machine pass", { exact: true }).focus();
  await shot(page, "07-field-focused", ".pass-control");
  const ring = await page.locator(".pass-control").evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.outlineColor, width: s.outlineWidth, offset: s.outlineOffset };
  });
  metrics.push({ region: "field-focus-ring", notes: ring });

  const btn = await geometry(page, 'button:has-text("Connect")');
  metrics.push({ region: "cta", padding: btn.padding, notes: { radius: btn.radius, bg: btn.bg } });
});

test("console regions", async ({ page, seedHost }) => {
  const { pass } = await seedHost({ harness: "tmux", caps: "tmux" });
  await page.goto(`/#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("button.row", { hasText: "rc box" })).toBeVisible();

  await shot(page, "10-topbar", "header.topbar");
  await shot(page, "11-session-row", "button.row");
  await shot(page, "12-agent-badge", ".agent-badge");
  await shot(page, "13-git-chip", ".git-chip");
  const row = await geometry(page, "button.row");
  metrics.push({
    region: "session-row",
    padding: row.padding,
    gaps: row.gaps,
    notes: { bg: row.bg },
  });

  await page.locator("button.row").click();
  await expect(page.locator(".transcript")).toBeVisible();
  await shot(page, "14-chat-head", ".chat-head");
  await shot(page, "15-composer", "form.composer");
  await shot(page, "16-composer-controls", ".composer-row");
  const comp = await geometry(page, "form.composer");
  metrics.push({ region: "composer", padding: comp.padding, gaps: comp.gaps });

  await shot(page, "17-assistant-prose", ".prose.assistant");
  await shot(page, "18-activity-rollup", ".activity-rollup");
  await page
    .getByRole("button", { name: /^Activity:/ })
    .first()
    .click();
  await expect(page.getByRole("dialog", { name: "Activity details" })).toBeVisible();
  await shot(page, "18a-tool-row", ".activity-list .tool-row");
});

test("transcript cards", async ({ page, seedHost }) => {
  const { pass } = await seedHost({ perm: true, caps: "compat-mitm" });
  await page.goto(`/#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row").click();
  await shot(page, "20-permission-card", ".perm");
  const perm = await geometry(page, ".perm");
  metrics.push({ region: "permission-card", padding: perm.padding, gaps: perm.gaps });
});

test("question card", async ({ page, seedHost }) => {
  const { pass } = await seedHost({ askq: true, caps: "compat-mitm" });
  await page.goto(`/#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row").click();
  await shot(page, "21-question-card", ".perm.perm-q");
  await shot(page, "22-question-option", ".q-option");
  await shot(page, "23-question-freeform", ".q-freeform");
  const q = await geometry(page, ".perm.perm-q");
  const opt = await geometry(page, ".q-option");
  metrics.push({ region: "question-card", padding: q.padding, gaps: q.gaps });
  metrics.push({
    region: "question-option",
    padding: opt.padding,
    notes: { radius: opt.radius, bg: opt.bg },
  });
});

test("mode sheet", async ({ page, seedHost }) => {
  const { pass } = await seedHost({ caps: "compat-mitm" });
  await page.goto(`/#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row").click();
  await page.getByTestId("composer-mode").click();
  // Wait for the sheet's slide + scrim animations to settle so the crop isn't a mid-animation frame.
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  await page.waitForFunction(() => {
    const els = [document.querySelector(".sheet-scrim"), document.querySelector(".sheet")];
    return els.every(
      (el) => el && (el as HTMLElement).getAnimations().every((a) => a.playState !== "running"),
    );
  });
  await shot(page, "30-mode-sheet", '[role="dialog"]');
  await shot(page, "31-mode-row", ".mode-row");
  const sheet = await geometry(page, '[role="dialog"]');
  const mrow = await geometry(page, ".mode-row");
  metrics.push({
    region: "mode-sheet",
    padding: sheet.padding,
    gaps: sheet.gaps,
    notes: { bg: sheet.bg },
  });
  metrics.push({ region: "mode-row", padding: mrow.padding });
});
