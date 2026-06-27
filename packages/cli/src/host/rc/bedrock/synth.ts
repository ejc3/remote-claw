// Synthesized Anthropic control-plane responses for the zero-Anthropic Bedrock mode. claude makes a
// handful of startup calls to api.anthropic.com (bootstrap, mcp registry, feature flags, telemetry);
// in bedrock mode the MITM serves them locally so NOTHING reaches Anthropic. Only `/v1/messages*`
// carries real semantics (→ Bedrock); everything else here is an empty success or a static flag.
// Captured shapes from a real `claude --print` run (see docs/bedrock-rc.md); identity is synthetic.

export interface SynthResponse {
  status: number;
  json: unknown;
}

/** A synthetic bootstrap: claude reads `oauth_account` (org/identity) + model options + flags. The
 *  account/org are fabricated — no real Anthropic identity is implied. */
const BOOTSTRAP: unknown = {
  client_data: {},
  additional_model_options: [],
  additional_model_costs: null,
  oauth_account: {
    account_uuid: "00000000-0000-0000-0000-000000000000",
    account_email: "bedrock-user@example.com",
    organization_uuid: "11111111-1111-1111-1111-111111111111",
    organization_name: "Bedrock Org",
    organization_type: "claude_max",
    organization_rate_limit_tier: "default_claude_max_20x",
    user_rate_limit_tier: null,
    seat_tier: null,
  },
  model_access: null,
  org_model_default: null,
  cwk_cfg_key: null,
  auto_compact_windows: null,
};

/** True if a path is real inference traffic the caller must route to Bedrock (NOT synthesize). */
export function isInferencePath(path: string): boolean {
  return path === "/v1/messages" || path === "/v1/messages/count_tokens";
}

/**
 * The synthesized response for a control-plane request, or `null` if the path is inference traffic
 * (route to Bedrock) — callers check `isInferencePath` first. Unknown api.anthropic.com paths fall to
 * a `{}` 200 so nothing leaks upstream (proven robust to the API-key-mode endpoint set).
 */
export function synthControlPlane(method: string, path: string): SynthResponse | null {
  if (isInferencePath(path)) return null;
  if (path === "/api/claude_cli/bootstrap") return { status: 200, json: BOOTSTRAP };
  if (path === "/api/claude_code_penguin_mode") {
    return { status: 200, json: { enabled: false, disabled_reason: null } };
  }
  if (path === "/v1/mcp_servers") return { status: 200, json: { data: [] } };
  if (path.startsWith("/mcp-registry/")) return { status: 200, json: { servers: [] } };
  if (path === "/v1/models") {
    return {
      status: 200,
      json: {
        data: [{ type: "model", id: "claude-opus-4-8", display_name: "Claude Opus" }],
        has_more: false,
      },
    };
  }
  // Telemetry + everything else: empty success. (method is accepted for symmetry / future use.)
  void method;
  return { status: 200, json: {} };
}
