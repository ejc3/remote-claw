import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the Astryx foundation at the level where it actually breaks: the CSS webpack EMITS.
 *
 * A cascade-layer mistake is the most common way an Astryx adoption fails, and it fails SILENTLY —
 * no build error, no runtime warning, just component styles quietly losing to (or beating) app CSS.
 * Two mistakes are specifically live for this app, and both were made once already:
 *
 *  1. The layer-ORDER declaration must land in the first-loaded stylesheet. Webpack hoists the contents
 *     of an @import above any inline rules in the importing file, so an `@layer a, b;` written inline in
 *     globals.css would sort AFTER the imports it is supposed to order. Hence app/layers.css.
 *  2. `@import "./viewer.css" layer(remote-claw)` DOES NOT WORK on Next 16 — the pipeline drops the
 *     `layer()` function and inlines the file unlayered, where it beats every layer for the wrong
 *     reason. viewer.css therefore carries its own `@layer remote-claw { … }` wrapper.
 *
 * Asserting on source text would miss both (the source looked right in each case); only the built
 * artifact tells the truth. Requires a prior `pnpm run build`, and is skipped when there isn't one so a
 * plain `vitest run` on a fresh clone doesn't fail for the wrong reason — CI builds before it tests.
 */
const CSS_DIR = join(import.meta.dirname, "..", ".next", "static", "css");

function builtCss(): { name: string; text: string }[] | null {
  try {
    if (!statSync(CSS_DIR).isDirectory()) return null;
  } catch {
    return null;
  }
  const files = readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"));
  if (files.length === 0) return null;
  return files.map((name) => ({ name, text: readFileSync(join(CSS_DIR, name), "utf8") }));
}

const sheets = builtCss();

describe.skipIf(sheets === null)("astryx foundation (built CSS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skipIf already gated on sheets !== null
  const css = sheets!;
  const all = css.map((c) => c.text).join("\n");

  it("declares the canonical layer order exactly once", () => {
    const decls = all.match(
      /@layer\s+reset\s*,\s*astryx-base\s*,\s*astryx-theme\s*,\s*remote-claw\s*;/g,
    );
    expect(decls, "app/layers.css must reach the build").not.toBeNull();
    expect(decls).toHaveLength(1);
  });

  it("puts the layer-order declaration at the very top of its stylesheet", () => {
    // If it sorted after any rule, the layers it names would already have been established in source
    // order and the declaration would be a no-op.
    const sheet = css.find((c) => /@layer\s+reset\s*,/.test(c.text));
    expect(sheet).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined on the line above
    expect(sheet!.text.trimStart().startsWith("@layer reset,")).toBe(true);
  });

  it("ships every viewer rule INSIDE @layer remote-claw", () => {
    // `.q-freeform` (the AskUserQuestion free-text box) and `.transcript` are viewer.css-only classes:
    // if either is emitted before the layer opens, the wrapper was dropped and the whole stylesheet is
    // unlayered.
    const sheet = css.find((c) => c.text.includes(".q-freeform"));
    expect(sheet, "viewer.css must reach the build").toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined on the line above
    const text = sheet!.text;
    const layerAt = text.indexOf("@layer remote-claw{");
    expect(layerAt, "viewer.css lost its @layer wrapper").toBeGreaterThanOrEqual(0);
    for (const cls of [".q-freeform", ".transcript{", ".perm-actions"]) {
      expect(text.indexOf(cls), `${cls} escaped @layer remote-claw`).toBeGreaterThan(layerAt);
    }
  });

  it("ships the astryx component and theme layers", () => {
    expect(all).toContain("@layer astryx-base{");
    expect(all).toContain("@layer astryx-theme{");
    // The brand theme is @scope'd to the attribute <Theme> sets; a mismatch here means the tokens
    // resolve to the neutral defaults and the whole palette silently shifts.
    expect(all).toContain('[data-astryx-theme="remote-claw"]');
  });

  it("keeps the shipped CSS within the viewer's CSP (no remote fonts or assets)", () => {
    // next.config.ts sends `font-src 'self'` and `default-src 'self'`. Astryx ships pre-compiled CSS
    // with no @font-face and no remote url() — assert it, because a theme package that pulled a Google
    // font would be blocked at runtime and only show up as unstyled text on a real device.
    const remote = all.match(/url\(\s*['"]?(?:https?:)?\/\//g) ?? [];
    expect(remote).toHaveLength(0);
    expect(all).not.toContain("@font-face");
  });
});
