# remote-claw — Test Plan

Scope: the Phase 0 own-relay implementation (`relay/relay.py` + `remote-claw`
CLI). Goal under test: **a real `claude --remote-control` worker and our own
client drive one synced session through a relay we host**, with inference passing
through to the real API.

Environment: a box with `claude` (≥ 2.1.51, tested 2.1.168) logged in via a full
**claude.ai** account (`claude auth status` → `authMethod: claude.ai`), plus
`python3` and `openssl`. Run `./remote-claw doctor` first.

---

## 1. Automated end-to-end test (primary)

`./remote-claw test`  (wraps `test/e2e.py`)

Fully self-contained; private ports (proxy 8899, client 9111) so it won't collide
with a running instance. Steps & assertions:

| Step | Assertion |
| --- | --- |
| ensure certs | CA/leaf exist (generated if missing) |
| start relay | client API answers on the client port |
| launch worker under a pty, pointed at the relay via `HTTPS_PROXY`+`NODE_EXTRA_CA_CERTS` | process starts |
| poll `GET /api/sessions` | the `e2e-test` session **registers with our relay** (proves the worker's RC backend is us, not Anthropic) |
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

## 3. Permission flow (Phase 2 — partial)

Finding (Phase 0): with our minimal `initialize`, the worker executes tools
without emitting `can_use_tool` upstream — even under `--permission-mode default`
(verified: `Bash(echo …)` ran with no prompt). So full client-side approval is
not yet exercised end-to-end.

- Plumbing present: relay forwards any upstream `control_request` to the client
  stream (with `request_id`, `tool_name`, `tool_input`) and accepts decisions via
  `POST /api/sessions/{id}/permission {request_id, behavior}` →
  pushes a `control_response` downstream.
- Practical control today: choose the worker's mode via
  `./remote-claw worker --permission-mode {default|acceptEdits|plan|bypassPermissions}`.
- TODO: reverse-engineer the handshake capability that makes the worker route
  `can_use_tool` to the relay, then assert allow/deny in an automated test.

---

## 4. Negative / robustness checks

- `./remote-claw doctor` flags: missing `claude`, missing certs, busy ports, auth
  status. (Tested: reports each correctly.)
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
