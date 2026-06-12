// Transparent-wrapper argument classification (§3.1). `remote-claw` consumes only the reserved
// `--rc-*` namespace; every other token is forwarded verbatim to `claude`. A `--` escape stops
// rc-parsing so a literal `--rc-*` can be passed through to claude.

export type RcValue = string | true;
export type RcFlagKind = "boolean" | "value";

/** The reserved `--rc-*` namespace. Keys omit the leading `--`. */
export const RC_FLAGS: Readonly<Record<string, RcFlagKind>> = {
  "rc-identity": "boolean",
  "rc-show-secret": "boolean",
  "rc-pass": "boolean",
  // Stand up the tracing MITM → real Anthropic and spawn claude behind it (a protocol inspector).
  "rc-trace": "boolean",
  "rc-json": "boolean",
  "rc-quiet": "boolean",
  "rc-yes": "boolean",
  "rc-force-noninteractive": "boolean",
  "rc-keep-old": "boolean",
  // The secret always lives in a FILE (never on argv): the default file unless --rc-file
  // points at a specific one, for both creating (--rc-identity) and using an identity.
  "rc-file": "value",
  "rc-confirm": "value",
  // The single app origin (its /api is the broker, its web UI builds the #fragment deep link).
  "rc-app": "value",
  // Pick the broker's durable backend this host targets (sent as the x-broker-backend header on every
  // relay/stream call, and the basis for the host's `durable` decision). Omitted ⇒ the broker's default.
  // Must match what viewers subscribe with — publish + subscribe for one channel address the same store.
  "rc-backend": "value",
};
// Not reserved: starting already remote-controlled is just claude's own `--remote-control`,
// which the wrapper forwards verbatim — no `--rc-share`. The web deep link is built from the
// one `--rc-app` origin — no separate `--rc-web`. The web app gates on SSO and the broker on the
// per-identity auth_token, so there is no app-wide key — no `--rc-app-key` (§4.5).

export interface Classified {
  /** Parsed reserved flags (key without `--`). Value is `true` for booleans. */
  rc: Record<string, RcValue>;
  /** Tokens to forward verbatim to `claude`. */
  claudeArgs: string[];
  /** Human-readable parse errors; non-empty means the invocation is invalid. */
  errors: string[];
}

/** Read a reserved value-flag as a string (booleans/absent → undefined). Shared by rc actions. */
export function strFlag(rc: Record<string, RcValue>, name: string): string | undefined {
  const v = rc[name];
  return typeof v === "string" ? v : undefined;
}

/**
 * Validate a local rc action's args (shared by --rc-identity/--rc-show-secret/…): it must not
 * forward any claude token (it doesn't launch claude), and only its `allowed` --rc-* flags may
 * accompany it. Returns an error string (for `remote-claw: <msg>`, exit 2) or null if OK.
 */
export function rcActionArgError(
  cmd: string,
  rc: Record<string, RcValue>,
  claudeArgs: readonly string[],
  allowed: ReadonlySet<string>,
): string | null {
  if (claudeArgs.length > 0) {
    return `${cmd} does not launch claude; remove the extra argument(s)`;
  }
  const unsupported = Object.keys(rc).filter((k) => !allowed.has(k));
  if (unsupported.length > 0) {
    return `${cmd} does not support ${unsupported.map((k) => `--${k}`).join(", ")} in this build`;
  }
  return null;
}

/** Split argv into the consumed `--rc-*` flags and the args forwarded to `claude`. */
export function classifyArgs(
  argv: readonly string[],
  spec: Readonly<Record<string, RcFlagKind>> = RC_FLAGS,
): Classified {
  const rc: Record<string, RcValue> = {};
  const claudeArgs: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;

    if (tok === "--") {
      // Escape: forward `--` and everything after it, untouched, to claude.
      for (let j = i; j < argv.length; j++) claudeArgs.push(argv[j] as string);
      break;
    }

    if (!tok.startsWith("--rc-")) {
      claudeArgs.push(tok);
      continue;
    }

    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq); // drop leading "--"
    const inlineValue = eq === -1 ? undefined : tok.slice(eq + 1);
    const kind = spec[name];

    if (kind === undefined) {
      errors.push(`unknown flag --${name}`);
      continue;
    }
    if (kind === "boolean") {
      if (inlineValue !== undefined) errors.push(`--${name} takes no value`);
      else rc[name] = true;
      continue;
    }
    // value flag
    if (inlineValue !== undefined) {
      rc[name] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    // The next token must be a value, not a flag — otherwise `--rc-file --model opus` would
    // silently swallow claude's `--model`. Any token starting with "-" needs the `=` form.
    if (next === undefined || next.startsWith("-")) {
      errors.push(
        `--${name} requires a value (use --${name}=<value> for a value starting with '-')`,
      );
      continue;
    }
    rc[name] = next;
    i++;
  }

  return { rc, claudeArgs, errors };
}
