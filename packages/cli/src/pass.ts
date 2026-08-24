// `--rc-pass` (§4.2a): issue a viewer PASS for this machine. A pass is a credential carrying the
// derived keys (read + steer this machine's sessions) but NOT the master secret S — so it cannot
// reveal the secret or reset the machine. You hand it to a phone/browser (paste it, or `--rc-qr` to
// render a scannable terminal QR). It IS a live credential: there is no in-place per-pass revocation,
// and a reset only moves future service while copied passes remain valid on retained old routes. It is
// the deliverable of this command, so — unlike the secret in --rc-identity/--rc-json — the pass is
// emitted in every mode (default / --rc-json / --rc-quiet), so you can get it WHENEVER. Reads the
// stored identity; never launches claude.
//
// `--rc-qr` WITH `--rc-app`/RC_APP can upload the pass as a ONE-TIME, TTL-bounded handoff and put only
// `<origin>/#otk1_<OTK>` in the QR. That network path is default-off and requires
// NEXT_PUBLIC_RC_HANDOFF_ENABLED=1 after the deployment's per-IP WAF rate limit has been verified. Without
// an origin the QR holds the bare pass for manual entry.

import { deriveIdentity, formatPass, toHex } from "@remote-claw/clawsec";
import { type RcValue, rcActionArgError, strFlag } from "./args.js";
import { uploadHandoff } from "./handoff-upload.js";
import { renderQr } from "./qr.js";
import { loadSecret, resolveSecretPath, type StoreEnv, StoreError } from "./store.js";

/** The reserved flags --rc-pass understands. `--rc-qr` also renders the pass as a terminal QR; when the
 *  handoff feature is enabled, `--rc-app` (or RC_APP) supplies the viewer origin for its one-time link. */
const PASS_FLAGS = new Set(["rc-pass", "rc-file", "rc-json", "rc-quiet", "rc-qr", "rc-app"]);

export interface PassOptions {
  /** STDOUT sink — the pass (default/json/quiet all emit it). Defaults to process.stdout. */
  stdout?: (s: string) => void;
  /** STDERR sink — the note / errors. Defaults to process.stderr. */
  stderr?: (s: string) => void;
  /** Injected env for path resolution (tests). */
  env?: StoreEnv;
  /** Injected fetch for the one-time-handoff upload (tests). Defaults to the global fetch. */
  fetchFn?: typeof fetch;
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
  const wantQr = rc["rc-qr"] === true;
  // The viewer origin for the deep link: --rc-app (trimmed; empty/whitespace ⇒ absent, matching the
  // launcher), else RC_APP. Absent ⇒ the QR holds the bare pass for manual entry.
  const appFlag = strFlag(rc, "rc-app")?.trim();
  const appOrigin =
    appFlag !== undefined && appFlag !== ""
      ? appFlag
      : (opts.env?.env?.RC_APP ?? process.env.RC_APP);
  // The QR payload (skipped in quiet — quiet emits only the bare pass on stdout). With an app origin, the
  // default-off uploader either returns a one-time link or fails closed with no QR (never the old forever
  // `#rcp1_` deep link). Without an origin, the QR is the bare pass.
  let qrPayload: string | undefined;
  if (wantQr && !quiet) {
    if (appOrigin) {
      // Only forward the Vercel SSO bypass to an https origin — it is meaningless elsewhere and must not
      // leak to a non-https/unintended target.
      const rawBypass =
        opts.env?.env?.VERCEL_AUTOMATION_BYPASS_SECRET ??
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      const bypass = rawBypass && /^https:\/\//i.test(appOrigin) ? rawBypass : undefined;
      try {
        qrPayload = await uploadHandoff(appOrigin, pass, {
          ...(bypass ? { bypass } : {}),
          ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
          ...(opts.env?.env ? { env: opts.env.env } : {}),
        });
      } catch (e) {
        // FAIL CLOSED: never fall back to a forever-pass QR (the whole point of the handoff). The pass is
        // still on stdout to paste manually; just don't render a QR.
        err(
          `remote-claw: one-time handoff upload to ${appOrigin} failed (${e instanceof Error ? e.message : String(e)}); not rendering a QR — paste the pass above, or re-run when the broker is reachable.\n`,
        );
      }
    } else {
      // No origin: the QR is the bare pass for MANUAL entry (the original --rc-qr behavior, not a deep
      // link). There is deliberately NO `<origin>/#<pass>` deep-link path — that forever-credential shape
      // was replaced by the one-time OTK handoff above (docs/ephemeral-handoff.md §3.4).
      qrPayload = pass;
    }
  }

  if (json) {
    // Machine mode: emit the QR PAYLOAD (the deep link or bare pass) as a field, not terminal art.
    out(
      `${JSON.stringify({ pass, identity_id: idHex, path: resolved.path, ...(qrPayload !== undefined ? { qr: qrPayload } : {}) })}\n`,
    );
    return 0;
  }
  if (quiet) {
    out(`${pass}\n`); // quiet = ONLY the pass on stdout (for piping); --rc-qr is a no-op here
    return 0;
  }

  err("remote-claw: viewer pass for this machine\n");
  err(`  identity_id: ${idHex}\n`);
  err("  This pass lets a viewer READ and STEER this machine's sessions. It is NOT the master\n");
  err(
    "  secret — it cannot reveal the secret or reset the machine — but it IS a live credential:\n",
  );
  err("  anyone who gets it can drive retained old routes even after you reset this machine.\n");
  err("  Paste it into the web app, or show it as a QR.\n");
  out(`${pass}\n`); // the pass on one stdout line (stable for piping, even with --rc-qr)
  if (qrPayload !== undefined) {
    // The QR goes to STDERR so stdout stays exactly the pass line. With --rc-app it's a deep link that
    // opens the viewer already loaded; otherwise the bare pass to paste.
    err(`\n${await renderQr(qrPayload)}\n`);
    err(
      qrPayload !== pass
        ? "  scan to open the viewer (one-time pairing link — single-use, expires shortly)\n"
        : "  scan to load the pass (no --rc-app/RC_APP origin, so the QR holds the bare pass)\n",
    );
  }
  return 0;
}
