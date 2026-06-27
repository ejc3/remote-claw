import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/cron/handoff-sweep/route";

// The dedicated handoff-expiry cron (apps/web/app/api/cron/handoff-sweep/route.ts). It reuses the retention
// CRON_SECRET gate, returns a UNIFORM 404 when unauthorized (indistinguishable from "no such route"), a
// {swept:0} no-op when the deployment can't hold a handoff store, sweeps otherwise, and opaque-500s on
// failure. The store module is mocked so the gate/route logic is exercised without a real db; the gate
// itself is real (env-driven).
const mocks = vi.hoisted(() => ({
  getHandoffStore: vi.fn(),
  handoffConfigured: vi.fn(),
}));

vi.mock("../../lib/broker/handoff-store", () => ({
  getHandoffStore: mocks.getHandoffStore,
  handoffConfigured: mocks.handoffConfigured,
}));

const env = process.env as Record<string, string | undefined>;
const KEYS = ["CRON_SECRET", "NODE_ENV", "VERCEL"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = env[k];
    delete env[k];
  }
  mocks.getHandoffStore.mockReset();
  mocks.handoffConfigured.mockReset();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function req(auth?: string): Request {
  const headers = auth === undefined ? undefined : { authorization: auth };
  return new Request("https://x.test/api/cron/handoff-sweep", headers ? { headers } : undefined);
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

describe("handoff-sweep cron route", () => {
  it("returns a uniform 404 when unauthorized (and never touches the store)", async () => {
    env.CRON_SECRET = "cron";

    const res = await GET(req("Bearer wrong"));

    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not found" });
    expect(mocks.handoffConfigured).not.toHaveBeenCalled();
    expect(mocks.getHandoffStore).not.toHaveBeenCalled();
  });

  it("no-ops with {swept:0} when the deployment has no handoff store configured", async () => {
    env.CRON_SECRET = "cron";
    mocks.handoffConfigured.mockReturnValue(false);

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 0 });
    expect(mocks.getHandoffStore).not.toHaveBeenCalled(); // short-circuits before building the store
  });

  it("sweeps expired rows and returns the count when configured + authorized", async () => {
    env.CRON_SECRET = "cron";
    mocks.handoffConfigured.mockReturnValue(true);
    const sweepExpired = vi.fn().mockResolvedValue(7);
    mocks.getHandoffStore.mockResolvedValue({ sweepExpired });

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 7 });
    expect(sweepExpired).toHaveBeenCalledTimes(1);
    expect(typeof (sweepExpired.mock.calls[0]?.[0] as number)).toBe("number"); // swept against a clock (now)
  });

  it("returns an opaque 500 when the sweep throws (db url/scope never leak)", async () => {
    env.CRON_SECRET = "cron";
    mocks.handoffConfigured.mockReturnValue(true);
    mocks.getHandoffStore.mockResolvedValue({
      sweepExpired: vi.fn().mockRejectedValue(new Error("turso down at https://secret-db")),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "sweep failed" });
    expect(error).toHaveBeenCalled();
  });

  it("allows an off-Vercel non-production dev run with no secret (gate open locally only)", async () => {
    // No CRON_SECRET, not VERCEL, not production → the shared gate opens for local/manual curl.
    mocks.handoffConfigured.mockReturnValue(false);

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 0 });
  });
});
