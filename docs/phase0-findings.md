# Phase 0 — Empirical Findings

**Historical evidence, not a current compatibility promise.** The original investigation used Claude
Code `2.1.168` on 2026-06-07. Later targeted observations used `2.1.237`. The old executable Python
prototype and raw captures were removed from the maintained tree on 2026-08-24; Git history retains
them. Current behavior is defined by the TypeScript implementation, [Protocol](protocol.md), and
focused compatibility tests.

These findings matter because they identified both the working private replacement relay and the
native client seam for structured coexistence. A later bounded M0 run first proved the cheaper
lower-fidelity tmux route. The current M1/M2 evidence and later sequencing live in
[Product goal and release gates](release-finish-line.md). This research is one part of the broader
Claude/Codex/OpenCode/tmux product.

## 1. `--sdk-url` is not a custom Remote Control relay hook

Claude `2.1.168` accepted `--sdk-url` only for a fixed provider-host allowlist and only with secure
schemes. A loopback URL failed client-side before opening a socket:

```text
claude --remote-control --sdk-url ws://localhost:8787 ...
→ host is not an approved Anthropic endpoint
```

`ANTHROPIC_BASE_URL` did not extend the allowlist. `CLAUDE_CODE_REMOTE` skipped a later organization
policy check, not the host check. The practical consequence was that remote-claw could not build on a
documented “point Remote Control at my server” switch.

The interactive Remote Control transport instead used ordinary HTTPS endpoints under
`api.anthropic.com`. A process-scoped loopback TLS proxy could either pass them through for observation
or answer the RC subset locally while forwarding inference and OAuth.

## 2. Stream JSON observations

`claude -p --input-format stream-json --output-format stream-json --verbose` provided a separate,
documented programmatic surface. One captured turn showed:

- user input as `message:{role:"user",content:...}`, not a bare string;
- a rich `system/init` record with model, tools, skills, agents, MCP servers, cwd, and permission mode;
- raw Messages API deltas wrapped in `stream_event`;
- a full `assistant` message; and
- a `result` record with duration, cost, usage, model usage, and permission denials.

The observed stream order was `message_start`, content block start/deltas, full assistant, content
block stop, message delta/stop, then result. This helped shape the canonical viewer translation, but
stream JSON is not the current Claude Remote Control collaboration transport.

## 3. Worker-side Remote Control map

The pinned capture observed this worker/host surface:

| Method and path | Observed purpose |
| --- | --- |
| `POST /v1/code/sessions` | Register a `cse_*` session with title, bridge config, cwd/model/source metadata |
| `POST /v1/code/sessions/{id}/bridge` | Mint a session-scoped worker bearer and `worker_epoch` |
| `GET /v1/code/sessions/{id}/worker/events/stream` | Deliver client events to the local Claude worker over SSE |
| `POST /v1/code/sessions/{id}/worker/events/delivery` | Acknowledge downstream delivery |
| `POST /v1/code/sessions/{id}/worker/events` | Post worker user echoes, assistant output, results, and system records |
| `PUT /v1/code/sessions/{id}/worker` | Publish epoch-bound worker metadata and connection state |
| `POST /v1/code/sessions/{id}/worker/heartbeat` | Keep the worker alive |
| `GET /v1/code/triggers` | Discover triggers |

The `2.1.168` reference stream began with an initialize control request, but a separate capture did
not show initialize before its first user event. Initialize-first is therefore a private-facade
invariant, not a universal provider guarantee.

Claude `2.1.237` later emitted an exact metadata-only disconnect update containing
`worker_epoch` and `connection_status:"disconnected"`. The current parser admits only that exact
shape with the matching epoch and performs no session-state mutation; a wrong value, extra key, or
wrong epoch fails closed.

## 4. Client-side REST/SSE seam

The most important Phase 0 observation was that an already running Anthropic-hosted Remote Control
session exposed a client-side REST/SSE interface usable with the host's normal Claude OAuth:

