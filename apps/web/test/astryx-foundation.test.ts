import { readdirSync, readFileSync } from "node:fs";
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
    const files = readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"));
    if (files.length === 0) return null;
    return files.map((name) => ({ name, text: readFileSync(join(CSS_DIR, name), "utf8") }));
  } catch {
    return null; // no build output yet
  }
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
 *  class names instead (the first version of this test) proves nothing about the rules it didn't name.
 *
 *  The brace count is deliberately naive — it does not skip `{`/`}` inside a string or `url()`. Verified
 *  safe two ways: the shipped CSS today contains ZERO braces inside any string/url token (a real
 *  tokenizer walk confirms it), so the count is exact; and even if a future surface introduced a
 *  `content: "{"`, a mis-split can only close a layer block EARLY, dumping the real CSS after it into
 *  `rest` — which turns the "no unlayered rules" assertion RED. It fails CLOSED. Do not "harden" this
 *  into a string-aware parser that could instead swallow a stray rule and fail open. */
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

/** The FIRST stylesheet the route links, in the order the browser loads them. The layer-order
 *  declaration has to reach the browser before the layers it names are first used, so a sheet that merely
 *  *starts* with the declaration proves nothing if the browser loaded astryx-base ahead of it.
 *
 *  Read from Next's client-reference-manifest (`entryCSSFiles`) rather than a prerendered index.html: the
 *  root layout reads the rc-theme cookie for light/dark, so the route is DYNAMIC and Next emits no static
 *  route HTML on disk (only _global-error.html survives). The manifest is the exact source Next itself
 *  uses to emit the <link> tags, so it's authoritative for a dynamic route as much as a static one — and
 *  it lists the layout's CSS (the globals.css chain) before the page's, each in load order, so the first
 *  `static/css/*` path in `entryCSSFiles` is the first <link> the browser sees. Returns null when the
 *  manifest is absent (no build), which the caller asserts on rather than skipping past. */
function firstLinkedStylesheet(): string | null {
  const p = join(
    import.meta.dirname,
    "..",
    ".next",
    "server",
    "app",
    "page_client-reference-manifest.js",
  );
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  // Anchor to entryCSSFiles so a future JS chunk named like a css file can't be mistaken for the first
  // sheet; within it, the first css path is the first-loaded <link>.
  const section = text.slice(text.indexOf("entryCSSFiles"));
  const m = section.match(/static\/css\/([a-z0-9]+\.css)/);
  return m?.[1] ?? null;
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
    // no-op. Assert against the route's actual <link> order (from Next's client-reference-manifest).
    const name = firstLinkedStylesheet();
    expect(
      name,
      "no client-reference-manifest to read stylesheet order from — run `pnpm run build`",
    ).not.toBeNull();
    const first = css.find((c) => c.name === name);
    expect(first, `first linked stylesheet ${name} not found on disk`).toBeDefined();
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
    // lose to the theme) is just as silent, and the no-unlayered test above wouldn't see it.
    //
    // The sentinel is `.identity-hex` deliberately: it is the one rule in viewer.css designated to
    // SURVIVE the migration (layout Astryx doesn't cover, written in Astryx tokens). Sampling classes
    // like `.q-freeform` or `.perm-actions` instead would turn this red every time their component
    // migrates and the rule legitimately disappears — a guard that cries wolf gets deleted.
    const sheet = css.find((c) => c.text.includes(".identity-hex"));
    expect(sheet, "viewer.css must reach the build").toBeDefined();
    const mine = splitLayers(sheet?.text ?? "")
      .blocks.filter((b) => b.name === "remote-claw")
      .map((b) => b.body)
      .join("\n");
    expect(mine, ".identity-hex is not inside @layer remote-claw").toContain(".identity-hex");
  });

  it("ships astryx's own component layer", () => {
    expect(all).toContain("@layer astryx-base{");
  });

  it("puts the brand theme's tokens inside @layer astryx-theme", () => {
    // Checking "an astryx-theme layer exists" and "the brand scope appears somewhere" independently
    // would pass even if the scope were emitted unlayered or into another layer — at which point the
    // palette silently falls back to the neutral defaults.
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

  it("keeps the viewer's core hand-written tokens mode-aware (light-dark) so light mode can't silently regress", () => {
    // The hand-written viewer.css tokens carry BOTH halves via light-dark(), which resolves off the
    // color-scheme reset.css derives from <html data-theme>. Reverting any of these to a single value
    // breaks one whole mode with no error and no failing render on the OTHER mode — exactly the class of
    // silent regression this file exists to catch (cf. the accent-inversion that only a screenshot caught).
    // Asserted on the built, minified CSS (`--bg:light-dark(...)`), not source.
    const dense = all.replace(/\s+/g, "");
    for (const tok of [
      "--bg",
      "--surface",
      "--text",
      "--accent-text",
      "--warn",
      "--danger",
      "--add-fg",
      "--del-fg",
    ]) {
      expect(
        dense,
        `${tok} is no longer light-dark() — light or dark mode will render stale colours`,
      ).toMatch(new RegExp(`${tok.replace(/[-]/g, "\\-")}:light-dark\\(`));
    }
  });

  it("has no bare element selectors left in @layer remote-claw", () => {
    // The subtlest failure mode of this migration, and one we shipped for a commit. @layer remote-claw
    // is declared LAST so hand-written rules keep winning while surfaces migrate — which also means a
    // BARE ELEMENT selector there (`button { … }`, `code { … }`) silently restyles every Astryx
    // component built from that element. It cost us a Button rendering at 16px/400 instead of Astryx's
    // 14px/500, and a <Code> at 10.32px. Both rules were redundant with Astryx's own reset.
    //
    // Structural selectors that don't target a component's element are fine, so this allows the
    // page-frame ones (html/body/:root/*) and anything class- or attribute-qualified.
    const sheet = css.find((c) => c.text.includes(".identity-hex"));
    const mine = splitLayers(sheet?.text ?? "")
      .blocks.filter((b) => b.name === "remote-claw")
      .map((b) => b.body)
      .join("");
    const ALLOWED = new Set(["html", "body", ":root", "*", "*::before", "*::after", "from", "to"]);
    const offenders = new Set<string>();
    // Selector lists sit before each `{`, delimited by the end of the previous rule. Group 1 is that
    // delimiter and group 2 is the selector list — destructure past the delimiter, or this reads `}`
    // as the selector and never finds anything (which is exactly how the first version of this guard
    // passed with `button {}` reintroduced).
    for (const [, , prelude] of mine.matchAll(/(^|[};])([^{};@]+)\{/g)) {
      for (const sel of (prelude ?? "").split(",")) {
        const s = sel.trim();
        // A bare element selector is a lone identifier: no ., #, [, :, >, +, ~ or descendant space.
        if (/^[a-z][a-z0-9]*$/.test(s) && !ALLOWED.has(s)) offenders.add(s);
      }
    }
    expect(
      [...offenders],
      "bare element selectors in @layer remote-claw override Astryx components built from those elements",
    ).toEqual([]);
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
