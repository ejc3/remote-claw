import { describe, expect, it, vi } from "vitest";
import { bypassForTarget, primeVercelBypass } from "../../../tests/web/app-e2e/protection-bypass";

const ORIGIN = "https://remote-claw-proof-ejc3-7031s-projects.vercel.app";

describe("deployed browser protection-bypass boundary", () => {
  it("never releases a configured secret to local or non-Vercel targets", () => {
    expect(bypassForTarget("http://localhost:3100", "canary")).toBeUndefined();
    expect(bypassForTarget(ORIGIN, "canary")).toBe("canary");
    for (const target of [
      "https://attacker.example",
      "https://attacker-project.vercel.app",
      "https://remote-claw-proof-attacker-team.vercel.app",
      "http://remote-claw-proof-ejc3-7031s-projects.vercel.app",
      "https://user:pass@remote-claw-proof-ejc3-7031s-projects.vercel.app",
      "https://remote-claw-proof-ejc3-7031s-projects.vercel.app:444",
    ]) {
      expect(() => bypassForTarget(target, "canary")).toThrow(/pinned HTTPS Vercel project/);
    }
  });

  it("sends the canary once with redirect following disabled and accepts only same-origin cookie setup", async () => {
    const get = vi.fn().mockResolvedValue({
      status: () => 307,
      headers: () => ({ location: `${ORIGIN}/` }),
    });
    const context = {
      request: { get },
      cookies: vi.fn().mockResolvedValue([{ name: "scoped", value: "not-inspected" }]),
    } as unknown as Parameters<typeof primeVercelBypass>[0];

    await primeVercelBypass(context, ORIGIN, "canary");

    expect(get).toHaveBeenCalledWith(
      `${ORIGIN}/`,
      expect.objectContaining({
        maxRedirects: 0,
        headers: {
          "x-vercel-protection-bypass": "canary",
          "x-vercel-set-bypass-cookie": "true",
        },
      }),
    );
  });

  it("rejects a cross-origin bypass redirect", async () => {
    const context = {
      request: {
        get: vi.fn().mockResolvedValue({
          status: () => 307,
          headers: () => ({ location: "https://attacker.example/collect" }),
        }),
      },
      cookies: vi.fn(),
    } as unknown as Parameters<typeof primeVercelBypass>[0];

    await expect(primeVercelBypass(context, ORIGIN, "canary")).rejects.toThrow(/cross-origin/);
  });
});
