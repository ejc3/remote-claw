# Code Review — Phase 0 relay (2026-06-07)

Two independent reviewers over the `phase0-own-relay` diff (27 files, ~3.3k lines):

1. **`/code-review` (multi-agent workflow)** — 8 finder angles (correctness,
   concurrency, protocol, security, reliability, cross-file, cleanup, altitude),
   deduped to 44 unique candidates, each verified by an independent agent
   (CONFIRMED / PLAUSIBLE / REFUTED). 43 survived.
2. **`codex` (gpt-5.5), bite-sized per-module** — independent passes over
   `client_api.py`, `mitm.py`, `core.py`, `server.py`+`cli.py`.

The two converged on the highest-severity issues (concurrency double-delivery,
missing socket timeouts, passthrough framing, token handling) — strong signal.

All actionable findings below were **fixed and re-verified** (`make check` +
integration tests green). Lower-value findings are **deferred** with rationale.

## Fixed

| Area | Finding | Fix |
| --- | --- | --- |
| concurrency (HIGH) | two concurrent worker SSE followers double-deliver on the reconnect race → duplicate turns / double permission responses | `Session.claim_worker_stream()` generation fencing — a new stream supersedes the old; `follow_downstream(gen, …)` exits when superseded |
| concurrency | lost-wakeup: `follow_downstream`/`follow_upstream` checked `closed` outside the lock → streams lingered ~10s on shutdown | re-check `closed`/`stop`/`gen` **inside** the lock before and after `wait()` |
| concurrency | `push_initialize` released the lock before enqueueing → a user event could precede `initialize` | enqueue `initialize` atomically under the lock (guaranteed seq 1) |
| security (HIGH) | live access token written verbatim to `relay.log`; redactor missed `token=`/`rc_token` | never log the token (log URL without it; `up` prints it to the terminal); added `token=`/`rc_token`/`x-api-key` redaction; `relay.log` chmod 0600 |
| security (HIGH) | `--expose` serves plaintext with token in URL/cookie | token kept out of logs; louder plaintext warning; localhost default unchanged (TLS = deferred, see below) |
| reliability (HIGH) | accepted proxy sockets + client server had no timeout → slow/idle peers pin threads | `settimeout(30)` on accepted proxy sockets; `_Handler.timeout = 30` on the client face |
| reliability (HIGH) | `cmd_up` returned on health-check failure without killing the spawned relay (orphan holding ports) | `proc.terminate()` + `wait()` on failure |
| correctness (HIGH) | `--proxy-port` placed **before** the subcommand was silently dropped (subparser default clobbered it) | subcommand port options use `argparse.SUPPRESS`; top-level keeps the defaults |
| reliability | `cmd_stop` ran `pkill -f remote-control` — would kill the user's **other** `claude --remote-control` sessions | only signal the tracked relay pid |
| protocol (HIGH) | passthrough dechunked a `chunked` body but forwarded `Transfer-Encoding: chunked` with no `Content-Length` → upstream misframe | drop `Transfer-Encoding`/stale `Content-Length`, set exact `Content-Length: len(body)`; also strip hop-by-hop headers named in `Connection` |
| reliability | truncated `Content-Length` body forwarded with stale length → upstream hang | mitigated by the framing fix (exact length of bytes actually read) |
| security | negative `Content-Length` → `rfile.read(-1)` blocks a handler thread | reject `n < 0` in `_read_json` |
| security | `?token=` not URL-decoded / not anchored | parse via `urllib.parse.parse_qs` (decodes + exact value) |
| security | `/healthz` leaked live session count (reachable under `--expose`) | returns `{ok: true}` only |
| reliability | client SSE used `lambda: False` as stop predicate → never observed shutdown | pass the relay `stop` event into the client face |
| protocol | `POST /worker/events` returned `{}` not the `{results:[…]}` array | return per-event `{event_id, sequence_num, duplicate}` |
| correctness | IPv6 `CONNECT [::1]:443` authority parse raised | `_split_authority()` (bracket-aware) |
| correctness | bytes pipelined after the `CONNECT` line were discarded | forward them into the blind tunnel |
| reliability | signal handler did blocking shutdown work (deadlock risk) | handler only sets the flag; teardown runs on the main thread; join both threads |
| cleanup | `_assistant_text` duplicated in `mitm` + `client_api` | shared `core.assistant_text` |
| cleanup | `cli.py` leaked the Popen log fd in the parent | `with open(...)` |
| cleanup | `ws-logger.js` (pre-pivot, unreferenced) | removed |

## Deferred (rationale)

- **Upstream connection pooling** (`mitm._passthrough` opens a fresh TCP+TLS per
  request, `Connection: close`). Correct, just not optimal; inference latency is
  model-dominated and pooling adds real complexity/risk. Revisit if perf matters.
- **TLS on the client face** for `--expose`. Mitigated (token never logged, loud
  warning, localhost default). Proper fix = serve `wss`/`https` or require a
  tunnel; deferred — SSH forwarding is the supported path.
- **`worker_epoch` increment/validation**, **single `Condition` for both
  streams**, **O(n) pending rescan**, **5s UI poll alongside SSE** — all correct
  at single-worker scale; micro-optimizations.
- **`capture-proxy.py` duplicates the HTTP helper layer** — it's a frozen
  research/capture artifact (excluded from lint), intentionally standalone.
- **Blind-tunnel accepts any `CONNECT` host** — the proxy is localhost-bound and
  only our own worker uses it; not an exposure in this design.

## Verification
`make check` (ruff + ruff-format + 20 unit tests) green; `tests/e2e.py` and
`tests/two_surface.py` PASS after the fixes. New unit tests cover stream
supersede/close, ack-skip, initialize-ordering, token redaction, and the mitm
authority/hop-by-hop helpers.
