import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorized,
  DEFAULT_RETENTION_MS,
  retentionMs,
  sqliteConfigured,
} from "../../app/api/cron/retention/gate";
import { GET } from "../../app/api/cron/retention/route";

const mocks = vi.hoisted(() => ({
  getBackend: vi.fn(),
}));

vi.mock("../../lib/broker", () => ({
  getBackend: mocks.getBackend,
}));

const env = process.env as Record<string, string | undefined>;
const KEYS = [
  "BROKER_BACKEND",
  "BROKER_RETENTION_MS",
  "CRON_SECRET",
  "NODE_ENV",
  "VERCEL",
  "TURSO_API_TOKEN",
  "TURSO_ORG",
  "TURSO_GROUP",
  "TURSO_GROUP_AUTH_TOKEN",
] as const;
const CLOUD_CREDS = {
  TURSO_API_TOKEN: "api",
  TURSO_ORG: "org",
  TURSO_GROUP: "grp",
  TURSO_GROUP_AUTH_TOKEN: "grouptok",
};

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

function req(auth?: string): Request {
  const headers = auth === undefined ? undefined : { authorization: auth };
  return new Request("https://x.test/api/cron/retention", headers ? { headers } : undefined);
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

describe("retentionMs", () => {
  it("requires a strictly positive integer millisecond value", () => {
    env.BROKER_RETENTION_MS = "0";
    expect(retentionMs()).toBe(DEFAULT_RETENTION_MS);
    env.BROKER_RETENTION_MS = "7d";
    expect(retentionMs()).toBe(DEFAULT_RETENTION_MS);
    env.BROKER_RETENTION_MS = "120000";
    expect(retentionMs()).toBe(120_000);
  });

  it("falls back for non-canonical values and trims valid decimal integers", () => {
    for (const raw of ["-1", "", "  ", "1.5", "1e3", "0x10", "+5", "9007199254740993"]) {
      env.BROKER_RETENTION_MS = raw;
      expect(retentionMs(), raw).toBe(DEFAULT_RETENTION_MS);
    }
    for (const [raw, expected] of [
      [" 500 ", 500],
      ["00500", 500],
    ] as const) {
      env.BROKER_RETENTION_MS = raw;
      expect(retentionMs(), raw).toBe(expected);
    }
  });

  it("is active when sqlite is the default OR the Turso Cloud creds are present (per-request sqlite)", () => {
    expect(sqliteConfigured()).toBe(false);
    env.BROKER_BACKEND = "vercel";
    expect(sqliteConfigured()).toBe(false);
    env.BROKER_BACKEND = " sqlite ";
    expect(sqliteConfigured()).toBe(true);
    // vercel default but cloud creds present → still active (?backend=sqlite provisions real cloud dbs).
    env.BROKER_BACKEND = "vercel";
    Object.assign(env, CLOUD_CREDS);
    expect(sqliteConfigured()).toBe(true);
  });
});

describe("authorized (the cron-secret gate)", () => {
  it("requires an exact Bearer match when CRON_SECRET is set", () => {
    env.CRON_SECRET = "s3cret";
    expect(authorized(req("Bearer s3cret"))).toBe(true);
    expect(authorized(req("Bearer wrong"))).toBe(false);
    expect(authorized(req("s3cret"))).toBe(false); // missing the "Bearer " prefix
    expect(authorized(req())).toBe(false); // no header
  });

  it("rejects an unauthenticated request on Vercel when no secret is set (fails closed)", () => {
    env.VERCEL = "1";
    expect(authorized(req())).toBe(false);
  });

  it("fails closed in production off-Vercel when no secret is set", () => {
    env.NODE_ENV = "production"; // self-hosted prod must not open without a secret
    expect(authorized(req())).toBe(false);
  });

  it("allows off-Vercel, non-production dev when no secret is set", () => {
    expect(authorized(req())).toBe(true);
  });
});

describe("retention cron route", () => {
  it("uses the shared auth gate and returns 404 when unauthorized", async () => {
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "sqlite";

    const res = await GET(req("Bearer wrong"));

    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not found" });
    expect(mocks.getBackend).not.toHaveBeenCalled();
  });

  it("falls back to swept:0 when sqlite is not the deployment backend", async () => {
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "vercel";

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 0 });
    expect(mocks.getBackend).not.toHaveBeenCalled();
  });

  it("runs sweep on a non-sqlite-default deployment when Turso Cloud creds are present", async () => {
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "vercel"; // not the default, but ?backend=sqlite sessions exist on cloud
    Object.assign(env, CLOUD_CREDS);
    const sweep = vi.fn().mockResolvedValue(4);
    mocks.getBackend.mockResolvedValue({ sweep });

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 4 });
    expect(mocks.getBackend).toHaveBeenCalledWith("sqlite");
  });

  it("runs sweep against the sqlite backend when it is the deployment backend", async () => {
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "sqlite";
    const sweep = vi.fn().mockResolvedValue(2);
    mocks.getBackend.mockResolvedValue({ sweep });

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 2 });
    expect(mocks.getBackend).toHaveBeenCalledWith("sqlite");
    expect(sweep).toHaveBeenCalledWith(DEFAULT_RETENTION_MS);
  });

  it("falls back to swept:0 when the backend has no sweep hook (e.g. cloud storage)", async () => {
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "sqlite";
    mocks.getBackend.mockResolvedValue({});

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 0 });
  });

  it("runs sweep with a valid retention override", async () => {
    env.BROKER_RETENTION_MS = "45000";
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "sqlite";
    const sweep = vi.fn().mockResolvedValue(3);
    mocks.getBackend.mockResolvedValue({ sweep });

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 3 });
    expect(mocks.getBackend).toHaveBeenCalledWith("sqlite");
    expect(sweep).toHaveBeenCalledWith(45_000);
  });

  it("returns 500 when backend construction or sweep fails", async () => {
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "sqlite";
    mocks.getBackend.mockRejectedValue(new Error("bad sqlite"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "bad sqlite" });
    expect(error).toHaveBeenCalledWith("[sqlite-retention] sweep failed:", "bad sqlite");
  });
});
