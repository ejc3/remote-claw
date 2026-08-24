# OpenCode native protocol observations

`evidence-1.17.5.json` is a sanitized historical record from OpenCode 1.17.5 on Linux arm64. It is
research input for a required product surface, not runtime authority, a release gate, or a claim about
the currently installed executable.

The useful observations are:

- `POST /session` preserved a caller-supplied `metadata.remoteClawCreationId` in the create response,
  session list, and creation event.
- `prompt_async` accepted a caller-supplied `messageID` with `noReply: true` and returned an empty 204.
- Repeating that exact request was not idempotent: one user message retained the caller ID but gained a
  second text part with a distinct native part ID. A 204 transport receipt is therefore not delivery
  proof, and an ambiguous prompt must not be blindly resent.
- The model-free run did not exercise provider inference or runtime permission creation/reply behavior.

The supported, explicit opt-in live compatibility suite is
`packages/cli/src/host/rc/opencode/driver.e2e.test.ts`; ordinary tests do not contact a native server.
Executable chunk manifests, binary/source hash verifiers, and the one-off capture program were removed.
Git history remains the recapture archive.
