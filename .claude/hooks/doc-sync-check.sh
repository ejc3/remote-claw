#!/usr/bin/env bash
# Stop hook — at the completion of a turn/loop, if any tracked Markdown changed this session, ask whether
# the mandatory doc-sync pass (see CLAUDE.md "## Mandatory doc-sync pass") is warranted before finishing.
#
# WHY remote-claw needs this: docs/*.md is rendered LIVE by marked.js (docs/index.html), so the markdown
# IS the source of truth — a malformed list or a stale claim ships verbatim. And the docs describe a moving
# surface (the RC protocol verbs, the per-driver permission/capability model, the --rc-* CLI flags), so they
# drift from the code that defines them (e.g. a driver's permission model changing from auto-approve to
# mirroring without its protocol.md row / *-driver.md being updated). The doc-sync pass is the backstop.
#
# Conservative by design:
#   - Triggers only on *.md changes (tracked, staged or unstaged, OR untracked). Nothing else fires it.
#   - Asks at most ONCE per distinct change state: a sentinel under .git/ records a hash of the current
#     contents of the changed files, so it re-asks only when they change further, never nags.
#   - Loop-guarded via stop_hook_active so it cannot bounce the agent in a stop sequence.
#
# Output contract: print a Stop-hook JSON decision to stdout and ALWAYS exit 0 (a hook fault must never
# wedge the session). `set -e` is deliberately omitted so a failing helper can't abort before exit 0.
set -uo pipefail

input="$(cat)"

# Loop guard, whitespace-tolerant; here-string (no pipe → no SIGPIPE even on a large payload).
if grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' <<<"$input"; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Changed (tracked, staged or unstaged) + untracked Markdown, NUL-delimited so spaced/odd paths are
# handled exactly (no word-splitting, no quote-truncation).
paths=()
while IFS= read -r -d '' f; do paths+=("$f"); done < <(
  git diff HEAD --name-only -z -- '*.md' 2>/dev/null
  git ls-files --others --exclude-standard -z -- '*.md' 2>/dev/null
)
[ "${#paths[@]}" -eq 0 ] && exit 0

# Hash the CURRENT contents of every changed/untracked file (captures edits to tracked AND untracked),
# so the prompt re-raises only when the set or its contents change further.
cur="$(
  for f in "${paths[@]}"; do
    printf '%s\0' "$f"
    [ -f "$f" ] && cat -- "$f"
  done | cksum | awk '{print $1 "-" $2}'
)"
sentinel="$(git rev-parse --git-dir)/doc-sync-asked"
if [ -f "$sentinel" ] && [ "$(cat "$sentinel" 2>/dev/null)" = "$cur" ]; then
  exit 0
fi
printf '%s' "$cur" >"$sentinel" 2>/dev/null || true

docs="$(printf '%s\n' "${paths[@]}" | sort -u | paste -sd, - | sed 's/,/, /g')"
reason="Doc-sync check: Markdown changed this session (${docs}). Per the mandatory doc-sync pass in CLAUDE.md, before finishing ask the user whether a doc-sync review is warranted across the affected docs: (1) RENDER — run the changed docs/*.md through marked and assert no list markers are stranded inside <p> tags (the jumble signature), fences balanced; (2) CODE-TRUTH — every documented --rc-* flag, RC verb, endpoint, and per-driver permission/capability claim matches the code that defines it (args.ts / the driver / protocol.md); (3) CROSS-DOC SYNC — no contradictions between v2-architecture.md, protocol.md, and the *-driver.md / pluggable-harness.md docs; (4) LOOSE ENDS — no stale/dangling references. If the user already had it run or declines, proceed; this prompt will not re-raise for the same changes."

# Emit a valid Stop-hook JSON decision (node escapes the reason); if node is unavailable or errors, fall
# back to a STATIC, quote-free JSON. Either branch leaves stdout valid; the trailing exit 0 always runs.
node -e 'process.stdout.write(JSON.stringify({ decision: "block", reason: process.argv[1] }))' "$reason" 2>/dev/null ||
  printf '%s' '{"decision":"block","reason":"Doc-sync check: Markdown changed this session; consider the mandatory doc-sync pass (CLAUDE.md) before finishing."}'
exit 0
