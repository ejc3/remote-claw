import { defineConfig, devices } from "@playwright/test";

// App e2e: drives the REAL web client (a real Chromium) against a REAL Next server running the broker
// on the durable per-channel SQLite backend. Stable Claude deliberately refuses a non-durable broker,
// so the primary browser gate must use the same durability class as production rather than silently
// downgrading the host to a compatibility profile. The host side is a real, persistent process: the
// seedHost fixture (app-e2e/fixtures.ts) spawns host-runner.ts (a real HostRcRelay + serve() + a scripted
// RC turn) per test. Separate from playwright.config.ts (the docs site) — run with `pnpm test:app`.
//
// Six specs run against this one local server: transcript.spec.ts (the RC turn / live round-trips),
// handoff.spec.ts (the ephemeral one-time-handoff PAIRING flow against the real /api/handoff route +
// store), viewer-ux.spec.ts (the design-pass UX regression guards), revive.spec.ts (the iOS-Safari
// background→foreground stream re-subscribe), liveness.spec.ts (the bus-unreachable banner +
// auto-recovery), and send-guard.spec.ts (the double-send re-entry guard). The sqlite variant
// (app-e2e.sqlite.config.ts) only re-runs
// transcript.spec.ts — the handoff store is backend-independent (it always uses its own locator) and the
// UX/revive guards are layout/transport, both backend-agnostic, so there's nothing to re-prove there.
//
// Two projects: "mobile" (Pixel 5 / Chromium) runs every spec; "ios-safari" (iPhone 15 / WebKit) runs the
// revive spec — WebKit is the only faithful iOS-Safari engine for the background→foreground stream
// suspend/re-subscribe behavior it exercises (and revive drives the live streaming transport end to end:
// host-confirmed acks over the re-subscribed stream). The RC-protocol transcript tests and the
// layout/handoff guards are engine-agnostic and proven on Chromium, so they stay Chromium-only — keeping
// WebKit focused on its unique value and off the flake-prone fill() paths that don't add engine coverage.

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: [
    "transcript.spec.ts",
    "handoff.spec.ts",
    "viewer-ux.spec.ts",
    "revive.spec.ts",
    "liveness.spec.ts",
    "send-guard.spec.ts",
  ],
  timeout: 90_000,
  expect: { timeout: 20_000 }, // absorb cold-start latency of a freshly-built prod server
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1, // each test spawns its own host; keep them sequential and deterministic
  // No retries: the in-process host makes this deterministic, and the old retries:2 is exactly what masked
  // the seed-route publish race as "flaky→green". A flake here now is a real bug — surface it, don't absorb.
  retries: 0,
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  // Run against a PRODUCTION build, not `next dev`: dev's on-demand compilation triggers HMR
  // module-graph rebuilds, and a prod build also exercises the real bundle. (The broker cache is a
  // globalThis singleton so it survives module duplication / HMR regardless — see lib/broker/index.ts.)
  webServer: {
    command: "pnpm exec next build --webpack && pnpm exec next start -p 3100",
    cwd: "../../apps/web",
    port: 3100,
    env: {
      BROKER_BACKEND: "sqlite",
      RC_SQLITE_DIR: process.env.RC_SQLITE_DIR ?? "/tmp/rc-sqlite-app-e2e",
    },
    // NEVER reuse a server already on the port (was `!CI`). Our command does a `next build` — i.e. it is a
    // one-shot ephemeral server, not a long-lived dev server. With reuse on, a LEFTOVER server (a prior run
    // hard-killed, an orphan, a stale build from another session) silently substitutes for the
    // build-under-test: the `next build` is skipped, so the suite runs against OLD code — either spuriously
    // FAILING (the wedged-orphan case that cost us a debugging cycle here) or, far worse, spuriously PASSING
    // and shipping a real regression the gate never built. `false` makes every run build + serve its own
    // code and turns a leftover server into a loud port-in-use error instead of a silent wrong result.
    reuseExistingServer: false,
    timeout: 300_000,
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 5"] } },
    // iPhone 15 ⇒ WebKit (the iOS-Safari engine). A per-project testMatch REPLACES the top-level one, so
    // WebKit runs ONLY the revive spec (its unique iOS suspend/re-subscribe + streaming coverage). CI
    // installs WebKit via `--with-deps webkit`.
    {
      name: "ios-safari",
      use: { ...devices["iPhone 15"] },
      testMatch: ["revive.spec.ts"],
    },
  ],
});
