import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";
import { coerceThemeMode, THEME_COOKIE } from "./theme-mode";

export const metadata: Metadata = {
  title: "remote-claw",
  description: "Drive a remote claude session, end-to-end encrypted.",
};

export const viewport: Viewport = {
  // Browser chrome (status bar, address bar) follows the OS colour scheme. It tracks `prefers-color-scheme`
  // rather than the rc-theme cookie because Viewport is statically exported — a per-request value would
  // force `generateViewport`. A forced-mode user whose OS disagrees sees a slightly-off chrome tint only;
  // the page itself is correct (data-theme is set from the cookie in RootLayout below).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
  ],
  width: "device-width",
  initialScale: 1,
  // NO maximumScale / user-scalable:no — blocking pinch-zoom fails WCAG 1.4.4 (resize text) / 2.5 mobile
  // a11y. The reason apps pin scale is to stop iOS auto-zooming when a <16px input is focused; we instead
  // keep every focusable input ≥16px (.field / .composer-input), so zoom stays available AND focus is calm.
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Read the colour-mode preference on the server so the first paint is correct: stamping `data-theme`
  // on <html> here (rather than letting <Theme> set it in a mount effect) means light-dark() tokens
  // resolve to the right side before hydration — no flash — and the <Theme> wrapper's per-mode class
  // matches, so there's no hydration mismatch. Reading cookies opts this route into dynamic rendering,
  // which is correct for a live, per-session console (there's nothing to statically cache).
  const mode = coerceThemeMode((await cookies()).get(THEME_COOKIE)?.value);
  // "system" leaves the attribute off, so reset.css keeps `color-scheme: light dark` and follows the OS.
  const dataTheme = mode === "system" ? undefined : mode;
  return (
    <html lang="en" data-theme={dataTheme}>
      <body>
        <Providers initialMode={mode}>{children}</Providers>
      </body>
    </html>
  );
}
