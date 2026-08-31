import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveIdentity, parsePass, parseSecret, toHex } from "@remote-claw/clawsec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RcValue } from "./args.js";
import { runPass } from "./pass.js";
import { assertNoSecretLeak } from "./secretleak.js";
import { ensureIdentity } from "./store.js";

const PASS_RE = /^rcp1_[A-Za-z0-9_-]{171}[0-9A-HJKMNP-TV-Z]{4}$/;

function capture() {
  const parts: string[] = [];
  return { write: (s: string) => parts.push(s), text: () => parts.join("") };
}

let dir: string;
let secretPath: string;
let prevRcApp: string | undefined;
let prevHandoffEnabled: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rc-pass-"));
  secretPath = join(dir, "secret");
  // The --rc-qr origin falls back to process.env.RC_APP in production; null it so the no-origin tests
  // are deterministic regardless of the ambient environment.
  prevRcApp = process.env.RC_APP;
  prevHandoffEnabled = process.env.NEXT_PUBLIC_RC_HANDOFF_ENABLED;
  delete process.env.RC_APP;
  delete process.env.NEXT_PUBLIC_RC_HANDOFF_ENABLED;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevRcApp === undefined) delete process.env.RC_APP;
  else process.env.RC_APP = prevRcApp;
  if (prevHandoffEnabled === undefined) delete process.env.NEXT_PUBLIC_RC_HANDOFF_ENABLED;
  else process.env.NEXT_PUBLIC_RC_HANDOFF_ENABLED = prevHandoffEnabled;
});

function rc(extra: Record<string, RcValue> = {}): Record<string, RcValue> {
  return { "rc-pass": true, "rc-file": secretPath, ...extra };
}

/** Seed an identity; return its rc1_ token + secret + identity_id hex. */
async function seed(): Promise<{ token: string; secret: Uint8Array; id: string }> {
  await ensureIdentity(secretPath, { now: () => new Date("2026-06-08T00:00:00Z") });
  const token = readFileSync(secretPath, "utf8").trim();
  const secret = await parseSecret(token);
  const id = toHex((await deriveIdentity(secret)).identityId);
  return { token, secret, id };
}

