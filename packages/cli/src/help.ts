// The `--help` banner for the reserved `--rc-*` surface. On the normal wrapper path,
// `remote-claw --help` prints this and then falls through to `claude --help`, so the user sees both
// layers; `--rc-trace --help` prints this only and exits without a child. Kept honest to what is
// actually implemented today: every flag listed here is wired in run.ts; each value flag names its
// env-var equivalent and default so the surface is discoverable without reading the source.

export const RC_HELP = `remote-claw — a transparent wrapper around \`claude\`.
Everything except the reserved --rc-* flags is forwarded verbatim to claude (use \`--\` to pass a
literal --rc-* through). To start a session already remote-controlled, pass claude's own
\`--remote-control\`.

Identity & passes (local; never launches claude — the ONLY possible network touch is --rc-pass --rc-qr
with an app origin, through the default-off one-time handoff noted below):
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
                     (or RC_APP), and only when NEXT_PUBLIC_RC_HANDOFF_ENABLED=1, it uploads a one-time
                     handoff and encodes <origin>/#otk1_<OTK> (scan → opens the viewer; single-use,
                     expires shortly). Set that deployment flag only after externally verifying the
                     per-IP WAF rate limit on /api/handoff. Otherwise no handoff QR is rendered; without
                     an app origin, the bare pass is rendered for manual entry. --rc-json adds the QR
                     payload as a "qr" field instead.

Remote control (relay sessions to the broker so a phone/laptop can watch + steer):
  --rc-app <origin>  the app origin whose /api is the broker (or set RC_APP). With it, remote-claw runs
                     the selected driver and bridges each session to the broker; without it, claude runs
                     transparently.
  --rc-backend <n>   pick the broker backend this host targets (or set RC_BACKEND): vercel | local |
                     sqlite. Omitted ⇒ the broker's default. Must match what your viewers use.
                     When the server reports a durable log, the host serves history from it instead of
                     keeping (and replaying) an in-memory transcript. Stable Claude requires that
                     durable profile and fails closed before discovery on vercel/local; production
                     should default the deployment to sqlite/Turso so host and viewer agree.
  --rc-driver <d>    capture/inject driver (or set RC_DRIVER): mitm | claude-native | tmux | opencode
                     (default mitm). mitm is the supported private relay and replaces Anthropic RC.
                     claude-native is the Linux/Claude 2.1.237 text-only companion: it leaves ordinary
                     Anthropic Remote Control intact alongside the local TUI and remote-claw browsers.
                     Literal official-client coexistence acceptance passed for the pinned release.
                     Use it with claude's own --remote-control.
                     tmux remains an experimental/internal compatibility driver. OpenCode has one
                     pinned supported text/interrupt tuple described below.

Claude native companion (--rc-driver=claude-native):
  Launch form starts ordinary Claude behind a transparent session-binding observer, then mirrors the
  exact native session through the sealed broker. Only non-empty, non-slash text is supported. Permissions,
  questions, interrupts, model/mode changes, attachments, and end remain native/local and disabled in
  the viewer. --rc-inference, --rc-bedrock-*, and --rc-accountless are rejected for this driver.
  --rc-native-session <cse_…>  attach a fresh remote-claw projection to this exact already-running
                     Anthropic RC session. This form starts no interactive Claude session or proxy and
                     accepts no forwarded Claude arguments; the required version probe still runs.

Inference (mitm driver; the supported default is anthropic):
  --rc-inference <t> anthropic | bedrock (or set RC_INFERENCE; default anthropic = pass through).
                     bedrock is an experimental/internal connector outside the primary coexistence
                     path; it routes /v1/messages to Bedrock and synthesizes the rest.
  --rc-bedrock-region <r>  AWS region for Bedrock (bedrock only; default: AWS_REGION / AWS_DEFAULT_REGION,
                     else us-east-1).
  --rc-bedrock-model <m>   override the Bedrock model id (bedrock only; default: map claude's own model).
  --rc-accountless   seed a synthetic claude.ai login + RC gates so native --remote-control works with no
                     real account (or set RC_ACCOUNTLESS=1). Requires --rc-inference=bedrock (a fabricated
                     credential can't reach real Anthropic).

Experimental/internal tmux driver (--rc-driver=tmux):
  --rc-tmux-skip-permissions   auto-approve tools (\`claude --dangerously-skip-permissions\`) instead of
                     mirroring each tool gate to the viewer (or set RC_TMUX_SKIP_PERMISSIONS). Default is
                     mirroring ON (the viewer is the gate).
  --rc-session-hook / --rc-no-session-hook   enable/disable using the private SessionStart marker for
                     ongoing exact transcript discovery + rotation-follow (or set RC_SESSION_HOOK;
                     default ON). Native startup readiness always requires that private hook once;
                     --bare/--safe-mode and truthy CLAUDE_CODE_SIMPLE or CLAUDE_CODE_SAFE_MODE are
                     rejected.

Pinned OpenCode driver (--rc-driver=opencode):
  --rc-oc-url <origin>     the \`opencode serve\` origin (or set OPENCODE_URL; default
                     http://127.0.0.1:4096). Only explicit-port HTTP loopback origins are accepted.
  --rc-oc-model <p/m>      provider/model for prompts (or set RC_OC_MODEL; default
                     amazon-bedrock/global.anthropic.claude-sonnet-4-6; this exact model is required).
  --rc-oc-session <id>     required exact existing canonical \`ses_…\` (or set RC_OC_SESSION).
                     Attach-only: the companion never discovers, selects, or creates a native session.
  --rc-oc-mirror-permissions  EXPERIMENTAL: opt in to permission mirroring (or set
                     RC_OC_MIRROR_PERMISSIONS=1). Default leaves native permission policy untouched;
                     permissions remain native/local. The retired --rc-oc-skip-permissions is an error.
                     Supported tuple: Linux arm64 and exact OpenCode 1.17.5. No forwarded arguments.

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
  OPENCODE_SERVER_USERNAME HTTP Basic username for a protected \`opencode serve\` (default: opencode).
  OPENCODE_SERVER_PASSWORD HTTP Basic password (preserved byte-for-byte; never logged).

Below is claude's own help:
`;
