# remote-claw (Phase 0) — working own-relay

Drive a real `claude --remote-control` session from **your own relay + client**:
the local TUI and your remote web client share **one synced session**, while
model inference passes straight through to the real Anthropic API.

This is the **Option 2 (own-relay via MITM)** implementation. Background, the
reverse-engineered protocol, and design rationale are in
[`../docs/phase0-findings.md`](../docs/phase0-findings.md).

## How it works

```
 claude --remote-control      HTTPS_PROXY      relay.py (MITM of api.anthropic.com)
   (local TUI, real session) ───────────────▶  ├─ intercepts /v1/code/sessions*  ← our relay/sync brain
                                                ├─ passes /v1/messages through    ← real inference
                                                └─ client UI + API on :9100  ◀──  your browser / curl
```
Redirection is **per-process** (`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`) — no
`/etc/hosts`, no sudo, no effect on other `claude` sessions on the box.

## Requirements

- `claude` ≥ 2.1.51 (tested **2.1.168**) logged in with a **claude.ai** account
  (`claude auth status` → `authMethod: claude.ai`). API-key / inference-only
  tokens can't establish Remote Control.
- `python3` + `openssl` (stdlib only; no pip installs).

## Quickstart

```bash
./remote-claw doctor          # check claude, openssl, certs, ports, auth
./remote-claw up mysession    # certs + relay (bg) + claude --remote-control (TUI)
# forward the client port from your laptop, then open the UI:
#   ssh -L 9100:127.0.0.1:9100 <box>   →   http://127.0.0.1:9100/
./remote-claw stop            # stop the background relay + workers
```

Type in the web UI *or* the local TUI — both drive the same session.

## Commands

| Command | What it does |
| --- | --- |
| `remote-claw doctor` | environment + auth check |
| `remote-claw certs [--force]` | generate the MITM CA + leaf cert (idempotent) |
| `remote-claw relay [-v]` | run the relay in the foreground |
| `remote-claw worker [NAME] [--permission-mode M]` | launch the worker pointed at the relay |
| `remote-claw up [NAME] [--permission-mode M]` | relay (bg) + worker (TUI), one shot |
| `remote-claw stop` | stop the background relay + workers |
| `remote-claw test` | run the automated end-to-end test |

`--permission-mode` ∈ `default · acceptEdits · plan · bypassPermissions`.
Ports: `--proxy-port` (8888), `--client-port` (9100).

## Testing

```bash
./remote-claw test     # automated round-trip: worker ↔ our relay ↔ our client
```
See [`TEST_PLAN.md`](TEST_PLAN.md) for the full plan (automated + manual + the
permission-flow status).

## Layout

```
remote-claw            CLI wrapper (entrypoint)
relay/relay.py         the relay: MITM face (:8888) + client face (:9100) + web UI
mitm/capture-proxy.py  passive MITM logger used to reverse-engineer the protocol
mitm/certs/            generated CA + leaf for api.anthropic.com
test/e2e.py            automated end-to-end test
captures/              raw protocol captures (evidence)
ws-logger.js           early WebSocket logger (pre-pivot; kept for reference)
TEST_PLAN.md           test plan
```

## Caveats

- The relay protocol is **undocumented and version-sensitive**. If a `claude`
  upgrade breaks the handshake, re-capture with `mitm/capture-proxy.py` and diff
  against `../docs/phase0-findings.md` §4b.
- The client face has **no auth** yet — bind to localhost / forward over SSH; do
  not expose it. (Phase 2.)
- Full `can_use_tool` client-side approval isn't exercised yet (see TEST_PLAN §3);
  use `--permission-mode` meanwhile.
