import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gate } from "../../app/api/dev/_gate";

// The shared dev-route gate (apps/web/app/api/dev/_gate.ts), used by /api/dev/sweep. Moved here from the
// removed /api/dev/seed route, so these are the SAME prod-gating + loopback-SSRF cases that lived in the
// deleted seed-gate.test.ts — kept so that auth coverage didn't disappear with the seed route.
const env = process.env as Record<string, string | undefined>;
const KEYS = ["DEV_SEED_TOKEN", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "BROKER_BACKEND"] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = env[k];
    delete env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

function req(url: string, token?: string): Request {
  const headers = token === undefined ? undefined : { "x-dev-seed-token": token };
  return new Request(url, headers ? { headers } : undefined);
}

describe("dev route gate", () => {
  it("404s in Vercel production even with the matching DEV_SEED_TOKEN", () => {
    env.VERCEL = "1";
    env.VERCEL_ENV = "production";
    env.VERCEL_URL = "prod.example.com";
    env.DEV_SEED_TOKEN = "seed-secret";

    const got = gate(req("https://prod.example.com/api/dev/sweep", "seed-secret"));
    expect(got).toBeInstanceOf(Response);
    expect((got as Response).status).toBe(404);
  });

  it("allows a matching token on a non-production Vercel preview and returns the trusted origin", () => {
    env.VERCEL = "1";
    env.VERCEL_ENV = "preview";
    env.VERCEL_URL = "preview-123.example.com";
    env.DEV_SEED_TOKEN = "seed-secret";

    // The trusted origin is the deployment's OWN URL (not the spoofable Host header) — no SSRF.
    expect(gate(req("https://attacker-controlled-host.test/api/dev/sweep", "seed-secret"))).toEqual(
      {
        origin: "https://preview-123.example.com",
      },
    );
  });

  it("allows local-backend dev off-Vercel when the request origin is loopback", () => {
    env.BROKER_BACKEND = "local";

    expect(gate(req("http://127.0.0.1:3000/api/dev/sweep"))).toEqual({
      origin: "http://127.0.0.1:3000",
    });
  });

  it("rejects local-backend dev from a non-loopback request origin (SSRF guard)", () => {
    env.BROKER_BACKEND = "local";

    const got = gate(req("http://example.com/api/dev/sweep"));
    expect(got).toBeInstanceOf(Response);
    expect((got as Response).status).toBe(400);
  });
});
