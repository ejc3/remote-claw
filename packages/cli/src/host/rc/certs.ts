// MITM certificate authority + leaf — a faithful port of phase0/remote_claw/certs.py.
//
// Generates a throwaway CA and a leaf for `api.anthropic.com` via the system `openssl`. The CA is
// trusted by the spawned `claude` process ONLY, via `NODE_EXTRA_CA_CERTS` — never installed
// system-wide. Private keys are written 0600. Idempotent: regenerates only if absent (or `force`).
//
// The wrapper points `claude` at our local proxy with `HTTPS_PROXY`; when claude opens a TLS
// connection to api.anthropic.com THROUGH that proxy, the proxy presents this leaf, and claude
// accepts it because the CA is in its NODE_EXTRA_CA_CERTS bundle. Inference (`/v1/messages`) and
// OAuth still flow to the real upstream — we only *serve* the RC endpoints (§14, §17.5).

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The host whose RC traffic we intercept (also the real inference host). */
export const MITM_HOST = "api.anthropic.com";

const VALIDITY_DAYS = "365";

export interface CertPaths {
  dir: string;
  caPem: string;
  caKey: string;
  leafPem: string;
  leafKey: string;
}

/** Resolve the cert file paths under a certs directory. */
export function certPaths(certsDir: string): CertPaths {
  return {
    dir: certsDir,
    caPem: join(certsDir, "ca.pem"),
    caKey: join(certsDir, "ca.key"),
    leafPem: join(certsDir, "leaf.pem"),
    leafKey: join(certsDir, "leaf.key"),
  };
}

/** Generate the CA + leaf if absent. Returns the paths (and whether it (re)generated). */
export function ensureCerts(certsDir: string, force = false): CertPaths & { generated: boolean } {
  const p = certPaths(certsDir);
  mkdirSync(certsDir, { recursive: true, mode: 0o700 });
  if (existsSync(p.caPem) && existsSync(p.leafPem) && !force) {
    return { ...p, generated: false };
  }
  if (!haveOpenssl()) {
    throw new Error("openssl not found on PATH; cannot generate MITM certs");
  }

  const run = (...args: string[]): void => {
    execFileSync("openssl", args, { cwd: certsDir, stdio: "ignore" });
  };

  run("genrsa", "-out", "ca.key", "2048");
  run(
    "req",
    "-x509",
    "-new",
    "-nodes",
    "-key",
    "ca.key",
    "-sha256",
    "-days",
    VALIDITY_DAYS,
    "-out",
    "ca.pem",
    "-subj",
    "/CN=remote-claw-CA",
  );
  run("genrsa", "-out", "leaf.key", "2048");
  run("req", "-new", "-key", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${MITM_HOST}`);
  writeFileSync(
    join(certsDir, "leaf.ext"),
    `subjectAltName=DNS:${MITM_HOST}\nextendedKeyUsage=serverAuth\n`,
  );
  run(
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "leaf.pem",
    "-days",
    VALIDITY_DAYS,
    "-sha256",
    "-extfile",
    "leaf.ext",
  );

  for (const key of ["ca.key", "leaf.key"]) {
    try {
      chmodSync(join(certsDir, key), 0o600);
    } catch {
      // best-effort on platforms without POSIX modes
    }
  }
  return { ...p, generated: true };
}

function haveOpenssl(): boolean {
  const path = process.env.PATH ?? "";
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, "openssl")) || existsSync(join(dir, "openssl.exe")));
}
