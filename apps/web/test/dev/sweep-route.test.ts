import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getBackend: vi.fn() }));
vi.mock("../../lib/broker", () => ({ getBackend: mocks.getBackend }));

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

describe("dev sweep route", () => {
  it("404s when not enabled (no token) and never touches the backend", async () => {
    const res = await POST(req("https://preview-123.example.com/api/dev/sweep"));
    expect(res.status).toBe(404);
    expect(mocks.getBackend).not.toHaveBeenCalled();
  });

  it("404s in production even with the matching token (cannot reap prod sessions)", async () => {
    enablePreview();
    env.VERCEL_ENV = "production";
    const res = await POST(req("https://preview-123.example.com/api/dev/sweep", "seed-secret"));
    expect(res.status).toBe(404);
    expect(mocks.getBackend).not.toHaveBeenCalled();
  });

  it("sweeps the sqlite backend with retain=0, drops its scope index, and returns the count", async () => {
    enablePreview();
    const sweep = vi.fn().mockResolvedValue(7);
    const dropIndex = vi.fn().mockResolvedValue(undefined);
    mocks.getBackend.mockResolvedValue({ sweep, dropIndex });
    const res = await POST(req("https://preview-123.example.com/api/dev/sweep", "seed-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ swept: 7, indexDropped: true });
    expect(mocks.getBackend).toHaveBeenCalledWith("sqlite");
    expect(sweep).toHaveBeenCalledWith(0); // default window
    expect(dropIndex).toHaveBeenCalledTimes(1); // cleanup also reclaims this scope's empty index db
  });

  it("a dropIndex failure does NOT mask a successful sweep (best-effort cleanup)", async () => {
    enablePreview();
    const sweep = vi.fn().mockResolvedValue(3);
    const dropIndex = vi.fn().mockRejectedValue(new Error("platform 503"));
    mocks.getBackend.mockResolvedValue({ sweep, dropIndex });
    const res = await POST(req("https://preview-123.example.com/api/dev/sweep", "seed-secret"));
    expect(res.status).toBe(200); // the sweep reclaimed the dbs — still a success
    expect(await res.json()).toEqual({ swept: 3, indexDropped: false });
  });

  it("honours a numeric ?retain window and ignores a non-numeric one (→ 0, never NaN)", async () => {
    enablePreview();
    const sweep = vi.fn().mockResolvedValue(0);
    mocks.getBackend.mockResolvedValue({ sweep });

    await POST(req("https://preview-123.example.com/api/dev/sweep?retain=60000", "seed-secret"));
    expect(sweep).toHaveBeenLastCalledWith(60_000);

    await POST(req("https://preview-123.example.com/api/dev/sweep?retain=7d", "seed-secret"));
    expect(sweep).toHaveBeenLastCalledWith(0); // non-numeric → 0, not NaN
  });

  it("returns swept:0 when the selected backend has no sweep hook", async () => {
    enablePreview();
    mocks.getBackend.mockResolvedValue({}); // e.g. a non-sqlite backend
    const res = await POST(req("https://preview-123.example.com/api/dev/sweep", "seed-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ swept: 0 });
  });

  it("returns 500 when the sweep itself fails", async () => {
    enablePreview();
    mocks.getBackend.mockResolvedValue({ sweep: vi.fn().mockRejectedValue(new Error("boom")) });
    const res = await POST(req("https://preview-123.example.com/api/dev/sweep", "seed-secret"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
  });
});