describe("runPass — issue a viewer pass (§4.2a)", () => {
  it("default: pass on one STDOUT line, note on STDERR, the master secret is not leaked", async () => {
    const { token, secret, id } = await seed();
    const out = capture();
    const e = capture();
    const code = await runPass(rc(), [], { stdout: out.write, stderr: e.write });
    expect(code).toBe(0);
    const pass = out.text().trim();
    expect(pass).toMatch(PASS_RE);
    expect(out.text()).toBe(`${pass}\n`); // ONLY the pass on stdout
    expect(e.text()).toMatch(/viewer pass/);
    expect(e.text()).toContain(`identity_id: ${id}`);
    expect(e.text()).toMatch(/indefinite, machine-wide bearer credential/);
    expect(e.text()).toMatch(/READ,\n {2}CONTROL, and FORGE records/);
    expect(e.text()).toMatch(/equally trusted/);
    expect(e.text()).toMatch(/individual revocation is not available/);
    expect(e.text()).toMatch(/copied passes still work on retained old routes/);
    // the pass derives the SAME identity (self-verifies against the broker like the secret)
    expect(toHex((await parsePass(pass)).identityId)).toBe(id);
    assertNoSecretLeak(out.text() + e.text(), { token, secret });
  });

  it("--rc-json: {pass, identity_id, path}; the pass round-trips; secret not leaked", async () => {
    const { token, secret, id } = await seed();
    const out = capture();
    const code = await runPass(rc({ "rc-json": true }), [], {
      stdout: out.write,
      stderr: () => {},
    });
    expect(code).toBe(0);
    const j = JSON.parse(out.text());
    expect(j).toMatchObject({ identity_id: id, path: secretPath });
    expect(j.pass).toMatch(PASS_RE);
    expect(toHex((await parsePass(j.pass)).identityId)).toBe(id);
    assertNoSecretLeak(out.text(), { token, secret });
  });

  it("--rc-quiet: just the pass, no note", async () => {
    await seed();
    const out = capture();
    const e = capture();
    await runPass(rc({ "rc-quiet": true }), [], { stdout: out.write, stderr: e.write });
    expect(out.text().trim()).toMatch(PASS_RE);
    expect(e.text()).toBe("");
  });

  it("the pass carries the derived keys but NOT the master secret", async () => {
    const { token } = await seed();
    const out = capture();
    await runPass(rc({ "rc-quiet": true }), [], { stdout: out.write, stderr: () => {} });
    expect(out.text()).not.toContain(token); // the rc1_ secret never appears in the pass
    expect(out.text()).not.toContain("rc1_");
  });

  it("--rc-qr (no origin): pass on stdout, a terminal QR + 'bare pass' note on stderr, no secret leak", async () => {
    const { token, secret } = await seed();
    const out = capture();
    const e = capture();
    const code = await runPass(rc({ "rc-qr": true }), [], { stdout: out.write, stderr: e.write });
    expect(code).toBe(0);
    expect(out.text().trim()).toMatch(PASS_RE); // stdout is STILL exactly the pass (pipe-safe)
    expect(out.text()).toBe(`${out.text().trim()}\n`);
    expect(e.text()).toMatch(/[▀▄█]/u); // the QR rendered to stderr
    expect(e.text()).toMatch(/scan to load the pass/);
    assertNoSecretLeak(out.text() + e.text(), { token, secret }); // the master secret never appears
  });

  it("--rc-qr --rc-app: stderr QR + one-time pairing note; stdout still just the pass", async () => {
    process.env.NEXT_PUBLIC_RC_HANDOFF_ENABLED = "1";
    await seed();
    const out = capture();
    const e = capture();
    const okFetch = (async () =>
      new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch;
    const code = await runPass(rc({ "rc-qr": true, "rc-app": "https://app.example.com" }), [], {
      stdout: out.write,
      stderr: e.write,
      fetchFn: okFetch,
    });
    expect(code).toBe(0);
    expect(out.text().trim()).toMatch(PASS_RE); // stdout is STILL exactly the pass (pipe-safe)
    expect(e.text()).toMatch(/[▀▄█]/u);
    expect(e.text()).toMatch(/one-time pairing link/);
  });

  it("sends an ambient deployment bypass only to the exact RC_APP pin", async () => {
    await seed();
    const out = capture();
    const calls: RequestInit[] = [];
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return Response.json({ ok: true });
    }) as typeof fetch;
    const code = await runPass(
      rc({ "rc-json": true, "rc-qr": true, "rc-app": "https://app.example.com/" }),
      [],
      {
        stdout: out.write,
        stderr: () => {},
        fetchFn,
        env: {
          env: {
            NEXT_PUBLIC_RC_HANDOFF_ENABLED: "1",
            RC_APP: "https://APP.example.com:443",
            VERCEL_AUTOMATION_BYPASS_SECRET: "scoped-bypass",
          },
          homedir: () => dir,
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.headers).get("x-vercel-protection-bypass")).toBe("scoped-bypass");
    expect(calls[0]?.redirect).toBe("error");
  });

  it("fails closed before upload when an ambient bypass has no matching RC_APP pin", async () => {
    await seed();
    const out = capture();
    const e = capture();
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const code = await runPass(
      rc({ "rc-json": true, "rc-qr": true, "rc-app": "https://untrusted.invalid" }),
      [],
      {
        stdout: out.write,
        stderr: e.write,
        fetchFn,
        env: {
          env: {
            NEXT_PUBLIC_RC_HANDOFF_ENABLED: "1",
            RC_APP: "https://app.example.com",
            VERCEL_AUTOMATION_BYPASS_SECRET: "never-send",
          },
          homedir: () => dir,
        },
      },
    );
    expect(code).toBe(0); // the manual pass remains available
    expect(calls).toBe(0);
    expect(JSON.parse(out.text()).qr).toBeUndefined();
    expect(e.text()).toMatch(/does not match.*not rendering a QR/);
    expect(e.text()).not.toContain("untrusted.invalid");
    expect(e.text()).not.toContain("never-send");
  });

  it("omits an ambient bypass for loopback handoff", async () => {
    await seed();
    let headers = new Headers();
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return Response.json({ ok: true });
    }) as typeof fetch;
    const code = await runPass(
      rc({ "rc-json": true, "rc-qr": true, "rc-app": "http://127.0.0.1:3100" }),
      [],
      {
        stdout: () => {},
        stderr: () => {},
        fetchFn,
        env: {
          env: {
            NEXT_PUBLIC_RC_HANDOFF_ENABLED: "1",
            VERCEL_AUTOMATION_BYPASS_SECRET: "never-send",
          },
          homedir: () => dir,
        },
      },
    );
    expect(code).toBe(0);
    expect(headers.has("x-vercel-protection-bypass")).toBe(false);
  });

  it("--rc-qr --rc-app FAILS CLOSED on upload error — no QR, no forever-pass deep link", async () => {
    process.env.NEXT_PUBLIC_RC_HANDOFF_ENABLED = "1";
    await seed();
    const out = capture();
    const e = capture();
    const failFetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const code = await runPass(rc({ "rc-qr": true, "rc-app": "https://app.example.com" }), [], {
      stdout: out.write,
      stderr: e.write,
      fetchFn: failFetch,
    });
    expect(code).toBe(0);
    expect(out.text().trim()).toMatch(PASS_RE); // the pass is still on stdout to paste manually
    expect(e.text()).not.toMatch(/[▀▄█]/u); // NO QR rendered (never a forever-pass QR)
    expect(e.text()).toMatch(/not rendering a QR/);
    expect(e.text()).not.toContain("#rcp1_");
  });

  it("--rc-json --rc-qr --rc-app: JSON `qr` is the one-time otk1_ deep link; no terminal art", async () => {
    process.env.NEXT_PUBLIC_RC_HANDOFF_ENABLED = "1";
    await seed();
    const out = capture();
    const okFetch = (async () =>
      new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch;
    const code = await runPass(
      rc({ "rc-json": true, "rc-qr": true, "rc-app": "https://app.example.com" }),
      [],
      { stdout: out.write, stderr: () => {}, fetchFn: okFetch },
    );
    expect(code).toBe(0);
    const j = JSON.parse(out.text());
    expect(j.pass).toMatch(PASS_RE);
    expect(j.qr).toMatch(/^https:\/\/app\.example\.com\/#otk1_/); // one-time handoff, not the bare pass
    expect(j.qr).not.toContain(j.pass); // the forever pass is NOT in the QR anymore
    expect(out.text()).not.toMatch(/[▀▄█]/u); // JSON mode = payload field, not art
  });

  it("--rc-json --rc-qr (no origin): `qr` equals the bare pass", async () => {
    await seed();
    const out = capture();
    await runPass(rc({ "rc-json": true, "rc-qr": true }), [], {
      stdout: out.write,
      stderr: () => {},
    });
    const j = JSON.parse(out.text());
    expect(j.qr).toBe(j.pass);
  });

  it("--rc-qr --rc-app is default-off and never calls the handoff route", async () => {
    await seed();
    const out = capture();
    const e = capture();
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const code = await runPass(rc({ "rc-qr": true, "rc-app": "https://app.example.com" }), [], {
      stdout: out.write,
      stderr: e.write,
      fetchFn,
    });
    expect(code).toBe(0);
    expect(called).toBe(false);
    expect(out.text().trim()).toMatch(PASS_RE); // manual paste remains available
    expect(e.text()).not.toMatch(/[▀▄█]/u);
    expect(e.text()).toMatch(/disabled.*WAF rate limit/i);
  });

  it("--rc-quiet --rc-qr: quiet wins — ONLY the pass on stdout, nothing on stderr", async () => {
    await seed();
    const out = capture();
    const e = capture();
    await runPass(rc({ "rc-quiet": true, "rc-qr": true }), [], {
      stdout: out.write,
      stderr: e.write,
    });
    expect(out.text().trim()).toMatch(PASS_RE);
    expect(out.text()).not.toMatch(/[▀▄█]/u);
    expect(e.text()).toBe("");
  });

  it("--rc-qr reads RC_APP from the injected env when --rc-app is absent", async () => {
    await seed();
    const out = capture();
    const okFetch = (async () =>
      new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch;
    const code = await runPass(rc({ "rc-json": true, "rc-qr": true }), [], {
      stdout: out.write,
      stderr: () => {},
      env: {
        env: {
          RC_APP: "https://env.example.com",
          NEXT_PUBLIC_RC_HANDOFF_ENABLED: "1",
        } as NodeJS.ProcessEnv,
        homedir: () => dir,
      },
      fetchFn: okFetch,
    });
    expect(code).toBe(0);
    const j = JSON.parse(out.text());
    expect(j.qr).toMatch(/^https:\/\/env\.example\.com\/#otk1_/);
  });

  it("no identity present: exit 1 with a 'run --rc-identity first' hint, nothing on stdout", async () => {
    const out = capture();
    const e = capture();
    const code = await runPass(rc(), [], { stdout: out.write, stderr: e.write });
    expect(code).toBe(1);
    expect(out.text()).toBe("");
    expect(e.text()).toMatch(/no identity.*--rc-identity/);
  });

  it("arg-rule: a forwarded positional exits 2", async () => {
    await seed();
    const e = capture();
    const code = await runPass(rc(), ["x"], { stdout: () => {}, stderr: e.write });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/does not launch claude/);
  });

  it("rejects an unsupported modifier (e.g. --rc-yes) with exit 2", async () => {
    await seed();
    const e = capture();
    const code = await runPass(rc({ "rc-yes": true }), [], { stdout: () => {}, stderr: e.write });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/does not support --rc-yes/);
  });

  it("corrupt secret: exit 1, no pass on stdout", async () => {
    writeFileSync(secretPath, "not-a-real-token\n", { mode: 0o600 });
    const out = capture();
    const e = capture();
    const code = await runPass(rc(), [], { stdout: out.write, stderr: e.write });
    expect(code).toBe(1);
    expect(out.text()).toBe("");
    expect(readFileSync(secretPath, "utf8")).toBe("not-a-real-token\n"); // untouched
  });
});
