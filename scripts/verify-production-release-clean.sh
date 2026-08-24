#!/bin/busybox ash

set -eu
set -o pipefail

fail() {
	printf '%s\n' "trusted production verifier bootstrap refused" >&2
	exit 126
}

snapshot_root=
publisher_snapshot_root=
materialization_root=
staged_receipt=
initial_release_head=
initial_release_tree=
publisher_started=0
publisher_succeeded=0
publisher_indeterminate_seen=0
cleanup() {
	if [ -n "$staged_receipt" ]; then
		if [ "$publisher_started" -eq 0 ] || [ "$publisher_succeeded" -eq 1 ]; then
			/bin/busybox rm -f -- "$staged_receipt"
		fi
	fi
	if [ -n "$snapshot_root" ]; then
		/bin/busybox rm -rf -- "$snapshot_root"
	fi
	if [ -n "$publisher_snapshot_root" ]; then
		/bin/busybox rm -rf -- "$publisher_snapshot_root"
	fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# This statically linked shell is the only process that inherits credentials. Before opening the
# credential pipe, it binds the inspection's candidate to an exact clean, equal-tree release HEAD,
# pins every executable it invokes, and materializes the verifier's three-file closure directly from
# committed Git blobs. Every Git child receives an empty environment, so wrapper-held provider tokens
# cannot reach repository config helpers.
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
[ "${GITHUB_REPOSITORY+x}" = x ] && [ -n "$GITHUB_REPOSITORY" ] || fail
[ "${GITHUB_TOKEN+x}" = x ] && [ -n "$GITHUB_TOKEN" ] || fail
[ "${RC_PRODUCTION_DEPLOYMENT_ID+x}" = x ] && [ -n "$RC_PRODUCTION_DEPLOYMENT_ID" ] || fail
[ "${RC_INSPECTION_RECEIPT_FILE+x}" = x ] && [ -n "$RC_INSPECTION_RECEIPT_FILE" ] || fail
[ "${VERCEL_AUTOMATION_BYPASS_SECRET+x}" = x ] && [ -n "$VERCEL_AUTOMATION_BYPASS_SECRET" ] || fail
[ "${VERCEL_TOKEN+x}" = x ] && [ -n "$VERCEL_TOKEN" ] || fail

script_path=$(/bin/busybox readlink -f -- "$0") || fail
script_dir=${script_path%/*}
repository_root=$(/bin/busybox readlink -f -- "$script_dir/..") || fail
[ "$script_path" = "$repository_root/scripts/verify-production-release-clean.sh" ] || fail

receipt_path=$(/bin/busybox readlink -f -- "$RC_INSPECTION_RECEIPT_FILE") || fail
[ "$RC_INSPECTION_RECEIPT_FILE" = "$receipt_path" ] || fail
[ -f "$receipt_path" ] && [ ! -L "$receipt_path" ] || fail
receipt_root=$repository_root/tests/web/test-results
[ "${receipt_path%/*}" = "$receipt_root" ] || fail
current_uid=$(/bin/busybox id -u) || fail
[ "$(/bin/busybox stat -Lc '%u:%a' "$receipt_root")" = "$current_uid:700" ] || fail
# A prior failed publication's random stage is its only outer-wrapper provenance binding. Never run a
# new timestamp-varying verifier over it or silently select one from same-uid storage.
preserved_stage=$(/bin/busybox find "$receipt_root" -maxdepth 1 -name '.production-release-stage-*.json' -print -quit) || fail
[ -z "$preserved_stage" ] || fail
receipt_stat=$(/bin/busybox stat -Lc '%u:%a:%h:%s' "$receipt_path") || fail
receipt_owner=${receipt_stat%%:*}
receipt_rest=${receipt_stat#*:}
receipt_mode=${receipt_rest%%:*}
receipt_rest=${receipt_rest#*:}
receipt_links=${receipt_rest%%:*}
receipt_bytes=${receipt_rest##*:}
[ "$receipt_owner" = "$current_uid" ] && [ "$receipt_mode" = 600 ] && [ "$receipt_links" = 1 ] || fail
[ "$receipt_bytes" -gt 0 ] && [ "$receipt_bytes" -le 131072 ] || fail

receipt_name=${receipt_path##*/}
receipt_prefix=real-topology-browser-leg-
receipt_suffix=.inspection-v1.json
case "$receipt_name" in
	"$receipt_prefix"*"$receipt_suffix") ;;
	*) fail ;;
