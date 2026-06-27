# Bedrock-backed Remote Control — drive the real claude TUI with **zero Anthropic API**, all inference on Bedrock

**Status:** **implemented** as `--rc-inference=bedrock` and proven end-to-end against the real `claude`
+ live Bedrock (2026-06-27). The native `bedrock-mantle` path, the SigV4/bearer auth, the control-plane
synthesis, and the launch wiring are built and unit-tested (CLI suite green). A real `claude --print`
through `--rc-inference=bedrock` translated `/v1/messages` (model `claude-opus-4-8` →
`anthropic.claude-opus-4-8`), SigV4-signed it, reached the live mantle endpoint, and claude surfaced
the Bedrock reply as an Anthropic API response — with **zero api.anthropic.com traffic**. The only
remaining gate for a *successful* completion (not a 403) is the `bedrock-mantle:CreateInference` IAM
grant (see Credentials).

## The goal (verbatim ask)

> "I want zero Anthropic API in the mix but `/remote-control` to the TUI works … mimic a successful
> round-trip with Anthropic servers but still have all inference go to Bedrock … and launch with a
> pretend Anthropic API key too (if we didn't have a local logged-in session)."

A Bedrock-only shop has **no Anthropic account**. Native `claude --remote-control` is Anthropic-API
only — it is **disabled** the moment `CLAUDE_CODE_USE_BEDROCK=1` puts claude into Bedrock-transport
mode (verified: the string `CLAUDE_CODE_USE_BEDROCK` gates the provider path; RC registers against
`api.anthropic.com/v1/code/sessions`, which the Bedrock transport never reaches). So those users
cannot use the native phone/TUI Remote Control at all — today their only option is the provider-
agnostic **tmux driver** (`--rc-driver=tmux`), which is a *reconstruction*, not the native RC spine.

This design keeps the **native RC protocol** by never tripping the gate: run claude in ordinary
**first-party Anthropic mode** (RC always enabled there) behind remote-claw's existing MITM, and have
the MITM **fully fabricate the Anthropic side** — auth/bootstrap/telemetry synthesized locally, and
`/v1/messages` **translated to Amazon Bedrock**. claude believes it completed a normal Anthropic
round-trip; not a byte reaches `api.anthropic.com`.

## Why this is the right altitude

remote-claw **already** runs the real `claude` in first-party mode behind a local MITM
(`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`), self-serves the RC endpoints from its `RelayCore`, and today
*passes through* everything else (`/v1/messages`, OAuth, telemetry) to the real upstream
(`packages/cli/src/host/rc/mitm.ts:#passthrough`). The entire delta for "zero Anthropic + Bedrock" is
**one branch**: replace that passthrough with (a) a synthesizer for control-plane calls and (b) a
Bedrock translator for `/v1/messages`. No change to the relay, the broker, the viewer, the session
seam, or the RC wire protocol. The RC spine that already works keeps working — we only swap what sits
*behind* the proxy from "real Anthropic" to "synth + Bedrock."

## Proven feasibility (live spike, 2026-06-27)

An "impersonator MITM" (`scratchpad/impersonator-mitm.mjs`) that **never connects to
api.anthropic.com** — it TLS-terminates the host, synthesizes every control-plane response, and serves
`/v1/messages` from a local canned backend emitting a known word `BEDROCKECHO`. The real
`claude` 2.1.195 was run through it twice:

- **Trial A — existing logged-in OAuth (`claudeAiOauth`).** claude printed `BEDROCKECHO`. Served (all
  fabricated, zero upstream): `POST /api/eval/sdk-*`, `GET /api/claude_code_penguin_mode`,
  `GET /v1/mcp_servers`, `GET /api/claude_cli/bootstrap`, `GET /mcp-registry/v0/servers`,
  `POST /v1/messages`, `POST /api/event_logging/v2/batch`.
- **Trial B — NO login, pretend `ANTHROPIC_API_KEY=sk-ant-…PRETEND…`, isolated `CLAUDE_CONFIG_DIR`.**
  claude printed `BEDROCKECHO`. API-key mode hits a *different* control-plane set —
  `GET /api/claude_code/policy_limits` (×4), `/api/claude_code/settings`,
  `/api/claude_code/organizations/metrics_enabled` — every one absorbed by the impersonator's default
  `{}` 200-stub.

**Conclusion:** claude is fully satisfied by a 100%-synthesized control plane plus a non-Anthropic
inference backend, in **both** auth modes, with no real Anthropic traffic. The "200-stub everything
unrecognized" default is robust to endpoints we didn't anticipate. Only `/v1/messages` (and
`/v1/messages/count_tokens`) carry real semantics that must be translated. (Evidence:
`scratchpad/EVIDENCE.md`.)

