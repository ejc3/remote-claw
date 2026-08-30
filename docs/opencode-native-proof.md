# OpenCode 1.17.5 protocol fixture

This is a retained research fixture for one OpenCode version. It records native API facts used by the
current pinned implementation of an intended product adapter. It is not runtime authority, a deployment
attestation, or a claim that the current driver has exactly-once mutation or durable recovery.

The fixture lives in `spikes/opencode-native/` and is intentionally model-free.

## Observed result

In one isolated OpenCode `1.17.5` server process, the probe:

1. began with an empty session list;
2. sent one `POST /session` with a unique `metadata.remoteClawCreationId` marker;
3. confirmed exactly one returned and listable canonical `ses_*` carried that marker;
4. subscribed to legacy `/event` SSE;
5. sent `prompt_async` with caller-supplied
   `messageID = "msg_remoteclaw_native_proof_001"`, `noReply:true`, and one fixed text part;
6. confirmed the empty `204`, native history, and SSE all carried that exact message and part;
7. sent the same request once more; and
8. deleted the session and proved the selected session and server resources were gone.

The second prompt returned another empty `204`. It was **not** idempotent: the native user message kept
the caller-supplied ID and gained a second distinct part with the same text. In this exact one-process,
`noReply:true` case, a caller message ID is useful correlation but is not a deduplication key.

That is the useful conclusion. A client must not blindly resend a prompt merely because its HTTP
outcome is ambiguous.

## Isolation

The retained protocol run used a private unprivileged network namespace with loopback and no default
route. It supplied fresh `HOME`, XDG, temporary, and workspace directories and a fixed child
environment with no inherited provider credential variables. It requested no assistant reply and did
not exercise provider inference.

This setup limits the fixture; it does not prove general filesystem isolation, production process
ownership, or behavior on another platform or OpenCode version.

## What the fixture does not prove

It does not establish:

- coexistence or ordering between a real OpenCode TUI and remote-claw;
- exactly-once prompt application, especially after a lost response or process restart;
- idempotent session creation or recovery of an ambiguous create;
- durable native-session-to-broker binding;
- SSE replay, gap recovery, or status convergence;
- permissions, questions, attachments, compaction, or interrupt causality;
- causal ownership of assistant output during concurrent native turns;
- provider credential or network isolation for the actual application; or
- browser-to-native end-to-end product behavior.

The current pinned driver sends `{model, parts}` and omits the caller `messageID`, so its
request is not the same request used by this fixture.

## Retained evidence

`spikes/opencode-native/evidence-1.17.5.json` is the sanitized model-free observation behind the
claims above. It is input for compatibility work, not an executable gate or runtime authority. The
one-off capture program, executable-content manifest, and hash verifiers were removed; Git history is
the recapture archive.

Fresh capture is required only when a concrete driver or protocol claim depends on it. Build the
smallest purpose-specific capture or live acceptance for that claim instead of reviving a ceremonial
package-wide proof chain.
