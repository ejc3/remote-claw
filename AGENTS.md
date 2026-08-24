# remote-claw — project notes for Claude

**Final target:** a cloud-brokered, zero-knowledge, E2E-encrypted multiplayer layer for Claude Code,
Codex, OpenCode, and an honest lower-fidelity tmux fallback. Each target keeps its local TUI plus
multiple remote-claw browsers and preserves official provider collaboration where available.
Inference routing (Anthropic/OpenAI/Bedrock) is an orthogonal axis. “Accountless” means no Anthropic
account, not no AWS/provider or remote-claw credentials.

**Current truth:** the private Claude replacement relay and narrower OpenCode/tmux adapters work;
simultaneous official-Claude-client coexistence and the production Codex adapter are not implemented.
The supported durable broker is SQLite/libSQL (Turso in deployment); Vercel Workflows remains
experimental. Design lives in `docs/v2-architecture.md`; the crypto core is `packages/clawsec`, the CLI
is `packages/cli`. Historical Claude RC observations are in `docs/phase0-findings.md` and
`docs/v2-architecture.md` §17.

## Driving a real claude through the wrapper (RC modes + the stub gotcha)

`remote-claw` runs the **real** `claude` behind a local MITM proxy (`HTTPS_PROXY` +
`NODE_EXTRA_CA_CERTS`). Two modes, picked by flag:

- **`--rc-app <origin> [--rc-backend <b>]`** (`runRcLaunch`, `launch.ts`) — intercepts claude's RC
  endpoints (`/v1/code/sessions/**`) and bridges the session **to our broker**, E2E-encrypted.
  By default, `/v1/messages`, OAuth, telemetry, and unrelated traffic tunnel to Anthropic. With
  `--rc-inference=bedrock`, remote-claw translates inference to Bedrock and synthesizes the required
  Anthropic control plane, so no request reaches Anthropic.
  View the session in **our** web viewer (`apps/web`) with a `--rc-pass` credential. Anthropic never sees this session, so the
  **official Claude app cannot** — by design.
- **`--rc-trace`** (`runRcTrace`, `trace-run.ts`) — a transparent inspector: passes **everything
  through to real `api.anthropic.com`** and just traces RC both ways (nothing hits our broker). The
  session registers with Anthropic and **bridges** (`POST /v1/code/sessions/{id}/bridge` → a
  `worker_jwt`), so the **official Claude app / mobile app drives it** while we capture every frame.

### The CLAUDE_CODE_CHILD_SESSION stub gotcha (cost hours, twice)

If the wrapper is started **from inside a claude session** (a terminal already in claude, or claude
spawning it — e.g. this harness), the launcher's session identity leaks into the spawned claude via
`...process.env`:

