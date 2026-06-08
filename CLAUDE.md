# remote-claw — project notes for Claude

A cloud-brokered, zero-knowledge, E2E-encrypted system that relays `claude --remote-control`
through a Vercel Workflows broker. Design lives in `docs/v2-architecture.md`; the crypto core is
`packages/clawsec`, the CLI is `packages/cli`. Phase-0 reverse-engineering of Claude's RC protocol
is in `docs/phase0-findings.md` (and consolidated in `docs/v2-architecture.md` §17).

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

## CLI / clawsec workflow

- Each change lands as its own reviewed PR (stacked when dependent). Per-PR gate: `pnpm exec biome
  check .` + `pnpm exec tsc --noEmit` + `pnpm exec vitest run` (all green), then `/code-review` +
  codex, then CI green before merging.
- TypeScript is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`. Secrets never go on argv, never get logged, and never appear in
  `--rc-json`/`--rc-quiet` output (only `--rc-identity` create and `--rc-show-secret` print `S`).
