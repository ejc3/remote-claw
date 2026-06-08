// `--rc-show-secret` (§3.1): the ONLY post-creation reveal of S, for re-onboarding a device.
// It reads the existing secret and NEVER regenerates. On a TTY it warns (the secret is a full
// credential — shoulder-surf/scrollback/recording risk) and pauses for Enter (skip with
// --rc-yes) before printing the token to STDOUT; non-TTY prints the bare token to STDOUT with
// the warning on STDERR (for scripted re-onboarding). The token is the only thing on STDOUT.

import { formatSecret } from "@remote-claw/clawsec";
import { type RcValue, rcActionArgError, strFlag } from "./args.js";
import { loadSecret, resolveSecretPath, type StoreEnv, StoreError } from "./store.js";

/** The only reserved flags --rc-show-secret understands. Any other rc-* flag is a usage error. */
const SHOW_SECRET_FLAGS = new Set(["rc-show-secret", "rc-file", "rc-yes"]);

export interface ShowSecretOptions {
  /** STDOUT sink — the token only. Defaults to process.stdout. */
  stdout?: (s: string) => void;
  /** STDERR sink — warnings / errors. Defaults to process.stderr. */
  stderr?: (s: string) => void;
  /** Injected env for path resolution (tests). */
  env?: StoreEnv;
  /** Whether stdin can be prompted for Enter (defaults to process.stdin.isTTY — the readable
   *  side the pause reads from; a non-interactive stdin reveals directly instead of pausing). */
  isTty?: boolean;
  /** Await an Enter keypress before revealing (defaults to reading stdin). */
  awaitEnter?: () => Promise<void>;
}

/** Wait for one line of input (Enter) on stdin. Also resolves on EOF so a closed/ended stdin
 *  proceeds instead of wedging the reveal forever. */
function defaultAwaitEnter(): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const done = () => {
      stdin.off("data", done);
      stdin.off("end", done);
      stdin.pause();
      resolve();
    };
    stdin.resume();
    stdin.once("data", done);
    stdin.once("end", done);
  });
}

export async function runShowSecret(
  rc: Record<string, RcValue>,
  claudeArgs: readonly string[],
  opts: ShowSecretOptions = {},
): Promise<number> {
  const out = opts.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => void process.stderr.write(s));

  const argErr = rcActionArgError("--rc-show-secret", rc, claudeArgs, SHOW_SECRET_FLAGS);
  if (argErr) {
    err(`remote-claw: ${argErr}\n`);
    return 2;
  }

  const file = strFlag(rc, "rc-file");
  const resolved = resolveSecretPath(file !== undefined ? { file } : {}, opts.env);

  let secret: Uint8Array;
  try {
    secret = (await loadSecret(resolved.path)).secret;
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

  const token = await formatSecret(secret);

  // The warning goes to STDERR in every mode so STDOUT stays exactly the token.
  err("remote-claw: revealing your secret — it is a FULL credential (decrypts/forges every\n");
  err("  chat under it). Anyone who sees your screen, scrollback, or a recording gets it;\n");
  err("  it is NOT safe to screen-share.\n");

  // The pause needs an interactive stdin to read Enter; if stdin isn't a TTY (piped, /dev/null,
  // EOF) we can't prompt, so reveal directly (the non-TTY contract) rather than hang.
  const interactive = opts.isTty ?? Boolean(process.stdin.isTTY);
  if (interactive && rc["rc-yes"] !== true) {
    err("  Press Enter to reveal (Ctrl-C to cancel)…\n");
    await (opts.awaitEnter ?? defaultAwaitEnter)();
  }

  out(`${token}\n`);
  return 0;
}
