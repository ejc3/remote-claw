#!/bin/busybox ash

set -eu
set -o pipefail

fail() {
	printf '%s\n' "trusted final-inspection bootstrap refused" >&2
	exit 126
}

snapshot_root=
publisher_snapshot_root=
stage_file=
cleanup() {
	if [ -n "$stage_file" ]; then
		/bin/busybox rm -f -- "$stage_file"
	fi
	if [ -n "$snapshot_root" ]; then
		/bin/busybox rm -rf -- "$snapshot_root"
	fi
	if [ -n "$publisher_snapshot_root" ]; then
		/bin/busybox rm -rf -- "$publisher_snapshot_root"
	fi
}
trap cleanup EXIT HUP INT TERM

# This statically linked shell is the only process that inherits credentials. Before opening the
# credential pipe, it binds the candidate HEAD and clean worktree, pins every executable it invokes,
# and materializes the scanner's two-module closure directly from committed Git blobs. Every Git
# child receives an empty environment, so wrapper-held provider tokens cannot reach config helpers.
busybox_path=$(/bin/busybox readlink /proc/$$/exe) || fail
[ "$busybox_path" = "/usr/bin/busybox" ] || fail
busybox_stat=$(/bin/busybox stat -Lc '%u:%g:%a:%s' /proc/$$/exe) || fail
[ "$busybox_stat" = "0:0:755:1914704" ] || fail
busybox_digest=$(/bin/busybox sha256sum /proc/$$/exe) || fail
busybox_digest=${busybox_digest%% *}
[ "$busybox_digest" = "52151e7f322f926b64049cdaa1410dc3ea6485525e0624b05813791c219ae933" ] || fail

git_path=$(/bin/busybox readlink -f /usr/bin/git) || fail
[ "$git_path" = "/usr/bin/git" ] || fail
git_stat=$(/bin/busybox stat -Lc '%u:%g:%a:%s' "$git_path") || fail
[ "$git_stat" = "0:0:755:4003072" ] || fail
git_digest=$(/bin/busybox sha256sum "$git_path") || fail
git_digest=${git_digest%% *}
[ "$git_digest" = "aa6540695d076182256dd6e96c8b302e4d56381e3000bbfd5c71bbdfe94a4942" ] || fail

node_path=$(/bin/busybox readlink -f /usr/bin/node) || fail
[ "$node_path" = "/usr/bin/node" ] || fail
node_stat=$(/bin/busybox stat -Lc '%u:%g:%a:%s' "$node_path") || fail
[ "$node_stat" = "0:0:755:122159120" ] || fail
node_digest=$(/bin/busybox sha256sum "$node_path") || fail
node_digest=${node_digest%% *}
[ "$node_digest" = "1a638b0fe2b68da0489276aca95526c5122fc61ba54d6a2d0d00c1c92ab7b876" ] || fail

[ "$#" -eq 0 ] || fail
[ "${RC_TOPOLOGY_RECEIPT_FILE+x}" = x ] && [ -n "$RC_TOPOLOGY_RECEIPT_FILE" ] || fail
[ "${TURSO_API_TOKEN+x}" = x ] && [ -n "$TURSO_API_TOKEN" ] || fail
[ "${TURSO_GROUP_AUTH_TOKEN+x}" = x ] && [ -n "$TURSO_GROUP_AUTH_TOKEN" ] || fail
[ "${VERCEL_TOKEN+x}" = x ] && [ -n "$VERCEL_TOKEN" ] || fail

script_path=$(/bin/busybox readlink -f -- "$0") || fail
script_dir=${script_path%/*}
repository_root=$(/bin/busybox readlink -f -- "$script_dir/..") || fail
[ "$script_path" = "$repository_root/scripts/run-trusted-final-inspection-clean.sh" ] || fail

receipt_path=$(/bin/busybox readlink -f -- "$RC_TOPOLOGY_RECEIPT_FILE") || fail
[ "$RC_TOPOLOGY_RECEIPT_FILE" = "$receipt_path" ] || fail
[ -f "$receipt_path" ] && [ ! -L "$receipt_path" ] || fail
receipt_root=$repository_root/tests/web/test-results
[ "${receipt_path%/*}" = "$receipt_root" ] || fail
current_uid=$(/bin/busybox id -u) || fail
[ "$(/bin/busybox stat -Lc '%u:%a' "$receipt_root")" = "$current_uid:700" ] || fail
receipt_stat=$(/bin/busybox stat -Lc '%u:%a:%h:%s' "$receipt_path") || fail
receipt_owner=${receipt_stat%%:*}
receipt_rest=${receipt_stat#*:}
receipt_mode=${receipt_rest%%:*}
receipt_rest=${receipt_rest#*:}
receipt_links=${receipt_rest%%:*}
receipt_bytes=${receipt_rest##*:}
[ "$receipt_owner" = "$current_uid" ] && [ "$receipt_mode" = 600 ] && [ "$receipt_links" = 1 ] || fail
[ "$receipt_bytes" -gt 0 ] && [ "$receipt_bytes" -le 32768 ] || fail

receipt_name=${receipt_path##*/}
receipt_prefix=real-topology-browser-leg-
case "$receipt_name" in
	"$receipt_prefix"*.json) ;;
	*) fail ;;
