"use client";

import { IconButton } from "@astryxdesign/core/IconButton";
import type { ThemeMode } from "@astryxdesign/core/theme";
import { useThemeMode } from "./providers";

// A single icon-only control that CYCLES the colour mode: system → light → dark → system. A cycle (not a
// 3-way menu) keeps the topbar to one button; the glyph shows the current mode and the label/tooltip name
// both the current mode and the one a tap moves to, so it stays discoverable and screen-reader-legible.
const NEXT: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };
const NAME: Record<ThemeMode, string> = { system: "System", light: "Light", dark: "Dark" };

/** Small stroke icons keep the header visually stable across platforms; emoji changed size, colour and
 * baseline between Linux screenshots, iOS Safari and desktop browsers. */
function ThemeGlyph({ mode }: { mode: ThemeMode }) {
  if (mode === "system") {
    return (
      <svg aria-hidden viewBox="0 0 20 20" width="18" height="18" fill="none">
        <title>System theme</title>
        <rect
          x="2.5"
          y="3.5"
          width="15"
          height="10"
          rx="1.75"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M7 16.5h6M10 13.5v3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (mode === "light") {
    return (
      <svg aria-hidden viewBox="0 0 20 20" width="18" height="18" fill="none">
        <title>Light theme</title>
        <circle cx="10" cy="10" r="3.25" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M10 1.75v2M10 16.25v2M1.75 10h2M16.25 10h2M4.17 4.17l1.42 1.42M14.41 14.41l1.42 1.42M15.83 4.17l-1.42 1.42M5.59 14.41l-1.42 1.42"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 20 20" width="18" height="18" fill="none">
      <title>Dark theme</title>
      <path
        d="M16.6 12.2A6.75 6.75 0 0 1 7.8 3.4a6.75 6.75 0 1 0 8.8 8.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Colour-mode toggle for the topbar. Reads/writes the shared preference via useThemeMode(), which
 *  updates <Theme> live and persists to the rc-theme cookie. `data-theme-mode` mirrors the active mode
 *  for tests. */
export function ThemeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useThemeMode();
  const next = NEXT[mode];
  const label = `Theme: ${NAME[mode]} — switch to ${NAME[next]}`;
  return (
    <IconButton
      className={className}
      variant="ghost"
      icon={<ThemeGlyph mode={mode} />}
      label={label}
      tooltip={label}
      aria-label={label}
      data-theme-mode={mode}
      onClick={() => setMode(next)}
    />
  );
}
