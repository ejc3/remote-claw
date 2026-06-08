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
  --rc-file <path>   use a specific secret file (default: $XDG_STATE_HOME/remote-claw/secret;
                     or set REMOTE_CLAW_SECRET_FILE)
  --rc-json          machine-readable output for an rc action (never prints the secret)
  --rc-quiet         minimal output for an rc action (never prints the secret)

Further --rc-* actions (broker config) arrive in later releases.

Below is claude's own help:
`;
