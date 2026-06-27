import { describe, expect, it } from "vitest";
import { isInferencePath, synthControlPlane } from "./synth.js";

describe("isInferencePath", () => {
  it("is true for messages + count_tokens only", () => {
    expect(isInferencePath("/v1/messages")).toBe(true);
    expect(isInferencePath("/v1/messages/count_tokens")).toBe(true);
    expect(isInferencePath("/api/claude_cli/bootstrap")).toBe(false);
    expect(isInferencePath("/v1/models")).toBe(false);
  });
});

describe("synthControlPlane", () => {
  it("returns null for inference paths (caller routes them to Bedrock)", () => {
    expect(synthControlPlane("POST", "/v1/messages")).toBeNull();
    expect(synthControlPlane("POST", "/v1/messages/count_tokens")).toBeNull();
  });

  it("synthesizes a bootstrap with a synthetic (non-real) oauth_account", () => {
    const r = synthControlPlane("GET", "/api/claude_cli/bootstrap");
    expect(r?.status).toBe(200);
    const acct = (
      r?.json as { oauth_account: { account_email: string; organization_type: string } }
    ).oauth_account;
    expect(acct.organization_type).toBe("claude_max");
    expect(acct.account_email).toContain("example.com"); // fabricated, not a real identity
  });

  it("synthesizes empty mcp lists + a feature flag", () => {
    expect(synthControlPlane("GET", "/v1/mcp_servers")?.json).toEqual({ data: [] });
    expect(synthControlPlane("GET", "/mcp-registry/v0/servers")?.json).toEqual({ servers: [] });
    expect(synthControlPlane("GET", "/api/claude_code_penguin_mode")?.json).toEqual({
      enabled: false,
      disabled_reason: null,
    });
  });

  it("default-stubs any unknown api.anthropic.com path with {} 200 (nothing leaks upstream)", () => {
    const r = synthControlPlane("POST", "/api/claude_code/policy_limits");
    expect(r).toEqual({ status: 200, json: {} });
    expect(synthControlPlane("POST", "/api/event_logging/v2/batch")).toEqual({
      status: 200,
      json: {},
    });
  });
});
