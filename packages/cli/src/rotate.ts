// `--rc-rotate` (§3.1/§4.4): the ONLY destructive action. A new S ⇒ a NEW identity; the old
// identity and ALL its spaces die. Bare `--rc-rotate` is a DRY-RUN preview that changes nothing;
// execution requires `--rc-confirm <identity_id>` (matching the CURRENT id — a typo guard, since
// identity_id is public, not authz) AND an interactive terminal, unless --rc-force-noninteractive.
// By default the old secret is best-effort scrubbed + removed; --rc-keep-old keeps a 0600 backup
// (still a live credential). On success the NEW token prints on exactly one stdout line (default
// mode only); --rc-json/--rc-quiet never print S.

import { deriveIdentity, toHex } from "@remote-claw/clawsec";
import { type RcValue, rcActionArgError, strFlag } from "./args.js";
import {
  loadSecret,
  resolveSecretPath,
  rotateIdentity,
  type StoreEnv,
  StoreError,
} from "./store.js";

/** The reserved flags --rc-rotate understands. Note: NOT --rc-yes (its gate is --rc-confirm). */
const ROTATE_FLAGS = new Set([
  "rc-rotate",
  "rc-file",
  "rc-confirm",
  "rc-keep-old",
  "rc-force-noninteractive",
  "rc-json",
  "rc-quiet",
]);

export interface RotateOptions {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  env?: StoreEnv;
  now?: () => Date;
  /** Whether stdin can be prompted (defaults to process.stdin.isTTY); gates execution only. */
  isTty?: boolean;
}

export async function runRotate(
  rc: Record<string, RcValue>,
  claudeArgs: readonly string[],
  opts: RotateOptions = {},
): Promise<number> {
  const out = opts.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => void process.stderr.write(s));

  const argErr = rcActionArgError("--rc-rotate", rc, claudeArgs, ROTATE_FLAGS);
  if (argErr) {
    err(`remote-claw: ${argErr}\n`);
    return 2;
  }

  const file = strFlag(rc, "rc-file");
  const resolved = resolveSecretPath(file !== undefined ? { file } : {}, opts.env);

  // Precondition (both phases): a valid current identity must exist and be derivable.
  let oldHex: string;
  try {
    const old = await loadSecret(resolved.path);
    oldHex = toHex((await deriveIdentity(old.secret)).identityId);
  } catch (e) {
    if (StoreError.is(e)) {
      if (e.code === "NOT_FOUND") {
        err(
          `remote-claw: no identity at ${resolved.path} — nothing to rotate; run \`remote-claw --rc-identity\` first\n`,
        );
      } else {
        err(`remote-claw: ${e.message}\n`);
      }
      return 1;
    }
    throw e;
  }

  const json = rc["rc-json"] === true;
  const quiet = rc["rc-quiet"] === true;
  const keepOld = rc["rc-keep-old"] === true;
  const confirm = strFlag(rc, "rc-confirm");

  // DRY-RUN (no --rc-confirm): preview only, touch NOTHING.
  if (confirm === undefined) {
    if (json) {
      out(
        `${JSON.stringify({ rotated: false, dry_run: true, identity_id: oldHex, would_destroy: oldHex, path: resolved.path, keep_old: keepOld })}\n`,
      );
      return 0;
    }
    if (quiet) {
      out(`${oldHex}\n`);
      return 0;
    }
    err("remote-claw: DRY RUN — nothing changed.\n");
    err(`  This would DESTROY identity ${oldHex} and ALL of its spaces — irreversible.\n`);
    err(`  secret file: ${resolved.path}\n`);
    err(
      keepOld
        ? `  The old secret would be kept at ${resolved.path}.old (0600) — STILL A LIVE CREDENTIAL.\n`
        : "  The old secret would be securely deleted (overwrite + unlink; best-effort on CoW/SSD/journaling FS).\n",
    );
    err(
      `  To execute: remote-claw --rc-rotate --rc-confirm ${oldHex}${keepOld ? " --rc-keep-old" : ""}\n`,
    );
    return 0;
  }

  // EXECUTE: confirm-match → TTY guard → rotate (each before anything is destroyed).
  if (confirm.trim().toLowerCase() !== oldHex) {
    // Never echo the supplied value — only the expected public id.
    err("remote-claw: --rc-confirm <id> does not match the current identity_id\n");
    err(`  expected: ${oldHex}\n`);
    err("  (re-run with the exact id shown by the dry-run)\n");
    return 2;
  }
  const interactive = opts.isTty ?? Boolean(process.stdin.isTTY);
  if (!interactive && rc["rc-force-noninteractive"] !== true) {
    err(
      "remote-claw: --rc-rotate needs an interactive terminal (a destructive, irreversible action);\n",
    );
    err("  pass --rc-force-noninteractive to override in scripts.\n");
    return 2;
  }

  let result: Awaited<ReturnType<typeof rotateIdentity>>;
  try {
    result = await rotateIdentity(resolved.path, { now: opts.now ?? (() => new Date()), keepOld });
  } catch (e) {
    if (StoreError.is(e)) {
      err(`remote-claw: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const newHex = toHex(result.identityId);
  if (json) {
    out(
      `${JSON.stringify({ rotated: true, old_identity_id: oldHex, identity_id: newHex, created_at: result.createdAt, path: resolved.path, kept_old: keepOld })}\n`,
    );
    return 0;
  }
  if (quiet) {
    out(`${newHex}\n`);
    return 0;
  }

  err("remote-claw: rotated identity\n");
  err(`  destroyed:   ${oldHex} (and all its spaces — gone)\n`);
  err(`  new id:      ${newHex}\n`);
  err(`  created_at:  ${result.createdAt}\n`);
  err(`  secret file: ${resolved.path}\n`);
  err(
    keepOld
      ? `  old secret:  kept at ${result.backupPath} (0600) — STILL A LIVE CREDENTIAL; delete it once re-onboarded\n`
      : "  old secret:  securely deleted (overwrite + unlink; best-effort on CoW/SSD/journaling FS — treat the device as forensically recoverable)\n",
  );
  err("  This is the only time the new secret is shown. Re-show it later with --rc-show-secret.\n");
  out(`${result.token}\n`); // the one and only emission of the new secret
  return 0;
}