esac
receipt_stem=${receipt_name%.json}
receipt_coordinates=${receipt_stem#"$receipt_prefix"}
candidate_head=${receipt_coordinates%%-*}
compact_run_id=${receipt_coordinates#"$candidate_head"-}
[ "$receipt_coordinates" = "$candidate_head-$compact_run_id" ] || fail
[ "${#candidate_head}" -eq 40 ] && [ "${#compact_run_id}" -eq 32 ] || fail
case "$candidate_head$compact_run_id" in
	*[!0-9a-f]*) fail ;;
esac
canonical_receipt=$receipt_root/$receipt_stem.inspection-v1.json
stage_file=$canonical_receipt.stage

run_git() {
	/bin/busybox timeout -s KILL 10 \
		/bin/busybox env -i \
		PATH=/usr/bin:/bin \
		LANG=C.UTF-8 \
		GIT_CONFIG_NOSYSTEM=1 \
		GIT_CONFIG_GLOBAL=/dev/null \
		GIT_NO_REPLACE_OBJECTS=1 \
		GIT_TERMINAL_PROMPT=0 \
		GIT_OPTIONAL_LOCKS=0 \
		/usr/bin/git \
		-C "$repository_root" \
		-c core.fsmonitor=false \
		-c core.hooksPath=/dev/null \
		-c credential.helper= \
		-c protocol.file.allow=never \
		"$@"
}

verify_candidate_tree() {
	git_root=$(run_git rev-parse --show-toplevel 2>/dev/null) || return 1
	[ "$git_root" = "$repository_root" ] || return 1
	git_head=$(run_git rev-parse --verify HEAD 2>/dev/null) || return 1
	[ "$git_head" = "$candidate_head" ] || return 1
	git_status=$(run_git status --porcelain=v1 --untracked-files=all 2>/dev/null) || return 1
	[ -z "$git_status" ] || return 1
}

verify_candidate_tree || fail

snapshot_root=$(/bin/busybox mktemp -d /tmp/remote-claw-final-inspection.XXXXXX) || fail
/bin/busybox chmod 700 "$snapshot_root" || fail
/bin/busybox mkdir -m 700 "$snapshot_root/scripts" || fail

materialize_committed_module() {
	relative_path=$1
	expected_mode=$2
	snapshot_base=$3
	actual_path=$repository_root/$relative_path
	snapshot_path=$snapshot_base/$relative_path
	[ -f "$actual_path" ] && [ ! -L "$actual_path" ] || return 1
	actual_mode=${expected_mode#100}
	[ "$(/bin/busybox stat -Lc '%u:%a:%h' "$actual_path")" = "$current_uid:$actual_mode:1" ] || return 1
	entry=$(run_git ls-tree "$candidate_head" -- "$relative_path" 2>/dev/null) || return 1
	set -- $entry
	[ "$#" -eq 4 ] && [ "$1" = "$expected_mode" ] && [ "$2" = blob ] && [ "$4" = "$relative_path" ] || return 1
	expected_object=$3
	run_git cat-file blob "$expected_object" >"$snapshot_path" 2>/dev/null || return 1
	[ "$(run_git hash-object --no-filters -- "$actual_path" 2>/dev/null)" = "$expected_object" ] || return 1
	[ "$(run_git hash-object --no-filters -- "$snapshot_path" 2>/dev/null)" = "$expected_object" ] || return 1
	/bin/busybox cmp -s "$actual_path" "$snapshot_path" || return 1
	/bin/busybox chmod 400 "$snapshot_path" || return 1
}

materialize_committed_module scripts/run-trusted-final-inspection-clean.sh 100755 "$snapshot_root" || fail
materialize_committed_module scripts/run-trusted-final-inspection.mjs 100644 "$snapshot_root" || fail
materialize_committed_module scripts/inspection-receipt-schema.mjs 100644 "$snapshot_root" || fail

runner_path=$snapshot_root/scripts/run-trusted-final-inspection.mjs
runner_stdout=$snapshot_root/runner.stdout
/bin/busybox rm -f -- "$stage_file" || fail
set +e
{
	printf '%s\0' \
		"$RC_TOPOLOGY_RECEIPT_FILE" \
		"$TURSO_API_TOKEN" \
		"$TURSO_GROUP_AUTH_TOKEN" \
		"$VERCEL_TOKEN"
} | /bin/busybox env -i \
	PATH=/usr/bin:/bin \
	LANG=C.UTF-8 \
	RC_INSPECTION_INPUT_FD=0 \
	RC_INSPECTION_MODE=scan \
	RC_INSPECTION_REPOSITORY_ROOT="$repository_root" \
	/usr/bin/node "$runner_path" >"$runner_stdout"
runner_status=$?
set -e
[ "$runner_status" -eq 0 ] || exit "$runner_status"
runner_output=$(/bin/busybox cat "$runner_stdout") || fail
[ "$runner_output" = "content-free staged final-inspection receipt: $stage_file" ] || fail

# Pin exact stage identity and bytes before the independent tree recheck. The credential-free
# publisher revalidates this tuple from an O_NOFOLLOW descriptor before it can promote the stage.
[ -f "$stage_file" ] && [ ! -L "$stage_file" ] || fail
stage_stat_before=$(/bin/busybox stat -Lc '%d:%i:%u:%a:%h:%s' "$stage_file") || fail
stage_sha256=$(/bin/busybox sha256sum "$stage_file") || fail
stage_sha256=${stage_sha256%% *}
stage_stat_after=$(/bin/busybox stat -Lc '%d:%i:%u:%a:%h:%s' "$stage_file") || fail
[ "$stage_stat_before" = "$stage_stat_after" ] || fail
stage_device=${stage_stat_before%%:*}
stage_rest=${stage_stat_before#*:}
stage_inode=${stage_rest%%:*}
stage_rest=${stage_rest#*:}
stage_owner=${stage_rest%%:*}
stage_rest=${stage_rest#*:}
stage_mode=${stage_rest%%:*}
stage_rest=${stage_rest#*:}
stage_links=${stage_rest%%:*}
stage_size=${stage_rest##*:}
[ "$stage_owner" = "$current_uid" ] && [ "$stage_mode" = 600 ] && [ "$stage_links" = 1 ] || fail
[ "$stage_size" -gt 1 ] && [ "$stage_size" -le 32768 ] || fail
[ "${#stage_sha256}" -eq 64 ] || fail
case "$stage_sha256" in
	*[!0-9a-f]*) fail ;;
esac
stage_stat=$stage_device:$stage_inode:$stage_size

# A successful JS self-check is not substituted for this independent, bounded bootstrap recheck.
verify_candidate_tree || fail
unset TURSO_API_TOKEN TURSO_GROUP_AUTH_TOKEN VERCEL_TOKEN

# The scanner had credentials and shared this uid, so its original 0400 snapshot is no longer a
# trust boundary. Materialize a second committed closure only after the outer recheck and credential
# erasure; the publisher never executes bytes the credential-bearing process could have changed.
publisher_snapshot_root=$(/bin/busybox mktemp -d /tmp/remote-claw-final-inspection-publish.XXXXXX) || fail
/bin/busybox chmod 700 "$publisher_snapshot_root" || fail
/bin/busybox mkdir -m 700 "$publisher_snapshot_root/scripts" || fail
materialize_committed_module scripts/run-trusted-final-inspection.mjs 100644 "$publisher_snapshot_root" || fail
materialize_committed_module scripts/inspection-receipt-schema.mjs 100644 "$publisher_snapshot_root" || fail
publisher_runner_path=$publisher_snapshot_root/scripts/run-trusted-final-inspection.mjs

# Only this credential-free committed publisher may create the canonical passed receipt, and only
# after the independent outer recheck above has succeeded.
set +e
/bin/busybox env -i \
	PATH=/usr/bin:/bin \
	LANG=C.UTF-8 \
	RC_INSPECTION_MODE=publish \
	RC_INSPECTION_REPOSITORY_ROOT="$repository_root" \
	RC_TOPOLOGY_RECEIPT_FILE="$receipt_path" \
	RC_INSPECTION_STAGE_FILE="$stage_file" \
	RC_INSPECTION_STAGE_SHA256="$stage_sha256" \
	RC_INSPECTION_STAGE_STAT="$stage_stat" \
	/usr/bin/node "$publisher_runner_path" >"$runner_stdout"
publisher_status=$?
set -e
[ "$publisher_status" -eq 0 ] || exit "$publisher_status"
/bin/busybox cat "$runner_stdout"
