---
name: pr-gate
description: The consolidated review gate for remote-claw — run before every PR push. Mechanical checks, VISUAL correctness for any viewer change, the traps each of which cost a real debugging cycle, and the process rules. Invoke on a branch to walk the gate against its diff.
---

# The remote-claw PR gate

Every entry here exists because something shipped wrong once. When invoked: run **Part 1**
mechanically, then review the diff against **Parts 2–5**, then confirm **Part 6**. A PR pushes only
when every gate passes, or a deviation is written explicitly into the PR description.

The rule that governs the whole document: **assert on the artifact that actually ships, not on the
source that produced it.** Most of what follows is a consequence of that.

---

## Part 1 — The mechanical gate (all must pass, in order)

Run from `apps/web` unless noted. Biome lives only in the workspaces, never at the repo root.

```
pnpm exec biome check .           # lint + format, from apps/web (NOT the repo root)
pnpm exec tsc --noEmit
pnpm run theme:build              # only if app/theme/remote-claw.ts changed
pnpm run build                    # MUST precede the tests — see below
RC_CI=1 pnpm exec vitest run      # RC_CI turns "no build output" into a failure, not a skip
cd ../../tests/web && pnpm exec playwright test -c app-e2e.config.ts
```

1. **Build before test, always.** `test/astryx-foundation.test.ts` asserts on the CSS webpack emits
   into `.next`. Without a build it finds nothing and *skips* — which is exactly how the cascade-layer
   guard was silently absent from CI for a commit. `RC_CI=1` makes that skip a hard failure.
2. **Reviews ran**: `codex exec -s read-only` on the diff, plus the `/simplify` angles. Findings
   triaged; every accepted one got a test that BITES (Part 3).
3. **Merge on green only** — CI on the PR head, including `web-preview-e2e`, which deploys a real
   Vercel preview and drives it.

---

## Part 2 — Visual correctness (mandatory for ANY change under `apps/web/app`)

**A green test suite does not mean the UI is right.** The migration onto Astryx flipped the primary
button to pale lavender with dark-blue text, and 375 tests stayed green — the design guard asserted the
disabled *treatment*, not the hue. A screenshot caught it. Nothing else could have.

So, for any diff that touches rendered markup or CSS:

1. **Capture before AND after.** Take the shots on the base commit first, then on the branch.

   ```
   cd tests/web
   pnpm exec playwright test -c app-e2e.shots.config.ts   # 11 surfaces × phone + desktop
   pnpm exec playwright test -c app-e2e.zoom.config.ts    # tight 3× crops + measured geometry
   ```

2. **LOOK at the images.** Open them. Not the filenames, not the test result — the pixels. This is
   non-negotiable and it is the whole point of the harness existing.

3. **Read `tests/web/zoom/metrics.json`.** "Padding looks fine" is not a finding; `padding: 8px 12px`
   on a 32px-tall primary CTA is. The harness measures padding, inter-element gaps, radius, background,
   and surface-vs-page contrast precisely so spacing is argued with numbers.

4. **Check these every time**, because each has been wrong at least once here:
   - **Touch targets ≥ 44px** on anything tappable. Astryx's largest Button is 36px; this app holds a
     44px floor (`.connect .astryx-button { min-height: 44px }`) and asserts it.
   - **Surface separation.** A card at 1.14:1 against the page is invisible; it needs a border AND
     elevation on this near-black palette. If a screen reads as one flat slab, this is why.
   - **Grouping.** A single uniform gap between every child produces an undifferentiated stack. Space
     BETWEEN groups (20px) must exceed space WITHIN one (8px).
   - **Focus rings** stay the bright accent, not the button fill (Part 4).
   - **Type hierarchy.** Explanatory copy must outrank a footnote. Astryx's `Text size` prop is INERT
     when the theme styles that `type`, so verify with `getComputedStyle`, not by reading the prop.

5. **A design regression gets a test only if a test could have caught it.** Hue, elevation and
   grouping mostly cannot be — say so in the PR and rely on the shots. Geometry can be: touch-target
   height, computed outline colour and font size all became assertions here.

---

## Part 3 — Tests must bite

- **Bite-validate every new guard**: break the thing on purpose, SEE the test go red with a message
  that names the actual problem, then restore. A guard that has never failed is a guess. Two guards in
  this repo passed happily against the bug they were written for — one read the wrong regex capture
  group, another crashed at collection instead of asserting.
