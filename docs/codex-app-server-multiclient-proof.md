# Codex app-server multi-client proof

**Status:** M3a product companion implemented and accepted 2026-08-30 against exact Codex CLI
`0.151.0` on Linux arm64. One local Codex TUI and two remote-claw browsers shared one exact native
thread through an explicit-port loopback app-server. M3b then passed on an exact official Remote thread
for the same Codex version/platform through the literal managed Unix socket and legacy full-turn
hydration. The earlier `0.146.0` observations below remain historical seam evidence.

## M3a product result

The shipped `--rc-driver=codex` companion resumes/joins one exact UUIDv7 on a caller-owned explicit-
port loopback WebSocket app-server. It subscribes before bounded ascending history, drains buffered
events before announcing readiness, projects completed native user/assistant text at Codex item
coordinates, and advertises real native thread status. Browser text is serialized behind native idle;
the final canonical acknowledgement follows only after the exact Codex user item appears. Empty text,
slash commands, attachments, files, interrupt, model/mode changes, end, approvals, and questions are
unavailable in the browser.

The companion never starts or stops app-server, discovers/selects/creates/deletes/stops a thread, or
owns the Codex TUI. The supported topology requires a local TUI attached to the same exact thread for
the companion lifetime. For current 0.151 approval/question requests, the first result or error wins
globally, but app-server exposes no atomic TUI-attachment proof. The companion's client therefore has
no request-response method: it observes those server requests without answering or erroring them, and
the local TUI is their sole owner.

The real acceptance used the production web build and durable SQLite broker. Uniquely labelled turns
from the TUI, browser A, and browser B, plus their replies, appeared exactly once in both independent
browser contexts and in the TUI. A native shell approval appeared in the TUI, was declined there, and
did not perform its side effect. A separate native question appeared in the TUI, was answered there,
and completed normally. Both app-server subscribers observed each request resolve while the companion
remained silent and live. Stopping the companion left app-server, the TUI, and the native thread live.

### Supported tuple

- Binary: `codex-cli 0.151.0`, `aarch64-unknown-linux-musl`.
- Native binary SHA-256: `56f026015ccc3ebc12895282200d89c216892bf6fa15fa7f228e6e0c6ad6ce76`.
- Source tag: `rust-v0.151.0`; commit
  [`78c290807ce710180111df227df3b7a4fe845452`](https://github.com/openai/codex/commit/78c290807ce710180111df227df3b7a4fe845452).
- Official native surface: [Codex app-server](https://learn.chatgpt.com/docs/app-server).
- remote-claw harness: `{agent:"codex",mode:"app-server"}` with `status:true` and every control,
  structured permission, and attachment capability false.

## Historical seam evidence

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

### Historical pinned tuple

- Binary: `codex-cli 0.146.0`, `aarch64-unknown-linux-musl`.
- Binary SHA-256: `cb5e8cb8a333a408ce6adbe0d4fad1845c69772c2216af7c1f88c98a11460dc6`.
- Source tag: `rust-v0.146.0`; commit
  [`e363b08c9175ac1cbe5893615dd2cb9ddf95043b`](https://github.com/openai/codex/commit/e363b08c9175ac1cbe5893615dd2cb9ddf95043b).
- Official surface: [Codex app-server](https://learn.chatgpt.com/docs/app-server).

The source and generated protocol schema showed per-connection initialization, per-thread subscriber
sets, explicit resume/unsubscribe, and a shared app-server processor. Those facts explain the observed
multi-client behavior; they do not promise it for another release.

## Boundary and next result

M3a has now proved:

1. one exact app-server thread and readiness-gated broker bridge;
2. a real local Codex TUI plus two remote-claw browsers;
3. native history/subscription reconciliation without duplicate mutation;
4. structural non-ownership of approvals and questions by the companion; and
5. lifecycle isolation on a clean companion stop, leaving app-server, TUI, and thread usable.

Focused deterministic tests own broker/projection fail-stop and teardown behavior; the live gate did
not simulate a broker failure.

M3b subsequently proved same-thread coexistence with the current Codex Remote product through its
supported topology, the local TUI, and two independent remote-claw browsers. It does not justify a
generalized coordinator, outward gateway, signing hierarchy, or durable command schema. Add state only
for a demonstrated native failure with an executable fault test. See
[Remote connections](https://learn.chatgpt.com/docs/remote-connections).

## What this does not prove

- tools, forms, attachments, child-agent fan-out, or browser ownership of approvals/questions;
- every notification, rich item family, or full TUI rendering parity;
- companion restart/backfill acceptance or stable projection identity;
- exactly-once native application after an ambiguous request;
- per-device provider unsubscribe or device-specific failure isolation;
- broker-loss isolation or recovery;
- a non-loopback socket/authentication boundary; or
- compatibility beyond the pinned binary/platform.

## Retained evidence

`spikes/codex-multiclient/` retains three sanitized Codex 0.146.0 observations: two-client sharing,
real-TUI coexistence, and multi-chat attachment. They are research inputs, not executable gates or a
current-version compatibility claim. The one-off probes and hash/offline verifiers were removed; Git
history is the recapture archive.

The current adapter's focused client/driver tests and one bounded current-version native acceptance own
the M3a claim. Ordinary changes should run the cheapest affected boundary and should not replay or
rebuild the historical proof machinery unless the supported native tuple changes.

## M3b product result

The historical M3a acceptance above remains an explicit-port loopback WebSocket result. For M3b, the
current companion additionally accepts the exact literal `unix://`, which resolves only to Codex's
same-user managed socket at `$CODEX_HOME/app-server-control/app-server-control.sock` (or under
`~/.codex` when `CODEX_HOME` is unset). It does not accept `unix:///path` or any other arbitrary Unix
socket path. Explicit-port literal loopback WebSocket origins remain available.

The resumed thread's native `historyMode` now chooses the bounded reader rather than assuming one API:
`paginated` pages `thread/items/list` ascending; `legacy` pages `thread/turns/list` ascending with
`itemsView:"full"`. Each reader validates its native shape and filters away tool, reasoning, and every
other unsupported family before the shared 10,000 projected user/assistant text-item cap is counted.
The immutable projection coordinate is `(turnId,itemId)`, because Codex may reuse one item ID in
different turns. Same-coordinate, same-byte history/live overlap deduplicates; changed projected bytes
at the same coordinate fence the companion.

The bounded live acceptance used an exact official Remote thread on Codex 0.151.0/Linux arm64, the
literal managed Unix socket, legacy full-turn hydration, one attached local TUI, and two independent
remote-claw browsers. The TUI remained the sole owner of approval and question handling. One marker
originating at the provider appeared exactly once in each browser. One browser-origin prompt and its
acknowledgement appeared exactly once in the official thread, the TUI, and both browsers; the sending
browser also showed its host receipt.

For the isolation step, an ephemeral provider transport was disabled and remained disabled while a
browser-B turn completed. The managed daemon, local TUI, companion, and both browsers stayed live, and
provider transport subsequently restored to connected. This proves failure isolation when provider
transport is absent. It does **not** prove that one specific provider device was unsubscribed while
another provider device remained connected, and must not be described as per-device unsubscribe.

M3b graduates only this exact text/status/coexistence and provider-transport-isolation tuple. It does
not graduate richer controls, attachments, approval/question ownership by browsers, companion
restart/backfill, or broker-loss behavior.
