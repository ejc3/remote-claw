import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorized,
  DEFAULT_WINDOW_MS,
  drainWindowMs,
  temporalConfigured,
} from "../../app/api/temporal/drain/gate";

// The drain route's pure gating logic (no native worker). Each test owns the env knobs it touches.
const KEYS = [
  "CRON_SECRET",
  "VERCEL",
  "BROKER_BACKEND",
  "TEMPORAL_ADDRESS",
  "TEMPORAL_API_KEY",
  "TEMPORAL_DRAIN_WINDOW_MS",
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function reqWithAuth(value?: string): Request {
  const headers = value === undefined ? undefined : { authorization: value };
  return new Request("https://x.test/api/temporal/drain", headers ? { headers } : undefined);
}

describe("authorized", () => {
  it("requires an exact Bearer match when CRON_SECRET is set", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(authorized(reqWithAuth("Bearer s3cret"))).toBe(true);
    expect(authorized(reqWithAuth("Bearer wrong"))).toBe(false);
    expect(authorized(reqWithAuth("s3cret"))).toBe(false); // missing the "Bearer " prefix
    expect(authorized(reqWithAuth())).toBe(false); // no header
  });

  it("rejects an unauthenticated request on Vercel when no secret is set (fails closed)", () => {
    process.env.VERCEL = "1";
    expect(authorized(reqWithAuth())).toBe(false);
  });

  it("allows off-Vercel local dev when no secret is set", () => {
    expect(authorized(reqWithAuth())).toBe(true);
  });
});

describe("temporalConfigured", () => {
  it("is false with nothing set, true for any temporal signal", () => {
    expect(temporalConfigured()).toBe(false);
    process.env.TEMPORAL_ADDRESS = "ns.acct.api.temporal.io:7233";
    expect(temporalConfigured()).toBe(true);
    delete process.env.TEMPORAL_ADDRESS;
    process.env.TEMPORAL_API_KEY = "tmprl_x";
    expect(temporalConfigured()).toBe(true);
    delete process.env.TEMPORAL_API_KEY;
    process.env.BROKER_BACKEND = "temporal";
    expect(temporalConfigured()).toBe(true);
  });
});

describe("drainWindowMs", () => {
  it("defaults above the 60s cron interval so invocations overlap", () => {
    expect(drainWindowMs(300)).toBe(DEFAULT_WINDOW_MS);
    expect(DEFAULT_WINDOW_MS).toBeGreaterThan(60_000);
  });

  it("clamps the window under maxDuration to leave shutdown headroom", () => {
    process.env.TEMPORAL_DRAIN_WINDOW_MS = "999999";
    expect(drainWindowMs(300)).toBe(290_000); // (300 - 10) * 1000
    expect(drainWindowMs(800)).toBe(790_000); // Pro headroom
  });

  it("honours a valid override and ignores garbage", () => {
    process.env.TEMPORAL_DRAIN_WINDOW_MS = "120000";
    expect(drainWindowMs(300)).toBe(120_000);
    process.env.TEMPORAL_DRAIN_WINDOW_MS = "nope";
    expect(drainWindowMs(300)).toBe(DEFAULT_WINDOW_MS);
    process.env.TEMPORAL_DRAIN_WINDOW_MS = "-5";
    expect(drainWindowMs(300)).toBe(DEFAULT_WINDOW_MS);
  });
});
