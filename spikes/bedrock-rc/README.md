# Spike: Bedrock-backed Remote Control (zero Anthropic API)

Reproducible evidence for `docs/bedrock-rc.md` — proving the real `claude` TUI can run native
`/remote-control` with **zero** `api.anthropic.com` traffic while inference is served by a
non-Anthropic backend (Amazon Bedrock). Standalone Node scripts, no repo deps, not part of the gate
(this dir has no `package.json`, so it is not a workspace member).

## Files

- **`impersonator-mitm.mjs`** — a MITM that TLS-terminates `api.anthropic.com` and **never connects to
  it**. Synthesizes every control-plane response (`/api/claude_cli/bootstrap`, mcp registry,
  penguin_mode, telemetry, and a default `{}` 200 for anything unrecognized) and serves `/v1/messages`
  from a local canned backend that emits a known word (`BEDROCKECHO`). This stands in for the real
  Bedrock translator: if claude prints the canned word, the Anthropic side is fully fabricated.
- **`discover-mitm.mjs`** — a pass-through logging MITM used once to inventory exactly which
  `api.anthropic.com` endpoints claude calls at startup/inference (auth headers redacted). Hits real
  Anthropic; only needed to regenerate the endpoint inventory.
- **`bedrock-translate.mjs`** — the zero-dep translation core: Anthropic `/v1/messages` body → Bedrock
  `InvokeModelWithResponseStream` request reshape (drop `model`/`stream`, set `anthropic_version`,
  strip Bedrock-rejected `anthropic-beta`s, map model→inference-profile), plus an incremental
  `vnd.amazon.eventstream` decoder and Bedrock-chunk → Anthropic-SSE re-emit.
- **`bedrock-translate.test.mjs`** — round-trips captured Anthropic event shapes through synthetic
  Bedrock framing (fed in 7-byte slices to exercise partial frames), asserting byte-faithful SSE, plus
  request-reshape / model-map / beta-filter checks. Run: `node bedrock-translate.test.mjs`.
- **`EVIDENCE.md`** — the two live `claude` trials (logged-in OAuth, and pretend `sk-ant-` key with no
  login) that both printed `BEDROCKECHO` with zero real Anthropic traffic.

## Reproduce the live "zero-Anthropic" proof

```sh
# 1. start the impersonator (prints its port + CA path)
node impersonator-mitm.mjs &
P=$(cat /tmp/.../imp/port); CA=$(cat /tmp/.../imp/ca-path)   # paths printed on start

# 2a. pretend-API-key path (no Anthropic account):
env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID \
    CLAUDE_CONFIG_DIR=$(mktemp -d) ANTHROPIC_API_KEY=sk-ant-PRETEND \
    HTTPS_PROXY=http://127.0.0.1:$P https_proxy=http://127.0.0.1:$P NODE_EXTRA_CA_CERTS=$CA \
    claude --print --dangerously-skip-permissions "Reply with one word: PINEAPPLE"
# → prints BEDROCKECHO (claude ran entirely off the impersonator; the CONFIG_DIR has no credentials)
```

The only step not reproducible here is a **live** Bedrock call (needs AWS creds + model access); the
translation core is proven offline by the self-test.
