"use client";

import { IconButton } from "@astryxdesign/core/IconButton";
import type { ThemeMode } from "@astryxdesign/core/theme";
import { useThemeMode } from "./providers";

// A single icon-only control that CYCLES the colour mode: system → light → dark → system. A cycle (not a
// 3-way menu) keeps the topbar to one button; the glyph shows the current mode and the label/tooltip name
// both the current mode and the one a tap moves to, so it stays discoverable and screen-reader-legible.
const NEXT: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };
const GLYPH: Record<ThemeMode, string> = { system: "🖥️", light: "☀️", dark: "🌙" };
const NAME: Record<ThemeMode, string> = { system: "System", light: "Light", dark: "Dark" };

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
      icon={<span aria-hidden>{GLYPH[mode]}</span>}
      label={label}
      tooltip={label}
      aria-label={label}
      data-theme-mode={mode}
      onClick={() => setMode(next)}
    />
  );
}
