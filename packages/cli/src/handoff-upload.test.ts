import { handoffId, parseOtk, toHex } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { uploadHandoff } from "./handoff-upload.js";

type Captured = { url: string; init: RequestInit };
const ENABLED_ENV = { NEXT_PUBLIC_RC_HANDOFF_ENABLED: "1" } as NodeJS.ProcessEnv;

function mockFetch(statuses: number[]): { fetchFn: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const status = statuses[Math.min(i, statuses.length - 1)] ?? 200;
    i += 1;
    return new Response(status === 200 ? JSON.stringify({ ok: true }) : "", { status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("uploadHandoff", () => {
  it("is default-off and makes no request without the deployment feature flag", async () => {
    const { fetchFn, calls } = mockFetch([200]);
    await expect(
      uploadHandoff("https://app.example.com", "rcp1_X", {
        fetchFn,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/disabled.*WAF rate limit/i);
    expect(calls).toHaveLength(0);
  });

  it("PUTs hex id/proof_hash/ct and returns an otk1_ deep link whose OTK hashes to the PUT id", async () => {
    const { fetchFn, calls } = mockFetch([200]);
    const link = await uploadHandoff("https://app.example.com/", "rcp1_THE_PASS", {
      fetchFn,
      env: ENABLED_ENV,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://app.example.com/api/handoff");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.redirect).toBe("error");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, string>;
    expect(body.id).toMatch(/^[0-9a-f]{64}$/);
    expect(body.proof_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.ct).toMatch(/^[0-9a-f]+$/);
    // the deep link's OTK must hash to the id we uploaded (the viewer reproduces this)
    const frag = link.split("#")[1] ?? "";
    expect(frag.startsWith("otk1_")).toBe(true);
    const otk = await parseOtk(frag);
    expect(toHex(await handoffId(otk))).toBe(body.id);
    expect(link.startsWith("https://app.example.com/#otk1_")).toBe(true);
  });

  it("re-mints a fresh OTK on a 409 id clash, then succeeds", async () => {
    const { fetchFn, calls } = mockFetch([409, 200]);
    const link = await uploadHandoff("https://app.example.com", "rcp1_X", {
      fetchFn,
      env: ENABLED_ENV,
    });
    expect(calls).toHaveLength(2);
    const id1 = JSON.parse(String(calls[0]?.init.body)).id;
    const id2 = JSON.parse(String(calls[1]?.init.body)).id;
    expect(id1).not.toBe(id2); // a genuinely fresh OTK, not the same one retried
    expect(link).toMatch(/#otk1_/);
  });

  it("throws on a non-ok, non-409 status", async () => {
    const { fetchFn } = mockFetch([500]);
    await expect(
      uploadHandoff("https://app.example.com", "rcp1_X", { fetchFn, env: ENABLED_ENV }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("gives up after repeated 409s", async () => {
    const { fetchFn, calls } = mockFetch([409, 409, 409]);
    await expect(
      uploadHandoff("https://app.example.com", "rcp1_X", { fetchFn, env: ENABLED_ENV }),
    ).rejects.toThrow(/repeated id conflicts/);
    expect(calls).toHaveLength(3);
  });

  it("sends the SSO bypass header when provided", async () => {
    const { fetchFn, calls } = mockFetch([200]);
    await uploadHandoff("https://app.example.com", "rcp1_X", {
      fetchFn,
      bypass: "bypass-secret",
      env: ENABLED_ENV,
    });
    expect(new Headers(calls[0]?.init.headers).get("x-vercel-protection-bypass")).toBe(
      "bypass-secret",
    );
  });

  it("refuses to send the bypass to loopback over HTTP or HTTPS", async () => {
    const { fetchFn, calls } = mockFetch([200]);
    for (const origin of [
      "http://127.0.0.1:3100",
      "https://localhost:3100",
      "https://localhost.:3100",
      "https://foo.localhost:3100",
      "https://127.0.1.2:3100",
    ]) {
      await expect(
        uploadHandoff(origin, "rcp1_X", {
          fetchFn,
          bypass: "bypass-secret",
          env: ENABLED_ENV,
        }),
      ).rejects.toThrow(/requires a remote HTTPS app origin/);
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid / non-http origin (so the caller fails closed, no PUT)", async () => {
    const { fetchFn, calls } = mockFetch([200]);
    await expect(
      uploadHandoff("not a url", "rcp1_X", { fetchFn, env: ENABLED_ENV }),
    ).rejects.toThrow(/absolute http\(s\) origin/);
    await expect(
      uploadHandoff("ftp://x.example.com", "rcp1_X", { fetchFn, env: ENABLED_ENV }),
    ).rejects.toThrow(/absolute http\(s\) origin/);
    expect(calls).toHaveLength(0); // never attempted a PUT to a bad origin
  });

  it("rejects paths, queries, and fragments instead of silently retargeting them", async () => {
    const { fetchFn, calls } = mockFetch([200]);
    for (const origin of [
      "https://app.example.com/viewer",
      "https://app.example.com/?x=1",
      "https://app.example.com/#frag",
    ]) {
      await expect(uploadHandoff(origin, "rcp1_X", { fetchFn, env: ENABLED_ENV })).rejects.toThrow(
        /root origin/,
      );
    }
    expect(calls).toHaveLength(0);
  });
});
