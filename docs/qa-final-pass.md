# Historical QA pass

**Status:** archived summary. This page records the useful conclusions of the June 2026 whole-system
review; it is not an active release checklist. Current gates live in
[Test plan](test-plan.md), and the product stop condition lives in
[Product goal and release gates](release-finish-line.md).

## Findings that still matter

The review found that the core confidentiality design was sound and that the important failures were
mostly ordering, recovery, and deployment edges:

- broker frames are AEAD-sealed and bind their visible routing coordinates;
- the broker receives routing metadata and an admission bearer, but not conversation keys or
  plaintext;
- identity-scoped routes recompute the identity from the bearer;
- host restart requires both transcript-sequence and publish-order recovery cursors;
- a changed replay at one durable coordinate is a hard collision;
- child Claude processes must not inherit the machine-secret path, deployment bypass, or parent Claude
  session identity;
- Turso create-to-serve delay is transient, while loss of a known channel is permanent storage loss;
- remote relay failure must not kill a healthy local Claude session; and
- unauthenticated handoff is safe only with its complete capability, TTL, atomic single-use, body-limit,
  and external rate-limit boundary.

The concrete protocol and storage boundaries above have focused regression tests in clawsec, the CLI
relay/session/launch suites, and the web broker/route suites. Deployment-only preconditions such as an
external handoff rate limit require the named conditional outside-in procedure in the current
[test plan](test-plan.md#56-handoff-waf--conditional-on-enabling-handoff); this archive is not evidence
that every operational conclusion is reproducible in-process.

## What is superseded

Historical suite counts, removed backends, old `test:app:*` variants, generalized-host-runtime plans,
and receipt-based release evidence are intentionally omitted. Git history preserves the original
report if an old decision needs forensic context.

The review did not prove the current Claude native-coexistence milestone. The private `--rc-app` path
still replaces Anthropic Remote Control, and `--rc-trace` is passive. Since this review,
`--rc-driver=claude-native` has implemented structured native-RC text coexistence plus an explicit
exact-session, fresh-projection restart path. This archive intentionally does not duplicate the live
acceptance ledger; current evidence and remaining gates are maintained in
[Product goal and release gates](release-finish-line.md). Later OpenCode, Codex, tmux, and inference
milestones retain their own acceptance scenarios.

## Current reproduction

For a frozen ordinary change:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm test:install
```

Then run only the browser, real-Claude, Turso, or deployment test owned by the changed surface. A green
foundation gate is not a substitute for the deployed native-coexistence acceptance test.