**Translation half — also proven (offline).** A zero-dep translation core
(`scratchpad/bedrock-translate.mjs`) reshapes claude's `/v1/messages` body for Bedrock
(`InvokeModelWithResponseStream`), strips the `anthropic-beta` features Bedrock rejects, and
decodes the AWS `vnd.amazon.eventstream` framing back into Anthropic SSE. Its self-test round-trips the
**8 real captured Anthropic events** from the discovery run through synthetic Bedrock framing — fed to
the decoder in deliberately awkward 7-byte slices to exercise partial-frame handling — and asserts the
re-emitted SSE is byte-faithful (event types, order, and JSON payloads identical). All four checks
pass. The one piece still unproven is a **live** Bedrock call, which is gated only on AWS creds (this
box has none), not on any unknown.

## The two auth launch modes

claude only needs to *believe* it is authenticated; the MITM validates nothing.

1. **Pretend API key (the Bedrock-only path — no Anthropic account).** Launch with
   `ANTHROPIC_API_KEY=sk-ant-<anything>` and an isolated `CLAUDE_CONFIG_DIR` that has **no**
   `.credentials.json` (so there is no OAuth to prefer) and a seeded `.claude.json`
   (`hasCompletedOnboarding:true`) so `--print`/headless start doesn't drop into onboarding. claude
   runs in `x-api-key` mode; the MITM ignores the key. *Proven (Trial B).*
2. **Existing OAuth session.** If the user happens to have a logged-in `claudeAiOauth`, that also works
   unchanged — but it is **not required** and the token is never used against Anthropic (the MITM
   serves bootstrap/inference locally). The wrapper can also write a **synthetic** far-future
   `.credentials.json` so claude never attempts an OAuth token refresh. *Proven (Trial A).*

Recommended default for the wrapper: **synthesize a pretend API key** (mode 1) so the feature needs
no Anthropic account whatsoever, and `unset`/override any inherited real creds for the child.

## Control-plane endpoints to synthesize (zero-Anthropic inventory)

Captured from a real first-party `claude --print` run (`scratchpad/discover/calls.jsonl`) plus the
API-key-mode trial. The MITM serves these locally; **any unrecognized `api.anthropic.com` path
defaults to `{}` 200** so nothing falls through to the real upstream.

| path | method | synthesized response | load-bearing? |
|---|---|---|---|
| `/api/claude_cli/bootstrap` | GET | `{oauth_account:{account_uuid,organization_uuid,organization_type:"claude_max",…}, additional_model_options:[], …}` | **yes** — account/org identity + model gating |
| `/v1/messages` | POST (SSE) | **translate → Bedrock** (see below) | **yes** — inference |
| `/v1/messages/count_tokens` | POST | `{input_tokens:N}` (estimate, or Bedrock count) | soft |
| `/api/claude_code_penguin_mode` | GET | `{enabled:false,disabled_reason:null}` | soft (feature flag) |
| `/v1/mcp_servers` | GET | `{data:[]}` | soft |
| `/mcp-registry/v0/servers` | GET | `{servers:[]}` | soft |
| `/v1/models` | GET | `{data:[{type:"model",id:"claude-opus-4-8",…}],has_more:false}` | soft |
| `/api/claude_code/policy_limits` `/settings` `/organizations/metrics_enabled` | GET | `{}` (API-key mode) | soft |
| `/api/eval/*`, `/api/event_logging/v2/batch`, `/v1/traces`, `/v1/logs` | POST | `{}` (drop telemetry) | no |
| **any other** `api.anthropic.com/*` | * | `{}` 200 (logged) | fail-safe |

