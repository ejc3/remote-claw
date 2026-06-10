#!/usr/bin/env bash
# Stand up a local Temporal dev server (in-memory, no Docker) + the relayChannel worker, run "$@"
# with TEMPORAL_ADDRESS exported, then tear everything down. Used by the Temporal-backed broker tests
# (the vitest contract test and the Playwright app e2e) so a single command provisions the whole
# stack — `pnpm --filter @remote-claw/web test:temporal`, `cd tests/web && pnpm test:app:temporal`.
#
# Requires the Temporal CLI (https://temporal.download): `temporal` on PATH, or installed at
# ~/.temporalio/bin/temporal via `curl -sSf https://temporal.download/cli.sh | sh`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADDR="${TEMPORAL_ADDRESS:-127.0.0.1:7233}"
# Split host:port; a colon-less address (e.g. "localhost") defaults the port to 7233.
case "$ADDR" in
  *:*) HOST="${ADDR%:*}"; PORT="${ADDR##*:}" ;;
  *)   HOST="$ADDR"; PORT="7233"; ADDR="$ADDR:7233" ;;
esac

TEMPORAL_BIN="$(command -v temporal || true)"
[ -z "$TEMPORAL_BIN" ] && [ -x "$HOME/.temporalio/bin/temporal" ] && TEMPORAL_BIN="$HOME/.temporalio/bin/temporal"
if [ -z "$TEMPORAL_BIN" ]; then
  echo "with-temporal: Temporal CLI not found." >&2
  echo "  install: curl -sSf https://temporal.download/cli.sh | sh" >&2
  exit 1
fi
export TEMPORAL_CLI="$TEMPORAL_BIN" # so the run command (e.g. the e2e's temporal probe) can find it

pids=()
cleanup() {
  # Stop the worker (its tsx → node child tree) and anything else we started.
  pkill -f "$ROOT/apps/web/temporal/worker.ts" 2>/dev/null || true
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

healthy() { "$TEMPORAL_BIN" operator cluster health --address "$ADDR" >/dev/null 2>&1; }

if healthy; then
  echo "with-temporal: reusing the Temporal server already healthy on $ADDR"
else
  echo "with-temporal: starting dev server on $ADDR"
  "$TEMPORAL_BIN" server start-dev --ip "$HOST" --port "$PORT" --headless >/tmp/temporal-dev.log 2>&1 &
  pids+=($!)
  for _ in $(seq 1 60); do healthy && break; sleep 1; done
  if ! healthy; then
    echo "with-temporal: dev server did not become healthy on $ADDR; see /tmp/temporal-dev.log" >&2
    tail -20 /tmp/temporal-dev.log >&2 || true
    exit 1
  fi
fi

echo "with-temporal: starting relayChannel worker"
( cd "$ROOT/apps/web" && TEMPORAL_ADDRESS="$ADDR" pnpm exec tsx temporal/worker.ts ) >/tmp/temporal-worker.log 2>&1 &
pids+=($!)
for _ in $(seq 1 60); do
  grep -q "ready —" /tmp/temporal-worker.log && break
  sleep 1
done
if ! grep -q "ready —" /tmp/temporal-worker.log; then
  echo "with-temporal: worker did not become ready; see /tmp/temporal-worker.log" >&2
  tail -20 /tmp/temporal-worker.log >&2 || true
  exit 1
fi

echo "with-temporal: running: $*"
TEMPORAL_ADDRESS="$ADDR" "$@"
