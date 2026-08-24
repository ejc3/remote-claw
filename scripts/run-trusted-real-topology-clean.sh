#!/bin/busybox ash

set -eu

fail() {
	printf '%s\n' "trusted real-topology bootstrap refused" >&2
	exit 126
}

# This shell is the only process that receives the operator's credential-bearing environment.
# BusyBox is statically linked, so hostile loader variables cannot execute before this check.
busybox_path=$(/bin/busybox readlink /proc/$$/exe) || fail
[ "$busybox_path" = "/usr/bin/busybox" ] || fail
busybox_stat=$(/bin/busybox stat -Lc '%u:%g:%a:%s' /proc/$$/exe) || fail
[ "$busybox_stat" = "0:0:755:1914704" ] || fail
busybox_digest=$(/bin/busybox sha256sum /proc/$$/exe) || fail
busybox_digest=${busybox_digest%% *}
[ "$busybox_digest" = "52151e7f322f926b64049cdaa1410dc3ea6485525e0624b05813791c219ae933" ] || fail

[ "$#" -eq 0 ] || fail
[ "${HOME+x}" = x ] && [ -n "$HOME" ] || fail
[ "${GITHUB_REPOSITORY+x}" = x ] && [ -n "$GITHUB_REPOSITORY" ] || fail
[ "${GITHUB_TOKEN+x}" = x ] && [ -n "$GITHUB_TOKEN" ] || fail
[ "${RC_DEPLOYMENT_ID+x}" = x ] && [ -n "$RC_DEPLOYMENT_ID" ] || fail
[ "${VERCEL_AUTOMATION_BYPASS_SECRET+x}" = x ] && [ -n "$VERCEL_AUTOMATION_BYPASS_SECRET" ] || fail
[ "${VERCEL_TOKEN+x}" = x ] && [ -n "$VERCEL_TOKEN" ] || fail
[ "${RC_PROVE_CLAUDE_CWD+x}" = x ] && [ -n "$RC_PROVE_CLAUDE_CWD" ] || fail

script_path=$(/bin/busybox readlink -f -- "$0") || fail
script_dir=${script_path%/*}
runner_path=$(/bin/busybox readlink -f -- "$script_dir/run-trusted-real-topology.mjs") || fail
[ -f "$runner_path" ] || fail

{
	printf '%s\0' \
		"$HOME" \
		"$GITHUB_REPOSITORY" \
		"$GITHUB_TOKEN" \
		"$RC_DEPLOYMENT_ID" \
		"$VERCEL_AUTOMATION_BYPASS_SECRET" \
		"$VERCEL_TOKEN" \
		"$RC_PROVE_CLAUDE_CWD"
} | /bin/busybox env -i \
	PATH=/usr/bin:/bin \
	LANG=C.UTF-8 \
	RC_PROOF_INPUT_FD=0 \
	/usr/bin/node "$runner_path"