`bootstrap` is the only response whose *shape* matters; everything else is an empty success or a flag.
The real `oauth_account` is replaced with synthetic UUIDs/org so no real identity is implied.

## Inference translation — `/v1/messages` → Amazon Bedrock

claude sends a **standard Anthropic Messages API** request (captured shape):
`{model:"claude-opus-4-8", messages:[…], system, tools, max_tokens, stream:true, …}` with
`anthropic-version: 2023-06-01` and a long `anthropic-beta` header; the streamed response is the
standard event sequence (`message_start` → `content_block_*` → `message_delta` → `message_stop`, with
`ping`s). There are **two** Bedrock paths to serve that, split by model generation:

### Primary — native `bedrock-mantle` (SSE passthrough, the easy path)

Bedrock exposes a **native Anthropic Messages endpoint** that speaks the *exact* api.anthropic.com wire
format: `POST https://bedrock-mantle.<region>.api.aws/anthropic/v1/messages`, **standard `text/event-
stream` SSE**, body keeps a top-level `model` and `stream:true`, `anthropic-version: 2023-06-01` as a
**header** (which claude already sends). The newest Claude models — **including `claude-opus-4-8` (what
this box runs)**, opus-4-7, haiku-4-5, fable-5 — are on this path. So the MITM does almost nothing:

1. Rewrite host→`bedrock-mantle.<region>.api.aws`, path→`/anthropic/v1/messages`.
2. Rewrite the body's `model` → the Bedrock id (e.g. `claude-opus-4-8` → `anthropic.claude-opus-4-8`).
3. Swap auth: drop claude's `Authorization`/`x-api-key`; add `x-api-key: $AWS_BEARER_TOKEN_BEDROCK`
   (Bedrock API key — **zero AWS SDK, zero SigV4**) *or* SigV4-sign for service **`bedrock-mantle`**.
4. **Scrub body fields Bedrock rejects** — Bedrock validates strictly and 400s on unknown keys
   (`"Extra inputs are not permitted"`). claude's request carries ~13 `anthropic-beta`s and possibly
   `metadata`/`output_config`/`effort`/`context-management` that the target model may not accept →
   keep a per-model allowlist, strip the rest.
5. **Pipe the SSE straight back** to claude — no decode, no reconstruction.

This is the recommended default: a thin reverse-proxy of `/v1/messages` with a body scrub and an auth
swap. The only real engineering is step 4 (the scrub) and the model-id map (step 2).

### Fallback — binary `InvokeModelWithResponseStream` (older / CRIS-only models)

For models without a native-SSE route: `POST bedrock-runtime.<region>.amazonaws.com/model/<profile>/
invoke-with-response-stream`, SigV4 service `bedrock`. Drop top-level `model`+`stream`, set
`anthropic_version:"bedrock-2023-05-31"` in the **body**, map model → a regional **inference-profile**
id (`us.`/`eu.`/`au.`/`jp.`/`global.` — Claude 4/3.7/3.5 ids are profile-only, a bare id 400s). The
response is AWS `vnd.amazon.eventstream` **binary** framing wrapping `{"bytes":<base64 Anthropic
event>}`; decode the frames, re-emit each event as `event: <type>\ndata: <json>\n\n`, **strip the
`amazon-bedrock-invocationMetrics` chunk** (it has crashed naive consumers), and optionally rewrite the
`msg_bdrk_`/`toolu_bdrk_` id prefixes back to `msg_`/`toolu_`. The zero-dep transcoder for this path is
proven in `spikes/bedrock-rc/bedrock-translate.mjs` (round-trips real captured events under chunked
input). Or use `@anthropic-ai/bedrock-sdk` (SigV4 + decode for you; you still own the model map + the
strip/rewrite), behind a dynamic `import()` so AWS deps stay out of the default bundle.

