import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Backend-fault paths of /api/handoff: a store build or query failure must return an OPAQUE 500 (never
// leak the db url/scope) AND self-heal by dropping the per-instance cached client (resetHandoffStore), so
// a rotated token / dead endpoint / partition doesn't 500 for the whole instance lifetime. We mock the
// store module so the real route runs against an injected failure; the body validation + crypto stay real.
const mocks = vi.hoisted(() => ({
  getHandoffStore: vi.fn(),
  resetHandoffStore: vi.fn(),
}));

vi.mock("../../lib/broker/handoff-store", () => ({
  getHandoffStore: mocks.getHandoffStore,
  resetHandoffStore: mocks.resetHandoffStore,
}));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_RC_HANDOFF_ENABLED", "1");
});

afterEach(() => {
  mocks.getHandoffStore.mockReset();
  mocks.resetHandoffStore.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const req = (method: string, body: unknown): Request =>
  new Request("https://x/api/handoff", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// A body that PASSES validation so the route reaches the backend (where the injected fault fires).
const PUT_BODY = { id: "a".repeat(64), proof_hash: "b".repeat(64), ct: "ab".repeat(100) };
const POST_BODY = { id: "a".repeat(64), proof: "b".repeat(64) };

async function json(res: Response): Promise<unknown> {
  return res.json();
}

describe("/api/handoff backend faults → opaque 500 + self-heal", () => {
  it("is an opaque default-off 404 before body parsing or store access", async () => {
    delete process.env.NEXT_PUBLIC_RC_HANDOFF_ENABLED;
    const { PUT, POST } = await import("../../app/api/handoff/route");

    const put = await PUT(req("PUT", PUT_BODY));
    const post = await POST(req("POST", POST_BODY));

    expect(put.status).toBe(404);
    expect(post.status).toBe(404);
    expect(await json(put)).toEqual({ error: "not found" });
    expect(await json(post)).toEqual({ error: "not found" });
    expect(put.headers.get("cache-control")).toBe("no-store");
    expect(post.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getHandoffStore).not.toHaveBeenCalled();
  });

  it("PUT returns 500 and resets the cached store when the store build fails", async () => {
    const { PUT } = await import("../../app/api/handoff/route");
    mocks.getHandoffStore.mockRejectedValue(new Error("turso: SQLITE_BUSY at https://secret-db"));

    const res = await PUT(req("PUT", PUT_BODY));

    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "unavailable" }); // opaque — no db url/scope
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resetHandoffStore).toHaveBeenCalledTimes(1);
  });

  it("PUT returns 500 and resets when put() itself throws (query failure, not build)", async () => {
    const { PUT } = await import("../../app/api/handoff/route");
    mocks.getHandoffStore.mockResolvedValue({
      put: vi.fn().mockRejectedValue(new Error("write failed")),
    });

    const res = await PUT(req("PUT", PUT_BODY));

    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "unavailable" });
    expect(mocks.resetHandoffStore).toHaveBeenCalledTimes(1);
  });

  it("POST (claim) returns 500 and resets when claim() throws", async () => {
    const { POST } = await import("../../app/api/handoff/route");
    mocks.getHandoffStore.mockResolvedValue({
      claim: vi.fn().mockRejectedValue(new Error("read failed")),
    });

    const res = await POST(req("POST", POST_BODY));

    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "unavailable" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resetHandoffStore).toHaveBeenCalledTimes(1);
  });

  it("a malformed body never reaches the backend (no store touch, no reset)", async () => {
    const { PUT } = await import("../../app/api/handoff/route");
    const res = await PUT(req("PUT", { id: "nothex", proof_hash: "x", ct: "y" }));
    expect(res.status).toBe(400);
    expect(mocks.getHandoffStore).not.toHaveBeenCalled();
    expect(mocks.resetHandoffStore).not.toHaveBeenCalled();
  });
});
