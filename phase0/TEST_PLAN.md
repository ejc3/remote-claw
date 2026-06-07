# remote-claw — Test Plan

Scope: the Phase 0 own-relay implementation (the `remote_claw` package +
`remote-claw` CLI). Goal under test: **a real `claude --remote-control` worker and our own
client drive one synced session through a relay we host**, with inference passing
through to the real API.

Environment: a box with `claude` (≥ 2.1.51, tested 2.1.168) logged in via a full
**claude.ai** account (`claude auth status` → `authMethod: claude.ai`), plus
`python3` and `openssl`. Run `./remote-claw doctor` first.

---

## 0. Unit tests (fast, no claude/network)

`make test`  →  `python -m unittest discover -s tests` (`tests/test_unit.py`)

Covers the pure logic: chunked decoding, request parsing, **secret redaction**,
the session event bus (downstream/upstream, initialize-once, ack-skips-redelivery),
and client-event shaping. 13 tests, run in CI on every push/PR (with `ruff`).

## 1. Automated end-to-end test (primary)

`./remote-claw test`  (runs `tests/e2e.py` then `tests/two_surface.py`)

Fully self-contained; private ports (proxy 8899, client 9111) so it won't collide
with a running instance. Steps & assertions:

| Step | Assertion |
| --- | --- |
| ensure certs | CA/leaf exist (generated if missing) |
| start relay | client API answers on the client port |
| launch worker under a pty, pointed at the relay via `HTTPS_PROXY`+`NODE_EXTRA_CA_CERTS` | process starts |
| poll `GET /api/sessions` | the `e2e` session **registers with our relay** (proves the worker's RC backend is us, not Anthropic) |
| `POST /api/sessions/{id}/input` a unique token | HTTP 200 |
| poll `GET /api/sessions/{id}/events` | an `assistant` event **contains the token** (proves: downstream delivery → worker → inference passthrough → upstream delivery → client read) |
| teardown | worker + relay killed |

Pass = exit 0 and `PASS — TUI worker ↔ our relay ↔ our client round-trip
verified.` Last run: **PASS** (reply `'ZEBRA…'`).

What it proves: registration, bridge/`worker_jwt`, worker SSE + `initialize`,
client→worker input, inference passthrough, worker→client output, client read API.

What it does NOT cover: the live local TUI rendering (headless), multi-client
fan-out, reconnect, and the permission prompt path (see §3).

---

## 2. Manual interactive test (the real experience)

1. `./remote-claw up mysession`
   - generates certs, starts the relay (background), launches `claude
     --remote-control mysession` with the proxy env — the **local TUI** appears.
2. Forward the client port and open the UI:
   `ssh -L 9100:127.0.0.1:9100 <box>` → browse `http://127.0.0.1:9100/`.
3. **Client → TUI:** type a message in the web UI, press Send.
   - ✓ it appears in the local TUI and is answered there;
   - ✓ the assistant reply renders in the web UI.
4. **TUI → client:** type a message in the local TUI.
   - ✓ expected: it appears in the web UI (worker echoes user + assistant events
     upstream). *(Status: mechanism in place via upstream fan-out; verify.)*
5. **Inference intact:** the model actually answers → `/v1/messages` passthrough
   works while `/v1/code/*` is intercepted.
6. Stop: close the TUI, then `./remote-claw stop`.

---

## 2b. Two-surface test (bidirectional sync)

`python3 tests/two_surface.py` (or `make test-integration`)

Runs the TUI wrapper (`claude --remote-control` under a controlled pty) against
our relay and proves **both surfaces drive one session**:
- **types a message in the TUI** → asserts it is answered and the reply appears in
  **our client** (TUI → client);
- **sends a message via our client API** → asserts it is answered and appears
  (client → TUI).

Pass = `PASS — both surfaces (TUI + our client) drive one synced session.` Last
run: **PASS** (`KIWI…` typed in TUI seen by client; `PLUM…` from client answered).
`./remote-claw test` runs this after the e2e test.

## 3. Permission flow — RESOLVED (matches real relay)

Finding (verified against BOTH our relay and Anthropic's **real** relay): in
Remote Control, tools **auto-execute with no `can_use_tool` prompt**, even under
`--permission-mode default`. Captured real flow for `echo REALPERM-987`:
`user → assistant(tool_use Bash) → user(tool_result) → assistant` — no permission
gate on the wire. So our relay is **faithful** to real RC; there was no missing
approval step to implement.

- Control today: `./remote-claw worker --permission-mode
  {default|acceptEdits|plan|bypassPermissions}`.
- Plumbing kept for completeness: relay forwards any upstream `control_request`
  to the client stream (`request_id`, `tool_name`, `tool_input`) and accepts
  `POST /api/sessions/{id}/permission {request_id, behavior}` → `control_response`
  downstream. (Not currently triggered, since RC doesn't gate.)

---

## 4. Negative / robustness checks

- **Auth enforced:** `e2e.py` asserts `GET /api/sessions` without a token returns
  **401** before proceeding. (Tested: PASS.)
- `./remote-claw doctor` flags: missing `claude`, missing certs, busy ports, auth
  status. (Tested: reports each correctly.)
- Secret redaction is unit-tested (`tests/test_unit.py`).
- Graceful shutdown: relay exits cleanly on SIGINT/SIGTERM (closes proxy + client
  face); verified by the integration teardown.
- `up` refuses to start if relay ports are busy (`remote-claw stop` first).
- Non-`api.anthropic.com` hosts are blind-tunneled (not MITM'd) — other traffic
  unaffected.
- Other `claude` sessions on the box are unaffected: redirection is per-process
  via `HTTPS_PROXY`, not global `/etc/hosts`.

---

## 5. Regression notes / pinning

- Protocol is **undocumented and version-sensitive** (captured on 2.1.168). If
  the worker fails to reach "Remote Control active" against the relay after a
  `claude` upgrade, re-capture with `mitm/capture-proxy.py` and diff endpoint
  shapes against `docs/phase0-findings.md` §4b.
