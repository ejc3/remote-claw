# remote-claw (Phase 0)

Drive a real `claude --remote-control` session from **your own relay + client**:
the local TUI and your remote web client share **one synced session**, while model
inference passes straight through to the real Anthropic API.

Background and the full reverse-engineered protocol are in
[`../docs/phase0-findings.md`](../docs/phase0-findings.md).

## How it works

```
 claude --remote-control      HTTPS_PROXY      remote-claw relay (MITM of api.anthropic.com)
   (local TUI, real session) ───────────────▶  ├─ intercepts /v1/code/sessions*  ← our relay / sync brain
                                                ├─ passes /v1/messages through    ← real inference
                                                └─ client UI + API on :9100 (token-gated) ◀── browser / curl
```

Redirection is **per-process** (`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`) — no
`/etc/hosts`, no sudo, and no effect on other `claude` sessions on the box.

## Requirements

- `claude` ≥ 2.1.51 (tested **2.1.168**) logged in with a **claude.ai** account
  (`claude auth status` → `authMethod: claude.ai`). API-key / inference-only
  tokens cannot establish Remote Control.
- `python3` ≥ 3.10 + `openssl`. Runtime is **stdlib-only** (no installs).

## Quickstart

```bash
./remote-claw doctor          # check claude, openssl, certs, ports, auth
./remote-claw up mysession    # certs + relay (bg) + claude --remote-control (TUI)
# the command prints a tokenised URL; forward the port and open it:
#   ssh -L 9100:127.0.0.1:9100 <box>   →   http://127.0.0.1:9100/?token=…
./remote-claw logs            # tail the relay event flow (introspection)
./remote-claw stop            # stop the background relay + workers
```

Type in the web UI *or* the local TUI — both drive the same session.

## Commands

| Command | What it does |
| --- | --- |
| `remote-claw doctor` | environment + auth check |
| `remote-claw certs [--force]` | generate the MITM CA + leaf cert (idempotent) |
| `remote-claw relay [-v] [--expose]` | run the relay in the foreground |
| `remote-claw worker [NAME] [--permission-mode M]` | launch the worker pointed at the relay |
| `remote-claw up [NAME] [--permission-mode M] [--expose]` | relay (bg) + worker (TUI) |
| `remote-claw stop` | stop the background relay + workers |
| `remote-claw test` | run the integration tests (e2e + two-surface) |
| `remote-claw logs` | tail the relay event flow |

`--permission-mode` ∈ `default · acceptEdits · plan · bypassPermissions`.
Ports: `--proxy-port` (8888), `--client-port` (9100).

## Security

- **Auth:** the client face requires a bearer token (header, cookie, or
  `?token=`) on every `/api/*` route and the UI. The token is generated 0600 in
  `.state/client-token` (override with `REMOTE_CLAW_TOKEN`). `/healthz` is the
  only unauthenticated route.
- **Binding:** localhost by default. `--expose` binds `0.0.0.0` (still
  token-gated) and logs a warning — prefer SSH forwarding.
- **Secrets:** logs are redacted (`worker_jwt`, bearer/oauth tokens, JWTs); cert
  private keys are 0600; `.gitignore` excludes `mitm/certs/`, `captures/`,
  `.state/`.
- The relay protocol is **undocumented and version-sensitive** (pinned to
  2.1.168). If a `claude` upgrade breaks the handshake, re-capture with
  `mitm/capture-proxy.py` and diff against `../docs/phase0-findings.md` §4b.

## Two roles

- **The TUI wrapper** (`remote-claw worker`/`up` + `logs`) — for **testing &
  introspection**: run the real Claude Code TUI against the relay and watch the
  `⇢`/`⇠` wire flow.
- **Our client** (web chat UI on :9100) — the **proof that remote works**: the
  chat flow runs on top of the relay, driving the same session as the TUI.
  Verified bidirectionally by `tests/two_surface.py`.

## Development

```bash
make check             # lint (ruff if present, else byte-compile) + unit tests
make test              # fast unit tests (no claude/network)
make test-integration  # e2e + two-surface (needs claude + claude.ai auth)
make fmt               # ruff format (if installed)
```

CI (`.github/workflows/ci.yml`) runs ruff + unit tests on every push/PR;
integration tests run locally (they need a logged-in `claude`).

## Layout

```
remote-claw                CLI entrypoint (shim → remote_claw.cli)
remote_claw/               the package (stdlib only)
  config.py                Config + paths
  log.py                   logging + secret redaction
  certs.py                 CA/leaf generation (0600 keys)
  core.py                  Session / RelayCore — event bus, epochs, acks
  http_util.py             HTTP/1.1 parse + dechunk helpers
  mitm.py                  MITM proxy + relay (worker-side) endpoints
  client_api.py            client face: auth, web UI, JSON/SSE, /healthz
  server.py                orchestration: token, threads, graceful shutdown
  cli.py                   argparse CLI
tests/                     test_unit.py (unit) · e2e.py · two_surface.py
mitm/capture-proxy.py      passive MITM logger (used to reverse-engineer)
mitm/certs/                generated CA + leaf (gitignored)
captures/                  raw protocol captures (gitignored)
pyproject.toml  Makefile   packaging + dev tasks
```

## Known limitations (next)

- Tools **auto-execute** in Remote Control (no `can_use_tool` gate) — this matches
  Anthropic's real relay (verified); permission-response plumbing is present but
  RC doesn't currently trigger it. Use `--permission-mode`.
- Single relay process; no persistence across relay restarts.
- The client UI renders complete messages (the worker posts complete assistant
  events upstream, not token deltas).