See Appendix A for the cited request/response facts for both paths.

## Credentials & config the host needs

- **Simplest: a Bedrock API key.** `AWS_BEARER_TOKEN_BEDROCK=<key>` → the MITM forwards `/v1/messages`
  to `bedrock-mantle` with `Authorization: Bearer`/`x-api-key`, **no AWS SDK, no SigV4**. One env var on
  the host. This is the recommended default for the wrapper.
- **Or the standard AWS chain** (for SigV4 / IAM shops): `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
  (+`AWS_SESSION_TOKEN`), `AWS_REGION`, `~/.aws` profile, SSO, or IMDS role — `@anthropic-ai/bedrock-sdk`
  and `aws4` both resolve these. **Proven against the live endpoint** (`spikes/bedrock-rc/try-mantle.mjs`,
  2026-06-27): SigV4-signing `bedrock-mantle/anthropic/v1/messages` with this box's IMDS instance-role
  creds authenticates and reaches Bedrock, which replies in **native Anthropic error format** — so the
  MITM→mantle transport works. The remaining gap is **one IAM action**: the role lacks
  `bedrock-mantle:CreateInference` on `arn:aws:bedrock-mantle:<region>:<acct>:project/default` in every
  Claude region (and `bedrock:InvokeModel` is allowed only in us-west-1, which hosts no Claude models).
  Granting that action (+ `CountTokens`) in us-east-1/us-west-2 with model access enabled — or a Bedrock
  API key — unblocks live inference; the translation logic is testable offline regardless.
- The host already holds these and **never exposes them to the child claude** — same trust boundary as
  the broker bypass secret (`launch.ts` scrubs host-only secrets from the child env). claude only ever
  talks to the local MITM.

## Wiring into the CLI (proposed)

A new launch mode parallel to `runRcLaunch`, selected by a flag — e.g.
`remote-claw --rc-app <origin> --rc-inference=bedrock [--rc-bedrock-region us-west-1]`
(default `--rc-inference=anthropic` = today's passthrough). Concretely:

1. `MitmOptions` gains an `inference: "anthropic" | "bedrock"` (default `anthropic`) and an optional
   model-map/region. In `#passthrough`, when `inference==="bedrock"`: route `/v1/messages*` to the
   Bedrock translator; serve the control-plane synthesizers; default-stub the rest. RC intercept
   (`INTERCEPT_PREFIXES`) is unchanged.
2. `launch.ts`: in bedrock mode, **do not** set `CLAUDE_CODE_USE_BEDROCK` (that would disable RC);
   instead inject the pretend `ANTHROPIC_API_KEY` + isolated `CLAUDE_CONFIG_DIR` for the child (mode 1
   above), and keep AWS creds in the *host* env only (never the child).
3. Everything downstream — `RelayCore`, `HostRcRelay`, `bridgeSession`, the broker, the viewer — is
   untouched. The viewer drives the native RC TUI exactly as today.

## Risks / open questions

- **Body scrub vs strict validation (the main one).** Bedrock 400s on unrecognized fields. claude's
  `/v1/messages` carries ~13 `anthropic-beta`s and possibly `metadata`/`output_config`/`effort`/
  `context-management`/manual `thinking` the target model may reject. Mitigation: a per-model allowlist;
  strip the rest. Some capabilities (1M context, extended caching, effort) may be unavailable on Bedrock
  — document the degradation. **Needs a live probe to pin the exact accepted set per model.**
