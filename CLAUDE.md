# remote-claw — project notes for Claude

A cloud-brokered, zero-knowledge, E2E-encrypted system that relays `claude --remote-control`
through a Vercel Workflows broker. Design lives in `docs/v2-architecture.md`; the crypto core is
`packages/clawsec`, the CLI is `packages/cli`. Phase-0 reverse-engineering of Claude's RC protocol
is in `docs/phase0-findings.md` (and consolidated in `docs/v2-architecture.md` §17).

## Driving a real claude through the wrapper (RC modes + the stub gotcha)

`remote-claw` runs the **real** `claude` behind a local MITM proxy (`HTTPS_PROXY` +
`NODE_EXTRA_CA_CERTS`). Two modes, picked by flag:

- **`--rc-app <origin> [--rc-backend <b>]`** (`runRcLaunch`, `launch.ts`) — intercepts claude's RC
  endpoints (`/v1/code/sessions/**`) and bridges the session **to our broker**, E2E-encrypted.
  Everything else (`/v1/messages`, OAuth) tunnels straight through to Anthropic. View it in **our** web
  viewer (`apps/web`) with a `--rc-show-secret` pass. Anthropic never sees this session, so the
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
- Diagnostics: `RC_LOG=debug` (frame shapes) or `RC_LOG=trace` (full bodies); `RC_LOG_FILE=…` captures
  to a clean file separate from the pty's TUI output.
- **Verify it's real, not a stub:** the child claude env has **no** `CLAUDE_CODE_CHILD_SESSION`; and —
  broker mode: a fresh `cse_<hex>` is "session created" + announces every ~20s; trace mode:
  `POST …/bridge` returns a `worker_jwt`.

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

Whenever a `docs/*.md` (or `CLAUDE.md`/`README.md`) lands, **or** you change the surface those docs
describe (an `--rc-*` flag, an RC control verb, a broker endpoint, or a driver's
permission/capability model), run a doc-sync pass before the work is "done" — no exceptions. The docs
are the *source of truth* (rendered live by marked.js) and they describe a moving target, so they drift
from the code and from each other; this is the doc analogue of the per-commit `/code-review` + codex
loop. A **Stop hook** (`.claude/hooks/doc-sync-check.sh`) reminds you when any Markdown changed in a
session — it asks once per change-state and never nags. The four lenses, each verified and root-cause
fixed (not papered over):

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

## CLI / clawsec workflow

- Each change lands as its own reviewed PR (stacked when dependent). Per-PR gate: `pnpm exec biome
  check .` + `pnpm exec tsc --noEmit` + `pnpm exec vitest run` (all green), then `/code-review` +
  codex, then CI green before merging.
- TypeScript is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`. Secrets never go on argv, never get logged, and never appear in
  `--rc-json`/`--rc-quiet` output (only `--rc-identity` create and `--rc-show-secret` print `S`).
