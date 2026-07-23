// The remote-claw brand theme, expressed as an Astryx theme.
//
// The viewer is DARK-ONLY (see providers.tsx, which pins `mode="dark"`): it's a console you open on a
// phone at night to steer a machine, and a light mode would be a second, untested surface. Every token
// below is therefore a `[light, dark]` tuple whose DARK half is the one that ships — the light half is
// kept honest (and legible) so a future light mode starts from something sane rather than nothing.
//
// These values are the palette the hand-written stylesheet used before the Astryx migration, carried over
// verbatim so the migration is a *component* change, not a redesign. The contrast notes are load-bearing:
// they were measured for WCAG AA and re-checked here.
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

    // ---- surfaces: the near-black console stack (bg → surface → raised) ----
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
    // Accent used AS TEXT/border/focus on the dark bg moves the OPPOSITE way from the fill: #7c7ef5
    // measures 5.8:1 on the body and 5.4:1 on a surface, where the #5457e8 fill would be only ~3.4:1.
    "--color-text-accent": ["#4b4ee0", "#7c7ef5"],
    "--color-icon-accent": ["#4b4ee0", "#7c7ef5"],

    // ---- status: online / needs-you / failed ----
    "--color-success": ["#0d8626", "#34d399"],
    "--color-warning": ["#b07d05", "#fbbf24"],
    "--color-error": ["#e3193b", "#fb7185"],
  },
});