- `CLAUDE_CODE_CHILD_SESSION` makes the child a **stub** that bridges to the *parent* session instead
  of running as a real, independent claude — the MITM then drives a stub, and in trace mode the session
  never gets a `worker_jwt` (so the app can't drive it).
- `CLAUDE_CODE_SESSION_ID` pins/resumes the parent's id instead of minting a fresh `cse_`.

**Both `launch.ts` and `trace-run.ts` scrub these** from the child env (alongside
`REMOTE_CLAW_SECRET_FILE` / `VERCEL_AUTOMATION_BYPASS_SECRET`). Outside a claude session they're unset
(no-op). When launching manually, also `unset` them in the launch shell as belt-and-suspenders.

### Running + verifying a real (non-stub) session

- claude needs a **TTY** or it drops to `--print` mode — launch under a pty:
  `script -qfc "bash launch.sh" pty.log`.
- Diagnostics: `RC_LOG=debug` (frame shapes) or `RC_LOG=trace` (JSON bodies up to 256 KiB, with
  credential-keyed and token-shaped values recursively redacted; larger/malformed/truncated bodies are
  omitted). On POSIX, `RC_LOG_FILE=…` writes only to an owned `0600` regular non-symlink file separate
  from the pty's TUI output; unsafe/insecure targets warn and drop records. File capture is disabled on
  Windows because Node cannot enforce the same owner/mode/no-follow contract. Trace bodies can contain
  conversation text despite credential redaction, so treat the file as sensitive.
- **Verify it's real, not a stub:** the child claude env has **no** `CLAUDE_CODE_CHILD_SESSION`; and —
  broker mode: a fresh `cse_<hex>` is "session created" + announces every ~20s; trace mode:
  `POST …/bridge` returns a `worker_jwt`.
- **Stable Claude currently requires the exact tested version** `2.1.237 (Claude Code)`. The
  compatibility probe resolves `RC_CLAUDE_BIN` or `claude` on `PATH`, runs its scrubbed `--version`
  check, and fails closed before creating an identity when the version differs. The local OS,
  executable path, and same-user installation are part of the host trust boundary; do not add
  platform-, owner-, inode-, size-, or hash-attestation machinery to this application gate.

### The Vercel bypass (`VERCEL_AUTOMATION_BYPASS_SECRET`)

Unrelated to claude/Anthropic. Our broker is on Vercel with **Deployment Protection (SSO)**; the host
sends `x-vercel-protection-bypass: <secret>` so its automated broker calls get past Vercel's edge
without a browser login. Only used in **`--rc-app`** mode (reaching our broker); not needed in trace
mode; scrubbed from the child claude's env. The full RC control-verb surface claude's REPL bridge
accepts is documented in `docs/protocol.md §11`.

## Editing the docs (`docs/*.md`)

`docs/index.html` renders the markdown **live** via marked.js (GFM, `breaks:false`) — so the
markdown *is* the source of truth and the HTML stays in sync automatically. Edit the `.md`, never a
generated copy.

### The list-rendering "jumble" rule (bit us repeatedly)

**Always put a blank line between a paragraph/bold-header line and a list that follows it** —
especially an **ordered list that doesn't start at `1.`**. In CommonMark/GFM (and marked), an
ordered list whose first number is not `1` **cannot interrupt a paragraph**, so:

```markdown
**Some header**
4. First item      ← WRONG: renders as one run-on paragraph "**Some header** 4. First item …"
```

```markdown
**Some header**

4. First item      ← RIGHT: renders as <ol start="4"> with a real <li>
```

This is the cause of the "it flipped to markdown mode / scenarios are jumbled" reports. Bullet
lists and `1.`-ordered lists *can* interrupt a paragraph, but add the blank line anyway for safety.
Tables and code fences also want a blank line before them.

**Verify rendering, don't eyeball it.** After non-trivial doc edits, render the whole file through
marked and assert there are **no list markers stranded inside `<p>` tags** (the jumble signature),
e.g.:

```bash
# in a throwaway dir:  pnpm add marked@12.0.2
node -e '
  const {marked}=require("marked"); const fs=require("fs");
  marked.setOptions({gfm:true,breaks:false});
  const html=marked.parse(fs.readFileSync("docs/v2-architecture.md","utf8"));
  const bad=(html.match(/<p>[\s\S]*?<\/p>/g)||[]).filter(p=>/\n\s*\d+\.\s/.test(p)||/\n\s*[-*]\s+\S/.test(p));
  console.log("jumbled paragraphs:", bad.length); process.exit(bad.length?1:0);'
```

Also keep ```` ``` ```` fences balanced (even count) and avoid splitting an inline `` `code` `` span
across a line wrap (some renderers mishandle it).

## Mandatory doc-sync pass

Whenever a `docs/*.md` (or `AGENTS.md`/`CLAUDE.md`/`README.md`) lands, **or** you change the surface those docs
describe (an `--rc-*` flag, an RC control verb, a broker endpoint, or a driver's
permission/capability model), run a doc-sync pass before the work is "done" — no exceptions. The docs
are the *source of truth* (rendered live by marked.js) and they describe a moving target, so they drift
from the code and from each other; this is the doc analogue of the per-commit `/code-review` + codex
loop. Perform it once on the settled tree; do not use a blocking stop hook or change-state sentinel.
The four lenses, each verified and root-cause fixed (not papered over):

1. **Render.** Run every changed `docs/*.md` through marked (`gfm:true, breaks:false`) and assert **no
   list markers stranded inside `<p>` tags** (the jumble signature) and balanced fences — the snippet in
   "Editing the docs" above. Don't eyeball it.
2. **Code-truth.** Every documented `--rc-*` flag matches `args.ts`/`run.ts`; every RC verb matches the
   relay/driver; every per-driver permission/capability claim matches that driver. Read the code, don't
   trust the prose. (Example drift this caught: the tmux driver's docs said "auto-approve
   (`--dangerously-skip-permissions`)" long after B2 made permission **mirroring** the default.)
3. **Cross-doc sync.** No contradictions between `docs/v2-architecture.md`, `docs/protocol.md`, and the
   `*-driver.md` / `pluggable-harness.md` docs; a behavior change is folded into **every** doc that
   states it, not just the one you happened to open.
4. **Loose ends.** No stale/dangling references, no superseded section left standing.

Run `codex exec -s read-only` as the independent second reviewer (fact-check each doc claim against the
code), same as the per-commit loop. Surface genuinely open questions rather than silently resolving them.

## Running Playwright (browser repro) — the gotchas that cost time

Playwright lives **only in the `tests/web` workspace** (`@playwright/test`), NOT `apps/web` or the repo
root. Two things bite an ad-hoc browser script every time:

- **Import name:** `import { chromium, webkit } from "@playwright/test"` (it re-exports the engines).
  Bare `import … from "playwright"` is NOT resolvable — `playwright` isn't a direct dep, only
  `@playwright/test` is.
- **Script location:** an ESM file resolves bare specifiers from the FILE's directory, not cwd. So an
  ad-hoc `.mjs` MUST live inside `tests/web/` (e.g. `tests/web/scratch.mjs`) — a script in `/tmp` or
  `apps/web` throws `ERR_MODULE_NOT_FOUND` even when run with cwd=`tests/web`. Delete the scratch file
  after. The real suites run via the `tests/web/*.config.ts` configs (`pnpm --filter … test:app`).

Browsers: **Chromium is installed and works headless** (`chromium.launch()`). **WebKit needs system
libs** (GTK4/graphene/gstreamer/flite) — install once from `tests/web` with `sudo pnpm exec playwright
install-deps webkit && pnpm exec playwright install webkit`. WebKit is the only faithful **iOS-Safari**
repro (e.g. a fetch failing as "Load failed"); Chromium with `devices['iPhone 15']` emulation
reproduces mobile *layout* but not WebKit-specific transport behavior.

## The viewer's CSS (Astryx) — three things that fail SILENTLY

`apps/web` is migrating onto **Astryx** (`@astryxdesign/core`). Full status + a findings report for the
Astryx team is in `docs/astryx-migration.md`. Three traps, all of which produce a page that *looks*
right while being wrong:

- **`app/globals.css` is an import manifest — never write a rule in it.** A rule there is UNLAYERED, and
  unlayered CSS beats every cascade layer. Layer order lives in its own `app/layers.css`, imported first
  (webpack hoists imported CSS above the importing file's inline rules, so an inline `@layer a, b;`
  sorts too late to order anything).
- **`@import "…" layer(x)` DOES NOT WORK on Next 16** — the pipeline drops the `layer()` and inlines the
  file unlayered. `app/viewer.css` therefore carries its own `@layer remote-claw { … }` wrapper
  internally. Guarded by `test/astryx-foundation.test.ts`, which asserts on the BUILT css in `.next`
  (source-level assertions pass in both the broken and fixed state — that's how this got through once).
- **The theme is compiled, not runtime.** Edit `app/theme/remote-claw.ts`, then run `pnpm run
  theme:build` — the built artifacts in `app/theme/built/` are committed and are what ships. Never edit
  them. `--color-accent` / `--color-on-accent` are pinned on purpose: seeding the accent family alone
  makes Astryx INVERT the accent in dark mode (pale fill, dark text), which no test catches.

**Colour mode is light + dark (default `system`).** Every token is a `[light, dark]` tuple →
`light-dark()`, resolved off `color-scheme`, which Astryx's `reset.css` derives from `<html data-theme>`.
The hand-written `viewer.css` `:root` surface/text tokens MIRROR the theme's light/dark pairs as
`light-dark()` so the two systems flip together — keep those in sync. The semantic TEXT tokens
(`--warn`/`--danger`/`--add-fg`/`--del-fg`) are deliberately DARKER on light than the theme's amber/red
FILL tokens: they clear AA 4.5:1 as text (labels, diff signs, perm Allow/Deny tints) on the worst-case
button surface, where the brighter fill values are ~3.5:1 — the same fill-vs-text split as
`--accent`/`--accent-text`. Verify contrast with numbers, not eyeballs (codex caught a sub-AA pass here). The preference lives in the
`rc-theme` cookie, READ server-side in `app/layout.tsx` (which makes the route dynamic — that's expected)
so the first paint is flash-free; `app/providers.tsx` (`"use client"`) holds the state + `<Theme mode>`,
and the cookie name/validator live in the directive-free `app/theme-mode.ts` (a client module's exports
can't be called from the server layout). The topbar `ThemeToggle` cycles system→light→dark. When adding a
new hardcoded colour to `viewer.css`, wrap it in `light-dark()` or the guard in
`test/astryx-foundation.test.ts` (core tokens must be `light-dark()`) — and light mode — will regress.

Because the accent-inversion trap is invisible to the test suite, **look at a screenshot before merging
any viewer change** — in BOTH modes: `cd tests/web && pnpm exec playwright test -c app-e2e.shots.config.ts`
  writes 12 surfaces × `{phone,desktop}`×`{light,dark}` (48 images) to
  `tests/web/shots/<project>/`. Take a set before
and after and actually open them.

## Tranche scope and gate discipline

Start from one observable user outcome and the safety boundaries it crosses. Do not create schemas,
receipt formats, coordinators, or attestations for hypothetical later work.

The required product surfaces are Claude Code, Codex, OpenCode, and an honest tmux fallback, with
native local UI, multiple remote-claw browsers, and provider-native collaboration preserved where
available. Inference routing is a separate axis. A required surface may be sequenced after the current
milestone, but must not be deleted merely to simplify the next tranche.

- During implementation, run the smallest relevant tests. Run the full gate once after code and docs
  settle, and repeat it only when a later code change invalidates the result.
- Parallelize only independent files or read-only investigation. Use one owner when a change genuinely
  crosses an API or storage boundary.
- A new finding blocks the tranche only when it shows a reachable high-impact safety failure or loss of
  the required user outcome with a concrete causal path. Track unrelated hardening separately.
- Prefer deletion and a thin vertical over preserving unused foundations. Git history is the archive.
- Add a durable coordinator, migration, or recovery protocol only for a named state-loss case with an
  executable crash test.
- Keep reviews bounded and evidence-led. Preserve concrete findings; stop rereading when it produces no
  new causal issue.

For every retained module and gate, name the product surface or safety invariant it owns. Delete
machinery with no such owner and record why Git history is sufficient. Every status claim must say
**current**, **this milestone**, or **final target**; never let a milestone silently redefine the final
target. Expensive gates are opt-in or path-owned. An experimental surface graduates only after its
executable real-user acceptance passes. No new coordinator, schema, signing hierarchy, or proof layer
is allowed without a demonstrated causal failure and the focused fault test it is meant to fix.

Use E2E as a discovery and outcome layer, not a regression dumping ground. First decide whether a
failure is a reproducible product defect, a test-harness defect, an external outage, or an unsupported
claim; fix it at that owner. For a product defect likely to recur, root-cause it to the earliest
trustworthy, cheapest deterministic boundary and put the detailed regression there. Do not memorialize
incidental timing or fixture data, and do not create a new abstraction solely to make a test cheaper.
Retain only the thinnest E2E sentinel when cross-layer wiring or the user outcome is causal. Never copy
the same scenario into every layer. If a test cannot shift left because it depends on cross-process,
provider, browser-engine, durability, or deployment semantics, record that reason beside the owning
gate. Security edge cases with a reachable trust-boundary failure keep a causal boundary regression
plus the smallest wiring sentinel. Lower-risk bugs get coverage proportional to recurrence and blast
radius. Remove or merge proof machinery when a cheaper test supersedes it; do not build hypothetical
exhaustive state graphs. “Cheapest” is subordinate to fidelity: never replace the behavior that caused
the failure with a mock that cannot reproduce it. Before retaining an expensive regression, name the
observed failure, its causal boundary, the cheaper tests considered, and why this is the smallest
faithful sentinel.

## CLI / clawsec workflow

- Each change lands as a reviewed PR. During implementation run the smallest relevant tests. Once the
  code is frozen, run `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm test:install`, plus only
  the path-relevant browser or native integration test. Run the full local gate once, followed by
  independent review and CI; repeat it only after a code change invalidates the result.
- Ordinary tests are deterministic and must not discover or probe ambient native services. OpenCode
  live E2E runs only through `pnpm --filter @remote-claw/cli run test:opencode-live`, which sets
  `RC_OPENCODE_E2E_RUN=1`; an explicitly requested unavailable target fails. Retained provider
  fixtures are manual historical evidence, not root-Biome or ordinary-CI inputs.
- “CI green” means the repository-owned, path-relevant checks succeeded for the candidate commit. Keep
  the cheap immutable-SHA deployment binding, but do not recreate private receipt chains, host-tool
  attestations, fleet/log scans, or managed-firewall matrices. A failed or incomplete smoke is simply a
  failed gate to diagnose or rerun.
- Release validation is outcome-focused: the tested Claude version launches, the deployed broker uses
  the intended durable backend, the browser can discover and drive a real session, reconnect preserves
  the transcript, and fail-stop cases remain truthful. Security-sensitive crypto, auth, ambiguous-send,
  durability, and permission boundaries keep deterministic regression tests.
- The full multi-agent product is **not implemented yet**. A bounded 2026-08-24 M0 run proved that the
  existing lower-fidelity tmux driver can keep plain `claude --remote-control`, one local pane, the
  Anthropic Remote API, and two remote-claw viewers live together; it did not exercise the official
  Claude app UI. The next milestone is the structured path and official-app acceptance. Keep Anthropic
  RC normal and use the existing host-side native client behind a small readiness-gated bridge: no
  presence or mutation before one exact session and all prerequisites are ready; cancellation prevents
  late publication. OAuth stays host-only, ambiguous sends fail closed, and Anthropic necessarily
  receives plaintext. This milestone does not remove OpenCode, Codex, tmux, Bedrock, or accountless
  from the product goal.
- TypeScript is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
  `verbatimModuleSyntax`. Root secrets and known credential material never go on argv or normal output,
  and credential-shaped trace values are redacted. `--rc-json`/`--rc-quiet` never print `S`; only
  `--rc-identity` create and `--rc-show-secret` do. Explicit trace bodies may contain conversation text.
