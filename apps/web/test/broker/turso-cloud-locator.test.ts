import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileDbLocator } from "../../lib/broker/sqlite-multi";
import { selectLocatorFromEnv, TursoCloudDbLocator } from "../../lib/broker/turso-cloud-locator";

// The cloud locator is the "storage = Turso Cloud" half of the single per-session backend (the file
// locator is the other half). It can't be integration-tested without a real Turso account, so its
// Platform-API logic — name derivation, create-if-absent, exists, and env-based selection — is verified
// against a mocked fetch. The live path is proven on a real deploy, like the `vercel` backend.

const TOKEN_A = "sess:00000000000000000000000000000000:cse_aaaa";
const TOKEN_B = "sess:00000000000000000000000000000000:cse_bbbb";

interface Call {
  url: string;
  method: string;
}
function makeFetch(route: (url: string, method: string) => { status: number; body?: string }): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    const { status, body } = route(url, method);
    return new Response(body ?? "", { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function opts(fetchImpl: typeof fetch) {
  return { apiToken: "api-tok", org: "myorg", group: "default", authToken: "group-tok", fetchImpl };
}

const ENV_KEYS = [
  "TURSO_API_TOKEN",
  "TURSO_ORG",
  "TURSO_GROUP",
  "TURSO_AUTH_TOKEN",
  "RC_SQLITE_DIR",
] as const;
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function snapshotEnv(): void {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
}

describe("TursoCloudDbLocator", () => {
  it("derives a stable, Turso-valid, injective db url + group-token auth", () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200 }));
    const loc = new TursoCloudDbLocator(opts(fetchImpl));
    const a = loc.config(TOKEN_A);
    expect(a.url).toMatch(/^libsql:\/\/rc-[0-9a-f]{32}-myorg\.turso\.io$/);
    expect(a.authToken).toBe("group-tok");
    expect(loc.config(TOKEN_A).url).toBe(a.url); // deterministic
    expect(loc.config(TOKEN_B).url).not.toBe(a.url); // injective
  });

  it("ensure() creates the db once and memoizes (no second POST)", async () => {
    const { fetchImpl, calls } = makeFetch((_url, method) =>
      method === "POST" ? { status: 200, body: "{}" } : { status: 404 },
    );
    const loc = new TursoCloudDbLocator(opts(fetchImpl));
    await loc.ensure(TOKEN_A);
    await loc.ensure(TOKEN_A);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("ensure() treats a name conflict (409) as success", async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 409, body: "already exists" }));
    const loc = new TursoCloudDbLocator(opts(fetchImpl));
    await expect(loc.ensure(TOKEN_A)).resolves.toBeUndefined();
  });

  it("ensure() confirms via GET when create returns 400/422, succeeding if it already exists", async () => {
    const { fetchImpl } = makeFetch((_url, method) =>
      method === "POST" ? { status: 422, body: "exists" } : { status: 200, body: "{}" },
    );
    const loc = new TursoCloudDbLocator(opts(fetchImpl));
    await expect(loc.ensure(TOKEN_A)).resolves.toBeUndefined();
  });

  it("ensure() throws on a hard create failure", async () => {
    const { fetchImpl } = makeFetch((_url, method) =>
      method === "POST" ? { status: 500, body: "boom" } : { status: 404 },
    );
    const loc = new TursoCloudDbLocator(opts(fetchImpl));
    await expect(loc.ensure(TOKEN_A)).rejects.toThrow(/create database/);
  });

  it("exists() maps 200→true, 404→false, other→throw", async () => {
    const present = new TursoCloudDbLocator(
      opts(makeFetch(() => ({ status: 200, body: "{}" })).fetchImpl),
    );
    expect(await present.exists(TOKEN_A)).toBe(true);
    const absent = new TursoCloudDbLocator(opts(makeFetch(() => ({ status: 404 })).fetchImpl));
    expect(await absent.exists(TOKEN_A)).toBe(false);
    const broken = new TursoCloudDbLocator(opts(makeFetch(() => ({ status: 500 })).fetchImpl));
    await expect(broken.exists(TOKEN_A)).rejects.toThrow(/get database/);
  });

  it("listStored returns only our rc- dbs, with a url that matches config()'s construction", async () => {
    const { fetchImpl } = makeFetch((url, method) =>
      method === "GET" && url.includes("/databases?group=")
        ? {
            status: 200,
            body: JSON.stringify({
              databases: [{ Name: "rc-aaa" }, { Name: "rc-bbb" }, { Name: "someone-elses-db" }],
            }),
          }
        : { status: 404 },
    );
    const loc = new TursoCloudDbLocator(opts(fetchImpl));
    const stored = await loc.listStored();
    expect(stored.map((s) => s.id)).toEqual(["rc-aaa", "rc-bbb"]); // non-rc db is never touched
    expect(stored[0]).toEqual({
      id: "rc-aaa",
      url: "libsql://rc-aaa-myorg.turso.io",
      authToken: "group-tok",
    });
    // The sweep keys its busy-set on config().url, so listStored's url must be built the same way.
    expect(loc.config(TOKEN_A).url).toMatch(/^libsql:\/\/rc-[0-9a-f]{32}-myorg\.turso\.io$/);
  });

  it("listStored throws on a list failure", async () => {
    const loc = new TursoCloudDbLocator(opts(makeFetch(() => ({ status: 500 })).fetchImpl));
    await expect(loc.listStored()).rejects.toThrow(/list databases/);
  });

  it("dropStored DELETEs the db and tolerates a 404 (already gone)", async () => {
    const { fetchImpl, calls } = makeFetch((_url, method) => ({
      status: method === "DELETE" ? 200 : 404,
      body: "{}",
    }));
    const loc = new TursoCloudDbLocator(opts(fetchImpl));
    await expect(loc.dropStored("rc-aaa")).resolves.toBeUndefined();
    expect(calls.find((c) => c.method === "DELETE")?.url).toContain("/databases/rc-aaa");

    const gone = new TursoCloudDbLocator(opts(makeFetch(() => ({ status: 404 })).fetchImpl));
    await expect(gone.dropStored("rc-gone")).resolves.toBeUndefined();
  });

  it("dropStored throws on a hard delete failure", async () => {
    const loc = new TursoCloudDbLocator(
      opts(makeFetch(() => ({ status: 500, body: "boom" })).fetchImpl),
    );
    await expect(loc.dropStored("rc-x")).rejects.toThrow(/delete database/);
  });
});

describe("selectLocatorFromEnv", () => {
  it("returns the cloud locator only when ALL Turso Cloud creds are present", () => {
    snapshotEnv();
    process.env.TURSO_API_TOKEN = "t";
    process.env.TURSO_ORG = "org";
    process.env.TURSO_GROUP = "default";
    process.env.TURSO_AUTH_TOKEN = "grp";
    expect(selectLocatorFromEnv()).toBeInstanceOf(TursoCloudDbLocator);
  });

  it("falls back to the local-file locator when any cloud cred is missing", () => {
    snapshotEnv();
    delete process.env.TURSO_API_TOKEN;
    process.env.TURSO_ORG = "org";
    process.env.TURSO_GROUP = "default";
    process.env.TURSO_AUTH_TOKEN = "grp";
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-sel-"));
    dirs.push(dir);
    process.env.RC_SQLITE_DIR = dir;
    expect(selectLocatorFromEnv()).toBeInstanceOf(FileDbLocator);
  });
});
