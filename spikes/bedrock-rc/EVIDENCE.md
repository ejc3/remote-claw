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

## Live Bedrock access probe (2026-06-27) — `try-mantle.mjs`

SigV4-signed (instance role `dev-server-role`, acct 928413605543, with session token) requests to the
NATIVE `bedrock-mantle.<region>.api.aws/anthropic/v1/messages` endpoint, model `claude-opus-4-8`:

- **Transport + auth PROVEN.** Requests authenticated and reached Bedrock; the endpoint replied in
  **native Anthropic error format** (`{"type":"error","error":{"type":"permission_error",...}}`) — a
  signature failure would look different. So the MITM→mantle signing path works against the live service,
  and mantle genuinely speaks the Anthropic wire format.
- **Mantle is live** in us-east-1 / us-west-2 / us-east-2 (us-west-1 → DNS NXDOMAIN: no mantle there).
- **One IAM action is missing:** every Claude region returns 403 `bedrock-mantle:CreateInference ... no
  identity-based policy allows the bedrock-mantle:CreateInference action` on
  `arn:aws:bedrock-mantle:<region>:928413605543:project/default`. The binary `bedrock:InvokeModel` path
  is likewise denied outside us-west-1, and us-west-1 hosts no Claude models (every id → invalid
  identifier).

**To unblock live inference:** grant the role `bedrock-mantle:CreateInference` (+ `bedrock-mantle:
CountTokens`) on the `project/default` ARN in a Claude region (us-east-1 or us-west-2) and enable Bedrock
model access for the Claude models there — OR provide a Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`). The
moment that lands, `node try-mantle.mjs` returns a real completion and the full RC round-trip can run.
