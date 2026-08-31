# Client-driven host runtime: retired design

**Status (2026-08-24): retired and removed.** The former A1 host-runtime implementation built a
generalized durable coordinator before remote-claw had proved even one provider-native collaboration
outcome. It was not used by the stable MITM path. The tmux and OpenCode launch paths opened a
health-only runtime-owner client, invoked no operation, and closed it; installed packages could not
start its private daemon entry reliably.

The code, database migrations, signing services, broker routes, codecs, and release machinery were
removed. Git history preserves the implementation if a specific idea is ever needed again. This page
records the decision so the deleted architecture is not mistaken for unfinished current work.

The cleanup does not delete an existing `host-state-v1.db` or attempt to kill a detached daemon from
an older build. Such files are recoverably orphaned user data; an old process can exit normally or at
reboot.

## What remains

- Process-local driver lifecycle and conservative capability reporting remain in the active Claude,
  tmux, OpenCode, and Codex adapters.
- The deployed broker still provides authenticated, encrypted, durable frame transport for the
  current remote-claw viewer.
- Runtime protocol parsing, mutation admission, deduplication, ambiguous-send fail-stop behavior,
  secret handling, and local-session survival remain safety boundaries.
- `AnthropicRcClient` provides the host-side native session list, history, SSE, and text-post
  primitives used by the bounded native text companion.

There is no durable host coordinator, runtime-owner daemon, server signer, A1 command adjudicator,
A1 browser route, or A1 migration schema in the current implementation.

## Why it was removed

The retired design accumulated more than 150,000 TypeScript lines plus a long technical archive while
providing no reachable user capability. It increased package size, CI time, review load, and attack
surface. Its internal proofs could not establish the missing outcome: official Claude clients and
remote-claw browsers controlling one normal Anthropic-hosted session together.

The replacement rule is evidence-first: implement the smallest end-to-end user path, retain only the
state needed by that path, and add a coordinator or signature layer only when a demonstrated safety or
recovery failure requires one.

## Current direction

The full milestone sequence is [Product goal and release gates](release-finish-line.md). The native text
vertical keeps Claude connected normally to Anthropic and uses the host-side `AnthropicRcClient` to
project history/events to the encrypted broker and submit text. It is implemented for one bound
session, text only, host-only OAuth, stable command UUIDs, no automatic retry after an ambiguous POST,
and explicit exact-session restart through a fresh projection. This retired-design note intentionally
does not mirror the changing acceptance ledger; current evidence and remaining gates live in the
[release roadmap](release-finish-line.md).

This experiment deliberately does not resurrect the generalized runtime or remove broader OpenCode
capability/tuple work, post-M3 Codex controls/restart/other-tuples work, later tmux tuples/controls, and
provider work. If the
provider-native API cannot meet a requirement, record the exact failure first and design only the
missing mechanism.

## Safety rules for any future coordinator

A future durable coordinator is justified only by a reachable product requirement and must still:

- preserve the local TUI and official-client session when remote-claw fails;
- distinguish receipt, provider acceptance, native observation, and rendered projection;
- prevent stale or duplicated writers after takeover;
- keep provider credentials and plaintext out of the remote-claw broker;
- fail closed without converting uncertainty into a second command; and
- ship with one executable recovery test for the failure it is intended to solve.

Those are constraints, not a pre-approved architecture or roadmap.
