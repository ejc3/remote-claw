// Cert authority tests: generate a real CA + leaf and verify the chain validates (the exact trust
// the spawned claude relies on via NODE_EXTRA_CA_CERTS). Skips cleanly if openssl is unavailable.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureCerts, MITM_HOST } from "./certs.js";

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const RUN = haveOpenssl();
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rc-certs-"));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!RUN)("MITM cert authority", () => {
  it("generates a CA + leaf, and the leaf chains to the CA for the MITM host", () => {
    const dir = tmp();
    const p = ensureCerts(dir);
    expect(p.generated).toBe(true);
    expect(existsSync(p.caPem)).toBe(true);
    expect(existsSync(p.leafPem)).toBe(true);

    // openssl verify must accept the leaf under our CA (this is exactly what claude's TLS does).
    const out = execFileSync("openssl", ["verify", "-CAfile", p.caPem, p.leafPem], {
      encoding: "utf8",
    });
    expect(out).toContain("leaf.pem: OK");

    // The leaf must be issued for api.anthropic.com (SAN), else claude rejects the hostname.
    const text = execFileSync("openssl", ["x509", "-in", p.leafPem, "-noout", "-text"], {
      encoding: "utf8",
    });
    expect(text).toContain(`DNS:${MITM_HOST}`);
  });

  it("is idempotent: a second call reuses the existing certs", () => {
    const dir = tmp();
    const first = ensureCerts(dir);
    const firstBytes = readFileSync(first.leafPem);
    const second = ensureCerts(dir);
    expect(second.generated).toBe(false);
    expect(readFileSync(second.leafPem)).toEqual(firstBytes); // unchanged
  });

  it("writes private keys 0600", () => {
    const dir = tmp();
    const p = ensureCerts(dir);
    // POSIX-only assertion; the mode's low 9 bits must be owner-only read/write.
    if (process.platform !== "win32") {
      expect(statSync(p.caKey).mode & 0o777).toBe(0o600);
      expect(statSync(p.leafKey).mode & 0o777).toBe(0o600);
    }
  });
});