esac
receipt_coordinates=${receipt_name#"$receipt_prefix"}
receipt_coordinates=${receipt_coordinates%"$receipt_suffix"}
candidate_head=${receipt_coordinates%%-*}
compact_run_id=${receipt_coordinates#"$candidate_head"-}
[ "$receipt_coordinates" = "$candidate_head-$compact_run_id" ] || fail
[ "${#candidate_head}" -eq 40 ] && [ "${#compact_run_id}" -eq 32 ] || fail
case "$candidate_head$compact_run_id" in
	*[!0-9a-f]*) fail ;;
esac

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

verify_release_tree() {
	git_root=$(run_git rev-parse --show-toplevel 2>/dev/null) || return 1
	[ "$git_root" = "$repository_root" ] || return 1
	replace_refs=$(run_git for-each-ref --format='%(refname)' refs/replace 2>/dev/null) || return 1
	[ -z "$replace_refs" ] || return 1
	common_directory=$(run_git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
	[ "$(/bin/busybox readlink -f -- "$common_directory")" = "$common_directory" ] || return 1
	[ ! -e "$common_directory/info/grafts" ] || return 1
	git_head=$(run_git rev-parse --verify HEAD 2>/dev/null) || return 1
	case "$git_head" in
		????????????????????????????????????????) ;;
		*) return 1 ;;
	esac
	case "$git_head" in
		*[!0-9a-f]*) return 1 ;;
	esac
	git_status=$(run_git status --porcelain=v1 --untracked-files=all 2>/dev/null) || return 1
	[ -z "$git_status" ] || return 1
	run_git merge-base --is-ancestor "$candidate_head" "$git_head" >/dev/null 2>&1 || return 1
	candidate_tree=$(run_git rev-parse "$candidate_head^{tree}" 2>/dev/null) || return 1
	release_tree=$(run_git rev-parse "$git_head^{tree}" 2>/dev/null) || return 1
	[ "$candidate_tree" = "$release_tree" ] || return 1
	[ -z "$initial_release_head" ] || [ "$git_head" = "$initial_release_head" ] || return 1
	[ -z "$initial_release_tree" ] || [ "$release_tree" = "$initial_release_tree" ] || return 1
	case "$candidate_tree" in
		????????????????????????????????????????) ;;
		*) return 1 ;;
	esac
	case "$candidate_tree" in
		*[!0-9a-f]*) return 1 ;;
	esac
}

verify_release_tree || fail
initial_release_head=$git_head
initial_release_tree=$release_tree

snapshot_root=$(/bin/busybox mktemp -d /tmp/remote-claw-production-verifier.XXXXXX) || fail
/bin/busybox chmod 700 "$snapshot_root" || fail
/bin/busybox mkdir -m 700 "$snapshot_root/scripts" || fail

materialize_committed_module() {
	relative_path=$1
	expected_mode=$2
	actual_path=$repository_root/$relative_path
	snapshot_path=$materialization_root/$relative_path
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

materialization_root=$snapshot_root
materialize_committed_module scripts/verify-production-release-clean.sh 100755 || fail
materialize_committed_module scripts/verify-production-release.mjs 100644 || fail
materialize_committed_module scripts/inspection-receipt-schema.mjs 100644 || fail

runner_path=$snapshot_root/scripts/verify-production-release.mjs
runner_stdout=$snapshot_root/runner.stdout
set +e
{
	printf '%s\0' \
		"$GITHUB_REPOSITORY" \
		"$GITHUB_TOKEN" \
		"$RC_PRODUCTION_DEPLOYMENT_ID" \
		"$RC_INSPECTION_RECEIPT_FILE" \
		"$VERCEL_AUTOMATION_BYPASS_SECRET" \
		"$VERCEL_TOKEN"
} | /bin/busybox env -i \
	PATH=/usr/bin:/bin \
	LANG=C.UTF-8 \
	RC_PRODUCTION_INPUT_FD=0 \
	RC_PRODUCTION_REPOSITORY_ROOT="$repository_root" \
	/usr/bin/node "$runner_path" >"$runner_stdout"
runner_status=$?
set -e

# The credential-bearing verifier may only stage private bytes. Bind those exact bytes before the
# independent outer Git recheck, then hand the binding to a fresh credential-free publisher.
[ "$runner_status" -eq 0 ] || {
	verify_release_tree || fail
	exit "$runner_status"
}
[ "$(/bin/busybox wc -l <"$runner_stdout")" -eq 1 ] || fail
runner_line=$(/bin/busybox cat "$runner_stdout") || fail
stage_prefix='staged production release attestation: '
case "$runner_line" in
	"$stage_prefix"*) ;;
	*) fail ;;
