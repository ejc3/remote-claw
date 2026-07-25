// The remote-claw brand theme, expressed as an Astryx theme.
//
// The viewer supports BOTH colour modes (see providers.tsx: it defaults to `system` and the topbar toggle
// forces light/dark, persisted via the rc-theme cookie). Every token below is a `[light, dark]` tuple that
// Astryx compiles to `light-dark(light, dark)`, resolved off the `color-scheme` reset.css derives from
// <html data-theme>. It shipped dark-only for a long time; the light half was present-but-dormant all
// along, then verified (WCAG AA, screenshots in both modes) and turned on.
//
// The DARK half is the palette the hand-written stylesheet used before the Astryx migration, carried over
// verbatim so the migration is a *component* change, not a redesign; the LIGHT half is a cool-neutral
// surface (near-white bg, dark ink) with the accent-as-text tokens darkened for contrast on it. The
// contrast notes are load-bearing: they were measured for WCAG AA in BOTH modes. The hand-written
// viewer.css :root tokens mirror these same light/dark pairs so the two systems agree exactly.
//
// Regenerate the built artifacts (remote-claw.css / .js / .d.ts) with:  pnpm run theme:build
import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";

export const remoteClawTheme = defineTheme({
  name: "remote-claw",
  extends: neutralTheme,

  // Drive the accent FAMILY from one seed rather than hand-writing `--color-accent`: the generator
  // derives `--color-on-accent`, `--color-accent-muted` and the icon/text accents from the scale, so
  // they keep a contrast guarantee. (Hand-writing only `--color-accent` leaves `--color-on-accent` at a
  // stale white default — the exact trap called out in `astryx docs migration`.)
  // #5457e8 is the button FILL: white-on-fill measures 5.38:1 (the older #6366f1 was 4.47 — sub-AA).
  color: { accent: "#5457e8", neutralStyle: "cool" },

  typography: {
    body: {
      family: "ui-sans-serif",
      fallbacks: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    },
    heading: {
      family: "ui-sans-serif",
      fallbacks: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    },
    code: { family: "ui-monospace", fallbacks: '"SF Mono", Menlo, monospace' },
  },

  tokens: {
    // ---- the accent FILL: pinned, overriding what the accent scale derives ----
    // The scale above generates `--color-accent: light-dark(#424BDA, #CBBEFF)` — i.e. in dark mode it
    // INVERTS the accent into a pale lavender surface carrying dark text (`--color-on-accent: #001F9C`).
    // That's a coherent convention, but it isn't this product: remote-claw's primary action is a solid
    // indigo fill with white text, and that specific pair was measured at 5.38:1 (the older #6366f1 was
    // 4.47 — sub-AA). A screenshot caught the flip; no test did, because our design guard asserts the
    // disabled treatment (dimmed, non-transparent) rather than the hue.
    //
    // Pinning BOTH halves is the supported escape hatch ("explicit token overrides always take
    // precedence over scale-generated values") and specifically avoids the trap `astryx docs migration`
    // warns about — hand-writing `--color-accent` alone would leave `--color-on-accent` at a derived
    // value chosen for a completely different background. `--color-accent-muted` is derived from
    // `--color-accent` via color-mix(), so it follows automatically.
    "--color-accent": ["#5457e8", "#5457e8"],
    "--color-on-accent": ["#ffffff", "#ffffff"],

    // ---- surfaces: [cool-neutral light stack, near-black console stack] (bg → surface → raised) ----
    "--color-background-body": ["#f4f5f8", "#0a0a0b"],
    "--color-background-surface": ["#ffffff", "#141417"],
    "--color-background-card": ["#ffffff", "#141417"],
    // Popovers/sheets sit one step above a card so a bottom sheet reads as lifted off the transcript.
    "--color-background-popover": ["#ffffff", "#1b1b1f"],
    "--color-background-muted": ["#05365910", "#1b1b1f"],

    // ---- lines ----
    "--color-border": ["#05365919", "#26262b"],
    "--color-border-emphasized": ["#ccd3db", "#3a3a42"],

    // ---- text ----
    "--color-text-primary": ["#0a1317", "#ececee"],
    "--color-text-secondary": ["#4e606f", "#9a9aa3"],
    "--color-text-disabled": ["#a4b0bc", "#6f747c"],
    // Accent used AS TEXT or an ICON moves the OPPOSITE way from the fill, and opposite again by mode: on
    // dark, #7c7ef5 measures 5.8:1 on the body / 5.4:1 on a surface (the #5457e8 fill would be only ~3.4:1
    // there); on light, it darkens to #4b4ee0 (~6.5:1 on white, where #7c7ef5 would be ~2:1).
    //
    // NOTE this does NOT cover focus rings. Astryx draws them from `--color-accent`
    // (`outline: 2px solid var(--color-accent)` in astryx.css), not `--color-text-accent` — so on this
    // theme a stock Astryx focus ring is the darker FILL colour. It still clears the 3:1 that WCAG 2.2
    // SC 1.4.11 asks of a non-text indicator, but it is dimmer than the ring this app has always drawn.
    // The app therefore keeps its own global `:focus-visible` rule in viewer.css deliberately — that
    // rule is NOT migration debt to be deleted with the rest of the file. Guarded by the focus-ring
    // assertion in tests/web/app-e2e/viewer-ux.spec.ts so removing it fails loudly.
    "--color-text-accent": ["#4b4ee0", "#7c7ef5"],
    "--color-icon-accent": ["#4b4ee0", "#7c7ef5"],

    // ---- status: online / needs-you / failed ----
    "--color-success": ["#0d8626", "#34d399"],
    "--color-warning": ["#b07d05", "#fbbf24"],
    "--color-error": ["#e3193b", "#fb7185"],
  },
});
