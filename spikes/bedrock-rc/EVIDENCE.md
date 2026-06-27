# Feasibility evidence — zero-Anthropic RC + non-Anthropic inference

Two live trials of the REAL `claude` 2.1.195 behind an "impersonator MITM" that NEVER connects to
api.anthropic.com (it TLS-terminates the host, synthesizes all control-plane responses, and serves
`/v1/messages` from a local canned backend that emits a known word `BEDROCKECHO`).

## Trial A — existing logged-in OAuth (claudeAiOauth)
Result: claude printed **BEDROCKECHO**. Calls served (all synthesized, zero upstream):
  POST /api/eval/sdk-*           (telemetry → {})
  GET  /api/claude_code_penguin_mode
  GET  /v1/mcp_servers           ({data:[]})
  GET  /api/claude_cli/bootstrap (synthetic oauth_account/org)
  GET  /mcp-registry/v0/servers
  POST /v1/messages              (canned SSE → BEDROCKECHO)
  POST /api/event_logging/v2/batch

## Trial B — NO login, pretend ANTHROPIC_API_KEY=sk-ant-...PRETEND..., isolated CLAUDE_CONFIG_DIR
Result: claude printed **BEDROCKECHO**. API-key mode hits a DIFFERENT control-plane set, all absorbed
by the impersonator's default `{}` 200-stub:
  POST /api/eval/sdk-*
  GET  /api/claude_code/policy_limits   (x4)
  GET  /api/claude_code/settings
  POST /v1/messages                     (warmup/title)
  GET  /api/claude_cli/bootstrap
  GET  /api/claude_code_penguin_mode
  GET  /mcp-registry/v0/servers
  POST /v1/messages                     (real prompt → BEDROCKECHO)
  GET  /api/claude_code/organizations/metrics_enabled
  POST /api/event_logging/v2/batch

## Conclusion
claude is fully satisfied by a 100%-synthesized Anthropic control plane + a non-Anthropic inference
backend, in BOTH auth modes. The "200-stub everything unknown" default is robust to the API-key path's
extra endpoints. Only `/v1/messages` (+ count_tokens) carry real semantics → translate to Bedrock.
RC channel (`/v1/code/sessions/*`) is already self-served by the existing relay (proven separately).