| Method and path | Observed purpose |
| --- | --- |
| `GET /v1/code/sessions` | List sessions with pagination/resume metadata |
| `GET /v1/code/sessions/{id}` | Read session details |
| `GET /v1/code/sessions/{id}/events` | Page ordered history |
| `GET /v1/code/sessions/{id}/events/stream` | Follow client-side live events over SSE |
| `POST /v1/code/sessions/{id}/events` | Submit a user event with caller UUID, session ID, and timestamp |
| `POST /v1/code/sessions/{id}/client/presence` | Publish client presence |
| `POST /v1/code/sessions/{id}/mark_read` | Publish a read coordinate |
| `POST /v1/code/sessions/{id}/archive` / `unarchive` | Change lifecycle state |

A separate process posted one user turn into a real session while the local TUI was live. Claude
received it, answered, and the process read the answer from provider history. This established the
core native-coexistence seam without replacing Anthropic's worker backend.

The observed event envelope included `event_id`, `event_type`, string `sequence_num`, `source`,
`created_at`, and a type-specific payload. One turn appeared as initialize request/response, client
user event, assistant, and result. Private provider interfaces can change, so current code bounds and
validates every body, preserves unknown SSE records, binds one exact session, and avoids inventing
mutation semantics.

## 5. Private replacement relay result

Phase 0 also proved the topology implemented by today's `--rc-app` mode:

```text
remote-claw client ⇄ local relay/MITM ⇄ real Claude worker
                                  └── ordinary inference/OAuth → Anthropic
```

The proxy answered `/v1/code/sessions/**` and trigger requests locally, minted the worker credential,
served downstream SSE, and accepted native output. Normal inference and OAuth passed through.

Observed runs established:

- a browser-originated prompt reached Claude, produced a model answer, appeared in the local TUI, and
  returned to the custom client;
- local-TUI input appeared in the custom client; and
- the private relay could fan one native session to the local TUI and its own client.

This result remains valuable, but it replaces Anthropic Remote Control. The official Claude app
cannot see the session. It therefore proves the current private beta, not native-provider coexistence.

## 6. Permissions observation

In the pinned real and private-relay captures, Remote Control tool calls executed without a
`can_use_tool` prompt even under default permission mode. The observed tool flow was user,
assistant/tool-use, user/tool-result, assistant. Control request/response plumbing existed, but the
captured RC path did not use it as a tool approval gate.

This is version-sensitive evidence, not permission policy for every adapter. OpenCode and tmux expose
their own documented permission boundaries, and future native actions require fresh focused captures.

## 7. Architectural consequence

The repository originally continued with the private relay and accumulated a much larger generalized
runtime and proof program. The private relay became useful product infrastructure; the unused
coordinator/proof machinery did not create a user-facing surface and was removed.

Before adding a companion, M0 tested the retained plain-Claude tmux route. On 2026-08-24, Claude
2.1.237 kept its normal Anthropic Remote Control session while one local pane, a host-side Anthropic
client, and two remote-claw browsers submitted labelled turns; provider history held each once, reload
did not duplicate them, and broker loss left the native session alive. This is bounded architecture
evidence, not a supported-version promise or official-app UI test.

The client-side seam became the selected M1 structured milestone and is now complete:

1. keep normal Anthropic Remote Control intact;
2. wait until one exact native session and bridge prerequisites are ready;
3. reconcile provider history with the live SSE stream;
4. project supported events through the existing sealed broker; and
5. submit one stable-identity text event without automatically retrying an ambiguous POST.

See [Native Claude Remote coexistence](native-rc-passthrough-scoping.md). The later pinned OpenCode M2
adapter reused the demonstrated small lifecycle and is also complete. Apply proven pieces selectively
to Codex where its native seam needs them. Keep tmux explicitly lower fidelity. Do not recreate the
retired generalized coordinator unless a concrete cross-adapter failure demonstrates that it is
necessary.

## 8. Evidence limits

These captures do not establish:

- compatibility with every Claude version or platform;
- a public or stable provider API contract;
- exactly-once native application after an ambiguous network result;
- permission, question, attachment, interrupt, or mode semantics beyond the observed shapes;
- Codex, OpenCode, or tmux parity; or
- full product completion.

The retained value is the endpoint map, negative `--sdk-url` result, direct-client seam, private-relay
round trip, and version-specific caveats. Raw historical code and captures remain recoverable through
Git history without staying in the shipped or continuously gated tree.
