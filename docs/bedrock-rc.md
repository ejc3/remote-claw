# Bedrock inference and no-Anthropic-account mode

**Status:** maintained for one exact accountless tuple: Linux arm64, Claude Code 2.1.237,
`bedrock-mantle` in `us-east-1`, `anthropic.claude-opus-4-8`, and temporary IMDSv2 SigV4
credentials. Its tools-disabled private viewer text round-trip passed on 2026-08-31. Bedrock remains a
model-provider surface, not a collaboration adapter; this evidence does not prove provider-native
Claude coexistence or a generalized cross-agent/provider matrix.

The final account/profile-isolation boundary rerun completed at 2026-08-31T15:38:02Z.

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
- any Vercel automation bypass needed by a protected remote-claw deployment. When that bypass is set,
  `RC_APP` must pin the exact same HTTPS broker origin; it is never sent to loopback or inherited by
  Claude.

The flag is valid only with `--rc-inference=bedrock`. It creates isolated, login-shaped Claude state
with the RC feature gates needed by the intercepted private façade. It never modifies the user's real
Claude config and does not provide a usable Anthropic credential.

## Current paths

| Agent adapter | Bedrock surface | Current claim |
| --- | --- | --- |
| Claude MITM | `bedrock-mantle` Messages API | Maintained for the exact accountless tuple above, including inference translation, control-plane synthesis, and private viewer round-trip; other versions, platforms, regions, models, and credential sources need their own gate |
| Claude tmux | Native Claude Bedrock configuration | M4 supported only for exact Claude 2.1.237/Linux arm64 with `global.anthropic.claude-sonnet-4-6` in `us-west-1`; lower-fidelity transcript/pane semantics, native/local permissions, and no provider-native/official-client claim |
| OpenCode | OpenCode `amazon-bedrock` provider | Supported only for the exact pinned M2 tuple; other models, regions, versions, platforms, and capabilities require separate gates. See [OpenCode driver](opencode-driver.md) |
| Codex | None advertised | Requires a separately tested provider route before any support claim |

The 2026-06-28 runs observed one real viewer prompt and model response for each of the first three
rows. The later 2026-08-31 M4 run graduated only the exact Claude-tmux tuple stated above, including
two browsers, reload, native/local permission ownership, and broker-loss isolation. The 2026-08-31 M5
gate refreshed only the exact Claude MITM/accountless tuple named above. The remaining observations
are pinned evidence, not a permanent provider/version/region support matrix.

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

AWS credentials are not copied into the Claude child environment, broker, browser, or normal
diagnostics. `AWS_EC2_METADATA_DISABLED=true` also disables metadata discovery in conforming child
SDKs. This is not a network sandbox: a process sharing the host network can address IMDS directly, so
accountless mode does not claim hostile-child isolation from the instance role. Use trusted local
Claude/tool code or add an independently maintained host network sandbox when that is part of the
deployment threat model. The isolated accountless state receives only fabricated login-shaped data and
the required local gates.

Exact Claude 2.1.237 also has credential routes outside `CLAUDE_CONFIG_DIR`. Accountless launch binds
`CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, and `ANTHROPIC_CONFIG_DIR` to the same owned
temporary root; removes inherited `CCR_OAUTH_TOKEN_FILE` and managed/remote-settings path overrides;
and fails closed if any of the three fixed CCR-host files under `/home/claude/.claude/remote` exists or
cannot be checked. Because safe mode still applies administrator policy, accountless also fails closed
when `/etc/claude-code/managed-settings.json` or `managed-settings.d` is present instead of bypassing or
parsing it. The maintained smoke's fresh empty working directory separately excludes project settings.

Claude 2.1.237 also requires a recognized human `client_platform` on incoming Remote Control user
events. After the sealed relay authenticates a private-viewer command, the local facade labels that
native event with Claude's `web_claude_ai` wire class. This is an ingress compatibility discriminator;
it does not mean Anthropic hosts or authenticates the private session.

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

The maintained accountless gate is:

~~~bash
RC_CLAUDE_BIN=/absolute/path/to/claude-2.1.237 \
  pnpm --filter @remote-claw/web run test:bedrock-accountless
~~~

It rejects any tuple other than Linux arm64, exact Claude 2.1.237, `us-east-1`,
`anthropic.claude-opus-4-8`, and temporary IMDSv2 SigV4. It creates a fresh empty mode-0700 working
directory, lets `runRcLaunch` create its isolated accountless config, verifies the child environment
receives no usable Anthropic auth variable, alternate API base, custom authorization header, inherited
settings override, or AWS credential variable, verifies that all three account/profile roots are
isolated, and
completes one real viewer-client prompt and response with tools disabled.
It exercises the browser's viewer protocol without claiming a literal browser or official-client run.
It does not modify the user's Claude config or preapprove an external repository. A deterministic MITM
test also makes the Anthropic upstream transport a hard failure while exercising Bedrock inference,
synthesized control-plane traffic, and local RC registration.

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
beside the Claude RC adapter and the maintained smoke in
`apps/web/test/smoke/real-claude.smoke.test.ts`. Historical discovery scripts were removed from the
maintained tree; Git history retains them. Current CLI help, tests, and the credentialed live smoke—not
the old spike—define the supported behavior.
