import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getBackend: vi.fn(), selectLocatorFromEnv: vi.fn() }));
vi.mock("../../lib/broker", () => ({ getBackend: mocks.getBackend }));
vi.mock("../../lib/broker/turso-cloud-locator", () => ({
  selectLocatorFromEnv: mocks.selectLocatorFromEnv,
}));

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
  mocks.getBackend.mockReset();
  mocks.selectLocatorFromEnv.mockReset();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  vi.restoreAllMocks();
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
    expect(mocks.selectLocatorFromEnv).not.toHaveBeenCalled();
    expect(mocks.getBackend).not.toHaveBeenCalled();
  });

  it("404s in production even with the matching token (cannot reap prod sessions)", async () => {
    enablePreview();
    env.VERCEL_ENV = "production";
    const res = await POST(req(URL_, "seed-secret"));
    expect(res.status).toBe(404);
    expect(mocks.selectLocatorFromEnv).not.toHaveBeenCalled();
  });

  it("cloud: deletes the whole scope by name and returns {deleted, remaining}", async () => {
    enablePreview();
    const dropScope = vi.fn().mockResolvedValue({ deleted: 9, remaining: 2 });
    mocks.selectLocatorFromEnv.mockReturnValue({ dropScope });
    const res = await POST(req(URL_, "seed-secret"));
    expect(res.status).toBe(200);
    // remaining:2 signals a still-live relay recreated dbs → the CI loop will call again.
    expect(await res.json()).toEqual({ deleted: 9, remaining: 2 });
    expect(dropScope).toHaveBeenCalledTimes(1);
    expect(mocks.getBackend).not.toHaveBeenCalled(); // cloud path never falls back to the index sweep
  });

  it("file/local fallback (no dropScope): index sweep + drop the empty index", async () => {
    enablePreview();
    mocks.selectLocatorFromEnv.mockReturnValue({}); // FileDbLocator has no dropScope
    const sweep = vi.fn().mockResolvedValue(4);
    const dropIndex = vi.fn().mockResolvedValue(undefined);
    mocks.getBackend.mockResolvedValue({ sweep, dropIndex });
    const res = await POST(req(URL_, "seed-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 4, remaining: 0, indexDropped: true });
    expect(sweep).toHaveBeenCalledWith(0);
    expect(dropIndex).toHaveBeenCalledTimes(1);
  });

  it("fallback: a dropIndex failure does NOT mask a successful sweep (best-effort)", async () => {
    enablePreview();
    mocks.selectLocatorFromEnv.mockReturnValue({});
    mocks.getBackend.mockResolvedValue({
      sweep: vi.fn().mockResolvedValue(3),
      dropIndex: vi.fn().mockRejectedValue(new Error("platform 503")),
    });
    const res = await POST(req(URL_, "seed-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 3, remaining: 0, indexDropped: false });
  });

  it("returns 500 when the scope delete itself fails", async () => {
    enablePreview();
    mocks.selectLocatorFromEnv.mockReturnValue({
      dropScope: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const res = await POST(req(URL_, "seed-secret"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
  });
});
