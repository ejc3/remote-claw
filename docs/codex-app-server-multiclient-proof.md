# Codex app-server multi-client proof

**Status:** bounded evidence captured 2026-07-29 against Codex CLI `0.146.0`; not a product adapter or
a current-version guarantee. Codex is an intended remote-claw surface. This evidence establishes a
native seam but does not prove local-TUI, browser, or Codex/ChatGPT Remote coexistence.

## What was observed

### Two raw clients

Two independently initialized app-server clients shared one materialized native thread. Client A
created it; client B joined and resumed the exact thread ID. A model-free shell command from each
client produced the same selected native event projection on both connections: matching thread, turn,
item, command, output, completion, and exit status.

### Real TUI plus one raw client

One app-server accepted a raw protocol client and a real
`codex resume <same-id> --remote <recorder> --no-alt-screen` TUI. A model-free shell command in each
direction produced deeply equal selected five-event projections, and both markers rendered in the TUI
pane. This establishes a basic real-TUI coexistence seam for those commands.

### Multiple native threads

Three initialized raw connections represented clients A and B plus a host observer. A and B created
different top-level threads. Before the observer resumed a thread, only its creating connection
received the selected projection. After the observer resumed both exact IDs, it received each later
projection alongside that thread's owner while the non-owner remained unsubscribed.

### Subscription is not mutation authority

For the pinned `thread/shellCommand` method, a late client could submit to a live thread while native
checks immediately before and after reported it unsubscribed. The owning connection received the
events; the submitting connection did not. A bridge must therefore treat subscription, write
admission, and event observation as separate facts.

The pinned server also used one global server-request ID whose first response or error consumed the
callback before payload validation, and an external-clock request required exactly one subscribed
connection. Permission/question fan-out cannot safely be inferred from ordinary notification fan-out.

## Pinned tuple

- Binary: `codex-cli 0.146.0`, `aarch64-unknown-linux-musl`.
- Binary SHA-256: `cb5e8cb8a333a408ce6adbe0d4fad1845c69772c2216af7c1f88c98a11460dc6`.
- Source tag: `rust-v0.146.0`; commit
  [`e363b08c9175ac1cbe5893615dd2cb9ddf95043b`](https://github.com/openai/codex/commit/e363b08c9175ac1cbe5893615dd2cb9ddf95043b).
- Official surface: [Codex app-server](https://learn.chatgpt.com/docs/app-server).

The source and generated protocol schema showed per-connection initialization, per-thread subscriber
sets, explicit resume/unsubscribe, and a shared app-server processor. Those facts explain the observed
multi-client behavior; they do not promise it for another release.

## Product implication

The smallest Codex adapter should first prove:

1. one exact app-server thread and readiness-gated broker bridge;
2. a real local Codex TUI plus two remote-claw browsers;
3. native history/subscription reconciliation without duplicate mutation;
4. explicit request/response ownership for approvals and questions; and
5. failure isolation that leaves the native TUI usable.

Only after that vertical works should Codex/ChatGPT Remote be added through a supported provider
boundary. The proof does not justify a generalized coordinator, outward gateway, signing hierarchy,
or durable command schema. Add state only for a demonstrated native failure with an executable fault
test.

## What this does not prove

- model turns, tools, approvals, questions, forms, attachments, or child-agent fan-out;
- every notification or full TUI rendering parity;
- browser transport, encrypted broker integration, or durable reconnect;
- exactly-once native application after an ambiguous request;
- official Codex/ChatGPT Remote coexistence;
- a production socket/authentication boundary; or
- compatibility beyond the pinned binary/platform.

## Retained evidence

`spikes/codex-multiclient/` retains three sanitized Codex 0.146.0 observations: two-client sharing,
real-TUI coexistence, and multi-chat attachment. They are research inputs, not executable gates or a
current-version compatibility claim. The one-off probes and hash/offline verifiers were removed; Git
history is the recapture archive.

When a future Codex adapter makes a concrete compatibility claim, add the smallest current-version
native acceptance that proves it. Ordinary changes should inspect the evidence, not replay historical
proof machinery.
