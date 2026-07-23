# Migrating the remote-claw viewer to Astryx

A running, evidence-based log of moving `apps/web` (a Next.js 16 / React 19 dark-only chat-transcript
viewer for remote Claude Code sessions) onto **[Astryx](https://astryx.atmeta.com)** — Meta's MIT-licensed
React design system, `@astryxdesign/core@0.1.8` (public beta).

It is written to be **shareable with the Astryx developers**: everything below is something we actually
hit, with the evidence that proves it, not an impression. Findings are added as the migration proceeds.

- **Our stack:** Next.js 16.2.7 App Router, React 19.2.7, **webpack** (`next build --webpack`), pnpm 10
  strict `node_modules`, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`), Biome, Playwright, a strict CSP (`style-src 'self' 'unsafe-inline'`,
  `font-src 'self'`, `connect-src 'self'`).
- **Starting point:** one 2 504-line `page.tsx` and a hand-written 1 567-line stylesheet.
- **Constraint that shaped everything:** ~130 Playwright locators target the viewer's own CSS classes,
  so the migration had to be incremental rather than a rewrite.

---

## Status

| Surface | State | Astryx components used |
| --- | --- | --- |
| Cascade layers, theme, build, CSP | **Done** | `Theme`, `defineTheme`, `astryx theme build` |
| Entry screens (Connect / Pairing / Reconnecting) | **Done** | `Card` `VStack` `Heading` `Text` `TextArea` `Button` `Banner` `Code` `Spinner` |
| Transcript (messages, tool rows, prose) | Next | `ChatMessageList` `ChatMessage` `ChatMessageBubble` `ChatSystemMessage` `ChatToolCalls` `Markdown` `CodeBlock` `Collapsible` |
| Composer | Planned | `ChatComposer` `ChatComposerInput` `ChatSendButton` |
| Bottom sheets / dropdowns | Planned | `Dialog` `Popover` `RadioList` |
| Session list + app frame | Planned | `AppShell` `Layout` `LayoutPanel` `List` `Item` `StatusDot` `Badge` |

---

## What works well

**1. The published package really is build-step-free on Next.js + webpack.**
Three CSS imports and one provider, exactly as documented, and it built first try. No Babel, no PostCSS,
no StyleX compiler, no `next.config` change. Given `astryx docs styling` describes Next.js App Router as
"the sharp edge" for StyleX, it is worth stating plainly in the Quick Start that *consumers who don't
author StyleX never touch that path at all* — we only learned it was a non-issue by reading further.

**2. `BaseProps` keeping `className`, `style`, `id`, `data-*` and `aria-*` is what made this possible.**
An incremental migration of an app with ~130 CSS-selector-based browser tests is only feasible because
components forward these. A system that only accepted `xstyle` would have forced a big-bang rewrite of
the app *and* its test suite in one commit. This deserves to be advertised louder than it is — it is
arguably the single most important adoption property.

**3. The CLI is a better documentation surface than the website, and should be the headline.**
`astryx docs <topic>`, `astryx component <Name>`, `astryx hook`, `astryx template`, plus `--json` and
`--dense`, gave complete, offline, machine-readable docs. We started by fanning out ~240 agents to scrape
`astryx.atmeta.com`; we threw that away once we found the CLI, which was both more accurate and free. The
docs site is a Next.js app whose content is inside an RSC payload, so it fetches poorly — the CLI has no
such problem.

**4. `astryx docs migration` predicted our worst bug before we hit it.**
Its "Cascade Layer Safety" section describes exactly the failure we then walked into (see finding **B**),
including the webpack `@import`-hoisting caveat and the `layers.css` remedy. Docs that name the specific
silent failure mode of the specific bundler are rare and valuable.

**5. `defineTheme` is expressive enough to carry a brand across without fighting it.**
The whole palette — near-black surface stack, two-value accent, status colours, type families — is 60
lines of `defineTheme` extending `neutralTheme`, and `astryx theme build` turns it into a static CSS file
that ships the tokens on first paint. The one place it surprised us is how the accent scale behaves in
dark mode (finding **F**), and even that had a documented escape hatch.

**6. The Chat family is a genuinely close fit for an agent-transcript UI.**
`ChatMessageList` already ships `role="log"` + `aria-live="polite"` + `aria-busy` via `isStreaming` — we
had hand-rolled all three. `ChatToolCalls` models status / target / duration / additions+deletions /
`resultDetail`, which is almost exactly our tool-call row including the diff stat. `Markdown` has
`isStreaming` and GFM `autolink`, which may let us drop `react-markdown` + `remark-gfm` entirely.

**7. CSP-clean out of the box.**
`reset.css`, `astryx.css` and the built theme CSS contain no `@font-face`, no `@import`, and no remote
`url()`. Under `font-src 'self'` / `default-src 'self'` that matters, and a theme package that pulled a
webfont would fail only on a real device. We now assert it in a test.

**8. `astryx docs layout` archetypes are good design advice, not filler.**
"Messaging / feed → rows and bubbles, no cards in the stream" matched the layout we had already arrived
at independently, which raised our confidence that adopting the system wouldn't fight the product.

**9. Three of our hand-tuned design/a11y assertions passed against Astryx components unchanged.**
This is the strongest evidence we have that the defaults are considered. All three were written as
regression guards against real bugs we had shipped, and all three still pass with the hand-written CSS
deleted:

| Our guard (written before Astryx existed for us) | Astryx component | Result |
| --- | --- | --- |
| Disabled primary CTA must stay a dimmed accent fill (`opacity: 0.5`, non-transparent background), not a dead grey slab | `Button variant="primary" isDisabled` | passes unchanged |
| The pass field must be ≥16px so iOS Safari doesn't auto-zoom on focus (we deliberately allow pinch-zoom, so font size *is* the guard) | `TextArea` | passes unchanged |
| The connect gate must autofocus its single field | `TextArea hasAutoFocus` | passes unchanged |

`Button`'s `isLoading` was also a straight upgrade: we used to swap the label to "Connecting…", which
changes the accessible name mid-flight. `isLoading` keeps the name stable and adds a spinner plus
`aria-busy`.

---

## Problems and friction

Ordered by how much time each cost us.

### A. `@stylexjs/stylex` is missing from the install instructions — hard runtime failure on pnpm

`README.md` Quick Start and `astryx docs getting-started` both say:

```bash
npm install @astryxdesign/core @astryxdesign/theme-neutral
```

But `@stylexjs/stylex` is a **peer dependency** of `@astryxdesign/core`, and **202 files in `dist/`
import it at runtime**:

```bash
$ grep -rl "@stylexjs/stylex" node_modules/@astryxdesign/core/dist --include="*.js" | wc -l
202
```

npm and yarn auto-install peer dependencies, so this is invisible there. **pnpm does not**, and pnpm's
strict `node_modules` means the package is genuinely unreachable — every component throws on import.

**Suggested fix:** add `@stylexjs/stylex` to the documented install line, or move it from
`peerDependencies` to `dependencies` (consumers who don't author StyleX have no reason to control its
version). A note in `astryx doctor` would also catch it.

### B. `@import "…" layer(name)` is silently dropped by Next.js's CSS pipeline

This is the one that actually broke us, and it is the exact failure class `astryx docs migration` warns
about — so it is worth the docs naming it explicitly.

We wrote the documented shape:

```css
/* app/globals.css */
@import "./layers.css";                 /* @layer reset, astryx-base, astryx-theme, remote-claw; */
@import "@astryxdesign/core/reset.css";
@import "@astryxdesign/core/astryx.css";
@import "./theme/built/remote-claw.css";
@import "./viewer.css" layer(remote-claw);   /* ← our 1567-line legacy stylesheet */
```

Next 16 inlines `viewer.css` but **discards the `layer()` function**, so the whole legacy stylesheet ships
**unlayered** — where it beats every cascade layer. There is no error and no warning, and the page *looks*
correct, because unlayered CSS winning happens to be what we wanted on day one. The layer we believed we
were in simply did not exist, and every later "did this component's styles take effect?" question would
have had a wrong answer.

Verified against the built artifact, not the source:

```js
// .next/static/css/*.css  — before the fix
"@layer remote-claw{".indexOf → -1        // the layer never opens
".q-freeform".indexOf        → 29843      // …but our rules are all there, unlayered
```

**Workaround:** put the layer *inside* the file. A file-internal `@layer name { … }` block survives the
pipeline intact (it is how `astryx.css` itself ships):

```css
/* app/viewer.css */
@layer remote-claw {
  :root { … }
  /* … */
}
```

**Why this matters beyond us:** the documented Tailwind-coexistence recipe in `astryx docs migration` and
`astryx docs styling` is built entirely on `@import "tailwindcss/preflight.css" layer(base)` and
`@import "tailwindcss/utilities.css" layer(utilities)`. On Next.js + webpack those appear to have the same
problem, which would put Tailwind preflight *above* `astryx-theme` — the precise silent override the doc
tells you to avoid. Worth verifying on your side and documenting the Next.js-specific shape.

We now guard it with a test that asserts on the **emitted** CSS; a source-level assertion passes in both
the broken and the fixed state.

### C. `astryx theme build` writes `<name>.js` next to `<name>.ts`

```bash
$ astryx theme build app/theme/remote-claw.ts
# → app/theme/remote-claw.css, remote-claw.js, remote-claw.d.ts, remote-claw.variants.d.ts
```

The built module lands beside its own source with the same basename. Our `next.config.ts` sets
`extensionAlias: { ".js": [".ts", ".tsx", ".js"] }` (unrelated — it exists so a workspace package's raw-TS
exports resolve), which tries `.ts` **first**. So `import { remoteClawTheme } from "./theme/remote-claw.js"`
resolves to the **source** theme — the runtime-`<style>`-injection path — instead of the built one. Silently:
same export name, same shape, just without `__built: true`. A bare extensionless import has the same
ambiguity under normal webpack `resolve.extensions` ordering.

**Suggested fix:** an `--out-dir` for all artifacts (today `-o` only controls the CSS), or default the
built module to a distinguishable name such as `<name>.built.js`. We work around it with a wrapper script
that moves the four artifacts into `theme/built/`.

### D. Generated artifacts carry a timestamp, so committed output can't be drift-checked

Every emitted file starts with:

```
 * Generated: 2026-07-23T14:28:08.031Z
```

We commit the built theme so CI and Vercel never have to run the CLI. With the timestamp, **every rebuild
produces a diff**, which makes the artifacts unreviewable and makes a "did someone edit the built file
instead of the source?" CI gate impossible. We post-process the line away to get byte-identical rebuilds.

**Suggested fix:** drop the timestamp (the `Source:` and `Command:` lines already carry the useful
provenance), or gate it behind a flag. Reproducible generated output is worth a lot.

### E. The `astryx init` nudge is printed on stdout of every command

```bash
$ astryx docs theme | head -2

Next step: run `pnpm exec astryx init` to finish setup and install the Astryx agent prompt.
```

That line is prepended to the stdout of `docs`, `component`, `hook` and `template`, so anything that pipes
or captures CLI output has to strip it. (`--json` is clean, which is the right instinct — the same should
apply to the text output.)

**Suggested fix:** send the nudge to **stderr**. It stays visible to a human, and disappears from pipes.

### F. `defineTheme`'s accent scale INVERTS the accent in dark mode — and no test caught it

Seeding the accent family the documented way:

```ts
defineTheme({ name: 'remote-claw', extends: neutralTheme, color: { accent: '#5457e8' } })
```

generates:

```js
"--color-accent":    "light-dark(#424BDA, #CBBEFF)"
"--color-on-accent": "light-dark(#FFFFFF, #001F9C)"
```

In **dark** mode the accent becomes a pale lavender **surface** carrying **dark** text. That is a
coherent convention, and for a system default it is probably the right one. But it is a surprise when the
reason you are writing a theme is to *carry an existing brand across*: our primary action is a solid
indigo fill with white text, and that exact pair was measured at 5.38:1 for WCAG AA. The generated theme
silently replaced both halves.

**What makes this worth reporting is how it was caught.** Our full gate stayed green — 339 unit tests and
36 Playwright tests, including a bespoke design guard that asserts the disabled primary CTA is a *dimmed
non-transparent fill* rather than a grey slab. That guard passed, because it asserts the treatment, not
the hue. Only a screenshot showed it.

The fix is supported and documented ("explicit token overrides always take precedence over
scale-generated values") — pin **both** halves, never just one:

```ts
tokens: {
  '--color-accent':    ['#5457e8', '#5457e8'],
  '--color-on-accent': ['#ffffff', '#ffffff'],
}
```

**Suggested docs change:** `astryx docs theme` explains how to *seed* an accent and warns against
hand-writing `--color-accent` alone. It would help to also say, in the same place, that the seed
**inverts for dark mode**, and show this pin-both-halves snippet as the supported way to keep a fixed
brand fill. Right now the only warning points the other way, which nudges you toward the scale API and
away from the thing you actually need.

### G. Small surprises worth a line in the docs

- **`Button` renders its label inside a nested `<span>`.** Reasonable, but it means a test that walks
  from a label up to "the element that renders it" lands on the span, not the button. Anything asserting
  on `data-variant` has to walk out to the enclosing `<button>`. A sentence in the testing guidance
  would save the next person the same five minutes.
- **`Code` is an inline span with no block form.** For a value that must wrap on any character and own
  its own line (in our case a 32-byte identity hex the user visually compares against a CLI's output),
  `CodeBlock` is too heavy — it brings a header bar, language label and copy button. We ended up with a
  small `display: block` class on `Code`. A `display` prop mirroring `Text`'s would cover it.
- **`TextArea` requires `label`**, which is the right call, and `isLabelHidden` covers the
  previously-`aria-label`-only case cleanly. Worth calling out in the migration doc as the standard
  translation for `<textarea aria-label="…">`, since it changes how tests select the field
  (`getByLabel` rather than a class).

### H. Minor CLI papercuts

- `astryx docs --list` errors with `unknown option '--list'`, even though bare `astryx docs` prints exactly
  that list and `astryx component --list` / `astryx template --list` both exist. The inconsistency sent us
  looking for a subcommand that isn't there.
- `astryx hook --json` returned a payload our generic walker found no names in, while
  `astryx component --list --json` worked first try. Worth checking the two share a shape.
- `@astryxdesign/cli` declares `@astryxdesign/lab` and `@astryxdesign/charts` as peer dependencies. Neither
  is mentioned in the docs and pnpm warns about both on install.

### I. Weight, for awareness rather than complaint

`@astryxdesign/core@0.1.8` unpacks to **15.5 MB across 2 440 files**, and `dist/astryx.css` is **127 KB**
uncompressed and loaded in full regardless of which components a page uses. For a viewer whose primary
device is a phone on a hotel network, that is the one number we are watching. Per-component CSS splitting
(or a documented way to subset the stylesheet) would matter to us before we ship this to production.

---

## Things we got wrong (not Astryx's fault, recorded so others don't repeat them)

- We initially fanned out ~240 agents to scrape the docs site. The CLI made all of it redundant. **Check
  for `astryx docs` first.**
- We reached for `xstyle` before reading `astryx docs styling` to the end. On Next.js App Router,
  authoring your own StyleX requires an SWC-based transform; `className` plus token-backed CSS avoids the
  whole question. For an app that already has a stylesheet, `className` + `var(--token)` is the
  lower-friction path and interoperates fine.

---

## How we verify each step

1. `pnpm run build` — the real production webpack build.
2. `vitest run` — includes `test/astryx-foundation.test.ts`, which asserts against the **emitted** CSS:
   layer order declared once and sorted first, every legacy rule inside `@layer remote-claw`, both Astryx
   layers present, the theme's `@scope` attribute matching, and no remote `url()`/`@font-face`.
3. `playwright test -c app-e2e.config.ts` — the existing browser suite, driving a real Chromium against a
   real Next server, a real broker and a real host process.
4. `playwright test -c app-e2e.shots.config.ts` — 11 screenshots per surface at phone and desktop widths,
   captured before and after each step and compared.
5. `codex exec` as an independent reviewer on the diff.

Each guard is **bite-validated**: we break the thing on purpose and confirm the test fails before trusting
it. The cascade-layer guard was validated this way — removing the `@layer` wrapper turns it red with
`viewer.css lost its @layer wrapper`.
