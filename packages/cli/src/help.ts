// The `--help` banner for the reserved `--rc-*` surface. `remote-claw --help` prints this and
// then falls through to `claude --help`, so the user sees both layers. Kept honest to what is
// actually implemented today; deferred actions are named as "later releases", not listed as if
// usable.

export const RC_HELP = `remote-claw — a transparent wrapper around \`claude\`.
Everything except the reserved --rc-* flags is forwarded verbatim to claude (use \`--\` to pass a
literal --rc-* through). To start a session already remote-controlled, pass claude's own
\`--remote-control\`.

Identity (local; never launches claude, never touches the network):
  --rc-identity      ensure this host's secret exists and print it once (create-once, idempotent).
                     Re-run with --rc-confirm <identity_id> to REPLACE it: mint a new, unrelated
                     identity and abandon the old one (DESTRUCTIVE; not a true rotation and NOT a
                     revocation — a leaked old secret keeps working until you re-onboard every
                     device). Needs a terminal unless --rc-force-noninteractive; --rc-keep-old
                     keeps the old secret as a live backup.
  --rc-show-secret   re-reveal this host's secret (warns first; --rc-yes skips the prompt)
  --rc-pass          print a viewer PASS for this machine: a credential that can read + steer this
                     machine's sessions but is NOT the master secret (can't reveal it or reset the
                     machine). Hand it to a phone/browser (paste or QR); revoke by resetting the
                     machine. The pass IS the output here, so it prints in every mode.
  --rc-file <path>   use a specific secret file (default: $XDG_STATE_HOME/remote-claw/secret;
                     or set REMOTE_CLAW_SECRET_FILE)
  --rc-json          machine-readable output for an rc action (never prints the master secret)
  --rc-quiet         minimal output for an rc action (never prints the master secret)

Remote control (relay sessions to the broker so a phone/laptop can watch + steer):
  --rc-app <origin>  the app origin whose /api is the broker (or set RC_APP). With it, launching claude
                     wraps it in the MITM and bridges each session to the broker; without it, claude runs
                     transparently.
  --rc-backend <n>   pick the broker's durable backend this host targets (or set RC_BACKEND): vercel |
                     local | temporal | turso. Omitted ⇒ the broker's default. Must match what your
                     viewers use. "turso" is a durable log, so the host serves history from it instead of
                     keeping (and replaying) an in-memory transcript.

Diagnostics:
  --rc-trace         stand up a MITM that passes through to the REAL api.anthropic.com and traces the
                     Remote-Control protocol both ways, then spawn claude behind it (no broker — a live
                     protocol inspector). Set RC_LOG=debug for frame shapes, RC_LOG=trace for full
                     bodies (RC_LOG_FILE=… to capture on disk). All local.

Below is claude's own help:
`;