- **Model-id map.** Native `bedrock-mantle` keeps a top-level `model` (just rewrite the id). The binary
  fallback needs a region-aware **inference-profile** map (`us.`/`eu.`/`au.`/`jp.`/`global.`; Claude
  4/3.7/3.5 ids are profile-only). No SDK ships the table.
- **Two-endpoint routing.** Current models → native SSE (`bedrock-mantle`); older/CRIS-only → binary
  `InvokeModel`. Confirm each target model's path + regional availability from its AWS model card.
- **Binary-path-only quirks** (don't apply to the native path): strip `amazon-bedrock-invocationMetrics`
  (has crashed naive consumers); `msg_bdrk_`/`toolu_bdrk_` id prefixes — rewrite only if the CLI
  validates the `msg_` shape (open question; test live).
- **count_tokens.** Native path forwards to `…/anthropic/v1/messages/count_tokens`; binary path wraps
  `CountTokens`. Low stakes (drives the context meter) — can estimate locally.
- **Tool use / thinking blocks end-to-end** weren't exercised by the canned spike — validate a real
  Bedrock tool-use + extended-thinking turn round-trips through RC to the viewer before shipping.
- **Body-size caps.** InvokeModel 25M chars; Bedrock guide cites 20 MB — reconcile before forwarding
  large attachments.

## Next steps

1. **Native-path first** (covers `claude-opus-4-8`): a thin `/v1/messages` reverse-proxy to
   `bedrock-mantle` — model rewrite + `AWS_BEARER_TOKEN_BEDROCK` auth swap + body scrub + SSE
   passthrough. Smallest correct implementation; no AWS SDK.
2. Binary-path fallback (`bedrock-translate.ts`: reshape + beta allowlist + event-stream→SSE) for
   models without native SSE — the proven spike code promotes to a real module + vitest.
3. Add `--rc-inference=bedrock` wiring (flag, MITM branch, child-env injection: pretend `sk-ant-` key +
   isolated config) behind the per-PR gate (biome + tsc + vitest → /code-review + codex → CI green).
4. Live validation with a real Bedrock key: a prompt, a tool-use turn, and extended thinking round-trip
   through native RC to the viewer with **zero** `api.anthropic.com` traffic (assert via a connection
   counter in the MITM).

---

## Appendix A — Bedrock request/response facts (cited)

Gathered from official AWS + Anthropic docs and the `@anthropic-ai/bedrock-sdk` source (research pass,
2026-06-27). The binary-path transcode is additionally **validated by an offline synthetic round-trip**
against real captured Anthropic events (`spikes/bedrock-rc/bedrock-translate.test.mjs`). Nothing here is
yet validated against a **live** Bedrock response — that is the AWS-creds-gated step.

**Two endpoints, split by model generation:**

- **(b) Native Anthropic Messages — `bedrock-mantle` (use this for current models).**
  `POST https://bedrock-mantle.<region>.api.aws/anthropic/v1/messages`, **standard `text/event-stream`
  SSE in the api.anthropic.com format**, body is Anthropic-shaped *with* top-level `model` and
  `"stream": true`, `anthropic-version: 2023-06-01` as a header. Auth: Bedrock API key (`x-api-key` /
  `Authorization: Bearer`) **or** SigV4 service `bedrock-mantle`. Supported model ids per the Anthropic
  table include `anthropic.claude-opus-4-8`, `…-opus-4-7`, `…-haiku-4-5`, `…-fable-5`,
  `…-mythos-preview`. Sources: AWS *Inference using Anthropic Messages API*
  (`bedrock/latest/userguide/inference-messages-api.html`); Anthropic *Claude in Amazon Bedrock*
  (`platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock`) — "this endpoint uses
  standard SSE streaming and the same request body shape as Anthropic's first-party API"; AWS What's-New
  on the `bedrock-mantle` endpoint (2026-06).
- **(a) Binary `InvokeModelWithResponseStream` (fallback, older/CRIS-only models).**
  `POST https://bedrock-runtime.<region>.amazonaws.com/model/<modelId>/invoke-with-response-stream`,
  SigV4 service `bedrock`, `Content-Type: application/json`. Body = Anthropic Messages **without**
  top-level `model`/`stream`, **with** `"anthropic_version": "bedrock-2023-05-31"`. Response is always
  `application/vnd.amazon.eventstream`. Sources: `API_runtime_InvokeModelWithResponseStream.html`;
  `model-parameters-anthropic-claude-messages-request-response.html`.

**Event-stream framing (path a).** Prelude `[total_len u32][headers_len u32][prelude_crc u32]` (CRC32 of
the 8 prelude bytes) → headers (`name_len u8`, name, `value_type u8`, value; string=type 7 with a 2-byte
length) → payload → `[message_crc u32]` (GZIP CRC32 over all bytes before the CRC); 16 bytes overhead.
Each Anthropic message is a `chunk` whose payload is `{"bytes":<base64>}` decoding to one standard
Anthropic event — same JSON as api.anthropic.com SSE. Smallest decode dep: `@smithy/eventstream-codec`.
Sources: AWS `lexv2/.../event-stream-encoding.html`; Smithy `aws/amazon-eventstream`; the AWS Claude
streaming example; `bedrock-sdk/src/core/streaming.ts`.

**Strict body validation (both paths).** Bedrock 400s (`ValidationException` / "Extra inputs are not
permitted") on unrecognized fields — confirmed live on the invoke path. So **scrub** fields claude sends
that the target model doesn't accept (extra `anthropic-beta`s, `metadata`, `output_config`, manual
`thinking` on adaptive-thinking models, etc.). Sources: `count-tokens.html`; claude-code issue #57611.

**Inference-profile requirement (path a).** All Claude 4 / 3.7 / 3.5-Haiku / 3.5-Sonnet-v2 ids are
profile-only — a bare `anthropic.claude-…` id returns "on-demand throughput isn't supported. Retry …
with the ID or ARN of an inference profile." Map model→region profile (`us.`/`eu.`/`au.`/`jp.`/`global.`
— note APAC split into `au.`/`jp.` for Sonnet 4.5+). **No SDK ships this table; build it.** Source:
Anthropic `claude-on-amazon-bedrock` model table; per-model AWS model cards.

