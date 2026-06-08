// `--rc-pass` (§4.2a): issue a viewer PASS for this machine. A pass is a credential carrying the
// derived keys (read + steer this machine's sessions) but NOT the master secret S — so it cannot
// reveal the secret or reset the machine. You hand it to a phone/browser (paste it, or show it as
// a QR). It IS a live credential (anyone who holds it can drive this machine until you reset it),
// but it is the deliverable of this command, so — unlike the secret in --rc-identity/--rc-json —
// the pass is emitted in every mode (default / --rc-json / --rc-quiet). Local-only; never launches
// claude. Revoke a pass by resetting the machine (`--rc-identity --rc-confirm`).

import { deriveIdentity, formatPass, toHex } from "@remote-claw/clawsec";
import { type RcValue, rcActionArgError, strFlag } from "./args.js";
import { loadSecret, resolveSecretPath, type StoreEnv, StoreError } from "./store.js";

/** The reserved flags --rc-pass understands. */
const PASS_FLAGS = new Set(["rc-pass", "rc-file", "rc-json", "rc-quiet"]);

export interface PassOptions {
  /** STDOUT sink — the pass (default/json/quiet all emit it). Defaults to process.stdout. */
  stdout?: (s: string) => void;
  /** STDERR sink — the note / errors. Defaults to process.stderr. */
  stderr?: (s: string) => void;
  /** Injected env for path resolution (tests). */
  env?: StoreEnv;
}

export async function runPass(
  rc: Record<string, RcValue>,
  claudeArgs: readonly string[],
  opts: PassOptions = {},
): Promise<number> {
  const out = opts.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => void process.stderr.write(s));

  const argErr = rcActionArgError("--rc-pass", rc, claudeArgs, PASS_FLAGS);
  if (argErr) {
    err(`remote-claw: ${argErr}\n`);
    return 2;
  }

  const file = strFlag(rc, "rc-file");
  const resolved = resolveSecretPath(file !== undefined ? { file } : {}, opts.env);

  let identity: Awaited<ReturnType<typeof deriveIdentity>>;
  try {
    const { secret } = await loadSecret(resolved.path);
    identity = await deriveIdentity(secret);
  } catch (e) {
    if (StoreError.is(e)) {
      if (e.code === "NOT_FOUND") {
        err(
          `remote-claw: no identity at ${resolved.path} — run \`remote-claw --rc-identity\` first\n`,
        );
      } else {
        err(`remote-claw: ${e.message}\n`);
      }
      return 1;
    }
    throw e;
  }

  const pass = await formatPass(identity);
  const idHex = toHex(identity.identityId);
  const json = rc["rc-json"] === true;
  const quiet = rc["rc-quiet"] === true;

  if (json) {
    out(`${JSON.stringify({ pass, identity_id: idHex, path: resolved.path })}\n`);
    return 0;
  }
  if (quiet) {
    out(`${pass}\n`);
    return 0;
  }

  err("remote-claw: viewer pass for this machine\n");
  err(`  identity_id: ${idHex}\n`);
  err("  This pass lets a viewer READ and STEER this machine's sessions. It is NOT the master\n");
  err(
    "  secret — it cannot reveal the secret or reset the machine — but it IS a live credential:\n",
  );
  err(
    "  anyone who gets it can drive this machine until you reset it (--rc-identity --rc-confirm).\n",
  );
  err("  Paste it into the web app, or show it as a QR.\n");
  out(`${pass}\n`); // the pass on one stdout line
  return 0;
}
