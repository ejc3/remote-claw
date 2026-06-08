// `--rc-identity` (§3.1): the local, idempotent, create-once identity command. It ensures the
// host's root secret exists in its file, prints how to use it, and exits WITHOUT launching
// claude (zero network I/O). The raw secret is emitted on exactly one path — its own bare line
// at creation in the default mode; --rc-json and --rc-quiet never print it (that output is what
// leaks into CI logs). A script that truly needs the secret reads the 0600 file directly.

import { toHex } from "@remote-claw/clawsec";
import { type RcValue, rcActionArgError, strFlag } from "./args.js";
import { ensureIdentity, resolveSecretPath, type StoreEnv, StoreError } from "./store.js";

/** The only reserved flags --rc-identity understands. Any other rc-* flag is a usage error. */
const IDENTITY_FLAGS = new Set(["rc-identity", "rc-file", "rc-json", "rc-quiet"]);

export interface IdentityOptions {
  /** STDOUT sink (the machine-readable channel: token / json / id). Defaults to process.stdout. */
  stdout?: (s: string) => void;
  /** STDERR sink (human summary / errors). Defaults to process.stderr. */
  stderr?: (s: string) => void;
  /** Injected env for path resolution (tests). */
  env?: StoreEnv;
  /** Injected clock for created_at (tests). */
  now?: () => Date;
}

export async function runIdentity(
  rc: Record<string, RcValue>,
  claudeArgs: readonly string[],
  opts: IdentityOptions = {},
): Promise<number> {
  const out = opts.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => void process.stderr.write(s));

  // Arg rule: --rc-identity does not launch claude, so any forwarded token (a positional, a
  // passthrough flag, or anything after `--` — classifyArgs funnels them all into claudeArgs)
  // is a usage error. Checked first, before any disk/crypto work, so a misuse never writes.
  // Arg-rule + unsupported-modifier guard (shared with the other rc actions): --rc-identity
  // doesn't launch claude, and only its own flags may accompany it. Before any disk work.
  const argErr = rcActionArgError("--rc-identity", rc, claudeArgs, IDENTITY_FLAGS);
  if (argErr) {
    err(`remote-claw: ${argErr}\n`);
    return 2;
  }

  const file = strFlag(rc, "rc-file");
  // `{ file }` only when set: exactOptionalPropertyTypes forbids passing an explicit `undefined`
  // for the optional `file`. The env arg falls back to the store's default when opts.env is unset.
  const resolved = resolveSecretPath(file !== undefined ? { file } : {}, opts.env);

  let id: Awaited<ReturnType<typeof ensureIdentity>>;
  try {
    id = await ensureIdentity(resolved.path, { now: opts.now ?? (() => new Date()) });
  } catch (e) {
    if (StoreError.is(e)) {
      err(`remote-claw: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const idHex = toHex(id.identityId);
  const json = rc["rc-json"] === true;
  const quiet = rc["rc-quiet"] === true;

  if (json) {
    // Built from public fields only — the token/secret is structurally never in scope here.
    out(
      `${JSON.stringify({
        created: id.created,
        identity_id: idHex,
        created_at: id.createdAt ?? null,
        path: id.secretPath,
      })}\n`,
    );
    return 0;
  }

  if (quiet) {
    // The id is public; the secret is deliberately suppressed (never emit S in --quiet/--json).
    out(`${idHex}\n`);
    return 0;
  }

  // Default (human) mode.
  if (id.created) {
    err("remote-claw: created identity\n");
    err(`  identity_id: ${idHex}\n`);
    err(`  created_at:  ${id.createdAt}\n`);
    err(`  secret file: ${id.secretPath}\n`);
    err("  This is the only time the secret is shown. Re-show it later with --rc-show-secret.\n");
    out(`${id.token}\n`); // the one and only emission of the raw secret
    return 0;
  }

  err("remote-claw: identity already exists\n");
  err(`  identity_id: ${idHex}\n`);
  err(`  created_at:  ${id.createdAt ?? "unknown"}\n`);
  err(`  secret file: ${id.secretPath}\n`);
  err("  Re-show the secret with --rc-show-secret.\n");
  return 0;
}