- **`describe.skipIf` still RUNS its callback.** It skips the tests, not the body. A `sheets!` inside
  throws a TypeError at collection rather than skipping.
- **Assert on emitted artifacts.** `.next/static/css`, the prerendered HTML, `getComputedStyle` — not
  the source file. Both cascade-layer bugs read correctly in source.
- **Prove the regression path RAN**, not just that the end state looks right — count the action (e.g.
  `submit-count === 2`), and for a negative ("the banner never appeared") park the recovery assertion
  on a mutually exclusive element so a paint race can't fake a pass.
- **Generated artifacts get a drift gate.** `theme:check` rebuilds and diffs; it needs `git add -N`
  first, because `git diff` ignores untracked files and a deleted-from-commit artifact would otherwise
  pass.

---

## Part 4 — Astryx / CSS traps (each cost a real cycle)

Full findings, with evidence, in `docs/astryx-migration.md`.

- **`app/globals.css` is an import manifest.** A rule written there is UNLAYERED, and unlayered CSS
  beats every cascade layer.
- **`@import "…" layer(x)` does not work on Next 16** — the pipeline drops `layer()` and inlines the
  file unlayered, silently. Put `@layer name { … }` INSIDE the file.
- **The layer-order declaration needs its own file, imported first** (`app/layers.css`); webpack hoists
  imported CSS above the importing file's inline rules.
- **No bare element selectors in `@layer remote-claw`.** That layer is declared last, so `button { … }`
  or `code { … }` there silently restyles every Astryx component built from that element. Both of ours
  were redundant with Astryx's own reset and were doing real damage. Guarded.
- **The theme is compiled.** Edit `app/theme/remote-claw.ts`, run `pnpm run theme:build`; never edit
  `app/theme/built/`.
- **The accent is pinned on purpose.** Seeding `color: { accent }` alone makes Astryx INVERT it in dark
  mode. Pin `--color-accent` AND `--color-on-accent` together, never one alone.
- **Focus rings come from `--color-accent`**, which this theme pins to the darker fill. The global
  `:focus-visible` rule in `viewer.css` is what keeps them bright — it is NOT migration debt and must
  outlive the file.
- **Theme-layer rules beat prop-driven size classes.** `<Text size>` (and anything else the generated
  theme styles) is inert; the class is still emitted, so it looks like it worked.

---

## Part 5 — Simplify & altitude

- **Check whether the tool already does it.** Half of `build-theme.mjs` re-implemented
  `astryx theme build --out`, which relocates the whole artifact set. Read the CLI's own source before
  writing a workaround for it.
- **Prefer the CLI to scraping.** `astryx docs <topic>` / `astryx component <Name>` (with `--json`,
  `--dense`) is complete, offline and authoritative. A 240-agent scrape of the docs site was thrown away
  once the CLI was found.
- **Shared wrappers live in the shared component**, not copy-pasted at each call site.
- **A test hook is `data-testid` or a semantic locator**, never a dead CSS class kept alive for a
  selector.
- **Sentinels in guards should be things designed to SURVIVE**, or the guard cries wolf every time a
  component legitimately migrates and gets deleted.

---

## Part 6 — Process rules (non-negotiable, from CLAUDE.md)

- **Docs are source of truth and get a doc-sync pass** whenever `docs/*.md`, `CLAUDE.md` or the surface
  they describe changes: render through marked (no list markers stranded in `<p>`), check every claim
  against the code, reconcile the docs against each other, remove stale references.
- **Blank line before every list and table** in `docs/*.md` — an ordered list not starting at `1.`
  cannot interrupt a paragraph, and the result is the "jumbled" render.
- **Report findings honestly, including against ourselves.** One finding in the Astryx report was
  corrected after review because it named a non-bug; reporting it upstream would have been wrong.
- **Never kill the user's processes.** No `pkill` of live claude sessions or drivers; use worktrees.
- **Commit messages describe the diff**, not the request. PR bodies cover EVERY commit —
  `git log main..HEAD` read in full first.
- **Secrets never reach argv, logs, or `--rc-json`/`--rc-quiet` output.**
- **Merge on green, aggressively.** Don't stop at "PR opened".
