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
  // `--rc-pass --rc-qr`: also render the pass as a terminal QR (scan it with a phone). With `--rc-app`
  // (or RC_APP) it uploads a one-time handoff and encodes `<origin>/#otk1_<OTK>`; otherwise the bare pass.
  "rc-qr": "boolean",
  "rc-yes": "boolean",
  "rc-force-noninteractive": "boolean",
  "rc-keep-old": "boolean",
  // The secret always lives in a FILE (never on argv): the default file unless --rc-file
  // points at a specific one, for both creating (--rc-identity) and using an identity.
  "rc-file": "value",
  "rc-confirm": "value",
  // The single app origin (its /api is the broker, its web UI builds the #fragment deep link).
  "rc-app": "value",
  // Pick the broker backend this host targets (sent as the x-broker-backend header on every relay/stream
  // call). Omitted ⇒ the broker's default; the host learns effective durability from the server.
  // Must match what viewers subscribe with — publish + subscribe for one channel address the same store.
  "rc-backend": "value",
  // Where inference goes (mitm driver only): "anthropic" (default — pass /v1/messages through to the
  // real upstream) or "bedrock" (translate to Amazon Bedrock + synthesize the rest of the Anthropic
  // control plane, so the child reaches NO api.anthropic.com — native RC stays on, all inference on
  // Bedrock). Env RC_INFERENCE. Bedrock region/model via --rc-bedrock-region / --rc-bedrock-model.
  "rc-inference": "value",
  "rc-bedrock-region": "value",
  "rc-bedrock-model": "value",
  // Which capture/inject driver runs the harness: mitm (default — real claude behind our MITM),
  // tmux (plain claude in a tmux pane; provider-agnostic, Bedrock-capable), or opencode (drive
  // `opencode serve`). Same broker/client/viewer for all (§ pluggable-harness).
  "rc-driver": "value",
  // OpenCode driver knobs (only meaningful with --rc-driver=opencode). The server origin
  // (default 127.0.0.1:4096, env OPENCODE_URL) and the model as "providerID/modelID" (default
  // amazon-bedrock/global.anthropic.claude-sonnet-4-6, env RC_OC_MODEL — a reliable tool-caller; the
  // opencode server supplies AWS creds, and the `global.` profile needs no region).
  "rc-oc-url": "value",
  "rc-oc-model": "value",
  // Which OpenCode session to ATTACH to (env RC_OC_SESSION). The configured canonical `ses_…` must
  // exist exactly. When omitted, the driver creates one only after a valid empty discovery response;
  // one or more existing sessions are ambiguous and require this flag.
  "rc-oc-session": "value",
  // opencode driver only: opt OUT of native permission mirroring (the driver adds a catch-all "ask"
  // rule so otherwise-unconfigured tools raise a viewer gate). DEFAULT ON; the opt-out SKIPS that
  // ask-PATCH and leaves the session's own permission config untouched — so opencode behaves exactly
  // as it would unbridged (auto-run, UNLESS the session already carries its own rules).
  // Env RC_OC_SKIP_PERMISSIONS truthy ("1"/"true"/"yes"/"on").
  "rc-oc-skip-permissions": "boolean",
  // tmux driver only: control whether the private SessionStart marker remains the authoritative source
  // for ongoing exact transcript discovery + rotation-follow (/clear, /compact, resume). DEFAULT ON;
  // disable ongoing follow with `--rc-no-session-hook` (or RC_SESSION_HOOK=0), which falls back to the
  // pinned id / transcript scan. This NEVER disables the private SessionStart hook used once for
  // mandatory native-readiness proof; hook-disabling Claude modes (--bare/--safe-mode) are rejected.
  "rc-session-hook": "boolean",
  "rc-no-session-hook": "boolean",
  // tmux driver only: opt OUT of permission mirroring (mirror the picker to the viewer), restoring the
  // legacy auto-approve-everything behavior. DEFAULT ON; env RC_TMUX_SKIP_PERMISSIONS truthy.
  "rc-tmux-skip-permissions": "boolean",
  // Accountless native RC: seed a synthetic claude.ai login + the RC feature gates into an isolated
  // config dir so native `/remote-control` works with NO real claude.ai login. Requires
  // `--rc-inference=bedrock` (a fabricated credential can't reach real Anthropic for inference). The
  // user's real ~/.claude.json is never touched. Env RC_ACCOUNTLESS=1.
  "rc-accountless": "boolean",
};
// Not reserved: starting already remote-controlled is just claude's own `--remote-control`,
// which the wrapper forwards verbatim — no `--rc-share`. The web deep link is built from the
// one `--rc-app` origin — no separate `--rc-web`. The deployment may use Vercel Deployment
// Protection, while broker data routes use the per-identity auth_token; there is no app-wide
// browser key and therefore no `--rc-app-key` (§4.5).

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
