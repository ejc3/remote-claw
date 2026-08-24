import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../../app/api/prove/deployment-attestation/route";

const env = process.env as Record<string, string | undefined>;
const KEYS = [
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
  "BROKER_BACKEND",
  "RC_TURSO_DB_SCOPE",
  "TURSO_API_TOKEN",
  "TURSO_ORG",
  "TURSO_GROUP",
  "TURSO_GROUP_AUTH_TOKEN",
] as const;
const SHA = "a".repeat(40);
const SCOPE = `pr-${SHA.slice(0, 7)}`;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = env[key];
    delete env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

function expectNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("cdn-cache-control")).toBe("no-store");
  expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
}

function setValidProfile(): void {
  env.VERCEL = "1";
  env.VERCEL_ENV = "preview";
  env.VERCEL_GIT_COMMIT_SHA = SHA.toUpperCase();
  env.BROKER_BACKEND = "sqlite";
  env.TURSO_API_TOKEN = "platform-secret";
  env.TURSO_ORG = "proof-org";
  env.TURSO_GROUP = "proof-group";
  env.TURSO_GROUP_AUTH_TOKEN = "group-secret";
}

function setValidProductionProfile(): void {
  setValidProfile();
  env.VERCEL_ENV = "production";
}

describe("deployment attestation route", () => {
  it("returns the exact Preview and canonical nonsecret storage coordinates without caching", async () => {
    setValidProfile();

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      environment: "preview",
      sha: SHA,
      storage: {
        backend: "sqlite",
        locator: "turso",
        organization: "proof-org",
        group: "proof-group",
        scope: SCOPE,
      },
    });
    expectNoStore(response);
  });

  it("returns the exact Production profile with the canonical prod scope without caching", async () => {
    setValidProductionProfile();

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      environment: "production",
      sha: SHA,
      storage: {
        backend: "sqlite",
        locator: "turso",
        organization: "proof-org",
        group: "proof-group",
        scope: "prod",
      },
    });
    expectNoStore(response);
  });

  it.each([
    "BROKER_BACKEND",
    "TURSO_API_TOKEN",
    "TURSO_ORG",
    "TURSO_GROUP",
    "TURSO_GROUP_AUTH_TOKEN",
  ] as const)("fails closed when the durable profile lacks %s", async (key) => {
    setValidProfile();
    delete env[key];

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "deployment attestation unavailable" });
    expectNoStore(response);
  });

  it("refuses any explicit Turso scope override, including the canonical-looking scope", async () => {
    setValidProfile();
    env.RC_TURSO_DB_SCOPE = SCOPE;

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "deployment attestation unavailable" });
    expectNoStore(response);

    setValidProductionProfile();
    env.RC_TURSO_DB_SCOPE = "prod";

    const productionResponse = await GET();

    expect(productionResponse.status).toBe(503);
    expect(await productionResponse.json()).toEqual({
      error: "deployment attestation unavailable",
    });
    expectNoStore(productionResponse);
  });

  it("fails closed on blank credentials or a non-sqlite deployment default", async () => {
    setValidProfile();
    env.TURSO_GROUP_AUTH_TOKEN = "   ";
    expect((await GET()).status).toBe(503);

    setValidProfile();
    env.BROKER_BACKEND = "vercel";
    expect((await GET()).status).toBe(503);

    setValidProfile();
    env.TURSO_ORG = "unsafe/org";
    expect((await GET()).status).toBe(503);
  });

  it.each([
    {},
    { VERCEL: "0", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: SHA },
    { VERCEL: "1", VERCEL_ENV: "development", VERCEL_GIT_COMMIT_SHA: SHA },
    { VERCEL: "1", VERCEL_ENV: "Preview", VERCEL_GIT_COMMIT_SHA: SHA },
    { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "short" },
    { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: ` ${SHA}` },
    { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: " ".repeat(40) },
  ])("fails closed without exposing partial coordinates for %j", async (candidate) => {
    Object.assign(env, candidate);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "deployment attestation unavailable" });
    expectNoStore(response);
  });
});
