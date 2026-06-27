import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bedrockRegion, envCredentials, resolveBedrockAuth } from "./creds.js";

const env = process.env as Record<string, string | undefined>;
const KEYS = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
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
});

describe("resolveBedrockAuth", () => {
  it("returns the bearer token when AWS_BEARER_TOKEN_BEDROCK is set", async () => {
    env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-key";
    await expect(resolveBedrockAuth()).resolves.toEqual({ kind: "bearer", token: "bedrock-key" });
  });

  it("falls back to env static creds (short-circuits before IMDS)", async () => {
    env.AWS_ACCESS_KEY_ID = "id";
    env.AWS_SECRET_ACCESS_KEY = "secret";
    await expect(resolveBedrockAuth()).resolves.toEqual({
      kind: "sigv4",
      credentials: { accessKeyId: "id", secretAccessKey: "secret" },
    });
  });
});
