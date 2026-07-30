import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { FileDbLocator } from "../../lib/broker/sqlite-multi";
import { selectLocatorFromEnv, TursoCloudDbLocator } from "../../lib/broker/turso-cloud-locator";

// The cloud locator is the "storage = Turso Cloud" half of the single per-channel backend (the file
// locator is the other half). It can't be integration-tested without a real Turso account, so its
// Platform-API logic — name derivation, create-if-absent, exists, and env-based selection — is verified
// against a mocked fetch. The live path is proven on a real deploy, like the `vercel` backend.

const TOKEN_A = "sess:00000000000000000000000000000000:cse_aaaa";
const TOKEN_B = "sess:00000000000000000000000000000000:cse_bbbb";
const TOKEN_BUS = "bus:00000000000000000000000000000000";

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
  return {
    apiToken: "api-tok",
    org: "myorg",
    group: "default",
    authToken: "group-tok",
    scope: "prod",
    fetchImpl,
  };
}

const ENV_KEYS = [
  "TURSO_API_TOKEN",
  "TURSO_ORG",
  "TURSO_GROUP",
  "TURSO_GROUP_AUTH_TOKEN",
  "RC_SQLITE_DIR",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
  "RC_TURSO_DB_SCOPE",
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
  it("derives a stable, Turso-valid, injective, human-scannable db url + group-token auth", () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200 }));
    const loc = new TursoCloudDbLocator(opts(fetchImpl));
    const a = loc.config(TOKEN_A);
    // rc-<scope>-<kind>-<16 hex>: meaningful (app/scope/kind visible), ≤36 chars, deterministic.
    expect(a.url).toMatch(/^libsql:\/\/rc-prod-s-[0-9a-f]{16}-myorg\.turso\.io$/);
    expect(a.authToken).toBe("group-tok");
    expect(loc.config(TOKEN_A).url).toBe(a.url); // deterministic
    expect(loc.config(TOKEN_B).url).not.toBe(a.url); // injective
    // The bus channel is the SAME scope but kind `b`, so the two kinds are distinguishable at a glance.
    expect(loc.config(TOKEN_BUS).url).toMatch(
      /^libsql:\/\/rc-prod-b-[0-9a-f]{16}-myorg\.turso\.io$/,
    );
    expect(loc.idFor(TOKEN_A).length).toBeLessThanOrEqual(36); // Turso's hard db-name limit
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

  it("the #known cache is TTL-bounded — an expired positive re-validates (cross-instance drop self-heals)", async () => {
    const prev = process.env.RC_TURSO_KNOWN_TTL_MS;
    process.env.RC_TURSO_KNOWN_TTL_MS = "0"; // entries expire immediately → never trust a stale positive
    try {
      let present = true; // flips when "another instance" drops the db
      const { fetchImpl, calls } = makeFetch((_url, method) =>
        method === "GET"
          ? present
            ? { status: 200, body: "{}" }
            : { status: 404 }
          : { status: 200, body: "{}" },
      );
      const loc = new TursoCloudDbLocator(opts(fetchImpl));
      expect(await loc.exists(TOKEN_A)).toBe(true); // first GET → 200, cached
      present = false; // the retention cron on another instance DELETEs it
      // With the TTL elapsed, exists() must re-GET (not return a stale true) → 404 → false. This is the
      // fix for the cross-instance stale-positive that otherwise opened a client against a deleted db.
      expect(await loc.exists(TOKEN_A)).toBe(false);
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    } finally {
      if (prev === undefined) delete process.env.RC_TURSO_KNOWN_TTL_MS;
      else process.env.RC_TURSO_KNOWN_TTL_MS = prev;
    }
  });

  // awaitReady — the create→serve propagation guard. After the Platform-API create returns, the new db's
  // libSQL endpoint can briefly 404 (or its host not resolve) until it propagates; awaitReady probes the
  // just-opened client until it serves. (This is the fix for the production "SERVER_ERROR: HTTP 404" on a
  // fresh per-channel db — verified here with a fake client, like the rest of the cloud locator.)
  const fakeClient = (execute: () => Promise<unknown>): Client =>
    ({ execute, close: () => {} }) as unknown as Client;
  // The exact @libsql/client shape: LibsqlError(code SERVER_ERROR) wrapping HttpServerError(status 404).
  const notReady404 = (): Error =>
    Object.assign(new Error("SERVER_ERROR: Server returned HTTP status 404"), {
      code: "SERVER_ERROR",
      cause: Object.assign(new Error("Server returned HTTP status 404"), { status: 404 }),
    });

  it("awaitReady retries the create→serve 404 window, then resolves once the endpoint serves", async () => {
    const loc = new TursoCloudDbLocator(opts(makeFetch(() => ({ status: 200 })).fetchImpl));
    let n = 0;
    const client = fakeClient(async () => {
      if (n++ < 3) throw notReady404(); // endpoint 404s for the first 3 probes, then propagates
      return { rows: [] };
    });
    await expect(loc.awaitReady(client, TOKEN_A)).resolves.toBeUndefined();
    expect(n).toBe(4); // 3 not-ready probes + 1 success
  });

  it("awaitReady fails fast on a non-404 error (e.g. auth 401) — never masks a real failure", async () => {
    const loc = new TursoCloudDbLocator(opts(makeFetch(() => ({ status: 200 })).fetchImpl));
    let n = 0;
    const client = fakeClient(async () => {
      n++;
      throw Object.assign(new Error("AUTH_FAILED"), { code: "AUTH", cause: { status: 401 } });
    });
    await expect(loc.awaitReady(client, TOKEN_A)).rejects.toThrow(/AUTH_FAILED/);
    expect(n).toBe(1); // a 401 is not a readiness transient — no retry, fail immediately
  });

  it("awaitReady gives up (throws the 404) once the deadline elapses without the endpoint serving", async () => {
    const prev = process.env.RC_TURSO_READY_DEADLINE_MS;
    process.env.RC_TURSO_READY_DEADLINE_MS = "250"; // tiny budget so the test is fast
    try {
      const loc = new TursoCloudDbLocator(opts(makeFetch(() => ({ status: 200 })).fetchImpl));
      const client = fakeClient(async () => {
        throw notReady404(); // never becomes ready
      });
      await expect(loc.awaitReady(client, TOKEN_A)).rejects.toThrow(/404/);
    } finally {
      if (prev === undefined) delete process.env.RC_TURSO_READY_DEADLINE_MS;
      else process.env.RC_TURSO_READY_DEADLINE_MS = prev;
    }
  });

  it("awaitReady also retries an unresolved-host/connection error during propagation", async () => {
    const loc = new TursoCloudDbLocator(opts(makeFetch(() => ({ status: 200 })).fetchImpl));
    let n = 0;
    const client = fakeClient(async () => {
      if (n++ < 2) throw new Error("getaddrinfo ENOTFOUND rc-prod-s-deadbeef-myorg.turso.io");
      return { rows: [] };
    });
    await expect(loc.awaitReady(client, TOKEN_A)).resolves.toBeUndefined();
    expect(n).toBe(3); // 2 DNS-not-resolving probes + 1 success
  });

  it("idFor + probeAuthToken expose the db name + group token for the retention sweep", () => {
    const loc = new TursoCloudDbLocator(opts(makeFetch(() => ({ status: 200 })).fetchImpl));
    expect(loc.idFor(TOKEN_A)).toMatch(/^rc-prod-s-[0-9a-f]{16}$/);
    // The id is the db name embedded in config()'s url, so dropStored(idFor) and the busy-set agree.
    expect(loc.config(TOKEN_A).url).toBe(`libsql://${loc.idFor(TOKEN_A)}-myorg.turso.io`);
    expect(loc.probeAuthToken()).toBe("group-tok");
  });

  it("indexConfig points at the per-scope rc-<scope>-index catalog db (never a session name)", () => {
    const loc = new TursoCloudDbLocator(opts(makeFetch(() => ({ status: 200 })).fetchImpl));
    expect(loc.indexConfig()).toEqual({
      url: "libsql://rc-prod-index-myorg.turso.io",
      authToken: "group-tok",
    });
    expect(loc.idFor(TOKEN_A)).not.toBe("rc-prod-index"); // a channel db can't collide with the index db
  });

  it("the scope namespaces BOTH the channel dbs and the index — environments/deployments don't overlap", () => {
    const fetchImpl = makeFetch(() => ({ status: 200 })).fetchImpl;
    const prod = new TursoCloudDbLocator(opts(fetchImpl));
    const preview = new TursoCloudDbLocator({ ...opts(fetchImpl), scope: "pr-a1b2c3d" });
    // Same token, different scope ⇒ DIFFERENT db names and DIFFERENT index dbs — the preview deployment's
    // sweep (walks `rc-pr-a1b2c3d-index`) can never list, let alone drop, prod's `rc-prod-` channel db.
    expect(preview.idFor(TOKEN_A)).toMatch(/^rc-pr-a1b2c3d-s-[0-9a-f]{16}$/);
    expect(preview.idFor(TOKEN_A)).not.toBe(prod.idFor(TOKEN_A));
    expect(preview.indexConfig().url).toBe("libsql://rc-pr-a1b2c3d-index-myorg.turso.io");
    expect(preview.indexConfig().url).not.toBe(prod.indexConfig().url);
    expect(preview.idFor(TOKEN_A).length).toBeLessThanOrEqual(36); // within Turso's hard limit
  });

  it("rejects an out-of-charset / over-long scope rather than failing opaquely at create time", () => {
    const f = makeFetch(() => ({ status: 200 })).fetchImpl;
    expect(() => new TursoCloudDbLocator({ ...opts(f), scope: "pr/evil" })).toThrow(
      /invalid db scope/,
    );
    expect(() => new TursoCloudDbLocator({ ...opts(f), scope: "x".repeat(15) })).toThrow(
      /invalid db scope/,
    );
  });

  it("the MAX accepted scope (14 chars) still yields a name within Turso's 36-char limit", () => {
    const f = makeFetch(() => ({ status: 200 })).fetchImpl;
    const maxScope = "x".repeat(14); // longest the constructor accepts
    const loc = new TursoCloudDbLocator({ ...opts(f), scope: maxScope });
    // rc-<14>-<kind>-<16hex> = 3 + 14 + 3 + 16 = 36 exactly — the binding worst case.
    const id = loc.idFor(TOKEN_A);
    expect(id).toBe(`rc-${maxScope}-s-${id.slice(-16)}`);
    expect(id).toHaveLength(36);
    expect(loc.indexConfig().url).toContain(`rc-${maxScope}-index`); // index also within limit
  });

  it("dropIndex deletes the scope's own index db (cleanup leaves no empty index behind)", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200, body: "{}" }));
    const loc = new TursoCloudDbLocator({ ...opts(fetchImpl), scope: "pr-a1b2c3d" });
    await loc.dropIndex();
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/databases/rc-pr-a1b2c3d-index");
  });

  it("dropScope deletes EVERY db in the scope by name (incl. uncatalogued) but never another scope's", async () => {
    // The Platform-API list returns dbs from THIS scope, a look-alike scope, prod, and the index. Only
    // this scope's (`rc-pr-a1b2c3d-*`, including its index) must be deleted — the trailing `-` in the
    // prefix keeps `pr-a1b2c3d` from matching `pr-a1b2c3dx`, and prod (`rc-prod-*`) is untouched.
    let present = [
      "rc-pr-a1b2c3d-s-1111111111111111",
      "rc-pr-a1b2c3d-b-2222222222222222",
      "rc-pr-a1b2c3d-s-3333333333333333", // a 0-frame orphan the index sweep would miss
      "rc-pr-a1b2c3d-index",
      "rc-pr-a1b2c3dx-s-4444444444444444", // look-alike scope — must NOT be deleted
      "rc-prod-s-5555555555555555", // production — must NOT be deleted
    ];
    const deleted: string[] = [];
    const fetchImpl = (async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.endsWith("/databases")) {
        return new Response(JSON.stringify({ databases: present.map((Name) => ({ Name })) }), {
          status: 200,
        });
      }
      if (method === "DELETE") {
        const name = decodeURIComponent(url.split("/databases/")[1] ?? "");
        deleted.push(name);
        present = present.filter((n) => n !== name);
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const loc = new TursoCloudDbLocator({ ...opts(fetchImpl), scope: "pr-a1b2c3d" });
    const r = await loc.dropScope();
    expect(deleted.sort()).toEqual(
      [
        "rc-pr-a1b2c3d-b-2222222222222222",
        "rc-pr-a1b2c3d-index",
        "rc-pr-a1b2c3d-s-1111111111111111",
        "rc-pr-a1b2c3d-s-3333333333333333",
      ].sort(),
    );
    expect(deleted).not.toContain("rc-pr-a1b2c3dx-s-4444444444444444"); // look-alike scope safe
    expect(deleted).not.toContain("rc-prod-s-5555555555555555"); // production safe
    expect(r).toEqual({ deleted: 4, remaining: 0 }); // re-list after deletes → scope empty
  });

  it("ensureIndex creates the rc-<scope>-index db (idempotent: a 409 conflict is success)", async () => {
    const { fetchImpl, calls } = makeFetch((_url, method) =>
      method === "POST" ? { status: 409, body: "exists" } : { status: 404 },
    );
    const loc = new TursoCloudDbLocator(opts(fetchImpl));
    await expect(loc.ensureIndex()).resolves.toBeUndefined();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/databases");
    await loc.ensureIndex(); // memoized — no second POST
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
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
    process.env.TURSO_GROUP_AUTH_TOKEN = "grp";
    expect(selectLocatorFromEnv()).toBeInstanceOf(TursoCloudDbLocator);
  });

  it("falls back to the local-file locator when any cloud cred is missing", () => {
    snapshotEnv();
    delete process.env.TURSO_API_TOKEN;
    process.env.TURSO_ORG = "org";
    process.env.TURSO_GROUP = "default";
    process.env.TURSO_GROUP_AUTH_TOKEN = "grp";
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-sel-"));
    dirs.push(dir);
    process.env.RC_SQLITE_DIR = dir;
    expect(selectLocatorFromEnv()).toBeInstanceOf(FileDbLocator);
  });

  function cloudLocatorWith(opts2: {
    vercelEnv?: string;
    sha?: string;
    override?: string;
  }): TursoCloudDbLocator {
    snapshotEnv();
    process.env.TURSO_API_TOKEN = "t";
    process.env.TURSO_ORG = "myorg";
    process.env.TURSO_GROUP = "default";
    process.env.TURSO_GROUP_AUTH_TOKEN = "grp";
    if (opts2.vercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = opts2.vercelEnv;
    if (opts2.sha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = opts2.sha;
    if (opts2.override === undefined) delete process.env.RC_TURSO_DB_SCOPE;
    else process.env.RC_TURSO_DB_SCOPE = opts2.override;
    return selectLocatorFromEnv() as TursoCloudDbLocator;
  }

  it("scopes by VERCEL_ENV/commit so a preview deploy is isolated from prod AND from other previews", () => {
    // ONLY an explicit production → `prod`; an UNSET env (local/self-host/CI) → `dev`, never `prod`
    // (so the dev-seed-gated sweep can't resolve to the prod scope off-Vercel).
    expect(cloudLocatorWith({ vercelEnv: "production" }).config(TOKEN_A).url).toMatch(
      /^libsql:\/\/rc-prod-s-[0-9a-f]{16}-myorg/,
    );
    expect(cloudLocatorWith({}).config(TOKEN_A).url).toMatch(/^libsql:\/\/rc-dev-s-/);
    expect(cloudLocatorWith({ vercelEnv: "development" }).config(TOKEN_A).url).toMatch(
      /^libsql:\/\/rc-dev-s-/,
    );
    // preview → `pr-<7-char commit sha>`: each commit's deploy gets its OWN index, so two concurrent
    // preview deploys (different commits) can't reclaim each other's dbs, and neither can touch prod's.
    expect(cloudLocatorWith({ vercelEnv: "preview", sha: "a1b2c3d4e5f6" }).indexConfig().url).toBe(
      "libsql://rc-pr-a1b2c3d-index-myorg.turso.io",
    );
    expect(cloudLocatorWith({ vercelEnv: "preview", sha: "aaaaaaa" }).idFor(TOKEN_A)).not.toBe(
      cloudLocatorWith({ vercelEnv: "preview", sha: "bbbbbbb" }).idFor(TOKEN_A),
    );
    // preview with no commit sha (manual/CLI deploy) → a stable `preview` scope, still off prod.
    expect(cloudLocatorWith({ vercelEnv: "preview" }).indexConfig().url).toBe(
      "libsql://rc-preview-index-myorg.turso.io",
    );
    // prod and any preview map the SAME token to DIFFERENT dbs → no cross-environment reach.
    expect(cloudLocatorWith({ vercelEnv: "preview", sha: "a1b2c3d" }).idFor(TOKEN_A)).not.toBe(
      cloudLocatorWith({ vercelEnv: "production" }).idFor(TOKEN_A),
    );
  });

  it("RC_TURSO_DB_SCOPE overrides the VERCEL_ENV-derived scope", () => {
    expect(
      cloudLocatorWith({ vercelEnv: "production", override: "custom" }).indexConfig().url,
    ).toBe("libsql://rc-custom-index-myorg.turso.io");
  });
});
