// The `--help` banner for the reserved `--rc-*` surface. `remote-claw --help` prints this and
// then falls through to `claude --help`, so the user sees both layers. Kept honest to what is
// actually implemented today: every flag listed here is wired in run.ts; each value flag names its
// env-var equivalent and default so the surface is discoverable without reading the source.

export const RC_HELP = `remote-claw — a transparent wrapper around \`claude\`.
Everything except the reserved --rc-* flags is forwarded verbatim to claude (use \`--\` to pass a
literal --rc-* through). To start a session already remote-controlled, pass claude's own
\`--remote-control\`.

Identity & passes (local; never launches claude — the ONLY network touch is --rc-pass --rc-qr with an
app origin, which uploads a one-time handoff, noted below):
  --rc-identity      ensure this host's secret exists and print it once (create-once, idempotent).
                     Re-run with --rc-confirm <identity_id> to REPLACE it: mint a new, unrelated
                     identity and abandon the old one (DESTRUCTIVE; not a true rotation and NOT a
                     revocation — a leaked old secret keeps working on retained old routes).
                     Stop/restart every running remote-claw process so it stops using the captured
                     old identity. Needs a terminal unless --rc-force-noninteractive;
                     --rc-keep-old keeps the old secret as a live backup.
  --rc-show-secret   re-reveal this host's secret (warns first; --rc-yes skips the prompt)
  --rc-pass          print a viewer PASS for this machine: a credential that can read + steer this
                     machine's sessions but is NOT the master secret (can't reveal it or reset the
                     machine). Hand it to a phone/browser (paste or QR). There is no per-pass
                     revocation: reset moves future service to a new identity but copied old passes
                     remain valid on retained old routes. The pass IS the output in every mode.
  --rc-file <path>   use a specific secret file (default: $XDG_STATE_HOME/remote-claw/secret;
                     or set REMOTE_CLAW_SECRET_FILE)
  --rc-json          machine-readable output for an rc action (never prints the master secret)
  --rc-quiet         minimal output for an rc action (never prints the master secret)
  --rc-qr            with --rc-pass: also render the pass as a scannable terminal QR. With --rc-app
                     (or RC_APP) it uploads a one-time handoff and encodes <origin>/#otk1_<OTK> (scan →
                     opens the viewer; single-use, expires shortly); otherwise the bare pass for manual
                     entry. --rc-json adds it as a "qr" field instead.

Remote control (relay sessions to the broker so a phone/laptop can watch + steer):
  --rc-app <origin>  the app origin whose /api is the broker (or set RC_APP). With it, remote-claw runs
                     the selected driver and bridges each session to the broker; without it, claude runs
                     transparently.
  --rc-backend <n>   pick the broker backend this host targets (or set RC_BACKEND): vercel | local |
                     sqlite. Omitted ⇒ the broker's default. Must match what your viewers use.
                     When the server reports a durable log, the host serves history from it instead of
                     keeping (and replaying) an in-memory transcript.
  --rc-driver <d>    capture/inject driver (or set RC_DRIVER): mitm | tmux | opencode (default mitm).
                     mitm runs the real claude behind our MITM; tmux drives a PLAIN claude in a detached
                     tmux pane and bridges via its transcript (provider-agnostic, Bedrock-capable, no
                     MITM); opencode peer-attaches to an \`opencode serve\`. All bridge the SAME broker.

Inference (mitm driver; route model traffic off api.anthropic.com):
  --rc-inference <t> anthropic | bedrock (or set RC_INFERENCE; default anthropic = pass through).
                     bedrock routes /v1/messages to Amazon Bedrock and synthesizes the rest — zero
                     api.anthropic.com.
  --rc-bedrock-region <r>  AWS region for Bedrock (bedrock only; default: AWS_REGION / AWS_DEFAULT_REGION,
                     else us-east-1).
  --rc-bedrock-model <m>   override the Bedrock model id (bedrock only; default: map claude's own model).
  --rc-accountless   seed a synthetic claude.ai login + RC gates so native --remote-control works with no
                     real account (or set RC_ACCOUNTLESS=1). Requires --rc-inference=bedrock (a fabricated
                     credential can't reach real Anthropic).

tmux driver (--rc-driver=tmux):
  --rc-tmux-skip-permissions   auto-approve tools (\`claude --dangerously-skip-permissions\`) instead of
                     mirroring each tool gate to the viewer (or set RC_TMUX_SKIP_PERMISSIONS). Default is
                     mirroring ON (the viewer is the gate).
  --rc-session-hook / --rc-no-session-hook   enable/disable using the private SessionStart marker for
                     ongoing exact transcript discovery + rotation-follow (or set RC_SESSION_HOOK;
                     default ON). Native startup readiness always requires that private hook once;
                     --bare/--safe-mode and truthy CLAUDE_CODE_SIMPLE or CLAUDE_CODE_SAFE_MODE are
                     rejected.

opencode driver (--rc-driver=opencode):
  --rc-oc-url <origin>     the \`opencode serve\` origin (or set OPENCODE_URL; default
                     http://127.0.0.1:4096).
  --rc-oc-model <p/m>      provider/model for prompts (or set RC_OC_MODEL; default
                     amazon-bedrock/global.anthropic.claude-sonnet-4-6 — a reliable Bedrock tool-caller).
  --rc-oc-session <id>     attach to this exact existing \`ses_…\` (or set RC_OC_SESSION). When omitted,
                     create only if discovery proves the server has no sessions; otherwise require an ID.
  --rc-oc-skip-permissions opt out of permission mirroring (or set RC_OC_SKIP_PERMISSIONS): leave the
                     session's own permission config instead of PATCHing it to "ask". Default is mirroring
                     ON.

Diagnostics:
  --rc-trace         stand up a MITM that passes through to the REAL api.anthropic.com and traces the
                     Remote-Control protocol both ways, then spawn claude behind it (no broker — a live
                     protocol inspector). RC_LOG=debug shows frame shapes; RC_LOG=trace shows redacted
                     JSON bodies up to 256 KiB (larger/malformed bodies are omitted). RC_LOG_FILE=<path>
                     writes only to an owned 0600 regular file on POSIX; unsafe/Windows targets warn and
                     drop. RC_LOG_FORMAT=json emits JSONL.

Environment-only knobs (no flag):
  RC_CLAUDE_BIN             path to the claude binary to spawn (default: \`claude\` on PATH).
  RC_BEDROCK_STRIP_KEYS    comma-separated body keys to drop before forwarding to Bedrock, for a model
                     that hard-400s on a field claude sends (e.g. output_config). Bedrock inference only.
  OPENCODE_SERVER_PASSWORD HTTP Basic password for a protected \`opencode serve\` (opencode driver).

Below is claude's own help:
`;
