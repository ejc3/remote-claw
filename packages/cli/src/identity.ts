// `--rc-identity` (§3.1): the local identity command. It ensures the host's root secret exists in
// its file, prints how to use it, and exits WITHOUT launching claude (zero network I/O). Two modes,
// one verb — because "rotating" an identity in a store-free, single-secret model is just minting a
// NEW one (a credential REPLACE, not a true rotation; §4.4):
//   • default (no --rc-confirm): create-once + idempotent — never overwrites an existing secret.
//   • --rc-confirm <identity_id>: DESTRUCTIVE replace — mint a new, unrelated identity and abandon
//     the old (guarded by the confirm typo-check + a TTY, unless --rc-force-noninteractive).
// The raw secret is emitted on exactly one path — its own bare line, only at create/replace in the
// default mode; --rc-json and --rc-quiet never print it (that output is what leaks into CI logs).

import { deriveIdentity, toHex } from "@remote-claw/clawsec";
import { type RcValue, rcActionArgError, strFlag } from "./args.js";
import {
  ensureIdentity,
  loadSecret,
  resolveSecretPath,
  rotateIdentity,
  type StoreEnv,
  StoreError,
} from "./store.js";

/** The reserved flags --rc-identity understands. The replace controls (--rc-confirm/--rc-keep-old/
 *  --rc-force-noninteractive) only act when --rc-confirm is present. Any other rc-* flag is a usage
 *  error. Note: NOT --rc-yes (that gates --rc-show-secret's reveal prompt, not a replace). */
const IDENTITY_FLAGS = new Set([
  "rc-identity",
  "rc-file",
  "rc-json",
  "rc-quiet",
  "rc-confirm",
  "rc-keep-old",
  "rc-force-noninteractive",
]);

export interface IdentityOptions {
  /** STDOUT sink (the machine-readable channel: token / json / id). Defaults to process.stdout. */
  stdout?: (s: string) => void;
  /** STDERR sink (human summary / errors). Defaults to process.stderr. */
  stderr?: (s: string) => void;
  /** Injected env for path resolution (tests). */
  env?: StoreEnv;
  /** Injected clock for created_at (tests). */
  now?: () => Date;
  /** Whether stdin can be prompted (defaults to process.stdin.isTTY); gates a --rc-confirm replace. */
  isTty?: boolean;
}

