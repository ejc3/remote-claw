import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bedrockRegion,
  containerCredentials,
  envCredentials,
  resolveBedrockAuth,
} from "./creds.js";

const env = process.env as Record<string, string | undefined>;
const KEYS = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  // Container-credential channel — cleared so a host that sets these (ECS/EKS CI) can't make the
  // resolver reach the live metadata endpoint mid-test.
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = env[k];
    delete env[k];
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("envCredentials", () => {
  it("is null without both keys", () => {
    expect(envCredentials()).toBeNull();
    env.AWS_ACCESS_KEY_ID = "id";
    expect(envCredentials()).toBeNull();
  });

  it("reads static creds incl. an optional session token", () => {
    env.AWS_ACCESS_KEY_ID = "id";
    env.AWS_SECRET_ACCESS_KEY = "secret";
    expect(envCredentials()).toEqual({ accessKeyId: "id", secretAccessKey: "secret" });
    env.AWS_SESSION_TOKEN = "tok";
    expect(envCredentials()).toEqual({
      accessKeyId: "id",
      secretAccessKey: "secret",
      sessionToken: "tok",
    });
  });
});

describe("bedrockRegion", () => {
  it("prefers override, then AWS_REGION, then AWS_DEFAULT_REGION, then us-east-1", () => {
    expect(bedrockRegion()).toBe("us-east-1");
    env.AWS_DEFAULT_REGION = "eu-west-1";
    expect(bedrockRegion()).toBe("eu-west-1");
    env.AWS_REGION = "us-west-2";
    expect(bedrockRegion()).toBe("us-west-2");
    expect(bedrockRegion("ap-south-1")).toBe("ap-south-1");
  });

  it("lowercases the region (AWS requires it in the host + SigV4 scope)", () => {
    expect(bedrockRegion("US-EAST-1")).toBe("us-east-1");
    env.AWS_REGION = "EU-West-1";
    expect(bedrockRegion()).toBe("eu-west-1");
  });
});

describe("containerCredentials", () => {
  it("is null when no container-credentials env is set (and never fetches)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(containerCredentials()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads creds (with the auth token header + Expiration) from AWS_CONTAINER_CREDENTIALS_FULL_URI", async () => {
    env.AWS_CONTAINER_CREDENTIALS_FULL_URI = "http://169.254.170.23/v1/creds";
    env.AWS_CONTAINER_AUTHORIZATION_TOKEN = "secret-token";
    const exp = "2999-01-01T00:00:00Z";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)?.authorization).toBe("secret-token");
      return new Response(
        JSON.stringify({
          AccessKeyId: "cid",
          SecretAccessKey: "csecret",
          Token: "ctok",
          Expiration: exp,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(containerCredentials()).resolves.toEqual({
      accessKeyId: "cid",
      secretAccessKey: "csecret",
      sessionToken: "ctok",
      expiration: Date.parse(exp),
    });
    expect(fetchMock).toHaveBeenCalledWith("http://169.254.170.23/v1/creds", expect.anything());
  });

  it("resolves AWS_CONTAINER_CREDENTIALS_RELATIVE_URI against the ECS metadata host", async () => {
    env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/role/abc";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ AccessKeyId: "r", SecretAccessKey: "s" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await containerCredentials();
    expect(fetchMock).toHaveBeenCalledWith("http://169.254.170.2/role/abc", expect.anything());
  });
});

describe("resolveBedrockAuth", () => {
  it("returns the bearer token when AWS_BEARER_TOKEN_BEDROCK is set", async () => {
    env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-key";
    await expect(resolveBedrockAuth()).resolves.toEqual({ kind: "bearer", token: "bedrock-key" });
  });

  it("falls back to env static creds (short-circuits before the container/IMDS chain)", async () => {
    env.AWS_ACCESS_KEY_ID = "id";
    env.AWS_SECRET_ACCESS_KEY = "secret";
    await expect(resolveBedrockAuth()).resolves.toEqual({
      kind: "sigv4",
      credentials: { accessKeyId: "id", secretAccessKey: "secret" },
    });
  });

  it("uses the container endpoint before IMDS when configured", async () => {
    env.AWS_CONTAINER_CREDENTIALS_FULL_URI = "http://169.254.170.23/creds";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ AccessKeyId: "cid", SecretAccessKey: "csecret" }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveBedrockAuth()).resolves.toEqual({
      kind: "sigv4",
      credentials: { accessKeyId: "cid", secretAccessKey: "csecret" },
    });
    // Only the container endpoint was hit — IMDS (169.254.169.254) was never reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("http://169.254.170.23/creds", expect.anything());
  });
});
