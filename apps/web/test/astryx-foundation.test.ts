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
 * artifact tells the truth.
 *
 * This needs a prior `pnpm run build`. Locally, a fresh clone running a bare `vitest run` has no build
 * output, and failing there would just be noise — so it skips. In CI that same skip would silently
 * DISARM the guard (and did: .github/workflows/web.yml used to run test:run before build), so CI sets
 * RC_CI=1, which turns a missing build into a hard failure instead.
 */
const CSS_DIR = join(import.meta.dirname, "..", ".next", "static", "css");
/** Set by .github/workflows/web.yml. Not `process.env.CI`: that is also set by unrelated local tooling
 *  and by the app-e2e runner, where a bare vitest without a build is legitimate. */
const REQUIRE_BUILD = process.env.RC_CI === "1";

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

describe("astryx foundation build output", () => {
  it.skipIf(!REQUIRE_BUILD)("is present (RC_CI=1 ⇒ the guards below must actually run)", () => {
    expect(
      sheets,
      `no CSS under ${CSS_DIR} — run \`pnpm run build\` before the tests, or the cascade-layer and CSP guards silently skip`,
    ).not.toBeNull();
  });
});

/** Split a stylesheet into its top-level `@layer NAME { … }` blocks by brace matching, and return what
 *  is left over once they are removed. `rest` is the load-bearing half: any rule that survives there is
 *  UNLAYERED, and unlayered CSS beats every cascade layer regardless of specificity. Sampling a few
 *  class names instead (the first version of this test) proves nothing about the rules it didn't name. */
function splitLayers(css: string): { blocks: { name: string; body: string }[]; rest: string } {
  const blocks: { name: string; body: string }[] = [];
  let rest = "";
  let i = 0;
  const OPEN = /@layer\s+([A-Za-z0-9_-]+)\s*\{/g;
  while (i < css.length) {
    OPEN.lastIndex = i;
    const m = OPEN.exec(css);
    if (m === null) {
      rest += css.slice(i);
      break;
    }
    rest += css.slice(i, m.index);
    let depth = 1;
    let j = OPEN.lastIndex;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
    }
    blocks.push({ name: m[1] ?? "", body: css.slice(OPEN.lastIndex, j - 1) });
    i = j;
  }
  return { blocks, rest };
}

/** The stylesheet <link> hrefs of the prerendered route, IN DOCUMENT ORDER. The layer-order declaration
 *  has to reach the browser before the layers it names are first used; a sheet that merely *starts* with
 *  the declaration proves nothing if the browser loaded astryx-base first. */
function linkedStylesheets(): string[] | null {
  for (const html of ["index.html", "_not-found.html"]) {
    const p = join(import.meta.dirname, "..", ".next", "server", "app", html);
    try {
      const text = readFileSync(p, "utf8");
      const hrefs = [...text.matchAll(/static\/css\/([a-z0-9]+\.css)/g)].map((m) => m[1] ?? "");
      if (hrefs.length > 0) return [...new Set(hrefs)];
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

describe.skipIf(sheets === null)("astryx foundation (built CSS)", () => {
  // `describe.skipIf` skips the TESTS but still RUNS this callback during collection, so this body has
  // to survive `sheets === null` rather than assume the guard above already excluded it — asserting
  // non-null here crashed collection with a TypeError instead of skipping.
  const css = sheets ?? [];
  const all = css.map((c) => c.text).join("\n");

  it("declares the canonical layer order exactly once", () => {
    const decls = all.match(
      /@layer\s+reset\s*,\s*astryx-base\s*,\s*astryx-theme\s*,\s*remote-claw\s*;/g,
    );
    expect(decls, "app/layers.css must reach the build").not.toBeNull();
    expect(decls).toHaveLength(1);
  });

  it("loads the layer-order declaration in the FIRST stylesheet the route links", () => {
    // Not "the declaration starts its own file" — that proves nothing if the browser loaded
    // astryx-base first, which would establish the order from source order and make the declaration a
    // no-op. Assert against the document's actual <link> order.
    const linked = linkedStylesheets();
    expect(linked, "no prerendered route HTML to read stylesheet order from").not.toBeNull();
    const first = css.find((c) => c.name === (linked ?? [])[0]);
    expect(first, `first linked stylesheet ${(linked ?? [])[0]} not found on disk`).toBeDefined();
    expect(first?.text.trimStart().startsWith("@layer reset,")).toBe(true);
  });

  it("emits NO unlayered rules — not one, anywhere", () => {
    // The general form of the bug. The previous version sampled three class names and checked they
    // appeared after an opening `@layer`; that passes for a rule after the layer's CLOSING brace, and
    // says nothing about the hundreds of rules it didn't name. Strip every balanced `@layer NAME { … }`
    // block and assert what remains contains no rule at all.
    for (const sheet of css) {
      const { rest } = splitLayers(sheet.text);
      // What may legitimately survive: the bare `@layer a, b, c;` ORDER declaration, @charset, and
      // whitespace. Anything with a body is an unlayered rule.
      const leftover = rest
        .replace(/@layer[^{;]*;/g, "")
        .replace(/@charset[^;]*;/g, "")
        .trim();
      expect(leftover, `unlayered CSS in ${sheet.name}: ${leftover.slice(0, 200)}`).toBe("");
    }
  });

  it("puts the viewer's own rules in the remote-claw layer specifically", () => {
    // Unlayered is not the only failure — landing in the WRONG layer (e.g. astryx-base, where it would
    // lose to the theme) is just as silent.
    const sheet = css.find((c) => c.text.includes(".q-freeform"));
    expect(sheet, "viewer.css must reach the build").toBeDefined();
    const { blocks } = splitLayers(sheet?.text ?? "");
    const mine = blocks
      .filter((b) => b.name === "remote-claw")
      .map((b) => b.body)
      .join("\n");
    for (const cls of [".q-freeform", ".transcript{", ".perm-actions", ".identity-hex"]) {
      expect(mine, `${cls} is not inside @layer remote-claw`).toContain(cls);
    }
  });

  it("puts the brand theme's tokens inside @layer astryx-theme", () => {
    // Checking "an astryx-theme layer exists" and "the brand scope appears somewhere" independently
    // would pass even if the scope were emitted unlayered or into another layer — at which point the
    // palette silently falls back to the neutral defaults.
    expect(all).toContain("@layer astryx-base{");
    const themed = css
      .flatMap((c) => splitLayers(c.text).blocks)
      .filter((b) => b.name === "astryx-theme")
      .map((b) => b.body)
      .join("\n");
    expect(themed, "no @layer astryx-theme content").not.toBe("");
    expect(themed, "brand @scope is not inside @layer astryx-theme").toContain(
      '[data-astryx-theme="remote-claw"]',
    );
    // The pinned brand pair specifically (finding F in docs/astryx-migration.md): seeding the accent
    // family alone makes Astryx INVERT it in dark mode into a pale fill carrying dark text. Nothing
    // else in the suite sees hue — the design guard in viewer-ux.spec.ts asserts the disabled
    // TREATMENT, and passed happily while the button was lavender. Compared whitespace-insensitively
    // because the shipped CSS is minified.
    const dense = themed.replace(/\s+/g, "");
    expect(dense, "the accent is no longer pinned — dark mode will invert it").toContain(
      "--color-accent:light-dark(#5457e8,#5457e8)",
    );
    expect(dense, "--color-on-accent must be pinned WITH --color-accent, never alone").toContain(
      "--color-on-accent:light-dark(#ffffff,#ffffff)",
    );
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
