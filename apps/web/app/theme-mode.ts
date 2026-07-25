// Colour-mode helpers shared by the SERVER layout (which reads the cookie) and the CLIENT providers/toggle
// (which write it). This module has NO "use client" directive on purpose: providers.tsx does, and a value
// exported from a client module can't be called on the server (Next throws "Attempted to call X from the
// server but X is on the client"). Keeping the cookie name + the validator here lets both sides import them.
import type { ThemeMode } from "@astryxdesign/core/theme";

/** The cookie that persists the colour-mode preference. Read server-side by the root layout (so the first
 *  server render already carries the right `data-theme` on <html> — no flash, no hydration mismatch) and
 *  written client-side by the toggle. Kept in one place so both sides agree. */
export const THEME_COOKIE = "rc-theme";

/** Validate an untrusted string (cookie value, etc.) into a ThemeMode, defaulting to "system". */
export function coerceThemeMode(value: string | undefined | null): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}
