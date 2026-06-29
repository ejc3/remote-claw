import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "remote-claw",
  description: "Drive a remote claude session, end-to-end encrypted.",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
  width: "device-width",
  initialScale: 1,
  // NO maximumScale / user-scalable:no — blocking pinch-zoom fails WCAG 1.4.4 (resize text) / 2.5 mobile
  // a11y. The reason apps pin scale is to stop iOS auto-zooming when a <16px input is focused; we instead
  // keep every focusable input ≥16px (.field / .composer-input), so zoom stays available AND focus is calm.
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