esac
stage_candidate=${runner_line#"$stage_prefix"}
[ "$stage_candidate" = "$(/bin/busybox readlink -f -- "$stage_candidate")" ] || fail
[ "${stage_candidate%/*}" = "$receipt_root" ] || fail
case "${stage_candidate##*/}" in
	.production-release-stage-????????-????-4???-[89ab]???-????????????.json) ;;
	*) fail ;;
esac
[ -f "$stage_candidate" ] && [ ! -L "$stage_candidate" ] || fail
stage_stat=$(/bin/busybox stat -Lc '%d:%i:%u:%a:%h:%s' "$stage_candidate") || fail
stage_device=${stage_stat%%:*}
stage_rest=${stage_stat#*:}
stage_inode=${stage_rest%%:*}
stage_rest=${stage_rest#*:}
stage_owner=${stage_rest%%:*}
stage_rest=${stage_rest#*:}
stage_mode=${stage_rest%%:*}
stage_rest=${stage_rest#*:}
stage_links=${stage_rest%%:*}
stage_size=${stage_rest##*:}
[ "$stage_owner" = "$current_uid" ] && [ "$stage_mode" = 600 ] && [ "$stage_links" = 1 ] || fail
[ "$stage_size" -gt 0 ] && [ "$stage_size" -le 131072 ] || fail
case "$stage_device$stage_inode$stage_size" in
	*[!0-9]*) fail ;;
esac
stage_sha256=$(/bin/busybox sha256sum "$stage_candidate") || fail
stage_sha256=${stage_sha256%% *}
case "$stage_sha256" in
	????????????????????????????????????????????????????????????????) ;;
	*) fail ;;
esac
case "$stage_sha256" in
	*[!0-9a-f]*) fail ;;
esac
staged_receipt=$stage_candidate

# A successful JS self-check is not substituted for this independent, bounded bootstrap recheck.
verify_release_tree || fail

# The credential-free publisher gets a fresh committed snapshot. The credential-bearing verifier
# cannot mutate the executable bytes that will promote its staging file.
publisher_snapshot_root=$(/bin/busybox mktemp -d /tmp/remote-claw-production-publisher.XXXXXX) || fail
/bin/busybox chmod 700 "$publisher_snapshot_root" || fail
/bin/busybox mkdir -m 700 "$publisher_snapshot_root/scripts" || fail
materialization_root=$publisher_snapshot_root
materialize_committed_module scripts/verify-production-release-clean.sh 100755 || fail
materialize_committed_module scripts/verify-production-release.mjs 100644 || fail
materialize_committed_module scripts/inspection-receipt-schema.mjs 100644 || fail
publisher_runner_path=$publisher_snapshot_root/scripts/verify-production-release.mjs

publisher_stdout=$snapshot_root/publisher.stdout
publisher_stderr=$snapshot_root/publisher.stderr
run_publisher() {
	{
		printf '%s\0' \
			"$staged_receipt" \
			"$stage_sha256" \
			"$stage_device" \
			"$stage_inode" \
			"$stage_size"
	} | /bin/busybox env -i \
		PATH=/usr/bin:/bin \
		LANG=C.UTF-8 \
		RC_PRODUCTION_PUBLISH_INPUT_FD=0 \
		RC_PRODUCTION_REPOSITORY_ROOT="$repository_root" \
		/usr/bin/node "$publisher_runner_path" >"$publisher_stdout" 2>"$publisher_stderr"
}

publisher_started=1
set +e
run_publisher
publisher_status=$?
# Exit 75 means the transaction has durable or ambiguous state that requires exact same-stage
# reconciliation. A signal-killed publisher may have crossed the same boundary before it died.
# Retry either outcome once in a fresh clean process, then preserve the stage on any failure.
if [ "$publisher_status" -eq 75 ] || [ "$publisher_status" -ge 128 ]; then
	publisher_indeterminate_seen=1
	run_publisher
	publisher_status=$?
fi
if [ "$publisher_indeterminate_seen" -eq 1 ] && [ "$publisher_status" -ne 0 ]; then
	publisher_status=75
fi
set -e
[ "$publisher_status" -eq 0 ] || {
	# Preserve the independent bound stage so an unresolved publication retains exact recovery
	# evidence. The publisher never deletes or replaces an already-visible canonical receipt.
	/bin/busybox cat "$publisher_stderr" >&2 || :
	exit "$publisher_status"
}
publisher_succeeded=1
/bin/busybox cat "$publisher_stdout"
