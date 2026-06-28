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

  it("strips a trailing -YYYYMMDD date (mantle uses undated ids; verified live: dated→404, undated→200)", () => {
    // claude's quick/"haiku" helper sends a dated id; mantle 404s it unless the date is dropped.
    expect(mantleModelId("claude-haiku-4-5-20251001")).toBe("anthropic.claude-haiku-4-5");
    expect(mantleModelId("claude-haiku-4-5-20251001[1m]")).toBe("anthropic.claude-haiku-4-5");
    // An undated id is unchanged, and the model version (`-4-5`) is NOT mistaken for a date.
    expect(mantleModelId("claude-haiku-4-5")).toBe("anthropic.claude-haiku-4-5");
    expect(mantleModelId("claude-opus-4-8")).toBe("anthropic.claude-opus-4-8");
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

  it("drops the top-level fields mantle 400s on (live-confirmed) but keeps the ones it accepts", () => {
    // From the real claude 2.1.x → mantle e2e: context_management/diagnostics are rejected;
    // thinking/output_config/tools are accepted and must survive.
    const raw = JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 8,
      context_management: { edits: [] },
      diagnostics: { foo: 1 },
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: { effort: "high" },
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "hi" }],
    });
    const out = JSON.parse(translateMessagesBody(raw).body);
    expect(out.context_management).toBeUndefined();
    expect(out.diagnostics).toBeUndefined();
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(out.output_config).toEqual({ effort: "high" });
    expect(out.tools).toEqual([{ name: "Bash" }]);
  });

  it("deep-strips cache_control.scope (nested) but keeps the cache_control block", () => {
    // mantle rejects system.N.cache_control.ephemeral.scope; it accepts {type:"ephemeral"} alone.
    const raw = JSON.stringify({
      model: "claude-opus-4-8",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", scope: "1h" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi", cache_control: { type: "ephemeral", scope: "5m" } },
          ],
        },
      ],
    });
    const out = JSON.parse(translateMessagesBody(raw).body);
    expect(out.system[0].cache_control).toEqual({ type: "ephemeral" }); // scope gone, block kept
    expect(out.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT touch a non-Anthropic cache_control (no type:ephemeral) buried in tool/user data", () => {
    // A tool_use input that legitimately carries its own `cache_control: { scope: … }` must survive —
    // we only strip Anthropic's prompt-cache breakpoint (type:"ephemeral"), not arbitrary user data.
    const raw = JSON.stringify({
      model: "claude-opus-4-8",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "configure",
              input: { cache_control: { scope: "workspace", mode: "read_only" } },
            },
          ],
        },
      ],
    });
    const out = JSON.parse(translateMessagesBody(raw).body);
    expect(out.messages[0].content[0].input.cache_control).toEqual({
      scope: "workspace",
      mode: "read_only",
    });
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
