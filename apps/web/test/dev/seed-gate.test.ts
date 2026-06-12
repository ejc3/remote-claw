import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gate } from "../../app/api/dev/seed/gate";

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

describe("dev seed gate", () => {
  it("404s in Vercel production even with the matching DEV_SEED_TOKEN", () => {
    env.VERCEL = "1";
    env.VERCEL_ENV = "production";
    env.VERCEL_URL = "prod.example.com";
    env.DEV_SEED_TOKEN = "seed-secret";

    const got = gate(req("https://prod.example.com/api/dev/seed", "seed-secret"));
    expect(got).toBeInstanceOf(Response);
    expect((got as Response).status).toBe(404);
  });

  it("allows a matching token on a non-production Vercel preview and returns the trusted origin", () => {
    env.VERCEL = "1";
    env.VERCEL_ENV = "preview";
    env.VERCEL_URL = "preview-123.example.com";
    env.DEV_SEED_TOKEN = "seed-secret";

    expect(gate(req("https://attacker-controlled-host.test/api/dev/seed", "seed-secret"))).toEqual({
      origin: "https://preview-123.example.com",
    });
  });

  it("allows local backend seeding off-Vercel when the request origin is loopback", () => {
    env.BROKER_BACKEND = "local";

    expect(gate(req("http://127.0.0.1:3000/api/dev/seed"))).toEqual({
      origin: "http://127.0.0.1:3000",
    });
  });

  it("rejects local backend seeding from a non-loopback request origin", () => {
    env.BROKER_BACKEND = "local";

    const got = gate(req("http://example.com/api/dev/seed"));
    expect(got).toBeInstanceOf(Response);
    expect((got as Response).status).toBe(400);
  });
});
