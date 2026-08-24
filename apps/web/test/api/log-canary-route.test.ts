import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "../../app/api/prove/log-canary/route";

const env = process.env as Record<string, string | undefined>;
const BEGIN = `RC_RELEASE_PROOF_LOG_BEGIN_${"a".repeat(32)}`;
const END = `RC_RELEASE_PROOF_LOG_END_${"a".repeat(32)}`;
let savedVercel: string | undefined;
let savedEnvironment: string | undefined;

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://immutable-preview.example/api/prove/log-canary", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

beforeEach(() => {
  savedVercel = env.VERCEL;
  savedEnvironment = env.VERCEL_ENV;
  env.VERCEL = "1";
  env.VERCEL_ENV = "preview";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedVercel === undefined) delete env.VERCEL;
  else env.VERCEL = savedVercel;
  if (savedEnvironment === undefined) delete env.VERCEL_ENV;
  else env.VERCEL_ENV = savedEnvironment;
});

describe("release proof log canary route", () => {
  it.each([
    BEGIN,
    END,
  ])("logs and accepts the exact bounded nonsecret marker %s", async (canary) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await POST(request(JSON.stringify({ canary })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(canary);
  });

  it.each([
    "production",
    "development",
    "Preview",
    "",
  ])("is unavailable outside the exact Preview runtime (%s)", async (environment) => {
    env.VERCEL_ENV = environment;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await POST(request(JSON.stringify({ canary: BEGIN })));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "release proof log canary unavailable" });
    expect(info).not.toHaveBeenCalled();
  });

  it("is unavailable when it is not running on Vercel", async () => {
    delete env.VERCEL;
    expect((await POST(request(JSON.stringify({ canary: BEGIN })))).status).toBe(503);
  });

  it.each([
    JSON.stringify({ canary: "secret" }),
    JSON.stringify({ canary: BEGIN, extra: "not logged" }),
    JSON.stringify({}),
    JSON.stringify([BEGIN]),
    "not-json",
  ])("rejects malformed input without logging it", async (body) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid release proof log canary" });
    expect(info).not.toHaveBeenCalled();
  });

  it("rejects wrong content types and oversized bodies before logging", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(
      (await POST(request(JSON.stringify({ canary: BEGIN }), { "content-type": "text/plain" })))
        .status,
    ).toBe(400);
    expect(
      (
        await POST(
          request(JSON.stringify({ canary: BEGIN }), {
            "content-length": "129",
          }),
        )
      ).status,
    ).toBe(400);
    expect(info).not.toHaveBeenCalled();
  });
});
