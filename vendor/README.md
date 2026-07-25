# vendor/ — temporary fork override for `@astryxdesign/core`

`astryxdesign-core-0.1.8.tgz` is a `pnpm pack` of **our fork** of `@astryxdesign/core`, built from
[ejc3/astryx@feat/codeblock-diff-markers-and-language](https://github.com/ejc3/astryx/tree/feat/codeblock-diff-markers-and-language)
— i.e. published `0.1.8` plus the CodeBlock per-line diff feature (per-sign washes + `+`/`−` markers) we
contributed upstream in **[facebook/astryx#4328](https://github.com/facebook/astryx/pull/4328)**.

It is wired in by the root `package.json`:

```json
"pnpm": { "overrides": { "@astryxdesign/core": "file:./vendor/astryxdesign-core-0.1.8.tgz" } }
```

We need the tarball (not a git dependency) because `@astryxdesign/core` is a **monorepo subpackage** —
pnpm can't resolve a package name to a subdirectory of a git repo. The tarball is committed so Vercel/CI
installs resolve without network access to the fork.

`@astryxdesign/theme-neutral` and `@astryxdesign/cli` stay on the published `0.1.8` (the fork only touched
`core`).

## This is temporary

When #4328 merges and a new `@astryxdesign/core` publishes:

1. Bump `apps/web`'s `@astryxdesign/core` to the released version.
2. Delete the `@astryxdesign/core` line from the root `pnpm.overrides`.
3. Delete this directory.

## Regenerating the tarball (if the fork changes)

```bash
# in the fork checkout:
pnpm -F @astryxdesign/core build
pnpm -F @astryxdesign/core pack --pack-destination /path/to/remote-claw/vendor
# then in remote-claw:
pnpm install
```
