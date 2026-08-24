---
name: pr-gate
description: "Run remote-claw's proportional pre-PR gate after a change is frozen: common local checks once, path-owned conditional evidence, independent review, and a green-CI merge."
---

# remote-claw PR gate

Use this skill when a tranche is ready to finish. The purpose is working software with credible safety
evidence, not a growing proof system.

## 1. Freeze the claim

Before the final gate:

- state the user outcome and safety boundaries changed by the diff;
- finish code, schema, generated artifacts, and docs;
- run focused owner tests while iterating; and
- do not repeatedly run the full gate on a moving tree.

If the diff grew beyond its durable boundary, split it only at a closed, crash-safe seam. Do not weaken a
safety invariant to make a tranche smaller.

## 2. Run the common local gate once

From the repository root:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm test:install
```

These commands cover formatting/lint, strict TypeScript, deterministic package tests, and the packed CLI.
They do not substitute for a real browser, provider, durable cloud, or deployed environment when one of
those boundaries is causal to the change.

## 3. Add only path-owned evidence

Use `docs/test-plan.md` to select conditional gates.

- For viewer CSS or rendered markup, build the production app, run the product browser suite, and inspect
  the light/dark phone and desktop screenshots. Run theme generation/checks when theme inputs changed.
- After the web production build, run web Vitest with `RC_CI=1` so emitted-CSS assertions cannot skip.
- For browser transport or broker/viewer wiring, run the product browser suite. Do not require visual
  screenshots for code-only changes with no rendered effect.
- For private Claude launch or translation changes, run the logged-in real-Claude smoke when its declared
  prerequisites are available; a required but unavailable prerequisite is not green.
- For OpenCode, Bedrock, Anthropic-native, Turso, stress, or deployed behavior, run the corresponding
  conditional gate only when the diff changes or claims that surface.
- The deployed Preview smoke is a trusted post-default-branch `repository_dispatch` check bound to the
  exact deployed SHA. It is not a PR-head check and must not be represented as one.

Keep non-obvious Astryx rules in `AGENTS.md` and `docs/astryx-migration.md`; do not duplicate their full
history here.

## 4. Turn E2E findings into proportional regressions

E2E is the final reality check and the discovery layer. When it finds a failure, first classify it as a
reproducible product defect, harness defect, external outage, or unsupported claim. Fix the owning cause.

For a product defect likely to recur:

1. identify the earliest trustworthy boundary that reproduces the cause;
2. add the cheapest deterministic regression at that boundary;
3. retain only a thin E2E sentinel when cross-layer wiring is itself causal; and
4. record why an expensive regression cannot shift left when it depends on a real browser engine,
   provider, process race, storage behavior, deployment, or security boundary.

Cheaper never means less faithful. A mock is unsuitable if it removes the behavior that caused the bug.
Do not duplicate one scenario at every layer, preserve incidental timing as a contract, invent an
abstraction solely for a test, or add a permanent guard for a one-off harness mistake. Coverage for
lower-risk bugs is proportional to recurrence and blast radius.

A reachable security failure gets a deterministic regression at its causal trust boundary and, only when
needed, the smallest integration sentinel proving that boundary is wired into the product. Prefer direct
malformed-input, authorization, replay, custody, and fail-stop tests over exhaustive synthetic state
graphs. New proof machinery needs a demonstrated failure and should be removed when a cheaper faithful
test supersedes it.

Before retaining an expensive regression, note in the test or PR:

- the observed failure;
- its causal boundary;
- cheaper alternatives considered; and
- why this is the smallest faithful sentinel.

Every declared-required gate must fail or report inconclusive with a nonzero exit when prerequisites are
missing. It must not silently skip green.

## 5. Sync documentation

When Markdown or a documented surface changes, perform the mandatory `AGENTS.md` doc-sync pass:

- render changed docs with GFM and reject list markers stranded in paragraphs;
- check flags, verbs, endpoints, permissions, and capability claims against code;
- reconcile `v2-architecture.md`, `protocol.md`, driver docs, the release finish line, and test plan; and
- remove stale or superseded references.

## 6. Review and merge

Review the frozen diff for correctness, security, unnecessary machinery, and preservation of the final
product goal. Run the required independent read-only review once; turn concrete findings into fixes and
focused checks, not unbounded rereading.

Push the reviewed commit, require ordinary path-owned CI on that exact PR head to be green, then merge.
Do not stop at an open PR. Never call a skipped, unavailable, wrong-SHA, or inconclusive required gate
green. Secrets must not enter argv, logs, artifacts, screenshots, or ordinary CLI output.