**Bedrock-only response extras (path a).** A `amazon-bedrock-invocationMetrics` chunk (token counts /
latency) with no `bytes` field — **strip it** (it has crashed naive consumers); ids are `msg_bdrk_` /
`toolu_bdrk_`-prefixed (rewrite to `msg_`/`toolu_` if the CLI validates the shape). Sources: langchain
issue #14120; pydantic-ai issue #5774; AWS tool-use response doc.

**Auth.** Bedrock **API key** is simplest: `export AWS_BEARER_TOKEN_BEDROCK=<key>` → `Authorization:
Bearer` / `x-api-key`, no SigV4. Otherwise the standard AWS chain (env → SSO → web-identity → INI →
IMDS); `@anthropic-ai/bedrock-sdk` uses `fromNodeProviderChain()` by default. SigV4 standalone:
`@smithy/signature-v4` + `@aws-crypto/sha256-js` (+ `@aws-sdk/credential-providers`) or the tiny `aws4`
— sign service `bedrock` (path a) or `bedrock-mantle` (path b), and **sign the exact transmitted
bytes** (serialize once, sign, forward unchanged). Sources: `bedrock/latest/userguide/api-keys.html`;
`reference_sigv-create-signed-request.html`; `bedrock-sdk/src/core/auth.ts`.

**TODO (live-probe):** the exact accepted `anthropic-beta`/field set per model; whether the CLI validates
the `msg_` id prefix; native-SSE availability for the target model in the target region; body-size caps
(InvokeModel 25M chars; Bedrock guide cites 20 MB).
