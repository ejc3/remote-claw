import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "../../app/api/dev/sweep/route";

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
  return new Request(url, { method: "POST", ...(headers ? { headers } : {}) });
}

// A NON-production preview with the matching token — the only place (besides local dev) the gate opens.
function enablePreview(): void {
  env.VERCEL = "1";
  env.VERCEL_ENV = "preview";
  env.VERCEL_URL = "preview-123.example.com";
  env.DEV_SEED_TOKEN = "seed-secret";
}
const URL_ = "https://preview-123.example.com/api/dev/sweep";

describe("dev sweep route", () => {
  it("404s when not enabled (no token) and never touches the backend/locator", async () => {
    const res = await POST(req(URL_));
    expect(res.status).toBe(404);
  });

  it("404s in production even with the matching token (cannot reap prod sessions)", async () => {
    enablePreview();
    env.VERCEL_ENV = "production";
    const res = await POST(req(URL_, "seed-secret"));
    expect(res.status).toBe(404);
  });

  it("fails closed on an otherwise authorized preview without touching storage", async () => {
    enablePreview();
    const res = await POST(req(URL_, "seed-secret"));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: "automated scope cleanup is disabled until exact deployment ownership is retained",
    });
  });
});