export async function runIdentity(
  rc: Record<string, RcValue>,
  claudeArgs: readonly string[],
  opts: IdentityOptions = {},
): Promise<number> {
  const out = opts.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => void process.stderr.write(s));

  // Arg-rule + unsupported-modifier guard (shared with the other rc actions): --rc-identity doesn't
  // launch claude, and only its own flags may accompany it. Checked first, before any disk work.
  const argErr = rcActionArgError("--rc-identity", rc, claudeArgs, IDENTITY_FLAGS);
  if (argErr) {
    err(`remote-claw: ${argErr}\n`);
    return 2;
  }

  const file = strFlag(rc, "rc-file");
  // `{ file }` only when set: exactOptionalPropertyTypes forbids passing an explicit `undefined`
  // for the optional `file`. The env arg falls back to the store's default when opts.env is unset.
  const resolved = resolveSecretPath(file !== undefined ? { file } : {}, opts.env);
  const json = rc["rc-json"] === true;
  const quiet = rc["rc-quiet"] === true;
  const keepOld = rc["rc-keep-old"] === true;
  const confirm = strFlag(rc, "rc-confirm");
  const now = opts.now ?? (() => new Date());

  // --rc-confirm <id> turns --rc-identity into a DESTRUCTIVE replace of the existing identity.
  if (confirm !== undefined) {
    return replaceExisting(resolved.path, {
      confirm,
      keepOld,
      force: rc["rc-force-noninteractive"] === true,
      json,
      quiet,
      now,
      isTty: opts.isTty,
      out,
      err,
    });
  }

  // CREATE-OR-LOAD (idempotent, never destructive): an existing valid secret is loaded, never
  // regenerated; only a genuinely absent one is created.
  let id: Awaited<ReturnType<typeof ensureIdentity>>;
  try {
    id = await ensureIdentity(resolved.path, { now });
  } catch (e) {
    if (StoreError.is(e)) {
      err(`remote-claw: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const idHex = toHex(id.identityId);

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

  // Already exists: idempotent no-op + how to REPLACE it (the honest 'rotation' = re-create).
  err("remote-claw: identity already exists (re-running is a no-op — your identity is safe)\n");
  err(`  identity_id: ${idHex}\n`);
  err(`  created_at:  ${id.createdAt ?? "unknown"}\n`);
  err(`  secret file: ${id.secretPath}\n`);
  err("  Re-show the secret with --rc-show-secret.\n");
  err("  To REPLACE it — mint a NEW, unrelated identity and abandon this one (destructive and\n");
  err("  irreversible; NOT a revocation: a leaked old secret keeps working until you re-onboard\n");
  err("  every device) — re-run with the confirm guard:\n");
  err(`    remote-claw --rc-identity --rc-confirm ${idHex}${keepOld ? " --rc-keep-old" : ""}\n`);
  return 0;
}

/**
 * The DESTRUCTIVE replace path (`--rc-identity --rc-confirm <id>`, §4.4): mint a new, unrelated
 * identity and abandon the old one. Refuses to replace a missing/corrupt identity; the confirm must
 * match the CURRENT public id (a typo guard — identity_id is public, not authz, so a TTY is also
 * required unless --rc-force-noninteractive). The NEW token prints on exactly one stdout line in
 * default mode only; --rc-json/--rc-quiet never print S. Uses the store's rotateIdentity mechanism
 * (new S durable before the old is replaced; old S secure-deleted, or kept with --rc-keep-old).
 */
async function replaceExisting(
  secretPath: string,
  o: {
    confirm: string;
    keepOld: boolean;
    force: boolean;
    json: boolean;
    quiet: boolean;
    now: () => Date;
    isTty: boolean | undefined;
    out: (s: string) => void;
    err: (s: string) => void;
  },
): Promise<number> {
  const { out, err } = o;

  // Precondition: a valid CURRENT identity must exist (refuse to "replace" a missing/corrupt one).
  let oldHex: string;
  let oldIdBytes: Uint8Array;
  try {
    const old = await loadSecret(secretPath);
    oldIdBytes = (await deriveIdentity(old.secret)).identityId;
    oldHex = toHex(oldIdBytes);
  } catch (e) {
    if (StoreError.is(e)) {
      if (e.code === "NOT_FOUND") {
        err(
          `remote-claw: no identity at ${secretPath} to replace — drop --rc-confirm to create one\n`,
        );
      } else {
        err(`remote-claw: ${e.message}\n`);
      }
      return 1;
    }
    throw e;
  }

  // Confirm-match (a typo/accident guard) — checked BEFORE the TTY guard. Never echo the supplied
  // value; only the expected public id.
  if (o.confirm.trim().toLowerCase() !== oldHex) {
    err("remote-claw: --rc-confirm <id> does not match the current identity_id\n");
    err(`  expected: ${oldHex}\n`);
    err("  (re-run with the exact id shown by `remote-claw --rc-identity`)\n");
    return 2;
  }

  const interactive = o.isTty ?? Boolean(process.stdin.isTTY);
  if (!interactive && !o.force) {
    err(
      "remote-claw: replacing an identity needs an interactive terminal (destructive, irreversible);\n",
    );
    err("  pass --rc-force-noninteractive to override in scripts.\n");
    return 2;
  }

  let result: Awaited<ReturnType<typeof rotateIdentity>>;
  try {
    // Pass the confirmed id so the store aborts if the file was swapped to a *different* identity
    // between this confirm-load and the replace (TOCTOU) — never destroy an unconfirmed identity.
    result = await rotateIdentity(secretPath, {
      now: o.now,
      keepOld: o.keepOld,
      expectOldId: oldIdBytes,
    });
  } catch (e) {
    if (StoreError.is(e)) {
      err(`remote-claw: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const newHex = toHex(result.identityId);
  if (o.json) {
    out(
      `${JSON.stringify({ created: true, replaced: true, old_identity_id: oldHex, identity_id: newHex, created_at: result.createdAt, path: secretPath, kept_old: o.keepOld })}\n`,
    );
    return 0;
  }
  if (o.quiet) {
    out(`${newHex}\n`);
    return 0;
  }

  err("remote-claw: replaced identity (minted a new, unrelated one; abandoned the old)\n");
  err(`  abandoned:   ${oldHex} — NOT revoked; its bus + keys still work for anyone holding the\n`);
  err("               old secret. Re-onboard every device now.\n");
  err(`  new id:      ${newHex}\n`);
  err(`  created_at:  ${result.createdAt}\n`);
  err(`  secret file: ${secretPath}\n`);
  err(
    o.keepOld
      ? `  old secret:  kept at ${result.backupPath} (0600) — STILL A LIVE CREDENTIAL; delete it once re-onboarded\n`
      : "  old secret:  securely deleted (overwrite + unlink; best-effort on CoW/SSD/journaling FS — treat the device as forensically recoverable)\n",
  );
  err("  This is the only time the new secret is shown. Re-show it later with --rc-show-secret.\n");
  out(`${result.token}\n`); // the one and only emission of the new secret
  return 0;
}
