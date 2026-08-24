# Bedrock inference and no-Anthropic-account mode

**Status:** implemented experimental inference route, live round-trip observed on 2026-06-28. Bedrock
is an intended model-provider surface. The existing evidence covers the private replacement relay; it
does not prove provider-native Claude coexistence or a supported cross-agent matrix.

## Product meaning

Inference routing is separate from collaboration:

```text
Claude/OpenCode adapter ⇄ remote-claw collaboration
          │
          └── model inference → Anthropic or Amazon Bedrock
```

`--rc-inference=bedrock` makes the Claude MITM translate inference to Bedrock while retaining the local
private RC façade and encrypted browser relay. The official Claude client cannot join that façade for
the same reason it cannot join ordinary `--rc-app`: Anthropic does not host that RC session.

`--rc-accountless` means **no Anthropic account**. It does not mean no identity, account, or credential
anywhere. A run still requires:

- AWS credentials or a Bedrock API key with model access;
- a remote-claw machine identity and viewer pass; and
- any Vercel automation bypass needed by a protected remote-claw deployment.

The flag is valid only with `--rc-inference=bedrock`. It creates isolated, login-shaped Claude state
with the RC feature gates needed by the intercepted private façade. It never modifies the user's real
Claude config and does not provide a usable Anthropic credential.

## Current paths

| Agent adapter | Bedrock surface | Current claim |
| --- | --- | --- |
| Claude MITM | `bedrock-mantle` Messages API | Implemented inference translation, control-plane synthesis, and private viewer round-trip |
| Claude tmux | Native Claude Bedrock configuration | Experimental transcript/pane fallback; no structured RC or official-client semantics |
| OpenCode | OpenCode `amazon-bedrock` provider | Experimental native HTTP/SSE adapter with the limits in [OpenCode driver](opencode-driver.md) |
| Codex | None advertised | Requires a separately tested provider route before any support claim |

The 2026-06-28 runs observed one real viewer prompt and model response for each of the first three
rows. They are pinned observations, not a permanent provider/version/region support matrix.

## CLI surface

```bash
remote-claw --rc-app "$RC_APP" \
  --rc-inference=bedrock \
  --rc-bedrock-region us-east-1 \
  --rc-bedrock-model anthropic.claude-opus-4-8 \
  --rc-accountless \
  --remote-control
```

- `--rc-inference=anthropic` is the default passthrough route.
- `--rc-bedrock-region` selects the AWS region, with the documented AWS environment fallback.
- `--rc-bedrock-model` overrides the model mapping.
- `RC_BEDROCK_STRIP_KEYS` adds model-specific rejected body fields to the scrub set.

AWS credentials stay in the host environment and are not copied to the Claude child, broker, browser,
or normal diagnostics. The isolated accountless state receives only fabricated login-shaped data and
the required local gates.

## Translation boundary

In Bedrock mode the loopback MITM:

1. continues to serve Claude's private RC endpoints locally;
2. synthesizes the small Anthropic control-plane subset Claude requires for startup;
3. rewrites `/v1/messages` and token-count requests to the configured Bedrock endpoint;
4. removes request fields the selected Bedrock API rejects;
5. authenticates with the configured Bedrock credential; and
6. converts the response stream back to the Anthropic shape expected by Claude.

The inference choice does not change `clawsec`, broker authentication, viewer passes, or adapter
readiness. A session is not published until its exact native identity and adapter prerequisites are
ready; cancellation prevents a late publish.

## Observed account gate

Claude's native Remote Control UI expects login-shaped claude.ai state. Merely setting an
`ANTHROPIC_API_KEY` selects API-key mode and disables that feature. In the private MITM topology the
accountless launcher supplies isolated synthetic state and the observed RC gates, while the proxy
intercepts all RC/control traffic and Bedrock performs inference. No real Anthropic account or token
is required for that topology.

This does **not** create access to Anthropic-hosted Remote Control. Official Claude web/mobile access
requires a real Anthropic-hosted session and therefore belongs to the native-Claude coexistence
milestone, not the accountless private façade.

## Safety and release gates

Before advertising one agent/model/region combination:

- run a credentialed prompt round-trip against the exact provider route;
- exercise tool use and thinking if those capabilities are advertised;
- verify strict request scrubbing and body limits for the selected model;
- verify no Anthropic connection or credential is used when the claim says no Anthropic account/API;
- inspect bounded logs and broker records for provider credentials and plaintext; and
- run the adapter's collaboration acceptance independently of the inference smoke.

An AWS acceptance response is not proof that the native agent applied, ordered, or displayed an
action. Ambiguous native writes retain the adapter's conservative unknown-outcome policy.

Known compatibility risks include per-model body validation, region-specific inference-profile IDs,
native-versus-runtime Bedrock endpoint differences, token-count behavior, response extras, and model
availability. Track these as a small tested matrix rather than a generalized provider façade.

## Source of truth

Implementation and tests live under `packages/cli/src/host/rc/bedrock/`, with launch/accountless wiring
beside the Claude RC adapter. Historical discovery scripts were removed from the maintained tree; Git
history retains them. Current CLI help, tests, and a credentialed live smoke—not the old spike—define
the supported behavior.
