import { describe, expect, it } from "vitest";
import {
  BEDROCK_ALLOWED_BETAS,
  filterBetaHeader,
  mantleModelId,
  parseStripKeys,
  translateMessagesBody,
} from "./translate.js";

describe("mantleModelId", () => {
  it("prefixes a bare claude id with anthropic.", () => {
    expect(mantleModelId("claude-opus-4-8")).toBe("anthropic.claude-opus-4-8");
  });

  it("strips a [1m] capability suffix", () => {
    expect(mantleModelId("claude-opus-4-8[1m]")).toBe("anthropic.claude-opus-4-8");
  });

  it("passes through an already-Bedrock id (anthropic./region-profile)", () => {
    expect(mantleModelId("anthropic.claude-opus-4-8")).toBe("anthropic.claude-opus-4-8");
    expect(mantleModelId("us.anthropic.claude-opus-4-8-v1:0")).toBe(
      "us.anthropic.claude-opus-4-8-v1:0",
    );
    expect(mantleModelId("global.anthropic.claude-sonnet-4-6")).toBe(
      "global.anthropic.claude-sonnet-4-6",
    );
  });

  it("honors an explicit override outright", () => {
    expect(mantleModelId("claude-opus-4-8", "anthropic.custom-v1:0")).toBe("anthropic.custom-v1:0");
    expect(mantleModelId("claude-opus-4-8", "  ")).toBe("anthropic.claude-opus-4-8"); // blank → ignored
  });
});

describe("translateMessagesBody", () => {
  it("rewrites model, keeps the rest, drops stripped keys", () => {
    const raw = JSON.stringify({
      model: "claude-opus-4-8[1m]",
      stream: true,
      max_tokens: 1000,
      system: "s",
      metadata: { user_id: "abc" },
      messages: [{ role: "user", content: "hi" }],
    });
    const { body, model } = translateMessagesBody(raw);
    const out = JSON.parse(body);
    expect(model).toBe("anthropic.claude-opus-4-8");
    expect(out.model).toBe("anthropic.claude-opus-4-8");
    expect(out.stream).toBe(true); // native path keeps top-level stream
    expect(out.max_tokens).toBe(1000);
    expect(out.metadata).toBeUndefined(); // Bedrock rejects unknown keys → stripped
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("applies a model override", () => {
    const { model } = translateMessagesBody(JSON.stringify({ model: "claude-opus-4-8" }), {
      modelOverride: "us.anthropic.claude-opus-4-8-v1:0",
    });
    expect(model).toBe("us.anthropic.claude-opus-4-8-v1:0");
  });

  it("strips extra configured keys on top of the built-in set", () => {
    const raw = JSON.stringify({
      model: "claude-opus-4-8",
      metadata: { user_id: "x" },
      output_config: { effort: "high" },
      max_tokens: 8,
    });
    const out = JSON.parse(
      translateMessagesBody(raw, { extraStripKeys: new Set(["output_config"]) }).body,
    );
    expect(out.metadata).toBeUndefined(); // built-in
    expect(out.output_config).toBeUndefined(); // configured extra
    expect(out.max_tokens).toBe(8);
  });

  it("throws on non-object JSON", () => {
    expect(() => translateMessagesBody("[]")).toThrow(/not a JSON object/);
    expect(() => translateMessagesBody("null")).toThrow(/not a JSON object/);
    expect(() => translateMessagesBody("not json")).toThrow();
  });
});

describe("filterBetaHeader", () => {
  it("keeps only Bedrock-accepted betas from claude's real header", () => {
    const real =
      "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24";
    expect(filterBetaHeader(real)).toBe("interleaved-thinking-2025-05-14");
  });

  it("returns empty when undefined or none allowed", () => {
    expect(filterBetaHeader(undefined)).toBe("");
    expect(filterBetaHeader("context-1m-2025-08-07,oauth-2025-04-20")).toBe("");
  });

  it("respects an allowlist override", () => {
    expect(filterBetaHeader("foo,bar", new Set(["bar"]))).toBe("bar");
    expect(BEDROCK_ALLOWED_BETAS.has("interleaved-thinking-2025-05-14")).toBe(true);
  });
});

describe("parseStripKeys", () => {
  it("parses a comma list, trims, ignores blanks; undefined/empty → undefined", () => {
    expect(parseStripKeys(undefined)).toBeUndefined();
    expect(parseStripKeys("  ")).toBeUndefined();
    expect(parseStripKeys(",,")).toBeUndefined();
    expect([...(parseStripKeys(" output_config , effort ,") ?? [])]).toEqual([
      "output_config",
      "effort",
    ]);
  });
});
